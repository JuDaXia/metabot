import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startMemoryServer } from '../src/memory/memory-server.js';
import { proxyMemoryRequest } from '../src/api/routes/memory-proxy.js';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
}

describe('memory proxy Authorization passthrough', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  async function startStack(opts: {
    memoryAuthToken?: string;
  }): Promise<{ proxyUrl: string; memoryUrl: string }> {
    const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memproxy-test-'));
    cleanups.push(() => fs.rmSync(databaseDir, { recursive: true, force: true }));

    const { server: memServer, storage } = startMemoryServer({
      port: 0,
      databaseDir,
      adminToken: 'admin-token',
      logger: createLogger(),
    });
    cleanups.push(() => storage.close());
    cleanups.push(() => memServer.close());
    await new Promise<void>((resolve) => memServer.once('listening', resolve));
    const memAddr = memServer.address() as AddressInfo;
    const memoryUrl = `http://127.0.0.1:${memAddr.port}`;

    const proxyServer = http.createServer((req, res) => {
      const url = req.url || '/';
      if (!url.startsWith('/memory')) {
        res.writeHead(404).end();
        return;
      }
      proxyMemoryRequest(req, res, url, req.method || 'GET', {
        memoryUrl,
        ...(opts.memoryAuthToken ? { memoryAuthToken: opts.memoryAuthToken } : {}),
        logger: createLogger(),
      }).catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    });
    proxyServer.listen(0);
    cleanups.push(() => proxyServer.close());
    await new Promise<void>((resolve) => proxyServer.once('listening', resolve));
    const proxyAddr = proxyServer.address() as AddressInfo;
    const proxyUrl = `http://127.0.0.1:${proxyAddr.port}`;

    return { proxyUrl, memoryUrl };
  }

  it('forwards inbound Authorization verbatim (does not rewrite to admin)', async () => {
    const { proxyUrl } = await startStack({ memoryAuthToken: 'admin-token' });

    // Caller presents a bogus bearer; the proxy must NOT rewrite to admin —
    // otherwise an unauthenticated caller would silently get admin access.
    const resp = await fetch(`${proxyUrl}/memory/api/folders`, {
      headers: { Authorization: 'Bearer not-a-known-token' },
    });
    expect(resp.status).toBe(401);
  });

  it('falls back to the configured admin token when caller sends no Authorization (web UI use case)', async () => {
    const { proxyUrl } = await startStack({ memoryAuthToken: 'admin-token' });

    // No Authorization header — admin fallback should kick in so the local
    // web UI keeps working unauthenticated against the bridge.
    const resp = await fetch(`${proxyUrl}/memory/api/folders`);
    expect(resp.status).toBe(200);
  });
});
