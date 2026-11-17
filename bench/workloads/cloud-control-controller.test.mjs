// Real controller with fake argv transport/provider responses. No host operations.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { harness } from "./cloud-fixtures.mjs";
import { controlRequest, guardianSha256 } from "./cloud-control-runtime.mjs";
import { bootstrapMarker, remoteFiles } from "./cloud-remote.mjs";
import { reservation, validateState } from "./cloud-contract.mjs";
import { digest } from "./cloud-local.mjs";

async function liveMonitor(h) {
  const pending = h.launch().launch();
  for (let i = 0; i < 100 && (!existsSync(h.statePath) || h.saved().control?.monitor?.phase !== "live"); i++)
    await new Promise(setImmediate);
  assert.equal(h.saved().control.monitor.phase, "live"); return { pending };
}

test("foreground timeout permanently marks the monitor invalid without releasing custody", async (t) => {
  const h = harness(t, { active: true, monitorHold: true });
  const pending = h.launch({ run(...args) {
    const result = h.run(...args);
    if (result.monitor) result.monitor.done = result.monitor.done.then(() => {
      throw Object.assign(new Error("uncertain foreground completion"), { controlTreeUncertain: true });
    });
    return result;
  } }).launch();
  for (let i = 0; i < 100 && !h.flags.completeMonitor; i++) await new Promise(setImmediate);
  assert.equal(typeof h.flags.completeMonitor, "function");
  h.flags.completeMonitor(false); await assert.rejects(pending, (error) => error.controlTreeUncertain === true);
  assert.equal(h.saved().control.monitor.phase, "invalid");
  assert.ok(existsSync(join(h.local, "operation.lock"))); assert.ok(existsSync(join(h.base, ".groups-launch.lock")));
  assert.equal(h.deletes, 0); assert.equal(await h.task().collect(), 3);
});

test("routine live collection reads the existing monitor journal without provider calls, SSH or new channels", async (t) => {
  const h = harness(t, { active: true, monitorHold: true }), { pending } = await liveMonitor(h);
  const calls = h.calls.length;
  try { assert.equal(await h.task().collect(), 3); assert.equal(h.calls.length, calls); assert.equal(h.deletes, 0); }
  finally { h.flags.completeMonitor(); await pending; }
  assert.ok(!existsSync(join(h.local, "operation.lock")));
  const after = h.calls.length; assert.equal(await h.task().collect(), 3); assert.equal(h.calls.length, after, "local close embargo is not remote terminal proof");
});

for (const ending of ["lost", "timeout", "terminal"]) test("cancelled monitor records its actual ending: " + ending, async (t) => {
  const h = harness(t, { active: true, monitorHold: true });
  const pending = h.launch({ run(...args) {
    const result = h.run(...args);
    if (result.monitor) result.monitor.done = result.monitor.done.then(value => {
      h.flags.cancelled = true;
      if (ending === "timeout") throw Object.assign(new Error("foreground timed out"), { controlTreeUncertain: true });
      return value;
    });
    return result;
  } }).launch();
  for (let i = 0; i < 100 && (!existsSync(h.statePath) || !h.saved().control.sealed.includes("bootstrap")); i++) await new Promise(setImmediate);
  assert.ok(h.saved().control.sealed.includes("bootstrap"));
  const calls = h.calls.length, terminal = ending === "terminal";
  h.flags.completeMonitor(terminal);
  await assert.rejects(pending, e => terminal ? /controller cancelled/.test(e.message) : e.controlTreeUncertain === true);
  assert.equal(h.calls.length, calls);
  assert.equal(h.saved().control.monitor.phase, terminal ? "closed" : "invalid");
  assert.equal(existsSync(join(h.local, "operation.lock")), !terminal);
  assert.equal(existsSync(join(h.base, ".groups-launch.lock")), !terminal);
  assert.equal(await h.task({ interrupted: () => false }).collect(), 3);
  assert.equal(h.deletes, 0);
});

test("lost monitor retains launch and operation custody; failed-only recovery waits for local closure and lease invalidation", async (t) => {
  const h = harness(t, { active: true, monitorHold: true }), { pending } = await liveMonitor(h);
  h.flags.completeMonitor(false); await assert.rejects(pending, (error) => error.controlTreeUncertain === true);
  assert.equal(h.saved().control.monitor.phase, "invalid");
  assert.ok(existsSync(join(h.local, "operation.lock"))); assert.ok(existsSync(join(h.base, ".groups-launch.lock")));
  const calls = h.calls.length; assert.equal(await h.task().collect(), 3); assert.equal(h.calls.length, calls);
  const path = join(h.local, "monitor-local-closed.json"), closed = JSON.parse(readFileSync(path)); closed.closedAtMs = Date.now() - 30001; closed.recoverAfterMs = closed.closedAtMs + 30000;
  writeFileSync(path, JSON.stringify(closed));
  assert.equal(await h.task().collect(), 3); assert.equal(h.units, 3); assert.equal(h.deletes, 0);
  assert.ok(existsSync(join(h.local, "operation.lock"))); assert.ok(!existsSync(join(h.local, "stream-recovery.lock")));
});

test("supervised audit publication refuses without the production locked approval checkpoint", async (t) => {
  const h = harness(t, { active: true, monitorHold: true }), { pending } = await liveMonitor(h);
  const calls = h.calls.length;
  try {
    const task = h.task({}, { collect: undefined, deliverAudit: join(h.temp, "delivery.json"),
      campaign: "r21-" + "a".repeat(16), approveSubject: "b".repeat(64) });
    await assert.rejects(task.deliverAudit(), /locked approval checkpoint/);
    assert.equal(h.calls.length, calls); assert.equal(h.deletes, 0);
    assert.ok(existsSync(join(h.local, "operation.lock")));
  } finally { h.flags.completeMonitor(); await pending; }
});

test("supervised audit binds publication bytes after the awaited locked checkpoint and refuses ended monitoring", async (t) => {
  for (const changed of ["delivery", "reservation", "invalid", "terminal"]) {
    const h = harness(t, { active: true, monitorHold: true }), { pending } = await liveMonitor(h);
    const path = join(h.temp, "delivery.json"); writeFileSync(path, "{}");
    const approved = { reservationSha256: digest(readFileSync(h.statePath)), deliverySha256: digest(readFileSync(path)) }, calls = h.calls.length;
    try {
      const task = h.task({ async authorizeAudit() {
        assert.ok(existsSync(join(h.local, "audit-delivery.lock")));
        if (changed === "delivery") writeFileSync(path, "{ }");
        else if (changed === "reservation") h.change((s) => { s.auditIntents = {}; });
        else writeFileSync(join(h.local, "monitor-" + changed + ".json"), "{}");
        return approved;
      } }, { collect: undefined, deliverAudit: path, campaign: "r21-" + "a".repeat(16), approveSubject: "b".repeat(64) });
      await assert.rejects(task.deliverAudit(), changed === "delivery" ? /locked audit delivery changed/ : changed === "reservation" ? /locked audit reservation changed/ : /progress/);
      assert.ok(!existsSync(join(h.local, "monitor-delivery-json-api.json")));
      assert.ok(!existsSync(join(h.local, "audit-delivery.lock"))); assert.ok(existsSync(join(h.local, "operation.lock")));
      assert.equal(h.calls.length, calls); assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
    } finally { h.flags.completeMonitor(); await pending; }
  }
});

test("closed monitor cannot delete running work or duplicate a host; terminal evidence permits exactly one cleanup", async (t) => {
  const h = harness(t, { active: true }); await h.launch().launch();
  await assert.rejects(h.launch().launch()); assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
  const path = join(h.local, "monitor-local-closed.json"), closed = JSON.parse(readFileSync(path));
  closed.closedAtMs = Date.now() - 30001; closed.recoverAfterMs = closed.closedAtMs + 30000;
  writeFileSync(path, JSON.stringify(closed));
  assert.equal(await h.task().collect(), 3); assert.equal(h.deletes, 0);
  h.flags.active = false;
  assert.equal(await h.task().collect(), 1); assert.equal(h.deletes, 1);
  assert.ok(h.saved().archiveSha256 && h.saved().evidenceSha256 && h.saved().destroyedAt);
  assert.equal(h.saved().fullGroupQualified, false);
  assert.equal(await h.task().collect(), 1); assert.equal(h.deletes, 1);
});

test("terminal monitor and archived native campaign must agree before deletion", async (t) => {
  for (const patch of [{ campaign: "r21-" + "f".repeat(16) }, { sealSha256: "e".repeat(64) }]) {
    const h = harness(t, { active: true }); await h.launch().launch();
    const path = join(h.local, "monitor-terminal.json"), closedPath = join(h.local, "monitor-local-closed.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path)), ...patch }));
    const closed = JSON.parse(readFileSync(closedPath)); closed.closedAtMs = Date.now() - 31000;
    closed.recoverAfterMs = closed.closedAtMs + 30000; writeFileSync(closedPath, JSON.stringify(closed));
    h.flags.active = false;
    await assert.rejects(h.task().collect()); assert.equal(h.deletes, 0); assert.equal(h.saved().deletionIntentAt, undefined);
    assert.ok(h.saved().archiveSha256 && h.saved().evidenceSha256);
  }
});

test("a closed supervised reservation refuses legacy or differently registered inspections", async (t) => {
  const h = harness(t, { active: true }); await h.launch().launch(); h.flags.active = false;
  const path = join(h.local, "monitor-local-closed.json"), closed = JSON.parse(readFileSync(path));
  closed.closedAtMs = Date.now() - 31000; closed.recoverAfterMs = closed.closedAtMs + 30000;
  writeFileSync(path, JSON.stringify(closed));
  for (const legacy of [true, false]) {
    await assert.rejects(h.task({ inspect: async () => {
      const s = structuredClone(h.report());
      if (legacy) delete s.supervisedTerminal;
      else s.supervisedTerminal.registrationSha256 = "f".repeat(64);
      return s;
    } }).collect());
    assert.equal(h.deletes, 0); assert.equal(h.saved().deletionIntentAt, undefined);
  }
});

test("controller persists earliest SSH and every SFTP intent before spawn, then seals including itself", async (t) => {
  const h = harness(t, { active: true }), controls = [];
  const state = await h.launch({ run(binary, args, timeout, allowFail, expiry, registration) {
    if (registration?.stream) {
      assert.equal(h.saved().control.monitor.phase, "pending"); assert.deepEqual(h.saved().control.sealed, []);
      assert.equal(registration.expected.id, h.saved().control.monitor.id);
    } else if (["ssh", "scp"].includes(binary)) {
      const saved = h.saved(), row = saved.control.ledger.at(-1);
      assert.equal(row.localTerminal, false); assert.deepEqual(row.request, registration.request);
      assert.equal(registration.request.helperSha256, guardianSha256);
      controls.push({ binary, script: args.at(-1), request: registration.request, command: registration.command });
    }
    return h.run(binary, args, timeout, allowFail, expiry, registration);
  } }).launch();
  assert.equal(controls[0].script, "true"); assert.equal(controls[0].request.sequence, 0);
  assert.ok(controls[0].command.includes(" -c "));
  assert.ok(controls.filter((c) => c.binary === "scp").length === 3);
  assert.ok(controls.slice(1).every((c) => !c.command.includes(" -c ")));
  assert.deepEqual(state.control.sealed, ["bootstrap"]);
  assert.ok(state.control.ledger.every((row) => row.localTerminal));
  const final = controls.at(-1); assert.equal(final.script, ":");
  assert.deepEqual(final.request.seal.map((r) => r.id), controls.map((c) => c.request.invocation.id));
  assert.equal(final.request.seal.at(-1).id, final.request.invocation.id);
  assert.equal(state.bootstrapReady, undefined, "legacy-shaped all-group state cannot borrow fleet-only admission metadata");
  assert.ok(!existsSync(join(h.local, "operation.lock")));
});

test("ambiguous earliest SSH preserves its pre-spawn intent, both locks and the host without retry", async (t) => {
  const h = harness(t, { active: true }); let ssh = 0;
  await assert.rejects(h.launch({ run(binary, ...args) {
    if (binary === "ssh") { ssh++; throw Object.assign(new Error("synthetic disconnect"), { controlTreeUncertain: true }); }
    return h.run(binary, ...args);
  } }).launch(), (error) => error.controlTreeUncertain === true);
  assert.equal(ssh, 1); assert.equal(h.saved().control.ledger.length, 1);
  assert.equal(h.saved().control.ledger[0].localTerminal, false);
  assert.ok(existsSync(join(h.local, "operation.lock"))); assert.ok(existsSync(join(h.base, ".groups-launch.lock")));
  assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
});

test("sealed native collection refuses before SSH instead of turning an authorized status poll into an intrusion", async (t) => {
  const h = harness(t, { active: true });
  await h.launch().launch();
  h.change((s) => { delete s.control.monitor; }); // Preserve explicit v4 behavior, not a supervised campaign.
  const saved = h.saved(), calls = h.calls.length;
  await assert.rejects(h.task().collect(), /terminal status unavailable without SSH intrusion/);
  assert.deepEqual(h.saved(), saved);
  assert.ok(h.calls.slice(calls).every(([binary]) => !["ssh", "scp"].includes(binary)));
  assert.equal(h.deletes, 0); assert.ok(!existsSync(join(h.local, "operation.lock")));
});

test("legacy live collection retains its existing single status observation", async (t) => {
  const h = harness(t, { active: true }); h.seed();
  assert.equal(await h.task().collect(), 3); assert.equal(h.units, 1);
  assert.equal(h.deletes, 0);
});

test("new custody and marker are source-bound while legacy generated bytes keep their schema", () => {
  const legacy = reservation({ round: "r21", commit: "a".repeat(40), token: "0123456789abcdef" });
  const state = { ...legacy, control: { schema: "benchmark-control-ledger/v1", helperSha256: guardianSha256, ledger: [], sealed: [] } };
  assert.equal(bootstrapMarker(legacy).schema, "benchmark-common-bootstrap/v1");
  assert.ok(!remoteFiles(legacy)["pack.sh"].includes("control-"));
  assert.equal(bootstrapMarker(state).controlHelperSha256, guardianSha256);
  const pack = remoteFiles(state)["pack.sh"];
  assert.ok(pack.includes("custody")); assert.ok(pack.includes("files+=('control')"));
  const request = controlRequest(state, "ssh", ["root@192.0.2.10", ":"], 30000, "bootstrap");
  state.control.ledger.push({ request, localTerminal: false }); validateState(state, state.round);
  for (const mutate of [
    (s) => { s.control.ledger[0].request.invocation.token = "f".repeat(16); },
    (s) => { s.control.ledger[0].request.sequence = 1; },
    (s) => { s.control.ledger[0].request.invocation.deadlineMs = 900001; },
    (s) => { s.control.ledger[0].request.invocation.channel = "scp"; },
    (s) => { s.control.sealed.push("bootstrap"); },
    (s) => { s.control.ledger[0].request.seal = []; },
  ]) { const changed = structuredClone(state); mutate(changed); assert.throws(() => validateState(changed, state.round)); }
});
