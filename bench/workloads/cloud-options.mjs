import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { roundName, validateState } from "./cloud-contract.mjs";

export function full(value, pattern, label) {
  assert.equal(typeof value, "string", label);
  const match = pattern.exec(value); assert.ok(match && match[0] === value, label); return value;
}
export function validateOptions(o) {
  assert.ok(o && typeof o === "object" && !Array.isArray(o));
  const allowed = ["round", "stateDir", "detach", "collect", "commit", "sshKey", "deliverAudit", "campaign", "approveSubject"];
  assert.ok(Object.keys(o).every((k) => allowed.includes(k)), "unknown option/override");
  roundName(o.round); assert.ok(Number(o.round.slice(1)) >= 17, "official campaigns start at r17");
  assert.ok(typeof o.stateDir === "string" && isAbsolute(o.stateDir) && !/[\r\n\0]/.test(o.stateDir)
    && !/^[\\/]{2}/.test(o.stateDir), "absolute local state root required");
  assert.equal([o.detach, o.collect, o.deliverAudit !== undefined].filter(Boolean).length, 1, "choose detach, collect or audit delivery");
  for (const flag of ["detach", "collect"]) if (o[flag] !== undefined) assert.equal(o[flag], true);
  if (o.detach) {
    full(o.commit, /[a-f0-9]{40}/, "full measured commit required"); full(o.sshKey, /[1-9]\d*/, "SSH key ID required");
  } else assert.ok(o.commit === undefined && o.sshKey === undefined, "collection/delivery uses saved reservation");
  if (o.deliverAudit !== undefined) {
    assert.ok(typeof o.deliverAudit === "string" && isAbsolute(o.deliverAudit), "absolute delivery file required");
    full(o.campaign, new RegExp(`${o.round}-[a-f0-9]{16}`), "exact campaign ID required");
    full(o.approveSubject, /[a-f0-9]{64}/, "explicit operator-approved subject required");
  } else assert.ok(o.campaign === undefined && o.approveSubject === undefined, "audit options require delivery");
  return Object.freeze({ ...o });
}
export function parseDropletArgs(args) {
  const o = { round: args[0] }, seen = new Set();
  const values = { "--state-dir": "stateDir", "--commit": "commit", "--ssh-key": "sshKey", "--deliver-audit": "deliverAudit", "--campaign": "campaign", "--approve-subject": "approveSubject" };
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]; assert.ok(!seen.has(flag), "duplicate option"); seen.add(flag);
    if (flag === "--detach" || flag === "--collect") o[flag.slice(2)] = true;
    else if (Object.hasOwn(values, flag)) { const value = args[++i]; assert.ok(value && !value.startsWith("--"), "option needs value"); o[values[flag]] = value; }
    else assert.fail(`unknown option ${flag}`);
  }
  return validateOptions(o);
}
export function controllerState(s, round) {
  validateState(s, round);
  const allowed = ["schema", "round", "commit", "token", "name", "tag", "unit", "host", "selection", "createdAt", "status", "id", "ip",
    "createIntentAt", "archiveSha256", "evidenceSha256", "extractionAttempts", "evidence", "evidenceOutcome", "collectedAt", "deletionIntentAt", "destroyedAt",
    "fullGroupQualified", "exitCode", "validation", "auditIntent"];
  assert.ok(Object.keys(s).every((k) => allowed.includes(k)), "unknown controller state field");
  assert.equal(s.id === undefined, s.ip === undefined, "partial host identity");
  if (s.status !== "reserved") assert.ok(s.createIntentAt, "missing create intent");
  if (s.status === "reserved") assert.ok(!s.createIntentAt && !s.id, "reserved host already has create intent");
  if (s.status === "creating") assert.ok(!s.id, "creating host unexpectedly bound");
  assert.equal(s.fullGroupQualified, false, "this provisional contract cannot qualify a campaign");
  if (s.evidence) assert.ok(s.archiveSha256 && s.evidenceSha256, "unhashed evidence");
  if (s.collectedAt || s.status === "collected") assert.ok(s.evidence && s.validation && ["validated", "failed", "blocked"].includes(s.evidenceOutcome), "incomplete collection state");
  if (s.destroyedAt) assert.ok(s.deletionIntentAt, "deletion confirmation without intent");
  if (s.exitCode !== undefined) assert.ok(Number.isInteger(s.exitCode) && s.exitCode >= 0 && s.exitCode <= 255, "exit code");
  if (s.validation !== undefined) {
    assert.deepEqual(Object.keys(s.validation).sort(), ["status", "campaign", "collectionIntegrity"].sort());
    assert.ok(["failed", "blocked"].includes(s.validation.status));
    full(s.validation.campaign, new RegExp(`${round}-[a-f0-9]{16}`), "validated campaign");
    assert.equal(s.validation.collectionIntegrity, "manifest-verified");
  }
  if (s.auditIntent !== undefined) {
    assert.deepEqual(Object.keys(s.auditIntent).sort(), ["campaign", "sha256", "subjectSha256"].sort());
    full(s.auditIntent.campaign, new RegExp(`${round}-[a-f0-9]{16}`), "audit campaign");
    for (const key of ["sha256", "subjectSha256"]) full(s.auditIntent[key], /[a-f0-9]{64}/, key);
  }
  return s;
}
export function campaignOutcome(report, s, exitCode) {
  assert.ok(report && ["failed", "blocked"].includes(report.status), "invalid/missing or unsupported native campaign validation; preserve host");
  assert.equal(report.round, s.round); assert.equal(report.commit, s.commit);
  full(report.campaign, new RegExp(`${s.round}-[a-f0-9]{16}`), "native campaign identity");
  assert.deepEqual(report.uncollectedNativeRoots, [], "native evidence remains on host");
  assert.equal(report.collectionIntegrity, "manifest-verified", "unsealed native evidence");
  assert.ok(Array.isArray(report.blockers));
  assert.equal(report.qualified, false); assert.equal(report.controllerReady, false);
  assert.equal(report.isolation, "unverified"); assert.equal(report.deletionAuthorized, false);
  return { fullGroupQualified: false, evidenceOutcome: exitCode !== 0 || report.status === "failed" ? "failed" : "blocked" };
}
