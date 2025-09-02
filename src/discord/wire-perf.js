/* src/discord/wire-perf.js
   Registers a lightweight /perf slash command and handles replies.
   - Defaults ON unless feature flag "slashPerf" === false.
   - Reads flags and project ids via utils/security-log.js to keep behavior consistent.
   - Upserts the command (guild if project-ids.json has guildId; otherwise global).
*/
import { readFlags, readProjectIds } from "../../utils/security-log.js";
import createLogger from "../../utils/pino-factory.js";
import { time } from "node:console";

const log = createLogger("perf");

/** Upsert a command in a guild if guildId provided; else global. */
async function upsertCommand(client, data, guildId) {
  // Ensure application is ready
  await client.application?.fetch?.();

  if (guildId) {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) throw new Error(`guild not found: ${guildId}`);
    const cmds = await guild.commands.fetch().catch(() => null);
    const existing = cmds && Array.from(cmds.values()).find(c => c.name === data.name);
    if (existing) {
      await guild.commands.edit(existing.id, data);
      return { scope: "guild", id: existing.id };
    } else {
      const created = await guild.commands.create(data);
      return { scope: "guild", id: created.id };
    }
  } else {
    const cmds = await client.application.commands.fetch().catch(() => null);
    const existing = cmds && Array.from(cmds.values()).find(c => c.name === data.name);
    if (existing) {
      await client.application.commands.edit(existing.id, data);
      return { scope: "global", id: existing.id };
    } else {
      const created = await client.application.commands.create(data);
      return { scope: "global", id: created.id };
    }
  }
}

/** Simple latency sampler (no external deps). */
function formatLatency(client) {
  const ws = client.ws?.ping ?? null; // discord.js WS ping
  return { wsPingMs: typeof ws === "number" ? Math.round(ws) : null };
}

export async function wirePerf(client) {
  // Read flags; default ON unless explicitly false
  const flags = await readFlags().catch(() => ({}));
  if (flags?.slashPerf === false) {
    log.info("slashPerf flag disabled; /perf not registered");
    return;
  }

  // Upsert command once client is ready
  client.once("ready", async () => {
    try {
      const ids = await readProjectIds().catch(() => ({}));

      const data = {
        name: "perf",
        description: "Show bot latency and health snapshot",
        dm_permission: false
      };

      const res = await upsertCommand(client, data, ids.guildId);
      log.info(`/perf registered (${res.scope})`);
    } catch (err) {
      log.warn({ err: String(err?.message || err) }, "failed to register /perf");
    }
  });

  // Handle invocations
  client.on("interactionCreate", async (interaction) => {
    try {
      if (!interaction?.isChatInputCommand?.()) return;
      if (interaction.commandName !== "perf") return;

      // Defer ephemeral reply (fast)
      await interaction.deferReply({ ephemeral: true });

      // Sample a couple of timings
      const t0 = Date.now();
      const ws = formatLatency(interaction.client);
      const t1 = Date.now();

      // Build payload (extend later with histograms)
      const payload = {
        wsPingMs: ws.wsPingMs,
        handlerOverheadMs: t1 - t0,
        ts: new Date().toISOString()
      };

      await interaction.editReply({
        content: "Performance snapshot",
        embeds: [{
          title: "Roman Bot /perf",
          description: "Lightweight latency snapshot",
          fields: [
            { name: "WS ping (ms)", value: String(payload.wsPingMs ?? "n/a"), inline: true },
            { name: "Handler overhead (ms)", value: String(payload.handlerOverheadMs), inline: true }
          ],
          footer: { text: payload.ts }
        }]
      });

      // Also log (so operators can correlate)
      log.info(payload, "perf snapshot");
    } catch (err) {
      // Avoid throwing in interaction handler
      try {
        if (interaction?.deferred && !interaction?.replied) {
          await interaction.editReply({ content: "Perf error. Check logs." });
        }
      } catch {}
      log.warn({ err: String(err?.stack || err) }, "perf handler failed");
    }
  });
}

export default wirePerf;
