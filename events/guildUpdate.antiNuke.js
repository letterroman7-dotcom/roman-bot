// events/guildUpdate.antiNuke.js
// Low-noise signal: "guildUpdate" (tiny weight) to detect bursty config changes.

export function onGuildUpdate(ctx) {
  const { director, notifier, log, oldGuild, newGuild, featureOn } = ctx;
  const guildId = newGuild?.id ?? oldGuild?.id ?? "unknown";

  if (!featureOn) return;

  try {
    const anti = director.forGuild(guildId);
    anti.record("guildUpdate", 1);
    const status = anti.status();

    // Keep log light; names can be long/mutable; rely on scrubbed IDs.
    log.info(
      { evt: "guildUpdate", guildId, score: status.score, triggered: status.triggered },
      "AntiNuke updated"
    );

    notifier.checkAndLog({ log, guildId, status });
  } catch (err) {
    log.error({ err }, "onGuildUpdate failed");
  }
}
