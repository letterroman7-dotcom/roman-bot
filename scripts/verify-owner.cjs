// scripts/verify-owner.cjs
// Owner's deterministic checklist for North Star v1:
//
// - AntiNuke threshold flips when expected
// - ThresholdNotifier emits "would-lockdown" on first crossing (rising edge)
// - ThresholdNotifier emits "recovered" when falling below
//
// Windows-safe dynamic imports via file:// URLs.
// Exits 0 on success, non-zero on any mismatch. Prints a JSON report.

const path = require("path");
const { pathToFileURL } = require("url");

function importFile(relPath) {
  const abs = path.resolve(relPath);
  const url = pathToFileURL(abs).href; // Windows-safe ESM URL
  return import(url);
}

(async function main() {
  try {
    const { AntiNukeService, DEFAULT_CONFIG } = await importFile("modules/antinuke/service.js");
    const { ThresholdNotifier } = await importFile("modules/antinuke/threshold-notifier.js");

    // Use tiny window for quick deterministic test
    const testCfg = {
      ...DEFAULT_CONFIG,
      windowMs: 500, // 0.5s window
      threshold: 1.0,
      scorePerEvent: {
        channelDelete: 0.5,
        roleDelete: 0.5
      }
    };

    // Mock clock to avoid timers
    let now = Date.now();
    const nowFn = () => now;

    /** Collect notifier outputs */
    const logs = [];
    const fakeLog = {
      info: (payload, msg) => logs.push({ level: "info", payload, msg }),
      warn: (payload, msg) => logs.push({ level: "warn", payload, msg }),
      error: (payload, msg) => logs.push({ level: "error", payload, msg })
    };

    const anti = new AntiNukeService(testCfg, undefined, nowFn);
    const notifier = new ThresholdNotifier();

    const report = {
      ok: true,
      ts: Date.now(),
      steps: [],
      emitted: []
    };

    function step(name, cond, extra = {}) {
      report.steps.push({ name, ok: !!cond, ...extra });
      if (!cond) report.ok = false;
    }

    // Step 1: baseline below threshold
    let status = anti.status();
    step("baseline-below-threshold", status.score === 0 && status.triggered === false, { status });

    // Step 2: +0.5 below threshold
    anti.record("channelDelete", 1);
    status = anti.status();
    notifier.checkAndLog({ log: fakeLog, guildId: "test-guild", status });
    step("after-0.5-below", status.score === 0.5 && status.triggered === false, { status });

    // Step 3: cross threshold (==1.0)
    anti.record("roleDelete", 1);
    status = anti.status();
    notifier.checkAndLog({ log: fakeLog, guildId: "test-guild", status });
    step("cross-threshold", status.score >= 1.0 && status.triggered === true, { status });

    // Expect a single "would-lockdown"
    const lockdownLogs = logs.filter(
      (l) => l.level === "warn" && l.payload?.evt === "antinuke.threshold" && l.payload?.action === "would-lockdown"
    );
    step("would-lockdown-emitted", lockdownLogs.length === 1, { lockdownLogsCount: lockdownLogs.length });

    // Step 4: advance time beyond window to recover
    now += 1000; // > 500ms
    status = anti.status();
    notifier.checkAndLog({ log: fakeLog, guildId: "test-guild", status });
    step("recovered-below", status.score === 0 && status.triggered === false, { status });

    // Expect a single "recovered"
    const recoveredLogs = logs.filter(
      (l) => l.level === "info" && l.payload?.evt === "antinuke.threshold.clear" && l.payload?.action === "recovered"
    );
    step("recovered-emitted", recoveredLogs.length === 1, { recoveredLogsCount: recoveredLogs.length });

    // Output
    report.emitted = logs;
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: String(err && err.message || err) }, null, 2));
    process.exitCode = 1;
  }
})();
