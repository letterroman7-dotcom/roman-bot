/* scripts/snapshot-view.cjs — view snapshot counts or a specific id */
const fs = require("fs");
const path = require("path");

const SNAP = path.join(process.cwd(), "data", "snapshots");
const CH   = path.join(SNAP, "channel-cache.json");
const RL   = path.join(SNAP, "role-cache.json");

function safeRead(p){ try { return JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/,"")); } catch { return { guilds:{}, savedAt:null }; } }
function findById(cache, id){
  for (const g of Object.values(cache.guilds||{})) {
    if (g && g[id]) return g[id];
  }
  return null;
}

const ch = safeRead(CH);
const rl = safeRead(RL);

const argId = process.argv[2];
if (!argId) {
  const chCount = Object.values(ch.guilds||{}).reduce((a,g)=>a+Object.keys(g||{}).length,0);
  const rlCount = Object.values(rl.guilds||{}).reduce((a,g)=>a+Object.keys(g||{}).length,0);
  console.log(JSON.stringify({
    ok: true,
    savedAt: { channels: ch.savedAt || null, roles: rl.savedAt || null },
    counts: { channels: chCount, roles: rlCount }
  }, null, 2));
} else {
  const hit = findById(ch, argId) || findById(rl, argId);
  console.log(JSON.stringify({ id: argId, found: !!hit, snapshot: hit }, null, 2));
}
