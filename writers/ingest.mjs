#!/usr/bin/env node
/**
 * writers/ingest.mjs —— DSH 会话转录原样写入 WeKnora 库①（kbs.session）。
 *
 * 行为移植自已验证的生产脚本：walk 会话目录（每个会话目录只取最新的一份转录）→ 按 zstd
 * magic 切多帧解压 → 只收 user（source.kind === 'user'）与 assistant 的文本 → 按 maxDocBytes
 * 分片渲染 → 用「state 记录的 id / 精确标题 / [会话尾号] 标记」定位既有文档，命中就
 * PUT /knowledge/manual/<id> 复用同一篇，只有真正新建才 POST manual。
 *
 * 契约（writers/README.md）：
 *   - config.apiUrl 已含 /api/v1，路径里不再写版本前缀；
 *   - 一切 HTTP 走 ../lib/weknora.js 的 request()，这里不拼 header、不写 fetch；
 *   - apiKey 只从环境变量 WEKNORA_API_KEY 取；
 *   - 本模块被 distill.mjs 复用解析层，导入不得产生任何副作用（不读配置、不写文件、不联网）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request, baseUrlOf } from '../lib/weknora.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..');
const CONFIG_NAME = 'writer.config.json';
const EXAMPLE_NAME = 'config.example.json';
const STATE_PATH = path.join(PKG_ROOT, 'data', 'writer-state', 'ingest.json');
const REQUEST_TIMEOUT_MS = 30000;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const POLL_INTERVAL_MS = 2000;
const BYTE_HEADROOM = 0.98;
const TITLE_SLICE = 50;
const SID_TAIL = 8;

const USAGE = [
  '用法: node writers/ingest.mjs [选项]',
  '',
  '把已结束且空闲 >= settleMinutes 的 DSH 会话转录原样写入 WeKnora（库① kbs.session）。',
  '已存在的文档按 state 的 id / 精确标题 / [会话尾号] 标记定位，走 PUT 复用同一篇，可重复执行。',
  '',
  '选项:',
  '  --dry-run            只打印本次计划：不写知识库、不写 state、不写任何文件',
  '  --config <path>      配置文件路径（默认 writers/writer.config.json，缺失时回退 config.example.json 的默认值）',
  '  --verbose, -v        打印每个会话的判定细节（跳过原因、字节数、分片数）',
  '  --limit <n>          本次最多处理 n 个会话（默认不限制）',
  '  --only <substr>      只处理路径里包含 substr 的会话',
  '  --settle <minutes>   覆盖 ingest.settleMinutes：会话最后一次写入后需空闲多少分钟',
  '  --help, -h           打印本帮助并退出',
  '',
  '凭证: apiKey 只从环境变量 WEKNORA_API_KEY 读取，配置文件里不放密钥。',
  '退出码: 0 成功；1 有会话失败；2 配置或连接失败。'
].join('\n');

// ---------------- 参数与配置 ----------------

const BOOLEAN_FLAGS = {
  '--dry-run': 'dryRun', '--dry': 'dryRun', '--verbose': 'verbose', '-v': 'verbose',
  '--no-llm': 'noLlm', '--help': 'help', '-h': 'help'
};
const VALUED_FLAGS = new Set(['--config', '--limit', '--only', '--settle', '--since']);

export function parseWriterArgs(argv) {
  const out = { help: false, dryRun: false, verbose: false, noLlm: false, values: {}, unknown: [] };
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (BOOLEAN_FLAGS[item]) { out[BOOLEAN_FLAGS[item]] = true; continue; }
    if (VALUED_FLAGS.has(item)) {
      const value = list[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('参数 ' + item + ' 缺少取值');
      out.values[item.slice(2)] = value;
      i++;
      continue;
    }
    out.unknown.push(item);
  }
  return out;
}

export function makeLog(prefix, opts) {
  const verbose = !!(opts && opts.verbose);
  const emit = (stream, tag, msg) => stream.write(prefix + (tag ? ' ' + tag : '') + ' ' + msg + '\n');
  return {
    info: (msg) => emit(process.stdout, '', msg),
    detail: (msg) => { if (verbose) emit(process.stdout, '', msg); },
    warn: (msg) => emit(process.stderr, '[warn]', msg),
    error: (msg) => emit(process.stderr, '[error]', msg)
  };
}

function readJson(file, what) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw new Error('读取' + what + '失败: ' + file + '（' + e.message + '）'); }
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(what + '不是合法 JSON: ' + file + '（' + e.message + '）'); }
}

function section(base, over) {
  return Object.assign({}, base && typeof base === 'object' ? base : {}, over && typeof over === 'object' ? over : {});
}

/** 相对包根目录解析（与插件读侧 profile.path 的口径一致）。 */
function resolveFromRoot(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  return path.isAbsolute(text) ? text : path.resolve(PKG_ROOT, text);
}

export function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 配置 = config.example.json 的默认值 + 用户配置（--config 或 writers/writer.config.json）的覆盖。
 * apiKey 永远只从 WEKNORA_API_KEY 取：文件里即使写了也不读。
 */
export function loadWriterConfig(argv) {
  const args = parseWriterArgs(argv);
  const notes = [];
  const exampleFile = path.join(HERE, EXAMPLE_NAME);
  let file = '';
  if (args.values.config) {
    file = path.resolve(process.cwd(), args.values.config);
    if (!fs.existsSync(file)) throw new Error('配置文件不存在: ' + file);
  } else {
    file = path.join(HERE, CONFIG_NAME);
    if (!fs.existsSync(file)) {
      file = exampleFile;
      notes.push('未找到 writers/' + CONFIG_NAME + '，改用 ' + EXAMPLE_NAME + ' 的默认值');
    }
  }
  const base = readJson(exampleFile, '默认配置');
  const user = file === exampleFile ? {} : readJson(file, '配置文件');
  const baseIngest = base.ingest || {};
  const userIngest = user.ingest || {};
  const baseDistill = base.distill || {};
  const userDistill = user.distill || {};

  const cfg = {
    apiUrl: String(user.apiUrl != null ? user.apiUrl : base.apiUrl || '').trim(),
    apiKey: String(process.env.WEKNORA_API_KEY || '').trim(),
    sessionsRoot: resolveFromRoot(user.sessionsRoot != null ? user.sessionsRoot : base.sessionsRoot),
    kbs: {
      session: String((user.kbs && user.kbs.session) || (base.kbs && base.kbs.session) || ''),
      knowledge: String((user.kbs && user.kbs.knowledge) || (base.kbs && base.kbs.knowledge) || ''),
      material: String((user.kbs && user.kbs.material) || (base.kbs && base.kbs.material) || '')
    },
    ingest: section(baseIngest, userIngest),
    distill: Object.assign(section(baseDistill, userDistill), {
      semanticDedupe: section(baseDistill.semanticDedupe, userDistill.semanticDedupe)
    }),
    dream: section(base.dream, user.dream),
    llm: section(base.llm, user.llm)
  };
  if (!cfg.apiKey) notes.push('环境变量 WEKNORA_API_KEY 未设置：本次请求不带 X-API-Key');
  return { cfg, file, notes };
}

// ---------------- 转录解析 ----------------

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

export function decodeTranscript(file) {
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('当前 Node 不支持 zstd 解压（需要 Node 22.15+ / 23.8+ 才有 zlib.zstdDecompressSync）');
  }
  const buf = fs.readFileSync(file);
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) starts.push(i);
  }
  if (!starts.length) throw new Error('转录里找不到 zstd 帧: ' + file);
  const out = [];
  let badFrames = 0;
  for (let k = 0; k < starts.length; k++) {
    const begin = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { out.push(zlib.zstdDecompressSync(buf.subarray(begin, end))); } catch { badFrames++; }
  }
  const text = Buffer.concat(out).toString('utf8');
  const objs = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { objs.push(JSON.parse(line)); } catch { badLines++; }
  }
  return { objs, frames: starts.length, badFrames, badLines };
}

export function textOf(items) {
  return (items || [])
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

export function extractSession(file) {
  const { objs, frames, badFrames, badLines } = decodeTranscript(file);
  const meta = objs.find((o) => o.type === 'session') || {};
  const titles = objs
    .filter((o) => o.type === 'session/title' && o.data && o.data.title)
    .map((o) => o.data.title);
  const turns = [];
  for (const o of objs) {
    if (o.type === 'user/message') {
      const kind = o.data && o.data.source ? o.data.source.kind : undefined;
      if (kind !== 'user') continue;
      const text = textOf(o.data.content);
      if (text) turns.push({ role: 'user', time: o.time, text });
    } else if (o.type === 'assistant/message') {
      const text = textOf(o.data && o.data.message ? o.data.message.content : []);
      if (text) turns.push({ role: 'assistant', time: o.time, text });
    }
  }
  return {
    sid: meta.id || path.basename(path.dirname(file)),
    cwd: meta.cwd || '',
    createdAt: meta.createdAt || (turns[0] && turns[0].time) || 0,
    title: titles.length ? titles[titles.length - 1] : '',
    turns,
    frames,
    badFrames,
    badLines,
    mtime: fs.statSync(file).mtimeMs,
    origin: meta.origin || null,
    file
  };
}

const SESSION_RE = /^session\.v([34])\.jsonl\.zstd$/;

/**
 * 每个会话目录只保留一份转录：v4 迁移重写过旧会话，会在同一目录留下一个陈旧的 v3。
 * 取 mtime 最新者；并列时先比格式版本，再比文件大小。
 */
export function walkSessions(root) {
  const best = new Map();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      const match = SESSION_RE.exec(entry.name);
      if (!match) continue;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      const cand = { file: full, v: Number(match[1]), mtime: stat.mtimeMs, size: stat.size };
      const cur = best.get(dir);
      if (!cur || cand.mtime > cur.mtime
        || (cand.mtime === cur.mtime && (cand.v > cur.v || (cand.v === cur.v && cand.size > cur.size)))) {
        best.set(dir, cand);
      }
    }
  }
  return [...best.values()].sort((a, b) => b.mtime - a.mtime);
}

// ---------------- 渲染 ----------------

const pad2 = (n) => String(n).padStart(2, '0');

export function fmtDate(ms) {
  if (!ms) return '未知';
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

export function fmtTs(ms) {
  if (!ms) return '未知';
  const d = new Date(ms);
  return fmtDate(ms) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function cleanTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function docTitle(titlePrefix, sess, part, total) {
  const base = titlePrefix + fmtDate(sess.createdAt).slice(0, 10) + ' '
    + cleanTitle(sess.title || sess.sid).slice(0, TITLE_SLICE) + ' [' + sess.sid.slice(-SID_TAIL) + ']';
  return total > 1 ? base + ' (第 ' + part + ' 部分)' : base;
}

function renderTurn(index, turn) {
  return '### 第 ' + index + ' 轮\n\n' + (turn.role === 'user' ? '用户' : '助手') + '：\n\n' + turn.text + '\n';
}

/** 一轮 = 一条用户消息 + 其后的助手消息。 */
function toRounds(turns) {
  const rounds = [];
  let current = null;
  for (const turn of turns) {
    if (turn.role === 'user' || !current) { current = []; rounds.push(current); }
    current.push(turn);
  }
  return rounds;
}

export function buildDocs(sess, opts) {
  const titlePrefix = String(opts.titlePrefix || '');
  const budget = Math.floor(num(opts.maxDocBytes, 200000) * BYTE_HEADROOM);
  const header = (part, total) => '# ' + docTitle(titlePrefix, sess, part, total) + '\n\n'
    + '- 会话 ID：' + sess.sid + '\n'
    + '- 工作目录：' + (sess.cwd || '未知') + '\n'
    + '- 开始时间：' + fmtTs(sess.createdAt) + '\n'
    + '- 消息条数：' + sess.turns.length + '（用户 ' + sess.turns.filter((t) => t.role === 'user').length + ' 条）\n'
    + '- 来源：DSH 会话转录 ' + path.basename(sess.file) + '（' + sess.frames + ' 帧）\n'
    + (total > 1 ? '- 本部分：' + part + '/' + total + '\n' : '')
    + '\n## 对话\n\n';

  const blocks = [];
  let index = 1;
  for (const round of toRounds(sess.turns)) {
    for (const turn of round) blocks.push(renderTurn(index, turn));
    index++;
  }

  const parts = [];
  let current = [];
  let size = 0;
  for (const block of blocks) {
    const bytes = Buffer.byteLength(block, 'utf8');
    if (current.length && size + bytes > budget) { parts.push(current); current = []; size = 0; }
    current.push(block);
    size += bytes;
  }
  if (current.length) parts.push(current);
  const total = parts.length || 1;
  return (parts.length ? parts : [[]]).map((part, i) => header(i + 1, total) + part.join('\n'));
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------- HTTP（只经 lib/weknora.js） ----------------

export class ApiError extends Error {
  constructor(message, info) {
    super(message);
    this.name = 'ApiError';
    this.status = info && info.status;
    this.reason = info && info.reason;
  }
}

function briefJson(value) {
  try { return JSON.stringify(value).slice(0, 200); } catch { return String(value).slice(0, 200); }
}

export async function api(ctx, method, target, body) {
  const res = await request(ctx.cfg, method, target, { body, timeoutMs: ctx.timeoutMs || REQUEST_TIMEOUT_MS });
  if (res.ok) return res.body;
  const reason = String(res.reason || '');
  const what = reason.indexOf('http_') === 0 ? 'HTTP ' + res.status
    : reason === 'timeout' ? '请求超时'
    : reason === 'transport' ? '无法连接 WeKnora（transport）'
    : reason === 'no_api_url' ? 'apiUrl 未配置'
    : '请求失败（' + reason + '）';
  const where = baseUrlOf(ctx.cfg) ? ' @ ' + baseUrlOf(ctx.cfg) : '';
  throw new ApiError(what + ': ' + method + ' ' + target + where, { status: res.status, reason });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 库里所有文档：标题 → 文档对象（分页读全）。 */
export async function listDocs(ctx, kbId) {
  const map = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const target = '/knowledge-bases/' + encodeURIComponent(kbId) + '/knowledge?page=' + page + '&page_size=' + PAGE_SIZE;
    const json = await api(ctx, 'GET', target);
    const data = (json && json.data) || [];
    for (const doc of data) if (doc && doc.title) map.set(doc.title, doc);
    if (data.length < PAGE_SIZE) break;
  }
  return map;
}

export async function chunkCount(ctx, id) {
  const json = await api(ctx, 'GET', '/chunks/' + encodeURIComponent(id) + '?page=1&page_size=' + PAGE_SIZE);
  if (json && typeof json.total === 'number') return json.total;
  return Array.isArray(json && json.data) ? json.data.length : 0;
}

/** 文档正文：把分片内容按页拼回纯文本。 */
export async function docText(ctx, id) {
  const parts = [];
  for (let page = 1; page <= 10; page++) {
    const json = await api(ctx, 'GET', '/chunks/' + encodeURIComponent(id) + '?page=' + page + '&page_size=' + PAGE_SIZE);
    const data = (json && json.data) || [];
    for (const chunk of data) parts.push(chunk && chunk.content ? chunk.content : '');
    if (data.length < PAGE_SIZE) break;
  }
  return parts.join('\n');
}

export async function waitParsed(ctx, id, timeoutSec) {
  const deadline = Date.now() + Math.max(1, num(timeoutSec, 600)) * 1000;
  let last = '';
  while (Date.now() < deadline) {
    const json = await api(ctx, 'GET', '/knowledge/' + encodeURIComponent(id));
    const doc = (json && json.data) || {};
    last = String(doc.parse_status || '');
    if (last === 'completed') return { status: last, error: '' };
    if (last === 'failed' || last === 'error') return { status: last, error: String(doc.error_message || '') };
    await sleep(POLL_INTERVAL_MS);
  }
  return { status: 'timeout(' + last + ')', error: '' };
}

export async function createManualDoc(ctx, kbId, title, content, maxAttempts) {
  const attempts = Math.max(1, num(maxAttempts, 1));
  const body = { title, content, status: 'publish', channel: 'web', file_name: title + '.md' };
  const target = '/knowledge-bases/' + encodeURIComponent(kbId) + '/knowledge/manual';
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const json = await api(ctx, 'POST', target, body);
      const doc = (json && json.data) || json || {};
      if (!doc.id) throw new ApiError('创建文档未返回 id: ' + briefJson(json), {});
      return doc.id;
    } catch (err) {
      lastErr = err;
      if (err.status && err.status < 500 && err.status !== 429) break;
      if (attempt < attempts) await sleep(1000 * attempt);
    }
  }
  throw lastErr || new Error('创建文档失败');
}

/** 重传正文：manual 文档走 PUT，复用既有 id，不新建文档。 */
export async function updateManualDoc(ctx, id, title, content) {
  return api(ctx, 'PUT', '/knowledge/manual/' + encodeURIComponent(id), {
    title, content, status: 'publish', channel: 'web', file_name: title + '.md'
  });
}

// ---------------- state ----------------

export function loadState(file, log) {
  const empty = { version: 1, sessions: {} };
  if (!fs.existsSync(file)) return empty;
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!state || typeof state !== 'object') throw new Error('不是对象');
    if (!state.sessions || typeof state.sessions !== 'object') state.sessions = {};
    state.version = 1;
    return state;
  } catch (err) {
    if (log) log.warn('state 损坏，按空状态继续（仍可按标题幂等）: ' + file + '（' + err.message + '）');
    return empty;
  }
}

export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// ---------------- 主流程 ----------------

function countPrefixed(existing, titlePrefix) {
  let count = 0;
  for (const title of existing.keys()) if (title.startsWith(titlePrefix)) count++;
  return count;
}

/** 一个分片对应的既有文档：state 记录的 id > 精确标题 > [尾号] 标记（会话标题漂移后仍命中同一篇）。 */
function resolveTarget(sess, existing, part, total, prev, titlePrefix) {
  const rec = prev && Array.isArray(prev.docs) ? prev.docs.find((d) => d.part === part) : null;
  if (rec && rec.knowledgeId) {
    for (const [title, doc] of existing) if (doc.id === rec.knowledgeId) return { doc, title, via: 'state-id' };
  }
  const live = docTitle(titlePrefix, sess, part, total);
  if (existing.has(live)) return { doc: existing.get(live), title: live, via: 'title' };
  const tag = '[' + sess.sid.slice(-SID_TAIL) + ']';
  for (const [title, doc] of existing) {
    if (!title.includes(tag)) continue;
    const match = /\(第 (\d+) 部分\)$/.exec(title);
    if ((match ? Number(match[1]) : 1) === part) return { doc, title, via: 'tag' };
  }
  return null;
}

const shortSid = (sid) => String(sid || '').slice(-SID_TAIL);

async function ingestRun(ctx, args) {
  const cfg = ctx.cfg;
  const log = ctx.log;
  const kb = cfg.kbs.session;
  if (!kb) throw new Error('kbs.session 未配置：请填写库①（会话记录）的知识库 id');
  if (!cfg.apiUrl) throw new Error('apiUrl 未配置：应为 http://<host>:<port>/api/v1（含版本前缀）');
  const root = cfg.sessionsRoot;
  if (!root) throw new Error('sessionsRoot 未配置：请填会话转录根目录（相对包根目录，或绝对路径）');
  if (!fs.existsSync(root)) throw new Error('sessionsRoot 不存在: ' + root);

  const settleMin = Math.max(0, num(args.values.settle, num(cfg.ingest.settleMinutes, 10)));
  const limit = Math.max(0, num(args.values.limit, 0));
  const only = String(args.values.only || '');
  const titlePrefix = String(cfg.ingest.titlePrefix || '');
  const maxDocBytes = Math.max(1024, num(cfg.ingest.maxDocBytes, 200000));
  const maxSessionDocs = Math.max(1, num(cfg.ingest.maxSessionDocs, 150));
  const maxAttempts = Math.max(1, num(cfg.ingest.maxAttempts, 3));
  const pollTimeoutSec = Math.max(1, num(cfg.ingest.pollTimeoutSec, 600));
  const skipSubagent = cfg.ingest.skipSubagentSessions !== false;

  let files = walkSessions(root);
  if (only) files = files.filter((item) => item.file.includes(only));
  if (limit) files = files.slice(0, limit);

  log.info('== run start sessions=' + files.length + (args.dryRun ? ' DRY-RUN（不写库、不写 state）' : ''));

  const state = loadState(STATE_PATH, log);
  const existing = await listDocs(ctx, kb);
  const baseDocCount = countPrefixed(existing, titlePrefix);

  const imported = [];
  const skipped = [];
  const failed = [];
  let created = 0;

  for (const item of files) {
    const file = item.file;
    let sess;
    try {
      sess = extractSession(file);
    } catch (err) {
      const sid = path.basename(path.dirname(file));
      failed.push({ sid, why: 'decode: ' + err.message });
      log.error('[decode] ' + shortSid(sid) + ' ' + err.message);
      continue;
    }
    if (skipSubagent && sess.origin === 'subagent') {
      skipped.push({ sid: sess.sid, why: 'subagent session' });
      log.detail('[skip] ' + shortSid(sess.sid) + ' 子代理会话（origin=subagent），不入库');
      continue;
    }
    if (!sess.turns.length) {
      skipped.push({ sid: sess.sid, why: 'no text' });
      log.detail('[skip] ' + shortSid(sess.sid) + ' 没有可用正文');
      continue;
    }

    const docs = buildDocs(sess, { titlePrefix, maxDocBytes });
    const hash = sha256(docs.join('\n\u0000\n'));
    const prev = state.sessions[sess.sid] || null;
    const titles = docs.map((doc, i) => docTitle(titlePrefix, sess, i + 1, docs.length));
    const targets = docs.map((doc, i) => resolveTarget(sess, existing, i + 1, docs.length, prev, titlePrefix));
    const changed = !!(prev && prev.hash !== hash);

    if (prev && !changed && targets.every(Boolean)) {
      skipped.push({ sid: sess.sid, why: 'unchanged' });
      log.detail('[skip] ' + shortSid(sess.sid) + ' 内容未变化');
      continue;
    }

    const idleMin = (Date.now() - sess.mtime) / 60000;
    if (idleMin < settleMin) {
      skipped.push({ sid: sess.sid, why: 'active' });
      log.detail('[skip] ' + shortSid(sess.sid) + ' 仍在活动（空闲 ' + Math.round(idleMin) + ' 分钟 < ' + settleMin + '）');
      continue;
    }

    const bytes = docs.reduce((sum, doc) => sum + Buffer.byteLength(doc, 'utf8'), 0);
    if (args.dryRun) {
      log.info('[dry] ' + shortSid(sess.sid) + ' turns=' + sess.turns.length + ' parts=' + docs.length
        + ' bytes=' + bytes + ' ' + (changed ? 'REFRESH' : 'NEW') + ' title=' + titles[0]);
      imported.push({ sid: sess.sid, action: changed ? 'would-refresh' : 'would-create', parts: docs.length, bytes });
      continue;
    }

    const rec = {
      sid: sess.sid, hash, file, cwd: sess.cwd, title: sess.title,
      origin: sess.origin, docs: [], updatedAt: new Date().toISOString()
    };
    try {
      if (prev && Array.isArray(prev.docs) && prev.docs.length > docs.length) {
        log.warn(shortSid(sess.sid) + ' 分片数减少 ' + prev.docs.length + '->' + docs.length + '，多余文档未删除（需人工处理）');
      }
      for (let i = 0; i < docs.length; i++) {
        const part = i + 1;
        const title = titles[i];
        const target = targets[i];
        const prevRec = prev && Array.isArray(prev.docs) ? prev.docs.find((d) => d.part === part) : null;
        const prevChunks = (prevRec && prevRec.chunks) || 0;
        let id = '';
        let action = '';
        if (target) {
          id = target.doc.id;
          if (!changed) {
            action = 'reused';
          } else {
            await updateManualDoc(ctx, id, title, docs[i]);
            action = 'refreshed';
            if (target.title !== title) existing.delete(target.title);
            existing.set(title, Object.assign({}, target.doc, { id, title }));
          }
        } else {
          if (baseDocCount + created >= maxSessionDocs) {
            throw new Error('已达 maxSessionDocs=' + maxSessionDocs + '（既有 ' + baseDocCount + ' 篇 + 本轮新建 ' + created + ' 篇）；请抬高 ingest.maxSessionDocs');
          }
          id = await createManualDoc(ctx, kb, title, docs[i], maxAttempts);
          created++;
          action = 'created';
          existing.set(title, { id, title });
        }
        const parsed = await waitParsed(ctx, id, pollTimeoutSec);
        const chunks = await chunkCount(ctx, id);
        if (chunks < 1) {
          throw new Error('索引不可用: ' + title + ' status=' + parsed.status + ' chunks=' + chunks + (parsed.error ? ' ' + parsed.error : ''));
        }
        if (parsed.status !== 'completed') {
          log.warn(shortSid(sess.sid) + ' part=' + part + ' 尚未完成解析: ' + parsed.status + '（chunks=' + chunks + '）');
        }
        rec.docs.push({ part, title, knowledgeId: id, chunks, parseStatus: parsed.status, action });
        imported.push({ sid: sess.sid, part, id, action, chunks, title });
        log.info('[' + action + '] ' + shortSid(sess.sid) + ' part=' + part + '/' + docs.length
          + ' chunks=' + (action === 'refreshed' ? prevChunks + '->' : '') + chunks + ' id=' + id + ' title=' + title);
      }
      state.sessions[sess.sid] = rec;
      saveState(STATE_PATH, state);
    } catch (err) {
      failed.push({ sid: sess.sid, why: err.message || String(err) });
      log.error('[fail] ' + shortSid(sess.sid) + ' ' + (err.message || String(err)));
    }
  }

  if (!args.dryRun) saveState(STATE_PATH, state);
  log.info('== run end imported=' + imported.length + ' skipped=' + skipped.length + ' failed=' + failed.length
    + (args.dryRun ? '（dry-run：未写库、未写 state）' : ' kbDocs=' + existing.size));
  for (const item of failed) log.error('[failed] ' + shortSid(item.sid) + ' ' + item.why);
  return failed.length ? 1 : 0;
}

export async function run(argv) {
  const list = Array.isArray(argv) ? argv : process.argv.slice(2);
  let args;
  try {
    args = parseWriterArgs(list);
  } catch (err) {
    console.error('[ingest] ' + err.message);
    return 2;
  }
  if (args.help) { console.log(USAGE); return 0; }
  if (args.unknown.length) {
    console.error('[ingest] 未知参数: ' + args.unknown.join(' ') + '\n' + USAGE);
    return 2;
  }

  const log = makeLog('[ingest]', args);
  let loaded;
  try {
    loaded = loadWriterConfig(list);
  } catch (err) {
    log.error(err.message);
    return 2;
  }
  for (const note of loaded.notes) log.info('[config] ' + note);

  const ctx = { cfg: loaded.cfg, log, timeoutMs: REQUEST_TIMEOUT_MS };
  try {
    return await ingestRun(ctx, args);
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
    console.error('[ingest] ' + (err && err.message ? err.message : String(err)));
    process.exitCode = 1;
  });
}
