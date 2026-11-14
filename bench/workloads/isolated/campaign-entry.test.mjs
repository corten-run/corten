import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { inside } from "./evidence.mjs";
import { parseCampaignArgs, readAuditInbox, runCampaignEntry } from "./campaign-entry.mjs";
import { groupNames } from "../registry.mjs";

const temporary = mkdtempSync(join(os.tmpdir(), "isolated-entry-test-"));
const commit = "a".repeat(40), args = ["r17", "--commit", commit, "--state-dir", "/bench/campaign"];
test("fixed entry grammar refuses filters, extra paths, duplicate args, stale identity shapes", () => {
  assert.deepEqual(parseCampaignArgs(args), { round: "r17", commit, stateRoot: "/bench/campaign" });
  for (const input of [[], [...args, "--apps", "corten"], ["r16", ...args.slice(1)], ["r017", ...args.slice(1)],
    ["r17", "--commit", "HEAD", ...args.slice(3)], ["r17", "--commit", commit, "--state-dir", "/bench/group2"],
    ["r17", "--commit", commit, "--commit", commit], [["r17"], ...args.slice(1)]]) assert.throws(() => parseCampaignArgs(input));
});
test("fixed entry accepts one exact registry group, never app filters or overrides", () => {
  for (const group of ["catalog-page", "json-api", "localized-marketplace", "mixed-production", "fullstack-browser",
    "client-heavy", "live-delivery", "recoverable-live", "hardening"]) {
    assert.deepEqual(parseCampaignArgs([...args, "--group", group]), { round: "r17", commit, stateRoot: "/bench/campaign", group });
  }
  for (const tail of [["--group", "foreign"], ["--group", ""], ["--group"], ["--apps", "corten"],
    ["--group", "catalog-page", "--group", "json-api"], ["--group", "catalog-page", "--apps", "corten"],
    ["--group", "catalog-page", "--recipe", "native-defaults"]]) assert.throws(() => parseCampaignArgs([...args, ...tail]));
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
test("entry retains live handle through review wait and exits nonzero for partial campaign", async (t) => {
  const directory = join(temporary, "job"); mkdirSync(directory);
  const handle = Object.freeze({ id: "r17-0123456789abcdef", directory });
  let state = "active", advances = 0, audit = false, mixed = false, policy, stopped = false, group = "json-api";
  t.mock.module("./campaign-contract.mjs", { namedExports: { bindCampaign: (input) => input } });
  t.mock.module("./campaign-verify.mjs", { exports: { validateCampaign: async () => ({ status: "blocked", collectionIntegrity: "unsealed-partial" }) } });
  t.mock.module("./campaign.mjs", { namedExports: { createCampaign({ authorize }) {
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
test("group entry chooses the group binder and retains the same audit and terminal exits", async (t) => {
  let expectedGroup, state, checked, calls, delivered, savedStatus = "verified";
  const handle = { id: "r17-0123456789abcdef", directory: null };
  t.mock.module("./campaign-contract.mjs", { exports: {
    bindCampaign() { assert.fail("group launch must not bind an all-group campaign"); },
    bindGroupCampaign(input) { assert.deepEqual(input, { round: "r17", commit, group: expectedGroup }); return { ...input, order: [input.group] }; },
  } });
  t.mock.module("./campaign-verify.mjs", { exports: { async validateCampaign(input) {
    assert.deepEqual(input, { folder: "/bench/campaign", round: "r17", commit }); checked = true;
    return { status: savedStatus, collectionIntegrity: "manifest-verified", commandLifecycle: "observed-terminal", uncollectedNativeRoots: [] };
  } } });
  t.mock.module("./campaign.mjs", { exports: { createCampaign({ authorize }) {
    const status = () => ({ state, auditGroup: expectedGroup, auditSubjectSha256: "json-subject", mixedAuditSubjectSha256: "mixed-subject" });
    const submit = async (h, delivery) => {
      assert.equal(h, handle); assert.equal(state, "blocked-review-needed");
      assert.equal(authorize({ action: expectedGroup === "json-api" ? "stage-json-audit" : "stage-mixed-audit", auditSubjectSha256: delivery.subjectSha256 }), true);
      delivered = true; state = "active"; return status();
    };
    return {
      async begin(plan, { stateRoot }) {
        assert.deepEqual(plan.order, [expectedGroup]); assert.equal(stateRoot, "/bench/campaign");
        const subject = { action: "begin-campaign", round: "r17", commit, groups: [expectedGroup] };
        assert.equal(authorize(subject), true); assert.equal(authorize({ ...subject, groups: groupNames }), false);
        assert.equal(authorize({ ...subject, groups: ["foreign"] }), false);
        assert.equal(authorize({ action: "stage-json-audit", auditSubjectSha256: "json-subject" }), false);
        return handle;
      }, status,
      async advance(h) {
        assert.equal(h, handle); calls++;
        if (["json-api", "mixed-production"].includes(expectedGroup) && !delivered) {
          state = "blocked-review-needed";
          const prefix = expectedGroup === "json-api" ? "json" : "mixed";
          writeFileSync(join(handle.directory, `${prefix}-audit-delivery.json`), JSON.stringify({ subjectSha256: `${prefix}-subject` }), { mode: 0o600 });
        } else state = "finished";
        return status();
      }, submitJsonAudit: submit, submitMixedAudit: submit,
      collect(h) { assert.equal(h, handle); assert.equal(state, "finished"); return {}; },
      stop() { assert.fail("completed entry does not stop or release the host"); },
    };
  } } });
  for (const group of groupNames) {
    expectedGroup = group; state = "active"; checked = false; calls = 0; delivered = false;
    handle.directory = join(temporary, `entry-${group}`); mkdirSync(handle.directory);
    const sigint = process.listenerCount("SIGINT"), sigterm = process.listenerCount("SIGTERM");
    assert.equal(await runCampaignEntry([...args, "--group", group]), 0); assert.equal(checked, true);
    assert.equal(calls, ["json-api", "mixed-production"].includes(group) ? 2 : 1);
    assert.equal(process.listenerCount("SIGINT"), sigint); assert.equal(process.listenerCount("SIGTERM"), sigterm);
  }
  for (const [status, code] of [["failed", 1], ["blocked", 1], ["invalid", 2]]) {
    savedStatus = status; state = "active"; expectedGroup = "catalog-page";
    handle.directory = join(temporary, `entry-${status}`); mkdirSync(handle.directory);
    assert.equal(await runCampaignEntry([...args, "--group", expectedGroup]), code);
  }
});
test.after(() => { assert.ok(inside(resolve(os.tmpdir()), resolve(temporary))); rmSync(temporary, { recursive: true, force: true }); });
