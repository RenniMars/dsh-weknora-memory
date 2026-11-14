/**
 * Vendored from @wxg-prc-cpg/dsh-weknora 0.1.0 (dist/config.js), MIT, source repo
 * https://github.com/Tencent/WeKnora (packages/dsh-weknora). Kept byte-for-byte apart from
 * this banner so upstream fixes can be diffed back in; integration lives in lib/tool-config.js
 * and lib/index.js, never here.
 */
/** Plugin configuration: shape, defaults, and load-time validation. */
const DEFAULTS = {
    baseUrl: 'http://localhost:8080/api/v1',
    maxResults: 8,
    maxChunkChars: 1200,
    requestTimeoutMs: 30_000,
    chatTimeoutMs: 300_000,
    resourceUrls: 'handle',
    toolPrefix: 'weknora',
};
/** Thrown when a patch row configures this plugin in a way it cannot serve. */
export class ConfigError extends Error {
    constructor(violations) {
        super(`dsh-weknora configuration is invalid:\n  - ${violations.join('\n  - ')}`);
        this.name = 'ConfigError';
    }
}
const API_ROOT = /\/api\/v\d+$/;
const TOOL_PREFIX = /^[a-z][a-z0-9_]*$/;
/**
 * Normalize a WeKnora base URL to an API root. Both `https://kb.example.com`
 * and `https://kb.example.com/api/v1` are accepted, because a deployment's
 * documented address is usually the bare origin.
 */
export function normalizeBaseUrl(raw) {
    const trimmed = raw.trim().replace(/\/+$/, '');
    return API_ROOT.test(trimmed) ? trimmed : `${trimmed}/api/v1`;
}
function positiveInt(value, field, violations) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        violations.push(`${field} must be a positive number, received ${JSON.stringify(value)}`);
        return undefined;
    }
    return Math.floor(value);
}
function stringList(value, field, violations) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry.trim() === '')) {
        violations.push(`${field} must be an array of non-empty strings`);
        return undefined;
    }
    return value.map(entry => entry.trim());
}
function optionalString(value, field, violations) {
    if (value === undefined || value === null || value === '')
        return undefined;
    if (typeof value !== 'string') {
        violations.push(`${field} must be a string`);
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}
function toggle(value, field, fallback, violations) {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'boolean') {
        violations.push(`${field} must be a boolean`);
        return fallback;
    }
    return value;
}
/**
 * Apply defaults and reject an unusable row while the plugin loads, so a typo
 * surfaces at boot rather than inside the first tool call the model makes.
 * @param raw - the `config` value from the Cordis row.
 * @returns configuration every consumer can read without re-checking.
 */
export function resolveConfig(raw) {
    const violations = [];
    const config = raw ?? {};
    if (typeof config !== 'object' || Array.isArray(config)) {
        throw new ConfigError(['config must be an object']);
    }
    const baseUrlInput = optionalString(config.baseUrl, 'baseUrl', violations) ?? DEFAULTS.baseUrl;
    let baseUrl = DEFAULTS.baseUrl;
    try {
        const url = new URL(normalizeBaseUrl(baseUrlInput));
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            violations.push(`baseUrl must use http or https, received ${url.protocol}`);
        }
        baseUrl = url.toString().replace(/\/+$/, '');
    }
    catch {
        violations.push(`baseUrl must be an absolute URL, received ${JSON.stringify(baseUrlInput)}`);
    }
    const resourceUrls = config.resourceUrls ?? DEFAULTS.resourceUrls;
    if (resourceUrls !== 'handle' && resourceUrls !== 'public') {
        violations.push(`resourceUrls must be "handle" or "public", received ${JSON.stringify(resourceUrls)}`);
    }
    const toolPrefix = optionalString(config.toolPrefix, 'toolPrefix', violations) ?? DEFAULTS.toolPrefix;
    if (!TOOL_PREFIX.test(toolPrefix)) {
        violations.push(`toolPrefix must match ${String(TOOL_PREFIX)}, received ${JSON.stringify(toolPrefix)}`);
    }
    const toolToggles = config.tools ?? {};
    if (typeof toolToggles !== 'object' || Array.isArray(toolToggles)) {
        violations.push('tools must be an object of booleans');
    }
    const resolved = {
        baseUrl,
        apiKey: optionalString(config.apiKey, 'apiKey', violations),
        tenantId: optionalString(config.tenantId, 'tenantId', violations),
        knowledgeBaseIds: stringList(config.knowledgeBaseIds, 'knowledgeBaseIds', violations) ?? [],
        agentId: optionalString(config.agentId, 'agentId', violations),
        maxResults: positiveInt(config.maxResults, 'maxResults', violations) ?? DEFAULTS.maxResults,
        maxChunkChars: positiveInt(config.maxChunkChars, 'maxChunkChars', violations) ?? DEFAULTS.maxChunkChars,
        requestTimeoutMs: positiveInt(config.requestTimeoutMs, 'requestTimeoutMs', violations) ?? DEFAULTS.requestTimeoutMs,
        chatTimeoutMs: positiveInt(config.chatTimeoutMs, 'chatTimeoutMs', violations) ?? DEFAULTS.chatTimeoutMs,
        resourceUrls: resourceUrls === 'public' ? 'public' : 'handle',
        toolPrefix,
        tools: {
            listKnowledgeBases: toggle(toolToggles.listKnowledgeBases, 'tools.listKnowledgeBases', true, violations),
            search: toggle(toolToggles.search, 'tools.search', true, violations),
            readDocument: toggle(toolToggles.readDocument, 'tools.readDocument', true, violations),
            ask: toggle(toolToggles.ask, 'tools.ask', true, violations),
        },
    };
    if (!Object.values(resolved.tools).some(Boolean)) {
        violations.push('at least one tool must stay enabled; remove the plugin row instead of disabling all of them');
    }
    if (violations.length > 0)
        throw new ConfigError(violations);
    return resolved;
}
//# sourceMappingURL=config.js.map