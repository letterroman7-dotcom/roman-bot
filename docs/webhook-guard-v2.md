# Webhook Guard V2 (Strict Allowlist) — Inert by default

These files are **new** and **do not change current behavior**.
They remain inert until you (1) enable `data/webhook-guard.v2.json` and (2) wire the handlers.

## Enable when ready

1. Toggle:
   ```json
   // data/webhook-guard.v2.json
   { "enabled": true, "...": "..." }
