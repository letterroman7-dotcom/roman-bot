// events/channelDelete.antiNuke.js
// Counts as "channelDelete" in AntiNuke scoring. Emits soft-lockdown notice on threshold.

export function onChannelDelete(ctx) {
  const { director, notifier, log, channel, featureOn } = ctx;
  const guildId = channel?.guild?.id ?? "unknown";
  const name = channel?.name ?? "unknown";

  if (!featureOn) return;

  try {
    const anti = director.forGuild(guildId);
    anti.record("channelDelete", 1);
    const status = anti.status();

    log.info(
      { evt: "channelDelete", guildId, channel: name, score: status.score, triggered: status.triggered },
      "AntiNuke updated"
    );

    notifier.checkAndLog({ log, guildId, status });
  } catch (err) {
    log.error({ err }, "onChannelDelete failed");
  }
}
