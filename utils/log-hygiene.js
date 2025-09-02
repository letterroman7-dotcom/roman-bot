// utils/log-hygiene.js
// Loaded via: node --import "./utils/log-hygiene.js"
// Goal: kill the discord.js v15 "ready" deprecation without touching app code.
// Approach: always remap .on/.once('ready', ...) → ('clientReady', ...) on Client.

try {
  const mod = await import("discord.js");

  // If discord.js is present, patch its Client prototype.
  const Client = mod?.Client;
  if (Client && !Client.prototype.__rbReadyPatched) {
    const wrap = (orig) =>
      function patched(event, ...args) {
        // Remap legacy 'ready' registrations to 'clientReady' (new name in v15).
        if (event === "ready") event = "clientReady";
        return orig.call(this, event, ...args);
      };

    Client.prototype.on = wrap(Client.prototype.on);
    Client.prototype.once = wrap(Client.prototype.once);
    Object.defineProperty(Client.prototype, "__rbReadyPatched", { value: true });

    // Optional: also remap removeListener/off so cleanup still works if code uses 'ready'
    const wrapRemove = (orig) =>
      function patched(event, ...args) {
        if (event === "ready") event = "clientReady";
        return orig.call(this, event, ...args);
      };
    if (Client.prototype.removeListener) Client.prototype.removeListener = wrapRemove(Client.prototype.removeListener);
    if (Client.prototype.off)            Client.prototype.off            = wrapRemove(Client.prototype.off);
  }
} catch {
  // If discord.js isn't installed/loaded yet, ignore silently.
}

// You can put other hygiene toggles here if you like:
// Example: longer stack traces
// Error.stackTraceLimit = Math.max(Error.stackTraceLimit ?? 10, 50);
