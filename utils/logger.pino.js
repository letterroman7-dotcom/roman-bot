// utils/logger.pino.js
// Pino logger with default ID scrubbing for privacy-by-design.
// Redacts: guildId, userId, channelId, roleId, webhookId, and generic "id" (partial mask).

function maskId(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed.length <= 6) return "***";
  const tail = trimmed.slice(-4);
  return `***redacted***${tail}`;
}

function scrubValue(v) {
  if (v && typeof v === "object") return scrubObject(v);
  return v;
}

function scrubObject(obj) {
  // Shallow copy then scrub known keys; recurse one level for nested payloads.
  const out = Array.isArray(obj) ? obj.map(scrubValue) : { ...obj };
  const keysToMask = ["guildId", "userId", "channelId", "roleId", "webhookId"];
  for (const k of keysToMask) {
    if (k in out) out[k] = maskId(out[k]);
  }
  // Conservative: mask generic 'id' if it looks like a snowflake-length string.
  if ("id" in out && typeof out.id === "string" && out.id.length >= 10) {
    out.id = maskId(out.id);
  }
  // Recurse for obvious nested payloads
  for (const [k, v] of Object.entries(out)) {
    if (v && typeof v === "object") out[k] = scrubObject(v);
  }
  return out;
}

function wrapWithScrub(logger) {
  const wrap = (level) => (payload, msg) => {
    // If payload is an object, scrub it, else pass-through
    if (payload && typeof payload === "object") {
      return logger[level](scrubObject(payload), msg);
    }
    return logger[level](payload, msg);
  };
  return {
    level: logger.level,
    info: wrap("info"),
    warn: wrap("warn"),
    error: wrap("error"),
    debug: wrap("debug" in logger ? "debug" : "info"),
    child: (bindings = {}) => wrapWithScrub(logger.child(scrubObject(bindings)))
  };
}

export async function getLogger(name = "roman-bot") {
  try {
    const { default: pino } = await import("pino");
    const base = pino({
      name,
      level: process.env.LOG_LEVEL || "info"
      // If you want hard redaction too, you could add:
      // redact: { paths: ["*.guildId","*.userId","*.channelId","*.roleId","*.webhookId"], censor: "***" }
    });
    return wrapWithScrub(base);
  } catch {
    // Fallback to console-based logger with same interface
    const prefix = `[${name}]`;
    const base = {
      info: (o, m) => console.log(prefix, JSON.stringify(scrubObject(o)), m || ""),
      warn: (o, m) => console.warn(prefix, JSON.stringify(scrubObject(o)), m || ""),
      error: (o, m) => console.error(prefix, JSON.stringify(scrubObject(o)), m || ""),
      debug: () => {},
      child: () => ({ info: (...a) => console.log(prefix, ...a) }),
      level: "info"
    };
    return wrapWithScrub(base);
  }
}
