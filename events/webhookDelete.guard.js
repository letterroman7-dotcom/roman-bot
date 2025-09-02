// events/webhookDelete.guard.js
// Works from any folder: imports utils from project root via process.cwd())

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
const auditWindowOk         = Guard.auditWindowOk         || (() => true);
const AuditTypes            = Guard.AuditTypes            || {};

const log = createLogger("webhook.delete.guard");

export default function wireWebhookDeleteGuard(client) {
  client.once?.("ready", () => log.info("webhookDelete.guard active"));

  client.on("webhooksUpdate", async (channel) => {
    try {
      const guild = channel?.guild;
      if (!guild?.id) return;

      const cfg = await loadWebhookGuardConfig();
      if (!cfg.enabled) return;

      const type = (AuditLogEvent?.WebhookDelete ?? AuditTypes.WebhookDelete);
      const audits = await guild.fetchAuditLogs({ type, limit: 1 }).catch(() => null);
      const entry = audits?.entries?.first?.() ?? (audits?.entries && [...audits.entries.values()][0]);
      if (!entry) return;

      const when = entry.createdTimestamp ?? entry?.createdAt?.getTime?.();
      if (!auditWindowOk(when, cfg.auditLookbackMs)) return;

      const executorId = entry.executorId;
      const webhook = entry.target;

      await sendSecurityLog(client, guild, "info", "webhook.delete", {
        channel: toRedactedId(channel?.id),
        webhookId: toRedactedId(webhook?.id),
        by: toRedactedId(executorId)
      });
    } catch (err) {
      log.warn({ err: String(err?.stack || err) }, "webhookDelete guard error");
    }
  });
}
