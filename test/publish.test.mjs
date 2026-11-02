/**
 * The package is published: these assertions guard the parts of the contract a release
 * cannot get wrong -- no credentials or personal files inside the tarball, and an endpoint
 * or key that can come from the environment instead of the JSON file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../lib/config.js";

const ROOT = new URL("../", import.meta.url);

test("P1: the manifest ships no personal data and declares what the market reads", () => {
  const pkg = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8"));
  assert.equal(pkg.private, undefined, "a private package cannot be installed from a registry");
  assert.equal(pkg.license, "MIT");
  assert.match(pkg.name, /^@[A-Za-z0-9._-]+\/[a-z0-9._-]+$/, "the published name is scoped");
  assert.ok(pkg.engines && pkg.engines.dsh, "the market reads engines.dsh for compatibility");
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes("dsh-plugin"), "discovery keys on the keyword");
  assert.ok(pkg.repository && pkg.repository.url, "an entry without a repository cannot be updated");
  for (const entry of pkg.files) {
    assert.ok(!entry.startsWith("data"), entry + " must not ship runtime data");
    assert.ok(!entry.includes("wk-inject.config.json"), "only the example config ships");
  }
  assert.ok(pkg.files.includes("wk-inject.config.example.json"));
  assert.equal(pkg.dsh.client.platform, "web", "the sidebar panel needs a web shell");
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
});

test("P2: the example config carries no credential and starts switched off", () => {
  const example = JSON.parse(readFileSync(new URL("wk-inject.config.example.json", ROOT), "utf8"));
  assert.equal(example.enabled, false, "an unconfigured install must not query whatever apiUrl is left");
  assert.equal(example.apiKey, "");
  assert.deepEqual(example.kbIds, [], "no knowledge base of the author's own may ship");
  assert.deepEqual(example.kbNames, {});
});

test("P3: the endpoint and the key can come from the environment", () => {
  const base = { profile: { enabled: false } };
  const fromEnv = loadConfig({ ...base }, { env: { WEKNORA_API_URL: "http://kb.example/api/v1", WEKNORA_API_KEY: "k-1" } });
  assert.equal(fromEnv.apiUrl, "http://kb.example/api/v1");
  assert.equal(fromEnv.apiKey, "k-1");
  const fromFile = loadConfig({ ...base, apiUrl: "http://file.example/api/v1", apiKey: "file-key" }, { env: {} });
  assert.equal(fromFile.apiUrl, "http://file.example/api/v1", "with no environment the file still configures it");
  assert.equal(fromFile.apiKey, "file-key");
  const envWins = loadConfig({ ...base, apiKey: "file-key" }, { env: { WEKNORA_API_KEY: "env-key" } });
  assert.equal(envWins.apiKey, "env-key", "the environment wins, so a key never has to live in the file");
});
