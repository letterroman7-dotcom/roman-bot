// utils/weights-override.js
// Loads per-guild AntiNuke overrides from data/weights.override.json.
// Flexible schema: accepts either "weights" or "scorePerEvent" keys.
// Example:
// {
//   "default": { "threshold": 1, "weights": { "channelDelete": 0.5 } },
//   "guilds": {
//     "123456789012345678": { "threshold": 1.5, "scorePerEvent": { "guildBanAdd": 0.6 } }
//   }
// }

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OVERRIDE_PATH = path.resolve(ROOT, "data", "weights.override.json");

let cache = null;
let mtime = 0;

function readJSONSafe(p) {
  try {
    const stat = fs.statSync(p);
    const text = fs.readFileSync(p, "utf8");
    const data = JSON.parse(text);
    return { data, mtimeMs: stat.mtimeMs };
  } catch {
    return { data: null, mtimeMs: 0 };
  }
}

function isPlainObject(x) {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

// Normalize { weights | scorePerEvent } -> scorePerEvent
function normalizeWeights(obj) {
  if (!isPlainObject(obj)) return {};
  // prefer explicit scorePerEvent; else fallback to weights
  const direct = isPlainObject(obj.scorePerEvent) ? obj.scorePerEvent : null;
  const alt = isPlainObject(obj.weights) ? obj.weights : null;
  const src = direct || alt || {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}

function normalizeSection(sec) {
  if (!isPlainObject(sec)) return {};
  const out = {};
  if (typeof sec.threshold === "number" && Number.isFinite(sec.threshold) && sec.threshold >= 0) {
    out.threshold = sec.threshold;
  }
  const scorePerEvent = normalizeWeights(sec);
  if (Object.keys(scorePerEvent).length > 0) out.scorePerEvent = scorePerEvent;
  return out;
}

export function getRawOverrides() {
  const { data, mtimeMs } = readJSONSafe(OVERRIDE_PATH);
  if (!cache || mtimeMs !== mtime) {
    cache = data;
    mtime = mtimeMs;
  }
  return cache;
}

/**
 * Returns merged config overrides for a given guildId:
 *   merge(defaultOverrides, guildOverrides), with scorePerEvent deep-merged.
 * If file not present or no entries exist, returns null.
 */
export function getOverridesForGuild(guildId) {
  const raw = getRawOverrides();
  if (!isPlainObject(raw)) return null;

  const def = normalizeSection(raw.default);
  const guilds = isPlainObject(raw.guilds) ? raw.guilds : {};
  const gsec = normalizeSection(guildId && guilds[guildId] ? guilds[guildId] : {});

  const out = {};
  // threshold: guild override > default
  if (typeof gsec.threshold === "number") out.threshold = gsec.threshold;
  else if (typeof def.threshold === "number") out.threshold = def.threshold;

  // scorePerEvent: deep-merge default then guild override
  const mergedScores = {
    ...(def.scorePerEvent || {}),
    ...(gsec.scorePerEvent || {})
  };
  if (Object.keys(mergedScores).length > 0) out.scorePerEvent = mergedScores;

  return Object.keys(out).length ? out : null;
}
