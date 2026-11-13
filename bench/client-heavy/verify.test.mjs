import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm, link, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { definition, selectedApps } from "../workloads/registry.mjs";
import { createClientWorkload, validateClientCapture } from "../workloads/client.mjs";
import { cliOptions, validateSaved } from "./verify.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const git = (args, input) => execFileSync("git", args, { cwd: root, input, maxBuffer: 64 * 1024 ** 2 });
const commit = git(["rev-parse", "HEAD"]).toString().trim(), apps = selectedApps("client-heavy");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sources = new Map();
const paths = git(["ls-tree", "-r", "--name-only", commit, "--", "crates", "bench/client-heavy", "bench/browser/gen",
  "bench/workloads/client.mjs", "bench/workloads/registry.mjs", "bench/browser/package-lock.json", "package-lock.json"])
  .toString().trim().split("\n");
const batch = git(["cat-file", "--batch"], paths.map((path) => `${commit}:${path}\n`).join(""));
let offset = 0;
for (const path of paths) {
  const end = batch.indexOf(10, offset), size = Number(batch.subarray(offset, end).toString().split(" ")[2]);
  offset = end + 1; sources.set(path, batch.subarray(offset, offset + size)); offset += size + 1;
}
assert.equal(offset, batch.length);
const zero = () => ({ subscriptions: 0, connections: 0, listeners: 0, timers: 0, pendingTasks: 0 });
const workload = createClientWorkload({ seed: 7, rowCount: 8, largeRowCount: 10, appendCount: 1, dashboardCount: 2 });
const settings = { maxCleanupMs: 10, cleanupObservationMs: 5 };

// Synthetic saved test observations, NOT native framework/build evidence. This
// independent reducer deliberately does not call the oracle's clientSnapshot.
function capture(app) {
  const records = [];
  let rows = structuredClone(workload.initial.rows), cards = structuredClone(workload.initial.cards);
  let next = rows.length + 1, selected = null, filter = "", direction = null, tick = 0, at = 0, id = 0;
  const add = (kind, fields = {}) => records.push({ kind, at: ++at, ...structuredClone(fields) });
  const make = (n) => Array.from({ length: n }, () => { const i = next++; return { id: `row-${i}`, label: `group-${(7 + i) % 7} row-${i}` }; });
  const dom = () => {
    let visible = rows.filter((r) => r.label.includes(filter));
    if (direction) visible = [...visible].sort((a, b) => (direction === "asc" ? 1 : -1) * (+a.id.slice(4) - +b.id.slice(4)));
    return { id: `dom-${++id}`, rows: visible.map((r) => ({ ...r, node: `node-${r.id}` })),
      selected: visible.some((r) => r.id === selected) ? selected : null,
      cards: cards.map((r) => ({ ...r, node: `node-${r.id}` })), totalMinor: cards.reduce((s, c) => s + c.priceMinor, 0) };
  };
  add("resources", { owned: zero() });
  add("initial", { data: workload.initial, dom: dom(), errors: [] });
  add("resources", { owned: { ...zero(), subscriptions: 1 } });
  for (const op of workload.operations) {
    if (op.kind === "update-tenth") rows.forEach((r, i) => { if (!(i % 10)) r.label += " !!!"; });
    if (op.kind === "select") selected = op.key;
    if (op.kind === "swap") [rows[1], rows[rows.length - 2]] = [rows[rows.length - 2], rows[1]];
    if (op.kind === "filter") filter = op.text;
    if (op.kind === "sort") direction = op.direction;
    if (op.kind === "remove") rows = rows.filter((r) => r.id !== op.key);
    if (op.kind === "patch-one") rows[Math.floor(rows.length / 2)].label += " *";
    if (op.kind === "patch-many") for (let i = 0; i < Math.min(100, rows.length); i++) rows[i * (rows.length % 97 ? 97 : 1) % rows.length].label += " *";
    if (op.kind === "append") rows.push(...make(workload.appendCount));
    if (["clear", "create-small", "replace-small", "create-large"].includes(op.kind)) {
      rows = op.kind === "clear" ? [] : make(op.kind === "create-large" ? workload.largeRowCount : workload.rowCount);
      selected = null; filter = ""; direction = null;
    }
    if (op.kind === "tick") {
      tick++;
      for (let k = 0; k < op.count; k++) { const i = (k + tick) % cards.length; cards[i].priceMinor = 10000 + (i % 17) * 100 + tick * 13 + i; }
    }
    add("operation", { operation: op, dom: dom(), network: [], errors: [] });
  }
  add("detach"); add("resources", { owned: zero() });
  add("cleanup-probe", { input: workload.cleanupProbe, network: [] }); add("resources", { owned: zero() });
  at += settings.cleanupObservationMs;
  add("state", { dom: dom(), owned: zero(), network: [], errors: [] });
  return { schema: "client-capture/v1", app, effectiveWorkload: workload, outcome: "captured", reason: null, records };
}
function pass(app, measured) {
  const c = capture(app);
  return { capture: c, oracle: validateClientCapture(workload, c, settings), readyMs: 1,
    actions: measured ? workload.operations.map((op) => ({ operation: op.id, kind: op.kind, elapsedMs: 0.25 })) : null,
    resourceDetails: [], failure: null };
}
const requiredSources = ["bench/client-heavy/run.mjs", "bench/client-heavy/build.mjs", "bench/client-heavy/observer.mjs",
  "bench/workloads/client.mjs", "bench/workloads/registry.mjs", "bench/browser/package-lock.json", "package-lock.json",
  "bench/browser/gen/Cargo.toml", "bench/browser/gen/src/bin/client.rs", ...paths.filter((p) => p.startsWith("crates/"))];
async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), "client-heavy-saved-"));
  t.after(async () => {
    const rel = relative(tmpdir(), folder);
    assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
    await rm(folder, { recursive: true, force: true });
  });
  const write = async (path, bytes) => { await mkdir(dirname(join(folder, path)), { recursive: true }); await writeFile(join(folder, path), bytes); };
  const json = (path, value) => write(path, JSON.stringify(value, null, 2) + "\n");
  const result = { schema: "client-heavy-native/v1", group: "client-heavy", round: "test-round", effectiveWorkload: workload,
    settings, timeoutMs: 30000, selectedApps: apps, definition: definition("client-heavy"), builds: {}, cells: {}, passed: true,
    readyForLoad: false, cleanupFailures: [], provenance: { commit, dirty: false,
      sources: Object.fromEntries(requiredSources.map((path) => [path, hash(sources.get(path))])), diffSha256: hash(""),
      node: process.version, platform: process.platform, release: "fixture", cpu: "fixture", logicalCpus: 1, browser: "fixture",
      browserInstances: 1, rendererProcessLimit: 1, concurrentPages: 1, passes: 2, note: "Synthetic unit fixture, never native evidence" } };
  for (const app of apps) {
    result.cells[app] = { outcome: "passed", qualification: pass(app, false), measurement: pass(app, true), readyForMeasurement: true };
    const bundle = app === "corten" ? "client.js" : "app.js", code = `throw new Error("saved code must never execute"); // ${app}\n`;
    const artifacts = { "index.html": "<!doctype html><title>Synthetic unit fixture</title>", [bundle]: code };
    if (app === "corten") Object.assign(artifacts, { "runtime.js": sources.get("crates/corten/js/dist/corten.js"), "views.js": "// synthetic generated views\n" });
    for (const [name, bytes] of Object.entries(artifacts)) await write(`native/${app}/${name}`, bytes);
    if (app === "corten") for (const name of ["screen.html", "client.footer.js", "views.d.ts", "build.log"]) await write(`native/corten/${name}`, "synthetic generator output\n");
    const entry = app === "corten" ? "bench/browser/gen/src/bin/client.js"
      : `bench/client-heavy/apps/${app}.${["react", "solid"].includes(app) ? "jsx" : app === "remix" ? "tsx" : "js"}`;
    const inputs = [entry, "bench/client-heavy/apps/input.js"];
    if (["vue", "svelte"].includes(app)) inputs.push(`bench/client-heavy/apps/${app}.${app === "vue" ? "vue" : "svelte"}`);
    result.builds[app] = { outcome: "built", inputs: inputs.map((path) => ({ path, sha256: hash(sources.get(path)) })),
      bundleSha256: hash(code), bytes: Buffer.byteLength(code), artifacts: Object.fromEntries(Object.entries(artifacts).map(([name, bytes]) => [name, hash(bytes)])) };
    if (app !== "corten") result.builds[app].inputs.push({ path: `bench/browser/node_modules/${app}/index.js`, sha256: hash("unsaved dependency") });
  }
  const save = async () => {
    await json("result.json", result); await json("native/build.json", result.builds); await json("native/workload.json", result.effectiveWorkload);
    for (const app of apps) await json(`${app}.json`, result.cells[app]);
  };
  await save();
  return { folder, result, save, json, write, validate: () => validateSaved({ folder, round: result.round, commit }) };
}
const invalid = (r, reason) => {
  assert.equal(r.status, "invalid", JSON.stringify(r.errors)); assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.reason === reason || e.reason.includes(reason)), JSON.stringify(r.errors));
};

test("full synthetic saved tree replays but v1 proof gaps block every native/ranking positive", async (t) => {
  const f = await fixture(t), before = await f.validate(), after = await f.validate();
  assert.equal(before.status, "blocked", JSON.stringify(before.errors)); assert.equal(before.diagnosticsPassed, true);
  assert.deepEqual(after, before);
  for (const key of ["valid", "ready", "readyForLoad", "rankingEligible"]) assert.equal(before[key], false);
  assert.equal(before.isolation, "unknown"); assert.equal(before.cells.react.replayPassed, true);
  assert.equal(before.cells.react.measurement.derived.observedOperations, 19);
  assert.equal(before.cells.react.measurement.derived.postProbeObservationMs, 7);
  assert.equal(before.cells.react.measurement.timings, null);
  for (const file of before.files) assert.equal(hash(await readFile(join(f.folder, file.path))), file.sha256, "read-only tree unchanged");
  assert.ok(before.blockers.some((b) => b.includes("source-to-bundle")));
});

const mutations = {
  "wrong round": ["wrong-run-identity", (f) => { f.result.round = "another"; }],
  "wrong commit": ["wrong-source-provenance", (f) => { f.result.provenance.commit = "0".repeat(40); }],
  "subset inventory": ["incomplete-or-changed-registry-inventory", (f) => { f.result.selectedApps = ["corten"]; }],
  "duplicate inventory": ["incomplete-or-changed-registry-inventory", (f) => { f.result.selectedApps = [...apps, "corten"]; }],
  "changed group definition": ["incomplete-or-changed-registry-inventory", (f) => { f.result.definition = { popular: ["react"] }; }],
  "missing app cell": ["incomplete-cell-inventory", (f) => { delete f.result.cells.remix; }],
  "missing build": ["incomplete-build-inventory", (f) => { delete f.result.builds.remix; }],
  "wrong raw workload": ["wrong-workload-plan", (f) => { f.result.effectiveWorkload = { ...workload, seed: 8 }; }],
  "weakened cleanup bounds": ["invalid-run-options", (f) => { f.result.settings = { ...settings, cleanupObservationMs: 0 }; }],
  "invalid timeout": ["invalid-run-options", (f) => { f.result.timeoutMs = 10; }],
  "missing source inventory": ["incomplete-source-provenance-inventory", (f) => { delete f.result.provenance.sources["bench/client-heavy/run.mjs"]; }],
  "forged source digest": ["source-digest-differs-from-exact-commit", (f) => { f.result.provenance.sources["bench/client-heavy/run.mjs"] = hash("forged"); }],
  "clean nonempty diff": ["clean-source-with-nonempty-diff", (f) => { f.result.provenance.diffSha256 = hash("diff"); }],
  "forged build input": ["build-input-differs-from-exact-source", (f) => { f.result.builds.react.inputs[0].sha256 = hash("forged"); }],
  "duplicate build input": ["duplicate-or-invalid-build-input", (f) => { f.result.builds.react.inputs.push(f.result.builds.react.inputs[0]); }],
  "case duplicate build input": ["duplicate-or-invalid-build-input", (f) => { f.result.builds.react.inputs.push({ ...f.result.builds.react.inputs[0], path: f.result.builds.react.inputs[0].path.toUpperCase() }); }],
  "path traversal build input": ["unsafe-path", (f) => { f.result.builds.react.inputs[0].path = "../../private"; }],
  "absolute artifact path": ["incomplete-build-artifacts", (f) => { f.result.builds.react.artifacts["/private"] = hash("x"); }],
  "bundle byte count": ["bundle-metrics-differ-from-bytes", (f) => { f.result.builds.react.bytes++; }],
  "bundle hash": ["bundle-metrics-differ-from-bytes", (f) => { f.result.builds.react.bundleSha256 = hash("forged"); }],
  "summary pass flag": ["summary-passed-differs-from-replayed-evidence", (f) => { f.result.passed = false; }],
  "summary native ready": ["invalid-summary-readiness", (f) => { f.result.readyForLoad = true; }],
  "cell ready flag": ["cell-flags-differ-from-raw-replay", (f) => { f.result.cells.react.readyForMeasurement = false; }],
  "forged oracle": ["saved-oracle-differs-from-raw-replay", (f) => { f.result.cells.react.measurement.oracle.observedOperations = 0; }],
  "bad measured timing": ["invalid-measured-action", (f) => { f.result.cells.react.measurement.actions[0].elapsedMs = -1; }],
  "incomplete timings": ["incomplete-measured-actions", (f) => { f.result.cells.react.measurement.actions.pop(); }],
  "qualification timing": ["qualification-has-action-timings", (f) => { f.result.cells.react.qualification.actions = []; }],
  "inactive subscription": ["missing-real-active-subscription", (f) => { f.result.cells.react.qualification.capture.records[2].owned.subscriptions = 0; }],
  "invented resource details": ["invalid-native-resource-detail", (f) => { f.result.cells.react.measurement.resourceDetails = [{ type: "click", target: "Window", connected: null, pageOwned: "yes", property: false }]; }],
  "raw operation HTTP": ["operation HTTP", (f) => { f.result.cells.react.measurement.capture.records[3].network.push({ transport: "http" }); }],
  "raw keyed row change": ["wrong independent DOM", (f) => { f.result.cells.react.measurement.capture.records[3].dom.rows[0].label = "forged"; }],
  "raw terminal cleanup leak": ["missing post-probe", (f) => { f.result.cells.react.measurement.capture.records.at(-1).owned.timers = 1; }],
};
for (const [name, [reason, mutate]] of Object.entries(mutations)) test(`rejects ${name} even when raw summaries agree`, async (t) => {
  const f = await fixture(t); await mutate(f); await f.save();
  // Request identity is external, not copied from the mutated summary.
  invalid(await validateSaved({ folder: f.folder, round: "test-round", commit }), reason);
});

test("replays both raw passes even when qualification is corrupt", async (t) => {
  const f = await fixture(t);
  for (const phase of ["qualification", "measurement"]) f.result.cells.react[phase].capture.records[3].network.push({ transport: "http" });
  await f.save(); const r = await f.validate();
  assert.ok(r.errors.some((e) => e.at === "react:qualification")); assert.ok(r.errors.some((e) => e.at === "react:measurement"));
});

for (const [name, path, value, reason] of [
  ["app mismatch", "react.json", {}, "raw-app-differs-from-summary"],
  ["build mismatch", "native/build.json", {}, "raw-builds-differ-from-summary"],
  ["workload mismatch", "native/workload.json", {}, "native-workload-differs-from-plan"],
]) test(`rejects raw ${name}`, async (t) => { const f = await fixture(t); await f.json(path, value); invalid(await f.validate(), reason); });

test("hashes actual bundle bytes instead of trusting the saved hash", async (t) => {
  const f = await fixture(t); await f.write("native/react/app.js", "forged bytes");
  invalid(await f.validate(), "native-artifact-hash-mismatch");
});
test("self-consistent forged bundle remains blocked, never source/build-qualified", async (t) => {
  const f = await fixture(t), code = "// forged bundle and consistent receipts\n";
  await f.write("native/react/app.js", code);
  Object.assign(f.result.builds.react, { bundleSha256: hash(code), bytes: Buffer.byteLength(code) });
  f.result.builds.react.artifacts["app.js"] = hash(code); await f.save();
  const r = await f.validate(); assert.equal(r.status, "blocked"); assert.equal(r.rankingEligible, false); assert.equal(r.valid, false);
});
test("plausible altered timing scalars cannot become recomputed measurements", async (t) => {
  const f = await fixture(t); f.result.cells.react.measurement.readyMs = 0; f.result.cells.react.measurement.actions[0].elapsedMs = 0;
  await f.save(); const r = await f.validate(); assert.equal(r.status, "blocked"); assert.equal(r.cells.react.measurement.timings, null);
});

for (const outcome of ["failed", "unsupported", "not-run"]) test(`retains ${outcome} without fabricated timings or promotion`, async (t) => {
  const f = await fixture(t);
  f.result.cells.react = { outcome, reason: "fixture-unavailable", qualification: null, measurement: null, readyForMeasurement: false };
  f.result.passed = false; await f.save();
  const r = await f.validate(); assert.equal(r.status, "blocked", JSON.stringify(r.errors));
  assert.equal(r.cells.react.outcome, outcome); assert.equal(r.cells.react.reason, "fixture-unavailable"); assert.equal(r.cells.react.measurement, null);
});
test("failed captured qualification bars measurement and preserves the offline failure", async (t) => {
  const f = await fixture(t), c = { schema: "client-capture/v1", app: "react", effectiveWorkload: workload, outcome: "failed", reason: "native-load-failed", records: null };
  f.result.cells.react = { outcome: "failed", qualification: { capture: c, oracle: validateClientCapture(workload, c, settings), readyMs: null,
    actions: null, failure: { phase: "load", diagnostic: "Error", diagnosticSha256: hash("fixture"), records: [], errors: [] } }, measurement: null, readyForMeasurement: false };
  f.result.passed = false; await f.save();
  const r = await f.validate(); assert.equal(r.status, "blocked"); assert.equal(r.cells.react.qualification.oracle.functionalPassed, false);
  f.result.cells.react.measurement = pass("react", true); await f.save(); invalid(await f.validate(), "measurement-before-qualification");
});
test("failed native builds stay explicit", async (t) => {
  const f = await fixture(t); f.result.builds.react = { outcome: "failed", reason: "native-build-failed", diagnosticSha256: hash("fixture") };
  await f.write("native/react/failure.log", "fixture");
  f.result.cells.react = { outcome: "failed", reason: "native-build-failed", qualification: null, measurement: null, readyForMeasurement: false };
  f.result.passed = false; await f.save(); const r = await f.validate();
  assert.equal(r.status, "blocked"); assert.deepEqual(r.cells.react.build, { outcome: "failed", bytes: null });
  await f.write("native/react/failure.log", "different error"); invalid(await f.validate(), "missing-or-mismatched-native-failure-log");
});
test("dirty source claims cannot bind changed source to the supplied commit", async (t) => {
  const f = await fixture(t); f.result.provenance.dirty = true;
  f.result.provenance.sources["bench/client-heavy/run.mjs"] = hash("changed uncommitted source"); await f.save();
  const r = await f.validate(); assert.equal(r.status, "blocked", JSON.stringify(r.errors));
  assert.ok(r.blockers.includes("dirty-source-without-saved-diff-bytes")); assert.equal(r.valid, false);
});
test("interrupted not-run cells may lack a raw app file but remain explicitly blocked", async (t) => {
  const f = await fixture(t);
  f.result.cells.react = { outcome: "not-run", reason: "native-runner-interrupted", qualification: null, measurement: null, readyForMeasurement: false };
  f.result.failure = { reason: "native-runner-interrupted", name: "Error", diagnosticSha256: hash("interrupted") }; f.result.passed = false;
  await f.save(); await rm(join(f.folder, "react.json")); const r = await f.validate();
  assert.equal(r.status, "blocked"); assert.equal(r.cells.react.outcome, "not-run");
  assert.ok(r.blockers.includes("native-runner-interrupted")); assert.ok(r.blockers.includes("missing-unrun-app-file:react"));
});
test("missing terminal ledger and actual cleanup failures never qualify a run", async (t) => {
  const f = await fixture(t); delete f.result.cleanupFailures; await f.save();
  let r = await f.validate(); assert.equal(r.status, "blocked"); assert.ok(r.blockers.includes("missing-cleanup-failure-ledger"));
  f.result.cleanupFailures = [{ resource: "server", name: "Error", diagnosticSha256: hash("fixture") }]; f.result.passed = false; await f.save();
  r = await f.validate(); assert.equal(r.status, "blocked"); assert.ok(r.blockers.includes("recorded-terminal-cleanup-failure"));
});

async function unrunFixture(t) {
  const f = await fixture(t);
  f.result.builds = null; f.result.passed = false;
  for (const app of apps) f.result.cells[app] = { outcome: "not-run", reason: "runner-failed-before-adapter",
    qualification: null, measurement: null, readyForMeasurement: false };
  await f.save();
  await rm(join(f.folder, "native/build.json"));
  return f;
}

test("null summary builds cannot hide a contradictory saved build manifest", async (t) => {
  const f = await unrunFixture(t);
  await f.json("native/build.json", { corten: { outcome: "built" } });
  invalid(await f.validate(), "raw-builds-differ-from-summary");
});

test("null summary builds cannot hide a malformed saved workload", async (t) => {
  const f = await unrunFixture(t); await f.write("native/workload.json", "{malformed");
  const r = await f.validate(); invalid(r, "missing-unreadable-or-malformed-evidence");
  assert.ok(r.errors.some((e) => e.at === "native/workload.json"));
});

test("null summary builds still compare a present valid workload with the plan", async (t) => {
  const f = await unrunFixture(t); await f.json("native/workload.json", {});
  invalid(await f.validate(), "native-workload-differs-from-plan");
});

test("missing native proof is blocked without contradicting complete not-run accounting", async (t) => {
  const f = await unrunFixture(t); await rm(join(f.folder, "native/workload.json"));
  const r = await f.validate(); assert.equal(r.status, "blocked", JSON.stringify(r.errors));
  assert.equal(r.diagnosticsPassed, true); assert.equal(r.valid, false);
  assert.ok(r.blockers.includes("native-builds-not-saved"));
  assert.ok(apps.every((app) => r.cells[app].outcome === "not-run" && r.cells[app].measurement === null));
});

test("present native manifests are checked independently even when both are malformed", async (t) => {
  const f = await unrunFixture(t);
  await f.write("native/build.json", "{malformed"); await f.write("native/workload.json", "{malformed");
  const r = await f.validate(); assert.equal(r.status, "invalid");
  assert.ok(["native/build.json", "native/workload.json"].every((at) => r.errors.some((e) => e.at === at)));
});

test("replayed captures without saved native manifests remain blocked, never ready", async (t) => {
  const f = await fixture(t);
  await rm(join(f.folder, "native/build.json")); await rm(join(f.folder, "native/workload.json"));
  const r = await f.validate(); assert.equal(r.status, "blocked", JSON.stringify(r.errors));
  assert.equal(r.diagnosticsPassed, true);
  assert.ok(r.blockers.includes("missing-native-build-file")); assert.ok(r.blockers.includes("missing-native-workload-file"));
  assert.ok(apps.every((app) => r.cells[app].replayPassed === true && r.cells[app].build === null));
  for (const key of ["valid", "ready", "readyForLoad", "rankingEligible"]) assert.equal(r[key], false);
});

for (const failure of [false, 0, "", null]) test(`present falsy failure ${JSON.stringify(failure)} is malformed, not absent`, async (t) => {
  const f = await fixture(t); f.result.failure = failure; await f.save();
  invalid(await f.validate(), "missing-or-unexpected-fields");
});

test("offline Git disables inherited promisor lazy fetch for an absent commit", async (t) => {
  const f = await fixture(t), scratch = await mkdtemp(join(tmpdir(), "client-heavy-git-"));
  t.after(async () => {
    const rel = relative(tmpdir(), scratch); assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
    await rm(scratch, { recursive: true, force: true });
  });
  const repository = join(scratch, "repository"), trace = join(scratch, "git-trace.jsonl"), absent = "1".repeat(40);
  git(["init", "--quiet", repository]);
  await mkdir(join(scratch, "hooks"));
  git(["-C", repository, "-c", "user.name=Verifier fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(scratch, "hooks")}`, "commit", "--quiet", "--allow-empty", "-m", "Fixture"]);
  f.result.provenance.commit = absent; await f.save();
  const result = spawnSync(process.execPath, [join(root, "bench/client-heavy/verify.mjs"), f.folder,
    "--round", "test-round", "--commit", absent], { encoding: "utf8", timeout: 30000, env: { ...process.env,
    GIT_DIR: join(repository, ".git"), GIT_WORK_TREE: repository, GIT_TRACE2_EVENT: trace,
    GIT_NO_LAZY_FETCH: "0", GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "extensions.partialClone", GIT_CONFIG_VALUE_0: "missing",
    GIT_CONFIG_KEY_1: "remote.missing.promisor", GIT_CONFIG_VALUE_1: "true",
    GIT_CONFIG_KEY_2: "remote.missing.url", GIT_CONFIG_VALUE_2: join(scratch, "nonexistent-local-remote") } });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "invalid");
  const events = (await readFile(trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const fetches = events.filter((e) => (e.event === "child_start" && e.argv?.some((arg) => ["fetch", "fetch-pack"].includes(arg)))
    || (e.event === "cmd_name" && ["fetch", "fetch-pack"].includes(e.name)));
  assert.deepEqual(fetches, [], "read-only Git object queries must not launch a lazy fetch");
});

test("rejects unknown files and malformed JSON", async (t) => {
  const f = await fixture(t); await f.write("injected.js", "throw new Error('never run');");
  invalid(await f.validate(), "unexpected-artifact-file");
  await f.write("result.json", "{broken"); invalid(await f.validate(), "missing-unreadable-or-malformed-evidence");
});
test("rejects missing native files", async (t) => {
  const f = await fixture(t); await rm(join(f.folder, "native/react/app.js")); invalid(await f.validate(), "native-artifact-hash-mismatch");
});
test("rejects hardlinked duplicate files", async (t) => {
  const f = await fixture(t); await link(join(f.folder, "react.json"), join(f.folder, "duplicate.json"));
  invalid(await f.validate(), "hardlinked-artifact");
});
test("rejects directory links, file links, and linked root ancestors", async (t) => {
  const f = await fixture(t), outer = join(f.folder, "native-link");
  await symlink(join(f.folder, "native"), outer, process.platform === "win32" ? "junction" : "dir");
  invalid(await f.validate(), "linked-artifact");
  const r = await validateSaved({ folder: join(outer, "react"), round: "test-round", commit });
  invalid(r, "linked-or-nondirectory-ancestor"); await rm(outer);
  try { await symlink(join(f.folder, "react.json"), join(f.folder, "linked.json"), "file"); }
  catch (e) { if (["EPERM", "EACCES"].includes(e.code)) { t.diagnostic("File symlink requires host privilege; directory junction coverage ran"); return; } throw e; }
  invalid(await f.validate(), "linked-artifact");
});
test("rejects case-colliding files on case-sensitive hosts", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t); await f.write("React.json", "{}"); invalid(await f.validate(), "case-colliding");
});
test("rejects sparse oversized files before allocating/reading them", async (t) => {
  const f = await fixture(t); await f.write("large.log", ""); await truncate(join(f.folder, "large.log"), 64 * 1024 ** 2 + 1);
  invalid(await f.validate(), "artifact-byte-limit");
});
test("fixed API/CLI refuses overrides, unsafe identities and command injection", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(cliOptions(["folder", "--round", "round", "--commit", commit]), { folder: "folder", round: "round", commit });
  for (const args of [[], ["folder", "--commit", commit, "--round", "round"], ["folder", "--round", "round", "--commit", commit, "--out", "x"]]) assert.throws(() => cliOptions(args));
  for (const changes of [{ round: "../x" }, { round: "CON" }, { commit: "HEAD" }, { commit: "0".repeat(40) }, { folder: "//host/share" },
    { folder: `${f.folder}/../outside` }, { validator: "arbitrary" }]) {
    const r = await validateSaved({ folder: f.folder, round: "test-round", commit, ...changes }); assert.equal(r.status, "invalid"); assert.equal(r.ready, false);
  }
  const cli = spawnSync(process.execPath, [join(root, "bench/client-heavy/verify.mjs"), f.folder, "--round", "test-round", "--commit", commit], { encoding: "utf8" });
  assert.equal(cli.status, 2, cli.stderr); assert.equal(JSON.parse(cli.stdout).status, "blocked");
  const bad = spawnSync(process.execPath, [join(root, "bench/client-heavy/verify.mjs"), f.folder, "--round", "../x", "--commit", commit], { encoding: "utf8" });
  assert.equal(bad.status, 1); assert.equal(JSON.parse(bad.stdout).status, "invalid");
});
