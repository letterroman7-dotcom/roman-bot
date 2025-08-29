// src/discord/run.js
import "dotenv/config";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { Client, GatewayIntentBits, Partials, ActivityType } from "discord.js";
import createLogger from "../../utils/pino-factory.js";

const log = createLogger("discord.run");

/* ---------- helpers ---------- */
function stripBOM(s) { return typeof s === "string" ? s.replace(/^\uFEFF/, "") : s; }
async function readJSONSafe(file) {
  try { return JSON.parse(stripBOM(await fs.readFile(file, "utf8"))); } catch { return {}; }
}

/** Optional import helper (ESM, file URL safe). */
async function tryImport(specOrUrl) {
  try {
    const mod = await import(specOrUrl instanceof URL ? specOrUrl.href : specOrUrl);
    return mod?.default ?? mod;
  } catch (err) {
    const msg = String(err?.message || err || "");
    if (msg.includes("Cannot find module") || err?.code === "ERR_MODULE_NOT_FOUND") {
      log.warn({ spec: String(specOrUrl) }, "optional module not found; continuing");
      return null;
    }
    log.warn({ err, spec: String(specOrUrl) }, "optional module failed to import; continuing");
    return null;
  }
}

/* ---------- Startup Anti-Nuke summary (inline) ---------- */

const ANTINUKE_FILE = path.join(process.cwd(), "data", "antinuke-config.json");

async function loadAntiNukeConfig() {
  try {
    const raw = await fs.readFile(ANTINUKE_FILE, "utf8");
    return JSON.parse(stripBOM(raw));
  } catch {
    return null; // missing or invalid file is fine
  }
}

function mergeAntiNukeConfig(cfg, guildId) {
  const defaults = (cfg && cfg.defaults) || {};
  const guilds = (cfg && cfg.guilds) || {};
  const override = guilds[guildId] || {};
  return {
    threshold: (override.threshold ?? defaults.threshold ?? 1),
    weights: { ...(defaults.weights || {}), ...(override.weights || {}) },
  };
}

async function printAntiNukeSummary(client) {
  const cfg = await loadAntiNukeConfig();
  const guilds = client?.guilds?.cache ?? new Map();

  console.log(`[startup] Anti-Nuke summary for ${guilds.size} guild(s):`);
  for (const [, g] of guilds) {
    const merged = mergeAntiNukeConfig(cfg, g?.id);
    const weights = Object.entries(merged.weights || {})
      .map(([k, v]) => `${k}:${v}`)
      .join(", ") || "(none)";
    console.log(`[startup][anti-nuke] "${g?.name ?? "Unknown"}" threshold=${merged.threshold} weights={ ${weights} }`);
  }
}

/* ------------------------------------------------------------------------ */

export async function startDiscord() {
  const TOKEN = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
  if (!TOKEN) {
    log.error("Missing DISCORD_TOKEN (or BOT_TOKEN). Bot will not start.");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildBans,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildEmojisAndStickers,
      GatewayIntentBits.GuildWebhooks,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.GuildMember, Partials.Message, Partials.Channel, Partials.Reaction],
  });

  // Optional wiring (won't crash if files are missing)
  const wireSecurity = await tryImport(new URL("./wire-security.js", import.meta.url));
  if (wireSecurity) {
    try {
      const fn = wireSecurity.wireSecurity ?? wireSecurity.execute ?? wireSecurity;
      if (typeof fn === "function") await fn(client);
    } catch (err) {
      log.warn({ err }, "wireSecurity failed");
    }
  }

  const wire = await tryImport(new URL("./wire.js", import.meta.url));
  if (wire) {
    try {
      const fn = wire.wire ?? wire.execute ?? wire;
      if (typeof fn === "function") await fn(client);
    } catch (err) {
      log.warn({ err }, "wire (commands) failed");
    }
  }

  // Use clientReady (v14 emits it; v15 will require it)
  client.once("clientReady", async () => {
    log.info({ user: client.user?.tag, id: client.user?.id }, "Discord client ready");
    try {
      client.user?.setPresence({
        activities: [{ name: "Keeping your server safe", type: ActivityType.Watching }],
        status: "online",
      });
    } catch {}

    // Respect feature flag for startup summary (default ON unless explicitly false)
    try {
      const features = await readJSONSafe(path.join(process.cwd(), "data", "feature-flags.json"));
      const startupOn = features.startupSummary !== false;
      if (startupOn) await printAntiNukeSummary(client);
    } catch (err) {
      log.warn({ err }, "Anti-Nuke startup summary failed");
    }
  });

  await client.login(TOKEN);
}

/* --- correct “main module” check for Windows paths with spaces --- */
try {
  const isEntry =
    typeof process.argv[1] === "string" &&
    import.meta.url === pathToFileURL(process.argv[1]).href;

  if (isEntry) {
    startDiscord();
  }
} catch {
  // Safer default for CLI usage
  startDiscord();
}
