// src/discord/addons/spamheat.v2.js
import { MessageFlags, PermissionsBitField } from "discord.js";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import {
  loadConfig as loadSpamCfgFile,
  isExempt,
  processMessage,
  actionSummary,
} from "../../../utils/spamheat-v2.js";

const log = pino({ name: "spamheat.wire" });
const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, "data", "spamheat-v2.json");

// Lazy import of log-config helper (optional)
let __logCfg = null;
async function getLogCfg() {
  if (__logCfg) return __logCfg;
  try {
    __logCfg = await import("../../../utils/log-config.js");
  } catch (err) {
    log.warn({ msg: "log-config helper missing; mod-log piping disabled", err: String(err?.message || err) });
    __logCfg = { __missing: true, getGuildMainLogChannelId: async () => null };
  }
  return __logCfg;
}

// --- config cache & helpers ---------------------------------------------------
let cfg = loadSpamCfgFile();
let lastStatMs = 0;

function reloadConfigIfChanged() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (!lastStatMs || stat.mtimeMs > lastStatMs) {
      cfg = loadSpamCfgFile();
      lastStatMs = stat.mtimeMs;
      log.info({ msg: "spamheat config reloaded", enabled: cfg.enabled, shadowMode: cfg.shadowMode });
    }
  } catch {
    // file may not exist yet
  }
}

function saveConfig(mutator) {
  const current = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) : {};
  const next = mutator(current) || current;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  cfg = loadSpamCfgFile();
  try {
    const stat = fs.statSync(CONFIG_PATH);
    lastStatMs = stat.mtimeMs;
  } catch {}
}

// --- metrics ------------------------------------------------------------------
const metrics = {
  processed: 0,
  warns: 0,
  blocks: 0,
  timeouts: 0
};

// --- mod-log helper -----------------------------------------------------------
async function sendModLog(guild, content) {
  try {
    const { getGuildMainLogChannelId, __missing } = await getLogCfg();
    if (__missing) return;
    const chId = await getGuildMainLogChannelId(guild.id);
    if (!chId) return;
    const ch = guild.channels.cache.get(chId) || await guild.channels.fetch(chId).catch(() => null);
    if (!ch) return;
    await ch.send({ content }).catch(() => {});
  } catch {}
}

// --- permission helpers -------------------------------------------------------
function botPermsOkForEnforcement(guild, channel) {
  const me = guild?.members?.me;
  if (!me) return false;
  const p = channel?.permissionsFor?.(me) || me.permissions;
  const canDelete = p?.has?.(PermissionsBitField.Flags.ManageMessages);
  const canTimeout = me.permissions?.has?.(PermissionsBitField.Flags.ModerateMembers);
  return { canDelete: !!canDelete, canTimeout: !!canTimeout };
}

// --- core wire ---------------------------------------------------------------
export async function wireSpamHeatV2(client) {
  log.info({ msg: "spamheat wiring start" });

  // refresh config every ~5s (cheap stat + parse)
  setInterval(reloadConfigIfChanged, 5000).unref?.();

  // message handler
  client.on("messageCreate", async (msg) => {
    try {
      if (!cfg.enabled) return;
      if (!msg?.inGuild?.() || msg.author?.bot || msg.system || msg.webhookId) return;

      // NOTE: If MESSAGE CONTENT intent is disabled, msg.content may be empty;
      // spamheat still does rate/mention counts, but quality improves with content intent on.
      const member = msg.member || await msg.guild.members.fetch(msg.author.id).catch(() => null);
      if (isExempt(member, cfg)) return;

      metrics.processed++;

      const res = processMessage(msg, cfg);
      const summary = actionSummary(res);

      if (cfg.shadowMode) {
        // observe-only
        if (res.reason !== "ok") {
          log.info({ msg: "shadow", guildId: msg.guild.id, channelId: msg.channel.id, userId: msg.author.id, summary });
          await sendModLog(msg.guild, `👀 **SpamHeat (shadow)** in <#${msg.channel.id}> by <@${msg.author.id}> — ${summary}`);
        }
        return;
      }

      // enforcement
      const { canDelete, canTimeout } = botPermsOkForEnforcement(msg.guild, msg.channel);

      if (res.reason === "warn") {
        metrics.warns++;
        log.info({ msg: "warn", guildId: msg.guild.id, channelId: msg.channel.id, userId: msg.author.id, summary });
        await sendModLog(msg.guild, `⚠️ **SpamHeat WARN** in <#${msg.channel.id}> by <@${msg.author.id}> — ${summary}`);
        return;
      }

      if (res.reason === "block") {
        metrics.blocks++;
        if (res.action === "delete" && cfg.deleteMessagesOnBlock && canDelete) {
          await msg.delete().catch(() => {});
        }
        log.warn({ msg: "block", guildId: msg.guild.id, channelId: msg.channel.id, userId: msg.author.id, summary });
        await sendModLog(msg.guild, `🛑 **SpamHeat BLOCK** in <#${msg.channel.id}> by <@${msg.author.id}> — ${summary}`);
        return;
      }

      if (res.reason === "max") {
        metrics.timeouts++;
        // best-effort delete offending message
        if (cfg.deleteMessagesOnBlock && canDelete) {
          await msg.delete().catch(() => {});
        }
        if (res.action === "timeout" && canTimeout) {
          const seconds = Math.max(60, Number(cfg.timeoutSeconds || 600));
          await member?.timeout?.(seconds * 1000, "SpamHeatV2 max strikes").catch(() => {});
        }
        log.warn({ msg: "max", guildId: msg.guild.id, channelId: msg.channel.id, userId: msg.author.id, summary });
        await sendModLog(msg.guild, `🚫 **SpamHeat TIMEOUT** <@${msg.author.id}> for ${cfg.timeoutSeconds || 600}s — ${summary}`);
      }
    } catch (err) {
      log.error({ msg: "messageCreate handler error", err: String(err?.message || err) });
    }
  });

  // Register /spamheat slash (guild-scoped) on ready
  client.once("clientReady", async () => {
    const app = client.application;
    if (!app) return;

    for (const [guildId] of client.guilds.cache) {
      try {
        await app.commands.create({
          name: "spamheat",
          description: "SpamHeat v2 controls (ephemeral)",
          dm_permission: false,
          options: [
            { type: 1, name: "status", description: "Show status & metrics" },
            { type: 1, name: "enable", description: "Enable SpamHeat v2 (optionally disable shadow)",
              options: [{ type: 5, name: "shadow", description: "Shadow mode (default true)", required: false }]
            },
            { type: 1, name: "disable", description: "Disable SpamHeat v2" },
            { type: 1, name: "shadow", description: "Toggle shadow mode",
              options: [{ type: 5, name: "on", description: "true = observe-only", required: true }]
            },
            { type: 1, name: "set", description: "Adjust thresholds/limits",
              options: [
                { type: 10, name: "heatwarn", description: "Warn at heat ≥ N", required: false },
                { type: 10, name: "heatblock", description: "Block at heat ≥ N", required: false },
                { type: 4,  name: "msgsperwin", description: "Messages per window", required: false },
                { type: 4,  name: "timeoutsec", description: "Timeout seconds at max", required: false }
              ]
            }
          ]
        }, guildId);
      } catch (err) {
        log.warn({ msg: "slash register failed", guildId, err: String(err?.message || err) });
      }
    }
    log.info({ msg: "spamheat slash registered" });
  });

  // Slash handler (ephemeral)
  client.on("interactionCreate", async (i) => {
    try {
      if (!i.isChatInputCommand() || i.commandName !== "spamheat") return;
      if (!i.inGuild()) { await i.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral }); return; }

      const m = i.member;
      const canManage = m?.permissions?.has?.(PermissionsBitField.Flags.ManageGuild) ||
                        m?.permissions?.has?.(PermissionsBitField.Flags.Administrator);
      if (!canManage) {
        await i.reply({ content: "You need **Manage Server** (or Administrator) to use this.", flags: MessageFlags.Ephemeral });
        return;
      }

      const sub = i.options.getSubcommand();

      if (sub === "status") {
        reloadConfigIfChanged();
        const me = i.guild.members.me;
        const perms = me?.permissions || new PermissionsBitField();
        const summary = {
          enabled: !!cfg.enabled,
          shadowMode: !!cfg.shadowMode,
          thresholds: cfg.thresholds,
          rateWindowMs: cfg.rateWindowMs,
          rateLimits: cfg.rateLimits,
          actions: cfg.actions,
          timeoutSeconds: cfg.timeoutSeconds,
          deleteMessagesOnBlock: !!cfg.deleteMessagesOnBlock,
          exempt: cfg.exempt,
          metrics,
          botPerms: {
            manageMessages: perms.has(PermissionsBitField.Flags.ManageMessages),
            moderateMembers: perms.has(PermissionsBitField.Flags.ModerateMembers),
            messageContentIntentLikely: typeof i.client?.options?.intents !== "undefined" // hint only
          }
        };
        await i.reply({ content: "```json\n" + JSON.stringify(summary, null, 2).slice(0, 1900) + "\n```", flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === "enable") {
        const shadow = i.options.getBoolean("shadow");
        saveConfig((c) => {
          c.enabled = true;
          if (typeof shadow === "boolean") c.shadowMode = shadow;
          return c;
        });
        await i.reply({ content: "Enabled SpamHeat v2" + (typeof shadow === "boolean" ? ` (shadow=${shadow})` : ""), flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === "disable") {
        saveConfig((c) => { c.enabled = false; return c; });
        await i.reply({ content: "Disabled SpamHeat v2.", flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === "shadow") {
        const on = i.options.getBoolean("on", true);
        saveConfig((c) => { c.shadowMode = !!on; return c; });
        await i.reply({ content: `Shadow mode set to ${on}.`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === "set") {
        const hw = i.options.getNumber("heatwarn");
        const hb = i.options.getNumber("heatblock");
        const mpw = i.options.getInteger("msgsperwin");
        const ts = i.options.getInteger("timeoutsec");

        saveConfig((c) => {
          c.thresholds = c.thresholds || {};
          c.rateLimits = c.rateLimits || {};
          if (typeof hw === "number") c.thresholds.heatWarn = hw;
          if (typeof hb === "number") c.thresholds.heatBlock = hb;
          if (Number.isInteger(mpw)) c.rateLimits.messagesPerWindow = mpw;
          if (Number.isInteger(ts)) c.timeoutSeconds = ts;
          return c;
        });

        await i.reply({ content: "Updated SpamHeat settings.", flags: MessageFlags.Ephemeral });
        return;
      }

      await i.reply({ content: "Unknown subcommand.", flags: MessageFlags.Ephemeral });
    } catch (err) {
      try { await i.reply({ content: "SpamHeat command failed. Check logs.", flags: MessageFlags.Ephemeral }); } catch {}
      log.error({ msg: "slash error", err: String(err?.message || err) });
    }
  });

  log.info({ msg: "spamheat wired", enabled: cfg.enabled, shadowMode: cfg.shadowMode });
}

export default { wireSpamHeatV2 };
