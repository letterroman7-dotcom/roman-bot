// scripts/canonicals-from-diagnostics.cjs (CommonJS)
// Purpose: Generate docs/canonicals.json from your committed diagnostics CSV,
//          choosing the *current* paths as canonical (no code changes).

/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const CSV_PATH = path.join(
  ROOT,
  "docs",
  "diagnostics",
  "2025-09-02",
  "duplicates_by_name.csv"
);
const OUT_DIR = path.join(ROOT, "docs");
const OUT_FILE = path.join(OUT_DIR, "canonicals.json");

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

// Tiny CSV reader (no deps). Assumes first line has headers, no commas inside fields.
function parseCSV(txt) {
  const lines = txt.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const obj = {};
    headers.forEach((h, idx) => (obj[h] = cols[idx] ?? ""));
    rows.push(obj);
  }
  return rows;
}

// Parse the "Paths" column which looks like "['src/utils/logger.js','src/logger.js']"
function parsePathsList(str) {
  if (!str) return [];
  const m = String(str).match(/\[(.*)\]/s);
  if (!m) return [];
  const inside = m[1];
  return inside
    .split(",")
    .map((s) => s.trim())
    .map((s) => s.replace(/^['"]|['"]$/g, "")) // strip surrounding quotes
    .filter(Boolean);
}

function pickCanonical(paths) {
  // Choose the *current* layout as truth: prefer a path under src/, else first entry.
  if (!Array.isArray(paths) || paths.length === 0) return null;
  const srcFirst = paths.find((p) => /^src\//i.test(p));
  return srcFirst || paths[0];
}

function main() {
  const csv = readFileSafe(CSV_PATH);
  if (!csv) {
    console.error(
      `Could not read ${CSV_PATH}. Confirm the diagnostics CSV is committed.`
    );
    process.exit(1);
  }

  const rows = parseCSV(csv);
  const canonicals = {};

  for (const row of rows) {
    const name = row["FileName"] || row["filename"] || row["name"];
    const pathsRaw = row["Paths"] || row["PathList"] || "";
    if (!name) continue;

    const list = parsePathsList(pathsRaw);
    const chosen = pickCanonical(list);
    if (chosen) {
      canonicals[name] = {
        canonical: chosen,
        seen: list, // keep for audit (no behavior change)
      };
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(canonicals, null, 2), "utf8");
  console.log(`Wrote canonical map -> ${OUT_FILE}`);
}

main();
