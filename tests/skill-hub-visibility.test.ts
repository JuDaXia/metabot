/**
 * Skill Hub visibility filter regression coverage.
 *
 * Before this fix, /api/skills (list) and /api/skills/search returned every
 * skill regardless of `visibility`, so a cross-instance peer authenticated
 * with our API_SECRET (or any future peer-token tier) could read skills
 * the owner had marked `private`. The store now accepts an optional
 * `visibility` filter and the route layer enforces it whenever the caller
 * looks like a peer (X-MetaBot-Origin: peer).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { SkillHubStore } from '../src/api/skill-hub-store.js';
import { handleSkillHubRoutes } from '../src/api/routes/skill-hub-routes.js';
import type { RouteContext } from '../src/api/routes/types.js';

function createLogger() {
  const fns = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { ...fns, child: () => createLogger() } as any;
}

function seedSkills(store: SkillHubStore) {
  store.publish({
    name: 'private-skill',
    skillMd: '---\nname: private-skill\ndescription: Private only\ntags: secret\n---\n# Private',
    author: 'bot',
    ownerInstanceId: 'local-id',
    ownerInstanceName: 'Local',
    visibility: 'private',
  });
  store.publish({
    name: 'published-skill',
    skillMd: '---\nname: published-skill\ndescription: Public skill\ntags: shared, secret\n---\n# Published',
    author: 'bot',
    ownerInstanceId: 'local-id',
    ownerInstanceName: 'Local',
    visibility: 'published',
  });
  store.publish({
    name: 'shared-skill',
    skillMd: '---\nname: shared-skill\ndescription: Shared skill\ntags: shared, secret\n---\n# Shared',
    author: 'bot',
    ownerInstanceId: 'local-id',
    ownerInstanceName: 'Local',
    visibility: 'shared',
  });
}

describe('SkillHubStore visibility filter', () => {
  let store: SkillHubStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-hub-vis-'));
    store = new SkillHubStore(tmpDir, createLogger());
    seedSkills(store);
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('list() with no filter returns every skill (local admin view)', () => {
    const names = store.list().map((s) => s.name).sort();
    expect(names).toEqual(['private-skill', 'published-skill', 'shared-skill']);
  });

  it('list({ visibility: [published, shared] }) hides private skills', () => {
    const names = store.list({ visibility: ['published', 'shared'] })
      .map((s) => s.name).sort();
    expect(names).toEqual(['published-skill', 'shared-skill']);
  });

  it('search() with no filter returns every match', () => {
    const names = store.search('secret').map((s) => s.name).sort();
    expect(names).toEqual(['private-skill', 'published-skill', 'shared-skill']);
  });

  it('search({ visibility: [published, shared] }) hides private hits', () => {
    const names = store.search('secret', { visibility: ['published', 'shared'] })
      .map((s) => s.name).sort();
    expect(names).toEqual(['published-skill', 'shared-skill']);
  });

  it('search with empty query honors visibility filter (falls back to list)', () => {
    const names = store.search('', { visibility: ['published', 'shared'] })
      .map((s) => s.name).sort();
    expect(names).toEqual(['published-skill', 'shared-skill']);
  });
});

describe('skill-hub-routes peer-visibility enforcement', () => {
  let server: http.Server;
  let baseUrl: string;
  let tmpDir: string;
  let store: SkillHubStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-hub-routes-'));
    store = new SkillHubStore(tmpDir, createLogger());
    seedSkills(store);

    const ctx = {
      logger: createLogger(),
      skillHubStore: store,
      registry: { get: () => undefined, list: () => [], listRegistered: () => [] } as any,
      peerManager: undefined,
      instance: { instanceId: 'local-id', instanceName: 'Local' } as any,
    } as unknown as RouteContext;

    server = http.createServer(async (req, res) => {
      try {
        const handled = await handleSkillHubRoutes(ctx, req, res, req.method || 'GET', req.url || '/');
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
        }
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    server.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('local request (no peer origin header) sees private + published + shared on /api/skills', async () => {
    const resp = await fetch(`${baseUrl}/api/skills`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { skills: Array<{ name: string }> };
    expect(body.skills.map((s) => s.name).sort()).toEqual([
      'private-skill', 'published-skill', 'shared-skill',
    ]);
  });

  it('peer request (X-MetaBot-Origin: peer) sees only published + shared on /api/skills', async () => {
    const resp = await fetch(`${baseUrl}/api/skills`, {
      headers: { 'X-MetaBot-Origin': 'peer' },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { skills: Array<{ name: string }> };
    expect(body.skills.map((s) => s.name).sort()).toEqual([
      'published-skill', 'shared-skill',
    ]);
  });

  it('local request sees every match on /api/skills/search', async () => {
    const resp = await fetch(`${baseUrl}/api/skills/search?q=secret`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { skills: Array<{ name: string }> };
    expect(body.skills.map((s) => s.name).sort()).toEqual([
      'private-skill', 'published-skill', 'shared-skill',
    ]);
  });

  it('peer request hides private hits on /api/skills/search', async () => {
    const resp = await fetch(`${baseUrl}/api/skills/search?q=secret`, {
      headers: { 'X-MetaBot-Origin': 'peer' },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { skills: Array<{ name: string }> };
    expect(body.skills.map((s) => s.name).sort()).toEqual([
      'published-skill', 'shared-skill',
    ]);
  });

  it('peer install of a published skill still works', async () => {
    // Cross-instance install path: GET /api/skills/:name. Make sure we did
    // not regress this — peers must still be able to fetch a published skill
    // record by name. Private fetches by peer should 404.
    const okResp = await fetch(`${baseUrl}/api/skills/published-skill`, {
      headers: { 'X-MetaBot-Origin': 'peer' },
    });
    expect(okResp.status).toBe(200);
    const okBody = await okResp.json() as { name: string; visibility: string };
    expect(okBody.name).toBe('published-skill');
    expect(okBody.visibility).toBe('published');

    const privateResp = await fetch(`${baseUrl}/api/skills/private-skill`, {
      headers: { 'X-MetaBot-Origin': 'peer' },
    });
    expect(privateResp.status).toBe(404);
  });
});
