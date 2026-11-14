/**
 * The user-state boundary: a published package may be replaced wholesale by an upgrade, so
 * the config, the profile card file and the logs must live outside it. These tests pin the
 * search order and the "relative paths resolve next to the config file" rule that keeps an
 * upgrade from moving the user's memory.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { PACKAGE_ROOT, loadConfig, userConfigPath, userDataDir } from "../lib/config.js";

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), "wk-home-" + label + "-"));
}

/** A package root that carries a config of its own, like the repo copy. */
function packageWithConfig(payload) {
  const root = tempDir("pkg");
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "wk-inject.config.json"), JSON.stringify(payload), "utf8");
  return root;
}

/** A user-level home: config plus a profile card file next to it. */
function userHome(config, cards = []) {
  const home = tempDir("home");
  writeFileSync(join(home, "wk-inject.config.json"), JSON.stringify(config), "utf8");
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "data", "profile.json"), JSON.stringify({ cards }), "utf8");
  return home;
}

test("the user-level config wins, and relative paths resolve next to it", () => {
  const home = userHome(
    { apiUrl: "http://user:8080/api/v1", apiKey: "user-key", pinned: [{ text: "用户自己的规则", reason: "preference" }] },
    [{ id: "u1", kind: "user", core: true, text: "陈哥哥", valid_from: "2026-10-01" }],
  );
  const pkg = packageWithConfig({ apiUrl: "http://pkg:8080/api/v1", apiKey: "pkg-key" });

  const config = loadConfig({}, { packageRoot: pkg, useUserConfig: true, env: { WK_INJECT_HOME: home } });

  assert.equal(config.apiUrl, "http://user:8080/api/v1");
  assert.equal(config.apiKey, "user-key");
  assert.equal(config.configPath, join(home, "wk-inject.config.json"));
  assert.equal(config.configHome, home);
  // The memory follows the config file, not the package that happened to load it.
  assert.equal(config.logFile, join(home, "logs", "inject.log"));
  assert.equal(config.profile.path, join(home, "data", "profile.json"));
  assert.equal(config.profile.cards.length, 1);
  assert.equal(config.profile.cards[0].text, "陈哥哥");
  assert.equal(config.pinned.length, 1);
});

test("an explicit WK_INJECT_CONFIG path outranks the home directory", () => {
  const home = userHome({ apiUrl: "http://home:8080/api/v1" });
  const other = tempDir("explicit");
  const explicit = join(other, "custom.json");
  writeFileSync(explicit, JSON.stringify({ apiUrl: "http://explicit:8080/api/v1" }), "utf8");

  const config = loadConfig({}, {
    useUserConfig: true,
    env: { WK_INJECT_HOME: home, WK_INJECT_CONFIG: explicit },
  });

  assert.equal(config.apiUrl, "http://explicit:8080/api/v1");
  assert.equal(config.configHome, other);
});

test("without the opt-in the user file is ignored, so a test stays hermetic", () => {
  const home = userHome({ apiUrl: "http://user:8080/api/v1" });
  const pkg = packageWithConfig({ apiUrl: "http://pkg:8080/api/v1" });

  const config = loadConfig({}, { packageRoot: pkg, env: { WK_INJECT_HOME: home } });

  assert.equal(config.apiUrl, "http://pkg:8080/api/v1");
  assert.equal(config.configHome, pkg);
});

test("with no file anywhere the package root is the fallback home", () => {
  const pkg = tempDir("empty");
  const config = loadConfig({}, { packageRoot: pkg, useUserConfig: true, env: { WK_INJECT_HOME: tempDir("nohome") } });

  assert.equal(config.configHome, pkg);
  assert.equal(config.configPath, join(pkg, "wk-inject.config.json"));
  assert.equal(config.logFile, join(pkg, "logs", "inject.log"));
});

test("the user data directory honours WK_INJECT_HOME and DSH_HOME", () => {
  // Compared through resolve() so the expectation holds on POSIX and on Windows alike.
  assert.equal(userDataDir({ WK_INJECT_HOME: "wk-home" }), resolve("wk-home"));
  const dshHome = join(tmpdir(), "wk-dsh");
  assert.equal(userConfigPath({ DSH_HOME: dshHome }), join(dshHome, "wk-inject", "wk-inject.config.json"));
  assert.ok(userDataDir({}).endsWith(join(".dsh", "wk-inject")));
  assert.ok(PACKAGE_ROOT);
});
