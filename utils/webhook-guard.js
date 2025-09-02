// utils/webhook-guard.js
import fs from "node:fs/promises";
import path from "node:path";
import createLogger from "./pino-factory.js";
import { sendSecurityLog, toRedactedId } from "./security-log.js";
import { isExempt } from "./exemptions.js";

const log = createLogger("webhook.guard");
const ROOT = process.cwd();
const CFG_PATH = path.join(ROOT, "data", "webhook-guard.json");

const stripBOM = (s) => (typeof s === "string" ? s.replace(/^\uFEFF/, "") : s);
async function readJSONSafe(file, fallback) {
  try { return JSON.parse(stripBOM(await fs.readFile(file, "utf8"))); } catch { return fallback; }
}

export async function loadWebhookGuardConfig() {
  const cfg = await readJSONSafe(CFG_PATH, {});
  return {
    enabled: cfg.enabled !== false,
    respectExemptions: cfg.respectExemptions !== false,
    allow: {
      channelIds: Array.isArray(cfg?.allow?.channelIds) ? cfg.allow.channelIds.map(String).filter(Boolean) : [],
    },
    enforce: {
      autoDeleteRogueWebhook: !!cfg?.enforce?.autoDeleteRogueWebhook,
      punishAction: (cfg?.enforce?.punishAction ?? "none")
    },
    auditLookbackMs: Number.isFinite(cfg.auditLookbackMs) ? cfg.auditLookbackMs : 7000,
    logLevel: cfg.logLevel || "warn",
  };
}

export function isChannelAllowed(channelId, cfg) {
  return cfg.allow.channelIds.includes(String(channelId));
}

export function auditWindowOk(ts, lookbackMs) {
  const t = typeof ts === "number" ? ts : (ts?.getTime?.() ?? 0);
  return !!t && (Date.now() - t) <= lookbackMs;
}

// Optional enforcer (only if punishAction != "none" and your repo has utils/enforce-safely.js)
let _enforceSafely = null;
async function getEnforcer() {
  if (_enforceSafely !== null) return _enforceSafely;
  try {
    const m = await import("./enforce-safely.js");
    _enforceSafely = m.default || m.enforceSafely || null;
  } catch { _enforceSafely = null; }
  return _enforceSafely;
}

export async function maybePunishExecutor(client, guild, userId, cfg, reason, evidence) {
  if (!guild?.members?.fetch || cfg.enforce.punishAction === "none") return { attempted: false };
  try {
    if (cfg.respectExemptions) {
      const ex = await isExempt({ guildId: guild.id, userId, roleIds: [], action: "webhook" });
      if (ex?.exempt) {
        await sendSecurityLog(client, guild, "info", "webhook.guard.executor.exempt", { user: toRedactedId(userId), source: ex.source });
        return { attempted: false, exempt: true };
      }
    }
    const enforceSafely = await getEnforcer();
    if (!enforceSafely) return { attempted: false, reason: "enforcer_unavailable" };
    await enforceSafely(guild, { action: cfg.enforce.punishAction, userId, reason, evidence });
    return { attempted: true, action: cfg.enforce.punishAction };
  } catch (err) {
    log.warn({ err: String(err?.message || err) }, "punish executor failed");
    return { attempted: false, error: String(err?.message || err) };
  }
}

// Fallback enum (defensive against lib changes)
export const AuditTypes = {
  WebhookCreate: 50,
  WebhookUpdate: 51,
  WebhookDelete: 52,
};
