import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { groupCampaignSchema, jsonPhase, mixedPhase, offlineAuditRemainingMs } from "./campaign-contract.mjs";
import { readRegular, supportedGroups } from "./evidence.mjs";
import { executionGroups } from "./native-replay.mjs";
import { liveGroup } from "./native-roles.mjs";

export function readCampaignJournal(root, plan, id, paths = readdirSync(root)) {
  const names = paths.filter((name) => /^\d{5}-[a-z-]+\.json$/.test(name)).sort();
  assert.ok(names.length > 0, "durable campaign journal missing");
  const records = names.map((name, sequence) => {
    const file = join(root, name), bytes = readRegular(file), event = JSON.parse(bytes);
    assert.equal(event.schema, "benchmark-isolated-campaign-event/v1"); assert.equal(event.sequence, sequence);
    assert.equal(event.campaign, id); assert.equal(event.round, plan.round); assert.equal(event.campaignSha256, plan.campaignSha256);
    assert.equal(name, `${String(sequence).padStart(5, "0")}-${event.kind}.json`);
    return { file, bytes, event };
  });
  return records;
}

// The producer inspects native output after the phase seal but before group
// completion. Replay that prefix using the same ordering as a saved campaign.
export function replaySealedPhase(root, plan, id, group, key) {
  const records = readCampaignJournal(root, plan, id);
  const seals = records.filter(({ event }) => event.kind === "phase-sealed" && event.group === group && event.phase === "timing");
  assert.equal(seals.length, 1, "live phase lacks its unique journal seal");
  const { status, sequence } = seals[0].event;
  assert.ok([3, 4, 5, 6].includes(status?.executionVersion), "live phase lacks a supported campaign seal");
  if (status.executionVersion === 6) assert.equal(plan.schema, groupCampaignSchema);
  assert.equal(status.state, "active"); assert.equal(status.nextGroup, group);
  const prefix = records.slice(0, sequence + 1);
  const events = prefix.map(({ event }) => {
    const embedded = event.status;
    assert.equal(embedded.schema, "benchmark-isolated-campaign-status/v1");
    assert.equal(embedded.campaign, id); assert.equal(embedded.round, plan.round);
    assert.equal(embedded.campaignSha256, plan.campaignSha256);
    assert.equal(embedded.executionVersion, status.executionVersion);
    return event;
  });
  const phase = replayJournal(plan, id, events, status, key);
  return { phase, version: status.executionVersion, verifyUnchanged() {
    for (const { file, bytes } of prefix) assert.ok(readRegular(file).equals(bytes), "live phase journal mutated");
  } };
}

// Recorded authorization/review events constrain order; they confer no authority.
export function replayJournal(plan, id, events, status, throughPhase) {
  const groups = [2, 3, 4, 5, 6].includes(status.executionVersion) ? executionGroups : supportedGroups;
  assert.ok(status.executionVersion === undefined || [2, 3, 4, 5, 6].includes(status.executionVersion));
  const controlAdmissions = new Map();
  let streamSeal, offlineAuditExpired;
  let authorized = false, started = false, terminal = false, index = 0, phase = null, command = null, review = "none", commandNumber = 0;
  const phases = new Map(), failedGroups = new Set(), completed = new Map();
  let reviewNeeded = null, auditStaged = null;
  let mixedReviewNeeded = null, mixedAuditStaged = null;
  const blockedOnlyByProbes = (row) => status.executionVersion === 6 && row.outcome === "blocked"
    && row.report?.timingBlockedByPreLoginProbes === true;
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
        case "control-admitted": {
          assert.ok([4, 5, 6].includes(status.executionVersion), "legacy journal cannot claim registered session proof");
          assert.ok(!controlAdmissions.has(event.epoch), "control epoch admitted twice");
          if (status.executionVersion === 5 && event.epoch !== "bootstrap") assert.equal(event.channel, "stream");
          else assert.equal(event.channel, undefined);
          if (event.epoch === "bootstrap") assert.equal(started, false);
          else {
            assert.deepEqual(event.binding, controlAdmissions.get("bootstrap")?.binding, "control epoch belongs to another reservation/source");
            assert.equal(event.epoch, `audit-${plan.order[index]}`);
            assert.ok(event.epoch === "audit-json-api" ? review === "waiting" : mixedReviewNeeded && !mixedAuditStaged);
          }
          assert.equal(event.path, event.epoch === "bootstrap" ? "control-bootstrap.json" : `control-${event.epoch}.json`);
          assert.match(event.sha256 ?? "", /^[a-f0-9]{64}$/);
          assert.equal(event.binding.round, plan.round); assert.equal(event.binding.commit, plan.commit);
          controlAdmissions.set(event.epoch, event); break;
        }
        case "started":
          if ([4, 5, 6].includes(status.executionVersion)) assert.ok(controlAdmissions.has("bootstrap"), "bootstrap control seal missing");
          assert.equal(started, false); assert.equal(phases.size, 0); started = true; break;
        case "native-output-reserved": {
          assert.equal(started, true); assert.equal(event.group, plan.order[index]); assert.ok(groups.includes(event.group));
          assert.ok(event.phase === "timing" || (event.group === "json-api" && event.phase === "prepare"));
          if (phase) { phaseComplete(); assert.equal(phase.phase, "prepare"); assert.equal(review, "accepted"); }
          if (event.group === "json-api") assert.equal(event.phase, review === "accepted" ? "timing" : "prepare");
          if ([3, 4, 5, 6].includes(status.executionVersion) && event.group === "mixed-production") assert.ok(mixedReviewNeeded && mixedAuditStaged);
          const binding = event.group === "json-api" ? jsonPhase(plan, event.phase, `/bench/campaign/${id}/json-native-audits.json`)
            : [3, 4, 5, 6].includes(status.executionVersion) && event.group === "mixed-production" ? mixedPhase(plan, id) : plan.bindings[index];
          assert.equal(event.artifactRoot, binding.validation.artifactRoot);
          const key = `${String(index).padStart(2, "0")}-${event.group}-${event.phase}`;
          assert.equal(phases.has(key), false, "native phase repeated");
          if (Object.hasOwn(event, "transferDestination")) {
            assert.ok(liveGroup(event.group) && event.phase === "timing");
            assert.equal(event.transferDestination, `${key}/native`, "pending transfer destination differs from phase");
          }
          phase = { key, group: event.group, phase: event.phase, binding, invocations: [...binding.preparation.fixtures, binding.execution.invocation],
            results: [], logs: [], count: 0, transferDestination: event.transferDestination };
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
          assert.equal(event.transferDestination, phase.transferDestination);
          assert.match(event.nativeManifestSha256 ?? "", /^[a-f0-9]{64}$/);
          if ([2, 3, 4, 5, 6].includes(status.executionVersion)) assert.match(event.phaseManifestSha256 ?? "", /^[a-f0-9]{64}$/);
          phase.phaseManifestSha256 = event.phaseManifestSha256;
          phase.manifestSha256 = event.nativeManifestSha256; phase.sealed = true;
          if (phase.key === throughPhase) return phase;
          break;
        case "review-needed":
          phaseComplete(); assert.equal(phase.group, "json-api"); assert.equal(phase.phase, "prepare"); assert.equal(review, "none");
          assert.equal(phase.results.length, phase.invocations.length); assert.ok(expectedAuditExit(phase, phase.results.at(-1)));
          assert.match(event.subjectSha256 ?? "", /^[a-f0-9]{64}$/);
          assert.equal(event.nativeExit, 1); assert.equal(event.qualification, "blocked");
          reviewNeeded = event; review = "waiting"; break;
        case "audit-staged":
          if ([4, 5, 6].includes(status.executionVersion)) assert.ok(controlAdmissions.has("audit-json-api"), "audit control seal missing");
          assert.equal(review, "waiting"); assert.ok(!command); auditStaged = event; review = "accepted"; break;
        case "mixed-review-needed":
          assert.ok([3, 4, 5, 6].includes(status.executionVersion)); assert.equal(started, true);
          assert.equal(plan.order[index], "mixed-production"); assert.equal(phase, null); assert.equal(command, null);
          assert.equal(mixedReviewNeeded, null); assert.match(event.subjectSha256 ?? "", /^[a-f0-9]{64}$/);
          mixedReviewNeeded = event; break;
        case "mixed-audit-staged":
          if ([4, 5, 6].includes(status.executionVersion)) assert.ok(controlAdmissions.has("audit-mixed-production"), "mixed control seal missing");
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
            if (failedGroups.has(event.group)) assert.ok(event.outcome === "failed" || blockedOnlyByProbes(event)
              || ([2, 3, 4, 5, 6].includes(status.executionVersion) && event.outcome === "native-validated"), "failed command promoted without native replay");
            const field = phase.phase === "prepare" ? "manifest" : "nativeManifestSha256";
            assert.match(event[field] ?? "", /^[a-f0-9]{64}$/);
            assert.equal(saved[field], event[field]);
            if (phase.sealed) assert.equal(event[field], phase.manifestSha256, "group outcome differs from collected phase seal");
            if (phase.phase === "prepare") { assert.equal(event.phase, "prepare"); assert.equal(saved.phase, "prepare"); }
            phase.manifestSha256 = event[field];
          } else { assert.equal(phase, null); assert.equal(event.outcome, "not-run"); }
          completed.set(event.group, event.outcome); index++; phase = null; review = "none"; break;
        }
        case "stream-sealed":
          assert.equal(status.executionVersion, 5); assert.equal(streamSeal, undefined);
          assert.equal(started, true); assert.equal(index, plan.order.length); assert.equal(phase, null); assert.equal(command, null);
          assert.equal(event.path, "control-stream-seal.json"); assert.match(event.sha256, /^[a-f0-9]{64}$/);
          assert.deepEqual(event.binding, controlAdmissions.get("bootstrap").binding); streamSeal = event; break;
        case "finished":
          if (status.executionVersion === 5) assert.ok(streamSeal, "supervised campaign lacks stream seal");
          assert.equal(started, true); assert.equal(index, plan.order.length); assert.equal(phase, null); assert.equal(command, null);
          assert.equal(status.state, "finished"); assert.deepEqual(status.uncollectedNativeRoots, []); terminal = true; break;
        case "offline-audit-expired": {
          assert.equal(status.executionVersion, 6);
          assert.equal(plan.order.length, 1);
          const group = plan.order[index], waiting = group === "json-api" ? reviewNeeded : mixedReviewNeeded;
          assert.ok(["json-api", "mixed-production"].includes(group) && waiting);
          assert.equal(event.group, group); assert.equal(event.subjectSha256, waiting.subjectSha256);
          assert.equal(offlineAuditRemainingMs(waiting.auditClock, event.auditClock, waiting.auditClock?.bootId), 0, "premature audit expiry");
          assert.ok(!auditStaged && !mixedAuditStaged && !command && !completed.size);
          assert.deepEqual([...controlAdmissions.keys()], ["bootstrap"]);
          assert.deepEqual(status.uncollectedNativeRoots, []);
          if (group === "json-api") {
            assert.equal(review, "waiting"); assert.ok(phase?.sealed && phase.phase === "prepare" && phases.size === 1); phaseComplete();
          } else assert.ok(!phase && phases.size === 0);
          offlineAuditExpired = { group, subjectSha256: waiting.subjectSha256 };
          // Same retained dispositions as a generic halt, with a stronger, replayed reason.
        }
        // falls through
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
  assert.equal(throughPhase, undefined, "requested live phase seal missing from journal prefix");
  assert.equal(terminal, true, "terminal journal event missing");
  for (const group of failedGroups) assert.ok(status.outcomes.some((r) => r.group === group &&
    (["failed", "preserved-uncertain"].includes(r.outcome) || blockedOnlyByProbes(r)
      || [2, 3, 4, 5, 6].includes(status.executionVersion) && r.outcome === "native-validated")));
  const pending = [], seen = new Set();
  for (const item of status.uncollectedNativeRoots) {
    const recorded = [...phases.values()].find((p) => p.group === item.group && p.phase === item.phase);
    assert.ok(recorded && !seen.has(recorded.key));
    const expected = { group: recorded.group, phase: recorded.phase, artifactRoot: recorded.binding.validation.artifactRoot,
      ...(recorded.transferDestination ? { transferDestination: recorded.transferDestination } : {}) };
    assert.deepEqual(item, expected);
    seen.add(recorded.key); pending.push(expected);
  }
  for (const recorded of phases.values()) if (recorded.transferDestination)
    assert.equal(seen.has(recorded.key), !recorded.sealed, "transfer must stay pending until its phase seal");
  const incomplete = !!command || [...phases.values()].some((p) => p.results.some((r) => !r.terminal)
    || (p.count < p.invocations.length && p.results.at(-1)?.success !== false));
  if (incomplete) { assert.equal(status.state, "preserved-uncertain"); assert.ok(phase && seen.has(phase.key)); }
  return { phases, completed, reviewNeeded, auditStaged, mixedReviewNeeded, mixedAuditStaged, controlAdmissions, streamSeal,
    offlineAuditExpired, processFailure: [...failedGroups].some((group) => !status.outcomes.some((row) => row.group === group && blockedOnlyByProbes(row))),
    incomplete, pending };
}
