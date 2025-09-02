// events/webhookUpdate.guard.js
// Works from any folder: imports utils from project root via process.cwd()

import { AuditLogEvent } from "discord.js";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const fromRoot = (p) => pathToFileURL(path.join(ROOT, p)).href;
const [
  { default: createLogger },
  Guard,
  { sendSecurityLog, toRedactedId }
] = await Promise.all([
  import(fromRoot("utils/pino-factory.js")),
  import(fromRoot("utils/webhook-guard.js")),
  import(fromRoot("utils/security-log.js")),
]);

const loadWebhookGuardConfig = Guard.loadWebhookGuardConfig || (async () => ({ enabled: false }));
const isChannelAllowed      = Guard.isChannelAllowed      || (() => false);
const maybePunishExecutor   = Guard.maybePunishExecutor   || (async () => {});
const auditWindowOk         = Guard.auditWindowOk         || (() => true);
const AuditTypes            = Guard.AuditTypes            || {};

const log = createLogger("webhook.update.guard");

export default function wireWebhookUpdateGuard(client) {
  client.once?.("ready", () => log.info("webhookUpdate.guard active"));

  client.on("webhooksUpdate", async (channel) => {
    try {
      const guild = channel?.guild;
      if (!guild?.id) return;

      const cfg = await loadWebhookGuardConfig();
      if (!cfg.enabled) return;

      const type = (AuditLogEvent?.WebhookUpdate ?? AuditTypes.WebhookUpdate);
      const audits = await guild.fetchAuditLogs({ type, limit: 1 }).catch(() => null);
      const entry = audits?.entries?.first?.() ?? (audits?.entries && [...audits.entries.values()][0]);
      if (!entry) return;

      const when = entry.createdTimestamp ?? entry?.createdAt?.getTime?.();
      if (!auditWindowOk(when, cfg.auditLookbackMs)) return;

      const executorId = entry.executorId;
      const webhook = entry.target;
      const channelId = webhook?.channelId ?? channel?.id;
      const changes = entry.changes;

      if (isChannelAllowed(channelId, cfg)) {
        await sendSecurityLog(client, guild, "info", "webhook.update.allowed", {
          channel: toRedactedId(channelId),
          webhookId: toRedactedId(webhook?.id),
          by: toRedactedId(executorId),
          changes
        });
        return;
      }

      let deleted = false, delErr = null;
      if (cfg.enforce?.autoDeleteRogueWebhook && webhook?.delete) {
        try { await webhook.delete("Webhook Guard: update on disallowed channel"); deleted = true; }
        catch (e) { delErr = String(e?.message || e); }
      }

      await sendSecurityLog(client, guild, cfg.logLevel || "info", "webhook.update.rogue", {
        channel: toRedactedId(channelId),
        webhookId: toRedactedId(webhook?.id),
        by: toRedactedId(executorId),
        changes,
        deleted,
        delErr
      });

      if (executorId) {
        await maybePunishExecutor(client, guild, executorId, cfg, "Updated webhook in disallowed channel", {
          channelId, webhookId: webhook?.id, changes
        });
      }
    } catch (err) {
      log.warn({ err: String(err?.stack || err) }, "webhookUpdate guard error");
    }
  });
}
