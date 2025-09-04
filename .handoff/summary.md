# Roman Bot — Baseline Summary (Post-Clean Restart)

This document captures the current locked state of the repo, aligned with the **inventory.post.json** snapshot.

## ✅ Completed & Working
- Boot & wiring (`src/discord/run.js`, `src/discord/wire.js`)
- Slash commands (diag, ping, uptime, ids, features, restorepreview, snapdiff, logtest, setlog, perf, help, webhookv2status, permcheck)
- Security logging (`utils/security-log.js`, `utils/send-log.js`, `utils/log-config.js`)
- Webhook Guard v2 (`utils/webhook-guard-v2.js`, `data/webhook-guard-v2.json`) — strict allowlist, auto-delete
- Snapshots (`utils/snapshot-*.js`, `data/snapshots/`)
- Exemptions & safe enforcement (`utils/exemptions.js`, `utils/enforce-safely.js`)
- SpamHeat v2 (`src/discord/addons/spamheat.v2.js`, `data/spamheat-v2.json`) — present, shadow-mode supported
- Perf hooks (`utils/perf-registry.js`, `/perf` command)
- Feature flags (`data/feature-flags.json`, helpers)

## ⚠️ Partial / Needs Code
- Anti-Nuke mass-action & perm-diff watchers (`src/discord/wire-mass-actions.js`, `src/discord/wire-perm-diff.js`) — require `modules/antinuke/director.js`
- Join-gate & raid correlation add-ons (`src/discord/addons/joingate.v1.js`, `raidcorr.v1.js`) — require `modules/antinuke/window.js`

## ❌ Missing / To Clean
- `modules/antinuke/director.js`
- `modules/antinuke/window.js`
- `cli/cli.js`
- `src/discord/wire-join-gate.js` (points to non-existent `../../wire-join-gate.js`)

---

## Next Steps
1. Implement **`modules/antinuke/director.js`** (ActorScore, mass action detection, perm diff enforcement).
2. Implement **`modules/antinuke/window.js`** (join velocity, raid correlation, sliding window).
3. Remove or repoint stray `wire-join-gate.js`.
4. Add `cli/cli.js` or drop CLI reference in `package.json`.

---

## North Star Alignment
**Goal:** Discord security bot that beats Wick & Bleed with faster detection (<150–300 ms), strict webhook guard, explainable logs, safe enforcement, JSON-first configs, optional AI.

This baseline covers **foundation (logging, wiring, snapshots, webhooks, spam, perf)**.  
What remains is **core detection engines (director + window)** and flipping watchers from **alert → enforce**.

