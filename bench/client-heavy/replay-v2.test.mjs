import assert from "node:assert/strict";
import test from "node:test";
import { fixturePass, workload, settings } from "./replay-fixture.mjs";
import { replayV2 } from "./replay-v2.mjs";
import { configurationNames } from "./contract.mjs";
import { depInputs, compilerSourcePath, cargoMetadata } from "./compiler.mjs";
import { validateClientCapture } from "../workloads/client.mjs";

const replay = (p, phase = "measurement") => replayV2(p, "react", phase, workload, settings, 30000, 1000);
test("v2 recomputes raw endpoints without claiming execution authentication", () => {
  const r = replay(fixturePass()); assert.equal(r.passed, true); assert.equal(r.timings.readyMs, 1);
  assert.equal(r.timings.actions.length, 19); assert.equal(r.timings.actions[0].elapsedMs, 0.25);
  assert.equal(replay(fixturePass("react", false), "qualification").timings.actions, null);
});
for (const [name, mutate, reason] of [
  ["coherent scalar shift", (p) => { p.actions[0].elapsedMs = 0.5; }, "timings-differ"],
  ["cross-origin endpoint", (p) => { p.timing.operations[0].timeOrigin++; }, "operation-clock"],
  ["negative start", (p) => { p.timing.operations[0].startedAt = -1; }, "invalid-clock-span"],
  ["overlapping operation", (p) => { p.timing.operations[1].startedAt = 3; p.actions[1].elapsedMs = 1.25; }, "operation-clock"],
  ["unbound record index", (p) => { p.timing.operations[0].recordIndex++; }, "operation-clock"],
  ["missing operation endpoint", (p) => { p.timing.operations.pop(); }, "missing-raw-operation-clocks"],
  ["mount outside observations", (p) => { p.timing.mount.endedAt = 10; p.readyMs = 9; }, "mount-clock"],
  ["invented context closure", (p) => { p.lifecycle.close.observed = "true"; }, "invalid-close"],
  ["cancel before deadline scheduled", (p) => { p.lifecycle.deadline.cancelledAt = 0; }, "invalid-deadline-order"],
  ["abort without firing", (p) => { p.lifecycle.deadline.aborted = true; }, "invalid-deadline-cancellation"],
  ["failure-leaked timings", (p) => { p.lifecycle.close.observed = false; }, "failed-pass-has-timings"],
  ["mount starts after DOM", (p) => { p.timing.mount.startedAt = 2.5; p.timing.mount.endedAt = 2.5; p.readyMs = 0; }, "mount-clock"],
  ["closed before browser observations", (p) => { p.lifecycle.deadline.scheduledAt = 0; p.lifecycle.deadline.cancelledAt = 0; p.lifecycle.close.startedAt = 0; p.lifecycle.close.endedAt = 0; }, "browser-clock-outside-context"],
  ["deadline silently exceeded", (p) => { p.lifecycle.deadline.cancelledAt = 100000; p.lifecycle.close.startedAt = 100001; p.lifecycle.close.endedAt = 100002; }, "invalid-deadline-cancellation"],
]) test(`rejects ${name}`, () => { const p = fixturePass(); mutate(p); assert.throws(() => replay(p), new RegExp(reason)); });
test("valid close failure and actual deadline failure retain null, not zero", () => {
  for (const timeout of [false, true]) {
    const p = fixturePass(); p.readyMs = null; p.actions = null;
    if (timeout) {
      Object.assign(p.lifecycle.deadline, { firedAt: 30001, aborted: true, cancelledAt: 30005 });
      Object.assign(p.lifecycle.close, { startedAt: 30001, endedAt: 30003 });
    } else p.lifecycle.close.observed = false;
    const r = replay(p); assert.equal(r.passed, false); assert.equal(r.timings, null);
  }
});
test("configuration union includes overrides, flags and case variants without values", () => {
  const names = configurationNames({ CARGO_TARGET_X_LINKER: "private", RUSTDOCFLAGS: "private", node_options: "private", LD_PRELOAD: "private", OTHER_SECRET: "private" });
  assert.deepEqual(names, ["CARGO_TARGET_X_LINKER", "LD_PRELOAD", "RUSTDOCFLAGS", "node_options"]);
  assert.ok(!JSON.stringify(names).includes("private"));
});
test("actual Make dep-info closure handles escaped spaces and continuations", () => {
  assert.deepEqual(depInputs(["/target/app: /src/a\\ b.rs \\", " /src/g.rs", "/src/a\\ b.rs:", "# env-dep:UNIT=value", ""].join("\n")), ["/src/a b.rs", "/src/g.rs"]);
  assert.throws(() => depInputs("not a rule"), /invalid-rust-dep-info/);
});

test("compiler inputs retain raw spelling while resolving relative and parent segments", () => {
  assert.equal(compilerSourcePath("/src", "bench/gen/client.rs"), "bench/gen/client.rs");
  assert.equal(compilerSourcePath("/src", "/src/crates/corten/src/../js/runtime.js"), "crates/corten/js/runtime.js");
  assert.throws(() => compilerSourcePath("/src", "../elsewhere.rs"), /escaped-rust/);
});

test("Cargo root-package dep-info resolves against its compiler working directory", () => {
  assert.equal(compilerSourcePath("/src", "src/bin/client.rs", "/src/bench/browser/gen"), "bench/browser/gen/src/bin/client.rs");
  assert.equal(compilerSourcePath("D:/src", "src/bin/client.rs", "D:/src/bench/browser/gen"), "bench/browser/gen/src/bin/client.rs");
  assert.throws(() => compilerSourcePath("/src", "../../../../escaped.rs", "/src/bench/browser/gen"), /escaped-rust/);
});

test("Cargo metadata retains launcher framing without executing or ignoring extra JSON", () => {
  const metadata = { version: 1, packages: [] }, line = JSON.stringify(metadata);
  assert.deepEqual(cargoMetadata(Buffer.from(`Queue status\n${line}\nLauncher exit 0\n`)), metadata);
  assert.throws(() => cargoMetadata(Buffer.from(`${line}\n${line}\n`)), /invalid-cargo-metadata-output/);
});

test("partial readiness and post-dispatch reads remain valid failed attempts", () => {
  for (const [length, phase, samples] of [[2, "readiness", 0], [3, workload.operations[0].id, 1]]) {
    const p = fixturePass(), records = p.capture.records.slice(0, length);
    p.capture = { ...p.capture, outcome: "failed", reason: `native-${phase}-failed`, records: null };
    p.oracle = validateClientCapture(workload, p.capture, settings); p.readyMs = null; p.actions = null;
    p.failure = { phase, diagnostic: "Error", diagnosticSha256: "a".repeat(64), records, errors: [] };
    p.timing.operations = p.timing.operations.slice(0, samples);
    assert.equal(replay(p).passed, false); assert.equal(replay(p).timings, null);
  }
});
