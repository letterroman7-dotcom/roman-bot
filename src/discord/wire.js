// src/discord/wire.js
// Registers /diag, /ping, /uptime, /ids per joined guild (guild-scoped).
// Replies are privacy-safe and ephemeral via MessageFlags.Ephemeral.
// Feature flags in data/feature-flags.json:
//   {
//     "slashDiag": true,
//     "slashPing": true,
//     "slashUptime": true,
//     "slashIds": true,
//     "pingThresholds": { "wsWarn":150, "wsCrit":300, "apiWarn":500, "apiCrit":1000 }
//   }

import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { MessageFlags } from "discord.js";

/* ---------- utils ---------- */

function stripBOM(s) { return typeof s === "string" ? s.replace(/^\uFEFF/, "") : s; }
/** Safe JSON read; returns {} on any error. */
async function readJSONSafe(file) { try { return JSON.parse(stripBOM(await fs.readFile(file, "utf8"))); } catch { return {}; } }
function normBool(v, fallback = true) { if (typeof v === "boolean") return v; if (typeof v === "string") return v.toLowerCase() === "true"; return fallback; }
async function installedVersion(pkgName) {
  try { const meta = JSON.parse(await fs.readFile(path.join(process.cwd(), "node_modules", pkgName, "package.json"), "utf8")); return meta.version || ""; }
  catch { return ""; }
}
function redact(tok) { if (!tok) return undefined; const s = String(tok); return `***redacted***${s.slice(-4)}`; }
function formatUptime(ms) {
  const total = Math.floor(ms / 1000);
  const s = total % 60, m = Math.floor(total / 60) % 60, h = Math.floor(total / 3600) % 24, d = Math.floor(total / 86400);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
}
function memSnapshot() {
  const mu = process.memoryUsage();
  const mb = (n) => Math.round((n / (1024 * 1024)) * 10) / 10;
  return { rssMB: mb(mu.rss), heapUsedMB: mb(mu.heapUsed), heapTotalMB: mb(mu.heapTotal) };
}
function evalStatus(wsMs, apiMs, th) {
  const ws = wsMs ?? 0, api = apiMs ?? 0;
  let status = "ok";
  if (ws >= th.wsCrit || api >= th.apiCrit) status = "crit";
  else if (ws >= th.wsWarn || api >= th.apiWarn) status = "warn";
  return status;
}

/* ---------- main wiring ---------- */

export async function wire(client) {
  // --- Interaction handler for /diag, /ping, /uptime, /ids (all ephemeral) ---
  client.on("interactionCreate", async (i) => {
    try {
      if (!i.isChatInputCommand()) return;

      // Load flags once per interaction
      const features = await readJSONSafe(path.join(process.cwd(), "data", "feature-flags.json"));
      const allowDiag   = normBool(features.slashDiag, true);
      const allowPing   = normBool(features.slashPing, true);
      const allowUptime = normBool(features.slashUptime, true);
      const allowIds    = normBool(features.slashIds, true);
      const th = Object.assign({ wsWarn:150, wsCrit:300, apiWarn:500, apiCrit:1000 }, features.pingThresholds || {});

      if (i.commandName === "diag") {
        if (!allowDiag) return;
        const pkg = await readJSONSafe(path.join(process.cwd(), "package.json"));
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        const versionsDeclared = { "discord.js": deps["discord.js"] || "", "pino": deps["pino"] || "" };
        const versionsInstalled = { "discord.js": await installedVersion("discord.js"), "pino": await installedVersion("pino") };
        const info = {
          node: process.version,
          versionsDeclared,
          versionsInstalled,
          flags: { startupSummary: !!features.startupSummary, slashDiag: allowDiag, slashPing: allowPing, slashUptime: allowUptime, slashIds: allowIds },
          env: { DISCORD_TOKEN: redact(process.env.DISCORD_TOKEN || process.env.BOT_TOKEN) },
        };
        const payload = "```json\n" + JSON.stringify(info, null, 2).slice(0, 1900) + "\n```";
        await i.reply({ content: payload, flags: MessageFlags.Ephemeral });
        return;
      }

      if (i.commandName === "ping") {
        if (!allowPing) return;
        const t0 = Date.now();
        await i.deferReply({ flags: MessageFlags.Ephemeral });   // (was: ephemeral: true)
        const apiLatency = Date.now() - t0;
        const wsLatency = Math.max(0, Math.round(client.ws.ping || 0));
        const upMs = process.uptime() * 1000;
        const info = {
          status: evalStatus(wsLatency, apiLatency, th),
          wsMs: wsLatency,
          apiMs: apiLatency,
          thresholds: th,
          timestamp: new Date().toISOString(),
          host: os.hostname(),
          pid: process.pid,
          uptime: formatUptime(upMs),
          mem: memSnapshot()
        };
        console.log(`[ping] status=${info.status} ws=${info.wsMs}ms api=${info.apiMs}ms up=${info.uptime} mem(rssMB)=${info.mem.rssMB}`);
        await i.editReply({ content: "```json\n" + JSON.stringify(info, null, 2).slice(0, 1900) + "\n```" });
        return;
      }

      if (i.commandName === "uptime") {
        if (!allowUptime) return;
        const upMs = Math.floor(process.uptime() * 1000);
        const startedAt = new Date(Date.now() - upMs).toISOString();
        const info = {
          startedAt,
          uptime: formatUptime(upMs),
          guilds: client.guilds.cache.size,
          user: client.user?.tag,
          pid: process.pid,
          host: os.hostname()
        };
        await i.reply({ content: "```json\n" + JSON.stringify(info, null, 2) + "\n```", flags: MessageFlags.Ephemeral });
        return;
      }

      if (i.commandName === "ids") {
        if (!allowIds) return;
        const isDM = !i.inGuild();
        const info = {
          isDM,
          guildId: i.guildId || null,
          guildName: i.guild?.name || null,
          channelId: i.channelId || null,
          userId: i.user?.id || null,
          user: i.user?.tag || null
        };
        await i.reply({ content: "```json\n" + JSON.stringify(info, null, 2) + "\n```", flags: MessageFlags.Ephemeral });
        return;
      }
    } catch {
      try { await i.reply({ content: "Command failed. Check logs.", flags: MessageFlags.Ephemeral }); } catch {}
    }
  });

  // --- Register commands per guild on clientReady (fast propagation) ---
  client.once("clientReady", async () => {
    try {
      const app = client.application;
      if (!app) return;

      const features = await readJSONSafe(path.join(process.cwd(), "data", "feature-flags.json"));
      const wantDiag   = normBool(features.slashDiag, true);
      const wantPing   = normBool(features.slashPing, true);
      const wantUptime = normBool(features.slashUptime, true);
      const wantIds    = normBool(features.slashIds, true);

      const defs = [];
      if (wantDiag)   defs.push({ name: "diag",   description: "Show bot diagnostics (ephemeral)",              dm_permission: false });
      if (wantPing)   defs.push({ name: "ping",   description: "Bot latency + uptime + memory (ephemeral)",    dm_permission: false });
      if (wantUptime) defs.push({ name: "uptime", description: "Show bot start time and uptime (ephemeral)",   dm_permission: false });
      if (wantIds)    defs.push({ name: "ids",    description: "Show guild/channel/user IDs (ephemeral)",      dm_permission: false });
      if (defs.length === 0) return;

      for (const [guildId] of client.guilds.cache) {
        for (const def of defs) {
          try { await app.commands.create(def, guildId); } catch { /* ignore dup/perm errors */ }
        }
      }
    } catch {
      // ignore registration errors; commands just won't appear
    }
  });
}

export default { wire };
