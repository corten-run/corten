import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { harness } from "./cloud-fixtures.mjs";
import { digest } from "./cloud-local.mjs";
import { productionPlan } from "./cloud-production.mjs";
import { unusedEvidence, unusedHostScript } from "./cloud-retirement.mjs";

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

test("settled upload approval binds the exact measured checkout, reservation, host and key", async (t) => {
  const h = await stoppedUpload(t), s = h.saved(), key = join(h.local, "known_hosts");
  const run = (binary, args, timeout = 60000, allowFail) => {
    assert.equal(binary, "git");
    return args[0] === "show" ? { status: 0, stdout: readFileSync(resolve(args[1].slice(41)), "utf8").replaceAll("\r\n", "\n") }
      : h.run(binary, args, timeout, allowFail);
  };
  const plan = () => productionPlan({ round: "r21", stateDir: h.base, collect: true, unusedBootstrapKnownHosts: key }, { repo: h.repo, run });
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
