import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { roundName, savedLoadLayout, savedPlacement, selection, terminalUnit, validateState } from "./cloud-contract.mjs";

// A disposition of one fenced DELETE, not a diagnostic or permission to retry.
export const unsentDelete = Object.freeze({ status: 1, stdout: "", stderr: "", deleteNotDispatched: true });
// In-process only: the controller refused before calling the provider worker.
export const unsentCreate = Symbol("create not dispatched");
export function quarantineCensusTargets(command) {
  assert.deepEqual(command.slice(0, 4), ["compute", "droplet", "list", "--pre-create-census"]);
  assert.deepEqual(command.slice(-2), ["--output", "json"]);
  const pairs = command.slice(4, -2);
  assert.ok(pairs.length >= 1 && pairs.length <= 12 && new Set(pairs).size === pairs.length
    && pairs.every((pair) => /^[a-f0-9]{64}:[a-f0-9]{64}$/.test(pair)), "invalid create quarantine targets");
  return pairs.map((pair) => pair.split(":"));
}
const providerCodes = ["provider-command", "provider-credential", "provider-output",
  "account-request", "account-http", "account-capacity", "get-request", "get-http", "get-response", "list-request", "list-http", "list-response",
  "list-response-shape", "list-response-total", "list-response-id", "list-response-duplicate",
  "list-response-links", "list-response-pages", "list-response-next", "list-response-count", "list-response-bounds",
  "catalog-request", "catalog-http", "catalog-response",
  "create-request", "create-http", "create-response", "create-link", "create-action-request", "create-action-http",
  "create-link-shape", "create-link-count", "create-link-id", "create-link-rel", "create-link-href",
  "create-action-response", "create-action-pending", "create-action-errored", "create-errored-absent", "delete-request", "delete-http",
  "action-request", "action-http", "action-response", "bootstrap-marker"];
const providerStatuses = [200, 201, 202, 204, 301, 302, 303, 304, 307, 308, 400, 401, 403, 404, 405, 408, 409, 410, 413, 415, 422, 429, 500, 501, 502, 503, 504];
export const catalogClosureDetails = Object.freeze(["request-error", "response-error", "response-aborted"]);
const providerDetails = {
  "account-request": ["internal-refusal", "connect", "send", "request-error", "response-error", "response-aborted",
    "response-status", "body-limit", "invalid-json", "deadline", "cancelled"],
  "catalog-request": [...catalogClosureDetails, "internal-refusal", "connect", "send", "response-status", "body-limit", "deadline", "cancelled"],
  "create-request": ["internal-refusal", "connect", "send", "request-error", "response-error", "response-aborted",
    "response-status", "body-limit", "invalid-json", "deadline", "cancelled"],
  "create-link-href": ["non-string", "malformed-uri", "credentials-or-fragment", "foreign-origin",
    "semantically-same-canonical-uri", "query-or-trailing-slash", "wrong-action-or-resource"],
  "list-response-count": ["terminal-count-mismatch", "total-changed"],
  // The existing report envelope also carries the launch's marker diagnosis.
  "bootstrap-marker": ["local-control-uncertain", "remote-completion-unconfirmed", "acknowledged-exit-refused", "marker-invalid"],
};
// This is the entire public diagnostic vocabulary, not an acceptance/retry policy.
// Reconstruct data properties only; never copy native exceptions or raw values.
export function providerDiagnostic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fields = Object.getOwnPropertyDescriptors(value), names = Object.keys(fields).sort();
  if (![ '["code"]', '["code","httpStatus"]', '["code","detail"]' ].includes(JSON.stringify(names))) return undefined;
  const code = fields.code.value;
  if (!providerCodes.includes(code)) return undefined;
  if (fields.detail) {
    const detail = fields.detail.value;
    return providerDetails[code]?.includes(detail) ? { code, detail } : undefined;
  }
  if (!fields.httpStatus) return code === "bootstrap-marker" ? undefined : { code };
  const httpStatus = fields.httpStatus.value;
  if (!code.endsWith("-http") || !providerStatuses.includes(httpStatus)) return undefined;
  return { code, httpStatus };
}
export function providerFailure(error) {
  return error && typeof error === "object" ? providerDiagnostic(Object.getOwnPropertyDescriptor(error, "providerDiagnostic")?.value) : undefined;
}

// The engine's provider-terminal create failure: the exact action and the droplet
// ID its single POST returned. Identity only, never proof that the droplet is gone.
export function erroredCreate(result) {
  if (!result || typeof result !== "object" || result.status !== 1 || providerFailure(result)?.code !== "create-action-errored") return undefined;
  const stdout = result.stdout;
  if (typeof stdout !== "string" || !/^\[\{"id":[1-9]\d{0,15},"actionId":[1-9]\d{0,15}\}\]$/.test(stdout)) return undefined;
  const [{ id, actionId }] = JSON.parse(stdout);
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(actionId)) return undefined;
  return { dropletId: String(id), actionId: String(actionId) };
}

// The droplet and create action IDs of an accepted POST whose outcome is still
// unknown. Identity only: never completion, failure or absence proof.
export function pendingCreate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== '["actionId","dropletId"]') return undefined;
  const ids = [value.dropletId, value.actionId];
  if (!ids.every((id) => typeof id === "string" && /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id)))) return undefined;
  return { dropletId: value.dropletId, actionId: value.actionId };
}

export function fleetCatalogResult(result) {
  if (result.status !== 0 || result.error) {
    const diagnostic = providerFailure(result);
    throw Object.assign(new Error("fleet catalog read failed"), diagnostic ? { providerDiagnostic: diagnostic } : {});
  }
  return JSON.parse(result.stdout);
}

const nativeReplayStages = ["collect-native-replay-start", "collect-native-replay-deadline", "collect-native-replay-interrupted",
  "collect-native-replay-refused", "collect-native-report-refused", "collect-native-evidence-refused"];
const controllerStages = ["source-plan", "exact-approval", "remote-main-advertisement", "remote-main-fetch", "remote-main-ancestry",
  "source-recheck", "controller-construction", "controller-launch", "controller-collect", "controller-audit", "controller-cancellation", "controller-retirement", "controller-checkpoint", "provider-settlement",
  "setup-watcher-proof-missing", "setup-host-proof-refused",
  // Refusals whose supported operator route the CLI names (publicError).
  "offline-never-started", "create-errored-contradicted", "create-contradiction-unpublished", ...nativeReplayStages];
// Detailed collect-time stages survive the production wrapper's phase mark.
export const routeStages = ["setup-watcher-proof-missing", "setup-host-proof-refused", "offline-never-started", "create-errored-contradicted", "create-contradiction-unpublished",
  ...nativeReplayStages];
export function controllerFailure(error) {
  const stage = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "controllerStage")?.value : undefined;
  return controllerStages.includes(stage) ? stage : undefined;
}

export function full(value, pattern, label) {
  assert.equal(typeof value, "string", label);
  const match = pattern.exec(value); assert.ok(match && match[0] === value, label); return value;
}
export function validateOptions(o) {
  assert.ok(o && typeof o === "object" && !Array.isArray(o));
  const allowed = ["round", "stateDir", "detach", "collect", "r21MeasuredCheckout", "absentMeasuredCheckout", "exitArchiveSha256", "unusedBootstrapKnownHosts", "cancelMixedWait", "retireFailedNative", "commit", "sshKey", "accountId", "context", "deliverAudit", "auditGroup", "campaign", "approveSubject", "group", "fleet"];
  assert.ok(Object.keys(o).every((k) => allowed.includes(k)), "unknown option/override");
  roundName(o.round); assert.ok(Number(o.round.slice(1)) >= 17, "official campaigns start at r17");
  assert.ok(typeof o.stateDir === "string" && isAbsolute(o.stateDir) && !/[\r\n\0]/.test(o.stateDir)
    && !/^[\\/]{2}/.test(o.stateDir), "absolute local state root required");
  assert.equal([o.detach, o.collect, o.cancelMixedWait, o.retireFailedNative, o.deliverAudit !== undefined].filter(Boolean).length, 1, "choose exactly one controller action");
  for (const flag of ["detach", "collect", "cancelMixedWait", "retireFailedNative"]) if (o[flag] !== undefined) assert.equal(o[flag], true);
  if (o.r21MeasuredCheckout !== undefined || o.exitArchiveSha256 !== undefined) {
    full(o.exitArchiveSha256, /[a-f0-9]{64}/, "independently verified exit archive digest required");
    assert.ok(o.collect && o.round === "r21" && o.unusedBootstrapKnownHosts === undefined);
    assert.ok(isAbsolute(o.r21MeasuredCheckout) && !/^[\\/]{2}|["$%\r\n\0]/.test(o.r21MeasuredCheckout), "absolute local measured checkout required");
  }
  if (o.unusedBootstrapKnownHosts !== undefined) {
    assert.equal(o.collect, true, "unused bootstrap proof is only for collection");
    assert.ok(typeof o.unusedBootstrapKnownHosts === "string" && isAbsolute(o.unusedBootstrapKnownHosts)
      && !/^[\\/]{2}|["$%\r\n\0]/.test(o.unusedBootstrapKnownHosts), "absolute local verified host-key file required");
  }
  if (o.absentMeasuredCheckout !== undefined) {
    assert.ok(o.collect && !o.r21MeasuredCheckout && o.unusedBootstrapKnownHosts === undefined, "absence-only collection cannot use another recovery mode");
    assert.ok(typeof o.absentMeasuredCheckout === "string" && isAbsolute(o.absentMeasuredCheckout)
      && !/^[\\/]{2}|["$%\r\n\0]/.test(o.absentMeasuredCheckout), "absolute local measured checkout required");
  }
  if (o.detach) {
    full(o.commit, /[a-f0-9]{40}/, "full measured commit required"); full(o.sshKey, /[1-9]\d*/, "SSH key ID required");
    providerIdentity({ accountId: o.accountId, context: o.context });
  } else assert.ok(o.commit === undefined && o.sshKey === undefined && o.accountId === undefined && o.context === undefined, "collection/delivery uses saved reservation");
  if (o.group !== undefined || o.fleet !== undefined) {
    assert.equal(o.detach, true, "group/fleet selection is fixed at reservation, not collection");
    assert.ok(selection().groups.some((row) => row.group === o.group), "current registry group required");
    assert.ok(typeof o.fleet === "string" && isAbsolute(o.fleet) && !/[\r\n\0]/.test(o.fleet)
      && !/^[\\/]{2}/.test(o.fleet), "absolute local fleet plan required");
  }
  if (o.deliverAudit !== undefined) {
    assert.ok(o.auditGroup === undefined || ["json-api", "mixed-production"].includes(o.auditGroup), "fixed native audit group required");
    assert.ok(typeof o.deliverAudit === "string" && isAbsolute(o.deliverAudit), "absolute delivery file required");
    full(o.campaign, new RegExp(`${o.round}-[a-f0-9]{16}`), "exact campaign ID required");
    full(o.approveSubject, /[a-f0-9]{64}/, "explicit operator-approved subject required");
  } else assert.ok(o.auditGroup === undefined && o.campaign === undefined && o.approveSubject === undefined, "audit options require delivery");
  return Object.freeze({ ...o, ...(o.deliverAudit !== undefined ? { auditGroup: o.auditGroup ?? "json-api" } : {}),
    ...(o.unusedBootstrapKnownHosts !== undefined ? { unusedBootstrapKnownHosts: resolve(o.unusedBootstrapKnownHosts) } : {}) });
}
export function parseDropletArgs(args) {
  const o = { round: args[0] }, seen = new Set();
  const values = { "--state-dir": "stateDir", "--commit": "commit", "--ssh-key": "sshKey", "--account-id": "accountId", "--context": "context", "--deliver-audit": "deliverAudit", "--audit-group": "auditGroup", "--campaign": "campaign", "--approve-subject": "approveSubject", "--group": "group", "--fleet": "fleet", "--unused-bootstrap-known-hosts": "unusedBootstrapKnownHosts",
    "--r21-measured-checkout": "r21MeasuredCheckout", "--absent-measured-checkout": "absentMeasuredCheckout", "--exit-archive-sha256": "exitArchiveSha256" };
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]; assert.ok(!seen.has(flag), "duplicate option"); seen.add(flag);
    if (flag === "--retire-failed-native") o.retireFailedNative = true;
    else if (flag === "--cancel-mixed-wait") o.cancelMixedWait = true;
    else if (flag === "--detach" || flag === "--collect") o[flag.slice(2)] = true;
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
// Shape only, like the other saved-state validators here. Exact old-host/wait
// authority belongs to the controller-only cancellation module, never the
// credential worker's deny-unlisted import closure.
export function cancellationState(value) {
  assert.deepEqual(Object.keys(value).sort(), ["controllerCommit", "intentSha256", "reservationSha256", ...(value.signalSha256 === undefined ? [] : ["signalSha256"])].sort());
  full(value.controllerCommit, /[a-f0-9]{40}/, "cancellation controller commit");
  assert.notEqual(value.controllerCommit, "9f3d35884c67d90524f978d173fabeb3a17bc970");
  for (const key of ["intentSha256", "reservationSha256", ...(value.signalSha256 === undefined ? [] : ["signalSha256"])])
    full(value[key], /[a-f0-9]{64}/, "cancellation evidence hash");
}
export const unitQuery = (s) => `systemctl show ${s.unit} --property=Id --property=LoadState --property=FragmentPath --property=ActiveState --property=Restart --property=MainPID --property=ExecMainCode --property=ExecMainStartTimestamp`;
function reappearance(r) {
  assert.ok(r && typeof r === "object" && !Array.isArray(r) && JSON.stringify(Object.keys(r).sort()) === '["at","dropletId","via"]'
    && ["exact-get", "inventory"].includes(r.via) && typeof r.at === "string" && new Date(r.at).toISOString() === r.at
    && typeof r.dropletId === "string" && /^[1-9]\d{0,15}$/.test(r.dropletId), "create failure reappearance record");
}
export function controllerState(s, round, options) {
  validateState(s, round, options);
  const allowed = ["schema", "round", "commit", "token", "name", "tag", "unit", "host", "selection", "createdAt", "status", "id", "ip",
    "createIntentAt", "archiveSha256", "evidenceSha256", "extractionAttempts", "evidence", "evidenceOutcome", "collectedAt", "deletionIntentAt", "destroyedAt",
    "fullGroupQualified", "exitCode", "validation", "auditIntent", "auditIntents", "provider", "group", "fleet", "retirement", "pendingRetirement", "bootstrapReady", "preBootstrapTerminal", "mixedCancellation", "control", "benchPackage", "gitSource", "trixieUpstream", "quietBootstrap", "remainingPlacement", "launchHostKeySha256", "createErrored", "createPending", "createContradicted",
    "skipHostChromium"];
  assert.ok(Object.keys(s).every((k) => allowed.includes(k)), "unknown controller state field");
  providerIdentity(s.provider);
  if (s.fleet) assert.deepEqual(s.provider, s.fleet.provider, "fleet account/context differs");
  assert.equal(s.id === undefined, s.ip === undefined, "partial host identity");
  if (s.status !== "reserved") assert.ok(s.createIntentAt, "missing create intent");
  if (s.status === "reserved") assert.ok(!s.createIntentAt && !s.id, "reserved host already has create intent");
  if (s.status === "creating") assert.ok(!s.id, "creating host unexpectedly bound");
  assert.equal(s.fullGroupQualified, false, "this provisional contract cannot qualify a campaign");
  if (s.launchHostKeySha256 !== undefined) {
    full(s.launchHostKeySha256, /[a-f0-9]{64}/, "launch host-key digest required");
    assert.ok(s.fleet && (s.control?.monitor || s.fleet.single?.offlineHandoff) && s.id && s.ip && s.createIntentAt,
      "launch host key requires a bound registered child");
  }
  if (s.preBootstrapTerminal !== undefined) {
    const p = s.preBootstrapTerminal, m = s.control?.monitor;
    assert.deepEqual(Object.keys(p).sort(), ["hostId", "invocation", "ip", "monitorId", "stdout"]);
    assert.ok(s.status === "starting" || s.status === "retired" && s.retirement?.kind === "setup-failed");
    assert.ok(m?.phase === "pending" && !m.registrationSha256 && !s.bootstrapReady && !s.control.sealed.length);
    assert.ok(!s.validation && !s.collectedAt && !s.evidenceOutcome && s.exitCode === undefined);
    assert.ok(s.id === p.hostId && s.ip === p.ip && m.id === p.monitorId);
    assert.ok(typeof p.stdout === "string" && Buffer.byteLength(p.stdout) <= 4096 && terminalUnit(p.stdout, s));
    const rows = s.control.ledger.filter((r) => r.request.epoch === "bootstrap"), last = rows.at(-1);
    const matched = (row, command) => row.localTerminal && row.code === 0 && row.request.invocation.channel === "ssh"
      && row.request.invocation.requestSha256 === createHash("sha256").update(`set -euo pipefail\n${command}\n`).digest("hex");
    assert.ok(rows.length > 1 && rows.every((r, i) => r === s.control.ledger[i] && r.localTerminal && !r.request.seal)
      && s.control.ledger.slice(rows.length).every((r) => r.request.epoch === "collection"));
    assert.ok(rows.some((r) => matched(r, `systemctl start ${s.unit}`)) && matched(last, unitQuery(s)) && last.request.invocation.id === p.invocation);
  }
  if (s.mixedCancellation !== undefined) {
    assert.equal(s.group, "mixed-production"); assert.equal(s.round, "r21");
    assert.equal(s.commit, "9f3d35884c67d90524f978d173fabeb3a17bc970");
    assert.ok(!s.auditIntent && !s.auditIntents, "cancellation cannot consume an audit attempt");
    cancellationState(s.mixedCancellation);
    assert.ok(s.status === "running" || s.status === "retired" && s.retirement?.kind === "native-failed");
    for (const key of ["collectedAt", "validation", "evidenceOutcome", "exitCode"]) assert.equal(s[key], undefined, "cancellation cannot qualify a campaign");
  }
  if (s.bootstrapReady !== undefined) {
    assert.ok(s.group !== undefined && s.group === s.fleet.jobs[0].group
      && (["running", "collected"].includes(s.status) || s.status === "retired" && ["setup-failed", "native-failed"].includes(s.retirement?.kind)), "only the first started fleet group records bootstrap admission");
    const offline = s.fleet.single?.offlineHandoff;
    assert.deepEqual(Object.keys(s.bootstrapReady).sort(), [...(offline ? ["bootId"] : []), "observedAt", "sha256"]);
    if (offline) full(s.bootstrapReady.bootId, /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/, "bootstrap boot ID required");
    full(s.bootstrapReady.sha256, /[a-f0-9]{64}/, "bootstrap observation hash");
    assert.equal(new Date(s.bootstrapReady.observedAt).toISOString(), s.bootstrapReady.observedAt, "bootstrap observation time required");
  }
  if (s.fleet?.single?.offlineHandoff && s.control.sealed.includes("bootstrap")) {
    assert.ok(s.launchHostKeySha256 && s.bootstrapReady?.bootId, "offline handoff requires pinned bootstrap identity");
    const last = s.control.ledger.filter(({ request }) => request.epoch === "bootstrap").at(-1);
    assert.equal(last.code, 0, "offline handoff requires a successful seal");
  }
  if (s.status === "retired" || s.retirement !== undefined) {
    assert.equal(s.status, "retired");
    assert.ok(s.retirement && typeof s.retirement === "object" && !Array.isArray(s.retirement), "retirement evidence required");
    assert.deepEqual(Object.keys(s.retirement).sort(), ["evidenceSha256", "kind"]);
    assert.ok(["unused", "setup-failed", "native-failed"].includes(s.retirement.kind));
    full(s.retirement.evidenceSha256, /[a-f0-9]{64}/, "retirement evidence hash");
    assert.ok(s.deletionIntentAt, "retirement requires a durable deletion intent");
    for (const key of ["validation", "exitCode", "collectedAt", "evidenceOutcome"])
      assert.equal(s[key], undefined, "retirement cannot claim native campaign execution");
    if (s.retirement.kind === "unused") {
      for (const key of ["archiveSha256", "evidenceSha256", "evidence", "bootstrapReady"])
        assert.equal(s[key], undefined, "unused retirement cannot claim campaign evidence");
    } else assert.ok(s.archiveSha256 && s.evidenceSha256 && s.evidence, "failed setup requires preserved archive evidence");
  }
  if (s.pendingRetirement !== undefined) {
    // The digest of a v2 or v3 setup receipt, saved just before the receipt is published.
    // An interrupted receipt is recovered only with exactly these bytes.
    const p = s.pendingRetirement;
    assert.ok(p && typeof p === "object" && !Array.isArray(p), "pending retirement record required");
    assert.deepEqual(Object.keys(p).sort(), ["evidenceSha256", "kind"]);
    assert.equal(p.kind, "setup-failed", "only a controlled setup retirement records its receipt digest");
    full(p.evidenceSha256, /[a-f0-9]{64}/, "pending retirement hash");
    assert.ok(s.control, "pending retirement requires a controlled host");
    // Only a bound, archived but unretired setup failure can be retiring: retire() runs
    // from a starting or running host whose archive is preserved, and the retirement
    // state that carries the intent removes the digest.
    assert.ok(["starting", "running"].includes(s.status) && s.id && s.ip, "pending retirement requires a bound starting or running host");
    for (const key of ["retirement", "deletionIntentAt", "destroyedAt"])
      assert.equal(s[key], undefined, "pending retirement cannot coexist with a retirement or deletion");
    assert.ok(s.archiveSha256 && s.evidenceSha256 && s.evidence, "pending retirement requires preserved archive evidence");
  }
  if (s.createPending !== undefined) {
    // An accepted POST whose create action had not settled when the launch stopped.
    assert.deepEqual(pendingCreate(s.createPending), s.createPending, "pending create identity");
    assert.ok(!s.id || s.id === s.createPending.dropletId, "bound host differs from the posted create");
  }
  if (s.createErrored !== undefined) {
    // Terminal provider failure of the one create: never bound, provisioned or deleted.
    const c = s.createErrored;
    assert.ok(c && typeof c === "object" && !Array.isArray(c), "create failure record required");
    assert.deepEqual(Object.keys(c).filter((key) => key !== "reappeared").sort(), ["actionId", "dropletId", "evidenceSha256"]);
    for (const key of ["actionId", "dropletId"]) assert.ok(Number.isSafeInteger(Number(full(c[key], /[1-9]\d{0,15}/, key))), key);
    full(c.evidenceSha256, /[a-f0-9]{64}/, "create failure evidence hash");
    // A later read saw the posted droplet again: a permanent contradiction of the receipt.
    if (c.reappeared !== undefined) reappearance(c.reappeared);
    assert.equal(s.status, "creating", "a provider-errored create is never bound");
    for (const key of ["id", "ip", "archiveSha256", "evidenceSha256", "evidence", "extractionAttempts", "evidenceOutcome", "validation", "collectedAt",
      "exitCode", "deletionIntentAt", "destroyedAt", "retirement", "bootstrapReady", "preBootstrapTerminal", "launchHostKeySha256", "mixedCancellation", "auditIntent", "auditIntents"])
      assert.equal(s[key], undefined, "a provider-errored create cannot claim a host, deletion or campaign");
    const m = s.control?.monitor;
    assert.ok(!s.control || !s.control.ledger.length && !s.control.sealed.length && (!m || m.phase === "pending" && !m.registrationSha256),
      "a provider-errored create cannot have guest control");
    if (s.createPending) assert.deepEqual({ dropletId: c.dropletId, actionId: c.actionId }, s.createPending, "create failure differs from the posted create");
  }
  if (s.createContradicted !== undefined) {
    // A provider-errored receipt (published or not) contradicted by its exact posted
    // droplet, which then showed its saved ownership and was bound. Kept as evidence
    // through the pinned unused retirement; never a create failure again. `reappeared`
    // is the bind's own exact read; the first observation stays in the witness file,
    // bound by `witnessSha256`. `receiptVerified` is false when the preserved receipt
    // was not the canonical record for this state. `stages` binds each reappearance
    // stage a failed publication left, by name and bytes, and each createErrored
    // publication stage an interrupted receipt publication left.
    const c = s.createContradicted;
    assert.ok(c && typeof c === "object" && !Array.isArray(c), "create contradiction record required");
    assert.deepEqual(Object.keys(c).filter((key) => key !== "stages").sort(),
      ["actionId", "dropletId", "evidenceSha256", "reappeared", "receiptVerified", "witnessSha256"]);
    for (const key of ["actionId", "dropletId"]) assert.ok(Number.isSafeInteger(Number(full(c[key], /[1-9]\d{0,15}/, key))), key);
    full(c.evidenceSha256, /[a-f0-9]{64}/, "create contradiction evidence hash");
    full(c.witnessSha256, /[a-f0-9]{64}/, "create contradiction witness hash");
    assert.equal(typeof c.receiptVerified, "boolean", "create contradiction receipt verification");
    if (c.stages !== undefined) {
      assert.ok(Array.isArray(c.stages) && c.stages.length > 0, "create contradiction stages");
      for (const stage of c.stages) {
        assert.ok(stage && typeof stage === "object" && !Array.isArray(stage) && JSON.stringify(Object.keys(stage).sort()) === '["name","sha256"]', "create contradiction stage");
        full(stage.name, /state\.json\.create-(?:reappeared|errored)-[a-f0-9]{32}\.tmp/, "create contradiction stage name");
        full(stage.sha256, /[a-f0-9]{64}/, "create contradiction stage hash");
      }
      assert.equal(new Set(c.stages.map(({ name }) => name)).size, c.stages.length, "duplicate create contradiction stage");
    }
    reappearance(c.reappeared);
    assert.equal(c.reappeared.dropletId, c.dropletId, "create contradiction names another droplet");
    assert.ok(s.createErrored === undefined && s.id === c.dropletId && (s.status === "preparing" || s.status === "retired" && s.retirement?.kind === "unused"),
      "a contradicted create is only its bound posted droplet, retired as unused");
    if (s.createPending) assert.deepEqual({ dropletId: c.dropletId, actionId: c.actionId }, s.createPending, "create contradiction differs from the posted create");
  }
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
export const absentCollectionPolicy = "collect-verified-absent-host-only";
export function absentCollectionCandidate(options, s) {
  return options.collect && options.unusedBootstrapKnownHosts === undefined && !options.r21MeasuredCheckout
    && s.status === "collected" && s.collectedAt && s.validation?.status === "verified" && s.exitCode === 0
    && s.evidenceOutcome === "validated" && s.id && s.archiveSha256 && s.evidenceSha256
    && s.control?.monitor?.phase === "closed" && !s.fleet?.single?.offlineHandoff
    && s.deletionIntentAt && !s.destroyedAt;
}

export function campaignOutcome(report, s, exitCode) {
  assert.ok(report && ["verified", "failed", "blocked"].includes(report.status), "invalid/missing or unsupported native campaign validation; preserve host");
  assert.equal(report.schema, s.group === undefined ? "benchmark-isolated-campaign-inspection/v1" : "benchmark-isolated-group-campaign-inspection/v1");
  assert.equal(report.scope, "intrinsic-evidence");
  assert.equal(report.round, s.round); assert.equal(report.commit, s.commit);
  assert.deepEqual(report.selection, s.selection, "complete current native selection required");
  const loadLayout = savedLoadLayout(s);
  assert.equal(report.loadLayout, loadLayout, "replayed group load layout differs from reservation");
  const placement = savedPlacement(s);
  assert.equal(report.placement, placement, "replayed host placement differs from reservation");
  full(report.campaign, new RegExp(`${s.round}-[a-f0-9]{16}`), "native campaign identity");
  assert.deepEqual(report.uncollectedNativeRoots, [], "native evidence remains on host");
  assert.equal(report.collectionIntegrity, "manifest-verified", "unsealed native evidence");
  assert.equal(report.commandLifecycle, "observed-terminal", "uncertain native command lifecycle");
  if (s.control?.monitor?.phase === "closed") {
    assert.deepEqual(Object.keys(report.supervisedTerminal ?? {}).sort(), ["registrationSha256", "sealSha256"]);
    assert.equal(report.supervisedTerminal.registrationSha256, s.control.monitor.registrationSha256);
    full(report.supervisedTerminal.sealSha256, /[a-f0-9]{64}/, "native stream seal");
  }
  const offline = s.fleet?.single?.offlineHandoff;
  if (offline) {
    assert.ok(s.control.sealed.includes("bootstrap") && s.bootstrapReady?.bootId);
    const last = s.control.ledger.filter(({ request }) => request.epoch === "bootstrap").at(-1);
    assert.equal(last?.code, 0);
    const bootstrapSealSha256 = createHash("sha256").update(JSON.stringify(last.request.seal)).digest("hex");
    assert.deepEqual(report.offlineTerminal, { hostname: s.name, bootId: s.bootstrapReady.bootId, token: s.token, bootstrapSealSha256 },
      "offline replay does not match the acknowledged host, boot and bootstrap ledger");
    assert.ok(Array.isArray(report.offlineIngress) && report.offlineIngress.length <= (s.group === "json-api" ? 2 : 1));
    assert.equal(new Set(report.offlineIngress.map(({ phase }) => phase)).size, report.offlineIngress.length);
    for (const ingress of report.offlineIngress) {
      assert.deepEqual(Object.keys(ingress).sort(), ["bytes", "group", "packets", "phase"]);
      assert.equal(ingress.group, s.group);
      assert.ok(ingress.phase === "timing" || s.group === "json-api" && ingress.phase === "prepare");
      assert.ok([ingress.bytes, ingress.packets].every((n) => Number.isSafeInteger(n) && n >= 0));
      assert.ok(ingress.packets ? ingress.bytes >= ingress.packets : ingress.bytes === 0);
      if (report.status === "verified" && ingress.phase === "timing") assert.equal(ingress.packets, 0);
    }
    if (report.status === "verified") assert.ok(report.offlineIngress.some(({ phase }) => phase === "timing"));
  } else for (const field of ["offlineTerminal", "offlineIngress", "offlineAuditExpired"])
    assert.equal(report[field], undefined, "offline evidence cannot qualify a different reservation mode");
  assert.ok(Array.isArray(report.blockers) && report.blockers.every((b) => typeof b === "string"));
  for (const key of ["campaignSha256", "sourceSha256", "archiveTreeSha256", "reservationSha256"]) full(report[key], /[a-f0-9]{64}/, key);
  if (report.offlineAuditExpired) {
    assert.equal(exitCode, 2);
    assert.equal(report.status, "blocked"); assert.deepEqual(report.groups, []);
    assert.deepEqual(Object.keys(report.offlineAuditExpired).sort(), ["group", "subjectSha256"]);
    assert.equal(report.offlineAuditExpired.group, s.group);
    assert.ok(["json-api", "mixed-production"].includes(s.group));
    assert.ok(!s.auditIntents?.[s.group] && !s.auditIntent && !s.control.ledger.some(({ request }) => request.epoch.startsWith("audit-")),
      "audit control or delivery may have started; preserve host");
    full(report.offlineAuditExpired.subjectSha256, /[a-f0-9]{64}/, "expired audit subject identity");
    assert.deepEqual(report.offlineIngress.map(({ phase }) => phase), s.group === "json-api" ? ["prepare"] : []);
  } else assert.equal(exitCode, report.status === "verified" ? 0 : 1, "native CLI exit disagrees or remains uncertain; preserve host");
  if (report.status === "verified") {
    const fields = ["schema", "scope", "status", "round", "commit", "campaign", "campaignSha256", "sourceSha256", "selection", "groups", "blockers",
      "collectionIntegrity", "commandLifecycle", "uncollectedNativeRoots", "archiveTreeSha256", "reservationSha256"];
    if (s.control?.monitor?.phase === "closed") fields.push("supervisedTerminal");
    if (offline) fields.push("offlineTerminal", "offlineIngress");
    if (loadLayout) fields.push("loadLayout");
    if (placement) fields.push("placement");
    assert.deepEqual(Object.keys(report).sort(), fields.sort(), "verified inspection schema differs");
    assert.deepEqual(report.blockers, []);
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
