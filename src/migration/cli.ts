#!/usr/bin/env node
/**
 * `mb-migrate-to-central` — Phase 3 of the central-architecture pivot.
 *
 * Uploads everything from this bot's local SQLite stores (memory + skill hub)
 * to a central MetaBot server. See `bin/mb-migrate-to-central` for the bash
 * wrapper used after `npm run build`.
 */
import * as path from 'node:path';
import { runMigration } from './migrator.js';
import type { Include, MigrationOptions } from './types.js';

const USAGE = `mb-migrate-to-central — upload local memory + skill-hub to a central server

USAGE
  mb-migrate-to-central --central-url <url> --token <bearer> --bot-name <name> [options]

REQUIRED
  --central-url <url>      Base URL of the central server (e.g. https://mb.xvirobotics.com)
  --token <bearer>         Bearer token issued by the central server
  --bot-name <name>        Used to namespace folders. Example: \`--bot-name floodsung-main\`
                           rewrites local /projects/foo into /users/floodsung-main/projects/foo.

OPTIONS
  --dry-run                Show what would be uploaded; do not POST (default).
  --apply                  Actually upload (negates --dry-run).
  --memory-db-path <dir>   Directory containing metamemory.db.
                           Defaults to $MEMORY_DATABASE_DIR or ./data.
  --skill-hub-db-path <d>  Directory containing skill-hub.db.
                           Defaults to ./data.
  --include memory         Migrate only the memory store (omit skills).
  --include skills         Migrate only the skill hub.
  --include memory,skills  Both (the default).
  --continue-on-error      Keep going past 4xx/5xx instead of aborting.
  -h, --help               Show this help and exit.
  -V, --version            Print version and exit.

NAMESPACE MAPPING (local → central)
  /projects/<X>            → /users/<bot-name>/projects/<X>
  /instances/<id>/...      → /users/<bot-name>/private/...
  /shared/...              → /shared/...        (1:1)
  /users/<other>/...       → SKIP               (not ours to migrate)

EXAMPLES
  # Dry-run from a local install of MetaBot
  mb-migrate-to-central --central-url https://mb.xvirobotics.com \\
                        --token $CENTRAL_TOKEN --bot-name floodsung-main

  # Apply (with continue-on-error so transient 5xx don't kill the run)
  mb-migrate-to-central --central-url https://mb.xvirobotics.com \\
                        --token $CENTRAL_TOKEN --bot-name floodsung-main \\
                        --apply --continue-on-error
`;

interface ParsedArgs {
  options?: MigrationOptions;
  helpRequested?: boolean;
  versionRequested?: boolean;
  error?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let centralUrl = '';
  let token = '';
  let botName = '';
  let dryRun = true;
  let memoryDbPath: string | undefined;
  let skillHubDbPath: string | undefined;
  const includeSet = new Set<Include>();
  let continueOnError = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h':
      case '--help':
        return { helpRequested: true };
      case '-V':
      case '--version':
        return { versionRequested: true };
      case '--central-url':
        centralUrl = next() || '';
        break;
      case '--token':
        token = next() || '';
        break;
      case '--bot-name':
        botName = next() || '';
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--apply':
        dryRun = false;
        break;
      case '--memory-db-path':
        memoryDbPath = next();
        break;
      case '--skill-hub-db-path':
        skillHubDbPath = next();
        break;
      case '--include': {
        const val = next() || '';
        for (const part of val.split(',')) {
          const p = part.trim();
          if (p === 'memory' || p === 'skills') includeSet.add(p);
          else if (p) return { error: `unknown --include value: ${p}` };
        }
        break;
      }
      case '--continue-on-error':
        continueOnError = true;
        break;
      default:
        return { error: `unknown argument: ${a}` };
    }
  }

  if (!centralUrl) return { error: '--central-url is required' };
  if (!token) return { error: '--token is required' };
  if (!botName) return { error: '--bot-name is required' };

  const defaultDataDir = process.env.MEMORY_DATABASE_DIR
    ? path.resolve(process.env.MEMORY_DATABASE_DIR)
    : path.resolve(process.cwd(), 'data');

  const include: Include[] = includeSet.size > 0 ? Array.from(includeSet) : ['memory', 'skills'];

  return {
    options: {
      centralUrl: centralUrl.replace(/\/+$/, ''),
      token,
      botName,
      dryRun,
      memoryDbPath: memoryDbPath ? path.resolve(memoryDbPath) : defaultDataDir,
      skillHubDbPath: skillHubDbPath ? path.resolve(skillHubDbPath) : defaultDataDir,
      include,
      continueOnError,
    },
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.helpRequested) {
    console.log(USAGE);
    return 0;
  }
  if (parsed.versionRequested) {
    console.log('mb-migrate-to-central 0.1.0');
    return 0;
  }
  if (parsed.error) {
    console.error(`error: ${parsed.error}`);
    console.error('');
    console.error('Run with --help for usage.');
    return 2;
  }
  if (!parsed.options) {
    console.error('error: failed to parse arguments');
    return 2;
  }

  const opts = parsed.options;
  console.log(`mb-migrate-to-central — ${opts.dryRun ? 'DRY RUN' : 'APPLY'} mode`);
  console.log(`  central:      ${opts.centralUrl}`);
  console.log(`  bot-name:     ${opts.botName}`);
  console.log(`  include:      ${opts.include.join(', ')}`);
  console.log(`  memory db:    ${opts.memoryDbPath}`);
  console.log(`  skill hub db: ${opts.skillHubDbPath}`);
  console.log('');

  try {
    const summary = await runMigration(opts);
    return summary.counts.err > 0 && !opts.continueOnError ? 1 : 0;
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
}

// Invoke when run directly (handles both `node dist/migration/cli.js` and `tsx src/migration/cli.ts`)
const invokedDirectly = (() => {
  try {
    const argv1 = process.argv[1] || '';
    // Resolved path comparison — tolerate .ts vs .js
    return argv1.endsWith('migration/cli.js')
      || argv1.endsWith('migration/cli.ts')
      || argv1.endsWith('mb-migrate-to-central');
  } catch { return false; }
})();

if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
