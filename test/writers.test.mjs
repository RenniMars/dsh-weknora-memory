import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRITERS = ["ingest", "distill", "dream", "profile-writer"];
const script = (name) => join(ROOT, "writers", name + ".mjs");
const node = (args, options = {}) =>
  spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: 60000, ...options });

test("W1: importing a writer is side-effect free", () => {
  for (const name of WRITERS) {
    const url = pathToFileURL(script(name)).href;
    const { status, stdout, stderr } = node(["--input-type=module", "-e", "await import(" + JSON.stringify(url) + ")"]);
    assert.equal(status, 0, name + " failed to load: " + stderr.slice(0, 300));
    assert.equal(stdout.trim(), "", name + " printed at import: " + stdout.slice(0, 200));
    assert.equal(stderr.trim(), "", name + " wrote to stderr at import: " + stderr.slice(0, 200));
  }
});

test("W2: every writer answers --help with exit 0", () => {
  for (const name of WRITERS) {
    const { status, stdout } = node([script(name), "--help"]);
    assert.equal(status, 0, name + " --help exited " + status);
    assert.match(stdout, /--dry-run/, name + " help must document --dry-run");
    assert.match(stdout, /--config/, name + " help must document --config");
  }
});

test("W3: a dry run against an unreachable backend fails loudly and writes no state", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wk-writers-"));
  try {
    const configPath = join(tmp, "writer.config.json");
    writeFileSync(configPath, JSON.stringify({
      apiUrl: "http://127.0.0.1:1/api/v1",
      sessionsRoot: tmp,
      kbs: { session: "stub-session", knowledge: "stub-knowledge" },
    }));
    const stateDir = join(ROOT, "data", "writer-state");
    const before = existsSync(stateDir) ? readdirSync(stateDir).sort().join(",") + ":" + statSync(stateDir).mtimeMs : "absent";

    const { status, stdout, stderr } = node([script("ingest"), "--config", configPath, "--dry-run"]);
    const output = stdout + stderr;

    assert.notEqual(status, 0, "an unreachable backend must not look like success");
    assert.match(output, /无法连接|transport|sessionsRoot/, "the failure must be explained in one readable line: " + output.slice(0, 400));
    assert.doesNotMatch(output, /\n\s+at .*\(.*:\d+:\d+\)/, "no uncaught stack trace");

    const after = existsSync(stateDir) ? readdirSync(stateDir).sort().join(",") + ":" + statSync(stateDir).mtimeMs : "absent";
    assert.equal(after, before, "a dry run must not touch data/writer-state");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("W4: profile-writer activates a reviewable card and disputes a degraded one, text untouched", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wk-profile-"));
  try {
    const card = (id, status, text, extra = {}) => ({ id, kind: "user", core: true, key: text.slice(0, 20), text, valid_from: "2026-01-01", status, source: "m00001", ...extra });
    const profilePath = join(tmp, "profile.json");
    const statsPath = join(tmp, "profile-stats.json");
    const configPath = join(tmp, "writer.config.json");

    writeFileSync(profilePath, JSON.stringify({
      version: 1,
      cards: [
        card("user.new1", "proposed", "用户偏好 Java 后端，接口层可用 Node", { proposedAt: "2026-01-02" }),
        card("user.old1", "active", "用户长期使用 VS Code 作为主编辑器", { proposedAt: "2025-12-01", approvedAt: "2025-12-02" }),
      ],
    }, null, 2));
    writeFileSync(statsPath, JSON.stringify({ "user.old1": { degrade: 1, missStreak: 50 } }, null, 2));
    writeFileSync(configPath, JSON.stringify({ profile: { path: profilePath, statsPath } }));

    const { status, stdout, stderr } = node([script("profile-writer"), "--config", configPath, "--review", "--write"]);
    assert.equal(status, 0, "profile-writer failed: " + (stdout + stderr).slice(0, 500));

    const after = JSON.parse(readFileSync(profilePath, "utf8"));
    const byId = Object.fromEntries(after.cards.map((c) => [c.id, c]));
    assert.equal(byId["user.new1"].status, "active", "a sourced, unique, short proposed card must be approved");
    assert.equal(byId["user.old1"].status, "disputed", "an active card with a degrade marker must be disputed");
    assert.equal(byId["user.new1"].text, "用户偏好 Java 后端，接口层可用 Node", "the review must not rewrite card text");
    assert.equal(byId["user.old1"].text, "用户长期使用 VS Code 作为主编辑器", "the review must not rewrite card text");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("W5: the shipped tree carries no credential, knowledge-base id or machine path", () => {
  const targets = ["lib", "writers", "README.md", "CHANGELOG.md", "package.json", "wk-inject.config.example.json"];
  const pattern = /sk-[A-Za-z0-9]{12,}|c74994cb-991c|308b9713-61ef|a314c6ab-4fa7|D:\\work|D:\/work/g;
  const offenders = [];
  const walk = (relative) => {
    const full = join(ROOT, relative);
    if (!existsSync(full)) return;
    if (statSync(full).isDirectory()) {
      for (const entry of readdirSync(full)) walk(join(relative, entry));
      return;
    }
    if (!/\.(js|mjs|json|md|ps1|cmd|yml)$/.test(relative)) return;
    const hits = readFileSync(full, "utf8").match(pattern);
    if (hits) offenders.push(relative + " -> " + hits[0]);
  };
  targets.forEach(walk);
  assert.deepEqual(offenders, [], "shipped files must not carry secrets or machine paths");
});
