import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the proxy-aware fetch so no real network calls happen.
vi.mock('../src/utils/http.js', () => ({ proxyFetch: vi.fn() }));

import { proxyFetch } from '../src/utils/http.js';
import {
  initRegistration,
  beginRegistration,
  pollRegistration,
  probeBot,
  renderQrTerminal,
} from '../src/feishu/qr-onboard.js';

const mockFetch = vi.mocked(proxyFetch);

/** Build a minimal Response-like object exposing text()/json(). */
function mkRes(obj: unknown, status = 200): Response {
  return {
    status,
    text: async () => JSON.stringify(obj),
    json: async () => obj,
  } as unknown as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('initRegistration', () => {
  it('passes when client_secret auth is supported', async () => {
    mockFetch.mockResolvedValueOnce(mkRes({ supported_auth_methods: ['client_secret'] }));
    await expect(initRegistration('feishu')).resolves.toBeUndefined();
  });

  it('throws when client_secret auth is not supported', async () => {
    mockFetch.mockResolvedValueOnce(mkRes({ supported_auth_methods: ['authorization_code'] }));
    await expect(initRegistration('feishu')).rejects.toThrow(/client_secret/);
  });
});

describe('beginRegistration', () => {
  it('parses device_code and appends metabot params to the QR url', async () => {
    mockFetch.mockResolvedValueOnce(
      mkRes({
        device_code: 'dc_123',
        verification_uri_complete: 'https://example.com/auth?a=1',
        user_code: 'UC9',
        interval: 5,
        expire_in: 600,
      }),
    );
    const res = await beginRegistration('feishu');
    expect(res.deviceCode).toBe('dc_123');
    expect(res.qrUrl).toBe('https://example.com/auth?a=1&from=metabot&tp=metabot');
    expect(res.userCode).toBe('UC9');
    expect(res.interval).toBe(5);
    expect(res.expireIn).toBe(600);
  });

  it('appends with ? when the verification url has no query', async () => {
    mockFetch.mockResolvedValueOnce(
      mkRes({ device_code: 'dc', verification_uri_complete: 'https://example.com/auth' }),
    );
    const res = await beginRegistration('feishu');
    expect(res.qrUrl).toBe('https://example.com/auth?from=metabot&tp=metabot');
  });

  it('throws when no device_code is returned', async () => {
    mockFetch.mockResolvedValueOnce(mkRes({ verification_uri_complete: 'https://x' }));
    await expect(beginRegistration('feishu')).rejects.toThrow(/device_code/);
  });
});

describe('pollRegistration', () => {
  it('returns credentials when client_id + client_secret arrive', async () => {
    mockFetch.mockResolvedValueOnce(
      mkRes({ client_id: 'cli_1', client_secret: 'sec_1', user_info: { open_id: 'ou_1' } }),
    );
    const creds = await pollRegistration({ deviceCode: 'dc', interval: 0, expireIn: 5 });
    expect(creds).toEqual({ appId: 'cli_1', appSecret: 'sec_1', domain: 'feishu', openId: 'ou_1' });
  });

  it('auto-switches to lark when tenant_brand is lark, then uses lark accounts URL', async () => {
    mockFetch
      .mockResolvedValueOnce(mkRes({ error: 'authorization_pending', user_info: { tenant_brand: 'lark' } }))
      .mockResolvedValueOnce(mkRes({ client_id: 'cli_2', client_secret: 'sec_2', user_info: { open_id: 'ou_2', tenant_brand: 'lark' } }));
    const creds = await pollRegistration({ deviceCode: 'dc', interval: 0, expireIn: 5 });
    expect(creds?.domain).toBe('lark');
    expect(creds?.appId).toBe('cli_2');
    // Second poll must target the Lark accounts host.
    expect(String(mockFetch.mock.calls[1][0])).toContain('accounts.larksuite.com');
  });

  it('returns null on access_denied', async () => {
    mockFetch.mockResolvedValueOnce(mkRes({ error: 'access_denied' }));
    const creds = await pollRegistration({ deviceCode: 'dc', interval: 0, expireIn: 5 });
    expect(creds).toBeNull();
  });

  it('returns null on timeout (always authorization_pending)', async () => {
    mockFetch.mockResolvedValue(mkRes({ error: 'authorization_pending' }));
    const creds = await pollRegistration({ deviceCode: 'dc', interval: 0, expireIn: 0.05 });
    expect(creds).toBeNull();
  });

  it('returns null immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const creds = await pollRegistration({ deviceCode: 'dc', interval: 0, expireIn: 5, signal: ac.signal });
    expect(creds).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('probeBot', () => {
  it('parses bot.app_name and open_id', async () => {
    mockFetch
      .mockResolvedValueOnce(mkRes({ tenant_access_token: 'tok' }))
      .mockResolvedValueOnce(mkRes({ code: 0, bot: { app_name: 'My Bot', open_id: 'ou_bot' } }));
    const res = await probeBot('cli', 'sec', 'feishu');
    expect(res).toEqual({ botName: 'My Bot', botOpenId: 'ou_bot' });
  });

  it('returns null when bot info code != 0', async () => {
    mockFetch
      .mockResolvedValueOnce(mkRes({ tenant_access_token: 'tok' }))
      .mockResolvedValueOnce(mkRes({ code: 99, msg: 'nope' }));
    const res = await probeBot('cli', 'sec', 'feishu');
    expect(res).toBeNull();
  });

  it('returns null when no tenant_access_token is issued', async () => {
    mockFetch.mockResolvedValueOnce(mkRes({ code: 10000, msg: 'bad creds' }));
    const res = await probeBot('cli', 'sec', 'feishu');
    expect(res).toBeNull();
  });
});

describe('renderQrTerminal', () => {
  it('renders a non-empty terminal string for a URL', async () => {
    const out = await renderQrTerminal('https://example.com/auth?x=1');
    expect(typeof out).toBe('string');
    expect((out as string).length).toBeGreaterThan(0);
  });
});
