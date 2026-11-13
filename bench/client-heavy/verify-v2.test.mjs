import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { Evidence, json, sha256 } from "./evidence.mjs";
import { options, sourceRoots, buildOptions, documentMarkup } from "./contract.mjs";
import { committed, validateSaved } from "./verify.mjs";
import { selectedApps, definition } from "../workloads/registry.mjs";
import { fixturePass, workload, settings } from "./replay-fixture.mjs";
import { vendorConfiguration } from "./build-replay.mjs";
import { admitSaved } from "./admission.mjs";
import { hostFixture } from "./host-fixture.mjs";

const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), apps = selectedApps("client-heavy");
const producerRoot = "/producer", outputPath = "bench/client-heavy/work/unit";
// Completely synthetic source/build/browser receipts. Their successful intrinsic
// replay MUST NOT authenticate them or create a real review receipt.
async function fixture(t) {
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
  const config = options(["unit", "--rows", "8", "--large", "10", "--append", "1", "--cards", "2", "--cleanup-ms", "10", "--observation-ms", "5"], producerRoot, "linux");
  assert.deepEqual(config.workload, workload); assert.deepEqual(config.settings, settings);
  const plan = { schema: "client-heavy-plan/v1", round: "unit", commit, invocation: config.invocation, workload, settings, timeoutMs: 30000,
    selectedApps: [...apps], definition: definition("client-heavy"), sourceBefore: "evidence/source-before.json", root: producerRoot, platform: "linux",
    nodeClock: { clock: "node-performance", timeOrigin: 1000 }, inheritedConfigurationNames: ["PATH"] };
  const output = { schema: "client-heavy-native/v2", group: "client-heavy", round: "unit", effectiveWorkload: workload, settings, timeoutMs: 30000,
    selectedApps: [...apps], definition: definition("client-heavy"), builds: {}, cells: {}, passed: true, readyForLoad: false, cleanupFailures: [],
    collection: { accounting: "complete", proof: "blocked", blockers: ["external-trusted-execution-source-build-and-host-admission-required"], isolation: "unknown", rankingEligible: false, reviewSubject: "review-subject.json" },
    provenance: { commit, sourceBefore: "evidence/source-before.json", sourceAfter: "evidence/source-after.json", node: "unit", platform: "linux", release: "unit", cpu: "unit", logicalCpus: 1,
      browser: "unit", browserInstances: 1, rendererProcessLimit: 1, concurrentPages: 1, passes: 2, note: "SYNTHETIC UNIT ONLY" },
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
    const bytes = { "index.html": Buffer.from(documentMarkup(app, workload, "<section>Synthetic unit</section>")), [bundle]: code };
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
    output.cells[app] = { outcome: "passed", qualification: fixturePass(app, false), measurement: fixturePass(app, true), readyForMeasurement: true };
    for (const phase of ["qualification", "measurement"]) {
      const p = output.cells[app][phase], start = 100 + apps.indexOf(app) * 1000 + (phase === "measurement" ? 200 : 0);
      p.lifecycle.contextCreatedAt = start; p.lifecycle.deadline.scheduledAt += start; p.lifecycle.deadline.cancelledAt += start;
      p.lifecycle.close.startedAt += start; p.lifecycle.close.endedAt += start; p.timing.timeOrigin += start + 10;
      p.timing.operations.forEach((s) => { s.timeOrigin += start + 10; });
      p.requests = Object.entries(bytes).map(([name, b], id) => ({ id, path: `/${app}/${name}`,
        method: "GET", resourceType: name.endsWith("html") ? "document" : "script", startedAt: start + 2 + id, endedAt: start + 3 + id, status: 200, body: { bytes: b.length, sha256: sha256(b) }, failure: null }));
    }
  }
  const seal = async () => {
    await saveJson("plan.json", plan); await saveJson("result.json", output); await saveJson("native/workload.json", workload); await saveJson("native/build.json", output.builds);
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

test("oversized blobs require the checked browser executable reference", async (t) => {
  const f = await fixture(t), browserPath = "evidence/browser.json", nodePath = "evidence/node.json";
  const browser = JSON.parse(await readFile(join(f.folder, browserPath))), node = JSON.parse(await readFile(join(f.folder, nodePath)));
  const ref = await f.e.blob(Buffer.alloc(128 * 1024 ** 2 + 1), 512 * 1024 ** 2);
  for (const role of ["unreferenced", "nonbrowser", "other-reference"]) await t.test(role, async () => {
    await f.saveJson(browserPath, browser); await f.saveJson(nodePath, node);
    const path = "evidence/configuration-after.json";
    await f.saveJson(path, role === "other-reference" ? { names: ["PATH"], oversized: ref } : { names: ["PATH"] });
    if (role === "nonbrowser") await f.saveJson(nodePath, { ...node, executable: ref });
    await f.seal(); const r = await f.validate(); assert.equal(r.status, "invalid", JSON.stringify(r.errors));
    assert.ok(r.errors.some((e) => e.at === "artifacts" && e.reason === "oversized-blob-not-browser-executable"), JSON.stringify(r.errors));
  });
  await f.saveJson("evidence/configuration-after.json", { names: ["PATH"] });
  await f.saveJson(nodePath, node); await f.saveJson(browserPath, { ...browser, executable: ref });
  await f.seal(); const good = await f.validate(); assert.equal(good.status, "verified", JSON.stringify(good.errors));
  assert.equal(good.readyForLoad, false);
  // Sharing the allowed browser blob does not enlarge another reference's bound.
  await f.saveJson(nodePath, { ...node, executable: ref }); await f.seal();
  const shared = await f.validate(); assert.equal(shared.status, "invalid");
  assert.ok(shared.errors.some((e) => e.at === nodePath && e.reason === "invalid-blob-reference"));
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
    commit, round: "unit", invocationSha256: hash(replay.invocation), sourceFilesSha256: hash(replay.sources.files), cpuSet: "0", memoryMaxBytes: 1024,
    exclusive: true, bootId: host.context.bootId, unitPath: host.context.unitPath, cpuMax: host.context.cpuMax,
    networkPolicySha256: d, toolchainSha256: d, configurationSha256: d };
  const observation = { schema: "client-heavy-trusted-observation/v1", attemptId: "unit", unitId: "unit", hostId: "unit", observerId: "observer", subjectSha256: replay.subjectSha256,
    commit, round: "unit", startedAt: replay.executionWindow.startedAt - 1, endedAt: replay.executionWindow.endedAt + 1, exitCode: 2, filesSha256: hash(replay.files), configurationNamesSha256: hash(replay.configurationNames),
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
