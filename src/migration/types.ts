/**
 * Shared types for `mb-migrate-to-central` — Phase 3 of the central pivot.
 *
 * The migration CLI walks two local SQLite stores (memory + skill hub) and
 * uploads each row to a central server via its REST API. See
 * `src/migration/migrator.ts` for the heavy lifting and `bin/mb-migrate-to-central`
 * for the CLI wrapper.
 */

export type Visibility = 'shared' | 'private' | 'published';
export type Include = 'memory' | 'skills';

export interface MigrationOptions {
  centralUrl: string;
  token: string;
  botName: string;
  /** Default `true` — show what would be uploaded but do not POST anything. */
  dryRun: boolean;
  /** Defaults to `process.cwd()/data` (matches src/api/http-server.ts + MEMORY_DATABASE_DIR). */
  memoryDbPath: string;
  /** Defaults to `process.cwd()/data`. Same dir as `memory-storage.ts`. */
  skillHubDbPath: string;
  /** Default `['memory', 'skills']`. */
  include: Include[];
  /** If true, log 4xx/5xx errors but keep going. */
  continueOnError: boolean;
}

export type ItemKind = 'folder' | 'document' | 'skill';
export type ItemOutcome = 'ok' | 'skip' | 'err' | 'dry-run';

export interface ItemReport {
  kind: ItemKind;
  /** Central path for memory rows, skill name for skills. */
  target: string;
  outcome: ItemOutcome;
  reason?: string;
}

export interface MigrationSummary {
  reports: ItemReport[];
  counts: Record<ItemOutcome, number>;
  durationMs: number;
}
