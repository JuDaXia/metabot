/**
 * Tests for `mb-migrate-to-central` — Phase 3.
 *
 * The 4 required cases:
 *   1. dry-run output (no POSTs happen, dry-run reports for every row)
 *   2. full migration to a stubbed central HTTP server
 *   3. idempotent re-run — second run produces zero new uploads
 *   4. error handling with --continue-on-error
 *
 * Plus a few smaller unit tests for the namespace mapper, since it's
 * load-bearing for correctness.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import Database from 'better-sqlite3';
import { mapLocalToCentral } from '../src/migration/namespace.js';
import { runMigration } from '../src/migration/migrator.js';
import { parseArgs } from '../src/migration/cli.js';
import type { ItemReport } from '../src/migration/types.js';

// ---- Fake central server ----------------------------------------------------

interface FakeFolder { path: string; visibility: string }
interface FakeDoc { path: string; title: string; content: string; tags: string[] }
interface FakeSkill {
  name: string;
  version: number;
  skillMd: string;
  contentHash: string;
  visibility: string;
}

interface FakeCentralOptions {
  failFolderRoute?: boolean;
  failSkillName?: string;
}

interface FakeCentral {
  folders: Map<string, FakeFolder>;
  docs: Map<string, FakeDoc>;
  skills: Map<string, FakeSkill>;
  requests: Array<{ method: string; path: string }>;
  url: string;
  token: string;
  close(): Promise<void>;
}

function computeContentHash(skillMd: string): string {
  return crypto.createHash('sha256').update(skillMd).digest('hex');
}

async function startFakeCentral(opts: FakeCentralOptions = {}): Promise<FakeCentral> {
  const folders = new Map<string, FakeFolder>();
  const docs = new Map<string, FakeDoc>();
  const skills = new Map<string, FakeSkill>();
  const requests: Array<{ method: string; path: string }> = [];
  const token = 'test-token-' + Math.random().toString(36).slice(2, 8);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const auth = req.headers.authorization || '';
    requests.push({ method: req.method || 'GET', path: url.pathname });

    if (auth !== `Bearer ${token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // Memory: folder GET (existence check)
    if (req.method === 'GET' && url.pathname.startsWith('/api/memory/folders/')) {
      const p = decodeURIComponent(url.pathname.slice('/api/memory/folders/'.length));
      const f = folders.get(p);
      if (f) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(f));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'folder_not_found' }));
      }
      return;
    }

    // Memory: folder POST (create)
    if (req.method === 'POST' && url.pathname === '/api/memory/folders') {
      const body = await readJson(req);
      if (opts.failFolderRoute) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'simulated_failure' }));
        return;
      }
      const p = String(body.path);
      folders.set(p, { path: p, visibility: String(body.visibility ?? 'private') });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: p, ok: true }));
      return;
    }

    // Memory: doc GET (existence)
    if (req.method === 'GET' && url.pathname.startsWith('/api/memory/documents/')) {
      const p = decodeURIComponent(url.pathname.slice('/api/memory/documents/'.length));
      const d = docs.get(p);
      if (d) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(d));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'document_not_found' }));
      }
      return;
    }

    // Memory: doc POST (create)
    if (req.method === 'POST' && url.pathname === '/api/memory/documents') {
      const body = await readJson(req);
      const p = String(body.path);
      // Auto-create parent folder for ergonomics (matches real central behavior).
      docs.set(p, {
        path: p,
        title: String(body.title ?? ''),
        content: typeof body.content === 'string' ? body.content : '',
        tags: Array.isArray(body.tags) ? body.tags : [],
      });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: p, ok: true }));
      return;
    }

    // Skills: GET (existence)
    const skillGet = url.pathname.match(/^\/api\/skills\/([^/]+)$/);
    if (req.method === 'GET' && skillGet) {
      const name = decodeURIComponent(skillGet[1]);
      const s = skills.get(name);
      if (s) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: s.name, version: s.version, contentHash: s.contentHash, visibility: s.visibility }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'skill_not_found' }));
      }
      return;
    }

    // Skills: POST publish
    const skillPublish = url.pathname.match(/^\/api\/skills\/([^/]+)\/publish$/);
    if (req.method === 'POST' && skillPublish) {
      const name = decodeURIComponent(skillPublish[1]);
      if (opts.failSkillName && opts.failSkillName === name) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'simulated_failure' }));
        return;
      }
      const body = await readJson(req);
      const skillMd = String(body.skillMd ?? '');
      const ch = computeContentHash(skillMd);
      const existing = skills.get(name);
      const version = (existing?.version ?? 0) + 1;
      skills.set(name, {
        name,
        version,
        skillMd,
        contentHash: ch,
        visibility: String(body.visibility ?? 'published'),
      });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name, version, published: true }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server failed to bind');
  return {
    folders,
    docs,
    skills,
    requests,
    url: `http://127.0.0.1:${addr.port}`,
    token,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ---- Local SQLite fixture ---------------------------------------------------

interface LocalFixture {
  memoryDir: string;
  skillHubDir: string;
  cleanup: () => void;
}

function setupLocalDbs(): LocalFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-migrate-test-'));
  const memoryDir = path.join(dir, 'memory');
  const skillHubDir = path.join(dir, 'skills');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(skillHubDir, { recursive: true });

  // --- Memory DB ---
  const memDb = new Database(path.join(memoryDir, 'metamemory.db'));
  memDb.exec(`
    CREATE TABLE folders (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT,
      path TEXT UNIQUE NOT NULL, visibility TEXT NOT NULL DEFAULT 'private',
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, title TEXT NOT NULL,
      folder_id TEXT NOT NULL DEFAULT 'root',
      path TEXT UNIQUE NOT NULL, content TEXT DEFAULT '',
      tags TEXT DEFAULT '[]', created_by TEXT DEFAULT '',
      created_at TEXT, updated_at TEXT
    );
  `);
  const now = new Date().toISOString();
  memDb.prepare('INSERT INTO folders (id, name, parent_id, path, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'root', 'Root', null, '/', 'shared', now, now,
  );
  memDb.prepare('INSERT INTO folders (id, name, parent_id, path, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'f-projects', 'projects', 'root', '/projects', 'private', now, now,
  );
  memDb.prepare('INSERT INTO folders (id, name, parent_id, path, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'f-foo', 'foo', 'f-projects', '/projects/foo', 'private', now, now,
  );
  memDb.prepare('INSERT INTO folders (id, name, parent_id, path, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'f-shared', 'shared', 'root', '/shared', 'shared', now, now,
  );
  memDb.prepare('INSERT INTO folders (id, name, parent_id, path, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'f-instances', 'instances', 'root', '/instances', 'private', now, now,
  );
  memDb.prepare('INSERT INTO folders (id, name, parent_id, path, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'f-inst-1', 'inst-1', 'f-instances', '/instances/inst-1', 'private', now, now,
  );
  memDb.prepare('INSERT INTO folders (id, name, parent_id, path, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'f-other-user', 'other-user', 'root', '/users/other-bot', 'private', now, now,
  );

  memDb.prepare('INSERT INTO documents (id, title, folder_id, path, content, tags, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'd1', 'Project Notes', 'f-foo', '/projects/foo/project-notes', 'hello world', '["work"]', 'bot', now, now,
  );
  memDb.prepare('INSERT INTO documents (id, title, folder_id, path, content, tags, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'd2', 'Shared Doc', 'f-shared', '/shared/shared-doc', 'shared content', '[]', 'bot', now, now,
  );
  memDb.prepare('INSERT INTO documents (id, title, folder_id, path, content, tags, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'd3', 'Instance Doc', 'f-inst-1', '/instances/inst-1/instance-doc', 'private content', '[]', 'bot', now, now,
  );
  memDb.prepare('INSERT INTO documents (id, title, folder_id, path, content, tags, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'd4', 'Other User Doc', 'f-other-user', '/users/other-bot/secret', 'NOT OURS', '[]', 'bot', now, now,
  );
  memDb.close();

  // --- Skill hub DB ---
  const skillDb = new Database(path.join(skillHubDir, 'skill-hub.db'));
  skillDb.exec(`
    CREATE TABLE skills (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
      author TEXT NOT NULL DEFAULT '', owner_instance_id TEXT,
      owner_instance_name TEXT,
      visibility TEXT NOT NULL DEFAULT 'published',
      content_hash TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
      user_invocable INTEGER NOT NULL DEFAULT 1,
      context TEXT, allowed_tools TEXT,
      skill_md TEXT NOT NULL, references_tar BLOB,
      published_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  const SKILL_A = `---\nname: skill-a\ndescription: First test skill\n---\n# Skill A\n`;
  const SKILL_B = `---\nname: skill-b\ndescription: Second test skill\n---\n# Skill B\n`;
  skillDb.prepare(
    `INSERT INTO skills (id, name, description, version, author, visibility, content_hash, tags, skill_md, published_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('s1', 'skill-a', 'First test skill', 1, 'tester', 'published', computeContentHash(SKILL_A), '[]', SKILL_A, now, now);
  skillDb.prepare(
    `INSERT INTO skills (id, name, description, version, author, visibility, content_hash, tags, skill_md, published_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('s2', 'skill-b', 'Second test skill', 1, 'tester', 'published', computeContentHash(SKILL_B), '[]', SKILL_B, now, now);
  skillDb.close();

  return {
    memoryDir,
    skillHubDir,
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

function silentLogger() {
  return { info: () => {}, error: () => {} };
}

function reportsByOutcome(reports: ItemReport[]) {
  return reports.reduce<Record<string, ItemReport[]>>((acc, r) => {
    (acc[r.outcome] ||= []).push(r);
    return acc;
  }, {});
}

// ---- Tests -----------------------------------------------------------------

describe('namespace.mapLocalToCentral', () => {
  it('rewrites /projects/* under /users/<bot>/projects', () => {
    expect(mapLocalToCentral('/projects/foo', 'flood')).toBe('/users/flood/projects/foo');
    expect(mapLocalToCentral('/projects/foo/bar', 'flood')).toBe('/users/flood/projects/foo/bar');
  });
  it('rewrites /instances/<id>/* under /users/<bot>/private', () => {
    expect(mapLocalToCentral('/instances/inst-1/notes/x', 'flood')).toBe('/users/flood/private/notes/x');
  });
  it('preserves /shared/*', () => {
    expect(mapLocalToCentral('/shared/foo', 'flood')).toBe('/shared/foo');
  });
  it('skips other users', () => {
    expect(mapLocalToCentral('/users/other/x', 'flood')).toBeNull();
  });
  it('keeps already-correct /users/<self>/...', () => {
    expect(mapLocalToCentral('/users/flood/x', 'flood')).toBe('/users/flood/x');
  });
  it('skips root', () => {
    expect(mapLocalToCentral('/', 'flood')).toBeNull();
  });
});

describe('parseArgs', () => {
  it('parses required args + defaults to dry-run', () => {
    const r = parseArgs(['--central-url', 'http://x', '--token', 't', '--bot-name', 'me']);
    expect(r.options?.dryRun).toBe(true);
    expect(r.options?.include).toEqual(['memory', 'skills']);
  });
  it('--apply flips dry-run off', () => {
    const r = parseArgs(['--central-url', 'http://x', '--token', 't', '--bot-name', 'me', '--apply']);
    expect(r.options?.dryRun).toBe(false);
  });
  it('errors when required args missing', () => {
    expect(parseArgs([]).error).toBeDefined();
    expect(parseArgs(['--central-url', 'x']).error).toBeDefined();
  });
  it('--include narrows the set', () => {
    const r = parseArgs(['--central-url', 'x', '--token', 't', '--bot-name', 'me', '--include', 'skills']);
    expect(r.options?.include).toEqual(['skills']);
  });
});

describe('runMigration', () => {
  let fixture: LocalFixture;
  let central: FakeCentral;

  beforeEach(async () => {
    fixture = setupLocalDbs();
    central = await startFakeCentral();
  });

  afterEach(async () => {
    fixture.cleanup();
    await central.close();
  });

  // Case 1: dry-run
  it('dry-run reports every row but POSTs nothing', async () => {
    const summary = await runMigration({
      centralUrl: central.url,
      token: central.token,
      botName: 'floodsung-main',
      dryRun: true,
      memoryDbPath: fixture.memoryDir,
      skillHubDbPath: fixture.skillHubDir,
      include: ['memory', 'skills'],
      continueOnError: false,
    }, { logger: silentLogger() });

    expect(summary.counts['dry-run']).toBeGreaterThan(0);
    expect(summary.counts.ok).toBe(0);
    expect(summary.counts.err).toBe(0);
    // No write requests against the central server
    const writes = central.requests.filter((r) => r.method === 'POST');
    expect(writes.length).toBe(0);

    // Dry-run reports include only the rows we'd actually try to upload
    const buckets = reportsByOutcome(summary.reports);
    const dryFolders = (buckets['dry-run'] || []).filter((r) => r.kind === 'folder');
    const dryDocs = (buckets['dry-run'] || []).filter((r) => r.kind === 'document');
    const dryFolderPaths = dryFolders.map((f) => f.target);
    expect(dryFolderPaths).toContain('/users/floodsung-main/projects');
    expect(dryFolderPaths).toContain('/users/floodsung-main/projects/foo');
    expect(dryFolderPaths).toContain('/shared');
    const dryDocPaths = dryDocs.map((d) => d.target);
    expect(dryDocPaths).toContain('/users/floodsung-main/projects/foo/project-notes');
    expect(dryDocPaths).toContain('/shared/shared-doc');
    expect(dryDocPaths).toContain('/users/floodsung-main/private/instance-doc');
    // Other-user data is skipped, never dry-run
    expect(dryDocPaths.some((p) => p.includes('other-bot'))).toBe(false);
  });

  // Case 2: full migration to a stubbed central
  it('apply mode uploads folders, documents, and skills to the stub server', async () => {
    const summary = await runMigration({
      centralUrl: central.url,
      token: central.token,
      botName: 'floodsung-main',
      dryRun: false,
      memoryDbPath: fixture.memoryDir,
      skillHubDbPath: fixture.skillHubDir,
      include: ['memory', 'skills'],
      continueOnError: false,
    }, { logger: silentLogger() });

    expect(summary.counts.err).toBe(0);
    expect(summary.counts.ok).toBeGreaterThan(0);

    // Folders landed on central
    expect(central.folders.has('/users/floodsung-main/projects')).toBe(true);
    expect(central.folders.has('/users/floodsung-main/projects/foo')).toBe(true);
    expect(central.folders.has('/shared')).toBe(true);
    expect(central.folders.has('/users/floodsung-main/private')).toBe(true);
    // Other-user folder must not have been touched
    for (const k of central.folders.keys()) expect(k.includes('other-bot')).toBe(false);

    // Documents landed
    expect(central.docs.has('/users/floodsung-main/projects/foo/project-notes')).toBe(true);
    expect(central.docs.has('/shared/shared-doc')).toBe(true);
    expect(central.docs.has('/users/floodsung-main/private/instance-doc')).toBe(true);
    for (const k of central.docs.keys()) expect(k.includes('other-bot')).toBe(false);

    // Skills landed
    expect(central.skills.has('skill-a')).toBe(true);
    expect(central.skills.has('skill-b')).toBe(true);

    // migrated_at column populated on the local DB (additive migration)
    const memDb = new Database(path.join(fixture.memoryDir, 'metamemory.db'));
    const migrated = memDb.prepare("SELECT COUNT(*) as n FROM documents WHERE migrated_at IS NOT NULL").get() as { n: number };
    expect(migrated.n).toBeGreaterThan(0);
    // The other-user doc must remain unmigrated
    const otherDoc = memDb.prepare("SELECT migrated_at FROM documents WHERE id = ?").get('d4') as { migrated_at: string | null };
    expect(otherDoc.migrated_at).toBeNull();
    memDb.close();

    const skillDb = new Database(path.join(fixture.skillHubDir, 'skill-hub.db'));
    const migratedSkills = skillDb.prepare("SELECT COUNT(*) as n FROM skills WHERE migrated_at IS NOT NULL").get() as { n: number };
    expect(migratedSkills.n).toBe(2);
    skillDb.close();
  });

  // Case 3: idempotence
  it('re-runs are idempotent — no duplicate uploads on the second pass', async () => {
    const baseOpts = {
      centralUrl: central.url,
      token: central.token,
      botName: 'floodsung-main',
      dryRun: false,
      memoryDbPath: fixture.memoryDir,
      skillHubDbPath: fixture.skillHubDir,
      include: ['memory', 'skills'] as const,
      continueOnError: false,
    };

    const first = await runMigration({ ...baseOpts, include: [...baseOpts.include] }, { logger: silentLogger() });
    expect(first.counts.ok).toBeGreaterThan(0);

    const writeCountAfterFirst = central.requests.filter((r) => r.method === 'POST').length;

    const second = await runMigration({ ...baseOpts, include: [...baseOpts.include] }, { logger: silentLogger() });
    expect(second.counts.ok).toBe(0);
    expect(second.counts.skip).toBeGreaterThan(0);
    expect(second.counts.err).toBe(0);

    const writeCountAfterSecond = central.requests.filter((r) => r.method === 'POST').length;
    expect(writeCountAfterSecond).toBe(writeCountAfterFirst); // no new POSTs
  });

  // Case 4: --continue-on-error
  it('--continue-on-error keeps going past 5xx; aborts otherwise', async () => {
    await central.close();
    central = await startFakeCentral({ failSkillName: 'skill-a' });

    // First, without continue-on-error — should fail with err counted but no
    // exception (runMigration catches MigrationAbortedError internally).
    const aborted = await runMigration({
      centralUrl: central.url,
      token: central.token,
      botName: 'floodsung-main',
      dryRun: false,
      memoryDbPath: fixture.memoryDir,
      skillHubDbPath: fixture.skillHubDir,
      include: ['skills'],
      continueOnError: false,
    }, { logger: silentLogger() });
    expect(aborted.counts.err).toBeGreaterThan(0);
    // skill-b never tried because abort short-circuited
    expect(central.skills.has('skill-b')).toBe(false);

    // Same again with continue-on-error — skill-b gets through despite skill-a failing.
    const continued = await runMigration({
      centralUrl: central.url,
      token: central.token,
      botName: 'floodsung-main',
      dryRun: false,
      memoryDbPath: fixture.memoryDir,
      skillHubDbPath: fixture.skillHubDir,
      include: ['skills'],
      continueOnError: true,
    }, { logger: silentLogger() });
    expect(continued.counts.err).toBeGreaterThan(0);
    expect(continued.counts.ok).toBeGreaterThan(0);
    expect(central.skills.has('skill-b')).toBe(true);
  });
});
