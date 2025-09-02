// wire-join-gate.js
// Join-Gate: detects mass-joins and optionally applies a reversible "soft lock".
// - Alert-only by default. Soft lock is flag-gated.
// - Uses SlidingWindowCounter (windowed joins) + new-account-age heuristics.
// - Registers /softlock (on/off/status) for operators with ManageGuild.

import { SlidingWindowCounter } from "./modules/antinuke/window.js";
import { readFlags, sendSecurityLog, toRedactedId, readProjectIds } from "./utils/security-log.js";
import { newTraceId } from "./utils/trace-id.js";
import createLogger from "./utils/pino-factory.js";

const log = createLogger("joingate");

// Per-guild state
const state = new Map();
/**
 * @typedef {Object} GuildState
 * @property {SlidingWindowCounter} counterTotal
 * @property {SlidingWindowCounter} counterNew
 * @property {boolean} locked
 * @property {number|null} unlockAt
 * @property {number} lastAlertTs
 */
function getState(guildId, windowMs) {
  let s = state.get(guildId);
  if (!s) {
    s = {
      counterTotal: new SlidingWindowCounter({ windowMs }),
      counterNew: new SlidingWindowCounter({ windowMs }),
      locked: false,
      unlockAt: null,
      lastAlertTs: 0,
    };
    state.set(guildId, s);
  } else {
    // keep counters fresh if window changed
    if (s.counterTotal.windowMs !== windowMs) s.counterTotal = new SlidingWindowCounter({ windowMs });
    if (s.counterNew.windowMs !== windowMs) s.counterNew = new SlidingWindowCounter({ windowMs });
  }
  return s;
}

async function applySoftLock(guild, flags) {
  const s = getState(guild.id, flags.joinGateWindowMs);
  if (s.locked) return { changed: false, reason: "already_locked" };
  const traceId = newTraceId("lock");
  // Strategy (safe & reversible): bump verification level to VeryHigh (3) if lower.
  let oldLevel = null, newLevel = null, changed = false, errMsg = null;
  try {
    oldLevel = guild.verificationLevel ?? null;
    // 3 = VeryHigh in discord.js v14; in v15 the enum is also numeric-compatible.
    if (oldLevel === null || oldLevel < 3) {
      await guild.setVerificationLevel(3);
      newLevel = 3;
      changed = true;
    } else {
      newLevel = oldLevel;
    }
  } catch (err) {
    errMsg = String(err?.message || err);
  }
  if (changed) {
    s.locked = true;
    const lockMs = Math.max(1, (flags.joinGateLockDurationMinutes || 15)) * 60_000;
    s.unlockAt = Date.now() + lockMs;
    setTimeout(() => {
      // best-effort auto-unlock
      releaseSoftLock(guild, flags, "auto_timeout").catch(() => {});
    }, lockMs).unref?.();
  }
  await sendSecurityLog(guild.client, guild, changed ? "warn" : "info", "join-gate.softlock.apply", {
    traceId,
    changed,
    error: errMsg || null,
    verificationLevel: { before: oldLevel, after: newLevel },
    unlockAt: s.unlockAt ? new Date(s.unlockAt).toISOString() : null,
  });
  return { changed, error: errMsg, traceId };
}

async function releaseSoftLock(guild, flags, reason = "manual") {
  const s = getState(guild.id, flags.joinGateWindowMs);
  if (!s.locked) return { changed: false, reason: "not_locked" };
  const traceId = newTraceId("lock");
  let oldLevel = null, newLevel = null, changed = false, errMsg = null;
  try {
    oldLevel = guild.verificationLevel ?? null;
    // We attempt to restore to "High" (2) rather than guessing the original.
    if (oldLevel !== null && oldLevel >= 3) {
      await guild.setVerificationLevel(2);
      newLevel = 2;
      changed = true;
    } else {
      newLevel = oldLevel;
    }
  } catch (err) {
    errMsg = String(err?.message || err);
  }
  if (changed) {
    s.locked = false;
    s.unlockAt = null;
  }
  await sendSecurityLog(guild.client, guild, changed ? "info" : "debug", "join-gate.softlock.release", {
    traceId, changed, reason, error: errMsg || null,
    verificationLevel: { before: oldLevel, after: newLevel },
  });
  return { changed, error: errMsg, traceId };
}

async function upsertSoftLockCommand(client, guildId) {
  await client.application?.fetch?.();
  const data = {
    name: "softlock",
    description: "Control Join-Gate soft lockdown",
    dm_permission: false,
    options: [
      {
        type: 3, // STRING
        name: "mode",
        description: "on/off/status",
        required: true,
        choices: [
          { name: "on", value: "on" },
          { name: "off", value: "off" },
          { name: "status", value: "status" },
        ],
      },
    ],
  };
  if (guildId) {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return { scope: "guild", id: null, ok: false };
    const cmds = await guild.commands.fetch().catch(() => null);
    const existing = cmds && Array.from(cmds.values()).find(c => c.name === data.name);
    if (existing) {
      await guild.commands.edit(existing.id, data);
      return { scope: "guild", id: existing.id, ok: true };
    } else {
      const created = await guild.commands.create(data);
      return { scope: "guild", id: created.id, ok: true };
    }
  } else {
    const cmds = await client.application.commands.fetch().catch(() => null);
    const existing = cmds && Array.from(cmds.values()).find(c => c.name === data.name);
    if (existing) {
      await client.application.commands.edit(existing.id, data);
      return { scope: "global", id: existing.id, ok: true };
    } else {
      const created = await client.application.commands.create(data);
      return { scope: "global", id: created.id, ok: true };
    }
  }
}

export async function wireJoinGate(client) {
  const flags = await readFlags().catch(() => ({}));
  if (flags.joinGateEnabled === false) {
    log.info("join-gate disabled by flag");
    return;
  }

  const windowMs = Math.max(5_000, flags.joinGateWindowMs || 60_000);
  const maxJoinsPerWindow = Math.max(3, flags.joinGateMaxJoinsPerWindow || 8);
  const minAgeDays = Math.max(0, flags.joinGateMinAccountAgeDays || 7);
  const newRatioTrigger = Math.min(1, Math.max(0, flags.joinGateNewAccountRatio ?? 0.6));
  const enforceLock = flags.joinGateEnforceLock === true;
  const autoLockOnTrigger = flags.joinGateSoftLockOnTrigger === true;
  const coolMs = 30_000; // min gap between alerts to avoid spam

  // Register /softlock (guild-scoped if guildId provided)
  try {
    const ids = await readProjectIds().catch(() => ({}));
    const res = await upsertSoftLockCommand(client, ids.guildId || null);
    log.info(`/softlock registered (${res.scope})`);
  } catch (err) {
    log.warn({ err: String(err?.message || err) }, "failed to register /softlock");
  }

  client.on("guildMemberAdd", async (member) => {
    try {
      const guild = member?.guild;
      if (!guild?.id) return;

      const s = getState(guild.id, windowMs);

      // record join
      s.counterTotal.increment("join", 1);

      // check account age
      const createdTs = Number(member?.user?.createdTimestamp || 0);
      const ageMs = createdTs ? (Date.now() - createdTs) : Number.POSITIVE_INFINITY;
      const ageDays = Math.floor(ageMs / 86_400_000);
      const isNew = ageDays < minAgeDays;
      if (isNew) s.counterNew.increment("joinNew", 1);

      const total = s.counterTotal.count("join");
      const newbies = s.counterNew.count("joinNew");
      const ratio = total > 0 ? newbies / total : 0;

      const triggered = (total >= maxJoinsPerWindow) || (total >= 3 && ratio >= newRatioTrigger);

      // Build sample (current member only; could expand to k-latest if needed)
      const sample = {
        id: toRedactedId(member.id),
        username: member.user?.tag || member.user?.username || null,
        ageDays: Number.isFinite(ageDays) ? ageDays : null,
        createdAt: createdTs ? new Date(createdTs).toISOString() : null,
        isNewAccount: isNew
      };

      // Throttle alerts a bit
      const now = Date.now();
      const gapOk = now - s.lastAlertTs >= coolMs;

      if (triggered && gapOk) {
        s.lastAlertTs = now;
        const traceId = newTraceId("join");
        await sendSecurityLog(client, guild, "warn", "join-gate.trigger", {
          traceId,
          windowMs,
          totalJoins: total,
          newbies,
          newAccountRatio: Number(ratio.toFixed(2)),
          thresholds: {
            maxJoinsPerWindow,
            minAccountAgeDays: minAgeDays,
            newAccountRatio: newRatioTrigger
          },
          sample
        });

        if (enforceLock && autoLockOnTrigger) {
          const res = await applySoftLock(guild, {
            joinGateWindowMs: windowMs,
            joinGateLockDurationMinutes: flags.joinGateLockDurationMinutes || 15
          });
          // NOTE: any errors already logged inside applySoftLock
        }
      }
    } catch (err) {
      log.warn({ err: String(err?.stack || err) }, "join-gate memberAdd failed");
    }
  });

  // Slash command handler
  client.on("interactionCreate", async (interaction) => {
    try {
      if (!interaction?.isChatInputCommand?.()) return;
      if (interaction.commandName !== "softlock") return;

      const member = interaction.member;
      const guild = interaction.guild;
      if (!guild?.id) return;

      // Permission check: ManageGuild required
      const canManage = member?.permissions?.has?.("ManageGuild") || member?.permissions?.has?.("Administrator");
      if (!canManage) {
        await interaction.reply({ content: "You need **Manage Server** to use this.", ephemeral: true });
        return;
      }

      const mode = interaction.options?.getString?.("mode");
      const s = getState(guild.id, windowMs);

      if (mode === "status") {
        await interaction.reply({
          ephemeral: true,
          content: s.locked
            ? `Soft-lock is **ON**. Auto-unlock: ${s.unlockAt ? `<t:${Math.floor(s.unlockAt/1000)}:R>` : "n/a"}`
            : "Soft-lock is **OFF**."
        });
        return;
      }

      if (mode === "on") {
        if (!enforceLock) {
          await interaction.reply({ ephemeral: true, content: "Soft-lock enforcement is disabled by feature flags." });
          return;
        }
        await interaction.deferReply({ ephemeral: true });
        const res = await applySoftLock(guild, { joinGateWindowMs: windowMs, joinGateLockDurationMinutes: flags.joinGateLockDurationMinutes || 15 });
        await interaction.editReply(res.changed ? "Soft-lock **enabled**." : "Soft-lock was already ON.");
        return;
      }

      if (mode === "off") {
        if (!enforceLock) {
          await interaction.reply({ ephemeral: true, content: "Soft-lock enforcement is disabled by feature flags." });
          return;
        }
        await interaction.deferReply({ ephemeral: true });
        const res = await releaseSoftLock(guild, { joinGateWindowMs: windowMs }, "manual");
        await interaction.editReply(res.changed ? "Soft-lock **disabled**." : "Soft-lock was already OFF.");
        return;
      }

      await interaction.reply({ ephemeral: true, content: "Usage: /softlock mode: on|off|status" });
    } catch (err) {
      try {
        if (interaction?.deferred && !interaction?.replied) {
          await interaction.editReply({ content: "Softlock error. Check logs." });
        }
      } catch {}
      log.warn({ err: String(err?.stack || err) }, "softlock handler failed");
    }
  });

  log.info(`join-gate active (window=${windowMs}ms, maxJoins=${maxJoinsPerWindow}, minAgeDays=${minAgeDays}, newRatio>=${newRatioTrigger})`);
}

export default wireJoinGate;
