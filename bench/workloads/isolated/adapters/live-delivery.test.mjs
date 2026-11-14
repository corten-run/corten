import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { contractSha256, selectedApps } from "../../registry.mjs";
import { coverage } from "../../evidence.mjs";
import { inventory, scenarios, settingsFor, workloadFor } from "../../../live/native.mjs";
import { fanoutProfile } from "../../../live/fanout.mjs";
import { verifyRound } from "../../../live/verify.mjs";

export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const paths = { runner: "bench/live/parity.mjs", verifier: "bench/live/verify.mjs", oracle: "bench/workloads/live.mjs",
  native: "bench/live/native.mjs", wire: "bench/live/wire.mjs", fanout: "bench/live/fanout.mjs",
  resources: "bench/live/resources.mjs", admission: "bench/live/admission.mjs", measurement: "bench/live/measurement.mjs",
  nativeHttp: "bench/live/native-http.mjs" };

// Synthetic retained FAILURE apparatus, never a native positive qualification.
// Every test uses the real statically imported verifier; no validator is mocked.
export async function syntheticFixture(t, group = "live-delivery", { allRegistered = false, round = "synthetic-adapter" } = {}) {
  const folder = await mkdtemp(join(tmpdir(), "isolated-live-adapter-test-"));
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(folder)); assert.ok(rel && rel !== ".." && !rel.startsWith(`..${sep}`));
    await rm(folder, { recursive: true, force: true });
  });
  const apps = selectedApps(group), profile = "native-feed", commit = "a".repeat(40);
  // Preserve a historical missing-port control independently of today's registrations.
  const entries = inventory(group, profile).map((entry, index, rows) => !allRegistered && index === rows.length - 1
    ? { app: entry.app, implementation: "not-implemented",
      reason: `Missing ${entry.app} native keyed browser application, bounded queue/history instrumentation and recovery port under bench/live/apps; historical transport-only code is not parity` }
    : entry);
  const sourceFiles = Object.entries(paths).map(([key, path]) => ({ path, mode: "100644", sha256: hash(`synthetic code ${key}`) }));
  for (const entry of entries.filter((r) => r.implementation === "implemented")) {
    sourceFiles.push({ path: `bench/live/apps/${entry.directory}/synthetic-input.txt`, mode: "100644", sha256: hash(`synthetic app ${entry.app}`) });
  }
  sourceFiles.push(...["crates/synthetic.rs", "Cargo.toml", "Cargo.lock"].map((path) => ({ path, mode: "100644", sha256: hash(`synthetic ${path}`) })));
  const code = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, sourceFiles.find((f) => f.path === path).sha256]));
  const settings = { inventory: entries, workload: workloadFor(profile), scenarios: scenarios(group),
    settings: scenarios(group).map((s) => settingsFor(group, s, profile)), measurement: null };
  const options = { apps, build: true, profile, measure: false };
  const invocation = { executable: "node", argv: [group === "live-delivery" ? "bench/live/run.mjs" : "bench/recoverable-live/run.mjs", round,
    ...(group === "live-delivery" ? ["--group", group] : []), "--build", "--profile", profile], cwd: "repository-root", shell: false };
  const binding = { request: { group, round, commit }, selection: { apps, contractSha256: contractSha256(group) },
    execution: { invocation, effectiveOptions: options, settings }, sources: { files: sourceFiles },
    resources: { app: { cpu: 1, memoryBytes: 1073741824 }, state: "blocked" }, review: { state: "unknown" }, status: { executionAuthorized: false } };
  const plan = { schema: "native-live-plan/v2", group, round, commit, apps, requested: apps, profile, ...settings,
    code, diffSha256: hash(""), contractSha256: binding.selection.contractSha256, startedAt: "2026-11-13T00:00:01.000Z",
    budget: { appCpus: 1, appMemoryBytes: 1073741824, browsers: 1, clients: 1 } };
  const json = async (file, value) => writeFile(join(folder, file), JSON.stringify(value));
  const compressed = async (file, value) => { const bytes = gzipSync(JSON.stringify(value)); await writeFile(join(folder, file), bytes); return { file, sha256: hash(bytes) }; };
  const cells = [];
  for (const entry of entries) {
    const app = entry.app, available = entry.implementation === "implemented";
    if (!available) { cells.push({ app, case: group === "live-delivery" ? "delivery" : "recovery", implementation: entry.implementation,
      parity: "not-run", measurement: "not-run", reason: entry.reason }); continue; }
    const appHashes = { "synthetic-input.txt": hash(`synthetic app ${app}`) };
    const sourceHashes = entry.rootContext ? { app: appHashes, crates: { "synthetic.rs": hash("synthetic crates/synthetic.rs") },
      cargo: hash("synthetic Cargo.toml"), lock: hash("synthetic Cargo.lock") } : appHashes;
    const provenance = { commit, code, diffSha256: plan.diffSha256, contractSha256: plan.contractSha256, sourceHashes,
      sourceSha256: hash(JSON.stringify(sourceHashes)), imageSourceSha256: hash(JSON.stringify(sourceHashes)),
      containerId: hash(`synthetic container ${app}`), imageId: `sha256:${hash(`synthetic image ${app}`)}`, nativePort: entry.transport,
      processTopology: entry.topology ?? "one application process; no broker, database or shared renderer", processInventory: "PID PPID COMMAND\n1001 1 synthetic\n",
      container: { nanoCpus: 1000000000, memory: 1073741824, memorySwap: 1073741824 } };
    const files = [];
    for (const [i, scenario] of settings.scenarios.entries()) files.push(await compressed(`${app}-${scenario}.json.gz`, {
      schema: "native-live-failure/v1", app, group, scenario, profile, provenance,
      workload: settings.workload, settings: settings.settings[i], error: "synthetic retained journey failure" }));
    const manifestName = `${app}-artifacts.json`; await json(manifestName, { app, group, files });
    cells.push({ app, case: group === "live-delivery" ? "delivery" : "recovery", implementation: "implemented", parity: "failed", measurement: "not-run",
      reason: `0/${settings.scenarios.length} bounded native browser journeys passed; no load qualification`, artifact: manifestName });
  }
  const ledger = coverage(group, cells); ledger.readyForLoad = false;
  await json("plan.json", plan); await json("coverage.json", ledger); await writeFile(join(folder, "source.diff.gz"), gzipSync(""));
  return { folder, binding, plan, ledger, json, compressed };
}

export async function rewriteArtifact(f, app, index, change) {
  const manifest = JSON.parse(await readFile(join(f.folder, `${app}-artifacts.json`), "utf8"));
  const a = JSON.parse(gunzipSync(await readFile(join(f.folder, manifest.files[index].file))));
  change(a); manifest.files[index] = await f.compressed(manifest.files[index].file, a);
  await f.json(`${app}-artifacts.json`, manifest);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const { inspectSaved } = await import("./live-delivery.mjs");
  for (const group of ["live-delivery", "recoverable-live"]) test(`${group}: current registered matrix binds native HTTP code without qualifying failed targets`, async (t) => {
    const f = await syntheticFixture(t, group, { allRegistered: true });
    const { inspectLiveSaved } = await import("./live-delivery.mjs");
    const r = await inspectLiveSaved(f.binding, f.folder, group);
    assert.ok(f.plan.inventory.every((entry) => entry.implementation === "implemented"));
    assert.equal(r.status, "failed"); assert.equal(r.attemptComplete, true);
    assert.ok(r.outcomes.every((row) => row.outcome === "failed"));
    assert.equal(r.resources, "blocked"); assert.equal(r.cleanupComplete, false);
  });
  for (const mutation of ["missing", "mismatched", "rehashed-provenance"]) test(`native HTTP ${mutation} cannot escape the committed code closure`, async (t) => {
    const f = await syntheticFixture(t);
    if (mutation === "missing") delete f.plan.code.nativeHttp;
    else f.plan.code.nativeHttp = "b".repeat(64);
    await f.json("plan.json", f.plan);
    if (["missing", "rehashed-provenance"].includes(mutation)) for (const entry of f.plan.inventory.filter((e) => e.implementation === "implemented")) {
      for (let i = 0; i < f.plan.scenarios.length; i++) await rewriteArtifact(f, entry.app, i, (a) => { a.provenance.code = f.plan.code; });
    }
    const r = await inspectSaved(f.binding, f.folder);
    assert.equal(r.status, mutation === "missing" ? "blocked" : "invalid");
    assert.equal(r.attemptComplete, false); assert.equal(r.cleanupComplete, false);
  });
  test("native app source closure excludes only direct test receipts, not other test or nested inputs", async (t) => {
    const f = await syntheticFixture(t);
    for (const path of ["test/receipts/private.txt", "test/receipts-final/retained.txt", "test/receipts-extra/input.txt", "nested/test/receipts/input.txt"]) {
      f.binding.sources.files.push({ path: `bench/live/apps/aspnet/${path}`, mode: "100644", sha256: hash(path) });
    }
    for (let i = 0; i < f.plan.scenarios.length; i++) await rewriteArtifact(f, "aspnet", i, (a) => {
      for (const path of ["test/receipts-extra/input.txt", "nested/test/receipts/input.txt"]) a.provenance.sourceHashes[path] = hash(path);
      a.provenance.sourceSha256 = a.provenance.imageSourceSha256 = hash(JSON.stringify(a.provenance.sourceHashes));
    });
    const r = await inspectSaved(f.binding, f.folder);
    assert.equal(r.status, "failed"); assert.equal(r.attemptComplete, true);
    await rewriteArtifact(f, "aspnet", 0, (a) => {
      delete a.provenance.sourceHashes["test/receipts-extra/input.txt"];
      a.provenance.sourceSha256 = a.provenance.imageSourceSha256 = hash(JSON.stringify(a.provenance.sourceHashes));
    });
    assert.equal((await inspectSaved(f.binding, f.folder)).status, "invalid");
  });
  test("real verifier replays synthetic failed native attempt, retaining failures and unsupported contenders", async (t) => {
    const f = await syntheticFixture(t), native = await verifyRound(f.folder), r = await inspectSaved(f.binding, f.folder);
    assert.deepEqual(native.passed, []); assert.deepEqual(native.unqualified, []);
    assert.equal(r.status, "failed"); assert.equal(r.attemptComplete, true);
    assert.equal(r.cleanupComplete, false); assert.equal(r.resources, "blocked");
    assert.ok(r.outcomes.some((o) => o.outcome === "failed")); assert.ok(r.outcomes.some((o) => o.outcome === "unsupported"));
    assert.deepEqual(r.outcomes.map((o) => o.app), f.binding.selection.apps);
    assert.ok(r.blockers.includes("native-effective-invocation-build-proof-not-produced"));
    assert.ok(r.blockers.includes("native-positive-os-terminal-cleanup-proof-not-produced"));
  });
  for (const [name, change] of [
    ["group", (f) => { f.plan.group = "recoverable-live"; }], ["round", (f) => { f.plan.round = "another"; }],
    ["commit", (f) => { f.plan.commit = "b".repeat(40); }], ["subset", (f) => { f.plan.requested.pop(); }],
    ["profile", (f) => { f.plan.profile = "bounded"; }], ["measure", (f) => { f.plan.measurement = fanoutProfile; }],
    ["settings", (f) => { f.plan.settings[0].queueLimit++; }], ["scenario", (f) => { f.plan.scenarios.pop(); }],
    ["code", (f) => { f.plan.code.runner = "b".repeat(64); }], ["cell matrix", (f) => { f.ledger.cells.pop(); }],
  ]) test(`rejects synthetic conflicting ${name}`, async (t) => {
    const f = await syntheticFixture(t); f.plan = structuredClone(f.plan); f.ledger = structuredClone(f.ledger); change(f);
    await f.json("plan.json", f.plan); await f.json("coverage.json", f.ledger);
    assert.equal((await inspectSaved(f.binding, f.folder)).status, "invalid");
  });
  for (const [name, change] of [
    ["source closure", (a) => { a.provenance.sourceHashes["unbound.txt"] = "b".repeat(64); a.provenance.sourceSha256 = hash(JSON.stringify(a.provenance.sourceHashes)); a.provenance.imageSourceSha256 = a.provenance.sourceSha256; }],
    ["workload", (a) => { a.workload.eventCount++; }], ["native transport", (a) => { a.provenance.nativePort = "another transport"; }],
    ["actual CPU quota", (a) => { a.provenance.container.nanoCpus = 2e9; }],
  ]) test(`rehashed retained failure cannot change ${name}`, async (t) => {
    const f = await syntheticFixture(t); await rewriteArtifact(f, "aspnet", 0, change);
    assert.equal((await inspectSaved(f.binding, f.folder)).status, "invalid");
  });
  test("missing artifact remains blocked and saved error text never escapes", async (t) => {
    const f = await syntheticFixture(t); await rm(join(f.folder, "aspnet-normal.json.gz"));
    assert.equal((await inspectSaved(f.binding, f.folder)).status, "blocked");
    await writeFile(join(f.folder, "aspnet-normal.json.gz"), "SYNTHETIC_PRIVATE_SENTINEL");
    const r = await inspectSaved(f.binding, f.folder); assert.equal(r.status, "invalid");
    assert.ok(!JSON.stringify(r).includes("SYNTHETIC_PRIVATE_SENTINEL"));
  });
  test("missing source provenance is blocked rather than relabeled a contradictory native failure", async (t) => {
    const f = await syntheticFixture(t); await rewriteArtifact(f, "aspnet", 0, (a) => { delete a.provenance; });
    const r = await inspectSaved(f.binding, f.folder); assert.equal(r.status, "blocked"); assert.equal(r.attemptComplete, false);
    assert.equal(r.outcomes.find((o) => o.app === "aspnet").outcome, "failed");
    assert.ok(r.blockers.includes("native-provenance-missing:aspnet"));
  });
  test("archive validator code and made-up positive receipts are never executed or accepted", async (t) => {
    const f = await syntheticFixture(t); await writeFile(join(f.folder, "verify.mjs"), 'throw new Error("archive execution forbidden");');
    f.plan.runtime = { complete: true, cleanupComplete: true, resources: "verified" };
    await f.json("plan.json", f.plan);
    const r = await inspectSaved(f.binding, f.folder); assert.equal(r.status, "failed");
    assert.equal(r.resources, "blocked"); assert.equal(r.cleanupComplete, false);
  });
  test("actual retained v3 fixture stays read-only and cannot become an exact full-inventory run", async () => {
    const folder = fileURLToPath(new URL("../../../live/evidence/review-v3-express/", import.meta.url));
    const before = await Promise.all((await readdir(folder)).sort().map(async (file) => [file, hash(await readFile(join(folder, file)))]));
    const native = await verifyRound(folder); assert.deepEqual(native.passed, ["express"]); assert.deepEqual(native.measured, ["express"]);
    const plan = JSON.parse(await readFile(join(folder, "plan.json"), "utf8"));
    const binding = { request: { group: plan.group, round: plan.round, commit: plan.commit }, selection: { apps: plan.apps },
      execution: { effectiveOptions: { apps: plan.apps, profile: plan.profile, measure: true }, settings: { measurement: plan.measurement } } };
    assert.equal((await inspectSaved(binding, folder)).status, "invalid");
    assert.deepEqual(await Promise.all(before.map(async ([file]) => [file, hash(await readFile(join(folder, file)))])), before);
  });
}
