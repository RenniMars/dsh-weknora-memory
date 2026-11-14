/**
 * Mounts the four WeKnora tools (list / search / read / ask) on this plugin's own client.
 *
 * The tools, the REST client and the SSE reader are vendored from
 * @wxg-prc-cpg/dsh-weknora (MIT), so nothing here re-implements an endpoint. This file is the
 * only seam: it maps our config keys onto the raw shape upstream's resolveConfig expects, and
 * mounts only when the host actually exposes a `tools` registry.
 *
 * Mounting is separate from injection on purpose: a headless host without `tools` loses the
 * tools and keeps the per-turn injection, and a broken tool config costs tools only.
 */
import { WeknoraClient } from "./tools-client.js";
import { resolveConfig } from "./tool-config.js";
import { createTools } from "./tools.js";

/** Map our flat config onto the raw config upstream's resolveConfig validates. */
export function rawToolsConfig(cfg) {
  const toggles = cfg?.tools && typeof cfg.tools === "object" ? cfg.tools : {};
  return {
    baseUrl: cfg?.apiUrl || undefined,
    apiKey: cfg?.apiKey || undefined,
    tenantId: cfg?.toolTenantId || undefined,
    knowledgeBaseIds: Array.isArray(cfg?.kbIds) ? cfg.kbIds : [],
    agentId: cfg?.toolAgentId || undefined,
    maxResults: cfg?.toolMaxResults,
    maxChunkChars: cfg?.toolMaxChunkChars,
    requestTimeoutMs: cfg?.toolRequestTimeoutMs,
    chatTimeoutMs: cfg?.toolChatTimeoutMs,
    resourceUrls: cfg?.toolResourceUrls,
    toolPrefix: cfg?.toolPrefix,
    tools: toggles,
  };
}

/**
 * Register every enabled tool on `scope.tools`.
 *
 * Registration is per tool and never all-or-nothing: a host that already owns a name (the
 * standalone @wxg-prc-cpg/dsh-weknora plugin registers the same four) rejects that one, and
 * losing three working tools because a fourth collided would be the wrong trade.
 * @returns {{mounted: string[], failed: {name: string, reason: string}[]}}
 */
export function mountTools(scope, cfg) {
  // The switch lives here as well as in index.js: a caller that mounts anyway (a test, or a
  // future admin route) must never get tools the deployment switched off.
  if (cfg?.toolsEnabled === false) return { mounted: [], failed: [] };
  const resolved = resolveConfig(rawToolsConfig(cfg));
  const client = new WeknoraClient(resolved);
  const definitions = createTools(client, resolved);
  const mounted = [];
  const failed = [];
  for (const definition of definitions) {
    try {
      scope.tools.register(definition);
      mounted.push(definition.name);
    } catch (error) {
      failed.push({ name: definition.name, reason: String(error?.message ?? error) });
    }
  }
  return { mounted, failed };
}
