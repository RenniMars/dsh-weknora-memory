/**
 * 写入侧（writers/）的配置解析：和读侧共用同一份文件。
 *
 * 用户要的是"所有配置一个文件"：插件读 ~/.dsh/wk-inject/wk-inject.config.json，
 * 四个写侧脚本也从这里读 `writers` 段，而不是各自再躺一个 writer.config.json。
 *
 * 兼容顺序（先给的赢）：
 *   1. `--config <path>` 明确指定的文件（老用法，测试也靠它）
 *   2. 共享配置里的 `writers` 段，叠加在同一份文件顶层的 apiUrl / apiKey 之上
 *   3. writers/writer.config.json（老安装还没搬配置时）
 *   4. writers/config.example.json 的出厂默认值
 *
 * apiKey 的口径：环境变量 WEKNORA_API_KEY 优先；没有就取**共享配置**里的 apiKey
 * （用户已决定明文留本机，不再逼人另设环境变量）；writers/writer.config.json 里的
 * apiKey 照旧不读——防止有人顺手把密钥提交进仓库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonc, userConfigPath } from './config.js';

/** 共享配置文件的位置，与读侧 loadConfig 的查找顺序一致（WK_INJECT_CONFIG → 用户目录）。 */
export function sharedConfigPath(env = process.env) {
  const explicit = String(env?.WK_INJECT_CONFIG ?? '').trim();
  if (explicit) return path.resolve(explicit);
  return userConfigPath(env ?? {});
}

/** 读共享配置；不存在或读坏了都返回空数据，让调用方回落到老配置，绝不抛。 */
export function readSharedConfig(env = process.env) {
  const file = sharedConfigPath(env);
  if (!fs.existsSync(file)) return { path: file, exists: false, data: {}, error: '' };
  try {
    const parsed = parseJsonc(fs.readFileSync(file, 'utf8'));
    return { path: file, exists: true, data: parsed && typeof parsed === 'object' ? parsed : {}, error: '' };
  } catch (error) {
    return { path: file, exists: true, data: {}, error: String(error?.message || error) };
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 深合并：对象逐层合，数组和标量整体替换（配置里没有"追加"语义）。 */
export function mergeDeep(base, over) {
  if (!isPlainObject(over)) return over === undefined ? base : over;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeDeep(out[key], value) : value;
  }
  return out;
}

function readJsoncFile(file) {
  return parseJsonc(fs.readFileSync(file, 'utf8'));
}

/**
 * 解析出写侧最终配置。
 * @returns {{ cfg: object, file: string, source: 'explicit'|'shared'|'legacy'|'example', notes: string[] }}
 */
export function loadWritersConfigFor(options = {}) {
  const env = options.env ?? process.env;
  const explicitPath = String(options.explicitPath || '').trim();
  const examplePath = options.examplePath;
  const legacyPath = options.legacyPath || '';
  const notes = [];
  if (!examplePath || !fs.existsSync(examplePath)) throw new Error('缺少默认配置：' + String(examplePath));

  const defaults = readJsoncFile(examplePath);
  const envKey = String(env?.WEKNORA_API_KEY || '').trim();
  const shared = readSharedConfig(env);
  const sharedKey = String(shared.data?.apiKey || '').trim();
  let layer = {};
  let file = examplePath;
  let source = 'example';

  if (explicitPath) {
    const resolved = path.resolve(process.cwd(), explicitPath);
    if (!fs.existsSync(resolved)) throw new Error('配置文件不存在：' + resolved);
    file = resolved;
    source = 'explicit';
    // 明确指定了文件就只认它：排障时要能说出到底哪一份在生效。
    layer = readJsoncFile(resolved);
  } else {
    const legacy = legacyPath && fs.existsSync(legacyPath);
    const writersBlock = isPlainObject(shared.data?.writers) ? shared.data.writers : null;
    if (shared.error) notes.push('共享配置解析失败，按出厂默认值继续：' + shared.path + '（' + shared.error + '）');
    if (legacy) {
      layer = readJsoncFile(legacyPath);
      file = legacyPath;
      source = 'legacy';
      notes.push('共享配置里没有 writers 段，用的是 writers/writer.config.json');
    } else if (!writersBlock) {
      notes.push('没有 writers 段，也没找到 writers/writer.config.json，按 config.example.json 的默认值继续');
    }
    if (writersBlock) {
      // writers 段赢过老的 writer.config.json；顶层 apiUrl 只补空值。
      const fromTop = {};
      if (!writersBlock.apiUrl && typeof shared.data.apiUrl === 'string' && shared.data.apiUrl) fromTop.apiUrl = shared.data.apiUrl;
      layer = mergeDeep(mergeDeep(layer, fromTop), writersBlock);
      file = shared.path;
      source = 'shared';
    }
  }

  const cfg = mergeDeep(defaults, layer);
  // writers 段里的 enabled 是"用户要不要跑写侧"，不是脚本参数：抬到顶层给 print-config / 任务注册看。
  cfg.__enabled = layer?.enabled === true;
  const fileKey = String(cfg.apiKey || '').trim();
  cfg.apiKey = envKey || (source === 'explicit' ? fileKey : sharedKey);
  if (!cfg.apiKey) notes.push('没有密钥：环境变量 WEKNORA_API_KEY 与共享配置的 apiKey 都是空的，本次请求不带 X-API-Key');
  else if (!envKey && source !== 'explicit') notes.push('密钥取自共享配置的 apiKey');
  return { cfg, file, source, notes };
}
