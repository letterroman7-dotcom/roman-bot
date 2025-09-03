// src/discord/run.js
import "dotenv/config";
import os from "node:os";
import { Client, GatewayIntentBits } from "discord.js";
import wireDefault, { wire as wireNamed } from "./wire.js";

const wire = wireNamed || wireDefault?.wire || wireDefault;

function jlog(level, name, msg, extra = {}) {
  const line = JSON.stringify({ level, name, msg, ...extra });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

const token = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || "";
if (!token) {
  jlog("error", "discord.run", "No token in DISCORD_TOKEN/BOT_TOKEN");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,                  // channels/roles/emojis CRUD events
    GatewayIntentBits.GuildModeration,         // ban add events
    GatewayIntentBits.GuildEmojisAndStickers,  // emoji delete events
  ],
});

let emittedClientReady = false;

client.once("ready", () => {
  jlog("info", "discord.run", "Discord client ready", {
    user: client.user?.tag,
    id: `[id:${client.user?.id}]`,
    guilds: client.guilds.cache.size,
  });
  // Emit the legacy/custom signal exactly once to avoid any bridge loops.
  if (!emittedClientReady) {
    emittedClientReady = true;
    client.emit("clientReady");
  }
});

(async () => {
  jlog("info", "discord.run", "starting discord client", {
    node: process.version,
    host: os.hostname(),
    pid: process.pid,
    tokenSource: ".env",
    tokenKeyPath: process.env.DISCORD_TOKEN ? "DISCORD_TOKEN" : "BOT_TOKEN",
    tokenTail: `***redacted***${String(token).slice(-4)}`,
  });

  // Wire v1 (slash + guards, etc.)
  if (typeof wire === "function") {
    await wire(client);
  }

  // 🔹 Always wire Webhook Guard **v2** (independent of v1), with resilient import resolution
  try {
    const v2m = await import("../../utils/webhook-guard-v2.js");
    const v2wire =
      v2m.wireWebhookGuardV2 ||
      v2m.wire ||
      (v2m.default?.wireWebhookGuardV2) ||
      (v2m.default?.wire) ||
      v2m.default;
    if (typeof v2wire === "function") {
      await v2wire(client);
    } else {
      console.warn(JSON.stringify({
        name: "webhook.v2",
        msg: "v2 module loaded but no callable wire() found",
        keys: Object.keys(v2m || {})
      }));
    }
  } catch (err) {
    console.warn(JSON.stringify({
      name: "webhook.v2",
      msg: "v2 import failed",
      err: String(err?.message || err)
    }));
  }

  await client.login(token);
  jlog("info", "discord.run", "login() resolved");
})();
