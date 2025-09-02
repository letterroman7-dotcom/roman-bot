// src/discord/addons/restore-apply.v1.js
// Restore-Apply v1: preview + (optional) apply of channel/role state from snapshots.
// - Resolves utils via absolute file URLs (robust on Windows/ESM).
// - Defers immediately (ephemeral) to avoid interaction timeouts.
// - Builds steps for channel field edits (name/topic/nsfw/slowmode/parent) and overwrites.
// - Drops no-op steps and always edits the reply.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { MessageFlags, PermissionFlagsBits } from "discord.js";

/* ---------------- logging helpers ---------------- */
const jlog = (level, obj) => {
  try {
    const line = JSON.stringify({ level, ...obj });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.info(line);
  } catch {}
};
const host = () => os.hostname?.() || "host";

/* ---------------- small utils ---------------- */
function stripBOM(s) { return typeof s === "string" ? s.replace(/^\uFEFF/, "") : s; }
async function readJSONSafe(file) { try { return JSON.parse(stripBOM(await fs.readFile(file, "utf8"))); } catch { return {}; } }
function asBool(v, fb) { if (typeof v === "boolean") return v; if (typeof v === "string") return v.toLowerCase() === "true"; if (typeof v === "number") return v !== 0; return fb; }
function asJson(obj) { return "```json\n" + JSON.stringify(obj, null, 2) + "\n```"; }

/* ---------------- dynamic utils importer (robust) ---------------- */
/**
 * We resolve utils using absolute file URLs so relative resolution can't fail.
 * Primary expected layout: <cwd>/src/utils/{snapshot-store.js,snapshot-diff.js}
 * Fallback layout (rare):   <cwd>/utils/{...}
 */
async function importUtils() {
  const bases = [
    path.join(process.cwd(), "src", "utils"),
    path.join(process.cwd(), "utils"),
  ];
  let lastErr = null;
  for (const base of bases) {
    try {
      const storeUrl = pathToFileURL(path.join(base, "snapshot-store.js")).href;
      const diffUrl  = pathToFileURL(path.join(base, "snapshot-diff.js")).href;
      const store = await import(storeUrl);
      const diff  = await import(diffUrl);
      jlog("info", { name: "restoreapply", msg: "utils resolved", base });
      return {
        getChannelSnapshot: store.getChannelSnapshot,
        getRoleSnapshot: store.getRoleSnapshot,
        diffChannel: diff.diffChannel,
        diffRole: diff.diffRole,
        summarizeDiff: diff.summarizeDiff,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("utils import failed");
}

/* ---------------- permissions/overwrite helpers ---------------- */
function toOverwriteResolvable(ow) {
  if (!ow) return null;
  const { id, type, allow, deny } = ow;
  let allowBits = allow;
  let denyBits = deny;

  const nameToBit = (name) => PermissionFlagsBits[name] ?? null;
  const arrToBits = (arr) => {
    try {
      let bits = 0n;
      for (const n of arr) {
        const bit = nameToBit(n);
        if (bit != null) bits |= BigInt(bit);
      }
      return bits;
    } catch { return 0n; }
  };

  if (Array.isArray(allow)) allowBits = arrToBits(allow);
  if (Array.isArray(deny))  denyBits  = arrToBits(deny);

  return { id, type, allow: allowBits, deny: denyBits };
}

function omitNoopSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.filter(s => {
    if (!s) return false;
    if (s.op === "channel.permissionOverwrites.set") return Number(s.count ?? 0) > 0;
    if (s.op === "channel.edit") return Array.isArray(s.fields) && s.fields.length > 0;
    return true;
  });
}

function buildChannelPatch(live, snap, d) {
  const changed = d?.changedFields || {};
  const patch = {};
  if ("name" in changed && typeof snap?.name === "string") patch.name = snap.name;
  if ("topic" in changed) patch.topic = snap?.topic ?? null;
  if ("nsfw" in changed && typeof snap?.nsfw !== "undefined") patch.nsfw = !!snap.nsfw;
  if ("rateLimitPerUser" in changed && typeof snap?.rateLimitPerUser !== "undefined") {
    patch.rateLimitPerUser = snap.rateLimitPerUser ?? 0;
  }
  if ("parentId" in changed && typeof snap?.parentId !== "undefined") {
    // Channel#edit expects "parent" for category reassignment
    patch.parent = snap.parentId ?? null;
  }
  return patch;
}

/* ---------------- handlers ---------------- */
async function handleChannel(ctx, id, dryRun) {
  const { i, utils } = ctx;
  const guild = i.guild;
  const live = guild?.channels?.cache?.get(id) || await guild?.channels?.fetch?.(id).catch(() => null);
  const snap = await utils.getChannelSnapshot(guild?.id, id);

  if (!live && !snap) {
    const payload = { error: `No channel live/snapshot for id=${id}` };
    await i.editReply({ content: asJson(payload) });
    return;
  }

  const d = utils.diffChannel(live, snap);
  const summary = utils.summarizeDiff(d);

  let steps = [];

  // Field edits
  const patch = buildChannelPatch(live, snap, d);
  const patchFields = Object.keys(patch);
  if (patchFields.length > 0) steps.push({ op: "channel.edit", fields: patchFields });

  // Overwrites (differences OR order mismatch)
  const owCounts = d?.overwrites?.counts || { added: 0, removed: 0, changed: 0, live: 0, snap: 0 };
  const delta = (owCounts.added || 0) + (owCounts.removed || 0) + (owCounts.changed || 0);
  const liveOrder = (live?.permissionOverwrites?.cache ? Array.from(live.permissionOverwrites.cache.values()) : []).map(o => o.id);
  const snapOrder = Array.isArray(snap?.permissionOverwrites) ? snap.permissionOverwrites.map(o => o.id) : [];
  const orderMismatch = JSON.stringify(liveOrder) !== JSON.stringify(snapOrder);

  if ((delta > 0 || orderMismatch) && (snap?.permissionOverwrites?.length || 0) > 0) {
    steps.push({ op: "channel.permissionOverwrites.set", count: snap.permissionOverwrites.length });
  }

  steps = omitNoopSteps(steps);

  const payload = { kind: "channel", id, dryRun, stepsCount: steps.length, summary, steps };

  jlog("info", {
    name: "security",
    time: Date.now(),
    pid: process.pid,
    hostname: host(),
    guild: `[id:${guild?.id}]`,
    actorId: `[id:${i.user?.id}]`,
    dryRun,
    id: `[id:${id}]`,
    steps,
    stepsCount: steps.length,
    summary,
    msg: "restore-apply.channel"
  });

  if (dryRun) {
    await i.editReply({ content: asJson(payload) });
    return;
  }

  for (const s of steps) {
    if (s.op === "channel.edit") {
      try { await live?.edit?.(patch); } catch {}
    } else if (s.op === "channel.permissionOverwrites.set") {
      const list = (snap?.permissionOverwrites || []).map(toOverwriteResolvable).filter(Boolean);
      try { await live?.permissionOverwrites?.set(list); } catch {}
    }
  }

  await i.editReply({ content: asJson(payload) });
}

async function handleRole(ctx, id, dryRun) {
  const { i, utils } = ctx;
  const guild = i.guild;
  const live = guild?.roles?.cache?.get(id) || await guild?.roles?.fetch?.(id).catch(() => null);
  const snap = await utils.getRoleSnapshot(guild?.id, id);

  if (!live && !snap) {
    const payload = { error: `No role live/snapshot for id=${id}` };
    await i.editReply({ content: asJson(payload) });
    return;
  }

  const d = utils.diffRole(live, snap);
  const summary = utils.summarizeDiff(d);
  const steps = []; // preview only for now

  const payload = { kind: "role", id, dryRun, stepsCount: steps.length, summary, steps };

  jlog("info", {
    name: "security",
    time: Date.now(),
    pid: process.pid,
    hostname: host(),
    guild: `[id:${guild?.id}]`,
    actorId: `[id:${i.user?.id}]`,
    dryRun,
    id: `[id:${id}]`,
    steps,
    stepsCount: steps.length,
    summary,
    msg: "restore-apply.role"
  });

  await i.editReply({ content: asJson(payload) });
}

/* ---------------- main wiring ---------------- */
export async function wireRestoreApplyV1(client) {
  // Load utils via absolute file URLs (fixes "Cannot find module ...src/utils/*.js")
  let utils;
  try {
    utils = await importUtils();
  } catch (err) {
    jlog("warn", {
      name: "restoreapply",
      msg: "utils import failed; skipping module",
      error: String(err?.message || err)
    });
    return;
  }

  // read config
  const cfgPath = path.join(process.cwd(), "data", "restore-apply.json");
  const cfg = Object.assign(
    { restoreApplyEnabled: true, restoreApplyDryRunDefault: true, restoreApplyMaxChanges: 75 },
    await readJSONSafe(cfgPath)
  );

  jlog("info", { name: "restoreapply", msg: "restore-apply wiring start", time: Date.now(), pid: process.pid, hostname: host() });
  jlog("info", {
    name: "restoreapply",
    msg: "restore-apply config resolved",
    time: Date.now(),
    pid: process.pid,
    hostname: host(),
    cfg: {
      restoreApplyEnabled: !!cfg.restoreApplyEnabled,
      restoreApplyDryRunDefault: !!cfg.restoreApplyDryRunDefault,
      restoreApplyMaxChanges: Number(cfg.restoreApplyMaxChanges) || 75
    }
  });

  if (!cfg.restoreApplyEnabled) return;

  // Register slash command when your run.js emits "clientReady"
  client.once("clientReady", async () => {
    try {
      const app = client.application;
      if (!app) return;
      for (const [guildId] of client.guilds.cache) {
        try {
          await app.commands.create({
            name: "restoreapply",
            description: "Preview/apply channel/role state from snapshot",
            dm_permission: false,
            options: [
              { type: 3, name: "id", description: "Channel or role ID", required: true },
              { type: 5, name: "dryrun", description: "Preview only (default true)", required: false }
            ]
          }, guildId);
          jlog("info", { name: "restoreapply", msg: "/restoreapply registered (guild)", guildId });
        } catch (err) {
          jlog("warn", { name: "restoreapply", msg: "slash register failed", guildId, err: String(err?.message || err) });
        }
      }
    } catch {}
  });

  // Handle interactions
  client.on("interactionCreate", async (i) => {
    try {
      if (!i.isChatInputCommand()) return;
      if (i.commandName !== "restoreapply") return;
      if (!i.inGuild()) { await i.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral }); return; }

      // Defer immediately to avoid timeouts while we load snapshots/diffs
      try { await i.deferReply({ flags: MessageFlags.Ephemeral }); } catch {}

      const id = i.options.getString("id", true);
      const dryRun = i.options.getBoolean("dryrun") ?? asBool(cfg.restoreApplyDryRunDefault, true);

      const asChannel = i.guild.channels.cache.has(id) || !!(await utils.getChannelSnapshot(i.guildId, id));
      const ctx = { client, i, cfg, utils };

      if (asChannel) await handleChannel(ctx, id, dryRun);
      else await handleRole(ctx, id, dryRun);
    } catch (err) {
      const payload = { error: "Command failed. Check logs.", detail: String(err?.message || err) };
      try {
        if (i.deferred || i.replied) await i.editReply({ content: asJson(payload) });
        else await i.reply({ content: asJson(payload), flags: MessageFlags.Ephemeral });
      } catch {}
    }
  });
}

export default { wireRestoreApplyV1 };
