// utils/send-log.js
// Minimal helper to send a plaintext alert to your main channel.
// Reads data/project-ids.json { mainChannelId }, caches it, and sends.
// Safe fallback: logs to console if channel/perm missing.

import fs from "node:fs/promises";
import path from "node:path";
import createLogger from "./pino-factory.js";

const log = createLogger("sendLog");
let cachedIds = null;

function stripBOM(s){ return typeof s==="string" ? s.replace(/^\uFEFF/,"") : s; }
async function readJSONSafe(file){ try{ return JSON.parse(stripBOM(await fs.readFile(file, "utf8"))); } catch { return {}; } }

async function getMainChannelId() {
  if (!cachedIds) {
    cachedIds = await readJSONSafe(path.join(process.cwd(), "data", "project-ids.json"));
  }
  return cachedIds?.mainChannelId || null;
}

/**
 * Send a simple log line into the configured main channel.
 * @param {import("discord.js").Guild} guild
 * @param {object} p
 * @param {string} p.title
 * @param {string} p.desc
 * @param {"info"|"warn"|"crit"} [p.severity="info"]
 */
export async function sendLog(guild, { title, desc, severity = "info" }) {
  try {
    const channelId = await getMainChannelId();
    if (!channelId) {
      log.warn({ title, severity }, "no mainChannelId in data/project-ids.json; logging to console only");
      console.log(`[LOG:${severity}] ${title} — ${desc}`);
      return;
    }

    const ch =
      guild.channels.cache.get(channelId) ||
      (await guild.channels.fetch(channelId).catch(() => null));

    if (!ch || !ch.isTextBased?.()) {
      log.warn({ channelId }, "mainChannelId is not a text channel (or inaccessible)");
      console.log(`[LOG:${severity}] ${title} — ${desc}`);
      return;
    }

    const tag =
      severity === "crit" ? "[CRIT]" :
      severity === "warn" ? "[WARN]" : "[INFO]";

    await ch.send(`**${tag} ${title}**\n${desc}`);
  } catch (err) {
    log.warn({ err }, "sendLog failed; fell back to console");
    console.log(`[LOG:warn] ${title} — ${desc}`);
  }
}

export default { sendLog };
