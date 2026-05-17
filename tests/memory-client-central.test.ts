import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MemoryStorage } from '../src/memory/memory-storage.js';
import {
  MemoryClientCentral,
  CentralUnreachableError,
  createMemoryClientCentral,
} from '../src/memory/memory-client-central.js';

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: () => createLogger() } as any;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function makeFetch(responder: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: FetchCall[] = [];
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), init: init || {} });
    return responder(String(url), init || {});
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('MemoryClientCentral', () => {
  let tmpDir: string;
  let cache: MemoryStorage;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-client-central-'));
    cache = new MemoryStorage(tmpDir, createLogger());
  });

  afterEach(() => {
    cache.close?.();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sends bearer token + origin headers on outbound calls', async () => {
    const { fn, calls } = makeFetch(() => jsonResponse(200, {
      id: 'root', name: 'root', path: '/', children: [], document_count: 0,
    }));
    const client = new MemoryClientCentral({
      centralUrl: 'https://central.example.com',
      centralToken: 'sekret',
      clientBot: 'alpha-bot',
      cache,
      fetchImpl: fn,
      logger: createLogger(),
    });

    await client.getFolderTree();

    expect(calls).toHaveLength(1);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sekret');
    expect(headers['X-MetaBot-Origin']).toBe('client');
    expect(headers['X-MetaBot-Client-Bot']).toBe('alpha-bot');
    expect(calls[0].url).toBe('https://central.example.com/api/memory/folders/tree');
  });

  it('returns folder tree from central on happy path', async () => {
    const fixture = {
      id: 'root',
      name: 'root',
      path: '/',
      document_count: 2,
      children: [
        { id: 'f1', name: 'projects', path: '/projects', children: [], document_count: 1 },
      ],
    };
    const { fn } = makeFetch(() => jsonResponse(200, fixture));
    const client = new MemoryClientCentral({
      centralUrl: 'https://central.example.com',
      centralToken: 't',
      cache,
      fetchImpl: fn,
      logger: createLogger(),
    });

    const tree = await client.getFolderTree();
    expect(tree.id).toBe('root');
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].name).toBe('projects');
    expect(tree.children[0].path).toBe('/projects');
  });

  it('falls back to local cache on network error for getFolderTree', async () => {
    const networkError = Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
    const { fn } = makeFetch(() => { throw networkError; });
    const logger = createLogger();
    const client = new MemoryClientCentral({
      centralUrl: 'https://central.example.com',
      centralToken: 't',
      cache,
      fetchImpl: fn,
      logger,
      fallbackReadonly: true,
    });

    const tree = await client.getFolderTree();
    // Cache returns at minimum the synthetic root
    expect(tree).toBeDefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('does NOT fall back when fallbackReadonly=false', async () => {
    const networkError = Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
    const { fn } = makeFetch(() => { throw networkError; });
    const client = new MemoryClientCentral({
      centralUrl: 'https://central.example.com',
      centralToken: 't',
      cache,
      fetchImpl: fn,
      logger: createLogger(),
      fallbackReadonly: false,
    });

    await expect(client.getFolderTree()).rejects.toBeTruthy();
  });

  it('throws CentralUnreachableError on write when central is down', async () => {
    const networkError = Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
    const { fn } = makeFetch(() => { throw networkError; });
    const client = new MemoryClientCentral({
      centralUrl: 'https://central.example.com',
      centralToken: 't',
      cache,
      fetchImpl: fn,
      logger: createLogger(),
    });

    await expect(client.createFolder('new', 'root')).rejects.toBeInstanceOf(CentralUnreachableError);
  });

  it('throws CentralUnreachableError on write when central returns 5xx', async () => {
    const { fn } = makeFetch(() => jsonResponse(502, { error: 'bad gateway' }));
    const client = new MemoryClientCentral({
      centralUrl: 'https://central.example.com',
      centralToken: 't',
      cache,
      fetchImpl: fn,
      logger: createLogger(),
    });

    await expect(client.createFolder('new', 'root')).rejects.toBeInstanceOf(CentralUnreachableError);
  });

  it('searchDocuments falls back to cache on network error', async () => {
    const networkError = Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
    const { fn } = makeFetch(() => { throw networkError; });
    const logger = createLogger();
    const client = new MemoryClientCentral({
      centralUrl: 'https://central.example.com',
      centralToken: 't',
      cache,
      fetchImpl: fn,
      logger,
    });

    const results = await client.searchDocuments('test');
    expect(Array.isArray(results)).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('aborts request after timeout and falls back to cache for reads', async () => {
    const { fn } = makeFetch(async (_url, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal | undefined;
        if (!signal) return;
        signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const client = new MemoryClientCentral({
      centralUrl: 'https://central.example.com',
      centralToken: 't',
      cache,
      fetchImpl: fn,
      logger: createLogger(),
      timeoutMs: 30,
    });

    const results = await client.searchDocuments('anything');
    expect(Array.isArray(results)).toBe(true);
  });

  it('listDocuments translates central response to local shape', async () => {
    const fixture = {
      documents: [
        {
          id: 'd1',
          title: 'Hello',
          folder_id: 'f1',
          path: '/hello',
          content: '',
          tags: ['a'],
          created_by: 'alice',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
        },
      ],
    };
    const { fn, calls } = makeFetch(() => jsonResponse(200, fixture));
    const client = new MemoryClientCentral({
      centralUrl: 'https://central.example.com',
      centralToken: 't',
      cache,
      fetchImpl: fn,
      logger: createLogger(),
    });

    const docs = await client.listDocuments('f1', 25, 0);
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('Hello');
    expect(docs[0].tags).toEqual(['a']);
    // Verify query string forwarding
    expect(calls[0].url).toContain('folder_id=f1');
    expect(calls[0].url).toContain('limit=25');
  });

  it('factory createMemoryClientCentral wires cache + logger', () => {
    const client = createMemoryClientCentral({
      centralUrl: 'https://central.example.com',
      centralToken: 't',
      cacheDir: tmpDir,
      logger: createLogger(),
    });
    expect(client).toBeInstanceOf(MemoryClientCentral);
    expect(client.getCache()).toBeInstanceOf(MemoryStorage);
  });

  it('createFolder includes parent_id + name in body', async () => {
    const fixture = {
      id: 'f-new',
      name: 'projects',
      parent_id: 'root',
      path: '/projects',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    const { fn, calls } = makeFetch(() => jsonResponse(201, fixture));
    const client = new MemoryClientCentral({
      centralUrl: 'https://central.example.com',
      centralToken: 't',
      cache,
      fetchImpl: fn,
      logger: createLogger(),
    });

    const folder = await client.createFolder('projects', 'root');
    expect(folder.id).toBe('f-new');
    expect(folder.path).toBe('/projects');

    const body = JSON.parse((calls[0].init.body as string) || '{}');
    expect(body.name).toBe('projects');
    expect(body.parent_id).toBe('root');
  });
});
