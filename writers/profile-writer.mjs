#!/usr/bin/env node
/**
 * 夜间画像写入器：data/profile.json 的唯一写入者。插件侧只读，任何新内容只能从这里
 * 进入常驻层。这是安全边界——常驻内容每轮注入、跨会话传播，一旦被污染没有任何
 * 后续检索能纠正它。
 *
 * 规则：
 * - 新卡一律 status="proposed"，proposedAt 记当天；当晚的复核不会把它转正（必须等下一夜）。
 * - 复核只处理 proposedAt < 当天 的卡，且必须同时满足：有来源、不重复（id 与正文）、
 *   同 id 不与其他卡冲突、正文 ≤60 字。任一条不过就保持 proposed 并写进日志。
 * - 降级：读 config.profile.statsPath，只有插件按 profile.degradeAfter 写了 degrade 标记的
 *   active 卡才转 disputed（下一轮就不再进常驻块，插件按 status 过滤）。没有 degrade 标记的卡，
 *   即使 missStreak 早已过线，也只作为"候选"报告，不动 status——判据只有插件，不是本脚本的自算。
 * - 默认 dry-run：打印计划与 diff，不落盘；--write 才写。
 *
 * 本脚本不调用 WeKnora：它只读/写本地 profile.json 与 profile-stats.json。
 *
 * 用法：
 *   node writers/profile-writer.mjs --propose "用户偏好 Java 后端" --kind user --source m00123 --dry-run
 *   node writers/profile-writer.mjs --review --dry-run
 *   node writers/profile-writer.mjs --review --write
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectProfileCardsDetailed } from '../lib/format.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_CONFIG = path.join(HERE, 'writer.config.json');
const EXAMPLE_CONFIG = path.join(HERE, 'config.example.json');

/**
 * 与插件侧硬约束一致（lib/config.js 的 PROFILE_* 常量）：
 * 9 张卡总量、user 3 张 / agent 6 张、单卡 80 字、user 文本 200 字、agent 文本 400 字。
 * 字数按 kind 分账——共用一个池子时三张 user 卡会把 agent 层挤成 0 张，这是实际发生过的事。
 */
export const MAX_CARDS = 9;
export const PER_KIND_MAX = { user: 3, agent: 6 };
export const MAX_TEXT = 80;
export const USER_MAX_CHARS = 200;
export const AGENT_MAX_CHARS = 400;
/**
 * 复核转正的正文上限（任务契约：正文 ≤60 字）。比写卡上限 80 更严：
 * 常驻层每轮注入，越短越不容易把一整段结论挤成噪声。
 */
export const REVIEW_TEXT_MAX = 60;
/**
 * R6 的历史阈值，保留但不再是判据：它只用来把"连续 missStreak 已到线、插件却没写 degrade 标记"
 * 的卡单独报成候选。真正决定降级的是 profile-stats.json 里的 degrade 字段（插件按
 * profile.degradeAfter 写；出厂 0 表示只计数、永不标记，于是夜间任务一张也不会降级）。
 */
export const DEGRADE_AFTER = 50;

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const charLen = (value) => Array.from(clean(value)).length;
const KINDS = new Set(['user', 'agent']);
const KIND_CHARS = { user: USER_MAX_CHARS, agent: AGENT_MAX_CHARS };
/**
 * 归一化主题键：去掉标点与空白后比对。同一件事被反复提出时只有这个键相同，正文常常
 * 一字不差地重写——按 key 合并而不是追加。
 */
const PUNCT = /[\s，。；：、,.;:!?！？"'“”‘’（）()【】\[\]—–-]+/g;
export function keyOf(value) {
  return clean(value).toLowerCase().replace(PUNCT, '');
}

/** 当前 kind 的 core 文本占用（disputed 不算，因为它就不再注入了）。 */
function kindChars(cards, kind) {
  return cards.filter((card) => card?.kind === kind && card?.core === true && card?.status !== 'disputed')
    .reduce((sum, card) => sum + charLen(card?.text), 0);
}
const STATUSES = new Set(['active', 'proposed', 'disputed']);

export function dayOf(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
}

export function emptyProfile() {
  return { version: 1, cards: [] };
}

/** 读一个 profile.json；缺失或损坏都退化成空表（插件侧同样如此，写侧不能更严格）。 */
export function readProfile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const cards = Array.isArray(raw?.cards) ? raw.cards : [];
    return { version: Number(raw?.version) || 1, cards };
  } catch {
    return emptyProfile();
  }
}

export function serializeProfile(profile) {
  return JSON.stringify({ version: Number(profile?.version) || 1, cards: profile?.cards ?? [] }, null, 2) + '\n';
}

/** 行级 diff：只裁掉公共前后缀，中间整段按 -/+ 输出，够看清楚这一次改了什么。 */
export function diffTexts(before, after) {
  const a = String(before).split('\n');
  const b = String(after).split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA -= 1; endB -= 1; }
  const out = [];
  for (let i = start; i <= endA; i += 1) out.push('- ' + a[i]);
  for (let i = start; i <= endB; i += 1) out.push('+ ' + b[i]);
  return out.join('\n');
}

/** approve/reject：人的一次显式决定，写进卡里而不是写进某个进程的内存。 */
export function decide(profile, id, action, { today = dayOf() } = {}) {
  const cards = Array.isArray(profile?.cards) ? profile.cards.map((card) => ({ ...card })) : [];
  const index = cards.findIndex((card) => card?.id === id);
  if (index < 0) return { error: 'unknown_id:' + id };
  if (action === 'approve') {
    cards[index] = { ...cards[index], approve: true, approvedAt: today };
  } else if (action === 'reject') {
    cards[index] = { ...cards[index], status: 'disputed', rejectedAt: today };
  } else {
    return { error: 'bad_action:' + action };
  }
  return { card: cards[index], profile: { version: Number(profile?.version) || 1, cards } };
}

/**
 * 生成一张 proposed 卡。所有校验都在这里，不合格就返回 error 且不产生卡：
 * 正文 1..80 字、kind 已知、有来源、id 与正文都不重复、不超 per-kind 3 张与 core 200 字。
 */
export function propose(profile, input = {}, { today = dayOf() } = {}) {
  const cards = Array.isArray(profile?.cards) ? profile.cards.slice() : [];
  const text = clean(input.text);
  const kind = clean(input.kind) || 'user';
  const source = clean(input.source);
  const core = input.core !== false;
  if (!text) return { error: 'empty_text' };
  if (charLen(text) > MAX_TEXT) return { error: 'text_too_long:' + charLen(text) };
  if (!KINDS.has(kind)) return { error: 'bad_kind:' + kind };
  if (!source) return { error: 'no_source' };
  // Same topic, same kind: attest the existing card instead of appending a near-copy.
  const key = keyOf(input.key || text);
  const index = cards.findIndex((card) => card?.kind === kind && (clean(card?.key) ? card.key === key : keyOf(card?.text) === key));
  if (index >= 0) {
    const prev = cards[index];
    const mergedText = charLen(text) > charLen(prev.text) ? text : clean(prev.text);
    if (charLen(mergedText) > MAX_TEXT) return { error: 'text_too_long:' + charLen(mergedText) };
    const merged = {
      ...prev,
      text: mergedText,
      key,
      // An existing card already counts as one sighting: the second one makes two.
      attest: (Number(prev.attest) || 1) + 1,
      lastSeen: today,
      proposedAt: prev.status === 'proposed' ? today : clean(prev.proposedAt),
    };
    cards[index] = merged;
    return { card: merged, merged: true, profile: { version: Number(profile?.version) || 1, cards } };
  }
  const id = clean(input.id) || kind + '.' + crypto.createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 8);
  if (cards.some((card) => card?.id === id)) return { error: 'duplicate_id:' + id };
  const sameKind = cards.filter((card) => card?.kind === kind && card?.core === true && card?.status !== 'disputed').length;
  if (sameKind >= PER_KIND_MAX[kind]) return { error: 'kind_quota:' + kind + '=' + sameKind };
  const liveCore = cards.filter((card) => card?.core === true && card?.status !== 'disputed').length;
  if (liveCore >= MAX_CARDS) return { error: 'card_quota:' + liveCore };
  if (core && kindChars(cards, kind) + charLen(text) > KIND_CHARS[kind]) {
    return { error: 'kind_chars:' + kind + '=' + kindChars(cards, kind) + '+' + charLen(text) + '>' + KIND_CHARS[kind] };
  }
  const card = {
    id,
    kind,
    core,
    key,
    text,
    valid_from: today,
    status: 'proposed',
    source,
    proposedAt: today,
    attest: 1,
  };
  return { card, profile: { version: Number(profile?.version) || 1, cards: [...cards, card] } };
}

/** 重复/冲突判定：同 id、正文完全相同、同 kind 且正文互相包含，都算冲突。 */
function conflictOf(card, cards) {
  for (const other of cards) {
    if (!other) continue;
    if (other.id === card.id) return 'duplicate_id:' + other.id;
    if (clean(other.text) === clean(card.text)) return 'duplicate_text:' + other.id;
    if (other.kind === card.kind) {
      const a = clean(card.text);
      const b = clean(other.text);
      if (a.length >= 6 && b.length >= 6 && (a.includes(b) || b.includes(a))) return 'overlap:' + other.id;
    }
  }
  return '';
}

/**
 * 一夜的复核：proposed 转 active（必须过四条：有来源 / 不重复 / 同 id 不冲突 / 正文 ≤60 字，
 * 且不是当晚提的）；active 只在 profile-stats.json 该卡带 degrade 标记时转 disputed，否则
 * streak 再长也只记一条 candidate 决策。纯函数，返回新 profile 与逐卡决策，便于测试与日志。
 */
export function review(profile, { today = dayOf(), stats = {}, degrade = true } = {}) {
  const cards = (Array.isArray(profile?.cards) ? profile.cards : []).map((card) => ({ ...card }));
  const decisions = [];
  for (const card of cards) {
    if (card.status === 'proposed') {
      if (!card.proposedAt || String(card.proposedAt) >= today) {
        decisions.push({ id: card.id, action: 'kept_proposed', reason: 'proposed_today_wait_next_night' });
        continue;
      }
      if (!clean(card.source)) {
        decisions.push({ id: card.id, action: 'kept_proposed', reason: 'no_source' });
        continue;
      }
      const length = charLen(card.text);
      if (!length || length > REVIEW_TEXT_MAX) {
        decisions.push({ id: card.id, action: 'kept_proposed', reason: 'bad_text:' + length + '>' + REVIEW_TEXT_MAX });
        continue;
      }
      const others = cards.filter((other) => other !== card);
      const conflict = conflictOf(card, others);
      if (conflict) {
        decisions.push({ id: card.id, action: 'kept_proposed', reason: 'conflict:' + conflict });
        continue;
      }
      card.status = 'active';
      decisions.push({ id: card.id, action: 'activated', reason: 'source+unique+under_' + REVIEW_TEXT_MAX });
      continue;
    }
    if (card.status === 'active' && degrade) {
      const entry = stats?.[card.id] ?? {};
      const miss = Number(entry.missStreak) || 0;
      const marker = entry.degrade;
      if (marker) {
        card.status = 'disputed';
        const after = Number(marker?.after) || 0;
        decisions.push({ id: card.id, action: 'disputed', reason: 'degrade_marker_' + after });
        continue;
      }
      if (miss >= DEGRADE_AFTER) {
        decisions.push({ id: card.id, action: 'candidate', reason: 'miss_streak_' + miss + '_no_marker' });
      }
    }
  }
  return { profile: { version: Number(profile?.version) || 1, cards }, decisions };
}

/**
 * 本轮的预算实况：用插件自己的选择器算一遍，所以"哪张卡被挤掉了"和插件渲染时看到的是
 * 同一套判断。静默丢弃正是要避免的：写满就报错，我们这里改成报表。
 */
export function profileBudget(cards) {
  const config = {
    profile: {
      enabled: true,
      cards,
      maxCards: MAX_CARDS,
      perKindMax: PER_KIND_MAX,
      maxText: MAX_TEXT,
      userMaxChars: USER_MAX_CHARS,
      agentMaxChars: AGENT_MAX_CHARS,
    },
  };
  const { chosen, chars, dropped, caps } = selectProfileCardsDetailed(config);
  const count = { user: 0, agent: 0 };
  for (const card of chosen) count[card.kind] += 1;
  return { chosen: chosen.length, count, chars, dropped, caps };
}

export function readStats(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 一次夜间运行的完整入口：propose -> review -> (diff, 落盘)。默认 dry-run。
 * @returns { ok, error?, profile, written, decisions, diff }
 */
export function run(options = {}) {
  const profilePath = options.profilePath;
  const statsPath = options.statsPath;
  const dryRun = options.dryRun !== false;
  const today = options.today || dayOf(options.now ? new Date(options.now) : new Date());
  if (!profilePath) return { ok: false, error: 'no_profile_path', written: false, decisions: [], diff: '' };
  const before = readProfile(profilePath);
  const beforeText = serializeProfile(before);
  let working = before;
  const decisions = [];
  if (options.propose !== undefined && options.propose !== null) {
    const proposed = propose(working, { text: options.propose, kind: options.kind, id: options.id, source: options.source, core: options.core }, { today });
    if (proposed.error) return { ok: false, error: proposed.error, profile: before, written: false, decisions, diff: '' };
    working = proposed.profile;
    decisions.push({ id: proposed.card.id, action: 'proposed', reason: 'awaiting_next_night_review' });
  }
  for (const id of options.approve ?? []) {
    const approved = decide(working, id, 'approve', { today });
    if (approved.error) return { ok: false, error: approved.error, profile: before, written: false, decisions, diff: '' };
    working = approved.profile;
    decisions.push({ id, action: 'approved', reason: 'human_approval' });
  }
  for (const id of options.reject ?? []) {
    const rejected = decide(working, id, 'reject', { today });
    if (rejected.error) return { ok: false, error: rejected.error, profile: before, written: false, decisions, diff: '' };
    working = rejected.profile;
    decisions.push({ id, action: 'rejected', reason: 'human_rejection' });
  }
  const degradeOn = options.degrade !== false;
  let degradeReport = { eligible: 0, degraded: 0, candidates: 0 };
  if (options.review === true) {
    const stats = statsPath ? readStats(statsPath) : {};
    // Eligibility is counted before the flip: a card that carries the plugin's degrade marker
    // is the only one this run may retire, so eligible stays non-zero even under --no-degrade.
    const eligible = degradeOn ? working.cards.filter((card) => card?.status === 'active' && stats?.[card?.id]?.degrade).length : 0;
    const reviewed = review(working, { today, stats, degrade: degradeOn });
    working = reviewed.profile;
    decisions.push(...reviewed.decisions);
    degradeReport = {
      eligible,
      degraded: reviewed.decisions.filter((entry) => entry.action === 'disputed').length,
      candidates: reviewed.decisions.filter((entry) => entry.action === 'candidate').length,
    };
  }
  const budget = profileBudget(working.cards);
  const afterText = serializeProfile(working);
  const diff = diffTexts(beforeText, afterText);
  const changed = diff !== '';
  if (dryRun || !changed) return { ok: true, profile: working, written: false, decisions, diff, profilePath, degradeReport, budget };
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, afterText, 'utf8');
  return { ok: true, profile: working, written: true, decisions, diff, profilePath, degradeReport, budget };
}

// ---------- 配置 ----------
function mergeConfig(base, over) {
  const out = { ...base };
  for (const [key, value] of Object.entries(over || {})) {
    const prev = out[key];
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && prev && typeof prev === 'object'
      ? { ...prev, ...value }
      : value;
  }
  return out;
}

function loadConfig(explicit) {
  if (!fs.existsSync(EXAMPLE_CONFIG)) throw new Error('缺少默认配置：' + EXAMPLE_CONFIG);
  let file = '';
  let fallback = false;
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error('配置文件不存在：' + explicit);
    file = explicit;
  } else if (fs.existsSync(DEFAULT_CONFIG)) {
    file = DEFAULT_CONFIG;
  } else {
    file = EXAMPLE_CONFIG;
    fallback = true;
  }
  const defaults = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG, 'utf8'));
  const raw = file === EXAMPLE_CONFIG ? defaults : JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = mergeConfig(defaults, raw);
  cfg.__file = file;
  cfg.__fallback = fallback;
  return cfg;
}

const USAGE = [
  '用法：node writers/profile-writer.mjs [选项]',
  '',
  'data/profile.json 的唯一写入者：新卡一律 proposed，至少等一夜才复核；',
  '复核四条全过才转 active，插件标了 degrade 的 active 卡转 disputed。不调用 WeKnora。',
  '',
  '选项：',
  '  --config <path>    配置文件；默认 writers/writer.config.json，缺省回落到 config.example.json',
  '  --review           跑一夜的复核（proposed -> active / active -> disputed）',
  '  --write            真正落盘；不加则一律 dry-run（只打印计划与 diff）',
  '  --dry-run          显式 dry-run（默认行为，便于脚本统一传参）',
  '  --propose <text>   提议一张新卡（status=proposed，proposedAt=今天）',
  '  --kind <user|agent>  提议的卡类型，默认 user',
  '  --source <ref>     提议卡的来源（必填，如 m00123）',
  '  --id <id>          指定卡 id；默认 kind + 正文 sha1 前 8 位',
  '  --approve <ids>    人工批准，逗号分隔',
  '  --reject <ids>     人工驳回（转 disputed），逗号分隔',
  '  --no-degrade       本轮不做降级，只报告',
  '  --profile <path>   覆盖 config.profile.path（相对包根的相对路径或绝对路径）',
  '  --stats <path>     覆盖 config.profile.statsPath',
  '  --verbose          打印配置解析与预算明细',
  '  -h, --help         打印本帮助并退出 0',
  '',
  '退出码：0 成功；1 运行期失败（配置/IO）；2 参数或提议校验失败。',
].join('\n');

/** 配置里的相对路径按包根目录解析；命令行覆盖值按调用者当前目录解析。 */
function resolvePath(value, { fromRoot }) {
  const text = String(value || '');
  if (!text) return '';
  return fromRoot ? path.resolve(ROOT, text) : path.resolve(text);
}

function cli(argv) {
  const flag = (name) => argv.includes(name);
  const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? String(argv[i + 1] ?? '') : ''; };
  if (flag('--help') || flag('-h')) {
    console.log(USAGE);
    return 0;
  }
  let cfg;
  try {
    cfg = loadConfig(value('--config'));
  } catch (error) {
    console.error('[fail] ' + (error?.message || error));
    return 1;
  }
  const profilePath = value('--profile') ? resolvePath(value('--profile'), { fromRoot: false }) : resolvePath(cfg.profile?.path || 'data/profile.json', { fromRoot: true });
  const statsPath = value('--stats') ? resolvePath(value('--stats'), { fromRoot: false }) : resolvePath(cfg.profile?.statsPath || 'data/profile-stats.json', { fromRoot: true });
  if (flag('--verbose')) {
    console.log('[config] ' + cfg.__file + (cfg.__fallback ? '（未找到 writer.config.json，回落到 config.example.json 的默认值）' : ''));
    console.log('[config] profile=' + profilePath + ' stats=' + statsPath);
  }
  const result = run({
    profilePath,
    statsPath,
    dryRun: !flag('--write'),
    propose: flag('--propose') ? value('--propose') : undefined,
    kind: value('--kind') || 'user',
    id: value('--id') || undefined,
    source: value('--source') || undefined,
    core: !flag('--no-core'),
    review: flag('--review'),
    degrade: !flag('--no-degrade'),
    approve: value('--approve') ? value('--approve').split(',').map((id) => id.trim()).filter(Boolean) : [],
    reject: value('--reject') ? value('--reject').split(',').map((id) => id.trim()).filter(Boolean) : [],
  });
  const mode = flag('--write') ? 'write' : 'dry-run';
  console.log('[' + mode + '] profile=' + (result.profilePath || profilePath));
  if (!result.ok) {
    console.log('[fail] ' + result.error);
    return 2;
  }
  for (const decision of result.decisions) console.log('[card] ' + decision.id + ' ' + decision.action + ' (' + decision.reason + ')');
  const report = result.degradeReport;
  console.log('[degrade] 具备降级资格（插件 degrade 标记）' + report.eligible + ' 张，实际降级 ' + report.degraded
    + ' 张；仅 missStreak≥' + DEGRADE_AFTER + ' 且无标记的候选 ' + report.candidates + ' 张（status 不变）');
  const budget = result.budget;
  if (budget) {
    const d = budget.dropped;
    const loses = ['status', 'kind', 'notCore', 'quota', 'chars', 'maxCards'].filter((name) => d[name]).map((name) => name + '=' + d[name]).join(' ');
    console.log('[budget] user ' + budget.count.user + '/' + budget.caps.perKindMax.user + ' 张 ' + budget.chars.user + '/' + budget.caps.chars.user
      + ' 字；agent ' + budget.count.agent + '/' + budget.caps.perKindMax.agent + ' 张 ' + budget.chars.agent + '/' + budget.caps.chars.agent
      + ' 字；未进块 ' + (loses || '无'));
  }
  console.log(result.diff ? '[diff]\n' + result.diff : '[diff] (none)');
  console.log(result.written ? '[write] ' + result.profilePath : '[dry-run] nothing written');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = cli(process.argv.slice(2));
  if (STATUSES.size === 0) process.exitCode = 1;
}
