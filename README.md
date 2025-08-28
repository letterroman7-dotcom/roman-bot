# Roman Bot — North Star v1

**Vision:** Calm, explainable “security co-pilot.”  
**Scope (v1):** Anti-Nuke window scoring + CLI (`ping`, `antinuke status`, `antinuke simulate`) + structured logs + diagnostics + clean module wiring + KV seam.  
**Discord wiring:** available behind a feature flag (`discordWiring`).  
**Soft-lockdown:** log-only notices when threshold crosses, with recovery notices.

## Quick start (CLI)
```bash
npm install
npm run verify:all
npm run ping
npm run antinuke:status
npm run antinuke:simulate
