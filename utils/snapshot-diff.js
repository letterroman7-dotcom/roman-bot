// utils/snapshot-diff.js
// Read-only "what changed" between LIVE objects and cached snapshots.
// Focuses on the core fields we snapshot; overwrites/permissions summarized.

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
  } catch { return []; }
}

function normalizeOverwrite(po) {
  const allow = po?.allow?.bitfield ?? po?.allow ?? 0n;
  const deny  = po?.deny?.bitfield ?? po?.deny ?? 0n;
  return {
    id: String(po?.id ?? ""),
    type: Number(po?.type ?? 0), // 0=role,1=member
    allow: allow.toString(),
    deny: deny.toString()
  };
}

function liveOverwritesArray(channel) {
  const arr = [];
  const cache = channel?.permissionOverwrites?.cache;
  if (cache && typeof cache.forEach === "function") {
    cache.forEach((po) => arr.push(normalizeOverwrite(po)));
  }
  return arr;
}

function mapByKey(arr) {
  const m = new Map();
  for (const o of arr || []) m.set(`${o.type}:${o.id}`, o);
  return m;
}

function diffOverwrites(liveArr, snapArr, limitSamples = 5) {
  const liveM = mapByKey(liveArr);
  const snapM = mapByKey(snapArr);

  const added = [];
  const removed = [];
  const changed = [];

  // additions & changes
  for (const [k, lv] of liveM.entries()) {
    const sv = snapM.get(k);
    if (!sv) { if (added.length < limitSamples) added.push(lv); continue; }
    if (lv.allow !== sv.allow || lv.deny !== sv.deny) {
      if (changed.length < limitSamples) {
        changed.push({
          id: lv.id, type: lv.type,
          allow: { live: lv.allow, snap: sv.allow },
          deny:  { live: lv.deny,  snap: sv.deny  }
        });
      }
    }
  }
  // removals
  for (const [k, sv] of snapM.entries()) {
    if (!liveM.has(k)) {
      if (removed.length < limitSamples) removed.push(sv);
    }
  }

  return {
    counts: {
      live: liveArr.length,
      snap: snapArr.length,
      added: Math.max(0, liveArr.length - snapArr.length) || added.length,
      removed: Math.max(0, snapArr.length - liveArr.length) || removed.length,
      changed: changed.length
    },
    samples: { added, removed, changed }
  };
}

export function diffChannel(live, snap) {
  if (!live && !snap) return { error: "no live or snapshot" };
  if (!snap) return { error: "no snapshot found" };

  const fields = [
    "name", "parentId", "position", "topic", "nsfw",
    "rateLimitPerUser", "bitrate", "userLimit", "rtcRegion"
  ];
  const changes = {};
  let changedCount = 0;

  for (const k of fields) {
    const liveVal = (live?.[k] ?? null);
    const snapVal = (snap?.[k] ?? null);
    if (liveVal !== snapVal) {
      changes[k] = { live: liveVal, snap: snapVal };
      changedCount++;
    }
  }

  const liveOw = liveOverwritesArray(live);
  const snapOw = snap?.permissionOverwrites || [];
  const ow = diffOverwrites(liveOw, snapOw);

  return {
    kind: "channel",
    changedFields: changes,
    changedFieldCount: changedCount,
    overwrites: ow
  };
}

export function diffRole(live, snap) {
  if (!live && !snap) return { error: "no live or snapshot" };
  if (!snap) return { error: "no snapshot found" };

  const fields = ["name", "position", "color", "hoist", "mentionable", "managed"];
  const changes = {};
  let changedCount = 0;

  for (const k of fields) {
    const liveVal = (live?.[k] ?? null);
    const snapVal = (snap?.[k] ?? null);
    if (liveVal !== snapVal) {
      changes[k] = { live: liveVal, snap: snapVal };
      changedCount++;
    }
  }

  const livePerms = decodePerms(live?.permissions?.bitfield ?? live?.permissions ?? "0");
  const snapPerms = decodePerms(snap?.permissions ?? "0");
  const liveSet = new Set(livePerms);
  const snapSet = new Set(snapPerms);

  const added = livePerms.filter(p => !snapSet.has(p));
  const removed = snapPerms.filter(p => !liveSet.has(p));

  return {
    kind: "role",
    changedFields: changes,
    changedFieldCount: changedCount,
    permissions: {
      added,
      removed,
      liveCount: livePerms.length,
      snapCount: snapPerms.length
    }
  };
}

export function summarizeDiff(diff) {
  if (!diff || diff.error) return diff?.error || "no diff";
  if (diff.kind === "channel") {
    const f = diff.changedFieldCount;
    const ow = diff.overwrites?.counts || {};
    return `channel: ${f} field(s) changed; overwrites: live=${ow.live} snap=${ow.snap} (added=${ow.added}, removed=${ow.removed}, changed=${ow.changed})`;
  }
  if (diff.kind === "role") {
    const f = diff.changedFieldCount;
    const p = diff.permissions || {};
    return `role: ${f} field(s) changed; perms: +${p.added?.length||0} -${p.removed?.length||0}`;
  }
  return "unknown diff";
}

export default { diffChannel, diffRole, summarizeDiff };
