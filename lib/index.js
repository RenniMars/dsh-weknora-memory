/**
 * DSH host-plane plugin: per-turn WeKnora context injection.
 *
 * Mounted from cordis.patch.yml (id: weknora-inject). It listens on
 * agent/pre-step with { prepend: true } and appends at most one bounded
 * <weknora_context> message per step when WeKnora returns relevant hits.
 * Every failure path (bad config, unreachable backend, timeout) degrades to an
 * untouched decision, so a session never fails or stalls because of it.
 */
import { join } from "node:path";
import { PACKAGE_ROOT, createLogger, loadConfig } from "./config.js";
import { createWeKnoraInjector, PLUGIN_ID } from "./injector.js";
import { panelRoutes } from "./panel.js";
import { mountTools } from "./mount-tools.js";

export const name = PLUGIN_ID;

export function apply(ctx, config) {
  let cfg;
  let log;
  let injector;
  try {
    cfg = loadConfig(config ?? {}, { useUserConfig: true });
    log = createLogger(cfg);
    injector = createWeKnoraInjector({ config: cfg, log });
  } catch {
    return;
  }
  if (!cfg.enabled || !cfg.apiUrl) return;
  try {
    ctx.logger?.("weknora-inject")?.info?.("weknora-inject ready (WeKnora " + cfg.apiUrl + ")");
  } catch {}
  ctx.on("agent/pre-step", (input, next) => injector.preStep(input, next), { prepend: true });
  ctx.on?.("agent/disposed", ({ agent }) => injector.forget(agent?.session?.header?.id));
  // The four model-facing tools. Same backend, same credential, same knowledge bases as
  // the injection above -- the difference is who starts: injection pushes context before the
  // model answers, a tool lets the model pull when it decides to. Mounted on its own
  // ctx.inject(["tools"]) so a host without a tool registry keeps the injection, and a bad
  // tool config costs the tools only, never the turn.
  if (cfg.toolsEnabled) {
    const registerTools = (scope) => {
      try {
        const { mounted, failed } = mountTools(scope, cfg);
        ctx.logger?.("weknora-inject")?.info?.("tools mounted (" + mounted.join(", ") + ")");
        for (const miss of failed) {
          ctx.logger?.("weknora-inject")?.info?.("tool not mounted: " + miss.name + " -- " + miss.reason);
        }
      } catch (error) {
        ctx.logger?.("weknora-inject")?.info?.("tool mount failed: " + String(error?.message ?? error));
      }
    };
    try {
      if (typeof ctx.inject === "function") ctx.inject(["tools"], registerTools);
      else if (ctx.tools?.register) registerTools(ctx);
      else throw new Error("no tools registry in this host");
    } catch (error) {
      ctx.logger?.("weknora-inject")?.info?.("tools failed: " + String(error?.message ?? error));
    }
  }
  // The panel reads and writes the same files the injector reads. It mounts as a prefix
  // route on the GUI's own web server, so the tab talks to the page's own origin: no second
  // listener, no port to keep in sync, no CORS preflight to fail. webServer arrives with the
  // GUI bundle, so a headless host simply never gets a panel -- injection is unaffected.
  if (cfg.panelEnabled) {
    const disposers = [];
    const register = (scope) => {
      try {
        // The GUI's /api transport owns the Host/Origin fence and the browser session, and
        // dispatches only the exact Fetch routes registered here. Registering on webServer
        // instead would sit behind that fence and answer 401 to every panel request.
        for (const route of panelRoutes({
          config: cfg,
          profilePath: cfg.profile.path,
          statsPath: cfg.profile.statsPath,
          logFile: cfg.logFile,
          backupDir: join(PACKAGE_ROOT, "data", "backups"),
        })) {
          disposers.push(scope.connection.fetch.register(route));
        }
        ctx.logger?.("weknora-inject")?.info?.("memory panel mounted (" + disposers.length + " routes)");
      } catch (error) {
        ctx.logger?.("weknora-inject")?.info?.("panel mount failed: " + String(error?.message ?? error));
      }
    };
    try {
      // connection arrives with the GUI bundle; a headless host has none, and there the
      // panel simply does not exist -- injection is unaffected either way.
      if (typeof ctx.inject === "function") ctx.inject(["connection"], register);
      else register(ctx);
      ctx.on?.("disposed", () => {
        for (const dispose of disposers) {
          try { dispose(); } catch {}
        }
      });
    } catch (error) {
      ctx.logger?.("weknora-inject")?.info?.("panel failed: " + String(error?.message ?? error));
    }
  }
}

export default { name, apply };
