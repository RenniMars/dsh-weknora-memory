/**
 * 写侧配置解析：一个文件（读写共用）而不是两个。
 *
 * 这组用例守的是"用户改一处、四件事全都认"：
 *   - 共享配置的 writers 段就是写侧的配置；
 *   - 老的 writers/writer.config.json 还能读，避免老安装升级即坏；
 *   - --config 指定文件时只认它（排障时不叠加，免得看不出谁在生效）；
 *   - 密钥优先环境变量，其次共享配置那一把。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.join(HERE, "..", "writers", "config.example.json");
const { loadWritersConfigFor, sharedConfigPath } = await import("../lib/writers-config.js");

function homeWith(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wk-writers-"));
  fs.writeFileSync(path.join(dir, "wk-inject.config.json"), text);
  return { env: { WK_INJECT_HOME: dir }, dir, file: path.join(dir, "wk-inject.config.json") };
}

test("the writers block of the shared config is what the write side reads", () => {
  const { env, file } = homeWith(JSON.stringify({
    apiUrl: "http://127.0.0.1:9999/api/v1",
    apiKey: "shared-key",
    writers: {
      enabled: true,
      sessionsRoot: "/sessions",
      kbs: { session: "kb-s", knowledge: "kb-k", material: "kb-m" },
      ingest: { settleMinutes: 3 },
      tasks: { ingest: "every6h", distill: "02:15", dream: "02:45" }
    }
  }, null, 2));
  const resolved = loadWritersConfigFor({ examplePath: EXAMPLE, legacyPath: "", env });
  assert.equal(resolved.source, "shared");
  assert.equal(resolved.file, file);
  assert.equal(resolved.cfg.apiUrl, "http://127.0.0.1:9999/api/v1", "writers.apiUrl 空时取共享配置顶层的 apiUrl");
  assert.equal(resolved.cfg.apiKey, "shared-key", "共享配置那一把密钥就是写侧的密钥");
  assert.equal(resolved.cfg.sessionsRoot, "/sessions");
  assert.deepEqual(resolved.cfg.kbs, { session: "kb-s", knowledge: "kb-k", material: "kb-m" });
  assert.equal(resolved.cfg.ingest.settleMinutes, 3, "writers 段盖过出厂默认值");
  assert.equal(resolved.cfg.ingest.maxDocBytes, 200000, "没写的字段仍取出厂默认值");
  assert.equal(resolved.cfg.tasks.ingest, "every6h");
  assert.equal(resolved.cfg.__enabled, true);
});

test("the shared config may carry JSONC comments and trailing commas", () => {
  const { env, dir } = homeWith(`{
  // 连接
  "apiKey": "k-1",
  "writers": {
    "kbs": { "session": "kb-s", },
    /* 时间 */
    "tasks": { "ingest": "hourly", },
  },
}`);
  const resolved = loadWritersConfigFor({ examplePath: EXAMPLE, legacyPath: "", env });
  assert.equal(resolved.cfg.apiKey, "k-1");
  assert.equal(resolved.cfg.kbs.session, "kb-s");
  assert.equal(resolved.cfg.__enabled, false, "没写 enabled 就是没打开");
  assert.equal(sharedConfigPath(env), path.join(dir, "wk-inject.config.json"));
});

test("an old writer.config.json still loads when the shared config has no writers block", () => {
  const { env, dir } = homeWith(JSON.stringify({ apiKey: "shared-key" }));
  const legacy = path.join(dir, "writer.config.json");
  fs.writeFileSync(legacy, JSON.stringify({ sessionsRoot: "/old-sessions", kbs: { session: "legacy-kb" } }));
  const resolved = loadWritersConfigFor({ examplePath: EXAMPLE, legacyPath: legacy, env });
  assert.equal(resolved.source, "legacy");
  assert.equal(resolved.cfg.sessionsRoot, "/old-sessions");
  assert.equal(resolved.cfg.kbs.session, "legacy-kb");
  assert.equal(resolved.cfg.apiKey, "shared-key", "老文件里的 apiKey 照旧不读，密钥仍来自共享配置");
  assert.ok(resolved.notes.some((n) => n.includes("writer.config.json")));
});

test("--config wins outright and does not get merged with the shared config", () => {
  const { env, dir } = homeWith(JSON.stringify({ apiKey: "shared-key", writers: { kbs: { session: "kb-shared" } } }));
  const explicit = path.join(dir, "only-this.json");
  fs.writeFileSync(explicit, JSON.stringify({ apiKey: "file-key", kbs: { knowledge: "kb-explicit" } }));
  const resolved = loadWritersConfigFor({ explicitPath: explicit, examplePath: EXAMPLE, legacyPath: "", env });
  assert.equal(resolved.source, "explicit");
  assert.equal(resolved.cfg.apiKey, "file-key", "显式文件里的密钥才允许用");
  assert.equal(resolved.cfg.kbs.knowledge, "kb-explicit");
  assert.equal(resolved.cfg.kbs.session, "", "共享配置的 writers 段不再叠加");
});

test("WEKNORA_API_KEY still outranks the shared config's key", () => {
  const { env } = homeWith(JSON.stringify({ apiKey: "shared-key", writers: { kbs: { session: "kb-s" } } }));
  const resolved = loadWritersConfigFor({ examplePath: EXAMPLE, legacyPath: "", env: { ...env, WEKNORA_API_KEY: "env-key" } });
  assert.equal(resolved.cfg.apiKey, "env-key");
  assert.ok(!resolved.notes.some((n) => n.includes("密钥取自共享配置")));
});

test("a broken shared config degrades to the shipped defaults instead of throwing", () => {
  const { env } = homeWith("{ this is not json ");
  const resolved = loadWritersConfigFor({ examplePath: EXAMPLE, legacyPath: "", env });
  assert.equal(resolved.source, "example");
  assert.equal(resolved.cfg.kbs.session, "");
  assert.ok(resolved.notes.some((n) => n.includes("解析失败")));
});
