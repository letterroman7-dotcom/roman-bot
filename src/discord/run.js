// src/discord/run.js
// Minimal Discord bootstrap. Honors feature flag "discordWiring".
// Events increment AntiNuke scoring and log status; emits soft-lockdown notices (log-only) on threshold.
// No punitive actions (v1 scope). Supports per-guild overrides via AntiNukeDirector.

import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { getLogger } from "../../utils/logger.pino.js";
import { isEnabled } from "../../utils/feature-flags.js";
import { AntiNukeDirector } from "../../modules/antinuke/director.js";
import { ThresholdNotifier } from "../../modules/antinuke/threshold-notifier.js";

const log = await getLogger("discord.run");

async function main() {
  if (!isEnabled("discordWiring")) {
    log.warn("discordWiring is disabled in data/feature-flags.json. Enable it and re-run.");
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    log.error("Missing DISCORD_TOKEN in environment. Set it in .env.");
    process.exitCode = 1;
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildBans
    ],
    partials: [Partials.GuildMember, Partials.Channel]
  });

  // Shared services (process-wide)
  const director = new AntiNukeDirector(); // per-guild services with overrides
  const notifier = new ThresholdNotifier();

  client.once("clientReady", () => {
    log.info({ user: client.user?.tag, id: client.user?.id }, "Discord client ready");
  });

  // Wire events (one-event-per-file; pass director + notifier)
  const { onChannelDelete } = await import("../../events/channelDelete.antiNuke.js");
  const { onRoleDelete } = await import("../../events/roleDelete.antiNuke.js");
  const { onWebhooksUpdate } = await import("../../events/webhooksUpdate.antiNuke.js");
  const { onGuildBanAdd } = await import("../../events/guildBanAdd.antiNuke.js");
  const { onEmojiDelete } = await import("../../events/emojiDelete.antiNuke.js");
  const { onGuildUpdate } = await import("../../events/guildUpdate.antiNuke.js");
  const { onRoleUpdate } = await import("../../events/roleUpdate.antiNuke.js");

  client.on("channelDelete", (channel) =>
    onChannelDelete({ client, log, director, notifier, channel, featureOn: isEnabled("discordWiring") })
  );

  client.on("roleDelete", (role) =>
    onRoleDelete({ client, log, director, notifier, role, featureOn: isEnabled("discordWiring") })
  );

  client.on("webhooksUpdate", (channel) =>
    onWebhooksUpdate({ client, log, director, notifier, channel, featureOn: isEnabled("discordWiring") })
  );

  client.on("guildBanAdd", (ban) =>
    onGuildBanAdd({ client, log, director, notifier, ban, featureOn: isEnabled("discordWiring") })
  );

  client.on("emojiDelete", (emoji) =>
    onEmojiDelete({ client, log, director, notifier, emoji, featureOn: isEnabled("discordWiring") })
  );

  client.on("guildUpdate", (oldGuild, newGuild) =>
    onGuildUpdate({ client, log, director, notifier, oldGuild, newGuild, featureOn: isEnabled("discordWiring") })
  );

  client.on("roleUpdate", (oldRole, newRole) =>
    onRoleUpdate({ client, log, director, notifier, oldRole, newRole, featureOn: isEnabled("discordWiring") })
  );

  await client.login(token);
}

main().catch((err) => {
  log.error({ err }, "Discord run crashed");
  process.exitCode = 1;
});
