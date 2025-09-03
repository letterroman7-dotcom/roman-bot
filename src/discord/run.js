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
    GatewayIntentBits.GuildModeration,         // ban add events (v14 alias for GuildBans)
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

// ───────────────────────────────────────────────────────────────────────────────
// v2 webhook guard wiring (safe & optional):
// - Tries root-level locations first:  ../../utils, ../../events
// - Falls back to src/* locations if present (none in your repo right now)
// - If anything is missing or disabled, logs and keeps v1-only behavior.
// ───────────────────────────────────────────────────────────────────────────────
async function tryImport(candidates) {
  for (const rel of candidates) {
    try {
      // Resolve relative to this file
      const mod = await import(new URL(rel, import.meta.url));
      return { mod, rel };
    } catch { /* try next */ }
  }
  return null;
}

async function wireWebhookGuardV2Safe(cli) {
  // Load config helper
  const utilsHit = await tryImport([
    "../../utils/webhook-guard-v2.js",
    "../utils/webhook-guard-v2.js",
  ]);
  if (!utilsHit) {
    jlog("info", "webhook.v2", "utils module not found; skipping v2 (v1 stays active)");
    return;
  }

  const { loadConfig: loadWebhookV2Config } = utilsHit.mod;
  let cfg;
  try {
    cfg = loadWebhookV2Config();
  } catch (err) {
    jlog("warn", "webhook.v2", "failed to load v2 config; skipping", { err: String(err?.message || err) });
    return;
  }
  if (!cfg?.enabled) {
    jlog("info", "webhook.v2", "v2 guard disabled (config)");
    return;
  }

  // Load handlers
  const createHit = await tryImport([
    "../../events/webhookCreate.guard.v2.js",
    "../events/webhookCreate.guard.v2.js",
  ]);
  const updateHit = await tryImport([
    "../../events/webhookUpdate.guard.v2.js",
    "../events/webhookUpdate.guard.v2.js",
  ]);
  const deleteHit = await tryImport([
    "../../events/webhookDelete.guard.v2.js",
    "../events/webhookDelete.guard.v2.js",
  ]);

  if (!createHit || !updateHit || !deleteHit) {
    jlog("warn", "webhook.v2", "v2 handlers not fully present; skipping v2 wiring (v1 stays active)", {
      haveCreate: !!createHit, haveUpdate: !!updateHit, haveDelete: !!deleteHit
    });
    return;
  }

  const onWebhookCreateV2 = createHit.mod.default;
  const onWebhookUpdateV2 = updateHit.mod.default;
  const onWebhookDeleteV2 = deleteHit.mod.default;

  try {
    cli.on("webhookCreate", onWebhookCreateV2);
    cli.on("webhookUpdate", onWebhookUpdateV2);
    cli.on("webhookDelete", onWebhookDeleteV2);
    jlog("info", "webhook.v2", "v2 guard wired", {
      mode: cfg.mode,
      autoDeleteRogueWebhooks: !!cfg.autoDeleteRogueWebhooks,
      punishExecutor: !!cfg.punishExecutor,
      punishAction: cfg.punishAction,
      utilsPathTried: utilsHit.rel,
    });
  } catch (err) {
    jlog("warn", "webhook.v2", "failed to attach v2 handlers; continuing with v1 only", {
      err: String(err?.message || err),
    });
  }
}

(async () => {
  jlog("info", "discord.run", "starting discord client", {
    node: process.version,
    host: os.hostname(),
    pid: process.pid,
    tokenSource: ".env",
    tokenKeyPath: process.env.DISCORD_TOKEN ? "DISCORD_TOKEN" : "BOT_TOKEN",
    tokenTail: `***redacted***${String(token).slice(-4)}`,
  });

  if (typeof wire === "function") {
    await wire(client); // your existing wiring (v1 guards, modules, etc.)
  }

  // Wire v2 only if present & enabled; otherwise no-op
  await wireWebhookGuardV2Safe(client);

  await client.login(token);
  jlog("info", "discord.run", "login() resolved");
})();
