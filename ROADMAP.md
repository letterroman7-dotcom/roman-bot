# Roman Bot — Roadmap (Living Doc)

> Last updated: _auto-kept in code alongside `/plan` output_

## North Star Progress

| Capability | Status | What we have today | What’s left to hit North Star |
|---|---|---|---|
| Join-Gate / Soft-Lock Raids | ✅ Shipped | Join-rate windowing, min account age, new-account ratio, manual + auto softlock, duration | Exemptions (roles/users), per-channel toggles, richer analytics in logs |
| Raid Correlation | ✅ Shipped | Time-window correlation across joins + danger events, auto-lock option (config) | Surface correlation reasons in log embeds; one-click unlock |
| Anti-Nuke (Mass Actions) | ⚠️ Partial | Mass-action + perm-diff watchers active; alerts | Enforce actions (timeout/kick/ban/role strip), cooldowns, per-action thresholds |
| Webhook Guard | ✅ Shipped | Create/update/delete guards, channel allowlist, rogue auto-delete | Per-user/webhook allowlists; audit trail message linking (jump URLs) |
| Snapshot Store | ✅ Shipped | Channel & role snapshots with counts; `/restorepreview`, `/snapdiff` | Scheduled/triggered snapshotting; backup rotation |
| Restore-Apply | ⚠️ Partial | `/restoreapply` with overwrite reapply (drops no-ops), dry-run/apply flow | Channel fields (name/topic/parent/slowmode/nsfw) and role fields (color/perms/position); per-step safety |
| Security Logging | ✅ Shipped | `/setlog` + `/logtest`, structured JSON logs | Rich embeds, incident threads, per-feature log levels |
| Admin Slash Ops | ✅ Shipped | `/ping`, `/uptime`, `/diag`, `/ids`, `/features`, `/wh` | Perms gating matrix; `/reload-config` |
| Config & Flags | ✅ Shipped | `feature-flags.json`, restore-apply config file | Live reload without restart; guild-scoped overrides |
| Performance Hygiene | ✅ Shipped | Boot hygiene, memory snapshot in `/ping` | Periodic health pings to log channel; crashloop protection |
| Exemptions/Safelists | ⬜ Not Started | — | Role/user/channel safelists used by all guards; “trusted integrators” profile |
| Incident Reporting | ⬜ Not Started | — | Auto-compiled incident timeline + summary command |
| Dashboard / UI | ⬜ Not Started | — | Minimal web/status page for flags, snapshots, incidents |

**Legend:** ✅ shipped • ⚠️ partial • ⬜ not started

**Progress score** (shipped=1, partial=0.5, not-started=0):  
`(8*1 + 2*0.5 + 3*0) / 13 = 69%`

---

## Parity vs Wick & Bleed (Qualitative)

| Dimension | Our Status | Wick Parity | Bleed Parity | Gap-Closers |
|---|---|---:|---:|---|
| Join-rate / Age Gate | Strong | 🔶 close | 🔶 close | Exemptions + better log UX |
| Raid Correlation | Strong | 🔶 close | 🔶 close | Expose correlation details |
| Anti-Nuke Enforcement | Alert-only | 🔴 behind | 🔴 behind | Punish pipeline + cooldowns |
| Webhook Protection | Strong | 🟢 near-par | 🔶 close | Owner/URL safelists |
| Snapshot & Restore | Strong (perms) | 🔶 close | 🔶 close | Restore non-perm fields + roles |
| Permission Diff Alerts | Present | 🟢 par | 🟢 par | Per-channel suppression |
| Logging / Audit UX | Basic | 🔶 close | 🔶 close | Embeds, incident threads, jump-links |
| Config Flexibility | File-based | 🔶 close | 🔶 close | Per-guild overrides + hot-reload |
| Automation / Safelists | Missing | 🔴 behind | 🔴 behind | Global exemptions, trusted bots |
| Reporting / Dashboards | Missing | 🔴 behind | 🔴 behind | Incident summaries + dashboard |

---

## Next 5 to Close the Gap Fast

1. **Anti-nuke enforce pipeline** (timeout/kick/ban/role strip) with thresholds + cooldowns.  
2. **Exemption layer** (roles/users/channels) shared by join-gate, anti-nuke, webhook guard, raid-corr.  
3. **Restore-Apply++** channel fields + role fields; keep dry-run diffs crisp.  
4. **Log UX**: embed formatter + incident threads; audit actor + jump URLs.  
5. **Config hot-reload & per-guild overrides** (file or small KV).

