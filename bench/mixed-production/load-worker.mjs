import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { chromium } from "@playwright/test";
import { control, sleep } from "./capture.mjs";
import { loadCycle } from "./load-capture.mjs";
import { nativeTransport } from "./native.mjs";
import { reconcileLedger, upstreamManifest, upstreamPhase } from "./upstream-ledger.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { folder, seconds, tailSeconds, maxCycles, upstream, settings } = config, token = process.env.MIXED_CONTROL_TOKEN;
const save = (path, value) => { writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2)); renameSync(`${path}.tmp`, path); };
const result = { schema: "mixed-native-window/v1", app: config.app, source: config.source, seconds, cycles: [], complete: false, failure: null };
let browser, watchdog;
const phases = [];
try {
  browser = await chromium.launch({ headless: true });
  async function cycleCapture(cycle, phase, now) {
    const dir = join(folder, `${phase}_${cycle}`); mkdirSync(dir);
    const transport = await nativeTransport({ browser, base: config.base, readbackPath: config.readbackPath, settings });
    const idFor = (id) => `${phase}_${cycle}_${id}`;
    try {
      const captured = await loadCycle({ ...config, transport, now,
        injector: { begin: (id, mode, delayMs, path) => control(upstream, token, idFor(id), { mode, delayMs, path }), read: (id) => control(upstream, token, idFor(id)) },
        save: async (request, value) => save(join(dir, `${request.id}.json`), value),
      });
      phases.push(upstreamPhase(phase, cycle, captured.capture, config.source));
      save(join(dir, "capture.json"), captured); return captured;
    } finally { await transport.close(); }
  }
  const warmStart = performance.now(), warmup = { cycles: 0, elapsedMs: 0, passed: true };
  while (performance.now() - warmStart < config.warmup * 1000 && warmup.cycles < maxCycles) {
    const captured = await cycleCapture(warmup.cycles++, "warmup", () => performance.now() - warmStart);
    if (!captured.passed) { warmup.passed = false; break; }
  }
  warmup.elapsedMs = performance.now() - warmStart; result.warmup = warmup;
  save(join(folder, "warmup.json"), warmup);
  if (!warmup.passed || warmup.elapsedMs < config.warmup * 1000) throw new Error("native warmup failed or exhausted cycle budget");
  save(join(folder, "ready.json"), { ready: true });
  while (!existsSync(join(folder, "go.json"))) await sleep(10);
  watchdog = setTimeout(() => { result.failure = "window-tail-budget-exceeded"; save(join(folder, "window.json"), result); process.exit(2); }, (seconds + tailSeconds + 5) * 1000);
  const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
  const epoch = performance.now(); result.startedUnixMs = Date.now(); result.startedAt = new Date(result.startedUnixMs).toISOString();
  const now = () => performance.now() - epoch;
  while (now() < seconds * 1000 && result.cycles.length < maxCycles) {
    const cycle = result.cycles.length, captured = await cycleCapture(cycle, "cycle", now);
    result.cycles.push({ cycle, passed: captured.passed, operations: captured.operations, oracle: captured.oracle });
    save(join(folder, "window.json"), result);
    if (!captured.passed) { result.failure = "native-load-semantics-failed"; break; }
    if (now() > (seconds + tailSeconds) * 1000) { result.failure = "window-tail-budget-exceeded"; break; }
  }
  result.elapsedMs = now(); result.finishedUnixMs = Date.now(); result.finishedAt = new Date(result.finishedUnixMs).toISOString();
  lag.disable(); result.eventLoopLagP99Ms = lag.percentile(99) / 1e6;
  if (result.elapsedMs < seconds * 1000) result.failure ??= "cycle-budget-exhausted-before-window-end";
} catch { result.failure ??= "native-window-execution-failed"; }
finally {
  try { await browser?.close(); } catch { result.failure ??= "native-browser-close-failed"; }
  try {
    await control(upstream, token, "seal", { action: "seal" });
    await sleep(settings.cleanupMs);
    const ledger = await control(upstream, token, "ledger");
    save(join(folder, "upstream-ledger.json"), ledger);
    result.upstreamReconciliation = reconcileLedger(ledger, upstreamManifest(config.plan, config.source, config.startupObservation, phases));
    result.orphans = ledger.orphans;
    if (!result.upstreamReconciliation.valid) result.failure ??= "final-native-upstream-reconciliation-failed";
  } catch { result.failure ??= "final-native-upstream-ledger-unavailable"; }
  clearTimeout(watchdog);
  result.complete = !result.failure && result.cycles.length > 0 && result.cycles.every((c) => c.passed);
  result.finishedAt ??= new Date().toISOString(); save(join(folder, "window.json"), result);
}
if (!result.complete) process.exitCode = 1;
else await new Promise(() => { setInterval(() => {}, 1000); }); // Keep the owned cgroup alive for the host's final CPU read.
