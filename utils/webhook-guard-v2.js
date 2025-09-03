// utils/webhook-guard-v2.js
// Webhook Guard v2: strict allowlist enforcement.
// - Reads policy from data/webhook-guard-v2.json
// - Enforces on:
//   (1) webhooksUpdate gateway event (fast + reliable)
//   (2) startup sweep across all guilds (optional, defaults true)
// - Leaves your existing v1 guards untouched.
//
// Expected config (Windows-safe name): data/webhook-guard-v2.json
// {
//   "enabled": true,
//   "mode": "strict-allowlist",
//   "logSeverity": "warn",            // "silent" | "warn" | "info" | "debug"
//   "auditChannelId": null,
//   "punishExecutor": false,
//   "punishAction": "none",
//   "allowlist": { "webhookIds": [], "channelIds": [], "creatorUserIds": [] },
//   "autoDeleteRogueWebhooks": true,
//   "autoRevokeTokens": true,
//   "rateLimits": { "createPerMinute": 3, "updatePerMinute": 6, "deletePerMinute": 6 },
//   "exempt": { "roleIds": [], "userIds": [] },
//
//   // New (optional):
//   "startupSweep": true,             // run a sweep on ready (default true)
//   "blockBotCreatesOutsideAllow": false // if true, even bot-created hooks outside allowlist are removed
// }

import fs from "node:fs";
import path from "node:path";

const NAME = "webhook.v2";
const DATA_PATH = path.join(process.cwd(), "data", "webhook-guard-v2.json");

function jlog(level, obj) {
  try {
    const rec = { level, name: NAME, ...obj };
    if (level === "error") console.error(JSON.stringify(rec));
    else if (level === "warn") console.warn(JSON.stringify(rec));
    else console.info(JSON.stringify(rec));
  } catch { /* noop */ }
}

function readJSONSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "")); }
  catch { return {}; }
}

export function loadConfig() {
  const raw = readJSONSafe(DATA_PATH);
  // Defaults
  return {
    enabled: raw.enabled === true,
    mode: raw.mode || "strict-allowlist",
    logSeverity: raw.logSeverity || "warn",
    auditChannelId: raw.auditChannelId ?? null,
    punishExecutor: !!raw.punishExecutor,
    punishAction: raw.punishAction || "none",
    allowlist: {
      webhookIds: Array.isArray(raw?.allowlist?.webhookIds) ? raw.allowlist.webhookIds : [],
      channelIds: Array.isArray(raw?.allowlist?.channelIds) ? raw.allowlist.channelIds : [],
      creatorUserIds: Array.isArray(raw?.allowlist?.creatorUserIds) ? raw.allowlist.creatorUserIds : []
    },
    autoDeleteRogueWebhooks: raw.autoDeleteRogueWebhooks !== false,
    autoRevokeTokens: raw.autoRevokeTokens !== false,
    rateLimits: {
      createPerMinute: Number.isFinite(Number(raw?.rateLimits?.createPerMinute)) ? Number(raw.rateLimits.createPerMinute) : 3,
      updatePerMinute: Number.isFinite(Number(raw?.rateLimits?.updatePerMinute)) ? Number(raw.rateLimits.updatePerMinute) : 6,
      deletePerMinute: Number.isFinite(Number(raw?.rateLimits?.deletePerMinute)) ? Number(raw.rateLimits.deletePerMinute) : 6,
    },
    exempt: {
      roleIds: Array.isArray(raw?.exempt?.roleIds) ? raw.exempt.roleIds : [],
      userIds: Array.isArray(raw?.exempt?.userIds) ? raw.exempt.userIds : []
    },
    startupSweep: raw.startupSweep !== false, // default true
    blockBotCreatesOutsideAllow: !!raw.blockBotCreatesOutsideAllow
  };
}

function lvl(cfg) {
  switch ((cfg.logSeverity || "warn").toLowerCase()) {
    case "silent": return 99;
    case "warn": return 2;
    case "info": return 1;
    case "debug": return 0;
    default: return 2;
  }
}
const L = { DEBUG: 0, INFO: 1, WARN: 2 };

function canLog(cfg, want) { return lvl(cfg) <= want; }

function isTextLikeType(t) {
  // 0: GuildText, 5: Announcement, 15: Forum (webhooks allowed for posts)
  return t === 0 || t === 5 || t === 15;
}

function isAllowed(cfg, hook, channelId, creatorId, botUserId) {
  // strict-allowlist: allow ONLY if any allow passes
  if ((cfg.mode || "strict-allowlist") !== "strict-allowlist") return true;

  if (cfg.allowlist.channelIds.includes(channelId)) return true;
  if (cfg.allowlist.webhookIds.includes(hook?.id)) return true;

  // creator checks (optional)
  if (creatorId && cfg.allowlist.creatorUserIds.includes(creatorId)) return true;

  // If the bot itself created it and blockBotCreatesOutsideAllow=false, treat as allowed (so /wh works).
  if (!cfg.blockBotCreatesOutsideAllow && (hook?.owner?.id === botUserId)) return true;

  return false;
}

async function deleteIfRogue(cfg, client, guild, channel, hook) {
  try {
    const me = guild.members.me || await guild.members.fetch(client.user.id).catch(() => null);
    const permsCh = channel?.permissionsFor?.(me);
    const canManage = !!permsCh?.has?.("ManageWebhooks");
    const canView = !!permsCh?.has?.("ViewChannel");
    const canAudit = !!me?.permissions?.has?.("ViewAuditLog");

    if (!canManage || !canView || !canAudit) {
      if (canLog(cfg, L.DEBUG)) {
        jlog("info", { msg: "skip-delete: missing perms", channelId: channel?.id, webhookId: hook?.id, canManage, canView, canAudit });
      }
      return false;
    }

    const creatorId = hook?.owner?.id || null;
    const allowed = isAllowed(cfg, hook, channel?.id, creatorId, client.user?.id);
    if (allowed) {
      if (canLog(cfg, L.DEBUG)) jlog("info", { msg: "ALLOW", channelId: channel?.id, webhookId: hook?.id, name: hook?.name, ownerId: creatorId || null });
      return false;
    }

    if (!cfg.autoDeleteRogueWebhooks) {
      if (canLog(cfg, L.INFO)) jlog("warn", { msg: "ROGUE_DETECTED_but_not_deleted", channelId: channel?.id, webhookId: hook?.id });
      return false;
    }

    await hook.delete("Webhook Guard v2: outside allowlist");
    if (canLog(cfg, L.INFO)) jlog("info", { msg: "BLOCK_DELETE", channelId: channel?.id, webhookId: hook?.id, name: hook?.name, ownerId: creatorId || null });
    return true;
  } catch (err) {
    jlog("warn", { msg: "delete_failed", channelId: channel?.id, webhookId: hook?.id, err: String(err?.message || err) });
    return false;
  }
}

async function enforceChannel(cfg, client, guild, channel) {
  try {
    if (!channel || !isTextLikeType(channel.type)) return { scanned: 0, deleted: 0 };

    const hooks = await channel.fetchWebhooks().catch(() => null);
    if (!hooks) return { scanned: 0, deleted: 0 };

    let deleted = 0;
    for (const hook of hooks.values()) {
      const did = await deleteIfRogue(cfg, client, guild, channel, hook);
      if (did) deleted++;
    }
    return { scanned: hooks.size, deleted };
  } catch {
    return { scanned: 0, deleted: 0 };
  }
}

async function sweepGuild(cfg, client, guild) {
  let totals = { channels: 0, scanned: 0, deleted: 0 };
  try {
    for (const ch of guild.channels.cache.values()) {
      if (!isTextLikeType(ch.type)) continue;
      totals.channels++;
      const res = await enforceChannel(cfg, client, guild, ch);
      totals.scanned += res.scanned;
      totals.deleted += res.deleted;
    }
  } catch {}
  return totals;
}

export async function wireWebhookGuardV2(client) {
  const cfg = loadConfig();
  if (!cfg.enabled) {
    if (canLog(cfg, L.WARN)) jlog("info", { msg: "v2 guard disabled (config)" });
    return;
  }

  if (canLog(cfg, L.INFO)) {
    jlog("info", {
      msg: "v2 guard wired",
      mode: cfg.mode,
      autoDeleteRogueWebhooks: !!cfg.autoDeleteRogueWebhooks,
      punishExecutor: !!cfg.punishExecutor,
      punishAction: cfg.punishAction,
      startupSweep: !!cfg.startupSweep,
      blockBotCreatesOutsideAllow: !!cfg.blockBotCreatesOutsideAllow
    });
  }

  // On READY: optional startup sweep to catch pre-existing rogue hooks
  client.once("ready", async () => {
    try {
      if (!cfg.startupSweep) return;
      for (const [guildId, guild] of client.guilds.cache) {
        const totals = await sweepGuild(cfg, client, guild);
        if (canLog(cfg, L.INFO)) jlog("info", { msg: "startup_sweep_done", guildId, ...totals });
      }
    } catch (err) {
      jlog("warn", { msg: "startup_sweep_failed", err: String(err?.message || err) });
    }
  });

  // Live enforcement on webhook changes in a channel
  client.on("webhooksUpdate", async (channel) => {
    try {
      const guild = channel?.guild;
      if (!guild || !isTextLikeType(channel?.type)) return;
      const res = await enforceChannel(cfg, client, guild, channel);
      if (res.deleted > 0 && canLog(cfg, L.INFO)) {
        jlog("info", { msg: "update_enforce", channelId: channel.id, scanned: res.scanned, deleted: res.deleted });
      } else if (canLog(cfg, L.DEBUG)) {
        jlog("info", { msg: "update_scan_clean", channelId: channel.id, scanned: res.scanned });
      }
    } catch (err) {
      jlog("warn", { msg: "update_enforce_failed", err: String(err?.message || err) });
    }
  });
}

// Be forgiving about how the wire is imported.
export default { wire: wireWebhookGuardV2, loadConfig };
