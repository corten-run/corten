import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { join, resolve, relative, extname, isAbsolute, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { cpus, platform, release } from "node:os";
import { selectedApps, definition } from "../workloads/registry.mjs";
import { clientCaptureSchema, validateClientCapture } from "../workloads/client.mjs";
import { buildApps, root, here, sha256 } from "./build.mjs";
import { installObserver } from "./observer.mjs";
import { Evidence, closeObserved, clock, json, failure } from "./evidence.mjs";
import { options, configurationNames } from "./contract.mjs";
import { launchBrowser, browserIdentity } from "./launch.mjs";
export { options, defaults } from "./contract.mjs";

export const schema = "client-heavy-native/v2";

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
  let closed = false;
  server.once("close", () => { closed = true; });
  return { url: `http://127.0.0.1:${server.address().port}`, isClosed: () => closed && !server.listening,
    close: () => new Promise((ok, reject) => { server.close((error) => error ? reject(error) : ok()); server.closeAllConnections(); }) };
}

// This function is evaluated by Playwright. It drives the real DOM's controls, never a reducer.
export async function dispatchOperation({ op, measure }) {
  const o = window.clientObserver, startedAt = performance.now();
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
  const endedAt = performance.now();
  return { startedAt, endedAt, timeOrigin: performance.timeOrigin, elapsedMs: measure ? endedAt - startedAt : null, dom: o.dom(), at: o.now() };
}

export async function journey(browser, url, app, workload, settings, timeoutMs, testHook, measure = false) {
  let context, page, timer, pass, closing, contextClosed = false;
  const records = [], actions = [], requests = [], errors = [];
  const http = [], httpIndex = new Map(), responses = [];
  const abort = new AbortController();
  const lifecycle = { clock: "node-performance", timeOrigin: performance.timeOrigin, contextCreatedAt: null, close: null,
    deadline: { timeoutMs, scheduledAt: null, firedAt: null, aborted: false, cancelledAt: null } };
  const timing = { schema: "client-heavy-timing/v1", clock: "browser-performance", timeOrigin: null, mount: null, operations: [] };
  let observing = false, networkAt = 0, apiAt = 0, phase = "context", readyMs = null;
  const closeContext = () => closing ??= closeObserved("context", () => context.close(), () => contextClosed);
  const network = async () => {
    const api = await page.evaluate(() => window.clientObserver.network);
    const result = requests.slice(networkAt).concat(api.slice(apiAt)); networkAt = requests.length; apiAt = api.length;
    return result;
  };
  try {
    context = await browser.newContext({ viewport: { width: 1100, height: 800 }, serviceWorkers: "block" });
    lifecycle.contextCreatedAt = clock();
    context.on("close", () => { contextClosed = true; });
    lifecycle.deadline.scheduledAt = clock();
    timer = setTimeout(() => {
      lifecycle.deadline.firedAt = clock(); abort.abort("journey-timeout"); lifecycle.deadline.aborted = abort.signal.aborted;
      void closeContext();
    }, timeoutMs);
    phase = "load";
    page = await context.newPage();
    page.setDefaultTimeout(Math.min(timeoutMs, 10000));
    page.setDefaultNavigationTimeout(Math.min(timeoutMs, 10000));
    context.on("request", (request) => {
      if (observing) requests.push({ transport: "http", method: request.method(), resourceType: request.resourceType() });
      const receipt = { id: http.length, path: new URL(request.url()).pathname, method: request.method(), resourceType: request.resourceType(),
        startedAt: clock(), endedAt: null, status: null, body: null, failure: null };
      httpIndex.set(request, receipt); http.push(receipt);
    });
    context.on("response", (response) => {
      const receipt = httpIndex.get(response.request());
      if (receipt) responses.push((async () => {
        receipt.status = response.status();
        try { const bytes = await response.body(); receipt.body = { bytes: bytes.length, sha256: sha256(bytes) }; }
        catch (error) { receipt.failure = failure(error); }
        receipt.endedAt = clock();
      })());
    });
    context.on("requestfailed", (request) => {
      const receipt = httpIndex.get(request);
      if (receipt) { receipt.failure = { name: "RequestFailed", diagnosticSha256: sha256(request.failure()?.errorText ?? "unknown") }; receipt.endedAt = clock(); }
    });
    page.on("websocket", () => { if (observing) requests.push({ transport: "websocket" }); });
    page.on("pageerror", (error) => errors.push({ kind: "pageerror", name: error.name, sha256: sha256(error.message) }));
    page.on("console", (msg) => { if (msg.type() === "error") errors.push({ kind: "console-error", sha256: sha256(msg.text()) }); });
    await page.addInitScript(installObserver);
    await page.goto(`${url}/${app}/`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => typeof window.clientMount === "function");
    timing.timeOrigin = await page.evaluate(() => performance.timeOrigin);
    records.push(await page.evaluate(() => window.clientObserver.begin()));
    const start = await page.evaluate(() => { const startedAt = performance.now(); window.clientMount(); return { startedAt, timeOrigin: performance.timeOrigin }; });
    timing.timeOrigin = start.timeOrigin;
    phase = "readiness";
    await page.waitForFunction(() => document.getElementById("screen") && window.clientObserver.owned().subscriptions > 0);
    const initial = await page.evaluate(async () => { const o = window.clientObserver; await o.settle(); return { kind: "initial", at: o.now(), data: o.loaded(), dom: o.dom(), readyAt: performance.now() }; });
    timing.mount = { startedAt: start.startedAt, endedAt: initial.readyAt, recordAt: initial.at, recordIndex: records.length };
    readyMs = initial.readyAt - start.startedAt; delete initial.readyAt;
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
      timing.operations.push({ operation: operation.id, startedAt: result.startedAt, endedAt: result.endedAt,
        timeOrigin: result.timeOrigin, recordAt: result.at, recordIndex: records.length });
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
    pass = { capture, oracle, readyMs, actions: measure ? actions : null, resourceDetails: await page.evaluate(() => window.clientObserver.listenerDetails()), failure: null };
  } catch (error) {
    const capture = { schema: clientCaptureSchema, app, effectiveWorkload: workload, outcome: "failed", reason: `native-${phase}-failed`, records: null };
    pass = { capture, oracle: validateClientCapture(workload, capture, settings), readyMs: null, actions: null,
      failure: { phase, diagnostic: error.message.startsWith("client contract:") ? error.message : error.name, diagnosticSha256: sha256(String(error)), records, errors } };
  } finally {
    await Promise.all(responses);
    clearTimeout(timer); lifecycle.deadline.cancelledAt = clock();
    if (context) lifecycle.close = await closeContext();
  }
  if (!pass.oracle.functionalPassed || !closedPass({ lifecycle })) { pass.readyMs = null; pass.actions = null; }
  for (const receipt of http) if (receipt.endedAt === null) {
    receipt.endedAt = clock(); receipt.failure = { name: "RequestIncomplete", diagnosticSha256: sha256("context-closed-before-response") };
  }
  return { ...pass, timing, lifecycle, requests: http };
}

export const closedPass = (pass) => pass.lifecycle?.close?.returned === true && pass.lifecycle.close.observed === true
  && pass.lifecycle.deadline?.firedAt === null;

export async function qualifyAndMeasure(capture) {
  const qualification = await capture("qualification");
  if (!qualification.oracle.functionalPassed || !closedPass(qualification)) return { qualification, measurement: null, readyForMeasurement: false };
  const measurement = await capture("measurement");
  return { qualification, measurement, readyForMeasurement: !!measurement.oracle.functionalPassed && closedPass(measurement) };
}

export async function finishRun(output, out, { browser, server, closeBrowser = () => browser.close(), interruptCleanup, isInterrupted, signals = [] }) {
  output.cleanupFailures = [];
  output.terminal = { clock: "node-performance", timeOrigin: performance.timeOrigin, signals, resources: [] };
  if (interruptCleanup) {
    try { await interruptCleanup; }
    catch (error) { output.cleanupFailures.push({ resource: "browser-interrupt", ...failure(error) }); }
  }
  for (const [resource, instance, close, observed] of [["browser", browser, closeBrowser, () => typeof browser.isConnected === "function" ? browser.isConnected() === false : null],
    ["server", server, () => server.close(), () => server.isClosed?.() ?? null]]) {
    const receipt = instance ? await closeObserved(resource, close, observed) : { resource, state: "not-created" };
    output.terminal.resources.push(receipt);
    if (receipt.failure) output.cleanupFailures.push({ resource, ...receipt.failure });
    if (instance && (receipt.returned !== true || receipt.observed !== true)) output.passed = false;
  }
  const interrupted = isInterrupted();
  if (interrupted) output.failure = { reason: "native-runner-interrupted", name: "Interrupted", diagnosticSha256: sha256(json(signals)) };
  if (interrupted || output.cleanupFailures.length) output.passed = false;
  for (const app of output.selectedApps) {
    const buildFailed = output.builds?.[app]?.outcome === "failed";
    output.cells[app] ??= { outcome: buildFailed ? "failed" : "not-run", reason: buildFailed ? "native-build-failed"
      : interrupted ? "native-runner-interrupted" : "runner-failed-before-adapter", qualification: null, measurement: null, readyForMeasurement: false };
    await writeFile(join(out, `${app}.json`), json(output.cells[app]));
  }
  await writeFile(join(out, "result.json"), json(output));
}

export async function run(args) {
  const config = options(args);
  // Refuse reuse: stale artifacts must never become evidence for this invocation.
  await mkdir(dirname(config.out), { recursive: true });
  await mkdir(config.out, { recursive: false });
  const evidence = new Evidence(root, config.out);
  const provenance = { commit: null, sourceBefore: "evidence/source-before.json", sourceAfter: "evidence/source-after.json",
    node: process.version, platform: platform(), release: release(), cpu: cpus()[0]?.model ?? "unknown", logicalCpus: cpus().length,
    browser: null, browserInstances: 1, rendererProcessLimit: 1, concurrentPages: 1, passes: 2, note: "Bounded local verification on an uncontrolled host; no throughput or ranking claim. No OS CPU or memory isolation." };
  const output = { schema, group: "client-heavy", round: config.round, effectiveWorkload: config.workload, settings: config.settings, timeoutMs: config.timeoutMs, provenance,
    selectedApps: selectedApps("client-heavy"), definition: definition("client-heavy"),
    builds: Object.fromEntries(selectedApps("client-heavy").map((app) => [app, { outcome: "not-run", reason: "runner-failed-before-build" }])),
    cells: {}, passed: false, readyForLoad: false,
    collection: { accounting: "incomplete", proof: "blocked", blockers: evidence.blockers, isolation: "unknown", rankingEligible: false,
      reviewSubject: "review-subject.json" } };
  let server, browser, closeBrowser, interrupted = false, interruptCleanup, sourceBefore;
  const signals = [], abort = new AbortController(), dependencyBefore = new Map();
  const interrupt = (signal) => {
    interrupted = true;
    abort.abort(signal); signals.push({ signal, at: clock(), aborted: abort.signal.aborted });
    interruptCleanup ??= browser && Promise.resolve().then(() => closeBrowser());
    // Handle the rejection immediately, but retain it for final cleanup evidence.
    interruptCleanup?.catch(() => {});
  };
  const onInt = () => interrupt("SIGINT"), onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  try {
    await evidence.save("native/workload.json", config.workload);
    await evidence.save("native/build.json", output.builds);
    sourceBefore = await evidence.source("before"); provenance.commit = sourceBefore.commit;
    const inheritedConfigurationNames = configurationNames(process.env);
    await evidence.save("plan.json", { schema: "client-heavy-plan/v1", round: config.round, commit: provenance.commit,
      invocation: config.invocation, workload: config.workload, settings: config.settings, timeoutMs: config.timeoutMs,
      selectedApps: output.selectedApps, definition: output.definition, sourceBefore: provenance.sourceBefore,
      root, platform: process.platform,
      nodeClock: { clock: "node-performance", timeOrigin: performance.timeOrigin }, inheritedConfigurationNames });
    try {
      const executablePath = await realpath(process.execPath);
      await evidence.save("evidence/node.json", { version: process.version, requestedExecutable: process.execPath, executablePath,
        executable: await evidence.file(dirname(executablePath), basename(executablePath)) });
    }
    catch { evidence.blockers.push("node-executable-bytes-unavailable"); }
    const cargoIdentity = await evidence.tool(config.cargo, ["--version", "--verbose"], "cargo-version");
    assert.ok(cargoIdentity.receipt.status === 0 && cargoIdentity.receipt.failure === null, "native-cargo-unavailable");
    for (const [label, directory] of [["node-dependencies", "node_modules"], ["browser-dependencies", "bench/browser/node_modules"]])
      dependencyBefore.set(label, await evidence.tree(join(root, directory), label, "before"));
    const nativeDirectory = join(config.out, "native");
    // Receipts and self-consistent hashes cannot prove which framework produced a
    // bundle. Compile the native sources in this invocation, including the Rust generator.
    await buildApps(config.workload, nativeDirectory, config.cargo, evidence, output.builds);
    assert.ok(!interrupted, "native-runner-interrupted");
    // Keep build failures even when no browser can be launched for the other apps.
    for (const app of output.selectedApps) if (output.builds[app].outcome === "failed") output.cells[app] = {
      outcome: "failed", reason: "native-build-failed", qualification: null, measurement: null, readyForMeasurement: false };
    const { chromium } = await import("playwright");
    server = await serve(nativeDirectory);
    const launched = await launchBrowser(chromium);
    browser = launched.browser; closeBrowser = launched.close;
    assert.ok(!interrupted, "native-runner-interrupted");
    provenance.browser = browser.version();
    try {
      await evidence.save("evidence/browser.json", await browserIdentity(evidence, launched));
    }
    catch { evidence.blockers.push("browser-executable-bytes-unavailable"); }
    for (const app of output.selectedApps) {
      assert.ok(!interrupted, "native-runner-interrupted");
      if (output.builds[app].outcome !== "built") {
        output.cells[app] = { outcome: "failed", reason: "native-build-failed", qualification: null, measurement: null, readyForMeasurement: false };
      } else {
        const result = await qualifyAndMeasure((phase) => journey(browser, server.url, app, config.workload, config.settings, config.timeoutMs, undefined, phase === "measurement"));
        output.cells[app] = { outcome: result.readyForMeasurement ? "passed" : "failed", ...result };
      }
      await writeFile(join(config.out, `${app}.json`), json(output.cells[app]));
      console.log(`${app}: ${output.cells[app].outcome}`);
    }
    output.passed = output.selectedApps.every((app) => output.cells[app].outcome === "passed");
  } catch (error) {
    output.failure = { reason: interrupted ? "native-runner-interrupted" : "runner-failed", name: error.name, diagnosticSha256: sha256(String(error)) };
  } finally {
    try {
      await finishRun(output, config.out, { browser, server, closeBrowser, interruptCleanup, isInterrupted: () => interrupted, signals });
      const sourceAfter = await evidence.source("after");
      if (!sourceBefore || sourceBefore.commit !== sourceAfter.commit || JSON.stringify(sourceBefore.entries) !== JSON.stringify(sourceAfter.entries))
        evidence.blockers.push("source-bytes-changed-during-invocation");
      for (const [label, directory] of [["node-dependencies", "node_modules"], ["browser-dependencies", "bench/browser/node_modules"]]) {
        if (!dependencyBefore.has(label)) continue;
        const after = await evidence.tree(join(root, directory), label, "after");
        if (JSON.stringify(dependencyBefore.get(label)?.entries) !== JSON.stringify(after.entries)
          || JSON.stringify(dependencyBefore.get(label)?.layout) !== JSON.stringify(after.layout)) evidence.blockers.push(`${label}-changed-during-invocation`);
      }
      for (const resource of output.terminal.resources) if (resource.state !== "not-created" && (resource.returned !== true || resource.observed !== true))
        evidence.blockers.push(`terminal-${resource.resource}-closure-not-observed`);
      for (const app of output.selectedApps) if (output.cells[app].outcome !== "passed") evidence.blockers.push(`unqualified-cell:${app}`);
      await evidence.save("evidence/configuration-after.json", { names: configurationNames(process.env) });
      if (interrupted) output.passed = false;
      output.collection.accounting = "complete"; output.collection.blockers = [...new Set(evidence.blockers)];
      await writeFile(join(config.out, "result.json"), json(output));
      await evidence.seal({ group: "client-heavy", round: config.round, commit: provenance.commit });
    } finally { process.off("SIGINT", onInt); process.off("SIGTERM", onTerm); }
  }
  return output;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = await run(process.argv.slice(2)); process.exitCode = result.passed ? 2 : 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
