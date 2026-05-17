import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startMemoryServer } from '../src/memory/memory-server.js';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
}

/**
 * Default-Private Folder semantics.
 *
 * Folders created without an explicit `visibility` default to `private`.
 * `mm share` (PUT /api/folders/<id> { visibility: 'shared' }) opts a folder in.
 *
 * These tests cover the new default + the share/unshare flip + the
 * instance-token namespace creation path.
 */
describe('default-private folders', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      cleanup?.();
    }
  });

  async function startAdminServer() {
    const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metamemory-default-private-test-'));
    cleanups.push(() => fs.rmSync(databaseDir, { recursive: true, force: true }));

    const { server, storage } = startMemoryServer({
      port: 0,
      databaseDir,
      adminToken: 'admin-token',
      logger: createLogger(),
    });

    cleanups.push(() => storage.close());
    cleanups.push(() => server.close());

    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${address.port}` };
  }

  async function startInstanceTokenServer() {
    const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metamemory-default-private-inst-'));
    cleanups.push(() => fs.rmSync(databaseDir, { recursive: true, force: true }));

    const { server, storage } = startMemoryServer({
      port: 0,
      databaseDir,
      adminToken: 'admin-token',
      instanceToken: 'instance-token',
      instanceId: 'alice',
      memoryNamespace: '/instances/alice',
      logger: createLogger(),
    });

    cleanups.push(() => storage.close());
    cleanups.push(() => server.close());

    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${address.port}` };
  }

  const adminHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer admin-token' };

  it('folder created without visibility defaults to private', async () => {
    const { url } = await startAdminServer();

    const folderResp = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'unspecified' }),
    });
    expect(folderResp.status).toBe(201);
    const folder = await folderResp.json() as { id: string; visibility: string };
    expect(folder.visibility).toBe('private');
  });

  it('explicit visibility=shared is honored on create', async () => {
    const { url } = await startAdminServer();

    const folderResp = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'opt-in-shared', visibility: 'shared' }),
    });
    expect(folderResp.status).toBe(201);
    const folder = await folderResp.json() as { id: string; visibility: string };
    expect(folder.visibility).toBe('shared');
  });

  it('admin sees default-private folders in tree (local backward compat)', async () => {
    const { url } = await startAdminServer();

    await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'admin-visible' }),
    });

    const tree = await fetch(`${url}/api/folders`, { headers: { Authorization: 'Bearer admin-token' } });
    expect(tree.status).toBe(200);
    expect(JSON.stringify(await tree.json())).toContain('admin-visible');
  });

  it('PUT visibility=shared flips a folder from private to shared', async () => {
    const { url } = await startAdminServer();

    const folderResp = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'will-be-shared' }),
    });
    const folder = await folderResp.json() as { id: string; visibility: string };
    expect(folder.visibility).toBe('private');

    const shareResp = await fetch(`${url}/api/folders/${folder.id}`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ visibility: 'shared' }),
    });
    expect(shareResp.status).toBe(200);
    const updated = await shareResp.json() as { visibility: string };
    expect(updated.visibility).toBe('shared');
  });

  it('PUT visibility=private flips a shared folder back to private', async () => {
    const { url } = await startAdminServer();

    const folderResp = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'will-be-unshared', visibility: 'shared' }),
    });
    const folder = await folderResp.json() as { id: string; visibility: string };
    expect(folder.visibility).toBe('shared');

    const unshareResp = await fetch(`${url}/api/folders/${folder.id}`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ visibility: 'private' }),
    });
    expect(unshareResp.status).toBe(200);
    const updated = await unshareResp.json() as { visibility: string };
    expect(updated.visibility).toBe('private');
  });

  it('instance-token can create default-private folders in its namespace', async () => {
    const { url } = await startInstanceTokenServer();

    const instanceHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer instance-token' };

    const instancesResp = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: instanceHeaders,
      body: JSON.stringify({ name: 'instances' }),
    });
    expect(instancesResp.status).toBe(201);
    const instances = await instancesResp.json() as { id: string; visibility: string };
    expect(instances.visibility).toBe('private');

    const aliceResp = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: instanceHeaders,
      body: JSON.stringify({ name: 'alice', parent_id: instances.id }),
    });
    expect(aliceResp.status).toBe(201);
    const alice = await aliceResp.json() as { id: string; visibility: string };
    expect(alice.visibility).toBe('private');
  });
});
