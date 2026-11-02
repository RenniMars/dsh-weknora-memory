#!/usr/bin/env node
// 夜间做梦（写侧，可选）：自动裁决事实卡之间的取代/冲突/重复，只改 header 里的状态字段，正文逐字保留。
// 五阶段：S0 收拢 -> S1 分组 -> S2 裁决 -> S3 落账 -> S4 报告。
// 契约见 writers/README.md：配置走 writer.config.json 或 --config，HTTP 只走 ../lib/weknora.js 的 request()。
// --dry-run：跑完整流程（含 LLM 裁决），只打印计划，不写库、不写 state、不写报告、不写日志。
// --no-llm ：一次 LLM 请求都不发（配合 --dry-run 做零成本演练）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request } from '../lib/weknora.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_CONFIG = path.join(HERE, 'writer.config.json');
const EXAMPLE_CONFIG = path.join(HERE, 'config.example.json');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const argVal = (n) => { const i = argv.indexOf(n); return i >= 0 ? String(argv[i + 1] ?? '') : ''; };

const DRY = flag('--dry-run') || flag('--dry');
const NO_LLM = flag('--no-llm');
const VERBOSE = flag('--verbose');
const SELF_TEST = flag('--self-test');
const THEN_PROFILE = flag('--then-profile');
const CONFIG_ARG = argVal('--config');

const USAGE = [
  '用法：node writers/dream.mjs [选项]',
  '',
  '夜间事实卡裁决：只改 header 里的 status / superseded_by，正文逐字节保留。',
  '不新建文档、不删除文档。',
  '',
  '选项：',
  '  --config <path>   配置文件；默认 writers/writer.config.json，缺省回落到 config.example.json',
  '  --dry-run         只打印计划：不写库、不写 state、不写报告（--dry 同义）',
  '  --no-llm          一次 LLM 请求都不发（配合 --dry-run 做零成本演练）',
  '  --verbose         打印每次裁决的完整 prompt 与配置解析结果',
  '  --then-profile    落账成功后紧接着跑 profile-writer.mjs --review --write（dry-run 下不做）',
  '  --self-test       用内置样本跑「裁决 -> 改动计划」映射，不调 API、不写任何文件',
  '  -h, --help        打印本帮助并退出 0',
  '',
  '退出码：0 成功；1 运行期失败（配置/网络/解析）；2 有落账未通过复核；3 落账被 maxUpdates 打断。',
].join('\n');

if (flag('--help') || flag('-h')) {
  console.log(USAGE);
  process.exit(0);
}

// ---------- 配置 ----------
/** 两层浅合并：example 提供默认值，用户配置只覆盖它写了的部分。 */
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
  // 凭证只从环境变量取：配置文件里的 apiKey 一律忽略，避免明文密钥进仓库。
  const fromFile = typeof cfg.apiKey === 'string' && cfg.apiKey ? cfg.apiKey : '';
  cfg.apiKey = process.env.WEKNORA_API_KEY || '';
  cfg.__file = file;
  cfg.__fallback = fallback;
  cfg.__ignoredFileKey = fromFile !== '';
  return cfg;
}

let CFG;
try {
  CFG = loadConfig(CONFIG_ARG);
} catch (error) {
  console.error('[fail] ' + (error?.message || error));
  process.exit(1);
}

const D = CFG.dream || {};
const API_KEY_PRESENT = CFG.apiKey !== '';
const KB_ID = String(CFG.kbs?.knowledge || '');
const KB = encodeURIComponent(KB_ID);
const PREFIX = String(D.titlePrefix || '[fact] ');
const MAX_LLM = Math.max(0, Number(process.env.DREAM_MAX_LLM || D.maxLlmCalls) || 0);
const MAX_UPDATES = Math.max(0, Number(process.env.DREAM_MAX_UPDATES || D.maxUpdates) || 0);
const GRP = Object.assign({ searchTopK: 5, queryChars: 120, sameRootScore: 0.5, crossRootScore: 0.6, maxCluster: 5 }, D.grouping || {});
const REPORT_DIR = path.resolve(ROOT, String(D.reportDir || 'logs/dream'));
const STATE_PATH = path.resolve(ROOT, String(D.statePath || 'data/dream-state.json'));
const LOG_PATH = path.resolve(ROOT, String(D.logPath || 'logs/dream.log'));
const PARSE_TIMEOUT_MS = (Number(D.parseTimeoutSec) || 180) * 1000;
const LLM_TIMEOUT_MS = Number(CFG.llm?.timeoutMs) || 240000;
const REQUEST_TIMEOUT_MS = Number(CFG.requestTimeoutMs) || 30000;

// ---------- 通用 ----------
const pad = (n) => String(n).padStart(2, '0');
const fmtDay = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const fmtTs = (ms) => { const d = new Date(ms); return fmtDay(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const sha1 = (s) => crypto.createHash('sha1').update(String(s), 'utf8').digest('hex');
const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n) + '…'; };
const BT = String.fromCharCode(96);
const FENCE = BT + BT + BT;

const lines = [];
function log(msg) {
  lines.push(msg);
  console.log(msg);
  if (DRY) return;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, new Date().toISOString() + ' ' + msg + '\n', 'utf8');
  } catch { /* 日志写不进去不该让这一夜失败 */ }
}

function reasonText(res) {
  return String(res.reason || 'unknown') + (res.status ? ' (HTTP ' + res.status + ')' : '');
}

async function api(method, ep, body, opts = {}) {
  const res = await request(CFG, method, ep, {
    body,
    timeoutMs: opts.timeoutMs ?? REQUEST_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
    expect: opts.expect,
  });
  if (!res.ok) throw new Error(method + ' ' + ep + ' -> ' + reasonText(res));
  return res.body;
}

// ---------- state ----------
const state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : {};
state.version = 1;
state.groups = state.groups || {};
state.counters = Object.assign({ runs: 0, llmCallsTotal: 0, updatesTotal: 0 }, state.counters || {});
state.history = state.history || [];
const saveState = () => { if (DRY) return; fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8'); };

// ---------- 卡解析（契约 v1：第 1 行是 header 注释行） ----------
const HEADER_RE = /^<!--\s*fact\s+(\{[\s\S]*\})\s*-->\s*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function splitContent(content) {
  const nl = content.indexOf('\n');
  if (nl < 0) return { head: content, rest: '' };
  return { head: content.slice(0, nl), rest: content.slice(nl) };
}

// 解析失败（无 header / JSON 坏 / 缺必填字段）= legacy 或坏卡：一律跳过，绝不当成卡。
function parseCard(doc, content) {
  const { head } = splitContent(content);
  const m = HEADER_RE.exec(head.replace(/\r$/, ''));
  if (!m) return { ok: false, why: '无 fact header（legacy 或坏卡）' };
  let f;
  try { f = JSON.parse(m[1]); } catch (e) { return { ok: false, why: 'header JSON 解析失败: ' + e.message }; }
  if (!f || typeof f !== 'object') return { ok: false, why: 'header 不是对象' };
  if (typeof f.subject !== 'string' || !f.subject) return { ok: false, why: 'header 缺 subject' };
  if (!['active', 'superseded', 'disputed'].includes(f.status)) return { ok: false, why: 'header status 非法: ' + JSON.stringify(f.status) };
  if (!DATE_RE.test(String(f.valid_from || ''))) return { ok: false, why: 'header valid_from 非法: ' + JSON.stringify(f.valid_from) };
  const body = content.split('\n').map(s => s.trim());
  const claim = body.find(s => s && !s.startsWith('<!--') && !s.startsWith('#') && !s.startsWith('证据：')) || '';
  const title = String(doc.title || '');
  return { ok: true, fields: f, claim, shortTitle: title.startsWith(PREFIX) ? title.slice(PREFIX.length) : title, root: f.subject.split('.')[0] };
}

function buildHeader(fields) {
  return '<!-- fact ' + JSON.stringify(fields) + ' -->';
}

// ---------- S0 收拢 ----------
async function listAllDocs() {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const j = await api('GET', '/knowledge-bases/' + KB + '/knowledge?page=' + page + '&page_size=100');
    const data = (j && j.data) || [];
    out.push(...data);
    if (data.length < 100) break;
  }
  return out;
}

async function loadCards() {
  const docs = await listAllDocs();
  const cardDocs = docs.filter(d => String(d.title || '').startsWith(PREFIX));
  const cards = [];
  const skipped = [];
  for (const d of cardDocs) {
    try {
      const j = await api('GET', '/knowledge/' + encodeURIComponent(d.id));
      const dd = (j && j.data) || {};
      const content = ((dd.metadata || {}).content) || '';
      if (!content) { skipped.push({ id: d.id, title: d.title, why: 'metadata.content 为空，跳过（绝不当成卡）' }); continue; }
      const p = parseCard(d, content);
      if (!p.ok) { skipped.push({ id: d.id, title: d.title, why: p.why }); continue; }
      cards.push({
        id: d.id, title: String(d.title || ''), content, fields: p.fields, claim: p.claim,
        shortTitle: p.shortTitle, root: p.root, validFrom: String(p.fields.valid_from),
        beforeSha: sha256(content)
      });
    } catch (e) {
      skipped.push({ id: d.id, title: d.title, why: 'GET 失败: ' + e.message });
    }
  }
  return { docs, cardDocs, cards, skipped };
}

// ---------- S1 分组：根前缀粗分组 + 库内检索形成候选组 ----------
async function searchNear(claim) {
  const j = await api('POST', '/knowledge-search', {
    query: String(claim).slice(0, GRP.queryChars),
    knowledge_base_ids: [KB_ID],
    max_results: GRP.searchTopK
  });
  const out = new Map();
  for (const h of ((j && j.data) || [])) {
    const id = String(h.knowledge_id || '');
    if (!id) continue;
    const s = Number(h.score || 0);
    if (!out.has(id) || s > out.get(id)) out.set(id, s);
  }
  return out;
}

class UnionFind {
  constructor(keys) { this.p = new Map(keys.map(k => [k, k])); }
  find(x) {
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r);
    while (this.p.get(x) !== r) { const n = this.p.get(x); this.p.set(x, r); x = n; }
    return r;
  }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(ra, rb); }
}

async function buildClusters(cards) {
  const byId = new Map(cards.map(c => [c.id, c]));
  const edge = new Map();
  for (const c of cards) {
    let hits;
    try { hits = await searchNear(c.claim); } catch (e) { log('[warn] knowledge-search 失败（' + c.fields.subject + '）: ' + e.message); continue; }
    for (const [id, s] of hits) {
      if (id === c.id || !byId.has(id)) continue;
      edge.set(c.id + '|' + id, s);
    }
  }
  const getEdge = (a, b) => edge.get(a + '|' + b) || 0;
  const uf = new UnionFind(cards.map(c => c.id));
  const pairNotes = [];
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i], b = cards[j];
      const sab = getEdge(a.id, b.id), sba = getEdge(b.id, a.id);
      if (!sab && !sba) continue;
      const same = a.root === b.root;
      const merged = same ? Math.max(sab, sba) >= GRP.sameRootScore : Math.min(sab, sba) >= GRP.crossRootScore;
      if (merged) {
        uf.union(a.id, b.id);
        pairNotes.push({ a: a.fields.subject, b: b.fields.subject, sab: Number(sab.toFixed(3)), sba: Number(sba.toFixed(3)), sameRoot: same });
      } else if (!same && Math.max(sab, sba) >= GRP.crossRootScore) {
        // 跨根只认双向命中；单边高分不合并，但记一笔，免得静默漏掉真冲突。
        log('[S1] 跨根单边命中未合并 ' + a.fields.subject + ' <-> ' + b.fields.subject + ' （' + sab.toFixed(3) + ' / ' + sba.toFixed(3) + '）');
      }
    }
  }
  const buckets = new Map();
  for (const c of cards) {
    const r = uf.find(c.id);
    if (!buckets.has(r)) buckets.set(r, []);
    buckets.get(r).push(c);
  }
  const clusters = [...buckets.values()].filter(g => g.length >= 2);
  const oversized = [];
  for (const g of clusters) {
    g.sort((x, y) => (y.validFrom.localeCompare(x.validFrom)) || x.id.localeCompare(y.id));
    if (g.length > GRP.maxCluster) { oversized.push({ root: g[0].root, size: g.length }); g.splice(GRP.maxCluster); }
  }
  return { clusters, pairNotes, oversized };
}

function fingerprintOf(members) {
  const parts = members.map(c => c.id + '|' + c.validFrom + '|' + sha1(c.claim).slice(0, 8)).sort();
  return sha1(parts.join(';')).slice(0, 16);
}

// ---------- S2 裁决 ----------
let llmCalls = 0;
let llmAborted = '';

/**
 * 一次裁决：建一个 WeKnora 会话，再走 knowledge-chat 的 SSE。
 * SSE 是纯文本，request() 只会 json()：这里用 fetchImpl 抓住原始响应文本，
 * 请求头与错误映射仍然全部由 lib/weknora.js 决定。
 */
async function chatOnce(chatSessionId, prompt) {
  const held = { text: '' };
  const fetchImpl = async (url, init) => {
    const response = await fetch(url, init);
    held.text = await response.text();
    return { ok: response.ok, status: response.status, json: async () => ({}) };
  };
  const res = await request(CFG, 'POST', '/knowledge-chat/' + encodeURIComponent(chatSessionId), {
    body: { query: prompt, knowledge_base_ids: [], agent_enabled: false, web_search_enabled: false },
    timeoutMs: LLM_TIMEOUT_MS,
    fetchImpl
  });
  if (!res.ok) throw new Error('knowledge-chat -> ' + reasonText(res));
  let text = '';
  for (const line of held.text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    let o;
    try { o = JSON.parse(line.slice(5).trim()); } catch { continue; }
    if (o.response_type === 'answer' && typeof o.content === 'string') text += o.content;
    if (o.response_type === 'error') throw new Error('LLM error event: ' + JSON.stringify(o).slice(0, 200));
  }
  return text;
}

async function llmOnce(prompt) {
  if (NO_LLM) throw new Error('--no-llm：本轮禁止调用 LLM');
  if (llmCalls >= MAX_LLM) throw new Error('LLM 预算用尽：' + llmCalls + '/' + MAX_LLM + '（config.dream.maxLlmCalls）');
  llmCalls++;
  const sj = await api('POST', '/sessions', { title: 'dream ' + new Date().toISOString().slice(0, 16) }, { timeoutMs: LLM_TIMEOUT_MS });
  const chatSessionId = sj && sj.data && sj.data.id;
  if (!chatSessionId) throw new Error('创建 WeKnora 会话失败: ' + JSON.stringify(sj).slice(0, 200));
  return chatOnce(chatSessionId, prompt);
}

function buildJudgePrompt(members) {
  const list = members.map((c, i) => [
    '[' + (i + 1) + '] 标题: ' + c.title,
    '    subject: ' + c.fields.subject,
    '    valid_from: ' + c.validFrom,
    '    status: ' + c.fields.status,
    '    claim: ' + c.claim
  ].join('\n')).join('\n\n');
  return [
    '你是记忆库的事实卡裁决器。下面是一组主题相近的事实卡，每张卡是一个独立文档。',
    '只需要判断这几张卡之间的语义关系，输出一行结论 + 不超过 20 字的理由。',
    '',
    '结论只能取以下五个之一（照抄英文单词）：',
    'NEWER_SUPERSEDES: <被取代的卡片标题>  同一事实有了更新版本，旧卡的整体结论已被新卡推翻或更新',
    'CONFLICT   两张卡的结论互相矛盾，且无法判断谁更新更对',
    'DUPLICATE  同一事实被重复记录，信息等价',
    'COMPLEMENT 各说一面，合起来更完整，不冲突',
    'KEEP_ALL   主题相近但各自独立，互不影响',
    '',
    '额外硬规则：',
    '1) NEWER_SUPERSEDES 只在「保留卡 valid_from 严格晚于被取代卡」且两张卡讲同一件事时使用；日期相同或更早一律不许用。',
    '2) 两张卡讲不同主题、互不影响 -> 必须 KEEP_ALL，不许用 NEWER_SUPERSEDES。',
    '3) 被取代的标题必须原样来自下面列表里某一行的标题，不许编造或截断。',
    '',
    '输出格式：第 1 行 = 结论（NEWER_SUPERSEDES 时必须原样复制被取代卡片的「标题」，含 [fact] 前缀）；第 1 行末尾空一格写不超过 20 字的理由。',
    '不要输出第 2 行，不要代码块，不要解释过程。',
    '',
    '示例：',
    'NEWER_SUPERSEDES: [fact] env.endpoints · 记忆栈端口 端口号已由新卡更新',
    'COMPLEMENT 一个讲链路一个讲口径',
    '',
    '卡片列表：',
    list
  ].join('\n');
}

const normKey = (s) => String(s || '').toLowerCase().replace(/[\u0060\[\]\s"'“”‘’·—\-_/\\|:：,，.。()（）]/g, '');

function parseVerdict(raw) {
  for (const line of String(raw || '').split('\n')) {
    const t = line.trim().replace(/^\*+|\*+$/g, '');
    if (!t) continue;
    const m = /^(NEWER_SUPERSEDES|CONFLICT|DUPLICATE|COMPLEMENT|KEEP_ALL)\s*[：:]?\s*(.*)$/i.exec(t);
    if (!m) continue;
    const verdict = m[1].toUpperCase();
    const rest = m[2].trim().replace(/[\u0060"']/g, '');
    return { verdict, rest, reason: rest.trim() };
  }
  return { verdict: '', rest: '', reason: '', raw: String(raw || '').slice(0, 200) };
}

// 把模型给的目标标题对回组内成员：精确 -> 去前缀包含 -> bigram 兜底。
function resolveTarget(rest, members) {
  const cand = String(rest || '').replace(/^\[fact\]\s*/i, '').trim();
  if (!cand) return null;
  const kc = normKey(cand);
  let hit = members.find(c => c.title === cand)
    || members.find(c => normKey(c.shortTitle) === kc)
    || members.find(c => normKey(c.title) === kc);
  if (hit) return hit;
  hit = members.find(c => { const k = normKey(c.shortTitle); return k && (kc.startsWith(k) || k.startsWith(kc) || kc.includes(k)); });
  if (hit) return hit;
  let best = null, bestScore = 0;
  for (const c of members) {
    const a = normKey(c.shortTitle);
    const A = new Set();
    for (let i = 0; i + 1 < a.length; i++) A.add(a.slice(i, i + 2));
    let inter = 0;
    for (let i = 0; i + 1 < kc.length; i++) if (A.has(kc.slice(i, i + 2))) inter++;
    const denom = Math.max(1, Math.min(a.length, kc.length) - 1);
    const score = inter / denom;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= 0.5 ? best : null;
}

// ---------- 裁决 -> 改动计划 ----------
function planChanges(members, verdictInfo) {
  const v = verdictInfo.verdict;
  const changes = [];
  if (!v) return { changes, note: '未知结论，按 KEEP_ALL 处理' };
  if (v === 'KEEP_ALL' || v === 'COMPLEMENT') return { changes, note: '' };
  if (v === 'NEWER_SUPERSEDES') {
    const old = verdictInfo.target;
    if (!old) return { changes, note: '目标标题无法对回组内成员，按 KEEP_ALL 处理（不猜）' };
    const rest = members.filter(c => c.id !== old.id);
    if (!rest.length) return { changes, note: 'NEWER_SUPERSEDES 但没有其它成员可作为新卡，按 KEEP_ALL 处理' };
    const newer = rest[0];
    // 只认严格更新的证据：valid_from 相等或倒挂都视为「没有更新」，一律不改。
    if (!(newer.validFrom > old.validFrom)) return { changes, note: '保留卡 valid_from ' + newer.validFrom + ' 不晚于被取代卡 ' + old.validFrom + '，无「更新」证据，按 KEEP_ALL 处理' };
    changes.push({ card: old, status: 'superseded', supersededBy: newer.shortTitle, why: '被「' + newer.shortTitle + '」取代' });
    return { changes, note: '' };
  }
  if (v === 'DUPLICATE') {
    const keep = members[0];
    for (const c of members.slice(1)) changes.push({ card: c, status: 'superseded', supersededBy: keep.shortTitle, why: '与「' + keep.shortTitle + '」重复，保留排名靠前者' });
    return { changes, note: '' };
  }
  if (v === 'CONFLICT') {
    for (const c of members) changes.push({ card: c, status: 'disputed', supersededBy: String(c.fields.superseded_by || ''), why: '组内结论互相矛盾，双方标 disputed' });
    return { changes, note: '' };
  }
  return { changes, note: '未识别结论 ' + v };
}

// ---------- S3 落账 ----------
let updates = 0;
let updateAborted = '';

async function waitParsed(id) {
  const deadline = Date.now() + PARSE_TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    const j = await api('GET', '/knowledge/' + encodeURIComponent(id));
    const d = (j && j.data) || {};
    last = d.parse_status || '';
    if (last === 'completed') return { status: last };
    if (last === 'failed' || last === 'error') return { status: last, error: d.error_message || '' };
    await new Promise(r => setTimeout(r, 1500));
  }
  return { status: 'timeout(' + last + ')' };
}

async function chunkTotal(id) {
  const j = await api('GET', '/chunks/' + encodeURIComponent(id) + '?page=1&page_size=1');
  if (j && typeof j.total === 'number') return j.total;
  return Array.isArray(j && j.data) ? j.data.length : 0;
}

async function applyChange(card, status, supersededBy) {
  const { rest } = splitContent(card.content);
  const fields = Object.assign({}, card.fields, { status, superseded_by: supersededBy });
  const newHead = buildHeader(fields);
  const newContent = newHead + rest;
  const beforeSha = card.beforeSha;
  const chunksBefore = await chunkTotal(card.id);
  updates++;
  const j = await api('PUT', '/knowledge/manual/' + encodeURIComponent(card.id), {
    title: card.title, content: newContent, status: 'publish', channel: 'web', file_name: card.title + '.md'
  });
  const putOk = !!(j && j.data && j.data.id);
  const parsed = await waitParsed(card.id);
  const g = await api('GET', '/knowledge/' + encodeURIComponent(card.id));
  const got = ((g.data || {}).metadata || {}).content || '';
  const verify = { sha: sha256(got), bytesEqual: got === newContent, headerEqual: splitContent(got).head === newHead };
  const reParsed = parseCard({ id: card.id, title: card.title }, got);
  verify.statusNow = reParsed.ok ? reParsed.fields.status : 'PARSE_FAIL';
  verify.supersededByNow = reParsed.ok ? String(reParsed.fields.superseded_by || '') : '';
  const chunksAfter = await chunkTotal(card.id);
  const ok = putOk && parsed.status === 'completed' && verify.bytesEqual && verify.headerEqual
    && verify.statusNow === status && verify.supersededByNow === String(supersededBy || '') && chunksAfter >= 1;
  const rec = {
    id: card.id, title: card.title, subject: fields.subject,
    statusBefore: card.fields.status, statusAfter: status,
    supBefore: String(card.fields.superseded_by || ''), supAfter: String(supersededBy || ''),
    shaBefore: beforeSha, shaAfter: verify.sha, bytesEqual: verify.bytesEqual, headerEqual: verify.headerEqual,
    bodyShaBefore: sha256(rest), bodyShaAfter: sha256(splitContent(got).rest), bodyLen: rest.length,
    chunksBefore, chunksAfter, parse: parsed.status, ok
  };
  card.fields = fields;
  card.beforeSha = verify.sha;
  return rec;
}

// ---------- S4 报告 ----------
function buildReport(ctx) {
  const L = [];
  L.push('# 夜间做梦报告 ' + ctx.day);
  L.push('');
  L.push('- 模式：' + (DRY ? 'dry-run（不写库、不写 state、不写报告）' : 'real'));
  L.push('- 知识库：' + KB_ID + '（全部 ' + ctx.totalDocs + ' 篇，其中 ' + PREFIX + ' 卡 ' + ctx.cardDocs.length + ' 张）');
  L.push('- 卡解析：成功 ' + ctx.cards.length + ' 张，跳过 ' + ctx.skipped.length + ' 张');
  L.push('- 候选分组：' + ctx.clusters.length + ' 组；state 命中已判定跳过 ' + ctx.skippedGroups.length + ' 组');
  L.push('- LLM 调用：' + ctx.llmCalls + ' / ' + MAX_LLM + (ctx.llmAborted ? '（' + ctx.llmAborted + '）' : ''));
  L.push('- 文档改动：' + ctx.updates + ' / ' + MAX_UPDATES + (ctx.updateAborted ? '（' + ctx.updateAborted + '）' : ''));
  L.push('- 耗时：' + (ctx.elapsedMs / 1000).toFixed(1) + ' 秒');
  L.push('- 新增卡：无（本工具只改状态，不新建文档、不删除文档）');
  L.push('');
  L.push('## 分组与裁决');
  L.push('');
  if (!ctx.judged.length) { L.push('（无候选组）'); L.push(''); }
  for (const g of ctx.judged) {
    L.push('### 组 ' + g.index + '：' + g.members.map(c => c.fields.subject).join(' + '));
    L.push('');
    L.push('- 成员：' + g.members.map(c => c.fields.subject + '（' + c.validFrom + '，' + c.fields.status + '）').join('；'));
    L.push('- 组内检索边：' + (g.edges || '无'));
    L.push('- 指纹：' + g.fingerprint);
    L.push('- 裁决：**' + (g.verdict || 'NONE') + '**' + (g.reason ? ' —— ' + clip(g.reason, 60) : ''));
    if (g.note) L.push('- 备注：' + g.note);
    L.push('- 计划改动：' + (g.plan.length ? g.plan.map(p => p.card.fields.subject + ' → ' + p.status).join('；') : '不动'));
    L.push('');
  }
  if (ctx.skippedGroups.length) {
    L.push('### state 命中、本轮跳过的组');
    L.push('');
    for (const s of ctx.skippedGroups) L.push('- ' + s.fingerprint + ' ' + s.members + '（上次裁决 ' + s.verdict + '，' + s.at + '）');
    L.push('');
  }
  L.push('## 改动明细');
  L.push('');
  if (!ctx.changes.length) { L.push('（无）'); L.push(''); }
  else {
    L.push('| 文档 id | 标题 | status 前 → 后 | superseded_by 前 → 后 | 正文 sha256 前 → 后 | 正文逐字节相同 | chunks |');
    L.push('|---|---|---|---|---|---|---|');
    for (const c of ctx.changes) {
      L.push('| ' + c.id + ' | ' + c.title + ' | ' + c.statusBefore + ' → ' + c.statusAfter + ' | ' + (c.supBefore || '(空)') + ' → ' + (c.supAfter || '(空)') + ' | ' + c.shaBefore.slice(0, 16) + ' → ' + c.shaAfter.slice(0, 16) + ' | ' + (c.bytesEqual ? '是' : '**否**') + ' | ' + c.chunksBefore + ' → ' + c.chunksAfter + ' |');
    }
    L.push('');
  }
  L.push('## 异常与跳过');
  L.push('');
  const an = [];
  for (const s of ctx.skipped) an.push('- 跳过卡 ' + s.id + ' ' + s.title + '：' + s.why);
  for (const c of ctx.changes) if (!c.ok) an.push('- **写入复核未通过** ' + c.id + ' ' + c.title + '：bytesEqual=' + c.bytesEqual + ' headerEqual=' + c.headerEqual + ' statusNow=' + c.statusAfter + ' parse=' + c.parse);
  if (ctx.llmAborted) an.push('- ' + ctx.llmAborted);
  if (ctx.updateAborted) an.push('- ' + ctx.updateAborted);
  for (const o of ctx.oversized) an.push('- 组超过 maxCluster ' + GRP.maxCluster + '（' + o.root + ' 组 ' + o.size + ' 张），已截断后裁决');
  for (const g of ctx.judged) if (g.note) an.push('- ' + g.members[0].fields.subject + ' 组：' + g.note);
  if (!an.length) an.push('（无）');
  L.push(...an);
  L.push('');
  L.push('## 本次日志');
  L.push('');
  L.push(FENCE);
  L.push(...ctx.logLines);
  L.push(FENCE);
  L.push('');
  return L.join('\n');
}

// ---------- 自检（--self-test）：用内置样本跑「裁决 -> 改动计划」映射，不调 API、不写任何文件 ----------
function selfTest() {
  const mk = (short, subject, vf) => {
    const fields = { v: 1, subject, status: 'active', valid_from: vf, superseded_by: '', confidence: 0.8, session: '', quote: '' };
    return { id: short, title: PREFIX + short, shortTitle: short, fields, claim: '正文', root: subject.split('.')[0], validFrom: vf,
      content: buildHeader(fields) + '\n\n# ' + short + '\n\n正文\n' };
  };
  const oldC = mk('mem.inject · 旧口径', 'mem.inject', '2026-09-13');
  const newC = mk('mem.inject · 新口径', 'mem.inject', '2026-11-01');
  const members = [oldC, newC];
  const judge = (raw) => { const v = parseVerdict(raw); return { verdict: v.verdict, reason: v.reason, target: resolveTarget(v.rest, members) }; };
  const cases = [];
  const sup = planChanges(members, judge('NEWER_SUPERSEDES: mem.inject · 旧口径\n理由：新口径覆盖旧口径'));
  cases.push(['NEWER_SUPERSEDES 指到旧卡 -> 旧卡 superseded 且指向新卡', sup.changes.length === 1 && sup.changes[0].card === oldC && sup.changes[0].status === 'superseded' && sup.changes[0].supersededBy === newC.shortTitle]);
  const bad1 = planChanges(members, judge('NEWER_SUPERSEDES: mem.inject · 新口径'));
  cases.push(['NEWER_SUPERSEDES 指到更新卡 -> 拒绝改动', bad1.changes.length === 0 && /不晚于/.test(bad1.note)]);
  const e1c = mk('oss.a · 甲', 'oss.a', '2026-09-13');
  const e2c = mk('oss.a · 乙', 'oss.a', '2026-09-13');
  const vEq = parseVerdict('NEWER_SUPERSEDES: oss.a · 甲');
  const eq1 = planChanges([e1c, e2c], { verdict: vEq.verdict, reason: vEq.reason, target: resolveTarget(vEq.rest, [e1c, e2c]) });
  cases.push(['valid_from 相等 -> 不许 supersede（等日期误判的回归用例）', eq1.changes.length === 0 && /不晚于/.test(eq1.note)]);
  const dup = planChanges(members, judge('DUPLICATE: 同一件事'));
  cases.push(['DUPLICATE -> 排名靠后者 superseded 指向保留者', dup.changes.length === 1 && dup.changes[0].card === newC && dup.changes[0].supersededBy === oldC.shortTitle]);
  const con = planChanges(members, judge('CONFLICT: 互相矛盾'));
  cases.push(['CONFLICT -> 双方 disputed', con.changes.length === 2 && con.changes.every(c => c.status === 'disputed')]);
  cases.push(['COMPLEMENT -> 不动', planChanges(members, judge('COMPLEMENT: 互补')).changes.length === 0]);
  cases.push(['KEEP_ALL -> 不动', planChanges(members, judge('KEEP_ALL: 无关')).changes.length === 0]);
  cases.push(['无法识别的回复 -> 按 KEEP_ALL', planChanges(members, judge('我觉得都挺好')).changes.length === 0]);
  const f2 = Object.assign({}, oldC.fields, { status: 'superseded', superseded_by: 'X' });
  const h2 = buildHeader(f2); const m2 = HEADER_RE.exec(h2);
  cases.push(['header 渲染 -> 解析 往返一致', !!m2 && JSON.stringify(JSON.parse(m2[1])) === JSON.stringify(f2)]);
  cases.push(['正文切分不含 header', splitContent(oldC.content).rest === '\n\n# mem.inject · 旧口径\n\n正文\n']);
  let bad = 0;
  for (const [name, ok] of cases) { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) bad++; }
  console.log('self-test ' + (cases.length - bad) + '/' + cases.length + ' passed');
  return bad ? 1 : 0;
}

// ---------- 主流程 ----------
async function main() {
  const t0 = Date.now();
  const day = fmtDay(new Date());
  if (VERBOSE) {
    console.log('[config] ' + CFG.__file + (CFG.__fallback ? '（未找到 writer.config.json，回落到 config.example.json 的默认值）' : ''));
    console.log('[config] apiUrl=' + String(CFG.apiUrl || '(空)') + ' apiKey=' + (API_KEY_PRESENT ? '(来自 WEKNORA_API_KEY)' : '(未设置)')
      + (CFG.__ignoredFileKey ? ' 配置文件里的 apiKey 已忽略' : ''));
    console.log('[config] kb=' + (KB_ID || '(空)') + ' prefix=' + JSON.stringify(PREFIX) + ' maxLlm=' + MAX_LLM + ' maxUpdates=' + MAX_UPDATES);
    console.log('[config] state=' + STATE_PATH + ' reportDir=' + REPORT_DIR);
  }
  if (!KB_ID) throw new Error('config.kbs.knowledge 为空：没有可裁决的知识库');
  log('== dream start ' + fmtTs(t0) + (DRY ? ' [DRY-RUN]' : '') + (NO_LLM ? ' [NO-LLM]' : '') + ' maxLlm=' + MAX_LLM + ' maxUpdates=' + MAX_UPDATES);

  const { docs, cardDocs, cards, skipped } = await loadCards();
  log('[S0] 知识库文档 ' + docs.length + ' 篇，' + PREFIX + '卡片 ' + cardDocs.length + ' 张，解析成功 ' + cards.length + '，跳过 ' + skipped.length);
  for (const s of skipped) log('[S0] 跳过 ' + String(s.id).slice(0, 8) + ' ' + clip(s.title, 40) + '：' + s.why);

  if (D.enabled === false) {
    log('[stop] config.dream.enabled=false，未做任何判定');
    return 0;
  }

  const { clusters, pairNotes, oversized } = await buildClusters(cards);
  log('[S1] 组内检索 ' + cards.length + ' 次，形成候选组 ' + clusters.length + ' 个' + (oversized.length ? '（' + oversized.length + ' 组超限被截断）' : ''));
  for (const p of pairNotes) log('[S1] 边 ' + p.a + ' <-> ' + p.b + ' （' + p.sab + ' / ' + p.sba + '，' + (p.sameRoot ? '同根' : '跨根') + '）');

  const judged = [];
  const skippedGroups = [];
  const changes = [];
  for (let gi = 0; gi < clusters.length; gi++) {
    const members = clusters[gi];
    const fp = fingerprintOf(members);
    const subj = members.map(c => c.fields.subject);
    const edges = pairNotes.filter(p => subj.includes(p.a) && subj.includes(p.b)).map(p => p.a + '/' + p.b + ' ' + p.sab + '·' + p.sba).join('；');
    const prev = state.groups[fp];
    if (prev) {
      skippedGroups.push({ fingerprint: fp, members: subj.join(' + '), verdict: prev.verdict, at: prev.at });
      log('[S2] 组 ' + (gi + 1) + ' 指纹 ' + fp + ' 已判定过（' + prev.at + ' ' + prev.verdict + '），跳过');
      continue;
    }
    if (llmAborted) { log('[S2] 组 ' + (gi + 1) + ' 未裁决：' + llmAborted); continue; }
    let verdictInfo = { verdict: '', reason: '', target: null, raw: '' };
    try {
      const prompt = buildJudgePrompt(members);
      if (VERBOSE) console.log('\n--- PROMPT ---\n' + prompt + '\n--- END PROMPT ---\n');
      const raw = await llmOnce(prompt);
      verdictInfo = parseVerdict(raw);
      verdictInfo.raw = String(raw || '');
      if (verdictInfo.verdict === 'NEWER_SUPERSEDES') verdictInfo.target = resolveTarget(verdictInfo.rest, members);
      log('[S2] 组 ' + (gi + 1) + ' ' + subj.join('+') + ' => ' + (verdictInfo.verdict || 'NONE') + (verdictInfo.target ? ' 目标=' + verdictInfo.target.fields.subject : '') + (verdictInfo.reason ? ' 理由=' + clip(verdictInfo.reason, 40) : ''));
    } catch (e) {
      const msg = e.message || String(e);
      if (/预算用尽|maxLlmCalls/.test(msg)) llmAborted = msg;
      log('[S2] 组 ' + (gi + 1) + ' 裁决失败：' + msg);
      judged.push({ index: gi + 1, members, edges, fingerprint: fp, verdict: '', reason: msg, note: '裁决失败', plan: [], raw: '' });
      continue;
    }
    const planRes = planChanges(members, verdictInfo);
    const plan = planRes.changes.map(p => ({ card: p.card, status: p.status, supersededBy: p.supersededBy, why: p.why }));
    judged.push({ index: gi + 1, members, edges, fingerprint: fp, verdict: verdictInfo.verdict || 'NONE', reason: verdictInfo.reason, note: planRes.note, plan, raw: verdictInfo.raw });
    if (!DRY) {
      state.groups[fp] = {
        at: fmtTs(Date.now()), verdict: verdictInfo.verdict || 'NONE', reason: clip(verdictInfo.reason, 60),
        members: members.map(c => ({ id: c.id, subject: c.fields.subject, valid_from: c.validFrom })),
        planned: plan.map(p => ({ id: p.card.id, status: p.status, superseded_by: p.supersededBy }))
      };
      saveState();
    }
  }

  const finalPlan = new Map();
  for (const g of judged) for (const p of g.plan) finalPlan.set(p.card.id, p);
  const planned = [...finalPlan.values()];
  for (const p of planned) {
    const needStatus = p.status !== p.card.fields.status;
    const needSup = String(p.supersededBy || '') !== String(p.card.fields.superseded_by || '');
    p.noop = !needStatus && !needSup;
  }
  log('[S2] 判定计划 ' + planned.length + ' 条，其中无需改动的 ' + planned.filter(p => p.noop).length + ' 条');

  if (DRY) {
    console.log('\n===== DRY-RUN 计划（不写库、不写 state、不写报告） =====');
    console.log('候选组 ' + judged.length + ' 个（另有 ' + skippedGroups.length + ' 组因 state 指纹已判定过而跳过）');
    for (const g of judged) {
      console.log('\n--- 组 ' + g.index + '：' + g.members.map(c => c.fields.subject).join(' + ') + ' ---');
      console.log('  指纹  : ' + g.fingerprint);
      console.log('  检索边: ' + (g.edges || '无'));
      for (const c of g.members) console.log('  成员  : ' + c.fields.subject + ' | ' + c.validFrom + ' | ' + c.fields.status + ' | ' + c.shortTitle);
      console.log('  裁决  : ' + g.verdict + (g.reason ? '  —— ' + clip(g.reason, 60) : ''));
      if (g.note) console.log('  备注  : ' + g.note);
      console.log('  计划  : ' + (g.plan.length ? g.plan.map(p => p.card.fields.subject + ' → ' + p.status + (p.supersededBy ? '（superseded_by=' + p.supersededBy + '）' : '')).join('；') : '不动'));
    }
    console.log('\n--- 待写文档 ' + planned.filter(p => !p.noop).length + ' 篇（上限 ' + MAX_UPDATES + '）---');
    for (const p of planned) {
      console.log('  ' + (p.noop ? '[skip] ' : '[plan] ') + p.card.id + ' | ' + p.card.fields.subject + ' | ' + p.card.fields.status + ' → ' + p.status + ' | superseded_by "' + String(p.card.fields.superseded_by || '') + '" → "' + String(p.supersededBy || '') + '" | ' + p.why);
    }
    console.log('\nLLM 调用 ' + llmCalls + ' / ' + MAX_LLM + '，PUT 0 次（dry-run），耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');
    console.log('===== END DRY-RUN =====');
    return 0;
  }

  // S3 落账
  for (const p of planned) {
    if (p.noop) { log('[S3] 跳过 ' + p.card.fields.subject + '：header 已是目标状态'); continue; }
    if (updates >= MAX_UPDATES) { updateAborted = '已达 maxUpdates ' + MAX_UPDATES + '，停止写入'; log('[S3] ' + updateAborted); break; }
    try {
      const before = p.card.fields.status + '/' + String(p.card.fields.superseded_by || '');
      const rec = await applyChange(p.card, p.status, p.supersededBy);
      changes.push(rec);
      log('[S3] ' + (rec.ok ? 'ok ' : 'WARN ') + p.card.fields.subject + ' ' + before + ' -> ' + rec.statusAfter + '/' + rec.supAfter +
        ' 正文相同=' + rec.bytesEqual + ' sha=' + rec.shaBefore.slice(0, 12) + '→' + rec.shaAfter.slice(0, 12) + ' chunks=' + rec.chunksBefore + '→' + rec.chunksAfter + ' parse=' + rec.parse);
    } catch (e) {
      log('[S3] 写入失败 ' + p.card.id + '：' + e.message);
      changes.push({ id: p.card.id, title: p.card.title, subject: p.card.fields.subject, statusBefore: p.card.fields.status, statusAfter: p.status, supBefore: String(p.card.fields.superseded_by || ''), supAfter: String(p.supersededBy || ''), shaBefore: p.card.beforeSha, shaAfter: '', bytesEqual: false, headerEqual: false, chunksBefore: -1, chunksAfter: -1, parse: 'put-failed', ok: false });
    }
  }

  // S4 报告
  state.counters.runs++;
  state.counters.llmCallsTotal += llmCalls;
  state.counters.updatesTotal += updates;
  state.history.push({ at: fmtTs(Date.now()), day, llmCalls, updates, clusters: clusters.length, changes: changes.length, elapsedMs: Date.now() - t0 });
  state.history = state.history.slice(-30);
  saveState();

  const elapsedMs = Date.now() - t0;
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, 'dream-' + day + '.md');
  fs.writeFileSync(reportPath, buildReport({
    day, totalDocs: docs.length, cardDocs, cards, skipped, clusters, judged, skippedGroups,
    changes, oversized, elapsedMs, llmCalls, llmAborted, updates, updateAborted, logLines: lines.slice(0, 200)
  }), 'utf8');

  const changedSubjects = changes.filter(c => c.ok).map(c => c.subject + '→' + c.statusAfter);
  console.log('');
  console.log('1) dream 完成：候选组 ' + clusters.length + '（已判定跳过 ' + skippedGroups.length + '），LLM ' + llmCalls + '/' + MAX_LLM + ' 次，改动 ' + updates + '/' + MAX_UPDATES + ' 篇，耗时 ' + (elapsedMs / 1000).toFixed(1) + ' 秒');
  console.log('2) 改动：' + (changedSubjects.length ? changedSubjects.join('，') : '无（本轮所有组判为 COMPLEMENT/KEEP_ALL 或 header 已是目标状态）'));
  console.log('3) 报告：' + reportPath);
  log('== dream end ' + fmtTs(Date.now()) + ' llm=' + llmCalls + ' updates=' + updates + ' elapsed=' + (elapsedMs / 1000).toFixed(1) + 's');

  // 退出码契约：有任何一条落账失败，或写入被安全阀打断，就以非零退出，
  // 让 run-all.cmd 跳过画像复核——失败的一夜不该把画像改掉。
  const failedChanges = changes.filter((c) => c.ok === false).length;
  if (failedChanges > 0 || updateAborted) {
    log('== dream exit ' + (failedChanges > 0 ? 2 : 3) + ' failedChanges=' + failedChanges + ' updateAborted=' + (updateAborted || 'none'));
    return failedChanges > 0 ? 2 : 3;
  }
  return 0;
}

// 只在被直接执行时运行：import 本模块必须零副作用（writers/README.md 契约）。
const ENTRY = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (ENTRY === import.meta.url) {
  let code = 0;
  try {
    code = SELF_TEST ? selfTest() : await main();
  } catch (error) {
    console.error('[fail] ' + (error?.message || error));
    code = 1;
  }
  if (code === 0 && THEN_PROFILE && !SELF_TEST) {
    if (DRY) {
      console.log('[then-profile] dry-run：跳过 profile-writer');
    } else {
      const args = [path.join(HERE, 'profile-writer.mjs'), '--review', '--write'];
      if (CONFIG_ARG) args.push('--config', CONFIG_ARG);
      const child = spawnSync(process.execPath, args, { stdio: 'inherit' });
      if (child.status !== 0) code = child.status ?? 1;
    }
  }
  process.exit(code);
}
