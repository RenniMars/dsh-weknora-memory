/**
 * The one WeKnora HTTP client.
 *
 * Both sides of the memory system go through here: the injector (lib/retrieve.js,
 * read path, every step) and the optional writers (writers/*, write path, scheduled).
 * They were two hand-rolled fetch blocks before this module existed, which is exactly
 * how a header or an error string drifts apart between the two.
 *
 * Nothing in here throws for transport, timeout or HTTP status: a call resolves to
 * { ok, status, body, reason } and the caller decides whether that is fatal. The read
 * path is required to degrade silently, the writers are required to log and exit
 * non-zero, so the decision has to stay with them.
 */

/** Request ceiling applied when a caller names no timeout of its own. */
export const DEFAULT_TIMEOUT_MS = 4000;

/** The configured base URL without trailing slashes, or "" when unset. */
export function baseUrlOf(config) {
  return String(config?.apiUrl ?? "").replace(/\/+$/, "");
}

/** Join a base URL and a path, tolerating a missing or extra leading slash. */
export function joinUrl(base, path) {
  const root = String(base ?? "").replace(/\/+$/, "");
  const tail = String(path ?? "");
  return root + (tail.startsWith("/") ? tail : "/" + tail);
}

/**
 * Request headers: X-API-Key only when a key is configured, and the JSON content
 * type only when a body is actually sent (a GET with Content-Type is noise).
 */
export function headersFor(config, { json = false } = {}) {
  const headers = json
    ? { "Content-Type": "application/json", Accept: "application/json" }
    : { Accept: "application/json" };
  const key = config?.apiKey;
  if (typeof key === "string" && key) headers["X-API-Key"] = key;
  return headers;
}

/**
 * One request. `reason` is one of no_api_url / timeout / transport / http_<status>,
 * which is the vocabulary lib/retrieve.js already reports in its stats.
 *
 * @param {object} config  clamped config (apiUrl / apiKey)
 * @param {string} method  HTTP method
 * @param {string} path    path below the base URL, e.g. "/knowledge-search"
 * @param {object} [options]
 * @param {object} [options.body]      JSON body; omit for a body-less request
 * @param {number} [options.timeoutMs] per-request ceiling; omitted means no deadline
 * @param {AbortSignal} [options.signal] caller's own deadline/cancellation
 * @param {Function} [options.fetchImpl] injected fetch (tests)
 * @param {"json"|"none"} [options.expect] parse the body as JSON (default) or ignore it
 */
export async function request(config, method, path, options = {}) {
  const { body, timeoutMs, signal, fetchImpl = globalThis.fetch, expect = "json" } = options;
  const base = baseUrlOf(config);
  if (!base) return { ok: false, reason: "no_api_url" };

  const signals = [];
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (signal) signals.push(signal);

  const init = { method, headers: headersFor(config, { json: body !== undefined }) };
  if (body !== undefined) init.body = JSON.stringify(body);
  if (signals.length === 1) init.signal = signals[0];
  else if (signals.length > 1) init.signal = AbortSignal.any(signals);

  try {
    const response = await fetchImpl(joinUrl(base, path), init);
    if (!response.ok) return { ok: false, status: response.status, reason: "http_" + response.status };
    if (expect === "none") return { ok: true, status: response.status, body: null };
    return { ok: true, status: response.status, body: await response.json() };
  } catch (error) {
    const name = error?.name;
    return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "transport" };
  }
}
