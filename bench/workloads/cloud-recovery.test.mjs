import assert from "node:assert/strict";
import fs, { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { accountId, commit, context, harness } from "./cloud-fixtures.mjs";
import { fleetPlan } from "./cloud-contract.mjs";
import { controlRequest } from "./cloud-control-runtime.mjs";
import { digest } from "./cloud-local.mjs";
import { productionPlan } from "./cloud-production.mjs";
import { interruptedFirstUpload as eligibleFirstUpload, unusedEvidence, unusedHostScript, verifyUnusedEvidence } from "./cloud-retirement.mjs";

test("a reconciled allocation is recovery evidence, not successful create completion", async (t) => {
  for (const failure of [{ createRejected: true }, { createLost: true }]) {
    const h = harness(t, { ...failure, active: true });
    await assert.rejects(h.launch().launch(), /create completion/);
    assert.equal(h.creates, 1); assert.equal(h.saved().status, "preparing");
    assert.equal(h.saved().id, "123");
    assert.equal(h.calls.some(([binary]) => binary === "ssh" || binary === "scp"), false);
    assert.equal(h.deletes, 0);
  }
});

test("collect retires a proved unused owned allocation without fabricating benchmark evidence", async (t) => {
  const h = harness(t, { missingUnit: true }); h.seed(); h.change((s) => { s.status = "preparing"; });
  assert.equal(await h.task().collect(), 1);
  const s = h.saved(); assert.equal(s.status, "retired"); assert.equal(s.retirement.kind, "unused");
  assert.ok(s.deletionIntentAt && s.destroyedAt); assert.equal(h.deletes, 1); assert.equal(h.inspections, 0);
  assert.equal(s.archiveSha256, undefined); assert.equal(s.validation, undefined); assert.equal(s.exitCode, undefined);
  assert.ok(existsSync(join(h.local, "unused-host.json")));
  assert.equal(await h.task().collect(), 1); assert.equal(h.deletes, 1, "a later collection only observes absence");
});

for (const key of ["deletionIntentAt", "destroyedAt"]) test(key === "deletionIntentAt"
  ? "a torn unused intent save leaves its own stage and no intent, and the next collect deletes once on a fresh proof"
  : "a torn unused destroyedAt save leaves its own stage after the one DELETE, and the next collect only confirms absence", async (t) => {
  const h = harness(t, { missingUnit: true }); h.seed(); h.change((s) => { s.status = "preparing"; });
  const tear = tearStateSave(t, `"${key}"`);
  await assert.rejects(h.task().collect(), /injected torn write/);
  tear.restore();
  assert.ok(tear.torn()); assert.equal(existsSync(join(h.local, "operation.lock")), false);
  // Neither save leaves the fixed-name stage every later ordinary save would refuse on.
  assert.equal(existsSync(join(h.local, "state.json.tmp")), false);
  const stages = readdirSync(h.local).filter((name) => /^state\.json\..*tmp$/.test(name));
  assert.equal(stages.length, 1);
  assert.match(stages[0], key === "deletionIntentAt" ? /^state\.json\.deletion-intent-[a-f0-9]{32}\.tmp$/ : /^state\.json\.destroyed-[a-f0-9]{32}\.tmp$/);
  const tornBytes = readFileSync(join(h.local, stages[0])), receipt = readFileSync(join(h.local, "unused-host.json"));
  assert.equal(tornBytes.length, 80);
  if (key === "deletionIntentAt") {
    const s = h.saved();
    assert.equal(h.deletes, 0); assert.equal(s.status, "preparing"); assert.equal(s.deletionIntentAt, undefined); assert.equal(s.retirement, undefined);
  }
  else { assert.equal(h.deletes, 1); assert.ok(h.saved().deletionIntentAt); assert.equal(h.saved().destroyedAt, undefined); }
  assert.equal(await h.task().collect(), 1);
  const s = h.saved();
  assert.equal(h.deletes, 1); assert.equal(s.retirement.kind, "unused"); assert.ok(s.destroyedAt);
  // A torn intent is recovered on a fresh proof, keeping the interrupted receipt; a torn destroyedAt only on absence.
  if (key === "deletionIntentAt") assert.ok(readFileSync(join(h.local, `unused-host.interrupted-${digest(receipt)}.json`)).equals(receipt));
  else assert.ok(readFileSync(join(h.local, "unused-host.json")).equals(receipt));
  assert.ok(readFileSync(join(h.local, stages[0])).equals(tornBytes));
});

test("an operation lock replaced during the absence read after an unused retirement's DELETE writes no destroyedAt", async (t) => {
  const h = harness(t, { missingUnit: true }); h.seed(); h.change((s) => { s.status = "preparing"; });
  const lock = join(h.local, "operation.lock"), replacement = `${JSON.stringify({ pid: 1, at: "2026-01-01T00:00:00.000Z" })}\n`;
  let replaced = false;
  // After the DELETE, the next exact host read is its absence confirmation.
  h.flags.hook = (binary, args) => {
    if (!replaced && h.deletes === 1 && binary === "doctl" && args[2] === "get") { replaced = true; unlinkSync(lock); writeFileSync(lock, replacement); }
  };
  await assert.rejects(h.task().collect(), (error) => /operation\.lock was replaced during this operation; the replacement is kept/.test(error.message)
    && /operation\.lock changed; preserve custody/.test(error.cause?.message));
  const saved = h.saved();
  assert.ok(replaced); assert.equal(h.deletes, 1); assert.equal(saved.status, "retired");
  assert.ok(saved.deletionIntentAt); assert.equal(saved.destroyedAt, undefined);
  assert.equal(readFileSync(lock, "utf8"), replacement, "the replacement lock is kept for its owner");
  // Once the replacement is gone, a collect confirms absence under its own lock and sends nothing.
  h.flags.hook = undefined; unlinkSync(lock);
  assert.equal(await h.task().collect(), 1);
  assert.ok(h.saved().destroyedAt); assert.equal(h.deletes, 1);
});

test("a reservation changed during an unused retirement's exact host read refuses with no receipt, intent or DELETE and keeps the change", async (t) => {
  const h = harness(t, { missingUnit: true }); h.seed(); h.change((s) => { s.status = "preparing"; });
  const path = join(h.local, "state.json");
  let proved = false, changed;
  // After the unused proof's SSH query, the next exact host read is the retirement's own.
  h.flags.hook = (binary, args) => {
    if (binary === "ssh") proved = true;
    else if (proved && !changed && binary === "doctl" && args[2] === "get") {
      const s = JSON.parse(readFileSync(path)); s.extractionAttempts = [...s.extractionAttempts ?? [], "evidence-Concurrent0"];
      writeFileSync(path, `${JSON.stringify(s, null, 2)}\n`); changed = readFileSync(path);
    }
  };
  await assert.rejects(h.task().collect(), /saved reservation changed before the deletion intent; preserve host/);
  const saved = h.saved();
  assert.ok(changed); assert.equal(h.deletes, 0);
  assert.ok(readFileSync(path).equals(changed), "the change is kept as made");
  assert.equal(saved.status, "preparing"); assert.equal(saved.deletionIntentAt, undefined); assert.equal(saved.retirement, undefined);
  assert.equal(existsSync(join(h.local, "unused-host.json")), false);
  // Over the changed reservation, a later collect retires once on its own fresh proof.
  h.flags.hook = undefined;
  assert.equal(await h.task().collect(), 1);
  assert.equal(h.deletes, 1); assert.ok(h.saved().destroyedAt); assert.deepEqual(h.saved().extractionAttempts, ["evidence-Concurrent0"]);
});

test("an allocated but never provisioned supervised host can be retired only with fresh unused proof", async (t) => {
  for (const valid of [true, false]) {
    const h = harness(t, { createRejected: true, missingUnit: true, ...(!valid ? { unusedProof: {} } : {}) });
    await assert.rejects(h.launch().launch(), /create completion/);
    assert.equal(h.saved().control.monitor.phase, "pending");
    assert.equal(h.saved().status, "preparing"); assert.equal(h.saved().control.ledger.length, 0);
    await assert.rejects(h.task().collect(), /approved pinned observation/);
    if (!valid) { await assert.rejects(h.pinnedUnused().collect()); assert.equal(h.deletes, 0); continue; }
    assert.equal(await h.pinnedUnused().collect(), 1); assert.equal(h.saved().retirement.kind, "unused");
    assert.ok(h.saved().destroyedAt); assert.equal(h.saved().validation, undefined);
    assert.equal(await h.pinnedUnused().collect(), 1); assert.equal(h.deletes, 1);
  }
});

test("unused recovery never takes over an operation lock or ignores monitor evidence", async (t) => {
  for (const name of ["operation.lock", "monitor-registration.json"]) {
    const h = harness(t, { createRejected: true, missingUnit: true });
    await assert.rejects(h.launch().launch(), /create completion/);
    writeFileSync(join(h.local, name), "preserve", { flag: "wx" });
    const calls = h.calls.length;
    await assert.rejects(h.pinnedUnused().collect());
    assert.equal(h.calls.length, calls); assert.equal(h.deletes, 0);
    assert.equal(readFileSync(join(h.local, name), "utf8"), "preserve");
  }
});

async function stoppedUpload(t, flags) {
  const h = harness(t, { missingUnit: true, ...flags });
  h.flags.hook = (binary, args) => {
    if (binary !== "doctl" || args[0] !== "account" || !existsSync(h.statePath)) return;
    const state = h.saved();
    if (state.control.ledger.length === 6 && state.control.ledger.every((r) => r.localTerminal))
      throw new Error("synthetic settled account read failure before next upload");
  };
  await assert.rejects(h.launch().launch(), /account read failure/);
  delete h.flags.hook;
  assert.equal(h.saved().status, "preparing");
  assert.deepEqual(h.saved().control.ledger.map((r) => r.request.invocation.channel), ["ssh", "ssh", "sftp", "ssh", "sftp", "ssh"]);
  assert.equal(h.saved().control.monitor.phase, "pending");
  assert.equal(h.calls.some((args) => args.at(-1).includes("systemctl start")), false);
  assert.ok(existsSync(join(h.local, h.saved().unit)), "next local payload was staged before the account read");
  writeFileSync(join(h.local, "known_hosts"), "synthetic operator-verified host key\n", { flag: "wx" });
  return h;
}

async function interruptedFirstUpload(t, { offline = false, localUncertain = !offline } = {}) {
  const group = "json-api", h = harness(t, { fleetGroup: group, fleetSlot: "json-api--r21", missingUnit: true, deleteLost: true });
  const single = { group, checkout: h.repo, indexSha256: "b".repeat(64), ...(offline ? { offlineHandoff: true } : {}) };
  const fleet = join(dirname(h.base), "fleet-r21.json");
  writeFileSync(fleet, JSON.stringify(fleetPlan({ round: "r21", commit, token: "f".repeat(16), tokens: { [group]: "1".repeat(16) },
    sshKey: "42", provider: { accountId, context } }, undefined, undefined, { stagedPlacement: true, single })));
  // In the offline recovery test the synthetic local worker is known closed,
  // but it never delivered a result for the remote upload.
  h.flags.hook = (binary) => {
    if (binary === "scp") throw Object.assign(new Error("lost upload reply"), localUncertain ? { controlUncertain: true } : {});
  };
  await assert.rejects(h.task({ checkFleetAdmission: () => [] }, { collect: undefined, detach: true, group, fleet,
    commit, sshKey: "42", accountId, context }).launch(), /lost upload reply/);
  delete h.flags.hook;
  const ledger = h.saved().control.ledger;
  assert.deepEqual(ledger.map(r => [r.request.invocation.channel, r.localTerminal, r.code]),
    [["ssh", true, 0], ["ssh", true, 0], ["sftp", false, undefined]]);
  const key = join(h.temp, "independently-verified-key");
  writeFileSync(key, readFileSync(join(h.local, "known_hosts")));
  const collect = (unusedBootstrapApproval = { reservationSha256: digest(readFileSync(h.statePath)),
    knownHostsSha256: digest(readFileSync(key)) }) => h.task({ unusedBootstrapApproval }, { unusedBootstrapKnownHosts: key }).collect();
  if (localUncertain) {
    const calls = h.calls.length;
    await assert.rejects(collect);
    assert.equal(h.calls.length, calls);
    assert.ok(existsSync(join(h.local, "operation.lock")) && existsSync(join(h.base, ".groups-launch.lock")));
    // Legacy supervised fixture only: model the separately proved operator custody handoff.
    if (!offline) { unlinkSync(join(h.local, "operation.lock")); unlinkSync(join(h.base, ".groups-launch.lock")); }
  }
  return { h, collect, ledger, key };
}

function neverWrittenProof(h, ledger) {
  const s = h.saved();
  return { schema: "benchmark-unused-host/v1", hostId: s.id, unit: s.unit, unused: true, observedAtMs: Date.now(),
    drainedReceipts: ledger.slice(0, 2).map(r => digest(r.request.invocation.id)),
    refusedUpload: { invocationId: ledger[2].request.invocation.id, jobPresent: false, failureSha256: digest("failed before registration") } };
}

function unusedPlan(h, key) {
  const run = (binary, args, timeout = 60000, allowFail) => {
    assert.equal(binary, "git");
    return args[0] === "show" ? { status: 0, stdout: readFileSync(resolve(args[1].slice(41)), "utf8").replaceAll("\r\n", "\n") }
      : h.run(binary, args, timeout, allowFail);
  };
  return productionPlan({ round: "r21", stateDir: h.base, collect: true, unusedBootstrapKnownHosts: key }, { repo: h.repo, run });
}

test("an unacknowledged first job upload retires only after a fresh never-written proof", async (t) => {
  const { h, collect, ledger, key } = await interruptedFirstUpload(t);
  const s = h.saved(), preview = await unusedPlan(h, key);
  assert.deepEqual(preview.missing, []);
  assert.equal(preview.subject.reservationSha256, digest(readFileSync(h.statePath)));
  assert.deepEqual(preview.subject.recovery, { measuredCommit: s.commit, hostId: s.id, ip: s.ip, knownHostsSha256: s.launchHostKeySha256,
    policy: "unacknowledged-first-upload-never-written-only" });
  h.flags.unusedProof = neverWrittenProof(h, ledger);
  const before = h.calls.length;
  await assert.rejects(collect, /deletion acknowledgement lost/);
  assert.equal(await collect(), 1); assert.equal(h.deletes, 1);
  assert.deepEqual(h.saved().control.ledger, ledger); assert.ok(h.saved().destroyedAt);
  assert.equal(h.saved().validation, undefined);
  assert.deepEqual(h.calls.slice(before).filter(([b]) => ["scp", "ssh"].includes(b)).map(([b]) => b), ["ssh"]);
  assert.deepEqual(h.calls.slice(before).filter(a => a[2] === "droplet" && a[3] === "delete").map(a => a.slice(1, 6)),
    [["compute", "droplet", "delete", s.id, "--force"]]);
});

test("offline first upload uses the approved unused receipt and exact-ID deletion without a monitor or final seal", async (t) => {
  const { h, collect, ledger, key } = await interruptedFirstUpload(t, { offline: true });
  const s = h.saved();
  assert.equal(s.status, "preparing"); assert.equal(s.fleet.single.offlineHandoff, true);
  assert.equal(s.quietBootstrap, "prelogin");
  assert.equal(s.control.monitor, undefined); assert.deepEqual(s.control.sealed, []);
  assert.equal(s.bootstrapReady, undefined);
  assert.equal(s.launchHostKeySha256, digest(readFileSync(key)));
  assert.deepEqual(h.calls.filter(([b]) => b === "scp").map(call => call.slice(-2)), [[join(h.local, "job.sh"), `root@${s.ip}:/bench/job.sh`]]);
  assert.equal(h.calls.some(([b, ...args]) => b === "ssh" && args.at(-1).includes("systemctl start")), false);
  await assert.rejects(h.task().collect(), /offline handoff not acknowledged/);
  const preview = await unusedPlan(h, key);
  assert.deepEqual(preview.missing, []);
  assert.equal(preview.subject.reservationSha256, digest(readFileSync(h.statePath)));
  assert.deepEqual(preview.subject.recovery, { measuredCommit: s.commit, hostId: s.id, ip: s.ip, knownHostsSha256: s.launchHostKeySha256,
    policy: "unacknowledged-first-upload-never-written-only" });

  const approve = ({ subject }) => ({ reservationSha256: subject.reservationSha256, knownHostsSha256: subject.recovery.knownHostsSha256 });
  h.flags.unusedProof = neverWrittenProof(h, ledger);
  h.flags.hook = (binary, args) => {
    if (binary === "ssh") {
      assert.ok(args.includes("StrictHostKeyChecking=yes"));
      assert.equal(args.at(-1), unusedHostScript(s, { bootstrap: true }));
    }
    if (binary === "doctl" && args[2] === "delete") {
      const saved = h.saved(), bytes = readFileSync(join(h.local, "unused-host.json"));
      assert.equal(saved.retirement.evidenceSha256, digest(bytes));
      assert.deepEqual(JSON.parse(bytes).observation, h.flags.unusedProof);
      verifyUnusedEvidence(JSON.parse(bytes), saved);
    }
  };
  const before = h.calls.length;
  await assert.rejects(collect(approve(preview)), /deletion acknowledgement lost/);
  assert.ok(h.saved().deletionIntentAt); assert.equal(h.saved().destroyedAt, undefined);
  await assert.rejects(collect(approve(preview)), /reservation changed/);
  assert.equal(await collect(approve(await unusedPlan(h, key))), 1);
  const retired = h.saved();
  assert.equal(retired.status, "retired"); assert.equal(retired.retirement.kind, "unused"); assert.ok(retired.destroyedAt);
  assert.deepEqual(retired.control.ledger, ledger);
  for (const field of ["archiveSha256", "validation", "exitCode", "collectedAt"]) assert.equal(retired[field], undefined, field);
  assert.deepEqual(h.calls.slice(before).filter(([b]) => ["scp", "ssh"].includes(b)).map(([b]) => b), ["ssh"]);
  assert.deepEqual(h.calls.slice(before).filter(a => a[2] === "droplet" && a[3] === "delete").map(a => a.slice(1, 6)),
    [["compute", "droplet", "delete", s.id, "--force"]]);
});

test("offline first upload refuses unresolved original local custody", async (t) => {
  const { h } = await interruptedFirstUpload(t, { offline: true, localUncertain: true });
  assert.equal(h.deletes, 0);
});

test("offline first upload refuses other lifecycle states and unexpected custody", async (t) => {
  const { h, collect, ledger, key } = await interruptedFirstUpload(t, { offline: true });
  h.flags.unusedProof = neverWrittenProof(h, ledger);
  const original = readFileSync(h.statePath), calls = h.calls.length;
  const rejected = [
    s => { delete s.fleet.single.offlineHandoff; delete s.quietBootstrap; },
    s => { delete s.quietBootstrap; },
    s => { s.control.ledger.length = 0; },
    s => { Object.assign(s.control.ledger[2], { localTerminal: true, code: 0 }); },
    s => {
      const invocations = s.control.ledger.map(r => r.request.invocation);
      s.control.ledger.push({ request: controlRequest(s, "ssh", [":"], 60000, "bootstrap", invocations), localTerminal: false });
    },
    s => { s.control.sealed.push("bootstrap"); },
    s => { s.status = "starting"; },
  ];
  for (const change of rejected) {
    writeFileSync(h.statePath, original);
    h.change(change);
    assert.equal(eligibleFirstUpload(h.saved(), h.local), false);
    await assert.rejects(unusedPlan(h, key));
    await assert.rejects(collect());
  }
  writeFileSync(h.statePath, original);
  writeFileSync(join(dirname(dirname(h.base)), ".continuation-operation.lock"), "original");
  await assert.rejects(collect(), /continuation custody remains/);
  assert.equal(readFileSync(join(dirname(dirname(h.base)), ".continuation-operation.lock"), "utf8"), "original");
  // Test a separate fixture so the original continuation lock is never removed.
  const extra = await interruptedFirstUpload(t, { offline: true });
  const extraState = readFileSync(extra.h.statePath), extraCalls = extra.h.calls.length;
  writeFileSync(join(extra.h.local, "unrecognized"), "preserve");
  await assert.rejects(extra.collect(), /unexpected local bootstrap custody/);
  assert.deepEqual(readFileSync(extra.h.statePath), extraState);
  assert.equal(extra.h.calls.length, extraCalls); assert.equal(extra.h.deletes, 0);
  assert.deepEqual(readFileSync(h.statePath), original);
  assert.deepEqual(h.calls.slice(calls).filter(([binary]) => binary !== "git"), []);
  assert.equal(h.deletes, 0); assert.equal(existsSync(join(h.local, "unused-host.json")), false);
});

test("first upload recovery refuses changed custody or incomplete evidence without deletion", async (t) => {
  for (const mode of ["source", "target", "launch-key", "job", "outer-lock", "fleet-lock", "receipt", "invocation", "failure", "present"]) {
    const { h, collect, ledger, key } = await interruptedFirstUpload(t);
    if (mode === "source") h.flags.wrongHead = true;
    if (mode === "target") h.change(s => { s.control.ledger[2].request.invocation.requestSha256 = digest("different SFTP target"); });
    if (mode === "launch-key") {
      writeFileSync(key, "different key"); writeFileSync(join(h.local, "known_hosts"), readFileSync(key));
    }
    if (mode === "job") writeFileSync(join(h.local, "job.sh"), "different job");
    if (mode === "outer-lock") writeFileSync(join(dirname(dirname(h.base)), ".continuation-operation.lock"), "original", { flag: "wx" });
    if (mode === "fleet-lock") writeFileSync(join(dirname(h.base), ".fleet-operation.lock"), "original", { flag: "wx" });
    const proof = neverWrittenProof(h, ledger);
    if (mode === "receipt") proof.drainedReceipts.pop();
    if (mode === "invocation") proof.refusedUpload.invocationId = ledger[1].request.invocation.id;
    if (mode === "failure") delete proof.refusedUpload.failureSha256;
    if (mode === "present") proof.refusedUpload.jobPresent = true;
    h.flags.unusedProof = proof;
    const before = readFileSync(h.statePath), start = h.calls.length;
    await assert.rejects(collect, undefined, mode);
    assert.deepEqual(readFileSync(h.statePath), before, mode);
    assert.equal(h.deletes, 0, mode); assert.equal(existsSync(join(h.local, "unused-host.json")), false, mode);
    assert.equal(h.calls.slice(start).filter(([b]) => b === "ssh").length, ["receipt", "invocation", "failure", "present"].includes(mode) ? 1 : 0, mode);
  }
});

test("settled bootstrap uploads retire only with fresh pinned drainage and never replay DELETE", async (t) => {
  const h = await stoppedUpload(t, { deleteLost: true });
  const ledger = h.saved().control.ledger;
  await assert.rejects(h.task().collect(), /monitor not registered/);
  const drainedReceipts = ledger.map((row) => digest(row.request.invocation.id));
  const run = (binary, args, timeout, allowFail, expiry) => {
    if (binary === "ssh") {
      assert.ok(args.includes("StrictHostKeyChecking=yes"));
      assert.ok(args.at(-1).includes("watcher_terminal"));
      const saved = h.saved();
      h.flags.unusedProof = { schema: "benchmark-unused-host/v1", hostId: saved.id, unit: saved.unit,
        unused: true, observedAtMs: Date.now(), drainedReceipts };
    }
    if (binary === "doctl" && args[2] === "delete") {
      assert.ok(expiry > Date.now() && expiry - Date.now() <= 60000);
      assert.deepEqual(args.slice(0, 5), ["compute", "droplet", "delete", "123", "--force"]);
      assert.deepEqual(JSON.parse(readFileSync(join(h.local, "unused-host.json"))).observation.drainedReceipts, drainedReceipts);
    }
    return h.run(binary, args, timeout, allowFail, expiry);
  };
  await assert.rejects(h.pinnedUnused({ run }).collect(), /deletion acknowledgement lost/);
  assert.equal(h.deletes, 1); assert.ok(h.saved().deletionIntentAt);
  assert.deepEqual(h.saved().control.ledger, ledger);
  assert.equal(h.saved().archiveSha256, undefined);
  const calls = h.calls.length;
  assert.equal(await h.pinnedUnused({ run }).collect(), 1);
  assert.equal(h.deletes, 1); assert.ok(h.saved().destroyedAt);
  assert.equal(h.calls.slice(calls).some(([binary]) => binary === "ssh" || binary === "scp"), false);
});

// The first exclusive state stage written with the key is torn: 80 bytes, then an error. Either
// a fresh stage or the fixed state.json.tmp is torn, so the test sees which one the save used.
const tearStateSave = (t, key) => {
  const fds = new Set(); let torn = false;
  t.mock.method(fs, "openSync", ((original) => (path, flags, ...rest) => {
    const fd = original(path, flags, ...rest);
    if (!torn && flags === "wx" && /^state\.json\..*tmp$/.test(basename(String(path)))) fds.add(fd);
    return fd;
  })(fs.openSync));
  t.mock.method(fs, "writeFileSync", ((original) => (target, data, ...rest) => {
    if (!fds.has(target)) return original(target, data, ...rest);
    fds.delete(target);
    if (torn || !String(data).includes(key)) return original(target, data, ...rest);
    torn = true; fs.writeSync(target, Buffer.from(data).subarray(0, 80));
    throw new Error("injected torn write");
  })(fs.writeFileSync));
  syncBuiltinESMExports();
  const restore = () => { fs.openSync.mock?.restore(); fs.writeFileSync.mock?.restore(); syncBuiltinESMExports(); };
  t.after(restore);
  return { torn: () => torn, restore };
};

test("a torn destroyedAt save on a pinned unused restart leaves its own stage, never state.json.tmp, and the next collect refuses with no second DELETE", async (t) => {
  const h = await stoppedUpload(t, { deleteLost: true });
  const drainedReceipts = h.saved().control.ledger.map((row) => digest(row.request.invocation.id));
  const run = (binary, args, timeout, allowFail, expiry) => {
    if (binary === "ssh") {
      const saved = h.saved();
      h.flags.unusedProof = { schema: "benchmark-unused-host/v1", hostId: saved.id, unit: saved.unit,
        unused: true, observedAtMs: Date.now(), drainedReceipts };
    }
    return h.run(binary, args, timeout, allowFail, expiry);
  };
  await assert.rejects(h.pinnedUnused({ run }).collect(), /deletion acknowledgement lost/);
  const intent = h.saved();
  assert.equal(h.deletes, 1); assert.ok(intent.deletionIntentAt); assert.equal(intent.destroyedAt, undefined);
  // The restart only confirms absence and records destroyedAt; that save is torn.
  const tear = tearStateSave(t, '"destroyedAt"');
  await assert.rejects(h.pinnedUnused({ run }).collect(), /injected torn write/);
  tear.restore();
  assert.ok(tear.torn()); assert.equal(h.deletes, 1); assert.deepEqual(h.saved(), intent);
  assert.equal(existsSync(join(h.local, "state.json.tmp")), false);
  const stages = readdirSync(h.local).filter((name) => /^state\.json\..*tmp$/.test(name));
  assert.equal(stages.length, 1); assert.match(stages[0], /^state\.json\.destroyed-[a-f0-9]{32}\.tmp$/);
  const tornBytes = readFileSync(join(h.local, stages[0]));
  assert.equal(tornBytes.length, 80); assert.equal(existsSync(join(h.local, "operation.lock")), false);
  // Pinned unused custody admits only its closed list of names, so the unread stage refuses
  // the next collect before any provider call: fail closed, with no second DELETE.
  const calls = h.calls.length;
  await assert.rejects(h.pinnedUnused({ run }).collect(), /unexpected local bootstrap custody/);
  assert.equal(h.deletes, 1); assert.deepEqual(h.saved(), intent);
  assert.equal(h.calls.slice(calls).some(([binary]) => binary === "doctl" || binary === "ssh"), false);
  assert.ok(readFileSync(join(h.local, stages[0])).equals(tornBytes));
});

// An ordinary collect saves its intent before the DELETE and destroyedAt after absence; a restart
// that finds an intent without destroyedAt records it on absence alone. Each save is torn once.
const ordinaryStage = (h, pattern) => {
  // A torn save leaves only its own fresh stage, never the fixed-name state.json.tmp.
  assert.equal(existsSync(join(h.local, "state.json.tmp")), false);
  const stages = readdirSync(h.local).filter((name) => /^state\.json\..*tmp$/.test(name));
  assert.equal(stages.length, 1); assert.match(stages[0], pattern);
  const bytes = readFileSync(join(h.local, stages[0]));
  assert.equal(bytes.length, 80); assert.equal(existsSync(join(h.local, "operation.lock")), false);
  return { name: stages[0], bytes };
};
const intentStage = /^state\.json\.deletion-intent-[a-f0-9]{32}\.tmp$/, destroyedStage = /^state\.json\.destroyed-[a-f0-9]{32}\.tmp$/;

test("a torn ordinary deletion intent save leaves its own stage and no intent, and the next collect deletes once", async (t) => {
  const h = harness(t); h.seed();
  const tear = tearStateSave(t, '"deletionIntentAt"');
  await assert.rejects(h.task().collect(), /injected torn write/);
  tear.restore();
  assert.ok(tear.torn()); assert.equal(h.deletes, 0);
  const stage = ordinaryStage(h, intentStage), interrupted = h.saved();
  assert.equal(interrupted.deletionIntentAt, undefined); assert.equal(interrupted.destroyedAt, undefined);
  assert.equal(await h.task().collect(), 1);
  assert.equal(h.deletes, 1); assert.ok(h.saved().deletionIntentAt); assert.ok(h.saved().destroyedAt);
  assert.ok(readFileSync(join(h.local, stage.name)).equals(stage.bytes));
});

test("a torn ordinary destroyedAt save after the one DELETE leaves its own stage, and the next collect records absence with no second DELETE", async (t) => {
  const h = harness(t); h.seed();
  const tear = tearStateSave(t, '"destroyedAt"');
  await assert.rejects(h.task().collect(), /injected torn write/);
  tear.restore();
  assert.ok(tear.torn()); assert.equal(h.deletes, 1);
  const stage = ordinaryStage(h, destroyedStage), interrupted = h.saved();
  assert.ok(interrupted.deletionIntentAt); assert.equal(interrupted.destroyedAt, undefined);
  assert.equal(await h.task().collect(), 1);
  const s = h.saved();
  assert.equal(h.deletes, 1); assert.ok(s.destroyedAt); assert.equal(s.deletionIntentAt, interrupted.deletionIntentAt);
  assert.ok(readFileSync(join(h.local, stage.name)).equals(stage.bytes));
});

test("a torn destroyedAt save on an ordinary restart after a lost DELETE acknowledgement leaves its own stage, and the next collect records absence with no second DELETE", async (t) => {
  const h = harness(t, { deleteLost: true }); h.seed();
  await assert.rejects(h.task().collect(), /acknowledgement/);
  const intent = h.saved();
  assert.equal(h.deletes, 1); assert.ok(intent.deletionIntentAt); assert.equal(intent.destroyedAt, undefined);
  // The restart finds the intent and only confirms absence; its destroyedAt save is torn.
  const tear = tearStateSave(t, '"destroyedAt"');
  await assert.rejects(h.task().collect(), /injected torn write/);
  tear.restore();
  assert.ok(tear.torn()); assert.equal(h.deletes, 1); assert.deepEqual(h.saved(), intent);
  const stage = ordinaryStage(h, destroyedStage);
  assert.equal(await h.task().collect(), 1);
  const s = h.saved();
  assert.equal(h.deletes, 1); assert.ok(s.destroyedAt); assert.equal(s.deletionIntentAt, intent.deletionIntentAt);
  assert.ok(readFileSync(join(h.local, stage.name)).equals(stage.bytes));
});

test("settled upload approval binds the exact measured checkout, reservation, host and key", async (t) => {
  const h = await stoppedUpload(t), s = h.saved(), key = join(h.local, "known_hosts");
  const plan = () => unusedPlan(h, key);
  const preview = await plan();
  assert.deepEqual(preview.missing, []);
  assert.equal(preview.subject.reservationSha256, digest(readFileSync(h.statePath)));
  assert.deepEqual(preview.subject.recovery, { measuredCommit: s.commit, hostId: s.id, ip: s.ip,
    knownHostsSha256: digest(readFileSync(key)), policy: "settled-uploads-unused-only-no-qualification" });
  h.flags.wrongHead = true;
  await assert.rejects(plan(), /require the measured checkout/);
});

test("settled upload recovery refuses changed local custody, wrong source, or incomplete fresh proof", async (t) => {
  for (const mode of ["source", "unsettled", "sftp-digest", "missing-upload", "changed-staged", "extra", "key", "launch-lock",
    "monitor", "wrong-host", "missing-drain", "duplicate-drain", "partial-drain"]) {
    const h = await stoppedUpload(t);
    if (mode === "source") h.flags.wrongHead = true;
    if (mode === "unsettled") h.change((s) => { const row = s.control.ledger.at(-1); row.localTerminal = false; delete row.code; });
    if (mode === "sftp-digest") h.change((s) => { s.control.ledger[2].request.invocation.requestSha256 = "0".repeat(64); });
    if (mode === "missing-upload") unlinkSync(join(h.local, "job.sh"));
    if (mode === "changed-staged") writeFileSync(join(h.local, h.saved().unit), "different");
    if (mode === "extra") writeFileSync(join(h.local, "results.tgz"), "partial evidence");
    if (mode === "key") writeFileSync(join(h.local, "known_hosts"), "different");
    if (mode === "launch-lock") writeFileSync(join(h.base, ".groups-launch.lock"), "preserve custody");
    if (mode === "monitor") writeFileSync(join(h.local, "monitor-journal.jsonl"), "preserve journal");
    const saved = h.saved(), start = h.calls.length, before = readFileSync(h.statePath);
    const proofFailures = ["wrong-host", "missing-drain", "duplicate-drain", "partial-drain"].includes(mode);
    const run = (binary, args, timeout, allowFail, expiry) => {
      if (binary === "ssh") {
        const hashes = saved.control.ledger.map((row) => digest(row.request.invocation.id));
        const drainedReceipts = mode === "duplicate-drain" ? hashes.fill(hashes[0]) : mode === "partial-drain" ? hashes.slice(1) : hashes;
        h.flags.unusedProof = { schema: "benchmark-unused-host/v1", hostId: mode === "wrong-host" ? "124" : saved.id,
          unit: saved.unit, unused: true, observedAtMs: Date.now(), ...(mode === "missing-drain" ? {} : { drainedReceipts }) };
      }
      return h.run(binary, args, timeout, allowFail, expiry);
    };
    await assert.rejects(h.pinnedUnused({ run }).collect(), mode === "source" ? /require the measured checkout/ : undefined, mode);
    assert.equal(h.deletes, 0, mode);
    assert.deepEqual(readFileSync(h.statePath), before, mode);
    assert.equal(existsSync(join(h.local, "unused-host.json")), false, mode);
    if (mode === "source") assert.deepEqual(h.calls.slice(start), [["git", "rev-parse", "HEAD"]]);
    assert.equal(h.calls.slice(start).filter(([binary]) => binary === "ssh").length, proofFailures ? 1 : 0, mode);
  }
});

test("unused retirement refuses bad, stale, future, wrong-host and secret-bearing proof", async (t) => {
  for (const proof of [null, {}, { unused: true }, "PRIVATE_SYNTHETIC_VALUE", ...[{ hostId: "124" }, { unit: "foreign.service" },
    { observedAtMs: 0 }, { observedAtMs: Date.now() + 60000 }, { unused: false }, { raw: "PRIVATE_SYNTHETIC_VALUE" }].map((patch) => ({ patch }))]) {
    const h = harness(t, { missingUnit: true, unusedProof: proof }); h.seed(); h.change((s) => { s.status = "preparing"; });
    if (proof?.patch) h.flags.unusedProof = { schema: "benchmark-unused-host/v1", hostId: h.saved().id, unit: h.saved().unit,
      unused: true, observedAtMs: Date.now(), ...proof.patch };
    await assert.rejects(h.task().collect()); assert.equal(h.deletes, 0); assert.equal(h.saved().deletionIntentAt, undefined);
  }
});

test("unused retirement confirms delayed exact-ID absence without creating benchmark evidence", async (t) => {
  const h = harness(t, { missingUnit: true, deleteUnconfirmed: true }); h.seed(); h.change((s) => { s.status = "preparing"; });
  let observations = 0;
  h.flags.hook = (binary, args) => {
    if (binary === "doctl" && args[2] === "get" && h.deletes && ++observations === 3) h.hosts([]);
  };
  assert.equal(await h.task().collect(), 1); assert.equal(h.deletes, 1); assert.equal(observations, 3);
  assert.ok(h.saved().destroyedAt); assert.equal(h.saved().validation, undefined);
});
test("a lost absence observation never repeats DELETE and changed retirement evidence refuses", async (t) => {
  const h = harness(t, { missingUnit: true, deleteUnconfirmed: true }); h.seed(); h.change((s) => { s.status = "preparing"; });
  await assert.rejects(h.task().collect()); assert.equal(h.deletes, 1); assert.ok(h.saved().deletionIntentAt);
  await assert.rejects(h.task().collect()); assert.equal(h.deletes, 1);
  h.hosts([]); assert.equal(await h.task().collect(), 1); assert.equal(h.deletes, 1);
  const path = join(h.local, "unused-host.json"), original = readFileSync(path);
  writeFileSync(path, "{}"); await assert.rejects(h.task().collect()); assert.equal(h.deletes, 1);
  writeFileSync(path, original);
});

test("a start-attempted or running allocation never takes the unused-retirement path", async (t) => {
  for (const status of ["starting", "running"]) {
    const h = harness(t, { missingUnit: true }); h.seed(); h.change((s) => { s.status = status; });
    await assert.rejects(h.task().collect()); assert.equal(h.deletes, 0);
    assert.equal(h.calls.some((c) => c.at(-1).includes("benchmark-unused-host/v1")), false);
  }
});

test("an interrupted unused receipt is preserved but only a fresh probe can authorize retirement", async (t) => {
  for (const mode of ["valid", "bad-old-record", "bad-fresh-proof"]) {
    const h = harness(t, { missingUnit: true }); h.seed(); h.change((s) => { s.status = "preparing"; });
    const state = h.saved(), raw = JSON.stringify({ schema: "benchmark-unused-host/v1", hostId: state.id, unit: state.unit, unused: true, observedAtMs: 1000 });
    const record = unusedEvidence(raw, state, unusedHostScript(state), 1000, 1000);
    if (mode === "bad-old-record") record.id = "124";
    const bytes = JSON.stringify(record), path = join(h.local, "unused-host.json"); writeFileSync(path, bytes);
    if (mode === "bad-fresh-proof") h.flags.unusedProof = { unused: true };
    if (mode !== "valid") {
      await assert.rejects(h.task().collect()); assert.equal(h.deletes, 0); assert.equal(h.saved().deletionIntentAt, undefined);
      assert.equal(readFileSync(path, "utf8"), bytes); continue;
    }
    assert.equal(await h.task().collect(), 1); assert.equal(h.deletes, 1);
    assert.equal(readFileSync(join(h.local, `unused-host.interrupted-${digest(bytes)}.json`), "utf8"), bytes);
    assert.notEqual(readFileSync(path, "utf8"), bytes);
    assert.equal(await h.task().collect(), 1); assert.equal(h.deletes, 1);
  }
});
