// Separate from run.mjs: bounded native browser correctness, not historical fan-out load.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { hostname, platform, release, arch, cpus } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { liveCaptureSchema, liveContracts, validateLiveCapture } from "../workloads/live.mjs";
import { contractSha256, selectedApps } from "../workloads/registry.mjs";
import { coverage } from "../workloads/evidence.mjs";
import { inventory, nativePorts, portFor, scenarios, settingsFor, workloadFor } from "./native.mjs";
import { wireEvents, wireSnapshots } from "./wire.mjs";
import { fanoutJourney, fanoutProfile, kernelObservation, verifyFanout } from "./fanout.mjs";

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, "../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function command(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.status !== 0) {
    const error = new Error(`${program} ${args.join(" ")}: ${result.error?.message ?? `exit ${result.status}`}\n${result.stderr?.slice(-12000) ?? ""}`);
    error.receipt = { program, args, status: result.status, signal: result.signal, error: result.error?.message,
      stdout: result.stdout, stderr: result.stderr };
    throw error;
  }
  return result.stdout.trim();
}
async function sources(directory, prefix = "") {
  const result = {};
  for (const e of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (["node_modules", "bin", "obj", "target"].includes(e.name)) continue;
    const name = prefix + e.name;
    if (e.isDirectory()) Object.assign(result, await sources(join(directory, e.name), name + "/"));
    else if (e.isFile()) result[name] = hash(await readFile(join(directory, e.name)));
  }
  return result;
}

export function select(group, requested) {
  assert.ok(Object.hasOwn(liveContracts, group), "unknown live group");
  const all = selectedApps(group), apps = requested === undefined ? all : requested.split(",");
  assert.ok(apps.length && new Set(apps).size === apps.length && apps.every((a) => all.includes(a)), "invalid, duplicate or unselected app");
  return apps;
}

export async function browserJourney(browser, base, workload, settings, port = {}) {
  const context = await browser.newContext();
  const deadline = setTimeout(() => { context.close().catch(() => {}); }, workload.eventCount > 24 ? 180000 : 45000);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const network = [], failures = [], observations = [];
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Performance.enable");
  cdp.on("Network.eventSourceMessageReceived", (e) => network.push({ kind: "native-sse", ...e }));
  cdp.on("Network.webSocketFrameReceived", (e) => network.push({ kind: "native-websocket-received", ...e }));
  cdp.on("Network.webSocketFrameSent", (e) => network.push({ kind: "native-websocket-sent", ...e }));
  cdp.on("Network.webSocketCreated", (e) => network.push({ kind: "native-websocket-created", ...e }));
  cdp.on("Network.loadingFinished", (e) => network.push({ kind: "received-bytes", ...e }));
  page.on("request", (r) => network.push({ kind: "request", at: performance.now(), method: r.method(), url: r.url(), body: r.postData() }));
  page.on("response", (r) => {
    const observation = { kind: "response", at: performance.now(), url: r.url(), status: r.status(), headers: r.headers() };
    network.push(observation);
    if (r.headers()["content-type"]?.includes("application/json")) {
      observations.push(r.text().then((body) => { observation.body = body; }, (error) => { observation.bodyError = error.message; }));
    }
  });
  page.on("pageerror", (e) => failures.push(e.message));
  let result;
  try {
    const configured = await context.request.post(`${base}/parity/configure`, { data: { initial: workload.initial, queueLimit: settings.queueLimit, historyLimit: settings.historyLimit } });
    assert.equal(configured.status(), 200, "native configure failed");
    const configuration = await configured.json();
    const rejected = await context.request.post(`${base}/parity/publish`, { data: { event: { ...workload.events[0], seq: 10000 } } });
    assert.equal(rejected.status(), 400, "native port accepted an out-of-order publication");
    const controls = [{ request: { event: { ...workload.events[0], seq: 10000 } }, status: rejected.status(), body: await rejected.text() }];
    if (settings.queueLimit > 2) for (const request of [
      { event: workload.events[0], events: [workload.events[0]] },
      { events: [workload.events[0], { ...workload.events[1], seq: 10000 }] }, { events: [] },
    ]) {
      const r = await context.request.post(`${base}/parity/publish`, { data: request });
      assert.equal(r.status(), 400, "native batch accepted malformed/nonconsecutive work");
      controls.push({ request, status: r.status(), body: await r.text() });
    }
    await page.goto(base, { waitUntil: "load" });
    await page.waitForFunction(() => !!window.liveApp);
    const call = (method, arg) => page.evaluate(async ({ method, arg }) => window.liveApp[method](arg), { method, arg });
    const waitThrough = async (through) => {
      await page.waitForFunction((n) => window.liveApp.through === n, through);
      await call("settle");
    };
    await call("setup", settings);
    let published = 0;
    const publish = async (deliver = true) => {
      await call("publish", workload.events[published++]);
      if (deliver) await waitThrough(published);
    };
    const publishMissed = async (count) => {
      // Keep each native HTTP request/ack, without a host/browser RPC per write.
      const events = workload.events.slice(published, published + count);
      await page.evaluate(async (events) => {
        if (events.length > 24) await window.liveApp.publishBatch(events);
        else for (const event of events) await window.liveApp.publish(event);
      }, events);
      published += count;
    };
    await publish();
    if (["disconnect", "missed-updates", "expired-cursor"].includes(settings.scenario)) {
      await call("disconnect");
      const missed = settings.scenario === "expired-cursor" ? settings.historyLimit + 2 : settings.scenario === "disconnect" ? 1 : 3;
      await publishMissed(missed);
      await call("reconnect"); await waitThrough(published);
    } else if (settings.scenario === "gap") {
      await call("drop", 2); await publish(false); await publish(false); await waitThrough(published);
    } else if (settings.scenario === "slow-reader") {
      await call("hold");
      await publishMissed(settings.queueLimit + 1);
      await waitThrough(published);
    }
    while (published < workload.eventCount) await publish();
    const duplicateCount = await page.evaluate(() => window.liveApp.records.filter((r) => r.kind === "event" && r.disposition === "duplicate").length);
    await call("duplicate");
    await page.waitForFunction((count) => window.liveApp.records.filter((r) => r.kind === "event" && r.disposition === "duplicate").length > count, duplicateCount);
    await call("settle"); await call("state"); await call("detach");
    await page.evaluate(async (event) => window.liveApp.publish(event, true), workload.cleanupProbe);
    await sleep(settings.cleanupObservationMs + 10);
    await call("released"); await call("state");
    await Promise.all(observations);
    assert.deepEqual(failures, [], "browser application errors");
    const capture = { schema: liveCaptureSchema, contract: liveContracts[settings.group], records: await page.evaluate(() => window.liveApp.records) };
    const summary = validateLiveCapture(workload, capture, settings);
    assert.ok(wireEvents(network, port.wire).length > 0, "no actual native browser transport evidence");
    result = { configuration, controls, capture, summary, network, failures, html: await page.content(),
      browser: { version: browser.version(), userAgent: await page.evaluate(() => navigator.userAgent) },
      browserCosts: { performance: await cdp.send("Performance.getMetrics"), dom: await cdp.send("Memory.getDOMCounters") },
      costs: await page.evaluate(() => ({ resources: performance.getEntriesByType("resource").map((r) => r.toJSON()),
        navigation: performance.getEntriesByType("navigation").map((r) => r.toJSON()) })) };
    return result;
  } catch (error) {
    error.evidence = { capture: { schema: liveCaptureSchema, contract: liveContracts[settings.group],
      records: await page.evaluate(() => window.liveApp?.records ?? []).catch(() => []) }, network, failures,
      html: await page.content().catch(() => "") };
    throw error;
  } finally { clearTimeout(deadline); await context.close(); }
}

export function verifyArtifact(artifact, expected) {
  assert.ok(nativePorts[expected.app], "no implemented native port for this app");
  assert.equal(artifact.schema, "native-live-evidence/v1");
  assert.equal(artifact.app, expected.app); assert.equal(artifact.group, expected.group);
  assert.equal(artifact.scenario, expected.scenario);
  assert.equal(artifact.provenance.contractSha256, contractSha256(expected.group));
  assert.match(artifact.provenance.imageId, /^sha256:[a-f0-9]{64}$/);
  const profile = artifact.profile ?? "bounded";
  const port = portFor(expected.app, profile);
  assert.ok(port, "native port does not support this explicit profile");
  assert.deepEqual(artifact.settings, settingsFor(expected.group, expected.scenario, profile));
  assert.equal(artifact.provenance.nativePort, nativePorts[expected.app]?.transport);
  assert.deepEqual(artifact.provenance.container, { nanoCpus: 1000000000, memory: 1073741824, memorySwap: 1073741824 }, "unreviewed native deployment budget");
  assert.equal(artifact.configuration.framework, expected.app);
  assert.deepEqual(artifact.controls.map((r) => r.status), profile === "native-feed" ? [400, 400, 400, 400] : [400], "negative native publication control missing");
  assert.equal(artifact.provenance.sourceSha256, hash(JSON.stringify(artifact.provenance.sourceHashes)));
  assert.equal(artifact.provenance.imageSourceSha256, artifact.provenance.sourceSha256, "image is not bound to the captured native sources");
  assert.deepEqual(artifact.workload, workloadFor(profile), "unreviewed workload");
  const summary = validateLiveCapture(artifact.workload, artifact.capture, artifact.settings);
  assert.deepEqual(artifact.summary, summary, "saved aggregate does not match raw capture");
  const received = wireEvents(artifact.network, port.wire);
  assert.ok(received.length > 0, "missing native browser evidence");
  assert.deepEqual(artifact.capture.records.filter((r) => r.kind === "event").map((r) => r.event), received,
    "application receive trace differs from native browser stream");
  const writes = artifact.network.filter((r) => r.kind === "request" && new URL(r.url).pathname === "/parity/publish");
  assert.deepEqual(writes.flatMap((r) => {
    const input = JSON.parse(r.body);
    if (Object.hasOwn(input, "events")) {
      assert.equal(profile, "native-feed", "batch outside explicit native fault profile");
      assert.ok(["expired-cursor", "slow-reader"].includes(artifact.scenario), "batch outside native fault setup");
      assert.equal(input.event, undefined); assert.ok(Array.isArray(input.events));
      assert.equal(input.events.length, artifact.scenario === "slow-reader" ? artifact.settings.queueLimit + 1 : artifact.settings.historyLimit + 2);
      return input.events;
    }
    return [input.event];
  }), [...artifact.workload.events, artifact.workload.cleanupProbe], "wrong native publication work");
  const snapshots = wireSnapshots(artifact.network, port.wire);
  assert.deepEqual(artifact.capture.records.filter((r) => r.kind === "snapshot").map(({ through, rows, work }) => ({ through, rows, work })), snapshots,
    "application snapshot trace differs from native HTTP bodies");
  const acks = artifact.network.filter((r) => r.kind === "response" && new URL(r.url).pathname === "/parity/publish");
  assert.deepEqual(acks.flatMap((r) => { assert.equal(r.status, 200); const body = JSON.parse(r.body);
    if (body.acks) { assert.equal(profile, "native-feed"); return body.acks.map((a) => a.seq); } return [body.seq];
  }), [...artifact.workload.events, artifact.workload.cleanupProbe].map((e) => e.seq), "missing raw publication acknowledgements");
  assert.deepEqual(artifact.failures, []);
  return summary;
}

export async function run({ group, out, apps: requested, build = false, round, profile = "bounded", measure = false }) {
  const apps = select(group, requested);
  const workload = workloadFor(profile);
  assert.ok(out, "output directory required");
  await mkdir(dirname(out), { recursive: true });
  await mkdir(out, { recursive: false }); // Evidence is never silently overwritten.
  const commit = command("git", ["rev-parse", "HEAD"]);
  const diff = command("git", ["diff", "HEAD", "--", "bench/live", "bench/recoverable-live",
    ":(exclude)bench/live/results", ":(exclude)bench/live/evidence", ":(exclude)bench/recoverable-live/results"]);
  const code = { runner: hash(await readFile(fileURLToPath(import.meta.url))),
    verifier: hash(await readFile(join(here, "verify.mjs"))),
    oracle: hash(await readFile(join(here, "../workloads/live.mjs"))),
    native: hash(await readFile(join(here, "native.mjs"))), wire: hash(await readFile(join(here, "wire.mjs"))),
    fanout: hash(await readFile(join(here, "fanout.mjs"))) };
  const plan = { schema: "native-live-plan/v2", group, round: round ?? basename(out), startedAt: new Date().toISOString(), apps: selectedApps(group), requested: apps,
    profile, measurement: measure ? fanoutProfile : null,
    inventory: inventory(group, profile), workload, scenarios: scenarios(group), settings: scenarios(group).map((s) => settingsFor(group, s, profile)),
    commit, diffSha256: hash(diff), code, contractSha256: contractSha256(group),
    environment: { hostname: hostname(), platform: platform(), release: release(), arch: arch(), cpus: cpus().length, node: process.version },
    budget: { appCpus: 1, appMemoryBytes: 1073741824, browsers: 1, clients: 1 },
    limits: ["bounded local correctness probe, not load qualification or comparative ranking", "slow native queue consumer, not TCP/network slow reader",
      "no authentication, multi-node or process-restart durability", "native process and application queue peaks; kernel socket memory is not measured",
      "browser application delivery waits for the active publisher acknowledgement; receivedAt and raw CDP record actual native arrival separately"] };
  await writeFile(join(out, "plan.json"), JSON.stringify(plan, null, 2));
  await writeFile(join(out, "source.diff.gz"), gzipSync(diff));
  const cells = [];
  let browser;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    for (const app of apps) {
      const port = portFor(app, profile);
      if (!port) continue;
      const name = `parity-live-${randomUUID()}`, context = join(here, "apps", port.directory);
      let owned = false;
      const cases = [], files = [], qualified = [];
      try {
        const appSources = async () => port.rootContext ? {
          app: await sources(context), crates: await sources(join(root, "crates")),
          cargo: hash(await readFile(join(root, "Cargo.toml"))), lock: hash(await readFile(join(root, "Cargo.lock"))),
        } : sources(context);
        const sourceHashes = await appSources();
        const sourceSha256 = hash(JSON.stringify(sourceHashes));
        const existing = spawnSync("docker", ["image", "inspect", port.image], { encoding: "utf8", timeout: 15000 });
        const existingImage = existing.status === 0 ? JSON.parse(existing.stdout)[0] : undefined;
        if (build || existingImage?.Config.Labels?.["bench.live.source-sha256"] !== sourceSha256) command("docker", ["build", "--label", "agent.owner=codex", "--label", "agent.task=bench-parity-live",
          "--label", `bench.live.source-sha256=${sourceSha256}`, "-t", port.image,
          ...(port.dockerfile ? ["-f", join(context, port.dockerfile)] : []), port.rootContext ? root : context], { timeout: port.buildTimeoutMs ?? 300000 });
        const built = JSON.parse(command("docker", ["image", "inspect", port.image]))[0];
        const imageId = built.Id, imageSourceSha256 = built.Config.Labels?.["bench.live.source-sha256"];
        assert.equal(imageSourceSha256, sourceSha256, "stale/unbound native image: rerun with --build");
        command("docker", ["run", "-d", "--name", name, "--label", "agent.owner=codex", "--label", "agent.task=bench-parity-live",
          "--cpus", "1", "--memory", "1g", "--memory-swap", "1g", "-p", "127.0.0.1::8080", imageId]);
        owned = true;
        const inspect = JSON.parse(command("docker", ["inspect", name]))[0];
        const hostPort = inspect.NetworkSettings.Ports["8080/tcp"][0].HostPort;
        const base = `http://127.0.0.1:${hostPort}`;
        let up = false;
        for (let i = 0; i < 150; i++) {
          try { const r = await fetch(`${base}/parity/resources`, { signal: AbortSignal.timeout(1000) }); if (r.ok) { up = true; break; } } catch {}
          await sleep(100);
        }
        assert.ok(up, "native app did not start within 15s");
        const provenance = { commit, diffSha256: hash(diff), code, contractSha256: contractSha256(group), sourceHashes, sourceSha256, imageSourceSha256,
          imageId, containerId: inspect.Id, nativePort: port.transport,
          processTopology: port.topology ?? "one application process; no broker, database or shared renderer",
          processInventory: command("docker", ["top", name, "-eo", "pid,ppid,comm"]), container: {
            nanoCpus: inspect.HostConfig.NanoCpus, memory: inspect.HostConfig.Memory, memorySwap: inspect.HostConfig.MemorySwap,
          } };
        for (const scenario of scenarios(group)) {
          const settings = settingsFor(group, scenario, profile), file = `${app}-${scenario}.json.gz`;
          let artifact;
          try {
            const journey = await browserJourney(browser, base, workload, settings, port);
            artifact = { schema: "native-live-evidence/v1", profile, app, group, scenario, provenance, workload, settings, ...journey };
            verifyArtifact(artifact, { app, group, scenario });
          } catch (error) {
            artifact = { schema: "native-live-failure/v1", profile, app, group, scenario, provenance, workload, settings, error: error.message, ...error.evidence };
          }
          const bytes = gzipSync(JSON.stringify(artifact));
          await writeFile(join(out, file), bytes); files.push({ file, sha256: hash(bytes) });
          const saved = JSON.parse(gunzipSync(await readFile(join(out, file))));
          if (saved.schema === "native-live-evidence/v1") { verifyArtifact(saved, { app, group, scenario }); cases.push(scenario); qualified.push(saved); }
          else console.error(`${app}/${scenario}: ${saved.error}`);
        }
        assert.deepEqual(await appSources(), sourceHashes, "native source changed during capture");
        assert.equal(command("docker", ["inspect", "--format", "{{.Image}}", name]), imageId);
        const allPassed = cases.length === scenarios(group).length;
        await writeFile(join(out, `${app}-artifacts.json`), JSON.stringify({ app, group, files }, null, 2));
        let measurement = "not-run", measurementArtifact;
        if (measure && allPassed) {
          // Independent admission: revalidate every saved native fault journey before any timing.
          assert.deepEqual(qualified.map((a) => a.scenario), scenarios(group));
          for (const a of qualified) verifyArtifact(a, { app, group, scenario: a.scenario });
          const measurementFiles = [];
          measurement = "complete"; measurementArtifact = `${app}-measurements.json`;
          const kernelCounters = () => {
            const raw = command("docker", ["exec", name, "sh", "-c", "cat /sys/fs/cgroup/cpu.stat; echo MEMORY; cat /sys/fs/cgroup/memory.current; cat /sys/fs/cgroup/memory.peak"]);
            return kernelObservation(raw);
          };
          for (const clients of fanoutProfile.clients) {
            let a;
            try {
              const observed = await fanoutJourney(browser, base, settingsFor(group, "normal", profile), clients, port, kernelCounters);
              a = { schema: "native-live-fanout/v1", profile: fanoutProfile, app, group, provenance, qualification: files,
                comparative: false, repeats: 1, ...observed };
              a.summary = verifyFanout(a, { app, group, provenance, qualification: files, settings: qualified[0].settings, wire: port.wire });
            } catch (error) {
              measurement = "failed";
              a = { schema: "native-live-fanout-failure/v1", app, group, clients, provenance, qualification: files, error: error.message, ...error.evidence };
              console.error(`${app}/fanout-${clients}: ${error.message}`);
            }
            const file = `${app}-fanout-${clients}.json.gz`, bytes = gzipSync(JSON.stringify(a));
            await writeFile(join(out, file), bytes); measurementFiles.push({ file, sha256: hash(bytes) });
          }
          await writeFile(join(out, measurementArtifact), JSON.stringify({ app, group, profile: fanoutProfile, files: measurementFiles }, null, 2));
        }
        assert.deepEqual(await appSources(), sourceHashes, "native source changed during measurement");
        cells.push({ app, case: group === "live-delivery" ? "delivery" : "recovery", implementation: "implemented",
          parity: allPassed ? "passed" : "failed", measurement, ...(measurementArtifact ? { measurementArtifact } : {}),
          reason: `${cases.length}/${scenarios(group).length} bounded native browser journeys passed; no load qualification`, artifact: `${app}-artifacts.json` });
      } catch (error) {
        await writeFile(join(out, `${app}-failure.json`), JSON.stringify({ app, error: error.message, receipt: error.receipt }, null, 2));
        cells.push({ app, case: group === "live-delivery" ? "delivery" : "recovery", implementation: "implemented", parity: "failed", measurement: "not-run", reason: error.message });
      } finally { if (owned) command("docker", ["rm", "-f", "-v", name]); }
    }
  } finally {
    await browser?.close();
    const rows = inventory(group, profile).map((entry) => cells.find((c) => c.app === entry.app) ?? {
      app: entry.app, case: group === "live-delivery" ? "delivery" : "recovery", implementation: entry.implementation,
      parity: "not-run", measurement: "not-run", reason: entry.reason,
    });
    const ledger = coverage(group, rows);
    ledger.readyForLoad = rows.every((r) => r.implementation === "implemented" && r.parity === "passed"
      && (!measure || r.measurement === "complete"));
    await writeFile(join(out, "coverage.json"), JSON.stringify(ledger, null, 2));
  }
  return cells.length === selectedApps(group).length && cells.every((c) => c.parity === "passed" && (!measure || c.measurement === "complete"));
}

export async function main(group, argv = process.argv.slice(2)) {
  const [out, ...args] = argv;
  let apps, build = false, profile = "bounded", measure = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apps") { assert.ok(args[i + 1], "--apps needs a value"); apps = args[++i]; }
    else if (args[i] === "--build") build = true;
    else if (args[i] === "--measure") measure = true;
    else if (args[i] === "--profile") { assert.ok(args[i + 1], "--profile needs a value"); profile = args[++i]; }
    else assert.fail(`unknown argument: ${args[i]}`);
  }
  const passed = await run({ group, out: out && resolve(out), apps, build, profile, measure });
  if (!passed) process.exitCode = 1; // A passing subset is not a passing group.
}
export async function runRound(group, args) {
  let round, apps, build = false, out, profile = "bounded", measure = false;
  if (Array.isArray(args)) {
    [round, ...args] = args;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--apps") { assert.ok(args[i + 1], "--apps needs a value"); apps = args[++i]; }
      else if (args[i] === "--build") build = true;
      else if (args[i] === "--measure") measure = true;
      else if (args[i] === "--profile") { assert.ok(args[i + 1], "--profile needs a value"); profile = args[++i]; }
      else assert.fail(`unknown argument: ${args[i]}`);
    }
  } else {
    assert.ok(args && typeof args === "object", "run requires round arguments");
    ({ round, apps, build = false, out, profile = "bounded", measure = false } = args);
  }
  assert.ok(typeof round === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(round), "explicit safe round name required");
  const destination = out ?? resolve(here, group === "live-delivery" ? "results/parity" : "../recoverable-live/results", round);
  return run({ group, out: destination, apps, build, round, profile, measure });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main("live-delivery");
