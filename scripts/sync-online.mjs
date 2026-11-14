#!/usr/bin/env node
/**
 * Keep the installed copy equal to the published one.
 *
 * The profile loads the plugin from its own node_modules, and that copy must be exactly
 * what npm serves -- a directory symlinked back into this repo is not a version, it is
 * whatever happens to be on disk. This script reports the drift, and with --install it
 * pulls the published tarball over the installed copy. User state (config, profile cards,
 * decay state, logs) lives in <DSH_HOME>/wk-inject and is never touched here.
 *
 *   node scripts/sync-online.mjs              # 本地版本 / 线上版本 / 已安装版本
 *   node scripts/sync-online.mjs --install    # 把线上最新版装进 profile
 *
 * Exit code 1 when --check is passed and the three versions disagree.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = "@rennimars/dsh-weknora-memory";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const profileDir = process.env.DSH_PROFILE_DIR?.trim() || join(homedir(), ".dsh", "profiles", "desktop");
const installedDir = join(profileDir, "node_modules", ...PKG.split("/"));

const localVersion = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;

function installedVersion() {
  try {
    return JSON.parse(readFileSync(join(installedDir, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

async function registry() {
  const response = await fetch("https://registry.npmjs.org/" + PKG.replace("/", "%2F"), {
    headers: { "User-Agent": "dsh-weknora-memory-sync" },
  });
  if (!response.ok) throw new Error("registry answered " + response.status);
  const body = await response.json();
  return { latest: body["dist-tags"].latest, tarball: body.versions[body["dist-tags"].latest].dist.tarball };
}

async function install(tarball) {
  const file = join(tmpdir(), "wk-sync-" + process.pid + ".tgz");
  writeFileSync(file, Buffer.from(await (await fetch(tarball)).arrayBuffer()));
  // A symlink back into the repo is the old dev wiring: it has to go, not be written through.
  if (existsSync(installedDir) && lstatSync(installedDir).isSymbolicLink()) unlinkSync(installedDir);
  rmSync(installedDir, { recursive: true, force: true });
  mkdirSync(installedDir, { recursive: true });
  execFileSync("tar", ["-xzf", file, "-C", installedDir, "--strip-components=1"], { stdio: "inherit" });
  rmSync(file, { force: true });
  // Pin the exact version: a caret range would let the next npm install drift silently.
  const pkgPath = join(profileDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.dependencies = pkg.dependencies ?? {};
  pkg.dependencies[PKG] = installedVersion();
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  const bundles = pkg.dsh?.profile?.bundles;
  if (Array.isArray(bundles) && !bundles.includes(PKG)) {
    bundles.push(PKG);
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  }
}

const { latest, tarball } = await registry();
if (args.has("--install") && installedVersion() !== latest) await install(tarball);

const installed = installedVersion();
const same = localVersion === latest && installed === latest;
console.log("本地仓库:", localVersion);
console.log("npm 线上:", latest);
console.log("已安装  :", installed ?? "未安装", "(" + profileDir + ")");
console.log(same ? "三者一致。" : "不一致：本地改完要先发版（tag），再 --install 拉线上版。");
if (args.has("--check") && !same) process.exitCode = 1;
