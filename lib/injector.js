/**
 * The pre-step injector: one WeKnora retrieval per step, one bounded message.
 *
 * Flow: identity checks -> query (this turn's user text, or the previous turn's
 * text joined to a too-short follow-up) -> retrieve (<=1500ms, never throws) ->
 * drop hits already injected in this session -> render a bounded block -> compose
 * [pinned standing rules][retrieved block] -> append it as one plugin-sourced
 * user-role message at the end of the entering batch (the same mechanism the
 * Hindsight plugin used, see its dist/dsh.js createDshHooks/preStep). Any failure
 * path returns the decision untouched.
 *
 * The pinned layer is the exception to "retrieval decides whether anything is
 * injected": it is configuration, so it is delivered even when retrieval is skipped
 * or fails. With no pinned rules configured every path behaves exactly as before,
 * and an empty pinned block leaves the retrieval text byte for byte unchanged.
 *
 * Every attempt leaves one append-only JSONL record whose metadata is enough to
 * measure the injection later (per-library hits and top score, what the filters
 * dropped, the block size, the retrieval time). Records never carry prompt text
 * or chunk content.
 *
 * The per-session "already injected" set and the last usable user text are in memory,
 * bounded to MAX_SESSIONS sessions. The one thing that does persist is the recency
 * state file (lib/decay.js): it records when each injected chunk was last hit, which is
 * the only age signal this deployment can get -- WeKnora's Postgres is not reachable
 * from the host and every chunks.metadata is NULL.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { refreshProfileCards } from "./config.js";
import { readState, stateSize, writeHits } from "./decay.js";
import { applyFactCards, buildInjection, buildPinned, cleanText, composeInjection } from "./format.js";
import { searchWeKnora } from "./retrieve.js";
import { applyTierQuota } from "./tier.js";

export const PLUGIN_ID = "weknora-inject";
export const SOURCE_KIND = "plugin:" + PLUGIN_ID;
const MAX_SESSIONS = 200;
/** Ceiling for the previous-turn text prepended to a short follow-up. */
export const CONTEXT_QUERY_CHARS = 200;
/**
 * Factory reference for the retirement threshold (R6). Kept as a documented constant, not
 * as the live value: the threshold that counts comes from config.profile.degradeAfter,
 * whose default is 0 ("count only"). A non-zero default is exactly what emptied the
 * profile layer -- a 60-character card is almost never repeated verbatim by a chunk.
 */
export const PROFILE_DEGRADE_AFTER = 50;

/**
 * The reference counter (R6). Every active core card gets one round counted per turn and
 * one hit when its text really appears in the retrieved text of that turn. A card that
 * keeps missing is a card the retrieval no longer corroborates -- the nightly task
 * reads the degrade marker this file writes once missStreak reaches the configured
 * profile.degradeAfter, and retirement itself stays its decision.
 *
 * text is the haystack and it is the retrieved block, not the composed message: a
 * rendered card lives inside that message by construction, so measuring there would
 * score every card a hit on every turn. A hit therefore means the retrieval brought
 * the same fact back on its own.
 *
 * Only counts are written, never card text, and the file is data/profile-stats.json:
 * profile.json itself stays read-only for this plugin, which is the whole safety
 * boundary of a layer that is injected on every turn.
 *
 * degradeAfter is the configured threshold, not PROFILE_DEGRADE_AFTER. With 0 (the
 * default) the counter still measures missStreak but writes no degrade marker at all, so
 * a card cannot drift into retirement merely for being short: every entry is rebuilt from
 * scratch here, which is also why turning the switch off clears a marker left by an
 * earlier run.
 * @param options.degradeAfter consecutive misses that mark a card (0 = count only).
 * @returns { stats, tracked, hits, eligible } or null when there is nothing to count or the write failed.
 */
export function recordProfileRounds({
  cards,
  text,
  statsPath,
  degradeAfter = 0,
  now = Date.now(),
  readFile = readFileSync,
  writeFile = writeFileSync,
  ensureDir = mkdirSync,
}) {
  const list = (Array.isArray(cards) ? cards : [])
    .filter((card) => card && card.core === true && card.status === "active" && String(card.id ?? "").trim() && cleanText(card.text));
  if (list.length === 0 || !statsPath) return null;
  let stats = {};
  try {
    if (existsSync(statsPath)) {
      const parsed = JSON.parse(readFile(statsPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stats = parsed;
    }
  } catch {
    stats = {};
  }
  const body = cleanText(text);
  const at = new Date(now).toISOString();
  const threshold = Math.max(0, Math.floor(Number(degradeAfter) || 0));
  let hits = 0;
  let eligible = 0;
  for (const card of list) {
    const id = String(card.id).trim();
    const prev = stats[id] && typeof stats[id] === "object" ? stats[id] : {};
    const entry = {
      rounds: Math.max(0, Number(prev.rounds) || 0) + 1,
      hits: Math.max(0, Number(prev.hits) || 0),
      lastHitAt: typeof prev.lastHitAt === "string" ? prev.lastHitAt : null,
      missStreak: Math.max(0, Number(prev.missStreak) || 0),
    };
    if (body.includes(cleanText(card.text))) {
      entry.hits += 1;
      entry.lastHitAt = at;
      entry.missStreak = 0;
      hits += 1;
    } else {
      entry.missStreak += 1;
    }
    // The marker is the only degrade signal this plugin emits; retirement stays the
    // nightly task's action. No marker at all while the threshold is 0.
    if (threshold > 0 && entry.missStreak >= threshold) {
      entry.degrade = { after: threshold, at };
      eligible += 1;
    }
    stats[id] = entry;
  }
  try {
    ensureDir(dirname(statsPath), { recursive: true });
    writeFile(statsPath, JSON.stringify(stats, null, 2) + "\n");
  } catch {
    return null;
  }
  return { stats, tracked: list.length, hits, eligible };
}

/**
 * The newest user-role text in the entering batch -- what the user actually just
 * asked. Plugin-injected messages carry a non-user source and are ignored.
 */
export function promptFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message?.source?.kind !== "user") continue;
    const text = (message.content ?? [])
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

/**
 * Join the previous turn's text to a short follow-up ("继续", "那怎么办").
 * The current text is kept whole and the previous one is trimmed from its front,
 * so the newest words always survive the CONTEXT_QUERY_CHARS ceiling.
 */
export function mergeContextQuery(previous, current) {
  const head = clean(String(current ?? ""));
  const tailSource = clean(String(previous ?? ""));
  const room = Math.max(0, CONTEXT_QUERY_CHARS - head.length - 1);
  const tail = room > 0 && tailSource ? tailSource.slice(Math.max(0, tailSource.length - room)) : "";
  return tail ? tail + " " + head : head;
}

function clean(value) {
  return value.replace(/\s+/g, " ").trim();
}

function chunkKey(hit) {
  const id = hit?.id;
  if (typeof id === "string" && id) return id;
  return String(hit?.knowledge_id ?? "?") + ":" + String(hit?.chunk_index ?? "?");
}

/** Build the message appended to the entering batch. */
export function injectionMessage(text) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: SOURCE_KIND, form: "context" },
  };
}

/** Weighted hits a single record may name; past this the log entry stops being readable. */
const MAX_WEIGHT_LOG = 6;

/**
 * One log entry per hit a source rule de-ranked, so a later review can see which
 * document was pushed down, by how much, and whether it still made the block.
 * Titles are document names (metadata), never chunk content; the body stays out.
 */
function weightRecord(hits, usedKeys) {
  const list = Array.isArray(hits) ? hits : [];
  const out = [];
  for (const hit of list) {
    const factor = hit?.applied_weight;
    if (typeof factor !== "number" || !Number.isFinite(factor)) continue;
    if (out.length >= MAX_WEIGHT_LOG) break;
    const entry = {
      title: cleanText(hit?.knowledge_title || hit?.document || "").slice(0, 48),
      factor: Number(factor.toFixed(3)),
      reason: String(hit?.weight_reason ?? "weight"),
      from: Number(Number(hit?.base_score ?? 0).toFixed(4)),
      to: Number(Number(hit?.score ?? 0).toFixed(4)),
      used: usedKeys ? usedKeys.has(chunkKey(hit)) : false,
    };
    // A de-ranked block is never decayed on top of its own factor; say so here, so the
    // record proves the two penalties did not stack instead of only implying it.
    if (hit?.decay_skipped) entry.decay_skipped = String(hit.decay_skipped);
    out.push(entry);
  }
  return out;
}

/**
 * Recency accounting for the log: how many retrieved chunks carry a weight below 1,
 * how many were spared because a source rule already de-ranked them, and the range the
 * candidate list was judged in. A chunk with no state entry has no age yet, so it never
 * appears as decayed -- on a fresh state file "decayed: 0" is the correct answer.
 */
function decayRecordOf(hits) {
  const list = Array.isArray(hits) ? hits : [];
  let decayed = 0;
  let skipped = 0;
  let low = Infinity;
  let high = -Infinity;
  for (const hit of list) {
    const factor = hit?.decay_factor;
    if (typeof factor !== "number" || !Number.isFinite(factor)) continue;
    if (hit.decay_skipped) {
      skipped += 1;
      continue;
    }
    // Same 3-decimal rule as the weight range: a chunk filed minutes ago still weighs
    // 1.000 and must not be counted as decayed.
    if (Number(factor.toFixed(3)) < 1) decayed += 1;
    if (factor < low) low = factor;
    if (factor > high) high = factor;
  }
  // 1/1 is the honest range when no retrieved chunk carries an age at all.
  return {
    decayed,
    decay_skipped: skipped,
    decay_min: Number.isFinite(low) ? Number(low.toFixed(3)) : 1,
    decay_max: Number.isFinite(high) ? Number(high.toFixed(3)) : 1,
  };
}

/**
 * The decay half of one log record: the counts above plus state_size, the number of
 * chunks the state file holds after this turn's hit write-back. The write-back files
 * only the blocks that really entered the injection -- a candidate that lost the filter
 * or the character budget keeps ageing, or one retrieval would make it look current
 * forever.
 */
function decayFieldsOf(config, hits, used) {
  const fields = decayRecordOf(hits);
  const statePath = config?.decay?.statePath;
  if (config?.decay?.enabled === false || !statePath) return fields;
  const written = Array.isArray(used) && used.length ? writeHits(statePath, used, Date.now()) : null;
  return { ...fields, state_size: written?.size ?? stateSize(readState(statePath)) };
}

/**
 * The tier half of one log record: this round's census, what the escape paths released,
 * and how each quota was spent. Emitted only when the layer is enabled, so switching it
 * off leaves the record exactly the shape it had before the layer existed.
 */
function tierFieldsOf(stats) {
  if (!stats?.enabled) return {};
  return {
    tier_counts: { hot: stats.counts.hot, warm: stats.counts.warm, cold: stats.counts.cold },
    cold_released: {
      count: stats.released.count,
      title: stats.released.title,
      time: stats.released.time,
      all: stats.released.all,
      reasons: stats.released.reasons,
      window: stats.released.window,
    },
    tier_quotas: {
      hot: stats.quotas.hot,
      warm: stats.quotas.warm,
      cold: stats.quotas.cold,
      backfilled: stats.backfilled,
      dropped: stats.dropped,
    },
  };
}

/**
 * The fact-card half of one log record: how many candidates carried a card, how many were
 * stale, how many were de-ranked, how many the active-sibling rule retired, how many named a
 * document retired in factCards.retiredDocs, how many trailing chunks of one card the document
 * merge dropped, how many documents carried disagreeing heads, and how many conflict lines
 * closed the block. Counts only -- a claim is chunk content and never enters the log. Emitted only when the layer is on, so switching it off leaves the record exactly
 * the shape it had before the layer existed.
 */
function factFieldsOf(stats, conflicts) {
  if (!stats?.enabled) return {};
  return {
    fact_counts: {
      cards: stats.cards,
      superseded: stats.superseded,
      weighted: stats.weighted,
      dropped_superseded: stats.dropped_superseded,
      retired_dropped: stats.retired_dropped ?? 0,
      dropped_siblings: stats.dropped_siblings ?? 0,
      header_conflicts: stats.header_conflicts ?? 0,
      conflict_lines: conflicts,
    },
  };
}

/** Per-library measurement for the log: ids, labels, hit counts, top score. */
function kbRecord(stats) {
  const list = Array.isArray(stats?.kb) ? stats.kb : [];
  return list.map((entry) => {
    const record = {
      id: String(entry?.id ?? ""),
      label: String(entry?.label ?? ""),
      hits: Number(entry?.hits ?? 0),
      top: Number(Number(entry?.top ?? 0).toFixed(4)),
    };
    if (entry?.ok === false) record.error = String(entry?.reason ?? "unknown");
    return record;
  });
}

/**
 * @param options.config   clamped config from loadConfig()
 * @param options.log      record sink (default: no-op)
 * @param options.retrieve retrieval implementation (default: searchWeKnora)
 */
export function createWeKnoraInjector(options = {}) {
  const config = options.config;
  const log = options.log ?? (() => {});
  const retrieve = options.retrieve ?? searchWeKnora;
  const injected = new Map();
  const lastPrompt = new Map();

  const seenFor = (sessionId) => {
    let set = injected.get(sessionId);
    if (set === undefined) {
      if (injected.size >= MAX_SESSIONS) injected.delete(injected.keys().next().value);
      set = new Set();
      injected.set(sessionId, set);
    }
    return set;
  };

  const rememberPrompt = (sessionId, text) => {
    if (!lastPrompt.has(sessionId) && lastPrompt.size >= MAX_SESSIONS) {
      lastPrompt.delete(lastPrompt.keys().next().value);
    }
    lastPrompt.set(sessionId, text.slice(0, config.maxQueryChars));
  };

  /**
   * The retrieval query for this step, or null when there is nothing to ask with.
   * A prompt at or above minQueryChars becomes the new remembered text; a shorter
   * one borrows the previous turn's text instead of being dropped.
   */
  const queryOf = (sessionId, prompt) => {
    if (prompt.length >= config.minQueryChars) {
      rememberPrompt(sessionId, prompt);
      return { query: prompt.slice(0, config.maxQueryChars), merged: false };
    }
    const previous = lastPrompt.get(sessionId);
    if (!previous) return null;
    return { query: mergeContextQuery(previous, prompt), merged: true };
  };

  /**
   * The pinned block for this step plus the fields the log carries for it. Built once per
   * step: it depends on configuration only, never on retrieval, so it survives a backend
   * that is down, a query too short to search with, and a step where nothing was relevant.
   */
  const pinnedFor = () => {
    const pinned = buildPinned(config);
    // The profile accounting rides along so an empty agent layer is visible in the log as
    // "everything was dropped by X" instead of looking like "nothing was written".
    const usage = pinned.profile ?? {};
    const fields = {
      pinned_chars: pinned.chars,
      pinned_count: pinned.count,
      pinned_truncated: pinned.truncated,
      profile_user_chars: usage.chars?.user ?? 0,
      profile_agent_chars: usage.chars?.agent ?? 0,
      profile_soul_cards: usage.soul_cards ?? 0,
      profile_dropped: usage.dropped ?? {},
    };
    return { ...pinned, fields };
  };

  const enhance = async (input, decision) => {
    if (!decision || decision.kind !== "enter") return decision;
    if (config.enabled === false) return decision;
    const session = input?.agent?.session;
    const sessionId = session?.header?.id;
    if (!sessionId) return decision;
    if (config.skipSubagents && session?.header?.origin === "subagent") return decision;
    if (input?.signal?.aborted) return decision;

    // A card promoted by the nightly task has to appear without a restart: the profile
    // file is re-read only when its mtime moved, so this is one stat() on the common path.
    refreshProfileCards(config?.profile);
    const pinned = pinnedFor();
    /**
     * Close the step: compose pinned first, retrieval second, and log exactly once.
     * record carries this path's outcome and accounting; when the composed body is empty
     * the decision comes back untouched and only the record is written, which is the
     * behaviour a plugin with no pinned rules has for every path.
     */
    const finish = (record, retrievalText, used) => {
      const body = composeInjection(pinned.text, retrievalText);
      /**
       * Reference counting for the profile cards (R6), once per turn. It is diagnostics:
       * a failure here must never cost the injection, so every error degrades to "no
       * fields" and the message is delivered exactly as rendered.
       */
      const profileFields = (() => {
        const profile = config?.profile;
        if (!profile || profile.enabled === false) return {};
        try {
          // The haystack is the retrieved block, never the composed body: a rendered card
          // is by construction inside the body, so counting against body would give every
          // card a hit on every turn and the configured retirement could never fire.
          const counted = recordProfileRounds({
            cards: profile.cards,
            text: retrievalText,
            statsPath: profile.statsPath,
            degradeAfter: profile.degradeAfter,
          });
          if (!counted) return {};
          return {
            profile_cards: counted.tracked,
            profile_hits: counted.hits,
            ...(counted.eligible ? { profile_degrade_ready: counted.eligible } : {}),
          };
        } catch {
          return {};
        }
      })();
      if (!body) {
        log({ ...record, retrieval_chars: 0, ...pinned.fields, ...profileFields });
        return decision;
      }
      for (const hit of used) seen.add(chunkKey(hit));
      log({
        ...record,
        outcome: "injected",
        // Keep why retrieval contributed nothing (skip / degraded / no_inject) instead of
        // overwriting it: a pinned-only turn must still be diagnosable.
        ...(record.outcome === "injected" ? {} : { retrieval_outcome: record.outcome }),
        // chars keeps meaning "the retrieved block's size" (scripts/report.mjs compares it
        // to maxChars); the pinned budget is reported separately and body_chars is the
        // whole message a session really received.
        chars: retrievalText.length,
        retrieval_chars: retrievalText.length,
        body_chars: body.length,
        ...pinned.fields,
        ...profileFields,
        ...(retrievalText ? {} : { pinned_only: true }),
      });
      const messages = Array.isArray(decision.messages) ? decision.messages : [];
      return { ...decision, messages: [...messages, injectionMessage(body)] };
    };

    const prompt = promptFromMessages(decision.messages);
    if (!prompt) {
      return finish({ outcome: "skip", reason: "no_user_text", session: sessionId }, "", []);
    }
    const prepared = queryOf(sessionId, prompt);
    if (!prepared) {
      return finish({ outcome: "skip", reason: "short_prompt_no_context", session: sessionId, prompt_chars: prompt.length }, "", []);
    }
    const { query, merged } = prepared;
    const extra = merged ? { merged: true, query_chars: query.length } : {};
    const startedAt = Date.now();
    const result = await retrieve(query, config, { signal: input.signal });
    const ms = Date.now() - startedAt;
    if (!result?.ok) {
      // A dead backend must not take the standing rules down with it.
      return finish({ outcome: "degraded", reason: result?.reason ?? "unknown", ms, session: sessionId, ...extra, kb: kbRecord(result?.stats) }, "", []);
    }
    const hits = Array.isArray(result.hits) ? result.hits : [];
    const seen = seenFor(sessionId);
    const fresh = hits.filter((hit) => !seen.has(chunkKey(hit)));
    /**
     * Tiering sits between "which chunks are still candidates" and "which ones fit the
     * block": fusion and decay have already fixed the rank order, so the tier layer only
     * decides how many of that order may claim a slot. It reads the state file (never
     * writes -- decay.js owns the write-back) and is a pure function of it, so a chunk is
     * re-classified from scratch on the next turn.
     */
    const statePath = config?.decay?.statePath;
    /**
     * Fact cards sit between "which chunks are still candidates" and the tier quota: fusion,
     * source weight and decay have already fixed the order, so the card layer only re-weighs a
     * stale card (supersededFactor) and, when its subject also matched an active card, retires
     * it. Legacy chunks come back untouched, in the order they arrived.
     */
    const carded = applyFactCards(fresh, config);
    const tiered = applyTierQuota(carded.hits, config, {
      query,
      now: Date.now(),
      state: statePath ? readState(statePath) : undefined,
    });
    const tier = tierFieldsOf(tiered.stats);
    const shaped = buildInjection(tiered.hits, config);
    const fact = factFieldsOf(carded.stats, shaped.conflicts?.length ?? 0);
    /**
     * A quota exclusion is not a filter verdict. considered and dropped keep describing
     * the whole candidate list, so scripts/report.mjs reads the same numbers it read
     * before this layer, and a withheld chunk shows up in tier_quotas.dropped instead of
     * quietly looking like a score miss. When the quota changed nothing -- every round
     * where all candidates fit -- the census IS the shaped pass, one call as before.
     */
    const census = tiered.hits.length === fresh.length ? shaped : buildInjection(fresh, config);
    const { text, used } = shaped;
    const considered = census.considered;
    const dropped = census.dropped;
    const kb = kbRecord(result.stats);
    const usedKeys = new Set(used.map(chunkKey));
    const weights = weightRecord(fresh, usedKeys);
    const weighted = fresh.filter((hit) => typeof hit?.applied_weight === "number").length;
    const decay = decayFieldsOf(config, hits, used);
    if (!text) {
      // An emptied candidate list is the tier layer's own outcome, not a threshold miss:
      // naming it separately is what makes "cold chunks are being withheld" measurable.
      const withheld = tiered.stats.enabled && tiered.stats.dropped > 0 && tiered.hits.length === 0;
      const reason = withheld ? "tier_cold" : hits.length === 0 ? "no_hits" : fresh.length === 0 ? "all_seen" : "below_threshold";
      return finish({ outcome: "no_inject", reason, ms, session: sessionId, hits: hits.length, ...extra, kb, considered, dropped, weighted, weights, ...decay, ...tier, ...fact }, "", []);
    }
    return finish({ outcome: "injected", ms, session: sessionId, hits: used.length, scanned: hits.length, ...extra, kb, considered, dropped, weighted, weights, ...decay, ...tier, ...fact }, text, used);
  };

  const preStep = async (input, next) => {
    const decision = await next();
    try {
      return await enhance(input, decision);
    } catch (error) {
      try {
        log({ outcome: "error", reason: String(error?.message ?? error) });
      } catch {}
      return decision;
    }
  };

  return {
    preStep,
    enhance,
    forget: (sessionId) => {
      injected.delete(sessionId);
      lastPrompt.delete(sessionId);
    },
  };
}
