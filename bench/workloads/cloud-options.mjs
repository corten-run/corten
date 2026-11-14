import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { roundName, validateState } from "./cloud-contract.mjs";

const providerCodes = ["provider-command", "provider-credential", "provider-output",
  "account-request", "account-http", "list-request", "list-http", "list-response",
  "create-request", "create-http", "create-response", "create-link", "create-action-request", "create-action-http",
  "create-action-response", "create-action-pending", "delete-request", "delete-http"];
const providerStatuses = [200, 201, 202, 204, 301, 302, 303, 304, 307, 308, 400, 401, 403, 404, 405, 408, 409, 410, 413, 415, 422, 429, 500, 501, 502, 503, 504];
// This is the entire public diagnostic vocabulary, not an acceptance/retry policy.
// Reconstruct data properties only; never copy native exceptions or raw values.
export function providerDiagnostic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fields = Object.getOwnPropertyDescriptors(value), names = Object.keys(fields).sort();
  if (JSON.stringify(names) !== '["code"]' && JSON.stringify(names) !== '["code","httpStatus"]') return undefined;
  const code = fields.code.value;
  if (!providerCodes.includes(code)) return undefined;
  if (!fields.httpStatus) return { code };
  const httpStatus = fields.httpStatus.value;
  if (!code.endsWith("-http") || !providerStatuses.includes(httpStatus)) return undefined;
  return { code, httpStatus };
}
export function providerFailure(error) {
  return error && typeof error === "object" ? providerDiagnostic(Object.getOwnPropertyDescriptor(error, "providerDiagnostic")?.value) : undefined;
}

export function full(value, pattern, label) {
  assert.equal(typeof value, "string", label);
  const match = pattern.exec(value); assert.ok(match && match[0] === value, label); return value;
}
export function validateOptions(o) {
  assert.ok(o && typeof o === "object" && !Array.isArray(o));
  const allowed = ["round", "stateDir", "detach", "collect", "commit", "sshKey", "accountId", "context", "deliverAudit", "auditGroup", "campaign", "approveSubject"];
  assert.ok(Object.keys(o).every((k) => allowed.includes(k)), "unknown option/override");
  roundName(o.round); assert.ok(Number(o.round.slice(1)) >= 17, "official campaigns start at r17");
  assert.ok(typeof o.stateDir === "string" && isAbsolute(o.stateDir) && !/[\r\n\0]/.test(o.stateDir)
    && !/^[\\/]{2}/.test(o.stateDir), "absolute local state root required");
  assert.equal([o.detach, o.collect, o.deliverAudit !== undefined].filter(Boolean).length, 1, "choose detach, collect or audit delivery");
  for (const flag of ["detach", "collect"]) if (o[flag] !== undefined) assert.equal(o[flag], true);
  if (o.detach) {
    full(o.commit, /[a-f0-9]{40}/, "full measured commit required"); full(o.sshKey, /[1-9]\d*/, "SSH key ID required");
    providerIdentity({ accountId: o.accountId, context: o.context });
  } else assert.ok(o.commit === undefined && o.sshKey === undefined && o.accountId === undefined && o.context === undefined, "collection/delivery uses saved reservation");
  if (o.deliverAudit !== undefined) {
    assert.ok(o.auditGroup === undefined || ["json-api", "mixed-production"].includes(o.auditGroup), "fixed native audit group required");
    assert.ok(typeof o.deliverAudit === "string" && isAbsolute(o.deliverAudit), "absolute delivery file required");
    full(o.campaign, new RegExp(`${o.round}-[a-f0-9]{16}`), "exact campaign ID required");
    full(o.approveSubject, /[a-f0-9]{64}/, "explicit operator-approved subject required");
  } else assert.ok(o.auditGroup === undefined && o.campaign === undefined && o.approveSubject === undefined, "audit options require delivery");
  return Object.freeze({ ...o, ...(o.deliverAudit !== undefined ? { auditGroup: o.auditGroup ?? "json-api" } : {}) });
}
export function parseDropletArgs(args) {
  const o = { round: args[0] }, seen = new Set();
  const values = { "--state-dir": "stateDir", "--commit": "commit", "--ssh-key": "sshKey", "--account-id": "accountId", "--context": "context", "--deliver-audit": "deliverAudit", "--audit-group": "auditGroup", "--campaign": "campaign", "--approve-subject": "approveSubject" };
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]; assert.ok(!seen.has(flag), "duplicate option"); seen.add(flag);
    if (flag === "--detach" || flag === "--collect") o[flag.slice(2)] = true;
    else if (Object.hasOwn(values, flag)) { const value = args[++i]; assert.ok(value && !value.startsWith("--"), "option needs value"); o[values[flag]] = value; }
    else assert.fail(`unknown option ${flag}`);
  }
  return validateOptions(o);
}
export function providerIdentity(provider) {
  assert.ok(provider && typeof provider === "object" && !Array.isArray(provider), "saved provider identity required; never infer legacy account");
  assert.deepEqual(Object.keys(provider).sort(), ["accountId", "context"]);
  // DigitalOcean IDs are opaque strings, not necessarily RFC-4122 UUIDs.
  full(provider.accountId, /(?:user|team):[A-Za-z0-9][A-Za-z0-9-]{0,127}/, "scoped stable account UUID required");
  full(provider.context, /[A-Za-z0-9][A-Za-z0-9_.-]{0,127}/, "explicit saved doctl context required");
  return provider;
}
export function providerAccount(value) {
  const account = Array.isArray(value) && value.length === 1 ? value[0] : value;
  assert.ok(account && typeof account === "object" && !Array.isArray(account), "account identity unavailable");
  const team = Object.hasOwn(account, "team");
  const uuid = team ? account.team?.uuid : account.uuid;
  full(uuid, /[A-Za-z0-9][A-Za-z0-9-]{0,127}/, "account identity unavailable");
  return `${team ? "team" : "user"}:${uuid}`;
}
export function controllerState(s, round) {
  validateState(s, round);
  const allowed = ["schema", "round", "commit", "token", "name", "tag", "unit", "host", "selection", "createdAt", "status", "id", "ip",
    "createIntentAt", "archiveSha256", "evidenceSha256", "extractionAttempts", "evidence", "evidenceOutcome", "collectedAt", "deletionIntentAt", "destroyedAt",
    "fullGroupQualified", "exitCode", "validation", "auditIntent", "auditIntents", "provider"];
  assert.ok(Object.keys(s).every((k) => allowed.includes(k)), "unknown controller state field");
  providerIdentity(s.provider);
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
    assert.ok(["verified", "failed", "blocked"].includes(s.validation.status));
    full(s.validation.campaign, new RegExp(`${round}-[a-f0-9]{16}`), "validated campaign");
    assert.equal(s.validation.collectionIntegrity, "manifest-verified");
  }
  if (s.auditIntent !== undefined) {
    assert.deepEqual(Object.keys(s.auditIntent).sort(), ["campaign", "sha256", "subjectSha256"].sort());
    full(s.auditIntent.campaign, new RegExp(`${round}-[a-f0-9]{16}`), "audit campaign");
    for (const key of ["sha256", "subjectSha256"]) full(s.auditIntent[key], /[a-f0-9]{64}/, key);
  }
  if (s.auditIntents !== undefined) {
    assert.ok(s.auditIntents && typeof s.auditIntents === "object" && !Array.isArray(s.auditIntents));
    for (const [group, intent] of Object.entries(s.auditIntents)) {
      assert.ok(["json-api", "mixed-production"].includes(group));
      assert.deepEqual(Object.keys(intent).sort(), ["group", "campaign", "sha256", "subjectSha256"].sort());
      assert.equal(intent.group, group); full(intent.campaign, new RegExp(`${round}-[a-f0-9]{16}`), "audit campaign");
      for (const key of ["sha256", "subjectSha256"]) full(intent[key], /[a-f0-9]{64}/, key);
    }
    assert.ok(!(s.auditIntent && s.auditIntents["json-api"]), "duplicate legacy JSON audit attempt");
  }
  return s;
}
export function campaignOutcome(report, s, exitCode) {
  assert.ok(report && ["verified", "failed", "blocked"].includes(report.status), "invalid/missing or unsupported native campaign validation; preserve host");
  assert.equal(report.schema, "benchmark-isolated-campaign-inspection/v1"); assert.equal(report.scope, "intrinsic-evidence");
  assert.equal(report.round, s.round); assert.equal(report.commit, s.commit);
  full(report.campaign, new RegExp(`${s.round}-[a-f0-9]{16}`), "native campaign identity");
  assert.deepEqual(report.uncollectedNativeRoots, [], "native evidence remains on host");
  assert.equal(report.collectionIntegrity, "manifest-verified", "unsealed native evidence");
  assert.equal(report.commandLifecycle, "observed-terminal", "uncertain native command lifecycle");
  assert.ok(Array.isArray(report.blockers) && report.blockers.every((b) => typeof b === "string"));
  for (const key of ["campaignSha256", "sourceSha256", "archiveTreeSha256", "reservationSha256"]) full(report[key], /[a-f0-9]{64}/, key);
  assert.equal(exitCode, report.status === "verified" ? 0 : 1, "native CLI exit disagrees or remains uncertain; preserve host");
  if (report.status === "verified") {
    const fields = ["schema", "scope", "status", "round", "commit", "campaign", "campaignSha256", "sourceSha256", "selection", "groups", "blockers",
      "collectionIntegrity", "commandLifecycle", "uncollectedNativeRoots", "archiveTreeSha256", "reservationSha256"];
    assert.deepEqual(Object.keys(report).sort(), fields.sort(), "verified inspection schema differs");
    assert.deepEqual(report.selection, s.selection, "complete current native selection required"); assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.groups.map((r) => r.group), s.selection.groups.map((r) => r.group), "complete ordered native groups required");
    for (const [index, group] of report.groups.entries()) {
      assert.equal(group.outcome, "native-validated");
      for (const key of ["bindingSha256", "nativeManifestSha256"]) full(group[key], /[a-f0-9]{64}/, key);
      assert.deepEqual(group.appOutcomes.map((r) => r.app), s.selection.groups[index].apps);
      for (const row of group.appOutcomes) {
        assert.ok(["passed", "failed", "unsupported"].includes(row.outcome));
        assert.equal(typeof row.comparisonEligible, "boolean");
        if (row.comparisonEligible) assert.equal(row.outcome, "passed");
      }
    }
  } else {
    assert.equal(report.qualified, false); assert.equal(report.controllerReady, false);
    assert.equal(report.isolation, "unverified"); assert.equal(report.deletionAuthorized, false);
  }
  return { fullGroupQualified: false, evidenceOutcome: report.status === "verified" ? "validated" : report.status };
}
