// scripts/guard-dist.cjs (CommonJS)
// Purpose: Ensure build artifacts only live where they should (no wrong-folder dupes).
// Behavior: Example check for server.js under dist/src/http/server.js vs dist/http/server.js
// Usage:    node scripts/guard-dist.cjs

/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const DIST = path.join(ROOT, "dist");

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function main() {
  if (!exists(DIST)) {
    console.log("dist/ does not exist; skipping dist guard.");
    return;
  }

  const problems = [];

  // Example guard: keep only dist/src/http/server.js (adjust/add more checks later if needed)
  const proper = path.join("dist", "src", "http", "server.js");
  const wrong1 = path.join("dist", "http", "server.js");

  if (exists(path.join(ROOT, proper)) && exists(path.join(ROOT, wrong1))) {
    problems.push({
      reason: "Duplicate compiled artifact",
      keep: proper.replace(/\\/g, "/"),
      rm: wrong1.replace(/\\/g, "/"),
    });
  }

  if (problems.length > 0) {
    console.error("❌ dist guard failed:");
    for (const p of problems) {
      console.error(`- ${p.reason}`);
      console.error(`  keep: ${p.keep}`);
      console.error(`  rm  : ${p.rm}`);
    }
    process.exit(1);
  }

  console.log("✅ dist guard passed.");
}

main();
