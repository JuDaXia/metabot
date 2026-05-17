/**
 * SkillHubClientCentral — Phase 2 of the central-architecture pivot.
 *
 * Async facade over the central server's `/api/skills/*` endpoints, with a
 * local SQLite-backed `SkillHubStore` retained as the read-only fallback
 * cache. Writes (publish/remove) fail loudly with `CentralUnreachableError`
 * when central is down; reads fall back to the cache.
 *
 * Wire shape mirrors MemoryClientCentral:
 *   - `Authorization: Bearer ${CENTRAL_TOKEN}` on every outbound call.
 *   - `X-MetaBot-Origin: client` (+ optional `X-MetaBot-Client-Bot`) for
 *     central-side audit attribution.
 *   - 3 s default timeout, fallback-readonly on by default.
 */

import type { Logger } from '../utils/logger.js';
import { proxyFetch } from '../utils/http.js';
import {
  SkillHubStore,
  type ListOptions,
  type SkillPublishInput,
  type SkillRecord,
  type SkillSearchResult,
  type SkillSummary,
} from './skill-hub-store.js';

export interface SkillHubClientCentralOptions {
  centralUrl: string;
  centralToken: string;
  fallbackReadonly?: boolean;
  clientBot?: string;
  cache: SkillHubStore;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger: Logger;
}

export class CentralUnreachableError extends Error {
  statusCode = 502;
  cause: unknown;
  constructor(op: string, cause: unknown) {
    super(`central_unreachable: ${op}`);
    this.name = 'CentralUnreachableError';
    this.cause = cause;
  }
}

export class SkillHubClientCentral {
  private readonly centralUrl: string;
  private readonly centralToken: string;
  private readonly fallbackReadonly: boolean;
  private readonly clientBot: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: SkillHubStore;
  private readonly logger: Logger;

  constructor(opts: SkillHubClientCentralOptions) {
    if (!opts.centralUrl) throw new Error('centralUrl is required');
    if (!opts.centralToken) throw new Error('centralToken is required');
    this.centralUrl = opts.centralUrl.replace(/\/+$/, '');
    this.centralToken = opts.centralToken;
    this.fallbackReadonly = opts.fallbackReadonly ?? true;
    this.clientBot = opts.clientBot;
    this.timeoutMs = opts.timeoutMs ?? 3000;
    this.fetchImpl = opts.fetchImpl ?? (proxyFetch as unknown as typeof fetch);
    this.cache = opts.cache;
    this.logger = opts.logger;
  }

  getCache(): SkillHubStore {
    return this.cache;
  }

  async publish(input: SkillPublishInput): Promise<SkillRecord> {
    const body: Record<string, unknown> = {
      skillMd: input.skillMd,
      visibility: input.visibility || 'published',
    };
    if (input.referencesTar) body.referencesTar = input.referencesTar.toString('base64');
    const opPath = `/api/skills/${encodeURIComponent(input.name)}/publish`;
    try {
      const { status, json } = await this.request('POST', opPath, body);
      if (status === 201 || status === 200) {
        // Central returns { name, version, published: true }; round-trip a
        // GET to surface the full record (matches local SkillHubStore.publish).
        const fetched = await this.getInternal(input.name);
        if (fetched) {
          // Mirror to cache for fallback reads.
          try { this.cache.publish(input); } catch { /* ignore cache write failure */ }
          return fetched;
        }
        // If round-trip get fails, fall back to local cache
        return this.cache.publish(input);
      }
      if (this.isServerFailure(status)) throw new CentralUnreachableError('publish', `status ${status}`);
      throw this.makeStatusError(status, json, 'publish');
    } catch (err) {
      if (this.isAbortOrNetwork(err)) throw new CentralUnreachableError('publish', err);
      throw err;
    }
  }

  async get(name: string): Promise<SkillRecord | undefined> {
    return this.getInternal(name);
  }

  private async getInternal(name: string): Promise<SkillRecord | undefined> {
    const opPath = `/api/skills/${encodeURIComponent(name)}`;
    try {
      const { status, json } = await this.request('GET', opPath);
      if (status === 200) {
        return centralRecordToLocal(json);
      }
      if (status === 404) return undefined;
      throw this.makeStatusError(status, json, 'get');
    } catch (err) {
      if (this.shouldFallback(err)) {
        this.logFallback('get', opPath, err);
        return this.cache.get(name);
      }
      throw err;
    }
  }

  async getContent(name: string): Promise<{ skillMd: string; referencesTar?: Buffer } | undefined> {
    const record = await this.getInternal(name);
    if (!record) return undefined;
    // Central's GET /api/skills/:name returns the full skill including
    // `skillMd`. References tar is delivered via a separate endpoint in
    // future phases; for now, fall back to the local cache for tar bytes.
    const cached = this.cache.getContent(name);
    return {
      skillMd: record.skillMd,
      ...(cached?.referencesTar ? { referencesTar: cached.referencesTar } : {}),
    };
  }

  async list(options?: ListOptions): Promise<SkillSummary[]> {
    const opPath = '/api/skills';
    try {
      const { status, json } = await this.request('GET', opPath);
      if (status === 200 && json && typeof json === 'object') {
        const skills = (json.skills || []) as any[];
        const filtered = options?.visibility
          ? skills.filter((s) => options.visibility!.includes(s.visibility || 'published'))
          : skills;
        return filtered.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description || '',
          version: s.version || 1,
          author: s.author || '',
          ...(s.ownerInstanceId ? { ownerInstanceId: s.ownerInstanceId } : {}),
          ...(s.ownerInstanceName ? { ownerInstanceName: s.ownerInstanceName } : {}),
          visibility: s.visibility || 'published',
          contentHash: s.contentHash || '',
          tags: s.tags || [],
          publishedAt: s.publishedAt || s.published_at || '',
          updatedAt: s.updatedAt || s.updated_at || '',
        }));
      }
      throw this.makeStatusError(status, json, 'list');
    } catch (err) {
      if (this.shouldFallback(err)) {
        this.logFallback('list', opPath, err);
        return this.cache.list(options);
      }
      throw err;
    }
  }

  async search(query: string, options?: ListOptions): Promise<SkillSearchResult[]> {
    const params = new URLSearchParams({ q: query });
    const opPath = `/api/skills/search?${params}`;
    try {
      const { status, json } = await this.request('GET', opPath);
      if (status === 200 && json && typeof json === 'object') {
        const skills = (json.skills || []) as any[];
        const filtered = options?.visibility
          ? skills.filter((s) => options.visibility!.includes(s.visibility || 'published'))
          : skills;
        return filtered.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description || '',
          version: s.version || 1,
          author: s.author || '',
          ...(s.ownerInstanceId ? { ownerInstanceId: s.ownerInstanceId } : {}),
          ...(s.ownerInstanceName ? { ownerInstanceName: s.ownerInstanceName } : {}),
          visibility: s.visibility || 'published',
          contentHash: s.contentHash || '',
          tags: s.tags || [],
          publishedAt: s.publishedAt || s.published_at || '',
          updatedAt: s.updatedAt || s.updated_at || '',
          snippet: s.snippet || '',
        }));
      }
      throw this.makeStatusError(status, json, 'search');
    } catch (err) {
      if (this.shouldFallback(err)) {
        this.logFallback('search', opPath, err);
        return this.cache.search(query, options);
      }
      throw err;
    }
  }

  async remove(name: string): Promise<boolean> {
    const opPath = `/api/skills/${encodeURIComponent(name)}`;
    try {
      const { status } = await this.request('DELETE', opPath);
      if (status === 200) {
        try { this.cache.remove(name); } catch { /* ignore */ }
        return true;
      }
      if (status === 404) return false;
      if (this.isServerFailure(status)) throw new CentralUnreachableError('remove', `status ${status}`);
      throw this.makeStatusError(status, null, 'remove');
    } catch (err) {
      if (this.isAbortOrNetwork(err)) throw new CentralUnreachableError('remove', err);
      throw err;
    }
  }

  // ---- Internals ----

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.centralToken}`,
      'X-MetaBot-Origin': 'client',
    };
    if (this.clientBot) headers['X-MetaBot-Client-Bot'] = this.clientBot;
    return headers;
  }

  private async request(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const url = `${this.centralUrl}${path}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    const init: RequestInit = {
      method,
      headers: this.buildHeaders(),
      signal: ac.signal,
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    try {
      const res = await this.fetchImpl(url, init);
      const text = await res.text();
      let json: any = null;
      if (text) {
        try { json = JSON.parse(text); } catch { json = text; }
      }
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  private isServerFailure(status: number): boolean {
    return status >= 500 && status < 600;
  }

  private shouldFallback(err: unknown): boolean {
    if (!this.fallbackReadonly) return false;
    if (err instanceof CentralUnreachableError) return true;
    return this.isAbortOrNetwork(err);
  }

  private isAbortOrNetwork(err: unknown): boolean {
    if (err instanceof CentralUnreachableError) return true;
    if (!err || typeof err !== 'object') return false;
    const e = err as { name?: string; code?: string; message?: string };
    if (e.name === 'AbortError') return true;
    if (e.code && /ECONN|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|EAI_AGAIN|UND_ERR/.test(e.code)) return true;
    if (e.message && /fetch failed|network|getaddrinfo|connect/i.test(e.message)) return true;
    return false;
  }

  private makeStatusError(status: number, json: any, op: string): Error {
    const message = json && typeof json === 'object' && 'error' in json
      ? String(json.error)
      : `central_status_${status}_${op}`;
    return Object.assign(new Error(message), { statusCode: status });
  }

  private logFallback(op: string, path: string, err: unknown): void {
    this.logger.warn({ op, path, err: (err as Error)?.message || String(err) }, 'central unreachable — falling back to local cache');
  }
}

function centralRecordToLocal(raw: any): SkillRecord {
  return {
    id: raw.id || '',
    name: raw.name || '',
    description: raw.description || '',
    version: raw.version || 1,
    author: raw.author || '',
    ...(raw.ownerInstanceId ? { ownerInstanceId: raw.ownerInstanceId } : {}),
    ...(raw.ownerInstanceName ? { ownerInstanceName: raw.ownerInstanceName } : {}),
    visibility: raw.visibility || 'published',
    contentHash: raw.contentHash || raw.content_hash || '',
    tags: raw.tags || [],
    userInvocable: raw.userInvocable !== false,
    ...(raw.context ? { context: raw.context } : {}),
    ...(raw.allowedTools ? { allowedTools: raw.allowedTools } : {}),
    skillMd: raw.skillMd || raw.skill_md || '',
    hasReferences: !!raw.hasReferences,
    publishedAt: raw.publishedAt || raw.published_at || '',
    updatedAt: raw.updatedAt || raw.updated_at || '',
  };
}

/**
 * Factory — creates a `SkillHubClientCentral` with a local cache.
 */
export function createSkillHubClientCentral(opts: {
  centralUrl: string;
  centralToken: string;
  fallbackReadonly?: boolean;
  clientBot?: string;
  cacheDir: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger: Logger;
}): SkillHubClientCentral {
  const cache = new SkillHubStore(opts.cacheDir, opts.logger);
  return new SkillHubClientCentral({
    centralUrl: opts.centralUrl,
    centralToken: opts.centralToken,
    ...(opts.fallbackReadonly !== undefined ? { fallbackReadonly: opts.fallbackReadonly } : {}),
    ...(opts.clientBot ? { clientBot: opts.clientBot } : {}),
    cache,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    logger: opts.logger,
  });
}
