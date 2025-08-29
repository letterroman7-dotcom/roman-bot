// utils/pino-factory.js
// Pino logger with privacy-by-design redaction of IDs in structured logs.

import pino from "pino";
import { redactObject } from "./redact.js";

/**
 * Create a pino logger that masks Discord IDs in any logged object fields.
 * Example: { id: "1407860488695709737" } -> { id: "[id:…9737]" }
 */
export function createLogger(name = "app") {
  return pino({
    name,
    // Ensure objects are passed through our redactor before serialization
    formatters: {
      level(label) {
        return { level: label };
      },
      log(obj) {
        try {
          return redactObject(obj);
        } catch {
          return obj;
        }
      }
    }
  });
}

export default createLogger;
