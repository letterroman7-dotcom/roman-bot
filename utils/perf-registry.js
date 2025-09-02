// utils/perf-registry.js
// Small, dependency-free perf registry with ring buffers + percentiles.

export class PerfRegistry {
  constructor(limit = 200) {
    this.limit = Math.max(10, limit);
    this.series = new Map(); // name -> number[]
  }
  observe(name, value) {
    if (!Number.isFinite(value)) return;
    const arr = this.series.get(name) || [];
    arr.push(value);
    if (arr.length > this.limit) arr.shift();
    this.series.set(name, arr);
  }
  get(name) {
    const arr = this.series.get(name) || [];
    return arr.slice(); // copy
  }
  stats(name) {
    const arr = this.series.get(name) || [];
    const n = arr.length;
    if (!n) return { n: 0 };
    const sorted = arr.slice().sort((a, b) => a - b);
    const p = (q) => sorted[Math.max(0, Math.min(n - 1, Math.round((q / 100) * (n - 1))))];
    const sum = arr.reduce((a, b) => a + b, 0);
    return {
      n,
      min: sorted[0],
      p50: p(50),
      p90: p(90),
      p95: p(95),
      p99: p(99),
      max: sorted[n - 1],
      avg: sum / n
    };
  }
}

export const perf = new PerfRegistry(300);
