/**
 * WeKnora hybrid search: one request per knowledge base, reciprocal rank fusion
 * across the libraries, then adjacency expansion of the winning hits.
 *
 * Each kb id in config.kbIds gets its own /knowledge-search call (concurrently, so
 * the fan-out fits inside min(config.timeoutMs, TIMEOUT_CAP_MS)); the top perKbHits
 * of every KB are kept and fused.
 *
 * Request body is { query, knowledge_base_ids, top_k }. Probing the live service
 * showed the response is byte-identical with and without top_k, rerank, threshold
 * or an unknown field, so top_k is sent for the day the server honours it and the
 * returned count stays whatever the server's own retrieval config decides.
 *
 * Fusion is RRF over the position each hit holds inside its own library's result
 * list (k = config.rrfK, default 60). The previous rule -- divide by the library's
 * own best score -- handed every library a fake 1.0 top hit, so a weak library's
 * mediocre rank-2 (0.95 after normalising) could outrank a strong library's real
 * rank-2. A chunk belongs to exactly one library, so RRF here reduces to 1/(k+rank)
 * per hit and the cross-library comparison becomes positional.
 *
 * The search response carries parent_chunk_id but no neighbour ids, and the parent
 * chunk rows are missing for 1729 of 1801 chunks, so "small to big" retrieval is not
 * available. GET /api/v1/chunks/{knowledge_id} does return pre_chunk_id and
 * next_chunk_id, so the top hits are widened with their immediate neighbours through
 * that call. Any failure there is silent: the hit is injected exactly as it arrived.
 */
import { TIMEOUT_CAP_MS } from "./config.js";
import { request } from "./weknora.js";
import { applyDecay, readState } from "./decay.js";
import { cleanText } from "./format.js";

const DEFAULT_PER_KB = 2;
const MAX_PER_KB = 5;
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 50;
const DEFAULT_RRF_K = 60;
const MAX_RRF_K = 1000;
const DEFAULT_NEIGHBORS = 1;
const MAX_NEIGHBORS = 2;
/** Page size requested from GET /chunks/{knowledge_id}; the server honours it (50 -> 50 rows). */
const CHUNK_PAGE_SIZE = 100;
/** Documents whose chunk pages stay in memory (knowledge_id -> page index). */
const PAGE_CACHE_MAX = 32;
/** Bound on the page probes of one binary search. */
const BINARY_SEARCH_MAX = 8;
/** A chunks request is only started with at least this much budget left. */
const MIN_REQUEST_MS = 50;
/** How much of one neighbouring chunk survives on each side of the hit. */
const NEIGHBOR_SEGMENT_CHARS = 400;
const SEPARATOR = " … ";

function timeoutOf(config) {
  return Math.max(50, Math.min(Number(config.timeoutMs) || TIMEOUT_CAP_MS, TIMEOUT_CAP_MS));
}

function intOr(value, fallback, min, max) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

/** How many hits to request per library (sent as top_k; clamped to what is sane). */
export function topKOf(config) {
  return intOr(config?.topK, DEFAULT_TOP_K, 1, MAX_TOP_K);
}

/** RRF smoothing constant: larger k flattens the advantage of a top position. */
function rrfKOf(config) {
  return intOr(config?.rrfK, DEFAULT_RRF_K, 1, MAX_RRF_K);
}

/** Neighbours merged on each side of one hit; 0 disables the expansion entirely. */
function neighborCountOf(config) {
  return intOr(config?.neighborChunks, DEFAULT_NEIGHBORS, 0, MAX_NEIGHBORS);
}

function perKbOf(config) {
  return intOr(config?.perKbHits, DEFAULT_PER_KB, 1, MAX_PER_KB);
}

/** WeKnora's relevance score, 0 when absent or not a finite number. */
export function scoreOf(hit) {
  const value = hit?.score;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Human label for a kb id: config.kbNames first, then a short id slice. */
export function labelOf(config, kbId) {
  const names = config && typeof config.kbNames === "object" && config.kbNames ? config.kbNames : {};
  const named = names[kbId];
  if (typeof named === "string" && named.trim()) return named.trim().slice(0, 16);
  return kbId ? String(kbId).slice(0, 8) : "kb";
}

/**
 * The first source rule whose regex matches a hit's document title, or null.
 *
 * Matching is done on the cleaned title (the same field the injected block shows,
 * so what the reader sees is what was ruled on) and each rule compiles its own
 * RegExp so a /g flag in config cannot carry lastIndex from one hit into the next.
 * @returns { factor, reason } or null when no rule applies
 */
export function sourceWeightOf(config, hit) {
  const rules = Array.isArray(config?.sourceWeights) ? config.sourceWeights : [];
  if (rules.length === 0) return null;
  const title = cleanText(hit?.knowledge_title || hit?.document || "");
  if (!title) return null;
  for (const rule of rules) {
    if (!rule || typeof rule.match !== "string") continue;
    const factor = Number(rule.factor);
    if (!Number.isFinite(factor) || factor <= 0 || factor > 1) continue;
    let pattern;
    try {
      pattern = new RegExp(rule.match);
    } catch {
      continue;
    }
    if (pattern.test(title)) return { factor, reason: String(rule.reason ?? "weight") };
  }
  return null;
}

/**
 * One hit with its source weight already applied to the raw score.
 *
 * The returned score replaces WeKnora's own number, so both the fusion position and
 * the minScore floor downstream judge the de-ranked value; base_score keeps the
 * original for the log and for the before/after comparison. base_score is filled on
 * every hit, weighted or not: a zero there reads as "the service scored this at 0" in
 * the log and in the weekly report, which is worse than useless while debugging.
 * A hit that matches no rule, or a rule whose factor is exactly 1, keeps its score and
 * gains nothing but that base.
 */
export function applySourceWeight(hit, config) {
  const base = scoreOf(hit);
  const rule = sourceWeightOf(config, hit);
  if (!rule || rule.factor === 1) {
    return { hit: hit.base_score === base ? hit : { ...hit, base_score: base }, score: base };
  }
  const weighted = base * rule.factor;
  return {
    hit: {
      ...hit,
      score: weighted,
      base_score: base,
      applied_weight: rule.factor,
      weight_reason: rule.reason,
    },
    score: weighted,
  };
}

/** Identity of one hit inside a merge; a chunk id when present, else kb + position. */
function keyOf(hit, group) {
  const id = hit?.id;
  if (typeof id === "string" && id) return id;
  return String(group?.kbId ?? "?") + ":" + String(hit?.chunk_index ?? "?");
}

/** One scoped search call; kbId "" means "no scope" (search everything). */
async function searchOnce(query, config, kbId, deps) {
  const body = { query, top_k: topKOf(config) };
  if (kbId) body.knowledge_base_ids = [kbId];
  const result = await request(config, "POST", "/knowledge-search", {
    body,
    timeoutMs: timeoutOf(config),
    signal: deps.signal,
    fetchImpl: deps.fetchImpl,
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  const hits = Array.isArray(result.body?.data) ? result.body.data : [];
  return { ok: true, hits };
}

/**
 * Merge per-KB result groups into one ranked list.
 *
 * Every group keeps at most perKbHits hits, ranked by its own raw score. With two or
 * more answering KBs each hit carries rrf = factor/(rrfK + position), so the ordering
 * between libraries is decided by position and source weight, not by each library's
 * own score scale: a clean library top arrives at 1/(k+1), the top of a library made
 * only of de-ranked transcripts at 0.35/(k+1), so the transcripts give way across
 * libraries as well as inside one; with factor 1 nothing changes.
 * raw_score is the score after the source weight (what display, ordering and the
 * absolute minScore floor all use); base_score keeps the service's own number on every
 * hit, and applied_weight / weight_reason mark the de-ranked ones for the log. The rank inside a
 * library is recomputed on the weighted score (ties fall back to the pre-weight score),
 * so a de-ranked hit really does lose its slot instead of keeping the server's order.
 * A single answering KB keeps its score space (rank_kind "score"), which is
 * exactly the single-KB behaviour that existed before -- with factor 1 identical.
 *
 * @param groups [{ kbId, label, hits }] in config order
 * @returns merged hits, each tagged with kb_id / kb_label / raw_score / rank_in_kb /
 *   rank_score / rank_kind, sorted by rank_score then raw_score
 */
export function mergeKbGroups(groups, config) {
  const perKb = perKbOf(config);
  const list = Array.isArray(groups) ? groups : [];
  const fuse = list.length > 1;
  const rrfK = rrfKOf(config);
  const merged = [];
  const byKey = new Map();
  const baseOf = (entry) => (typeof entry.hit.base_score === "number" ? entry.hit.base_score : entry.score);
  // The source weight also scales the fusion contribution, so a library whose top hit is
  // a de-ranked transcript arrives at 0.35/(rrfK+1) and gives way to a clean library.
  const weightOf = (entry) => (typeof entry?.applied_weight === "number" ? entry.applied_weight : 1);
  for (const group of list) {
    // The source weight is applied to the raw score *before* this library is ranked,
    // so a de-ranked hit loses its position inside its own library and, when it falls
    // past perKbHits, never reaches the fusion at all.
    const ranked = (Array.isArray(group?.hits) ? group.hits : [])
      .map((hit, order) => ({ ...applySourceWeight(hit, config), order }))
      // The weighted score decides the position inside the library; the pre-weight score
      // breaks a tie, and the server's own order breaks what is left of it.
      .sort((a, b) => b.score - a.score || baseOf(b) - baseOf(a) || a.order - b.order)
      .slice(0, perKb);
    for (let index = 0; index < ranked.length; index += 1) {
      const { hit, score } = ranked[index];
      const key = keyOf(hit, group);
      const shared = byKey.get(key);
      if (shared) {
        // The same chunk listed by two libraries: RRF adds the two contributions.
        shared.rrf += fuse ? weightOf(hit) / (rrfK + index + 1) : 0;
        shared.raw_score = Math.max(shared.raw_score, score);
        continue;
      }
      const entry = {
        ...hit,
        kb_id: group?.kbId ?? "",
        kb_label: group?.label ?? "",
        raw_score: score,
        rank_in_kb: index + 1,
        rrf: 0,
      };
      entry.rrf = fuse ? weightOf(entry) / (rrfK + index + 1) : 0;
      byKey.set(key, entry);
      merged.push(entry);
    }
  }
  for (const entry of merged) {
    entry.rank_kind = fuse ? "rrf" : "score";
    entry.rank_score = fuse ? entry.rrf : entry.raw_score;
  }
  merged.sort((a, b) => b.rank_score - a.rank_score || b.raw_score - a.raw_score || a.rank_in_kb - b.rank_in_kb);
  return merged;
}

/** Highest raw score in a hit list; 0 for an empty list. */
function topScore(hits) {
  let top = 0;
  for (const hit of hits) {
    const score = scoreOf(hit);
    if (score > top) top = score;
  }
  return top;
}

function sliceTail(text, limit) {
  if (!text) return "";
  return text.length > limit ? "…" + text.slice(-limit) : text;
}

function sliceHead(text, limit) {
  if (!text) return "";
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

/**
 * One page of a document's chunks as { list, total, pageSize }; null on any failure.
 *
 * The server honours page_size exactly (requested 50 -> 50 rows, requested 100 -> 100
 * rows) and reports the document's chunk count in total, so the page holding a chunk is
 * usually floor(chunk_index / pageSize) + 1. That only holds while a document's
 * chunk_index values are 0-based and contiguous, so a miss falls through to
 * binarySearchPage() over the page index ranges instead of giving up.
 */
async function fetchChunkPage(knowledgeId, page, config, deps, timeoutMs) {
  const result = await request(
    config,
    "GET",
    "/chunks/" + encodeURIComponent(knowledgeId) + "?page=" + page + "&page_size=" + CHUNK_PAGE_SIZE,
    { timeoutMs: Math.max(MIN_REQUEST_MS, timeoutMs), signal: deps.signal, fetchImpl: deps.fetchImpl }
  );
  if (!result.ok) return null;
  const payload = result.body;
  return {
    list: Array.isArray(payload?.data) ? payload.data : [],
    total: Number.isFinite(payload?.total) ? Number(payload.total) : null,
    pageSize: Number.isFinite(payload?.page_size) && payload.page_size > 0 ? Number(payload.page_size) : null,
  };
}

/** One fetched page, indexed by chunk id and by chunk_index, with its index range. */
function indexOfPage(list) {
  const index = { byId: new Map(), byIndex: new Map(), min: null, max: null };
  for (const chunk of list) {
    if (chunk && typeof chunk.id === "string" && chunk.id) index.byId.set(chunk.id, chunk);
    const at = chunk?.chunk_index;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    index.byIndex.set(at, chunk);
    if (index.min === null || at < index.min) index.min = at;
    if (index.max === null || at > index.max) index.max = at;
  }
  return index;
}

/**
 * Per-document page index, keyed by knowledge_id for the process lifetime (bounded to
 * PAGE_CACHE_MAX documents). One retrieval usually wants several hits out of the same
 * document and later turns hit the same documents again, so a repeated lookup costs no
 * request instead of re-reading an unchanged chunk list.
 */
const docPages = new Map();

/** The cache entry for one document, including its in-flight page requests. */
function docEntryOf(knowledgeId) {
  const cached = docPages.get(knowledgeId);
  if (cached) return cached;
  if (docPages.size >= PAGE_CACHE_MAX) docPages.delete(docPages.keys().next().value);
  const entry = { pages: new Map(), pending: new Map(), pageSize: CHUNK_PAGE_SIZE, total: null, indexBase: null };
  docPages.set(knowledgeId, entry);
  return entry;
}

/** Last page number of a document, or null while its total is unknown. */
function lastPageOf(entry) {
  if (entry.total === null || !entry.pageSize) return null;
  return Math.max(1, Math.ceil(entry.total / entry.pageSize));
}

/** One page from the cache, or one request shared by every caller asking for it. */
async function ensurePage(knowledgeId, page, ctx) {
  const entry = docEntryOf(knowledgeId);
  const cached = entry.pages.get(page);
  if (cached) return cached;
  const inFlight = entry.pending.get(page);
  if (inFlight) return inFlight;
  const remaining = ctx.deadline - Date.now();
  if (remaining < MIN_REQUEST_MS) return null;
  const request = fetchChunkPage(knowledgeId, page, ctx.config, ctx.deps, Math.min(ctx.budgetMs, remaining))
    .then((result) => {
      if (!result) return null;
      if (result.pageSize) entry.pageSize = result.pageSize;
      if (result.total !== null) entry.total = result.total;
      const index = indexOfPage(result.list);
      if (index.min !== null && page === 1) entry.indexBase = index.min;
      entry.pages.set(page, index);
      return index;
    })
    .catch(() => null)
    .finally(() => entry.pending.delete(page));
  entry.pending.set(page, request);
  return request;
}

/** The page holding chunkIndex: arithmetic first, binary search when that misses. */
async function pageHolding(knowledgeId, chunkIndex, ctx) {
  const entry = docEntryOf(knowledgeId);
  if (entry.total === null) {
    // Read page 1 first: it reports total and page_size, it is the page the hit itself
    // lives on whenever the document fits one page, and it makes every later page
    // number exact instead of a blind guess past the end of the document.
    const first = await ensurePage(knowledgeId, 1, ctx);
    if (!first) return null;
    if (first.byIndex.has(chunkIndex)) return first;
  }
  const last = lastPageOf(entry);
  let page = Math.floor(chunkIndex / entry.pageSize) + 1;
  if (last !== null) page = Math.min(Math.max(page, 1), last);
  const direct = await ensurePage(knowledgeId, page, ctx);
  if (direct && direct.byIndex.has(chunkIndex)) return direct;
  return binarySearchPage(knowledgeId, chunkIndex, ctx);
}

/** Locate chunkIndex by halving the page range, for listings that do not start at 0. */
async function binarySearchPage(knowledgeId, chunkIndex, ctx) {
  const entry = docEntryOf(knowledgeId);
  const last = lastPageOf(entry);
  if (last === null) return null;
  let low = 1;
  let high = last;
  let probes = 0;
  while (low <= high && probes < BINARY_SEARCH_MAX) {
    const mid = Math.floor((low + high) / 2);
    probes += 1;
    const index = await ensurePage(knowledgeId, mid, ctx);
    if (!index) return null;
    if (index.byIndex.has(chunkIndex)) return index;
    if (index.min === null) return null;
    if (chunkIndex < index.min) high = mid - 1;
    else if (chunkIndex > index.max) low = mid + 1;
    else return null;
  }
  return null;
}

/**
 * The chunk at one chunk_index of a document, or null.
 *
 * A 0-based listing with a known total proves that any index at or past that total is
 * absent, so a hit whose row was dropped between the search index and the chunk list
 * costs no request; its neighbours are still locatable, which is what keeps the
 * expansion working for the two live documents that used to fail here.
 */
async function chunkAt(knowledgeId, chunkIndex, ctx) {
  if (typeof chunkIndex !== "number" || !Number.isFinite(chunkIndex) || chunkIndex < 0) return null;
  const entry = docEntryOf(knowledgeId);
  if (entry.indexBase === 0 && entry.total !== null && chunkIndex >= entry.total) return null;
  const index = await pageHolding(knowledgeId, chunkIndex, ctx);
  return index ? index.byIndex.get(chunkIndex) ?? null : null;
}

/**
 * The neighbour on one side of a chunk: already-loaded pages first (free), then the
 * page that should hold the expected index, then the exact id inside a loaded page.
 */
async function neighbourAt(knowledgeId, expectedIndex, expectedId, ctx) {
  const entry = docEntryOf(knowledgeId);
  for (const index of entry.pages.values()) {
    const found = index.byIndex.get(expectedIndex);
    if (found) return found;
  }
  const fetched = await chunkAt(knowledgeId, expectedIndex, ctx);
  if (fetched) return fetched;
  if (typeof expectedId !== "string" || !expectedId) return null;
  for (const index of entry.pages.values()) {
    const found = index.byId.get(expectedId);
    if (found) return found;
  }
  return null;
}

/**
 * Widen the leading hits with their adjacent chunks.
 *
 * Only the first config.maxHits hits are considered, and everything is bounded by the
 * caller's deadline so the expansion can never push one retrieval past TIMEOUT_CAP_MS.
 * Each side walks outward from the hit's own chunk_index (using pre_chunk_id /
 * next_chunk_id when the hit's own row is loaded), so a hit whose row is missing from
 * the chunk list is still widened by the neighbours that do exist. Neighbour text is
 * sliced towards the hit (tail of the previous chunk, head of the next one) and each
 * side is capped at NEIGHBOR_SEGMENT_CHARS; a hit that cannot be widened at all comes
 * back untouched, never as an error.
 *
 * @returns { hits, stats: { expanded, failed } } with hits in the same order
 */
export async function expandNeighbors(hits, config, deps = {}, deadline = Date.now() + timeoutOf(config)) {
  const list = Array.isArray(hits) ? hits : [];
  const count = neighborCountOf(config);
  const stats = { expanded: 0, failed: 0 };
  if (!count || list.length === 0) return { hits: list, stats };
  const wanted = Math.max(1, Math.min(intOr(config?.maxHits, 3, 1, 5), list.length));
  const ctx = {
    config,
    deps,
    deadline,
    budgetMs: intOr(config?.neighborTimeoutMs, 400, MIN_REQUEST_MS, TIMEOUT_CAP_MS),
  };
  const out = list.slice();
  await Promise.all(list.slice(0, wanted).map(async (hit, position) => {
    const knowledgeId = typeof hit?.knowledge_id === "string" ? hit.knowledge_id : "";
    const baseIndex = hit?.chunk_index;
    if (!knowledgeId || typeof baseIndex !== "number" || !Number.isFinite(baseIndex)) {
      stats.failed += 1;
      return;
    }
    const self = await chunkAt(knowledgeId, baseIndex, ctx);
    const before = await walkSide(knowledgeId, self, baseIndex, -1, count, ctx);
    const after = await walkSide(knowledgeId, self, baseIndex, 1, count, ctx);
    const parts = [...before, cleanText(hit?.content), ...after].filter(Boolean);
    if (parts.length <= 1) {
      stats.failed += 1;
      return;
    }
    out[position] = {
      ...hit,
      content: parts.join(SEPARATOR),
      neighbors: { before: before.filter(Boolean).length, after: after.filter(Boolean).length },
    };
    stats.expanded += 1;
  }));
  return { hits: out, stats };
}

/**
 * Neighbour segments on one side of a hit, in document order.
 * direction -1 walks towards the previous chunks, +1 towards the next ones.
 */
async function walkSide(knowledgeId, self, baseIndex, direction, count, ctx) {
  const segments = [];
  let cursor = self;
  let anchor = baseIndex;
  for (let step = 0; step < count; step += 1) {
    const expectedId = direction < 0 ? cursor?.pre_chunk_id : cursor?.next_chunk_id;
    const chunk = await neighbourAt(knowledgeId, anchor + direction, expectedId ?? null, ctx);
    if (!chunk) break;
    const text = cleanText(chunk.content);
    segments.push(direction < 0 ? sliceTail(text, NEIGHBOR_SEGMENT_CHARS) : sliceHead(text, NEIGHBOR_SEGMENT_CHARS));
    cursor = chunk;
    anchor = typeof chunk.chunk_index === "number" ? chunk.chunk_index : anchor + direction;
  }
  return direction < 0 ? segments.reverse() : segments;
}

/**
 * @param query  retrieval query (already clamped by the caller)
 * @param config clamped config (apiUrl / apiKey / kbIds / kbNames / perKbHits /
 *   topK / rrfK / neighborChunks / timeoutMs)
 * @param deps   signal (caller abort) and fetchImpl (tests)
 * @returns ok true with the merged + expanded hits array, or ok false with a reason
 * @returns stats { kb: [{ id, label, ok, hits, top | reason }], failed, neighbors,
 *   top_k } -- one entry per configured knowledge base, in config order. This is
 *   what the injection log records as the per-library measurement; it never carries
 *   chunk content.
 */
export async function searchWeKnora(query, config, deps = {}) {
  const deadline = Date.now() + timeoutOf(config);
  const kbIds = (Array.isArray(config?.kbIds) ? config.kbIds : []).filter((id) => typeof id === "string" && id);
  const scope = kbIds.length ? kbIds : [""];
  const results = await Promise.all(scope.map((kbId) => searchOnce(query, config, kbId, deps)));
  const groups = [];
  const reasons = [];
  const kb = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const kbId = scope[index];
    const label = labelOf(config, kbId);
    if (result.ok) {
      groups.push({ kbId, label, hits: result.hits });
      kb.push({ id: kbId, label, ok: true, hits: result.hits.length, top: topScore(result.hits) });
    } else {
      reasons.push(result.reason ?? "unknown");
      kb.push({ id: kbId, label, ok: false, reason: result.reason ?? "unknown" });
    }
  }
  const stats = { kb, failed: reasons.length, top_k: topKOf(config) };
  if (groups.length === 0) return { ok: false, reason: reasons.includes("timeout") ? "timeout" : reasons[0] ?? "unknown", stats };
  // Unscoped legacy call (no kb ids configured): keep WeKnora's own order, but the
  // source weights still decide the score minScore is judged on.
  const merged = groups.length === 1 && !groups[0].kbId
    ? groups[0].hits.map((hit) => applySourceWeight(hit, config).hit)
    : mergeKbGroups(groups, config);
  // Recency decay lands after the fusion, on the score the filters downstream judge:
  // rank_score for a fused hit, raw score for a single-library one. A missing state
  // file means no chunk has an age yet, so every weight is 1 and the merged list comes
  // through unchanged (that is what keeps this a no-op until the first hit is filed).
  const decayed = applyDecay(merged, config, {
    state: deps.decayState ?? readState(config?.decay?.statePath),
    now: deps.now,
  });
  stats.decay = decayed.stats;
  const expanded = await expandNeighbors(decayed.hits, config, deps, deadline);
  stats.neighbors = expanded.stats;
  return { ok: true, hits: expanded.hits, stats };
}
