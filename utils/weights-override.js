// utils/weights-override.js
// Loads per-guild AntiNuke overrides from data/weights.override.json.
// Shape:
// {
//   "default": { "threshold": 1, "scorePerEvent": { "channelDelete": 0.5 } },
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
 *   merge(defaultOverrides, guildOverrides) — shallow merge for threshold + deep merge for scorePerEvent.
 * If file not present or no entries exist, returns null.
 */
export function getOverridesForGuild(guildId) {
  const raw = getRawOverrides();
  if (!raw || (typeof raw !== "object")) return null;

  const def = raw.default || {};
  const guilds = raw.guilds || {};
  const perGuild = guildId && guilds[guildId] ? guilds[guildId] : {};

  const threshold =
    perGuild.threshold ?? def.threshold ?? undefined;

  const scorePerEvent = {
    ...(def.scorePerEvent || {}),
    ...(perGuild.scorePerEvent || {})
  };

  const hasThreshold = typeof threshold === "number";
  const hasAnyScore = Object.keys(scorePerEvent).length > 0;

  if (!hasThreshold && !hasAnyScore) return null;

  const out = {};
  if (hasThreshold) out.threshold = threshold;
  if (hasAnyScore) out.scorePerEvent = scorePerEvent;
  return out;
}
