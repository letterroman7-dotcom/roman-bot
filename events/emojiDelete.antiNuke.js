// events/emojiDelete.antiNuke.js
// Counts as "emojiDelete" in AntiNuke scoring. Emits soft-lockdown notice on threshold.

export function onEmojiDelete(ctx) {
  const { anti, notifier, log, emoji, featureOn } = ctx;
  const guildId = emoji?.guild?.id ?? "unknown";
  const name = emoji?.name ?? "unknown";
  const emojiId = emoji?.id ?? "unknown";

  if (!featureOn) return;

  try {
    anti.record("emojiDelete", 1);
    const status = anti.status();

    log.info(
      {
        evt: "emojiDelete",
        guildId,
        emoji: name,
        id: emojiId,
        score: status.score,
        triggered: status.triggered
      },
      "AntiNuke updated"
    );

    notifier.checkAndLog({ log, guildId, status });
  } catch (err) {
    log.error({ err }, "onEmojiDelete failed");
  }
}
