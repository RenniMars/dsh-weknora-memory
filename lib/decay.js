/**
 * Recency decay and hit write-back for the injector.
 *
 * Two facts shape this module. WeKnora's Postgres is not reachable from the host
 * (the container publishes no port, the plugin is a host Node process), and every
 * chunks.metadata in the live database is NULL (measured: 0 of 4950 rows), so the
 * plugin cannot store a tier or a last-hit stamp in the database even if it wanted
 * to. State therefore lives in one JSON file of its own (config.decay.statePath).
 *
 * The age is measured from the last time the chunk was actually injected, falling
 * back to the moment the chunk was first filed. Document write time is deliberately
 * not used: a re-imported transcript is new to WeKnora and stale to the reader, and
 * "silence for ten minutes" is not a hit either.
 *
 * Weight is w = min(1, max(floor, 2^(-ageDays / tauDays))), applied to the RRF
 * rank_score *after* the cross-library merge, so the minScore / minScoreRatio
 * filters downstream judge the decayed value. A chunk already de-ranked by a
 * sourceWeights rule is not decayed on top of it (no double penalty): one of the
 * two applies, and the log says which.
 *
 * Every write is tmp-file + rename, and the read-merge-write is one synchronous
 * sequence, so two writers in this process cannot interleave and a reader in
 * another one sees either the old file or the new one, never half of each.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { cleanText } from "./format.js";

export const STATE_VERSION = 1;
export const DAY_MS = 86400000;
/** Bound on the state file: entries past this are dropped, oldest stamp first. */
export const MAX_STATE_ENTRIES = 4000;
const DEFAULT_TAU_DAYS = 30;
const DEFAULT_FLOOR = 0.35;
const TITLE_MAX = 80;

/** Identity of one chunk across the state file, the log and the seen-set. */
export function keyOfHit(hit) {
  const id = hit?.id;
  if (typeof id === "string" && id) return id;
  return String(hit?.knowledge_id ?? "?") + ":" + String(hit?.chunk_index ?? "?");
}

/**
 * The decay curve itself, with no side effects: 1.0 at age 0, halving every
 * tauDays, never below floor. A missing or non-positive tau falls back to 30.
 */
export function decayFactor(ageDays, options = {}) {
  const tau = Number(options.tauDays) > 0 ? Number(options.tauDays) : DEFAULT_TAU_DAYS;
  const floorValue = Number(options.floor);
  const floor = Number.isFinite(floorValue) ? Math.min(Math.max(floorValue, 0), 1) : DEFAULT_FLOOR;
  const age = Number(ageDays) > 0 ? Number(ageDays) : 0;
  return Math.min(1, Math.max(floor, Math.pow(2, -age / tau)));
}

/** Age in days from the entry's last hit (or first sight); null when unusable. */
export function ageDaysOf(entry, now) {
  const stamp = entry?.lastHit ?? entry?.firstSeen;
  if (typeof stamp !== "string" || !stamp) return null;
  const at = Date.parse(stamp);
  if (!Number.isFinite(at)) return null;
  const ms = (Number.isFinite(now) ? now : Date.now()) - at;
  return ms > 0 ? ms / DAY_MS : 0;
}

export function emptyState() {
  return { version: STATE_VERSION, updatedAt: "", chunks: {} };
}

/** Entries the file holds; 0 for a missing or unusable one. */
export function stateSize(state) {
  const chunks = state?.chunks;
  return chunks && typeof chunks === "object" ? Object.keys(chunks).length : 0;
}

/**
 * The state file as { version, updatedAt, chunks }; an empty state for a missing,
 * unreadable or truncated file. Missing state is the normal first-run case, so it is
 * never an error -- every chunk simply has no age yet and every weight is 1.
 */
export function readState(statePath) {
  if (!statePath) return emptyState();
  try {
    if (!existsSync(statePath)) return emptyState();
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyState();
    const chunks = parsed.chunks && typeof parsed.chunks === "object" && !Array.isArray(parsed.chunks) ? parsed.chunks : {};
    return { version: STATE_VERSION, updatedAt: String(parsed.updatedAt ?? ""), chunks };
  } catch {
    return emptyState();
  }
}

/**
 * Replace the state file atomically: write a unique temp file next to it, then
 * rename over it. A crash leaves the old file intact instead of a truncated one.
 */
export function writeState(statePath, state) {
  if (!statePath) return false;
  try {
    const dir = dirname(statePath);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = statePath + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, statePath);
    return true;
  } catch {
    return false;
  }
}

/** Drop the entries with the oldest stamp until the file is back inside its bound. */
function prune(chunks, limit) {
  const keys = Object.keys(chunks);
  if (keys.length <= limit) return chunks;
  const stampOf = (key) => {
    const entry = chunks[key] ?? {};
    const value = Date.parse(entry.lastHit ?? entry.firstSeen ?? "");
    return Number.isFinite(value) ? value : 0;
  };
  const ordered = keys.sort((a, b) => stampOf(b) - stampOf(a));
  const kept = {};
  for (const key of ordered.slice(0, limit)) kept[key] = chunks[key];
  return kept;
}

/**
 * File the hits that really entered one injection: first sight creates the entry
 * (firstSeen = now), a repeat refreshes lastHit and counts a hit. Pure: returns a
 * new state, the input is not mutated.
 * @returns { state, written } -- written counts the hits filed, not the file size.
 */
export function recordHits(state, hits, now, options = {}) {
  const at = new Date(Number.isFinite(now) ? now : Date.now()).toISOString();
  const limit = Number.isFinite(options.maxEntries) ? options.maxEntries : MAX_STATE_ENTRIES;
  const chunks = state?.chunks && typeof state.chunks === "object" ? { ...state.chunks } : {};
  let written = 0;
  for (const hit of Array.isArray(hits) ? hits : []) {
    const key = keyOfHit(hit);
    if (!key) continue;
    const prev = chunks[key] ?? {};
    chunks[key] = {
      firstSeen: typeof prev.firstSeen === "string" && prev.firstSeen ? prev.firstSeen : at,
      lastHit: at,
      hits: (Number(prev.hits) || 0) + 1,
      kbId: String(hit?.kb_id ?? hit?.knowledge_base_id ?? prev.kbId ?? ""),
      title: cleanText(hit?.knowledge_title || hit?.document || prev.title || "").slice(0, TITLE_MAX),
    };
    written += 1;
  }
  const next = { version: STATE_VERSION, updatedAt: at, chunks: prune(chunks, limit) };
  return { state: next, written };
}

/**
 * Read-merge-write the hits of one turn. The read and the rename happen in one
 * synchronous run, so two calls in this process serialize instead of losing each
 * other's entries; across processes the rename keeps the file parseable.
 * @returns { size, written, ok } -- ok false when the write failed (never throws).
 */
export function writeHits(statePath, hits, now, options = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (!statePath || list.length === 0) return { size: null, written: 0, ok: false };
  const state = readState(statePath);
  const { state: next, written } = recordHits(state, list, now, options);
  const ok = writeState(statePath, next);
  return { size: stateSize(next), written, ok };
}

/** Ranking score of a hit, mirroring retrieve.js: rank_score, else score. */
function rankOf(hit) {
  const rank = hit?.rank_score;
  if (typeof rank === "number" && Number.isFinite(rank)) return rank;
  const score = hit?.score;
  return typeof score === "number" && Number.isFinite(score) ? score : 0;
}

function scoreOf(hit) {
  const value = hit?.score;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Apply the recency weight to merged hits.
 *
 * Runs after the cross-library fusion, so it scales rank_score (and the raw score
 * with it) rather than any pre-fusion number. A hit de-ranked by a sourceWeights
 * rule keeps that factor alone unless decay.applyToSourceWeights is on: the two
 * are alternatives, not a product, and the skipped one is marked in the log.
 * A chunk with no state entry has no age yet, so it stays exactly as it arrived --
 * that is why an empty state file reproduces the pre-decay output byte for byte.
 *
 * @returns { hits, stats: { enabled, applied, skipped, min, max, state_size } }
 */
export function applyDecay(hits, config, deps = {}) {
  const list = Array.isArray(hits) ? hits : [];
  const decay = config?.decay;
  const stats = { enabled: false, applied: 0, skipped: 0, min: 1, max: 1, state_size: 0 };
  if (!decay || decay.enabled === false || list.length === 0) return { hits: list.slice(), stats };
  const state = deps.state ?? emptyState();
  const chunks = state?.chunks && typeof state.chunks === "object" ? state.chunks : {};
  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  stats.enabled = true;
  stats.state_size = stateSize(state);
  const out = list.slice();
  let changed = false;
  for (let index = 0; index < out.length; index += 1) {
    const hit = out[index];
    if (typeof hit?.applied_weight === "number" && decay.applyToSourceWeights !== true) {
      out[index] = { ...hit, decay_factor: 1, decay_skipped: "source_weight" };
      stats.skipped += 1;
      continue;
    }
    const ageDays = ageDaysOf(chunks[keyOfHit(hit)], now);
    if (ageDays === null) continue;
    const factor = decayFactor(ageDays, decay);
    if (factor === 1) {
      out[index] = { ...hit, decay_factor: 1, decay_age_days: Number(ageDays.toFixed(3)) };
      continue;
    }
    const next = {
      ...hit,
      score: scoreOf(hit) * factor,
      decay_factor: factor,
      decay_age_days: Number(ageDays.toFixed(3)),
    };
    if (typeof hit?.rank_score === "number" && Number.isFinite(hit.rank_score)) next.rank_score = hit.rank_score * factor;
    out[index] = next;
    changed = true;
  }
  // The merge sorted by rank_score; scaling it can reorder the tail, so restore the
  // order here rather than letting the neighbour expansion widen a demoted hit.
  if (changed) out.sort((a, b) => rankOf(b) - rankOf(a) || scoreOf(b) - scoreOf(a));
  // The range describes the weights that were really handed out: seeding it with 1 and
  // widening it only on the way up would report max 1 for a list that is entirely aged.
  let low = Infinity;
  let high = -Infinity;
  for (const hit of out) {
    if (typeof hit?.decay_factor !== "number" || hit.decay_skipped) continue;
    // "Applied" means the weight really dropped: minutes-old chunks round to 1.000 and
    // must not be reported as decayed, or a busy library reads as fully aged.
    stats.applied += Number(hit.decay_factor.toFixed(3)) < 1 ? 1 : 0;
    if (hit.decay_factor < low) low = hit.decay_factor;
    if (hit.decay_factor > high) high = hit.decay_factor;
  }
  if (Number.isFinite(low)) stats.min = Number(low.toFixed(3));
  if (Number.isFinite(high)) stats.max = Number(high.toFixed(3));
  return { hits: out, stats };
}
