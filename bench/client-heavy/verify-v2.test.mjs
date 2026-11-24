import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { Evidence, json, sha256 } from "./evidence.mjs";
import { options, sourceRoots, buildOptions, documentMarkup, comparisonProfile } from "./contract.mjs";
import { committed, validateSaved } from "./verify.mjs";
import { selectedApps, definition } from "../workloads/registry.mjs";
import { validateClientCapture } from "../workloads/client.mjs";
import { fixturePass, workload, settings } from "./replay-fixture.mjs";
import { vendorConfiguration } from "./build-replay.mjs";
import { admitSaved } from "./admission.mjs";
import { hostFixture } from "./host-fixture.mjs";
import { evaluateLatestStable, latestStableSources } from "../workloads/latest-stable.mjs";
import { replayCandidatePolicy, replayCandidateDisposition, replayProducerSchema, replaySolidCompiler } from "./verify-v2.mjs";
import { solidCompilerFiles, solidManifestFiles, solidRuntimeFiles, solidRuntimePrefix } from "./compiler.mjs";

const solid1Commit = "6f1bbf0553ec3b60c884bf5855fe8786ca25f1c2", apps = selectedApps("client-heavy");
const producerRoot = "/producer", outputPath = "bench/client-heavy/work/unit";

test("Solid 2 replay requires the exact compiler, package manifests and bundled browser runtime", () => {
  const target = "linux-x64-gnu", files = solidCompilerFiles(target, "linux");
  const receipt = { version: "2.0.2", target, files };
  const dependencies = new Map(Object.entries(files).map(([path, sha256]) => [path, { sha256 }]));
  const manifests = Object.entries(solidManifestFiles(target));
  for (const [path, sha256] of manifests) if (sha256 !== null) dependencies.set(path, { sha256 });
  const inputs = new Map(Object.entries(solidRuntimeFiles).map(([path, sha256]) => [solidRuntimePrefix + path, { sha256 }]));
  const check = (value = receipt, deps = dependencies, build = inputs) => replaySolidCompiler(value, "linux", deps, build);
  assert.doesNotThrow(() => check());
  assert.throws(() => check(null), /missing-solid-compiler-receipt/);
  assert.throws(() => check({ ...receipt, version: "2.0.1" }), /solid-compiler-differs-from-locked-install/);
  assert.throws(() => check({ ...receipt, target: "win32-x64-msvc" }), /unreviewed-solid-compiler-target/);
  for (const path of Object.keys(files)) {
    const missing = new Map(dependencies); missing.delete(path);
    assert.throws(() => check(receipt, missing), /solid-compiler-differs-from-locked-install/);
  }
  for (const [path, sha256] of manifests) {
    const changed = new Map(dependencies).set(path, { sha256: "0".repeat(64) });
    assert.throws(() => check(receipt, changed), /missing-or-modified-solid-package-manifest/);
    if (sha256 === null) continue;
    changed.delete(path);
    assert.throws(() => check(receipt, changed), /missing-or-modified-solid-package-manifest/);
  }
  const nested = "@solidjs/signals/dist/prod/package.json";
  assert.equal(solidManifestFiles(target)[nested], null);
  assert.throws(() => check(receipt, new Map(dependencies).set(nested.toUpperCase(), { sha256: "0".repeat(64) })),
    /missing-or-modified-solid-package-manifest/);
  // Leave both top-level entries intact when changing an imported module.
  for (const path of ["solid-js/dist/solid.js", "solid-js/dist/internal.js", "@solidjs/signals/dist/prod/core/graph.js"]) {
    const changed = new Map(inputs), input = solidRuntimePrefix + path;
    assert.ok(changed.has(input));
    changed.set(input, { sha256: "0".repeat(64) });
    assert.throws(() => check(receipt, dependencies, changed), /missing-or-modified-solid-runtime-build-input/);
  }
  const published = "@solidjs/signals/dist/prod/index.js";
  const normal = solidRuntimePrefix + published, shadow = solidRuntimePrefix + "solid-js/node_modules/" + published;
  const missing = new Map(inputs); missing.delete(normal);
  for (const changed of [missing, new Map(missing).set(shadow, inputs.get(normal)), new Map(inputs).set(shadow, inputs.get(normal))])
    assert.throws(() => check(receipt, dependencies, changed), /missing-or-modified-solid-runtime-build-input/);
});
// Completely synthetic source/build/browser receipts. Their successful intrinsic
// replay MUST NOT authenticate them or create a real review receipt.
async function fixture(t, version = 2) {
  const commit = version >= 3 ? solid1Commit : "e006be831cd69e423bfd3e159362b54746597b96";
  const folder = await mkdtemp(join(tmpdir(), "client-v2-unit-")), e = new Evidence(process.cwd(), folder);
  t.after(async () => { const r = relative(tmpdir(), folder); assert.ok(r && !isAbsolute(r) && !r.startsWith("..")); await rm(folder, { recursive: true, force: true }); });
  const write = async (p, b) => { await mkdir(dirname(join(folder, p)), { recursive: true }); await writeFile(join(folder, p), b); };
  const saveJson = (p, v) => write(p, json(v));
  const remove = async (p) => { const target = join(folder, p), rel = relative(folder, target);
    assert.ok(rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../")); await rm(target, { recursive: true, force: true }); };
  const sources = [];
  for (const [path, bytes] of committed(commit, sourceRoots)) sources.push({ path, ...await e.blob(bytes) });
  sources.sort((a, b) => a.path.localeCompare(b.path, "en"));
  const empty = await e.blob(Buffer.alloc(0)), module = await e.blob(Buffer.from("// synthetic dependency, never executed\n"));
  const source = new Map(sources.map((s) => [s.path, s]));
  const config = options(version === 4 ? ["unit", "--profile", comparisonProfile]
    : ["unit", "--rows", "8", "--large", "10", "--append", "1", "--cards", "2", "--cleanup-ms", "10", "--observation-ms", "5"], producerRoot, "linux");
  if (version < 4) { assert.deepEqual(config.workload, workload); assert.deepEqual(config.settings, settings); }
  const { workload: spec, settings: limits, measurementOrder } = config;
  const plan = { schema: "client-heavy-plan/v1", round: "unit", commit, invocation: config.invocation, workload: spec, settings: limits, timeoutMs: 30000,
    ...(measurementOrder ? { measurementOrder } : {}),
    selectedApps: [...apps], definition: definition("client-heavy"), sourceBefore: "evidence/source-before.json", root: producerRoot, platform: "linux",
    nodeClock: { clock: "node-performance", timeOrigin: 1000 }, inheritedConfigurationNames: ["PATH"] };
  const output = { schema: `client-heavy-native/v${version}`, group: "client-heavy", round: "unit", effectiveWorkload: spec, settings: limits, timeoutMs: 30000,
    selectedApps: [...apps], definition: definition("client-heavy"), builds: {}, cells: {}, passed: true, readyForLoad: false, cleanupFailures: [],
    collection: { accounting: "complete", proof: "blocked", blockers: ["external-trusted-execution-source-build-and-host-admission-required"], isolation: "unknown", rankingEligible: false, reviewSubject: "review-subject.json" },
    provenance: { commit, sourceBefore: "evidence/source-before.json", sourceAfter: "evidence/source-after.json", node: "unit", platform: "linux", release: "unit", cpu: "unit", logicalCpus: 1,
      browser: "unit", browserInstances: 1, rendererProcessLimit: 1, concurrentPages: 1, passes: 1 + (measurementOrder?.length ?? 1), note: "SYNTHETIC UNIT ONLY" },
    terminal: { clock: "node-performance", timeOrigin: 1000, signals: [], resources: ["browser", "server"].map((resource, i) => ({ resource,
      startedAt: 10000 + i * 2, endedAt: 10001 + i * 2, returned: true, observed: true, failure: null })) } };
  const dependencyEntries = {};
  for (const [label, lockPath] of [["node-dependencies", "package-lock.json"], ["browser-dependencies", "bench/browser/package-lock.json"]]) {
    const lock = JSON.parse(await readFile(join(folder, source.get(lockPath).blob))), entries = [];
    for (const [path, value] of Object.entries(lock.packages)) if (path && !value.optional) entries.push({ path: `${path.slice(13)}/package.json`,
      ...await e.blob(Buffer.from(JSON.stringify({ version: value.version }))) });
    if (label === "browser-dependencies") entries.push({ path: "esbuild/lib/main.js", ...module }, { path: "unit/index.js", ...module });
    dependencyEntries[label] = entries;
  }
  for (const stage of ["before", "after"]) {
    await saveJson(`evidence/source-${stage}.json`, { schema: "client-heavy-source/v1", stage, startedAt: stage === "before" ? 0 : 11000, endedAt: stage === "before" ? 1 : 11001, commit, status: empty, diff: empty, entries: sources, unavailable: [] });
    for (const label of ["node-dependencies", "browser-dependencies"]) await saveJson(`evidence/${label}-${stage}.json`, {
      schema: "client-heavy-dependency-bytes/v1", label, stage, entries: dependencyEntries[label], unavailable: [], startedAt: stage === "before" ? 0 : 11000, endedAt: stage === "before" ? 1 : 11001 });
    await saveJson(`evidence/cargo-dependencies-${stage}.json`, { schema: "client-heavy-dependency-bytes/v1", label: "cargo-dependencies", stage,
      entries: [], unavailable: [], startedAt: stage === "before" ? 5 : 9, endedAt: stage === "before" ? 6 : 10 });
  }
  for (const name of ["node", "browser"]) await saveJson(`evidence/${name}.json`, { version: "unit", requestedExecutable: "/unit", executablePath: "/unit", executable: module });
  await saveJson("evidence/configuration-after.json", { names: ["PATH"] });
  let toolAt = 2;
  const tool = async (label, args, stdout = "") => { const start = toolAt; toolAt += 2; return saveJson(`evidence/${label}.json`, { command: "cargo", args, configurationNames: ["PATH"], startedAt: start, endedAt: start + 1,
    status: 0, signal: null, failure: null, stdout: await e.blob(Buffer.from(stdout)), stderr: empty }); };
  await tool("cargo-version", ["--version", "--verbose"], "cargo 1.0.0 synthetic");
  await tool("cargo-vendor", ["vendor", "--versioned-dirs", "--manifest-path", "bench/browser/gen/Cargo.toml", `${outputPath}/evidence/cargo-vendor`]);
  const packages = [["gen", "corten-bench-gen", "bench/browser/gen", "client", "src/bin/client.rs"], ["corten", "corten-run", "crates/corten", "corten", "src/lib.rs"]]
    .map(([id, name, dir, target, src]) => ({ id, name, version: "0.0.0", manifest_path: `${producerRoot}/${dir}/Cargo.toml`, targets: [{ name: target, src_path: `${producerRoot}/${dir}/${src}`, kind: [id === "gen" ? "bin" : "lib"] }] }));
  await tool("cargo-metadata", ["metadata", "--locked", "--offline", "--format-version", "1", "--config", `${outputPath}/evidence/cargo-vendor.toml`, "--manifest-path", "bench/browser/gen/Cargo.toml"], JSON.stringify({ version: 1, packages, resolve: { root: "gen", nodes: [{ id: "gen", dependencies: ["corten"] }, { id: "corten", dependencies: [] }] } }));
  const artifacts = packages.map((p) => ({ reason: "compiler-artifact", package_id: p.id, target: p.targets[0], fresh: false, filenames: ["/target/synthetic"] }));
  const compilerOutput = [...artifacts, { reason: "build-finished", success: true }].map((m) => JSON.stringify(m)).join("\n") + "\n";
  await tool("cargo-run", ["run", "--locked", "--offline", "--release", "--verbose", "--message-format=json", "--target-dir", `${outputPath}.compiler`,
    "--config", `${outputPath}/evidence/cargo-vendor.toml`, "--manifest-path", "bench/browser/gen/Cargo.toml", "--bin", "client", "--", `${outputPath}/native/workload.json`, `${outputPath}/native/corten`], compilerOutput);
  await write("evidence/cargo-vendor.toml", vendorConfiguration);
  await saveJson("evidence/cargo-lock-invocation.json", { state: "absent" });
  for (const stage of ["before", "after"]) await saveJson(`evidence/cargo-lock-${stage}.json`, await e.blob(Buffer.from("# Synthetic lock fixture\nversion = 4\n")));
  const compilerPaths = ["bench/browser/gen/src/bin/client.rs", "crates/corten/src/lib.rs"], dep = compilerPaths.map((p) => `${producerRoot}/${p}`);
  await saveJson("evidence/compiler-inputs.json", { schema: "client-heavy-compiler-inputs/v1", metadata: "evidence/cargo-metadata.json", toolchain: await e.blob(Buffer.from(JSON.stringify({ rustc_fingerprint: 1, outputs: { unit: { success: true, stdout: "rustc 1.0.0\nhost: synthetic\nrelease: synthetic\n" } } }))),
    artifacts, compilerRoot: producerRoot, depfiles: [{ path: "release/client.d", ...await e.blob(Buffer.from(`/target/app: ${dep.join(" ")}\n`)), inputs: dep }],
    inputs: compilerPaths.map((p) => { const { path, ...ref } = source.get(p); return { path: `${producerRoot}/${p}`, sourcePath: p, ...ref }; }), unavailable: [] });
  for (const app of apps) {
    const opts = buildOptions(app, producerRoot, "linux"), entry = opts.entryPoints[0].slice(producerRoot.length + 1);
    const inputPaths = [entry, "bench/client-heavy/apps/input.js", ...(app === "corten" ? [] : ["bench/browser/node_modules/unit/index.js"]),
      ...(["vue", "svelte"].includes(app) ? [`bench/client-heavy/apps/${app}.${app === "vue" ? "vue" : "svelte"}`] : [])].sort();
    const inputs = inputPaths.map((path) => ({ path, ...(source.has(path) ? (({ path: _, ...ref }) => ref)(source.get(path)) : module) }));
    const raw = Buffer.from(`throw new Error('saved code must not run'); // ${app}`), code = Buffer.concat([raw, Buffer.from("\n")]), bundle = app === "corten" ? "client.js" : "app.js";
    const meta = { inputs: Object.fromEntries(inputPaths.map((p) => [p, {}])), outputs: { "stdout.js": { bytes: raw.length, entryPoint: entry, imports: [], inputs: Object.fromEntries(inputPaths.map((p) => [p, { bytesInOutput: 0 }])) } } };
    const bytes = { "index.html": Buffer.from(documentMarkup(app, spec, "<section>Synthetic unit</section>")), [bundle]: code };
    if (app === "corten") Object.assign(bytes, { "runtime.js": Buffer.from(await readFile(join(folder, source.get("crates/corten/js/dist/corten.js").blob))), "views.js": Buffer.from("// synthetic views") });
    const artifactHashes = Object.fromEntries(Object.entries(bytes).map(([p, b]) => [p, sha256(b)]));
    for (const [p, b] of Object.entries(bytes)) await write(`native/${app}/${p}`, b);
    if (app === "corten") {
      await write("native/corten/screen.html", "<section>Synthetic unit</section>"); await write("native/corten/client.footer.js", "");
      await write("native/corten/views.d.ts", "// synthetic types"); await write("native/corten/build.log", compilerOutput);
    }
    output.builds[app] = { outcome: "built", inputs: inputs.map(({ path, sha256 }) => ({ path, sha256 })), bundleSha256: sha256(code), bytes: code.length, artifacts: artifactHashes };
    await saveJson(`native/${app}/build-options.json`, opts); await saveJson(`native/${app}/metafile.json`, meta);
    const buildAt = 10 + apps.indexOf(app) * 2;
    await saveJson(`native/${app}/build-receipt.json`, { schema: "client-heavy-build-receipt/v1", app, startedAt: app === "corten" ? 4 : buildAt, endedAt: buildAt + 1, esbuild: { version: "0.28.2", entry: module },
      optionsSha256: sha256(json(opts)), metafileSha256: sha256(json(meta)), rawBundle: await e.blob(raw), footer: empty, inputs, artifacts: artifactHashes });
    function capture(measured, start, elapsedMs = 0.25) {
      const p = fixturePass(app, measured, spec, limits);
      p.lifecycle.contextCreatedAt = start; p.lifecycle.deadline.scheduledAt += start; p.lifecycle.deadline.cancelledAt += start;
      p.lifecycle.close.startedAt += start; p.lifecycle.close.endedAt += start; p.timing.timeOrigin += start + 10;
      p.timing.operations.forEach((s) => { s.timeOrigin += start + 10; });
      if (measured) { p.timing.operations[0].endedAt = p.timing.operations[0].startedAt + elapsedMs; p.actions[0].elapsedMs = elapsedMs; }
      p.requests = Object.entries(bytes).map(([name, b], id) => ({ id, path: `/${app}/${name}`,
        method: "GET", resourceType: name.endsWith("html") ? "document" : "script", startedAt: start + 2 + id, endedAt: start + 3 + id, status: 200, body: { bytes: b.length, sha256: sha256(b) }, failure: null }));
      return p;
    }
    const start = 100 + apps.indexOf(app) * (measurementOrder ? 350 : 1000);
    output.cells[app] = { outcome: "passed", qualification: capture(false, start), readyForMeasurement: true,
      ...(measurementOrder ? { measurements: measurementOrder.map((block, i) => capture(true, 100 + (apps.length * (i + 1) + block.indexOf(app)) * 350, [0.75, 0.25, 0.5][i])) }
        : { measurement: capture(true, start + 200) }) };
  }
  if (version >= 3) {
    const inputs = Object.fromEntries(await Promise.all(Object.entries(latestStableSources).map(async ([key, path]) =>
      [key, await readFile(join(folder, source.get(path).blob))])));
    output.latestStable = evaluateLatestStable({ group: "client-heavy", ...inputs });
    const row = output.latestStable.candidates.find((r) => r.app === "solid");
    await remove("native/solid");
    output.builds.solid = { outcome: "not-run", reason: row.reason };
    output.cells.solid = { outcome: "unsupported", reason: row.reason, qualification: null, readyForMeasurement: false,
      ...(measurementOrder ? { measurements: [] } : { measurement: null }) };
    output.passed = false;
  }
  const seal = async () => {
    await saveJson("plan.json", plan); await saveJson("result.json", output); await saveJson("native/workload.json", spec); await saveJson("native/build.json", output.builds);
    for (const app of apps) await saveJson(`${app}.json`, output.cells[app]);
    await rm(join(folder, "review-subject.json"), { force: true }); await e.seal({ group: "client-heavy", round: "unit", commit });
  };
  await seal();
  const request = { folder, round: "unit", commit };
  return { folder, output, plan, e, seal, saveJson, write, remove, request, validate: () => validateSaved(request) };
}
test("complete intrinsic six-app replay is verified, not externally admitted", async (t) => {
  const f = await fixture(t), r = await f.validate();
  assert.equal(r.status, "verified", JSON.stringify(r.errors)); assert.deepEqual(r.blockers, []);
  assert.equal(r.intrinsic.complete, true); assert.equal(r.intrinsic.passed, true);
  assert.equal(r.readyForLoad, false); assert.equal(r.rankingEligible, false); assert.equal(r.isolation, "unknown");
  assert.equal(r.cells.react.measurement.timings.actions.length, 19);
  assert.equal((await admitSaved(f.request)).admitted, false);
});

test("v3 public replay preserves unsupported Solid and qualified diagnostic peers separately", async (t) => {
  const f = await fixture(t, 3), r = await f.validate();
  assert.equal(r.schema, "client-heavy-saved-verification/v3");
  assert.equal(r.status, "failed", JSON.stringify(r.errors)); assert.equal(r.intrinsic.complete, true);
  assert.deepEqual(r.errors, []); assert.equal(r.rankingEligible, false); assert.equal(r.readyForLoad, false);
  assert.equal(Object.keys(r.cells).length, 6);
  assert.equal(r.cells.solid.outcome, "unsupported"); assert.equal(r.cells.solid.qualification, null); assert.equal(r.cells.solid.measurement, null);
  assert.equal(r.cells.solid.build.bytes, null);
  assert.equal(r.cells.react.replayPassed, true); assert.ok(r.cells.react.measurement.timings);
  assert.ok(r.latestStable.candidates.every((row) => row.latestStableEligible === (row.app !== "solid")));
});

test("v4 replays each block and recomputes summaries for native and policy passes only", async (t) => {
  const f = await fixture(t, 4), r = await f.validate();
  assert.equal(r.schema, "client-heavy-saved-verification/v4");
  assert.equal(r.status, "failed", JSON.stringify(r.errors));
  assert.equal(r.intrinsic.complete, true); assert.equal(r.rankingEligible, false);
  const attemptedOrder = f.plan.measurementOrder.map((block) => block.filter((app) => app !== "solid"));
  assert.deepEqual(r.cells.react.comparison, { samples: 3, attemptedOrder, actions: f.plan.workload.operations.map(({ id, kind }, i) =>
    ({ operation: id, kind, medianMs: i === 0 ? 0.5 : 0.25, minMs: 0.25, maxMs: i === 0 ? 0.75 : 0.25 })) });
  assert.equal(r.cells.remix.replayPassed, true); assert.deepEqual(r.cells.remix.comparison, r.cells.react.comparison);
  assert.equal(r.cells.solid.outcome, "unsupported"); assert.deepEqual(r.cells.solid.measurements, []);
  assert.deepEqual(r.processWindows.filter((w) => w.phase === "measurement").map((w) => w.app),
    attemptedOrder.flat());
});

test("v4 refuses resealed missing, reused or tampered sample receipts", async (t) => {
  const f = await fixture(t, 4), samples = f.output.cells.react.measurements;
  for (const [replacement, reason] of [
    [samples.slice(0, 2), "missing-measurement-attempt-receipt"],
    [[samples[0], samples[0], samples[2]], "context-before-build-or-previous-close"],
    [[samples[1], samples[0], samples[2]], "context-before-build-or-previous-close"],
    [[samples[0], samples[1], { ...samples[2], actions: [] }], "timings-differ-from-endpoint-recomputation"],
  ]) {
    f.output.cells.react.measurements = replacement;
    await f.seal();
    const r = await f.validate();
    assert.equal(r.status, "invalid"); assert.ok(r.errors.some((entry) => entry.reason === reason), JSON.stringify(r.errors));
    assert.ok(Object.values(r.cells).every((cell) => cell.comparison === undefined));
  }
});

test("resealed v4 needs an observed qualification for each built app before comparing healthy peers", async (t) => {
  const f = await fixture(t, 4), vue = f.output.cells.vue, qualification = vue.qualification;
  assert.equal(f.output.builds.vue.outcome, "built");
  Object.assign(vue, { outcome: "failed", readyForMeasurement: false, measurements: [], qualification: null, reason: "runner-failed-before-adapter" });
  await f.seal();
  const missing = await f.validate();
  assert.equal(missing.intrinsic.complete, false);
  assert.ok(missing.errors.some((e) => e.at === "vue:cell" && e.reason === "missing-qualification-attempt-receipt"));
  assert.equal(missing.cells.react.replayPassed, true);
  assert.ok(Object.values(missing.cells).every((cell) => cell.comparison === undefined));

  f.output.failure = { reason: "runner-failed", name: "Error", diagnosticSha256: sha256("synthetic interruption") };
  await f.seal();
  const interrupted = await f.validate();
  assert.equal(interrupted.status, "blocked", JSON.stringify(interrupted.errors));
  assert.equal(interrupted.intrinsic.complete, false); assert.equal(interrupted.cells.react.comparison, undefined);

  // A retained readiness failure with an observed context close IS an attempt.
  delete f.output.failure; delete vue.reason; vue.qualification = qualification;
  const records = qualification.capture.records.slice(0, 2);
  Object.assign(qualification.capture, { outcome: "failed", reason: "native-readiness-failed", records: null });
  qualification.failure = { phase: "readiness", diagnostic: "Error", diagnosticSha256: sha256("synthetic readiness failure"), records, errors: [] };
  qualification.oracle = validateClientCapture(f.plan.workload, qualification.capture, f.plan.settings);
  qualification.readyMs = null; qualification.timing.operations = [];
  await f.seal();
  const observed = await f.validate();
  assert.equal(observed.status, "failed", JSON.stringify(observed.errors));
  assert.equal(observed.intrinsic.complete, true);
  assert.equal(observed.cells.vue.qualification.passed, false); assert.equal(observed.cells.vue.qualification.closurePassed, true);
  assert.equal(observed.cells.vue.comparison, undefined);
  assert.equal(observed.cells.solid.outcome, "unsupported"); assert.equal(observed.cells.solid.qualification, null);
  assert.equal(observed.cells.react.comparison.samples, 3);
  assert.deepEqual(observed.cells.react.comparison.attemptedOrder, f.plan.measurementOrder.map((block) =>
    block.filter((app) => app !== "vue" && app !== "solid")));

  qualification.lifecycle.close.observed = false;
  await f.seal();
  const unclosed = await f.validate();
  assert.ok(unclosed.blockers.includes("comparison-context-not-closed"));
  assert.equal(unclosed.intrinsic.complete, false); assert.equal(unclosed.cells.react.comparison, undefined);
});

for (const [name, mutate] of [
  ["missing policy", (f) => { delete f.output.latestStable; }],
  ["downgraded producer schema", (f) => { f.output.schema = "client-heavy-native/v2"; }],
  ["legacy policy mixed into v3", (f) => { f.output.latestStable.schema = "benchmark-latest-stable-evaluation/v1"; }],
  ["invented latest eligibility", (f) => { f.output.latestStable.candidates[3].latestStableEligible = true; }],
  ["hidden Solid policy row", (f) => { f.output.latestStable.candidates.splice(3, 1); }],
  ["unknown unsupported reason", (f) => { f.cells.solid.reason = "compiler-failed"; }],
  ["measured Solid", (f) => { f.cells.solid = structuredClone(f.cells.react); }],
  ["attempted Solid build", (f) => { f.paths.push("native/solid/failure.log"); }],
  ["unsupported peer without observation", (f) => { f.cells.react = structuredClone(f.cells.solid); }],
]) test(`v3 production replay gates refuse ${name}`, async () => {
  const source = new Map(Object.values(latestStableSources).map((path) => [path, execFileSync("git", ["show", `${solid1Commit}:${path}`],
    { cwd: new URL("../../", import.meta.url) })]));
  const latestStable = evaluateLatestStable({ group: "client-heavy", ...Object.fromEntries(Object.entries(latestStableSources).map(([key, path]) => [key, source.get(path)])) });
  assert.equal(latestStable.valid, true);
  const reason = latestStable.candidates.find((r) => r.app === "solid").reason;
  const f = { output: { schema: "client-heavy-native/v3", latestStable }, paths: [], cells: { solid: { outcome: "unsupported", reason, qualification: null, measurement: null, readyForMeasurement: false },
    react: { outcome: "passed", qualification: {}, measurement: {}, readyForMeasurement: true } } };
  const validate = () => { const policy = replayCandidatePolicy(f.output, (path) => source.get(path));
    for (const app of ["solid", "react"]) replayCandidateDisposition(policy, app, f.cells[app], { outcome: app === "solid" ? "not-run" : "built", reason }, f.paths); };
  assert.doesNotThrow(validate); mutate(f); assert.throws(validate);
});

test("v3 source-bound schema gate retains historical v2 and refuses policy stripping or unknown producers", () => {
  for (const version of [2, 3]) {
    const source = Buffer.from(`export const schema = "client-heavy-native/v${version}";\n`);
    replayProducerSchema(source, `client-heavy-native/v${version}`);
    assert.throws(() => replayProducerSchema(source, `client-heavy-native/v${version === 2 ? 3 : 2}`));
  }
  for (const source of ["", 'export const schema = "client-heavy-native/v4";\n',
    'export const schema = "client-heavy-native/v2";\nexport const schema = "client-heavy-native/v3";\n'])
    assert.throws(() => replayProducerSchema(Buffer.from(source), "client-heavy-native/v2"));
});

for (const [name, packageName, version, app, changeRoot] of [
  ["Vue exact compiler dependency", "@vue/compiler-core", "0.0.0-rc.1", "vue"],
  ["React scheduler caret dependency", "scheduler", "0.0.0-rc.1", "react"],
  ["installed esbuild optional binary", "@esbuild/linux-x64", "0.0.0-rc.1", "corten"],
  ["React DOM peer dependency", "react", "19.3.0", "react", true],
]) test(`review repair rejects incompatible ${name} through production policy replay`, async () => {
  const inputs = Object.fromEntries(await Promise.all(Object.entries(latestStableSources).map(async ([key, path]) =>
    [key, await readFile(new URL(`../../${path}`, import.meta.url))])));
  const lock = JSON.parse(inputs.lockfile); lock.packages[`node_modules/${packageName}`].version = version;
  if (changeRoot) {
    const manifest = JSON.parse(inputs.manifest); manifest.devDependencies[packageName] = version;
    lock.packages[""].devDependencies[packageName] = version; inputs.manifest = Buffer.from(JSON.stringify(manifest));
  }
  inputs.lockfile = Buffer.from(JSON.stringify(lock));
  const policy = evaluateLatestStable({ group: "client-heavy", ...inputs });
  const replay = (latestStable) => replayCandidatePolicy({ schema: "client-heavy-native/v3", latestStable },
    (path) => inputs[Object.entries(latestStableSources).find(([, sourcePath]) => sourcePath === path)[0]]);
  const row = replay(policy).candidates.find((row) => row.app === app);
  assert.equal(row.status, "blocked"); assert.equal(row.latestStableEligible, false);
  assert.ok(Array.isArray(row.incompatible));
  assert.ok(row.incompatible.some((edge) => edge.package === packageName));
  const forged = structuredClone(policy), claimed = forged.candidates.find((row) => row.app === app);
  claimed.status = "satisfied"; claimed.latestStableEligible = true; claimed.blockers = []; claimed.incompatible = [];
  assert.throws(() => replay(forged));
});

test("native verifier import completes without running the CLI", () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const module = await import(${JSON.stringify(new URL("./verify.mjs", import.meta.url).href)}); console.log(typeof module.validateSaved);`],
  { encoding: "utf8", timeout: 10000, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 1024 ** 2 });
  assert.equal(child.error, undefined); assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, ""); assert.equal(child.stdout.trim(), "function");
});

test("native v2 CLI completes verified and blocked replay with exact exit codes", async (t) => {
  const f = await fixture(t);
  for (const [status, code] of [["verified", 0], ["blocked", 2]]) await t.test(status, async () => {
    if (status === "blocked") {
      for (const stage of ["before", "after"]) {
        const path = `evidence/source-${stage}.json`, source = JSON.parse(await readFile(join(f.folder, path)));
        source.entries = source.entries.filter((s) => s.path !== "bench/client-heavy/run.mjs"); await f.saveJson(path, source);
      }
      await f.seal();
    }
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("./verify.mjs", import.meta.url)),
      f.folder, "--round", f.request.round, "--commit", f.request.commit],
    { encoding: "utf8", timeout: 60000, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 16 * 1024 ** 2 });
    assert.equal(child.error, undefined); assert.equal(child.signal, null);
    assert.equal(child.status, code, child.stderr); assert.equal(child.stderr, "");
    const report = JSON.parse(child.stdout);
    assert.equal(report.schema, "client-heavy-saved-verification/v2"); assert.equal(report.status, status);
    assert.deepEqual(report.errors, []); assert.deepEqual(report.selectedApps, apps);
    assert.equal(report.intrinsic.complete, status === "verified"); assert.equal(report.intrinsic.passed, true);
    assert.equal(report.readyForLoad, false); assert.equal(report.rankingEligible, false); assert.equal(report.authentication, "external-required");
    if (status === "verified") assert.deepEqual(report.blockers, []);
    else assert.ok(report.blockers.includes("missing-source:bench/client-heavy/run.mjs"), JSON.stringify(report.blockers));
  });
});

test("oversized blobs require a checked tool executable reference", async (t) => {
  const f = await fixture(t), browserPath = "evidence/browser.json", nodePath = "evidence/node.json";
  const browser = JSON.parse(await readFile(join(f.folder, browserPath))), node = JSON.parse(await readFile(join(f.folder, nodePath)));
  const ref = await f.e.blob(Buffer.alloc(128 * 1024 ** 2 + 1), 512 * 1024 ** 2);
  for (const role of ["unreferenced", "other-reference"]) await t.test(role, async () => {
    await f.saveJson(browserPath, browser); await f.saveJson(nodePath, node);
    const path = "evidence/configuration-after.json";
    await f.saveJson(path, role === "other-reference" ? { names: ["PATH"], oversized: ref } : { names: ["PATH"] });
    await f.seal(); const r = await f.validate(); assert.equal(r.status, "invalid", JSON.stringify(r.errors));
    assert.ok(r.errors.some((e) => e.at === "artifacts" && e.reason === "oversized-blob-not-tool-executable"), JSON.stringify(r.errors));
  });
  await f.saveJson("evidence/configuration-after.json", { names: ["PATH"] });
  await f.saveJson(nodePath, node); await f.saveJson(browserPath, { ...browser, executable: ref });
  await f.seal(); const good = await f.validate(); assert.equal(good.status, "verified", JSON.stringify(good.errors));
  assert.equal(good.readyForLoad, false);
  await f.saveJson(browserPath, browser);
  await f.saveJson(nodePath, { ...node, executable: ref }); await f.seal();
  const capturedNode = await f.validate(); assert.equal(capturedNode.status, "verified", JSON.stringify(capturedNode.errors));
  assert.equal(capturedNode.toolIdentities.node, ref.sha256);
  assert.equal(capturedNode.readyForLoad, false);
});

test("raw relative compiler input binds the metadata root package, not repository cwd", async (t) => {
  const f = await fixture(t), path = "evidence/compiler-inputs.json";
  const compiler = JSON.parse(await readFile(join(f.folder, path)));
  compiler.inputs[0].path = "src/bin/client.rs";
  compiler.depfiles[0].inputs[0] = "src/bin/client.rs";
  const { inputs, path: depPath } = compiler.depfiles[0];
  inputs.sort();
  compiler.depfiles[0] = { path: depPath, ...await f.e.blob(Buffer.from(`/target/app: ${inputs.join(" ")}\n`)), inputs };
  await f.saveJson(path, compiler); await f.seal();
  const good = await f.validate(); assert.equal(good.status, "verified", JSON.stringify(good.errors));
  compiler.inputs[0].sourcePath = "src/bin/client.rs";
  await f.saveJson(path, compiler); await f.seal();
  const bad = await f.validate(); assert.equal(bad.status, "invalid");
  assert.ok(bad.errors.some((e) => e.reason === "compiler-input-path-differs"));
});

test("saved install layouts replay declared aliases and reject before/after changes", async (t) => {
  const f = await fixture(t);
  for (const stage of ["before", "after"]) {
    const path = `evidence/browser-dependencies-${stage}.json`, s = JSON.parse(await readFile(join(f.folder, path)));
    const manifest = s.entries.find((e) => e.path === "esbuild/package.json");
    Object.assign(manifest, await f.e.blob(Buffer.from(JSON.stringify({ name: "esbuild", version: "0.28.2", bin: { esbuild: "lib/main.js" } }))));
    const target = s.entries.find((e) => e.path === "esbuild/lib/main.js");
    s.entries.push({ ...target, path: ".bin/esbuild" });
    s.layout = { schema: "client-heavy-install-layout/v1", bins: [{ path: ".bin/esbuild", target: "../esbuild/lib/main.js" }], hardlinks: [] };
    await f.saveJson(path, s);
  }
  await f.seal(); assert.equal((await f.validate()).status, "verified");
  const path = "evidence/browser-dependencies-after.json", s = JSON.parse(await readFile(join(f.folder, path)));
  s.layout.bins[0].target = "../esbuild/lib/./main.js";
  await f.saveJson(path, s); await f.seal();
  const r = await f.validate(); assert.equal(r.status, "invalid"); assert.ok(r.errors.some((e) => e.reason === "install-layout-changed-during-run"));
});
for (const [name, mutate, reason] of [
  ["subset", async (f) => { f.output.selectedApps.pop(); }, "incomplete-or-changed-registry"],
  ["coherent scalar", async (f) => { f.output.cells.react.measurement.actions[0].elapsedMs++; }, "timings-differ"],
  ["mount origin", async (f) => { f.output.cells.react.measurement.timing.operations[0].timeOrigin++; }, "operation-clock"],
  ["fixed defaults", async (f) => { f.plan.invocation.defaults.rows = 1000; }, "plan-differs-from-fixed"],
  ["terminal fake success", async (f) => { f.output.terminal.resources[0].observed = false; }, "summary-passed"],
  ["signal hidden", async (f) => { f.output.terminal.signals.push({ signal: "SIGINT", at: 100, aborted: true }); }, "signal-without-interrupted"],
  ["request byte coherence", async (f) => { f.output.cells.react.qualification.requests[0].body.bytes++; }, "request-body-differs"],
  ["request omitted", async (f) => { f.output.cells.react.measurement.requests.pop(); }, "missing-native-artifact-request"],
  ["raw build options", async (f) => { const p = "native/react/build-options.json", o = buildOptions("react", producerRoot, "linux"); o.define["process.env.NODE_ENV"] = '"development"'; await f.saveJson(p, o); }, "build-receipt-differs"],
  ["source omitted", async (f) => { for (const stage of ["before", "after"]) { const p = `evidence/source-${stage}.json`, s = JSON.parse(await readFile(join(f.folder, p))); s.entries = s.entries.filter((s) => s.path !== "bench/client-heavy/run.mjs"); await f.saveJson(p, s); } }, "blocked"],
  ["configuration malformed union", async (f) => { await f.saveJson("evidence/configuration-after.json", { names: ["RUSTFLAGS", "RUSTFLAGS"] }); }, "invalid-configuration"],
  ["unknown file", async (f) => { await f.write("evidence/approved.json", "true"); }, "unexpected-artifact"],
  ["overlapping passes", async (f) => { f.output.cells.react.measurement.lifecycle = structuredClone(f.output.cells.react.qualification.lifecycle); }, "context-before-build-or-previous-close"],
  ["request after context", async (f) => { for (const r of f.output.cells.react.measurement.requests) { r.startedAt += 1000; r.endedAt += 1000; } }, "http-clock-outside-context"],
  ["terminal before contexts", async (f) => { for (const r of f.output.terminal.resources) { r.startedAt = 0; r.endedAt = 0; } }, "terminal-before-context"],
  ["malformed vendor configuration", async (f) => { await f.write("evidence/cargo-vendor.toml", "not TOML"); }, "wrong-cargo-source-replacement"],
  ["contradictory lockfiles", async (f) => { await f.saveJson("evidence/cargo-lock-after.json", await f.e.blob(Buffer.from("different"))); }, "cargo-lock-receipts-differ"],
  ["empty node dependency union", async (f) => { for (const stage of ["before", "after"]) { const p = `evidence/node-dependencies-${stage}.json`, v = JSON.parse(await readFile(join(f.folder, p))); v.entries = []; await f.saveJson(p, v); } }, "invalid-npm-lock"],
  ["measurement omitted after qualification", async (f) => { const c = f.output.cells.react; c.measurement = null; c.outcome = "failed"; c.readyForMeasurement = false; f.output.passed = false; }, "missing-measurement-attempt"],
  ["unreported operation HTTP", async (f) => { const p = f.output.cells.react.measurement, r = structuredClone(p.requests[1]);
    r.id = p.requests.length; r.startedAt = p.timing.timeOrigin - f.plan.nodeClock.timeOrigin + p.timing.operations[0].startedAt; r.endedAt = r.startedAt + 0.1; p.requests.push(r); }, "unexpected-native-journey-http"],
  ["compiler after browser", async (f) => { for (const label of ["cargo-vendor", "cargo-metadata", "cargo-run"]) { const path = `evidence/${label}.json`, r = JSON.parse(await readFile(join(f.folder, path))); r.startedAt += 6000; r.endedAt += 6000; await f.saveJson(path, r); } }, "compiler-tools-outside-native-build"],
]) test(`v2 refuses ${name} despite resealed ledger`, async (t) => {
  const f = await fixture(t); await mutate(f); await f.seal(); const r = await f.validate();
  if (reason === "blocked") { assert.equal(r.status, "blocked", JSON.stringify(r.errors)); assert.equal(r.readyForLoad, false); }
  else { assert.equal(r.status, "invalid", JSON.stringify(r)); assert.ok(r.errors.some((e) => e.reason.includes(reason)), JSON.stringify(r.errors)); }
});
test("valid retained semantic failure is failed, never timing zero or a subset pass", async (t) => {
  const f = await fixture(t), c = f.output.cells.react;
  c.measurement.lifecycle.close.observed = false; c.measurement.readyMs = null; c.measurement.actions = null;
  c.readyForMeasurement = false; c.outcome = "failed"; f.output.passed = false;
  await f.seal(); const r = await f.validate();
  assert.equal(r.status, "failed", JSON.stringify(r.errors)); assert.equal(r.intrinsic.complete, true); assert.equal(r.cells.react.measurement.timings, null);
  assert.equal(Object.keys(r.cells).length, 6); assert.equal((await admitSaved(f.request)).admitted, false);
});

test("dependency-loader failure after the Cargo probe is a retained apparatus failure", async (t) => {
  const f = await fixture(t);
  for (const name of ["cargo-vendor.json", "cargo-vendor.toml", "cargo-metadata.json", "cargo-run.json", "compiler-inputs.json", "cargo-lock-before.json", "cargo-lock-after.json", "cargo-lock-invocation.json", "cargo-dependencies-before.json", "cargo-dependencies-after.json", "browser.json"])
    await f.remove(`evidence/${name}`);
  for (const app of apps) { await f.remove(`native/${app}`); f.output.builds[app] = { outcome: "not-run", reason: "runner-failed-before-build" };
    f.output.cells[app] = { outcome: "not-run", reason: "runner-failed-before-adapter", qualification: null, measurement: null, readyForMeasurement: false }; }
  for (const label of ["node-dependencies", "browser-dependencies"]) { const path = `evidence/${label}-before.json`, s = JSON.parse(await readFile(join(f.folder, path)));
    s.startedAt = 4; s.endedAt = 5; s.unavailable = [{ name: "Error" }]; await f.saveJson(path, s); }
  f.output.provenance.browser = null; f.output.passed = false;
  f.output.failure = { reason: "runner-failed", name: "Error", diagnosticSha256: "a".repeat(64) };
  f.output.terminal.resources = ["browser", "server"].map((resource) => ({ resource, state: "not-created" }));
  await f.seal(); const r = await f.validate(); assert.equal(r.status, "blocked", JSON.stringify(r.errors)); assert.equal(r.valid, true);
  assert.ok(Object.values(r.cells).every((c) => c.outcome === "not-run"));
});
test("external admission requires independently supplied matching observation and review", async (t) => {
  const f = await fixture(t), replay = await f.validate(), hash = (v) => sha256(json(v)), d = "a".repeat(64);
  const host = hostFixture(replay);
  // Synthetic trusted-channel contract fixture only. Never persisted as review evidence.
  const context = { schema: "client-heavy-trusted-context/v1", attemptId: "unit", unitId: "unit", hostId: "unit", observerId: "observer", producerId: "producer",
    commit: f.request.commit, round: "unit", invocationSha256: hash(replay.invocation), sourceFilesSha256: hash(replay.sources.files), cpuSet: "0", memoryMaxBytes: 1024,
    exclusive: true, bootId: host.context.bootId, unitPath: host.context.unitPath, cpuMax: host.context.cpuMax,
    networkPolicySha256: d, toolchainSha256: d, configurationSha256: d };
  const observation = { schema: "client-heavy-trusted-observation/v1", attemptId: "unit", unitId: "unit", hostId: "unit", observerId: "observer", subjectSha256: replay.subjectSha256,
    commit: f.request.commit, round: "unit", startedAt: replay.executionWindow.startedAt - 1, endedAt: replay.executionWindow.endedAt + 1, exitCode: 2, filesSha256: hash(replay.files), configurationNamesSha256: hash(replay.configurationNames),
    toolchainSha256: d, configurationSha256: d, networkPolicySha256: d, cpuSet: "0", memoryMaxBytes: 1024, exclusive: true };
  const buildReview = { schema: "client-heavy-independent-build-review/v1", reviewerId: "reviewer", subjectSha256: replay.subjectSha256,
    sourceFilesSha256: context.sourceFilesSha256, toolchainSha256: d, configurationSha256: d, receiptSha256: d, verdict: "pass" };
  const hostProof = host.proof;
  assert.equal((await admitSaved(f.request, { context, observation, buildReview: null, hostProof })).admitted, false);
  assert.equal((await admitSaved(f.request, { context, observation, buildReview, hostProof: null })).admitted, false);
  const good = await admitSaved(f.request, { context, observation, buildReview, hostProof }); assert.equal(good.admitted, true, JSON.stringify(good.errors)); assert.equal(good.rankingEligible, false);
  for (const mutate of [(x) => { x.observation.subjectSha256 = "b".repeat(64); }, (x) => { x.context.exclusive = false; },
    (x) => { x.buildReview.reviewerId = "producer"; }, (x) => { x.observation.configurationNamesSha256 = "b".repeat(64); },
    (x) => { x.observation.toolchainSha256 = "b".repeat(64); }, (x) => { x.observation.startedAt = 1; x.observation.endedAt = 2; }]) {
    const trusted = structuredClone({ context, observation, buildReview, hostProof }); mutate(trusted); assert.equal((await admitSaved(f.request, trusted)).status, "invalid");
  }
});
