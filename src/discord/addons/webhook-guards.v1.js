// src/discord/addons/webhook-guards.v1.js
// Webhook Guards v1 — auto-locate and wire webhook guard handlers anywhere in the repo.
//
// Finds files whose names contain: "webhook" + ("create"|"update"|"delete") + "guard"
// Accepts variants like: webhookCreate.guard.js, webhook-create.guard.js, webhook.create.guard.mjs, etc.
// Scans the whole repo (process.cwd()), skipping heavy/system dirs.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import createLogger from "../../../utils/pino-factory.js";
import { loadWebhookGuardConfig } from "../../../utils/webhook-guard.js";

const log = createLogger("webhook-guards");
const FLAG = Symbol.for("roman.webhookGuardsV1Wired");

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "coverage", ".next",
  ".cache", "out", "bin", "tmp", "temp", ".turbo", ".yarn", ".pnpm-store",
]);

// filename matcher (case-insensitive, allows -, _, .)
function makeMatcher(kind /* 'create'|'update'|'delete' */) {
  const k = kind.toLowerCase();
  return (base) => {
    const s = base.toLowerCase();
    const has = (t) => s.includes(t);
    const okExt = [".js", ".mjs", ".cjs", ".ts"].some(ext => s.endsWith(ext));
    // require all tokens
    return okExt && has("webhook") && has("guard") && has(k);
  };
}

async function findOneFile(matchFn, roots) {
  const stack = [...roots];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { continue; }

    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) stack.push(full);
      } else if (ent.isFile()) {
        if (matchFn(ent.name)) return full;
      }
    }
  }
  return null;
}

async function resolveGuards() {
  const cwd = process.cwd();
  const roots = [path.join(cwd, "src"), cwd]; // prefer src/, then fallback to repo root

  const createPath = await findOneFile(makeMatcher("create"), roots);
  const updatePath = await findOneFile(makeMatcher("update"), roots);
  const deletePath = await findOneFile(makeMatcher("delete"), roots);

  const pretty = (p) => p ? path.relative(cwd, p) : null;
  if (createPath) log.info({ used: pretty(createPath) }, "create-guard resolved");
  else log.warn("create-guard file not found anywhere in repo");
  if (updatePath) log.info({ used: pretty(updatePath) }, "update-guard resolved");
  else log.warn("update-guard file not found anywhere in repo");
  if (deletePath) log.info({ used: pretty(deletePath) }, "delete-guard resolved");
  else log.warn("delete-guard file not found anywhere in repo");

  return { createPath, updatePath, deletePath };
}

async function importWireFn(absPath, label) {
  if (!absPath) return null;
  try {
    const mod = await import(pathToFileURL(absPath).href);
    const fn = mod?.default;
    if (typeof fn !== "function") {
      log.warn({ used: absPath }, `${label} lacks default export function`);
      return null;
    }
    return fn;
  } catch (e) {
    log.warn({ used: absPath, err: String(e?.stack || e) }, `failed to import ${label}`);
    return null;
  }
}

export async function wireWebhookGuardsV1(client) {
  if (!client) return;
  if (client[FLAG]) { log.info("webhook-guards already wired (skipping)"); return; }
  Object.defineProperty(client, FLAG, { value: true, enumerable: false });

  log.info("webhook-guards wiring start");

  const { createPath, updatePath, deletePath } = await resolveGuards();

  const [wireCreate, wireUpdate, wireDelete] = await Promise.all([
    importWireFn(createPath, "webhookCreate.guard"),
    importWireFn(updatePath, "webhookUpdate.guard"),
    importWireFn(deletePath, "webhookDelete.guard"),
  ]);

  let wired = 0;
  try { if (wireCreate) { wireCreate(client); wired++; } else log.warn("webhookCreate.guard not wired"); } catch (e) { log.warn({ err: String(e?.stack||e) }, "webhookCreate.guard wiring failed"); }
  try { if (wireUpdate) { wireUpdate(client); wired++; } else log.warn("webhookUpdate.guard not wired"); } catch (e) { log.warn({ err: String(e?.stack||e) }, "webhookUpdate.guard wiring failed"); }
  try { if (wireDelete) { wireDelete(client); wired++; } else log.warn("webhookDelete.guard not wired"); } catch (e) { log.warn({ err: String(e?.stack||e) }, "webhookDelete.guard wiring failed"); }

  client.once?.("ready", async () => {
    try {
      const cfg = await loadWebhookGuardConfig();
      log.info({ cfg }, "webhook-guard config resolved");
    } catch (e) {
      log.info({ err: String(e?.message || e) }, "webhook-guard config resolved (defaults/file missing)");
    }
    const status = wired === 3 ? "all" : (wired === 0 ? "none" : "partial");
    log.info({ wired }, `webhook-guards active (${status} wired)`);
  });
}

export default wireWebhookGuardsV1;
