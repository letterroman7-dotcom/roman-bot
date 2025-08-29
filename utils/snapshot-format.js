// utils/snapshot-format.js
// Pretty, read-only summaries for channel/role snapshots.

import { PermissionFlagsBits } from "discord.js";

const PERM_KEYS = Object.keys(PermissionFlagsBits);

function decodePerms(bitStr) {
  try {
    const n = BigInt(bitStr ?? "0");
    const names = [];
    for (const k of PERM_KEYS) {
      const bit = BigInt(PermissionFlagsBits[k]);
      if ((n & bit) !== 0n) names.push(k);
    }
    return names.sort();
  } catch {
    return [];
  }
}

function resolveTargetLabel(guild, id, type) {
  try {
    if (!guild || !id) return `(${id || "unknown"})`;
    if (type === 0) { // role
      if (id === guild.id) return "@everyone";
      const role = guild.roles?.cache?.get?.(id);
      return role ? `@${role.name}` : `(role:${id})`;
    }
    if (type === 1) { // member
      const mem = guild.members?.cache?.get?.(id);
      return mem ? `@${mem.user?.tag}` : `(user:${id})`;
    }
    return `(${id})`;
  } catch {
    return `(${id})`;
  }
}

export function formatChannelSnapshot(guild, snap, { maxOverwrites = 3, maxPerms = 6 } = {}) {
  if (!snap) return "no snapshot";
  const lines = [];
  lines.push(`name="${snap.name}" parentId=${snap.parentId ?? "null"} position=${snap.position ?? "null"}`);
  const ow = snap.permissionOverwrites || [];
  lines.push(`overwrites=${ow.length}`);
  for (let i = 0; i < Math.min(ow.length, maxOverwrites); i++) {
    const o = ow[i];
    const label = resolveTargetLabel(guild, o?.id, o?.type);
    const allNames = decodePerms(o?.allow);
    const denNames = decodePerms(o?.deny);
    const allow = allNames.slice(0, maxPerms);
    const deny = denNames.slice(0, maxPerms);
    const allowMore = Math.max(0, allNames.length - allow.length);
    const denyMore = Math.max(0, denNames.length - deny.length);
    const allowStr = `allow=[${allow.join(", ")}${allowMore ? ` …+${allowMore}` : ""}]`;
    const denyStr = `deny=[${deny.join(", ")}${denyMore ? ` …+${denyMore}` : ""}]`;
    lines.push(`  #${i + 1} ${label} ${allowStr} ${denyStr}`);
  }
  if (ow.length > maxOverwrites) lines.push(`  …+${ow.length - maxOverwrites} more overwrite(s)`);
  return lines.join("\n");
}

export function formatRoleSnapshot(_guild, snap, { maxPerms = 12 } = {}) {
  if (!snap) return "no snapshot";
  const all = decodePerms(snap.permissions);
  const names = all.slice(0, maxPerms);
  const more = Math.max(0, all.length - names.length);
  return `name="${snap.name}" position=${snap.position ?? "null"} perms=[${names.join(", ")}${more ? ` …+${more}` : ""}] managed=${!!snap.managed}`;
}

export default { formatChannelSnapshot, formatRoleSnapshot };
