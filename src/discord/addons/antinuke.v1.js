// src/discord/addons/antinuke.v1.js
/* eslint-disable no-console */
import fs from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { AuditLogEvent, MessageFlags } from "discord.js";

const log = pino({ name: "antinuke" });

const stripBOM = (s) => (typeof s === "string" ? s.replace(/^\uFEFF/, "") : s);
async function readJSONSafe(file, fb = {}) { try { return JSON.parse(stripBOM(await fs.readFile(file, "utf8"))); } catch { return fb; } }
function n(v, fb) { const x = Number(v); return Number.isFinite(x) ? x : fb; }

let sendLog = undefined;
async function getSendLog() {
  if (sendLog !== undefined) return sendLog;
  try {
    const mod = await import("../../../utils/send-log.js");
    sendLog = (mod?.default || mod?.sendLog || null);
    console.info(JSON.stringify({ name: "antinuke.trace", phase: "send-log:loaded", used: "../../../utils/send-log.js" }));
  } catch {
    sendLog = null;
  }
  return sendLog;
}
async function safeSendLog(guild, payload) {
  const fn = await getSendLog();
  console.info(JSON.stringify({ name: "antinuke.trace", phase: "deliverLog:start", guild: guild?.id, title: payload?.title }));
  if (fn) {
    try { await fn(guild?.client, guild?.id, payload); console.info(JSON.stringify({ name: "antinuke.trace", phase: "deliverLog:ok" })); return; }
    catch (e) { console.warn(JSON.stringify({ name: "antinuke.trace", phase: "deliverLog:fail", err: String(e?.message || e) })); }
  }
  console.log(JSON.stringify({ name: "antinuke", ...payload }));
}

const GSTATE = new Map();
function getWeights(cfg) {
  const w = cfg?.weights || {};
  return {
    channelDelete: n(w.channelDelete, 1.0),
    roleDelete:    n(w.roleDelete,    1.0),
    emojiDelete:   n(w.emojiDelete,   0.5),
    webhookCreate: n(w.webhookCreate, 0.75),
    webhookDelete: n(w.webhookDelete, 0.75),
    guildBanAdd:   n(w.guildBanAdd,   1.5),
  };
}
function bumpScore(guildId, actorId, key, weight, windowMs) {
  if (!GSTATE.has(guildId)) GSTATE.set(guildId, new Map());
  const map = GSTATE.get(guildId);
  const now = Date.now();
  const cur = map.get(actorId) || { score: 0, windowStart: now, tally: {} };
  if (now - cur.windowStart > windowMs) { cur.score = 0; cur.windowStart = now; cur.tally = {}; }
  cur.score += weight;
  cur.tally[key] = (cur.tally[key] || 0) + 1;
  map.set(actorId, cur);
  return cur;
}
function tallyString(tally, weights) {
  const parts = Object.entries(tally).map(([k, c]) => `${k}×${c}`);
  const score = Object.entries(tally).reduce((a, [k, c]) => a + (weights[k] || 0) * c, 0);
  return `${parts.join(", ")} (${score.toFixed(2)})`;
}

async function resolveActorForChannelDelete(channel) {
  try {
    const guild = channel?.guild; if (!guild) return { user: null, entry: null };
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 3 }).catch(() => null);
    const entries = Array.from(logs?.entries?.values?.() || []);
    const now = Date.now();
    const entry = entries.find(e => e?.target?.id === channel?.id && Math.abs(now - (e?.createdTimestamp || 0)) < 15_000);
    return { user: entry?.executor || null, entry: entry || null };
  } catch { return { user: null, entry: null }; }
}
async function resolveActorForRoleDelete(role) {
  try {
    const guild = role?.guild; if (!guild) return { user: null, entry: null };
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.RoleDelete, limit: 3 }).catch(() => null);
    const now = Date.now();
    const entry = Array.from(logs?.entries?.values?.() || [])
      .find(e => e?.target?.id === role?.id && Math.abs(now - (e?.createdTimestamp || 0)) < 15_000);
    return { user: entry?.executor || null, entry: entry || null };
  } catch { return { user: null, entry: null }; }
}
async function resolveActorForEmojiDelete(emoji) {
  try {
    const guild = emoji?.guild; if (!guild) return { user: null, entry: null };
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.EmojiDelete, limit: 3 }).catch(() => null);
    const now = Date.now();
    const entry = Array.from(logs?.entries?.values?.() || [])[0];
    if (!entry || Math.abs(now - (entry?.createdTimestamp || 0)) > 15_000) return { user: null, entry: null };
    return { user: entry?.executor || null, entry: entry || null };
  } catch { return { user: null, entry: null }; }
}
async function resolveActorViaAudit(guild, type) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 1 }).catch(() => null);
    const entry = Array.from(logs?.entries?.values?.() || [])[0] || null;
    const now = Date.now();
    if (!entry || Math.abs(now - (entry?.createdTimestamp || 0)) > 15_000) return { user: null, entry: null };
    return { user: entry?.executor || null, entry };
  } catch { return { user: null, entry: null }; }
}

async function requestSoftLockBridge(client, guild, minutes, who) {
  try {
    const mod = await import("./joingate.v1.js");
    const helper =
      mod?.requestSoftLock ||
      mod?.engageSoftLock ||
      mod?.softLockEngage ||
      mod?.softLockOn ||
      mod?.default?.requestSoftLock;
    if (typeof helper === "function") {
      await helper(client, guild?.id, minutes, { reason: "anti-nuke", actorId: who?.id, source: "antinuke" });
      return true;
    }
  } catch {}
  try {
    client.emit("joingate:softlock:request", { guildId: guild?.id, minutes, reason: "anti-nuke", actorId: who?.id, source: "antinuke" });
    return true;
  } catch {}
  return false;
}

async function registerSlash(client) {
  client.once("clientReady", async () => {
    try {
      const app = client.application; if (!app) return;
      for (const [guildId] of client.guilds.cache) {
        try { await app.commands.create({ name: "antinuke", description: "Show Anti-Nuke status (ephemeral)", dm_permission: false }, guildId); }
        catch (err) { log.warn({ err: String(err?.message || err), guildId }, "slash register failed (/antinuke)"); }
      }
      console.info(JSON.stringify({ name: "antinuke.trace", phase: "slash:registered", guildId: client.guilds.cache.first()?.id, cmd: "antinuke" }));
    } catch {}
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== "antinuke") return;
      const cfg = await readJSONSafe(path.join(process.cwd(), "data", "antinuke-limiter.json"), {});
      const weights = getWeights(cfg);
      const enabled = !!cfg.enabled;
      const enforce = !!(cfg?.enforce?.enabled);
      const softMin = n(cfg?.enforce?.softLockMinutes, 15);
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
      const summary = {
        enabled,
        windowMs: n(cfg.windowMs, 30_000),
        threshold: n(cfg.threshold, 3),
        enforce: { enabled: enforce, softLockMinutes: softMin },
        respectExemptions: cfg?.respectExemptions !== false,
        weights
      };
      await interaction.editReply("```json\n" + JSON.stringify(summary, null, 2).slice(0, 1900) + "\n```");
    } catch (e) {
      try { await interaction.reply({ content: "Anti-Nuke: failed to show status.", flags: MessageFlags.Ephemeral }); } catch {}
      log.error({ err: String(e?.message || e) }, "antinuke status failed");
    }
  });
}

export async function wire(client) {
  const cfgPath = path.join(process.cwd(), "data", "antinuke-limiter.json");
  const cfg = await readJSONSafe(cfgPath, {});
  console.info(JSON.stringify({ name: "antinuke.trace", phase: "startup:config", cfg }));

  const enabled   = !!cfg.enabled;
  const windowMs  = n(cfg.windowMs, 30_000);
  const threshold = n(cfg.threshold, 3);
  const weights   = getWeights(cfg);
  const enforce   = !!(cfg?.enforce?.enabled);
  const softMin   = n(cfg?.enforce?.softLockMinutes, 15);

  log.info({ cfg }, "antinuke config resolved");

  const anyGuild = client.guilds.cache.first?.() || Array.from(client.guilds.cache.values())[0];
  console.info(JSON.stringify({ name: "antinuke.trace", phase: "startup:summary", guild: anyGuild?.id }));
  await safeSendLog(anyGuild, {
    title: "Anti-Nuke",
    description: `Active (window=${windowMs}ms, threshold=${threshold}, enforce=${enforce ? "true" : "false"})`,
  });

  if (!enabled) {
    log.info("antinuke disabled; not wiring listeners");
    await registerSlash(client);
    return;
  }

  console.info(JSON.stringify({ name: "antinuke.trace", phase: "handlers:attach:start" }));

  client.on("channelDelete", async (channel) => {
    console.info(JSON.stringify({ name: "antinuke.trace", event: "channelDelete", guildId: channel?.guild?.id, channelId: channel?.id, name: channel?.name }));
    try {
      if (!channel?.guild) return;
      const { user } = await resolveActorForChannelDelete(channel);
      const actorId = user?.id || "unknown";
      const s = bumpScore(channel.guild.id, actorId, "channelDelete", weights.channelDelete, windowMs);
      await safeSendLog(channel.guild, {
        title: (s.score >= threshold ? "⚠️ Anti-Nuke Activity" : "ℹ️ Anti-Nuke Activity"),
        description:
          `Event: **channelDelete** (+${weights.channelDelete.toFixed(2)})\n` +
          `Score: **${s.score.toFixed(2)}** / threshold **${threshold}** (window ${windowMs}ms)\n` +
          (user ? `By: **${user.username}** (${user.id})\n` : "") +
          (channel?.name ? `Channel: #${channel.name} (${channel.id})\n` : `Channel ID: ${channel?.id || "unknown"}\n`) +
          `Window: ${tallyString(s.tally, weights)}`
      });
      if (enforce && s.score >= threshold) {
        await safeSendLog(channel.guild, {
          title: "🛑 Anti-Nuke Enforcement",
          description: `Threshold reached → requesting soft-lock for ${softMin} minutes.`
        });
        await requestSoftLockBridge(client, channel.guild, softMin, user);
      }
    } catch (e) {
      log.error({ err: String(e?.message || e) }, "channelDelete handler failed");
    }
  });

  client.on("roleDelete", async (role) => {
    console.info(JSON.stringify({ name: "antinuke.trace", event: "roleDelete", guildId: role?.guild?.id, roleId: role?.id, name: role?.name }));
    try {
      if (!role?.guild) return;
      const { user } = await resolveActorForRoleDelete(role);
      const actorId = user?.id || "unknown";
      const s = bumpScore(role.guild.id, actorId, "roleDelete", weights.roleDelete, windowMs);
      await safeSendLog(role.guild, {
        title: (s.score >= threshold ? "⚠️ Anti-Nuke Activity" : "ℹ️ Anti-Nuke Activity"),
        description:
          `Event: **roleDelete** (+${weights.roleDelete.toFixed(2)})\n` +
          `Score: **${s.score.toFixed(2)}** / threshold **${threshold}** (window ${windowMs}ms)\n` +
          (user ? `By: **${user.username}** (${user.id})\n` : "") +
          `Role: @${role?.name || "unknown"} (${role?.id || "?"})\n` +
          `Window: ${tallyString(s.tally, weights)}`
      });
      if (enforce && s.score >= threshold) {
        await safeSendLog(role.guild, {
          title: "🛑 Anti-Nuke Enforcement",
          description: `Threshold reached → requesting soft-lock for ${softMin} minutes.`
        });
        await requestSoftLockBridge(client, role.guild, softMin, user);
      }
    } catch (e) {
      log.error({ err: String(e?.message || e) }, "roleDelete handler failed");
    }
  });

  client.on("emojiDelete", async (emoji) => {
    console.info(JSON.stringify({ name: "antinuke.trace", event: "emojiDelete", guildId: emoji?.guild?.id, emoji: emoji?.name }));
    try {
      if (!emoji?.guild) return;
      const { user } = await resolveActorForEmojiDelete(emoji);
      const actorId = user?.id || "unknown";
      const s = bumpScore(emoji.guild.id, actorId, "emojiDelete", weights.emojiDelete, windowMs);
      await safeSendLog(emoji.guild, {
        title: (s.score >= threshold ? "⚠️ Anti-Nuke Activity" : "ℹ️ Anti-Nuke Activity"),
        description:
          `Event: **emojiDelete** (+${weights.emojiDelete.toFixed(2)})\n` +
          `Score: **${s.score.toFixed(2)}** / threshold **${threshold}** (window ${windowMs}ms)\n` +
          (user ? `By: **${user.username}** (${user.id})\n` : "") +
          `Window: ${tallyString(s.tally, weights)}`
      });
      if (enforce && s.score >= threshold) {
        await safeSendLog(emoji.guild, {
          title: "🛑 Anti-Nuke Enforcement",
          description: `Threshold reached → requesting soft-lock for ${softMin} minutes.`
        });
        await requestSoftLockBridge(client, emoji.guild, softMin, user);
      }
    } catch (e) {
      log.error({ err: String(e?.message || e) }, "emojiDelete handler failed");
    }
  });

  client.on("webhookUpdate", async (channel) => {
    console.info(JSON.stringify({ name: "antinuke.trace", event: "webhookUpdate", guildId: channel?.guild?.id, channelId: channel?.id }));
    try {
      const guild = channel?.guild; if (!guild) return;
      const { user: cu } = await resolveActorViaAudit(guild, AuditLogEvent.WebhookCreate);
      const { user: du } = await resolveActorViaAudit(guild, AuditLogEvent.WebhookDelete);
      const user = cu || du; if (!user) return;
      const weights = getWeights(await readJSONSafe(path.join(process.cwd(), "data", "antinuke-limiter.json"), {}));
      const w = (cu ? weights.webhookCreate : 0) + (du ? weights.webhookDelete : 0);
      const key = cu && du ? "webhookCreate+webhookDelete" : (cu ? "webhookCreate" : "webhookDelete");
      const s = bumpScore(guild.id, user.id, key, w || weights.webhookDelete, windowMs);
      await safeSendLog(guild, {
        title: (s.score >= threshold ? "⚠️ Anti-Nuke Activity" : "ℹ️ Anti-Nuke Activity"),
        description:
          `Event: **${key}** (+${(w || weights.webhookDelete).toFixed(2)})\n` +
          `Score: **${s.score.toFixed(2)}** / threshold **${threshold}** (window ${windowMs}ms)\n` +
          `By: **${user.username}** (${user.id})\n` +
          `Channel: #${channel?.name || "unknown"} (${channel?.id || "?"})\n` +
          `Window: ${tallyString(s.tally, weights)}`
      });
      if (enforce && s.score >= threshold) {
        await safeSendLog(guild, {
          title: "🛑 Anti-Nuke Enforcement",
          description: `Threshold reached → requesting soft-lock for ${softMin} minutes.`
        });
        await requestSoftLockBridge(client, guild, softMin, user);
      }
    } catch (e) {
      log.error({ err: String(e?.message || e) }, "webhookUpdate handler failed");
    }
  });

  client.on("guildBanAdd", async (ban) => {
    console.info(JSON.stringify({ name: "antinuke.trace", event: "guildBanAdd", guildId: ban?.guild?.id, targetId: ban?.user?.id }));
    try {
      const guild = ban?.guild; if (!guild) return;
      const { user } = await resolveActorViaAudit(guild, AuditLogEvent.MemberBanAdd);
      if (!user) return;
      const s = bumpScore(guild.id, user.id, "guildBanAdd", weights.guildBanAdd, windowMs);
      await safeSendLog(guild, {
        title: (s.score >= threshold ? "⚠️ Anti-Nuke Activity" : "ℹ️ Anti-Nuke Activity"),
        description:
          `Event: **guildBanAdd** (+${weights.guildBanAdd.toFixed(2)})\n` +
          `Score: **${s.score.toFixed(2)}** / threshold **${threshold}** (window ${windowMs}ms)\n` +
          `By: **${user.username}** (${user.id})\n` +
          `Target: **${ban?.user?.username || "unknown"}** (${ban?.user?.id || "?"})\n` +
          `Window: ${tallyString(s.tally, weights)}`
      });
      if (enforce && s.score >= threshold) {
        await safeSendLog(guild, {
          title: "🛑 Anti-Nuke Enforcement",
          description: `Threshold reached → requesting soft-lock for ${softMin} minutes.`
        });
        await requestSoftLockBridge(client, guild, softMin, user);
      }
    } catch (e) {
      log.error({ err: String(e?.message || e) }, "guildBanAdd handler failed");
    }
  });

  console.info(JSON.stringify({ name: "antinuke.trace", phase: "handlers:attach:done" }));
  await registerSlash(client);
}

export const wireAntiNukeV1 = wire;
export default wire;
