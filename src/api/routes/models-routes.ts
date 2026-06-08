import type * as http from 'node:http';
import { getAllModels } from '../../engines/model-catalog.js';
import { jsonResponse } from './helpers.js';
import type { RouteContext } from './types.js';

/**
 * GET /api/models — selectable model lists per engine.
 *
 * Claude is fetched live from the Anthropic Models API when an API key is set
 * (cached 1h), with a maintained static fallback (`claudeSource` says which).
 * Kimi and Codex are static. Used by the Web UI add/edit-bot model field.
 */
export async function handleModelRoutes(
  _ctx: RouteContext,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const path = url.split('?')[0];

  if (method === 'GET' && path === '/api/models') {
    const all = await getAllModels();
    jsonResponse(res, 200, all);
    return true;
  }

  return false;
}
