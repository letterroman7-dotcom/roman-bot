// events/webhooksUpdate.antiNuke.js
// Discord doesn't emit "webhookDelete"; we use webhooksUpdate as a proxy.
// Count this as "webhookDelete" for scoring. Emit soft-lockdown notice on threshold.

export function onWebhooksUpdate(ctx) {
  const { director, notifier, log, channel, featureOn } = ctx;
  const guildId = channel?.guild?.id ?? "unknown";
  const name = channel?.name ?? "unknown";

  if (!featureOn) return;

  try {
    const anti = director.forGuild(guildId);
    anti.record("webhookDelete", 1);
    const status = anti.status();

    log.info(
      { evt: "webhooksUpdate->webhookDelete", guildId, channel: name, score: status.score, triggered: status.triggered },
      "AntiNuke updated"
    );

    notifier.checkAndLog({ log, guildId, status });
  } catch (err) {
    log.error({ err }, "onWebhooksUpdate failed");
  }
}
