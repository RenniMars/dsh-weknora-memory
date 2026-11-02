import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CHARS_CAP, TIMEOUT_CAP_MS, loadConfig } from "../lib/config.js";
import { DAY_MS, applyDecay, decayFactor, readState, stateSize, writeHits, writeState } from "../lib/decay.js";
import { PINNED_TAG, PROFILE_TAG_MAX, applyFactCards, buildInjection, buildPinned, cleanText, composeInjection, conflictLines, parseFactCard, profileLine, selectHits, selectProfileCards, selectProfileCardsDetailed } from "../lib/format.js";
import { mergeKbGroups, searchWeKnora } from "../lib/retrieve.js";
import { CONTEXT_QUERY_CHARS, PROFILE_DEGRADE_AFTER, SOURCE_KIND, createWeKnoraInjector, promptFromMessages, recordProfileRounds } from "../lib/injector.js";
import { DEGRADE_AFTER, propose, review, run as runWriter } from "../../../_wk_dream/profile-writer.mjs";
import { PANEL_API_PREFIX, addCard, aggregateRetrieval, panelRoutes, removeCard, updateCard } from "../lib/panel.js";
import { DEFAULT_TIER, applyTierQuota, parseTimeWindow, tierOf } from "../lib/tier.js";

const TEST_LOG = join(tmpdir(), "wk-inject-unit.log");
const TEST_STATE = join(tmpdir(), "wk-inject-unit-state-" + process.pid + ".json");

/**
 * Unit-test config: the real wk-inject.config.json (so the shipped budget, labels and
 * library split are exercised as deployed) with the pinned layer switched off, because
 * most tests here are about retrieval and must not see a standing-rule block. A test
 * that is about pinned rules passes its own list.
 */
function configOf(overrides = {}) {
  // The decay state file is pointed at the temp dir: the tests must never file hits
  // into the plugin's own data/, or the next run would start with a real age. The profile
  // layer is switched off for the same reason as the pinned rules: the shipped file is
  // data that changes with every nightly run, and the byte-identity tests are about the
  // renderer, not about which cards happen to be active today.
  return loadConfig({ logFile: TEST_LOG, pinned: [], profile: { enabled: false }, decay: { statePath: TEST_STATE }, ...overrides });
}

/** The standing rules as they ship in wk-inject.config.json (no override). */
function shippedPinned() {
  return loadConfig({ logFile: TEST_LOG }).pinned;
}

function agentOf(id = "unit-session", origin = "main") {
  return { session: { header: { id, origin, cwd: "D:/work" } } };
}

function decisionOf(text, extraMessages = []) {
  return {
    kind: "enter",
    messages: [
      ...extraMessages,
      { id: "u-" + text.length, role: "user", content: [{ type: "text", text }], source: { kind: "user" } },
    ],
  };
}

const nextOf = (decision) => async () => decision;

/** Parse one rendered block into its attributes and its hit entries. */
function parseBlock(text) {
  const open = /^<weknora_context ([^>]*)>/.exec(text);
  const attrs = {};
  if (open) for (const match of open[1].matchAll(/([a-z_]+)="([^"]*)"/g)) attrs[match[1]] = match[2];
  const entries = [];
  let current = null;
  for (const line of text.split("\n").slice(1)) {
    const head = /^\[(\d+)\] (.*) · score (\d+\.\d+)$/.exec(line);
    if (head) {
      current = { index: Number(head[1]), label: head[2].split(" · ").pop(), score: Number(head[3]), body: [] };
      entries.push(current);
      continue;
    }
    if (current) current.body.push(line);
  }
  for (const entry of entries) entry.body = entry.body.join("\n").replace("</weknora_context>", "").trim();
  return { attrs, entries };
}

const PREAMBLE_HEAD = "以下片段由系统在本次请求前自动从本机 WeKnora 知识库检索得到";

/**
 * What a block must satisfy whatever the live service returns: one entry per counted
 * hit, sequential numbering, a retrieved body under every entry, and each library's
 * raw scores in non-increasing order. Nothing here pins a chunk's text or its id, so
 * re-ranking, re-chunking or a neighbour that arrives only on the second attempt
 * cannot turn the live test red.
 */
function assertBlockInvariants(text) {
  assert.ok(text.startsWith("<weknora_context "), "missing opening delimiter");
  assert.ok(text.endsWith("</weknora_context>"), "missing closing delimiter");
  const { attrs, entries } = parseBlock(text);
  assert.ok(entries.length >= 1, "expected at least one rendered hit");
  assert.equal(Number(attrs.count), entries.length, "count must match the rendered hits");
  entries.forEach((entry, position) => {
    assert.equal(entry.index, position + 1, "hit numbering must be sequential");
    assert.ok(entry.body.length >= 30, "hit " + entry.index + " carries no retrieved body: " + entry.body.length);
    assert.ok(!entry.body.includes(PREAMBLE_HEAD), "hit body must be retrieved content, not the template");
    assert.ok(!entry.body.includes("(untitled)"), "hit " + entry.index + " has no title");
  });
  const byLabel = new Map();
  for (const entry of entries) byLabel.set(entry.label, [...(byLabel.get(entry.label) ?? []), entry.score]);
  for (const [label, scores] of byLabel) {
    for (let position = 1; position < scores.length; position += 1) {
      assert.ok(scores[position] <= scores[position - 1], "scores of " + label + " must not rise: " + scores.join(","));
    }
  }
  return { attrs, entries };
}

// Composite scores live in 0.10..0.70 (0.6*rerank + 0.3*base + 0.1), so synthetic
// hits use that band; minScore 0.1 is the structural floor of the same formula.
function syntheticHits(count, contentChars = 900) {
  const body = "WeKnora 的检索接口位于 /api/v1/knowledge-search，需要 X-API-Key 请求头。".repeat(40).slice(0, contentChars);
  return Array.from({ length: count }, (_, index) => ({
    id: "chunk-" + index,
    knowledge_id: "kb-doc-" + index,
    chunk_index: index,
    knowledge_title: "合成标题 " + (index + 1),
    content: body,
    score: 0.52 - index * 0.05,
  }));
}

test("buildInjection caps the block at CHARS_CAP and keeps title + snippet", () => {
  const config = configOf();
  const hits = syntheticHits(4);
  const { text, used } = buildInjection(hits, config);
  assert.ok(text.length > 0, "expected an injection block");
  assert.ok(text.length <= CHARS_CAP, "block exceeds hard cap: " + text.length);
  assert.ok(text.startsWith("<weknora_context "), "missing opening delimiter");
  assert.ok(text.endsWith("</weknora_context>"), "missing closing delimiter");
  assert.ok(text.includes(hits[0].knowledge_title), "missing hit title");
  assert.ok(text.includes(cleanText(hits[0].content).slice(0, 40)), "missing hit snippet");
  assert.ok(used.length >= 1 && used.length <= config.maxHits, "hit count must respect maxHits: " + used.length);
  assert.ok(!text.includes(hits[3].knowledge_title), "a hit that ran out of budget must not appear");
});

test("hits below minScore are never injected", () => {
  const config = configOf();
  const hits = syntheticHits(3).map((hit) => ({ ...hit, score: 0.002 }));
  const { text, used } = buildInjection(hits, config);
  assert.equal(text, "");
  assert.equal(used.length, 0);
});

test("only the leading score cluster survives minScoreRatio", () => {
  const config = configOf();
  const hits = [
    { id: "a", knowledge_title: "top", content: "A".repeat(200), score: 0.42 },
    { id: "b", knowledge_title: "tail", content: "B".repeat(200), score: 0.18 },
  ];
  const chosen = selectHits(hits, config);
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].id, "a");
});

test("promptFromMessages takes the newest user text and ignores plugin messages", () => {
  const decision = decisionOf("第二个问题", [
    { id: "p1", role: "user", content: [{ type: "text", text: "注入块" }], source: { kind: SOURCE_KIND } },
  ]);
  assert.equal(promptFromMessages(decision.messages), "第二个问题");
});

test("config clamps timeout and length to the hard caps", () => {
  const config = configOf({ timeoutMs: 99999, maxChars: 99999, maxHits: 99, topK: 999, neighborChunks: 9, rrfK: 0 });
  assert.equal(config.timeoutMs, TIMEOUT_CAP_MS);
  assert.equal(config.maxChars, CHARS_CAP);
  assert.equal(CHARS_CAP, 2400, "the default budget is 2400 chars for 3 hits");
  assert.equal(config.maxHits, 5, "maxHits still clamps at 5");
  assert.equal(config.topK, 50, "topK clamps at 50");
  assert.equal(config.neighborChunks, 2, "neighbour count clamps at 2");
  assert.equal(config.rrfK, 1, "rrfK floors at 1");
  assert.equal(configOf().perKbHits, 2, "perKbHits default is 2");
  assert.equal(configOf().minScore, 0.1, "minScore default matches the composite floor");
});

// The one live test. It asserts invariants, never the text of a particular chunk:
// two retrievals of the same query do not return byte-identical blocks (ranking and
// neighbour expansion are both live), so a strictEquality between two of them is a
// test of the service's mood, not of this plugin.
test("live: one real retrieval renders one bounded, ordered block", async (t) => {
  const config = configOf();
  const records = [];
  const injector = createWeKnoraInjector({ config, log: (record) => records.push(record) });
  const decision = decisionOf("WeKnora 的 knowledge-search 接口怎么调用，需要什么请求头？");
  const enhanced = await injector.preStep({ agent: agentOf("live-session"), signal: undefined }, nextOf(decision));
  const record = records[0] ?? {};
  // An unreachable or empty service is a skip, never a failure.
  if (record.outcome !== "injected") {
    t.skip("live retrieval gave " + String(record.outcome) + "/" + String(record.reason ?? "-") + " -- live assertions skipped");
    return;
  }
  assert.equal(enhanced.messages.length, 2, "expected exactly one appended message");
  const injected = enhanced.messages[1];
  assert.equal(injected.source.kind, SOURCE_KIND);
  assert.equal(injected.role, "user");
  const text = injected.content[0].text;
  assert.ok(text.length <= CHARS_CAP, "live block exceeds cap: " + text.length);
  assert.equal(record.chars, text.length, "the log must measure the block that was injected");
  const { entries } = assertBlockInvariants(text);
  assert.equal(record.hits, entries.length, "the logged hit count must match the rendered hits");
  console.log("live block chars=" + text.length + " hits=" + entries.length + " labels=" + [...new Set(entries.map((entry) => entry.label))].join("/"));
});

test("unreachable WeKnora degrades silently, well under 1500ms", async () => {
  const config = configOf({ apiUrl: "http://127.0.0.1:59999/api/v1" });
  const records = [];
  const injector = createWeKnoraInjector({ config, log: (record) => records.push(record) });
  const decision = decisionOf("WeKnora 检索接口怎么用？超时降级测试");
  const startedAt = Date.now();
  const enhanced = await injector.preStep({ agent: agentOf("dead-session"), signal: undefined }, nextOf(decision));
  const elapsed = Date.now() - startedAt;
  assert.equal(enhanced, decision, "decision must come back untouched");
  assert.equal(enhanced.messages.length, 1);
  assert.ok(elapsed < 1500, "degradation took " + elapsed + "ms");
  assert.equal(records[0].outcome, "degraded");
  assert.equal(records[0].reason, "transport");
  console.log("degrade elapsed=" + elapsed + "ms reason=" + records[0].reason);
});

test("a hanging backend is cut off by the 1500ms ceiling", async () => {
  const config = configOf({ timeoutMs: 1500 });
  const hangingFetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const records = [];
  const injector = createWeKnoraInjector({
    config,
    log: (record) => records.push(record),
    retrieve: (query, cfg, deps) => searchWeKnora(query, cfg, { ...deps, fetchImpl: hangingFetch }),
  });
  const decision = decisionOf("挂起后端必须被 1500ms 上限切断");
  const startedAt = Date.now();
  const enhanced = await injector.preStep({ agent: agentOf("hang-session"), signal: undefined }, nextOf(decision));
  const elapsed = Date.now() - startedAt;
  assert.equal(enhanced, decision);
  assert.ok(elapsed < 1700, "timeout ceiling not applied: " + elapsed + "ms");
  assert.equal(records[0].outcome, "degraded");
  console.log("hang elapsed=" + elapsed + "ms reason=" + records[0].reason);
});

test("the same chunk is not injected twice in one session", async () => {
  const config = configOf();
  const hits = syntheticHits(2);
  const records = [];
  const injector = createWeKnoraInjector({
    config,
    log: (record) => records.push(record),
    retrieve: async () => ({ ok: true, hits }),
  });
  const first = await injector.preStep({ agent: agentOf("dup-session"), signal: undefined }, nextOf(decisionOf("第一轮提问，检索同样的片段")));
  assert.equal(first.messages.length, 2);
  const second = await injector.preStep({ agent: agentOf("dup-session"), signal: undefined }, nextOf(decisionOf("第二轮提问，检索同样的片段")));
  assert.equal(second.messages.length, 1, "already-injected hits must not repeat");
  assert.deepEqual(records.map((record) => record.outcome), ["injected", "no_inject"]);
  assert.equal(records[1].reason, "all_seen");
});

test("short prompts, subagent sessions and disabled config skip retrieval", async () => {
  const config = configOf();
  let calls = 0;
  const injector = createWeKnoraInjector({ config, retrieve: async () => { calls += 1; return { ok: true, hits: syntheticHits(1) }; } });
  const short = decisionOf("hi");
  assert.equal(await injector.preStep({ agent: agentOf("s1"), signal: undefined }, nextOf(short)), short);
  const sub = decisionOf("这是一个足够长的子代理提问文本");
  assert.equal(await injector.preStep({ agent: agentOf("s2", "subagent"), signal: undefined }, nextOf(sub)), sub);
  const offConfig = configOf({ enabled: false });
  const offInjector = createWeKnoraInjector({ config: offConfig, retrieve: async () => { calls += 1; return { ok: true, hits: syntheticHits(1) }; } });
  const off = decisionOf("关闭开关后不应该发起任何检索请求");
  assert.equal(await offInjector.preStep({ agent: agentOf("s3"), signal: undefined }, nextOf(off)), off);
  assert.equal(calls, 0, "no retrieval should have run");
});
// Wiring only: apply() builds its own config from the file, so fetch is stubbed here
// and the one live test above keeps the real-service coverage.
test("apply() wires a working pre-step listener into a cordis-like context", async () => {
  const plugin = await import("../lib/index.js");
  assert.equal(plugin.name, "weknora-inject");
  const listeners = new Map();
  const ctx = { on: (event, handler) => listeners.set(event, handler), logger: () => ({ info: () => {} }) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url) => Promise.resolve({
    ok: true,
    json: async () => (String(url).includes("/chunks/") ? { data: [] } : { data: syntheticHits(1) }),
  });
  try {
    // pinned is switched off here: this test is about the wiring, not the standing rules.
    // The decay state file is redirected too: apply() loads its own config, and a test
    // that files synthetic chunk ids into data/ would poison the next real run.
    plugin.apply(ctx, { logFile: TEST_LOG, pinned: [], profile: { enabled: false }, decay: { statePath: TEST_STATE } });
    assert.ok(listeners.has("agent/pre-step"), "apply must register agent/pre-step");
    const handler = listeners.get("agent/pre-step");
    const decision = decisionOf("WeKnora 的检索接口怎么调用，需要什么请求头？");
    const enhanced = await handler({ agent: agentOf("apply-session"), signal: undefined }, nextOf(decision));
    assert.equal(enhanced.messages.length, 2, "the wired listener must append one block");
    assert.equal(enhanced.messages[1].source.kind, SOURCE_KIND);
    const text = enhanced.messages[1].content[0].text;
    assert.ok(text.length <= CHARS_CAP);
    assert.equal(assertBlockInvariants(text).entries.length, 1);
    console.log("apply() block chars=" + text.length);
  } finally {
    globalThis.fetch = realFetch;
  }
});
test("a KB with no hits does not silence the other KB", async () => {
  const config = configOf({ apiUrl: "http://unit.test/api/v1", kbIds: ["kb-doc", "kb-mem"], kbNames: { "kb-doc": "文档", "kb-mem": "会话" } });
  const asked = [];
  const fetchImpl = (url, init) => {
    const kb = (JSON.parse(init.body).knowledge_base_ids || [])[0];
    asked.push(kb);
    const data = kb === "kb-doc" ? [] : [{
      id: "mem-1",
      knowledge_id: "doc-mem-1",
      chunk_index: 0,
      knowledge_title: "会话记录 昨天我们讨论了什么",
      content: "昨天我们讨论了 WeKnora 的分块参数、重排阈值与插件注入策略。".repeat(6),
      score: 0.231,
    }];
    return Promise.resolve({ ok: true, json: async () => ({ data }) });
  };
  const result = await searchWeKnora("昨天我们讨论了什么内容", config, { fetchImpl });
  assert.equal(result.ok, true);
  assert.deepEqual(asked.sort(), ["kb-doc", "kb-mem"], "every configured kb must be asked once");
  assert.equal(result.hits.length, 1, "only the answering kb contributes hits");
  assert.equal(result.hits[0].kb_label, "会话");
  const { text, used } = buildInjection(result.hits, config);
  assert.equal(used.length, 1);
  assert.ok(text.includes("会话记录 昨天我们讨论了什么"), "the answering kb must still be injected");
  assert.ok(text.includes(" · 会话 · "), "per-hit source label must name the kb");
  const records = [];
  const injector = createWeKnoraInjector({ config, log: (record) => records.push(record), retrieve: (query, cfg, deps) => searchWeKnora(query, cfg, { ...deps, fetchImpl }) });
  const enhanced = await injector.preStep({ agent: agentOf("kb-empty-session"), signal: undefined }, nextOf(decisionOf("昨天我们讨论了什么内容")));
  assert.equal(enhanced.messages.length, 2, "an empty kb must not block the injection");
  assert.equal(records[0].outcome, "injected");
});

test("both KBs keep a representative when their score scales differ", async () => {
  // This case is about the score scales, not about source weights: the 文档 fixture
  // documents are named hs-* only to look like records of that library, so the rule is
  // pinned out here and stays the subject of its own tests below.
  const config = configOf({ apiUrl: "http://unit.test/api/v1", kbIds: ["kb-doc", "kb-mem"], kbNames: { "kb-doc": "文档", "kb-mem": "会话" }, sourceWeights: [] });
  const docHits = [
    { id: "doc-1", knowledge_title: "hs-Hindsight 部署实战记录", content: "Hindsight 的 embedding 配置写错在 model 字段与维度不一致。".repeat(6), score: 0.6884 },
    { id: "doc-2", knowledge_title: "hs-委派机制约定变更", content: "委派任务的默认模型改为 agent 系列，与记忆库改名无关。".repeat(8), score: 0.3 },
  ];
  const memHits = [
    { id: "mem-1", knowledge_title: "会话记录 我们为什么改名", content: "我们把 hermes bank 改名成 agent，因为旧命名和 Hindsight 记忆库冲突。".repeat(4), score: 0.2362 },
  ];
  const fetchImpl = (url, init) => {
    const kb = (JSON.parse(init.body).knowledge_base_ids || [])[0];
    return Promise.resolve({ ok: true, json: async () => ({ data: kb === "kb-doc" ? docHits : memHits }) });
  };
  const result = await searchWeKnora("我们为什么把 hermes bank 改名成 agent？", config, { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.hits.length, 3, "both kb partial lists merge");
  const { text, used } = buildInjection(result.hits, config);
  assert.deepEqual([...new Set(used.map((hit) => hit.kb_label))].sort(), ["会话", "文档"], "each kb must land a representative");
  assert.ok(text.includes("hs-Hindsight 部署实战记录"));
  assert.ok(text.includes("会话记录 我们为什么改名"), "the weaker kb must survive the strong kb's scale");
  assert.ok(text.includes('kb_count="2"'), "the block must state that two libraries contributed");
  assert.equal(used[0].kb_label, "文档", "the document library keeps top-1 when its raw score is higher");
});

test("a partly failing kb fan-out still returns the surviving kb", async () => {
  const config = configOf({ apiUrl: "http://unit.test/api/v1", kbIds: ["kb-dead", "kb-live"], kbNames: { "kb-dead": "文档", "kb-live": "会话" } });
  const fetchImpl = (url, init) => {
    const kb = (JSON.parse(init.body).knowledge_base_ids || [])[0];
    if (kb === "kb-dead") return Promise.reject(Object.assign(new Error("boom"), { name: "AbortError" }));
    return Promise.resolve({ ok: true, json: async () => ({ data: [{ id: "live-1", knowledge_title: "会话记录 存活", content: "仍然可以注入的内容。".repeat(10), score: 0.2 }] }) });
  };
  const result = await searchWeKnora("某一个库挂掉时仍然要有结果", config, { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].rank_score, 0.2, "a single answering kb keeps its raw score space");
  assert.equal(result.hits[0].rank_kind, "score", "no fusion happened, so the rank stays a raw score");
  const allDead = await searchWeKnora("全部库都挂掉时必须降级", config, { fetchImpl: () => Promise.reject(Object.assign(new Error("boom"), { name: "AbortError" })) });
  assert.equal(allDead.ok, false);
  assert.equal(allDead.reason, "timeout");
});
test("a short follow-up is retrieved together with the previous turn's text", async () => {
  const config = configOf();
  const queries = [];
  const injector = createWeKnoraInjector({
    config,
    log: () => {},
    retrieve: async (query) => { queries.push(query); return { ok: true, hits: syntheticHits(1) }; },
  });
  const long = "WeKnora 的分块参数和重排阈值是怎么配置的？";
  await injector.preStep({ agent: agentOf("ctx-session"), signal: undefined }, nextOf(decisionOf(long)));
  const short = decisionOf("继续");
  await injector.preStep({ agent: agentOf("ctx-session"), signal: undefined }, nextOf(short));
  assert.equal(queries.length, 2, "both turns must retrieve");
  assert.equal(queries[0], long, "a long prompt is its own query");
  assert.ok(queries[1].includes("继续"), "the short prompt must stay in the merged query: " + queries[1]);
  assert.ok(queries[1].includes("分块参数"), "the merged query must carry the previous text: " + queries[1]);
  assert.ok(queries[1].length <= CONTEXT_QUERY_CHARS, "merged query exceeds the context ceiling: " + queries[1].length);
});

test("a short prompt without any previous text is skipped as short_prompt_no_context", async () => {
  const config = configOf();
  const records = [];
  let calls = 0;
  const injector = createWeKnoraInjector({
    config,
    log: (record) => records.push(record),
    retrieve: async () => { calls += 1; return { ok: true, hits: syntheticHits(1) }; },
  });
  const short = decisionOf("继续");
  const out = await injector.preStep({ agent: agentOf("ctx-empty"), signal: undefined }, nextOf(short));
  assert.equal(out, short, "decision must come back untouched");
  assert.equal(calls, 0, "no retrieval without a previous turn");
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "skip");
  assert.equal(records[0].reason, "short_prompt_no_context");
});

test("an injection record carries per-kb scores and filter drop counts", async () => {
  const config = configOf({ apiUrl: "http://unit.test/api/v1", kbIds: ["kb-mem"], kbNames: { "kb-mem": "记忆" }, maxHits: 2, perKbHits: 3 });
  const body = "记忆体系的库划分与写入机制说明。".repeat(12);
  const data = [
    { id: "m-1", knowledge_title: "记忆 一", content: body, score: 0.5 },
    { id: "m-2", knowledge_title: "记忆 二", content: body, score: 0.2 },
    { id: "m-3", knowledge_title: "记忆 三", content: body, score: 0.05 },
  ];
  const fetchImpl = () => Promise.resolve({ ok: true, json: async () => ({ data }) });
  const records = [];
  const injector = createWeKnoraInjector({
    config,
    log: (record) => records.push(record),
    retrieve: (query, cfg, deps) => searchWeKnora(query, cfg, { ...deps, fetchImpl }),
  });
  await injector.preStep({ agent: agentOf("metrics-session"), signal: undefined }, nextOf(decisionOf("记忆体系是怎么划分库的？")));
  const record = records[0];
  assert.equal(record.outcome, "injected");
  assert.ok(Array.isArray(record.kb) && record.kb.length === 1, "one kb entry per configured library");
  assert.equal(record.kb[0].label, "记忆");
  assert.equal(record.kb[0].hits, 3, "kb hit count is the raw fan-out count");
  assert.equal(record.kb[0].top, 0.5, "kb top score is the best raw score of that library");
  assert.equal(record.considered, 3, "considered counts the hits handed to the filters");
  assert.equal(record.dropped.score, 1, "0.05 is under minScore");
  assert.equal(record.dropped.ratio, 1, "0.2 is under minScoreRatio of the best hit");
  assert.ok(typeof record.ms === "number", "retrieval cost must be recorded");
  assert.ok(typeof record.chars === "number" && record.chars > 0);
});

// ---------------------------------------------------------------------------
// Cross-library fusion: position, not each library's own score scale
// ---------------------------------------------------------------------------

function twoKbFetch(groups) {
  const asked = [];
  const fetchImpl = (url, init) => {
    const kb = (JSON.parse(init.body).knowledge_base_ids || [])[0];
    asked.push(kb);
    return Promise.resolve({ ok: true, json: async () => ({ data: groups[kb] || [] }) });
  };
  return { fetchImpl, asked };
}

test("cross-library fusion ranks by position, so a weak library's top is no longer a fake 1.0", async () => {
  const config = configOf({ apiUrl: "http://unit.test/api/v1", kbIds: ["kb-doc", "kb-mem"], kbNames: { "kb-doc": "文档", "kb-mem": "会话" } });
  const body = "这一段的正文足够长，可以进入注入块。".repeat(20);
  const strong = [
    { id: "strong-1", knowledge_title: "强库第一", content: body, score: 0.7 },
    { id: "strong-2", knowledge_title: "强库第二", content: body, score: 0.5 },
  ];
  const weak = [
    { id: "weak-1", knowledge_title: "弱库第一", content: body, score: 0.2 },
    { id: "weak-2", knowledge_title: "弱库第二", content: body, score: 0.19 },
  ];
  const { fetchImpl } = twoKbFetch({ "kb-doc": strong, "kb-mem": weak });
  const result = await searchWeKnora("强库与弱库的命中应该按名次融合", config, { fetchImpl });
  assert.equal(result.ok, true);
  const order = result.hits.map((hit) => hit.id);
  // Old rule: weak-2 normalised to 0.95 and jumped over strong-2 (0.714). Now both are
  // rank 2 -> equal RRF, and the tie is settled by the raw score, so strength wins.
  assert.deepEqual(order, ["strong-1", "weak-1", "strong-2", "weak-2"], "unexpected fused order: " + order.join(","));
  const byId = new Map(result.hits.map((hit) => [hit.id, hit]));
  assert.equal(byId.get("strong-1").rank_kind, "rrf", "two answering libraries must fuse");
  assert.equal(byId.get("strong-1").rank_score, byId.get("weak-1").rank_score, "both library tops share one RRF score");
  assert.equal(byId.get("strong-2").rank_score, byId.get("weak-2").rank_score, "both second places share one RRF score");
  assert.ok(byId.get("strong-1").rank_score > byId.get("weak-2").rank_score, "rank 1 must beat rank 2 across libraries");
  assert.equal(byId.get("weak-1").rank_score, 1 / 61, "rrfK 60: rank 1 scores 1/61");
  assert.equal(byId.get("weak-2").rank_score, 1 / 62, "rrfK 60: rank 2 scores 1/62");
  const { used } = buildInjection(result.hits, config);
  assert.deepEqual(used.map((hit) => hit.id), ["strong-1", "weak-1", "strong-2"], "the rendered order follows the fused order");
});

test("rrfK is configurable and shapes the gap between ranks", async () => {
  const config = configOf({ apiUrl: "http://unit.test/api/v1", kbIds: ["kb-doc", "kb-mem"], rrfK: 10 });
  const body = "正文足够长以至于可以注入。".repeat(20);
  const { fetchImpl } = twoKbFetch({
    "kb-doc": [{ id: "d1", knowledge_title: "文档一", content: body, score: 0.6 }],
    "kb-mem": [{ id: "m1", knowledge_title: "会话一", content: body, score: 0.2 }],
  });
  const result = await searchWeKnora("rrfK 必须来自配置", config, { fetchImpl });
  assert.equal(result.hits[0].rank_score, 1 / 11, "rrfK 10 must produce 1/11");
  assert.equal(result.hits[1].rank_score, 1 / 11, "the other library top is identical by construction");
});

// ---------------------------------------------------------------------------
// Neighbour expansion through GET /chunks/{knowledge_id}
//
// Every case below uses its own knowledge_id: the page index is cached per document
// for the process lifetime, so sharing an id between fixtures would leak one case's
// rows into the next one.
// ---------------------------------------------------------------------------

/** One GET /chunks answer: rows plus the total / page_size the plugin reads back. */
function chunkPage(rows, total = rows.length, pageSize = 100) {
  return { ok: true, json: async () => ({ data: rows, page_size: pageSize, page: 1, total, success: true }) };
}

/** A document served page by page, with contiguous chunk_index values from base. */
function pagedDocument({ base = 0, total, pageSize = 100 }) {
  return (url) => {
    const page = Number(/page=(\d+)/.exec(url)?.[1] ?? 1);
    const from = (page - 1) * pageSize;
    const rows = [];
    for (let offset = from; offset < Math.min(total, from + pageSize); offset += 1) {
      const at = base + offset;
      rows.push({
        id: "p-" + at,
        chunk_index: at,
        content: "第 " + at + " 块的正文：" + "这一段用于验证按 chunk_index 定位邻块。".repeat(3),
        pre_chunk_id: offset > 0 ? "p-" + (at - 1) : "",
        next_chunk_id: offset < total - 1 ? "p-" + (at + 1) : "",
      });
    }
    return chunkPage(rows, total, pageSize);
  };
}

function neighbourFetch({ searchHits, onChunks }) {
  const calls = [];
  const fetchImpl = (url) => {
    calls.push(url);
    if (url.includes("/knowledge-search")) return Promise.resolve({ ok: true, json: async () => ({ data: searchHits }) });
    if (url.includes("/chunks/")) return Promise.resolve(onChunks(url));
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  };
  const chunkCalls = () => calls.filter((url) => url.includes("/chunks/"));
  return { fetchImpl, calls, chunkCalls };
}

const HIT_TEXT = "命中块的正文：知识库检索与重排的配置说明，这一段是命中的核心内容。";

function neighbourFixture() {
  return [
    { id: "c-0", chunk_index: 0, content: "前置块的正文：上一段解释了检索接口的鉴权方式与请求头要求。", pre_chunk_id: "", next_chunk_id: "c-1" },
    { id: "c-1", chunk_index: 1, content: HIT_TEXT, pre_chunk_id: "c-0", next_chunk_id: "c-2" },
    { id: "c-2", chunk_index: 2, content: "后置块的正文：注入预算与字符上限是怎么定的，这一段接着往下讲。", pre_chunk_id: "c-1", next_chunk_id: "" },
  ];
}

function neighbourHit(knowledgeId) {
  return { id: "c-1", knowledge_id: knowledgeId, knowledge_title: "检索配置说明", chunk_index: 1, content: HIT_TEXT, score: 0.52 };
}

test("a hit is widened with its adjacent chunks before injection", async () => {
  const config = configOf({ apiUrl: "http://unit.test/api/v1", kbIds: ["kb-doc"] });
  const { fetchImpl, chunkCalls } = neighbourFetch({ searchHits: [neighbourHit("know-wide")], onChunks: () => chunkPage(neighbourFixture()) });
  const result = await searchWeKnora("检索的配置与重排是怎么定的", config, { fetchImpl });
  assert.equal(result.ok, true);
  const hit = result.hits[0];
  assert.deepEqual(hit.neighbors, { before: 1, after: 1 }, "one neighbour on each side must be merged");
  assert.ok(hit.content.includes("前置块的正文"), "the previous chunk must be prepended");
  assert.ok(hit.content.includes("命中块的正文"), "the hit itself must stay in the middle");
  assert.ok(hit.content.includes("后置块的正文"), "the next chunk must be appended");
  assert.ok(hit.content.indexOf("前置块") < hit.content.indexOf("命中块"), "neighbour order must follow the document");
  assert.ok(hit.content.indexOf("命中块") < hit.content.indexOf("后置块"), "neighbour order must follow the document");
  assert.equal(result.stats.neighbors.expanded, 1);
  assert.equal(chunkCalls().length, 1, "one page covers the hit and both neighbours");
  const { text } = buildInjection(result.hits, config);
  assert.ok(text.includes("前置块的正文"), "the expanded context must reach the injected block");
  assert.ok(text.includes("后置块的正文"), "the expanded context must reach the injected block");
  assert.ok(chunkCalls()[0].includes("/chunks/know-wide"), "neighbours come from the chunks endpoint");
});

// The live failure this replaces: two of three hits reported a chunk_index one past the
// document's last listed chunk, so the hit's own row is absent while its neighbour is
// present. Locating neighbours by chunk_index keeps the expansion working instead of
// counting the hit as failed.
test("a hit whose own row is missing is still widened by the neighbour that exists", async () => {
  const config = configOf({ apiUrl: "http://unit.test/api/v1", kbIds: ["kb-doc"] });
  const stale = { ...neighbourHit("know-stale"), id: "row-from-search-index", chunk_index: 3, content: "命中块的正文：这一行只在检索索引里存在。" };
  const { fetchImpl, chunkCalls } = neighbourFetch({ searchHits: [stale], onChunks: () => chunkPage(neighbourFixture()) });
  const result = await searchWeKnora("命中块不在 chunks 列表里时仍要扩邻块", config, { fetchImpl });
  const hit = result.hits[0];
  assert.deepEqual(hit.neighbors, { before: 1, after: 0 }, "the listed previous chunk must still be merged");
  assert.ok(hit.content.includes("后置块的正文"), "chunk_index 2 is the row before the missing index 3");
  assert.ok(hit.content.includes("这一行只在检索索引里存在"), "the hit's own text must stay as retrieved");
  assert.equal(result.stats.neighbors.expanded, 1);
  assert.equal(result.stats.neighbors.failed, 0);
  assert.equal(chunkCalls().length, 1, "an index past the total must not cost a second request");
});

test("a chunk past the first page is found on its own page", async () => {
  const config = configOf({ apiUrl: "http://unit.test/api/v1", kbIds: ["kb-doc"] });
  const { fetchImpl, chunkCalls } = neighbourFetch({
    searchHits: [{ ...neighbourHit("know-page2"), id: "p-150", chunk_index: 150, content: "第 150 块的正文。" }],
    onChunks: pagedDocument({ total: 300 }),
  });
  const result = await searchWeKnora("跨页的命中块必须能取到邻块", config, { fetchImpl });
  assert.deepEqual(result.hits[0].neighbors, { before: 1, after: 1 }, "both neighbours sit on page 2");
  const pages = chunkCalls().map((url) => Number(/page=(\d+)/.exec(url)[1]));
  assert.deepEqual(pages, [1, 2], "page 1 teaches total/page_size, page 2 holds chunk_index 150: " + pages.join(","));
});

test("chunk_index values that do not start at zero are located by binary search", async () => {
  const config = configOf({ apiUrl: "http://unit.test/api/v1", kbIds: ["kb-doc"] });
  const { fetchImpl, chunkCalls } = neighbourFetch({
    searchHits: [{ ...neighbourHit("know-offset"), id: "p-1150", chunk_index: 1150, content: "第 1150 块的正文。" }],
    onChunks: pagedDocument({ base: 1000, total: 300 }),
  });
  const result = await searchWeKnora("重新分块后 chunk_index 不再从 0 开始", config, { fetchImpl });
  assert.deepEqual(result.hits[0].neighbors, { before: 1, after: 1 });
  const pages = chunkCalls().map((url) => Number(/page=(\d+)/.exec(url)[1]));
  assert.deepEqual(pages, [1, 3, 2], "arithmetic lands on page 3, the halving search finds page 2: " + pages.join(","));
});

test("a failing chunks endpoint degrades to the bare hit", async () => {
  const config = configOf({ apiUrl: "http://unit.test/api/v1", kbIds: ["kb-doc"] });
  const { fetchImpl } = neighbourFetch({
    searchHits: [neighbourHit("know-fail")],
    onChunks: () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  const result = await searchWeKnora("邻块接口坏掉时仍然要注入原块", config, { fetchImpl });
  assert.equal(result.ok, true, "a broken chunks endpoint must not fail the retrieval");
  assert.equal(result.hits[0].content, HIT_TEXT, "the hit must come back untouched");
  assert.equal(result.hits[0].neighbors, undefined, "no neighbour info when the expansion failed");
  assert.equal(result.stats.neighbors.failed, 1);
  const { text, used } = buildInjection(result.hits, config);
  assert.equal(used.length, 1);
  assert.ok(text.includes("命中块的正文"));
});

test("a page whose chunk ids differ from the search hit is still located by chunk_index", async () => {
  const config = configOf({ apiUrl: "http://unit.test/api/v1", kbIds: ["kb-doc"] });
  const rows = neighbourFixture().map((chunk) => ({ ...chunk, id: chunk.id === "c-1" ? "server-side-id" : chunk.id }));
  const searchHits = [{ ...neighbourHit("know-idmismatch"), id: "chunk-from-search" }];
  const { fetchImpl } = neighbourFetch({ searchHits, onChunks: () => chunkPage(rows) });
  const result = await searchWeKnora("命中块 id 与服务端不一致时按位置兜底", config, { fetchImpl });
  assert.equal(result.hits[0].neighbors.before, 1, "chunk_index still locates the hit");
  assert.equal(result.hits[0].neighbors.after, 1, "chunk_index still locates the hit");
});

test("one document page is fetched once and reused by the next retrieval", async () => {
  const config = configOf({ apiUrl: "http://unit.test/api/v1", kbIds: ["kb-doc"] });
  const { fetchImpl, chunkCalls } = neighbourFetch({ searchHits: [neighbourHit("know-cache")], onChunks: () => chunkPage(neighbourFixture()) });
  const first = await searchWeKnora("第一次检索需要抓一次 chunk 分页", config, { fetchImpl });
  assert.equal(first.stats.neighbors.expanded, 1);
  assert.equal(chunkCalls().length, 1, "the first retrieval pays for the page");
  const second = await searchWeKnora("第二次检索同一文档必须命中缓存", config, { fetchImpl });
  assert.equal(second.stats.neighbors.expanded, 1);
  assert.equal(chunkCalls().length, 1, "the cached page index must save the second request");
});

test("neighborChunks 0 disables the extra request entirely", async () => {
  const config = configOf({ apiUrl: "http://unit.test/api/v1", kbIds: ["kb-doc"], neighborChunks: 0 });
  const { fetchImpl, chunkCalls } = neighbourFetch({ searchHits: [neighbourHit("know-off")], onChunks: () => chunkPage(neighbourFixture()) });
  const result = await searchWeKnora("关闭邻块扩展后只发检索请求", config, { fetchImpl });
  assert.equal(result.hits[0].content, HIT_TEXT);
  assert.equal(chunkCalls().length, 0, "no chunks request when disabled");
});

test("the search request carries an explicit top_k from config", async () => {
  const bodies = [];
  const fetchImpl = (url, init) => {
    if (url.includes("/knowledge-search")) bodies.push(JSON.parse(init.body));
    return Promise.resolve({ ok: true, json: async () => ({ data: [] }) });
  };
  await searchWeKnora("请求体必须带上 top_k", configOf({ apiUrl: "http://unit.test/api/v1", kbIds: ["kb-doc"] }), { fetchImpl });
  await searchWeKnora("请求体必须带上 top_k", configOf({ apiUrl: "http://unit.test/api/v1", kbIds: ["kb-doc"], topK: 25 }), { fetchImpl });
  assert.equal(bodies[0].top_k, 10, "default top_k is 10");
  assert.equal(bodies[1].top_k, 25, "top_k follows config");
  assert.deepEqual(bodies[0].knowledge_base_ids, ["kb-doc"], "the kb scope must survive the new field");
});

test("the block's count states the hits that really rendered", () => {
  const config = configOf({ maxChars: 400 });
  const { text, used } = buildInjection(syntheticHits(4), config);
  assert.ok(used.length >= 1, "expected at least one rendered hit");
  assert.ok(used.length < 4, "the narrow budget must cut the tail");
  const { attrs, entries } = parseBlock(text);
  assert.equal(Number(attrs.count), used.length, "count must match the rendered hits: " + attrs.count + " vs " + used.length);
  assert.equal(entries.length, used.length, "one entry per rendered hit");
});

test("three hits get a full working share of the 2400-char budget", () => {
  const config = configOf();
  const hits = syntheticHits(3, 1600);
  const { text, used } = buildInjection(hits, config);
  assert.equal(used.length, 3);
  assert.ok(text.length > 2000, "the block must use the raised budget: " + text.length);
  assert.ok(text.length <= CHARS_CAP, "block exceeds cap: " + text.length);
  for (const hit of used) {
    assert.ok(text.includes(cleanText(hit.content).slice(0, 500)), "each hit keeps at least 500 characters of its body");
  }
});

// --- source de-ranking (sourceWeights) --------------------------------------

const WEIGHTED_BODY = "这一段正文长度足够通过最短内容的过滤，用来验证来源降权后的排序与分数。";

/** One library: an hs- legacy transcript above a clean document of the same library. */
function weightedGroup() {
  return {
    kbId: "kb-memory",
    label: "会话记忆",
    hits: [
      { id: "hs-1", knowledge_id: "doc-hs", chunk_index: 0, knowledge_title: 'hs-[{"role":"user","content":"legacy Hermes"', content: WEIGHTED_BODY, score: 0.6 },
      { id: "clean-1", knowledge_id: "doc-clean", chunk_index: 0, knowledge_title: "会话记录 2026-11-01 注入插件上限", content: WEIGHTED_BODY, score: 0.45 },
    ],
  };
}

test("a source rule drops the hs- transcript below a clean document", () => {
  const config = configOf();
  const merged = mergeKbGroups([weightedGroup()], config);
  assert.equal(merged[0].id, "clean-1", "the de-ranked transcript must not lead");
  assert.equal(merged[1].id, "hs-1");
  assert.equal(merged[1].base_score, 0.6, "the original score must survive for the log");
  assert.equal(merged[1].applied_weight, 0.35, "appliedWeight must be recorded on the hit");
  assert.equal(merged[1].weight_reason, "legacy-hermes");
  assert.ok(Math.abs(merged[1].score - 0.6 * 0.35) < 1e-9, "score must be multiplied by the factor: " + merged[1].score);
  // With no rule at all the transcript leads again -- the rule is what moved it.
  const plain = mergeKbGroups([weightedGroup()], configOf({ sourceWeights: [] }));
  assert.equal(plain[0].id, "hs-1");
  assert.equal(plain[0].score, 0.6);
  assert.equal(plain[0].applied_weight, undefined);
  // The injected block follows the de-ranked order, and shows the de-ranked score.
  const { text, used } = buildInjection(merged, config);
  assert.equal(used[0].id, "clean-1");
  assert.ok(text.includes("score 0.4500"), "the block must render the score it ranked on");
});

test("the weighted score, not the server order, decides rank_in_kb", () => {
  // The service lists the transcript first; after the weight (0.60 * 0.35 = 0.21) a weaker
  // clean hit (0.30) has to take rank 1 of the library, so the transcript slips to rank 2.
  const group = {
    kbId: "kb-memory",
    label: "会话记忆",
    hits: [
      { id: "hs-1", knowledge_title: 'hs-[{"role":"user","content":"legacy Hermes"', content: WEIGHTED_BODY, score: 0.6 },
      { id: "clean-1", knowledge_title: "会话记录 2026-11-01 注入插件上限", content: WEIGHTED_BODY, score: 0.3 },
    ],
  };
  const config = configOf();
  const merged = mergeKbGroups([group], config);
  assert.equal(merged[0].id, "clean-1");
  assert.equal(merged[0].rank_in_kb, 1);
  assert.equal(merged[1].id, "hs-1");
  assert.equal(merged[1].rank_in_kb, 2, "the de-ranked hit must lose its rank inside the library");
  assert.ok(Math.abs(merged[1].raw_score - 0.21) < 1e-9, "the rank must be built on the weighted score: " + merged[1].raw_score);
  assert.equal(merged[1].base_score, 0.6, "the original score must still be there to compare against");
  assert.deepEqual(buildInjection(merged, config).used.map((hit) => hit.id), ["clean-1", "hs-1"]);
  // Same two hits, no rule: the transcript takes rank 1 back.
  const plain = mergeKbGroups([group], configOf({ sourceWeights: [] }));
  assert.equal(plain[0].id, "hs-1");
  assert.equal(plain[0].rank_in_kb, 1);
  // With a second library the fusion slot moves with the rank: 1/(60+2) vs 1/(60+1).
  const other = { kbId: "kb-b", label: "知识", hits: [{ id: "doc-1", knowledge_title: "WeKnora 检索接口文档", content: WEIGHTED_BODY, score: 0.5 }] };
  const fused = mergeKbGroups([group, other], config);
  const hs = fused.find((hit) => hit.id === "hs-1");
  const clean = fused.find((hit) => hit.id === "clean-1");
  assert.ok(Math.abs(hs.rrf - 0.35 / (60 + 2)) < 1e-12, "rrf must follow the recomputed rank and carry the factor: " + hs.rrf);
  assert.ok(Math.abs(clean.rrf - 1 / (60 + 1)) < 1e-12, "the clean hit must hold the better fusion slot: " + clean.rrf);
  assert.ok(fused.indexOf(clean) < fused.indexOf(hs), "the transcript must rank below the clean hit");
});

test("a library of de-ranked transcripts gives its fusion slot to a clean library", () => {
  // Library A holds nothing but legacy transcripts (0.70 -> 0.245), library B one clean
  // document (0.30 -> 0.30). Both tops used to arrive at 1/(60+1); the factor must now
  // decide the cross-library contest too.
  const legacy = { kbId: "kb-memory", label: "会话记忆", hits: [{ id: "hs-only", knowledge_title: 'hs-[{"role":"user","content":"legacy Hermes"', content: WEIGHTED_BODY, score: 0.7 }] };
  const clean = { kbId: "kb-b", label: "知识", hits: [{ id: "doc-1", knowledge_title: "WeKnora 检索接口文档", content: WEIGHTED_BODY, score: 0.3 }] };
  const config = configOf();
  const merged = mergeKbGroups([legacy, clean], config);
  const hs = merged.find((hit) => hit.id === "hs-only");
  const doc = merged.find((hit) => hit.id === "doc-1");
  assert.ok(Math.abs(hs.rrf - 0.35 / 61) < 1e-12, "the fusion contribution must carry the factor: " + hs.rrf);
  assert.ok(Math.abs(doc.rrf - 1 / 61) < 1e-12, "a clean top keeps the whole slot: " + doc.rrf);
  assert.ok(doc.rrf > hs.rrf, "a clean library must outrank a library of transcripts");
  assert.deepEqual(merged.map((hit) => hit.id), ["doc-1", "hs-only"]);
  // The scaled rrf also falls under the minScoreRatio gate, so the transcript loses its
  // injection slot instead of trailing the clean hit inside the block.
  const built = buildInjection(merged, config);
  assert.deepEqual(built.used.map((hit) => hit.id), ["doc-1"]);
  assert.equal(built.dropped.ratio, 1, "the de-ranked library must lose its slot to the ratio gate");
  // Without the rule both tops are equal again and the raw score decides.
  const plain = mergeKbGroups([legacy, clean], configOf({ sourceWeights: [] }));
  assert.equal(plain[0].id, "hs-only");
  assert.equal(plain[0].rrf, plain[1].rrf);
});

test("every hit carries the score the service returned", () => {
  const config = configOf();
  const merged = mergeKbGroups([weightedGroup()], config);
  for (const hit of merged) {
    assert.equal(typeof hit.base_score, "number", "base_score must be filled on every hit: " + hit.id);
  }
  // The clean hit is not de-ranked, so both numbers are its own score; the transcript
  // keeps the two apart. Neither column may read as a zero anywhere.
  assert.equal(merged[0].base_score, 0.45);
  assert.equal(merged[0].raw_score, 0.45);
  assert.equal(merged[0].applied_weight, undefined);
  assert.equal(merged[1].base_score, 0.6);
  assert.ok(Math.abs(merged[1].raw_score - 0.21) < 1e-9);
  const plain = mergeKbGroups([weightedGroup()], configOf({ sourceWeights: [] }));
  for (const hit of plain) {
    assert.equal(hit.base_score, hit.raw_score, "without a rule the base is the raw score: " + hit.id);
    assert.ok(hit.base_score > 0);
  }
});

test("the weight lands inside the library before the fusion slot is handed out", () => {
  const config = configOf({ perKbHits: 1 });
  const other = { kbId: "kb-a", label: "知识", hits: [{ id: "clean-2", knowledge_title: "WeKnora 检索接口文档", content: WEIGHTED_BODY, score: 0.5 }] };
  const merged = mergeKbGroups([weightedGroup(), other], config);
  // perKbHits 1 keeps one hit per library: after the weight that hit is the clean one,
  // so the fusion compares clean-vs-clean instead of handing the slot to the transcript.
  assert.ok(!merged.some((hit) => hit.id === "hs-1"), "a de-ranked hit must lose its fusion slot");
  assert.ok(merged.some((hit) => hit.id === "clean-1"));
});

test("factor 1 leaves score, order and every field exactly as before", () => {
  const plain = configOf({ sourceWeights: [] });
  const identity = configOf({ sourceWeights: [{ match: "^hs-", factor: 1, reason: "off" }] });
  const before = mergeKbGroups([weightedGroup()], plain);
  const after = mergeKbGroups([weightedGroup()], identity);
  assert.deepEqual(after, before, "a factor of 1 must be a no-op");
  assert.equal(after[0].id, "hs-1", "order must be untouched");
  assert.equal(after[0].applied_weight, undefined, "a no-op must not mark the hit");
  assert.equal(buildInjection(after, identity).text, buildInjection(before, plain).text, "the block must be byte-identical");
  // Across two libraries a no-op factor must not touch a single rrf either.
  const legacy = { kbId: "kb-memory", label: "会话记忆", hits: [{ id: "hs-x", knowledge_title: 'hs-[{"role":"user","content":"legacy"', content: WEIGHTED_BODY, score: 0.7 }] };
  const clean = { kbId: "kb-b", label: "知识", hits: [{ id: "doc-x", knowledge_title: "WeKnora 检索接口文档", content: WEIGHTED_BODY, score: 0.3 }] };
  assert.deepEqual(mergeKbGroups([legacy, clean], identity), mergeKbGroups([legacy, clean], plain), "factor 1 must leave every rrf untouched");
});

test("an illegal factor, a broken regex or a blank match is ignored", () => {
  const config = configOf({
    sourceWeights: [
      { match: "^hs-", factor: 1.8, reason: "too-big" },
      { match: "^hs-", factor: 0, reason: "zero" },
      { match: "^hs-", factor: -0.5, reason: "negative" },
      { match: "^hs-", factor: "abc", reason: "not-a-number" },
      { match: "([unclosed", factor: 0.2, reason: "broken-regex" },
      { match: "   ", factor: 0.2, reason: "blank" },
      null,
      "hs-",
      { match: "^hs-", factor: "0.5", reason: "numeric-string" },
    ],
  });
  assert.deepEqual(config.sourceWeights, [{ match: "^hs-", factor: 0.5, reason: "numeric-string" }], "only the usable rule may survive");
  const bare = configOf({ sourceWeights: [{ match: "^hs-", factor: 2, reason: "too-big" }] });
  assert.equal(bare.sourceWeights.length, 0, "out-of-range factors are dropped, not clamped");
  const merged = mergeKbGroups([weightedGroup()], bare);
  assert.deepEqual(merged, mergeKbGroups([weightedGroup()], configOf({ sourceWeights: [] })), "an ignored rule must not change the fusion");
});

// ---------------------------------------------------------------------------
// Shared helpers for the panel tests
// ---------------------------------------------------------------------------

/** A directory of its own per test, so no two tests share a backup or a stats file. */
function tempDir(label) {
  return mkdtempSync(join(tmpdir(), "wk-panel-" + label + "-"));
}

/** One core card, active unless the test says otherwise. */
function cardOf(id, kind, text, extra = {}) {
  return { id, kind, core: true, text, valid_from: "2026-10-01", status: "active", source: "m00001", ...extra };
}

// ---------------------------------------------------------------------------
// The panel (R9): one loopback API over the same files the injector reads
// ---------------------------------------------------------------------------

test("R9: the panel edits one card in place and refuses an unknown id or a bad status", () => {
  const profile = { version: 1, cards: [cardOf("user.a", "user", "偏好一。"), cardOf("agent.b", "agent", "习惯一。")] };
  const edited = updateCard(profile, "user.a", { text: "  偏好一，改过了。  " });
  assert.equal(edited.error, undefined, JSON.stringify(edited));
  assert.equal(edited.card.text, "偏好一，改过了。", "the text is trimmed, not stored raw");
  assert.equal(edited.profile.cards[0].text, "偏好一，改过了。");
  assert.equal(edited.profile.cards.length, 2, "an edit never appends");
  assert.equal(updateCard(profile, "user.missing", { text: "x" }).error, "unknown_id");
  assert.equal(updateCard(profile, "user.a", { status: "archived" }).error, "bad_status", "only the three known statuses are writable");
  assert.equal(updateCard(profile, "user.a", { kind: "system" }).error, "bad_kind");
  const approved = updateCard(profile, "agent.b", { status: "active", approve: true });
  assert.equal(approved.card.approve, true, "the panel can approve a card, which is what promotes it");
});

test("R9: the panel adds a proposed card and removes one by id", () => {
  const profile = { version: 1, cards: [cardOf("user.a", "user", "偏好一。")] };
  const added = addCard(profile, { kind: "agent", text: "改代码前先跑测试。" });
  assert.equal(added.error, undefined);
  assert.equal(added.card.status, "proposed", "a new card waits for approval");
  assert.equal(added.card.source, "panel");
  assert.equal(added.profile.cards.length, 2);
  assert.equal(addCard(profile, { kind: "system", text: "x" }).error, "bad_kind");
  assert.equal(addCard(profile, { kind: "user", text: "   " }).error, "empty_text");
  const removed = removeCard(added.profile, added.card.id);
  assert.equal(removed.error, undefined);
  assert.equal(removed.profile.cards.length, 1);
  assert.equal(removeCard(removed.profile, "user.ghost").error, "unknown_id");
});

test("R9: the retrieval aggregate counts attempts, not skipped steps", () => {
  const lines = [
    JSON.stringify({ outcome: "injected", hits: 3, retrieval_chars: 900, pinned_chars: 823, ms: 120, kb: [{ label: "知识", hits: 2 }, { label: "会话记忆", hits: 1 }] }),
    JSON.stringify({ outcome: "injected", hits: 1, retrieval_chars: 300, pinned_chars: 823, ms: 80, kb: [{ label: "知识", hits: 1 }] }),
    JSON.stringify({ outcome: "injected", reason: "no_user_text", retrieval_outcome: "skip", retrieval_chars: 0, pinned_chars: 823, pinned_only: true }),
    JSON.stringify({ outcome: "injected", reason: "short_prompt", retrieval_outcome: "skip", retrieval_chars: 0, pinned_chars: 823, pinned_only: true }),
    "not json at all",
  ];
  const stats = aggregateRetrieval(lines);
  assert.equal(stats.records, 4, "a broken line is skipped, not counted");
  assert.equal(stats.attempts, 2, "two steps actually asked the backend");
  assert.equal(stats.injected_pct, 100, "both attempts injected");
  assert.equal(stats.avg_hits, 2, "3 and 1 hits average to 2 over the two attempts");
  assert.equal(stats.avg_retrieval_chars, 600);
  assert.equal(stats.pinned_only, 2);
  assert.deepEqual(stats.kb_hits, { "知识": 3, "会话记忆": 1 });
  assert.equal(stats.p50_ms, 80, "p50 sits on the lower of the two durations");
});

/** Drive one registered Fetch route the way the connection service dispatches it. */
function panelOf(handler, path, init) {
  const url = "http://127.0.0.1" + path;
  const request = new Request(url, init);
  return Promise.resolve(handler.fetch(request)).then(async (response) => ({
    status: response.status,
    body: await response.json(),
    noStore: response.headers.get("cache-control") === "no-store",
  }));
}

test("R9: the panel routes read and write the profile through the host transport", async () => {
  const dir = tempDir("panel");
  const profilePath = join(dir, "profile.json");
  const backupDir = join(dir, "backups");
  writeFileSync(profilePath, JSON.stringify({ version: 1, cards: [cardOf("user.a", "user", "偏好一。")] }, null, 2) + "\n");
  const config = configOf({ profile: { enabled: true, path: profilePath } });
  const routes = panelRoutes({ config, profilePath, statsPath: join(dir, "stats.json"), logFile: join(dir, "inject.log"), backupDir });
  assert.deepEqual(routes.map((r) => r.path), [PANEL_API_PREFIX + "/state", PANEL_API_PREFIX + "/card"], "exact paths only: the transport has no path parameters");
  assert.deepEqual(routes.map((r) => r.methods), [["GET"], ["POST"]]);
  const state = routes[0];
  const card = routes[1];

  const first = await panelOf(state, state.path);
  assert.equal(first.status, 200);
  assert.equal(first.noStore, true, "panel state is never cached");
  assert.equal(first.body.profile.cards.length, 1);
  assert.equal(first.body.profile.cards[0].rendered, true, "an active core card is what the injector would render");
  assert.equal(first.body.memory.cards, 1);
  assert.equal(first.body.retrieval.records, 0, "an absent log file is an empty aggregate");

  const put = await panelOf(card, card.path, { method: "POST", body: JSON.stringify({ op: "update", id: "user.a", patch: { text: "偏好一，面板改过。" } }) });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const stored = JSON.parse(readFileSync(profilePath, "utf8")).cards;
  assert.equal(stored[0].text, "偏好一，面板改过。", "the write reached the file the injector reads");
  assert.equal(readdirSync(backupDir).length >= 1, true, "a pre-write copy exists");

  const added = await panelOf(card, card.path, { method: "POST", body: JSON.stringify({ op: "add", input: { kind: "agent", text: "新习惯。" } }) });
  assert.equal(added.status, 200);
  assert.equal(JSON.parse(readFileSync(profilePath, "utf8")).cards.length, 2);

  const removed = await panelOf(card, card.path, { method: "POST", body: JSON.stringify({ op: "remove", id: "user.a" }) });
  assert.equal(removed.status, 200);
  assert.equal(JSON.parse(readFileSync(profilePath, "utf8")).cards.length, 1);

  const ghost = await panelOf(card, card.path, { method: "POST", body: JSON.stringify({ op: "update", id: "user.ghost", patch: { text: "x" } }) });
  assert.equal(ghost.status, 400);
  assert.equal(ghost.body.error, "unknown_id");

  const badOp = await panelOf(card, card.path, { method: "POST", body: JSON.stringify({ op: "nope" }) });
  assert.equal(badOp.status, 400);
  assert.equal(badOp.body.error, "bad_op");

  const badJson = await panelOf(card, card.path, { method: "POST", body: "{not json" });
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.error, "bad_json");
});
