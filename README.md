# Roman Bot

Roman Bot is a next-generation **Discord security bot** built with the clear goal of surpassing Wick and Bleed in speed, safety, and reliability.  
It follows a **North Star architecture**: modular, security-first, explainable actions, privacy-by-design, and operator-ready from day one.

---

## ✨ Features (v1.2.3)

- **Anti-Nuke Guard**  
  Sliding window scoring for destructive actions (channel/role/webhook deletes, guild bans, emoji deletes, updates).
  - Threshold detection with log-only **soft lockdown notices**.
  - Recovery detection when actions subside.
  - CLI simulation for safe testing.
- **Event Coverage**  
  Tracks `channelDelete`, `roleDelete`, `webhookDelete`, `guildBanAdd`, `emojiDelete`, `guildUpdate`, `roleUpdate`, plus creates.
- **Weights Overrides**  
  Per-guild scoring can be tuned without code edits using `data/weights.override.json`.
- **Diagnostics**  
  `npm run env:check` → shows Node/OS, feature flags, safe token check, Git commit.  
  `npm run verify:all` → full smoke test (diag + env + owner + CLI).

---

## 🚀 Getting Started

### 1. Clone

```powershell
git clone https://github.com/letterroman7-dotcom/roman-bot.git
cd roman-bot
```
