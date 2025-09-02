// src/discord/run.js
import { Client, GatewayIntentBits, Partials } from "discord.js";
import process from "node:process";
import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ---------- tiny logger ---------- */
function redact(tok) { if (!tok) return undefined; const s = String(tok); return `***redacted***${s.slice(-4)}`; }
function jlog(level, fields) {
  const base = { level, name: "discord.run" };
  const out = JSON.stringify({ ...base, ...fields });
  if (level === "error") console.error(out);
  else if (level === "warn") console.warn(out);
  else console.info(out);
}

/* ---------- helpers ---------- */
async function readJSONSafe(file) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return null; }
}
function* walkKV(obj, prefix = "") {
  if (!obj || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    yield [p, v];
    if (v && typeof v === "object") yield* walkKV(v, p);
  }
}
function likelyToken(str) {
  // Heuristic: Discord tokens typically have 2 dots and are long-ish
  return typeof str === "string" && str.includes(".") && str.split(".").length >= 3 && str.length >= 40;
}

/* ---------- token resolver: env → .handoff/context.json (deep) → .env ---------- */
async function resolveToken() {
  // 1) env
  const envTok = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
  if (envTok) return { token: envTok, source: "env", keyPath: "DISCORD_TOKEN|BOT_TOKEN" };

  // 2) .handoff/context.json
  const handoffPath = path.resolve(process.cwd(), ".handoff", "context.json");
  const ctx = await readJSONSafe(handoffPath);
  if (ctx) {
    // a) common spots
    const common =
      ctx?.discord?.token ||
      ctx?.bot?.token ||
      ctx?.token ||
      ctx?.DISCORD_TOKEN ||
      ctx?.BOT_TOKEN ||
      null;
    if (common) return { token: common, source: handoffPath, keyPath: "common" };

    // b) deep scan for any *token*-looking value
    for (const [keyPath, val] of walkKV(ctx)) {
      const keyLower = keyPath.toLowerCase();
      if (keyLower.includes("token") && typeof val === "string" && val) {
        return { token: val, source: handoffPath, keyPath };
      }
      if (likelyToken(val)) {
        return { token: val, source: handoffPath, keyPath };
      }
    }
  }

  // 3) .env file
  try {
    const envFile = await fsp.readFile(path.resolve(process.cwd(), ".env"), "utf8");
    const lines = envFile.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*(DISCORD_TOKEN|BOT_TOKEN)\s*=\s*(.+)\s*$/i);
      if (m) return { token: m[2].trim(), source: ".env", keyPath: m[1] };
    }
  } catch {}

  return { token: null, source: null, keyPath: null };
}

/* ---------- optional ./wire.js loader (won't break startup) ---------- */
async function tryWireOptional(client) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const specPath = path.resolve(here, "wire.js");
  const specUrl = pathToFileURL(specPath).href;

  if (!fs.existsSync(specPath)) {
    jlog("warn", { msg: "optional wire.js not found; continuing", spec: specUrl });
    return;
  }

  try {
    const mod = await import(specUrl);
    const wireFn =
      (typeof mod?.wire === "function" && mod.wire) ||
      (mod?.default && typeof mod.default.wire === "function" && mod.default.wire);

    if (!wireFn) {
      jlog("warn", { msg: "wire.js loaded but no `wire` export found", spec: specUrl, exports: Object.keys(mod || {}) });
      return;
    }
    await wireFn(client);
    jlog("info", { msg: "wire.js imported and wired", spec: specUrl });
  } catch (err) {
    jlog("error", { msg: "wire.js import failed", error: String(err?.message || err), stack: err?.stack || null });
  }
}

/* ---------- boot ---------- */
const { token: TOKEN, source: TOKEN_SRC, keyPath: TOKEN_KEY } = await resolveToken();

jlog("info", {
  msg: "starting discord client",
  node: process.version,
  host: os.hostname(),
  pid: process.pid,
  tokenSource: TOKEN_SRC || "none",
  tokenKeyPath: TOKEN_KEY || "n/a",
  tokenTail: redact(TOKEN),
});

if (!TOKEN) {
  jlog("error", { msg: "No token found (env/.handoff/.env). Make sure handoff wrote the token or set DISCORD_TOKEN." });
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.Channel, Partials.GuildMember],
  sweepers: { messages: { interval: 300, lifetime: 900 } },
  rest: { retries: 3, timeout: 20_000 },
});

client.setMaxListeners?.(50);

process.on("unhandledRejection", (err) => jlog("error", { msg: "unhandledRejection", error: String(err) }));
process.on("uncaughtException", (err) => jlog("error", { msg: "uncaughtException", error: String(err?.message || err), stack: err?.stack || null }));

client.once("ready", async () => {
  jlog("info", { msg: "Discord client ready", user: client.user?.tag, id: client.user?.id ? `[id:${client.user.id}]` : null, guilds: client.guilds.cache.size });
  await tryWireOptional(client);       // load your rich wiring (diag/ping/ids/wh/etc)
  client.emit?.("clientReady");        // keep your wire.js compatibility
});

try {
  await client.login(TOKEN);
  jlog("info", { msg: "login() resolved" });
} catch (err) {
  jlog("error", { msg: "login() failed", error: String(err?.message || err) });
  process.exit(1);
}
