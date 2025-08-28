// modules/antinuke/threshold-notifier.js
// Emits a single "would-lockdown" notice when a guild crosses the AntiNuke threshold,
// and a "recovered" notice when it falls back below. Log-only (v1 scope).
// Adds an owner "hint" on crossing to guide manual action.

export class ThresholdNotifier {
  constructor() {
    /** @type {Map<string, boolean>} guildId -> lastTriggered */
    this.state = new Map();
  }

  /**
   * @param {object} p
   * @param {import('pino').Logger | Console} p.log
   * @param {string} p.guildId
   * @param {{
   *   score: number, threshold: number, triggered: boolean,
   *   windowMs: number, ts: number, counts: Record<string, number>
   * }} p.status
   */
  checkAndLog({ log, guildId, status }) {
    const prev = this.state.get(guildId) || false;
    const now = Boolean(status.triggered);

    // Rising edge: crossed threshold -> "would-lockdown" + owner hint
    if (now && !prev) {
      log.warn(
        {
          evt: "antinuke.threshold",
          action: "would-lockdown",
          guildId,
          score: status.score,
          threshold: status.threshold,
          windowMs: status.windowMs,
          counts: status.counts,
          hint: "consider enabling lockdown mode and reviewing recent audit logs",
          ts: status.ts
        },
        "AntiNuke threshold crossed"
      );
      this.state.set(guildId, true);
      return;
    }

    // Falling edge: recovered below threshold
    if (!now && prev) {
      log.info(
        {
          evt: "antinuke.threshold.clear",
          action: "recovered",
          guildId,
          score: status.score,
          threshold: status.threshold,
          windowMs: status.windowMs,
          counts: status.counts,
          ts: status.ts
        },
        "AntiNuke threshold cleared"
      );
      this.state.set(guildId, false);
      return;
    }

    // No edge change: do nothing (avoid spam)
  }
}
