// utils/log-config.js
// Simple per-guild log channel storage in data/log-config.json

import fs from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "log-config.json");

async function ensureFile() {
  await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  try {
    await fs.access(FILE);
  } catch {
    await fs.writeFile(FILE, "{}\n", "utf8");
  }
}

function stripBOM(s) { return typeof s === "string" ? s.replace(/^\uFEFF/, "") : s; }

async function readJSONSafe() {
  await ensureFile();
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const obj = JSON.parse(stripBOM(raw));
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

async function writeJSONSafe(obj) {
  await ensureFile();
  const json = JSON.stringify(obj ?? {}, null, 2);
  await fs.writeFile(FILE, json + "\n", "utf8");
}

/** Get the saved main moderation log channel for a guild (or null). */
export async function getGuildMainLogChannelId(guildId) {
  if (!guildId) return null;
  const db = await readJSONSafe();
  const rec = db[guildId];
  return (rec && typeof rec.mainChannelId === "string") ? rec.mainChannelId : null;
}

/** Set the main moderation log channel for a guild. */
export async function setGuildMainLogChannelId(guildId, channelId) {
  if (!guildId || !channelId) return false;
  const db = await readJSONSafe();
  if (!db[guildId]) db[guildId] = {};
  db[guildId].mainChannelId = String(channelId);
  await writeJSONSafe(db);
  return true;
}

export default {
  getGuildMainLogChannelId,
  setGuildMainLogChannelId,
};
