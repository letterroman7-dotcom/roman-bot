// modules/antinuke/service.js
import { SlidingWindowCounter, InMemoryKV } from "./window.js";

export const DEFAULT_CONFIG = {
  windowMs: 30000,
  threshold: 1,
  scorePerEvent: {
    // destructive deletes / bans = 0.5 (higher risk)
    channelDelete: 0.5,
    roleDelete: 0.5,
    webhookDelete: 0.5,
    guildBanAdd: 0.5,
    emojiDelete: 0.5,
    // low-noise signals
    guildUpdate: 0.1,
    roleUpdate: 0.1,
    // creations = lower weight
    channelCreate: 0.2,
    roleCreate: 0.2,
    webhookCreate: 0.2,
    // NEW: track permission changes on channels
    channelUpdate: 0.2
  }
};

export class AntiNukeService {
  constructor(cfg = {}, kv = new InMemoryKV(), now = () => Date.now()) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...cfg,
      scorePerEvent: { ...DEFAULT_CONFIG.scorePerEvent, ...(cfg.scorePerEvent || {}) }
    };
    this.window = new SlidingWindowCounter({ windowMs: this.config.windowMs, kv, now });
  }

  supportedEvents() { return Object.keys(this.config.scorePerEvent); }

  record(eventType, count = 1) {
    if (!this.config.scorePerEvent[eventType]) {
      throw new Error(`Unsupported eventType: ${eventType}. Supported: ${this.supportedEvents().join(", ")}`);
    }
    this.window.increment(eventType, count);
  }

  status() {
    const events = this.supportedEvents();
    const snap = this.window.snapshot(events);
    let score = 0;
    const perEvent = {};
    for (const et of events) {
      const c = snap.counts[et] || 0;
      const w = this.config.scorePerEvent[et] || 0;
      const s = c * w;
      perEvent[et] = s; score += s;
    }
    const triggered = score >= this.config.threshold;
    return {
      ts: snap.ts,
      windowMs: snap.windowMs,
      counts: snap.counts,
      perEvent,
      score,
      threshold: this.config.threshold,
      triggered
    };
  }

  simulate(eventType, count = 1) { this.record(eventType, count); return this.status(); }
}
