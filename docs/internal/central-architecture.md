# Central Architecture (Phase 1+ design spec)

> Status: Implementation in progress (overnight 2026-05-17 → 2026-05-18). Authoritative spec for `central-builder` agent.

## Background

MetaBot is pivoting from P2P federation to a centralized memory + skill hub. See [`~/.claude/projects/.../memory/decision_central_architecture_pivot.md`](decision_central_architecture_pivot.md) for the ADR.

## High-level shape

```
┌─────────────────────────────────────────────────┐
│  Central Server (single host, ECS)              │
│  - HTTPS via Caddy + Let's Encrypt              │
│  - Node.js process (port 8200)                  │
│  - SQLite at data/central.db                    │
│  - Audit log JSONL at data/audit/               │
│  - Doc blobs in SQLite (small) or fs (large)    │
└────────┬────────────────────────────────────────┘
         │ HTTPS + Bearer credential token
    ┌────┴───────┬─────────┬─────────┐
    │            │         │         │
  floodsung    dkj       tom       ...
  metabot     metabot   metabot
```

Each metabot client knows the central URL and one bearer credential. Reads/writes go to central; local SQLite is a read-only fallback cache.

## Code layout

```
central/                          # NEW top-level module
├── package.json                  # separate from main metabot to keep deps minimal
├── tsconfig.json
├── src/
│   ├── index.ts                  # entry, starts http server
│   ├── server.ts                 # http server, routing
│   ├── auth/
│   │   ├── credentials.ts        # credential CRUD, token resolution
│   │   ├── credentials-store.ts  # SQLite store
│   │   └── auth-middleware.ts    # request → Principal
│   ├── memory/
│   │   ├── memory-store.ts       # ADAPTED FROM src/memory/memory-storage.ts
│   │   ├── memory-routes.ts      # ADAPTED FROM src/memory/memory-routes.ts
│   │   └── acl.ts                # namespace-based ACL
│   ├── skills/
│   │   ├── skill-store.ts        # ADAPTED FROM src/api/skill-hub-store.ts
│   │   ├── skill-routes.ts       # ADAPTED FROM src/api/routes/skill-hub-routes.ts
│   │   └── publish-acl.ts        # publish-skill permission check
│   ├── admin/
│   │   ├── admin-routes.ts       # /admin/* endpoints
│   │   └── admin-cli.ts          # CLI tool to bootstrap admin / issue credentials
│   └── observability/
│       └── audit-log.ts          # reuse from Phase 0 PR 3
├── Dockerfile
├── docker-compose.yml            # local dev
├── deploy/
│   ├── Caddyfile                 # TLS termination
│   ├── central.service           # systemd unit
│   └── install.sh                # one-shot install on ECS
├── bin/
│   └── central-admin             # admin CLI
└── tests/
```

## Data model

### Credential
```ts
interface Credential {
  id: string;                     // uuid v4
  token: string;                  // 32-byte hex, displayed once at issue time
  tokenHash: string;              // sha256 of token, stored
  botName: string;                // 'floodsung-main', 'dkj-laptop'
  ownerName: string;              // 'Flood Sung', 'dkj'
  role: 'admin' | 'member';
  writableNamespaces: string[];   // e.g., ['/users/dkj']
  readableNamespaces: string[];   // e.g., ['/shared', '/users/dkj']
  publishSkill: boolean;          // default false
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
  notes: string;                  // free-form
}
```

### Namespace conventions

```
/users/<bot-name>/private/...   # only this credential reads/writes
/users/<bot-name>/projects/...  # this credential writes; others read iff granted
/shared/skills/...              # canonical skill bundles, admin-only write, all-read
/shared/teams/<team>/...        # team-shared
/archive/...                    # admin-only write, all-read (decommissioned namespaces)
```

### ACL resolution

```ts
function canRead(cred: Credential, path: string): boolean {
  if (cred.role === 'admin') return true;
  if (path.startsWith('/shared/')) return true;
  return cred.readableNamespaces.some(ns => path.startsWith(ns));
}

function canWrite(cred: Credential, path: string): boolean {
  if (cred.role === 'admin') return true;
  return cred.writableNamespaces.some(ns => path.startsWith(ns));
}

function canPublishSkill(cred: Credential): boolean {
  return cred.role === 'admin' || cred.publishSkill;
}
```

## API

### Manifest (open)

```
GET /api/manifest
→ { schemaVersion, instance: { name, publicKey }, capabilities: { memory, skills } }
```

### Credentials (admin-only)

```
POST /admin/credentials/issue
Body: { botName, ownerName, role: 'member', writableNamespaces?, readableNamespaces?, publishSkill?, notes? }
→ { credential: Credential, token: "<one-time display>" }

POST /admin/credentials/revoke
Body: { credentialId }
→ { ok: true, revokedAt }

GET /admin/credentials
→ { credentials: Credential[] (without token) }

GET /admin/audit?date=YYYY-MM-DD&principal=&op=
→ { entries: AuditEntry[] }
```

### Memory (credential auth)

```
GET    /api/memory/folders?prefix=/users/dkj  → list folders matching ACL
GET    /api/memory/folders/:path              → folder details + immediate children
POST   /api/memory/folders                    → create
PATCH  /api/memory/folders/:path              → update metadata
DELETE /api/memory/folders/:path              → delete (admin or owner)

GET    /api/memory/documents/:path            → get doc content
POST   /api/memory/documents                  → create
PATCH  /api/memory/documents/:path            → update
DELETE /api/memory/documents/:path            → delete

GET    /api/memory/search?q=                  → search within accessible namespaces only
```

### Skills (credential auth)

```
GET    /api/skills                            → list (visibility-filtered for member)
GET    /api/skills/:name                      → details + bundle
POST   /api/skills/:name/publish              → publish (requires publishSkill)
DELETE /api/skills/:name                      → unpublish (admin only)
GET    /api/skills/search?q=                  → search
```

### Health

```
GET /health                                   → { ok: true, uptime, version }
```

## Auth flow

1. Bot starts metabot with `METABOT_BACKEND=central`, `CENTRAL_URL=https://central.example.com`, `CENTRAL_TOKEN=<bearer>`
2. Every request: `Authorization: Bearer <token>`
3. Server resolves token → Credential via `tokenHash` lookup; updates `lastUsedAt`
4. Revoked credentials: `revokedAt != null` → 401 with `{ error: 'credential_revoked' }`
5. Audit log: every request `(ts, op, path, credentialId, sourceIp, status, latencyMs)`

## Admin bootstrap

On first startup with empty DB:
1. Generate admin credential automatically
2. Write the one-time token to stdout AND to `data/admin-bootstrap-token.txt` (chmod 600)
3. Log a loud warning: "ADMIN TOKEN BOOTSTRAPPED — SAVE IT NOW; this is the only time it's displayed"
4. On subsequent startups, skip bootstrap (existing admin credential persists)

CLI: `central-admin issue --bot dkj-laptop --owner dkj --role member` (requires admin token via env or stdin).

## Deployment

### ECS host setup

```bash
# Run as user, not root
sudo useradd -m -s /bin/bash central
sudo mkdir -p /var/lib/central /etc/central
sudo chown central:central /var/lib/central

# Install Caddy
sudo apt install caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile

# Install Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash
sudo apt install nodejs

# Install central
cd /opt && sudo git clone https://github.com/<repo> metabot
cd metabot/central && sudo npm install && sudo npm run build
sudo cp deploy/central.service /etc/systemd/system/
sudo systemctl enable --now central caddy
```

### Caddyfile

```
central.example.com {
    reverse_proxy localhost:8200
}
```

### systemd unit

```ini
[Unit]
Description=MetaBot Central Server
After=network.target

[Service]
Type=simple
User=central
WorkingDirectory=/opt/metabot/central
EnvironmentFile=/etc/central/env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Required env vars

```
CENTRAL_PORT=8200
CENTRAL_DATA_DIR=/var/lib/central
CENTRAL_AUDIT_DIR=/var/lib/central/audit
```

## Phase 2: metabot client mode (separate PR)

Client mode lives in `src/memory/memory-client-central.ts`:
- Wraps `MemoryClient` interface
- All reads/writes proxied to central via HTTPS
- Local SQLite cache for last-known-good (read-only on network failure)
- Same for `src/api/skill-hub-store.ts` — local cache + central forward

Config:
```
METABOT_BACKEND=central
CENTRAL_URL=https://central.example.com
CENTRAL_TOKEN=mt_<32-byte-hex>
CENTRAL_FALLBACK_READONLY=true  # default
```

When `METABOT_BACKEND=local` (default for backward compat during migration), metabot behaves as today.

## Phase 3: migration tool

`bin/mb-migrate-to-central`:
1. Read local SQLite (memory + skill-hub)
2. For each folder/doc/skill, POST to central using owner's credential
3. Map namespace: local `/projects/X` → central `/users/<botname>/projects/X` (or per-bot mapping config)
4. Dry-run mode (default) shows what would be uploaded
5. `--apply` to actually upload
6. On success, mark local DB as migrated (don't delete — keep for fallback)

## Phase 4: P2P teardown (PR opened, NOT merged tonight)

Files to delete:
- `src/cluster/mdns.ts`
- `src/cluster/peer-manager.ts` (and dependents)
- `src/cluster/peer-token.ts`
- `src/api/routes/sync-routes.ts` (the peer parts)
- `src/api/routes/search-routes.ts` (federated search)
- `data/peer-cache.json`
- `bin/mm peer-search`
- All `mDNS` config in `.env.example`

Tests to delete:
- `tests/peer-*.test.ts`
- `tests/mdns-*.test.ts`
- `tests/memory-proxy-auth.test.ts` (the cross-instance bits)

Keep:
- `tests/memory-proxy-auth.test.ts` admin/local cases (bridge still proxies to central)
- `src/api/routes/memory-proxy.ts` (now proxies to central instead of local memory-server)

## Open questions (defer until central live)

1. **Backup of central DB itself**: cron `sqlite3 .backup` to S3-compatible storage. Decide bucket later.
2. **Schema migrations**: future schema changes need versioning. Use embedded migration files; on startup run pending.
3. **Multi-region**: out of scope for now.
4. **Compliance log retention**: 1 year? 7 years? Ask user post-launch.
