// utils/audit-log.js
// Safe helpers to read Discord Audit Logs and attribute actions.
// Requires your bot to have the "View Audit Log" permission.

import { AuditLogEvent } from "discord.js";

const EVENT_TO_AUDIT = {
  // channels
  channelCreate: AuditLogEvent.ChannelCreate,
  channelDelete: AuditLogEvent.ChannelDelete,
  channelUpdate: AuditLogEvent.ChannelUpdate,
  // roles
  roleCreate: AuditLogEvent.RoleCreate,
  roleDelete: AuditLogEvent.RoleDelete,
  roleUpdate: AuditLogEvent.RoleUpdate,
  // webhooks
  webhookCreate: AuditLogEvent.WebhookCreate,
  webhookDelete: AuditLogEvent.WebhookDelete,
  webhookUpdate: AuditLogEvent.WebhookUpdate,
  // bans / emojis / guild
  guildBanAdd: AuditLogEvent.MemberBanAdd,
  emojiDelete: AuditLogEvent.EmojiDelete,
  guildUpdate: AuditLogEvent.GuildUpdate,
};

function auditTypeForEvent(eventName) {
  return EVENT_TO_AUDIT[eventName] ?? null;
}

/**
 * Find the most recent audit-log entry that matches `eventName` and `targetId`
 * within `lookbackMs` (default 30s). Returns null if not found/allowed.
 *
 * @param {import("discord.js").Guild} guild
 * @param {string} eventName e.g. "channelDelete"
 * @param {string} targetId the channel/role/webhook/emoji/user id acted on
 * @param {number} lookbackMs default 30000
 * @returns {Promise<null | {
 *  userId: string | null,
 *  username: string | null,
 *  entryId: string,
 *  createdAt: string,
 *  action: number,
 * }>}
 */
export async function findExecutorForEvent(guild, eventName, targetId, lookbackMs = 30_000) {
  try {
    if (!guild?.fetchAuditLogs) return null;
    const type = auditTypeForEvent(eventName);
    if (!type) return null;

    const fetched = await guild.fetchAuditLogs({ type, limit: 6 });
    const now = Date.now();

    for (const [, entry] of fetched.entries) {
      const created = entry.createdTimestamp ?? 0;
      const target = entry.target?.id ?? entry.targetId ?? null;
      const age = now - created;

      if (targetId && target && String(target) !== String(targetId)) continue;
      if (age > lookbackMs) continue;

      const user = entry.executor || null;
      return {
        userId: user?.id ?? null,
        username: (user?.tag ?? user?.username ?? null) || null,
        entryId: entry.id,
        createdAt: new Date(created || now).toISOString(),
        action: entry.action,
      };
    }
    return null;
  } catch {
    // permission or transient errors — just return null (alert stays useful)
    return null;
  }
}
