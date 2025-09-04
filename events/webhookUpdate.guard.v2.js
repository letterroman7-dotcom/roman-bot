// events/webhookUpdate.guard.v2.js — inert until wired; does not modify existing v1.

import pino from "pino";
import { loadConfig, isExempt, shouldBlockChange, tryAutoDeleteWebhook, summaryForLog } from "../utils/webhook-guard-v2.js";

const log = pino({ name: "webhook.update.v2" });

export default async function onWebhookUpdate(webhook) {
  const cfg = loadConfig();
  if (!cfg.enabled) return;

  try {
    const guild = webhook.guild;
    const audit = await guild.fetchAuditLogs({ type: 51, limit: 1 }).catch(() => null); // 51 = WEBHOOK_UPDATE
    const entry = audit?.entries?.first?.() ?? null;
    const executor = entry?.executor ?? null;
    const member = executor ? await guild.members.fetch(executor.id).catch(() => null) : null;

    if (member && isExempt(member, cfg)) return;

    const ctx = {
      webhookId: webhook.id,
      channelId: webhook.channelId ?? webhook.channel?.id ?? null,
      creatorId: entry?.target?.user?.id ?? null,
      executorId: executor?.id ?? null,
      guildId: guild.id
    };

    const blocked = shouldBlockChange(ctx, cfg);
    log[cfg.logSeverity]({ ctx }, summaryForLog(ctx, blocked));

    if (blocked) {
      // If a rogue update points to a compromised URL/token, you may want to delete & recreate.
      await tryAutoDeleteWebhook(webhook, cfg, "Unauthorized webhook update (v2)");
    }
  } catch (err) {
    log.warn({ err }, "webhook update v2 handler error");
  }
}
