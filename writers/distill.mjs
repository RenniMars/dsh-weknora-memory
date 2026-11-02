#!/usr/bin/env node
/**
 * writers/distill.mjs —— 已结束的 DSH 会话 → 记忆条目 → WeKnora 库②（kbs.knowledge）。
 *
 * 行为移植自已验证的生产脚本：近期会话按 idle/settle 与 state 的 mtime 筛出候选 → 调 LLM 抽取
 * 结论/约束/偏好/教训/事实 → 校验（kind 白名单、证据必须逐字出现在原文）→ 本地 bigram 去重 →
 * 知识库向量检索复核（同义视为重复、同主题不同结论记为冲突）→ 一条结论一篇文档写入库②。
 *
 * 与 ingest.mjs 共用解析层（walkSessions / extractSession），不再像源脚本那样在运行时把自己的
 * 解析层截取成临时模块——那个做法既写文件又依赖源码文本格式。
 *
 * 契约（writers/README.md）：
 *   - config.apiUrl 已含 /api/v1，路径里不再写版本前缀；
 *   - 一切 HTTP 走 ../lib/weknora.js 的 request()；
 *   - apiKey 只从环境变量 WEKNORA_API_KEY 取；
 *   - 导入本模块不得产生任何副作用，--dry-run 不写库、不写 state、不写任何文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request } from '../lib/weknora.js';
import {
  api, chunkCount, createManualDoc, docText, extractSession, fmtDate, fmtTs, listDocs,
  loadWriterConfig, makeLog, num, parseWriterArgs, waitParsed, walkSessions
} from './ingest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const STATE_PATH = path.join(PKG_ROOT, 'data', 'writer-state', 'distill.json');
const REQUEST_TIMEOUT_MS = 30000;
const SID_TAIL = 8;

const CARD_TITLE_MAX = 60;
const CARD_HARD_CHARS = 600;
const CARD_TARGET_CHARS = 400;
const CARD_NOTE_MAX_LINES = 2;
const CARD_NOTE_MAX_CHARS = 40;
const CARD_QUOTE_MAX = 120;
const CARD_CLAIM_MAX = 80;
const CARD_HEADLINE_MAX = 20;
const MAX_CONFLICTS_KEPT = 500;

const SUBJECT_RE = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*){0,4}$/;
const KINDS = new Set(['decision', 'constraint', 'preference', 'lesson', 'fact']);
const KIND_TITLE = { decision: '决策', constraint: '约束', preference: '偏好', lesson: '教训', fact: '事实' };

const USAGE = [
  '用法: node writers/distill.mjs [选项]',
  '',
  '从最近结束的 DSH 会话里抽结论/约束/偏好/教训/事实，一条一篇文档写入 WeKnora 库②（kbs.knowledge）。',
  '',
  '选项:',
  '  --dry-run            只打印本次计划：不发 LLM 请求、不写知识库、不写 state、不写任何文件',
  '  --config <path>      配置文件路径（默认 writers/writer.config.json，缺失时回退 config.example.json 的默认值）',
  '  --verbose, -v        打印每个候选会话与判定细节',
  '  --limit <n>          本次最多处理 n 个会话（默认 distill.maxSessionsPerRun）',
  '  --since <YYYY-MM-DD> 只处理该日期之后写入过的会话',
  '  --only <substr>      只处理路径里包含 substr 的会话',
  '  --no-llm             一次 LLM 请求都不发（只走读路径）',
  '  --help, -h           打印本帮助并退出',
  '',
  '凭证: apiKey 只从环境变量 WEKNORA_API_KEY 读取；LLM 走 WeKnora 会话网关，不存第二份密钥。',
  '退出码: 0 成功；1 有会话或文档失败；2 配置或连接失败。'
].join('\n');

const shortSid = (sid) => String(sid || '').slice(-SID_TAIL);

// ---------------- state ----------------

function emptyState() {
  return {
    version: 1,
    sessions: {},
    entries: {},
    conflicts: [],
    counters: { llmCalls: 0, sessionsProcessed: 0, docsWritten: 0, runInChars: 0, runOutChars: 0 }
  };
}

function loadState(log) {
  if (!fs.existsSync(STATE_PATH)) return emptyState();
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (!raw || typeof raw !== 'object') throw new Error('不是对象');
    const base = emptyState();
    return {
      version: 1,
      sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
      entries: raw.entries && typeof raw.entries === 'object' ? raw.entries : {},
      conflicts: Array.isArray(raw.conflicts) ? raw.conflicts : [],
      counters: Object.assign({}, base.counters, raw.counters && typeof raw.counters === 'object' ? raw.counters : {})
    };
  } catch (err) {
    log.warn('state 损坏，按空状态继续（仍可按知识库既有条目去重）: ' + STATE_PATH + '（' + err.message + '）');
    return emptyState();
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// ---------------- LLM：WeKnora 会话网关 ----------------

function briefJson(value) {
  try { return JSON.stringify(value).slice(0, 200); } catch { return String(value).slice(0, 200); }
}

/**
 * knowledge-chat 返回 SSE 流。lib/weknora.js 的 request() 只能把响应当 JSON 或忽略正文，
 * 所以从它提供的 fetchImpl 注入口拿到响应、克隆一份读原文，正文照旧交给 request() 处理：
 * URL 拼接、鉴权头、超时与 reason 映射仍然只有那一份实现。
 */
async function llmOnce(ctx, prompt) {
  const cfg = ctx.cfg;
  const created = await api(ctx, 'POST', '/sessions', { title: 'distill ' + new Date().toISOString().slice(0, 16) });
  const chatId = created && created.data && created.data.id;
  if (!chatId) throw new Error('创建 WeKnora 会话未返回 id: ' + briefJson(created));

  const body = { query: prompt, knowledge_base_ids: [], agent_enabled: false, web_search_enabled: false };
  const modelName = String(cfg.llm && cfg.llm.modelName ? cfg.llm.modelName : '').trim();
  if (modelName) body.model_name = modelName;

  let raw = '';
  const capture = async (url, init) => {
    const response = await fetch(url, init);
    try { raw = await response.clone().text(); } catch { raw = ''; }
    return response;
  };

  const res = await request(cfg, 'POST', '/knowledge-chat/' + encodeURIComponent(chatId), {
    body,
    timeoutMs: Math.max(1000, num(cfg.llm && cfg.llm.timeoutMs, 240000)),
    fetchImpl: capture,
    expect: 'none'
  });
  if (!res.ok) {
    const reason = String(res.reason || '');
    const what = reason.indexOf('http_') === 0 ? 'HTTP ' + res.status
      : reason === 'timeout' ? '请求超时'
      : reason === 'transport' ? '无法连接 WeKnora（transport）'
      : '请求失败（' + reason + '）';
    throw new Error('knowledge-chat ' + what + (raw ? '：' + raw.slice(0, 200) : ''));
  }
  const text = parseSseAnswer(raw);
  return { text, inChars: prompt.length, outChars: text.length };
}

function parseSseAnswer(raw) {
  let text = '';
  for (const line of String(raw || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.indexOf('data:') !== 0) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let event;
    try { event = JSON.parse(payload); } catch { continue; }
    if (event && event.response_type === 'answer' && typeof event.content === 'string') text += event.content;
    else if (event && event.response_type === 'error') throw new Error('LLM 返回错误事件: ' + briefJson(event));
  }
  return text;
}

// ---------------- 抽取 prompt ----------------

const KIND_DOC = [
  'decision  已定的技术选型、方案、取舍（例：会话记忆与知识分库存放）',
  'constraint 用户明确的要求、禁令、边界（例：不改插件代码）',
  'preference 用户的稳定偏好（例：回答先给结论）',
  'lesson    被验证有效或失败的经验（例：zstd 多帧必须按 magic 切帧）',
  'fact      稳定事实：路径、端口、版本、服务地址、库 id'
].join('\n');

function buildPrompt(sess, cfg) {
  const perTurnChars = Math.max(1, num(cfg.distill.perTurnChars, 1500));
  const maxInputChars = Math.max(1, num(cfg.distill.maxInputChars, 30000));
  const maxEntries = Math.max(1, num(cfg.distill.maxEntriesPerSession, 8));
  const date = fmtDate(sess.createdAt || sess.mtime);
  const turns = [];
  let used = 0;
  for (const turn of sess.turns) {
    const text = turn.text.length > perTurnChars ? turn.text.slice(0, perTurnChars) + '…（截断）' : turn.text;
    const block = '[' + (turn.role === 'user' ? '用户' : '助手') + '] ' + text.replace(/\s+/g, ' ').trim();
    if (used + block.length > maxInputChars) break;
    turns.push(block);
    used += block.length;
  }
  return [
    '你是记忆提炼器。输入是一段已经结束的 DSH 助手会话转录。你的唯一任务是把跨会话仍然成立的结论抽成条目，不做总结，不写过程叙述。',
    '',
    'kind 取值范围（只能取这五个词）：',
    KIND_DOC,
    '',
    '输出格式（严格遵守）：',
    '只输出一个 JSON 数组，第一个字符是 [，最后一个字符是 ]。不要代码块，不要任何解释文字。数组元素：',
    '{"kind":"fact","subject":"fact.weknora.kb-id","headline":"知识库 id","statement":"...","note":["...","..."],"confidence":0.8,"evidence":"...","date":"YYYY-MM-DD","session_id":"..."}',
    '',
    '字段要求：',
    '1) subject：这张卡的稳定标识，小写点分 2-4 段（只含 a-z 0-9 _ -），例如 fact.weknora.kb-id、decision.sessions-vs-kb；同一主题必须复用同一 subject，不超过 40 字符。',
    '2) headline：这张卡的短标题，不超过 20 字，用来区分同一 subject 下的不同卡（不要重复 subject 里已表达的词）。',
    '3) statement：一句独立可读的中文陈述，20-80 字，不得出现他/它/这个/那个/上面/刚才/这次等指代，必须脱离原对话也能读懂。',
    '4) note：说明最多 2 行（边界条件、适用范围、为什么成立），每行不超过 40 字，不要加 - 或编号前缀；写不出就输出 []。',
    '   整张卡正文（标题+陈述+说明+证据）合计不超过 600 字；超过 400 字即视为偏胖。',
    '5) confidence：0 到 1 之间的小数，表示这条结论的确定程度。',
    '6) evidence：从转录里逐字复制的一句原话，不超过 120 字，不得改写、不得拼接。找不到原话就不要输出这一条。',
    '7) date：该结论出现的日期，格式 YYYY-MM-DD，未知则用会话开始日期。',
    '8) session_id：原样回填下面给出的 session_id。',
    '',
    '收录标准：只收跨会话仍然成立的内容——用户明确的要求/禁令/偏好、已确定的技术选型或方案、被验证的经验教训、稳定的事实（路径、端口、版本、服务地址、库 id）。',
    '丢弃：寒暄、进度播报、工具调用的中间输出、一次性命令结果、临时的调试细节、后来被推翻的想法、任何在原文里找不到逐字证据的推断。',
    '宁少勿多：最多 ' + maxEntries + ' 条；如果整段没有可跨会话复用的结论，输出 []。',
    '',
    '会话元数据：session_id=' + sess.sid + '；会话日期=' + date + '；标题=' + (sess.title || '(无)'),
    '',
    '转录：',
    turns.join('\n')
  ].join('\n');
}

// ---------------- 校验 / 去重 ----------------

function squash(value) {
  return String(value || '').replace(/\s+/g, '');
}

function normKey(value) {
  const lowered = String(value || '').toLowerCase()
    .replace(/[\s，。、；：,.;:!?！？"'“”‘’（）()【】\[\]<>《》·\-—_/\\|]/g, '');
  return lowered.split(String.fromCharCode(96)).join('');
}

function bigrams(value) {
  const text = normKey(value);
  const out = new Set();
  for (let i = 0; i + 1 < text.length; i++) out.add(text.slice(i, i + 2));
  return out;
}

function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let overlap = 0;
  for (const gram of A) if (B.has(gram)) overlap++;
  return overlap / (A.size + B.size - overlap);
}

/** 只认第一个 [ 到最后一个 ] 之间的数组；解析失败时逐个抓顶层对象兜底。 */
function parseEntries(raw) {
  const text = String(raw || '');
  const begin = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (begin < 0 || end <= begin) return { entries: [], error: '没有 JSON 数组' };
  const slice = text.slice(begin, end + 1);
  try { return { entries: JSON.parse(slice), error: '' }; } catch (err) {
    const objs = [];
    const re = /\{[^{}]*\}/g;
    let match;
    while ((match = re.exec(slice))) {
      try { objs.push(JSON.parse(match[0])); } catch { /* skip */ }
    }
    if (!objs.length) return { entries: [], error: 'JSON 解析失败: ' + err.message };
    return { entries: objs, error: '' };
  }
}

function clipText(value, limit) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return text.slice(0, limit).replace(/[，。、；：,.;:!?！？\s]+$/, '');
}

/** 超长时优先切在句读处，避免把一句话砍成半个词。 */
function clipClaim(value, limit) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const match = head.match(/^([\s\S]*[。！？；，、,.!?;])/);
  const cut = match && match[1].length >= Math.floor(limit * 0.5) ? match[1] : head;
  return cut.replace(/[，。、；：,.;:!?！？\s]+$/, '');
}

function hash8(value) {
  return crypto.createHash('sha1').update(String(value), 'utf8').digest('hex').slice(0, 8);
}

/** 只修大小写/分隔符这类表面问题；含中文的 subject 不做猜测式改写。 */
function repairSubject(raw) {
  const lowered = String(raw == null ? '' : raw).toLowerCase().trim();
  if (!/^[a-z0-9._\-\s]+$/.test(lowered)) return '';
  let text = lowered.replace(/\s+/g, '');
  text = text.replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  text = text.split('.').filter(Boolean).slice(0, 5).join('.');
  if (text.length > 48) text = text.slice(0, 48).replace(/[-.]+$/, '');
  return text;
}

/** LLM 给的 subject 只当建议：正则不过就归一化，仍不过就改写为 <kind>.fallback-<hash8>，绝不丢卡。 */
function normalizeSubject(raw, kind, statement) {
  const direct = String(raw == null ? '' : raw).trim();
  if (direct.length <= 48 && SUBJECT_RE.test(direct)) return { subject: direct, warn: '' };
  const repaired = repairSubject(raw);
  if (repaired && repaired.length <= 48 && SUBJECT_RE.test(repaired)) {
    return { subject: repaired, warn: 'subject「' + clipText(direct, 40) + '」不合契约正则，已归一化 → ' + repaired };
  }
  const fallback = (KINDS.has(kind) ? kind : 'fact') + '.fallback-' + hash8(statement);
  return { subject: fallback, warn: 'subject「' + clipText(direct, 40) + '」不合契约正则且无法归一化，改写 → ' + fallback };
}

/** 既有文档里的条目陈述：旧格式的 ### n. 行优先，否则取正文第一条陈述行。 */
function statementsFromDoc(text) {
  const out = [];
  const re = /^###[ \t]+\d+\.[ \t]*(.+)$/gm;
  let match;
  while ((match = re.exec(String(text || '')))) {
    const statement = match[1].trim();
    if (statement) out.push(statement);
  }
  if (out.length) return out;
  const body = String(text || '').split('\n').map((line) => line.trim())
    .find((line) => line && !line.startsWith('<!--') && !line.startsWith('#') && !line.startsWith('证据：'));
  if (body) out.push(body);
  return out;
}

// ---------------- 事实卡渲染（一张卡 = 一篇文档） ----------------

function renderCard(entry, cfg) {
  const titlePrefix = String(cfg.distill.titlePrefix || '');
  const subject = entry.subject;
  const claim = clipClaim(entry.statement, CARD_CLAIM_MAX);
  let headline = clipText(entry.headline, CARD_HEADLINE_MAX) || clipText(claim, 12);
  const headOf = (value) => (value ? subject + ' · ' + value : subject);
  let title = titlePrefix + headOf(headline);
  if (title.length > CARD_TITLE_MAX) {
    const budget = CARD_TITLE_MAX - titlePrefix.length - subject.length - 3;
    headline = budget >= 1 ? headline.slice(0, budget).trim() : '';
    title = titlePrefix + headOf(headline);
  }
  if (title.length > CARD_TITLE_MAX) title = title.slice(0, CARD_TITLE_MAX);

  const head = headOf(headline);
  const quote = clipText(entry.evidence, CARD_QUOTE_MAX);
  const fields = {
    v: 1, subject, status: 'active', valid_from: entry.date, superseded_by: '',
    confidence: entry.confidence, session: entry.session_id, quote
  };
  const header = '<!-- fact ' + JSON.stringify(fields) + ' -->';
  const assemble = (notes) => {
    const lines = [header, '', '# ' + head, '', claim, ''];
    if (notes.length) lines.push(...notes, '');
    lines.push('证据：' + quote);
    return lines.join('\n');
  };

  // LLM 有时把 statement 原句又写进 note[0]；重复行会让卡读起来像复读，按 normKey 去掉。
  const seen = new Set([normKey(claim)]);
  const noteLine = (value) => clipClaim(value, CARD_NOTE_MAX_CHARS);
  const notes = (Array.isArray(entry.note) ? entry.note : [])
    .map(noteLine)
    .filter(Boolean)
    .filter((value) => {
      const key = normKey(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, CARD_NOTE_MAX_LINES);

  const fill = [
    '适用范围：' + (KIND_TITLE[entry.kind] || entry.kind) + ' 类结论，记录日期 ' + entry.date,
    '由 distill 从会话转录抽取，逐字证据见文末「证据」行。'
  ];
  for (const line of fill) {
    if (notes.length >= CARD_NOTE_MAX_LINES) break;
    notes.push(noteLine(line));
  }

  let content = assemble(notes);
  if (content.split('\n').join('').length > CARD_HARD_CHARS) content = assemble([]);
  const chars = content.split('\n').join('').length;
  return { entry, title, header, fields, content, chars };
}

// ---------------- 语义去重（知识库检索 + 条目级 bigram 复核） ----------------

function dedupeSettings(cfg) {
  const raw = cfg.distill.semanticDedupe || {};
  return {
    enabled: raw.enabled !== false,
    scoreMin: num(raw.scoreMin, 0.66),
    simMin: 0.2,
    conflictSimMin: 0.1,
    maxResults: 5,
    queryChars: 120
  };
}

/**
 * 单一分数阈值在本部署不可用（同义与不相关都落在 0.64-0.71 窄带），所以两段合取：
 * 检索 top score >= scoreMin 才算「库里已有相近内容」，再用条目级 bigram 区分同义重复与同主题不同结论。
 */
async function semanticLookup(ctx, statement, known, sd) {
  if (!sd.enabled) return { verdict: 'new', why: 'semanticDedupe.enabled=false' };
  let hits = [];
  try {
    const json = await api(ctx, 'POST', '/knowledge-search', {
      query: statement.slice(0, sd.queryChars),
      knowledge_base_ids: [ctx.kb],
      max_results: sd.maxResults
    });
    hits = (json && json.data) || [];
  } catch (err) {
    ctx.log.warn('knowledge-search 失败，本条不做语义去重: ' + err.message);
    return { verdict: 'new', why: 'search failed' };
  }
  const top = hits[0] || null;
  const score = top ? Number(top.score || 0) : 0;
  if (!top || score < sd.scoreMin) return { verdict: 'new', score: Number(score.toFixed(4)) };

  const candidates = [];
  for (const value of known.values()) if (value && typeof value.statement === 'string') candidates.push(value.statement);
  for (const hit of hits) {
    for (const statement2 of statementsFromDoc(hit.content || hit.matched_content || '')) candidates.push(statement2);
  }
  let best = { sim: 0, text: '' };
  for (const candidate of candidates) {
    const sim = similarity(statement, candidate);
    if (sim > best.sim) best = { sim, text: candidate };
  }
  const evidence = {
    score: Number(score.toFixed(4)),
    sim: Number(best.sim.toFixed(3)),
    hit: String(best.text || '').slice(0, 80),
    knowledgeId: top.knowledge_id,
    title: top.knowledge_title
  };
  if (best.sim >= sd.simMin) return Object.assign({ verdict: 'dup' }, evidence);
  if (best.sim >= sd.conflictSimMin) return Object.assign({ verdict: 'conflict' }, evidence);
  return Object.assign({ verdict: 'new' }, evidence);
}

// ---------------- 主流程 ----------------

async function distillRun(ctx, args) {
  const cfg = ctx.cfg;
  const log = ctx.log;
  const kb = cfg.kbs.knowledge;
  if (!kb) throw new Error('kbs.knowledge 未配置：请填写库②（知识/记忆）的知识库 id');
  if (!cfg.apiUrl) throw new Error('apiUrl 未配置：应为 http://<host>:<port>/api/v1（含版本前缀）');
  const root = cfg.sessionsRoot;
  if (!root) throw new Error('sessionsRoot 未配置：请填会话转录根目录（相对包根目录，或绝对路径）');
  if (!fs.existsSync(root)) throw new Error('sessionsRoot 不存在: ' + root);

  const settleMin = Math.max(0, num(cfg.ingest.settleMinutes, 10));
  const maxSessions = Math.max(1, num(args.values.limit, num(cfg.distill.maxSessionsPerRun, 3)));
  const maxDocs = Math.max(1, num(cfg.distill.maxDocsPerRun, 3));
  const maxEntries = Math.max(1, num(cfg.distill.maxEntriesPerSession, 8));
  const titlePrefix = String(cfg.distill.titlePrefix || '');
  const cardPrefix = String(cfg.dream && cfg.dream.titlePrefix ? cfg.dream.titlePrefix : '');
  const pollTimeoutSec = Math.max(1, num(cfg.ingest.pollTimeoutSec, 600));
  const maxAttempts = Math.max(1, num(cfg.ingest.maxAttempts, 3));
  const sd = dedupeSettings(cfg);

  const state = loadState(log);

  const sinceTs = args.values.since ? Date.parse(args.values.since + 'T00:00:00') : 0;
  if (args.values.since && !Number.isFinite(sinceTs)) throw new Error('--since 需要 YYYY-MM-DD: ' + args.values.since);
  const only = String(args.values.only || '');

  log.info('== distill start' + (args.dryRun ? ' DRY-RUN（不发 LLM、不写库、不写 state）' : '')
    + ' maxSessions=' + maxSessions + ' maxDocs=' + maxDocs + ' settle=' + settleMin + 'm');

  const now = Date.now();
  const candidates = [];
  const skipReasons = [];
  for (const item of walkSessions(root)) {
    if (only && !item.file.includes(only)) continue;
    if (sinceTs && item.mtime < sinceTs) continue;
    const sid = path.basename(path.dirname(item.file));
    const idleMin = (now - item.mtime) / 60000;
    if (idleMin < settleMin) { skipReasons.push(shortSid(sid) + ' 仍在活动(' + Math.round(idleMin) + 'm)'); continue; }
    const prev = state.sessions[sid];
    if (prev && prev.mtime >= item.mtime) { skipReasons.push(shortSid(sid) + ' 未变化'); continue; }
    candidates.push({ file: item.file, mtime: item.mtime, sid });
    if (candidates.length >= maxSessions) break;
  }
  log.info('候选会话 ' + candidates.length + ' 个；跳过 ' + skipReasons.length + ' 个'
    + (skipReasons.length ? '（' + skipReasons.slice(0, 5).join('；') + (skipReasons.length > 5 ? ' …' : '') + '）' : ''));

  const existingDocs = await listDocs(ctx, kb);
  const known = new Map();
  for (const [key, value] of Object.entries(state.entries)) {
    if (value && typeof value.statement === 'string') known.set(key, value);
  }
  let memoryDocs = 0;
  let cardDocs = 0;
  for (const doc of existingDocs.values()) {
    const title = String(doc.title || '');
    const isMemory = !!titlePrefix && title.startsWith(titlePrefix);
    const isCard = !!cardPrefix && title.startsWith(cardPrefix);
    if (!isMemory && !isCard) continue;
    if (isMemory) memoryDocs++; else cardDocs++;
    let text = '';
    try {
      text = await docText(ctx, doc.id);
    } catch (err) {
      log.warn('读取既有文档失败 ' + title + ': ' + err.message);
      continue;
    }
    for (const statement of statementsFromDoc(text)) {
      known.set(normKey(statement), { statement, docId: doc.id, docTitle: title });
    }
  }
  log.info('知识库既有文档 ' + existingDocs.size + ' 篇，其中记忆 ' + memoryDocs + ' 篇、事实卡 ' + cardDocs
    + ' 张，可解析条目 ' + known.size + ' 条');

  const collected = [];
  const discards = [];
  const conflicts = [];
  const skippedSemantic = [];
  const subjectWarns = [];
  const written = [];
  let llmCalls = 0;
  let failedRuns = 0;
  let capped = false;
  state.counters.runInChars = 0;
  state.counters.runOutChars = 0;

  for (const candidate of candidates) {
    let sess;
    try {
      sess = extractSession(candidate.file);
    } catch (err) {
      discards.push({ sid: candidate.sid, why: 'decode: ' + err.message });
      log.error('[decode] ' + shortSid(candidate.sid) + ' ' + err.message);
      continue;
    }
    if (!sess.turns.length) {
      discards.push({ sid: candidate.sid, why: '没有可提炼的正文' });
      log.detail('[skip] ' + shortSid(candidate.sid) + ' 没有可提炼的正文');
      continue;
    }
    const prompt = buildPrompt(sess, cfg);

    if (args.dryRun || args.noLlm) {
      log.info('[plan] ' + shortSid(candidate.sid) + ' turns=' + sess.turns.length + ' prompt字符=' + prompt.length
        + (args.dryRun ? '（dry-run：不发 LLM、不写库）' : '（--no-llm）'));
      continue;
    }

    let answer = '';
    try {
      const reply = await llmOnce(ctx, prompt);
      answer = reply.text;
      llmCalls++;
      state.counters.llmCalls++;
      state.counters.runInChars += reply.inChars;
      state.counters.runOutChars += reply.outChars;
    } catch (err) {
      discards.push({ sid: candidate.sid, why: 'LLM: ' + err.message });
      log.error('[fail] ' + shortSid(candidate.sid) + ' LLM ' + err.message);
      failedRuns++;
      break;
    }

    const parsed = parseEntries(answer);
    if (parsed.error) {
      log.error('[fail] ' + shortSid(candidate.sid) + ' 输出解析失败: ' + parsed.error + ' raw=' + answer.slice(0, 200));
      discards.push({ sid: candidate.sid, why: 'parse: ' + parsed.error });
      continue;
    }

    const flat = squash(sess.turns.map((turn) => turn.text).join('\n'));
    let kept = 0;
    let droppedEvidence = 0;
    let droppedKind = 0;
    let dup = 0;
    for (const raw of parsed.entries) {
      if (!raw || typeof raw.statement !== 'string' || typeof raw.evidence !== 'string') continue;
      const kind = String(raw.kind || '').toLowerCase();
      if (!KINDS.has(kind)) { droppedKind++; continue; }
      const statement = raw.statement.replace(/\s+/g, ' ').trim();
      const evidence = raw.evidence.replace(/\s+/g, ' ').trim();
      if (!statement || evidence.length < 4) { droppedEvidence++; continue; }
      if (!flat.includes(squash(evidence))) {
        droppedEvidence++;
        discards.push({ sid: candidate.sid, why: '证据不在原文', statement: statement.slice(0, 60), evidence: evidence.slice(0, 60) });
        continue;
      }
      const key = normKey(statement);
      // 卡正文存的是 clipClaim 过的 claim（<=80 字），长陈述必须用同一裁剪形态比对，否则跨轮会重复写卡。
      const keyCard = normKey(clipClaim(statement, CARD_CLAIM_MAX));
      if (known.has(key) || known.has(keyCard)) { dup++; continue; }

      const semantic = await semanticLookup(ctx, statement, known, sd);
      if (semantic.verdict === 'dup') {
        skippedSemantic.push({ sid: candidate.sid, statement: statement.slice(0, 100), hit: semantic.hit, score: semantic.score, sim: semantic.sim, docTitle: semantic.title || '' });
        log.info('[skip_semantic] ' + statement.slice(0, 36) + ' ≈「' + String(semantic.hit || '').slice(0, 36) + '」 score=' + semantic.score + ' sim=' + semantic.sim);
        dup++;
        continue;
      }

      let conflicted = null;
      if (semantic.verdict === 'conflict') {
        conflicted = '知识库检索相近但结论不同（score=' + semantic.score + '，sim=' + semantic.sim + '）：「' + semantic.hit + '」';
      }
      for (const value of known.values()) {
        if (conflicted) break;
        const sim = similarity(statement, value.statement);
        if (sim >= 0.55 && sim < 0.97) { conflicted = '与既有条目相似度 ' + sim.toFixed(2) + '：' + value.statement; break; }
      }
      if (conflicted) conflicts.push({ new: statement, old: conflicted, sid: candidate.sid });

      const subject = normalizeSubject(raw.subject, kind, statement);
      if (subject.warn) {
        subjectWarns.push({ sid: candidate.sid, statement: statement.slice(0, 60), warn: subject.warn });
        log.warn(subject.warn);
      }
      const confidence = Number(raw.confidence);
      collected.push({
        kind,
        statement,
        evidence,
        subject: subject.subject,
        headline: typeof raw.headline === 'string' ? raw.headline : '',
        note: Array.isArray(raw.note) ? raw.note.map((item) => String(item)) : [],
        confidence: Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? Number(confidence.toFixed(2)) : 0.8,
        date: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date)) ? String(raw.date) : fmtDate(sess.createdAt || candidate.mtime),
        session_id: candidate.sid,
        title: sess.title || '',
        conflict: conflicted || ''
      });
      known.set(key, { statement });
      kept++;
      if (kept >= maxEntries) { log.detail('[cap] ' + shortSid(candidate.sid) + ' 已达 maxEntriesPerSession=' + maxEntries); break; }
      if (collected.length >= maxDocs) { capped = true; log.info('[cap] 已达 distill.maxDocsPerRun=' + maxDocs + '（本轮不再收条目）'); break; }
    }

    log.info('[llm] ' + shortSid(candidate.sid) + ' 条目=' + parsed.entries.length + ' 采纳=' + kept
      + ' 重复=' + dup + ' 丢证据=' + droppedEvidence + ' 丢kind=' + droppedKind
      + ' 输入字符=' + prompt.length + ' 返回字符=' + answer.length);
    state.sessions[candidate.sid] = {
      sid: candidate.sid, mtime: candidate.mtime, lastRunAt: new Date().toISOString(),
      entries: kept, dup, droppedEvidence, file: candidate.file, title: sess.title || ''
    };
    state.counters.sessionsProcessed += 1;
    if (!args.dryRun) saveState(state);
    if (capped) break;
  }

  // ---- 写库 ----
  if (!collected.length) {
    log.info('== 本轮没有新条目（候选 ' + candidates.length + '，LLM 调用 ' + llmCalls + ' 次）。未写入知识库。');
  } else {
    const cards = collected.slice(0, maxDocs).map((entry) => renderCard(entry, cfg));
    for (const card of cards) {
      if (card.chars > CARD_TARGET_CHARS) {
        log.warn('卡偏胖 ' + card.chars + ' 字符 > 目标 ' + CARD_TARGET_CHARS + '（硬上限 ' + CARD_HARD_CHARS + '）：' + card.title);
      }
    }
    for (const card of cards) {
      try {
        const id = await createManualDoc(ctx, kb, card.title, card.content, maxAttempts);
        const parsed = await waitParsed(ctx, id, pollTimeoutSec);
        const chunks = await chunkCount(ctx, id);
        state.counters.docsWritten += 1;
        written.push({ docId: id, title: card.title, subject: card.fields.subject, chunks, parseStatus: parsed.status });
        state.entries[normKey(card.entry.statement)] = {
          statement: card.entry.statement, kind: card.entry.kind, subject: card.fields.subject,
          date: card.entry.date, docId: id, docTitle: card.title
        };
        log.info('[ok] doc id=' + id + ' chunks=' + chunks + ' parse=' + parsed.status
          + ' subject=' + card.fields.subject + ' title=' + card.title);
        if (chunks < 1) {
          log.error('[fail] chunks=0，写入未生效 doc=' + id + ' title=' + card.title);
          failedRuns++;
        }
        if (!args.dryRun) saveState(state);
      } catch (err) {
        failedRuns++;
        log.error('[fail] 写入失败 ' + card.title + ': ' + (err.message || String(err)));
      }
    }
  }

  if (conflicts.length) {
    state.conflicts.push(...conflicts.map((item) => ({ at: new Date().toISOString(), new: item.new, old: item.old, sid: item.sid })));
    if (state.conflicts.length > MAX_CONFLICTS_KEPT) state.conflicts = state.conflicts.slice(-MAX_CONFLICTS_KEPT);
  }
  if (!args.dryRun) saveState(state);

  log.info('== distill end 采纳条目=' + collected.length + ' 文档=' + written.length
    + ' 冲突=' + conflicts.length + ' 语义跳过=' + skippedSemantic.length + ' subject改写=' + subjectWarns.length
    + ' 本轮LLM=' + llmCalls + ' 累积LLM=' + state.counters.llmCalls
    + (args.dryRun ? '（dry-run：未写库、未写 state）' : ''));
  return failedRuns ? 1 : 0;
}

export async function run(argv) {
  const list = Array.isArray(argv) ? argv : process.argv.slice(2);
  let args;
  try {
    args = parseWriterArgs(list);
  } catch (err) {
    console.error('[distill] ' + err.message);
    return 2;
  }
  if (args.help) { console.log(USAGE); return 0; }
  if (args.unknown.length) {
    console.error('[distill] 未知参数: ' + args.unknown.join(' ') + '\n' + USAGE);
    return 2;
  }

  const log = makeLog('[distill]', args);
  let loaded;
  try {
    loaded = loadWriterConfig(list);
  } catch (err) {
    log.error(err.message);
    return 2;
  }
  for (const note of loaded.notes) log.info('[config] ' + note);

  const ctx = { cfg: loaded.cfg, log, timeoutMs: REQUEST_TIMEOUT_MS, kb: loaded.cfg.kbs.knowledge };
  try {
    return await distillRun(ctx, args);
  } catch (err) {
    log.error(err && err.message ? err.message : String(err));
    return 2;
  }
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return pathToFileURL(path.resolve(entry)).href === import.meta.url; } catch { return false; }
})();

if (isMain) {
  run().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error('[distill] ' + (err && err.message ? err.message : String(err)));
    process.exitCode = 1;
  });
}
