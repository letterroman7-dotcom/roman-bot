// scripts/env-check.cjs
// Health/Env check for Roman Bot v1 (North Star) with traceability:
// - .env + DISCORD_TOKEN presence (redacted)
// - feature flags shape
// - versions (discord.js, pino)
// - git commit (short) and OS info

const fs = require("fs");
const path = require("path");
const os = require("os");
const cp = require("child_process");

function fileExists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function readJSONSafe(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function redactToken(t) { if (!t || typeof t !== "string") return "(missing)"; const tail = t.slice(-4); return `***redacted***${tail}`; }

function readPkgVersion(depName, root) {
  try {
    const pkgPath = require.resolve(path.join(depName, "package.json"), { paths: [root] });
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return pkg.version || "(unknown)";
  } catch { return "(not installed)"; }
}

function gitShortCommit(root) {
  try {
    return cp.execSync("git rev-parse --short HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch { return "(not a git repo)"; }
}

const root = process.cwd();
const result = {
  ok: true,
  ts: Date.now(),
  node: process.version,
  os: {
    platform: os.platform(),
    release: os.release(),
    arch: process.arch
  },
  git: {
    commit: gitShortCommit(root)
  },
  files: {},
  env: {},
  flags: {},
  versions: {}
};

// .env and token
const envPath = path.join(root, ".env");
result.files[".env"] = fileExists(envPath) ? "present" : "missing";
let discordToken = null;
if (fileExists(envPath)) {
  try {
    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const m = /^DISCORD_TOKEN\s*=\s*(.+)$/.exec(line.trim());
      if (m) { discordToken = m[1]; break; }
    }
  } catch {}
}
const hasToken = Boolean(discordToken && discordToken.trim().length > 0);
result.env.DISCORD_TOKEN = hasToken ? redactToken(discordToken.trim()) : "(missing)";
if (!hasToken) result.ok = false;

// feature flags
const flagsPath = path.join(root, "data", "feature-flags.json");
result.files["data/feature-flags.json"] = fileExists(flagsPath) ? "present" : "missing";
const flags = readJSONSafe(flagsPath);
if (!flags || typeof flags.discordWiring !== "boolean") {
  result.flags.discordWiring = "(invalid or missing)";
  result.ok = false;
} else {
  result.flags.discordWiring = flags.discordWiring;
}

// versions
result.versions["discord.js"] = readPkgVersion("discord.js", root);
result.versions["pino"] = readPkgVersion("pino", root);

// output
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
