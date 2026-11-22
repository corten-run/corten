// Actual fixed entry with source-bound typed contracts and fake native work only.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mock, test } from "node:test";
import * as contracts from "./campaign-contract.mjs";
import { digest } from "./evidence.mjs";
import { binding, registration } from "../test-fixtures/control-stream-fixture.mjs";
import { streamHash } from "./control-stream.mjs";

const root = mkdtempSync(join(tmpdir(), "corten-stream-entry-"));
let handle, state, mode, stream, abort, order, delivered;
mock.module("./campaign-contract.mjs", { exports: { ...contracts, bindGroupCampaign: (input) => input } });
mock.module("./control-admission.mjs", { exports: {
  bootstrapControl: () => binding,
  waitControlAdmission: async (_binding, epoch) => { assert.equal(epoch, "bootstrap"); return { apparatus: registration }; },
  controlOperation: (_binding, operation) => { assert.equal(operation, "activate"); order.push("activate"); },
} });
mock.module("./control-stream-remote.mjs", { exports: { async superviseControlStream(actual, admission, controller) {
  await new Promise(setImmediate); // Native activation must wait for the pinned sampler's first observation.
  assert.deepEqual(actual, binding); assert.equal(admission.apparatus, registration); abort = controller;
  stream = { registration, check() { assert.equal(abort.signal.aborted, false); },
    progress(status) { order.push("progress:" + status.state); },
    audit(group, bytes) { assert.equal(state, "blocked-review-needed"); assert.equal(group, "json-api"); order.push("audit-pending");
      return { binding, id: registration.id, registrationSha256: streamHash(registration), renewal: 1, monoNs: "2000000",
        intent: { group, campaign: handle.id, subjectSha256: "e".repeat(64), bytes: bytes.length, sha256: digest(bytes) } }; },
    async finish(payload) {
      assert.equal(state, "finished"); assert.equal(payload.nativeTerminal, true); assert.equal(payload.id, registration.id);
      assert.equal(payload.sealSha256, digest(readFileSync(join(handle.directory, "control-stream-seal.json"))));
      order.push("drain"); if (mode === "drain-failed") throw new Error("actual disappearance not established");
      return { schema: "test-only-actual-drain-placeholder", id: registration.id };
    }, dispose() { order.push("dispose"); },
  }; return stream;
} } });
mock.module("./campaign.mjs", { exports: { createCampaign({ authorize }) {
  const status = () => ({ campaign: handle.id, state, auditGroup: "json-api", auditSubjectSha256: "e".repeat(64) });
  return {
    async begin(plan, options) { assert.equal(options.control.stream, stream); assert.equal(plan.group, mode === "failed-group" ? "localized-marketplace" : "json-api"); order.push("begin"); return handle; }, status,
    async advance() {
      if (mode === "lost-lease") { abort.abort(); return status(); }
      if (!delivered && mode !== "failed-group") {
        state = "blocked-review-needed"; writeFileSync(join(handle.directory, "json-audit-delivery-pending.json"), JSON.stringify({ subjectSha256: "e".repeat(64) }), { mode: 0o600 });
      } else { writeFileSync(join(handle.directory, "control-stream-seal.json"), "source-bound seal placeholder"); state = "finished"; }
      return status();
    },
    recordStreamAudit(h, proof) {
      assert.equal(h, handle); assert.equal(proof.intent.campaign, handle.id);
      assert.ok(existsSync(join(handle.directory, "json-audit-delivery-pending.json"))); assert.ok(!existsSync(join(handle.directory, "json-audit-delivery.json")));
      order.push("admit-audit");
    },
    async submitJsonAudit(h) {
      assert.equal(h, handle); assert.ok(existsSync(join(handle.directory, "json-audit-delivery.json")));
      assert.equal(authorize({ action: "stage-json-audit", auditSubjectSha256: "e".repeat(64) }), true);
      delivered = true; state = "active"; order.push("submit-audit"); return status();
    },
    collect() { assert.ok(existsSync(join(handle.directory, "control-stream-drain.json"))); order.push("collect"); return { status: status() }; },
    stop() { state = "preserved-uncertain"; order.push("stop"); return status(); },
  };
} } });
mock.module("./campaign-verify.mjs", { exports: { validateCampaign: async () => {
  assert.ok(existsSync(join(handle.directory, "collection-manifest.json"))); order.push("verify");
  return mode === "failed-group" ? { status: "failed", collectionIntegrity: "manifest-verified",
    commandLifecycle: "observed-terminal", uncollectedNativeRoots: [] } : { status: "verified" };
} } });
const { runCampaignEntry } = await import("./campaign-entry.mjs");

for (const outcome of ["normal", "failed-group", "drain-failed", "lost-lease"]) test("fixed supervised entry lifecycle: " + outcome, async () => {
  mode = outcome; order = []; state = "active"; delivered = false;
  handle = { id: "r21-0123456789abcdef", directory: join(root, outcome) }; mkdirSync(handle.directory, { mode: 0o700 });
  const invocation = ["r21", "--commit", binding.commit, "--state-dir", "/bench/campaign", "--group", outcome === "failed-group" ? "localized-marketplace" : "json-api"];
  if (outcome === "drain-failed") await assert.rejects(runCampaignEntry(invocation), /disappearance/);
  else assert.equal(await runCampaignEntry(invocation), outcome === "normal" ? 0 : outcome === "failed-group" ? 1 : 2);
  assert.equal(order.at(-1), "dispose");
  if (outcome === "normal") {
    for (const [first, last] of [["audit-pending", "admit-audit"], ["admit-audit", "submit-audit"], ["drain", "collect"], ["collect", "verify"]])
      assert.ok(order.indexOf(first) < order.indexOf(last));
  } else if (outcome === "failed-group") {
    assert.deepEqual(order, ["activate", "begin", "progress:active", "drain", "collect", "verify", "dispose"]);
  } else {
    assert.ok(!order.includes("collect") && !order.includes("verify")); assert.ok(!existsSync(join(handle.directory, "control-stream-drain.json")));
    if (outcome === "lost-lease") assert.ok(!order.includes("drain") && !order.includes("submit-audit"));
  }
});
test.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true }); });
