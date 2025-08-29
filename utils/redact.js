// utils/redact.js
// ESM. Central redaction helpers for Discord IDs (snowflakes) and objects.
// NOTE: Use ASCII '...' to avoid mojibake (… -> ΓÇª) on some Windows consoles.

import util from "node:util";

const SNOWFLAKE_RE = /\b\d{17,20}\b/g;
const MENTION_RE = /<(@!?|#|@&)(\d{17,20})>/g;

// ASCII-only mask to avoid Unicode ellipsis issues on Windows terminals.
function maskId(id) {
  const s = String(id);
  return `[id:...${s.slice(-4)}]`;
}

export function redactString(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(MENTION_RE, (_m, p1, id) => `<${p1}${maskId(id)}>`)
// Fallback for bare snowflakes in text:
    .replace(SNOWFLAKE_RE, (m) => maskId(m));
}

export function redactObject(value, seen = new WeakSet()) {
  if (value === null) return value;
  const t = typeof value;
  if (t === "string") return redactString(value);
  if (t !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => redactObject(v, seen));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if ((/(\b|_)id$|Id$/.test(k)) && (typeof v === "string" || typeof v === "number")) {
      out[k] = maskId(v);
    } else {
      out[k] = redactObject(v, seen);
    }
  }
  return out;
}

export function inspectRedacted(value) {
  return util.inspect(redactObject(value), { depth: 5, colors: false, compact: true });
}

/**
 * Patches console.* to redact Discord IDs automatically.
 * Safe, no behavior changes besides masking IDs in log output.
 */
export function installConsoleRedaction() {
  const orig = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  for (const level of Object.keys(orig)) {
    console[level] = (...args) => {
      try {
        const redacted = args.map((a) => {
          if (typeof a === "string") return redactString(a);
          if (a instanceof Error) {
            const e = new Error(redactString(a.message));
            e.stack = a.stack ? redactString(String(a.stack)) : undefined;
            return e;
          }
          return inspectRedacted(a);
        });
        orig[level](...redacted);
      } catch {
        // If anything goes wrong, fall back to original args.
        orig[level](...args);
      }
    };
  }
}
