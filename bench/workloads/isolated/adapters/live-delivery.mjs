import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { verifyRound } from "../../../live/verify.mjs";
import { groupNames } from "../../registry.mjs";
import { readRegular, tree } from "../evidence.mjs";
import { inspectLifetime } from "../host-lifetime.mjs";
import { verifyHostBoundary } from "../host-observation.mjs";
import { liveCaptureSchema, liveContracts } from "../../live.mjs";
import { negativeRequests } from "../../../live/admission.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const codePaths = Object.freeze({
  runner: "bench/live/parity.mjs", verifier: "bench/live/verify.mjs", oracle: "bench/workloads/live.mjs",
  native: "bench/live/native.mjs", wire: "bench/live/wire.mjs", fanout: "bench/live/fanout.mjs",
  resources: "bench/live/resources.mjs", admission: "bench/live/admission.mjs", measurement: "bench/live/measurement.mjs",
  nativeHttp: "bench/live/native-http.mjs",
});
const sha = (value) => assert.match(value ?? "", /^[a-f0-9]{64}$/);
const clock = (value) => { const n = Date.parse(value); assert.ok(Number.isFinite(n)); return n; };
class MissingProof extends Error {
  constructor(blocker) { super("native proof missing"); this.blocker = blocker; }
}
const present = (value, blocker) => { if (value === undefined) throw new MissingProof(blocker); return value; };

// The caller verifies the binding and whole physical tree. This adapter replays
// the native API that actually exists, not a proposed receipt format.
// Native replay establishes functional truth and image/source/container limits.
// A standalone native tree cannot prove OS exit. Only the fixed adjacent campaign
// phase can add the core collector's independently replayed lifetime and boundary.

function sourceHashes(files, entry) {
  const under = (prefix) => Object.fromEntries(files.filter((f) => f.path.startsWith(prefix)
    && !f.path.slice(prefix.length).split("/").some((p) => ["node_modules", "bin", "obj", "target"].includes(p))
    && !/^test\/(?:receipts|receipts-final)\//.test(f.path.slice(prefix.length)))
    .map((f) => [f.path.slice(prefix.length), f.sha256]));
  const app = under(`bench/live/apps/${entry.directory}/`);
  assert.ok(Object.keys(app).length, "bound native sources absent");
  if (!entry.rootContext) return app;
  const crates = under("crates/"); assert.ok(Object.keys(crates).length);
  const cargo = files.find((f) => f.path === "Cargo.toml")?.sha256, lock = files.find((f) => f.path === "Cargo.lock")?.sha256;
  sha(cargo); sha(lock); return { app, crates, cargo, lock };
}

function phaseProof(binding, folder, startedAt) {
  if (basename(folder) !== "native") return null;
  const phase = dirname(folder), campaign = basename(dirname(phase)), { group, round } = binding.request;
  assert.match(campaign, new RegExp(`^${round}-[a-f0-9]{16}$`));
  assert.equal(basename(phase), `${String(groupNames.indexOf(group)).padStart(2, "0")}-${group}-timing`);
  const beforeTree = tree(phase), read = (name) => JSON.parse(readRegular(join(phase, name)));
  assert.deepEqual(read("native-manifest.json"), tree(folder));
  const before = read("host-before.json"), after = read("host-after.json");
  verifyHostBoundary(before, after);
  // The single fresh host has no participant containers outside the native run.
  assert.deepEqual(before.containers, []); assert.deepEqual(after.containers, []);
  const names = beforeTree.entries.filter((e) => e.type === "directory" && /^command-\d+-host$/.test(e.path));
  assert.equal(names.length, 1, "live phase requires its one exact native command");
  const directory = join(phase, names[0].path), context = JSON.parse(readRegular(join(directory, "binding.json")));
  const terminal = JSON.parse(readRegular(join(directory, "terminal.json"))), command = Number(/^command-(\d+)-host$/.exec(names[0].path)[1]);
  assert.equal(context.bootId, before.bootId);
  const observation = inspectLifetime(binding, binding.execution.invocation, directory,
    { campaign, command, pid: context.leaderPid, result: terminal.command });
  assert.equal(binding.execution.effectiveOptions.build, true);
  const first = observation.samples[0].at, last = observation.samples.at(-1).at, started = clock(startedAt);
  assert.ok(clock(before.at) <= first && first <= started && started <= last && last <= clock(after.at));
  const result = terminal.command;
  assert.equal(result.error, null); assert.equal(result.signal, null);
  assert.ok([0, 1].includes(result.code)); assert.equal(result.success, result.code === 0 && !result.cancelled && !result.forced);
  const browser = observation.identities.some((p) => p.type === "--type=renderer");
  assert.deepEqual(tree(phase), beforeTree, "external phase evidence mutated");
  return { complete: observation.status === "verified" && observation.cleanupComplete && browser, code: result.code };
}

function observedFailure(a, group, profile) {
  const networkObserved = (network) => network.some((response) => response.kind === "response" && typeof response.requestId === "string"
    && Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
    && network.some((request) => request.kind === "request" && request.requestId === response.requestId && request.url === response.url));
  if (a.schema === "native-live-fanout-failure/v1") return Array.isArray(a.browsers) && a.browsers.length > 0
    && a.browsers.length <= a.clients && a.browsers.every((b) => Array.isArray(b.records) && Array.isArray(b.failures)
      && typeof b.html === "string" && Array.isArray(b.network) && networkObserved(b.network));
  if (a.schema !== "native-live-failure/v1") return true;
  if (!a.capture || !Array.isArray(a.controls) || !Array.isArray(a.network) || !Array.isArray(a.failures) || typeof a.html !== "string") return false;
  assert.equal(a.capture.schema, liveCaptureSchema); assert.equal(a.capture.contract, liveContracts[group]); assert.ok(Array.isArray(a.capture.records));
  const requests = negativeRequests(a.workload, profile);
  assert.ok(a.controls.length <= requests.length);
  for (const [i, control] of a.controls.entries()) {
    assert.deepEqual(control.request, requests[i]); assert.ok(Number.isInteger(control.status) && control.status >= 100 && control.status <= 599);
    assert.equal(typeof control.body, "string");
  }
  // A source-bound error string alone does not show any target work. Keep such
  // producer/harness failures, but do not qualify them using an empty OS scope.
  return a.controls.length > 0 || networkObserved(a.network);
}

// status/attemptComplete describe intrinsic replay of requested native work,
// including complete failures. They do not clear the independent OS resource,
// terminal cleanup or observed-launch gates listed in blockers.
export async function inspectSaved(binding, folder) { return inspectLiveSaved(binding, folder, "live-delivery"); }

// Shared by the fixed recovery adapter, not a validator/plugin callback seam.
export async function inspectLiveSaved(binding, folder, group) {
  const apps = binding.selection.apps;
  const result = { status: "blocked", attemptComplete: false, cleanupComplete: false, resources: "blocked",
    outcomes: apps.map((app) => ({ app, outcome: "not-run" })), blockers: [] };
  const missing = new Set();
  const need = (value, code) => { if (!value) missing.add(code); return Boolean(value); };
  let resourceStage = false;
  try {
    assert.ok(["live-delivery", "recoverable-live"].includes(group));
    assert.equal(binding.request.group, group);
    const { round, commit } = binding.request, { effectiveOptions: options, settings } = binding.execution;
    assert.deepEqual(options.apps, apps);
    const names = new Set(await readdir(folder));
    const json = async (file) => JSON.parse(await readFile(join(folder, file), "utf8"));
    if (!need(names.has("plan.json") && names.has("coverage.json") && names.has("source.diff.gz"), "native-plan-coverage-or-source-diff-missing")) {
      result.blockers = [...missing]; return result;
    }
    const plan = await json("plan.json"), ledger = await json("coverage.json");
    for (const key of ["schema", "group", "round", "commit", "apps", "requested", "inventory", "workload", "scenarios", "settings", "code", "contractSha256", "diffSha256", "startedAt"]) {
      present(plan[key], "native-plan-fields-missing");
    }
    for (const [key, expected] of Object.entries({ group, round, commit })) assert.equal(plan[key], expected);
    assert.deepEqual(plan.apps, apps); assert.deepEqual(plan.requested, apps, "partial native selection");
    assert.equal(plan.profile ?? "bounded", options.profile);
    assert.deepEqual(plan.measurement ?? null, settings.measurement);
    for (const key of ["inventory", "workload", "scenarios", "settings"]) assert.deepEqual(plan[key], settings[key]);
    assert.equal(plan.contractSha256, binding.selection.contractSha256);
    assert.deepEqual(ledger.apps, apps); assert.equal(ledger.group, group);
    const caseKey = group === "live-delivery" ? "delivery" : "recovery";
    assert.deepEqual(ledger.cells.map((c) => [c.app, c.case]), apps.map((app) => [app, caseKey]));
    assert.ok(["native-live-plan/v1", "native-live-plan/v2"].includes(plan.schema));
    const diff = gunzipSync(await readFile(join(folder, "source.diff.gz")), { maxOutputLength: 16 * 1024 * 1024 });
    assert.equal(digest(diff), plan.diffSha256); assert.equal(diff.length, 0, "unbound working source diff");
    const sourceFiles = binding.sources.files, sourceMap = new Map(sourceFiles.map((f) => [f.path, f.sha256]));
    assert.equal(sourceMap.size, sourceFiles.length);
    assert.ok(plan.code && typeof plan.code === "object");
    for (const key of Object.keys(plan.code)) assert.ok(Object.hasOwn(codePaths, key));
    for (const [key, path] of Object.entries(codePaths)) {
      if (need(plan.code[key] !== undefined, `native-code-proof-missing:${key}`)) {
        sha(sourceMap.get(path)); assert.equal(plan.code[key], sourceMap.get(path), "native code differs from binding");
      }
    }
    clock(plan.startedAt);
    const provenance = new Map();
    const legacyMeasurements = new Set();
    let allAttempted = true, failed = false, failedEvidenceComplete = true;
    for (const [index, entry] of plan.inventory.entries()) {
      const app = apps[index], cell = ledger.cells[index], outcome = result.outcomes[index];
      assert.equal(entry.app, app); assert.equal(cell.implementation, entry.implementation);
      const supported = entry.implementation === "implemented" && (!entry.profiles || entry.profiles.includes(options.profile));
      const manifestName = `${app}-artifacts.json`, measurementName = `${app}-measurements.json`, failureName = `${app}-failure.json`;
      const startup = names.has(failureName) ? await json(failureName) : null;
      if (startup) {
        assert.equal(startup.app, app); assert.ok(typeof startup.error === "string" && startup.error.length);
        outcome.outcome = "failed"; failed = true;
        if (need(startup.provenance !== undefined, `startup-source-proof-missing:${app}`)) {
          assert.equal(startup.provenance.commit, commit); assert.equal(startup.provenance.round, round);
          assert.equal(startup.provenance.group, group);
          assert.deepEqual(startup.provenance.code, plan.code);
          assert.equal(startup.provenance.diffSha256, plan.diffSha256);
          assert.deepEqual(startup.provenance.sourceHashes, sourceHashes(sourceFiles, entry));
        }
      }
      const retained = [];
      if (names.has(manifestName)) {
        assert.ok(supported); assert.equal(cell.artifact, manifestName);
        const manifest = await json(manifestName); assert.equal(manifest.app, app); assert.equal(manifest.group, group);
        assert.deepEqual(manifest.files.map((f) => f.file), settings.scenarios.map((s) => `${app}-${s}.json.gz`));
        for (const [i, file] of manifest.files.entries()) {
          const bytes = await readFile(join(folder, file.file)); assert.equal(digest(bytes), file.sha256);
          const a = JSON.parse(gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }));
          assert.equal(a.app, app); assert.equal(a.group, group); assert.equal(a.scenario, settings.scenarios[i]);
          assert.equal(a.profile ?? "bounded", options.profile); assert.deepEqual(a.workload, settings.workload);
          assert.deepEqual(a.settings, settings.settings[i]);
          assert.ok(["native-live-evidence/v1", "native-live-failure/v1"].includes(a.schema));
          if (a.schema === "native-live-evidence/v1") for (const key of ["configuration", "controls", "capture", "summary", "network", "failures"]) {
            present(a[key], `native-scenario-raw-proof-missing:${app}`);
          }
          retained.push(a);
        }
      } else {
        if (cell.artifact !== undefined) {
          assert.equal(cell.artifact, manifestName); missing.add(`native-scenario-manifest-missing:${app}`);
        }
        if (supported && !startup) { allAttempted = false; missing.add(`native-scenarios-not-run:${app}`); }
      }
      const qualificationPassed = retained.length > 0 && retained.every((a) => a.schema === "native-live-evidence/v1");
      if (retained.some((a) => a.schema === "native-live-failure/v1")) { failed = true; outcome.outcome = "failed"; }
      if (!supported) { assert.equal(retained.length, 0); assert.equal(startup, null); outcome.outcome = "unsupported"; missing.add(`native-port-unsupported:${app}`); }
      if (names.has(measurementName)) {
        assert.ok(options.measure && qualificationPassed); assert.equal(cell.measurementArtifact, measurementName);
        const measured = await json(measurementName);
        assert.equal(measured.app, app); assert.equal(measured.group, group); assert.deepEqual(measured.profile, settings.measurement);
        assert.deepEqual(measured.files.map((f) => f.file), settings.measurement.clients.map((n) => `${app}-fanout-${n}.json.gz`));
        for (const file of measured.files) {
          const bytes = await readFile(join(folder, file.file)); assert.equal(digest(bytes), file.sha256);
          const a = JSON.parse(gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }));
          if (a.schema === "native-live-fanout-failure/v1") { failed = true; outcome.outcome = "failed"; }
          else if (!need(a.schema === "native-live-fanout/v3", `native-measurement-receipts-missing:${app}`)) {
            assert.ok(["native-live-fanout/v1", "native-live-fanout/v2"].includes(a.schema));
            legacyMeasurements.add(`${app}:${a.clients}`);
          }
          retained.push(a);
        }
      } else {
        assert.equal(cell.measurementArtifact, undefined);
        if (options.measure && qualificationPassed) { allAttempted = false; missing.add(`native-measurements-not-run:${app}`); }
        if (!options.measure) assert.equal(cell.measurement, "not-run");
      }
      for (const a of retained) {
        failedEvidenceComplete &&= observedFailure(a, group, options.profile);
        const p = present(a.provenance, `native-provenance-missing:${app}`); assert.ok(p);
        for (const key of ["commit", "code", "diffSha256", "contractSha256", "sourceHashes", "sourceSha256", "imageSourceSha256", "containerId", "imageId", "nativePort", "processTopology", "processInventory", "container"]) {
          present(p[key], `native-provenance-fields-missing:${app}`);
        }
        assert.equal(p.commit, commit);
        assert.deepEqual(p.code, plan.code); assert.equal(p.diffSha256, plan.diffSha256);
        assert.equal(p.contractSha256, plan.contractSha256);
        assert.deepEqual(p.sourceHashes, sourceHashes(sourceFiles, entry), "native build input closure differs");
        assert.equal(p.sourceSha256, digest(JSON.stringify(p.sourceHashes))); assert.equal(p.imageSourceSha256, p.sourceSha256);
        sha(p.containerId); assert.match(p.imageId ?? "", /^sha256:[a-f0-9]{64}$/);
        assert.equal(p.nativePort, entry.transport);
        assert.equal(p.processTopology, entry.topology ?? "one application process; no broker, database or shared renderer");
        assert.ok(typeof p.processInventory === "string" && /^PID\s+PPID\s+COMMAND\r?\n/.test(p.processInventory));
        if (provenance.has(app)) assert.deepEqual(p, provenance.get(app)); else provenance.set(app, p);
      }
    }
    // Run the committed native validator over the entire tree, not only passing cells.
    let native;
    try { native = await verifyRound(folder); }
    catch (error) {
      if ([...missing].some((m) => m.startsWith("native-scenarios-not-run:"))
        && error?.code === "ERR_ASSERTION" && error.message.split("\n")[0] === "missing native startup failure evidence") {
        result.blockers = [...missing]; return result;
      }
      throw error;
    }
    assert.equal(native.group, group);
    assert.deepEqual(native.missing, apps.filter((app) => !native.passed.includes(app)));
    for (const r of native.unqualified) assert.ok(r.scenario === undefined && legacyMeasurements.has(`${r.app}:${r.clients}`),
      "native retained success contradicts replay");
    if (native.unqualified.length) missing.add("native-retained-captures-unqualified");
    for (const row of result.outcomes) if (row.outcome === "not-run" && native.passed.includes(row.app)
      && (!options.measure || native.measured.includes(row.app))) row.outcome = "passed";
    const passed = result.outcomes.every((r) => r.outcome === "passed");
    if (passed) { assert.deepEqual(native.missing, []); assert.deepEqual(native.unqualified, []); assert.equal(native.readyForLoad, true); }
    resourceStage = true;
    for (const p of provenance.values()) {
      assert.deepEqual(p.container, { nanoCpus: binding.resources.app.cpu * 1e9,
        memory: binding.resources.app.memoryBytes, memorySwap: binding.resources.app.memoryBytes });
    }
    const proofMissing = [...missing].some((m) => !m.startsWith("native-port-unsupported:"));
    result.attemptComplete = allAttempted && !proofMissing && native.unqualified.length === 0;
    result.status = result.attemptComplete ? failed ? "failed" : passed ? "verified" : "blocked" : "blocked";
    result.blockers = [...missing, "native-effective-invocation-build-proof-not-produced",
      "native-actual-browser-driver-os-resource-proof-not-produced", "native-positive-os-terminal-cleanup-proof-not-produced"];
    if (result.attemptComplete) {
      let proof;
      try { proof = phaseProof(binding, folder, plan.startedAt); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (proof?.complete) {
        assert.equal(proof.code, passed ? 0 : 1, "observed exit contradicts native outcomes");
        result.cleanupComplete = true; result.resources = "verified"; result.blockers = [...missing];
        if (!failedEvidenceComplete) {
          result.status = "blocked"; result.attemptComplete = false; result.blockers.push("native-failed-attempt-raw-observation-missing");
        }
      } else if (proof) result.status = "blocked";
    }
    return result;
  } catch (error) {
    // No assertion text, artifact value, subprocess stderr or arbitrary saved error escapes.
    if (error instanceof MissingProof) { result.blockers = [...missing, error.blocker]; return result; }
    if (error?.code === "ENOENT") { result.blockers = [...missing, "native-required-artifact-missing"]; return result; }
    result.status = "invalid"; result.attemptComplete = false;
    if (resourceStage) result.resources = "invalid";
    result.cleanupComplete = false; result.blockers = ["native-live-evidence-contradictory"];
    return result;
  }
}
