// cli/cli.js
// Simple JSON CLI for Roman Bot.
// Usage:
//   node cli/cli.js ping
//   node cli/cli.js antinuke status [--guild <id>]
//   node cli/cli.js antinuke simulate <eventType> <count> [--guild <id>]
//
// Valid eventType:
//   channelDelete, roleDelete, webhookDelete,
//   guildBanAdd, emojiDelete,
//   guildUpdate, roleUpdate,
//   channelCreate, roleCreate, webhookCreate
//
// Notes:
// - Per-guild overrides are applied when you pass --guild <id>.
// - Without --guild, the CLI uses a process-wide default guild id ("cli-default").
// - Output is machine-friendly JSON to stdout; errors go to stderr with exitCode=1.

import "dotenv/config";
import { AntiNukeDirector } from "../modules/antinuke/director.js";

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function fail(msg, extra = {}) {
  const out = { ok: false, error: msg, ...extra };
  process.stderr.write(JSON.stringify(out, null, 2) + "\n");
  process.exitCode = 1;
}

function parseArgs(argv = process.argv.slice(2)) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        const key = a.slice(2, eq);
        const val = a.slice(eq + 1);
        flags[key] = val;
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (a.startsWith("-")) {
      // short flags not used; treat as positional for simplicity
      positional.push(a);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function usage() {
  return `
Usage:
  node cli/cli.js ping
  node cli/cli.js antinuke status [--guild <id>]
  node cli/cli.js antinuke simulate <eventType> <count> [--guild <id>]

Examples:
  node cli/cli.js ping
  node cli/cli.js antinuke status --guild 123456789012345678
  node cli/cli.js antinuke simulate channelDelete 2 --guild 123456789012345678
`;
}

async function main() {
  const { positional, flags } = parseArgs();
  const cmd = positional[0];

  if (!cmd) {
    fail("Missing command. See usage.", { usage: usage().trim() });
    return;
  }

  // Single director per process; applies per-guild overrides.
  const director = new AntiNukeDirector();

  if (cmd === "ping") {
    print({ ok: true, cmd: "ping", node: process.version, ts: Date.now() });
    return;
  }

  if (cmd === "antinuke") {
    const sub = positional[1];
    const guildId = String(flags.guild || "cli-default");

    const svc = director.forGuild(guildId);

    if (sub === "status") {
      const s = svc.status();
      print({ ok: true, cmd: "antinuke status", guildId, ...s });
      return;
    }

    if (sub === "simulate") {
      const eventType = positional[2];
      const countRaw = positional[3];

      if (!eventType) {
        fail("Missing <eventType> for simulate.", { usage: usage().trim() });
        return;
      }
      if (!countRaw || Number.isNaN(Number(countRaw))) {
        fail("Missing or invalid <count> for simulate.", { usage: usage().trim() });
        return;
      }

      try {
        const status = svc.simulate(eventType, Number(countRaw));
        print({
          ok: true,
          cmd: "antinuke simulate",
          guildId,
          eventType,
          count: Number(countRaw),
          ...status
        });
        return;
      } catch (err) {
        fail(`Unsupported eventType: ${eventType}`, {
          supported: svc.supportedEvents(),
        });
        return;
      }
    }

    fail("Unknown antinuke subcommand. See usage.", { usage: usage().trim() });
    return;
  }

  fail("Unknown command. See usage.", { usage: usage().trim() });
}

main().catch((err) => {
  fail("CLI crashed", { err: String(err && err.stack) });
});
