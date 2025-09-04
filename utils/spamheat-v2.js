// utils/spamheat-v2.js (ESM) — adaptive anti-spam core (inert until enabled)
import fs from "fs";
import path from "path";
import pino from "pino";

const log = pino({ name: "spamheat.v2" });
const ROOT = process.cwd();

function rel(...parts) { return path.join(ROOT, ...parts); }
function readJSONSafe(p, fallback = {}) {
  try {
    let s = fs.readFileSync(p, "utf8");
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return JSON.parse(s);
  } catch { return fallback; }
}

function resolveConfigPath() {
  const cands = [ rel("data","spamheat-v2.json") ];
  for (const p of cands) { try { fs.accessSync(p, fs.constants.R_OK); return p; } catch {} }
  return null;
}

export function loadConfig() {
  const p = resolveConfigPath();
  if (!p) { log.info("no spamheat-v2.json found; defaulting disabled"); return { enabled:false }; }
  const c = readJSONSafe(p, {});
  return {
    enabled: !!c.enabled,
    shadowMode: c.shadowMode !== false,
    logSeverity: c.logSeverity ?? "info",
    exempt: { roleIds: c.exempt?.roleIds ?? [], userIds: c.exempt?.userIds ?? [] },
    rateWindowMs: c.rateWindowMs ?? 10000,
    rateLimits: { messagesPerWindow: c.rateLimits?.messagesPerWindow ?? 6 },
    weights: {
      link: c.weights?.link ?? 2.0,
      mention: c.weights?.mention ?? 1.5,
      emoji: c.weights?.emoji ?? 0.5,
      uppercase: c.weights?.uppercase ?? 1.0,
      length: c.weights?.length ?? 0.25,
      newline: c.weights?.newline ?? 0.3,
      repeat: c.weights?.repeat ?? 2.0
    },
    thresholds: {
      heatWarn: c.thresholds?.heatWarn ?? 3.0,
      heatBlock: c.thresholds?.heatBlock ?? 5.0
    },
    strikeDecayMs: c.strikeDecayMs ?? 30000,
    maxStrikes: c.maxStrikes ?? 3,
    actions: {
      onWarn: c.actions?.onWarn ?? "log",
      onBlock: c.actions?.onBlock ?? "delete",
      onMax: c.actions?.onMax ?? "timeout"
    },
    timeoutSeconds: c.timeoutSeconds ?? 600,
    deleteMessagesOnBlock: c.deleteMessagesOnBlock !== false
  };
}

export function isExempt(member, cfg) {
  if (!member) return false;
  if (cfg.exempt.userIds.includes(member.id)) return true;
  return member.roles?.cache?.some?.(r => cfg.exempt.roleIds.includes(r.id)) ?? false;
}

// ── per-user state ─────────────────────────────────────────────────────────────
const userState = new Map(); // key `${guildId}:${userId}` -> { ts:[], strikes, lastContent, lastAt }

function keyFor(msg) { return `${msg.guild?.id || "DM"}:${msg.author.id}`; }
function now() { return Date.now(); }

function pruneWindow(list, windowMs, nowMs) {
  const cut = nowMs - windowMs;
  while (list.length && list[0] < cut) list.shift();
}

function countLinks(text) {
  const re = /(https?:\/\/\S+|discord\.gg\/\S+)/gi;
  return (text.match(re) || []).length;
}
function countMentions(msg) {
  return (msg.mentions?.users?.size || 0) +
         (msg.mentions?.roles?.size || 0) +
         (msg.mentions?.everyone ? 1 : 0);
}
function countEmojis(text) {
  const custom = (text.match(/<a?:\w+:\d+>/g) || []).length;
  const uni = (text.match(/[\u{1F300}-\u{1FAFF}]/gu) || []).length;
  return custom + uni;
}
function uppercaseRatio(text) {
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  const uppers = (text.match(/[A-Z]/g) || []).length;
  return letters ? (uppers / letters) : 0;
}

function computeHeat(msg, cfg, st) {
  const t = msg.content || "";
  const w = cfg.weights;
  let heat = 0;

  // rate within window
  st.ts = st.ts || [];
  const nowMs = now();
  pruneWindow(st.ts, cfg.rateWindowMs, nowMs);
  st.ts.push(nowMs);
  const rateCount = st.ts.length;
  if (rateCount > cfg.rateLimits.messagesPerWindow) {
    heat += (rateCount - cfg.rateLimits.messagesPerWindow) * 0.75;
  }

  heat += countLinks(t) * w.link;
  heat += countMentions(msg) * w.mention;
  heat += countEmojis(t) * w.emoji;
  if (uppercaseRatio(t) > 0.6) heat += w.uppercase;
  if (t.length > 500) heat += w.length;
  heat += ((t.match(/\n/g) || []).length) * w.newline;

  // simple repeat detection
  if (st.lastContent && st.lastContent.trim() === t.trim() && t.trim().length >= 10) {
    heat += w.repeat;
  }
  st.lastContent = t;

  return { heat, rateCount };
}

function decayStrikes(strikes, lastAt, nowMs, decayMs) {
  if (!strikes || !lastAt) return strikes || 0;
  const elapsed = nowMs - lastAt;
  const dec = elapsed / decayMs; // 1 strike per decayMs elapsed
  return Math.max(0, strikes - dec);
}

export function processMessage(msg, cfg) {
  const k = keyFor(msg);
  const st = userState.get(k) || { ts: [], strikes: 0, lastContent: "", lastAt: 0 };
  const nowMs = now();

  // decay
  st.strikes = decayStrikes(st.strikes, st.lastAt, nowMs, cfg.strikeDecayMs);

  const { heat, rateCount } = computeHeat(msg, cfg, st);

  let action = "none";
  let reason = "ok";
  if (heat >= cfg.thresholds.heatBlock) {
    st.strikes += 1;
    st.lastAt = nowMs;
    reason = "block";
    action = cfg.actions.onBlock; // often "delete"
    if (st.strikes >= cfg.maxStrikes) {
      action = cfg.actions.onMax; // often "timeout"
      reason = "max";
    }
  } else if (heat >= cfg.thresholds.heatWarn) {
    reason = "warn";
    action = cfg.actions.onWarn; // typically "log"
  }

  userState.set(k, st);
  return { heat, rateCount, strikes: st.strikes, action, reason };
}

export function actionSummary(res) {
  return `[SpamHeatV2] ${res.reason.toUpperCase()} heat=${res.heat.toFixed(2)} rate=${res.rateCount} strikes=${res.strikes} act=${res.action}`;
}
