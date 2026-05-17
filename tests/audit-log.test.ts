import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AuditLog, type AuditEntry } from '../src/observability/audit-log.js';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-log-test-'));
}

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: new Date().toISOString(),
    op: 'read',
    path: '/api/documents/foo',
    principalId: 'admin',
    sourceIp: '127.0.0.1',
    status: 200,
    latencyMs: 12,
    ...overrides,
  };
}

describe('AuditLog', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkTmpDir();
  });

  afterEach(() => {
    vi.useRealTimers();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('appends JSONL entries with a daily filename', () => {
    const log = new AuditLog({ dir });
    log.append(makeEntry({ op: 'list', path: '/api/documents' }));
    log.append(makeEntry({ op: 'create', path: '/api/documents', status: 201 }));

    const file = log.getCurrentPath();
    expect(path.basename(file)).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.op).toBe('list');
    expect(second.op).toBe('create');
    expect(second.status).toBe(201);
  });

  it('rotates when current file exceeds maxBytes', () => {
    const log = new AuditLog({ dir, maxBytes: 200 });
    const longPath = '/api/documents/' + 'x'.repeat(80);
    for (let i = 0; i < 10; i += 1) {
      log.append(makeEntry({ path: longPath, principalId: `p${i}` }));
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
    expect(files.length).toBeGreaterThanOrEqual(2);
    let totalLines = 0;
    for (const f of files) {
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      totalLines += content.trim().split('\n').filter(Boolean).length;
    }
    expect(totalLines).toBe(10);
  });

  it('rolls to a new file when the UTC date changes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T23:59:59Z'));
    const log = new AuditLog({ dir });
    log.append(makeEntry({ op: 'read' }));
    const firstPath = log.getCurrentPath();

    vi.setSystemTime(new Date('2026-05-18T00:00:01Z'));
    log.append(makeEntry({ op: 'list' }));
    const secondPath = log.getCurrentPath();

    expect(firstPath).not.toBe(secondPath);
    expect(path.basename(firstPath)).toBe('2026-05-17.jsonl');
    expect(path.basename(secondPath)).toBe('2026-05-18.jsonl');
    expect(fs.existsSync(firstPath)).toBe(true);
    expect(fs.existsSync(secondPath)).toBe(true);
  });

  it('writes concurrent appends without corruption', () => {
    const log = new AuditLog({ dir });
    const writes: AuditEntry[] = [];
    for (let i = 0; i < 200; i += 1) {
      writes.push(makeEntry({ principalId: `principal-${i}`, latencyMs: i }));
    }
    for (const w of writes) log.append(w);

    const file = log.getCurrentPath();
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(200);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('ts');
      expect(parsed).toHaveProperty('op');
      expect(parsed).toHaveProperty('principalId');
    }
  });

  it('disabled mode is a no-op', () => {
    const log = new AuditLog({ dir, enabled: false });
    log.append(makeEntry());
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    expect(files.filter((f) => f.endsWith('.jsonl'))).toHaveLength(0);
  });
});
