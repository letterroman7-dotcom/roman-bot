// events/roleDelete.antiNuke.js
// Counts as "roleDelete" in AntiNuke scoring. Emits soft-lockdown notice on threshold.

export function onRoleDelete(ctx) {
  const { director, notifier, log, role, featureOn } = ctx;
  const guildId = role?.guild?.id ?? "unknown";
  const name = role?.name ?? "unknown";

  if (!featureOn) return;

  try {
    const anti = director.forGuild(guildId);
    anti.record("roleDelete", 1);
    const status = anti.status();

    log.info(
      { evt: "roleDelete", guildId, role: name, score: status.score, triggered: status.triggered },
      "AntiNuke updated"
    );

    notifier.checkAndLog({ log, guildId, status });
  } catch (err) {
    log.error({ err }, "onRoleDelete failed");
  }
}
