// src/discord/addons/massguard-controls.v1.js
// Slash: /massguard status | enable | disable | cooldown <minutes>
// Writes to data/feature-flags.json and replies ephemerally.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MessageFlags, PermissionFlagsBits } from "discord.js";

/* ---------------- helpers ---------------- */
function stripBOM(s) { return typeof s === "string" ? s.replace(/^\uFEFF/, "") : s; }

async function readJSONSafe(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(stripBOM(raw));
  } catch {
    return {};
  }
}

async function ensureDirExists(dir) {
  try { await fs.mkdir(dir, { recursive: true }); } catch {}
}

async function safeWriteJSON(file, obj) {
  // Atomic-ish write: write temp, then rename.
  const dir = path.dirname(file);
  await ensureDirExists(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${Date.now()}.tmp`);
  const json = JSON.stringify(obj, null, 2);
  await fs.writeFile(tmp, json, "utf8");
  await fs.rename(tmp, file);
}

function normInt(n, fallback) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : fallback;
}

/* ---------------- main ---------------- */
export default async function wireMassGuardControlsV1(client) {
  const ffPath = path.join(process.cwd(), "data", "feature-flags.json");

  // Register slash on ready (guild-scoped, like the rest of your commands)
  client.once?.("ready", async () => {
    try {
      const app = client.application;
      if (!app) return;

      const def = {
        name: "massguard",
        description: "Control MassGuard enforcement and cooldown (ephemeral)",
        dm_permission: false,
        options: [
          { type: 1, name: "status", description: "Show current MassGuard settings" },
          { type: 1, name: "enable", description: "Enable MassGuard enforcement" },
          { type: 1, name: "disable", description: "Disable MassGuard enforcement" },
          {
            type: 1,
            name: "cooldown",
            description: "Set MassGuard cooldown minutes (enables cooldown)",
            options: [
              {
                type: 4, // INTEGER
                name: "minutes",
                description: "Cooldown in minutes (1-1440)",
                required: true,
                min_value: 1,
                max_value: 1440
              }
            ]
          }
        ]
      };

      for (const [guildId] of client.guilds.cache) {
        try {
          await app.commands.create(def, guildId);
          console.info(JSON.stringify({ name: "discord.wire", msg: "slash upsert", guildId, command: "massguard" }));
        } catch (err) {
          console.warn(JSON.stringify({ name: "discord.wire", msg: "slash register failed", guildId, command: "massguard", err: String(err?.message || err) }));
        }
      }
    } catch {}
  });

  // Handle the interactions
  client.on("interactionCreate", async (i) => {
    try {
      if (!i.isChatInputCommand()) return;
      if (i.commandName !== "massguard") return;

      // Permission gate
      const member = i.member;
      const canManage =
        member?.permissions?.has?.(PermissionFlagsBits.ManageGuild) ||
        member?.permissions?.has?.(PermissionFlagsBits.Administrator);
      if (!canManage) {
        await i.reply({ content: "You need **Manage Server** (or **Administrator**) to use this.", flags: MessageFlags.Ephemeral });
        return;
      }

      const sub = i.options.getSubcommand();
      const ff = await readJSONSafe(ffPath);

      // Normalize existing structure
      ff.enforce = ff.enforce || {};
      if (!Object.prototype.hasOwnProperty.call(ff, "enforceCooldownEnabled")) ff.enforceCooldownEnabled = true;
      if (!Object.prototype.hasOwnProperty.call(ff, "enforceCooldownMinutes")) ff.enforceCooldownMinutes = 5;

      const snapshotBefore = {
        enforce: {
          massGuard: !!ff.enforce.massGuard
        },
        enforceCooldownEnabled: !!ff.enforceCooldownEnabled,
        enforceCooldownMinutes: normInt(ff.enforceCooldownMinutes, 5)
      };

      if (sub === "status") {
        const payload = {
          host: os.hostname(),
          guildId: i.guildId,
          user: i.user?.tag,
          now: new Date().toISOString(),
          settings: snapshotBefore
        };
        await i.reply({ content: "```json\n" + JSON.stringify(payload, null, 2).slice(0, 1900) + "\n```", flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === "enable") {
        ff.enforce.massGuard = true;
        await safeWriteJSON(ffPath, ff);
        const payload = { ok: true, action: "enable", settings: { ...snapshotBefore, enforce: { massGuard: true } } };
        // Emit a soft signal in case you want to listen elsewhere
        client.emit?.("config:featureFlagsUpdated", { path: ffPath, key: "enforce.massGuard", value: true });
        await i.reply({ content: "```json\n" + JSON.stringify(payload, null, 2).slice(0, 1900) + "\n```", flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === "disable") {
        ff.enforce.massGuard = false;
        await safeWriteJSON(ffPath, ff);
        const payload = { ok: true, action: "disable", settings: { ...snapshotBefore, enforce: { massGuard: false } } };
        client.emit?.("config:featureFlagsUpdated", { path: ffPath, key: "enforce.massGuard", value: false });
        await i.reply({ content: "```json\n" + JSON.stringify(payload, null, 2).slice(0, 1900) + "\n```", flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === "cooldown") {
        const minutesRaw = i.options.getInteger("minutes", true);
        const minutes = Math.min(1440, Math.max(1, normInt(minutesRaw, 5)));
        ff.enforceCooldownEnabled = true;
        ff.enforceCooldownMinutes = minutes;
        await safeWriteJSON(ffPath, ff);
        const payload = {
          ok: true,
          action: "cooldown",
          set: { enforceCooldownEnabled: true, enforceCooldownMinutes: minutes }
        };
        client.emit?.("config:featureFlagsUpdated", { path: ffPath, key: "enforceCooldown", value: { enabled: true, minutes } });
        await i.reply({ content: "```json\n" + JSON.stringify(payload, null, 2).slice(0, 1900) + "\n```", flags: MessageFlags.Ephemeral });
        return;
      }

      await i.reply({ content: "Unknown subcommand.", flags: MessageFlags.Ephemeral });
    } catch (err) {
      try {
        await i.reply({ content: "Command failed. Check logs.", flags: MessageFlags.Ephemeral });
      } catch {}
      console.warn("[massguard] interaction error:", err);
    }
  });
}
