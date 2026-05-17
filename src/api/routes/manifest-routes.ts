import type * as http from 'node:http';
import { jsonResponse } from './helpers.js';
import type { RouteContext } from './types.js';

export async function handleManifestRoutes(
  ctx: RouteContext,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  if (method === 'GET' && url === '/api/manifest') {
    const { instance, registry, memoryServerUrl, skillHubStore } = ctx;
    jsonResponse(res, 200, {
      schemaVersion: 1,
      instance: {
        id: instance.instanceId,
        name: instance.instanceName,
        clusterId: instance.clusterId,
        discoveryMode: instance.discoveryMode,
        publicKey: instance.publicKey,
      },
      capabilities: {
        bots: true,
        skills: !!skillHubStore,
        memory: !!memoryServerUrl,
      },
      endpoints: {
        bots: '/api/bots',
        skills: '/api/skills',
        skillsSearch: '/api/skills/search?q=',
        memory: memoryServerUrl,
      },
      memory: {
        namespace: instance.memoryNamespace,
        writableNamespaces: process.env.METABOT_MEMORY_NAMESPACES
          ? process.env.METABOT_MEMORY_NAMESPACES.split(',').filter(Boolean)
          : [instance.memoryNamespace],
        mode: 'namespace-readwrite',
      },
      stats: {
        localBots: registry.list().length,
        localSkills: skillHubStore?.list().length ?? 0,
      },
    });
    return true;
  }

  return false;
}
