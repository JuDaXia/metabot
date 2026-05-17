/**
 * Map local memory paths to central memory paths.
 *
 * Rules (per ADR `decision_central_architecture_pivot.md` + Phase 3 spec):
 *   - `/projects/<X>`           → `/users/<bot-name>/projects/<X>`
 *   - `/instances/<id>/...`     → `/users/<bot-name>/private/...`
 *   - `/shared/...`             → `/shared/...`              (1:1)
 *   - `/users/<other>/...`      → SKIP (not ours to migrate; null return)
 *   - `/`                       → null (root never migrates)
 *   - anything else             → `/users/<bot-name>/<rest>` (best effort)
 */
export function mapLocalToCentral(localPath: string, botName: string): string | null {
  if (!botName.trim()) throw new Error('bot-name required');
  const sanitizedBot = botName.trim();

  let p = localPath.trim();
  if (!p.startsWith('/')) p = '/' + p;
  // collapse trailing slash (except root)
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);

  if (p === '/') return null;
  if (p === '/shared' || p.startsWith('/shared/')) return p;

  if (p === '/users') return null; // never migrate the bare /users namespace
  if (p.startsWith('/users/')) {
    // /users/<x>/... — only ours if <x> matches botName
    const segments = p.slice('/users/'.length).split('/');
    const owner = segments[0];
    if (owner === sanitizedBot) return p; // already correctly namespaced
    return null;
  }

  if (p === '/projects') return `/users/${sanitizedBot}/projects`;
  if (p.startsWith('/projects/')) {
    return `/users/${sanitizedBot}/projects/${p.slice('/projects/'.length)}`;
  }

  if (p === '/instances') return null; // skip the bare instances namespace
  if (p.startsWith('/instances/')) {
    // /instances/<id>/<rest> → /users/<bot>/private/<rest>
    const segments = p.slice('/instances/'.length).split('/');
    const rest = segments.slice(1).join('/'); // drop the instance id
    return rest
      ? `/users/${sanitizedBot}/private/${rest}`
      : `/users/${sanitizedBot}/private`;
  }

  // Catch-all: park unknown top-level namespaces under /users/<bot>/<segment>.
  // This keeps unknown trees migratable instead of silently dropping them.
  return `/users/${sanitizedBot}${p}`;
}
