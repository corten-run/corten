import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { harness } from "./cloud-fixtures.mjs";
import { digest } from "./cloud-local.mjs";
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

test("unused retirement refuses bad, stale, future, wrong-host and secret-bearing proof", async (t) => {
  for (const proof of [null, {}, { unused: true }, "PRIVATE_SYNTHETIC_VALUE", ...[{ hostId: "124" }, { unit: "foreign.service" },
    { observedAtMs: 0 }, { observedAtMs: Date.now() + 60000 }, { unused: false }, { raw: "PRIVATE_SYNTHETIC_VALUE" }].map((patch) => ({ patch }))]) {
    const h = harness(t, { missingUnit: true, unusedProof: proof }); h.seed(); h.change((s) => { s.status = "preparing"; });
    if (proof?.patch) h.flags.unusedProof = { schema: "benchmark-unused-host/v1", hostId: h.saved().id, unit: h.saved().unit,
      unused: true, observedAtMs: Date.now(), ...proof.patch };
    await assert.rejects(h.task().collect()); assert.equal(h.deletes, 0); assert.equal(h.saved().deletionIntentAt, undefined);
  }
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
