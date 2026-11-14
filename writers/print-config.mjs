#!/usr/bin/env node
/**
 * writers/print-config.mjs —— 把写侧最终解析出来的配置打出来，排障用。
 *
 *   node writers/print-config.mjs            # 人看的：来源文件 + 每段摘要（apiKey 打码）
 *   node writers/print-config.mjs --json     # 机器看的：register-tasks.ps1 读它拿计划任务时间
 *   node writers/print-config.mjs --config <path>   # 按指定文件解析（排障老配置）
 *
 * 配置到底从哪来、哪些字段被谁覆盖，是这类"一个文件管四件事"最容易扯皮的地方，
 * 所以这里如实打印 source（explicit / shared / legacy / example）和每条 note。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWritersConfigFor } from '../lib/writers-config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('用法: node writers/print-config.mjs [--json] [--config <path>]');
  process.exit(0);
}
const configIndex = argv.indexOf('--config');
const explicitPath = configIndex >= 0 ? argv[configIndex + 1] : '';
const asJson = argv.includes('--json');

let resolved;
try {
  resolved = loadWritersConfigFor({
    explicitPath,
    examplePath: path.join(HERE, 'config.example.json'),
    legacyPath: path.join(HERE, 'writer.config.json'),
    env: process.env
  });
} catch (error) {
  console.error('[fail] ' + (error?.message || error));
  process.exit(1);
}

const masked = { ...resolved.cfg };
masked.apiKey = masked.apiKey ? '***' + String(masked.apiKey).slice(-4) : '';

if (asJson) {
  // 给 ps1 读，就不要再夹带任何密钥；时间字段单独抽出来省得调用方去钻对象。
  const tasks = resolved.cfg.tasks && typeof resolved.cfg.tasks === 'object' ? resolved.cfg.tasks : {};
  console.log(JSON.stringify({
    file: resolved.file,
    source: resolved.source,
    notes: resolved.notes,
    enabled: resolved.cfg.__enabled === true,
    tasks: { ingest: String(tasks.ingest || 'hourly'), distill: String(tasks.distill || '00:00'), dream: String(tasks.dream || '00:30') },
    kbs: resolved.cfg.kbs ?? {},
    apiKeySet: Boolean(resolved.cfg.apiKey)
  }, null, 2));
} else {
  console.log('[config] 来源: ' + resolved.source + ' -> ' + resolved.file);
  for (const note of resolved.notes) console.log('[note] ' + note);
  console.log('[config] apiUrl=' + resolved.cfg.apiUrl + ' apiKey=' + (masked.apiKey || '(空)'));
  console.log('[config] sessionsRoot=' + (resolved.cfg.sessionsRoot || '(空)'));
  console.log('[config] kbs=' + JSON.stringify(resolved.cfg.kbs));
  console.log('[config] tasks=' + JSON.stringify(resolved.cfg.tasks));
  console.log('[config] 段落: ' + Object.keys(resolved.cfg).filter((k) => resolved.cfg[k] && typeof resolved.cfg[k] === 'object').join(', '));
}
