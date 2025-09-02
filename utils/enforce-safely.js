// utils/enforce-safely.js
// One-call helper to respect exemptions before running any punitive action.
// Safe to add: it's a utility, not auto-wired; nothing changes until you import & call it.

import createLogger from "./pino-factory.js";
import { isExempt } from "./exemptions.js";

const log = createLogger("enforce");

function rolesOf(member) {
  try {
    // discord.js v14: member.roles.cache is a Collection
    return Array.from(member?.roles?.cache?.keys?.() ?? []);
  } catch {
    return [];
  }
}

/**
 * enforceSafely({ guild, actor, action, reason, onEnforce })
 * - Checks exemptions for the actor for the given action.
 * - If exempt: logs and returns { enforced:false, exempt:true, source }.
 * - If NOT exempt: calls onEnforce() and returns its result wrapped in { enforced:true, result }.
 *
 * @param {object} params
 * @param {import("discord.js").Guild} params.guild
 * @param {import("discord.js").User|import("discord.js").GuildMember} params.actor
 * @param {string} params.action               // e.g., "massGuard", "antiSpam", "permDiff"
 * @param {string} [params.reason]             // optional context for logs
 * @param {function():Promise<any>|function():any} params.onEnforce
 */
export async function enforceSafely({ guild, actor, action, reason = "", onEnforce }) {
  const guildId = guild?.id ?? "";
  const userId  = (actor?.user?.id ?? actor?.id ?? "");
  const member  = actor?.user ? actor : (guild?.members?.cache?.get?.(userId) ?? null);
  const roleIds = member ? rolesOf(member) : [];

  const { exempt, source } = await isExempt({ guildId, userId, roleIds, action });

  if (exempt) {
    log.info({ guild: guildId, user: userId, action, source, reason }, "skipping enforcement due to exemption");
    return { enforced: false, exempt: true, source };
  }

  let result;
  try {
    result = await onEnforce();
    log.info({ guild: guildId, user: userId, action, reason }, "enforcement executed");
  } catch (err) {
    log.warn({ guild: guildId, user: userId, action, err, reason }, "enforcement failed");
    throw err;
  }
  return { enforced: true, result };
}

export default { enforceSafely };
