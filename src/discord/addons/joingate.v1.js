// src/discord/addons/join-gate.v1.js
// Join-Gate v1 with exemptions: ignores joins from exempt users for "antiSpam" action.
// ✅ FIX: Soft-lock status now reflects LIVE guild verification level (>= Very High).
//         In-memory state is auto-synced with live level on status/boot/on/off.

import fs from "node:fs/promises";
import path from "node:path";
import { MessageFlags } from "discord.js";
import createLogger from "../../../utils/pino-factory.js";
import { SlidingWindowCounter } from "../../../modules/antinuke/window.js";
import { readFlags, readProjectIds, sendSecurityLog, toRedactedId } from "../../../utils/security-log.js";
import { isExempt } from "../../../utils/exemptions.js";

const log = createLogger("joingate");
log.info("joingate module loaded");

const ROOT = process.cwd();
const JG_OVERRIDE = path.join(ROOT, "data", "feature-flags.join-gate.json");
const stripBOM = (s) => (typeof s === "string" ? s.replace(/^\uFEFF/, "") : s);
const now = () => Date.now();

function onceClientReady(client, fn) {
  let fired = false;
  const wrap = (...a) => { if (fired) return; fired = true; try { fn(...a); } catch {} };
  client.once?.("clientReady", wrap);
  client.once?.("ready", wrap);
}

// ----- Soft-lock helpers (LIVE truth = guild.verificationLevel >= VeryHigh) -----
function verLevelNum(guild) {
  const lv = guild?.verificationLevel;
  if (typeof lv === "number") return lv;
  if (lv && typeof lv.value === "number") return lv.value; // future-proof
  const asStr = String(lv || "").toLowerCase();
  if (asStr.includes("very") || (asStr.includes("high") && !asStr.includes("medium"))) return 3;
  if (asStr.includes("high")) return 2;
  if (asStr.includes("medium")) return 1;
  if (asStr.includes("low")) return 0;
  return 0;
}
function isLiveLocked(guild) { return verLevelNum(guild) >= 3; }

// Per-guild state (mirrors live when we touch it)
const state = new Map();
function getState(guildId, windowMs) {
  let s = state.get(guildId);
  if (!s) {
    s = {
      counterTotal: new SlidingWindowCounter({ windowMs }),
      counterNew:   new SlidingWindowCounter({ windowMs }),
      locked: false,
      unlockAt: null,
      lastAlertTs: 0,
    };
    state.set(guildId, s);
  } else {
    if (s.counterTotal.windowMs !== windowMs) s.counterTotal = new SlidingWindowCounter({ windowMs });
    if (s.counterNew.windowMs   !== windowMs) s.counterNew   = new SlidingWindowCounter({ windowMs });
  }
  return s;
}
function syncLockedFromLive(guild, cfg) {
  const s = getState(guild.id, cfg.joinGateWindowMs);
  const live = isLiveLocked(guild);
  if (s.locked !== live) {
    s.locked = live;
    if (!live) s.unlockAt = null;
    log.debug?.({ guild: guild.id, live, note: "syncLockedFromLive" }, "soft-lock state synced with live");
  }
  return s.locked;
}

async function readJoinGateConfig() {
  const f = await readFlags().catch(() => ({}));
  let o = {};
  try { o = JSON.parse(stripBOM(await fs.readFile(JG_OVERRIDE, "utf8"))); } catch {}

  const cfg = {
    joinGateEnabled:             o.joinGateEnabled ?? f.joinGateEnabled ?? true,
    joinGateWindowMs:            Number.isFinite(o.joinGateWindowMs)            ? o.joinGateWindowMs            : (Number.isFinite(f.joinGateWindowMs)            ? f.joinGateWindowMs            : 60_000),
    joinGateMaxJoinsPerWindow:   Number.isFinite(o.joinGateMaxJoinsPerWindow)   ? o.joinGateMaxJoinsPerWindow   : (Number.isFinite(f.joinGateMaxJoinsPerWindow)   ? f.joinGateMaxJoinsPerWindow   : 8),
    joinGateMinAccountAgeDays:   Number.isFinite(o.joinGateMinAccountAgeDays)   ? o.joinGateMinAccountAgeDays   : (Number.isFinite(f.joinGateMinAccountAgeDays)   ? f.joinGateMinAccountAgeDays   : 7),
    joinGateNewAccountRatio:     typeof o.joinGateNewAccountRatio === "number"  ? o.joinGateNewAccountRatio     : (typeof f.joinGateNewAccountRatio === "number"  ? f.joinGateNewAccountRatio     : 0.6),
    joinGateManualEnabled:       o.joinGateManualEnabled ?? f.joinGateManualEnabled ?? true,
    joinGateSoftLockOnTrigger:   o.joinGateSoftLockOnTrigger ?? f.joinGateSoftLockOnTrigger ?? false,
    joinGateEnforceLock:         o.joinGateEnforceLock       ?? f.joinGateEnforceLock       ?? false,
    joinGateLockDurationMinutes: Number.isFinite(o.joinGateLockDurationMinutes) ? o.joinGateLockDurationMinutes : (Number.isFinite(f.joinGateLockDurationMinutes) ? f.joinGateLockDurationMinutes : 15),
  };

  log.info({ cfg }, "join-gate config resolved");
  return cfg;
}

async function applySoftLock(guild, cfg) {
  const s = getState(guild.id, cfg.joinGateWindowMs);
  const live = isLiveLocked(guild);

  if (live) {
    s.locked = true;
    return { changed: false, reason: "already_locked_live", verificationLevel: { before: verLevelNum(guild), after: verLevelNum(guild) }, unlockAt: s.unlockAt || null };
  }

  let changed = false, errMsg = null, before = verLevelNum(guild), after = before;
  try {
    if (typeof guild.setVerificationLevel === "function") {
      await guild.setVerificationLevel(3);
    } else {
      await guild.edit?.({ verificationLevel: 3 });
    }
    changed = true; after = 3;
  } catch (err) {
    errMsg = String(err?.message || err);
  }

  if (changed) {
    s.locked = true;
    const ms = Math.max(1, cfg.joinGateLockDurationMinutes) * 60_000;
    s.unlockAt = now() + ms;
    setTimeout(() => { releaseSoftLock(guild, cfg, "auto_timeout").catch(() => {}); }, ms).unref?.();
  }

  return { changed, error: errMsg, verificationLevel: { before, after }, unlockAt: s.unlockAt || null };
}

async function releaseSoftLock(guild, cfg, reason = "manual") {
  const s = getState(guild.id, cfg.joinGateWindowMs);
  const live = isLiveLocked(guild);

  if (!live) {
    s.locked = false; s.unlockAt = null;
    return { changed: false, reason: "already_unlocked_live", verificationLevel: { before: verLevelNum(guild), after: verLevelNum(guild) } };
  }

  let changed = false, errMsg = null, before = verLevelNum(guild), after = before;
  try {
    if (typeof guild.setVerificationLevel === "function") {
      await guild.setVerificationLevel(2);
    } else {
      await guild.edit?.({ verificationLevel: 2 });
    }
    changed = true; after = 2;
  } catch (err) {
    errMsg = String(err?.message || err);
  }

  if (changed) { s.locked = false; s.unlockAt = null; }

  return { changed, error: errMsg, reason, verificationLevel: { before, after } };
}

async function upsertSoftLockCommand(client, guildId) {
  await client.application?.fetch?.();
  const data = {
    name: "softlock",
    description: "Control Join-Gate soft lockdown",
    dm_permission: false,
    options: [
      { type: 3, name: "mode", description: "on/off/status", required: true, choices: [
        { name: "on", value: "on" },
        { name: "off", value: "off" },
        { name: "status", value: "status" }
      ]}
    ]
  };

  if (guildId) {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return { scope: "guild", id: null, ok: false };
    const cmds = await guild.commands.fetch().catch(() => null);
    const existing = cmds && Array.from(cmds.values()).find(c => c.name === data.name);
    if (existing) { await guild.commands.edit(existing.id, data); return { scope: "guild", id: existing.id, ok: true }; }
    const created = await guild.commands.create(data); return { scope: "guild", id: created.id, ok: true };
  } else {
    const cmds = await client.application.commands.fetch().catch(() => null);
    const existing = cmds && Array.from(cmds.values()).find(c => c.name === data.name);
    if (existing) { await client.application.commands.edit(existing.id, data); return { scope: "global", id: existing.id, ok: true }; }
    const created = await client.application.commands.create(data); return { scope: "global", id: created.id, ok: true };
  }
}

export async function wireJoinGateV1(client) {
  log.info("joingate wiring start");

  const cfg = await readJoinGateConfig();
  if (cfg.joinGateEnabled === false) {
    log.info("join-gate disabled by flag");
    return;
  }

  const windowMs        = Math.max(5_000, cfg.joinGateWindowMs);
  const maxJoins        = Math.max(3, cfg.joinGateMaxJoinsPerWindow);
  const minAgeDays      = Math.max(0, cfg.joinGateMinAccountAgeDays);
  const newRatioTrigger = Math.min(1, Math.max(0, cfg.joinGateNewAccountRatio));
  const manualOK        = cfg.joinGateManualEnabled === true;
  const enforceLock     = cfg.joinGateEnforceLock === true;
  const autoLockOnTrig  = cfg.joinGateSoftLockOnTrigger === true;
  const coolMs          = 30_000; // throttle alerts

  // Bridge: handle Anti-Nuke’s soft-lock request event (respects joinGateEnforceLock)
  client.on("joingate:softlock:request", async (ev) => {
    try {
      if (!ev?.guildId) return;
      if (!enforceLock) return;
      const guild = client.guilds.cache.get(ev.guildId) || await client.guilds.fetch(ev.guildId).catch(() => null);
      if (!guild) return;

      const minutes = Math.max(1, Number(ev.minutes) || cfg.joinGateLockDurationMinutes || 15);
      const res = await applySoftLock(guild, { ...cfg, joinGateLockDurationMinutes: minutes });

      await sendSecurityLog(client, guild, res.changed ? "warn" : "info", "join-gate.softlock.apply", {
        requestedBy: ev.actorId || "unknown",
        source: ev.source || "unknown",
        minutes,
        ...res
      });
    } catch (err) {
      log.warn({ err: String(err?.stack || err) }, "softlock request bridge failed");
    }
  });

  // Register command & boot log when ready; also sync state from LIVE level.
  onceClientReady(client, async () => {
    try {
      const ids = await readProjectIds().catch(() => ({}));
      const res = await upsertSoftLockCommand(client, ids.guildId || null);
      log.info(`/softlock registered (${res.scope})`);
    } catch (err) {
      log.warn({ err: String(err?.message || err) }, "failed to register /softlock");
    }

    // Sync all connected guilds on boot
    for (const [, g] of client.guilds.cache) {
      try { syncLockedFromLive(g, { joinGateWindowMs: windowMs }); } catch {}
    }

    log.info(`join-gate active (window=${windowMs}ms, maxJoins=${maxJoins}, minAgeDays=${minAgeDays}, newRatio>=${newRatioTrigger}, manual=${manualOK}, auto=${enforceLock && autoLockOnTrig})`);
  });

  // Heuristic trigger (exemptions-aware; ignores bots + exempt users for "antiSpam")
  client.on("guildMemberAdd", async (member) => {
    try {
      const guild = member?.guild; if (!guild?.id) return;
      if (member?.user?.bot) return; // ignore bots

      const ex = await isExempt({ guildId: guild.id, userId: member?.id, roleIds: [], action: "antiSpam" });
      if (ex.exempt) {
        log.debug?.({ user: toRedactedId(member?.id), source: ex.source }, "join ignored due to exemption");
        return;
      }

      const s = getState(guild.id, windowMs);
      s.counterTotal.increment("join", 1);

      const createdTs = Number(member?.user?.createdTimestamp || 0);
      const ageMs = createdTs ? (now() - createdTs) : Number.POSITIVE_INFINITY;
      const ageDays = Number.isFinite(ageMs) ? Math.floor(ageMs / 86_400_000) : null;
      const isNew = ageDays != null ? (ageDays < minAgeDays) : false;
      if (isNew) s.counterNew.increment("joinNew", 1);

      const total   = s.counterTotal.count("join");
      const newbies = s.counterNew.count("joinNew");
      const ratio   = total > 0 ? (newbies / total) : 0;

      const triggered = (total >= maxJoins) || (total >= 3 && ratio >= newRatioTrigger);
      const gapOk = now() - s.lastAlertTs >= coolMs;

      if (triggered && gapOk) {
        s.lastAlertTs = now();
        await sendSecurityLog(client, guild, "warn", "join-gate.trigger", {
          windowMs,
          totalJoins: total,
          newbies,
          newAccountRatio: Number(ratio.toFixed(2)),
          thresholds: { maxJoinsPerWindow: maxJoins, minAccountAgeDays: minAgeDays, newAccountRatio: newRatioTrigger }
        });

        if (enforceLock && autoLockOnTrig) {
          const res = await applySoftLock(guild, cfg);
          await sendSecurityLog(client, guild, res.changed ? "warn" : "info", "join-gate.softlock.apply", res);
        }
      }
    } catch (err) {
      log.warn({ err: String(err?.stack || err) }, "join-gate memberAdd failed");
    }
  });

  // Slash: /softlock (manual allowed if joinGateManualEnabled)
  client.on("interactionCreate", async (interaction) => {
    try {
      if (!interaction?.isChatInputCommand?.()) return;
      if (interaction.commandName !== "softlock") return;
      const guild = interaction.guild; if (!guild?.id) return;

      const m = interaction.member;
      const canManage = m?.permissions?.has?.("ManageGuild") || m?.permissions?.has?.("Administrator");
      if (!canManage) { await interaction.reply({ flags: MessageFlags.Ephemeral, content: "You need **Manage Server** to use this." }); return; }

      const mode = interaction.options?.getString?.("mode");

      if (mode === "status") {
        const liveOn = isLiveLocked(guild);
        syncLockedFromLive(guild, { joinGateWindowMs: windowMs }); // keep state in sync
        const s = getState(guild.id, windowMs);

        const suffix = s.unlockAt ? ` Auto-unlock: <t:${Math.floor(s.unlockAt/1000)}:R>` : "";
        await interaction.reply({ flags: MessageFlags.Ephemeral, content: liveOn ? ("Soft-lock is **ON**." + suffix) : "Soft-lock is **OFF**." });
        return;
      }

      if (!manualOK) { await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Manual soft-lock is disabled by feature flags." }); return; }

      if (mode === "on") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const res = await applySoftLock(guild, cfg);
        syncLockedFromLive(guild, { joinGateWindowMs: windowMs });
        await interaction.editReply(res.changed ? "Soft-lock **enabled**." : "Soft-lock was already ON.");
        return;
      }

      if (mode === "off") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const res = await releaseSoftLock(guild, cfg, "manual");
        syncLockedFromLive(guild, { joinGateWindowMs: windowMs });
        await interaction.editReply(res.changed ? "Soft-lock **disabled**." : "Soft-lock was already OFF.");
        return;
      }

      await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Usage: /softlock mode: on|off|status" });
    } catch (err) {
      try { if (interaction?.deferred && !interaction?.replied) await interaction.editReply({ content: "Softlock error. Check logs." }); } catch {}
      log.warn({ err: String(err?.stack || err) }, "softlock handler failed");
    }
  });
}

export default wireJoinGateV1;
