/**
 * Feishu / Lark "scan-QR-to-create-bot" onboarding — device-code OAuth flow.
 *
 * Ported from NousResearch/hermes-agent (gateway/platforms/feishu.py `qr_register`).
 * The user scans a QR with the Feishu / Lark mobile app; the platform then creates a
 * fully-configured `PersonalAgent` bot application and hands back its app_id / app_secret.
 *
 * Flow: init → begin → poll → probe. Pure HTTP (no special SDK), proxy-aware via proxyFetch.
 */
import QRCode from 'qrcode';
import { proxyFetch } from '../utils/http.js';

export type FeishuDomain = 'feishu' | 'lark';

export interface BeginResult {
  deviceCode: string;
  /** URL encoded into the QR; opening it in the Feishu / Lark app starts authorization. */
  qrUrl: string;
  userCode: string;
  /** Poll interval in seconds. */
  interval: number;
  /** Lifetime of the device code in seconds. */
  expireIn: number;
}

export interface RegistrationCredentials {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  openId?: string;
}

export interface BotProbeResult {
  botName?: string;
  botOpenId?: string;
}

// --- Endpoints (mirror hermes constants) ---
const ACCOUNTS_URLS: Record<FeishuDomain, string> = {
  feishu: 'https://accounts.feishu.cn',
  lark: 'https://accounts.larksuite.com',
};
const OPEN_URLS: Record<FeishuDomain, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};
const REGISTRATION_PATH = '/oauth/v1/app/registration';
const REQUEST_TIMEOUT_MS = 10_000;

function accountsBaseUrl(domain: FeishuDomain): string {
  return ACCOUNTS_URLS[domain] ?? ACCOUNTS_URLS.feishu;
}

function openBaseUrl(domain: FeishuDomain): string {
  return OPEN_URLS[domain] ?? OPEN_URLS.feishu;
}

/**
 * POST form-encoded data to the registration endpoint and parse JSON.
 *
 * The registration endpoint returns JSON even on 4xx (e.g. poll returns
 * `authorization_pending` as a 400), so we parse the body regardless of HTTP status.
 */
async function postRegistration(
  baseUrl: string,
  body: Record<string, string>,
): Promise<Record<string, any>> {
  const res = await proxyFetch(`${baseUrl}${REGISTRATION_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    throw new Error(`Feishu / Lark registration returned non-JSON (HTTP ${res.status})`);
  }
}

/** Verify the environment supports client_secret auth. Throws if not. */
export async function initRegistration(domain: FeishuDomain = 'feishu'): Promise<void> {
  const res = await postRegistration(accountsBaseUrl(domain), { action: 'init' });
  const methods: string[] = res.supported_auth_methods ?? [];
  if (!methods.includes('client_secret')) {
    throw new Error(
      `Feishu / Lark registration environment does not support client_secret auth. ` +
        `Supported: ${methods.join(', ') || 'none'}`,
    );
  }
}

/** Start the device-code flow. */
export async function beginRegistration(domain: FeishuDomain = 'feishu'): Promise<BeginResult> {
  const res = await postRegistration(accountsBaseUrl(domain), {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id',
  });
  const deviceCode = res.device_code;
  if (!deviceCode) {
    throw new Error('Feishu / Lark registration did not return a device_code');
  }
  let qrUrl: string = res.verification_uri_complete ?? '';
  qrUrl += (qrUrl.includes('?') ? '&' : '?') + 'from=metabot&tp=metabot';
  return {
    deviceCode,
    qrUrl,
    userCode: res.user_code ?? '',
    interval: res.interval || 5,
    expireIn: res.expire_in || 600,
  };
}

/**
 * Poll until the user scans the QR code, or timeout / denial.
 *
 * Returns credentials on success, null on denial / expiry / timeout / abort.
 * Auto-detects Lark tenants mid-poll via `user_info.tenant_brand` and switches the
 * accounts base URL accordingly.
 */
export async function pollRegistration(opts: {
  deviceCode: string;
  interval: number;
  expireIn: number;
  domain?: FeishuDomain;
  signal?: AbortSignal;
}): Promise<RegistrationCredentials | null> {
  const { deviceCode, interval, expireIn, signal } = opts;
  let currentDomain: FeishuDomain = opts.domain ?? 'feishu';
  let domainSwitched = false;
  const deadline = Date.now() + expireIn * 1000;

  while (Date.now() < deadline) {
    if (signal?.aborted) return null;

    let res: Record<string, any>;
    try {
      res = await postRegistration(accountsBaseUrl(currentDomain), {
        action: 'poll',
        device_code: deviceCode,
        tp: 'ob_app',
      });
    } catch {
      await sleep(interval * 1000, signal);
      continue;
    }

    // Lark auto-detection — server may return credentials in this same response.
    const userInfo = res.user_info ?? {};
    if (userInfo.tenant_brand === 'lark' && !domainSwitched) {
      currentDomain = 'lark';
      domainSwitched = true;
    }

    if (res.client_id && res.client_secret) {
      return {
        appId: res.client_id,
        appSecret: res.client_secret,
        domain: currentDomain,
        openId: userInfo.open_id,
      };
    }

    const error = res.error ?? '';
    if (error === 'access_denied' || error === 'expired_token') {
      return null;
    }

    // authorization_pending or unknown — keep polling
    await sleep(interval * 1000, signal);
  }
  return null;
}

/**
 * Verify bot connectivity via /open-apis/bot/v3/info. Best-effort: returns null on failure.
 * `botOpenId` is the bot's app-scoped open_id (the ID Feishu puts in @mention payloads).
 */
export async function probeBot(
  appId: string,
  appSecret: string,
  domain: FeishuDomain,
): Promise<BotProbeResult | null> {
  const baseUrl = openBaseUrl(domain);
  try {
    const tokenRes = await proxyFetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const tokenData: Record<string, any> = await tokenRes.json();
    const accessToken = tokenData.tenant_access_token;
    if (!accessToken) return null;

    const botRes = await proxyFetch(`${baseUrl}/open-apis/bot/v3/info`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const botData: Record<string, any> = await botRes.json();
    return parseBotResponse(botData);
  } catch {
    return null;
  }
}

function parseBotResponse(data: Record<string, any>): BotProbeResult | null {
  // /bot/v3/info returns bot.app_name; legacy paths used bot_name — accept both.
  if (data.code !== 0) return null;
  const bot = data.bot ?? data.data?.bot ?? {};
  return {
    botName: bot.app_name ?? bot.bot_name,
    botOpenId: bot.open_id,
  };
}

/** Render a QR code as a terminal-printable ASCII string. Returns null if rendering fails. */
export async function renderQrTerminal(url: string): Promise<string | null> {
  try {
    return await QRCode.toString(url, { type: 'terminal', small: true });
  } catch {
    return null;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
