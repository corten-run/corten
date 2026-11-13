import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, relative, extname, isAbsolute, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { cpus, platform, release } from "node:os";
import { chromium } from "playwright";
import { selectedApps, definition } from "../workloads/registry.mjs";
import { createClientWorkload, clientCaptureSchema, validateClientCapture } from "../workloads/client.mjs";
import { buildApps, root, here, sha256 } from "./build.mjs";
import { installObserver } from "./observer.mjs";

export const schema = "client-heavy-native/v1";
export function options(args) {
  const [round, ...rest] = args;
  assert.match(round ?? "", /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, "explicit safe round argument required");
  const values = { rows: 14, large: 110, append: 7, cards: 24, seed: 7, "cleanup-ms": 2000, "observation-ms": 100, "timeout-ms": 30000, cargo: "cargo", out: join(here, "work", round) };
  const seen = new Set();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, "");
    assert.ok(rest[i].startsWith("--") && Object.hasOwn(values, key) && rest[i + 1] !== undefined && !seen.has(key), "unknown, missing or duplicate option");
    seen.add(key);
    values[key] = ["out", "cargo"].includes(key) ? rest[i + 1] : Number(rest[i + 1]);
  }
  for (const key of ["cleanup-ms", "observation-ms", "timeout-ms"]) assert.ok(Number.isSafeInteger(values[key]) && values[key] > 0 && values[key] <= 120000, `invalid ${key}`);
  assert.ok(values["timeout-ms"] > values["observation-ms"] + values["cleanup-ms"], "journey timeout must exceed cleanup bounds");
  const workload = createClientWorkload({ seed: values.seed, rowCount: values.rows, largeRowCount: values.large, appendCount: values.append, dashboardCount: values.cards });
  return { round, out: resolve(values.out), cargo: values.cargo, timeoutMs: values["timeout-ms"], settings: { maxCleanupMs: values["cleanup-ms"], cleanupObservationMs: values["observation-ms"] }, workload };
}

export async function serve(directory) {
  const base = resolve(directory);
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, "http://local").pathname);
      const file = resolve(base, "." + (path.endsWith("/") ? `${path}index.html` : path));
      const rel = relative(base, file);
      if (rel.startsWith("..") || isAbsolute(rel)) return res.writeHead(403).end();
      const body = await readFile(file);
      res.writeHead(200, { "content-type": ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json" })[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((ok, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", ok); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((ok) => { server.close(ok); server.closeAllConnections(); }) };
}

// This function is evaluated by Playwright. It drives the real DOM's controls, never a reducer.
export async function dispatchOperation({ op, measure }) {
  const o = window.clientObserver, start = measure ? performance.now() : null;
  if (op.kind === "filter") {
    const input = document.getElementById("filter");
    if (!input || input.disabled) throw new Error("native-control-missing");
    if (!o.visible(input)) throw new Error("native-control-not-visible");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, op.text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    const selector = op.kind === "select" ? `[data-select="${op.key}"]` : op.kind === "remove" ? `[data-remove="${op.key}"]`
      : op.kind === "sort" ? `#sort-${op.direction}` : op.kind === "tick" ? (op.count === o.loaded().cards.length ? "#tick-all" : "#tick-small") : `#${op.kind}`;
    const control = document.querySelector(selector);
    if (!control || control.disabled) throw new Error("native-control-missing");
    if (!o.visible(control)) throw new Error("native-control-not-visible");
    control.click();
  }
  await o.settle();
  return { elapsedMs: measure ? performance.now() - start : null, dom: o.dom(), at: o.now() };
}

export async function journey(browser, url, app, workload, settings, timeoutMs, testHook, measure = false) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, serviceWorkers: "block" });
  const page = await context.newPage(), records = [], actions = [], requests = [], errors = [];
  let observing = false, networkAt = 0, apiAt = 0, phase = "load", readyMs = null;
  const timer = setTimeout(() => context.close().catch(() => {}), timeoutMs);
  page.setDefaultTimeout(Math.min(timeoutMs, 10000));
  page.setDefaultNavigationTimeout(Math.min(timeoutMs, 10000));
  context.on("request", (request) => { if (observing) requests.push({ transport: "http", method: request.method(), resourceType: request.resourceType() }); });
  page.on("websocket", () => { if (observing) requests.push({ transport: "websocket" }); });
  page.on("pageerror", (error) => errors.push({ kind: "pageerror", name: error.name, sha256: sha256(error.message) }));
  page.on("console", (msg) => { if (msg.type() === "error") errors.push({ kind: "console-error", sha256: sha256(msg.text()) }); });
  const network = async () => {
    const api = await page.evaluate(() => window.clientObserver.network);
    const result = requests.slice(networkAt).concat(api.slice(apiAt)); networkAt = requests.length; apiAt = api.length;
    return result;
  };
  try {
    await page.addInitScript(installObserver);
    await page.goto(`${url}/${app}/`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => typeof window.clientMount === "function");
    records.push(await page.evaluate(() => window.clientObserver.begin()));
    const start = await page.evaluate(() => { const start = performance.now(); window.clientMount(); return start; });
    phase = "readiness";
    await page.waitForFunction(() => document.getElementById("screen") && window.clientObserver.owned().subscriptions > 0);
    const initial = await page.evaluate(async () => { const o = window.clientObserver; await o.settle(); return { kind: "initial", at: o.now(), data: o.loaded(), dom: o.dom(), readyAt: performance.now() }; });
    readyMs = initial.readyAt - start; delete initial.readyAt;
    records.push({ ...initial, errors: [...errors] });
    records.push(await page.evaluate(() => ({ kind: "resources", at: window.clientObserver.now(), owned: window.clientObserver.owned() })));
    assert.equal(initial.dom.rows.length, workload.rowCount, "initial loaded row count");
    assert.equal(initial.dom.cards.length, workload.dashboardCount, "initial loaded card count");
    assert.ok(records.at(-1).owned.subscriptions > 0, "real active subscription required");
    observing = true;
    if (testHook) await testHook(page);
    for (const operation of workload.operations) {
      phase = operation.id;
      const result = await page.evaluate(dispatchOperation, { op: operation, measure });
      if (measure) actions.push({ operation: operation.id, kind: operation.kind, elapsedMs: result.elapsedMs });
      records.push({ kind: "operation", at: result.at, operation, dom: result.dom, network: await network(), errors: [...errors] });
    }
    phase = "detach";
    records.push(await page.evaluate(() => ({ kind: "detach", at: window.clientObserver.now() })));
    await page.evaluate(async () => { await window.clientDetach(); await window.clientObserver.settle(); });
    assert.equal(await page.evaluate(() => window.clientObserver.detached()), true, "native unmount must detach screen");
    records.push(await page.evaluate(() => ({ kind: "resources", at: window.clientObserver.now(), owned: window.clientObserver.owned() })));
    phase = "cleanup-probe";
    const probeAt = await page.evaluate((input) => { window.clientProbe(input.count); return window.clientObserver.now(); }, workload.cleanupProbe);
    records.push({ kind: "cleanup-probe", at: probeAt, input: workload.cleanupProbe, network: await network() });
    await page.evaluate(async (ms) => { await window.clientObserver.wait(ms); await window.clientObserver.settle(); }, settings.cleanupObservationMs);
    records.push(await page.evaluate(() => ({ kind: "resources", at: window.clientObserver.now(), owned: window.clientObserver.owned() })));
    const final = await page.evaluate(() => ({ kind: "state", at: window.clientObserver.now(), dom: window.clientObserver.dom(), owned: window.clientObserver.owned() }));
    records.push({ ...final, network: await network(), errors: [...errors] });
    const capture = { schema: clientCaptureSchema, app, effectiveWorkload: workload, outcome: "captured", reason: null, records };
    phase = "oracle";
    const oracle = validateClientCapture(workload, capture, settings);
    return { capture, oracle, readyMs, actions: measure ? actions : null, resourceDetails: await page.evaluate(() => window.clientObserver.listenerDetails()), failure: null };
  } catch (error) {
    const capture = { schema: clientCaptureSchema, app, effectiveWorkload: workload, outcome: "failed", reason: `native-${phase}-failed`, records: null };
    return { capture, oracle: validateClientCapture(workload, capture, settings), readyMs: null, actions: null,
      failure: { phase, diagnostic: error.message.startsWith("client contract:") ? error.message : error.name, diagnosticSha256: sha256(String(error)), records, errors } };
  } finally { clearTimeout(timer); await context.close(); }
}

export async function qualifyAndMeasure(capture) {
  const qualification = await capture("qualification");
  if (!qualification.oracle.functionalPassed) return { qualification, measurement: null, readyForMeasurement: false };
  const measurement = await capture("measurement");
  return { qualification, measurement, readyForMeasurement: !!measurement.oracle.functionalPassed };
}

export async function finishRun(output, out, { browser, server, interruptCleanup, isInterrupted }) {
  output.cleanupFailures = [];
  for (const [resource, close] of [["browser-interrupt", () => interruptCleanup], ["browser", () => browser?.close()], ["server", () => server?.close()]]) {
    try { await close(); }
    catch (error) { output.cleanupFailures.push({ resource, name: error.name, diagnosticSha256: sha256(String(error)) }); }
  }
  const interrupted = isInterrupted();
  if (interrupted || output.cleanupFailures.length) output.passed = false;
  for (const app of output.selectedApps) output.cells[app] ??= { outcome: "not-run", reason: interrupted ? "native-runner-interrupted" : "runner-failed-before-adapter", qualification: null, measurement: null, readyForMeasurement: false };
  await writeFile(join(out, "result.json"), JSON.stringify(output, null, 2) + "\n");
}

export async function run(args) {
  const config = options(args);
  // Refuse reuse: stale artifacts must never become evidence for this invocation.
  await mkdir(dirname(config.out), { recursive: true });
  await mkdir(config.out, { recursive: false });
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const sourcePaths = ["bench/client-heavy/run.mjs", "bench/client-heavy/build.mjs", "bench/client-heavy/observer.mjs", "bench/workloads/client.mjs", "bench/workloads/registry.mjs", "bench/browser/package-lock.json", "package-lock.json", "bench/browser/gen/Cargo.toml", "bench/browser/gen/src/bin/client.rs",
    ...git("ls-files", "crates").split("\n")].filter(Boolean);
  const sources = Object.fromEntries(await Promise.all([...new Set(sourcePaths)].sort().map(async (path) => [path, sha256(await readFile(join(root, path)))])));
  const provenance = { commit: git("rev-parse", "HEAD"), dirty: !!git("status", "--porcelain"), sources, diffSha256: sha256(git("diff", "HEAD", "--", "bench/browser", "bench/client-heavy", "crates")),
    node: process.version, platform: platform(), release: release(), cpu: cpus()[0]?.model ?? "unknown", logicalCpus: cpus().length,
    browser: null, browserInstances: 1, rendererProcessLimit: 1, concurrentPages: 1, passes: 2, note: "Bounded local verification on an uncontrolled host; no throughput or ranking claim. No OS CPU or memory isolation." };
  const output = { schema, group: "client-heavy", round: config.round, effectiveWorkload: config.workload, settings: config.settings, timeoutMs: config.timeoutMs, provenance,
    selectedApps: selectedApps("client-heavy"), definition: definition("client-heavy"), builds: null, cells: {}, passed: false, readyForLoad: false };
  let server, browser, interrupted = false, interruptCleanup;
  const interrupt = () => {
    interrupted = true;
    interruptCleanup ??= browser && Promise.resolve().then(() => browser.close());
    // Handle the rejection immediately, but retain it for final cleanup evidence.
    interruptCleanup?.catch(() => {});
  };
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  try {
    const nativeDirectory = join(config.out, "native");
    // Receipts and self-consistent hashes cannot prove which framework produced a
    // bundle. Compile the native sources in this invocation, including the Rust generator.
    output.builds = await buildApps(config.workload, nativeDirectory, config.cargo);
    assert.ok(!interrupted, "native-runner-interrupted");
    server = await serve(nativeDirectory);
    browser = await chromium.launch({ headless: true, args: ["--renderer-process-limit=1"] });
    assert.ok(!interrupted, "native-runner-interrupted");
    provenance.browser = browser.version();
    for (const app of output.selectedApps) {
      assert.ok(!interrupted, "native-runner-interrupted");
      if (output.builds[app].outcome !== "built") {
        output.cells[app] = { outcome: "failed", reason: "native-build-failed", qualification: null, measurement: null, readyForMeasurement: false };
      } else {
        const result = await qualifyAndMeasure((phase) => journey(browser, server.url, app, config.workload, config.settings, config.timeoutMs, undefined, phase === "measurement"));
        output.cells[app] = { outcome: result.readyForMeasurement ? "passed" : "failed", ...result };
      }
      await writeFile(join(config.out, `${app}.json`), JSON.stringify(output.cells[app], null, 2) + "\n");
      console.log(`${app}: ${output.cells[app].outcome}`);
    }
    output.passed = output.selectedApps.every((app) => output.cells[app].outcome === "passed");
  } catch (error) {
    output.failure = { reason: interrupted ? "native-runner-interrupted" : "runner-failed", name: error.name, diagnosticSha256: sha256(String(error)) };
  } finally {
    try {
      await finishRun(output, config.out, { browser, server, interruptCleanup, isInterrupted: () => interrupted });
    } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
  }
  return output;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = await run(process.argv.slice(2)); process.exitCode = result.passed ? 0 : 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
