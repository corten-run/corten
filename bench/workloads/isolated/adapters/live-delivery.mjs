import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { retainedPrefix, verifyRound } from "../../../live/verify.mjs";
import { groupNames } from "../../registry.mjs";
import { deploymentSha256 } from "../../deployments.mjs";
import { campaignSchema, groupCampaignSchema } from "../campaign-contract.mjs";
import { replaySealedPhase } from "../campaign-journal.mjs";
import { commandResult } from "../composition.mjs";
import { readRegular, tree } from "../evidence.mjs";
import { inspectLifetime, inspectLiveActors } from "../host-lifetime.mjs";
import { nativeControlPartition } from "../native-roles.mjs";
import { verifyOfflineWindow } from "../control-admission.mjs";
import { readLiveWorkloadEnd, verifyHostBoundary, verifyLifetimeSettledBoundary, verifyLiveWorkloadWindows } from "../host-observation.mjs";
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

function phaseProof(binding, folder, startedAt, actors, passed) {
  if (basename(folder) !== "native") return null;
  const phase = dirname(folder), campaignRoot = dirname(phase), campaign = basename(campaignRoot), { group, round, commit } = binding.request;
  assert.match(campaign, new RegExp(`^${round}-[a-f0-9]{16}$`));
  // The outer collector validates the whole campaign. Replay this phase's exact
  // membership too: dedicated campaigns start at zero, not the registry index.
  const planPath = join(campaignRoot, "plan.json"), reservationPath = join(dirname(campaignRoot), ".host-attempt.json");
  const planBytes = readRegular(planPath), reservationBytes = readRegular(reservationPath);
  const plan = JSON.parse(planBytes), reservation = JSON.parse(reservationBytes);
  assert.ok([campaignSchema, groupCampaignSchema].includes(plan.schema), "unknown campaign scope");
  assert.equal(plan.round, round); assert.equal(plan.commit, commit);
  const order = plan.schema === groupCampaignSchema ? [group] : groupNames;
  assert.ok(isDeepStrictEqual(plan.order, order), "campaign group order differs");
  assert.equal(plan.bindings.length, order.length);
  const index = order.indexOf(group); assert.ok(index >= 0);
  assert.ok(isDeepStrictEqual(plan.bindings[index], binding), "campaign phase binding differs");
  const { campaignSha256, ...body } = plan;
  sha(campaignSha256); assert.equal(campaignSha256, deploymentSha256(body));
  assert.equal(reservation.schema, "benchmark-isolated-campaign-reservation/v1");
  assert.equal(reservation.id, campaign); assert.equal(reservation.commit, commit);
  assert.equal(reservation.campaignSha256, campaignSha256);
  assert.equal(basename(phase), `${String(index).padStart(2, "0")}-${group}-timing`);
  const beforeTree = tree(phase);
  const read = (name) => {
    const bytes = readRegular(join(phase, name)), entry = beforeTree.entries.find(({ path }) => path === name);
    assert.equal(digest(bytes), entry?.sha256, "live boundary record differs from phase snapshot");
    return JSON.parse(bytes);
  };
  const nativeManifest = tree(folder);
  assert.ok(isDeepStrictEqual(read("native-manifest.json"), nativeManifest), "native manifest differs");
  const before = read("host-before.json"), after = read("host-after.json");
  const seal = replaySealedPhase(campaignRoot, plan, campaign, group, basename(phase));
  const { phase: recorded, version } = seal, offline = version === 6;
  assert.equal(beforeTree.sha256, recorded.phaseManifestSha256, "live phase differs from journal seal");
  assert.equal(nativeManifest.sha256, recorded.manifestSha256, "live native tree differs from journal seal");
  assert.equal(recorded.results.length, 1); assert.equal(recorded.invocations.length, 1);
  const [record] = recorded.results, [invocation] = recorded.invocations, result = commandResult(record);
  assert.ok(beforeTree.entries.some(({ path, type }) => path === `command-${record.number}.log` && type === "file"),
    "live command log missing from phase seal");
  // The single fresh host has no participant containers outside the native run.
  assert.deepEqual(before.containers, []); assert.deepEqual(after.containers, []);
  const hostPath = `command-${record.number}-host`;
  const names = beforeTree.entries.filter((e) => e.type === "directory" && /^command-\d+-host$/.test(e.path));
  assert.deepEqual(names.map(({ path }) => path), [hostPath], "live phase requires its one exact native command");
  const observation = inspectLifetime(binding, invocation, join(phase, hostPath),
    { campaign, command: record.number, pid: record.pid, result, phase: "timing" });
  assert.equal(observation.manifestSha256, record.hostManifestSha256, "live terminal lifetime differs from journal seal");
  assert.equal(observation.context.bootId, before.bootId);
  if (offline) {
    for (const census of [before, after]) assert.equal(census.controlApparatus, undefined);
    verifyOfflineWindow(read("control-ingress.json"));
  }
  if (beforeTree.entries.some(({ path }) => path === "host-after-settled.json")) {
    assert.ok(version === 5 || offline, "settled live phase lacks monitored or offline scope");
    assert.equal(recorded.transferDestination, `${recorded.key}/native`, "settled live phase lacks its transfer commitment");
    const settled = read("host-after-settled.json");
    if (offline) assert.equal(settled.controlApparatus, undefined);
    verifyLifetimeSettledBoundary({ binding, invocation, round, phase: "timing",
      lifetime: observation, before, after, settled, offline, liveWorkloadEnd() {
        const end = readLiveWorkloadEnd({ binding, invocation, round, phase: "timing", result: record, folder });
        if (!end) return;
        assert.ok(passed && actors, "live workload end requires complete successful measured work");
        verifyLiveWorkloadWindows(before, offline, end, actors.measuredEnds,
          binding.selection.apps.length * binding.execution.settings.measurement.clients.length);
        return end;
      } });
  } else verifyHostBoundary(before, after);
  assert.equal(binding.execution.effectiveOptions.build, true);
  const first = observation.samples[0].at, last = observation.samples.at(-1).at, started = clock(startedAt);
  assert.ok(clock(before.at) <= first && first <= started && started <= last && last <= clock(after.at));
  assert.equal(result.error, null); assert.equal(result.signal, null);
  assert.ok([0, 1].includes(result.code)); assert.equal(result.success, result.code === 0 && !result.cancelled && !result.forced);
  const browser = binding.execution.effectiveOptions.isolated
    ? actors && inspectLiveActors(binding, observation, actors.tools, actors.participants, actors.windows)
    : observation.identities.some((p) => p.type === "--type=renderer");
  assert.ok(isDeepStrictEqual(tree(phase), beforeTree), "external phase evidence mutated");
  seal.verifyUnchanged();
  assert.ok(readRegular(planPath).equals(planBytes) && readRegular(reservationPath).equals(reservationBytes), "campaign membership mutated");
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

export function liveActorWindow(a, app) {
  const { startedAt, endedAt, renderer } = a.actorWindow;
  const valid = (start, end) => Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start;
  assert.ok(valid(startedAt, endedAt));
  const functional = a.schema === "native-live-evidence/v1", measured = a.schema === "native-live-fanout/v3";
  if (renderer === null) {
    // These functional receipts are collected only after newPage succeeds.
    const failedWithPage = a.schema === "native-live-failure/v1"
      && (a.configuration !== undefined || a.controls?.length || a.capture?.records?.length || a.failures?.length || a.html);
    assert.ok(!functional && !measured && !failedWithPage && !a.browsers?.length && !a.network?.length,
      "missing renderer for retained browser activity");
    return { app, startedAt, endedAt, renderer };
  }
  assert.ok(renderer && valid(renderer.startedAt, renderer.endedAt)
    && renderer.startedAt >= startedAt && renderer.endedAt <= endedAt);
  if (functional || measured) assert.ok(renderer.endedAt > renderer.startedAt, "successful scenario has no renderer activity interval");
  if (functional) {
    const { timeOrigin, capturedAt } = a.costs;
    assert.ok(Number.isFinite(timeOrigin) && Number.isFinite(capturedAt) && capturedAt > 0
      && timeOrigin >= renderer.startedAt - 2 && timeOrigin + capturedAt <= renderer.endedAt + 2, "functional browser clock outside scenario activity");
    const lastPageAt = a.capture.records.at(-1)?.at;
    assert.ok(Number.isFinite(lastPageAt) && capturedAt >= lastPageAt, "functional capture precedes the last page record");
    const start = Math.max(renderer.startedAt, Math.ceil(timeOrigin));
    const end = Math.min(renderer.endedAt, Math.floor(timeOrigin + capturedAt) + 1);
    assert.ok(start < end, "functional scenario has no captured activity interval");
    return { app, startedAt, endedAt, renderer: { startedAt: start, endedAt: end } };
  }
  if (measured) {
    const start = Math.ceil(a.host.timeOrigin + a.interval.startedAt), end = Math.floor(a.host.timeOrigin + a.interval.finishedAt);
    assert.ok(valid(start, end) && start < end
      && renderer.startedAt <= start && renderer.endedAt >= end, "measurement outside native actor window");
    return { app, startedAt, endedAt, renderer: { startedAt: start, endedAt: end } };
  }
  return { app, startedAt, endedAt, renderer };
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
    const cancelled = ledger.cancelled === true;
    if (cancelled) missing.add("native-live-run-cancelled");
    const actorFiles = [...names].filter((name) => name.endsWith("-host-actor.json"));
    assert.equal(plan.isolated ?? false, options.isolated ?? false, "live isolation differs from binding");
    const actors = options.isolated ? { tools: null, participants: [], windows: [], measuredEnds: [] } : null;
    if (actors) {
      nativeControlPartition(binding);
      if (need(names.has("host-actor-tools.json"), "native-live-actor-tools-missing")) actors.tools = await json("host-actor-tools.json");
    } else assert.ok(!actorFiles.length && !names.has("host-actor-tools.json"), "live actor receipt has no bound isolation");
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
    let allAttempted = !cancelled, failed = false, failedEvidenceComplete = true;
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
          assert.ok(isDeepStrictEqual(startup.provenance.code, plan.code), "startup code provenance differs");
          assert.equal(startup.provenance.diffSha256, plan.diffSha256);
          assert.ok(isDeepStrictEqual(startup.provenance.sourceHashes, sourceHashes(sourceFiles, entry)), "startup source hashes differ");
        }
      }
      const retained = [];
      if (names.has(manifestName)) {
        assert.ok(supported); assert.equal(cell.artifact, manifestName);
        const manifest = await json(manifestName); assert.equal(manifest.app, app); assert.equal(manifest.group, group);
        retainedPrefix(manifest.files, settings.scenarios.map((s) => `${app}-${s}.json.gz`),
          cancelled || startup, "incomplete native scenarios");
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
        if (retained.length < settings.scenarios.length) {
          allAttempted = false; missing.add(`native-scenarios-not-run:${app}`);
        }
      } else {
        if (cell.artifact !== undefined) {
          assert.equal(cell.artifact, manifestName); missing.add(`native-scenario-manifest-missing:${app}`);
        }
        if (supported && !startup) { allAttempted = false; missing.add(`native-scenarios-not-run:${app}`); }
      }
      const qualificationPassed = retained.length === settings.scenarios.length && retained.every((a) => a.schema === "native-live-evidence/v1");
      if (retained.some((a) => a.schema === "native-live-failure/v1")) { failed = true; outcome.outcome = "failed"; }
      if (!supported) { assert.equal(retained.length, 0); assert.equal(startup, null); outcome.outcome = "unsupported"; missing.add(`native-port-unsupported:${app}`); }
      if (names.has(measurementName)) {
        assert.ok(options.measure && qualificationPassed); assert.equal(cell.measurementArtifact, measurementName);
        const measured = await json(measurementName);
        assert.equal(measured.app, app); assert.equal(measured.group, group); assert.deepEqual(measured.profile, settings.measurement);
        retainedPrefix(measured.files, settings.measurement.clients.map((n) => `${app}-fanout-${n}.json.gz`),
          cancelled || startup, "incomplete native measurements");
        if (measured.files.length < settings.measurement.clients.length) {
          allAttempted = false; missing.add(`native-measurements-not-run:${app}`);
        }
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
      const actorName = `${app}-host-actor.json`;
      if (actors && retained.length && need(names.has(actorName), `native-live-application-actor-missing:${app}`)) {
        const actor = await json(actorName);
        assert.equal(actor.app, app); assert.equal(actor.role, "application");
        assert.equal(actor.id, retained[0].provenance.containerId); assert.equal(actor.imageId, retained[0].provenance.imageId);
        actors.participants.push(actor);
        actorFiles.splice(actorFiles.indexOf(actorName), 1);
      }
      for (const a of retained) {
        failedEvidenceComplete &&= observedFailure(a, group, options.profile);
        const p = present(a.provenance, `native-provenance-missing:${app}`); assert.ok(p);
        for (const key of ["commit", "code", "diffSha256", "contractSha256", "sourceHashes", "sourceSha256", "imageSourceSha256", "containerId", "imageId", "nativePort", "processTopology", "processInventory", "container"]) {
          present(p[key], `native-provenance-fields-missing:${app}`);
        }
        assert.equal(p.commit, commit);
        assert.ok(isDeepStrictEqual(p.code, plan.code), "native code provenance differs"); assert.equal(p.diffSha256, plan.diffSha256);
        assert.equal(p.contractSha256, plan.contractSha256);
        assert.ok(isDeepStrictEqual(p.sourceHashes, sourceHashes(sourceFiles, entry)), "native build input closure differs");
        assert.equal(p.sourceSha256, digest(JSON.stringify(p.sourceHashes))); assert.equal(p.imageSourceSha256, p.sourceSha256);
        sha(p.containerId); assert.match(p.imageId ?? "", /^sha256:[a-f0-9]{64}$/);
        assert.equal(p.nativePort, entry.transport);
        assert.equal(p.processTopology, entry.topology ?? "one application process; no broker, database or shared renderer");
        assert.ok(typeof p.processInventory === "string" && /^PID\s+PPID\s+COMMAND\r?\n/.test(p.processInventory));
        if (provenance.has(app)) assert.ok(isDeepStrictEqual(p, provenance.get(app)), "native build provenance differs"); else provenance.set(app, p);
        if (actors && need(a.actorWindow?.renderer !== undefined, `native-live-actor-window-missing:${app}`)) {
          actors.windows.push(liveActorWindow(a, app));
          if (a.schema === "native-live-fanout/v3") actors.measuredEnds.push(a.actorWindow.endedMonoNs);
        }
      }
    }
    if (actorFiles.length) {
      // A native startup/harness failure can leave a container receipt before
      // any replayable browser work. Keep its failure, never clear resources.
      assert.ok(actorFiles.every((name) => apps.some((app, i) => name === `${app}-host-actor.json`
        && (names.has(`${app}-failure.json`) || (cancelled && ledger.cells[i].reason === "Cancelled before first scenario")))),
        "unbound native live actor receipt");
      missing.add("native-live-actor-without-browser-evidence");
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
    if (passed) { assert.deepEqual(native.missing, []); assert.deepEqual(native.unqualified, []); assert.equal(native.readyForLoad, !cancelled); }
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
      try { proof = phaseProof(binding, folder, plan.startedAt, actors, passed); }
      catch (error) {
        if (error?.code !== "ENOENT") throw error;
        result.status = "blocked";
      }
      if (proof) assert.equal(proof.code, passed ? 0 : 1, "observed exit contradicts native outcomes");
      if (proof?.complete) {
        result.cleanupComplete = true; result.resources = "verified"; result.blockers = [...missing];
      } else if (proof) {
        // Keep the app dispositions as diagnostics, not a verified phase failure.
        result.status = "blocked";
      }
      if (proof && !failedEvidenceComplete) {
        result.status = "blocked"; result.attemptComplete = false; result.blockers.push("native-failed-attempt-raw-observation-missing");
      }
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
