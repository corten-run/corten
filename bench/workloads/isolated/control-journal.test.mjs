import assert from "node:assert/strict";
import test from "node:test";
import { replayJournal } from "./campaign-journal.mjs";

const commit = "a".repeat(40), id = "r21-0123456789abcdef";
const binding = { round: "r21", commit, token: "0123456789abcdef", helperSha256: "b".repeat(64) };
const plan = { round: "r21", commit, order: ["mixed-production"] };
const status = (executionVersion) => ({ executionVersion, state: "preserved-uncertain",
  outcomes: [{ group: "mixed-production", outcome: "not-run" }], uncollectedNativeRoots: [] });
const authorized = { kind: "authorized", sequence: 0 }, started = { kind: "started" }, halted = { kind: "halted" };
const admitted = (epoch) => ({ kind: "control-admitted", epoch, binding, sha256: "c".repeat(64),
  path: epoch === "bootstrap" ? "control-bootstrap.json" : `control-${epoch}.json` });

test("v4 cannot start without sealed bootstrap and cannot claim it in legacy schemas", () => {
  for (const version of [undefined, 2, 3]) {
    assert.doesNotThrow(() => replayJournal(plan, id, [authorized, started, halted], status(version)));
    assert.throws(() => replayJournal(plan, id, [authorized, admitted("bootstrap"), started, halted], status(version)));
  }
  assert.throws(() => replayJournal(plan, id, [authorized, started, halted], status(4)), /bootstrap control seal missing/);
  const rows = [authorized, admitted("bootstrap"), started, halted];
  assert.equal(replayJournal(plan, id, rows, status(4)).controlAdmissions.size, 1);
  assert.throws(() => replayJournal(plan, id, [authorized, admitted("bootstrap"), admitted("bootstrap"), started, halted], status(4)));
  assert.doesNotThrow(() => replayJournal(plan, id, [authorized, halted], status(4)), "early failed admission is retained, not qualified");
});

test("audit staging requires its own post-review sealed admission and the same exact binding", () => {
  const before = [authorized, admitted("bootstrap"), started, { kind: "mixed-review-needed", subjectSha256: "d".repeat(64) }];
  const stage = { kind: "mixed-audit-staged" }, audit = admitted("audit-mixed-production");
  assert.throws(() => replayJournal(plan, id, [...before, stage, halted], status(4)), /mixed control seal missing/);
  assert.equal(replayJournal(plan, id, [...before, audit, stage, halted], status(4)).controlAdmissions.size, 2);
  for (const mutate of [
    (a) => { a.binding.token = "f".repeat(16); }, (a) => { a.binding.helperSha256 = "f".repeat(64); },
    (a) => { a.path = "control-bootstrap.json"; }, (a) => { a.epoch = "audit-json-api"; },
  ]) { const changed = structuredClone(audit); mutate(changed); assert.throws(() => replayJournal(plan, id, [...before, changed, stage, halted], status(4))); }
  assert.throws(() => replayJournal(plan, id, [authorized, admitted("bootstrap"), started, audit, halted], status(4)), "no admission before review wait");
});

test("v5 replay requires same-stream audit admission and a final stream seal without changing v4", () => {
  const before = [authorized, admitted("bootstrap"), started, { kind: "mixed-review-needed", subjectSha256: "d".repeat(64) }];
  const audit = { ...admitted("audit-mixed-production"), channel: "stream" }, stage = { kind: "mixed-audit-staged" };
  assert.doesNotThrow(() => replayJournal(plan, id, [...before, audit, stage, halted], status(5)));
  assert.throws(() => replayJournal(plan, id, [...before, admitted("audit-mixed-production"), stage, halted], status(5)));
  assert.throws(() => replayJournal(plan, id, [...before, audit, stage, halted], status(4)));
  const empty = { ...plan, order: [] }, finished = { executionVersion: 5, state: "finished", outcomes: [], uncollectedNativeRoots: [] };
  const seal = { kind: "stream-sealed", path: "control-stream-seal.json", sha256: "e".repeat(64), binding };
  const prefix = [authorized, admitted("bootstrap"), started];
  assert.throws(() => replayJournal(empty, id, [...prefix, { kind: "finished" }], finished), /stream seal/);
  assert.equal(replayJournal(empty, id, [...prefix, seal, { kind: "finished" }], finished).streamSeal.sha256, seal.sha256);
  for (const change of [(s) => { s.binding.token = "f".repeat(16); }, (s) => { s.path = "late-clean.json"; }]) {
    const wrong = structuredClone(seal); change(wrong); assert.throws(() => replayJournal(empty, id, [...prefix, wrong, { kind: "finished" }], finished));
  }
});

test("v6 requires a drained bootstrap and separate audit epoch, never a stream receipt", () => {
  const bootstrap = admitted("bootstrap"), stage = { kind: "mixed-audit-staged" };
  const prefix = [authorized, bootstrap, started, { kind: "mixed-review-needed", subjectSha256: "d".repeat(64) }];
  const audit = admitted("audit-mixed-production");
  assert.throws(() => replayJournal(plan, id, [authorized, started, halted], status(6)), /bootstrap control seal missing/);
  assert.throws(() => replayJournal(plan, id, [...prefix, stage, halted], status(6)), /mixed control seal missing/);
  assert.throws(() => replayJournal(plan, id, [...prefix, { ...audit, channel: "stream" }, stage, halted], status(6)));
  assert.equal(replayJournal(plan, id, [...prefix, audit, stage, halted], status(6)).controlAdmissions.size, 2);
});
