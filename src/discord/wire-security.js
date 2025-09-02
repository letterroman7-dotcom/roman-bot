// src/discord/wire-security.js
// Mass-guard + snapshots + pretty restore-preview posts + ENFORCEMENT COOLDOWN.

import path from "node:path";
import fs from "node:fs/promises";
import { AuditLogEvent, PermissionsBitField } from "discord.js";
import createLogger from "../../utils/pino-factory.js";
import { enforceSafely } from "../../utils/enforce-safely.js";
let sendLog = null; try { ({ sendLog } = await import("../../utils/send-log.js")); } catch {}

import {
  snapshotChannelData,
  snapshotRoleData,
  upsertChannelSnapshot,
  upsertRoleSnapshot,
  backfillGuildSnapshots,
  getChannelSnapshot,
  getRoleSnapshot
} from "../../utils/snapshot-store.js";
import { formatChannelSnapshot, formatRoleSnapshot } from "../../utils/snapshot-format.js";

const log = createLogger("security");
const CFG_FILE = path.join(process.cwd(), "data", "antinuke-config.json");
const FF_FILE  = path.join(process.cwd(), "data", "feature-flags.json");

function stripBOM(s){return typeof s==="string"?s.replace(/^\uFEFF/,""):s;}
async function readJSONSafe(f){try{return JSON.parse(stripBOM(await fs.readFile(f,"utf8")));}catch{return {};}}

function mergeConfig(cfg,guildId){
  const d=(cfg&&cfg.defaults)||{}, g=(cfg&&cfg.guilds)||{}, o=g[guildId]||{};
  return { threshold: o.threshold ?? d.threshold ?? 1, weights: { ...(d.weights||{}), ...(o.weights||{}) } };
}
function getEnforceFlag(ff){ return !!(ff && ff.enforce && ff.enforce.massGuard === true); }
function getLogToChannelFlag(ff){ return ff && ff.securityLogToChannel === false ? false : true; }
function getRestorePreviewFlag(ff){ return ff && ff.restorePreviewToChannel === false ? false : true; }
function getCooldownEnabled(ff){ return ff?.enforceCooldownEnabled !== false; } // default ON
function getCooldownMs(ff){ const n = Number(ff?.enforceCooldownMinutes); return Number.isFinite(n) && n > 0 ? Math.floor(n*60_000) : 5*60_000; } // default 5m

async function resolveExecutor(guild,{type,channelId,roleId}){
  try{
    const logs=await guild.fetchAuditLogs({type,limit:1});
    const entry=logs?.entries?.first?.(); if(!entry) return null;
    const ageMs=Date.now()-entry.createdTimestamp;
    let targetMatches=true;
    if(type===AuditLogEvent.ChannelDelete&&channelId) targetMatches=(entry.target?.id?entry.target.id===channelId:true);
    if(type===AuditLogEvent.RoleDelete   &&roleId)    targetMatches=(entry.target?.id?entry.target.id===roleId   :true);
    if(ageMs>15_000||!targetMatches) return null;
    return entry.executor ?? null;
  }catch(err){ log.warn({err,guild:guild?.id,type},"fetchAuditLogs failed"); return null; }
}

const windowMs=15_000;
const scores=new Map();
function bumpScore(gid,uid,w){const k=`${gid}:${uid}`,now=Date.now(),cur=scores.get(k);if(!cur||now>cur.resetAt){scores.set(k,{score:w,resetAt:now+windowMs});return w;}cur.score+=w;return cur.score;}

// COOLDOWNS (per guild:actor)
const cooldowns = new Map();
const ck = (gid, uid) => `${gid}:${uid}`;
function getCooldownRemainingMs(gid, uid) {
  const until = cooldowns.get(ck(gid, uid)) ?? 0;
  return Math.max(0, until - Date.now());
}
function setCooldown(gid, uid, ms) { cooldowns.set(ck(gid, uid), Date.now() + ms); }

function permsSummary(guild){
  try{
    const me=guild?.members?.me, p=me?.permissions;
    return { viewAudit:!!p?.has(PermissionsBitField.Flags.ViewAuditLog), moderate:!!p?.has(PermissionsBitField.Flags.ModerateMembers), sendMsgs:!!p?.has(PermissionsBitField.Flags.SendMessages), rolePosOk:me?.roles?.highest?.position ?? -1 };
  }catch{ return { viewAudit:false, moderate:false, sendMsgs:false, rolePosOk:-1 }; }
}

async function maybeEnforceMassGuard({ guild, executor, total, threshold, reason, ff, logToChannel }) {
  const actuallyEnforce = getEnforceFlag(ff);
  const cooldownEnabled = getCooldownEnabled(ff);
  const cooldownMs = getCooldownMs(ff);

  if (cooldownEnabled) {
    const rem = getCooldownRemainingMs(guild.id, executor.id);
    if (rem > 0) {
      const secs = Math.ceil(rem / 1000);
      const title = "MassGuard cooldown active — skipping enforcement";
      const desc  = `executor=<@${executor.id}> remaining=${secs}s reason="${reason}"`;
      if (logToChannel && sendLog) { await sendLog(guild, { title, desc, severity: "warn" }); }
      else { console.log(`[LOG:warn] ${title} — ${desc}`); }
      // clear score to avoid noisy re-triggers during cooldown window
      scores.delete(`${guild.id}:${executor.id}`);
      return;
    }
  }

  if (actuallyEnforce) {
    await enforceSafely({
      guild,
      actor: executor,
      action: "massGuard",
      reason,
      onEnforce: async () => {
        const member = await guild.members.fetch(executor.id).catch(() => null);
        if (member?.moderatable && member.timeout) {
          await member.timeout(60_000, "MassGuard: destructive activity threshold reached");
          return "timeout(60s)";
        }
        return "not-moderatable";
      }
    });
    // start cooldown only when we actually enforced
    if (cooldownEnabled) setCooldown(guild.id, executor.id, cooldownMs);
  } else {
    log.warn({ guild: `[id:${guild.id}]`, user: `[id:${executor.id}]`, total }, "DRY-RUN: would enforce massGuard");
  }

  const title = actuallyEnforce ? "MassGuard ENFORCED" : "MassGuard would enforce (dry-run)";
  const desc  = `executor=<@${executor.id}> score=${total.toFixed(2)} threshold=${threshold} reason="${reason}"`;
  if (logToChannel && sendLog) { await sendLog(guild, { title, desc, severity: actuallyEnforce ? "crit" : "warn" }); }
  else { console.log(`[LOG:${actuallyEnforce ? "crit" : "warn"}] ${title} — ${desc}`); }
}

export async function wireSecurity(client){
  client.once("clientReady", async () => {
    const ff = await readJSONSafe(FF_FILE);
    const enforcing = getEnforceFlag(ff);
    const logToChan = getLogToChannelFlag(ff);
    const cooldownEnabled = getCooldownEnabled(ff);
    const cooldownMinutes = Math.round(getCooldownMs(ff)/60000);

    for (const [, g] of client.guilds.cache) {
      const perms = permsSummary(g);
      log.info(
        { windowMs, enforcing, logToChannel: logToChan, cooldownEnabled, cooldownMinutes, guild: `[id:${g.id}]`, perms },
        "security wiring active"
      );
      if (!perms.viewAudit) log.warn({ guild: g.id }, "missing View Audit Log — cannot attribute executor reliably");
      if (enforcing && !perms.moderate) log.warn({ guild: g.id }, "enforcement ON but missing Moderate Members");

      try { await backfillGuildSnapshots(g); } catch (err) { log.warn({ guild: g.id, err }, "snapshot backfill failed"); }
    }
  });

  // Live snapshot updates (safe)
  client.on("channelCreate", async (ch)=>{try{if(!ch?.guild) return; await upsertChannelSnapshot(ch.guild.id, snapshotChannelData(ch));}catch(err){log.warn({err},"channelCreate snapshot failed");}});
  client.on("channelUpdate", async (_o,n)=>{try{const ch=n??_o; if(!ch?.guild) return; await upsertChannelSnapshot(ch.guild.id, snapshotChannelData(ch));}catch(err){log.warn({err},"channelUpdate snapshot failed");}});
  client.on("roleCreate",    async (r)=>{try{if(!r?.guild) return; await upsertRoleSnapshot(r.guild.id, snapshotRoleData(r));}catch(err){log.warn({err},"roleCreate snapshot failed");}});
  client.on("roleUpdate",    async (_o,n)=>{try{const r=n??_o; if(!r?.guild) return; await upsertRoleSnapshot(r.guild.id, snapshotRoleData(r));}catch(err){log.warn({err},"roleUpdate snapshot failed");}});

  // Guard: Channel delete + formatted restore preview
  client.on("channelDelete", async (channel) => {
    try {
      const guild = channel.guild; if (!guild) return;
      const cfg = await readJSONSafe(CFG_FILE);
      const ff  = await readJSONSafe(FF_FILE);
      const merged = mergeConfig(cfg, guild.id);
      const weight = merged.weights?.channelDelete ?? 0.5;

      const executor = await resolveExecutor(guild, { type: AuditLogEvent.ChannelDelete, channelId: channel.id });
      if (executor) {
        const total = bumpScore(guild.id, executor.id, weight);
        log.info({ guild:`[id:${guild.id}]`, user:`[id:${executor.id}]`, weight, total, threshold: merged.threshold }, "massGuard score");

        if (total >= merged.threshold) {
          await maybeEnforceMassGuard({
            guild, executor, total, threshold: merged.threshold,
            reason:`channelDelete; score ${total.toFixed(2)} >= ${merged.threshold}`,
            ff, logToChannel: getLogToChannelFlag(ff)
          });
          scores.delete(`${guild.id}:${executor.id}`);
        }
      }

      if (getRestorePreviewFlag(ff)) {
        const snap = await getChannelSnapshot(guild.id, channel.id);
        const title = "Restore preview: channel deleted";
        const desc = snap ? formatChannelSnapshot(guild, snap) : `no snapshot found for id=${channel.id}`;
        if (sendLog) { await sendLog(guild, { title, desc, severity: "info" }); }
        else { console.log(`[LOG:info] ${title}\n${desc}`); }
      }
    } catch (err) { log.warn({ err }, "channelDelete guard/preview failed"); }
  });

  // Guard: Role delete + formatted restore preview
  client.on("roleDelete", async (role) => {
    try {
      const guild = role.guild; if (!guild) return;
      const cfg = await readJSONSafe(CFG_FILE);
      const ff  = await readJSONSafe(FF_FILE);
      const merged = mergeConfig(cfg, guild.id);
      const weight = merged.weights?.roleDelete ?? 0.5;

      const executor = await resolveExecutor(guild, { type: AuditLogEvent.RoleDelete, roleId: role.id });
      if (executor) {
        const total = bumpScore(guild.id, executor.id, weight);
        log.info({ guild:`[id:${guild.id}]`, user:`[id:${executor.id}]`, weight, total, threshold: merged.threshold }, "massGuard score");

        if (total >= merged.threshold) {
          await maybeEnforceMassGuard({
            guild, executor, total, threshold: merged.threshold,
            reason:`roleDelete; score ${total.toFixed(2)} >= ${merged.threshold}`,
            ff, logToChannel: getLogToChannelFlag(ff)
          });
          scores.delete(`${guild.id}:${executor.id}`);
        }
      }

      if (getRestorePreviewFlag(ff)) {
        const snap = await getRoleSnapshot(guild.id, role.id);
        const title = "Restore preview: role deleted";
        const desc = snap ? formatRoleSnapshot(guild, snap) : `no snapshot found for id=${role.id}`;
        if (sendLog) { await sendLog(guild, { title, desc, severity: "info" }); }
        else { console.log(`[LOG:info] ${title}\n${desc}`); }
      }
    } catch (err) { log.warn({ err }, "roleDelete guard/preview failed"); }
  });
}

export default { wireSecurity };
