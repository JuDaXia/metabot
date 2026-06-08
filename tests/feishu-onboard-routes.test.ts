import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

// Stub the device-code flow + bot runner so the route never touches the network or a WS.
vi.mock('../src/feishu/qr-onboard.js', () => ({
  initRegistration: vi.fn(async () => {}),
  beginRegistration: vi.fn(async () => ({
    deviceCode: 'dc_test',
    qrUrl: 'https://example.com/auth?from=metabot&tp=metabot',
    userCode: 'UC1',
    interval: 5,
    expireIn: 600,
  })),
  // Never resolves — keeps the background session in "pending" for the test.
  pollRegistration: vi.fn(() => new Promise<never>(() => {})),
  probeBot: vi.fn(async () => null),
  renderQrTerminal: vi.fn(async () => 'ASCII_QR'),
}));
vi.mock('../src/feishu/feishu-bot-runner.js', () => ({ startFeishuBot: vi.fn() }));

import { handleFeishuOnboardRoutes } from '../src/api/routes/feishu-onboard-routes.js';
import { BotRegistry } from '../src/api/bot-registry.js';
import { createLogger } from '../src/utils/logger.js';
import type { RouteContext } from '../src/api/routes/types.js';

function mkReq(method: string, bodyObj?: unknown): any {
  const payload = Buffer.from(bodyObj === undefined ? '' : JSON.stringify(bodyObj));
  const req = Readable.from([payload]) as any;
  req.method = method;
  return req;
}

interface FakeRes {
  statusCode: number;
  body: any;
  writeHead(status: number, headers?: unknown): void;
  end(data?: string): void;
}
function mkRes(): FakeRes {
  return {
    statusCode: 0,
    body: undefined,
    writeHead(status: number) {
      this.statusCode = status;
    },
    end(data?: string) {
      this.body = data ? JSON.parse(data) : undefined;
    },
  };
}

let tmpDir: string;
let botsConfigPath: string;

function makeCtx(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    registry: new BotRegistry(),
    logger: createLogger('fatal'),
    botsConfigPath,
    ws: {},
    ...overrides,
  } as unknown as RouteContext;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-onboard-'));
  botsConfigPath = path.join(tmpDir, 'bots.json');
  fs.writeFileSync(botsConfigPath, JSON.stringify({ feishuBots: [] }));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('handleFeishuOnboardRoutes', () => {
  it('400 when BOTS_CONFIG is not set', async () => {
    const ctx = makeCtx({ botsConfigPath: undefined });
    const res = mkRes();
    const handled = await handleFeishuOnboardRoutes(
      ctx,
      mkReq('POST', { name: 'x', defaultWorkingDirectory: '/tmp/x' }),
      res as any,
      'POST',
      '/api/feishu/onboard',
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/BOTS_CONFIG/);
  });

  it('400 when name or working directory is missing', async () => {
    const res = mkRes();
    await handleFeishuOnboardRoutes(makeCtx(), mkReq('POST', { name: 'x' }), res as any, 'POST', '/api/feishu/onboard');
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/defaultWorkingDirectory/);
  });

  it('409 when a bot with the same name already exists in config', async () => {
    fs.writeFileSync(
      botsConfigPath,
      JSON.stringify({
        feishuBots: [{ name: 'dup', feishuAppId: 'a', feishuAppSecret: 'b', defaultWorkingDirectory: '/tmp' }],
      }),
    );
    const res = mkRes();
    await handleFeishuOnboardRoutes(
      makeCtx(),
      mkReq('POST', { name: 'dup', defaultWorkingDirectory: '/tmp/dup' }),
      res as any,
      'POST',
      '/api/feishu/onboard',
    );
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/already exists/);
  });

  it('201 begins a session and returns a QR; status is then pending; cancel works', async () => {
    const ctx = makeCtx();

    // Begin
    const beginRes = mkRes();
    await handleFeishuOnboardRoutes(
      ctx,
      mkReq('POST', { name: 'newbot', defaultWorkingDirectory: path.join(tmpDir, 'wd') }),
      beginRes as any,
      'POST',
      '/api/feishu/onboard',
    );
    expect(beginRes.statusCode).toBe(201);
    expect(beginRes.body.sessionId).toBeTruthy();
    expect(beginRes.body.qrTerminal).toBe('ASCII_QR');
    expect(beginRes.body.qrUrl).toContain('from=metabot');
    const sessionId = beginRes.body.sessionId;

    // Status → pending
    const statusRes = mkRes();
    await handleFeishuOnboardRoutes(ctx, mkReq('GET'), statusRes as any, 'GET', `/api/feishu/onboard/${sessionId}`);
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.body.status).toBe('pending');

    // Cancel
    const delRes = mkRes();
    await handleFeishuOnboardRoutes(ctx, mkReq('DELETE'), delRes as any, 'DELETE', `/api/feishu/onboard/${sessionId}`);
    expect(delRes.statusCode).toBe(200);
    expect(delRes.body.cancelled).toBe(true);

    // After cancel the session is gone → 404
    const goneRes = mkRes();
    await handleFeishuOnboardRoutes(ctx, mkReq('GET'), goneRes as any, 'GET', `/api/feishu/onboard/${sessionId}`);
    expect(goneRes.statusCode).toBe(404);
  });

  it('404 for an unknown session id', async () => {
    const res = mkRes();
    await handleFeishuOnboardRoutes(makeCtx(), mkReq('GET'), res as any, 'GET', '/api/feishu/onboard/nope');
    expect(res.statusCode).toBe(404);
  });
});
