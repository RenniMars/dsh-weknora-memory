/**
 * Configuration + file logging for @rennimars/dsh-weknora-memory.
 *
 * Settings live in wk-inject.config.json next to this package (apiUrl / apiKey /
 * kbIds / switches); values handed to the plugin by its cordis entry override the
 * file, and the file overrides DEFAULT_CONFIG. Every numeric field is clamped, so
 * a bad config can never widen the latency or length contract:
 * timeoutMs <= TIMEOUT_CAP_MS (1500) and maxChars <= CHARS_CAP (2400).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_TEMPLATE } from "./config-template.js";
import { normalizeTier } from "./tier.js";

/** Directory holding this package (lib/..), used to resolve config and log paths. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_FILENAME = "wk-inject.config.json";
export { CONFIG_TEMPLATE };
/**
 * Where the user's own state lives: the config, the profile card file and the logs.
 *
 * It sits outside the package on purpose. An upgrade replaces the whole package
 * directory, so a config or a card file written there is gone the moment the next
 * version lands -- and the published package ships neither (both are npmignored).
 * WK_INJECT_HOME names the directory outright; otherwise it is <DSH_HOME>/wk-inject,
 * with DSH_HOME defaulting to ~/.dsh.
 */
export function userDataDir(env = process.env) {
  const explicit = String(env.WK_INJECT_HOME ?? "").trim();
  if (explicit) return resolve(explicit);
  const dshHome = String(env.DSH_HOME ?? "").trim() || join(homedir(), ".dsh");
  return resolve(dshHome, "wk-inject");
}
/** Absolute path of the user-level config file this package falls back to. */
export function userConfigPath(env = process.env) {
  return join(userDataDir(env), CONFIG_FILENAME);
}

/**
 * JSONC helpers. JSON has no comments, and a config whose keys are unexplained is
 * the main reason a fresh install stays empty: nobody knows that "kbIds" means the
 * retrieval scope. So the shipped template carries a comment per field, and the
 * loader strips them before parsing. Only the two JSON comment forms and trailing
 * commas are supported -- enough for a hand-edited config, nothing more.
 */
export function stripJsonComments(text) {
  const src = String(text ?? "");
  let out = "";
  let i = 0;
  let inString = false;
  let quote = "";
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") { out += next ?? ""; i += 2; continue; }
      if (ch === quote) inString = false;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; out += ch; i += 1; continue; }
    if (ch === "/" && next === "/") { while (i < src.length && src[i] !== "\n") i += 1; continue; }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Parse a JSONC document: comments and trailing commas out, JSON.parse in. */
export function parseJsonc(text) {
  const stripped = stripJsonComments(String(text ?? "").replace(/^\uFEFF/, ""));
  return JSON.parse(stripped.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * Write the commented template into the user data directory when none exists yet.
 *
 * A fresh install otherwise reads as "installed but dead": the package ships no config, so
 * every field sits at its default and there is nothing on disk telling the user what to edit.
 * This drops a fully commented file in place on first start and never overwrites one that
 * already exists; a failed write is returned, never thrown, so a read-only home still loads.
 */
export function ensureUserConfig(env = process.env, options = {}) {
  const path = options.configPath ? resolve(options.configPath) : userConfigPath(env);
  const exists = options.existsSync ?? existsSync;
  if (exists(path)) return { path, created: false };
  try {
    mkdirSync(dirname(path), { recursive: true });
    (options.writeFile ?? writeFileSync)(path, CONFIG_TEMPLATE, "utf8");
    return { path, created: true };
  } catch (error) {
    return { path, created: false, error: String(error?.message ?? error) };
  }
}

/** Hard latency ceiling for one retrieval: the turn must never be held longer. */
export const TIMEOUT_CAP_MS = 4000;
/**
 * Hard ceiling for the injected block, delimiters included.
 * 2400 with maxHits 3 leaves ~800 characters per injected hit: a whole 241-char
 * median chunk plus both neighbours, instead of the 166-char shreds the old
 * 1500-char ceiling forced.
 */
export const CHARS_CAP = 2400;
/**
 * Hard ceiling for the pinned block (standing rules, see format.buildPinned). It is
 * a budget of its own: pinned text never consumes a character of CHARS_CAP.
 */
export const PINNED_MAX_CHARS_CAP = 2000;
/** Longest single standing rule, so one verbose entry cannot fill the whole block. */
const MAX_PINNED_TEXT = 200;
const MAX_PINNED_REASON = 24;
const MAX_PINNED_ITEMS = 12;
/**
 * Profile-layer caps (data/profile.json). These are the numbers the renderer enforces
 * too, so a hand-edited file cannot widen the block. Text is budgeted per kind, not per
 * block: a shared pot is what starved the agent layer to 0 cards, because three user
 * cards ate the 200 characters first and every agent card fell through the same gate.
 *   user  3 cards / 200 characters  -- who the user is
 *   agent 6 cards / 400 characters  -- how this agent works (habits, not facts)
 *   soul  6 cards / 300 characters  -- standing rules, rendered in section A, never scored
 * 80 characters per card is the ceiling that lets one card carry a rule plus its counter
 * example; the shipped cards average a third of it.
 */
export const PROFILE_MAX_CARDS = 9;
export const PROFILE_PER_KIND_MAX = 6;
export const PROFILE_USER_KIND_MAX = 3;
export const PROFILE_MAX_TEXT = 80;
export const PROFILE_USER_MAX_CHARS = 200;
export const PROFILE_AGENT_MAX_CHARS = 400;
export const PROFILE_SOUL_MAX_CARDS = 6;
export const PROFILE_SOUL_MAX_CHARS = 300;
/**
 * Ceiling for profile.degradeAfter. 0 -- the shipped value, and the default when the key
 * is absent -- disables retirement entirely: the counter still measures missStreak, but
 * the stats file carries no degrade marker for the nightly task to act on.
 */
export const PROFILE_DEGRADE_AFTER_MAX = 500;

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  apiUrl: "http://localhost:8080/api/v1",
  apiKey: "",
  kbIds: [],
  kbNames: {},
  kbId: "",
  kbLabel: "",
  timeoutMs: 3000,
  maxChars: CHARS_CAP,
  maxHits: 3,
  perKbHits: 2,
  topK: 10,
  rrfK: 60,
  neighborChunks: 1,
  neighborTimeoutMs: 400,
  minScore: 0.1,
  minScoreRatio: 0.45,
  /**
   * Source de-ranking: the first rule whose regex matches a hit's document title
   * multiplies that hit's raw score. Legacy Hermes transcripts ("hs-[{...") are
   * still useful evidence but were crowding real hits out of 3 injection slots, so
   * they are kept and pushed down instead of deleted.
   */
  sourceWeights: [
    { match: "^hs-", factor: 0.35, reason: "legacy-hermes" },
  ],
  /**
   * The four model-facing tools (list_knowledge_bases / search / read_document / ask), vendored
   * from @wxg-prc-cpg/dsh-weknora. Injection works without them; they are the manual route for
   * when the agent wants to look instead of waiting for the per-turn block. Tool names keep the
   * `weknora_` prefix so a prompt written against the old standalone plugin keeps working.
   */
  toolsEnabled: true,
  toolPrefix: "weknora",
  toolAgentId: "",
  toolTenantId: "",
  toolMaxResults: 8,
  toolMaxChunkChars: 1200,
  toolRequestTimeoutMs: 30000,
  toolChatTimeoutMs: 300000,
  toolResourceUrls: "handle",
  tools: Object.freeze({ listKnowledgeBases: true, search: true, readDocument: true, ask: true }),
  minQueryChars: 8,
  maxQueryChars: 500,
  skipSubagents: true,
  logFile: "logs/inject.log",
  /**
   * The memory panel: the sidebar tab's same-origin routes on the GUI's own web server.
   * It sits off the injection path entirely, so switching it off costs the agent nothing.
   */
  panelEnabled: true,
  /**
   * Standing rules: never scored, never decayed, injected at the head of every
   * message ahead of the retrieval block. An entry is { text, reason? }; an empty
   * list means the plugin renders exactly what it rendered before this layer existed.
   */
  pinned: [],
  /**
   * 1500: the four standing rules plus their note lines take ~343 characters, the soul
   * section adds up to 300 of text, and the profile section may now spend 200 (user) plus
   * 400 (agent) of card text on top. Every rendered card also pays ~22 characters of
   * "- [kind] ... —— 来源: <date>" overhead, and 15 lines pay it 15 times. Still a separate
   * budget from CHARS_CAP, so the retrieval block keeps its full 2400 characters; and still
   * a ceiling, not a target -- a file with fewer cards renders a shorter block.
   */
  pinnedMaxChars: 1500,
  /**
   * How often the pinned block is delivered. It is configuration, not retrieval: it renders
   * identically on every step of one user turn, and DSH persists each injected message into
   * the session, so a copy stays readable until something folds the history away.
   *   "session" -- once per session, re-seeded after a compaction or every
   *                pinnedRefreshTurns turns (default);
   *   "turn"    -- once per user turn;
   *   "step"    -- every step.
   */
  pinnedMode: "session",
  /**
   * Turns between re-deliveries in "session" mode. This is the guard for a fold the hook
   * cannot observe -- a compaction performed outside this process leaves no trace in the
   * session -- so the block comes back at most this many turns later. 0 disables it and
   * leaves compaction detection alone.
   */
  pinnedRefreshTurns: 8,
  /**
   * Standing profile facts (data/profile.json). The plugin only ever reads this file:
   * every write belongs to the nightly task (_wk_dream/profile-writer.mjs). That is the
   * safety boundary -- content that is injected every turn and never re-derived would
   * otherwise be able to propagate a poisoned fact across sessions.
   */
  profile: {
    enabled: true,
    path: "data/profile.json",
    statsPath: "data/profile-stats.json",
    maxCards: PROFILE_MAX_CARDS,
    perKindMax: { user: PROFILE_USER_KIND_MAX, agent: PROFILE_PER_KIND_MAX },
    maxText: PROFILE_MAX_TEXT,
    userMaxChars: PROFILE_USER_MAX_CHARS,
    agentMaxChars: PROFILE_AGENT_MAX_CHARS,
    soulMaxCards: PROFILE_SOUL_MAX_CARDS,
    soulMaxChars: PROFILE_SOUL_MAX_CHARS,
    /**
     * Consecutive zero-hit rounds after which the plugin marks a core card as degradable.
     * 0 means "count only" and is the shipped value: a 60-character card is almost never
     * repeated verbatim by a retrieval chunk, so any non-zero default ends up retiring
     * every card and emptying the layer. The marker lands in profile-stats.json; flipping
     * a card to disputed stays the nightly task's job.
     */
    degradeAfter: 0,
  },
  /**
   * Recency decay: a chunk's weight halves every tauDays since it was last injected,
   * down to floor. State lives in the plugin's own file (WeKnora's Postgres publishes
   * no port and every chunks.metadata is NULL), so nothing here needs the database.
   * applyToSourceWeights stays false: a block already de-ranked by sourceWeights keeps
   * that one factor instead of being penalised twice.
   */
  decay: {
    enabled: true,
    tauDays: 30,
    floor: 0.35,
    statePath: "data/tier-state.json",
    applyToSourceWeights: false,
  },
  /**
   * Hot / warm / cold slot quotas (see tier.js). The values ship in "measure first"
   * shape: every chunk today is minutes old, so everything is hot, hotTopK never binds
   * and the injected block is what it was before this layer. coldTopK 0 is the only
   * setting that changes behaviour, and only for a chunk that is old *and* was never
   * hit -- the numbers are meant to be re-tuned once 14 days of real ages exist.
   *
   * Left empty on purpose: the shipped numbers live in tier.js (DEFAULT_TIER) and
   * normalizeTier() fills this in on every loadConfig(). Evaluating a tier.js binding
   * here at module init would make the config -> tier -> decay -> format -> config
   * import cycle order-dependent (a TDZ error whenever tier.js is the entry point).
   */
  tier: {},
  /**
   * Fact cards (_wk_spec/fact-card-spec.md §4): a chunk whose first line is a
   * <!-- fact {...} --> head carries a status. A superseded card keeps its slot but weighs
   * supersededFactor, a subject that matched two live cards closes the block with one
   * conflict line, and every chunk without a head stays a legacy entry rendered exactly as
   * before -- which is why switching this off restores the previous bytes, not a re-derived
   * approximation. The conflict line is a separate switch from the weighting.
   */
  factCards: { enabled: true, supersededFactor: 0.3, conflictLine: true, retiredDocs: [] },
});

function clampNumber(value, fallback, min, max) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

/** Accept an array or a comma-separated string; drop blanks, duplicates keep order. */
function normalizeKbIds(value) {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(",");
  const out = [];
  for (const item of raw) {
    const id = String(item ?? "").trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function clampInt(value, fallback, min, max) {
  return Math.round(clampNumber(value, fallback, min, max));
}

/** Keep only id -> short label pairs; anything else is dropped rather than trusted. */
function normalizeKbNames(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, label] of Object.entries(value)) {
    const id = String(key ?? "").trim();
    const text = String(label ?? "").trim().slice(0, 16);
    if (id && text) out[id] = text;
  }
  return out;
}

const MAX_SOURCE_WEIGHTS = 8;
const MAX_WEIGHT_REASON = 32;
const MAX_WEIGHT_MATCH = 120;

/**
 * Keep only usable de-ranking rules: a regex that compiles, a factor in (0,1], and a
 * short reason. A factor of 1 is legal and means "matched, no change", which is how a
 * caller disables a rule without deleting it; out-of-range, non-numeric or
 * non-compiling entries are dropped rather than trusted.
 */
export function normalizeSourceWeights(value) {
  const raw = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const match = String(item.match ?? "").trim().slice(0, MAX_WEIGHT_MATCH);
    if (!match) continue;
    const factor = typeof item.factor === "number" ? item.factor : Number(item.factor);
    if (!Number.isFinite(factor) || factor <= 0 || factor > 1) continue;
    try {
      new RegExp(match);
    } catch {
      continue;
    }
    out.push({ match, factor, reason: String(item.reason ?? "").trim().slice(0, MAX_WEIGHT_REASON) || "weight" });
    if (out.length >= MAX_SOURCE_WEIGHTS) break;
  }
  return out;
}

/**
 * Keep only usable standing rules: a non-blank one-line text and an optional short
 * reason. Configuration order is preserved because the block renders in that order and
 * truncates from the tail; a bare string is accepted as { text }.
 */
export function normalizePinned(value) {
  const raw = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of raw) {
    if (out.length >= MAX_PINNED_ITEMS) break;
    const source = typeof item === "string" ? { text: item } : item;
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const text = String(source.text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_PINNED_TEXT);
    if (!text) continue;
    const reason = String(source.reason ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_PINNED_REASON);
    out.push(reason ? { text, reason } : { text });
  }
  return out;
}

/**
 * The delivery schedule for the pinned block. pinnedOncePerTurn is the pre-0.3.3 switch and
 * is still honoured, so a config file written for 0.3.1 keeps the behaviour it asked for:
 * false meant "every step". Anything unrecognised falls back to the shipped default.
 */
export function normalizePinnedMode(merged) {
  // The legacy switch wins when it is present at all: it is absent from the defaults now, so
  // seeing it means the file asked for that behaviour explicitly.
  if (merged?.pinnedOncePerTurn === false) return "step";
  const raw = String(merged?.pinnedMode ?? "").trim();
  if (raw === "session" || raw === "turn" || raw === "step") return raw;
  return DEFAULT_CONFIG.pinnedMode;
}

const DEFAULT_DECAY = DEFAULT_CONFIG.decay;
const DEFAULT_FACT = DEFAULT_CONFIG.factCards;
const MAX_RETIRED_DOCS = 50;
const MAX_RETIRED_ITEM = 200;

/**
 * Keep only usable retired-document entries: a non-blank title or knowledge_id, trimmed and
 * deduplicated case-insensitively (the matcher compares the same way). Config order is
 * preserved; the list is a deny list, so a typo simply retires nothing.
 */
export function normalizeRetiredDocs(value) {
  const raw = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (out.length >= MAX_RETIRED_DOCS) break;
    if (typeof item !== "string") continue;
    const text = item.trim().slice(0, MAX_RETIRED_ITEM);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/**
 * Clamp the fact-card block: enabled and conflictLine stay on unless literally false, so a
 * config file that predates this layer keeps the behaviour it had, and supersededFactor stays
 * inside (0,1] -- a factor of 0 would delete the card the contract says to keep demoted.
 */
export function normalizeFactCards(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    enabled: raw.enabled !== false,
    supersededFactor: clampNumber(raw.supersededFactor, DEFAULT_FACT.supersededFactor, 0.01, 1),
    conflictLine: raw.conflictLine !== false,
    retiredDocs: normalizeRetiredDocs(raw.retiredDocs),
  };
}

/**
 * Clamp the decay block: a positive tau, a floor inside [0,1], the state file resolved
 * against the package root (so the shipped relative "data/tier-state.json" lands
 * inside the plugin), and the source-weight override off unless it is literally true.
 * A missing block keeps the shipped defaults, which is why an older config file still
 * gets the same behaviour as a fresh one.
 */
export function normalizeDecay(value, packageRoot) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const stateRel = String(raw.statePath ?? DEFAULT_DECAY.statePath).trim() || DEFAULT_DECAY.statePath;
  return {
    enabled: raw.enabled !== false,
    tauDays: clampNumber(raw.tauDays, DEFAULT_DECAY.tauDays, 1, 3650),
    floor: clampNumber(raw.floor, DEFAULT_DECAY.floor, 0, 1),
    statePath: resolve(packageRoot, stateRel),
    applyToSourceWeights: raw.applyToSourceWeights === true,
  };
}

/* --------------------------------------------------------------- profile cards */

const PROFILE_KINDS = new Set(["user", "agent", "soul"]);
const PROFILE_STATUS = new Set(["active", "proposed", "disputed"]);
const PROFILE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PROFILE_ID_MAX = 64;
const PROFILE_SOURCE_MAX = 120;

/**
 * Keep only a usable profile card: a known kind, a one-line text inside 60 characters,
 * a known status and an ISO date. A card that fails any of them is dropped rather than
 * repaired -- the file is written by the nightly task, and a malformed card is exactly
 * the case that must never reach the prompt. A missing status reads as "proposed"
 * (the fail-closed side): only an explicitly active card is injected.
 */
export function normalizeProfileCard(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = String(value.id ?? "").trim().slice(0, PROFILE_ID_MAX);
  const kind = String(value.kind ?? "").trim();
  if (!id || !PROFILE_KINDS.has(kind)) return null;
  const text = String(value.text ?? "").replace(/\s+/g, " ").trim().slice(0, PROFILE_MAX_TEXT);
  if (!text) return null;
  const rawStatus = String(value.status ?? "").trim();
  const validFrom = String(value.valid_from ?? "").trim();
  const proposedAt = String(value.proposedAt ?? "").trim();
  return {
    id,
    kind,
    core: value.core === true,
    text,
    valid_from: PROFILE_DATE.test(validFrom) ? validFrom : "",
    status: PROFILE_STATUS.has(rawStatus) ? rawStatus : "proposed",
    source: String(value.source ?? "").replace(/\s+/g, " ").trim().slice(0, PROFILE_SOURCE_MAX),
    proposedAt: PROFILE_DATE.test(proposedAt) ? proposedAt : "",
  };
}

/**
 * Read data/profile.json. Read-only by construction: nothing in this module (and nothing
 * in lib/) writes it, which is the property the "plugin never writes the profile" test
 * checks by scanning the sources. Any failure yields an empty card list, so a broken
 * file degrades to "no profile layer" instead of failing the turn.
 */
export function readProfileCards(path, readFile = readFileSync) {
  try {
    if (!existsSync(path)) return { version: 1, cards: [], exists: false };
    const parsed = parseJsonc(readFile(path, "utf8"));
    const raw = Array.isArray(parsed?.cards) ? parsed.cards : [];
    const cards = [];
    for (const item of raw) {
      const card = normalizeProfileCard(item);
      if (card) cards.push(card);
    }
    return { version: Number(parsed?.version) || 1, cards, exists: true };
  } catch {
    return { version: 1, cards: [], exists: false, error: true };
  }
}

/**
 * One quota per kind, from either shape: a bare number applies to both kinds (the pre-split
 * config), an object names them. user and agent are clamped apart because their ceilings
 * differ, and soul has no quota here -- it is a separate section with its own budget.
 */
export function normalizePerKindMax(value) {
  const src = value && typeof value === "object" && !Array.isArray(value) ? value : { user: value, agent: value };
  return {
    user: clampInt(src.user, PROFILE_USER_KIND_MAX, 1, PROFILE_USER_KIND_MAX),
    agent: clampInt(src.agent, PROFILE_PER_KIND_MAX, 1, PROFILE_PER_KIND_MAX),
  };
}

/**
 * Re-read data/profile.json when its mtime moved, and return the card list to render.
 * One stat() per turn (microseconds), no parse unless the file actually changed. A layer
 * that is off, or whose cards were handed in directly, is returned untouched.
 */
export function refreshProfileCards(profile, stat = statSync) {
  if (!profile || profile.enabled === false || profile.cardsFromFile !== true) return profile?.cards ?? [];
  try {
    const stamp = stat(profile.path).mtimeMs;
    if (stamp === profile.mtimeMs) return profile.cards;
    const read = readProfileCards(profile.path);
    if (!read.exists) return profile.cards;
    profile.cards = read.cards;
    profile.mtimeMs = stamp;
    return profile.cards;
  } catch {
    return profile.cards ?? [];
  }
}

/**
 * Clamp the profile block. Both paths resolve against the package root and every cap is
 * clamped to this module's hard ceiling. `cards` is an accepted override (tests, and a
 * caller that has already parsed the file).
 */
export function normalizeProfile(value, packageRoot = PACKAGE_ROOT) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const rel = (input, fallback) => String(input ?? fallback).trim() || fallback;
  const out = {
    enabled: raw.enabled !== false,
    path: resolve(packageRoot, rel(raw.path, DEFAULT_CONFIG.profile.path)),
    statsPath: resolve(packageRoot, rel(raw.statsPath, DEFAULT_CONFIG.profile.statsPath)),
    maxCards: clampInt(raw.maxCards, PROFILE_MAX_CARDS, 1, PROFILE_MAX_CARDS),
    perKindMax: normalizePerKindMax(raw.perKindMax),
    maxText: clampInt(raw.maxText, PROFILE_MAX_TEXT, 10, PROFILE_MAX_TEXT),
    userMaxChars: clampInt(raw.userMaxChars, PROFILE_USER_MAX_CHARS, 20, PROFILE_USER_MAX_CHARS),
    agentMaxChars: clampInt(raw.agentMaxChars, PROFILE_AGENT_MAX_CHARS, 40, PROFILE_AGENT_MAX_CHARS),
    soulMaxCards: clampInt(raw.soulMaxCards, PROFILE_SOUL_MAX_CARDS, 1, PROFILE_SOUL_MAX_CARDS),
    soulMaxChars: clampInt(raw.soulMaxChars, PROFILE_SOUL_MAX_CHARS, 0, PROFILE_SOUL_MAX_CHARS),
    degradeAfter: clampInt(raw.degradeAfter, DEFAULT_CONFIG.profile.degradeAfter, 0, PROFILE_DEGRADE_AFTER_MAX),
  };
  if (Array.isArray(raw.cards)) out.cards = raw.cards.map(normalizeProfileCard).filter(Boolean);
  return out;
}

/**
 * Merge defaults, the JSON file and the plugin's cordis config into one clamped object.
 * A missing or unparsable file is not an error: defaults still apply.
 * @param overrides config object from the cordis entry, if any.
 * @param options packageRoot override and readFile override (tests).
 */
/** Tool names are model-visible identifiers; upstream rejects anything else. */
const TOOL_PREFIX_RE = /^[a-z][a-z0-9_]*$/;

function normalizeToolPrefix(value) {
  const text = String(value ?? "").trim();
  return TOOL_PREFIX_RE.test(text) ? text : DEFAULT_CONFIG.toolPrefix;
}

/**
 * Which of the four tools exist. A switch that is off is not registered at all, so the
 * model never sees a tool that would only fail; the upstream default is all four.
 */
function normalizeToolToggles(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const toggles = {};
  for (const key of Object.keys(DEFAULT_CONFIG.tools)) {
    toggles[key] = source[key] !== false;
  }
  return toggles;
}

export function loadConfig(overrides = {}, options = {}) {
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const readFile = options.readFile ?? readFileSync;
  // WK_TIER=all is the environment form of tier.includeAll; an explicit env keeps a
  // test hermetic instead of depending on whatever the host exported.
  const env = options.env ?? process.env;
  // Config search order, first existing file wins: the caller's explicit path, then the
  // user-level file (only when the host asks for it -- a test stays hermetic without it),
  // then the legacy copy inside the package. Relative paths in the file (profile data,
  // logs) resolve against the directory the file was found in, so an upgrade of the
  // package can never move the user's state.
  const explicit = String(env.WK_INJECT_CONFIG ?? "").trim();
  const candidates = [
    explicit ? resolve(explicit) : "",
    options.configPath ? resolve(options.configPath) : "",
    options.useUserConfig ? userConfigPath(env) : "",
    resolve(packageRoot, CONFIG_FILENAME),
  ].filter(Boolean);
  const path = candidates.find((candidate) => existsSync(candidate)) ?? candidates[candidates.length - 1];
  const configHome = dirname(path);
  let fromFile = {};
  if (existsSync(path)) {
    try {
      const parsed = parseJsonc(readFile(path, "utf8"));
      if (parsed && typeof parsed === "object") fromFile = parsed;
    } catch {
      fromFile = {};
    }
  }
  const merged = { ...DEFAULT_CONFIG, ...fromFile, ...(overrides ?? {}) };
  // A published copy carries no credentials, so the endpoint and the key can come from the
  // environment; the environment wins when it names one, which is what keeps a key out of the
  // JSON file on a machine that exports it. Neither is exported by this plugin.
  const envApiUrl = String(env.WEKNORA_API_URL ?? "").trim();
  const envApiKey = String(env.WEKNORA_API_KEY ?? "");
  if (envApiUrl) merged.apiUrl = envApiUrl;
  if (envApiKey) merged.apiKey = envApiKey;
  // The profile file is read here and nowhere else; writing it belongs to the nightly
  // task alone (R2). A disabled layer keeps an empty card list, so it costs no read.
  const profile = normalizeProfile(merged.profile, configHome);
  if (!profile.enabled) profile.cards = [];
  else if (!Array.isArray(profile.cards)) {
    profile.cards = readProfileCards(profile.path, readFile).cards;
    // Only a card list that came from the file is ever refreshed from it later: a caller
    // that passed cards directly (tests) must never have them replaced by whatever is on
    // disk. The nightly task writes at 03:30, and a long-lived session would otherwise
    // wait for a restart before a promoted card appeared.
    profile.cardsFromFile = true;
    try { profile.mtimeMs = statSync(profile.path).mtimeMs; } catch { profile.mtimeMs = 0; }
  }
  // kbIds is the search scope; a legacy single kbId still works when kbIds is absent.
  const legacyKbId = String(merged.kbId ?? "").trim();
  const kbIds = normalizeKbIds(merged.kbIds);
  return {
    enabled: merged.enabled !== false,
    apiUrl: String(merged.apiUrl ?? "").trim(),
    apiKey: String(merged.apiKey ?? ""),
    kbIds: kbIds.length ? kbIds : legacyKbId ? [legacyKbId] : [],
    kbNames: normalizeKbNames(merged.kbNames),
    kbId: legacyKbId,
    kbLabel: String(merged.kbLabel ?? "").trim(),
    timeoutMs: clampInt(merged.timeoutMs, DEFAULT_CONFIG.timeoutMs, 50, TIMEOUT_CAP_MS),
    maxChars: clampInt(merged.maxChars, DEFAULT_CONFIG.maxChars, 200, CHARS_CAP),
    maxHits: clampInt(merged.maxHits, DEFAULT_CONFIG.maxHits, 1, 5),
    perKbHits: clampInt(merged.perKbHits, DEFAULT_CONFIG.perKbHits, 1, 5),
    topK: clampInt(merged.topK, DEFAULT_CONFIG.topK, 1, 50),
    rrfK: clampInt(merged.rrfK, DEFAULT_CONFIG.rrfK, 1, 1000),
    neighborChunks: clampInt(merged.neighborChunks, DEFAULT_CONFIG.neighborChunks, 0, 2),
    neighborTimeoutMs: clampInt(merged.neighborTimeoutMs, DEFAULT_CONFIG.neighborTimeoutMs, 50, TIMEOUT_CAP_MS),
    minScore: clampNumber(merged.minScore, DEFAULT_CONFIG.minScore, 0, 1),
    minScoreRatio: clampNumber(merged.minScoreRatio, DEFAULT_CONFIG.minScoreRatio, 0, 1),
    sourceWeights: normalizeSourceWeights(merged.sourceWeights ?? DEFAULT_CONFIG.sourceWeights),
    minQueryChars: clampInt(merged.minQueryChars, DEFAULT_CONFIG.minQueryChars, 1, 1000),
    maxQueryChars: clampInt(merged.maxQueryChars, DEFAULT_CONFIG.maxQueryChars, 50, 4000),
    skipSubagents: merged.skipSubagents !== false,
    toolsEnabled: merged.toolsEnabled !== false,
    toolPrefix: normalizeToolPrefix(merged.toolPrefix),
    toolAgentId: String(merged.toolAgentId ?? "").trim(),
    toolTenantId: String(merged.toolTenantId ?? "").trim(),
    toolMaxResults: clampInt(merged.toolMaxResults, DEFAULT_CONFIG.toolMaxResults, 1, 50),
    toolMaxChunkChars: clampInt(merged.toolMaxChunkChars, DEFAULT_CONFIG.toolMaxChunkChars, 200, 20000),
    toolRequestTimeoutMs: clampInt(merged.toolRequestTimeoutMs, DEFAULT_CONFIG.toolRequestTimeoutMs, 1000, 120000),
    toolChatTimeoutMs: clampInt(merged.toolChatTimeoutMs, DEFAULT_CONFIG.toolChatTimeoutMs, 5000, 900000),
    toolResourceUrls: merged.toolResourceUrls === "public" ? "public" : "handle",
    tools: normalizeToolToggles(merged.tools),
    logFile: resolve(configHome, String(merged.logFile ?? DEFAULT_CONFIG.logFile)),
    /** Which config file was actually read, and the directory relative paths resolve in. */
    configPath: path,
    configHome,
    panelEnabled: merged.panelEnabled !== false,
    pinned: normalizePinned(merged.pinned),
    pinnedMaxChars: clampInt(merged.pinnedMaxChars, DEFAULT_CONFIG.pinnedMaxChars, 120, PINNED_MAX_CHARS_CAP),
    pinnedMode: normalizePinnedMode(merged),
    pinnedRefreshTurns: clampInt(merged.pinnedRefreshTurns, DEFAULT_CONFIG.pinnedRefreshTurns, 0, 200),
    profile,
    decay: normalizeDecay(merged.decay, configHome),
    tier: normalizeTier(merged.tier, env),
    factCards: normalizeFactCards(merged.factCards),
  };
}

/**
 * Build an append-only JSONL logger. Records carry metadata only (session id,
 * timings, hit counts, decision) -- never prompt text or chunk content. After the
 * first write failure the logger disables itself instead of retrying per turn.
 */
export function createLogger(config, options = {}) {
  const appendFile = options.appendFile ?? appendFileSync;
  const ensureDir = options.mkdir ?? mkdirSync;
  let ready = false;
  let broken = false;
  return (record) => {
    if (broken) return;
    try {
      if (!ready) {
        ensureDir(dirname(config.logFile), { recursive: true });
        ready = true;
      }
      appendFile(config.logFile, JSON.stringify({ at: new Date().toISOString(), plugin: "weknora-inject", ...record }) + "\n");
    } catch {
      broken = true;
    }
  };
}
