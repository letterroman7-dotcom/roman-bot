// utils/webhook-guard-v2.js (ESM) — robust loader, inert until enabled
import fs from "fs";
import path from "path";
import pino from "pino";

const log = pino({ name: "webhook.guard.v2" });

function rel(...parts) {
  return path.join(process.cwd(), ...parts);
}

// Safe JSON loader with BOM strip + fallback
export function loadJSONSafe(filePath, fallback = {}) {
  try {
    let raw = fs.readFileSync(filePath, "utf8");
    // Strip UTF-8 BOM if present
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// Try multiple candidate filenames to avoid OS/editor quirks
function resolveConfigPath() {
  const candidates = [
    rel("data", "webhook-guard.v2.json"),  // original suggestion
    rel("data", "webhook-guard-v2.json"),  // Windows-safe hyphen variant (preferred)
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return p;
    } catch {
      /* keep searching */
    }
  }
  return null;
}

export function loadConfig() {
  const cfgPath = resolveConfigPath();
  if (!cfgPath) {
    log.info("no v2 config file found (webhook-guard.v2.json / webhook-guard-v2.json); defaulting disabled");
  }
  const cfg = loadJSONSafe(cfgPath || "", {});
  // normalize
  return {
    enabled: !!cfg.enabled,
    mode: cfg.mode ?? "strict-allowlist",
    logSeverity: cfg.logSeverity ?? "warn",
    auditChannelId: cfg.auditChannelId ?? null,
    punishExecutor: !!cfg.punishExecutor,
    punishAction: cfg.punishAction ?? "none",
    allowlist: {
      webhookIds: cfg.allowlist?.webhookIds ?? [],
      channelIds: cfg.allowlist?.channelIds ?? [],
      creatorUserIds: cfg.allowlist?.creatorUserIds ?? []
    },
    autoDeleteRogueWebhooks: cfg.autoDeleteRogueWebhooks !== false,
    autoRevokeTokens: cfg.autoRevokeTokens !== false,
    rateLimits: {
      createPerMinute: cfg.rateLimits?.createPerMinute ?? 3,
      updatePerMinute: cfg.rateLimits?.updatePerMinute ?? 6,
      deletePerMinute: cfg.rateLimits?.deletePerMinute ?? 6
    },
    exempt: {
      roleIds: cfg.exempt?.roleIds ?? [],
      userIds: cfg.exempt?.userIds ?? []
    }
  };
}

export function isExempt(member, cfg) {
  if (!member) return false;
  if (cfg.exempt.userIds.includes(member.id)) return true;
  return member.roles?.cache?.some?.(r => cfg.exempt.roleIds.includes(r.id)) ?? false;
}

export function isAllowedWebhook({ webhookId, channelId, creatorId }, cfg) {
  const a = cfg.allowlist;
  if (a.webhookIds.includes(webhookId)) return true;
  if (a.channelIds.includes(channelId)) return true;
  if (a.creatorUserIds.includes(creatorId)) return true;
  return false;
}

export function shouldBlockChange(ctx, cfg) {
  if (!cfg.enabled) return false;
  if (cfg.mode !== "strict-allowlist") return false;
  const { webhookId, channelId, creatorId } = ctx;
  return !isAllowedWebhook({ webhookId, channelId, creatorId }, cfg);
}

export async function maybePunishExecutor({ guild, executor, reason }, cfg) {
  if (!cfg.punishExecutor || cfg.punishAction === "none") return;
  try {
    if (cfg.punishAction === "kick") {
      await guild.members.kick(executor.id, reason);
    } else if (cfg.punishAction === "ban") {
      await guild.members.ban(executor.id, { reason, deleteMessageSeconds: 0 });
    }
  } catch (err) {
    log.warn({ err }, "punish failed");
  }
}

export async function tryAutoDeleteWebhook(webhook, cfg, reason = "Unauthorized webhook (v2)") {
  if (!cfg.autoDeleteRogueWebhooks) return false;
  try {
    await webhook.delete(reason);
    return true;
  } catch {
    return false;
  }
}

export function summaryForLog(ctx, blocked) {
  const base = `[WebhookGuardV2] ${blocked ? "BLOCK" : "ALLOW"}`;
  return `${base} id=${ctx.webhookId ?? "?"} ch=${ctx.channelId ?? "?"} by=${ctx.executorId ?? "?"}`;
}
