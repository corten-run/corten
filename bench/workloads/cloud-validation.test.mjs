import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { harness } from "./cloud-fixtures.mjs";
import { inspectCampaign, validationLimit, validationStopLimit } from "./cloud-validation.mjs";
import { captureValidation, validationPaths, validationTask, typescriptPath } from "./cloud-validation-snapshot.mjs";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 5000, windowsHide: true });
  assert.equal(result.status, 0, "synthetic local Git operation failed"); return result.stdout.trim();
}
const sharedDependencies = resolve(checkout, git(checkout, "rev-parse", "--git-common-dir"), "..", "node_modules");
function removeDependencyLink(repo) {
  const link = join(repo, "node_modules");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(realpathSync(link), realpathSync(sharedDependencies));
  if (process.platform === "win32") rmdirSync(link);
  else unlinkSync(link);
}

async function fakeNative(t, source, { realGraph = false, unconfirmed = false } = {}) {
  const h = harness(t), repo = join(h.temp, "validator"), root = join(repo, "bench/workloads");
  for (const path of validationPaths) {
    const target = join(repo, path); mkdirSync(dirname(target), { recursive: true });
    if (realGraph) copyFileSync(join(checkout, path), target);
    else writeFileSync(target, "export {};\n");
  }
  for (const name of ["cloud-validation.mjs", "cloud-validation-worker.mjs", "cloud-validation-snapshot.mjs"])
    copyFileSync(new URL(name, import.meta.url), join(root, name));
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
  // Synthetic committed modules, never benchmarks. Reuse the main install only.
  symlinkSync(realpathSync(sharedDependencies), join(repo, "node_modules"), "junction");
  if (source !== undefined) writeFileSync(join(root, "isolated/campaign-verify.mjs"), source);
  git(repo, "init", "--initial-branch=main");
  git(repo, "add", "--", ...validationPaths, "bench/workloads/cloud-validation.mjs", "bench/workloads/cloud-validation-snapshot.mjs");
  git(repo, "-c", "user.name=Synthetic validation test", "-c", "user.email=synthetic@example.invalid", "-c", "core.hooksPath=", "commit", "-qm", "Synthetic validation fixture");
  const approvedCommit = git(repo, "rev-parse", "HEAD");
  const native = await import(pathToFileURL(join(root, "cloud-validation.mjs")));
  return { ...h, repo, inspect: native.inspectCampaign, input: { folder: root, round: "r21", commit: approvedCommit }, started: join(root, "started") };
}

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
  const snapshot = captureValidation(h.input.commit, { root: h.repo });
  const marker = join(h.input.folder, "post-capture-marker");
  for (const path of ["cloud-validation-worker.mjs", "isolated/campaign-verify.mjs"])
    writeFileSync(join(h.input.folder, path), `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "unapproved");`);
  removeDependencyLink(h.repo);
  mkdirSync(dirname(join(h.repo, typescriptPath)), { recursive: true });
  writeFileSync(join(h.repo, typescriptPath), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unapproved dependency"); module.exports = {version:"forged"};`);
  assert.deepEqual(await validationTask(h.input, { snapshot }).result, { synthetic: true, typescript: "5.9.3" });
  assert.equal(existsSync(marker), false);
});

test("unlisted project and package imports never evaluate mutable code", { timeout: 15000 }, async (t) => {
  const h = await fakeNative(t, `export async function validateCampaign({folder}) {
    await import(folder + "/unlisted.mjs"); return { forged: true };
  }`);
  const marker = join(h.input.folder, "unlisted-marker");
  writeFileSync(join(h.input.folder, "unlisted.mjs"), `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "unapproved");`);
  await assert.rejects(h.inspect(h.input), { message: "native campaign validation unavailable or invalid; evidence/host preserved" });
  assert.equal(existsSync(marker), false);
  const snapshot = captureValidation(h.input.commit, { root: h.repo });
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
  assert.throws(() => captureValidation(git(h.repo, "rev-parse", "HEAD"), { root: h.repo }), /validation unavailable/);
  // Remove only our junction, nonrecursively; never alter the shared install.
  removeDependencyLink(h.repo);
  mkdirSync(dirname(join(h.repo, typescriptPath)), { recursive: true });
  writeFileSync(join(h.repo, typescriptPath), 'throw new Error("private dependency marker");');
  // Existing module captured its original commit. That graph still exists and
  // package pin failure is independent of the missing current HEAD member.
  await assert.rejects(h.inspect(h.input), { message: "native campaign validation unavailable or invalid; evidence/host preserved" });
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
  assert.deepEqual(await h.inspect(h.input), { evidenceMode: "synthetic-import-control", modules: paths.length, typescript: "5.9.3", statements: 1 });
});

test("unchanged native campaign API evaluates captured real sources and rejects an empty archive", { timeout: 15000 }, async (t) => {
  const h = await fakeNative(t, undefined, { realGraph: true });
  assert.deepEqual(await h.inspect(h.input), {
    status: "invalid", controllerReady: false, qualified: false, deletionAuthorized: false, error: "saved-campaign-invalid",
  });
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
    const snapshot = captureValidation(h.input.commit, { root: h.repo, readGit(command, args, options) {
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
