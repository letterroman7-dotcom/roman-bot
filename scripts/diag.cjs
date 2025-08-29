/* scripts/diag.cjs - safe diagnostics (no Discord connection)
 * - Robustly reads package.json (handles BOM)
 * - Detects --import ./utils/log-hygiene.js in start:discord
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = process.cwd();
const PKG = path.join(ROOT, "package.json");
const CFG = path.join(ROOT, "data", "antinuke-config.json");

function stripBOM(s) { return typeof s === "string" ? s.replace(/^\uFEFF/, "") : s; }
function safeJSONRead(p) {
  try {
    const raw = stripBOM(fs.readFileSync(p, "utf8"));
    return JSON.parse(raw);
  } catch {
    try {
      // Fallback: require can handle JSON + BOM better in CJS
      delete require.cache[p];
      return require(p);
    } catch {
      return null;
    }
  }
}
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function redact(tok) { if (!tok) return undefined; const s = String(tok); return `***redacted***${s.slice(-4)}`; }

function declaredDeps(pkg) {
  return Object.assign({}, (pkg && pkg.dependencies) || {}, (pkg && pkg.devDependencies) || {});
}

function installedVersion(pkgName) {
  try {
    const pkgPath = require.resolve(path.join(pkgName, "package.json"), { paths: [ROOT] });
    const meta = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return meta.version || "";
  } catch { return ""; }
}

const pkg = safeJSONRead(PKG) || {};
const deps = declaredDeps(pkg);
const cfg = safeJSONRead(CFG);

// Versions
const versionsDeclared = { "discord.js": deps["discord.js"] || "", "pino": deps["pino"] || "" };
const versionsInstalled = { "discord.js": installedVersion("discord.js"), "pino": installedVersion("pino") };

// Preload detection from package.json only (npm env isn’t set when running a different script)
const startFromPkg = String((pkg.scripts && pkg.scripts["start:discord"]) || "");
function norm(s) { return s.toLowerCase().replace(/\\/g, "/").replace(/["']/g, "").replace(/\s+/g, " ").trim(); }
const startNorm = norm(startFromPkg);
const preloadRedaction = startNorm.includes("--import") && startNorm.includes("utils/log-hygiene.js");

const flags = {
  preloadRedaction,
  pinoFactoryPresent: exists(path.join(ROOT, "utils", "pino-factory.js")),
  discordWiring: exists(path.join(ROOT, "src", "discord", "run.js"))
};

const info = {
  ok: true,
  ts: Date.now(),
  node: process.version,
  os: { platform: os.platform(), release: os.release(), arch: os.arch() },
  files: {
    ".env": exists(path.join(ROOT, ".env")) ? "present" : "missing",
    "data/feature-flags.json": exists(path.join(ROOT, "data", "feature-flags.json")) ? "present" : "missing",
    "data/antinuke-config.json": exists(CFG) ? "present" : "missing"
  },
  env: { DISCORD_TOKEN: redact(process.env.DISCORD_TOKEN || process.env.BOT_TOKEN) },
  versionsDeclared,
  versionsInstalled,
  antinuke: (cfg ? {
    defaults: { threshold: cfg?.defaults?.threshold ?? 1, weights: cfg?.defaults?.weights || {} },
    guildOverrides: Object.keys(cfg.guilds || {}).length
  } : "not-configured"),
  flags,
  scriptsEcho: { startDiscord_pkg: startFromPkg }
};

console.log(JSON.stringify(info, null, 2));
