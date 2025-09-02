// utils/discord-ready.js
export function onceClientReady(client, fn) {
  let fired = false;
  const wrap = (...a) => { if (fired) return; fired = true; fn(...a); };
  client.once?.("clientReady", wrap);  // works on v15+
  client.once?.("ready", wrap);        // harmless on v14; our shim remaps on v15
}
