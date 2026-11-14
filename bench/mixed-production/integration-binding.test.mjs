import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";
import { bindExecutionParticipant, executionWorkerCompleted } from "./execution-evidence.mjs";
import { savedRelative } from "./measure.mjs";

test("measurement artifact references use portable saved POSIX paths on the producer host", () => {
  const root = resolve("saved-round");
  for (const suffix of ["warmup_0/capture.json", "cycle_2/capture.json", "cycle_2/request_1.json"])
    assert.equal(savedRelative(root, join(root, "measurement/corten/api/steady-1", suffix)), `measurement/corten/api/steady-1/${suffix}`);
  assert.throws(() => savedRelative(root, resolve(root, "../escape")));
});

test("complete native failure admission still requires actual worker completion, not a crash or unfinished collector", () => {
  for (const [role, exitCode] of [["capture", 0], ["qualificationWorker", 0], ["qualificationWorker", 1]]) {
    const context = { stage: role === "capture" ? "functional" : "qualification", pass: null, app: "corten", source: "api", role };
    const p = { ...context, restartCount: 0, state: { Status: "exited", Running: false, Paused: false, Restarting: false,
      OOMKilled: false, Dead: false, ExitCode: exitCode, StartedAt: "2026-11-13T00:00:00Z", FinishedAt: "2026-11-13T00:01:00Z" } };
    assert.equal(executionWorkerCompleted([p], context, exitCode), true);
    for (const state of [{ Running: true }, { ExitCode: 137 }, { OOMKilled: true }, { Dead: true }, { Restarting: true },
      { Paused: true }, { Status: "running" }, { FinishedAt: "0001-01-01T00:00:00Z" }, { StartedAt: "0001-01-01T00:00:00Z" }])
      assert.equal(executionWorkerCompleted([{ ...p, state: { ...p.state, ...state } }], context, exitCode), false);
    assert.equal(executionWorkerCompleted([{ ...p, restartCount: 1 }], context, exitCode), false);
    assert.throws(() => executionWorkerCompleted([], context, exitCode));
    assert.throws(() => executionWorkerCompleted([p, p], context, exitCode));
  }
});

test("qualification and window receipts bind original lifecycle IDs, images and observed process lifetime", () => {
  for (const stage of ["qualification", "calibration", "steady"]) for (const role of ["app", "upstream", "load"]) {
    const context = { stage, pass: stage === "qualification" ? null : stage === "calibration" ? 0 : 1, app: "corten", source: "api", role };
    const p = { ...context, id: "a".repeat(64), imageId: `sha256:${"b".repeat(64)}`, restartCount: 0,
      state: { StartedAt: "2026-11-13T00:00:00Z", OOMKilled: false, Dead: false, Running: true, ExitCode: 0, Restarting: false,
        Paused: stage !== "qualification" && role === "app" } };
    const observed = { id: p.id, imageId: p.imageId, startedAt: p.state.StartedAt };
    assert.equal(bindExecutionParticipant([p], context, observed), true);
    for (const field of ["id", "imageId", "startedAt"]) assert.throws(() => bindExecutionParticipant([p], context, { ...observed, [field]: "replacement" }));
    assert.throws(() => bindExecutionParticipant([], context, observed));
    assert.throws(() => bindExecutionParticipant([p, p], context, observed));
    for (const state of [{ Running: false }, { ExitCode: 137 }, { OOMKilled: true }, { Dead: true }, { Restarting: true }, { Paused: !p.state.Paused }])
      assert.equal(bindExecutionParticipant([{ ...p, state: { ...p.state, ...state } }], context, observed), false);
    assert.equal(bindExecutionParticipant([{ ...p, restartCount: 1, state: { ...p.state, StartedAt: "2026-11-13T00:01:00Z" } }], context, observed), false);
  }
});
