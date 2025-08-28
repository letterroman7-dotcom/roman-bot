# Roman Bot — North Star v1 (v1.2.3)

**Roman Bot** is a calm, explainable **security co-pilot** for Discord guilds.

## ✨ What’s included (v1)

- **Anti-Nuke window scoring** with a sliding window and clear thresholds
- **Soft-lockdown notices (log-only)** on threshold crossing + recovery logs
- **Low-noise signals**: `guildBanAdd`, `emojiDelete`, `guildUpdate`, `roleUpdate`
- **Per-guild overrides** via `data/weights.override.json`
- **Privacy-by-design logging** (guild/user/channel IDs redacted)
- **Diagnostics**: `env:check`, `owner:check`, `verify:all`
- **CLI-first**; Discord wiring behind a feature flag

---

## 🚀 Quick start

```bash
npm install
npm run verify:all
```
