// Fixed read-only replay closure. No evidence/CLI value selects executable paths.
// Update deliberately when the native import graph changes; unknown imports fail closed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

export const validationPaths = Object.freeze([
  "bench/catalog/check.mjs",
  "bench/catalog/contract.mjs",
  "bench/catalog/droplet-contract.mjs",
  "bench/catalog/fixtures.mjs",
  "bench/catalog/group.mjs",
  "bench/catalog/raw.mjs",
  "bench/catalog/record-attempt.mjs",
  "bench/catalog/report.mjs",
  "bench/catalog/stats.mjs",
  "bench/catalog/verify.mjs",
  "bench/client-heavy/build-replay.mjs",
  "bench/client-heavy/compiler.mjs",
  "bench/client-heavy/contract.mjs",
  "bench/client-heavy/install-layout.mjs",
  "bench/client-heavy/launch.mjs",
  "bench/client-heavy/replay-v2.mjs",
  "bench/client-heavy/verify-v2.mjs",
  "bench/client-heavy/verify.mjs",
  "bench/fullstack-browser/binding-artifact.mjs",
  "bench/fullstack-browser/binding-effects.mjs",
  "bench/fullstack-browser/binding-intrinsics.mjs",
  "bench/fullstack-browser/binding-modules.mjs",
  "bench/fullstack-browser/binding-window.mjs",
  "bench/fullstack-browser/bindings.mjs",
  "bench/fullstack-browser/cancellations.mjs",
  "bench/fullstack-browser/capture.mjs",
  "bench/fullstack-browser/contract.mjs",
  "bench/fullstack-browser/ledger.mjs",
  "bench/fullstack-browser/lifecycle.mjs",
  "bench/fullstack-browser/native-browser-dom.mjs",
  "bench/fullstack-browser/native-evidence.mjs",
  "bench/fullstack-browser/native-execution.mjs",
  "bench/fullstack-browser/native-lifetimes.mjs",
  "bench/fullstack-browser/native-responses.mjs",
  "bench/fullstack-browser/native-source.mjs",
  "bench/fullstack-browser/navigation.mjs",
  "bench/fullstack-browser/upstream.mjs",
  "bench/fullstack-browser/verify.mjs",
  "bench/fullstack/apps.mjs",
  "bench/fullstack/conformance.mjs",
  "bench/fullstack/inventory.mjs",
  "bench/fullstack/mixed.mjs",
  "bench/fullstack/passes.mjs",
  "bench/hardening/clock.mjs",
  "bench/hardening/evidence.mjs",
  "bench/hardening/lifecycle.mjs",
  "bench/hardening/native.mjs",
  "bench/hardening/plan.mjs",
  "bench/hardening/probe.mjs",
  "bench/hardening/receipts.mjs",
  "bench/hardening/verify.mjs",
  "bench/json-api/artifacts.mjs",
  "bench/json-api/contract.mjs",
  "bench/json-api/evidence.mjs",
  "bench/json-api/process.mjs",
  "bench/json-api/report.mjs",
  "bench/live/admission.mjs",
  "bench/live/apps/drogon/wire.mjs",
  "bench/live/apps/laravel/wire.mjs",
  "bench/live/apps/leptos/wire.mjs",
  "bench/live/apps/phoenix/wire.mjs",
  "bench/live/apps/rails/wire.mjs",
  "bench/live/apps/topcoat/wire.mjs",
  "bench/live/fanout.mjs",
  "bench/live/measurement.mjs",
  "bench/live/native-http.mjs",
  "bench/live/native.mjs",
  "bench/live/parity.mjs",
  "bench/live/resources.mjs",
  "bench/live/verify.mjs",
  "bench/live/wire.mjs",
  "bench/load-tool.mjs",
  "bench/marketplace/check.mjs",
  "bench/marketplace/contract.mjs",
  "bench/marketplace/droplet-contract.mjs",
  "bench/marketplace/feature-contract.mjs",
  "bench/marketplace/fixtures.mjs",
  "bench/marketplace/groups.mjs",
  "bench/marketplace/load-evidence.mjs",
  "bench/marketplace/raw-contract.mjs",
  "bench/marketplace/records.mjs",
  "bench/marketplace/reference.mjs",
  "bench/marketplace/report.mjs",
  "bench/marketplace/run-contract.mjs",
  "bench/marketplace/saved-files.mjs",
  "bench/marketplace/split.mjs",
  "bench/marketplace/validate.mjs",
  "bench/mixed-production/build-context.mjs",
  "bench/mixed-production/capture.mjs",
  "bench/mixed-production/execution-evidence.mjs",
  "bench/mixed-production/execution-inputs.mjs",
  "bench/mixed-production/immutable-git.mjs",
  "bench/mixed-production/load-capture.mjs",
  "bench/mixed-production/measure.mjs",
  "bench/mixed-production/metrics.mjs",
  "bench/mixed-production/producer-evidence.mjs",
  "bench/mixed-production/qualification-evidence.mjs",
  "bench/mixed-production/resources.mjs",
  "bench/mixed-production/response-evidence.mjs",
  "bench/mixed-production/run.mjs",
  "bench/mixed-production/snapshot.mjs",
  "bench/mixed-production/source-audit.mjs",
  "bench/mixed-production/stats.mjs",
  "bench/mixed-production/upstream-ledger.mjs",
  "bench/mixed-production/verify.mjs",
  "bench/workloads/browser.mjs",
  "bench/workloads/client.mjs",
  "bench/workloads/cloud-contract.mjs",
  "bench/workloads/cloud-validation-worker.mjs",
  "bench/workloads/deployments.mjs",
  "bench/workloads/evidence.mjs",
  "bench/workloads/hardening.mjs",
  "bench/workloads/isolated/adapters/client-heavy.mjs",
  "bench/workloads/isolated/adapters/fullstack-browser.mjs",
  "bench/workloads/isolated/adapters/hardening.mjs",
  "bench/workloads/isolated/adapters/live-delivery.mjs",
  "bench/workloads/isolated/adapters/mixed-production.mjs",
  "bench/workloads/isolated/adapters/recoverable-live.mjs",
  "bench/workloads/isolated/campaign-contract.mjs",
  "bench/workloads/isolated/campaign-journal.mjs",
  "bench/workloads/isolated/campaign-verify.mjs",
  "bench/workloads/isolated/composition.mjs",
  "bench/workloads/isolated/contract.mjs",
  "bench/workloads/isolated/evidence.mjs",
  "bench/workloads/isolated/host-lifetime.mjs",
  "bench/workloads/isolated/host-observation.mjs",
  "bench/workloads/isolated/json-staging.mjs",
  "bench/workloads/isolated/mixed-staging.mjs",
  "bench/workloads/isolated/native-replay.mjs",
  "bench/workloads/isolated/participant-executables.mjs",
  "bench/workloads/isolated/process.mjs",
  "bench/workloads/isolated/raw-support.mjs",
  "bench/workloads/isolated/worker.mjs",
  "bench/workloads/json-check.mjs",
  "bench/workloads/latest-stable.mjs",
  "bench/workloads/live.mjs",
  "bench/workloads/mixed.mjs",
  "bench/workloads/registry.mjs",
  "bench/workloads/run.mjs",
  "scripts/steady.mjs"
]);
export const typescriptPath = "node_modules/typescript/lib/typescript.js";
// typescript@5.9.3, verified against the package-lock SHA-512 npm archive.
export const typescriptSha256 = "3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675";
const checkout = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const entryPath = "bench/workloads/cloud-validation-worker.mjs";
const hash = (source) => createHash("sha256").update(source).digest("hex");
export const validationFailure = () => new Error("native campaign validation unavailable or invalid; evidence/host preserved");
const text = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const gitEnvironment = () => ({ ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" });
function head(root, readGit = spawnSync) {
  const result = readGit("git", ["--no-replace-objects", "-C", root, "rev-parse", "--verify", "HEAD^{commit}"], {
    encoding: "utf8", timeout: 5000, maxBuffer: 1024, windowsHide: true, shell: false,
    env: gitEnvironment(),
  });
  if (result.status !== 0 || result.error || !/^[a-f0-9]{40}\s*$/.test(result.stdout ?? "")) throw validationFailure();
  return result.stdout.trim();
}
// Evidence may name a source identity, never select executable code. Default
// replay accepts only this installed controller's commit, captured on import.
const installedCommit = head(checkout);

// Reading immutable Git objects, not checkout files, binds the entire executable
// closure to the already-approved measured commit, including nested worker entry.
// One process, bounded time/output, no fetch, filters, hooks or working-tree writes.
// root/readGit are trusted local test seams, never options read from evidence.
export function captureValidation(commit, { root = checkout, readGit = spawnSync } = {}) {
  try {
    assert.match(commit, /^[a-f0-9]{40}$/);
    root = realpathSync(root);
    assert.equal(commit, root === checkout ? installedCommit : head(root, readGit));
    const result = readGit("git", ["--no-replace-objects", "-C", root, "cat-file", "--batch"], {
      input: validationPaths.map((path) => `${commit}:${path}\n`).join(""),
      encoding: null, timeout: 5000, maxBuffer: 32 * 1024 * 1024,
      windowsHide: true, shell: false,
      env: gitEnvironment(),
    });
    assert.equal(result.status, 0); assert.ok(!result.error);
    let offset = 0;
    const sources = validationPaths.map((path) => {
      const end = result.stdout.indexOf(10, offset);
      assert.ok(end >= offset);
      const header = result.stdout.subarray(offset, end).toString("ascii");
      assert.match(header, /^[a-f0-9]{40} blob [0-9]+$/);
      const size = Number(header.split(" ")[2]);
      assert.ok(Number.isSafeInteger(size) && size > 0 && size <= 1024 * 1024);
      const bytes = result.stdout.subarray(end + 1, end + 1 + size);
      assert.equal(bytes.length, size); assert.equal(result.stdout[end + 1 + size], 10);
      assert.equal(createHash("sha1").update(`blob ${size}\0`).update(bytes).digest("hex"), header.split(" ")[0]);
      offset = end + size + 2;
      return { path, source: text(bytes), sha256: hash(bytes) };
    });
    assert.equal(offset, result.stdout.length);
    // Only this fixed package entry is executable. Pin same-read bytes, never
    // evaluate a package resolver/loader or trust package.json/version alone.
    const fd = openSync(realpathSync(join(root, typescriptPath)), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let bytes;
    try {
      const stat = fstatSync(fd);
      assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 16 * 1024 * 1024);
      bytes = readFileSync(fd);
    } finally { closeSync(fd); }
    assert.equal(hash(bytes), typescriptSha256);
    sources.push({ path: typescriptPath, source: text(bytes), sha256: hash(bytes) });
    return { root: pathToFileURL(root + "/").href, sources };
  } catch { throw validationFailure(); }
}

// Caller-only seam for synthetic controls. Neither JSON input nor CLI arguments
// can supply a snapshot, worker implementation, module, command or package.
export function validationTask(input, { snapshot = captureValidation(input.commit), WorkerClass = Worker } = {}) {
  try {
    assert.deepEqual(Object.keys(input).sort(), ["commit", "folder", "round"]);
    assert.match(input.commit, /^[a-f0-9]{40}$/);
    const { sources, root } = snapshot;
    assert.deepEqual(sources.map((row) => row.path), [...validationPaths, typescriptPath]);
    const base = new URL(root);
    assert.equal(base.protocol, "file:"); assert.ok(base.href.endsWith("/"));
    for (const row of sources) {
      assert.deepEqual(Object.keys(row).sort(), ["path", "sha256", "source"]);
      assert.equal(hash(row.source), row.sha256);
    }
    assert.equal(sources.at(-1).sha256, typescriptSha256);
    const entry = sources.find((row) => row.path === entryPath);
    const worker = new WorkerClass(new URL("data:text/javascript;base64," + Buffer.from(entry.source).toString("base64")), {
      workerData: { input, root, sources }, stdout: true, stderr: true, execArgv: [],
      env: { ...gitEnvironment(), NODE_OPTIONS: "", NODE_PATH: "" },
    });
    worker.stdout.resume(); worker.stderr.resume();
    const stop = () => { try { void worker.terminate().catch(() => {}); } catch {} };
    const result = new Promise((resolve, reject) => {
      let message, failed = false;
      worker.once("message", (value) => { message = value; stop(); });
      worker.once("error", () => { failed = true; });
      worker.once("exit", () => {
        if (!failed && message?.ok === true) resolve(message.report);
        else reject(validationFailure());
      });
    });
    return { result, stop, unref: () => worker.unref() };
  } catch { throw validationFailure(); }
}
