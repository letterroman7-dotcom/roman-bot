// utils/perm-danger.js
// Helpers to detect "dangerous" permission additions on roles and channel overwrites.

import { PermissionsBitField } from "discord.js";

function bit(v) {
  if (typeof v === "bigint") return v;
  if (!v) return 0n;
  // PermissionsBitField or similar
  if (typeof v.bitfield === "bigint") return v.bitfield;
  try { return BigInt(v); } catch { return 0n; }
}

// Permissions considered strong enough to signal risk when newly granted.
export const DANGEROUS_ROLE_PERMS = [
  "Administrator",
  "ManageGuild",
  "ManageRoles",
  "ManageChannels",
  "ManageWebhooks",
  "ViewAuditLog",
  "KickMembers",
  "BanMembers",
  "MentionEveryone",
  "ModerateMembers",
  "ManageMessages",
  "ManageThreads"
];

// Channel overwrites cannot grant Administrator, but they can newly ALLOW powerful channel-level perms.
export const DANGEROUS_CHANNEL_PERMS = [
  "ManageChannels",
  "ManageRoles",        // (applies sparsely but include for caution)
  "ManageWebhooks",
  "ManageMessages",
  "ManageThreads",
  "MentionEveryone"
];

// ---------- Role helpers ----------
export function addedDangerRolePerms(oldRole, newRole) {
  try {
    const oldBits = bit(oldRole?.permissions);
    const newBits = bit(newRole?.permissions);
    const added = [];
    for (const name of DANGEROUS_ROLE_PERMS) {
      const flag = BigInt(PermissionsBitField.Flags[name]);
      const had = (oldBits & flag) !== 0n;
      const has = (newBits & flag) !== 0n;
      if (!had && has) added.push(name);
    }
    return added;
  } catch {
    return [];
  }
}

// ---------- Channel overwrite helpers ----------
function indexOverwrites(channel) {
  const m = new Map();
  try {
    const coll = channel?.permissionOverwrites?.cache;
    if (!coll) return m;
    for (const [, ov] of coll) {
      m.set(ov.id, ov);
    }
  } catch {}
  return m;
}

export function addedDangerChannelAllows(oldChan, newChan) {
  const before = indexOverwrites(oldChan);
  const after = indexOverwrites(newChan);

  let totalAdded = 0;
  const samples = []; // {id, type, addedPerms: [names]}

  const allIds = new Set([...before.keys(), ...after.keys()]);
  for (const id of allIds) {
    const a = after.get(id);
    const b = before.get(id);
    const aAllow = bit(a?.allow);
    const bAllow = bit(b?.allow);

    // list of channel-level dangerous perms newly allowed (0 -> 1)
    const addedNames = [];
    for (const name of DANGEROUS_CHANNEL_PERMS) {
      const flag = BigInt(PermissionsBitField.Flags[name]);
      const had = (bAllow & flag) !== 0n;
      const has = (aAllow & flag) !== 0n;
      if (!had && has) addedNames.push(name);
    }
    if (addedNames.length > 0) {
      totalAdded += addedNames.length;
      samples.push({
        id,
        type: a?.type ?? b?.type ?? null,   // 0 = role, 1 = member
        addedPerms: addedNames
      });
    }
  }

  return { totalAdded, samples };
}
