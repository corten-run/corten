// Nonofficial CI diagnostic. The native catalog runner owns build, parity checks and cleanup.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beginLifetime, inspectLifetime } from "../bench/workloads/isolated/host-lifetime.mjs";
import { supervise } from "../bench/workloads/isolated/process.mjs";

// Only fixed stages, error codes and numeric observations leave this disposable runner.
const codes = ["ENOENT", "ESRCH", "EACCES", "EPERM", "EIO", "ENOSPC", "EDQUOT", "EMFILE", "ENFILE", "ERR_ASSERTION"];
const codeOf = code => codes.includes(code) ? code : "unknown";
const number = value => Number.isSafeInteger(value) ? value : null;
const capture = item => item && ({ code: codeOf(item.code), samples: number(item.samples),
  entryGapMs: number(item.catalogCensus?.entryGapMs), censusMs: number(item.catalogCensus?.censusMs),
  attempts: number(item.catalogCensus?.attempts) });
let stage = "preflight";
try {
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
  const binding = { diagnosticOnly: true, request: { group: "catalog-page", round, commit } };
  const invocation = { executable: "node", argv: ["bench/catalog/run.mjs", round, "--apps", "corten", "--build", "--check-only"], shell: false };
  console.log(JSON.stringify({ diagnostic: "catalog-build", campaign, commit }));
  const directory = join(out, "command-host"), stop = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => stop.abort(signal));
  let observer, pid, setupError;
  stage = "command";
  const result = await supervise(invocation, { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", TZ: "UTC" },
    signal: stop.signal, log: () => {}, async onStart(value, startupSignal) {
      pid = value;
      try {
        stage = "begin";
        observer = await beginLifetime({ campaign, binding, invocation, directory, command: 0, pid, signal: stop.signal,
          startupSignal, onFault: () => stop.abort("catalog observer fault") });
        stage = "attach";
        await observer.attach(pid); startupSignal.throwIfAborted();
        stage = "command";
      } catch (error) { setupError = error; observer?.dispose(); observer = null; throw error; }
    } });
  console.log(JSON.stringify({ stage, terminal: result.terminal, exit: number(result.code), cancelled: result.cancelled, forced: result.forced }));
  if (setupError) throw setupError;
  assert.ok(observer, "command observation did not start");
  stage = "seal";
  const seal = await observer.finish(result);
  stage = "replay";
  const terminal = JSON.parse(readFileSync(join(directory, "terminal.json")));
  const failures = terminal.observerFailures;
  console.log(JSON.stringify({ stage, samples: number(terminal.samples), failures: number(failures.count),
    first: capture(failures.first), last: capture(failures.last) }));
  const proof = inspectLifetime(binding, invocation, directory, { campaign, command: 0, pid, result });
  assert.equal(proof.manifestSha256, seal.sha256);
  console.log(JSON.stringify({ hostVerified: proof.status === "verified", cleanupComplete: proof.cleanupComplete }));
  assert.ok(proof.status === "verified" && proof.cleanupComplete, "host replay did not verify");
  stage = "cleanup";
  assert.ok(!existsSync("/sys/fs/cgroup" + proof.context.path), "command scope still present");
  stage = "native-checks";
  const summary = JSON.parse(readFileSync(join(folder, "summary.json")));
  assert.equal(summary.commit, commit); assert.equal(summary.dirty, false);
  assert.deepEqual(summary.options.apps, ["corten"]); assert.equal(summary.options.checkOnly, true);
  const stages = ["build/image", "checks", "app logs", "suite", "upstream logs", "tree provenance", "artifact index"];
  console.log(JSON.stringify({ nativeExit: number(result.code), failureCount: summary.failures.length,
    cleanupFailures: summary.cleanupFailures.length, firstFailures: summary.failures.slice(0, 8).map(f => ({
      stage: stages.includes(f.stage) ? f.stage : "unknown",
      source: f.source === null ? null : ["api", "fixture"].includes(f.source) ? f.source : "unknown" })) }));
  assert.ok(result.success, "native command failed");
  assert.equal(summary.complete, true); assert.equal(summary.checksPassed, true);
  assert.deepEqual(summary.failures, []); assert.deepEqual(summary.cleanupFailures, []);
  stage = "image";
  const image = JSON.parse(readFileSync(join(folder, "image-corten.json")));
  assert.equal(image.commit, commit); assert.equal(image.built, true);
  assert.match(image.imageId, /^sha256:[0-9a-f]{64}$/); assert.equal(image.imageId, summary.apps.corten.imageId);
  assert.deepEqual(Object.keys(summary.apps.corten.checks).sort(), ["api", "fixture"]);
  console.log("Corten image built; both source checks and host replay passed. No throughput measured.");
} catch (error) {
  console.error(JSON.stringify({ diagnostic: "failed", stage, code: codeOf(error?.code) }));
  process.exitCode = 1;
}
