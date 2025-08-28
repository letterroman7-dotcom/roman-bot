# Roman Bot

[![CI](https://github.com/letterroman7-dotcom/roman-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/letterroman7-dotcom/roman-bot/actions/workflows/ci.yml)

Roman Bot is a next-generation Discord security bot built to outpace Wick and Bleed.  
It combines deterministic rule-based protection with modular design and per-guild overrides.

## Features (v1 scope)

- ⚡ Anti-Nuke Guard (window scoring)
- ⚠️ Threshold notices (log-only, no punitive actions in v1)
- 🛠 Per-guild weights override (`data/weights.override.json`)
- 🧰 CLI tools (`cli/cli.js`) for diagnostics, status, and simulation
- 🔐 Privacy-by-design logging with Pino
- ✅ GitHub Actions CI pipeline (`verify:all`)

## Development

Requirements:

- Node.js v22.x
- npm v11.x

### Setup

```powershell
# Clone
git clone https://github.com/letterroman7-dotcom/roman-bot.git
cd roman-bot

# Install deps
npm install

# Copy and edit .env
Copy-Item .env.example .env
# Add your DISCORD_TOKEN inside .env
```
