/**
 * Model catalog — the selectable model lists for the `/model` picker and the
 * `GET /api/models` endpoint.
 *
 * Claude models are fetched live from the Anthropic Models API (`GET /v1/models`)
 * when an API key / auth token is available, and fall back to a maintained static
 * list otherwise (so the list still stays current for subscription-OAuth users who
 * have no API key). Kimi and Codex have no equivalent enumeration endpoint, so they
 * remain static.
 */
import { proxyFetch } from '../utils/http.js';
import type { EngineName } from './index.js';

export interface ModelOption {
  id: string;
  label: string;
  note: string;
}

export type ModelSource = 'live' | 'static';

// --- Static fallbacks ---------------------------------------------------------

/**
 * Maintained Claude list — used when the live Models API is unreachable or no
 * credentials are configured. Keep the latest models at the top. The `[1m]`
 * variants opt into the 1M context window (Claude Code convention); the base id
 * uses the default 200k context.
 */
const STATIC_CLAUDE_MODELS: ModelOption[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', note: 'Most capable · 200k context' },
  { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M)', note: '1M context window' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', note: '200k context' },
  { id: 'claude-opus-4-7[1m]', label: 'Opus 4.7 (1M)', note: '1M context window' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', note: '200k context' },
  { id: 'claude-opus-4-6[1m]', label: 'Opus 4.6 (1M)', note: '1M context window' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', note: 'Balanced · 200k context' },
  { id: 'claude-sonnet-4-6[1m]', label: 'Sonnet 4.6 (1M)', note: '1M context window' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: 'Fastest · 200k context' },
];

export const KIMI_MODELS: ModelOption[] = [
  { id: 'kimi-for-coding', label: 'Kimi for Coding', note: 'Subscription default · 256k context · thinking' },
  { id: 'kimi-k2', label: 'Kimi K2', note: 'Legacy coding model' },
];

export const CODEX_MODELS: ModelOption[] = [
  { id: 'gpt-5.4-codex', label: 'GPT-5.4 Codex', note: 'Recommended Codex coding model' },
  { id: 'gpt-5.4', label: 'GPT-5.4', note: 'General flagship model' },
  { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', note: 'Legacy Codex coding model' },
];

// --- Live Claude fetch --------------------------------------------------------

const MODELS_API_URL = 'https://api.anthropic.com/v1/models';
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const ONE_MILLION = 1_000_000;

let claudeCache: { at: number; models: ModelOption[]; source: ModelSource } | null = null;

function formatContext(tokens: number): string {
  if (tokens >= ONE_MILLION) return '1M';
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/** Map raw Anthropic Models API objects into picker options (newest first). */
export function mapLiveClaudeModels(raw: Array<Record<string, any>>): ModelOption[] {
  const out: ModelOption[] = [];
  const seen = new Set<string>();
  for (const m of raw) {
    const rawId: string = m?.id ?? '';
    if (!/^claude-(opus|sonnet|haiku)-\d/.test(rawId)) continue;
    // Collapse dated snapshot ids (e.g. claude-haiku-4-5-20251001 → claude-haiku-4-5).
    const id = rawId.replace(/-\d{8}$/, '');
    if (seen.has(id)) continue;
    seen.add(id);
    const label = typeof m?.display_name === 'string' ? m.display_name.replace(/^Claude\s+/, '') : id;
    const ctx = Number(m?.max_input_tokens ?? m?.context_window ?? 0);
    const supports1m = ctx >= ONE_MILLION;
    out.push({ id, label, note: supports1m ? '200k context' : `${formatContext(ctx)} context` });
    if (supports1m) {
      out.push({ id: `${id}[1m]`, label: `${label} (1M)`, note: '1M context window' });
    }
  }
  return out;
}

async function fetchLiveClaudeModels(): Promise<ModelOption[] | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (!apiKey && !authToken) return null; // no credentials — use the static list

  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  if (apiKey) headers['x-api-key'] = apiKey;
  else headers['authorization'] = `Bearer ${authToken}`;

  try {
    const all: Array<Record<string, any>> = [];
    let url = `${MODELS_API_URL}?limit=100`;
    for (let page = 0; page < 10; page++) {
      const res = await proxyFetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body: Record<string, any> = await res.json();
      const data: Array<Record<string, any>> = body?.data ?? [];
      all.push(...data);
      if (!body?.has_more || !body?.last_id) break;
      url = `${MODELS_API_URL}?limit=100&after_id=${encodeURIComponent(body.last_id)}`;
    }
    const mapped = mapLiveClaudeModels(all);
    return mapped.length ? mapped : null;
  } catch {
    return null;
  }
}

/** Claude model list — live when possible (cached 1h), static fallback otherwise. */
export async function getClaudeModels(opts?: { force?: boolean }): Promise<{ models: ModelOption[]; source: ModelSource }> {
  if (!opts?.force && claudeCache && Date.now() - claudeCache.at < CACHE_TTL_MS) {
    return { models: claudeCache.models, source: claudeCache.source };
  }
  const live = await fetchLiveClaudeModels();
  const result = live
    ? { models: live, source: 'live' as const }
    : { models: STATIC_CLAUDE_MODELS, source: 'static' as const };
  claudeCache = { at: Date.now(), ...result };
  return result;
}

/** Model list for a given engine. Claude is dynamic; Kimi/Codex are static. */
export async function getModelsForEngine(engine: EngineName): Promise<{ models: ModelOption[]; source: ModelSource }> {
  switch (engine) {
    case 'kimi':
      return { models: KIMI_MODELS, source: 'static' };
    case 'codex':
      return { models: CODEX_MODELS, source: 'static' };
    case 'claude':
    default:
      return getClaudeModels();
  }
}

/** All engines' model lists — used by `GET /api/models`. */
export async function getAllModels(): Promise<{
  claude: ModelOption[];
  kimi: ModelOption[];
  codex: ModelOption[];
  claudeSource: ModelSource;
}> {
  const claude = await getClaudeModels();
  return { claude: claude.models, kimi: KIMI_MODELS, codex: CODEX_MODELS, claudeSource: claude.source };
}
