// src/discord/addons/plan.v1.js
// /plan — ephemeral milestone snapshot + % complete
// Reads static plan from in-file constants (optionally overrides from data/roadmap.json)

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MessageFlags } from "discord.js";

const log = (lvl, obj) => {
  try { (console[lvl] || console.log)(JSON.stringify(obj)); } catch {}
};
const stripBOM = s => typeof s === "string" ? s.replace(/^\uFEFF/, "") : s;
async function readJSONSafe(file) { try { return JSON.parse(stripBOM(await fs.readFile(file, "utf8"))); } catch { return {}; } }
function asBool(v, fb=true){ if (typeof v==="boolean") return v; if (typeof v==="string") return v.toLowerCase()==="true"; return fb; }
function jsonBlock(x){ return "```json\n" + JSON.stringify(x, null, 2) + "\n```"; }

// Default plan (mirrors ROADMAP.md)
const DEFAULT_ITEMS = [
  { key: "joingate",          title: "Join-Gate / Soft-Lock Raids", status: "shipped" },
  { key: "raidcorr",          title: "Raid Correlation",            status: "shipped" },
  { key: "antinuke",          title: "Anti-Nuke (Mass Actions)",    status: "partial" },
  { key: "whguard",           title: "Webhook Guard",               status: "shipped" },
  { key: "snapshots",         title: "Snapshot Store",              status: "shipped" },
  { key: "restoreapply",      title: "Restore-Apply",               status: "partial" },
  { key: "securitylog",       title: "Security Logging",            status: "shipped" },
  { key: "adminslash",        title: "Admin Slash Ops",             status: "shipped" },
  { key: "flags",             title: "Config & Flags",              status: "shipped" },
  { key: "perf",              title: "Performance Hygiene",         status: "shipped" },
  { key: "exemptions",        title: "Exemptions/Safelists",        status: "todo" },
  { key: "incident",          title: "Incident Reporting",          status: "todo" },
  { key: "dashboard",         title: "Dashboard / UI",              status: "todo" },
];

function score(items){
  let shipped=0, partial=0, todo=0;
  for(const it of items){
    if(it.status==="shipped") shipped++;
    else if(it.status==="partial") partial++;
    else todo++;
  }
  const total = items.length || 1;
  const pct = Math.round(((shipped + 0.5*partial)/total)*100);
  return { shipped, partial, notStarted: todo, total, percent: pct };
}

export async function wirePlanV1(client){
  // feature flag
  const ff = await readJSONSafe(path.join(process.cwd(), "data", "feature-flags.json"));
  const enabled = asBool(ff?.slashPlan ?? true, true);
  if (!enabled) { log("info", { level:"info", name:"plan", msg:"/plan disabled by feature flag" }); return; }

  // optional override from data/roadmap.json
  let items = DEFAULT_ITEMS;
  const overridePath = path.join(process.cwd(), "data", "roadmap.json");
  try {
    const over = await readJSONSafe(overridePath);
    if (Array.isArray(over) && over.length) {
      items = over.map(x => ({ key: String(x.key||""), title: String(x.title||""), status: String(x.status||"todo") }));
      log("info", { level:"info", name:"plan", msg:"roadmap override loaded", path: overridePath, count: items.length });
    }
  } catch {}

  // register
  client.once("clientReady", async () => {
    try{
      const app = client.application; if(!app) return;
      for(const [guildId] of client.guilds.cache){
        try{
          await app.commands.create({
            name: "plan",
            description: "Show roadmap milestones and % complete (ephemeral)",
            dm_permission: false
          }, guildId);
          log("info", { level:"info", name:"plan", msg:"/plan registered (guild)", guildId });
        } catch(err){
          log("warn", { level:"warn", name:"plan", msg:"slash register failed", guildId, err: String(err?.message||err) });
        }
      }
    } catch {}
  });

  // handler
  client.on("interactionCreate", async (i) => {
    try{
      if(!i.isChatInputCommand()) return;
      if(i.commandName !== "plan") return;
      await i.deferReply({ flags: MessageFlags.Ephemeral });

      const s = score(items);
      const payload = {
        percentComplete: s.percent,
        counts: { shipped: s.shipped, partial: s.partial, notStarted: s.notStarted, total: s.total },
        milestones: items.map(it => ({ key: it.key, title: it.title, status: it.status })),
        meta: { host: os.hostname(), pid: process.pid, ts: new Date().toISOString() }
      };

      await i.editReply({ content: jsonBlock(payload) });
    } catch(err){
      try{
        if(i.deferred || i.replied) await i.editReply({ content: jsonBlock({ error: "Command failed. Check logs." }) });
        else await i.reply({ content: jsonBlock({ error: "Command failed. Check logs." }), flags: MessageFlags.Ephemeral });
      } catch {}
    }
  });
}

export default { wirePlanV1 };
