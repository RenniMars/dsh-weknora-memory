/**
 * The panel's host side: reads and writes the profile, and aggregates the plugin's own log
 * for the stats view. Nothing here is on the injection path -- a panel failure never costs
 * a turn, and the injector keeps its own read of data/profile.json (mtime based), so an edit
 * here is live on the next turn.
 *
 * Served as a same-origin prefix route on the GUI's own web server (see
 * createPanelHandler): the browser fetch needs no CORS exchange and no second port, which
 * is the fault this replaced -- a loopback server on a fixed port that the page could not
 * reach. Same-origin does not weaken anything: the host web server binds a loopback
 * interface, and these endpoints were already loopback-only.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeProfileCard } from "./config.js";
import { cleanText, profileLine, selectProfileCardsDetailed, selectSoulCards } from "./format.js";

const MAX_BODY = 64 * 1024;
const KINDS = new Set(["user", "agent", "soul"]);

/** One profile.json payload, keeping every field the nightly task wrote. */
export function readProfileFile(file) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return { version: Number(raw?.version) || 1, cards: Array.isArray(raw?.cards) ? raw.cards : [] };
  } catch {
    return { version: 1, cards: [] };
  }
}

export function writeProfileFile(file, profile, backupDir) {
  const text = JSON.stringify({ version: Number(profile?.version) || 1, cards: profile.cards ?? [] }, null, 2) + "\n";
  if (backupDir) {
    mkdirSync(backupDir, { recursive: true });
    if (existsSync(file)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      copyFileSync(file, join(backupDir, "profile-" + stamp + ".json"));
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
  return text;
}

/** The shape the panel renders: cards, the caps that apply and what they cost. */
export function profileView(config, cards) {
  const fake = { profile: { ...config.profile, cards } };
  const detail = selectProfileCardsDetailed(fake);
  const soul = selectSoulCards(fake);
  const sum = (list) => list.reduce((total, card) => total + Array.from(cleanText(card.text)).length, 0);
  return {
    caps: detail.caps,
    soulCaps: {
      maxCards: Math.min(Number(config.profile.soulMaxCards) || 6, 6),
      maxChars: Math.min(Number(config.profile.soulMaxChars) || 300, 300),
    },
    spent: {
      user: detail.chars.user,
      agent: detail.chars.agent,
      soul: sum(soul),
    },
    rendered: {
      chosen: detail.chosen.length,
      dropped: detail.dropped,
      soulCards: soul.length,
    },
    cards: cards.map((card) => ({
      id: card.id,
      kind: card.kind,
      text: cleanText(card.text),
      chars: Array.from(cleanText(card.text)).length,
      status: card.status,
      core: card.core === true,
      source: card.source ?? "",
      valid_from: card.valid_from ?? "",
      approve: card.approve === true,
      attest: Number(card.attest) || 0,
      rendered: Boolean(profileLine(card)),
    })),
  };
}

/** Edit one card in place; unknown id is an error, not a silent append. */
export function updateCard(profile, id, patch, today = new Date().toISOString().slice(0, 10)) {
  const cards = (Array.isArray(profile?.cards) ? profile.cards : []).map((card) => ({ ...card }));
  const index = cards.findIndex((card) => card?.id === id);
  if (index < 0) return { error: "unknown_id" };
  const next = { ...cards[index] };
  if (patch.text !== undefined) next.text = String(patch.text).replace(/\s+/g, " ").trim();
  if (patch.kind !== undefined) {
    if (!KINDS.has(String(patch.kind))) return { error: "bad_kind" };
    next.kind = String(patch.kind);
  }
  if (patch.status !== undefined) {
    if (!["active", "proposed", "disputed"].includes(String(patch.status))) return { error: "bad_status" };
    next.status = String(patch.status);
  }
  if (patch.core !== undefined) next.core = patch.core !== false;
  if (patch.approve !== undefined) next.approve = patch.approve === true;
  const checked = normalizeProfileCard(next);
  if (!checked) return { error: "card_rejected" };
  if (!checked.text) return { error: "empty_text" };
  if (checked.status !== next.status) return { error: "bad_status" };
  next.text = checked.text;
  next.valid_from = next.valid_from || today;
  cards[index] = next;
  return { card: next, profile: { version: Number(profile?.version) || 1, cards } };
}

export function addCard(profile, input, today = new Date().toISOString().slice(0, 10)) {
  const kind = String(input?.kind ?? "user").trim();
  if (!KINDS.has(kind)) return { error: "bad_kind" };
  const text = String(input?.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { error: "empty_text" };
  const cards = (Array.isArray(profile?.cards) ? profile.cards : []).map((card) => ({ ...card }));
  const id = kind + "." + Date.now().toString(36);
  cards.push({
    id,
    kind,
    core: input?.core !== false,
    text,
    valid_from: today,
    status: "proposed",
    source: "panel",
    proposedAt: today,
    attest: 1,
  });
  return { card: cards[cards.length - 1], profile: { version: Number(profile?.version) || 1, cards } };
}

export function removeCard(profile, id) {
  const cards = Array.isArray(profile?.cards) ? profile.cards : [];
  const kept = cards.filter((card) => card?.id !== id);
  if (kept.length === cards.length) return { error: "unknown_id" };
  return { profile: { version: Number(profile?.version) || 1, cards: kept } };
}

/** Aggregate the inject log: what got injected, at what cost, and what was dropped. */
export function aggregateRetrieval(lines) {
  const out = {
    records: 0,
    attempts: 0,
    injected: 0,
    pinned_only: 0,
    hits: 0,
    retrieval_chars: 0,
    pinned_chars: 0,
    retired_dropped: 0,
    dropped_siblings: 0,
    kbs: {},
    durations: [],
    last: null,
  };
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record !== "object") continue;
    out.records += 1;
    // A skipped turn never asked the backend anything, so it must not drag the averages
    // down: the numbers that matter are per attempt, not per step.
    const attempted = record.retrieval_outcome !== "skip" && record.outcome !== "skipped";
    if (attempted) out.attempts += 1;
    // Only a step that actually asked the backend can count as an injection; the skip path
    // also reports outcome "injected" because it still delivered the pinned block.
    if (attempted && record.outcome === "injected") out.injected += 1;
    if (record.pinned_only) out.pinned_only += 1;
    out.hits += Number(record.hits) || 0;
    out.retrieval_chars += Number(record.retrieval_chars) || 0;
    out.pinned_chars += Number(record.pinned_chars) || 0;
    const fact = record.fact_counts ?? {};
    out.retired_dropped += Number(fact.retired_dropped) || 0;
    out.dropped_siblings += Number(fact.dropped_siblings) || 0;
    for (const kb of Array.isArray(record.kb) ? record.kb : []) {
      const label = String(kb?.label ?? kb?.id ?? "?");
      out.kbs[label] = (out.kbs[label] || 0) + (Number(kb?.hits) || 0);
    }
    const ms = Number(record.durationMs ?? record.ms ?? 0);
    if (ms > 0) out.durations.push(ms);
    out.last = record;
  }
  const pct = (part) => (out.attempts ? Math.round((part / out.attempts) * 1000) / 10 : 0);
  const sorted = out.durations.slice().sort((a, b) => a - b);
  // Nearest-rank quantile: with two samples p50 is the lower one, p95 the upper.
  const at = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] : 0);
  const over = Math.max(1, out.attempts);
  return {
    records: out.records,
    attempts: out.attempts,
    injected: out.injected,
    injected_pct: pct(out.injected),
    pinned_only: out.pinned_only,
    avg_hits: out.attempts ? Math.round((out.hits / out.attempts) * 100) / 100 : 0,
    avg_retrieval_chars: out.attempts ? Math.round(out.retrieval_chars / over) : 0,
    avg_pinned_chars: out.records ? Math.round(out.pinned_chars / out.records) : 0,
    retired_dropped: out.retired_dropped,
    dropped_siblings: out.dropped_siblings,
    kb_hits: out.kbs,
    p50_ms: at(0.5),
    p95_ms: at(0.95),
    last: out.last,
  };
}


function json(status, body) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function tailLines(file, limit) {
  try {
    const size = statSync(file).size;
    const window = Math.min(size, 4 * 1024 * 1024);
    const buffer = readFileSync(file);
    const text = buffer.subarray(Math.max(0, buffer.length - window)).toString("utf8");
    const lines = text.split("\n").filter(Boolean);
    return lines.slice(Math.max(0, lines.length - limit));
  } catch {
    return [];
  }
}

/**
 * Route root. These are exact paths under the GUI's own `/api` transport, which owns the
 * Host/Origin fence and the browser session: the client fetches them same-origin, so there
 * is no CORS exchange, no second port, and no token to copy around.
 */
export const PANEL_API_PREFIX = "/api/weknora-memory";

/** Everything the panel renders, in the one payload its first paint needs. */
export function panelSnapshot(options) {
  const { config, profilePath, statsPath, logFile } = options;
  const profile = readProfileFile(profilePath);
  let stats = {};
  try { stats = JSON.parse(readFileSync(statsPath, "utf8")); } catch { stats = {}; }
  const perCard = Object.entries(stats).map(([id, entry]) => ({
    id,
    rounds: Number(entry?.rounds) || 0,
    hits: Number(entry?.hits) || 0,
    missStreak: Number(entry?.missStreak) || 0,
    lastHitAt: entry?.lastHitAt ?? "",
    degrade: Boolean(entry?.degrade),
  })).sort((a, b) => b.hits - a.hits);
  const byKind = { user: 0, agent: 0, soul: 0 };
  const byStatus = { active: 0, proposed: 0, disputed: 0 };
  for (const card of profile.cards) {
    if (byKind[card.kind] !== undefined) byKind[card.kind] += 1;
    if (byStatus[card.status] !== undefined) byStatus[card.status] += 1;
  }
  return {
    ok: true,
    path: profilePath,
    profile: profileView(config, profile.cards),
    memory: { cards: profile.cards.length, byKind, byStatus, perCard },
    retrieval: aggregateRetrieval(tailLines(logFile, 1000)),
  };
}

/**
 * The panel's routes, as the connection service wants them: exact paths, one fetch handler
 * each. One GET for all three tabs, one POST for every mutation, so the browser half never
 * needs a path parameter -- the service only routes exact paths.
 */
export function panelRoutes(options) {
  const { profilePath, backupDir } = options;
  const snapshot = () => panelSnapshot(options);
  const card = {
    path: PANEL_API_PREFIX + "/card",
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      let body;
      try { body = await request.json(); } catch { return json(400, { ok: false, error: "bad_json" }); }
      const op = String(body?.op ?? "");
      const profile = readProfileFile(profilePath);
      const applied = op === "add"
        ? addCard(profile, body?.input ?? {})
        : op === "update"
          ? updateCard(profile, String(body?.id ?? ""), body?.patch ?? {})
          : op === "remove"
            ? removeCard(profile, String(body?.id ?? ""))
            : { error: "bad_op" };
      if (applied.error) return json(400, { ok: false, error: applied.error });
      writeProfileFile(profilePath, applied.profile, backupDir);
      return json(200, snapshot());
    },
  };
  return [
    {
      path: PANEL_API_PREFIX + "/state",
      methods: ["GET"],
      requestBody: "buffered",
      fetch: () => Promise.resolve(json(200, snapshot())),
    },
    card,
  ];
}
