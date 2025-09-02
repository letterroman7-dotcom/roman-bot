// src/discord/addons/roadmap.v1.js
// Roadmap v1 — Ephemeral, configurable progress view.
// Reads data/roadmap.json and presents:
//   /roadmap                       -> overview
//   /roadmap view:overview         -> overview
//   /roadmap view:phase key:<k>    -> single phase with items
//   /roadmap view:item  key:<item> -> single item detail
//
// Design notes:
// - Fully optional: safe to load even if config is missing (falls back to defaults).
// - Guild-scoped command; replies are ephemeral.
// - Defers immediately to avoid "application did not respond".

import fs from "node:fs/promises";
import path from "node:path";
import { MessageFlags } from "discord.js";

const LOG = (level, obj) => {
  try { console[level] ? console[level](JSON.stringify(obj)) : console.log(JSON.stringify(obj)); } catch {}
};

function stripBOM(s) { return typeof s === "string" ? s.replace(/^\uFEFF/, "") : s; }
async function readJSONSafe(file) {
  try { return JSON.parse(stripBOM(await fs.readFile(file, "utf8"))); } catch { return null; }
}

function asJsonBlock(obj) { return "```json\n" + JSON.stringify(obj, null, 2).slice(0, 1900) + "\n```"; }

// ----- defaults (kept in sync with /plan you already have) -----
function defaultRoadmap() {
  return {
    phases: [
      {
        key: "defense",
        title: "Defense",
        items: [
          { key: "joingate",     title: "Join-Gate / Soft-Lock Raids", status: "shipped" },
          { key: "raidcorr",     title: "Raid Correlation",            status: "shipped" },
          { key: "antinuke",     title: "Anti-Nuke (Mass Actions)",    status: "partial" },
          { key: "whguard",      title: "Webhook Guard",               status: "shipped" },
          { key: "snapshots",    title: "Snapshot Store",              status: "shipped" },
          { key: "restoreapply", title: "Restore-Apply",               status: "partial" },
        ]
      },
      {
        key: "ops",
        title: "Ops & Hygiene",
        items: [
          { key: "securitylog",  title: "Security Logging",            status: "shipped" },
          { key: "adminslash",   title: "Admin Slash Ops",             status: "shipped" },
          { key: "flags",        title: "Config & Flags",              status: "shipped" },
          { key: "perf",         title: "Performance Hygiene",         status: "shipped" },
        ]
      },
      {
        key: "future",
        title: "Future",
        items: [
          { key: "exemptions",   title: "Exemptions/Safelists",        status: "todo" },
          { key: "incident",     title: "Incident Reporting",          status: "todo" },
          { key: "dashboard",    title: "Dashboard / UI",              status: "todo" },
        ]
      }
    ]
  };
}

// ----- computations -----
function flattenItems(roadmap) {
  const items = [];
  for (const p of roadmap.phases || []) {
    for (const it of p.items || []) items.push({ phaseKey: p.key, phaseTitle: p.title, ...it });
  }
  return items;
}

function computeStats(roadmap) {
  const items = flattenItems(roadmap);
  const total = items.length || 1;
  const shipped = items.filter(i => i.status === "shipped").length;
  const partial = items.filter(i => i.status === "partial").length;
  const notStarted = items.filter(i => i.status !== "shipped" && i.status !== "partial").length;
  const pct = Math.round(((shipped + 0.5 * partial) / total) * 100);
  return { percentComplete: pct, counts: { shipped, partial, notStarted, total } };
}

function iconFor(status) {
  switch (status) {
    case "shipped": return "✅";
    case "partial": return "🟡";
    default:        return "🟦";
  }
}

// short one-line display for lists
function line(it) {
  return `${iconFor(it.status)} ${it.key} — ${it.title} (${it.status})`;
}

function buildOverviewPayload(roadmap) {
  const stats = computeStats(roadmap);
  const phases = (roadmap.phases || []).map(p => {
    const shipped = (p.items || []).filter(i => i.status === "shipped").length;
    const partial = (p.items || []).filter(i => i.status === "partial").length;
    const todo    = (p.items || []).length - shipped - partial;
    return { key: p.key, title: p.title, counts: { shipped, partial, todo, total: (p.items || []).length } };
  });

  return {
    view: "overview",
    percentComplete: stats.percentComplete,
    counts: stats.counts,
    phases
  };
}

function buildPhasePayload(roadmap, phaseKey) {
  const phase = (roadmap.phases || []).find(p => p.key === phaseKey) || null;
  if (!phase) return { error: `phase key not found: ${phaseKey}` };
  return {
    view: "phase",
    phase: {
      key: phase.key,
      title: phase.title,
      items: (phase.items || []).map(i => ({ key: i.key, title: i.title, status: i.status, note: i.note || null }))
    }
  };
}

function buildItemPayload(roadmap, itemKey) {
  const item = flattenItems(roadmap).find(i => i.key === itemKey) || null;
  if (!item) return { error: `item key not found: ${itemKey}` };
  return {
    view: "item",
    item: { key: item.key, title: item.title, status: item.status, phaseKey: item.phaseKey, phaseTitle: item.phaseTitle, note: item.note || null }
  };
}

// ----- handlers -----
async function handleRoadmap(i, roadmap, view, key) {
  if (view === "phase" && key)  return i.editReply({ content: asJsonBlock(buildPhasePayload(roadmap, key)) });
  if (view === "item"  && key)  return i.editReply({ content: asJsonBlock(buildItemPayload(roadmap, key)) });
  return i.editReply({ content: asJsonBlock(buildOverviewPayload(roadmap)) });
}

// ----- wiring -----
export async function wireRoadmapV1(client) {
  const cfgPath = path.join(process.cwd(), "data", "roadmap.json");
  let roadmap = await readJSONSafe(cfgPath);
  if (!roadmap || !Array.isArray(roadmap.phases)) {
    roadmap = defaultRoadmap();
    LOG("warn", { level: "warn", name: "roadmap", msg: "using default roadmap (data/roadmap.json missing or invalid)" });
  }

  // Register per guild when the client signals it's ready (your run.js emits clientReady)
  client.once("clientReady", async () => {
    try {
      const app = client.application;
      if (!app) return;

      for (const [guildId] of client.guilds.cache) {
        try {
          await app.commands.create({
            name: "roadmap",
            description: "Show roadmap (overview / phase / item)",
            dm_permission: false,
            options: [
              { type: 3, name: "view", description: "overview | phase | item", required: false },
              { type: 3, name: "key",  description: "phase key or item key",  required: false }
            ]
          }, guildId);
          LOG("info", { level: "info", name: "roadmap", msg: "/roadmap registered (guild)", guildId });
        } catch (err) {
          LOG("warn", { level: "warn", name: "roadmap", msg: "slash register failed", guildId, err: String(err?.message || err) });
        }
      }
    } catch {}
  });

  client.on("interactionCreate", async (i) => {
    try {
      if (!i.isChatInputCommand()) return;
      if (i.commandName !== "roadmap") return;
      if (!i.inGuild()) { await i.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral }); return; }

      await i.deferReply({ flags: MessageFlags.Ephemeral });

      // reload config on each call so updates to data/roadmap.json reflect instantly
      const fresh = await readJSONSafe(cfgPath);
      const active = (fresh && Array.isArray(fresh.phases)) ? fresh : roadmap;

      const view = (i.options.getString("view") || "overview").toLowerCase();
      const key  = i.options.getString("key") || "";

      await handleRoadmap(i, active, view, key);
    } catch (err) {
      try {
        if (i.deferred || i.replied) {
          await i.editReply({ content: asJsonBlock({ error: "Command failed. Check logs." }) });
        } else {
          await i.reply({ content: asJsonBlock({ error: "Command failed. Check logs." }), flags: MessageFlags.Ephemeral });
        }
      } catch {}
    }
  });

  LOG("info", { level: "info", name: "roadmap", msg: "roadmap wiring ready" });
}

export default { wireRoadmapV1 };
