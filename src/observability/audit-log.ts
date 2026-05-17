import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';

export type AuditOp =
  | 'read'
  | 'list'
  | 'create'
  | 'update'
  | 'delete'
  | 'search'
  | 'install'
  | 'publish'
  | 'get';

export interface AuditEntry {
  ts: string;
  op: AuditOp | string;
  path: string;
  principalId: string;
  sourceIp: string;
  status: number;
  latencyMs: number;
}

export interface AuditLogOptions {
  dir: string;
  enabled?: boolean;
  maxBytes?: number;
  logger?: Logger;
}

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export class AuditLog {
  private dir: string;
  private enabled: boolean;
  private maxBytes: number;
  private logger?: Logger;
  private currentDate: string;
  private currentPath: string;
  private currentSize: number;
  private rotationIndex: number;

  constructor(options: AuditLogOptions) {
    this.dir = options.dir;
    this.enabled = options.enabled !== false;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.logger = options.logger;
    this.currentDate = formatDate(new Date());
    this.rotationIndex = 0;
    this.currentPath = this.computePath();
    this.currentSize = this.readCurrentSize();
    if (this.enabled) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
      } catch (err) {
        this.logger?.warn({ err, dir: this.dir }, 'audit-log: failed to create directory');
      }
    }
  }

  append(entry: AuditEntry): void {
    if (!this.enabled) return;

    const today = formatDate(new Date());
    if (today !== this.currentDate) {
      this.currentDate = today;
      this.rotationIndex = 0;
      this.currentPath = this.computePath();
      this.currentSize = this.readCurrentSize();
    }

    const line = JSON.stringify(entry) + '\n';
    const bytes = Buffer.byteLength(line, 'utf-8');

    if (this.currentSize + bytes > this.maxBytes && this.currentSize > 0) {
      this.rotate();
    }

    try {
      const fd = fs.openSync(this.currentPath, 'a');
      try {
        fs.writeSync(fd, line);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.currentSize += bytes;
    } catch (err) {
      this.logger?.warn({ err, path: this.currentPath }, 'audit-log: append failed');
    }
  }

  rotate(): void {
    this.rotationIndex += 1;
    this.currentPath = this.computePath();
    this.currentSize = this.readCurrentSize();
  }

  getCurrentPath(): string {
    return this.currentPath;
  }

  private computePath(): string {
    const suffix = this.rotationIndex === 0 ? '' : `.${this.rotationIndex}`;
    return path.join(this.dir, `${this.currentDate}${suffix}.jsonl`);
  }

  private readCurrentSize(): number {
    try {
      return fs.statSync(this.currentPath).size;
    } catch {
      return 0;
    }
  }
}

export function createDefaultAuditLog(logger?: Logger): AuditLog {
  const dir = process.env.METABOT_AUDIT_DIR || path.join(process.cwd(), 'data', 'audit');
  const enabled = process.env.METABOT_AUDIT_ENABLED !== 'false';
  return new AuditLog({ dir, enabled, logger });
}
