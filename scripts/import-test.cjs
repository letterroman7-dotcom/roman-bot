#!/usr/bin/env node
/* scripts/import-test.cjs
   Usage: node scripts/import-test.cjs src/discord/wire-mass-actions.js
*/
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const input = process.argv[2];
if (!input) {
  console.error("usage: node scripts/import-test.cjs <relative-or-absolute-path-to-esm-file>");
  process.exit(1);
}
const abs = path.isAbsolute(input) ? input : path.join(process.cwd(), input);
const url = pathToFileURL(abs).href;

console.log(JSON.stringify({ abs, exists: fs.existsSync(abs), url }, null, 2));

import(url)
  .then((m) => {
    console.log("OK imports:", Object.keys(m));
  })
  .catch((e) => {
    console.error("ERR code:", e && e.code);
    console.error("ERR message:", e && e.message);
    console.error("----- STACK -----");
    console.error(String(e && e.stack || e));
    process.exitCode = 1;
  });
