// utils/logger.pino.js
// Compatibility shim for older imports that expected getLogger(...).
// Delegates to the shared pino factory and returns a Promise for backward-compat.

import createLogger from "./pino-factory.js";

/** @returns {Promise<import('pino').Logger>} */
export async function getLogger(name = "roman-bot") {
  // If you ever need async setup (e.g., transports), do it here.
  return createLogger(name);
}

export default getLogger;
