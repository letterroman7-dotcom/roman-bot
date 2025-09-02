// utils/trace-id.js
// Tiny helper to correlate related security log lines.
export function newTraceId(prefix = "inc") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
