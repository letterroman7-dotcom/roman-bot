// src/discord/addons/raid-correlation.v1.js
// Correlates join bursts + dangerous audit-log events to auto-escalate.
// - No slash commands; runs silently.
// - Soft-locks when BOTH thresholds are met within a window.
// - Exemptions-aware (joins: "antiSpam"; audit executors: "ownerProtection").
// - Works alongside Join-Gate; uses its same lock approach (inline here).

import createLogger from "../../../utils/pino-factory.js";
import { SlidingWindowCounter } from "../../../modules/antinuke/window.js";
import { isExempt } from "../../../utils/exemptions.js";
import { readFlags, sendSecurityLog, toRedactedId } from "../../../utils/security-log.js";

const log = createLogger("raidcorr");
const now = () => Date.now();

function onceClientReady(client, fn) {
  let fired = false;
  const wrap = (...a) => { if (fired) return; fired = true; try { fn(...a); } catch {} };
  client.once?.("clientReady", wrap);
  client.once?.("ready", wrap);
}

// Soft-lock helpers (same behavior as Join-Gate)
async function applySoftLock(guild, minutes = 15) {
  let changed = false, errMsg = null, before = guild.verificationLevel ?? null, after = before;
  try {
    if (before == null || before < 3) {
      if (typeof guild.setVerificationLevel === "function") {
        await guild.setVerificationLevel(3);
      } else {
        await guild.edit?.({ verificationLevel: 3 });
      }
      changed = true; after = 3;
    }
  } catch (err) { errMsg = String(err?.message || err); }
  return { changed, error: errMsg, verificationLevel: { before, after }, unlockAt: changed ? new Date(Date.now()+minutes*60000).toISOString() : null };
}

export async function wireRaidCorrelationV1(client) {
  log.info("raid-correlation wiring start");

  // Resolve config from feature flags (with safe defaults)
  const f = await readFlags().catch(() => ({}));
  const cfg = {
    raidCorrEnabled:                 f.raidCorrEnabled ?? true,
    raidCorrWindowMs:                Number.isFinite(f.raidCorrWindowMs) ? f.raidCorrWindowMs : 120_000,
    raidCorrMinJoins:                Number.isFinite(f.raidCorrMinJoins) ? f.raidCorrMinJoins : 6,
    raidCorrMinNewRatio:             typeof f.raidCorrMinNewRatio === "number" ? f.raidCorrMinNewRatio : 0.5,
    raidCorrMinDangerEvents:         Number.isFinite(f.raidCorrMinDangerEvents) ? f.raidCorrMinDangerEvents : 3,
    raidCorrLockMinutes:             Number.isFinite(f.raidCorrLockMinutes) ? f.raidCorrLockMinutes : 15,
    raidCorrRespectExemptions:       f.raidCorrRespectExemptions ?? true,
    // Gate actual enforcement so you can run alert-only
    raidCorrEnforceLock:             f.raidCorrEnforceLock ?? true
  };
  log.info({ cfg }, "raid-correlation config resolved");
  if (!cfg.raidCorrEnabled) { log.info("raid-correlation disabled by flag"); return; }

  // Per-guild counters
  const S = new Map(); // guildId -> { joins:SlidingWindowCounter, joinsNew:SlidingWindowCounter, danger:SlidingWindowCounter, lastIncidentTs:number }
  const get = (g) => {
    let s = S.get(g);
    if (!s) {
      s = {
        joins: new SlidingWindowCounter({ windowMs: cfg.raidCorrWindowMs }),
        joinsNew: new SlidingWindowCounter({ windowMs: cfg.raidCorrWindowMs }),
        danger: new SlidingWindowCounter({ windowMs: cfg.raidCorrWindowMs }),
        lastIncidentTs: 0,
      };
      S.set(g, s);
    } else {
      if (s.joins.windowMs !== cfg.raidCorrWindowMs) s.joins = new SlidingWindowCounter({ windowMs: cfg.raidCorrWindowMs });
      if (s.joinsNew.windowMs !== cfg.raidCorrWindowMs) s.joinsNew = new SlidingWindowCounter({ windowMs: cfg.raidCorrWindowMs });
      if (s.danger.windowMs !== cfg.raidCorrWindowMs) s.danger = new SlidingWindowCounter({ windowMs: cfg.raidCorrWindowMs });
    }
    return s;
  };

  // Count joins (ignore bots + exempt users for antiSpam)
  client.on("guildMemberAdd", async (m) => {
    try {
      const g = m?.guild; if (!g?.id) return;
      if (m?.user?.bot) return;
      const s = get(g.id);

      if (cfg.raidCorrRespectExemptions) {
        const ex = await isExempt({ guildId: g.id, userId: m.id, action: "antiSpam" });
        if (ex.exempt) return;
      }

      // New account heuristic: <7 days (same as Join-Gate default)
      const created = Number(m?.user?.createdTimestamp || 0);
      const ageDays = created ? Math.floor((now() - created) / 86_400_000) : 9999;
      const isNew = ageDays < 7;

      s.joins.increment("j", 1);
      if (isNew) s.joinsNew.increment("jn", 1);
    } catch (err) {
      log.warn({ err: String(err?.stack || err) }, "guildMemberAdd correlation err");
    }
  });

  // Count dangerous audit events
  // Uses the real-time gateway event if available; otherwise you still have your existing watchers as defense.
  onceClientReady(client, async () => {
    log.info("raid-correlation listening for audit events");
  });

  client.on("guildAuditLogEntryCreate", async (entry, guild) => {
    try {
      if (!guild?.id) return;
      const s = get(guild.id);

      // Identify "dangerous" actions (broad but safe)
      const a = entry?.action; // discord.js enum string or number depending on version
      const actionStr = String(a).toLowerCase();
      const looksDanger =
        actionStr.includes("channel_delete") ||
        actionStr.includes("role_delete") ||
        actionStr.includes("channel_create") ||
        actionStr.includes("webhook_create") ||
        actionStr.includes("webhook_delete") ||
        actionStr.includes("member_role_update") ||
        actionStr.includes("member_update") ||
        actionStr.includes("guild_update") ||
        actionStr.includes("overwrite_update") ||
        actionStr.includes("bot_add"); // conservative extras

      if (!looksDanger) return;

      // Respect exemptions for the executor
      const execId = entry?.executorId || entry?.executor?.id || null;
      if (cfg.raidCorrRespectExemptions && execId) {
        const ex = await isExempt({ guildId: guild.id, userId: execId, action: "ownerProtection" });
        if (ex.exempt) return;
      }

      s.danger.increment("d", 1);

      // Evaluate escalation each time we see a dangerous event
      await maybeEscalate(guild, s, cfg);
    } catch (err) {
      log.warn({ err: String(err?.stack || err) }, "audit-entry correlation err");
    }
  });

  async function maybeEscalate(guild, s, cfg) {
    try {
      const joins = s.joins.count("j");
      const newb  = s.joinsNew.count("jn");
      const danger= s.danger.count("d");
      const ratio = joins > 0 ? newb / joins : 0;

      const joinOK   = joins >= cfg.raidCorrMinJoins && ratio >= cfg.raidCorrMinNewRatio;
      const dangerOK = danger >= cfg.raidCorrMinDangerEvents;

      if (!(joinOK && dangerOK)) return;

      // Cooldown: avoid spamming incidents
      const nowTs = now();
      if (nowTs - s.lastIncidentTs < 60_000) return;
      s.lastIncidentTs = nowTs;

      // Log incident summary
      const incident = {
        windowMs: cfg.raidCorrWindowMs,
        joins, newAccounts: newb, newRatio: Number(ratio.toFixed(2)),
        dangerEvents: danger,
        thresholds: {
          minJoins: cfg.raidCorrMinJoins,
          minNewRatio: cfg.raidCorrMinNewRatio,
          minDangerEvents: cfg.raidCorrMinDangerEvents
        },
        enforce: cfg.raidCorrEnforceLock,
        lockMinutes: cfg.raidCorrLockMinutes
      };

      await sendSecurityLog(guild.client, guild, cfg.raidCorrEnforceLock ? "error" : "warn", "raid-corr.incident", incident);

      // Enforce lock
      if (cfg.raidCorrEnforceLock) {
        const res = await applySoftLock(guild, cfg.raidCorrLockMinutes);
        await sendSecurityLog(guild.client, guild, res.changed ? "warn" : "info", "raid-corr.softlock.apply", {
          changed: res.changed,
          error: res.error || null,
          verificationLevel: res.verificationLevel,
          unlockAt: res.unlockAt
        });
      }
    } catch (err) {
      log.warn({ err: String(err?.stack || err) }, "maybeEscalate failed");
    }
  }
}

export default wireRaidCorrelationV1;
