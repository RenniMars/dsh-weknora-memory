#!/usr/bin/env node
/**
 * Offline summary of logs/inject.log (append-only JSONL written by the plugin).
 *
 * Read-only: it never writes, rotates or truncates the log. Records written before
 * the measurement fields existed lack kb[]/dropped/considered and are counted as
 * such instead of being treated as zero-scored data points.
 *
 * Usage: node scripts/report.mjs [--days N] [--file <path>] [--json]
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CHARS_CAP, loadConfig } from "../lib/config.js";
import { readState } from "../lib/decay.js";
import { tierOf } from "../lib/tier.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LOG = resolve(PACKAGE_ROOT, "logs", "inject.log");
const DAY_MS = 86400000;

function parseArgs(argv) {
  const options = { days: 7, file: DEFAULT_LOG, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--days") options.days = Number(argv[++index]);
    else if (arg.startsWith("--days=")) options.days = Number(arg.slice(7));
    else if (arg === "--file") options.file = resolve(argv[++index] ?? "");
    else if (arg.startsWith("--file=")) options.file = resolve(arg.slice(7));
    else if (arg === "--help" || arg === "-h") {
      console.log("用法: node scripts/report.mjs [--days N] [--file <path>] [--json]");
      process.exit(0);
    } else {
      console.error("未知参数: " + arg);
      console.error("用法: node scripts/report.mjs [--days N] [--file <path>] [--json]");
      process.exit(2);
    }
  }
  if (!Number.isFinite(options.days) || options.days <= 0) {
    console.error("--days 必须是正数");
    process.exit(2);
  }
  return options;
}

function readRecords(path) {
  const raw = readFileSync(path, "utf8");
  const records = [];
  let bad = 0;
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    try {
      const record = JSON.parse(text);
      if (record && typeof record === "object") records.push(record);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  return { records, bad };
}

const isNum = (value) => typeof value === "number" && Number.isFinite(value);
const mean = (list) => (list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : 0);
const pct = (part, whole) => (whole ? ((part / whole) * 100).toFixed(1) + "%" : "-");

/** Terminal width of a string, counting CJK glyphs as two columns. */
function widthOf(text) {
  let width = 0;
  for (const char of String(text)) {
    width += /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6]/.test(char) ? 2 : 1;
  }
  return width;
}

function pad(text, width) {
  const value = String(text);
  return value + " ".repeat(Math.max(0, width - widthOf(value)));
}

function summarize(records, options) {
  const now = Date.now();
  const since = now - options.days * DAY_MS;
  const inWindow = [];
  let undated = 0;
  for (const record of records) {
    const at = Date.parse(record.at ?? "");
    if (!Number.isFinite(at)) {
      undated += 1;
      continue;
    }
    if (at >= since) inWindow.push(record);
  }

  const outcomes = {};
  const reasons = {};
  const injected = [];
  const retrieval = [];
  const kbTotals = new Map();
  const droppedTotals = { score: 0, ratio: 0, short: 0, budget: 0 };
  let withKb = 0;
  let withDropped = 0;
  let noInject = 0;
  let withWeights = 0;
  let weightedTotal = 0;
  const weightEntries = [];
  const weightRules = new Map();
  const pinnedChars = [];
  const pinnedCounts = [];
  const retrievalChars = [];
  const bodyChars = [];
  const decayedCounts = [];
  const decaySkipped = [];
  const decayMins = [];
  const decayMaxs = [];
  const stateSizes = [];
  let withPinned = 0;
  let pinnedTruncated = 0;
  let withDecay = 0;
  // Tiering: what the layers offered, what claimed a slot, what the escape paths
  // opened, and in how many rounds a cap actually had to withhold something.
  const tierSeen = { hot: 0, warm: 0, cold: 0 };
  const tierChosen = { hot: 0, warm: 0, cold: 0 };
  const tierPressure = { hot: 0, warm: 0, cold: 0 };
  const releasedTotals = { count: 0, title: 0, time: 0, all: 0 };
  const releaseRounds = new Map();
  let withTier = 0;
  let tierBackfilled = 0;
  let tierDropped = 0;

  for (const record of inWindow) {
    const outcome = String(record.outcome ?? "unknown");
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    const reason = record.reason ? String(record.reason) : "";
    if (reason) {
      const key = reason + "|" + outcome;
      reasons[key] = (reasons[key] ?? 0) + 1;
    }
    if (outcome === "injected") injected.push(record);
    if (outcome === "no_inject") noInject += 1;
    if (outcome === "injected" || outcome === "no_inject" || outcome === "degraded") retrieval.push(record);

    if (Array.isArray(record.kb)) {
      withKb += 1;
      for (const entry of record.kb) {
        const key = String(entry?.label || entry?.id || "kb");
        let bucket = kbTotals.get(key);
        if (!bucket) {
          bucket = { label: key, rounds: 0, withHits: 0, tops: [], hits: 0 };
          kbTotals.set(key, bucket);
        }
        bucket.rounds += 1;
        const hits = isNum(entry?.hits) ? entry.hits : 0;
        bucket.hits += hits;
        if (hits > 0) bucket.withHits += 1;
        if (isNum(entry?.top)) bucket.tops.push(entry.top);
      }
    }
    if (isNum(record.weighted)) weightedTotal += record.weighted;
    if (Array.isArray(record.weights)) {
      withWeights += 1;
      for (const entry of record.weights) {
        if (!entry || typeof entry !== "object") continue;
        const factor = isNum(entry.factor) ? entry.factor : null;
        const reason = String(entry.reason || "weight");
        weightEntries.push({ reason, factor, used: entry.used === true });
        let bucket = weightRules.get(reason);
        if (!bucket) {
          bucket = { reason, count: 0, used: 0, factors: [], froms: [], tos: [] };
          weightRules.set(reason, bucket);
        }
        bucket.count += 1;
        if (entry.used === true) bucket.used += 1;
        if (factor !== null) bucket.factors.push(factor);
        if (isNum(entry.from)) bucket.froms.push(entry.from);
        if (isNum(entry.to)) bucket.tos.push(entry.to);
      }
    }
    if (isNum(record.pinned_chars)) {
      withPinned += 1;
      pinnedChars.push(record.pinned_chars);
      if (isNum(record.pinned_count)) pinnedCounts.push(record.pinned_count);
      if (record.pinned_truncated === true) pinnedTruncated += 1;
      if (isNum(record.retrieval_chars)) retrievalChars.push(record.retrieval_chars);
      if (isNum(record.body_chars)) bodyChars.push(record.body_chars);
    }
    if (isNum(record.decayed)) {
      withDecay += 1;
      decayedCounts.push(record.decayed);
      if (isNum(record.decay_skipped)) decaySkipped.push(record.decay_skipped);
      if (isNum(record.decay_min)) decayMins.push(record.decay_min);
      if (isNum(record.decay_max)) decayMaxs.push(record.decay_max);
      if (isNum(record.state_size)) stateSizes.push(record.state_size);
    }
    if (record.dropped && typeof record.dropped === "object") {
      withDropped += 1;
      for (const key of Object.keys(droppedTotals)) {
        if (isNum(record.dropped[key])) droppedTotals[key] += record.dropped[key];
      }
    }
    if (record.tier_counts && typeof record.tier_counts === "object") {
      withTier += 1;
      const quotas = record.tier_quotas && typeof record.tier_quotas === "object" ? record.tier_quotas : {};
      for (const layer of ["hot", "warm", "cold"]) {
        const seen = record.tier_counts[layer];
        if (isNum(seen)) tierSeen[layer] += seen;
        const used = isNum(quotas[layer]?.used) ? quotas[layer].used : 0;
        tierChosen[layer] += used;
        // Pressure, not fullness: a cap only counts when it withheld a candidate.
        if (isNum(seen) && seen > used) tierPressure[layer] += 1;
      }
      if (isNum(quotas.backfilled)) tierBackfilled += quotas.backfilled;
      if (isNum(quotas.dropped)) tierDropped += quotas.dropped;
      const released = record.cold_released && typeof record.cold_released === "object" ? record.cold_released : {};
      for (const key of Object.keys(releasedTotals)) {
        if (isNum(released[key])) releasedTotals[key] += released[key];
      }
      for (const reason of Array.isArray(released.reasons) ? released.reasons : []) {
        const key = String(reason);
        releaseRounds.set(key, (releaseRounds.get(key) ?? 0) + 1);
      }
    }
  }

  const chars = injected.map((record) => record.chars).filter(isNum);
  const hits = injected.map((record) => record.hits).filter(isNum);
  const ms = retrieval.map((record) => record.ms).filter(isNum);
  const kbs = [...kbTotals.values()].sort((a, b) => b.rounds - a.rounds);

  return {
    days: options.days,
    file: options.file,
    total: records.length,
    undated,
    window: { from: new Date(since).toISOString(), to: new Date(now).toISOString(), count: inWindow.length },
    outcomes,
    reasons,
    injected: injected.length,
    noInject,
    emptyRatio: injected.length + noInject > 0 ? noInject / (injected.length + noInject) : null,
    chars: { avg: mean(chars), max: chars.length ? Math.max(...chars) : 0, count: chars.length },
    hits: { avg: mean(hits), count: hits.length },
    ms: { avg: mean(ms), max: ms.length ? Math.max(...ms) : 0, count: ms.length },
    dropped: droppedTotals,
    kbs: kbs.map((bucket) => ({
      label: bucket.label,
      rounds: bucket.rounds,
      withHits: bucket.withHits,
      avgTop: mean(bucket.tops),
      avgHits: bucket.rounds ? bucket.hits / bucket.rounds : 0,
    })),
    weights: {
      records: withWeights,
      entries: weightEntries.length,
      used: weightEntries.filter((entry) => entry.used).length,
      reported: weightedTotal,
      avgFactor: mean(weightEntries.map((entry) => entry.factor).filter(isNum)),
      rules: [...weightRules.values()]
        .map((bucket) => ({
          reason: bucket.reason,
          count: bucket.count,
          used: bucket.used,
          avgFactor: mean(bucket.factors),
          avgFrom: mean(bucket.froms),
          avgTo: mean(bucket.tos),
        }))
        .sort((a, b) => b.count - a.count),
    },
    pinned: {
      records: withPinned,
      avgChars: mean(pinnedChars),
      maxChars: pinnedChars.length ? Math.max(...pinnedChars) : 0,
      avgCount: mean(pinnedCounts),
      truncated: pinnedTruncated,
      avgRetrievalChars: mean(retrievalChars),
      avgBodyChars: mean(bodyChars),
    },
    decay: {
      records: withDecay,
      rounds: decayedCounts.reduce((sum, value) => sum + value, 0),
      skipped: decaySkipped.reduce((sum, value) => sum + value, 0),
      min: decayMins.length ? Math.min(...decayMins) : null,
      max: decayMaxs.length ? Math.max(...decayMaxs) : null,
      state: stateSizes.length ? stateSizes[stateSizes.length - 1] : null,
    },
    tier: {
      records: withTier,
      seen: tierSeen,
      chosen: tierChosen,
      pressure: tierPressure,
      released: releasedTotals,
      reasons: [...releaseRounds.entries()].map(([reason, rounds]) => ({ reason, rounds })).sort((a, b) => b.rounds - a.rounds),
      backfilled: tierBackfilled,
      dropped: tierDropped,
      state: null,
    },
    measured: { withKb, withDropped, retrieval: retrieval.length },
  };
}

/**
 * Where the chunks in the state file sit right now, by the deployed thresholds. This
 * is the number the thresholds will be re-tuned from: "how much material would
 * coldTopK 0 withhold today". Read-only -- the same lazy tierOf the injector uses.
 */
function tierDistribution(config) {
  const counts = { total: 0, hot: 0, warm: 0, cold: 0 };
  let state;
  try {
    state = readState(config?.decay?.statePath);
  } catch {
    return counts;
  }
  const now = Date.now();
  for (const entry of Object.values(state?.chunks ?? {})) {
    counts[tierOf(entry, now, config?.tier)] += 1;
    counts.total += 1;
  }
  return counts;
}

function printReport(summary) {
  const lines = [];
  const total = summary.window.count;
  lines.push("WeKnora 注入反馈 · 最近 " + summary.days + " 天");
  lines.push("日志 " + summary.file);
  lines.push("窗口 " + summary.window.from + " → " + summary.window.to);
  lines.push("记录 " + summary.total + " 行，窗口内 " + total + " 条" + (summary.undated ? "（无时间戳 " + summary.undated + " 条已忽略）" : ""));
  lines.push("");
  lines.push("轮次结果");
  for (const [outcome, count] of Object.entries(summary.outcomes).sort((a, b) => b[1] - a[1])) {
    lines.push("  " + pad(outcome, 14) + String(count).padStart(6) + "  " + pct(count, total).padStart(7));
    const detail = Object.entries(summary.reasons)
      .filter(([key]) => key.endsWith("|" + outcome))
      .map(([key, value]) => [key.split("|")[0], value])
      .sort((a, b) => b[1] - a[1]);
    for (const [reason, value] of detail) {
      lines.push("      " + pad(reason, 26) + String(value).padStart(4));
    }
  }
  lines.push("");
  lines.push("注入质量（injected " + summary.injected + " 轮）");
  lines.push("  平均检索字符 " + summary.chars.avg.toFixed(1) + "  最大 " + summary.chars.max + "（检索上限 " + summary.caps.maxChars + "，不含钉层）");
  lines.push("  平均命中数   " + summary.hits.avg.toFixed(2) + " 条 / 轮");
  lines.push("  平均检索耗时 " + summary.ms.avg.toFixed(0) + " ms  最大 " + summary.ms.max + " ms（" + summary.ms.count + " 轮实测，上限 " + summary.caps.timeoutMs + " ms）");
  lines.push("  空注入比例   " + (summary.emptyRatio === null ? "-" : (summary.emptyRatio * 100).toFixed(1) + "%") + "（no_inject " + summary.noInject + " / 检索完成 " + (summary.injected + summary.noInject) + "）");
  lines.push("  过滤丢弃     minScore " + summary.dropped.score + " · minScoreRatio " + summary.dropped.ratio + " · 内容过短 " + summary.dropped.short + " · 超 maxHits " + summary.dropped.budget);
  lines.push("");
  lines.push("各库（平均最高分 / 有命中率）");
  if (!summary.kbs.length) lines.push("  （窗口内没有带库级度量的记录）");
  for (const kb of summary.kbs) {
    lines.push("  " + pad(kb.label, 12) + "最高分 " + kb.avgTop.toFixed(4) + "   命中 " + kb.withHits + "/" + kb.rounds + " 轮（" + pct(kb.withHits, kb.rounds) + "）   平均 " + kb.avgHits.toFixed(1) + " 条");
  }
  const weights = summary.weights;
  lines.push("");
  lines.push("来源降权（sourceWeights · appliedWeight）");
  if (!weights.records) {
    lines.push("  （窗口内没有带 appliedWeight 的记录）");
  } else {
    lines.push("  记录 " + weights.records + " 轮带权重明细，命中 " + weights.entries + " 条被降权（注入 " + weights.used + " 条）");
    lines.push("  平均 factor " + weights.avgFactor.toFixed(3));
    for (const rule of weights.rules) {
      lines.push("  " + pad(rule.reason, 14) + "命中 " + String(rule.count).padStart(3) + " 条  注入 " + String(rule.used).padStart(3) + " 条  factor " + rule.avgFactor.toFixed(2) + "  分数 " + rule.avgFrom.toFixed(4) + " → " + rule.avgTo.toFixed(4));
    }
  }
  const pinned = summary.pinned;
  lines.push("");
  lines.push("钉层（pinned · 每轮固定注入，不参与打分、不占检索预算）");
  if (!pinned.records) {
    lines.push("  （窗口内没有带钉层度量的记录）");
  } else {
    lines.push("  记录 " + pinned.records + " 轮   平均 " + pinned.avgChars.toFixed(0) + " 字符（上限 " + summary.caps.pinnedMaxChars + "）   最大 " + pinned.maxChars + "   平均 " + pinned.avgCount.toFixed(1) + " 条" + (pinned.truncated ? "   被截断 " + pinned.truncated + " 轮" : ""));
    lines.push("  正文平均构成   钉层 " + pinned.avgChars.toFixed(0) + " + 检索 " + pinned.avgRetrievalChars.toFixed(0) + " = " + pinned.avgBodyChars.toFixed(0) + " 字符");
  }
  const decay = summary.decay;
  lines.push("");
  lines.push("时间衰减（decay · 加在 RRF 之后、注入之前）");
  if (!decay.records) {
    lines.push("  （窗口内没有带衰减度量的记录）");
  } else {
    lines.push("  记录 " + decay.records + " 轮   累计衰减 " + decay.rounds + " 条   跳过 " + decay.skipped + " 条（只乘 sourceWeights）");
    lines.push("  权重区间 " + (decay.min === null ? "-" : decay.min.toFixed(3)) + " – " + (decay.max === null ? "-" : decay.max.toFixed(3)) + "   状态文件 " + (decay.state === null ? "-" : decay.state) + " 条");
  }
  const tier = summary.tier;
  lines.push("");
  lines.push("分层（tier · 惰性判定，不落库、不跑计划任务）");
  if (!tier.records) {
    lines.push("  （窗口内没有带分层度量的记录）");
  } else {
    lines.push("  阈值 hot < " + summary.caps.tier.hotDays + " 天 · warm < " + summary.caps.tier.warmDays + " 天 · 配额 hot " + summary.caps.tier.hotTopK + " / warm " + summary.caps.tier.warmTopK + " / cold " + summary.caps.tier.coldTopK + "（cold 需 hits=0）");
    lines.push("  记录 " + tier.records + " 轮   被检索 hot " + tier.seen.hot + " · warm " + tier.seen.warm + " · cold " + tier.seen.cold + " 条");
    lines.push("  被入选 hot " + tier.chosen.hot + " · warm " + tier.chosen.warm + " · cold " + tier.chosen.cold + " 条   配额回填 " + tier.backfilled + " 条   被层拦下 " + tier.dropped + " 条");
    const how = tier.reasons.length ? tier.reasons.map((entry) => entry.reason + " " + entry.rounds + " 轮").join(" · ") : "-";
    lines.push("  冷层解冻 " + tier.released.count + " 条（标题 " + tier.released.title + " · 时间 " + tier.released.time + " · includeAll " + tier.released.all + "）   触发 " + how);
    lines.push("  配额吃紧 hot " + tier.pressure.hot + " 轮 · warm " + tier.pressure.warm + " 轮 · cold " + tier.pressure.cold + " 轮");
  }
  if (tier.state && tier.state.total) {
    lines.push("  状态文件 " + tier.state.total + " 条   现在 hot " + tier.state.hot + " · warm " + tier.state.warm + " · cold " + tier.state.cold);
  }
  const missing = summary.measured.retrieval - summary.measured.withKb;
  if (missing > 0) {
    lines.push("");
    lines.push("注：" + missing + " 条检索记录没有 kb 字段（度量字段上线前写入），未计入库级统计。");
  }
  return lines.join("\n");
}

const options = parseArgs(process.argv.slice(2));
let read;
try {
  read = readRecords(options.file);
} catch (error) {
  console.error("读不到日志 " + options.file + "：" + (error?.message ?? error));
  process.exit(1);
}
// Read-only: the ceilings printed below are the deployed ones, taken from
// defaults + wk-inject.config.json (loadConfig only reads; it writes nothing).
const config = loadConfig({});
const summary = summarize(read.records, options);
summary.badLines = read.bad;
summary.caps = { maxChars: Math.min(config.maxChars, CHARS_CAP), timeoutMs: config.timeoutMs, pinnedMaxChars: config.pinnedMaxChars };
summary.caps.tier = { hotDays: config.tier.hotDays, warmDays: config.tier.warmDays, hotTopK: config.tier.hotTopK, warmTopK: config.tier.warmTopK, coldTopK: config.tier.coldTopK };
summary.tier.state = tierDistribution(config);
if (options.json) console.log(JSON.stringify(summary, null, 2));
else console.log(printReport(summary));
