// Intrinsic trace replay only. No saved module or command is executed.
import { isDeepStrictEqual as same } from "node:util";
import { validateClientCapture } from "../workloads/client.mjs";
import { replay } from "./verify.mjs";

export const need = (ok, reason) => { if (!ok) throw new Error(reason); };
export const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const keys = (v, required, optional = []) => need(object(v) && required.every((k) => Object.hasOwn(v, k))
  && Object.keys(v).every((k) => [...required, ...optional].includes(k)), "missing-or-unexpected-fields");
export const finite = (v) => Number.isFinite(v) && v >= 0;
export const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export const span = (v) => need(object(v) && finite(v.startedAt) && finite(v.endedAt) && v.endedAt >= v.startedAt, "invalid-clock-span");
export const diagnostic = (v) => { keys(v, ["name", "diagnosticSha256"]); need(typeof v.name === "string" && digest(v.diagnosticSha256), "invalid-diagnostic"); };

export function closure(value, resource) {
  keys(value, ["resource", "startedAt", "endedAt", "returned", "observed", "failure"]); span(value);
  need(value.resource === resource && typeof value.returned === "boolean" && [null, true, false].includes(value.observed), "invalid-close-receipt");
  if (value.failure !== null) { diagnostic(value.failure); need(value.returned === false || value.observed !== true, "contradictory-close-failure"); }
  need(value.returned || value.observed === null, "observation-without-close-return");
  return value.returned && value.observed === true && value.failure === null;
}

export function replayV2(pass, app, phase, workload, settings, timeoutMs, nodeOrigin) {
  keys(pass, ["capture", "oracle", "readyMs", "actions", "failure", "timing", "lifecycle", "requests"], ["resourceDetails"]);
  const oracle = validateClientCapture(workload, pass.capture, settings);
  need(same(oracle, pass.oracle), "saved-oracle-differs-from-raw-replay");
  const life = pass.lifecycle, timing = pass.timing;
  keys(life, ["clock", "timeOrigin", "contextCreatedAt", "close", "deadline"]);
  need(life.clock === "node-performance" && life.timeOrigin === nodeOrigin, "wrong-node-clock-origin");
  const deadline = life.deadline;
  keys(deadline, ["timeoutMs", "scheduledAt", "firedAt", "aborted", "cancelledAt"]);
  need(deadline.timeoutMs === timeoutMs && finite(deadline.cancelledAt) && typeof deadline.aborted === "boolean", "invalid-deadline");
  let closed = false;
  if (life.contextCreatedAt === null) {
    need(life.close === null && deadline.scheduledAt === null && deadline.firedAt === null && !deadline.aborted
      && pass.failure?.phase === "context" && same(pass.failure.records, []), "invalid-uncreated-context");
  } else {
    need(finite(life.contextCreatedAt) && finite(deadline.scheduledAt) && deadline.scheduledAt >= life.contextCreatedAt
      && deadline.cancelledAt >= deadline.scheduledAt, "invalid-deadline-order");
    closed = closure(life.close, "context");
    need(life.close.startedAt >= deadline.scheduledAt, "invalid-context-close-order");
    if (deadline.firedAt === null) need(deadline.aborted === false && life.close.startedAt >= deadline.cancelledAt
      && life.close.endedAt >= deadline.cancelledAt && deadline.cancelledAt <= deadline.scheduledAt + timeoutMs + 1, "invalid-deadline-cancellation");
    else {
      need(finite(deadline.firedAt) && deadline.firedAt >= deadline.scheduledAt + timeoutMs - 1
        && deadline.firedAt <= deadline.cancelledAt && deadline.aborted === true && life.close.startedAt >= deadline.firedAt, "invalid-deadline-abort");
      closed = false;
    }
  }
  keys(timing, ["schema", "clock", "timeOrigin", "mount", "operations"]);
  need(timing.schema === "client-heavy-timing/v1" && timing.clock === "browser-performance" && Array.isArray(timing.operations), "invalid-browser-timing");
  const records = pass.capture.records ?? pass.failure?.records;
  need(Array.isArray(records), "missing-raw-records");
  const inContext = (at) => need(finite(at) && life.contextCreatedAt !== null && finite(timing.timeOrigin)
    && timing.timeOrigin + at >= nodeOrigin + life.contextCreatedAt - 1
    && timing.timeOrigin + at <= nodeOrigin + (deadline.firedAt === null ? life.close.startedAt : life.close.endedAt) + 1, "browser-clock-outside-context");
  for (const record of records) inContext(record.at);
  let readyMs = null;
  const actions = [];
  if (timing.mount === null) need(timing.operations.length === 0 && (timing.timeOrigin === null || finite(timing.timeOrigin)), "operations-without-mount");
  else {
    need(finite(timing.timeOrigin), "missing-browser-clock-origin");
    keys(timing.mount, ["startedAt", "endedAt", "recordAt", "recordIndex"]); span(timing.mount);
    const mount = timing.mount;
    need(mount.recordIndex === 1 && records[1]?.kind === "initial" && mount.recordAt === records[1].at
      && mount.startedAt >= records[0].at - 0.01 && mount.startedAt <= mount.recordAt + 0.01 && mount.endedAt >= mount.recordAt - 0.01
      && (records[2] ? mount.endedAt <= records[2].at + 0.01 : pass.failure?.phase === "readiness"), "mount-clock-differs-from-observation");
    inContext(mount.startedAt); inContext(mount.endedAt);
    readyMs = mount.endedAt - mount.startedAt;
    let previous = records[2]?.at;
    for (const [i, sample] of timing.operations.entries()) {
      keys(sample, ["operation", "startedAt", "endedAt", "timeOrigin", "recordAt", "recordIndex"]); span(sample);
      const index = 3 + i, record = records[index], op = workload.operations[i];
      need(op && sample.operation === op.id && sample.timeOrigin === timing.timeOrigin && sample.recordIndex === index
        && (record ? record.kind === "operation" && sample.recordAt === record.at
          : pass.failure?.phase === op.id && i === timing.operations.length - 1 && index === records.length)
        && finite(sample.recordAt) && sample.startedAt >= previous - 0.01
        && sample.endedAt <= sample.recordAt + 0.01 && sample.endedAt >= previous - 0.01, "operation-clock-differs-from-observation");
      inContext(sample.startedAt); inContext(sample.endedAt); inContext(sample.recordAt);
      previous = sample.recordAt;
      actions.push({ operation: op.id, kind: op.kind, elapsedMs: sample.endedAt - sample.startedAt });
    }
    const recorded = records.filter((r) => r.kind === "operation").length;
    need(timing.operations.length === recorded || (pass.failure?.phase === workload.operations[recorded]?.id
      && timing.operations.length === recorded + 1), "missing-raw-operation-clocks");
  }
  const functional = oracle.functionalPassed === true, passed = functional && closed;
  if (functional) need(readyMs !== null && actions.length === workload.operations.length, "incomplete-success-timing");
  if (passed) need(pass.readyMs === readyMs && same(pass.actions, phase === "measurement" ? actions : null), "timings-differ-from-endpoint-recomputation");
  else need(pass.readyMs === null && pass.actions === null, "failed-pass-has-timings");
  // Reuse the reviewed legacy structural/partial-record checks, not its proof
  // policy or scalar timings. These temporary fields never escape as measurements.
  const { timing: _timing, lifecycle: _lifecycle, requests: _requests, ...legacy } = pass;
  if (functional && !closed) { legacy.readyMs = readyMs; legacy.actions = phase === "measurement" ? actions : null; }
  if (pass.failure?.phase === "context") {
    need(pass.capture.outcome === "failed" && pass.capture.reason === "native-context-failed", "invalid-context-failure");
    legacy.capture = { ...pass.capture, reason: "native-load-failed" };
    legacy.oracle = validateClientCapture(workload, legacy.capture, settings);
    legacy.failure = { ...pass.failure, phase: "load" };
  }
  const checked = replay(legacy, app, phase, workload, settings, timeoutMs);
  return { oracle, passed, closurePassed: closed, derived: checked.derived,
    timings: passed ? { readyMs, actions: phase === "measurement" ? actions : null } : null,
    requests: functional ? records.flatMap((r) => r.network ?? []) : null };
}
