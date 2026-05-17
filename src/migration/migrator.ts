/**
 * Migration core: walk local SQLite stores and upload everything to a
 * central server via REST. Idempotent (skips items that already exist
 * on the central side).
 *
 * The CLI in `src/migration/cli.ts` is a thin wrapper around `runMigration`;
 * tests should call `runMigration` directly against a stubbed central HTTP
 * server (see `tests/migrate-to-central.test.ts`).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { mapLocalToCentral } from './namespace.js';
import type {
  ItemKind,
  ItemOutcome,
  ItemReport,
  MigrationOptions,
  MigrationSummary,
} from './types.js';

// ---- HTTP helpers -----------------------------------------------------------

export interface HttpResponse {
  status: number;
  body: any;
}

export type HttpClient = (
  method: string,
  url: string,
  body: unknown,
  headers: Record<string, string>,
) => Promise<HttpResponse>;

export const defaultHttpClient: HttpClient = async (method, url, body, headers) => {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* keep as text */ }
  return { status: res.status, body: parsed };
};

// ---- Reporter --------------------------------------------------------------

export type Logger = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

const consoleLogger: Logger = {
  info: (m) => console.log(m),
  error: (m) => console.error(m),
};

function tag(outcome: ItemOutcome): string {
  switch (outcome) {
    case 'ok': return '[OK]';
    case 'skip': return '[SKIP]';
    case 'err': return '[ERR]';
    case 'dry-run': return '[DRY-RUN]';
  }
}

function logItem(logger: Logger, kind: ItemKind, target: string, outcome: ItemOutcome, reason?: string): void {
  const line = `${tag(outcome)} ${kind}:${target}${reason ? ` (${reason})` : ''}`;
  if (outcome === 'err') logger.error(line);
  else logger.info(line);
}

// ---- Local DB row shapes ---------------------------------------------------

interface LocalFolderRow {
  id: string;
  name: string;
  parent_id: string | null;
  path: string;
  visibility?: string;
  created_at?: string;
  updated_at?: string;
}

interface LocalDocumentRow {
  id: string;
  title: string;
  folder_id: string;
  path: string;
  content: string;
  tags: string;
  created_by: string;
  created_at?: string;
  updated_at?: string;
}

interface LocalSkillRow {
  id: string;
  name: string;
  description: string;
  version: number;
  author: string;
  owner_instance_id: string | null;
  owner_instance_name: string | null;
  visibility: string;
  content_hash: string;
  tags: string;
  skill_md: string;
  references_tar: Buffer | null;
  published_at: string;
  updated_at: string;
}

// ---- migrated_at column (additive) -----------------------------------------

/**
 * Ensure a `migrated_at` TEXT column exists on the given table. Idempotent —
 * safe to call on every run.
 */
function ensureMigratedAtColumn(db: Database.Database, table: string): void {
  const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'migrated_at')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN migrated_at TEXT`);
  }
}

function markMigrated(db: Database.Database, table: string, id: string): void {
  db.prepare(`UPDATE ${table} SET migrated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
}

// ---- Memory uploads --------------------------------------------------------

async function folderExistsOnCentral(
  http: HttpClient,
  centralUrl: string,
  token: string,
  centralPath: string,
): Promise<boolean> {
  const encoded = encodeURIComponent(centralPath);
  const res = await http(
    'GET',
    `${centralUrl}/api/memory/folders/${encoded}`,
    undefined,
    { Authorization: `Bearer ${token}` },
  );
  return res.status === 200;
}

async function documentExistsOnCentral(
  http: HttpClient,
  centralUrl: string,
  token: string,
  centralPath: string,
): Promise<{ exists: boolean; sameContent?: boolean; remoteContent?: string }> {
  const encoded = encodeURIComponent(centralPath);
  const res = await http(
    'GET',
    `${centralUrl}/api/memory/documents/${encoded}`,
    undefined,
    { Authorization: `Bearer ${token}` },
  );
  if (res.status !== 200) return { exists: false };
  return { exists: true, remoteContent: res.body?.content ?? '' };
}

async function skillExistsOnCentral(
  http: HttpClient,
  centralUrl: string,
  token: string,
  name: string,
): Promise<{ exists: boolean; version?: number; contentHash?: string }> {
  const encoded = encodeURIComponent(name);
  const res = await http(
    'GET',
    `${centralUrl}/api/skills/${encoded}`,
    undefined,
    { Authorization: `Bearer ${token}` },
  );
  if (res.status !== 200) return { exists: false };
  return {
    exists: true,
    version: res.body?.version,
    contentHash: res.body?.contentHash,
  };
}

function parseTagsField(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* ignore */ }
  }
  return [];
}

function computeSkillContentHash(skillMd: string, referencesTar?: Buffer | null): string {
  const h = crypto.createHash('sha256');
  h.update(skillMd);
  if (referencesTar) h.update(referencesTar);
  return h.digest('hex');
}

// ---- Per-store migrators ---------------------------------------------------

async function migrateMemory(
  db: Database.Database,
  opts: MigrationOptions,
  http: HttpClient,
  logger: Logger,
  reports: ItemReport[],
): Promise<void> {
  ensureMigratedAtColumn(db, 'folders');
  ensureMigratedAtColumn(db, 'documents');

  // Walk folders depth-first (sorted by path so parents come before children).
  const folders = db.prepare('SELECT * FROM folders ORDER BY path').all() as LocalFolderRow[];
  // skip root
  const folderRows = folders.filter((f) => f.path !== '/');

  // Build folder-id → centralPath map (for routing docs even if folder was SKIPped).
  const folderIdToCentral = new Map<string, string | null>();
  folderIdToCentral.set('root', '/');

  for (const f of folderRows) {
    const central = mapLocalToCentral(f.path, opts.botName);
    folderIdToCentral.set(f.id, central);

    if (central === null) {
      record(reports, logger, 'folder', f.path, 'skip', 'not owned by this bot');
      continue;
    }

    // visibility — keep `private` if set, otherwise default to `private` on central
    // (central is auth-walled per ADR; we don't blast everything to /shared).
    const visibility = (f.visibility === 'shared') ? 'shared' : 'private';

    if (opts.dryRun) {
      record(reports, logger, 'folder', central, 'dry-run', `visibility=${visibility}`);
      continue;
    }

    try {
      if (await folderExistsOnCentral(http, opts.centralUrl, opts.token, central)) {
        record(reports, logger, 'folder', central, 'skip', 'already exists');
        markMigrated(db, 'folders', f.id);
        continue;
      }
      const res = await http(
        'POST',
        `${opts.centralUrl}/api/memory/folders`,
        { path: central, visibility },
        { Authorization: `Bearer ${opts.token}` },
      );
      if (res.status >= 200 && res.status < 300) {
        record(reports, logger, 'folder', central, 'ok');
        markMigrated(db, 'folders', f.id);
      } else {
        record(reports, logger, 'folder', central, 'err', `${res.status} ${stringifyError(res.body)}`);
        if (!opts.continueOnError) throw new MigrationAbortedError(`folder ${central} failed: ${res.status}`);
      }
    } catch (e) {
      if (e instanceof MigrationAbortedError) throw e;
      record(reports, logger, 'folder', central, 'err', (e as Error).message);
      if (!opts.continueOnError) throw new MigrationAbortedError(`folder ${central} failed: ${(e as Error).message}`);
    }
  }

  // Documents
  const docs = db.prepare('SELECT * FROM documents ORDER BY path').all() as LocalDocumentRow[];
  for (const d of docs) {
    const central = mapLocalToCentral(d.path, opts.botName);
    if (central === null) {
      record(reports, logger, 'document', d.path, 'skip', 'not owned by this bot');
      continue;
    }

    const tags = parseTagsField(d.tags);
    const content = typeof d.content === 'string' ? d.content : Buffer.from(d.content || '').toString();

    if (opts.dryRun) {
      record(reports, logger, 'document', central, 'dry-run', `${content.length}B, tags=${JSON.stringify(tags)}`);
      continue;
    }

    try {
      const existing = await documentExistsOnCentral(http, opts.centralUrl, opts.token, central);
      if (existing.exists) {
        // Idempotence: compare content hash to avoid double-upload.
        const localHash = sha256(content);
        const remoteHash = sha256(existing.remoteContent ?? '');
        if (localHash === remoteHash) {
          record(reports, logger, 'document', central, 'skip', 'already exists (same content)');
          markMigrated(db, 'documents', d.id);
          continue;
        }
        record(reports, logger, 'document', central, 'skip', 'already exists (content differs — manual reconcile)');
        continue;
      }
      const res = await http(
        'POST',
        `${opts.centralUrl}/api/memory/documents`,
        { path: central, title: d.title, content, tags },
        { Authorization: `Bearer ${opts.token}` },
      );
      if (res.status >= 200 && res.status < 300) {
        record(reports, logger, 'document', central, 'ok');
        markMigrated(db, 'documents', d.id);
      } else {
        record(reports, logger, 'document', central, 'err', `${res.status} ${stringifyError(res.body)}`);
        if (!opts.continueOnError) throw new MigrationAbortedError(`document ${central} failed: ${res.status}`);
      }
    } catch (e) {
      if (e instanceof MigrationAbortedError) throw e;
      record(reports, logger, 'document', central, 'err', (e as Error).message);
      if (!opts.continueOnError) throw new MigrationAbortedError(`document ${central} failed: ${(e as Error).message}`);
    }
  }
}

async function migrateSkills(
  db: Database.Database,
  opts: MigrationOptions,
  http: HttpClient,
  logger: Logger,
  reports: ItemReport[],
): Promise<void> {
  ensureMigratedAtColumn(db, 'skills');

  const skills = db.prepare(
    `SELECT id, name, description, version, author, owner_instance_id, owner_instance_name,
            visibility, content_hash, tags, skill_md, references_tar, published_at, updated_at
     FROM skills`,
  ).all() as LocalSkillRow[];

  for (const s of skills) {
    if (opts.dryRun) {
      record(reports, logger, 'skill', s.name, 'dry-run', `v${s.version}, ${s.visibility}`);
      continue;
    }

    try {
      const remote = await skillExistsOnCentral(http, opts.centralUrl, opts.token, s.name);
      if (remote.exists) {
        // Idempotence: skip if same content hash on the same name. We can't
        // compare version numbers safely because central assigns its own.
        const localHash = s.content_hash || computeSkillContentHash(s.skill_md, s.references_tar);
        if (remote.contentHash && remote.contentHash === localHash) {
          record(reports, logger, 'skill', s.name, 'skip', 'already exists (same content)');
          markMigrated(db, 'skills', s.id);
          continue;
        }
        record(reports, logger, 'skill', s.name, 'skip', 'already exists (content differs)');
        continue;
      }

      const body: Record<string, unknown> = {
        skillMd: s.skill_md,
        visibility: s.visibility || 'published',
      };
      if (s.references_tar) {
        body.referencesTar = s.references_tar.toString('base64');
      }

      const res = await http(
        'POST',
        `${opts.centralUrl}/api/skills/${encodeURIComponent(s.name)}/publish`,
        body,
        { Authorization: `Bearer ${opts.token}` },
      );
      if (res.status >= 200 && res.status < 300) {
        record(reports, logger, 'skill', s.name, 'ok');
        markMigrated(db, 'skills', s.id);
      } else {
        record(reports, logger, 'skill', s.name, 'err', `${res.status} ${stringifyError(res.body)}`);
        if (!opts.continueOnError) throw new MigrationAbortedError(`skill ${s.name} failed: ${res.status}`);
      }
    } catch (e) {
      if (e instanceof MigrationAbortedError) throw e;
      record(reports, logger, 'skill', s.name, 'err', (e as Error).message);
      if (!opts.continueOnError) throw new MigrationAbortedError(`skill ${s.name} failed: ${(e as Error).message}`);
    }
  }
}

// ---- Entry point -----------------------------------------------------------

export class MigrationAbortedError extends Error {}

function record(
  reports: ItemReport[],
  logger: Logger,
  kind: ItemKind,
  target: string,
  outcome: ItemOutcome,
  reason?: string,
): void {
  reports.push({ kind, target, outcome, reason });
  logItem(logger, kind, target, outcome, reason);
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function stringifyError(body: any): string {
  if (!body) return '';
  if (typeof body === 'string') return body;
  if (body.error) return String(body.error);
  try { return JSON.stringify(body); } catch { return String(body); }
}

export interface RunMigrationDeps {
  http?: HttpClient;
  logger?: Logger;
}

export async function runMigration(
  options: MigrationOptions,
  deps: RunMigrationDeps = {},
): Promise<MigrationSummary> {
  const http = deps.http ?? defaultHttpClient;
  const logger = deps.logger ?? consoleLogger;
  const reports: ItemReport[] = [];
  const startedAt = Date.now();

  if (!options.botName.trim()) throw new Error('--bot-name is required');
  if (!options.centralUrl) throw new Error('--central-url is required');
  if (!options.token) throw new Error('--token is required');

  if (options.include.includes('memory')) {
    const dbPath = path.join(options.memoryDbPath, 'metamemory.db');
    if (!fs.existsSync(dbPath)) {
      logger.info(`[SKIP] memory store not found at ${dbPath}`);
    } else {
      const db = new Database(dbPath);
      try {
        await migrateMemory(db, options, http, logger, reports);
      } catch (e) {
        if (e instanceof MigrationAbortedError) {
          logger.error(`aborted: ${e.message}`);
        } else {
          throw e;
        }
      } finally {
        db.close();
      }
    }
  }

  if (options.include.includes('skills')) {
    const dbPath = path.join(options.skillHubDbPath, 'skill-hub.db');
    if (!fs.existsSync(dbPath)) {
      logger.info(`[SKIP] skill hub store not found at ${dbPath}`);
    } else {
      const db = new Database(dbPath);
      try {
        await migrateSkills(db, options, http, logger, reports);
      } catch (e) {
        if (e instanceof MigrationAbortedError) {
          logger.error(`aborted: ${e.message}`);
        } else {
          throw e;
        }
      } finally {
        db.close();
      }
    }
  }

  const counts: Record<ItemOutcome, number> = { ok: 0, skip: 0, err: 0, 'dry-run': 0 };
  for (const r of reports) counts[r.outcome]++;
  const durationMs = Date.now() - startedAt;

  logger.info('');
  logger.info(`Summary: ok=${counts.ok} skip=${counts.skip} err=${counts.err} dry-run=${counts['dry-run']} duration=${durationMs}ms`);

  return { reports, counts, durationMs };
}
