// scripts/guard-duplicates.cjs (CommonJS)
// Purpose: Prevent NEW duplicate files appearing outside chosen canonicals.
// Behavior: Reads docs/canonicals.json; fails if a filename exists in other locations.
// Usage:    node scripts/guard-duplicates.cjs

/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const CANON = path.join(ROOT, "docs", "canonicals.json");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function walk(dir, acc) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(ROOT, full).replace(/\\/g, "/");

    // Skip known excludes
    if (
      rel.startsWith("node_modules/") ||
      rel.startsWith(".git/") ||
      rel.startsWith("dist/") ||
      rel.startsWith("docs/diagnostics/")
    ) {
      continue;
    }

    if (e.isDirectory()) walk(full, acc);
    else acc.push(rel);
  }
  return acc;
}

function main() {
  if (!fs.existsSync(CANON)) {
    console.error(
      "Missing docs/canonicals.json. Run: node scripts/canonicals-from-diagnostics.cjs"
    );
    process.exit(1);
  }

  const map = readJson(CANON); // { "logger.js": { canonical, seen } ... }
  const files = walk(ROOT, []);

  // Build index by filename
  const byName = new Map();
  for (const rel of files) {
    const name = path.basename(rel);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(rel);
  }

  const problems = [];
  for (const [name, meta] of Object.entries(map)) {
    const canonical = meta.canonical;
    const seen = byName.get(name) || [];
    const offenders = seen.filter((p) => p !== canonical);
    if (offenders.length > 0) {
      problems.push({ name, canonical, offenders });
    }
  }

  if (problems.length > 0) {
    console.error("❌ Duplicate guard failed. These files exist outside canonicals:\n");
    for (const p of problems) {
      console.error(`- ${p.name}`);
      console.error(`  canonical: ${p.canonical}`);
      for (const off of p.offenders) console.error(`  offender : ${off}`);
      console.error("");
    }
    console.error(
      "Fix: remove/move offenders or update docs/canonicals.json if you intentionally changed canonical locations."
    );
    process.exit(1);
  }

  console.log("✅ Duplicate guard passed. No offenders outside canonicals.");
}

main();
