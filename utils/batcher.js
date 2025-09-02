// utils/batcher.js
// Tiny time-window batcher: accumulate items per key, flush on timer or max.

export class Batcher {
  constructor({ windowMs = 2500, max = 25 } = {}) {
    this.windowMs = Number(windowMs);
    this.max = Number(max);
    this.map = new Map(); // key -> { items: [], timer }
  }

  add(key, item, onFlush) {
    let entry = this.map.get(key);
    if (!entry) {
      entry = { items: [], timer: null };
      this.map.set(key, entry);
      entry.timer = setTimeout(() => this.flush(key, onFlush), this.windowMs);
    }
    entry.items.push(item);
    if (entry.items.length >= this.max) {
      this.flush(key, onFlush);
    }
  }

  flush(key, onFlush) {
    const entry = this.map.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.map.delete(key);
    try { onFlush?.(key, entry.items); } catch {}
  }

  flushAll(onFlush) {
    for (const key of [...this.map.keys()]) this.flush(key, onFlush);
  }
}

export default Batcher;
