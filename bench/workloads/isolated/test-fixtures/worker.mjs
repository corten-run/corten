// Runs ONLY in the test's disposable checkout. Every native/tool spawn is replaced.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mock } from "node:test";
import { bindExecution } from "../contract.mjs";
import { createWorker, verifyWorkingSources } from "../worker.mjs";
import { inside } from "../evidence.mjs";
import { catalogResult } from "./catalog.mjs";
import { fakeChild } from "./process.mjs";
import { marketplaceResult } from "./marketplace.mjs";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
assert.ok(repo.includes("isolated-worker-test-"), "fixture must not operate on a developer checkout");
const phase = process.argv[2]; assert.ok(["ownership", "validation", "unsafe", "unsupported"].includes(phase));
const git = (args) => childProcess.execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const commit = git(["rev-parse", "HEAD"]);
const bind = (group, round) => bindExecution({ group, round, commit, recipe: "native-defaults", review: null });
const sandbox = resolve(repo, ".."), states = mkdtempSync(join(sandbox, "state-"));
const root = (name) => { const p = join(states, name); mkdirSync(p, { mode: 0o700 }); return p; };
mock.method(os, "platform", () => "linux"); mock.method(os, "availableParallelism", () => 8);
let current, mode = "valid", calls = [];
const start = mock.method(childProcess, "spawn", (binary, args, options) => {
  assert.equal(binary, process.execPath); assert.equal(options.shell, false);
  assert.equal(resolve(options.cwd), resolve(repo));
  assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "LANG", "PATH", "TZ", "GIT_NO_REPLACE_OBJECTS", "GIT_NO_LAZY_FETCH", "GIT_TERMINAL_PROMPT",
    ...Object.keys(current.resources.requestedCpuEnv)].sort());
  assert.equal(options.env.GIT_NO_REPLACE_OBJECTS, "1"); assert.equal(options.env.GIT_NO_LAZY_FETCH, "1");
  const nativeArgs = args.slice(1); calls.push(nativeArgs);
  const expected = [...current.preparation.fixtures, current.execution.invocation];
  assert.notEqual(nativeArgs[0], current.validation.validator.argv[0], "report subprocess must never read producer files");
  assert.deepEqual(nativeArgs, expected[calls.length - 1].argv, "only the exact bound native commands may execute");
  if (mode === "nonterminal") return fakeChild(() => {}, { killCloses: false });
  return fakeChild((child) => {
    child.stdout.write(`fake evidence ${calls.length}\n`);
    if (mode === "prep-fails") return child.close(9);
    if (nativeArgs[0] === current.execution.invocation.argv[0]) {
      const output = join(repo, current.validation.artifactRoot); mkdirSync(output, { recursive: true });
      const summary = current.request.group === "catalog-page" ? catalogResult(current)
        : current.request.group === "localized-marketplace" ? marketplaceResult(current) : {
        round: current.request.round, commit, options: current.execution.effectiveOptions, complete: true,
        measurement: { cpus: current.resources.expectedCpus }, failures: [], cleanupFailures: [],
      };
      if (mode === "bad-cleanup") summary.cleanupFailures.push({ error: "owned resource retained" });
      if (mode === "hardlink") {
        const external = join(states, "external-summary.json"); writeFileSync(external, JSON.stringify(summary));
        linkSync(external, join(output, "summary.json"));
      } else writeFileSync(join(output, "summary.json"), JSON.stringify(summary));
      if (mode !== "summary-only") {
        mkdirSync(join(output, "raw")); writeFileSync(join(output, "raw", "failed.log"), "original evidence, not a number\n");
      }
      if (mode === "process-fails") return child.close(7);
    }
    child.close(0);
  });
});
async function run(group, round, testMode = "valid", policy = () => true, state = root(round)) {
  current = bind(group, round); mode = testMode; calls = [];
  const input = structuredClone(current);
  const worker = createWorker({ authorize(subject) {
    assert.ok(Object.isFrozen(subject)); assert.equal(subject.bindingSha256, current.bindingSha256);
    assert.equal(subject.stateRoot, resolve(state));
    if (testMode === "mutate-input") {
      input.execution.invocation.argv.push("--apps", "corten");
      input.validation.artifactRoot = "../foreign"; input.status.executionAuthorized = true;
    }
    return policy(subject);
  } });
  return { worker, result: await worker.run(input, { stateRoot: state }), state, calls: [...calls] };
}
async function ownership() {
  assert.throws(() => createWorker({}), /authorization policy/);
  const deniedState = root("denied"); current = bind("catalog-page", "c9001"); calls = [];
  await assert.rejects(createWorker({ authorize: () => ({ approved: true }) }).run(current, { stateRoot: deniedState }), /did not authorize/);
  assert.equal(calls.length, 0); assert.equal(existsSync(join(deniedState, ".host-attempt.json")), false);
  const valid = await run("catalog-page", "c9002", "mutate-input");
  assert.equal(valid.result.collection.outcome, "blocked"); assert.equal(valid.calls.length, 2);
  assert.equal(valid.result.collection.report.rawCompleteness, "not-established");
  assert.equal(valid.result.collection.controllerReady, false);
  assert.equal(valid.worker.verify(valid.result.attempt), valid.result.collection);
  assert.throws(() => valid.worker.collect({ ...valid.result.attempt }), /not owned/);
  assert.throws(() => createWorker({ authorize: () => true }).collect(valid.result.attempt), /not owned/);
  const other = bind("json-api", "j9002"); calls = []; current = other;
  await assert.rejects(createWorker({ authorize: () => true }).run(other, { stateRoot: valid.state }), /EEXIST/);
  assert.equal(calls.length, 0, "durable host reservation blocks another group/round");
  const copy = join(valid.result.attempt.directory, "native", "raw", "failed.log");
  appendFileSync(copy, "mutation"); assert.throws(() => valid.worker.verify(valid.result.attempt), /mutated/);
  const failed = await run("catalog-page", "c9003", "process-fails");
  assert.equal(failed.result.collection.outcome, "failed"); assert.equal(failed.result.collection.report.diagnosticNativeReport.baseline, true);
  assert.equal(failed.calls.length, 2, "failed native process must not run a success report phase");
  assert.equal(failed.worker.collect(failed.result.attempt).outcome, "failed");
  const source = join(repo, current.validation.artifactRoot, "summary.json");
  appendFileSync(source, " "); assert.throws(() => failed.worker.verify(failed.result.attempt), /mutated/);
  await actualSources();
}
async function validation() {
  const cleanup = await run("catalog-page", "c9004", "bad-cleanup");
  assert.equal(cleanup.result.collection.outcome, "failed"); assert.match(cleanup.result.collection.validationError, /strict catalog/);
  appendFileSync(join(cleanup.result.attempt.directory, "command-0.log"), "log mutation");
  assert.throws(() => cleanup.worker.verify(cleanup.result.attempt), /command evidence mutated/);
  const missing = await run("catalog-page", "c9005", "prep-fails");
  assert.equal(missing.result.collection.outcome, "failed"); assert.equal(missing.calls.length, 1);
  assert.equal(missing.worker.verify(missing.result.attempt).outcome, "failed");
  appendFileSync(join(missing.state, ".host-attempt.json"), "ownership mutation");
  assert.throws(() => missing.worker.collect(missing.result.attempt), /reservation ownership changed/);
  assert.ok(existsSync(join(missing.result.attempt.directory, "native")), "uncertain ownership never deletes retained evidence");
  const json = await run("json-api", "j9006");
  assert.equal(json.result.collection.outcome, "failed", "aggregate complete/exit zero cannot bypass real native schema/validation");
  assert.ok(json.result.collection.validationError);
  const market = await run("localized-marketplace", "w9006"); assert.equal(market.result.collection.outcome, "blocked");
  assert.equal(market.calls.length, 2); assert.equal(market.result.collection.report.rawCompleteness, "not-established");
}
async function unsafe() {
  const summaryOnly = await run("catalog-page", "c9010", "summary-only");
  assert.equal(summaryOnly.result.collection.outcome, "blocked");
  assert.equal(summaryOnly.result.collection.report.diagnosticNativeReport.baseline, true, "native summary gate is diagnostic only");
  assert.equal(summaryOnly.worker.collect(summaryOnly.result.attempt).outcome, "blocked");
  assert.equal(summaryOnly.calls.length, 2);
  const hardlink = await run("catalog-page", "c9011", "hardlink");
  assert.equal(hardlink.result.outcome, "preserved-uncertain"); assert.match(hardlink.result.error, /link\/special evidence file refused/);
  assert.equal(hardlink.calls.length, 2);
  assert.equal(existsSync(join(hardlink.result.attempt.directory, "native")), false, "unsafe source must not reach copied validation");
  assert.deepEqual(JSON.parse(readFileSync(join(states, "external-summary.json"))), catalogResult(current));
}
async function unsupported() {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let done = false;
    const pending = run("catalog-page", "c9009", "nonterminal").then((value) => { done = true; return value; });
    for (let i = 0; i < 10 && !done; i++) { await new Promise((r) => setImmediate(r)); mock.timers.tick(37 * 60 * 60 * 1000); }
    assert.ok(done, "bounded shutdown must return without trusting an absent exit");
    const uncertain = await pending;
    assert.equal(uncertain.result.outcome, "preserved-uncertain");
    assert.throws(() => uncertain.worker.collect(uncertain.result.attempt), /not observed terminal/);
    assert.equal(existsSync(join(uncertain.result.attempt.directory, "native")), false);
  } finally { mock.timers.reset(); }
  for (const group of ["mixed-production", "fullstack-browser", "client-heavy", "live-delivery", "recoverable-live", "hardening"]) {
    const b = bind(group, "w9007"); calls = [];
    const r = await createWorker({ authorize() { throw new Error("must not authorize unsupported group"); } }).run(b);
    assert.equal(r.outcome, "not-run"); assert.equal(r.coverage.cells.every((c) => c.parity === "not-run"), true); assert.equal(calls.length, 0);
  }
}
async function actualSources() {
  const b = bind("catalog-page", "c9008"), path = join(repo, "bench/workloads/isolated/README.md"), original = readFileSync(path);
  git(["update-index", "--assume-unchanged", "bench/workloads/isolated/README.md"]);
  try {
    appendFileSync(path, "\nHidden working-source mutation.\n");
    assert.equal(git(["status", "--porcelain"]), "");
    assert.throws(() => verifyWorkingSources(b), /executed working source differs/);
  } finally { writeFileSync(path, original); git(["update-index", "--no-assume-unchanged", "bench/workloads/isolated/README.md"]); }
}
try {
  await ({ ownership, validation, unsafe, unsupported }[phase])();
  console.log(`WORKER_PROBE_PASS:${phase}`);
} finally {
  start.mock.restore(); mock.restoreAll();
  assert.ok(inside(sandbox, resolve(states))); rmSync(states, { recursive: true, force: true });
}
