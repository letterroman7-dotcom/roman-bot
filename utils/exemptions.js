// utils/exemptions.js
// Centralized exemptions loader + checker (BOM-safe, hot-reloads).
//
// File shape (all lists are arrays of action names or ["*"]):
// {
//   "$schema": "../schemas/exemptions.schema.json",
//   "notes": "Actions: antiSpam, massGuard, permDiff, autoRestore, botGuard, ownerProtection. Use \"*\" for all actions.",
//   "users": { "<userId>": ["*"] },
//   "roles": { "<roleId>": ["massGuard", "permDiff"] },
//   "guilds": {
//     "<guildId>": {
//       "users": { "<userId>": ["permDiff"] },
//       "roles": { "<roleId>": ["*"] }
//     }
//   }
// }

import fs from "node:fs/promises";
import path from "node:path";
import createLogger from "./pino-factory.js";

const log = createLogger("exemptions");
const ROOT = process.cwd();
const FILE = path.join(ROOT, "data", "exemptions.json");

const stripBOM = (s) => (typeof s === "string" ? s.replace(/^\uFEFF/, "") : s);
const asArr = (v) => Array.isArray(v) ? v : (v == null ? [] : [v]);

let cache = { data: null, mtimeMs: 0 };

async function readFileIfChanged() {
  try {
    const st = await fs.stat(FILE);
    if (!cache.data || st.mtimeMs !== cache.mtimeMs) {
      const raw = await fs.readFile(FILE, "utf8");
      const json = JSON.parse(stripBOM(raw));
      cache = { data: normalize(json), mtimeMs: st.mtimeMs };
      log.info({ entries: {
        users: Object.keys(cache.data.users || {}).length,
        roles: Object.keys(cache.data.roles || {}).length,
        guilds: Object.keys(cache.data.guilds || {}).length
      } }, "exemptions loaded");
    }
  } catch (err) {
    // If file missing/invalid, keep a safe empty structure
    if (!cache.data) cache = { data: normalize({}), mtimeMs: 0 };
    log.warn({ err: String(err?.message || err) }, "exemptions load failed; using empty set");
  }
}

function toSetMap(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = new Set(asArr(v));
  return out;
}

function normalize(src = {}) {
  return {
    users: toSetMap(src.users),
    roles: toSetMap(src.roles),
    guilds: Object.fromEntries(Object.entries(src.guilds || {}).map(([gid, g]) => ([
      gid,
      { users: toSetMap(g?.users), roles: toSetMap(g?.roles) }
    ])))
  };
}

/**
 * Check if actor is exempt from an action.
 * @param {object} p
 * @param {string} [p.guildId]
 * @param {string} [p.userId]
 * @param {string[]} [p.roleIds]
 * @param {string} [p.action] - e.g., "antiSpam","massGuard","permDiff","autoRestore","botGuard","ownerProtection"
 * @returns {{exempt:boolean, source?:string, matched?:string}}
 */
export async function isExempt({ guildId, userId, roleIds = [], action }) {
  await readFileIfChanged();
  const ex = cache.data;

  // helper
  const has = (set, act) => set?.has?.("*") || (act && set?.has?.(act));

  // Global users
  if (userId && has(ex.users[userId], action)) {
    return { exempt: true, source: "global.users", matched: userId };
  }
  // Global roles
  for (const r of roleIds) {
    if (has(ex.roles[r], action)) return { exempt: true, source: "global.roles", matched: r };
  }
  // Guild-specific
  const g = guildId && ex.guilds[guildId];
  if (g) {
    if (userId && has(g.users[userId], action)) return { exempt: true, source: "guild.users", matched: userId };
    for (const r of roleIds) {
      if (has(g.roles[r], action)) return { exempt: true, source: "guild.roles", matched: r };
    }
  }
  return { exempt: false };
}

export default { isExempt };
