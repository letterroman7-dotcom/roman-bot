// src/discord/wire.js
// Registers: /diag /ping /uptime /ids /features /restorepreview /snapdiff (guild-scoped).
// Replies are privacy-safe and ephemeral via MessageFlags.Ephemeral.
// Adds: /wh (webhook test helper) gated by feature flag "slashWebhookTest": true.
// NEW: /setlog and /logtest for moderation log channel.
// NEW: wires perf add-on (once) with /perf stats|json.
// NEW: /help (lists enabled commands based on feature flags; ephemeral)
// NEW: /webhookv2 (status; ephemeral, only if utils/webhook-guard-v2.js exists)
// NEW: /permcheck (ephemeral) — report effective perms for enforcement in this channel

import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { MessageFlags } from "discord.js";
import { getChannelSnapshot, getRoleSnapshot, snapshotCounts } from "../../utils/snapshot-store.js";
import { formatChannelSnapshot, formatRoleSnapshot } from "../../utils/snapshot-format.js";
import { diffChannel, diffRole, summarizeDiff } from "../../utils/snapshot-diff.js";

// 🔹 Add-ons (Join-Gate, Restore-Apply, Raid-Correlation, Plan, Anti-Nuke, Perf)
import {
  wireJoinGateV1,
  wireRestoreApplyV1,
  wireRaidCorrelationV1,
  wirePlanV1,
  wireAntiNukeV1,
  wirePerfV1,          // ✅ added
} from "./addons/index.js";

// ❗ Lazy-import log-config so a missing helper never breaks startup
let __logCfgCached = null;
async function getLogCfg() {
  if (__logCfgCached) return __logCfgCached;
  try {
    __logCfgCached = await import("../../utils/log-config.js");
  } catch (err) {
    console.warn(JSON.stringify({
      name: "discord.wire",
      msg: "log-config helper missing; /setlog and /logtest disabled",
      err: String(err?.message || err)
    }));
    __logCfgCached = {
      __missing: true,
      getGuildMainLogChannelId: async () => null,
      setGuildMainLogChannelId: async () => false,
    };
  }
  return __logCfgCached;
}

/* ---------- helpers ---------- */
function stripBOM(s) { return typeof s === "string" ? s.replace(/^\uFEFF/, "") : s; }
async function readJSONSafe(file) { try { return JSON.parse(stripBOM(await fs.readFile(file, "utf8"))); } catch { return {}; } }
function normBool(v, fb = true) { if (typeof v === "boolean") return v; if (typeof v === "string") return v.toLowerCase() === "true"; return fb; }
async function installedVersion(pkgName) { try { const meta = JSON.parse(await fs.readFile(path.join(process.cwd(), "node_modules", pkgName, "package.json"), "utf8")); return meta.version || ""; } catch { return ""; } }
function redact(tok) { if (!tok) return undefined; const s = String(tok); return `***redacted***${s.slice(-4)}`; }
function formatUptime(ms) { const t=Math.floor(ms/1000),s=t%60,m=Math.floor(t/60)%60,h=Math.floor(t/3600)%24,d=Math.floor(ms/86400000);const pad=n=>String(n).padStart(2,"0");return `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`; }
function memSnapshot(){const mu=process.memoryUsage();const mb=n=>Math.round((n/(1024*1024))*10)/10;return{rssMB:mb(mu.rss),heapUsedMB:mb(mu.heapUsed),heapTotalMB:mb(mu.heapTotal)}}
function evalStatus(ws,api,th){let st="ok";if(ws>=th.wsCrit||api>=th.apiCrit)st="crit";else if(ws>=th.wsWarn||api>=th.apiWarn)st="warn";return st}
function isTextLike(ch){ return ch?.type === 0 || ch?.type === 5; } // guild text or announcement

// 🔹 Guarded dynamic import helper (relative to THIS file)
async function tryImport(relCandidates) {
  for (const rel of relCandidates) {
    try {
      const mod = await import(new URL(rel, import.meta.url));
      return { mod, rel };
    } catch {}
  }
  return null;
}

/* ---------- main wiring ---------- */
export async function wire(client) {
  // Relax EventEmitter listener cap to avoid MaxListeners warnings across add-ons
  client.setMaxListeners?.(50);

  // 🔹 Add-ons first so they can register slash commands and listeners on ready
  try { await wireJoinGateV1(client); } catch {}
  try { await wireRestoreApplyV1(client); } catch {}
  try { await wireRaidCorrelationV1(client); } catch {}
  try { await wirePlanV1(client); } catch {}
  try { await wireAntiNukeV1(client); } catch {}
  try { await wirePerfV1(client); } catch {}       // ✅ added (single call)

  // 🔹 Webhook guards (dynamic import so boot never dies if optional)
  try {
    console.info(JSON.stringify({ name: "discord.wire", msg: "webhook-guards import start" }));
    const { default: wireWebhookGuardsV1 } = await import("./addons/webhook-guards.v1.js");
    await wireWebhookGuardsV1(client);
    console.info(JSON.stringify({ name: "discord.wire", msg: "webhook-guards import ok (wired)" }));
  } catch (err) {
    console.warn(JSON.stringify({ name: "discord.wire", msg: "webhook-guards import skipped", err: String(err?.message || err) }));
  }

  client.on("interactionCreate", async (i) => {
    try {
      if (!i.isChatInputCommand()) return;

      const features = await readJSONSafe(path.join(process.cwd(), "data", "feature-flags.json"));
      const allowDiag     = normBool(features.slashDiag, true);
      const allowPing     = normBool(features.slashPing, true);
      const allowUptime   = normBool(features.slashUptime, true);
      const allowIds      = normBool(features.slashIds, true);
      const allowFeatures = normBool(features.slashFeatures, true);
      const allowRestore  = normBool(features.slashRestorePreview, true);
      const allowSnapdiff = normBool(features.slashSnapdiff, true);
      const allowWh       = normBool(features.slashWebhookTest, false);
      // NEW flags
      const allowSetlog   = normBool(features.slashSetlog, true);
      const allowLogtest  = normBool(features.slashLogtest, true);
      const allowHelp     = normBool(features.slashHelp, true);               // NEW
      const allowWebhookV2= normBool(features.slashWebhookV2Status, true);    // NEW
      const allowPermcheck= normBool(features.slashPermcheck, true);          // NEW

      const th = Object.assign({ wsWarn:150, wsCrit:300, apiWarn:500, apiCrit:1000 }, features.pingThresholds || {});

      if (i.commandName === "diag" && allowDiag) {
        const pkg = await readJSONSafe(path.join(process.cwd(), "package.json"));
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        const versionsDeclared   = { "discord.js": deps["discord.js"] || "", "pino": deps["pino"] || "" };
        const versionsInstalled  = { "discord.js": await installedVersion("discord.js"), "pino": await installedVersion("pino") };
        const info = {
          node: process.version, versionsDeclared, versionsInstalled,
          flags: {
            startupSummary: !!features.startupSummary,
            slashDiag: allowDiag, slashPing: allowPing, slashUptime: allowUptime, slashIds: allowIds,
            slashFeatures: allowFeatures, slashRestorePreview: allowRestore, slashSnapdiff: allowSnapdiff, slashWebhookTest: allowWh,
            slashSetlog: allowSetlog, slashLogtest: allowLogtest, slashHelp: allowHelp, slashWebhookV2Status: allowWebhookV2, slashPermcheck: allowPermcheck
          },
          env: { DISCORD_TOKEN: redact(process.env.DISCORD_TOKEN || process.env.BOT_TOKEN) }
        };
        await i.reply({ content: "```json\n" + JSON.stringify(info, null, 2).slice(0,1900) + "\n```", flags: MessageFlags.Ephemeral });
        return;
      }

      if (i.commandName === "ping" && allowPing) {
        const t0 = Date.now(); await i.deferReply({ flags: MessageFlags.Ephemeral });
        const apiLatency = Date.now() - t0; const wsLatency = Math.max(0, Math.round(client.ws.ping || 0));
        const upMs = process.uptime() * 1000;
        const info = { status: evalStatus(wsLatency, apiLatency, th), wsMs: wsLatency, apiMs: apiLatency, thresholds: th, timestamp: new Date().toISOString(), host: os.hostname(), pid: process.pid, uptime: formatUptime(upMs), mem: memSnapshot() };
        console.log(`[ping] status=${info.status} ws=${info.wsMs}ms api=${info.apiMs}ms up=${info.uptime} mem(rssMB)=${info.mem.rssMB}`);
        await i.editReply({ content: "```json\n" + JSON.stringify(info, null, 2).slice(0,1900) + "\n```" });
        return;
      }

      if (i.commandName === "uptime" && allowUptime) {
        const upMs = Math.floor(process.uptime()*1000);
        const startedAt = new Date(Date.now()-upMs).toISOString();
        await i.reply({ content: "```json\n" + JSON.stringify({ startedAt, uptime: formatUptime(upMs), guilds: client.guilds.cache.size, user: client.user?.tag, pid: process.pid, host: os.hostname() }, null, 2) + "\n```", flags: MessageFlags.Ephemeral });
        return;
      }

      if (i.commandName === "ids" && allowIds) {
        const isDM = !i.inGuild();
        await i.reply({ content: "```json\n" + JSON.stringify({ isDM, guildId: i.guildId || null, guildName: i.guild?.name || null, channelId: i.channelId || null, userId: i.user?.id || null, user: i.user?.tag || null }, null, 2) + "\n```", flags: MessageFlags.Ephemeral });
        return;
      }

      if (i.commandName === "features" && allowFeatures) {
        const ff = await readJSONSafe(path.join(process.cwd(), "data", "feature-flags.json"));
        const limiter = await readJSONSafe(path.join(process.cwd(), "data", "antinuke-limiter.json"));

        const enforcing = !!(ff?.enforce?.massGuard === true);
        const summary = {
          enforce: {
            massGuard: enforcing,
            cooldownEnabled: ff?.enforceCooldownEnabled !== false,
            cooldownMinutes: Number.isFinite(Number(ff?.enforceCooldownMinutes)) ? Number(ff.enforceCooldownMinutes) : 5
          },
          securityLogToChannel: ff.securityLogToChannel !== false,
          pingThresholds: Object.assign({ wsWarn:150, wsCrit:300, apiWarn:500, apiCrit:1000 }, ff.pingThresholds || {}),
          startupSummary: !!ff.startupSummary,
          slash: {
            diag: allowDiag, ping: allowPing, uptime: allowUptime, ids: allowIds, features: allowFeatures,
            restorepreview: allowRestore, snapdiff: allowSnapdiff, webhookTest: allowWh,
            setlog: allowSetlog, logtest: allowLogtest, help: allowHelp, webhookV2Status: allowWebhookV2, permcheck: allowPermcheck
          },
          antiNuke: {
            enabled: !!limiter.enabled,
            windowMs: Number.isFinite(Number(limiter.windowMs)) ? Number(limiter.windowMs) : 30000,
            threshold: Number.isFinite(Number(limiter.threshold)) ? Number(limiter.threshold) : 3,
            enforce: {
              enabled: !!(limiter?.enforce?.enabled),
              softLockMinutes: Number.isFinite(Number(limiter?.enforce?.softLockMinutes)) ? Number(limiter.enforce.softLockMinutes) : 15
            },
            respectExemptions: limiter?.respectExemptions !== false,
            weights: limiter?.weights || {}
          }
        };
        await i.reply({ content: "```json\n" + JSON.stringify(summary, null, 2).slice(0,1900) + "\n```", flags: MessageFlags.Ephemeral });
        return;
      }

      // NEW: /help — list available commands based on feature flags (ephemeral)
      if (i.commandName === "help" && allowHelp) {
        const list = [];
        if (allowDiag) list.push("/diag – diagnostics (ephemeral)");
        if (allowPing) list.push("/ping – latency & uptime (ephemeral)");
        if (allowUptime) list.push("/uptime – start time & uptime (ephemeral)");
        if (allowIds) list.push("/ids – guild/channel/user IDs (ephemeral)");
        if (allowFeatures) list.push("/features – feature flags summary (ephemeral)");
        if (allowRestore) list.push("/restorepreview – show cached snapshot or counts");
        if (allowSnapdiff) list.push("/snapdiff – diff live channel/role vs snapshot");
        if (allowWh) list.push("/wh – webhook helper (create/update/delete)");
        if (allowSetlog) list.push("/setlog – set moderation log channel");
        if (allowLogtest) list.push("/logtest – send a test message to the log channel");
        if (allowWebhookV2) list.push("/webhookv2 – show Webhook Guard v2 status");
        if (allowPermcheck) list.push("/permcheck – show enforcement perms in this channel");
        const payload = { commands: list };
        await i.reply({ content: "```json\n" + JSON.stringify(payload, null, 2).slice(0,1900) + "\n```", flags: MessageFlags.Ephemeral });
        return;
      }

      // NEW: /webhookv2 — status (ephemeral; safe if loader/file missing)
      if (i.commandName === "webhookv2" && allowWebhookV2) {
        const utilsHit = await tryImport([
          "../../utils/webhook-guard-v2.js",
          "../utils/webhook-guard-v2.js"
        ]);
        if (!utilsHit) {
          await i.reply({ content: "Webhook Guard v2 not available on this build.", flags: MessageFlags.Ephemeral });
          return;
        }
        let cfg = {};
        try {
          const { loadConfig } = utilsHit.mod;
          cfg = loadConfig();
        } catch {
          await i.reply({ content: "Failed to read v2 config.", flags: MessageFlags.Ephemeral });
          return;
        }
        const summary = {
          available: true,
          enabled: !!cfg.enabled,
          mode: cfg.mode || null,
          autoDeleteRogueWebhooks: !!cfg.autoDeleteRogueWebhooks,
          punishExecutor: !!cfg.punishExecutor,
          punishAction: cfg.punishAction || "none",
          allowlist: {
            channels: Array.isArray(cfg.allowlist?.channelIds) ? cfg.allowlist.channelIds.length : 0,
            webhooks: Array.isArray(cfg.allowlist?.webhookIds) ? cfg.allowlist.webhookIds.length : 0,
            creators: Array.isArray(cfg.allowlist?.creatorUserIds) ? cfg.allowlist.creatorUserIds.length : 0
          }
        };
        await i.reply({ content: "```json\n" + JSON.stringify(summary, null, 2).slice(0,1900) + "\n```", flags: MessageFlags.Ephemeral });
        return;
      }

      // NEW: /permcheck — show if v2 can enforce deletes in this channel
      if (i.commandName === "permcheck" && allowPermcheck) {
        if (!i.inGuild()) { await i.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral }); return; }
        const target = i.options.getChannel?.("channel") || i.channel;
        const me = i.guild.members.me || await i.guild.members.fetch(client.user.id).catch(()=>null);
        const chPerms = target?.permissionsFor?.(me) || null;
        const guildPerms = me?.permissions || null;

        // Try to read v2 allowlist
        let v2 = { available:false, enabled:false, allowlisted:false };
        const utilsHit = await tryImport(["../../utils/webhook-guard-v2.js","../utils/webhook-guard-v2.js"]);
        if (utilsHit) {
          try {
            const { loadConfig } = utilsHit.mod;
            const cfg = loadConfig();
            v2.available = true;
            v2.enabled = !!cfg.enabled;
            v2.allowlisted = !!cfg.allowlist?.channelIds?.includes?.(target?.id);
          } catch {}
        }

        const perms = {
          viewChannel: !!chPerms?.has?.("ViewChannel"),
          manageWebhooks: !!chPerms?.has?.("ManageWebhooks"),
          viewAuditLog: !!guildPerms?.has?.("ViewAuditLog")
        };
        const enforcePossible = v2.enabled && perms.viewChannel && perms.manageWebhooks && perms.viewAuditLog && !v2.allowlisted;

        const payload = {
          channelId: target?.id || null,
          bot: client.user?.tag,
          v2,
          perms,
          enforcePossible
        };
        await i.reply({ content: "```json\n" + JSON.stringify(payload, null, 2).slice(0,1900) + "\n```", flags: MessageFlags.Ephemeral });
        return;
      }

      if (i.commandName === "restorepreview" && allowRestore) {
        const id = i.options.getString("id");
        if (!id) {
          const cnt = await snapshotCounts();
          await i.reply({ content: "```json\n" + JSON.stringify(cnt, null, 2) + "\n```", flags: MessageFlags.Ephemeral });
          return;
        }
        const ch = await getChannelSnapshot(i.guildId, id);
        const rl = ch ? null : await getRoleSnapshot(i.guildId, id);

        if (!ch && !rl) {
          await i.reply({ content: "```json\n" + JSON.stringify({ error: `no snapshot found for id=${id}` }, null, 2) + "\n```", flags: MessageFlags.Ephemeral });
          return;
        }

        const payload = ch ? { kind: "channel", snapshot: ch } : { kind: "role", snapshot: rl };
        const jsonPart = "```json\n" + JSON.stringify(payload, null, 2).slice(0, 900) + "\n```";
        await i.reply({ content: jsonPart, flags: MessageFlags.Ephemeral });
        return;
      }

      if (i.commandName === "snapdiff" && allowSnapdiff) {
        const id = i.options.getString("id");
        if (!id) { await i.reply({ content: "Please provide an ID.", flags: MessageFlags.Ephemeral }); return; }

        const liveCh = i.guild?.channels?.cache?.get?.(id) || await i.guild?.channels?.fetch?.(id).catch(()=>null);
        const liveRl = !liveCh ? (i.guild?.roles?.cache?.get?.(id) || await i.guild?.roles?.fetch?.(id).catch(()=>null)) : null;

        const snapCh = await getChannelSnapshot(i.guildId, id);
        const snapRl = !snapCh ? await getRoleSnapshot(i.guildId, id) : null;

        let diff, payload;
        if (liveCh || snapCh) {
          diff = diffChannel(liveCh, snapCh);
          payload = { kind: "channel", id, summary: summarizeDiff(diff), diff };
        } else if (liveRl || snapRl) {
          diff = diffRole(liveRl, snapRl);
          payload = { kind: "role", id, summary: summarizeDiff(diff), diff };
        } else {
          payload = { error: `ID ${id} not found as channel or role, and no snapshot exists.` };
        }

        const json = JSON.stringify(payload, null, 2);
        await i.reply({ content: "```json\n" + json.slice(0, 1900) + "\n```", flags: MessageFlags.Ephemeral });
        return;
      }

      // NEW: /setlog (ephemeral) — set guild's main moderation log channel
      if (i.commandName === "setlog" && allowSetlog) {
        if (!i.inGuild()) { await i.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral }); return; }
        const m = i.member;
        const canManage = m?.permissions?.has?.("ManageGuild") || m?.permissions?.has?.("Administrator");
        if (!canManage) { await i.reply({ content: "You need **Manage Server** (or Administrator) to use this.", flags: MessageFlags.Ephemeral }); return; }

        const channel = i.options.getChannel("channel", true);
        if (!isTextLike(channel)) {
          await i.reply({ content: "Pick a **text** or **announcement** channel.", flags: MessageFlags.Ephemeral });
          return;
        }

        const { setGuildMainLogChannelId, __missing } = await getLogCfg();
        if (__missing) { await i.reply({ content: "Log config helper missing on this build; feature disabled.", flags: MessageFlags.Ephemeral }); return; }

        await setGuildMainLogChannelId(i.guildId, channel.id);
        await i.reply({ content: "```json\n" + JSON.stringify({ ok: true, set: { guildId: i.guildId, mainChannelId: channel.id, name: channel.name } }, null, 2) + "\n```", flags: MessageFlags.Ephemeral });
        return;
      }

      // NEW: /logtest — send a test message to the configured log channel
      if (i.commandName === "logtest" && allowLogtest) {
        if (!i.inGuild()) { await i.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral }); return; }

        const { getGuildMainLogChannelId, __missing } = await getLogCfg();
        if (__missing) { await i.reply({ content: "Log config helper missing on this build; feature disabled.", flags: MessageFlags.Ephemeral }); return; }

        const chId = await getGuildMainLogChannelId(i.guildId);
        if (!chId) { await i.reply({ content: "No log channel set. Run `/setlog` first.", flags: MessageFlags.Ephemeral }); return; }
        const ch = i.guild.channels.cache.get(chId) || await i.guild.channels.fetch(chId).catch(()=>null);
        if (!isTextLike(ch)) { await i.reply({ content: "Saved log channel is not text/announcement or is inaccessible.", flags: MessageFlags.Ephemeral }); return; }

        await ch.send({ content: `🧪 Log test from **${client.user?.tag}** at ${new Date().toISOString()}` }).catch(()=>{});
        await i.reply({ content: "Sent a test message to your configured log channel.", flags: MessageFlags.Ephemeral });
        return;
      }

      // /wh (webhook test helper) — gated by feature flag
      if (i.commandName === "wh" && allowWh) {
        if (!i.inGuild()) { await i.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral }); return; }
        const m = i.member;
        const canManage = m?.permissions?.has?.("ManageGuild") || m?.permissions?.has?.("ManageWebhooks") || m?.permissions?.has?.("Administrator");
        if (!canManage) { await i.reply({ content: "You need **Manage Webhooks** (or Manage Server) to use this.", flags: MessageFlags.Ephemeral }); return; }

        const sub = i.options.getSubcommand();
        const channel = i.options.getChannel("channel", true);
        if (!channel || (channel.type !== 0 && channel.type !== 5 && channel.type !== 15)) {
          await i.reply({ content: "Pick a text or announcement channel.", flags: MessageFlags.Ephemeral });
          return;
        }

        async function pickWebhook() {
          const hooks = await channel.fetchWebhooks().catch(()=>null);
          if (!hooks || hooks.size === 0) return null;
          const own = Array.from(hooks.values()).find(h => h?.owner?.id === client.user?.id);
          return own || Array.from(hooks.values())[0];
        }

        if (sub === "create") {
          const name = i.options.getString("name") || "AI Hook Test";
          await i.deferReply({ flags: MessageFlags.Ephemeral });
          try {
            const hook = await channel.createWebhook({ name });
            await i.editReply({ content: "```json\n" + JSON.stringify({ ok: true, action: "create", channelId: channel.id, webhookId: hook.id, name: hook.name }, null, 2) + "\n```" });
          } catch (err) {
            await i.editReply({ content: "```json\n" + JSON.stringify({ ok: false, action: "create", error: String(err?.message || err) }, null, 2) + "\n```" });
          }
          return;
        }

        if (sub === "update") {
          const name = i.options.getString("name") || "AI Hook Test (updated)";
          await i.deferReply({ flags: MessageFlags.Ephemeral });
          try {
            const hook = await pickWebhook();
            if (!hook) { await i.editReply({ content: "No webhook found in that channel." }); return; }
            await hook.edit({ name });
            await i.editReply({ content: "```json\n" + JSON.stringify({ ok: true, action: "update", channelId: channel.id, webhookId: hook.id, name }, null, 2) + "\n```" });
          } catch (err) {
            await i.editReply({ content: "```json\n" + JSON.stringify({ ok: false, action: "update", error: String(err?.message || err) }, null, 2) + "\n```" });
          }
          return;
        }

        if (sub === "delete") {
          await i.deferReply({ flags: MessageFlags.Ephemeral });
          try {
            const hook = await pickWebhook();
            if (!hook) { await i.editReply({ content: "No webhook found in that channel." }); return; }
            await hook.delete("wh test delete");
            await i.editReply({ content: "```json\n" + JSON.stringify({ ok: true, action: "delete", channelId: channel.id, webhookId: hook.id }, null, 2) + "\n```" });
          } catch (err) {
            await i.editReply({ content: "```json\n" + JSON.stringify({ ok: false, action: "delete", error: String(err?.message || err) }, null, 2) + "\n```" });
          }
          return;
        }

        await i.reply({ content: "Unknown subcommand.", flags: MessageFlags.Ephemeral });
        return;
      }

    } catch {
      try { await i.reply({ content: "Command failed. Check logs.", flags: MessageFlags.Ephemeral }); } catch {}
    }
  });

  client.once("clientReady", async () => {
    try {
      const app = client.application; if (!app) return;
      const features = await readJSONSafe(path.join(process.cwd(), "data", "feature-flags.json"));
      const wantDiag     = normBool(features.slashDiag, true);
      const wantPing     = normBool(features.slashPing, true);
      const wantUptime   = normBool(features.slashUptime, true);
      const wantIds      = normBool(features.slashIds, true);
      const wantFeatures = normBool(features.slashFeatures, true);
      const wantRestore  = normBool(features.slashRestorePreview, true);
      const wantSnapdiff = normBool(features.slashSnapdiff, true);
      const wantWh       = normBool(features.slashWebhookTest, false);
      const wantSetlog   = normBool(features.slashSetlog, true);
      const wantLogtest  = normBool(features.slashLogtest, true);
      const wantHelp     = normBool(features.slashHelp, true);
      const wantWebhookV2= normBool(features.slashWebhookV2Status, true);
      const wantPermcheck= normBool(features.slashPermcheck, true); // NEW

      const defs = [];
      if (wantDiag)     defs.push({ name: "diag",     description: "Show bot diagnostics (ephemeral)",            dm_permission: false });
      if (wantPing)     defs.push({ name: "ping",     description: "Bot latency + uptime + memory (ephemeral)",  dm_permission: false });
      if (wantUptime)   defs.push({ name: "uptime",   description: "Show bot start time and uptime (ephemeral)", dm_permission: false });
      if (wantIds)      defs.push({ name: "ids",      description: "Show guild/channel/user IDs (ephemeral)",    dm_permission: false });
      if (wantFeatures) defs.push({ name: "features", description: "Show current feature flags (ephemeral)",     dm_permission: false });
      if (wantRestore)  defs.push({
        name: "restorepreview",
        description: "Show a cached snapshot by id, or counts if omitted",
        dm_permission: false,
        options: [{ type: 3, name: "id", description: "Channel or role ID", required: false }]
      });
      if (wantSnapdiff) defs.push({
        name: "snapdiff",
        description: "Compare LIVE object with SNAPSHOT by ID (channel or role)",
        dm_permission: false,
        options: [{ type: 3, name: "id", description: "Channel or role ID", required: true }]
      });

      if (wantWh) {
        defs.push({
          name: "wh",
          description: "Webhook test helper (create/update/delete)",
          dm_permission: false,
          options: [
            {
              type: 1, name: "create", description: "Create a webhook in a channel",
              options: [
                { type: 7, name: "channel", description: "Target channel", required: true },
                { type: 3, name: "name", description: "Webhook name (optional)", required: false }
              ]
            },
            {
              type: 1, name: "update", description: "Rename an existing webhook in a channel",
              options: [
                { type: 7, name: "channel", description: "Target channel", required: true },
                { type: 3, name: "name", description: "New name (optional)", required: false }
              ]
            },
            {
              type: 1, name: "delete", description: "Delete a webhook in a channel",
              options: [
                { type: 7, name: "channel", description: "Target channel", required: true }
              ]
            }
          ]
        });
      }

      if (wantSetlog) {
        defs.push({
          name: "setlog",
          description: "Set the main moderation log channel",
          dm_permission: false,
          options: [{ type: 7, name: "channel", description: "Text or announcement channel", required: true } ]
        });
      }
      if (wantLogtest) {
        defs.push({
          name: "logtest",
          description: "Send a test message to the configured log channel",
          dm_permission: false
        });
      }

      if (wantHelp) {
        defs.push({
          name: "help",
          description: "List available commands (ephemeral)",
          dm_permission: false
        });
      }

      if (wantWebhookV2) {
        defs.push({
          name: "webhookv2",
          description: "Show Webhook Guard v2 status (ephemeral)",
          dm_permission: false
        });
      }

      if (wantPermcheck) {
        defs.push({
          name: "permcheck",
          description: "Show if v2 can enforce in this channel (ephemeral)",
          dm_permission: false,
          options: [
            { type: 7, name: "channel", description: "Channel to check (defaults to here)", required: false }
          ]
        });
      }

      if (defs.length === 0) return;
      for (const [guildId] of client.guilds.cache) {
        for (const def of defs) {
          try { await app.commands.create(def, guildId); }
          catch (err) {
            console.warn(JSON.stringify({ name: "discord.wire", msg: "slash register failed", guildId, command: def.name, err: String(err?.message || err) }));
          }
        }
      }
    } catch {}
  });
}

export default { wire };
