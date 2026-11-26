// Exercise the real host entry; only native work and privileged observations are faked.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import * as contracts from "./campaign-contract.mjs";
import { binding } from "../test-fixtures/control-stream-fixture.mjs";

let fixture;
mock.module("./campaign-contract.mjs", { exports: { ...contracts, bindGroupCampaign: (input) => input } });
mock.module("./control-admission.mjs", { exports: {
  bootstrapControl: () => ({ ...binding, offlineHandoff: true }),
  waitControlAdmission: async (control, epoch, options) => {
    assert.deepEqual(control, binding);
    if (epoch.startsWith("audit-")) {
      assert.equal(options.deadline, Infinity);
      assert.equal(options.signal.aborted, false);
      if (fixture.expireDuringAdmission) fixture.expire = true;
    }
    fixture.steps.push("admit:" + epoch);
    return fixture.apparatus ? { apparatus: {} } : {};
  },
  controlOperation: (_control, operation) => fixture.steps.push(operation),
} });
mock.module("./control-stream-remote.mjs", { exports: {
  superviseControlStream() { assert.fail("offline handoff must not open or depend on a workstation stream"); },
} });
mock.module("./campaign.mjs", { exports: { createCampaign({ authorize }) {
  const status = () => ({ campaign: fixture.handle.id, state: fixture.state,
    auditGroup: fixture.group, auditSubjectSha256: "e".repeat(64), mixedAuditSubjectSha256: "e".repeat(64) });
  const prefix = fixture.group === "json-api" ? "json" : "mixed";
  async function submit(handle) {
    assert.equal(handle, fixture.handle);
    assert.ok(fixture.steps.includes("admit:audit-" + fixture.group));
    assert.equal(authorize({ action: "stage-" + prefix + "-audit", auditSubjectSha256: "e".repeat(64) }), true);
    fixture.steps.push("submit");
    fixture.state = "active";
    return status();
  }
  return {
    async begin(_plan, { control }) {
      assert.equal(control.stream, undefined);
      assert.equal(control.offlineHandoff, true);
      fixture.steps.push("begin");
      return fixture.handle;
    }, status,
    async advance() {
      if (fixture.group === "localized-marketplace" || fixture.steps.includes("submit")) {
        assert.equal(fixture.connected, false);
        fixture.steps.push("finish"); fixture.state = "finished";
      } else {
        fixture.state = "blocked-review-needed";
        if (!fixture.expire)
          writeFileSync(join(fixture.handle.directory, prefix + "-audit-delivery-pending.json"), "{}", { mode: 0o600 });
      }
      return status();
    },
    recordControlAdmission() { fixture.steps.push("drained"); },
    submitJsonAudit: submit, submitMixedAudit: submit,
    offlineAuditRemainingMs(handle) {
      assert.equal(handle, fixture.handle);
      if (fixture.badBoot) throw new Error("offline audit clock boot differs");
      return fixture.expire ? 0 : contracts.auditWaitMs;
    },
    expireOfflineAudit(handle) {
      assert.equal(handle, fixture.handle);
      fixture.steps.push("expire"); fixture.state = "preserved-uncertain";
      return { status: status() };
    },
    collect() { fixture.steps.push("collect"); return { status: status() }; },
    stop(handle) {
      assert.equal(handle, fixture.handle);
      fixture.steps.push("stop");
    },
  };
} } });
mock.module("./campaign-verify.mjs", { exports: { async validateCampaign() {
  assert.ok(readFileSync(join(fixture.handle.directory, "collection-manifest.json")).length);
  fixture.steps.push("replay");
  return { status: "verified" };
} } });

const { runCampaignEntry } = await import("./campaign-entry.mjs");
for (const group of ["localized-marketplace", "json-api", "mixed-production"]) {
  test("detached native entry finishes after disconnect: " + group, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "corten-offline-handoff-"));
    t.after(() => rmSync(root, { recursive: true }));
    const handle = { id: "r21-0123456789abcdef", directory: join(root, "r21-0123456789abcdef") };
    mkdirSync(handle.directory);
    fixture = { group, handle, steps: [], connected: true, state: "active" };
    let wallReads = 0;
    t.mock.method(Date, "now", () => fixture.state === "blocked-review-needed" ? wallReads++ * contracts.auditWaitMs * 2 : 0);
    // Simulate loss of the original connection at the proven admission boundary.
    const steps = fixture.steps;
    steps.push = function (value) {
      if (value === "admit:bootstrap") fixture.connected = false;
      return Array.prototype.push.call(this, value);
    };
    assert.equal(await runCampaignEntry(["r21", "--commit", binding.commit, "--state-dir", "/bench/campaign", "--group", group]), 0);
    assert.deepEqual([...steps], ["admit:bootstrap", "activate", "begin", ...(group === "localized-marketplace"
      ? [] : ["admit:audit-" + group, "drained", "submit"]), "finish", "collect", "replay"]);
    assert.equal(wallReads, 0, "a forward wall step is not an offline audit deadline");
  });
}

test("an offline audit wait writes a terminal failure manifest and returns 2 without timing or delivery", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "corten-offline-handoff-"));
  t.after(() => rmSync(root, { recursive: true }));
  const handle = { id: "r21-0123456789abcdef", directory: join(root, "r21-0123456789abcdef") };
  mkdirSync(handle.directory);
  fixture = { group: "json-api", handle, steps: [], state: "active", expire: true };
  t.mock.method(Date, "now", () => 0);
  assert.equal(await runCampaignEntry(["r21", "--commit", binding.commit, "--state-dir", "/bench/campaign", "--group", fixture.group]), 2);
  assert.deepEqual(fixture.steps, ["admit:bootstrap", "activate", "begin", "expire"]);
  const manifest = JSON.parse(readFileSync(join(handle.directory, "collection-manifest.json"), "utf8"));
  assert.equal(manifest.status.state, "preserved-uncertain");
});

for (const [fault, reason] of [
  ["badBoot", /offline audit clock boot differs/],
  ["expireDuringAdmission", /offline audit admission reached the deadline/],
]) test("offline audit entry preserves uncertain custody: " + fault, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "corten-offline-handoff-"));
  t.after(() => rmSync(root, { recursive: true }));
  const handle = { id: "r21-0123456789abcdef", directory: join(root, "r21-0123456789abcdef") };
  mkdirSync(handle.directory);
  fixture = { group: "json-api", handle, steps: [], state: "active", [fault]: true };
  await assert.rejects(runCampaignEntry(["r21", "--commit", binding.commit, "--state-dir", "/bench/campaign", "--group", fixture.group]), reason);
  assert.deepEqual(fixture.steps, ["admit:bootstrap", "activate", "begin", ...(fixture.expireDuringAdmission ? ["admit:audit-json-api"] : []), "stop"]);
  assert.equal(existsSync(join(handle.directory, "collection-manifest.json")), false);
  assert.equal(existsSync(join(handle.directory, "json-audit-delivery.json")), false);
});

test("an offline handoff must not silently adopt a stream apparatus", async () => {
  fixture = { steps: [], apparatus: true };
  await assert.rejects(runCampaignEntry(["r21", "--commit", binding.commit, "--state-dir", "/bench/campaign", "--group", "localized-marketplace"]),
    /offline handoff has a stream apparatus/);
  assert.deepEqual(fixture.steps, ["admit:bootstrap"]);
});
