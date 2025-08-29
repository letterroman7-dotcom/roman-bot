// src/discord/wire.js
// Registers a /diag slash command per joined guild (guild-scoped, fast)
// and replies with a privacy-safe, ephemeral diagnostics JSON.
// Controlled by data/feature-flags.json -> { "slashDiag": true/false } (default: true)

import path from "node:path";
import fs from "node:fs/promises";

/* ---------- utils ---------- */

function stripBOM(s) {
  return typeof s === "string" ? s.replace(/^\uFEFF/, "") : s;
}

/** Safe JSON read that tolerates BOM; returns {} on any error. */
async function readJSONSafe(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(stripBOM(raw));
  } catch {
    return {};
  }
}

function normBool(v, fallback = true) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "true";
  return fallback;
}

async function installedVersion(pkgName) {
  try {
    const meta = JSON.parse(
      await fs.readFile(path.join(process.cwd(), "node_modules", pkgName, "package.json"), "utf8")
    );
    return meta.version || "";
  } catch {
    return "";
  }
}

function redact(tok) {
  if (!tok) return undefined;
  const s = String(tok);
  return `***redacted***${s.slice(-4)}`;
}

/* ---------- main wiring ---------- */

export async function wire(client) {
  // --- Interaction handler for /diag (ephemeral) ---
  client.on("interactionCreate", async (i) => {
    try {
      if (!i.isChatInputCommand()) return;
      if (i.commandName !== "diag") return;

      // Read package.json robustly (BOM-safe)
      const pkg = await readJSONSafe(path.join(process.cwd(), "package.json"));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

      const versionsDeclared = {
        "discord.js": deps["discord.js"] || "",
        "pino": deps["pino"] || "",
      };
      const versionsInstalled = {
        "discord.js": await installedVersion("discord.js"),
        "pino": await installedVersion("pino"),
      };

      const features = await readJSONSafe(path.join(process.cwd(), "data", "feature-flags.json"));
      const info = {
        node: process.version,
        versionsDeclared,
        versionsInstalled,
        flags: {
          startupSummary: !!features.startupSummary,
          slashDiag: normBool(features.slashDiag, true),
        },
        env: {
          DISCORD_TOKEN: redact(process.env.DISCORD_TOKEN || process.env.BOT_TOKEN),
        },
      };

      const payload = "```json\n" + JSON.stringify(info, null, 2).slice(0, 1900) + "\n```";
      await i.reply({ content: payload, ephemeral: true });
    } catch {
      try { await i.reply({ content: "Diag failed. Check logs.", ephemeral: true }); } catch {}
    }
  });

  // --- Register /diag per guild on clientReady (fast propagation) ---
  client.once("clientReady", async () => {
    try {
      const app = client.application;
      if (!app) return;

      const features = await readJSONSafe(path.join(process.cwd(), "data", "feature-flags.json"));
      const enable = normBool(features.slashDiag, true); // default ON
      if (!enable) return;

      const cmd = {
        name: "diag",
        description: "Show bot diagnostics (ephemeral)",
        dm_permission: false,
      };

      for (const [guildId] of client.guilds.cache) {
        try {
          await app.commands.create(cmd, guildId); // guild-scoped for instant availability
        } catch {
          // ignore per-guild failures (missing perms, etc.)
        }
      }
    } catch {
      // ignore registration errors; command just won't appear
    }
  });
}

export default { wire };
