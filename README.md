# Roman Bot

Roman Bot is a Discord security bot focused on **fast, safe, explainable protection**.  
It provides **Anti-Nuke**, **logging**, and **diagnostics** with clean modular architecture.

---

## Features (v1 scope)

- Anti-Nuke **window scoring** (channel/role/webhook/ban/emoji updates)
- Threshold logs (`would-lockdown` / `recovered`)
- CLI tooling: `ping`, `antinuke status`, `antinuke simulate`
- Environment + diagnostics scripts (`env:check`, `owner:check`)
- Per-guild **weights override** via JSON (no code changes needed)

---

## Setup

1. **Clone repo & install**
   ```powershell
   git clone https://github.com/letterroman7-dotcom/roman-bot.git
   cd roman-bot
   npm install
   ```
