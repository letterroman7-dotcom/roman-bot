# SpamHeat V2 (Adaptive Anti-Spam)

**Disabled by default.** Turns on via `data/spamheat-v2.json` → `"enabled": true`.

- Scores each message with simple, explainable features (links, mentions, emoji, caps, repeats, rate).
- Strike decay over time; configurable thresholds and actions.
- Shadow mode logs without deleting for safe tuning.

## Enable (shadow)
```json
{ "enabled": true, "shadowMode": true }
