// src/discord/addons/perf.v1.js
// Performance hygiene: /perf slash + periodic samples (CPU, memory, event loop delay).

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { MessageFlags } from "discord.js";

const NAME = "perf";

// lightweight JSON logger (consistent shape)
function jlog(level, msg, extra = {}) {
  const line = JSON.stringify({ level, name: NAME, msg, ...extra });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

// safe json loader
async function readJSONSafe(file) {
  try {
    const s = await fs.readFile(file, "utf8");
    const noBOM = s.replace(/^\uFEFF/, "");
    return JSON.parse(noBOM);
  } catch {
    return {};
  }
}

function formatUptime(ms) {
  const t = Math.floor(ms / 1000);
  const s = t % 60;
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600) % 24;
  const d = Math.floor(ms / 86400000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
}

function memSnapshot() {
  const mu = process.memoryUsage();
  return {
    rss: mu.rss,
    heapTotal: mu.heapTotal,
    heapUsed: mu.heapUsed,
    external: mu.external,
    arrayBuffers: mu.arrayBuffers ?? 0,
  };
}

function cpuPercentSince(prev) {
  // prev is {time, usage}; usage from process.cpuUsage(prev.usage)
  const nowUsage = process.cpuUsage(prev.usage);
  const elapsedMs = performance.now() - prev.time;
  // user+system microseconds -> milliseconds
  const usedMs = (nowUsage.user + nowUsage.system) / 1000;
  // Normalize by number of CPUs to get "overall CPU %" perspective
  const cores = os.cpus()?.length || 1;
  const pct = Math.max(0, Math.min(100, (usedMs / (elapsedMs * cores)) * 100));
  return { pct, mark: { time: performance.now(), usage: process.cpuUsage() } };
}

function humanEL(h) {
  // convert nanoseconds to ms and round to 2 decimals
  const ms = (n) => Math.round((Number(n) / 1e6) * 100) / 100;
  return {
    min: ms(h.min),
    p50: ms(h.percentile(50)),
    p90: ms(h.percentile(90)),
    p99: ms(h.percentile(99)),
    max: ms(h.max),
  };
}

const SYM_STATE = Symbol.for("roman.perf.state");

export async function wirePerfV1(client) {
  if (client[SYM_STATE]) {
    jlog("info", "already wired; skipping");
    return;
  }

  jlog("info", "perf wiring start");

  // ---- config ----
  const ffPath = path.join(process.cwd(), "data", "feature-flags.json");
  const features = await readJSONSafe(ffPath);
  const perfCfg = Object.assign(
    {
      enabled: true,
      sampleIntervalMs: 10000,
      elResolutionMs: 20,
      postStartupSummary: true,
    },
    features?.perf || {}
  );

  if (perfCfg.enabled === false) {
    jlog("info", "disabled via feature flags");
    return;
  }

  // ---- event loop delay monitor ----
  const el = monitorEventLoopDelay({ resolution: perfCfg.elResolutionMs });
  el.enable();

  // ---- CPU baseline ----
  let cpuMark = { time: performance.now(), usage: process.cpuUsage() };

  // ---- state & sampler ----
  const state = {
    interval: null,
    el,
  };
  client[SYM_STATE] = state;

  const sample = () => {
    const mem = memSnapshot();
    const { pct, mark } = cpuPercentSince(cpuMark);
    cpuMark = mark;
    const elStats = humanEL(el);

    jlog("info", "tick", {
      cpuPct: Math.round(pct),
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      el_p50_ms: elStats.p50,
      el_p90_ms: elStats.p90,
      el_p99_ms: elStats.p99,
    });

    // reset histogram between samples to keep percentiles meaningful
    el.reset();
  };

  // start periodic sampler once client is ready (guilds populated)
  client.once("ready", () => {
    if (state.interval) return;
    state.interval = setInterval(sample, perfCfg.sampleIntervalMs).unref?.();

    // optional one-shot summary to a log channel via /perf (manual) or here if you want auto-post.
    jlog("info", "perf wiring done");
  });

  // ---- /perf command ----
  client.once("clientReady", async () => {
    try {
      const app = client.application;
      if (!app) return;

      const def = {
        name: "perf",
        description: "Show bot performance snapshot (ephemeral)",
        dm_permission: false,
      };

      for (const [guildId] of client.guilds.cache) {
        try {
          await app.commands.create(def, guildId);
          jlog("info", "/perf registered (guild)", { guildId });
        } catch (err) {
          jlog("warn", "slash register failed", { guildId, command: "perf", err: String(err?.message || err) });
        }
      }
    } catch (err) {
      jlog("warn", "slash registration error", { err: String(err?.message || err) });
    }
  });

  client.on("interactionCreate", async (i) => {
    if (!i.isChatInputCommand()) return;
    if (i.commandName !== "perf") return;

    try {
      const mu = memSnapshot();
      const upMs = Math.floor(process.uptime() * 1000);
      const elStats = humanEL(el);

      const body = {
        ts: new Date().toISOString(),
        host: os.hostname(),
        pid: process.pid,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        uptimeSec: Math.floor(upMs / 1000),
        cpuPct: Math.round(cpuPercentSince(cpuMark).pct), // quick spot CPU
        mem: mu,
        eventLoop: {
          minMs: elStats.min,
          meanMs: undefined, // monitorEventLoopDelay doesn't expose mean directly
          maxMs: elStats.max,
          stddevMs: undefined, // not available; keep keys consistent with earlier print if you want
          percentilesMs: { p50: elStats.p50, p90: elStats.p90, p99: elStats.p99 },
        },
      };

      // Fancy human line + JSON payload
      const human =
        `Node ${body.node}  •  PID ${body.pid}  •  Host ${body.host}\n` +
        `Uptime ${formatUptime(upMs)}  •  CPU ${body.cpuPct}%\n` +
        `Mem rss ${Math.round(mu.rss / 1024 / 1024)} MB, heap ${Math.round(mu.heapUsed / 1024 / 1024)} MB/${Math.round(mu.heapTotal / 1024 / 1024)} MB\n` +
        `EL Delay (ms) p50 ${elStats.p50}, p90 ${elStats.p90}, p99 ${elStats.p99}, max ${elStats.max}\n` +
        `ts=${body.ts}`;

      // reply (ephemeral via flags)
      await i.reply({
        content: human,
        flags: MessageFlags.Ephemeral,
      });

      // Follow with JSON (in the same ephemeral interaction via followUp)
      await i.followUp({
        content: "```json\n" + JSON.stringify(body, null, 2).slice(0, 1900) + "\n```",
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      try {
        await i.reply({ content: "perf failed. Check logs.", flags: MessageFlags.Ephemeral });
      } catch {}
      jlog("error", "interaction failed", { err: String(err?.message || err) });
    }
  });
}

export default { wirePerfV1 };
