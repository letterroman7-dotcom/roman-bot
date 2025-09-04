// events/webhookCreate.guard.v2.js — inert until wired; does not modify existing v1.
// One event per file; no side effects on import.

import pino from "pino";
import { loadConfig, isExempt, shouldBlockChange, tryAutoDeleteWebhook, summaryForLog } from "../utils/webhook-guard-v2.js";

const log = pino({ name: "webhook.create.v2" });

export default async function onWebhookCreate(webhook) {
  const cfg = loadConfig();
  if (!cfg.enabled) return; // inert by default

  try {
    const guild = webhook.guild;
    const audit = await guild.fetchAuditLogs({ type: 50, limit: 1 }).catch(() => null); // 50 = WEBHOOK_CREATE
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
      await tryAutoDeleteWebhook(webhook, cfg);
      // optional: punish handled by higher-level policy when wired
    }
  } catch (err) {
    log.warn({ err }, "webhook create v2 handler error");
  }
}
