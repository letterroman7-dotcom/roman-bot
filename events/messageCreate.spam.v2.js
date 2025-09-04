// events/messageCreate.spam.v2.js — inert until enabled in data/spamheat-v2.json
import pino from "pino";
import { loadConfig, isExempt, processMessage, actionSummary } from "../utils/spamheat-v2.js";

const log = pino({ name: "message.spam.v2" });

export default async function onMessageCreate(message) {
  const cfg = loadConfig();
  if (!cfg.enabled) return;
  if (!message || !message.guild) return;       // ignore DMs
  if (message.author?.bot) return;              // ignore bots

  try {
    const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
    if (member && isExempt(member, cfg)) return;

    const res = processMessage(message, cfg);
    log[cfg.logSeverity]({ guildId: message.guild.id, channelId: message.channel.id, userId: message.author.id, res },
      actionSummary(res)
    );

    if (cfg.shadowMode) return;

    if (res.action === "delete" && cfg.deleteMessagesOnBlock) {
      try { await message.delete(); } catch { /* ignore */ }
    } else if (res.action === "timeout") {
      const ms = Math.max(1, (cfg.timeoutSeconds ?? 600)) * 1000;
      try { await member?.timeout(ms, "SpamHeat v2 auto-timeout"); } catch { /* ignore */ }
    }
  } catch (err) {
    log.warn({ err }, "spam v2 handler error");
  }
}
