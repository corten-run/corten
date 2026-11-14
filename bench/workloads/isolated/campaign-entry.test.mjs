import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { mock, test } from "node:test";
import { inside } from "./evidence.mjs";
import { parseCampaignArgs, readAuditInbox, runCampaignEntry } from "./campaign-entry.mjs";

const temporary = mkdtempSync(join(os.tmpdir(), "isolated-entry-test-"));
const commit = "a".repeat(40), args = ["r17", "--commit", commit, "--state-dir", "/bench/campaign"];
test("fixed entry grammar refuses filters, extra paths, duplicate args, stale identity shapes", () => {
  assert.deepEqual(parseCampaignArgs(args), { round: "r17", commit, stateRoot: "/bench/campaign" });
  for (const input of [[], [...args, "--apps", "corten"], ["r16", ...args.slice(1)], ["r017", ...args.slice(1)],
    ["r17", "--commit", "HEAD", ...args.slice(3)], ["r17", "--commit", commit, "--state-dir", "/bench/group2"],
    ["r17", "--commit", commit, "--commit", commit], [["r17"], ...args.slice(1)]]) assert.throws(() => parseCampaignArgs(input));
});
test("private inbox has bounded physical bytes, never follows producer hardlinks", () => {
  for (const group of ["json-api", "mixed-production"]) {
    const directory = join(temporary, group); mkdirSync(directory);
    assert.equal(readAuditInbox(directory, group), null);
    const path = join(directory, `${group === "json-api" ? "json" : "mixed"}-audit-delivery.json`);
    writeFileSync(path, '{"review":{"decision":"approved"}}', { mode: 0o600 });
    assert.equal(readAuditInbox(directory, group).delivery.review.decision, "approved", "parsing is not authorization");
    for (const bad of ["foreign", "../json-api", [group]]) assert.throws(() => readAuditInbox(directory, bad));
    linkSync(path, join(directory, "alias.json")); assert.throws(() => readAuditInbox(directory, group), /unsafe audit inbox/);
  }
});
test("entry retains live handle through review wait and exits nonzero for partial campaign", async () => {
  const directory = join(temporary, "job"); mkdirSync(directory);
  const handle = Object.freeze({ id: "r17-0123456789abcdef", directory });
  let state = "active", advances = 0, audit = false, mixed = false, policy, stopped = false, group = "json-api";
  mock.module("./campaign-contract.mjs", { namedExports: { bindCampaign: (input) => input } });
  mock.module("./campaign-verify.mjs", { exports: { validateCampaign: async () => ({ status: "blocked", collectionIntegrity: "unsealed-partial" }) } });
  mock.module("./campaign.mjs", { namedExports: { createCampaign({ authorize }) {
    policy = authorize;
    const status = () => ({ state, auditGroup: group, auditSubjectSha256: "exact-subject", mixedAuditSubjectSha256: "exact-mixed-subject" });
    return {
      async begin(plan, { stateRoot }) { assert.equal(stateRoot, "/bench/campaign"); assert.equal(plan.commit, commit);
        assert.equal(authorize({ action: "begin-campaign", commit, round: "r17" }), true); return handle; },
      status,
      async advance(h) {
        assert.equal(h, handle); advances++;
        if (!audit) { state = "blocked-review-needed"; writeFileSync(join(directory, "json-audit-delivery.json"), '{"subjectSha256":"exact-subject"}', { mode: 0o600 }); }
        else if (!mixed) { group = "mixed-production"; state = "blocked-review-needed"; writeFileSync(join(directory, "mixed-audit-delivery.json"), '{"subjectSha256":"exact-mixed-subject"}', { mode: 0o600 }); }
        else state = "finished";
        return status();
      },
      async submitJsonAudit(h, delivery) {
        assert.equal(h, handle); assert.equal(authorize({ action: "stage-json-audit", auditSubjectSha256: "wrong" }), false);
        assert.equal(authorize({ action: "stage-json-audit", auditSubjectSha256: delivery.subjectSha256 }), true);
        audit = true; state = "active"; return status();
      },
      async submitMixedAudit(h, delivery) {
        assert.equal(h, handle);
        assert.equal(authorize({ action: "stage-json-audit", auditSubjectSha256: delivery.subjectSha256 }), false, "mixed transport is not JSON transport authority");
        assert.equal(authorize({ action: "stage-mixed-audit", auditSubjectSha256: "wrong" }), false);
        assert.equal(authorize({ action: "stage-mixed-audit", auditSubjectSha256: delivery.subjectSha256 }), true);
        mixed = true; state = "active"; return status();
      },
      collect(h) { assert.equal(h, handle); return { manifest: {}, controllerReady: false }; },
      stop() { stopped = true; },
    };
  } } });
  const sigint = process.listenerCount("SIGINT"), sigterm = process.listenerCount("SIGTERM");
  assert.equal(await runCampaignEntry(args), 2); assert.equal(advances, 3); assert.equal(audit, true); assert.equal(mixed, true); assert.equal(stopped, false);
  assert.equal(policy({ action: "stage-json-audit", auditSubjectSha256: "exact-subject" }), false, "past delivery confers no retained transport authority");
  assert.equal(process.listenerCount("SIGINT"), sigint); assert.equal(process.listenerCount("SIGTERM"), sigterm);
});
test.after(() => { assert.ok(inside(resolve(os.tmpdir()), resolve(temporary))); rmSync(temporary, { recursive: true, force: true }); });
