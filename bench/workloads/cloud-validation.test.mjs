import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { harness } from "./cloud-fixtures.mjs";
import { inspectCampaign, validationLimit, validationStopLimit } from "./cloud-validation.mjs";
import { captureValidation, localCompiler, validationPaths, validationTask, typescriptPath, semverIntegrity, semverSources } from "./cloud-validation-snapshot.mjs";
import { fixtureGitEnv, withFixtureGitEnv } from "../../scripts/fixture-git.mjs";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 5000, windowsHide: true, env: fixtureGitEnv() });
  assert.equal(result.status, 0, "synthetic local Git operation failed"); return result.stdout.trim();
}
// captureValidation runs Git on the process's environment, so it reads a fixture only without the caller's selectors.
const captureFixture = (/** @type {string} */ commit, /** @type {any} */ options) => withFixtureGitEnv(() => captureValidation(commit, options));
// The bench package's classic compiler (npm --prefix bench ci), linked, never copied or altered.
const classicCompiler = realpathSync(join(checkout, "bench/node_modules/typescript"));

const syntheticHead = "c".repeat(40);
const privateGitData = "synthetic private Git detail";
for (const [name, result, reason] of [
  ["timeout", { status: null, error: Object.assign(new Error(privateGitData), { code: "ETIMEDOUT" }) }, "timed out"],
  ["spawn", { status: null, error: Object.assign(new Error(privateGitData), { code: "ENOENT" }) }, "process error"],
  ["spawn-throws", new Error(privateGitData), "process error"],
  ["nonzero", { status: 128, stdout: syntheticHead + "\n" }, "unsuccessful exit"],
  ["signal", { status: null, signal: "SIGTERM" }, "unsuccessful exit"],
  ["malformed", { status: 0, stdout: syntheticHead + "\n" + privateGitData }, "malformed output"],
  ["valid", { status: 0, stdout: syntheticHead + "\r\n" }, null],
]) {
  test(`installed Git HEAD initialization: ${name}`, async (t) => {
    const spawn = t.mock.method(childProcess, "spawnSync", () => {
      if (result instanceof Error) throw result;
      return { stdout: privateGitData, stderr: privateGitData, ...result };
    });
    syncBuiltinESMExports();
    const url = new URL(`./cloud-validation-snapshot.mjs?head=${name}`, import.meta.url);
    let initialized;
    try {
      if (reason === null) initialized = await import(url.href);
      else await assert.rejects(import(url.href), (error) => {
        assert.equal(error.message, `Git HEAD validation failed: ${reason}`);
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(spawn.mock.callCount(), 1, "one Git read, no retry");
      const [command, args, options] = spawn.mock.calls[0].arguments;
      assert.equal(command, "git");
      assert.deepEqual(args, ["--no-replace-objects", "-C", realpathSync(checkout), "rev-parse", "--verify", "HEAD^{commit}"]);
      assert.equal(options.timeout, 5000);
      assert.equal(options.maxBuffer, 1024);
      assert.equal(options.shell, false);
    } finally {
      spawn.mock.restore();
      syncBuiltinESMExports();
    }
    if (initialized) {
      const generic = { message: "native campaign validation unavailable or invalid; evidence/host preserved" };
      const reads = [];
      const readGit = (_command, args) => {
        reads.push(args[3]);
        return { status: 128, stderr: privateGitData };
      };
      assert.throws(() => initialized.captureValidation("b".repeat(40), { readGit }), generic);
      assert.deepEqual(reads, []);
      assert.throws(() => initialized.captureValidation(syntheticHead, { readGit }), generic);
      assert.deepEqual(reads, ["cat-file"], "use the initialized HEAD without a second rev-parse");
      assert.throws(() => initialized.captureValidation(syntheticHead, { root: dirname(checkout), readGit }), generic);
      assert.deepEqual(reads, ["cat-file", "rev-parse"], "downstream HEAD failures stay generic");
    }
  });
}

function linkClassicCompiler(repo) {
  mkdirSync(join(repo, "bench/node_modules"), { recursive: true });
  symlinkSync(classicCompiler, join(repo, "bench/node_modules/typescript"), "junction");
}

function removeDependencyLink(repo) {
  const link = join(repo, "bench/node_modules/typescript");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(realpathSync(link), classicCompiler);
  if (process.platform === "win32") rmdirSync(link);
  else unlinkSync(link);
}

const benchMetadata = ["bench/package.json", "bench/package-lock.json"];
// The committed bench manifest and lock, as parsed objects an edit may change or delete.
const benchFiles = () => Object.fromEntries(benchMetadata.map((path) => [path, JSON.parse(readFileSync(join(checkout, path), "utf8"))]));

// `omit` builds an older measured commit: those closure paths are neither committed nor in its copied snapshot list.
async function fakeNative(t, source, { realGraph = false, unconfirmed = false, bench = () => {}, omit = [] } = {}) {
  const h = harness(t), repo = join(h.temp, "validator"), root = join(repo, "bench/workloads");
  const paths = validationPaths.filter((path) => !omit.includes(path));
  for (const path of paths) {
    const target = join(repo, path); mkdirSync(dirname(target), { recursive: true });
    if (realGraph) copyFileSync(join(checkout, path), target);
    else writeFileSync(target, "export {};\n");
  }
  for (const name of ["cloud-validation.mjs", "cloud-validation-worker.mjs", "cloud-validation-snapshot.mjs"])
    copyFileSync(new URL(name, import.meta.url), join(root, name));
  for (const path of omit) {
    const snapshot = join(root, "cloud-validation-snapshot.mjs"), before = readFileSync(snapshot, "utf8"), entry = `\n  ${JSON.stringify(path)},`;
    assert.equal(before.split(entry).length, 2, "omitted path is listed once"); writeFileSync(snapshot, before.replace(entry, ""));
  }
  if (unconfirmed) {
    const path = join(root, "cloud-validation-snapshot.mjs");
    writeFileSync(path, readFileSync(path, "utf8").replace('import { Worker } from "node:worker_threads";', `
      import {EventEmitter} from "node:events"; import {writeFileSync} from "node:fs";
      class Worker extends EventEmitter {
        stdout = {resume(){}}; stderr = {resume(){}};
        constructor(url, options) { super(); this.folder = options.workerData.input.folder; }
        terminate() { writeFileSync(this.folder + "/stop-requested", "synthetic"); throw new Error("private stop failure"); }
        unref() { writeFileSync(this.folder + "/unreferenced", "synthetic"); }
      }`));
  }
  if (realGraph) for (const path of ["package.json", "bench/marketplace/labels.json"])
    copyFileSync(join(checkout, path), join(repo, path));
  // The TypeScript link targets only the bench install. Semver's small package is
  // copied so replacement controls cannot alter either source install.
  linkClassicCompiler(repo);
  mkdirSync(join(repo, "node_modules"));
  cpSync(join(checkout, "node_modules/semver"), join(repo, "node_modules/semver"), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"));
  manifest.devDependencies.semver = "7.8.6";
  const lock = JSON.parse(readFileSync(join(checkout, "package-lock.json"), "utf8"));
  lock.packages[""].devDependencies.semver = "7.8.6";
  lock.packages["node_modules/semver"] = { version: "7.8.6", resolved: "https://registry.npmjs.org/semver/-/semver-7.8.6.tgz",
    integrity: "sha512-9lpSSU4Mly3mrtruwLs1eLK6+gzbzqeBFwRNjIjE+9LuDpWdYctrQlQ3ej1Ilgi7gknpsTRnPoLP8DpCHqHIJw==", dev: true };
  writeFileSync(join(repo, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify(lock));
  const files = benchFiles(); bench(files);
  for (const [path, value] of Object.entries(files)) writeFileSync(join(repo, path), JSON.stringify(value));
  if (source !== undefined) writeFileSync(join(root, "isolated/campaign-verify.mjs"), source);
  git(repo, "init", "--initial-branch=main");
  git(repo, "add", "--", ...paths, "bench/workloads/cloud-validation.mjs", "bench/workloads/cloud-validation-snapshot.mjs", "package.json", "package-lock.json", ...Object.keys(files));
  git(repo, "-c", "user.name=Synthetic validation test", "-c", "user.email=synthetic@example.invalid", "-c", "core.hooksPath=", "commit", "-qm", "Synthetic validation fixture");
  const approvedCommit = git(repo, "rev-parse", "HEAD");
  // The copied modules read the fixture's HEAD on import and capture from it on inspection, on the
  // process's environment, so both run without the caller's selectors.
  const native = await withFixtureGitEnv(() => import(pathToFileURL(join(root, "cloud-validation.mjs"))));
  const inspect = (/** @type {any[]} */ ...args) => withFixtureGitEnv(() => native.inspectCampaign(...args));
  return { ...h, repo, inspect, input: { folder: root, round: "r21", commit: approvedCommit }, started: join(root, "started") };
}

test("JSON API c-16 and c-32 replay evaluate the committed placement module in the sealed worker; dropping it stays blocked", { timeout: 60000 }, async (t) => {
  const path = "bench/json-api/placement.mjs";
  assert.equal(validationPaths.filter((p) => p === path).length, 1);
  const h = await fakeNative(t, `import {readFileSync} from "node:fs"; import {createHash} from "node:crypto";
    import {inspectJson, renderJson} from "../../json-api/report.mjs";
    export function validateCampaign({folder}) {
      return JSON.parse(readFileSync(folder + "/json-layouts.json", "utf8")).map(({summary, artifacts}) => {
        const load = (ref) => { const bytes = artifacts[ref?.path];
          if (bytes === undefined || createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw new Error("raw artifact"); return JSON.parse(bytes); };
        const report = inspectJson(summary, {load});
        return { baseline: report.baseline, layout: summary.measurement.loadLayout, line: renderJson(report).split("\\n").find((line) => line.startsWith("Load layout ")) };
      });
    }`, { realGraph: true });
  // Both results use the placement and measurement shape run.mjs writes.
  const { result } = await import("../json-api/test-fixtures.mjs"), { c16Env, runnerPlacement } = await import("../json-api/placement.mjs");
  const cases = [[16, c16Env], [32, { ...c16Env, JSON_API_LOAD_LAYOUT: "json-c32-generator-v1", JSON_API_LOAD_CPUS: "4-23" }]];
  const saved = cases.map(([size, env]) => {
    const artifacts = new Map(), f = result([], { artifacts, placement: runnerPlacement(env, size) });
    assert.ok(artifacts.size > 0);
    return { summary: f.summary, artifacts: Object.fromEntries(artifacts) };
  });
  writeFileSync(join(h.input.folder, "json-layouts.json"), JSON.stringify(saved));
  const snapshot = captureFixture(h.input.commit, { root: h.repo }), row = snapshot.sources.find((r) => r.path === path);
  assert.equal(row.source, readFileSync(join(checkout, path), "utf8").replaceAll("\r\n", "\n"));
  // Replacing the checkout file after commit cannot run: replay uses the committed bytes.
  const marker = join(h.input.folder, "unapproved-placement");
  writeFileSync(join(h.repo, path), `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "unapproved");`);
  assert.deepEqual(await h.inspect(h.input), cases.map(([size, env], i) => ({ baseline: true, layout: env.JSON_API_LOAD_LAYOUT,
    line: `Load layout ${env.JSON_API_LOAD_LAYOUT}: the untimed cold probe ran on CPUs 4-7 at quota 4; load resource samples are bounded against k6's quota ${i ? 20 : 12} on CPUs ${env.JSON_API_LOAD_CPUS}. This is apparatus placement for a ${size}-CPU host, not a measured speedup.` })));
  assert.equal(existsSync(marker), false);
  const task = validationTask(h.input, { snapshot, WorkerClass: class extends Worker {
    constructor(entry, options) {
      options.workerData.sources = options.workerData.sources.filter((r) => r.path !== path);
      super(entry, options);
    }
  } });
  await assert.rejects(task.result, /validation unavailable/);
  assert.equal(existsSync(marker), false);
});

test("an older measured commit without the placement module still captures and replays under its own closure list", { timeout: 15000 }, async (t) => {
  const path = "bench/json-api/placement.mjs";
  const h = await fakeNative(t, 'import "../../json-api/report.mjs"; export function validateCampaign() { return { unmarked: true }; }', { omit: [path] });
  assert.throws(() => git(h.repo, "cat-file", "-e", `${h.input.commit}:${path}`));
  // This checkout's list names the module, so it cannot read that commit; the commit's own adapter can.
  assert.throws(() => captureFixture(h.input.commit, { root: h.repo }), /validation unavailable/);
  const own = await withFixtureGitEnv(() => import(pathToFileURL(join(h.repo, "bench/workloads/cloud-validation-snapshot.mjs")).href));
  assert.equal(own.validationPaths.includes(path), false);
  const snapshot = withFixtureGitEnv(() => own.captureValidation(h.input.commit));
  assert.equal(snapshot.sources.some((r) => r.path === path), false);
  assert.equal(snapshot.sources.length, validationPaths.length - 1 + 1 + Object.keys(semverSources).length);
  assert.deepEqual(await h.inspect(h.input), { unmarked: true });
});

test("native worker returns only after stopping validator-owned lasting work", { timeout: 15000 }, async (t) => {
  const h = await fakeNative(t, "export function validateCampaign(input) { setInterval(() => {}, 1000); return input; }");
  let retained = false;
  assert.deepEqual(await h.inspect(h.input, { preserveLock: () => { retained = true; } }), h.input);
  assert.equal(retained, false);
});

test("native worker awaits the fixed asynchronous read-only API without adding authority context", { timeout: 15000 }, async (t) => {
  const h = await fakeNative(t, 'export async function validateCampaign(input) { await new Promise((r) => setTimeout(r, 25)); return { keys: Object.keys(input).sort(), input, frozen: Object.isFrozen(input) }; }');
  assert.deepEqual(await h.inspect(h.input), { keys: ["commit", "folder", "round"], input: h.input, frozen: true });
});

test("asynchronous native rejection is sanitized, settled and cannot become a report", { timeout: 15000 }, async (t) => {
  const h = await fakeNative(t, 'export async function validateCampaign() { await new Promise((r) => setTimeout(r, 25)); throw new Error("synthetic-private-value"); }');
  let retained = false;
  await assert.rejects(h.inspect(h.input, { preserveLock: () => { retained = true; } }), (error) =>
    /validation unavailable/.test(error.message) && !error.message.includes("synthetic-private-value"));
  assert.equal(retained, false);
});

test("native worker cancellation terminates synchronous validator work before lock release", { timeout: 15000 }, async (t) => {
  const h = await fakeNative(t, 'import {writeFileSync} from "node:fs"; export function validateCampaign({folder}) { writeFileSync(folder + "/started", "fake"); while (true) {} }');
  let cancelled = false, retained = false;
  const pending = h.inspect(h.input, { interrupted: () => cancelled, preserveLock: () => { retained = true; } });
  const observed = assert.rejects(pending, /validation unavailable/);
  while (!existsSync(h.started)) await new Promise((r) => setImmediate(r));
  cancelled = true; await observed; assert.equal(retained, false);
});

test("native worker fixed deadline terminates synchronous validator work", { timeout: 15000 }, async (t) => {
  const h = await fakeNative(t, 'import {writeFileSync} from "node:fs"; export function validateCampaign({folder}) { writeFileSync(folder + "/started", "fake"); while (true) {} }');
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let retained = false;
  const pending = h.inspect(h.input, { preserveLock: () => { retained = true; } });
  const observed = assert.rejects(pending, /validation unavailable/);
  while (!existsSync(h.started)) await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(validationLimit); await observed; assert.equal(retained, false);
});

test("worker missing/throwing native validator errors are sanitized and settled", { timeout: 15000 }, async (t) => {
  let retained = false;
  const missing = await fakeNative(t, 'export const syntheticMissingApi = true;');
  await assert.rejects(missing.inspect(missing.input, { preserveLock: () => { retained = true; } }), /validation unavailable/);
  const h = await fakeNative(t, 'export function validateCampaign() { console.error("synthetic-private-value"); throw new Error("synthetic-private-value"); }');
  await assert.rejects(h.inspect(h.input), (error) => !error.message.includes("synthetic-private-value"));
  assert.equal(retained, false);
});

for (const member of ["cloud-validation-worker.mjs", "isolated/campaign-verify.mjs"]) {
  test(`approved native snapshot never executes replaced ${member}`, { timeout: 15000 }, async (t) => {
    const h = await fakeNative(t, 'export function validateCampaign() { return { approved: true }; }');
    const marker = join(h.input.folder, "unapproved-executed");
    writeFileSync(join(h.input.folder, member), `import {writeFileSync} from "node:fs";
      writeFileSync(${JSON.stringify(marker)}, "unapproved");
      ${member === "cloud-validation-worker.mjs"
        ? 'import {parentPort} from "node:worker_threads"; parentPort.postMessage({ok:true,report:{approved:true}});'
        : 'export function validateCampaign() { return { approved: true }; }'}`);
    assert.deepEqual(await h.inspect(h.input), { approved: true });
    assert.equal(existsSync(marker), false, "mutable disk code executed after approval");
  });
}

test("same-read snapshot survives replacement after capture and before real Worker construction", { timeout: 15000 }, async (t) => {
  const h = await fakeNative(t, 'import ts from "typescript"; export function validateCampaign() { return { synthetic: true, typescript: ts.version }; }');
  const snapshot = captureFixture(h.input.commit, { root: h.repo });
  const marker = join(h.input.folder, "post-capture-marker");
  for (const path of ["cloud-validation-worker.mjs", "isolated/campaign-verify.mjs"])
    writeFileSync(join(h.input.folder, path), `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "unapproved");`);
  removeDependencyLink(h.repo);
  mkdirSync(dirname(join(h.repo, typescriptPath)), { recursive: true });
  writeFileSync(join(h.repo, typescriptPath), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unapproved dependency"); module.exports = {version:"forged"};`);
  assert.deepEqual(await validationTask(h.input, { snapshot }).result, { synthetic: true, typescript: "6.0.3" });
  assert.equal(existsSync(marker), false);
});

/**
 * Runs `run` with GIT_DIR and GIT_WORK_TREE in process.env naming a scratch caller with a commit of its
 * own, as a container that mounts a linked worktree names one, then asserts that caller is unchanged.
 * A fixture read that inherited them would read the caller's HEAD rather than the fixture's.
 * @param {import("node:test").TestContext} t @param {() => Promise<void>} run
 */
async function underScratchCaller(t, run) {
  const { temp } = harness(t), caller = join(temp, "caller"), elsewhere = join(temp, "caller-worktree");
  mkdirSync(caller); mkdirSync(elsewhere);
  git(caller, "init", "-q"); writeFileSync(join(caller, "caller.txt"), "caller\n"); git(caller, "add", "caller.txt");
  git(caller, "-c", "user.name=Caller", "-c", "user.email=caller@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "caller");
  const state = () => [readFileSync(join(caller, ".git", "config"), "utf8"), git(caller, "for-each-ref"), git(caller, "status", "--porcelain")];
  const before = state(), saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  Object.assign(process.env, { GIT_DIR: join(caller, ".git"), GIT_WORK_TREE: elsewhere });
  try { await run(); } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
  assert.deepEqual(state(), before, "the caller's config, refs and work tree are unchanged");
}

test("a fixture's native snapshot, capture and inspection read the fixture under a caller's GIT_DIR and GIT_WORK_TREE", { timeout: 30000 }, async (t) => {
  await underScratchCaller(t, async () => {
    const h = await fakeNative(t, 'import ts from "typescript"; export function validateCampaign() { return { typescript: ts.version }; }');
    const snapshot = captureFixture(h.input.commit, { root: h.repo });
    assert.equal(snapshot.sources.find((row) => row.path === "bench/workloads/isolated/campaign-verify.mjs")?.sha256,
      createHash("sha256").update(readFileSync(join(h.input.folder, "isolated/campaign-verify.mjs"))).digest("hex"));
    assert.deepEqual(await h.inspect(h.input), { typescript: "6.0.3" });
  });
});

test("pinned semver CommonJS graph evaluates captured extensionless dependencies", { timeout: 15000 }, async (t) => {
  const h = await fakeNative(t, `import semver from "../../../node_modules/semver/index.js";
    export function validateCampaign() { return {
      stable: semver.satisfies("3.5.28", "^3.5.0"),
      prerelease: semver.satisfies("3.5.28-rc.1", "^3.5.0"),
      override: semver.satisfies("0.28.2", "^0.27.1"),
      union: semver.satisfies("7.8.6", "^6 || >=7.8.0 <8"),
    }; }`);
  assert.deepEqual(await h.inspect(h.input), { stable: true, prerelease: false, override: false, union: true });
});

function semverSnapshot(t, edit = () => {}) {
  const h = harness(t), commit = "a".repeat(40);
  linkClassicCompiler(h.repo);
  mkdirSync(join(h.repo, "node_modules"));
  cpSync(join(checkout, "node_modules/semver"), join(h.repo, "node_modules/semver"), { recursive: true });
  const marker = join(h.repo, "unapproved-semver");
  const manifest = { devDependencies: { semver: "7.8.6" } };
  const lock = { packages: { "": structuredClone(manifest), "node_modules/semver": { version: "7.8.6", integrity: semverIntegrity,
    resolved: "https://registry.npmjs.org/semver/-/semver-7.8.6.tgz" } } };
  const source = `import semver from "../../../node_modules/semver/index.js";
    export function validateCampaign() { return { stable: semver.satisfies("3.5.28", "^3.5.0"),
      prerelease: semver.satisfies("3.5.28-rc.1", "^3.5.0"), override: semver.satisfies("0.28.2", "^0.27.1") }; }`;
  const metadata = { "package.json": manifest, "package-lock.json": lock, ...benchFiles() };
  edit({ manifest, lock, metadata, repo: h.repo });
  const paths = [...validationPaths, "package.json", "package-lock.json", ...benchMetadata];
  const objects = paths.map((path) => {
    // An edit that deletes a metadata file gets Git's batch answer for an absent object.
    if (path in metadata && metadata[path] === undefined) return Buffer.from(`${commit}:${path} missing\n`);
    const bytes = Buffer.from(path in metadata ? JSON.stringify(metadata[path])
      : path.endsWith("/isolated/campaign-verify.mjs") ? source : readFileSync(join(checkout, path)));
    return Buffer.concat([Buffer.from(`${createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")} blob ${bytes.length}\n`), bytes, Buffer.from("\n")]);
  });
  // Trusted Git seam only, not evidence-selected code. Existing controls above
  // exercise real Git; these isolate package capture and the actual worker.
  const capture = () => captureValidation(commit, { root: h.repo, readGit(command, args, options) {
    assert.equal(command, "git"); assert.equal(args[0], "--no-replace-objects");
    if (args.includes("rev-parse")) return { status: 0, stdout: commit + "\n" };
    assert.equal(options.input, paths.map((path) => `${commit}:${path}\n`).join(""));
    return { status: 0, stdout: Buffer.concat(objects) };
  } });
  return { ...h, marker, capture, input: { round: "r21", commit, folder: h.repo } };
}

test("semver snapshot pins same-read library bytes before actual worker execution", { timeout: 15000 }, async (t) => {
  const h = semverSnapshot(t), snapshot = h.capture();
  assert.equal(snapshot.sources.length, validationPaths.length + Object.keys(semverSources).length + 1);
  assert.equal(Object.keys(semverSources).length, 48);
  for (const path of ["index.js", "classes/range.js", "internal/re.js"])
    writeFileSync(join(h.repo, "node_modules/semver", path), `require("node:fs").writeFileSync(${JSON.stringify(h.marker)}, "unapproved");`);
  const task = validationTask(h.input, { snapshot });
  assert.deepEqual(await task.result, { stable: true, prerelease: false, override: false });
  assert.equal(existsSync(h.marker), false);
  assert.throws(h.capture, /validation unavailable/);
});

test("only named replay dependencies extend the worker source budget", { timeout: 15000 }, async (t) => {
  const paths = validationPaths.filter((path) => path === "bench/catalog/cgroup.mjs" || path === "bench/typescript.mjs" || path === "bench/fullstack/edge.mjs"
    || path === "bench/fullstack-browser/document-navigation.mjs"
    || path === "bench/json-api/load-resource-proof.mjs" || path === "bench/json-api/placement.mjs"
    || path === "bench/workloads/isolated/native-roles.mjs" || /^bench\/hardening\/(?:bounded-requests\.mjs$|dependency-recovery-)/.test(path));
  assert.deepEqual(paths, [
    "bench/catalog/cgroup.mjs",
    "bench/fullstack-browser/document-navigation.mjs",
    "bench/fullstack/edge.mjs",
    "bench/hardening/bounded-requests.mjs",
    "bench/hardening/dependency-recovery-capture.mjs",
    "bench/hardening/dependency-recovery-contract.mjs",
    "bench/json-api/load-resource-proof.mjs",
    "bench/json-api/placement.mjs",
    "bench/typescript.mjs",
    "bench/workloads/isolated/native-roles.mjs",
  ]);
  const h = semverSnapshot(t), snapshot = h.capture();
  assert.equal(snapshot.sources.length - paths.length, 211);
  const task = validationTask(h.input, { snapshot, WorkerClass: class extends Worker {
    constructor(entry, options) {
      // Inject below the exact parent manifest check to exercise the worker's own bound. The
      // fixture never imports the JSON proof, so only its named slot, not a generic extra
      // one, keeps an unused path in its place from fitting.
      options.workerData.sources = options.workerData.sources.map((row) =>
        row.path === "bench/json-api/load-resource-proof.mjs" ? { ...row, path: "bench/hardening/unlisted-control.mjs" } : row);
      super(entry, options);
    }
  } });
  await assert.rejects(task.result, /validation unavailable/);
});

test("semver snapshot rejects unpinned dependency declarations and absent captured members", { timeout: 15000 }, async (t) => {
  for (const edit of [({ manifest }) => { manifest.devDependencies.semver = "^7.8.6"; },
    ({ lock }) => { lock.packages[""].devDependencies.semver = "7.8.5"; },
    ({ lock }) => { lock.packages["node_modules/semver"].integrity = "sha512-forged"; },
    ({ lock }) => { lock.packages["node_modules/semver"].dependencies = { unapproved: "*" }; }]) {
    const h = semverSnapshot(t, edit); assert.throws(h.capture, /validation unavailable/);
  }
  const h = semverSnapshot(t), snapshot = h.capture();
  snapshot.sources = snapshot.sources.filter((row) => row.path !== "node_modules/semver/internal/re.js");
  assert.throws(() => validationTask(h.input, { snapshot }), /validation unavailable/);
});

// The pinned compiler bytes alone are not enough: the measured commit's bench manifest and
// lock must declare and pin exactly that package, as the root's do for semver.
const benchMetadataEdits = [
  ["missing bench manifest", (files) => { files["bench/package.json"] = undefined; }],
  ["missing bench lock", (files) => { files["bench/package-lock.json"] = undefined; }],
  ["manifest range", (files) => { files["bench/package.json"].devDependencies.typescript = "^6.0.3"; }],
  ["manifest without TypeScript", (files) => { delete files["bench/package.json"].devDependencies.typescript; }],
  ["lock root declaration", (files) => { files["bench/package-lock.json"].packages[""].devDependencies.typescript = "6.0.2"; }],
  ["lock version", (files) => { files["bench/package-lock.json"].packages["node_modules/typescript"].version = "6.0.2"; }],
  ["lock integrity", (files) => { files["bench/package-lock.json"].packages["node_modules/typescript"].integrity = semverIntegrity; }],
  ["lock resolved", (files) => { files["bench/package-lock.json"].packages["node_modules/typescript"].resolved = "https://registry.npmjs.org/typescript/-/typescript-7.0.2.tgz"; }],
  ["lock without TypeScript", (files) => { delete files["bench/package-lock.json"].packages["node_modules/typescript"]; }],
];

test("bench metadata pins the captured compiler; missing or divergent metadata fails with the correct bytes installed", { timeout: 15000 }, async (t) => {
  const pinned = semverSnapshot(t);
  assert.equal(localCompiler(pinned.repo), true, "the correct pinned compiler is installed for every variant");
  assert.equal(pinned.capture().sources.find((row) => row.path === typescriptPath).sha256, createHash("sha256").update(readFileSync(join(classicCompiler, "lib/typescript.js"))).digest("hex"));
  for (const [name, change] of benchMetadataEdits) {
    const h = semverSnapshot(t, ({ metadata }) => change(metadata));
    assert.equal(localCompiler(h.repo), true, name);
    assert.throws(h.capture, { message: "native campaign validation unavailable or invalid; evidence/host preserved" }, name);
  }
});

test("real Git capture refuses a commit whose bench metadata is missing or divergent", { timeout: 30000 }, async (t) => {
  for (const [name, change] of [benchMetadataEdits[0], benchMetadataEdits[1], benchMetadataEdits[6]]) {
    const h = await fakeNative(t, 'export function validateCampaign() { return { synthetic: true }; }', { bench: (files) => {
      change(files);
      for (const path of benchMetadata) if (files[path] === undefined) delete files[path];
    } });
    assert.equal(localCompiler(h.repo), true, name);
    await assert.rejects(h.inspect(h.input), { message: "native campaign validation unavailable or invalid; evidence/host preserved" }, name);
    assert.throws(() => captureFixture(h.input.commit, { root: h.repo }), /validation unavailable/, name);
  }
});

test("the local bench compiler check accepts only the pinned bytes at the bench path", (t) => {
  const h = harness(t), root7 = realpathSync(join(checkout, "node_modules/typescript"));
  const unlink = (link) => { assert.ok(lstatSync(link).isSymbolicLink()); if (process.platform === "win32") rmdirSync(link); else unlinkSync(link); };
  assert.equal(localCompiler(h.repo), false, "nothing installed");
  mkdirSync(join(h.repo, "node_modules"));
  symlinkSync(root7, join(h.repo, "node_modules/typescript"), "junction");
  assert.equal(localCompiler(h.repo), false, "root 7.0.2 only");
  mkdirSync(join(h.repo, "bench/node_modules"), { recursive: true });
  symlinkSync(root7, join(h.repo, "bench/node_modules/typescript"), "junction");
  assert.equal(localCompiler(h.repo), false, "root compiler at the bench path");
  unlink(join(h.repo, "bench/node_modules/typescript"));
  linkClassicCompiler(h.repo);
  assert.equal(localCompiler(h.repo), true, "pinned bench install");
  removeDependencyLink(h.repo); unlink(join(h.repo, "node_modules/typescript"));
});

test("semver snapshot never falls back to an unlisted package file", { timeout: 15000 }, async (t) => {
  const h = semverSnapshot(t), snapshot = h.capture();
  const row = snapshot.sources.find((row) => row.path.endsWith("/isolated/campaign-verify.mjs"));
  row.source = 'export async function validateCampaign() { await import("../../../node_modules/semver/unlisted.js"); return { forged: true }; }';
  row.sha256 = createHash("sha256").update(row.source).digest("hex");
  writeFileSync(join(h.repo, "node_modules/semver/unlisted.js"), `require("node:fs").writeFileSync(${JSON.stringify(h.marker)}, "unapproved");`);
  await assert.rejects(validationTask(h.input, { snapshot }).result, /validation unavailable/);
  assert.equal(existsSync(h.marker), false);
});

test("unlisted project and package imports never evaluate mutable code", { timeout: 15000 }, async (t) => {
  const h = await fakeNative(t, `export async function validateCampaign({folder}) {
    await import(folder + "/unlisted.mjs"); return { forged: true };
  }`);
  const marker = join(h.input.folder, "unlisted-marker");
  writeFileSync(join(h.input.folder, "unlisted.mjs"), `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "unapproved");`);
  await assert.rejects(h.inspect(h.input), { message: "native campaign validation unavailable or invalid; evidence/host preserved" });
  assert.equal(existsSync(marker), false);
  const snapshot = captureFixture(h.input.commit, { root: h.repo });
  const row = snapshot.sources.find((row) => row.path.endsWith("isolated/campaign-verify.mjs"));
  // Trusted caller-only seam, never saved JSON. Exercise the identical loader's
  // package fallback denial without installing or executing that package.
  row.source = 'export async function validateCampaign() { return import("unlisted-package"); }';
  row.sha256 = createHash("sha256").update(row.source).digest("hex");
  await assert.rejects(validationTask(h.input, { snapshot }).result, /validation unavailable/);
});

test("evidence commit cannot select historical code; absent closure and changed dependency fail closed", { timeout: 15000 }, async (t) => {
  const h = await fakeNative(t, 'export function validateCampaign() { return { synthetic: true }; }');
  await assert.rejects(h.inspect({ ...h.input, commit: "a".repeat(40) }), { message: "native campaign validation unavailable or invalid; evidence/host preserved" });
  git(h.repo, "rm", "--", validationPaths[0]);
  git(h.repo, "-c", "user.name=Synthetic test", "-c", "user.email=synthetic@example.invalid", "-c", "core.hooksPath=", "commit", "-qm", "Missing closure");
  assert.throws(() => captureFixture(git(h.repo, "rev-parse", "HEAD"), { root: h.repo }), /validation unavailable/);
  // Remove only our junction, nonrecursively; never alter the shared install.
  removeDependencyLink(h.repo);
  mkdirSync(dirname(join(h.repo, typescriptPath)), { recursive: true });
  writeFileSync(join(h.repo, typescriptPath), 'throw new Error("private dependency marker");');
  // Existing module captured its original commit. That graph still exists and
  // package pin failure is independent of the missing current HEAD member.
  await assert.rejects(h.inspect(h.input), { message: "native campaign validation unavailable or invalid; evidence/host preserved" });
});

test("native replay timeout has a fixed stage and retains custody if the worker does not settle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let stops = 0, retains = 0, unreferences = 0;
  const pending = inspectCampaign({}, { start: () => ({
    result: new Promise(() => {}), stop: () => stops++, unref: () => unreferences++,
  }), preserveLock: () => retains++ });
  const rejected = assert.rejects(pending, {
    message: "native campaign validation unavailable or invalid; evidence/host preserved",
    controllerStage: "collect-native-replay-deadline",
  });
  t.mock.timers.tick(validationLimit + 1);
  assert.equal(stops, 1);
  assert.equal(retains, 0);
  t.mock.timers.tick(validationStopLimit);
  await rejected;
  assert.equal(retains, 1);
  assert.equal(unreferences, 1);
});

test("replay after confirmed host absence is still bounded, but permits 25 minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let stops = 0;
  const pending = inspectCampaign({}, { confirmedAbsent: true, start: () => ({
    result: new Promise(() => {}), stop: () => stops++,
  }) });
  const rejected = assert.rejects(pending, { controllerStage: "collect-native-replay-deadline" });
  t.mock.timers.tick(validationLimit + 1);
  assert.equal(stops, 0);
  t.mock.timers.tick(25 * 60_000 - validationLimit);
  assert.equal(stops, 1);
  t.mock.timers.tick(validationStopLimit);
  await rejected;
});

test("native replay startup, interruption and worker refusal have closed stages", async () => {
  const raw = Object.assign(new Error("PRIVATE_EVIDENCE_VALUE"), { controllerStage: "collect-native-replay-deadline" });
  const message = "native campaign validation unavailable or invalid; evidence/host preserved";
  await assert.rejects(inspectCampaign({}, { start: () => { throw raw; } }),
    { message, controllerStage: "collect-native-replay-start" });
  await assert.rejects(inspectCampaign({}, { start: () => ({ result: Promise.reject(raw) }) }),
    { message, controllerStage: "collect-native-replay-refused" });
  let started = false;
  await assert.rejects(inspectCampaign({}, { interrupted: () => true, start: () => { started = true; } }),
    { message, controllerStage: "collect-native-replay-interrupted" });
  assert.equal(started, false);
});

test("cancellation retains the lock if stopping a real-worker adapter is unconfirmed", { timeout: 15000 }, async (t) => {
  const h = await fakeNative(t, 'export function validateCampaign() { return {}; }', { unconfirmed: true });
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let cancelled = false, retained = 0;
  const pending = h.inspect(h.input, { interrupted: () => cancelled, preserveLock: () => retained++ });
  const rejected = assert.rejects(pending, { message: "native campaign validation unavailable or invalid; evidence/host preserved" });
  cancelled = true; t.mock.timers.tick(25);
  assert.equal(existsSync(join(h.input.folder, "stop-requested")), true);
  assert.equal(retained, 0);
  t.mock.timers.tick(validationStopLimit); await rejected;
  assert.equal(retained, 1);
  assert.equal(existsSync(join(h.input.folder, "unreferenced")), true);
});

test("nested native worker stays captured when outer snapshot hooks cannot be inherited", { timeout: 15000 }, async (t) => {
  const h = await fakeNative(t, 'export function validateCampaign() { return { syntheticNested: true }; }');
  const modules = ["cloud-validation.mjs", "cloud-validation-snapshot.mjs"].map((name) =>
    [pathToFileURL(join(h.input.folder, name)).href, readFileSync(join(h.input.folder, name), "utf8")]);
  const marker = join(h.input.folder, "nested-unapproved");
  for (const name of ["cloud-validation-worker.mjs", "isolated/campaign-verify.mjs"])
    writeFileSync(join(h.input.folder, name), `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "unapproved");`);
  // Real outer worker, exactly the relevant fleet isolation boundary: only its
  // two controller imports are hooked. Native code is deliberately NOT supplied
  // to this loader; nested validation must enforce its own approved snapshot.
  const bootstrap = `import {registerHooks,isBuiltin} from "node:module";
    import {parentPort,workerData} from "node:worker_threads";
    const modules = new Map(workerData.modules);
    registerHooks({resolve(s,c,next){if(isBuiltin(s))return next(s,c);const url=new URL(s,c.parentURL).href;
      if(!modules.has(url))throw Error("unlisted");return {url,shortCircuit:true};},
      load(url,c,next){if(isBuiltin(url))return next(url,c);if(!modules.has(url))throw Error("unlisted");
      return {format:"module",source:modules.get(url),shortCircuit:true};}});
    try { const {inspectCampaign}=await import(workerData.modules[0][0]);
      parentPort.postMessage({report:await inspectCampaign(workerData.input)});
    } catch {parentPort.postMessage({error:"synthetic-nested-failure"});} parentPort.close();`;
  const outer = new Worker(new URL("data:text/javascript;base64," + Buffer.from(bootstrap).toString("base64")), {
    workerData: { modules, input: h.input }, execArgv: [], stdout: true, stderr: true,
  });
  outer.stdout.resume(); outer.stderr.resume();
  let message; outer.once("message", (value) => { message = value; });
  await new Promise((resolve, reject) => { outer.once("error", reject); outer.once("exit", (code) => code === 0 ? resolve() : reject(new Error("synthetic outer worker failed"))); });
  assert.deepEqual(message, { report: { syntheticNested: true } });
  assert.equal(existsSync(marker), false);
});

test("isolated hardening adapter replays the captured edge configuration without loading the checkout", { timeout: 15000 }, async (t) => {
  const h = await fakeNative(t, `import { inspectSaved } from "./adapters/hardening.mjs";
    import { proxyConfig } from "../../hardening/evidence.mjs";
    export function validateCampaign() { return { adapter: typeof inspectSaved, config: proxyConfig() }; }`, { realGraph: true });
  const snapshot = captureFixture(h.input.commit, { root: h.repo });
  const edge = "bench/fullstack/edge.mjs";
  writeFileSync(join(h.repo, edge), 'throw new Error("must not load replaced checkout");');
  const { nginxConf, edgeOffset } = await import("../fullstack/edge.mjs");
  assert.deepEqual(await validationTask(h.input, { snapshot }).result,
    { adapter: "function", config: nginxConf([["target", { port: 8080 - edgeOffset, publicAuthority: "localhost:8080" }]], 1) });
});

test("complete fixed native graph and pinned TypeScript evaluate captured bytes without package loaders", { timeout: 15000 }, async (t) => {
  const paths = validationPaths.filter((path) => !path.endsWith("cloud-validation-worker.mjs") && !path.endsWith("isolated/campaign-verify.mjs"));
  const source = `export async function validateCampaign() {
      let ts; try { ts = (await import("typescript")).default; } catch { return { blockedAt: "typescript" }; }
      for (const [index, path] of ${JSON.stringify(paths)}.entries()) {
        try { await import(new URL("../../../" + path, import.meta.url)); } catch { return { blockedAt: index }; }
      }
      const ast = ts.createSourceFile("synthetic.js", "const value = 1;", ts.ScriptTarget.Latest, true);
      return { evidenceMode: "synthetic-import-control", modules: ${paths.length}, typescript: ts.version, statements: ast.statements.length };
    }`;
  const h = await fakeNative(t, source, { realGraph: true });
  assert.deepEqual(await h.inspect(h.input), { evidenceMode: "synthetic-import-control", modules: paths.length, typescript: "6.0.3", statements: 1 });
});

test("catalog timed replay uses exact captured source and missing or changed closure stays blocked", { timeout: 15000 }, async (t) => {
  const path = "bench/catalog/timed.mjs";
  assert.equal(validationPaths.filter((p) => p === path).length, 1);
  assert.equal(validationPaths.includes("bench/catalog/load-outcome.js"), false, "k6-only producer code is not a native replay dependency");
  const h = await fakeNative(t, `import {timedRawSchema} from "../../catalog/timed.mjs";
    export function validateCampaign() { return { schema: timedRawSchema }; }`, { realGraph: true });
  const snapshot = captureFixture(h.input.commit, { root: h.repo }), row = snapshot.sources.find((row) => row.path === path);
  assert.equal(row.source, readFileSync(join(checkout, path), "utf8").replaceAll("\r\n", "\n"));
  assert.equal(row.sha256, createHash("sha256").update(row.source).digest("hex"));
  const marker = join(h.input.folder, "unapproved-timed");
  writeFileSync(join(h.repo, path), `import {writeFileSync} from "node:fs";
    writeFileSync(${JSON.stringify(marker)}, "unapproved"); export const timedRawSchema = "forged";`);
  assert.deepEqual(await h.inspect(h.input), { schema: "catalog-saved-evidence/v3" });
  assert.equal(existsSync(marker), false);
  const missing = { ...snapshot, sources: snapshot.sources.filter((row) => row.path !== path) };
  assert.throws(() => validationTask(h.input, { snapshot: missing }), /validation unavailable/);
  const changed = structuredClone(snapshot); changed.sources.find((row) => row.path === path).source += "\n// changed bytes\n";
  assert.throws(() => validationTask(h.input, { snapshot: changed }), /validation unavailable/);
  git(h.repo, "rm", "--cached", "--", path);
  git(h.repo, "-c", "user.name=Synthetic test", "-c", "user.email=synthetic@example.invalid", "-c", "core.hooksPath=", "commit", "-qm", "Missing timed replay source");
  assert.throws(() => captureFixture(git(h.repo, "rev-parse", "HEAD"), { root: h.repo }), /validation unavailable/);
});

test("unchanged native campaign API evaluates captured real sources and rejects an empty archive", { timeout: 15000 }, async (t) => {
  const h = await fakeNative(t, undefined, { realGraph: true });
  assert.deepEqual(await h.inspect(h.input), {
    status: "invalid", controllerReady: false, qualified: false, deletionAuthorized: false, error: "saved-campaign-invalid",
  });
});

test("browser saved replay imports only the committed document-navigation helper in the sealed worker", { timeout: 15000 }, async (t) => {
  const path = "bench/fullstack-browser/document-navigation.mjs";
  const h = await fakeNative(t, `import {validateSaved} from "../../fullstack-browser/verify.mjs";
    export async function validateCampaign(input) {
      const r = await validateSaved(input);
      return { outcome: r.outcome, diagnostics: r.invalid.length };
    }`, { realGraph: true });
  const snapshot = captureFixture(h.input.commit, { root: h.repo });
  const marker = join(h.input.folder, "unapproved-browser-navigation");
  writeFileSync(join(h.repo, path), `import {writeFileSync} from "node:fs";
    writeFileSync(${JSON.stringify(marker)}, "unapproved"); export function replayDocumentNavigation() {} export function cleanupObserved() {}`);
  const good = await h.inspect(h.input);
  assert.deepEqual(good, { outcome: "invalid", diagnostics: 1 });
  const task = validationTask(h.input, { snapshot, WorkerClass: class extends Worker {
    constructor(entry, options) {
      options.workerData.sources = options.workerData.sources.filter((row) => row.path !== path);
      super(entry, options);
    }
  } });
  await assert.rejects(task.result, /validation unavailable/);
  assert.equal(existsSync(marker), false);
});

test("native replay uses captured observer writer bytes rather than a replaced checkout module", { timeout: 15000 }, async (t) => {
  const h = await fakeNative(t, undefined, { realGraph: true });
  const marker = join(h.input.folder, "unapproved-writer");
  writeFileSync(join(h.repo, "bench/workloads/isolated/host-durable-writer.mjs"),
    `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "unapproved");`);
  assert.deepEqual(await h.inspect(h.input), {
    status: "invalid", controllerReady: false, qualified: false, deletionAuthorized: false, error: "saved-campaign-invalid",
  });
  assert.equal(existsSync(marker), false);
});

test("a complete campaign replay can finish after three minutes of evidence checks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let finish;
  const report = { status: "verified" };
  const result = inspectCampaign({}, { inspect: () => new Promise((resolve) => { finish = resolve; }) });
  t.mock.timers.tick(180_001);
  finish(report);
  assert.equal(await result, report);
});

test("a settled result arriving after the deadline cannot win against an overdue timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = 0, retained = false, finish;
  t.mock.method(performance, "now", () => now);
  const result = inspectCampaign({}, {
    inspect: () => new Promise((resolve) => { finish = resolve; }),
    preserveLock: () => { retained = true; },
  });
  now = validationLimit + 1; // Wall time elapsed, but the event loop has not run the timer.
  finish({ status: "verified" });
  await assert.rejects(result, /validation unavailable/);
  assert.equal(retained, false, "a settled worker does not leave an uncertain lock");
});

test("snapshot setup consumes the existing validation deadline rather than extending it", { timeout: 5000 }, async (t) => {
  const clock = t.mock.method(performance, "now");
  clock.mock.mockImplementationOnce(() => 0, 0);
  clock.mock.mockImplementationOnce(() => validationLimit - 10, 1);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let retained = false;
  const result = inspectCampaign({}, { inspect: () => new Promise(() => {}), preserveLock: () => { retained = true; } });
  const rejected = assert.rejects(result, /validation unavailable/);
  t.mock.timers.tick(9); assert.equal(retained, false);
  t.mock.timers.tick(1); await rejected; assert.equal(retained, true);
});

test("fixed Git reads forbid promisor lazy fetch and replacement even under inherited overrides", { timeout: 15000 }, async (t) => {
  const h = await fakeNative(t, 'export function validateCampaign() { return {}; }');
  const previous = process.env.GIT_NO_LAZY_FETCH;
  process.env.GIT_NO_LAZY_FETCH = "0";
  const seen = [];
  try {
    const snapshot = captureFixture(h.input.commit, { root: h.repo, readGit(command, args, options) {
      assert.equal(command, "git"); assert.equal(args[0], "--no-replace-objects");
      assert.equal(options.env.GIT_NO_LAZY_FETCH, "1"); assert.equal(options.env.GIT_NO_REPLACE_OBJECTS, "1");
      assert.equal(options.env.GIT_TERMINAL_PROMPT, "0"); assert.equal(options.shell, false); assert.equal(options.timeout, 5000);
      seen.push(args[3]); return spawnSync(command, args, options);
    } });
    const task = validationTask(h.input, { snapshot, WorkerClass: class extends Worker {
      constructor(entry, options) {
        assert.equal(options.env.GIT_NO_LAZY_FETCH, "1"); assert.equal(options.env.GIT_NO_REPLACE_OBJECTS, "1");
        assert.equal(options.env.GIT_TERMINAL_PROMPT, "0"); assert.equal(options.env.NODE_OPTIONS, ""); assert.equal(options.env.NODE_PATH, "");
        super(entry, options);
      }
    } });
    assert.deepEqual(await task.result, {});
  } finally {
    if (previous === undefined) delete process.env.GIT_NO_LAZY_FETCH;
    else process.env.GIT_NO_LAZY_FETCH = previous;
  }
  assert.deepEqual(seen, ["rev-parse", "cat-file"]);
});
