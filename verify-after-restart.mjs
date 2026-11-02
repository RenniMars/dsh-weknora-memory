/**
 * Pre-flight (now) and post-restart verification for @rennimars/dsh-weknora-memory.
 *
 *   node verify-after-restart.mjs          # both phases
 *   node verify-after-restart.mjs --pre    # manifest + resolution + patch only
 *   node verify-after-restart.mjs --post   # log tail + newest session transcript
 *
 * Nothing here starts or restarts the Harness: it only reads files.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_JSON = join(PACKAGE_ROOT, "package.json");
const BUNDLE_NAME = "@rennimars/dsh-weknora-memory";
const PROFILE_DIR = "D:/apps/DeepSeekHarness/home/profiles/web";
const INSTALL_DIR = "D:/apps/DeepSeekHarness/app";
const SESSIONS_DIR = "D:/apps/DeepSeekHarness/home/sessions";
const LOG_FILE = join(PACKAGE_ROOT, "logs", "inject.log");

const args = new Set(process.argv.slice(2));
const wantPre = args.has("--pre") || args.size === 0;
const wantPost = args.has("--post") || args.size === 0;
let failures = 0;

function check(label, ok, detail) {
  console.log((ok ? "PASS  " : "FAIL  ") + label + (detail === undefined ? "" : "  ::  " + detail));
  if (!ok) failures += 1;
  return ok;
}

/** Probe node's own node_modules lookup from an anchor, as dsh-app-boot does. */
function resolveFrom(anchorDir) {
  const req = createRequire(join(anchorDir, "package.json"));
  for (const searchPath of req.resolve.paths(BUNDLE_NAME) ?? []) {
    const candidate = join(searchPath, BUNDLE_NAME, "package.json");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Compose this bundle's layer with the very loader dsh uses at startup, so a YAML
 * or manifest mistake shows up here instead of breaking the next boot.
 */
async function loadThroughRealLoader() {
  const bootPath = join(INSTALL_DIR, "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js");
  if (!existsSync(bootPath)) {
    console.log("SKIP  dsh-app-boot not found at " + bootPath);
    return;
  }
  try {
    const boot = await import("file:///" + bootPath.replace(/\\/g, "/"));
    const installAnchor = join(INSTALL_DIR, "node_modules", "@deepseek-ai", "dsh", "package.json");
    const dir = boot.resolveBundleDir("dsh", BUNDLE_NAME, installAnchor, PROFILE_DIR);
    check("dsh loader resolves the bundle", dir !== undefined, String(dir));
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    check("dsh compatibility check passes", boot.evaluatePluginCompatibility(manifest) === undefined,
      JSON.stringify(boot.evaluatePluginCompatibility(manifest) ?? "compatible"));
    const patches = boot.bundlePatchPaths(dir, manifest.dsh.bundle).flatMap((path) => boot.loadOverlayPatches("dsh", path));
    const entries = boot.composeEntries([patches]);
    const mine = entries.filter((entry) => entry.id === "weknora-inject");
    check("composed layer mounts exactly one weknora-inject row", mine.length === 1 && mine[0].name === BUNDLE_NAME, JSON.stringify(mine));
  } catch (error) {
    check("dsh loader composes this bundle's layer", false, String(error?.message ?? error));
  }
}

async function preflight() {
  console.log("== phase 1: profile wiring (valid before any restart) ==");
  const profileJson = JSON.parse(readFileSync(join(PROFILE_DIR, "package.json"), "utf8"));
  const bundles = profileJson?.dsh?.profile?.bundles ?? [];
  check("profile bundles list this plugin", bundles.includes(BUNDLE_NAME), "position " + bundles.indexOf(BUNDLE_NAME) + " of " + bundles.length);

  const fromProfile = resolveFrom(PROFILE_DIR);
  const fromInstall = resolveFrom(INSTALL_DIR);
  check("package resolves from the installation anchor", fromInstall !== null, String(fromInstall));
  check("package resolves from the profile anchor", fromProfile !== null, String(fromProfile));

  const manifest = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
  const patchRel = manifest?.dsh?.bundle?.patch;
  check("manifest declares dsh.bundle.patch", typeof patchRel === "string", String(patchRel));
  check("declares no engines.dsh / dsh peer (compat check cannot reject it)",
    manifest.engines?.dsh === undefined && !Object.keys(manifest.peerDependencies ?? {}).some((k) => k.startsWith("@deepseek-ai/dsh")),
    "engines.dsh=" + manifest.engines?.dsh + " peers=" + JSON.stringify(manifest.peerDependencies ?? {}));
  const patchPath = join(PACKAGE_ROOT, patchRel);
  check("patch file exists", existsSync(patchPath), patchPath);
  if (existsSync(patchPath)) {
    const text = readFileSync(patchPath, "utf8");
    check("patch inserts id weknora-inject", /id:\s*weknora-inject/.test(text), "entry name " + (/name:\s*"([^"]+)"/.exec(text)?.[1] ?? "?"));
  }
  const entry = join(PACKAGE_ROOT, "lib", "index.js");
  check("plugin entry file exists", existsSync(entry), entry);
  await loadThroughRealLoader();

  const cfgPath = join(PACKAGE_ROOT, "wk-inject.config.json");
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    check("config file parses", true, "enabled=" + cfg.enabled + " apiUrl=" + cfg.apiUrl + " kbId=" + cfg.kbId);
  }
}

const SCAN_LIMIT = 8;

function newestSessionFiles(limit = SCAN_LIMIT) {
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let info;
      try { info = statSync(full); } catch { continue; }
      if (info.isDirectory()) walk(full);
      else if (name.endsWith(".jsonl.zstd")) found.push({ full, mtime: info.mtimeMs });
    }
  };
  if (!existsSync(SESSIONS_DIR)) return [];
  walk(SESSIONS_DIR);
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, limit);
}

function postRestart() {
  console.log("");
  console.log("== phase 2: after the host restart ==");
  if (!existsSync(LOG_FILE)) {
    console.log("WAIT  no log yet: " + LOG_FILE + " (nothing has run a pre-step through the plugin)");
  } else {
    const lines = readFileSync(LOG_FILE, "utf8").trim().split(/\r?\n/);
    const injected = lines.filter((line) => line.includes('"outcome":"injected"'));
    check("plugin log has injected records", injected.length > 0, injected.length + " of " + lines.length + " lines");
    console.log("last 5 log records:");
    for (const line of lines.slice(-5)) console.log("  " + line);
  }

  const candidates = newestSessionFiles();
  if (candidates.length === 0) {
    console.log("WAIT  no session transcripts found under " + SESSIONS_DIR);
    return;
  }
  let total = 0;
  for (const candidate of candidates) {
    let text = "";
    try {
      text = zstdDecompressSync(readFileSync(candidate.full)).toString("utf8");
    } catch (error) {
      console.log("SKIP  " + candidate.full + " :: " + String(error?.message ?? error));
      continue;
    }
    const hits = text.split("<weknora_context").length - 1;
    if (hits > 0) {
      total += hits;
      const at = text.lastIndexOf("<weknora_context");
      console.log("  " + candidate.full + " :: " + hits + " block(s)");
      console.log("  last block (700 chars):");
      console.log("    " + text.slice(at, at + 700).replace(/\n/g, "\n    "));
    }
  }
  check("one of the newest " + candidates.length + " transcripts contains an injected block", total > 0, total + " block(s) total");
}

if (wantPre) await preflight();
if (wantPost) postRestart();
console.log("");
console.log(failures === 0 ? "RESULT: all preflight checks passed" : "RESULT: " + failures + " check(s) failed");
process.exitCode = failures === 0 ? 0 : 1;
