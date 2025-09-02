/* src/discord/wire-perm-diff.js
   Alert-only permission-diff watchers for roleUpdate & channelUpdate.
   - Computes dangerous permission additions and feeds AntiNuke scoring.
   - Respects feature flags in data/feature-flags.json:
       - watchPermDiff (default true)
       - permDiffWarnDangerOnly (default true)
       - permDiffIncludeSamples (default true)
*/
import { AntiNukeDirector } from "../../modules/antinuke/director.js";
import { sendSecurityLog, readFlags, toRedactedId } from "../../utils/security-log.js";
import createLogger from "../../utils/pino-factory.js";
import { newTraceId } from "../../utils/trace-id.js";
import {
  DANGEROUS_ROLE_PERMS,
  DANGEROUS_CHANNEL_PERMS
} from "../../utils/perm-danger.js";

const log = createLogger("permdiff");

export async function wirePermDiff(client) {
  const flags = await readFlags(); // BUGFIX: was missing await
  if (flags?.watchPermDiff === false) { log.info("perm-diff watchers disabled by feature flag"); return; }
  const warnDangerOnly = flags?.permDiffWarnDangerOnly !== false;
  const includeSamples = flags?.permDiffIncludeSamples !== false;

  const director = new AntiNukeDirector();

  client.on("roleUpdate", async (oldRole, newRole) => {
    try {
      const guild = newRole?.guild || oldRole?.guild; if (!guild?.id) return;
      const before = new Set(oldRole?.permissions?.toArray?.() || []);
      const after  = new Set(newRole?.permissions?.toArray?.() || []);
      const added  = [...after].filter(p => !before.has(p));
      const addedDanger = added.filter(p => DANGEROUS_ROLE_PERMS.includes(p));
      const count = addedDanger.length;

      const traceId = newTraceId("perm");
      const svc = director.forGuild(guild.id);
      const scored = count > 0 ? svc.simulate("roleUpdate", count) : null;

      const level = count > 0
        ? (scored?.triggered ? "warn" : (warnDangerOnly ? "warn" : "info"))
        : (warnDangerOnly ? "debug" : "info");

      await sendSecurityLog(client, guild, level, "perm-diff", {
        traceId,
        kind: "role.perms.allow.added",
        guild: toRedactedId(guild.id),
        role: { id: toRedactedId(newRole.id), name: newRole.name, pos: newRole.rawPosition },
        dangerousAllowsAddedCount: count,
        ...(includeSamples ? { samples: addedDanger } : {}),
        scoring: scored ? {
          event: "roleUpdate", count,
          perEventScore: scored.perEvent?.roleUpdate ?? null,
          score: scored.score, threshold: scored.threshold, triggered: scored.triggered,
          counts: scored.counts, windowMs: scored.windowMs
        } : { note: count > 0 ? "no scoring available" : "no dangerous additions" }
      });
    } catch (err) { log.error({ err: String(err?.stack || err) }, "roleUpdate handler failed"); }
  });

  client.on("channelUpdate", async (oldChan, newChan) => {
    try {
      const guild = newChan?.guild || oldChan?.guild; if (!guild?.id) return;
      const before = (oldChan?.permissionOverwrites?.cache || new Map());
      const after  = (newChan?.permissionOverwrites?.cache || new Map());

      // Collect newly ALLOWed dangerous channel perms
      const addedDanger = [];
      for (const [id, o] of after) {
        const a = before.get(id);
        const beforeAllow = new Set(a?.allow?.toArray?.() || []);
        const afterAllow  = new Set(o?.allow?.toArray?.() || []);
        const newlyAllow  = [...afterAllow].filter(p => !beforeAllow.has(p));
        for (const perm of newlyAllow) if (DANGEROUS_CHANNEL_PERMS.includes(perm)) addedDanger.push({ id, perm, type: o?.type });
      }
      const count = addedDanger.length;
      const traceId = newTraceId("perm");
      const svc = director.forGuild(guild.id);
      const scored = count > 0 ? svc.simulate("channelUpdate", count) : null;

      const level = count > 0
        ? (scored?.triggered ? "warn" : (warnDangerOnly ? "warn" : "info"))
        : (warnDangerOnly ? "debug" : "info");

      await sendSecurityLog(client, guild, level, "perm-diff", {
        traceId,
        kind: "channel.overwrites.allow.added",
        guild: toRedactedId(guild.id),
        channel: {
          id: toRedactedId(newChan.id),
          name: newChan.name,
          type: newChan.type,
          parentId: toRedactedId(newChan.parentId ?? null)
        },
        dangerousAllowsAddedCount: count,
        ...(includeSamples ? { samples: addedDanger } : {}),
        scoring: scored ? {
          event: "channelUpdate", count,
          perEventScore: scored.perEvent?.channelUpdate ?? null,
          score: scored.score, threshold: scored.threshold, triggered: scored.triggered,
          counts: scored.counts, windowMs: scored.windowMs
        } : { note: count > 0 ? "no scoring available" : "no dangerous additions" }
      });
    } catch (err) { log.error({ err: String(err?.stack || err) }, "channelUpdate handler failed"); }
  });

  log.info("perm-diff watchers active (alert-only)");
}
export default wirePermDiff;
