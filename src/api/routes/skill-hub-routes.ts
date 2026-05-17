import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as http from 'node:http';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';
import type { SkillHubStore, SkillRecord, SkillSearchResult, SkillSummary, SkillPublishInput, Visibility } from '../skill-hub-store.js';
import type { SkillHubClientCentral } from '../skill-hub-client-central.js';
import { CentralUnreachableError } from '../skill-hub-client-central.js';
import { installSkillFromHub } from '../skills-installer.js';
import type { AuditOp } from '../../observability/audit-log.js';

/**
 * Thin polymorphic wrapper around the local SQLite store and the central
 * client. The local store is synchronous; the central client is async; this
 * adapter normalizes both to async so the route handlers can `await`
 * uniformly. Reads transparently fall back to the cache inside the central
 * client itself, so this layer only needs to map the surface.
 */
interface SkillFacade {
  search(query: string, options?: { visibility?: Visibility[] }): Promise<SkillSearchResult[]>;
  publish(input: SkillPublishInput): Promise<SkillRecord>;
  get(name: string): Promise<SkillRecord | undefined>;
  list(options?: { visibility?: Visibility[] }): Promise<SkillSummary[]>;
  remove(name: string): Promise<boolean>;
  getContent(name: string): Promise<{ skillMd: string; referencesTar?: Buffer } | undefined>;
}

function makeFacade(local: SkillHubStore, central?: SkillHubClientCentral): SkillFacade {
  if (central) {
    return {
      search: (q, opts) => central.search(q, opts),
      publish: (input) => central.publish(input),
      get: (name) => central.get(name),
      list: (opts) => central.list(opts),
      remove: (name) => central.remove(name),
      getContent: (name) => central.getContent(name),
    };
  }
  return {
    search: async (q, opts) => local.search(q, opts),
    publish: async (input) => local.publish(input),
    get: async (name) => local.get(name),
    list: async (opts) => local.list(opts),
    remove: async (name) => local.remove(name),
    getContent: async (name) => local.getContent(name),
  };
}

function deriveSkillOp(method: string, url: string): AuditOp | string {
  if (method === 'DELETE') return 'delete';
  if (method === 'POST') {
    if (/\/publish-from-bot$/.test(url)) return 'publish';
    if (/\/install$/.test(url)) return 'install';
    return 'publish';
  }
  if (method === 'GET') {
    if (url.startsWith('/api/skills/search')) return 'search';
    if (url === '/api/skills' || url.startsWith('/api/skills?')) return 'list';
    return 'get';
  }
  return method.toLowerCase();
}

function deriveSkillPrincipal(req: http.IncomingMessage): string {
  const origin = req.headers['x-metabot-origin'];
  if (typeof origin === 'string' && origin === 'peer') {
    const peerName = req.headers['x-metabot-peer-name'];
    return typeof peerName === 'string' && peerName ? `peer:${peerName}` : 'peer';
  }
  return 'admin';
}

function getSourceIp(req: http.IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

/**
 * Decide which visibility tiers the caller is allowed to see.
 *
 * Local admin (no `X-MetaBot-Origin: peer` header) sees everything; peers
 * authenticated via shared API_SECRET or future peer-token tiers only see
 * `published` + `shared`. See decision_acl_pragmatic_v1.md for the parallel
 * memory-server design.
 */
function visibilityFilterForRequest(req: http.IncomingMessage): Visibility[] | undefined {
  const origin = req.headers['x-metabot-origin'];
  const isPeer = typeof origin === 'string' && origin === 'peer';
  return isPeer ? ['published', 'shared'] : undefined;
}

export async function handleSkillHubRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const { logger, registry, peerManager, instance } = ctx;
  const store = ctx.skillHubStore;
  const client = ctx.skillHubClient;

  if (!url.startsWith('/api/skills')) return false;

  if (ctx.auditLog) {
    const start = Date.now();
    const op = deriveSkillOp(method, url);
    const principalId = deriveSkillPrincipal(req);
    const sourceIp = getSourceIp(req);
    const auditLog = ctx.auditLog;
    res.on('finish', () => {
      auditLog.append({
        ts: new Date().toISOString(),
        op,
        path: url,
        principalId,
        sourceIp,
        status: res.statusCode,
        latencyMs: Date.now() - start,
      });
    });
  }

  if (!store) { jsonResponse(res, 503, { error: 'Skill Hub not available' }); return true; }
  const facade = makeFacade(store, client);

  try {
    // GET /api/skills/search?q=...
    if (method === 'GET' && url.startsWith('/api/skills/search')) {
      const params = new URL(url, 'http://localhost').searchParams;
      const query = params.get('q') || '';
      const visibility = visibilityFilterForRequest(req);
      const localResults = await facade.search(query, visibility ? { visibility } : undefined);
      // Include peer skills if not a peer request
      const isPeer = req.headers['x-metabot-origin'] === 'peer';
      if (!isPeer && peerManager) {
        const peerSkills = peerManager.getPeerSkills?.() ?? [];
        const filtered = query
          ? peerSkills.filter((s) => {
              const q = query.toLowerCase();
              return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.tags.some((t) => t.toLowerCase().includes(q));
            })
          : peerSkills;
        jsonResponse(res, 200, { skills: [...localResults, ...filtered.map((s) => ({ ...s, snippet: '' }))] });
      } else {
        jsonResponse(res, 200, { skills: localResults });
      }
      return true;
    }

    // POST /api/skills/:name/publish-from-bot — publish from a bot's working directory
    if (method === 'POST' && /^\/api\/skills\/[^/]+\/publish-from-bot$/.test(url)) {
      const skillName = decodeURIComponent(url.split('/')[3]);
      const body = await parseJsonBody(req);
      const botName = body.botName as string;
      if (!botName) {
        jsonResponse(res, 400, { error: 'Missing botName' });
        return true;
      }
      const bot = registry.get(botName);
      if (!bot) {
        jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
        return true;
      }

      const skillDir = [
        path.join(bot.config.claude.defaultWorkingDirectory, '.claude', 'skills', skillName),
        path.join(bot.config.claude.defaultWorkingDirectory, '.codex', 'skills', skillName),
      ].find((candidate) => fs.existsSync(path.join(candidate, 'SKILL.md')))
        ?? path.join(bot.config.claude.defaultWorkingDirectory, '.claude', 'skills', skillName);
      const skillMdPath = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) {
        jsonResponse(res, 404, { error: `Skill not found at ${skillMdPath}` });
        return true;
      }

      const skillMd = fs.readFileSync(skillMdPath, 'utf-8');

      // Pack references/ directory if it exists
      let referencesTar: Buffer | undefined;
      const refsDir = path.join(skillDir, 'references');
      if (fs.existsSync(refsDir)) {
        try {
          const { execSync } = await import('node:child_process');
          referencesTar = execSync(`tar cf - -C "${skillDir}" references`, { maxBuffer: 50 * 1024 * 1024 });
        } catch (err: any) {
          logger.warn({ err: err.message, skillName }, 'Failed to pack references directory');
        }
      }

      const record = await facade.publish({
        name: skillName,
        skillMd,
        referencesTar,
        author: botName,
        ownerInstanceId: instance.instanceId,
        ownerInstanceName: instance.instanceName,
        visibility: 'published',
      });
      jsonResponse(res, 201, { name: record.name, version: record.version, published: true });
      return true;
    }

    // POST /api/skills/:name/install — install a skill to a bot
    if (method === 'POST' && /^\/api\/skills\/[^/]+\/install$/.test(url)) {
      const skillName = decodeURIComponent(url.split('/')[3]);
      const body = await parseJsonBody(req);
      const botName = body.botName as string;
      if (!botName) {
        jsonResponse(res, 400, { error: 'Missing botName' });
        return true;
      }
      const bot = registry.get(botName);
      if (!bot) {
        jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
        return true;
      }

      const source = (body.source as string) || 'local';

      let skillMd: string;
      let referencesTar: Buffer | undefined;

      if (source.startsWith('peer:')) {
        // Fetch from peer
        const peerName = source.slice(5);
        if (!peerManager?.fetchPeerSkill) {
          jsonResponse(res, 400, { error: 'Peer manager not available' });
          return true;
        }
        const peerSkill = await peerManager.fetchPeerSkill(peerName, skillName);
        if (!peerSkill) {
          jsonResponse(res, 404, { error: `Skill "${skillName}" not found on peer "${peerName}"` });
          return true;
        }
        skillMd = peerSkill.skillMd;
        referencesTar = peerSkill.referencesTar;
      } else {
        // Fetch from local store (or central via facade)
        const content = await facade.getContent(skillName);
        if (!content) {
          jsonResponse(res, 404, { error: `Skill not found: ${skillName}` });
          return true;
        }
        skillMd = content.skillMd;
        referencesTar = content.referencesTar;
      }

      const workDir = bot.config.claude.defaultWorkingDirectory;
      installSkillFromHub(workDir, skillName, skillMd, referencesTar, logger);
      jsonResponse(res, 200, { installed: true, botName, skillName });
      return true;
    }

    // GET /api/skills/:name — get skill details
    if (method === 'GET' && /^\/api\/skills\/[^/]+$/.test(url)) {
      const skillName = decodeURIComponent(url.split('/')[3]);
      const record = await facade.get(skillName);
      if (record) {
        const visibility = visibilityFilterForRequest(req);
        if (visibility && !visibility.includes(record.visibility)) {
          // Peer asked for a name they shouldn't even know exists — 404, not 403.
          jsonResponse(res, 404, { error: `Skill not found: ${skillName}` });
          return true;
        }
        jsonResponse(res, 200, record);
        return true;
      }
      // Try peers
      if (peerManager?.fetchPeerSkill) {
        // Search through peer skills to find which peer has it
        const peerSkills = peerManager.getPeerSkills?.() ?? [];
        const match = peerSkills.find((s) => s.name === skillName);
        if (match) {
          const full = await peerManager.fetchPeerSkill(match.peerName, skillName);
          if (full) {
            jsonResponse(res, 200, { ...full, peerName: match.peerName, peerUrl: match.peerUrl });
            return true;
          }
        }
      }
      jsonResponse(res, 404, { error: `Skill not found: ${skillName}` });
      return true;
    }

    // GET /api/skills — list all skills
    if (method === 'GET' && (url === '/api/skills' || url.startsWith('/api/skills?'))) {
      const visibility = visibilityFilterForRequest(req);
      const localSkills = await facade.list(visibility ? { visibility } : undefined);
      const isPeer = req.headers['x-metabot-origin'] === 'peer';
      if (!isPeer && peerManager?.getPeerSkills) {
        const peerSkills = peerManager.getPeerSkills();
        jsonResponse(res, 200, { skills: [...localSkills, ...peerSkills] });
      } else {
        jsonResponse(res, 200, { skills: localSkills });
      }
      return true;
    }

    // POST /api/skills — publish a skill directly
    if (method === 'POST' && url === '/api/skills') {
      const body = await parseJsonBody(req);
      const skillMd = body.skillMd as string;
      if (!skillMd) {
        jsonResponse(res, 400, { error: 'Missing skillMd' });
        return true;
      }
      const referencesTar = body.referencesTar
        ? Buffer.from(body.referencesTar as string, 'base64')
        : undefined;

      const record = await facade.publish({
        name: body.name as string || '',
        skillMd,
        referencesTar,
        author: body.author as string,
        ownerInstanceId: instance.instanceId,
        ownerInstanceName: instance.instanceName,
        visibility: (body.visibility as 'private' | 'published' | 'shared') || 'published',
      });
      jsonResponse(res, 201, { name: record.name, version: record.version, published: true });
      return true;
    }

    // DELETE /api/skills/:name
    if (method === 'DELETE' && /^\/api\/skills\/[^/]+$/.test(url)) {
      const skillName = decodeURIComponent(url.split('/')[3]);
      const removed = await facade.remove(skillName);
      if (removed) {
        jsonResponse(res, 200, { name: skillName, removed: true });
      } else {
        jsonResponse(res, 404, { error: `Skill not found: ${skillName}` });
      }
      return true;
    }

    return false;
  } catch (err) {
    if (err instanceof CentralUnreachableError) {
      logger.warn({ op: deriveSkillOp(method, url), path: url, err: err.message }, 'central_unreachable in skill-hub route');
      jsonResponse(res, 502, { error: 'central_unreachable', detail: err.message });
      return true;
    }
    throw err;
  }
}
