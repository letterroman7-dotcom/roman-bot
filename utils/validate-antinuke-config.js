// utils/validate-antinuke-config.js
// Lightweight validator for data/antinuke-config.json.
// - Warns on typos/unknown weight keys
// - Validates types and obvious mistakes
// - Never throws; returns { ok, errors, warnings, cfg }

const SNOWFLAKE_RE = /^\d{17,20}$/;

// Expandable list of known signal keys. Unknowns will warn but are allowed.
const KNOWN_WEIGHT_KEYS = new Set([
  "channelDelete",
  "roleDelete",
  "channelCreate",
  "roleCreate",
  "webhookCreate",
  "webhookDelete",
  // keep space for future signals:
  "emojiCreate",
  "emojiDelete",
  "channelUpdatePermDiff",
  "roleUpdatePermDiff",
  "guildMemberAddBotGuard"
]);

function isObject(o) {
  return o && typeof o === "object" && !Array.isArray(o);
}

function validateWeights(weights, where, warnings, errors) {
  if (weights == null) return;
  if (!isObject(weights)) {
    errors.push(`${where}: "weights" must be an object`);
    return;
  }
  const keys = Object.keys(weights);
  if (keys.length === 0) {
    warnings.push(`${where}: "weights" is empty`);
  }
  for (const k of keys) {
    if (!KNOWN_WEIGHT_KEYS.has(k)) {
      warnings.push(`${where}: unknown weight key "${k}" (will be used, but check for typos)`);
    }
    const v = weights[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      errors.push(`${where}: weight "${k}" must be a finite number`);
      continue;
    }
    if (v < 0) warnings.push(`${where}: weight "${k}" is negative (${v}); consider >= 0`);
    if (v > 5) warnings.push(`${where}: weight "${k}"=${v} is large; typical range is 0..1`);
  }
}

export function validateAntiNukeConfig(input) {
  const errors = [];
  const warnings = [];

  if (input == null) {
    return { ok: true, errors, warnings, cfg: null };
  }
  if (!isObject(input)) {
    errors.push(`top-level: config must be an object`);
    return { ok: false, errors, warnings, cfg: null };
  }

  const cfg = { ...input };

  // defaults
  if (cfg.defaults != null) {
    if (!isObject(cfg.defaults)) {
      errors.push(`defaults: must be an object`);
    } else {
      if (cfg.defaults.threshold != null) {
        const t = cfg.defaults.threshold;
        if (typeof t !== "number" || !Number.isFinite(t)) {
          errors.push(`defaults.threshold must be a finite number`);
        } else if (t < 0) {
          warnings.push(`defaults.threshold is negative (${t}); consider >= 0`);
        }
      }
      validateWeights(cfg.defaults.weights, "defaults", warnings, errors);
    }
  } else {
    warnings.push(`defaults: missing; using implicit threshold=1 and no weights`);
  }

  // guilds
  if (cfg.guilds != null) {
    if (!isObject(cfg.guilds)) {
      errors.push(`guilds: must be an object mapping guildId -> overrides`);
    } else {
      for (const [gid, ov] of Object.entries(cfg.guilds)) {
        if (!SNOWFLAKE_RE.test(gid)) {
          warnings.push(`guilds["${gid}"]: not a typical Discord snowflake id (17-20 digits)`);
        }
        if (!isObject(ov)) {
          errors.push(`guilds["${gid}"]: override must be an object`);
          continue;
        }
        if (ov.threshold != null) {
          const t = ov.threshold;
          if (typeof t !== "number" || !Number.isFinite(t)) {
            errors.push(`guilds["${gid}"].threshold must be a finite number`);
          } else if (t < 0) {
            warnings.push(`guilds["${gid}"].threshold is negative (${t}); consider >= 0`);
          }
        }
        validateWeights(ov.weights, `guilds["${gid}"]`, warnings, errors);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, cfg };
}

export default { validateAntiNukeConfig };
