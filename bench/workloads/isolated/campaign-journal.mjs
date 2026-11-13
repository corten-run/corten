import assert from "node:assert/strict";
import { jsonPhase, mixedPhase } from "./campaign-contract.mjs";
import { supportedGroups } from "./evidence.mjs";
import { executionGroups } from "./native-replay.mjs";

// Recorded authorization/review events constrain order; they confer no authority.
export function replayJournal(plan, id, events, status) {
  const groups = [2, 3].includes(status.executionVersion) ? executionGroups : supportedGroups;
  assert.ok(status.executionVersion === undefined || [2, 3].includes(status.executionVersion));
  let authorized = false, started = false, terminal = false, index = 0, phase = null, command = null, review = "none", commandNumber = 0;
  const phases = new Map(), failedGroups = new Set(), completed = new Map();
  let reviewNeeded = null, auditStaged = null;
  let mixedReviewNeeded = null, mixedAuditStaged = null;
  const expectedAuditExit = (p, exit) => p?.group === "json-api" && p.phase === "prepare"
    && p.count === p.invocations.length
    && exit?.terminal === true && exit.code === 1 && !exit.cancelled && !exit.forced && exit.error === null;
  function phaseComplete() {
    assert.ok(phase && !command && phase.results.length > 0);
    const last = phase.results.at(-1);
    assert.ok(phase.results.length === phase.invocations.length || !last.success);
    assert.ok(phase.results.every((r) => r.terminal && !r.cancelled && !r.forced));
  }
  for (const event of events) {
    assert.equal(terminal, false, "journal continues after terminal event");
    if (event.kind === "authorized") {
      assert.equal(authorized, false); assert.equal(event.sequence, 0); authorized = true;
    } else {
      assert.equal(authorized, true, "journal lacks initial authorization record");
      switch (event.kind) {
        case "started":
          assert.equal(started, false); assert.equal(phases.size, 0); started = true; break;
        case "native-output-reserved": {
          assert.equal(started, true); assert.equal(event.group, plan.order[index]); assert.ok(groups.includes(event.group));
          assert.ok(event.phase === "timing" || (event.group === "json-api" && event.phase === "prepare"));
          if (phase) { phaseComplete(); assert.equal(phase.phase, "prepare"); assert.equal(review, "accepted"); }
          if (event.group === "json-api") assert.equal(event.phase, review === "accepted" ? "timing" : "prepare");
          if (status.executionVersion === 3 && event.group === "mixed-production") assert.ok(mixedReviewNeeded && mixedAuditStaged);
          const binding = event.group === "json-api" ? jsonPhase(plan, event.phase, `/bench/campaign/${id}/json-native-audits.json`)
            : status.executionVersion === 3 && event.group === "mixed-production" ? mixedPhase(plan, id) : plan.bindings[index];
          assert.equal(event.artifactRoot, binding.validation.artifactRoot);
          const key = `${String(index).padStart(2, "0")}-${event.group}-${event.phase}`;
          assert.equal(phases.has(key), false, "native phase repeated");
          phase = { key, group: event.group, phase: event.phase, binding, invocations: [...binding.preparation.fixtures, binding.execution.invocation],
            results: [], logs: [], count: 0 };
          phases.set(key, phase); break;
        }
        case "command-intent":
          assert.ok(phase && !command); assert.equal(event.group, phase.group);
          assert.equal(phase.sealed, undefined, "command follows sealed phase");
          assert.ok(!phase.results.length || phase.results.at(-1).success, "command follows failed or cancelled command");
          assert.ok(phase.count < phase.invocations.length); assert.deepEqual(event.invocation, phase.invocations[phase.count++]);
          phase.logs.push(`${phase.key}/command-${commandNumber}.log`); command = { started: false, number: commandNumber++ }; break;
        case "command-started":
          assert.ok(command && !command.started); assert.ok(event.pid === null || (Number.isSafeInteger(event.pid) && event.pid > 0));
          command.started = true; command.pid = event.pid; break;
        case "command-exited": {
          assert.ok(command && phase, "command exit lacks matching intent");
          for (const field of ["terminal", "success", "cancelled", "forced"]) assert.equal(typeof event[field], "boolean");
          assert.ok(event.code === null || Number.isSafeInteger(event.code)); assert.ok(event.error === null || typeof event.error === "string");
          // A synchronous spawn exception has no start record or exit code. It may
          // retain a failed prefix, never substitute for a successful command.
          assert.ok(command.started || (event.terminal && event.code === null && typeof event.error === "string" && event.error.length > 0));
          assert.equal(event.success, event.terminal && event.code === 0 && !event.cancelled && !event.forced && event.error === null);
          if (!event.success && !expectedAuditExit(phase, event)) failedGroups.add(phase.group);
          if (event.hostManifestSha256 !== undefined) assert.match(event.hostManifestSha256, /^[a-f0-9]{64}$/);
          phase.results.push({ ...event, number: command.number, pid: command.pid }); command = null; break;
        }
        case "phase-sealed":
          assert.ok(phase && !command && phase.results.length > 0 && phase.results.every((r) => r.terminal));
          assert.equal(phase.sealed, undefined, "phase sealed twice");
          assert.equal(event.group, phase.group); assert.equal(event.phase, phase.phase);
          assert.equal(event.artifactRoot, phase.binding.validation.artifactRoot);
          assert.match(event.nativeManifestSha256 ?? "", /^[a-f0-9]{64}$/);
          if ([2, 3].includes(status.executionVersion)) assert.match(event.phaseManifestSha256 ?? "", /^[a-f0-9]{64}$/);
          phase.phaseManifestSha256 = event.phaseManifestSha256;
          phase.manifestSha256 = event.nativeManifestSha256; phase.sealed = true; break;
        case "review-needed":
          phaseComplete(); assert.equal(phase.group, "json-api"); assert.equal(phase.phase, "prepare"); assert.equal(review, "none");
          assert.equal(phase.results.length, phase.invocations.length); assert.ok(expectedAuditExit(phase, phase.results.at(-1)));
          assert.match(event.subjectSha256 ?? "", /^[a-f0-9]{64}$/);
          assert.equal(event.nativeExit, 1); assert.equal(event.qualification, "blocked");
          reviewNeeded = event; review = "waiting"; break;
        case "audit-staged":
          assert.equal(review, "waiting"); assert.ok(!command); auditStaged = event; review = "accepted"; break;
        case "mixed-review-needed":
          assert.equal(status.executionVersion, 3); assert.equal(started, true);
          assert.equal(plan.order[index], "mixed-production"); assert.equal(phase, null); assert.equal(command, null);
          assert.equal(mixedReviewNeeded, null); assert.match(event.subjectSha256 ?? "", /^[a-f0-9]{64}$/);
          mixedReviewNeeded = event; break;
        case "mixed-audit-staged":
          assert.ok(mixedReviewNeeded); assert.equal(mixedAuditStaged, null); assert.equal(plan.order[index], "mixed-production");
          assert.equal(phase, null); assert.equal(command, null); mixedAuditStaged = event; break;
        case "group-finished": {
          assert.equal(started, true); assert.equal(event.group, plan.order[index]);
          const saved = status.outcomes[index]; assert.equal(event.outcome, saved.outcome);
          if (groups.includes(event.group)) {
            phaseComplete(); assert.equal(phase.group, event.group);
            assert.ok(["failed", "blocked", "native-validated"].includes(event.outcome));
            if (event.group === "json-api") {
              if (phase.phase === "prepare") { assert.equal(event.outcome, "failed"); assert.equal(review, "none"); }
              else assert.equal(review, "accepted");
            }
            if (failedGroups.has(event.group)) assert.ok(event.outcome === "failed" || ([2, 3].includes(status.executionVersion) && event.outcome === "native-validated"), "failed command promoted without native replay");
            const field = phase.phase === "prepare" ? "manifest" : "nativeManifestSha256";
            assert.match(event[field] ?? "", /^[a-f0-9]{64}$/);
            assert.equal(saved[field], event[field]);
            if (phase.sealed) assert.equal(event[field], phase.manifestSha256, "group outcome differs from collected phase seal");
            if (phase.phase === "prepare") { assert.equal(event.phase, "prepare"); assert.equal(saved.phase, "prepare"); }
            phase.manifestSha256 = event[field];
          } else { assert.equal(phase, null); assert.equal(event.outcome, "not-run"); }
          completed.set(event.group, event.outcome); index++; phase = null; review = "none"; break;
        }
        case "finished":
          assert.equal(started, true); assert.equal(index, plan.order.length); assert.equal(phase, null); assert.equal(command, null);
          assert.equal(status.state, "finished"); assert.deepEqual(status.uncollectedNativeRoots, []); terminal = true; break;
        case "halted":
          assert.equal(status.state, "preserved-uncertain");
          for (let i = index; i < plan.order.length; i++) {
            const outcome = status.outcomes[i].outcome;
            if (i === index && phase) assert.ok(["failed", "preserved-uncertain"].includes(outcome));
            else assert.equal(outcome, "not-run");
          }
          terminal = true; break;
        default: assert.fail("unknown campaign journal event");
      }
    }
  }
  assert.equal(terminal, true, "terminal journal event missing");
  for (const group of failedGroups) assert.ok(status.outcomes.some((r) => r.group === group &&
    (["failed", "preserved-uncertain"].includes(r.outcome) || [2, 3].includes(status.executionVersion) && r.outcome === "native-validated")));
  const pending = [], seen = new Set();
  for (const item of status.uncollectedNativeRoots) {
    assert.deepEqual(Object.keys(item).sort(), ["artifactRoot", "group", "phase"]);
    const recorded = [...phases.values()].find((p) => p.group === item.group && p.phase === item.phase);
    assert.ok(recorded && !seen.has(recorded.key)); assert.equal(item.artifactRoot, recorded.binding.validation.artifactRoot);
    seen.add(recorded.key); pending.push({ group: recorded.group, phase: recorded.phase, artifactRoot: recorded.binding.validation.artifactRoot });
  }
  const incomplete = !!command || [...phases.values()].some((p) => p.results.some((r) => !r.terminal)
    || (p.count < p.invocations.length && p.results.at(-1)?.success !== false));
  if (incomplete) { assert.equal(status.state, "preserved-uncertain"); assert.ok(phase && seen.has(phase.key)); }
  return { phases, completed, reviewNeeded, auditStaged, mixedReviewNeeded, mixedAuditStaged, processFailure: failedGroups.size > 0, incomplete, pending };
}
