// utils/snapshot-store.js
// v1-safe snapshot cache for channels & roles (no behavior change).
// Writes JSON files under data/snapshots/*.json with BOM-safe I/O.
// Includes getters used by restore previews.

import fs from "node:fs/promises";
import path from "node:path";
import createLogger from "./pino-factory.js";

const log = createLogger("snapshot");

const SNAP_DIR = path.join(process.cwd(), "data", "snapshots");
const CH_FILE  = path.join(SNAP_DIR, "channel-cache.json");
const RL_FILE  = path.join(SNAP_DIR, "role-cache.json");

function stripBOM(s) { return typeof s === "string" ? s.replace(/^\uFEFF/, "") : s; }
async function ensureDir(dir) { try { await fs.mkdir(dir, { recursive: true }); } catch { /* ok */ } }

async function readCache(file) {
  try {
    const raw = stripBOM(await fs.readFile(file, "utf8"));
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return { guilds: {}, savedAt: null };
    if (!obj.guilds) obj.guilds = {};
    return obj;
  } catch {
    return { guilds: {}, savedAt: null };
  }
}
async function writeCache(file, data) {
  const tmp = file + ".tmp";
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(tmp, json, "utf8");
  await fs.rename(tmp, file);
}

export function snapshotChannelData(ch) {
  try {
    const overwrites = [];
    const cache = ch?.permissionOverwrites?.cache;
    if (cache && typeof cache.forEach === "function") {
      cache.forEach((po) => {
        const allow = po?.allow?.bitfield ?? po?.allow ?? 0n;
        const deny  = po?.deny?.bitfield ?? po?.deny ?? 0n;
        overwrites.push({
          id: po?.id ?? null,
          type: po?.type ?? null, // 0=role, 1=member
          allow: allow.toString(),
          deny: deny.toString()
        });
      });
    }
    return {
      id: ch.id,
      guildId: ch.guild?.id ?? null,
      name: ch.name ?? null,
      type: ch.type ?? null,
      parentId: ch.parentId ?? null,
      position: ch.position ?? null,
      topic: ch.topic ?? null,
      nsfw: !!ch.nsfw,
      rateLimitPerUser: ch.rateLimitPerUser ?? null,
      bitrate: ch.bitrate ?? null,
      userLimit: ch.userLimit ?? null,
      rtcRegion: ch.rtcRegion ?? null,
      permissionOverwrites: overwrites
    };
  } catch {
    return { id: ch?.id ?? null, guildId: ch?.guild?.id ?? null };
  }
}

export function snapshotRoleData(role) {
  try {
    const perms = role?.permissions?.bitfield ?? role?.permissions ?? 0n;
    return {
      id: role.id,
      guildId: role.guild?.id ?? null,
      name: role.name ?? null,
      color: role.color ?? null,
      hoist: !!role.hoist,
      position: role.position ?? null,
      mentionable: !!role.mentionable,
      managed: !!role.managed,
      permissions: perms.toString()
    };
  } catch {
    return { id: role?.id ?? null, guildId: role?.guild?.id ?? null };
  }
}

export async function upsertChannelSnapshot(guildId, snap) {
  if (!guildId || !snap?.id) return;
  await ensureDir(SNAP_DIR);
  const cache = await readCache(CH_FILE);
  if (!cache.guilds[guildId]) cache.guilds[guildId] = {};
  cache.guilds[guildId][snap.id] = snap;
  cache.savedAt = new Date().toISOString();
  await writeCache(CH_FILE, cache);
}

export async function upsertRoleSnapshot(guildId, snap) {
  if (!guildId || !snap?.id) return;
  await ensureDir(SNAP_DIR);
  const cache = await readCache(RL_FILE);
  if (!cache.guilds[guildId]) cache.guilds[guildId] = {};
  cache.guilds[guildId][snap.id] = snap;
  cache.savedAt = new Date().toISOString();
  await writeCache(RL_FILE, cache);
}

export async function backfillGuildSnapshots(guild) {
  const chanValues = Array.from(guild.channels?.cache?.values?.() ?? []);
  const roleValues = Array.from(guild.roles?.cache?.values?.() ?? []);

  let chCount = 0, rlCount = 0;
  for (const ch of chanValues) {
    try {
      const snap = snapshotChannelData(ch);
      await upsertChannelSnapshot(guild.id, snap);
      chCount++;
    } catch {}
  }
  for (const r of roleValues) {
    try {
      const snap = snapshotRoleData(r);
      await upsertRoleSnapshot(guild.id, snap);
      rlCount++;
    } catch {}
  }
  log.info({ guild: `[id:${guild.id}]`, channels: chCount, roles: rlCount }, "backfilled snapshots");
  return { channels: chCount, roles: rlCount };
}

/* ---------- getters for restore preview ---------- */
export async function getChannelSnapshot(guildId, id) {
  const cache = await readCache(CH_FILE);
  if (guildId && cache.guilds[guildId]?.[id]) return cache.guilds[guildId][id];
  for (const g of Object.values(cache.guilds)) {
    if (g?.[id]) return g[id];
  }
  return null;
}

export async function getRoleSnapshot(guildId, id) {
  const cache = await readCache(RL_FILE);
  if (guildId && cache.guilds[guildId]?.[id]) return cache.guilds[guildId][id];
  for (const g of Object.values(cache.guilds)) {
    if (g?.[id]) return g[id];
  }
  return null;
}

export async function snapshotCounts() {
  const ch = await readCache(CH_FILE);
  const rl = await readCache(RL_FILE);
  const chCount = Object.values(ch.guilds||{}).reduce((a,g)=>a+Object.keys(g||{}).length,0);
  const rlCount = Object.values(rl.guilds||{}).reduce((a,g)=>a+Object.keys(g||{}).length,0);
  return { savedAt: { channels: ch.savedAt || null, roles: rl.savedAt || null }, counts: { channels: chCount, roles: rlCount } };
}

export default {
  snapshotChannelData,
  snapshotRoleData,
  upsertChannelSnapshot,
  upsertRoleSnapshot,
  backfillGuildSnapshots,
  getChannelSnapshot,
  getRoleSnapshot,
  snapshotCounts
};
