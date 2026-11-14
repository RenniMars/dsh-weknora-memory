import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_TEMPLATE, ensureUserConfig, loadConfig, parseJsonc, userConfigPath } from "../lib/config.js";

// A user gets exactly one file to edit, and it has to explain itself: JSON has no comments,
// so a config full of unexplained keys is why a fresh install stays empty. These tests hold
// the template to that promise -- it must parse, it must cover the three fields nobody can
// guess, and copying it must land the loader in "unconfigured", not "silently broken".
test("the shipped template is valid JSONC and documents the three fields a user must fill", () => {
  const parsed = parseJsonc(CONFIG_TEMPLATE);
  for (const key of ["apiUrl", "apiKey", "kbIds", "pinned", "profile", "decay", "tools"]) {
    assert.ok(key in parsed, "the template must carry " + key);
  }
  assert.deepEqual(parsed.kbIds, [], "a template ships no scope: the user's ids are not guessable");
  assert.equal(parsed.apiKey, "", "a template ships no credential");
  // Comments must be real comments, not decorative: the file is unreadable without them.
  assert.ok(CONFIG_TEMPLATE.includes("//"), "the template must keep its explanatory comments");
  const lines = CONFIG_TEMPLATE.split("\n");
  const commented = lines.filter((line) => line.trim().startsWith("//")).length;
  assert.ok(commented >= 20, "expected the template to explain itself, got " + commented + " comment lines");
});

test("the template lands in the user data directory once, and never overwrites an edit", () => {
  const home = join(tmpdir(), "wk-inject-template-" + process.pid);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  try {
    const first = ensureUserConfig({ WK_INJECT_HOME: home });
    assert.equal(first.created, true);
    assert.equal(first.path, userConfigPath({ WK_INJECT_HOME: home }));
    assert.ok(existsSync(first.path));
    const written = readFileSync(first.path, "utf8");
    assert.equal(written, CONFIG_TEMPLATE);

    writeFileSync(first.path, '{ "enabled": false }', "utf8");
    const second = ensureUserConfig({ WK_INJECT_HOME: home });
    assert.equal(second.created, false, "an existing config is never replaced");
    assert.equal(readFileSync(first.path, "utf8"), '{ "enabled": false }');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a commented config with a trailing comma loads, and the template alone means unconfigured", () => {
  const home = join(tmpdir(), "wk-inject-jsonc-" + process.pid);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  try {
    const path = userConfigPath({ WK_INJECT_HOME: home });
    writeFileSync(path, [
      "{",
      "  // the backend this machine talks to",
      '  "apiUrl": "http://weknora.example:8080/api/v1",',
      '  "apiKey": "secret", /* inline comment */',
      '  "kbIds": ["kb-1", "kb-2",],',
      "}",
    ].join("\n"), "utf8");
    const cfg = loadConfig({}, { useUserConfig: true, env: { WK_INJECT_HOME: home } });
    assert.equal(cfg.configPath, path);
    assert.equal(cfg.apiUrl, "http://weknora.example:8080/api/v1");
    assert.equal(cfg.apiKey, "secret");
    assert.deepEqual(cfg.kbIds, ["kb-1", "kb-2"]);

    // Copying the template verbatim is the documented first step: it must load cleanly and
    // report itself as unconfigured, which is exactly what the startup log keys off.
    const blank = join(tmpdir(), "wk-inject-blank-" + process.pid);
    rmSync(blank, { recursive: true, force: true });
    mkdirSync(blank, { recursive: true });
    try {
      const blankPath = userConfigPath({ WK_INJECT_HOME: blank });
      writeFileSync(blankPath, CONFIG_TEMPLATE, "utf8");
      const fresh = loadConfig({}, { useUserConfig: true, env: { WK_INJECT_HOME: blank } });
      assert.equal(fresh.apiKey, "");
      assert.deepEqual(fresh.kbIds, []);
      assert.equal(fresh.enabled, true, "the template is on, it is just not filled in yet");
    } finally {
      rmSync(blank, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a config file that is pure JSON still loads unchanged", () => {
  const home = join(tmpdir(), "wk-inject-plainjson-" + process.pid);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  try {
    const path = userConfigPath({ WK_INJECT_HOME: home });
    writeFileSync(path, JSON.stringify({ apiUrl: "http://plain:8080/api/v1", kbIds: ["k"] }), "utf8");
    const cfg = loadConfig({}, { useUserConfig: true, env: { WK_INJECT_HOME: home } });
    assert.equal(cfg.apiUrl, "http://plain:8080/api/v1");
    assert.deepEqual(cfg.kbIds, ["k"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
