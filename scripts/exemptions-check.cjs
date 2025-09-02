#!/usr/bin/env node
/* scripts/exemptions-check.cjs - print exemptions summary and test a subject */
const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const EXEMPT = path.join(ROOT, "data", "exemptions.json");
const IDS = path.join(ROOT, "data", "project-ids.json");

function safeJSON(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

function stripBOM(s){ return typeof s==="string" ? s.replace(/^\uFEFF/,"") : s; }
function readJSON(p){ try { return JSON.parse(stripBOM(fs.readFileSync(p,"utf8"))); } catch { return null; } }

const ex = readJSON(EXEMPT) || {};
const ids = readJSON(IDS) || {};

function match(list, action){
  if (!Array.isArray(list)) return false;
  return list.includes("*") || (action && list.includes(action));
}

function isExempt({ guildId, userId, roleIds = [], action = "" }) {
  const gu = (ex.guilds && ex.guilds[guildId] && ex.guilds[guildId].users) || {};
  const gr = (ex.guilds && ex.guilds[guildId] && ex.guilds[guildId].roles) || {};
  if (match(gu[userId], action)) return { exempt: true, source: `guild.users[${guildId}/${userId}]` };
  for (const r of roleIds) if (match(gr[r], action)) return { exempt: true, source: `guild.roles[${guildId}/${r}]` };
  if (match((ex.users||{})[userId], action)) return { exempt: true, source: `users[${userId}]` };
  for (const r of roleIds) if (match((ex.roles||{})[r], action)) return { exempt: true, source: `roles[${r}]` };
  return { exempt:false };
}

const guildId = process.argv[2] || ids.guildId || "UNKNOWN_GUILD";
const userId  = process.argv[3] || ids.ownerUserId || "UNKNOWN_USER";
const action  = process.argv[4] || "massGuard";

const summary = {
  using: { EXEMPT, IDS },
  summary: {
    globalUsers: Object.keys(ex.users || {}),
    globalRoles: Object.keys(ex.roles || {}),
    guildUsers: Object.keys((ex.guilds && ex.guilds[guildId] && ex.guilds[guildId].users) || {}),
    guildRoles: Object.keys((ex.guilds && ex.guilds[guildId] && ex.guilds[guildId].roles) || {})
  },
  test: { guildId, userId, action, result: isExempt({ guildId, userId, action }) }
};

console.log(JSON.stringify(summary, null, 2));
