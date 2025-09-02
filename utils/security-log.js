// utils/security-log.js
// Centralized security/audit logging with optional Discord-channel mirroring and NDJSON file mirror.
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import createLogger from "./pino-factory.js";

const log = createLogger("security");
const ROOT = process.cwd();
const FF = path.join(ROOT, "data", "feature-flags.json");
const IDS = path.join(ROOT, "data", "project-ids.json");
const LOG_DIR = path.join(ROOT, "logs");
const LOG_FILE = path.join(LOG_DIR, "security.ndjson");

function stripBOM(s) { return typeof s === "string" ? s.replace(/^\uFEFF/, "") : s; }
async function readJSONSafe(file, fallback = {}) { try { return JSON.parse(stripBOM(await fs.readFile(file, "utf8"))); } catch { return fallback; } }

export function toRedactedId(id) {
  if (!id) return undefined;
  const s = String(id);
  return `[id:${s.length > 4 ? "..." + s.slice(-4) : s}]`;
}

export async function readFlags() {
  const f = await readJSONSafe(FF, {});
  // Normalize dotted key "enforce.massGuard" into object form if present
  const enforce = typeof f.enforce === "object" && f.enforce ? { ...f.enforce } : {};
  if (Object.prototype.hasOwnProperty.call(f, "enforce.massGuard")) enforce.massGuard = !!f["enforce.massGuard"];

  return {
    // Logging / startup
    securityLogToChannel: f.securityLogToChannel !== false,
    securityLogToFile: f.securityLogToFile === true,
    startupSummary: f.startupSummary !== false,

    // Slash features
    slashPerf: f.slashPerf === true,

    // Watchers
    watchMass: f.watchMass !== false,
    watchPermDiff: f.watchPermDiff !== false,

    // Perm-diff tuning
    permDiffWarnDangerOnly: f.permDiffWarnDangerOnly !== false,
    permDiffIncludeSamples: f.permDiffIncludeSamples !== false,

    // Audit attribution
    auditAttribution: f.auditAttribution !== false,
    auditLookbackMs: Number.isFinite(f.auditLookbackMs) ? f.auditLookbackMs : 30_000,

    // Enforcement guardrails
    enforce,
    enforceCooldownEnabled: f.enforceCooldownEnabled !== false,
    enforceCooldownMinutes: Number.isFinite(f.enforceCooldownMinutes) ? f.enforceCooldownMinutes : 5,

    // Join-Gate flags (NEW)
    joinGateEnabled: f.joinGateEnabled !== false,
    joinGateWindowMs: Number.isFinite(f.joinGateWindowMs) ? f.joinGateWindowMs : 60_000,
    joinGateMaxJoinsPerWindow: Number.isFinite(f.joinGateMaxJoinsPerWindow) ? f.joinGateMaxJoinsPerWindow : 8,
    joinGateMinAccountAgeDays: Number.isFinite(f.joinGateMinAccountAgeDays) ? f.joinGateMinAccountAgeDays : 7,
    joinGateNewAccountRatio: typeof f.joinGateNewAccountRatio === "number" ? f.joinGateNewAccountRatio : 0.6,
    joinGateSoftLockOnTrigger: f.joinGateSoftLockOnTrigger === true,
    joinGateEnforceLock: f.joinGateEnforceLock === true,
    joinGateLockDurationMinutes: Number.isFinite(f.joinGateLockDurationMinutes) ? f.joinGateLockDurationMinutes : 15,

    // Misc
    pingThresholds: f.pingThresholds || {},
  };
}

export async function readProjectIds() {
  const ids = await readJSONSafe(IDS, {});
  const asStr = (x) => (x == null ? null : String(x));
  return {
    guildId: asStr(ids.guildId) || null,
    mainChannelId: asStr(ids.mainChannelId) || null,
    ownerUserId: asStr(ids.ownerUserId) || null,
  };
}

function mirrorToFile(level, title, guild, payload) {
  try {
    if (!fssync.existsSync(LOG_DIR)) fssync.mkdirSync(LOG_DIR, { recursive: true });
    const rec = { t: new Date().toISOString(), level, title, guild: toRedactedId(guild?.id), ...payload };
    fssync.appendFileSync(LOG_FILE, JSON.stringify(rec) + "\n", { encoding: "utf8" });
  } catch (err) { log.warn({ msg: err?.message }, "security file mirror failed"); }
}

export async function sendSecurityLog(client, guild, level, title, payload) {
  const flags = await readFlags();
  const ids = await readProjectIds();
  if (flags.securityLogToFile) mirrorToFile(level, title, guild, payload);

  if (flags.securityLogToChannel && ids.mainChannelId) {
    try {
      const chan = guild?.channels?.cache?.get?.(ids.mainChannelId) || (await guild?.channels?.fetch?.(ids.mainChannelId));
      if (chan && chan.isTextBased?.()) {
        const printable = "```json\n" + JSON.stringify(payload, null, 2) + "\n```";
        const prefix = level === "warn" ? "[WARN]" : level === "error" ? "[ERROR]" : level === "crit" ? "[CRIT]" : "[INFO]";
        await chan.send({ content: `${prefix} ${title}\n${printable}` });
        return;
      }
    } catch (err) {
      // fall through to pino
    }
  }

  const base = { guild: toRedactedId(guild?.id), ...payload };
  const logger = createLogger("security");
  switch (level) {
    case "debug": logger.debug(base, title); break;
    case "info":  logger.info(base, title);  break;
    case "warn":  logger.warn(base, title);  break;
    case "error": logger.error(base, title); break;
    case "crit":  logger.fatal(base, title); break;
    default:      logger.info(base, title);  break;
  }
}
