// modules/antinuke/director.js
// Provides an AntiNukeService per guild, applying per-guild overrides if present.

import { AntiNukeService, DEFAULT_CONFIG } from "./service.js";
import { getOverridesForGuild } from "../../utils/weights-override.js";

export class AntiNukeDirector {
  constructor(baseConfig = DEFAULT_CONFIG) {
    this.baseConfig = baseConfig;
    /** @type {Map<string, AntiNukeService>} */
    this.map = new Map();
  }

  /**
   * Returns (and memoizes) an AntiNukeService for the guild.
   * If overrides exist, they are applied at first access.
   * NOTE: overrides are read at creation time; restart the process to re-read file.
   */
  forGuild(guildId = "unknown") {
    const key = String(guildId || "unknown");
    if (this.map.has(key)) return this.map.get(key);

    const overrides = getOverridesForGuild(key) || {};
    const cfg = {
      ...this.baseConfig,
      threshold: overrides.threshold ?? this.baseConfig.threshold,
      scorePerEvent: {
        ...this.baseConfig.scorePerEvent,
        ...(overrides.scorePerEvent || {})
      }
    };

    const svc = new AntiNukeService(cfg);
    this.map.set(key, svc);
    return svc;
  }
}
