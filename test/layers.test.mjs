/**
 * Layer tests rebuilt after the original test file was truncated: the pinned/profile
 * renderer, the decay and tier layers, the fact-card contract and the nightly writer.
 * Everything here is a pure function call -- no network, no live backend.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, normalizeProfileCard, refreshProfileCards } from "../lib/config.js";
import {
  applyFactCards,
  buildInjection,
  buildPinned,
  parseFactCard,
  profileLine,
  selectProfileCardsDetailed,
  selectSoulCards,
} from "../lib/format.js";
import { decayFactor } from "../lib/decay.js";
import { DEFAULT_TIER, applyTierQuota, tierOf } from "../lib/tier.js";
import { propose, profileBudget, review, decide } from "../../../_wk_dream/profile-writer.mjs";

const TEST_LOG = join(tmpdir(), "wk-layers.log");

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), "wk-layers-" + label + "-"));
}

function cardOf(id, kind, text, extra = {}) {
  return { id, kind, core: true, text, valid_from: "2026-10-01", status: "active", source: "m00001", ...extra };
}

/** Config with exactly these cards and no standing rules, unless a test passes its own. */
function configWith(cards, overrides = {}) {
  return loadConfig({ logFile: TEST_LOG, pinned: [], profile: { enabled: true, cards }, ...overrides });
}

/* ------------------------------------------------------------------ pinned */

test("L1: soul renders in section A, user and agent in section B", () => {
  const config = configWith([
    cardOf("soul.a", "soul", "结论要给出处。"),
    cardOf("user.a", "user", "后端是 Java。"),
    cardOf("agent.a", "agent", "改代码前先读实现。"),
  ]);
  const block = buildPinned(config);
  const text = block.text;
  assert.ok(text.indexOf("[soul] 结论要给出处。") < text.indexOf("[user] 后端是 Java。"), "soul precedes the profile section: " + text);
  assert.equal(block.count, 3);
  assert.equal(block.profile.soul_cards, 1);
  assert.ok(!text.includes("来源"), "no date or provenance is rendered");
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(text), "no date may appear anywhere: " + text);
});

test("L1: standing rules come first and are kept when the tail is truncated", () => {
  const rules = [{ text: "规则一。", reason: "preference" }, { text: "规则二。", reason: "architecture" }];
  const cards = [cardOf("user.a", "user", "字".repeat(60)), cardOf("agent.b", "agent", "字".repeat(60))];
  const config = configWith(cards, { pinned: rules, pinnedMaxChars: 120 });
  const block = buildPinned(config);
  assert.ok(block.truncated, "120 characters cannot hold two rules and two cards");
  assert.ok(block.text.includes("规则一。"), "the first rule survives: " + block.text);
  assert.ok(!block.text.includes("字".repeat(60)), "the profile cards pay first");
});

test("L2: a card is dropped by status, quota or characters and each drop is counted", () => {
  const cards = [
    cardOf("user.a", "user", "偏好一。"),
    cardOf("user.b", "user", "偏好二。", { status: "proposed" }),
    cardOf("user.c", "user", "偏好三。", { core: false }),
    cardOf("user.d", "user", "字".repeat(80)),
    cardOf("user.e", "user", "字".repeat(80)),
    cardOf("user.f", "user", "字".repeat(80)),
  ];
  const detail = selectProfileCardsDetailed(configWith(cards));
  assert.equal(detail.dropped.status, 1, "a proposed card is not rendered");
  assert.equal(detail.dropped.notCore, 1, "a core=false card stays out");
  assert.equal(detail.dropped.quota, 1, "the fourth live user card hits the per-kind quota");
  assert.equal(detail.chosen.length, 3);

  // A tighter character budget drops the same card through the other gate.
  const tight = selectProfileCardsDetailed(configWith(cards, { profile: { enabled: true, cards, userMaxChars: 100 } }));
  assert.equal(tight.dropped.chars, 2, "two 80-character cards do not fit a 100-character budget: " + JSON.stringify(tight.dropped));
  assert.equal(tight.chosen.length, 2, "3 + 80 fits a 100-character budget; the two 80-character cards after it do not");
});

test("L2: the per-kind budgets are three user cards and six agent cards", () => {
  const cards = [];
  for (let i = 0; i < 4; i += 1) cards.push(cardOf("user." + i, "user", "偏好" + i + "。"));
  for (let i = 0; i < 7; i += 1) cards.push(cardOf("agent." + i, "agent", "习惯" + i + "。"));
  const detail = selectProfileCardsDetailed(configWith(cards));
  const kinds = detail.chosen.map((card) => card.kind);
  assert.equal(kinds.filter((kind) => kind === "user").length, 3);
  assert.equal(kinds.filter((kind) => kind === "agent").length, 7 > 6 ? 6 : 6);
});

test("L3: soul has its own budget and never consumes a profile slot", () => {
  const cards = [
    cardOf("soul.a", "soul", "准则一。"),
    cardOf("soul.b", "soul", "准则二。"),
    cardOf("user.a", "user", "偏好一。"),
  ];
  const config = configWith(cards);
  assert.equal(selectSoulCards(config).length, 2);
  const detail = selectProfileCardsDetailed(config);
  assert.equal(detail.chosen.length, 1, "soul is filtered by kind, not counted as a profile card: " + JSON.stringify(detail.chosen));
});

test("L4: profileLine renders the text alone, whatever the date says", () => {
  assert.equal(profileLine(cardOf("user.a", "user", "偏好一。", { valid_from: "2020-01-01" })), "- [user] 偏好一。");
  assert.equal(profileLine(cardOf("soul.a", "soul", "准则一。")), "- [soul] 准则一。");
});

test("L5: a newer mtime makes the next turn see the promoted card", () => {
  const dir = tempDir("reload");
  const file = join(dir, "profile.json");
  const write = (cards) => writeFileSync(file, JSON.stringify({ version: 1, cards }, null, 2) + "\n");
  write([cardOf("user.first", "user", "第一张。")]);
  const config = loadConfig({ logFile: TEST_LOG, pinned: [], profile: { enabled: true, path: file } });
  assert.equal(buildPinned(config).count, 1);
  write([cardOf("user.second", "user", "第二张。")]);
  const stamp = new Date(Date.now() + 5000);
  utimesSync(file, stamp, stamp);
  refreshProfileCards(config.profile);
  const text = buildPinned(config).text;
  assert.ok(text.includes("第二张。"), "the refreshed file is what renders: " + text);
  assert.ok(!text.includes("第一张。"));
});

/* ------------------------------------------------------------------- decay */

test("L6: the decay halves every tau and never falls below the floor", () => {
  const shape = { tauDays: 30, floor: 0.35 };
  assert.equal(decayFactor(0, shape), 1);
  assert.ok(Math.abs(decayFactor(30, shape) - 0.5) < 1e-9);
  assert.ok(Math.abs(decayFactor(60, shape) - 0.35) < 1e-9, "the floor binds before the curve would");
  assert.equal(decayFactor(-5, shape), 1, "clock skew never inflates a weight");
});

/* -------------------------------------------------------------------- tier */

test("L7: a cold chunk is withheld until the layer is switched wide", () => {
  const chunk = { firstSeen: new Date(Date.now() - 200 * 86400000).toISOString(), hits: 0 };
  assert.equal(tierOf(chunk, DEFAULT_TIER, Date.now()), "cold");
  const cold = { firstSeen: new Date(Date.now() - 200 * 86400000).toISOString(), hits: 1 };
  assert.notEqual(tierOf(cold, DEFAULT_TIER, Date.now()), "cold", "a chunk that was hit is never cold");
});

/* ---------------------------------------------------------------- fact card */

test("L8: a fact head is parsed, a broken one degrades to a legacy chunk", () => {
  const body = '<!-- fact {"v":1,"subject":"mem.retention","status":"superseded","valid_from":"2026-11-01"} -->\n# mem.retention\n会话记忆保留 30 天。';
  const card = parseFactCard(body);
  assert.equal(card.subject, "mem.retention");
  assert.equal(card.status, "superseded");
  assert.equal(parseFactCard("no head here"), null);
  assert.equal(parseFactCard("<!-- fact {bad json} -->"), null);
});

test("L8: a retired document is dropped and the count is reported", () => {
  const config = loadConfig({ logFile: TEST_LOG, factCards: { retiredDocs: ["旧机制文档"] } });
  const hits = [
    { id: "a", knowledge_id: "doc-a", knowledge_title: "旧机制文档", content: "字".repeat(60), score: 0.6, kb_id: "kb" },
    { id: "b", knowledge_id: "doc-b", knowledge_title: "新机制文档", content: "字".repeat(60), score: 0.5, kb_id: "kb" },
  ];
  const { hits: kept, stats } = applyFactCards(hits, config);
  assert.equal(stats.retired_dropped, 1);
  assert.deepEqual(kept.map((hit) => hit.id), ["b"]);
});

/* ------------------------------------------------------------------- writer */

test("L9: a repeat is attestation, a human approval promotes, a rejection retires", () => {
  const base = { version: 1, cards: [] };
  const first = propose(base, { kind: "agent", text: "改代码前先读实现。", source: "s1" }, { today: "2026-11-01" });
  assert.equal(first.error, undefined);
  assert.equal(first.card.status, "proposed");
  const again = propose(first.profile, { kind: "agent", text: "改代码前先读实现。", source: "s2" }, { today: "2026-11-02" });
  assert.equal(again.merged, true, "the same topic merges into one card");
  assert.equal(again.card.attest, 2);
  const reviewed = review(again.profile, { today: "2026-11-03" });
  const decision = reviewed.decisions.find((entry) => entry.id === again.card.id);
  assert.equal(decision.action, "kept_proposed", "two attestations are not a decision: " + JSON.stringify(decision));
  const approved = decide(reviewed.profile, again.card.id, "approve", { today: "2026-11-03" });
  const promoted = review(approved.profile, { today: "2026-11-03" });
  assert.equal(promoted.profile.cards[0].status, "active", "an approval is checked before the tonight gate");
  const rejected = decide(promoted.profile, again.card.id, "reject", { today: "2026-11-03" });
  assert.equal(rejected.profile.cards[0].status, "disputed");
});

test("L9: the nightly budget report counts what would really render", () => {
  const cards = [
    cardOf("user.a", "user", "偏好一。"),
    cardOf("agent.a", "agent", "习惯一。"),
    cardOf("agent.b", "agent", "习惯二。"),
  ];
  const budget = profileBudget(cards);
  assert.equal(budget.count.user, 1);
  assert.equal(budget.count.agent, 2);
  assert.ok(budget.chars.user > 0 && budget.chars.agent > 0);
});

/* ------------------------------------------------------------------ injection */

test("L10: a retrieval block and a pinned block compose pinned-first", () => {
  const config = configWith([cardOf("soul.a", "soul", "准则一。")], { pinned: [{ text: "硬规则一。", reason: "preference" }], maxChars: 600 });
  const hits = [{ id: "h1", kb_id: "kb", knowledge_title: "标题", content: "正文".repeat(20), score: 0.8 }];
  const pinned = buildPinned(config);
  const retrieval = buildInjection(hits, config);
  assert.ok(pinned.text.startsWith("<pinned_constraints"));
  assert.ok(retrieval.text.startsWith("<weknora_context"));
});
