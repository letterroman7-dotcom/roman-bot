// utils/send-log.js
// Send moderation/security logs to the configured guild channel.
// Default export: async (guild, title, description, severity="info") => boolean

export default async function sendLog(guild, title, description, severity = "info") {
  try {
    if (!guild) return false;

    // 1) Get the configured channel id from your log-config helper (used by /setlog and /logtest)
    let getGuildMainLogChannelId = null;
    try {
      const mod = await import("./log-config.js");
      getGuildMainLogChannelId =
        mod?.getGuildMainLogChannelId || mod?.default?.getGuildMainLogChannelId || null;
    } catch {
      // helper missing is ok; we'll try fallbacks
    }

    let chId = null;
    if (typeof getGuildMainLogChannelId === "function") {
      try { chId = await getGuildMainLogChannelId(guild.id); } catch {}
    }

    // 2) Resolve the channel (by saved id first, then common names as a fallback)
    const isTextLike = (c) => c?.type === 0 || c?.type === 5; // text or announcement
    let ch = null;

    if (chId) {
      ch = guild.channels.cache.get(chId) || await guild.channels.fetch(chId).catch(() => null);
    }
    if (!ch) {
      const candidates = ["mod-log", "moderation-log", "security-log", "audit-log"];
      for (const name of candidates) {
        ch = guild.channels.cache.find(c => isTextLike(c) && c.name === name);
        if (ch) break;
      }
    }
    if (!ch || !isTextLike(ch)) return false;

    // 3) Try to send (don’t hard-fail on permission introspection)
    const sev = severity === "error" ? "🛑" : severity === "warn" ? "⚠️" : "ℹ️";
    const content = [
      `${sev} **${title}**`,
      description && description.includes("\n")
        ? "```md\n" + description.slice(0, 1800) + "\n```"
        : (description || "")
    ].filter(Boolean).join("\n");

    await ch.send({ content }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}
