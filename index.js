// index.js
// CLI entry splash. Uses the shared pino factory (no top-level await needed).

import createLogger from "./utils/pino-factory.js";

const log = createLogger("roman-bot");
log.info('Roman Bot v1 (North Star) is CLI-first. Try: node cli/cli.js --help');
