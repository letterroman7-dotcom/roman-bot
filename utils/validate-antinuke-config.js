// utils/validate-antinuke-config.js
// Validate antinuke-config.json structure & values.

const ALLOWED_TOP = new Set(["defaults", "guilds"]);
const ALLOWED_EVENTS = new Set([
  "channelDelete",
  "roleDelete",
  "webhookDelete",
  "guildBanAdd",
  "emojiDelete",
  "guildUpdate",
  "roleUpdate",
  "channelCreate",
  "roleCreate",
  "webhookCreate",
  "channelUpdate" // NEW
]);

function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
function isNum(v) { return typeof v === "number" && Number.isFinite(v); }

function checkWeights(weights, path, errors, warnings) {
  if (!isObj(weights)) { errors.push(`${path}: weights must be an object`); return; }
  for (const [k, v] of Object.entries(weights)) {
    if (!ALLOWED_EVENTS.has(k)) {
      warnings.push(`${path}: unknown weight key "${k}" (allowed: ${[...ALLOWED_EVENTS].join(", ")})`);
    }
    if (!isNum(v) || v < 0) {
      errors.push(`${path}.${k}: weight must be a non-negative number`);
    }
  }
}

export function validateAntiNukeConfig(cfg) {
  const errors = [];
  const warnings = [];

  if (!isObj(cfg)) {
    errors.push("config must be an object");
    return { ok: false, errors, warnings, cfg: null };
  }

  // Unknown top-level keys
  for (const k of Object.keys(cfg)) {
    if (!ALLOWED_TOP.has(k)) {
      warnings.push(`unknown top-level key "${k}" (allowed: defaults, guilds)`);
    }
  }

  // defaults
  if (cfg.defaults) {
    if (!isObj(cfg.defaults)) { errors.push("defaults must be an object"); }
    const t = cfg.defaults?.threshold;
    if (t !== undefined && (!isNum(t) || t < 0)) {
      errors.push("defaults.threshold must be a non-negative number");
    }
    if (cfg.defaults?.weights) {
      checkWeights(cfg.defaults.weights, "defaults.weights", errors, warnings);
    }
  }

  // guild overrides
  if (cfg.guilds) {
    if (!isObj(cfg.guilds)) { errors.push("guilds must be an object mapping guildId -> override"); }
    for (const [gid, ov] of Object.entries(cfg.guilds || {})) {
      if (!/^\d{17,20}$/.test(gid)) {
        warnings.push(`guilds["${gid}"]: not a typical Discord snowflake id (17-20 digits)`);
      }
      if (!isObj(ov)) { errors.push(`guilds["${gid}"] must be an object`); continue; }
      const t = ov.threshold;
      if (t !== undefined && (!isNum(t) || t < 0)) {
        errors.push(`guilds["${gid}"].threshold must be a non-negative number`);
      }
      if (ov.weights) {
        checkWeights(ov.weights, `guilds["${gid}"].weights`, errors, warnings);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, cfg };
}

export default { validateAntiNukeConfig };
