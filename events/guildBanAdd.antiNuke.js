// events/guildBanAdd.antiNuke.js
// Counts as "guildBanAdd" in AntiNuke scoring. Emits soft-lockdown notice on threshold.

export function onGuildBanAdd(ctx) {
  const { anti, notifier, log, ban, featureOn } = ctx;
  const guildId = ban?.guild?.id ?? "unknown";
  const userTag = ban?.user?.tag ?? "unknown";
  const userId = ban?.user?.id ?? "unknown";

  if (!featureOn) return;

  try {
    anti.record("guildBanAdd", 1);
    const status = anti.status();

    log.info(
      {
        evt: "guildBanAdd",
        guildId,
        user: userTag,
        userId,
        score: status.score,
        triggered: status.triggered
      },
      "AntiNuke updated"
    );

    notifier.checkAndLog({ log, guildId, status });
  } catch (err) {
    log.error({ err }, "onGuildBanAdd failed");
  }
}
