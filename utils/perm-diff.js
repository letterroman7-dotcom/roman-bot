// utils/perm-diff.js
// Compute diffs for dangerous permission escalations on roles & channel overwrites.

import { PermissionsBitField } from "discord.js";

export const DANGEROUS_PERMS = [
  "Administrator",
  "ManageGuild",
  "ManageRoles",
  "ManageChannels",
  "KickMembers",
  "BanMembers",
  "ManageWebhooks",
  "MentionEveryone",
  "ManageMessages",
  "ViewAuditLog",
  "ManageEmojisAndStickers",
  "ModerateMembers",
  "ManageEvents"
];

function toSet(arr) { return new Set(arr || []); }
function fromBitfield(bitfield) {
  return new PermissionsBitField(bitfield ?? 0n).toArray();
}

export function diffRolePerms(oldRole, newRole) {
  const before = toSet(fromBitfield(oldRole?.permissions?.bitfield));
  const after  = toSet(fromBitfield(newRole?.permissions?.bitfield));

  const added    = [...after].filter(p => !before.has(p));
  const removed  = [...before].filter(p => !after.has(p));
  const addedDanger   = added.filter(p => DANGEROUS_PERMS.includes(p));
  const removedDanger = removed.filter(p => DANGEROUS_PERMS.includes(p));

  return { before: [...before], after: [...after], added, removed, addedDanger, removedDanger };
}

function overwritesSnapshot(channel) {
  const map = new Map();
  const coll = channel?.permissionOverwrites?.cache;
  if (!coll) return map;
  for (const [, ow] of coll) {
    map.set(String(ow?.id), {
      id: String(ow?.id),
      type: ow?.type, // 0=role, 1=member
      allow: toSet(fromBitfield(ow?.allow?.bitfield)),
      deny:  toSet(fromBitfield(ow?.deny?.bitfield))
    });
  }
  return map;
}

export function diffChannelOverwrites(oldChannel, newChannel) {
  const before = overwritesSnapshot(oldChannel);
  const after  = overwritesSnapshot(newChannel);

  const changes = [];
  const ids = new Set([...before.keys(), ...after.keys()]);
  for (const id of ids) {
    const a = before.get(id) || { allow: new Set(), deny: new Set(), type: undefined };
    const b = after.get(id)  || { allow: new Set(), deny: new Set(), type: undefined };

    const addedAllow   = [...b.allow].filter(p => !a.allow.has(p));
    const removedAllow = [...a.allow].filter(p => !b.allow.has(p));

    const addedDanger   = addedAllow.filter(p => DANGEROUS_PERMS.includes(p));
    const removedDanger = removedAllow.filter(p => DANGEROUS_PERMS.includes(p));

    if (addedAllow.length || removedAllow.length) {
      changes.push({ id, type: b.type ?? a.type, addedAllow, removedAllow, addedDanger, removedDanger });
    }
  }

  const addedDanger = changes.flatMap(c => c.addedDanger.map(perm => ({ id: c.id, type: c.type, perm })));
  const removedDanger = changes.flatMap(c => c.removedDanger.map(perm => ({ id: c.id, type: c.type, perm })));

  return { changes, addedDanger, removedDanger };
}
