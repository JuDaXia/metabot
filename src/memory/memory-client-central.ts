/**
 * MemoryClientCentral — Phase 2 of the central-architecture pivot.
 *
 * Async facade over the central server's `/api/memory/*` endpoints, with a
 * local SQLite-backed read-only cache used as the fallback path when central
 * is unreachable. Writes fail loudly with `CentralUnreachableError` so the
 * caller (memory-server's HTTP handler) can return 502 `central_unreachable`.
 *
 * Wire shape:
 *   - Outbound requests carry `Authorization: Bearer ${CENTRAL_TOKEN}`.
 *   - Inbound principal context is forwarded via `X-MetaBot-Origin: client`
 *     and (optionally) `X-MetaBot-Client-Bot: <botName>` so the central
 *     audit log can attribute writes correctly.
 *   - Outbound calls time out at 3 s by default; on network failure or 5xx
 *     reads transparently serve from the local cache while writes throw.
 *
 * This module deliberately exposes async methods (not the synchronous
 * MemoryStorage surface) — memory-server.ts switches to the central
 * routing branch when the client is wired in.
 */

import type { Logger } from '../utils/logger.js';
import { proxyFetch } from '../utils/http.js';
import {
  MemoryStorage,
  type Document,
  type DocumentCreateInput,
  type DocumentSummary,
  type DocumentUpdateInput,
  type Folder,
  type FolderTreeNode,
  type MemoryAccess,
  type SearchResult,
  type Visibility,
} from './memory-storage.js';

export interface MemoryClientCentralOptions {
  /** Central server base URL (e.g. https://mb.xvirobotics.com), trailing slash trimmed. */
  centralUrl: string;
  /** Bearer token for outbound /api/memory/* calls. */
  centralToken: string;
  /** Serve cached reads from local SQLite when central is unreachable. Default true. */
  fallbackReadonly?: boolean;
  /** Forwarded as X-MetaBot-Client-Bot for central-side audit attribution. */
  clientBot?: string;
  /** Local SQLite-backed storage used as the read-only fallback cache. */
  cache: MemoryStorage;
  /** Outbound request timeout (ms). Default 3000. */
  timeoutMs?: number;
  /** Custom fetcher (test seam). Defaults to proxyFetch. */
  fetchImpl?: typeof fetch;
  logger: Logger;
}

interface CentralFolder {
  id: string;
  name: string;
  parent_id: string | null;
  path: string;
  created_at: string;
  updated_at: string;
}

interface CentralDocument {
  id: string;
  title: string;
  folder_id: string;
  path: string;
  content: string;
  tags: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface CentralFolderTreeNode {
  id: string;
  name: string;
  path: string;
  children: CentralFolderTreeNode[];
  document_count: number;
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

export class MemoryClientCentral {
  private readonly centralUrl: string;
  private readonly centralToken: string;
  private readonly fallbackReadonly: boolean;
  private readonly clientBot: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly cache: MemoryStorage;
  private readonly logger: Logger;
  /** id → path lookup populated as we see records. Lets id-based callers route correctly. */
  private readonly idPathCache = new Map<string, string>();

  constructor(opts: MemoryClientCentralOptions) {
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

  /** Expose the cache so the HTTP handler can read stats / passthrough getters. */
  getCache(): MemoryStorage {
    return this.cache;
  }

  close(): void {
    this.cache.close();
  }

  // ---- Folder ops ----

  async createFolder(name: string, parentId = 'root', visibility: Visibility = 'private', _access: MemoryAccess = 'admin'): Promise<Folder> {
    const { json } = await this.runWrite('createFolder', '/api/memory/folders', () =>
      this.request('POST', '/api/memory/folders', { name, parent_id: parentId }),
    );
    const cf = json as CentralFolder;
    const folder: Folder = {
      id: cf.id,
      name: cf.name,
      parent_id: cf.parent_id,
      path: cf.path,
      visibility,
      created_at: cf.created_at,
      updated_at: cf.updated_at,
    };
    this.rememberMapping(folder.id, folder.path);
    return folder;
  }

  async getFolderTree(_access: MemoryAccess = 'admin'): Promise<FolderTreeNode> {
    const opPath = '/api/memory/folders/tree';
    try {
      const { status, json } = await this.request('GET', opPath);
      if (status === 200 && json && typeof json === 'object') {
        return this.translateTree(json as CentralFolderTreeNode);
      }
      throw this.makeStatusError(status, json, 'getFolderTree');
    } catch (err) {
      if (this.shouldFallback(err)) {
        this.logFallback('getFolderTree', opPath, err);
        return this.cache.getFolderTree(_access);
      }
      throw err;
    }
  }

  async deleteFolder(folderId: string, _access: MemoryAccess = 'admin'): Promise<void> {
    const target = this.resolveFolderTarget(folderId);
    await this.runWrite('deleteFolder', `/api/memory/folders/${encodeURIComponent(target)}`, () =>
      this.request('DELETE', `/api/memory/folders/${encodeURIComponent(target)}`),
    );
    this.idPathCache.delete(folderId);
  }

  isFolderAccessible(folderId: string, access: MemoryAccess): boolean {
    return this.cache.isFolderAccessible(folderId, access);
  }

  canWriteFolder(folderId: string, access: MemoryAccess): boolean {
    return this.cache.canWriteFolder(folderId, access);
  }

  getAccessibleFolderIds(access: MemoryAccess): Set<string> {
    return this.cache.getAccessibleFolderIds(access);
  }

  /**
   * Folder visibility is a local-only concept (central uses path-based ACL).
   * Update the cache and return without proxying — preserves admin UX.
   */
  updateFolder(folderId: string, data: { visibility?: Visibility }): Folder | null {
    return this.cache.updateFolder(folderId, data);
  }

  // ---- Document ops ----

  async createDocument(data: DocumentCreateInput, _access: MemoryAccess = 'admin'): Promise<Document> {
    const folderId = data.folder_id || 'root';
    const folder = this.findFolderInCache(folderId);
    const body: Record<string, unknown> = {
      title: data.title,
      folder_id: folderId,
      content: data.content || '',
      tags: data.tags || [],
      created_by: data.created_by || '',
    };
    if (folder) {
      const parentPath = folder.path === '/' ? '' : folder.path;
      body.path = `${parentPath}/${slugify(data.title)}`;
    }
    const { json } = await this.runWrite('createDocument', '/api/memory/documents', () =>
      this.request('POST', '/api/memory/documents', body),
    );
    const cd = json as CentralDocument;
    this.rememberMapping(cd.id, cd.path);
    return centralDocToLocal(cd);
  }

  async getDocument(docId: string, access: MemoryAccess = 'admin'): Promise<Document | null> {
    const target = this.resolveDocTarget(docId);
    const opPath = `/api/memory/documents/${encodeURIComponent(target)}`;
    try {
      const { status, json } = await this.request('GET', opPath);
      if (status === 200) {
        const doc = centralDocToLocal(json as CentralDocument);
        this.rememberMapping(doc.id, doc.path);
        return doc;
      }
      if (status === 404) return null;
      throw this.makeStatusError(status, json, 'getDocument');
    } catch (err) {
      if (this.shouldFallback(err)) {
        this.logFallback('getDocument', opPath, err);
        return this.cache.getDocument(docId, access);
      }
      throw err;
    }
  }

  async getDocumentByPath(docPath: string, access: MemoryAccess = 'admin'): Promise<Document | null> {
    const opPath = `/api/memory/documents/${encodeURIComponent(docPath)}`;
    try {
      const { status, json } = await this.request('GET', opPath);
      if (status === 200) {
        const doc = centralDocToLocal(json as CentralDocument);
        this.rememberMapping(doc.id, doc.path);
        return doc;
      }
      if (status === 404) return null;
      throw this.makeStatusError(status, json, 'getDocumentByPath');
    } catch (err) {
      if (this.shouldFallback(err)) {
        this.logFallback('getDocumentByPath', opPath, err);
        return this.cache.getDocumentByPath(docPath, access);
      }
      throw err;
    }
  }

  async listDocuments(folderId?: string, limit = 50, offset = 0, access: MemoryAccess = 'admin'): Promise<DocumentSummary[]> {
    const params = new URLSearchParams();
    if (folderId) params.set('folder_id', folderId);
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    const opPath = `/api/memory/documents?${params}`;
    try {
      const { status, json } = await this.request('GET', opPath);
      if (status === 200 && json && typeof json === 'object') {
        const docs = (json.documents || []) as CentralDocument[];
        return docs.map((d) => ({
          id: d.id,
          title: d.title,
          folder_id: d.folder_id,
          path: d.path,
          tags: d.tags || [],
          created_by: d.created_by || '',
          created_at: d.created_at,
          updated_at: d.updated_at,
        }));
      }
      throw this.makeStatusError(status, json, 'listDocuments');
    } catch (err) {
      if (this.shouldFallback(err)) {
        this.logFallback('listDocuments', opPath, err);
        return this.cache.listDocuments(folderId, limit, offset, access);
      }
      throw err;
    }
  }

  async updateDocument(docId: string, data: DocumentUpdateInput, _access: MemoryAccess = 'admin'): Promise<Document | null> {
    const target = this.resolveDocTarget(docId);
    const body: Record<string, unknown> = {};
    if (data.title !== undefined) body.title = data.title;
    if (data.content !== undefined) body.content = data.content;
    if (data.tags !== undefined) body.tags = data.tags;
    if (data.folder_id !== undefined) body.folder_id = data.folder_id;
    const opPath = `/api/memory/documents/${encodeURIComponent(target)}`;
    try {
      const { status, json } = await this.request('PATCH', opPath, body);
      if (status === 200) {
        const cd = json as CentralDocument;
        this.rememberMapping(cd.id, cd.path);
        return centralDocToLocal(cd);
      }
      if (status === 404) return null;
      if (this.isServerFailure(status)) throw new CentralUnreachableError('updateDocument', `status ${status}`);
      throw this.makeStatusError(status, json, 'updateDocument');
    } catch (err) {
      if (this.isAbortOrNetwork(err)) throw new CentralUnreachableError('updateDocument', err);
      throw err;
    }
  }

  async deleteDocument(docId: string, _access: MemoryAccess = 'admin'): Promise<boolean> {
    const target = this.resolveDocTarget(docId);
    const opPath = `/api/memory/documents/${encodeURIComponent(target)}`;
    try {
      const { status } = await this.request('DELETE', opPath);
      if (status === 200) {
        this.idPathCache.delete(docId);
        return true;
      }
      if (status === 404) return false;
      if (this.isServerFailure(status)) throw new CentralUnreachableError('deleteDocument', `status ${status}`);
      throw this.makeStatusError(status, null, 'deleteDocument');
    } catch (err) {
      if (this.isAbortOrNetwork(err)) throw new CentralUnreachableError('deleteDocument', err);
      throw err;
    }
  }

  async searchDocuments(query: string, limit = 20, access: MemoryAccess = 'admin'): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    const opPath = `/api/memory/search?${params}`;
    try {
      const { status, json } = await this.request('GET', opPath);
      if (status === 200 && json && typeof json === 'object') {
        const results = (json.results || []) as Array<{
          id: string; title: string; path: string; snippet: string;
          tags: string[]; created_by: string; updated_at: string;
        }>;
        return results.map((r) => ({
          id: r.id,
          title: r.title,
          path: r.path,
          snippet: r.snippet || '',
          tags: r.tags || [],
          created_by: r.created_by || '',
          updated_at: r.updated_at,
        }));
      }
      throw this.makeStatusError(status, json, 'searchDocuments');
    } catch (err) {
      if (this.shouldFallback(err)) {
        this.logFallback('searchDocuments', opPath, err);
        return this.cache.searchDocuments(query, limit, access);
      }
      throw err;
    }
  }

  getStats(): { document_count: number; folder_count: number } {
    return this.cache.getStats();
  }

  // ---- Internals ----

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.centralToken}`,
      'X-MetaBot-Origin': 'client',
    };
    if (this.clientBot) headers['X-MetaBot-Client-Bot'] = this.clientBot;
    return { ...headers, ...(extra || {}) };
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

  private async runWrite(
    op: string,
    urlPath: string,
    fn: () => Promise<{ status: number; json: any }>,
  ): Promise<{ status: number; json: any }> {
    try {
      const result = await fn();
      if (result.status >= 200 && result.status < 300) return result;
      if (this.isServerFailure(result.status)) {
        throw new CentralUnreachableError(op, `status ${result.status}`);
      }
      throw this.makeStatusError(result.status, result.json, op);
    } catch (err) {
      if (this.isAbortOrNetwork(err)) {
        const u = new CentralUnreachableError(op, err);
        this.logger.warn({ op, path: urlPath, err: (err as Error)?.message || String(err) }, 'central write failed (network)');
        throw u;
      }
      throw err;
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

  private rememberMapping(id: string | undefined, path: string | undefined): void {
    if (id && path) this.idPathCache.set(id, path);
  }

  private resolveFolderTarget(folderIdOrPath: string): string {
    if (folderIdOrPath.startsWith('/')) return folderIdOrPath;
    return this.idPathCache.get(folderIdOrPath) || folderIdOrPath;
  }

  private resolveDocTarget(idOrPath: string): string {
    if (idOrPath.startsWith('/')) return idOrPath;
    return this.idPathCache.get(idOrPath) || idOrPath;
  }

  private findFolderInCache(folderId: string): Folder | undefined {
    try {
      const tree = this.cache.getFolderTree('admin');
      return findFolderNodeAsFolder(tree, folderId);
    } catch {
      return undefined;
    }
  }

  private translateTree(node: CentralFolderTreeNode): FolderTreeNode {
    return {
      id: node.id,
      name: node.name,
      path: node.path,
      visibility: 'shared',
      children: (node.children || []).map((c) => this.translateTree(c)),
      document_count: node.document_count,
    };
  }
}

function centralDocToLocal(cd: CentralDocument): Document {
  return {
    id: cd.id,
    title: cd.title,
    folder_id: cd.folder_id,
    path: cd.path,
    content: cd.content || '',
    tags: cd.tags || [],
    created_by: cd.created_by || '',
    created_at: cd.created_at,
    updated_at: cd.updated_at,
  };
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/ /g, '-');
}

function findFolderNodeAsFolder(node: FolderTreeNode, folderId: string): Folder | undefined {
  if (node.id === folderId) {
    return {
      id: node.id,
      name: node.name,
      parent_id: null,
      path: node.path,
      visibility: node.visibility,
      created_at: '',
      updated_at: '',
    };
  }
  for (const child of node.children) {
    const found = findFolderNodeAsFolder(child, folderId);
    if (found) return found;
  }
  return undefined;
}

/**
 * Factory — preferred construction path. Creates a `MemoryClientCentral`
 * with a local SQLite cache. The cache is what `MemoryStorage` would have
 * constructed in local-only mode, so reads continue to work when central
 * is down.
 */
export function createMemoryClientCentral(opts: {
  centralUrl: string;
  centralToken: string;
  fallbackReadonly?: boolean;
  clientBot?: string;
  cacheDir: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger: Logger;
}): MemoryClientCentral {
  const cache = new MemoryStorage(opts.cacheDir, opts.logger);
  return new MemoryClientCentral({
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
