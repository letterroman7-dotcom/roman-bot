// src/discord/addons/index.js
// Defensive, lazy loader for optional add-ons so a missing file never breaks startup.
// Adds per-addon de-dupe so the same wire() isn't called twice (even if imported elsewhere).

/* ---------- logging ---------- */
function jlog(level, name, msg, extra = {}) {
  const line = JSON.stringify({ level, name, msg, ...extra });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

/* ---------- import helper ---------- */
async function tryImport(candidates) {
  for (const rel of candidates) {
    try {
      const mod = await import(rel);
      return { mod, used: rel };
    } catch (err) {
      const code =
        err?.code || (err?.message?.includes?.("Cannot find module") ? "ERR_MODULE_NOT_FOUND" : "");
      // Only warn on non-"module not found" errors; silence not-found to keep boot clean.
      if (code && code !== "ERR_MODULE_NOT_FOUND") {
        jlog("warn", "addons", "import error", { rel, path: rel, err: String(err?.message || err) });
      }
    }
  }
  return { mod: null, used: null };
}

/* ---------- de-dupe ---------- */
const SYM_WIRED = Symbol.for("roman.addons.wired");

function alreadyWired(client, name) {
  if (!client[SYM_WIRED]) client[SYM_WIRED] = new Set();
  if (client[SYM_WIRED].has(name)) return true;
  client[SYM_WIRED].add(name);
  return false;
}

/* ---------- call into module ---------- */
async function callWire(mod, used, client, name) {
  // Find a reasonable wire function export in the loaded module
  const wire =
    mod?.wireJoinGateV1 ||
    mod?.wireRestoreApplyV1 ||
    mod?.wireRaidCorrelationV1 ||
    mod?.wirePlanV1 ||
    mod?.wireRoadmapV1 ||
    mod?.wireAntiNukeV1 ||
    mod?.wirePerfV1 ||
    mod?.wire ||
    mod?.default;

  if (typeof wire !== "function") {
    jlog("warn", name, "module loaded but no wire function export", {
      used,
      exports: Object.keys(mod || {})
    });
    return;
  }

  // Per-addon de-dupe (guards against double wiring if someone imports the add-on directly elsewhere)
  if (alreadyWired(client, name)) {
    jlog("info", name, "already wired; skipping duplicate call", { used });
    return;
  }

  jlog("info", name, `${name} module loaded`, { used });
  try {
    await wire(client);
  } catch (err) {
    jlog("error", name, "wire failed", { used, err: String(err?.message || err) });
  }
}

/* ---------- individual add-on loaders ---------- */

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

/** Plan */
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

/** Roadmap */
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

/** Anti-Nuke */
export async function wireAntiNukeV1(client) {
  const { mod, used } = await tryImport([
    "./antinuke.v1.js",
    "./antinuke.js",
    "../antinuke.v1.js",
    "../antinuke.js",
  ]);
  if (!mod) { jlog("info", "antinuke", "module not found; skipping"); return; }
  await callWire(mod, used, client, "antinuke");
}

/** Perf */
export async function wirePerfV1(client) {
  const { mod, used } = await tryImport([
    "./perf.v1.js",
    "./perf.js",
    "../perf.v1.js",
    "../perf.js",
  ]);
  if (!mod) { jlog("info", "perf", "module not found; skipping"); return; }
  await callWire(mod, used, client, "perf");
}
