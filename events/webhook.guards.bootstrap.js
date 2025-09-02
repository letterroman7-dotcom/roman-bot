// src/discord/events/webhook.guards.bootstrap.js
// Purpose: Ensure the three webhook guard event files are actually wired.
// Safe: idempotent (won't double-register), zero changes to existing modules.

import createLogger from "../../../utils/pino-factory.js";
import wireWebhookCreateGuard from "./webhookCreate.guard.js";
import wireWebhookUpdateGuard from "./webhookUpdate.guard.js";
import wireWebhookDeleteGuard from "./webhookDelete.guard.js";

const log = createLogger("webhook.guards.bootstrap");

// Unique symbol on the client to prevent double wiring
const FLAG = Symbol.for("roman.webhookGuardsWired");

export default function wireWebhookGuardsBootstrap(client) {
  if (!client) return;

  // Idempotency: if we've already wired on this client, bail
  if (client[FLAG]) return;
  Object.defineProperty(client, FLAG, { value: true, enumerable: false });

  // Wire the three guards
  wireWebhookCreateGuard(client);
  wireWebhookUpdateGuard(client);
  wireWebhookDeleteGuard(client);

  // Breadcrumb so you can see this file is active on boot
  client.once?.("ready", () => {
    log.info("webhook.guards bootstrap active (create/update/delete wired)");
  });
}
