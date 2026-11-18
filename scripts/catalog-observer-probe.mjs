// Nonofficial CI diagnostic. The native catalog runner owns build, parity checks and cleanup.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginLifetime, inspectLifetime } from "../bench/workloads/isolated/host-lifetime.mjs";
import { supervise } from "../bench/workloads/isolated/process.mjs";

const round = "c900000001";
const campaign = /^0::\/system\.slice\/corten-bench-groups-(r900000001-[a-f0-9]{16})\.service\/supervisor\s*$/
  .exec(readFileSync("/proc/self/cgroup", "utf8"))?.[1];
assert.ok(campaign, "expected the fresh delegated diagnostic unit");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.match(commit, /^[0-9a-f]{40}$/);
assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }), "");
const folder = join("bench/catalog/results", round);
assert.ok(!existsSync(folder), "never reuse a catalog result");
const out = join(process.env.RUNNER_TEMP, "catalog-observer-probe");
mkdirSync(out, { mode: 0o700 });
const save = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const binding = { diagnosticOnly: true, request: { group: "catalog-page", round, commit } };
const invocation = { executable: "node", argv: ["bench/catalog/run.mjs", round, "--apps", "corten", "--build", "--check-only"], shell: false };
save("request.json", { campaign, binding, invocation });
const directory = join(out, "command-host"), stop = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => stop.abort(signal));
let observer, pid;
const result = await supervise(invocation, { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", TZ: "UTC" },
  signal: stop.signal, log: (bytes) => process.stdout.write(bytes), async onStart(value, startupSignal) {
    pid = value;
    observer = await beginLifetime({ campaign, binding, invocation, directory, command: 0, pid, signal: stop.signal,
      startupSignal, onFault: () => stop.abort("catalog observer fault") });
    try { await observer.attach(pid); startupSignal.throwIfAborted(); }
    catch (error) { observer.dispose(); observer = null; throw error; }
  } });
save("command.json", { pid, result });
assert.ok(observer, "command observation did not start");
const seal = await observer.finish(result);
const proof = inspectLifetime(binding, invocation, directory, { campaign, command: 0, pid, result });
const terminal = JSON.parse(readFileSync(join(directory, "terminal.json")));
save("host-replay.json", { commit, diagnosticOnly: true, hostStatus: proof.status, checks: proof.checks,
  observerFailures: terminal.observerFailures, samples: proof.samples.length, manifestSha256: proof.manifestSha256 });
assert.equal(proof.manifestSha256, seal.sha256);
assert.ok(result.success && proof.status === "verified" && proof.cleanupComplete, "native command or host replay did not verify");
assert.ok(!existsSync("/sys/fs/cgroup" + proof.context.path), "command scope still present");
const summary = JSON.parse(readFileSync(join(folder, "summary.json")));
assert.equal(summary.commit, commit); assert.equal(summary.dirty, false);
assert.deepEqual(summary.options.apps, ["corten"]); assert.equal(summary.options.checkOnly, true);
assert.equal(summary.complete, true); assert.equal(summary.checksPassed, true);
assert.deepEqual(summary.failures, []); assert.deepEqual(summary.cleanupFailures, []);
const image = JSON.parse(readFileSync(join(folder, "image-corten.json")));
assert.equal(image.commit, commit); assert.equal(image.built, true);
assert.match(image.imageId, /^sha256:[0-9a-f]{64}$/); assert.equal(image.imageId, summary.apps.corten.imageId);
assert.deepEqual(Object.keys(summary.apps.corten.checks).sort(), ["api", "fixture"]);
console.log("Corten image built; both source checks and host replay passed. No throughput measured.");
