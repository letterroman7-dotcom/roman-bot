// src/discord/addons/index.js
// Defensive, lazy loader for optional add-ons so a missing file never breaks startup.

function jlog(level, name, msg, extra = {}) {
  const line = JSON.stringify({ level, name, msg, ...extra });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

async function tryImport(candidates) {
  for (const rel of candidates) {
    try {
      const mod = await import(rel);
      return { mod, used: rel };
    } catch (err) {
      const code =
        err?.code || (err?.message?.includes("Cannot find module") ? "ERR_MODULE_NOT_FOUND" : "");
      if (code && code !== "ERR_MODULE_NOT_FOUND") {
        jlog("warn", "addons", "import error", { rel, path: rel, err: String(err?.message || err) });
      }
    }
  }
  return { mod: null, used: null };
}

async function callWire(mod, used, client, name) {
  const wire =
    mod?.wireJoinGateV1 ||
    mod?.wireRestoreApplyV1 ||
    mod?.wireRaidCorrelationV1 ||
    mod?.wirePlanV1 ||
    mod?.wireRoadmapV1 ||
    mod?.wire ||
    mod?.default;

  if (typeof wire === "function") {
    jlog("info", name, `${name} module loaded`, { used });
    await wire(client);
  } else {
    jlog("warn", name, "module loaded but no wire function export", {
      used,
      exports: Object.keys(mod || {})
    });
  }
}

/** Join-Gate */
export async function wireJoinGateV1(client) {
  const { mod, used } = await tryImport([
    "./joingate.v1.js",
    "./joingate.js",
    "../joingate.v1.js",
    "../joingate.js",
  ]);
  if (!mod) { jlog("info", "joingate", "module not found; skipping"); return; }
  await callWire(mod, used, client, "joingate");
}

/** Restore-Apply */
export async function wireRestoreApplyV1(client) {
  const { mod, used } = await tryImport([
    "./restore-apply.v1.js",
    "./restoreapply.v1.js",
    "./restoreapply.js",
    "../restore-apply.v1.js",
    "../restoreapply.v1.js",
    "../restoreapply.js",
  ]);
  if (!mod) { jlog("info", "restoreapply", "module not found; skipping"); return; }
  await callWire(mod, used, client, "restoreapply");
}

/** Raid-Correlation */
export async function wireRaidCorrelationV1(client) {
  const { mod, used } = await tryImport([
    "./raidcorr.v1.js",
    "./raid-corr.v1.js",
    "./raidcorr.js",
    "../raidcorr.v1.js",
    "../raid-corr.v1.js",
    "../raidcorr.js",
  ]);
  if (!mod) { jlog("info", "raidcorr", "module not found; skipping"); return; }
  await callWire(mod, used, client, "raidcorr");
}

/** Plan (already present in your logs; kept for completeness) */
export async function wirePlanV1(client) {
  const { mod, used } = await tryImport([
    "./plan.v1.js",
    "./plan.js",
    "../plan.v1.js",
    "../plan.js",
  ]);
  if (!mod) { jlog("info", "plan", "module not found; skipping"); return; }
  await callWire(mod, used, client, "plan");
}

/** Roadmap (new) */
export async function wireRoadmapV1(client) {
  const { mod, used } = await tryImport([
    "./roadmap.v1.js",
    "./roadmap.js",
    "../roadmap.v1.js",
    "../roadmap.js",
  ]);
  if (!mod) { jlog("info", "roadmap", "module not found; skipping"); return; }
  await callWire(mod, used, client, "roadmap");
}
