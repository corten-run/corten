// Execute the fixed remote program against a fake filesystem/process, not a cloud host.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { auditDelivery, auditProgram, auditProtocol } from "./cloud-audit.mjs";
import { deploymentSha256 } from "./deployments.mjs";
import { commit, campaign, syntheticDelivery } from "./cloud-fixtures.mjs";

function fake(flags = {}, group = "json-api") {
  const token = "0123456789abcdef", dir = `/bench/campaign/${campaign}`, cp = "c".repeat(64);
  const { prefix } = auditProtocol(group), delivery = syntheticDelivery(group);
  if (flags.bundleSchema) delivery.bundle.schema = flags.bundleSchema;
  const identities = delivery.bundle.receipts.map((r) => r.identity);
  const body = { schema: `benchmark-${prefix}-audit-subject/v1`, campaignSha256: cp, commit,
    ...(group === "mixed-production" ? { requests: identities.map((identity) => ({ identity })) } : { identities }), qualified: false };
  const subject = { ...body, subjectSha256: deploymentSha256(body) };
  delivery.subjectSha256 = delivery.review.subjectSha256 = subject.subjectSha256;
  if (flags.changedReceipt) delivery.bundle.receipts[0].identity = { ...delivery.bundle.receipts[0].identity, imageId: "synthetic-unapproved-image" };
  const bytes = Buffer.from(JSON.stringify(delivery)), stage = `/bench/cloud-${prefix}-audit-${token}.json`,
    target = `${dir}/${prefix}-audit-delivery${flags.control ? "-pending" : ""}.json`;
  const files = new Map([
    ["/bench/campaign/.host-attempt.json", JSON.stringify({ id: campaign, commit, campaignSha256: cp })],
    [`${dir}/plan.json`, JSON.stringify({ round: "r21", commit, campaignSha256: cp })],
    [`${dir}/00000-review-needed.json`, JSON.stringify({ status: { campaign, round: "r21", campaignSha256: cp, state: flags.finished ? "finished" : "blocked-review-needed",
      auditGroup: flags.wrongGroup ? "foreign" : group, auditInbox: `${campaign}/${prefix}-audit-delivery.json`,
      [group === "mixed-production" ? "mixedAuditSubjectSha256" : "auditSubjectSha256"]: subject.subjectSha256 } })],
    [`${dir}/${prefix}-audit-subject.json`, JSON.stringify(flags.changedSubject ? { ...subject, commit: "b".repeat(40) } : subject)],
    [stage, bytes],
  ]);
  if (flags.collision) files.set(target, "existing inbox");
  let moves = 0;
  const fs = {
    realpathSync: (d) => flags.symlink && d === dir ? "/foreign" : d,
    lstatSync(f, options) {
      const directory = f === "/bench/campaign" || f === dir;
      if (!directory && !files.has(f)) { if (options?.throwIfNoEntry === false) return undefined; throw new Error("missing fake file"); }
      return { isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false, size: Buffer.byteLength(files.get(f) ?? ""),
        nlink: flags.hardlink && f === stage ? 2 : 1, uid: flags.foreignOwner ? 1001 : 1000, mode: flags.publicStage && f === stage ? 0o644 : 0o600 };
    },
    readFileSync: (f) => Buffer.from(files.get(f)),
    readdirSync: () => ["plan.json", "00000-review-needed.json", `${prefix}-audit-subject.json`],
  };
  const intent = { group, campaign, sha256: createHash("sha256").update(bytes).digest("hex"), subjectSha256: subject.subjectSha256 };
  const run = () => runInNewContext(auditProgram({ token, round: "r21", commit, ...(flags.control ? { control: {} } : {}) }, intent, true), {
    require(name) {
      if (name === "node:fs") return fs;
      if (name === "node:path") return path.posix;
      if (name === "node:assert/strict") return assert;
      if (name === "node:crypto") return { createHash };
      if (name === "node:child_process") return { spawnSync(binary, args, options) {
        moves++; assert.equal(binary, "mv"); assert.deepEqual(Array.from(args), ["-T", "--no-clobber", "--", stage, target]); assert.equal(options.timeout, 10000);
        if (flags.raceCollision) files.set(target, "racing inbox");
        if (!files.has(target)) { files.set(target, files.get(stage)); files.delete(stage); }
        return { status: 0 };
      } };
      assert.fail("unapproved fake process dependency");
    }, process: { getuid: () => 1000 }, console: { log: () => {} }, Buffer,
  }, { timeout: 1000 });
  const intake = () => auditDelivery(bytes, { campaign, approveSubject: subject.subjectSha256, auditGroup: group });
  return { run, intake, files, target, stage, get moves() { return moves; } };
}
test("local and remote inboxes agree on current JSON audit envelopes without admitting foreign versions or groups", () => {
  for (const group of ["json-api", "mixed-production"]) {
    for (const schema of ["json-api-native-audits/v1", "json-api-native-audits/v2", "json-api-native-audits/v3", "mixed-native-source-audits/v1"]) {
      const probe = fake({ bundleSchema: schema }, group);
      if (group === "json-api" ? ["json-api-native-audits/v1", "json-api-native-audits/v2"].includes(schema) : schema === "mixed-native-source-audits/v1") {
        assert.equal(probe.intake().group, group); probe.run(); assert.equal(probe.moves, 1);
      } else {
        assert.throws(probe.intake); assert.throws(probe.run); assert.equal(probe.moves, 0);
      }
    }
  }
});
test("new JSON API audit delivery must include newly registered apps", () => {
  const delivery = syntheticDelivery("json-api");
  const options = { campaign, approveSubject: delivery.subjectSha256, auditGroup: "json-api" };
  assert.equal(auditDelivery(Buffer.from(JSON.stringify(delivery)), options).group, "json-api");
  delivery.bundle.receipts = delivery.bundle.receipts.filter((r) => r.identity.app !== "ntex");
  assert.throws(() => auditDelivery(Buffer.from(JSON.stringify(delivery)), options), /complete native audit selection required/);
});
test("fixed remote inbox publishes once, rebinds subject body, and never overwrites a collision", () => {
  for (const group of ["json-api", "mixed-production"]) {
  const h = fake({}, group); h.run(); assert.ok(h.files.has(h.target)); assert.ok(!h.files.has(h.stage)); assert.equal(h.moves, 1);
  assert.throws(h.run); assert.equal(h.moves, 1);
  for (const flags of [{ finished: true }, { changedSubject: true }, { changedReceipt: true }, { wrongGroup: true }, { hardlink: true }, { foreignOwner: true }, { publicStage: true }, { symlink: true }, { collision: true }, { raceCollision: true }]) {
    const h = fake(flags, group); assert.throws(h.run); assert.ok(h.files.has(h.stage));
    if (flags.collision || flags.raceCollision) assert.equal(h.files.get(h.target), flags.collision ? "existing inbox" : "racing inbox");
  }
  }
  for (const field of ["round", "commit", "token"]) assert.throws(() => auditProgram({ round: "r21", commit, token: "0123456789abcdef", [field]: "'; arbitraryCommand #" },
    { campaign, sha256: "a".repeat(64), subjectSha256: "b".repeat(64) }));
});

test("registered audit publish leaves only pending delivery for the detached sealed-admission barrier", () => {
  for (const group of ["json-api", "mixed-production"]) {
    const h = fake({ control: true }, group); h.run();
    assert.ok(h.files.has(h.target)); assert.ok(h.target.endsWith("-pending.json"));
    assert.ok(!h.files.has(h.target.replace("-pending.json", ".json")));
    assert.throws(h.run); assert.equal(h.moves, 1);
  }
});
