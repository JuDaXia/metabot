import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type * as http from 'node:http';
import { addBot, getBotEntry } from '../bots-config-writer.js';
import { installSkillsToWorkDir } from '../skills-installer.js';
import { feishuBotFromJson, type FeishuBotJsonEntry } from '../../config.js';
import { startFeishuBot } from '../../feishu/feishu-bot-runner.js';
import {
  initRegistration,
  beginRegistration,
  pollRegistration,
  probeBot,
  renderQrTerminal,
  type FeishuDomain,
} from '../../feishu/qr-onboard.js';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';

type OnboardStatus = 'pending' | 'success' | 'failed' | 'expired';

interface OnboardSession {
  sessionId: string;
  status: OnboardStatus;
  qrUrl: string;
  userCode: string;
  botName?: string;
  error?: string;
  createdAt: number;
  abort: AbortController;
}

// Device codes live ~10 min; keep a small grace window before evicting a finished/expired session.
const SESSION_TTL_MS = 15 * 60 * 1000;
const sessions = new Map<string, OnboardSession>();

function cleanupSessions(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) {
      s.abort.abort();
      sessions.delete(id);
    }
  }
}

/**
 * QR scan-to-create Feishu / Lark bot onboarding.
 *
 *   POST   /api/feishu/onboard        — start the device-code flow, return QR + sessionId
 *   GET    /api/feishu/onboard/:id    — poll the session status
 *   DELETE /api/feishu/onboard/:id    — cancel an in-flight session
 *
 * On success the server writes the bot to bots.json and hot-activates it (no restart),
 * mirroring the add-bot logic in bot-routes.ts.
 */
export async function handleFeishuOnboardRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const path = url.split('?')[0];

  // POST /api/feishu/onboard — begin
  if (method === 'POST' && path === '/api/feishu/onboard') {
    await beginOnboard(ctx, req, res);
    return true;
  }

  // GET /api/feishu/onboard/:sessionId — status
  if (method === 'GET' && path.startsWith('/api/feishu/onboard/')) {
    cleanupSessions();
    const sessionId = decodeURIComponent(path.slice('/api/feishu/onboard/'.length));
    const session = sessions.get(sessionId);
    if (!session) {
      jsonResponse(res, 404, { error: `Onboard session not found: ${sessionId}` });
      return true;
    }
    jsonResponse(res, 200, {
      status: session.status,
      qrUrl: session.qrUrl,
      userCode: session.userCode,
      ...(session.botName ? { botName: session.botName } : {}),
      ...(session.error ? { error: session.error } : {}),
    });
    return true;
  }

  // DELETE /api/feishu/onboard/:sessionId — cancel
  if (method === 'DELETE' && path.startsWith('/api/feishu/onboard/')) {
    const sessionId = decodeURIComponent(path.slice('/api/feishu/onboard/'.length));
    const session = sessions.get(sessionId);
    if (!session) {
      jsonResponse(res, 404, { error: `Onboard session not found: ${sessionId}` });
      return true;
    }
    session.abort.abort();
    sessions.delete(sessionId);
    jsonResponse(res, 200, { sessionId, cancelled: true });
    return true;
  }

  return false;
}

async function beginOnboard(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const { registry, logger, botsConfigPath } = ctx;

  if (!botsConfigPath) {
    jsonResponse(res, 400, { error: 'Feishu onboarding requires BOTS_CONFIG to be set' });
    return;
  }

  const body = await parseJsonBody(req);
  const name = (body.name as string)?.trim();
  const workDir = (body.defaultWorkingDirectory as string)?.trim();
  const domain: FeishuDomain = body.domain === 'lark' ? 'lark' : 'feishu';

  if (!name || !workDir) {
    jsonResponse(res, 400, { error: 'Missing required fields: name, defaultWorkingDirectory' });
    return;
  }

  // Reject duplicate names up front (before showing a QR the user would scan for nothing).
  if (registry.get(name) || getBotEntry(botsConfigPath, name)) {
    jsonResponse(res, 409, { error: `Bot with name "${name}" already exists` });
    return;
  }

  // Start the device-code flow.
  let begin;
  try {
    await initRegistration(domain);
    begin = await beginRegistration(domain);
  } catch (err: any) {
    logger.warn({ err: err?.message || err }, 'Feishu onboarding: begin failed');
    jsonResponse(res, 502, { error: `Could not reach Feishu / Lark registration: ${err?.message || err}` });
    return;
  }

  cleanupSessions();
  const sessionId = crypto.randomUUID();
  const session: OnboardSession = {
    sessionId,
    status: 'pending',
    qrUrl: begin.qrUrl,
    userCode: begin.userCode,
    createdAt: Date.now(),
    abort: new AbortController(),
  };
  sessions.set(sessionId, session);

  const qrTerminal = await renderQrTerminal(begin.qrUrl);

  // Drive the rest of the flow in the background; the CLI polls the status endpoint.
  void runOnboard(ctx, session, begin, {
    name,
    defaultWorkingDirectory: workDir,
    domain,
    engine: body.engine as string | undefined,
    description: body.description as string | undefined,
    model: body.model as string | undefined,
    maxTurns: body.maxTurns as number | undefined,
    maxBudgetUsd: body.maxBudgetUsd as number | undefined,
    codex: body.codex,
    kimi: body.kimi,
    installSkills: body.installSkills === true,
  });

  jsonResponse(res, 201, {
    sessionId,
    qrUrl: begin.qrUrl,
    ...(qrTerminal ? { qrTerminal } : {}),
    userCode: begin.userCode,
    interval: begin.interval,
    expiresIn: begin.expireIn,
  });
}

interface OnboardParams {
  name: string;
  defaultWorkingDirectory: string;
  domain: FeishuDomain;
  engine?: string;
  description?: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  codex?: unknown;
  kimi?: unknown;
  installSkills: boolean;
}

async function runOnboard(
  ctx: RouteContext,
  session: OnboardSession,
  begin: { deviceCode: string; interval: number; expireIn: number },
  params: OnboardParams,
): Promise<void> {
  const { registry, logger, botsConfigPath, memoryServerUrl, memoryAuthToken, ws } = ctx;

  const creds = await pollRegistration({
    deviceCode: begin.deviceCode,
    interval: begin.interval,
    expireIn: begin.expireIn,
    domain: params.domain,
    signal: session.abort.signal,
  });

  if (session.abort.signal.aborted) return; // cancelled / evicted

  if (!creds) {
    session.status = 'expired';
    session.error = 'QR registration was denied, expired, or timed out.';
    return;
  }

  try {
    // Best-effort: resolve the bot's display name.
    const probe = await probeBot(creds.appId, creds.appSecret, creds.domain);

    const entry: FeishuBotJsonEntry = {
      name: params.name,
      feishuAppId: creds.appId,
      feishuAppSecret: creds.appSecret,
      defaultWorkingDirectory: params.defaultWorkingDirectory,
      ...(creds.domain === 'lark' ? { domain: 'lark' as const } : {}),
      ...(params.description ? { description: params.description } : {}),
      ...(params.engine ? { engine: params.engine as FeishuBotJsonEntry['engine'] } : {}),
      ...(params.codex ? { codex: params.codex as FeishuBotJsonEntry['codex'] } : {}),
      ...(params.kimi ? { kimi: params.kimi as FeishuBotJsonEntry['kimi'] } : {}),
      ...(params.model ? { model: params.model } : {}),
      ...(params.maxTurns ? { maxTurns: params.maxTurns } : {}),
      ...(params.maxBudgetUsd ? { maxBudgetUsd: params.maxBudgetUsd } : {}),
    };

    fs.mkdirSync(params.defaultWorkingDirectory, { recursive: true });
    addBot(botsConfigPath!, 'feishu', entry);
    logger.info({ name: params.name, domain: creds.domain }, 'Feishu bot added to config via QR onboarding');

    if (params.installSkills) {
      installSkillsToWorkDir(params.defaultWorkingDirectory, logger, { platform: 'feishu' });
    }

    // Hot-activate — bot serves immediately, no restart.
    const config = feishuBotFromJson(entry);
    const handle = await startFeishuBot(
      config,
      logger,
      memoryServerUrl || 'http://localhost:8100',
      memoryAuthToken,
    );
    registry.register({
      name: handle.name,
      platform: 'feishu',
      config: handle.config,
      bridge: handle.bridge,
      sender: handle.sender,
      feishuClient: handle.feishuClient,
      wsClient: handle.wsClient,
    });
    ws.handle?.broadcastBotList();

    session.botName = probe?.botName || params.name;
    session.status = 'success';
    logger.info({ name: params.name }, 'Feishu bot hot-activated via QR onboarding');
  } catch (err: any) {
    logger.error({ err: err?.message || err, name: params.name }, 'Feishu onboarding: activation failed');
    session.status = 'failed';
    session.error =
      `Credentials obtained, but activation failed: ${err?.message || err}. ` +
      `The bot may be saved in bots.json — restart MetaBot to activate it.`;
  }
}
