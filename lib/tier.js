/**
 * Lazy hot / warm / cold tiering: which retrieved chunks may still claim an
 * injection slot, and the three ways a cold one is let back in.
 *
 * Why lazy: the state file (config.decay.statePath, shared with decay.js) holds only
 * firstSeen / lastHit / hits / kbId / title per chunk, and Postgres is unreachable from
 * the host, so a nightly "demote everything" job would have nothing new to demote --
 * the age is a pure function of the stamp and "now". Tiering therefore computes itself
 * on the read path, once per retrieval, and never writes: no scheduler, no daemon, no
 * migration. Change the thresholds and the next turn re-classifies every chunk.
 *
 * The tier decides *slots*, not scores. rerank order is untouched: hot hits keep the
 * ordinary rank order, a tier only bounds how many of its own hits may claim a slot
 * ("reserved" mode below) and whether an unreleased cold hit may enter at all.
 *
 * Reserved quotas, and why a cap is not a hard truncation: hotTopK 2 out of a 3-hit
 * budget would drop today's third hit and change the injected body of every round that
 * hits three times -- the one thing this layer must not do today (its thresholds are
 * meant to be re-tuned after 14 days of data, not to bite on day one). So each tier
 * claims at most its cap, and *surplus is backfilled from the same budget in rank
 * order* -- never from an unreleased cold hit. With every candidate in one tier the
 * selection is therefore exactly "the top maxHits by rank", i.e. the pre-tier body, byte
 * for byte; the caps only start to choose between tiers when two of them compete.
 *
 * Import graph: this module imports decay.js (stamps, chunk identity) and format.js
 * (cleanText), and config.js imports normalizeTier from here -- so the cycle
 * config -> tier -> decay -> format -> config exists. It is safe in every entry order
 * because nobody reads another module's binding at init: DEFAULT_CONFIG.tier is {} and
 * normalizeTier() fills the defaults on each loadConfig(), while format.js / decay.js
 * only touch config.js bindings inside function bodies.
 */
import { DAY_MS, ageDaysOf, keyOfHit } from "./decay.js";
import { cleanText } from "./format.js";

export const TIER_HOT = "hot";
export const TIER_WARM = "warm";
export const TIER_COLD = "cold";

/**
 * Shipped thresholds. hotDays 14 / warmDays 90 are the "measure first" values: every
 * chunk filed by today's deployment is minutes old, so all of it is hot and the tier
 * layer is a no-op until real ages accumulate. coldTopK 0 is what keeps a cold chunk
 * out of the block by default; hotTopK / warmTopK are the slot reservations.
 */
export const DEFAULT_TIER = Object.freeze({
  enabled: true,
  hotDays: 14,
  warmDays: 90,
  coldTopK: 0,
  warmTopK: 1,
  hotTopK: 2,
  coldNeedsZeroHits: true,
});

/** Shortest run of a cold hit's title that must appear in the query to thaw it. */
export const MIN_TITLE_MATCH = 6;
/** Slot cap for one tier; 0 is legal and means "never selected". */
const MAX_TOP_K = 5;
const MAX_TIER_DAYS = 3650;

function numberOr(value, fallback) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampDays(value, fallback) {
  return Math.min(Math.max(numberOr(value, fallback), 1), MAX_TIER_DAYS);
}

function clampSlots(value, fallback) {
  return Math.min(Math.max(Math.round(numberOr(value, fallback)), 0), MAX_TOP_K);
}

/**
 * Clamp the tier block into the shape the rest of the plugin reads. A missing block
 * keeps the shipped defaults, so an older config file behaves like a fresh one.
 * WK_TIER=all is the environment-variable form of tier.includeAll (escape path a):
 * it is folded in here, once, so every downstream reader sees one flag.
 */
export function normalizeTier(value, env = {}) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const hotDays = clampDays(raw.hotDays, DEFAULT_TIER.hotDays);
  const envAll = String(env?.WK_TIER ?? "").trim().toLowerCase() === "all";
  return {
    enabled: raw.enabled !== false,
    hotDays,
    // warmDays can never precede hotDays, or the middle tier would be empty.
    warmDays: Math.max(hotDays, clampDays(raw.warmDays, DEFAULT_TIER.warmDays)),
    coldTopK: clampSlots(raw.coldTopK, DEFAULT_TIER.coldTopK),
    warmTopK: clampSlots(raw.warmTopK, DEFAULT_TIER.warmTopK),
    hotTopK: clampSlots(raw.hotTopK, DEFAULT_TIER.hotTopK),
    coldNeedsZeroHits: raw.coldNeedsZeroHits !== false,
    includeAll: raw.includeAll === true || envAll,
  };
}

/**
 * The tier of one chunk at one instant. Pure: no state is read or written here.
 *
 * age = now - (lastHit ?? firstSeen), the same age decay.js weighs, so a chunk cannot be
 * "recent" for the decay curve and "cold" for the tier layer at the same time.
 *   hot   age < hotDays
 *   warm  age < warmDays, or (age >= warmDays and it has been hit at least once)
 *   cold  age >= warmDays AND hits === 0        <- two conditions, never one
 * A chunk with no state entry has never been retrieved into a block, which is "new
 * material", not "stale material": warm, never cold. An unparsable stamp lands in the
 * same bucket for the same reason -- refusal to guess must not cost a chunk its slot.
 *
 * @param entry the state-file entry ({ firstSeen, lastHit, hits, ... }) or undefined
 * @param now epoch ms
 * @param cfg the normalized tier block
 */
export function tierOf(entry, now, cfg = DEFAULT_TIER) {
  const hotDays = clampDays(cfg?.hotDays, DEFAULT_TIER.hotDays);
  const warmDays = Math.max(hotDays, clampDays(cfg?.warmDays, DEFAULT_TIER.warmDays));
  const age = ageDaysOf(entry, now);
  if (age === null) return TIER_WARM;
  if (age < hotDays) return TIER_HOT;
  if (age < warmDays) return TIER_WARM;
  const hits = numberOr(entry?.hits, 0);
  // The default is the AND rule: old age alone is not enough, the counter must be empty
  // too. coldNeedsZeroHits false is the opt-out that makes age sufficient on its own.
  if (cfg?.coldNeedsZeroHits === false) return TIER_COLD;
  return hits > 0 ? TIER_WARM : TIER_COLD;
}

/** The title a cold hit is thawed by: the injected title, else the one filed in state. */
export function titleOf(hit, entry) {
  return cleanText(hit?.knowledge_title || hit?.document || entry?.title || "");
}

/**
 * Escape path b: the query names the cold chunk. True when any run of
 * MIN_TITLE_MATCH title characters appears verbatim in the query, so "记忆插件是否
 * 实际有用" thaws a chunk titled "... 记忆插件是否实际有用 (1) ..." but a two-character
 * overlap ("插件") never does -- a 6-character run is long enough to mean the user
 * typed the title and short enough to survive the title's own date/suffix padding.
 */
export function titleReleased(query, title) {
  const haystack = cleanText(query);
  const needle = cleanText(title);
  if (haystack.length < MIN_TITLE_MATCH || needle.length < MIN_TITLE_MATCH) return false;
  for (let at = 0; at + MIN_TITLE_MATCH <= needle.length; at += 1) {
    if (haystack.includes(needle.slice(at, at + MIN_TITLE_MATCH))) return true;
  }
  return false;
}

function dayStartOf(ms) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Escape path c: the query carries a time condition, turned into the window the cold
 * chunk's firstSeen must fall inside.
 *
 * Recognised: 最近N天 / 近N天, 今天 / 今日, 昨天 / 昨日, N月N日 (this year, or last year
 * when that date is still in the future). Anything else -- including "近三天", a
 * half-typed date, or a month of 31 in a 30-day month -- is not a time condition, so the
 * function returns null and the caller behaves exactly as if no time words were there.
 * It never throws: a query is user text, and a failed parse must not cost a retrieval.
 *
 * @returns { from, to, label } in epoch ms (to inclusive), or null
 */
export function parseTimeWindow(query, now = Date.now()) {
  try {
    const text = String(query ?? "");
    if (!text) return null;
    const stamp = Number.isFinite(now) ? now : Date.now();
    const span = /(?:最近|近)\s*(\d{1,4})\s*天/.exec(text);
    if (span) {
      const days = Number(span[1]);
      if (Number.isFinite(days) && days > 0) return { from: stamp - days * DAY_MS, to: stamp, label: "近" + days + "天" };
    }
    if (/今天|今日/.test(text)) return { from: dayStartOf(stamp), to: stamp, label: "今天" };
    if (/昨天|昨日/.test(text)) {
      const from = dayStartOf(stamp) - DAY_MS;
      return { from, to: from + DAY_MS - 1, label: "昨天" };
    }
    const calendar = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(text);
    if (calendar) {
      const month = Number(calendar[1]);
      const day = Number(calendar[2]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        const year = new Date(stamp).getFullYear();
        let from = new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
        // A day still ahead of us is a day of the previous year ("12月28日" asked in
        // January means the one just past, not the one eleven months out).
        if (Number.isFinite(from) && from > stamp) from = new Date(year - 1, month - 1, day, 0, 0, 0, 0).getTime();
        if (Number.isFinite(from)) return { from, to: from + DAY_MS - 1, label: month + "月" + day + "日" };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** firstSeen of a state entry in epoch ms, or null when it carries no usable stamp. */
export function firstSeenAt(entry) {
  const at = Date.parse(entry?.firstSeen ?? "");
  return Number.isFinite(at) ? at : null;
}

function emptyStats() {
  return {
    enabled: false,
    counts: { hot: 0, warm: 0, cold: 0 },
    released: { count: 0, title: 0, time: 0, all: 0, reasons: [], window: null },
    quotas: { hot: { cap: 0, used: 0 }, warm: { cap: 0, used: 0 }, cold: { cap: 0, used: 0 } },
    backfilled: 0,
    kept: 0,
    dropped: 0,
  };
}

/**
 * Apply the tier layer to this round's candidates and return the ones that may still
 * claim a slot, in rank order.
 *
 * Every candidate is classified from the state file (tierOf). A cold one is excluded
 * unless one of the three escape paths opens it: tier.includeAll / WK_TIER=all (path a,
 * counted as warm), a >= 6-character title run found in the query (path b, "title"), or
 * a firstSeen inside the window the query names (path c, "time"). A released hit is
 * treated as warm from then on -- it competes in the warm quota like any other warm hit
 * and is marked tier_released so the log can prove which path opened it.
 *
 * Selection is rank order with per-tier caps and backfill (see the header): a tier that
 * runs past its cap is skipped, then the skipped hits are re-admitted in rank order
 * while the budget is still unfilled. Unreleased cold hits are the one thing backfill
 * never pulls, which is what makes coldTopK 0 an exclusion instead of a suggestion.
 *
 * @param hits candidates in rank order (after fusion and decay)
 * @param config clamped config (tier, maxHits)
 * @param deps { state, now, query } -- state is the parsed tier-state file
 * @returns { hits, stats } with stats.counts / released / quotas / backfilled / kept /
 *   dropped, which is exactly what the injection log reports.
 */
export function applyTierQuota(hits, config, deps = {}) {
  const list = Array.isArray(hits) ? hits : [];
  const cfg = config?.tier;
  const stats = emptyStats();
  if (!cfg || cfg.enabled === false || list.length === 0) {
    stats.kept = list.length;
    return { hits: list.slice(), stats };
  }
  stats.enabled = true;
  const caps = {
    [TIER_HOT]: clampSlots(cfg.hotTopK, DEFAULT_TIER.hotTopK),
    [TIER_WARM]: clampSlots(cfg.warmTopK, DEFAULT_TIER.warmTopK),
    [TIER_COLD]: clampSlots(cfg.coldTopK, DEFAULT_TIER.coldTopK),
  };
  for (const tier of [TIER_HOT, TIER_WARM, TIER_COLD]) stats.quotas[tier].cap = caps[tier];
  const chunks = deps.state?.chunks && typeof deps.state.chunks === "object" ? deps.state.chunks : {};
  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  const query = String(deps.query ?? "");
  const window = parseTimeWindow(query, now);
  stats.released.window = window ? window.label : null;
  const budget = Math.min(Math.max(Math.round(numberOr(config?.maxHits, 3)), 1), 5);
  const reasons = new Set();

  const candidates = [];
  for (const hit of list) {
    const entry = chunks[keyOfHit(hit)];
    let tier = tierOf(entry, now, cfg);
    stats.counts[tier] += 1;
    let released = "";
    if (tier === TIER_COLD) {
      if (cfg.includeAll === true) released = "all";
      else if (titleReleased(query, titleOf(hit, entry))) released = "title";
      else {
        const seenAt = firstSeenAt(entry);
        if (window && seenAt !== null && seenAt >= window.from && seenAt <= window.to) released = "time";
      }
      if (released) {
        stats.released[released] += 1;
        reasons.add(released);
        tier = TIER_WARM;
      }
    }
    candidates.push({ hit, tier, released, order: candidates.length, backfilled: false });
  }
  stats.released.count = stats.released.title + stats.released.time + stats.released.all;
  stats.released.reasons = [...reasons];

  const chosen = [];
  const skipped = [];
  for (const candidate of candidates) {
    if (usedOf(stats, candidate.tier) < caps[candidate.tier]) {
      chosen.push(candidate);
      stats.quotas[candidate.tier].used += 1;
    } else {
      skipped.push(candidate);
    }
  }
  if (chosen.length < budget) {
    for (const candidate of skipped) {
      if (chosen.length >= budget) break;
      // The only tier backfill never touches: cold is excluded, not merely deprioritised.
      if (candidate.tier === TIER_COLD) continue;
      candidate.backfilled = true;
      chosen.push(candidate);
      stats.quotas[candidate.tier].used += 1;
      stats.backfilled += 1;
    }
  }
  stats.dropped = skipped.filter((candidate) => !candidate.backfilled).length;
  stats.kept = chosen.length;
  chosen.sort((a, b) => a.order - b.order);
  const out = chosen.map((candidate) => (candidate.released ? { ...candidate.hit, tier_released: candidate.released } : candidate.hit));
  return { hits: out, stats };
}

/** Selections already given to one tier (kept as a tiny helper for the quota loop). */
function usedOf(stats, tier) {
  return stats.quotas[tier]?.used ?? 0;
}
