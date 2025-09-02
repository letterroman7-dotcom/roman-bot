/* src/discord/wire-mass-actions.js
   Alert-only watchers for channel/role create/delete (+webhook/emoji proxy).
   Scores via AntiNukeDirector; logs include per-incident traceId and optional audit attribution.
*/
import { AntiNukeDirector } from "../../modules/antinuke/director.js";
import { sendSecurityLog, readFlags, toRedactedId } from "../../utils/security-log.js";
import { findExecutorForEvent } from "../../utils/audit-log.js";
import { newTraceId } from "../../utils/trace-id.js";
import createLogger from "../../utils/pino-factory.js";
const log = createLogger("mass");

export async function wireMassActions(client) {
  const flags = await readFlags();
  if (flags?.watchMass === false) { log.info("mass-action watchers disabled by flag"); return; }
  log.info("mass-action watchers active (alert-only; batched 2500ms/25)");

  const director = new AntiNukeDirector();

  async function handle(eventName, guild, payload, count = 1) {
    try {
      if (!guild?.id) return;
      const traceId = newTraceId("mass");

      const svc = director.forGuild(guild.id);
      const scored = svc.simulate(eventName, count);

      // Optional audit attribution (safe lookback)
      let actor = null;
      const targetId =
        payload?.channel?.id ?? payload?.role?.id ?? payload?.webhook?.id ?? payload?.emoji?.id ?? null;
      try {
        if (flags.auditAttribution && targetId) {
          const found = await findExecutorForEvent(guild, eventName, targetId, flags.auditLookbackMs || 30_000);
          if (found) actor = { id: toRedactedId(found.userId), username: found.username, auditEntryId: found.entryId, at: found.createdAt };
        }
      } catch {}

      await sendSecurityLog(client, guild, scored?.triggered ? "warn" : "info", "mass-action", {
        traceId,
        event: eventName,
        count,
        perEventScore: scored?.perEvent?.[eventName] ?? null,
        score: scored?.score ?? null,
        threshold: scored?.threshold ?? null,
        triggered: !!scored?.triggered,
        windowMs: scored?.windowMs ?? null,
        counts: scored?.counts ?? null,
        guild: toRedactedId(guild?.id),
        actor,
        targetId: toRedactedId(targetId)
      });
    } catch (err) {
      log.warn({ msg: err?.message }, "mass-action handler failed");
    }
  }

  // Channel create/delete
  client.on("channelCreate", (ch) => handle("channelCreate", ch?.guild, { channel: ch }, 1));
  client.on("channelDelete", (ch) => handle("channelDelete", ch?.guild, { channel: ch }, 1));
  // Role create/delete
  client.on("roleCreate", (role) => handle("roleCreate", role?.guild, { role }, 1));
  client.on("roleDelete", (role) => handle("roleDelete", role?.guild, { role }, 1));
  // Emoji delete
  client.on("emojiDelete", (emoji) => handle("emojiDelete", emoji?.guild, { emoji }, 1));
  // Webhook updates (proxy for create/delete bursts)
  client.on("webhooksUpdate", (chan) => handle("webhookCreate", chan?.guild, { channel: chan }, 1));
}
export default wireMassActions;
