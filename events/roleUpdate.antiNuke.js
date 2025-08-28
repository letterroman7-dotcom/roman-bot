// events/roleUpdate.antiNuke.js
// Low-noise signal: "roleUpdate" (tiny weight) to detect bursts of permission changes.

export function onRoleUpdate(ctx) {
  const { director, notifier, log, oldRole, newRole, featureOn } = ctx;
  const guildId = newRole?.guild?.id ?? oldRole?.guild?.id ?? "unknown";
  const roleName = newRole?.name ?? oldRole?.name ?? "unknown";

  if (!featureOn) return;

  try {
    const anti = director.forGuild(guildId);
    anti.record("roleUpdate", 1);
    const status = anti.status();

    log.info(
      { evt: "roleUpdate", guildId, role: roleName, score: status.score, triggered: status.triggered },
      "AntiNuke updated"
    );

    notifier.checkAndLog({ log, guildId, status });
  } catch (err) {
    log.error({ err }, "onRoleUpdate failed");
  }
}
