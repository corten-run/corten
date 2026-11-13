// Execute the fixed remote program against a fake filesystem/process, not a cloud host.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { auditProgram } from "./cloud-audit.mjs";
import { deploymentSha256 } from "./deployments.mjs";
import { commit, campaign } from "./cloud-fixtures.mjs";

function fake(flags = {}) {
  const token = "0123456789abcdef", dir = `/bench/campaign/${campaign}`, cp = "c".repeat(64);
  const body = { schema: "benchmark-json-audit-subject/v1", campaignSha256: cp, commit, identities: [], qualified: false };
  const subject = { ...body, subjectSha256: deploymentSha256(body) };
  const bytes = Buffer.from('{"notAuthority":true}'), stage = `/bench/cloud-audit-${token}.json`, target = `${dir}/json-audit-delivery.json`;
  const files = new Map([
    ["/bench/campaign/.host-attempt.json", JSON.stringify({ id: campaign, commit, campaignSha256: cp })],
    [`${dir}/plan.json`, JSON.stringify({ round: "r21", commit, campaignSha256: cp })],
    [`${dir}/00000-review-needed.json`, JSON.stringify({ status: { campaign, round: "r21", campaignSha256: cp, state: flags.finished ? "finished" : "blocked-review-needed", auditSubjectSha256: subject.subjectSha256 } })],
    [`${dir}/json-audit-subject.json`, JSON.stringify(flags.changedSubject ? { ...subject, commit: "b".repeat(40) } : subject)],
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
    readdirSync: () => ["plan.json", "00000-review-needed.json", "json-audit-subject.json"],
  };
  const intent = { campaign, sha256: createHash("sha256").update(bytes).digest("hex"), subjectSha256: subject.subjectSha256 };
  const run = () => runInNewContext(auditProgram({ token, round: "r21", commit }, intent, true), {
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
  return { run, files, target, stage, get moves() { return moves; } };
}
test("fixed remote inbox publishes once, rebinds subject body, and never overwrites a collision", () => {
  const h = fake(); h.run(); assert.ok(h.files.has(h.target)); assert.ok(!h.files.has(h.stage)); assert.equal(h.moves, 1);
  assert.throws(h.run); assert.equal(h.moves, 1);
  for (const flags of [{ finished: true }, { changedSubject: true }, { hardlink: true }, { foreignOwner: true }, { publicStage: true }, { symlink: true }, { collision: true }, { raceCollision: true }]) {
    const h = fake(flags); assert.throws(h.run); assert.ok(h.files.has(h.stage));
    if (flags.collision || flags.raceCollision) assert.equal(h.files.get(h.target), flags.collision ? "existing inbox" : "racing inbox");
  }
  for (const field of ["round", "commit", "token"]) assert.throws(() => auditProgram({ round: "r21", commit, token: "0123456789abcdef", [field]: "'; arbitraryCommand #" },
    { campaign, sha256: "a".repeat(64), subjectSha256: "b".repeat(64) }));
});
