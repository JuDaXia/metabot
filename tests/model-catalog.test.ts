import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/http.js', () => ({ proxyFetch: vi.fn() }));

import { proxyFetch } from '../src/utils/http.js';
import {
  mapLiveClaudeModels,
  getClaudeModels,
  getModelsForEngine,
  KIMI_MODELS,
  CODEX_MODELS,
} from '../src/engines/model-catalog.js';

const mockFetch = vi.mocked(proxyFetch);

function mkRes(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

const savedKey = process.env.ANTHROPIC_API_KEY;
const savedToken = process.env.ANTHROPIC_AUTH_TOKEN;

beforeEach(() => {
  mockFetch.mockReset();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  if (savedToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
});

describe('mapLiveClaudeModels', () => {
  it('maps display_name, strips date suffix, and adds a [1m] variant for 1M models', () => {
    const out = mapLiveClaudeModels([
      { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', max_input_tokens: 1_000_000 },
      { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', max_input_tokens: 200_000 },
      { id: 'some-other-model', display_name: 'Other', max_input_tokens: 1_000_000 },
    ]);
    expect(out).toEqual([
      { id: 'claude-opus-4-8', label: 'Opus 4.8', note: '200k context' },
      { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 (1M)', note: '1M context window' },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: '200k context' },
    ]);
  });

  it('dedupes alias and dated snapshot of the same model', () => {
    const out = mapLiveClaudeModels([
      { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', max_input_tokens: 1_000_000 },
      { id: 'claude-sonnet-4-6-20251114', display_name: 'Claude Sonnet 4.6', max_input_tokens: 1_000_000 },
    ]);
    expect(out.filter((m) => m.id === 'claude-sonnet-4-6')).toHaveLength(1);
  });
});

describe('getClaudeModels', () => {
  it('falls back to the static list (incl. opus-4-8) when no credentials are set', async () => {
    const { models, source } = await getClaudeModels({ force: true });
    expect(source).toBe('static');
    expect(models.some((m) => m.id === 'claude-opus-4-8')).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches live from the Models API when ANTHROPIC_API_KEY is set, sending x-api-key', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockFetch.mockResolvedValueOnce(
      mkRes({
        data: [{ id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', max_input_tokens: 1_000_000 }],
        has_more: false,
      }),
    );
    const { models, source } = await getClaudeModels({ force: true });
    expect(source).toBe('live');
    expect(models[0]).toEqual({ id: 'claude-opus-4-8', label: 'Opus 4.8', note: '200k context' });
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-test');
  });

  it('falls back to static when the live fetch returns a non-OK response', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockFetch.mockResolvedValueOnce(mkRes({ error: 'nope' }, false));
    const { source } = await getClaudeModels({ force: true });
    expect(source).toBe('static');
  });

  it('caches results — a non-forced call does not re-fetch', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockFetch.mockResolvedValue(
      mkRes({ data: [{ id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', max_input_tokens: 1_000_000 }], has_more: false }),
    );
    await getClaudeModels({ force: true });
    const callsAfterFirst = mockFetch.mock.calls.length;
    await getClaudeModels(); // cached
    expect(mockFetch.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('getModelsForEngine', () => {
  it('returns the static Kimi list', async () => {
    const { models, source } = await getModelsForEngine('kimi');
    expect(source).toBe('static');
    expect(models).toBe(KIMI_MODELS);
  });

  it('returns the static Codex list', async () => {
    const { models } = await getModelsForEngine('codex');
    expect(models).toBe(CODEX_MODELS);
  });
});
