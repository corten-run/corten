import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { Evidence, closeObserved, json, sha256 } from "./evidence.mjs";
import { defaults, options, run, serve, journey, dispatchOperation, finishRun } from "./run.mjs";
import { selectedApps } from "../workloads/registry.mjs";
import { validateSaved, snapshot } from "./verify.mjs";
import { vendorConfiguration } from "./build.mjs";
import { artifactProfile } from "./verify-v2.mjs";

// All fixtures here are collector unit inputs, NOT saved native framework evidence.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "client-heavy-producer-")), out = join(root, "saved");
  t.after(async () => {
    const r = relative(tmpdir(), root); assert.ok(r && !isAbsolute(r) && r !== ".." && !r.startsWith(".."));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(out);
  const write = async (path, text) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); };
  const read = async (path) => JSON.parse(await readFile(join(out, path), "utf8"));
  return { root, out, write, read, evidence: new Evidence(root, out) };
}

test("invocation retains exact argv, unchanged defaults, effective options and full selection", () => {
  const args = ["unit", "--seed", "13", "--cards", "3"];
  const o = options(args);
  assert.deepEqual(o.invocation.argv, args); args[0] = "changed"; assert.equal(o.invocation.argv[0], "unit");
  assert.equal(o.invocation.defaults.seed, 7); assert.equal(o.invocation.effective.seed, 13);
  assert.deepEqual(defaults, { rows: 14, large: 110, append: 7, cards: 24, seed: 7, "cleanup-ms": 2000,
    "observation-ms": 100, "timeout-ms": 30000, cargo: "cargo" });
  assert.equal(selectedApps("client-heavy").length, 6);
});

test("source before/after saves real bytes, commit, binary diff and clean observations", async (t) => {
  const f = await fixture(t);
  await f.write(".gitignore", "saved/\n"); await f.write("bench/client-heavy/probe.mjs", "// Collector unit fixture\n");
  await f.write("Cargo.toml", "# Collector unit fixture\n");
  const git = (...args) => execFileSync("git", args, { cwd: f.root, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--quiet"); git("add", ".gitignore", "Cargo.toml", "bench/client-heavy/probe.mjs");
  await mkdir(join(f.root, "hooks"));
  git("-c", "user.name=Collector unit fixture", "-c", "user.email=unit@example.invalid", "-c", "commit.gpgsign=false",
    "-c", `core.hooksPath=${join(f.root, "hooks")}`, "commit", "--quiet", "-m", "Collector unit fixture");
  // Empty untracked hooks directory does not affect the clean observation.
  const before = await f.evidence.source("before"), after = await f.evidence.source("after");
  assert.match(before.commit, /^[a-f0-9]{40}$/); assert.equal(before.status.bytes, 0);
  assert.deepEqual(before.entries, after.entries); assert.deepEqual(before.unavailable, []);
  for (const entry of before.entries) assert.equal(sha256(await readFile(join(f.out, entry.blob))), entry.sha256);
  await f.write("bench/client-heavy/probe.mjs", "// Changed collector unit fixture\n");
  const changed = await f.evidence.source("changed");
  assert.notDeepEqual(before.entries, changed.entries); assert.ok(changed.status.bytes > 0 && changed.diff.bytes > 0);
  assert.ok(f.evidence.blockers.includes("source-changed-not-clean"));
});

test("dependency snapshots contain every regular file's bytes, not just a digest claim", async (t) => {
  const f = await fixture(t), base = join(f.root, "dependencies");
  await f.write("dependencies/a/package.json", '{"name":"collector-unit-fixture"}\n');
  await f.write("dependencies/a/lib.js", "// Collector unit dependency\n");
  const before = await f.evidence.tree(base, "unit-dependencies", "before");
  assert.deepEqual(before.entries.map((e) => e.path), ["a/lib.js", "a/package.json"]);
  assert.deepEqual(before.unavailable, []);
  for (const entry of before.entries) assert.deepEqual(await readFile(join(f.out, entry.blob)), await readFile(join(base, entry.path)));
  await f.write("dependencies/a/lib.js", "// Changed unit dependency\n");
  const after = await f.evidence.tree(base, "unit-dependencies", "after");
  assert.notDeepEqual(before.entries, after.entries);
});

test("only the v2 Cargo vendor tree accepts SemVer build metadata in filenames", async (t) => {
  const f = await fixture(t);
  const path = "evidence/cargo-vendor/wasi-0.11.1+wasi-snapshot-preview1/Cargo.toml";
  await f.write(`saved/${path}`, "# Collector unit dependency\n");
  const profile = { directory: () => true, versionedVendorPaths: true };
  assert.deepEqual([...(await snapshot(f.out, profile)).keys()], [path]);
  await assert.rejects(snapshot(f.out, { directory: () => true }), /unsafe-path/);
  await f.write("saved/not-vendor+name.json", "{}\n");
  await assert.rejects(snapshot(f.out, profile), /unsafe-path/);
});

test("larger executable blobs seal with their explicit bound; ordinary artifacts do not", async (t) => {
  const f = await fixture(t); f.evidence.limits.fileBytes = 8;
  await f.write("image", "large executable bytes");
  const ref = await f.evidence.file(f.root, "image", 32);
  const subject = await f.evidence.seal({ group: "client-heavy", round: "unit", commit: "a".repeat(40) });
  assert.equal(subject.files[0].path, ref.blob);
  await rm(join(f.out, "review-subject.json"));
  await f.write("saved/ordinary", "large ordinary bytes");
  await assert.rejects(f.evidence.seal({}), /saved-evidence-byte-limit/);
});

test("snapshot keeps ordinary-file, unique-blob and saved-total bounds independent", async (t) => {
  const f = await fixture(t), a = Buffer.from("aaa"), b = Buffer.from("bbb");
  await f.write(`saved/evidence/blobs/${sha256(a)}`, a); await f.write(`saved/evidence/blobs/${sha256(b)}`, b);
  const profile = { ...artifactProfile, blobTotalBytes: 5, limits: { ...artifactProfile.limits, fileBytes: 4, totalBytes: 20 } };
  await assert.rejects(snapshot(f.out, profile), /unique-blob-byte-limit/);
  await assert.rejects(snapshot(f.out, { ...profile, blobTotalBytes: 10, limits: { ...profile.limits, totalBytes: 5 } }), /artifact-byte-limit/);
  await f.write("saved/result.json", "12345");
  await assert.rejects(snapshot(f.out, { ...profile, blobTotalBytes: 10 }), /oversized-blob-not-browser-executable/);
});

test("missing, linked and oversized dependencies explicitly block incomplete collection", async (t) => {
  const f = await fixture(t);
  const missing = await f.evidence.tree(join(f.root, "missing"), "missing-dependencies", "before");
  assert.equal(missing.unavailable.length, 1); assert.ok(f.evidence.blockers.includes("missing-dependencies-before-incomplete"));
  await f.write("dependencies/module.js", "// Unit fixture\n");
  await symlink(join(f.root, "dependencies"), join(f.root, "dependency-link"), process.platform === "win32" ? "junction" : "dir");
  const linked = await f.evidence.tree(join(f.root, "dependency-link"), "linked-dependencies", "before");
  assert.deepEqual(linked.entries, []); assert.equal(linked.unavailable.length, 1);
  f.evidence.limits.fileBytes = 1;
  const oversized = await f.evidence.tree(join(f.root, "dependencies"), "large-dependencies", "before");
  assert.equal(oversized.unavailable.length, 1);
});

test("source readers reject link traversal, hardlinks and escape paths", async (t) => {
  const f = await fixture(t); await f.write("source.js", "// Unit fixture\n");
  await assert.rejects(f.evidence.file(f.root, "../outside"), /source-path-escape/);
  await link(join(f.root, "source.js"), join(f.root, "hard.js"));
  await assert.rejects(f.evidence.file(f.root, "hard.js"), /linked-or-nonregular-source/);
  await mkdir(join(f.root, "real"));
  await symlink(join(f.root, "real"), join(f.root, "alias"), process.platform === "win32" ? "junction" : "dir");
  await f.write("real/module.js", "// Unit fixture\n");
  await assert.rejects(f.evidence.file(f.root, "alias/module.js"), /linked-source-ancestor/);
});

test("tool receipts save actual stdout/stderr bytes, exit status and endpoint clocks", async (t) => {
  const f = await fixture(t);
  const result = await f.evidence.tool(process.execPath, ["-e", "process.stdout.write('unit stdout'); process.stderr.write('unit stderr'); process.exitCode=3"], "unit-tool");
  const receipt = await f.read("evidence/unit-tool.json");
  assert.equal(receipt.status, 3); assert.equal(receipt.failure, null); assert.ok(receipt.endedAt >= receipt.startedAt);
  assert.equal((await readFile(join(f.out, receipt.stdout.blob))).toString(), "unit stdout");
  assert.equal((await readFile(join(f.out, receipt.stderr.blob))).toString(), "unit stderr");
  assert.equal(receipt.stdout.sha256, sha256(result.stdout));
  assert.ok(f.evidence.blockers.includes("unit-tool-unavailable"));
});

test("vendor source replacement is a saved TOML file, not shell-quoted config arguments", async (t) => {
  const f = await fixture(t), config = join(f.out, "evidence/cargo-vendor.toml");
  assert.ok(vendorConfiguration.includes('[source.crates-io]\nreplace-with = "client-heavy-vendor"'));
  assert.ok(vendorConfiguration.includes('directory = "evidence/cargo-vendor"'));
  assert.equal(join(dirname(dirname(config)), "evidence/cargo-vendor"), join(f.out, "evidence/cargo-vendor"));
  if (process.platform === "win32") {
    await f.write("unit-tool.cmd", "@echo off\r\necho %*\r\n");
    const result = await f.evidence.tool(join(f.root, "unit-tool.cmd"), ["run", "--config", "saved/evidence/cargo-vendor.toml", "--locked", "--offline"], "unit-batch-tool");
    assert.equal(result.receipt.status, 0); assert.match(result.stdout.toString(), /run --config saved\/evidence\/cargo-vendor.toml --locked --offline/);
  }
});

test("review subject binds all artifact bytes but contains no authored approval", async (t) => {
  const f = await fixture(t); await f.evidence.save("result.json", { fixture: "collector-unit-only", proof: "blocked" });
  await f.evidence.blob(Buffer.from("Unit dependency bytes"));
  await f.evidence.seal({ group: "client-heavy", round: "unit", commit: "1".repeat(40) });
  const { subjectSha256, ...subject } = await f.read("review-subject.json");
  assert.equal(subjectSha256, sha256(json(subject)));
  assert.ok(!Object.hasOwn(subject, "approved") && !subject.files.some((entry) => entry.path === "review-subject.json"));
  for (const entry of subject.files) assert.equal(sha256(await readFile(join(f.out, entry.path))), entry.sha256);
  await writeFile(join(f.out, "result.json"), "{mutated}");
  assert.notEqual(subject.files.find((entry) => entry.path === "result.json").sha256, sha256(await readFile(join(f.out, "result.json"))));
  await assert.rejects(f.evidence.seal({}), /subject-already-exists/);
});

test("subject generation rejects linked and hardlinked artifacts instead of sealing them", async (t) => {
  const f = await fixture(t);
  await f.write("outside/unit.js", "// Unit fixture\n");
  await symlink(join(f.root, "outside"), join(f.out, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.evidence.seal({}), /linked-saved-evidence/);
  await rm(join(f.out, "linked"));
  await writeFile(join(f.out, "unit.js"), "// Unit fixture\n");
  await link(join(f.out, "unit.js"), join(f.out, "duplicate.js"));
  await assert.rejects(f.evidence.seal({}), /nonregular-saved-evidence/);
});

test("positive server close observes the real close event, not just an empty failure list", async (t) => {
  const f = await fixture(t), server = await serve(f.out);
  t.after(async () => { if (!server.isClosed()) await server.close(); });
  assert.equal(server.isClosed(), false);
  const receipt = await closeObserved("server", () => server.close(), () => server.isClosed());
  assert.equal(receipt.returned, true); assert.equal(receipt.observed, true); assert.equal(receipt.failure, null);
  assert.ok(receipt.endedAt >= receipt.startedAt); await assert.rejects(fetch(server.url));
});

test("failed closure is retained without pretending an observation succeeded", async () => {
  let observed = false;
  const receipt = await closeObserved("unit", async () => { throw new Error("Unit private diagnostic"); }, () => { observed = true; });
  assert.equal(receipt.returned, false); assert.equal(receipt.observed, null); assert.equal(observed, false);
  assert.equal(receipt.failure.name, "Error"); assert.ok(!JSON.stringify(receipt).includes("Unit private diagnostic"));
});

test("unknown terminal browser closure stays unknown and cannot preserve a passing result", async (t) => {
  const f = await fixture(t), output = { selectedApps: [], cells: {}, passed: true, collection: { proof: "blocked", isolation: "unknown" } };
  await finishRun(output, f.out, { browser: { async close() {} }, isInterrupted: () => false });
  assert.equal(output.terminal.resources[0].observed, null); assert.equal(output.passed, false);
  assert.equal(output.collection.proof, "blocked"); assert.equal(output.collection.isolation, "unknown");
});

for (const timeout of [false, true]) test(`journey records actual context closure and deadline abort (${timeout})`, async () => {
  const context = new EventEmitter(); let closes = 0;
  context.close = async () => { closes++; context.emit("close"); };
  context.newPage = timeout ? () => new Promise((_, reject) => context.once("close", () => reject(new Error("Unit page closed"))))
    : async () => { throw new Error("Unit page creation failure"); };
  const workload = options(["unit"]).workload;
  const pass = await journey({ newContext: async () => context }, "http://127.0.0.1", "react", workload,
    { maxCleanupMs: 2, cleanupObservationMs: 1 }, timeout ? 5 : 100);
  assert.equal(closes, 1); assert.equal(pass.lifecycle.close.observed, true); assert.equal(pass.lifecycle.close.returned, true);
  assert.equal(pass.lifecycle.deadline.firedAt !== null, timeout); assert.equal(pass.lifecycle.deadline.aborted, timeout);
  assert.equal(pass.capture.outcome, "failed"); assert.equal(pass.readyMs, null); assert.equal(pass.actions, null);
});

test("dispatch saves actual common-clock timing endpoints even for the untimed qualification", async () => {
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  let clicks = 0;
  try {
    globalThis.window = { clientObserver: { visible: () => true, loaded: () => ({ cards: [] }),
      settle: () => new Promise((ok) => setTimeout(ok, 5)), dom: () => ({ fixture: "unit-only" }), now: () => performance.now() } };
    globalThis.document = { querySelector: () => ({ disabled: false, click: () => clicks++ }) };
    for (const measure of [false, true]) {
      const result = await dispatchOperation({ op: { kind: "clear" }, measure });
      assert.ok(result.endedAt >= result.startedAt && result.at >= result.endedAt);
      assert.equal(result.timeOrigin, performance.timeOrigin);
      assert.equal(result.elapsedMs, measure ? result.endedAt - result.startedAt : null);
    }
    assert.equal(clicks, 2);
  } finally {
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
  }
});

test("final accounting retains failed/unsupported/not-run cells and writes every app file", async (t) => {
  const f = await fixture(t), apps = selectedApps("client-heavy"), cells = {};
  cells.react = { outcome: "unsupported", reason: "unit-only", qualification: null, measurement: null, readyForMeasurement: false };
  const output = { selectedApps: apps, cells, builds: { corten: { outcome: "failed" } }, passed: false };
  await finishRun(output, f.out, { isInterrupted: () => true, signals: [{ signal: "SIGINT", at: 1, aborted: true }] });
  assert.equal(output.cells.corten.outcome, "failed"); assert.equal(output.cells.react.outcome, "unsupported");
  assert.equal(output.cells.vue.outcome, "not-run");
  for (const app of apps) assert.deepEqual(await f.read(`${app}.json`), output.cells[app]);
  assert.deepEqual(output.terminal.resources.map((r) => r.state), ["not-created", "not-created"]);
  assert.equal(output.terminal.signals[0].aborted, true);
});

test("a real failed producer invocation saves complete six-app accounting but no strict positive", { timeout: 120000 }, async (t) => {
  const f = await fixture(t), out = join(f.root, "run"), args = ["unit-failed", "--out", out, "--cargo", join(f.root, "no-such-cargo")];
  const output = await run(args), saved = JSON.parse(await readFile(join(out, "result.json"), "utf8"));
  assert.equal(saved.schema, "client-heavy-native/v2"); assert.deepEqual(output, saved);
  assert.equal(saved.collection.accounting, "complete"); assert.equal(saved.collection.proof, "blocked");
  assert.equal(saved.collection.isolation, "unknown"); assert.equal(saved.collection.rankingEligible, false); assert.equal(saved.readyForLoad, false);
  assert.equal(saved.passed, false); assert.ok(saved.collection.blockers.length > 0);
  assert.deepEqual(JSON.parse(await readFile(join(out, "plan.json"), "utf8")).invocation.argv, args);
  for (const app of selectedApps("client-heavy")) {
    assert.deepEqual(JSON.parse(await readFile(join(out, `${app}.json`), "utf8")), saved.cells[app]);
    assert.ok(["passed", "failed", "not-run"].includes(saved.cells[app].outcome));
    if (saved.cells[app].outcome !== "passed") assert.equal(saved.cells[app].measurement, null);
  }
  // Missing Cargo guarantees no Rust build and no Corten performance qualification,
  // even on a host that can build/capture some of the JavaScript contenders.
  assert.notEqual(saved.cells.corten.outcome, "passed"); assert.equal(saved.cells.corten.measurement, null);
  const subject = JSON.parse(await readFile(join(out, "review-subject.json"), "utf8"));
  assert.ok(subject.files.some((entry) => entry.path === "evidence/source-before.json"));
  assert.ok(subject.files.some((entry) => entry.path === "evidence/source-after.json"));
  assert.ok(subject.files.some((entry) => entry.path === "native/build.json"));
  const rejected = await validateSaved({ folder: out, round: "unit-failed", commit: saved.provenance.commit });
  assert.equal(rejected.schema, "client-heavy-saved-verification/v2");
  assert.equal(rejected.status, "blocked", JSON.stringify(rejected.errors)); assert.equal(rejected.diagnosticsPassed, true); assert.equal(rejected.ready, false);
  const before = sha256(await readFile(join(out, "result.json")));
  await assert.rejects(run(args), /EEXIST/); assert.equal(sha256(await readFile(join(out, "result.json"))), before);
});
