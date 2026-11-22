import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { replacedRealm, validatePlatformRetirement } from "./lifecycle.mjs";
import { reconcileNativeNetwork, reconcileRequests, semanticRequestKey } from "./ledger.mjs";
import { replayPeerApplicability, replayWorkerAbsence } from "./native-lifetimes.mjs";
import { reconcileUpstream } from "./upstream.mjs";

const keys = ["subscriptions", "connections", "listeners", "timers", "pendingTasks"];
const empty = (counts) => counts && Object.keys(counts).length === keys.length && keys.every((key) => counts[key] === 0);
const need = (ok, reason) => assert.ok(ok, reason);
const same = (a, b, reason) => need(isDeepStrictEqual(a, b), reason);
const ordered = (...times) => times.every((t, i) => Number.isFinite(t) && t >= 0 && (!i || t >= times[i - 1]));
const sameScope = (a, b) => a?.realm === b?.realm && a?.scope === b?.scope;

function quiet(sample) {
  need(sample?.scriptExecutionEnabled === false && sample.realm && sample.scope && empty(sample.unattributed)
    && Array.isArray(sample.unsupported) && !sample.unsupported.length && Array.isArray(sample.scopes)
    && sample.scopes.length === 1 && sample.scopes[0].scope === sample.scope && sample.scopes[0].connected === true
    && empty(sample.scopes[0].owned), "Missing or nonempty live no-JS resource checkpoint");
}

// Recompute from pre-teardown receipts. No probe or count is supplied for the dead realm.
// This variant is deliberately limited to whole ordinary document journeys with no
// workers or long-lived peers. It is not an alternate path for same-realm cleanup.
export function replayDocumentNavigation(e, profile, { observationMs, maxCleanupMs }) {
  const result = { outcome: "unknown", reason: null, requests: [] };
  try {
    const j = e.platformLifecycle, c = e.nativeCleanup, b = j?.boundaries, rows = e.steps;
    need(profile.js === false && j?.contextConfiguration?.javaScriptEnabled === false
      && rows?.length === profile.steps.length && rows.length > 0 && c?.outcome === "unsupported", "No complete script-disabled document journey");
    const retired = replacedRealm(c.before, c.after);
    need(retired && c.probe == null && c.dom == null && c.released == null, "Retired same-realm counts/probe cannot be replaced by platform proof");
    same(c.retired, retired, "Cleanup resource retirement differs from observed replacement");
    same(c.failures, [retired.reason], "Other native cleanup failures remain");
    need(c.navigation?.via === "native-header-link" && c.navigation.path === "/" && sameScope(c.before, rows.at(-1).resources)
      && sameScope(c.after, c.landingResources) && sameScope(c.after, c.terminalResources), "Cleanup not bound to current and replacement scopes");
    for (const sample of [c.before, c.after, c.landingResources, c.terminalResources]) quiet(sample);
    need(ordered(rows.at(-1).resources.at, c.before.at, c.navigation.at, c.after.at, c.landingSettledAt, c.landingResources.at, b?.terminalStartedAt, b?.endedAt,
      c.terminalResources.at, e.requestLedgerEndedAt)
      && c.after.at - c.navigation.at <= maxCleanupMs && b.endedAt - b.terminalStartedAt >= observationMs
      && c.landingResources.at - c.navigation.at <= maxCleanupMs && c.terminalResources.document?.path === "/", "Unbounded or wrong native cleanup destination/interval");

    const network = reconcileNativeNetwork(e, true);
    need(network.outcome === "reconciled", network.reasons.join("; "));
    const workers = replayWorkerAbsence(j), peer = replayPeerApplicability(j, workers);
    need(workers.status === "verified" && peer.status === "verified" && peer.applicability === "empty-set",
      `Worker/long-lived peer absence unproved: ${peer.blocked.join("; ")}`);
    const requestClasses = [];
    function phase({ before, after, at, end, path, method, requests, observer, retirement, settled = false }) {
      quiet(after);
      const bindings = j.realms.filter((r) => r.realm === after.realm);
      need(bindings.length === 1, "Replacement resource realm not uniquely bound");
      const binding = bindings[0];
      const documents = j.documents.filter((d) => d.observer === observer && d.realm === after.realm && d.scope === after.scope && d.path === path
        && d.frame === binding.frame && d.loader === binding.loader && d.identityObservation?.uniqueId === binding.uniqueId
        && ordered(at, binding.observedAt, after.at, d.observedAt, d.identityObservation.startedAt, d.identityObservation.finishedAt, b.terminalStartedAt));
      need(documents.length === 1, "Replacement parser observation not bound to its observed scope/document");
      if (before) {
        const actual = replacedRealm(before, after);
        need(actual, "Same-realm work cannot use the document replacement alternative");
        same(retirement, actual, "Retention summary differs from resource replacement");
        const proof = validatePlatformRetirement(j, { realm: before.realm, retiredAt: at, observationMs });
        need(proof.outcome === "proved" && proof.replacement.binding.realm === after.realm && proof.replacement.commit.path === path
          && ordered(at, proof.replacement.commit.receivedAt, binding.observedAt, after.at), proof.reasons.join("; ") || "Replacement proof does not bind the next observed realm");
      }
      const native = network.requests.filter((r) => r.dispatch.receivedAt >= at && r.dispatch.receivedAt <= end);
      need(native.every((r) => r.dispatch.frame === binding.frame && r.dispatch.loader === binding.loader), "Action contains work from an unrelated loader");
      if (settled) need(native.every((r) => ordered(r.dispatch.receivedAt, r.terminal.receivedAt, r.body?.receivedAt ?? r.terminal.receivedAt, end)),
        "Landing request did not finish before cleanup settled");
      const docs = native.filter((r) => r.classification === "document"), final = docs.at(-1);
      need(final?.dispatch.path === path && docs[0]?.dispatch.method === method && final.terminal.event === "Network.loadingFinished"
        && final.dispatch.urlSha256 === documents[0].identityObservation.documentSha256
        && docs.every((r) => r.dispatch.request === final.dispatch.request)
        && docs.slice(0, -1).every((r) => r.terminal.event === "native-redirect"), "Expected one native document dispatch/redirect chain for this action");
      if (path === "/") need(docs.length === 1 && final.response?.status === 200, "Cleanup landing must be one successful HTML document");
      const proven = new Map();
      for (const nativeRequest of native) {
        const key = JSON.stringify(nativeRequest.phaseKey), { classification } = nativeRequest;
        const entry = proven.get(key) ?? { classification, count: 0 };
        need(entry.classification === classification && classification, "Ambiguous native request classification");
        entry.count++; proven.set(key, entry);
      }
      for (const request of requests) {
        const match = proven.get(JSON.stringify(semanticRequestKey(request)));
        need(match?.count > 0, "Action request has no matching native receipt in its phase");
        need(request.transport === (match.classification === "document" ? "document" : "fetch")
          && (match.classification === "document" || request.method === "GET" && request.input === null && request.components?.length === 0),
        "Native parser request carries application transport");
        if (match.classification === "parser-asset") need(request.status >= 200 && request.status < 300, "Parser asset failed");
        if (match.classification === "intentionally-disabled-preload")
          need(request.failure === "csp" && request.status === null && !request.completed, "Disabled preload lacks its native failure");
        match.count--; requestClasses.push({ request: request.id, classification: match.classification });
      }
      need([...proven.values()].every((entry) => entry.count === 0), "Action dropped a native request or error");
    }
    for (const [i, row] of rows.entries()) {
      same(row.action, profile.steps[i], "Wrong action in native document journey");
      const before = i ? rows[i - 1].resources : null;
      need(row.dom?.scope === row.resources?.scope && row.dom.url?.path === row.action.path && sameScope(row.resourcesAtDOM, row.resources)
        && ordered(before?.at ?? b.applicationStartedAt, row.dispatchStartedAt, row.resourcesAtDOM.at, row.resources.at, c.before.at), "Action DOM/realm/dispatch observations do not bind");
      quiet(row.resourcesAtDOM);
      phase({ before, after: row.resources, at: row.dispatchStartedAt, end: row.resources.at, path: row.action.path,
        method: row.action.input ? "POST" : "GET", requests: row.requests, observer: row.dom.observer, retirement: row.retired });
    }
    phase({ before: c.before, after: c.after, at: c.navigation.at, end: c.landingSettledAt, path: "/", method: "GET",
      requests: c.requests, observer: c.landingResources.observer, retirement: c.retired, settled: true });
    need(requestClasses.length === network.requests.length, "Unassigned native requests outside actions/cleanup");
    const assigned = reconcileRequests(e, { outcome: "proved", requests: requestClasses });
    need(assigned.outcome === "reconciled", assigned.reasons.join("; "));
    const upstream = reconcileUpstream(e.upstreamLedger, { source: profile.source, actions: profile.steps.map((s) => s.id), steps: rows, observationMs });
    need(upstream.outcome === "reconciled", upstream.reasons.join("; "));
    need(ordered(b.endedAt, e.upstreamLedger.terminal.startedAt, e.upstreamLedger.terminal.finishedAt, e.requestLedgerEndedAt),
      "Final upstream observation does not cover native retirement");
    result.outcome = "proved"; result.requests = requestClasses;
  } catch (error) { result.reason = error.message; }
  return result;
}

// JS actions may replace only a root or may replace the whole document. Do not
// classify their requests with the no-JS rules or claim zeros for dead realms.
export function replayJSReplacement(e, profile, { observationMs, maxCleanupMs, actionTimeoutMs }) {
  const unavailable = { outcome: "unknown", reason: null, actions: [], cleanup: false };
  try {
    const j = e.platformLifecycle, b = j?.boundaries, c = e.nativeCleanup, rows = e.steps;
    need(profile.js === true && j?.contextConfiguration?.javaScriptEnabled === true && rows?.length === profile.steps.length
      && rows.length > 0, "No complete JS journey with native context configuration");
    need(ordered(b.applicationStartedAt, b.terminalStartedAt, b.endedAt, e.requestLedgerEndedAt)
      && b.endedAt - b.terminalStartedAt >= observationMs, "JS replacement native observation is unbounded");
    const network = reconcileNativeNetwork(e, false);
    need(network.outcome === "reconciled", network.reasons.join("; "));
    const workers = replayWorkerAbsence(j), peer = replayPeerApplicability(j, workers);
    need(workers.status === "verified" && peer.status === "verified" && peer.applicability === "empty-set",
      `JS replacement worker/long-lived peer absence unproved: ${peer.blocked.join("; ")}`);
    function replacement({ before, after, observer, retirement, at, end, path, method, requests, statuses, landing = false }) {
      const actual = replacedRealm(before, after);
      need(actual && before.scriptExecutionEnabled === true && after.scriptExecutionEnabled === true, "JS replacement is not a new default realm");
      same(retirement, actual, "JS replacement reports unavailable old scope observations inconsistently");
      const proof = validatePlatformRetirement(j, { realm: before.realm, retiredAt: at, observationMs });
      const binding = proof.replacement?.binding, commit = proof.replacement?.commit;
      need(proof.outcome === "proved" && binding?.realm === after.realm && after.document?.path === path && commit?.path === path
        && ordered(before.at, at, proof.destruction?.receivedAt, commit.receivedAt, binding.observedAt, after.at, end, b.terminalStartedAt),
      proof.reasons.join("; ") || "JS replacement realm and destination do not bind to the action");
      const documents = j.documents.filter((d) => d.observer === observer && d.realm === after.realm && d.scope === after.scope
        && d.frame === binding.frame && d.loader === binding.loader && d.path === path && d.identityObservation?.uniqueId === binding.uniqueId
        && ordered(after.at, d.observedAt, d.identityObservation.startedAt, d.identityObservation.finishedAt, b.terminalStartedAt));
      need(documents.length === 1, "JS replacement lacks the uniquely bound live document observation");
      const native = network.requests.filter((r) => r.dispatch.receivedAt >= at && r.dispatch.receivedAt <= end);
      const docs = native.filter((r) => r.dispatch.type === "Document"), final = docs.at(-1);
      need(final?.dispatch.path === path && final.dispatch.urlSha256 === documents[0].identityObservation.documentSha256
        && docs[0]?.dispatch.method === method && final.terminal.event === "Network.loadingFinished"
        && statuses.includes(final.response?.status) && docs.every((r) => r.dispatch.request === final.dispatch.request)
        && docs.slice(0, -1).every((r) => r.terminal.event === "native-redirect"), "JS replacement requires one observed document chain to the action destination");
      need(native.every((r) => r.dispatch.frame === binding.frame && r.dispatch.loader === binding.loader
        && ordered(r.dispatch.receivedAt, r.terminal.receivedAt, r.body?.receivedAt ?? r.terminal.receivedAt, end)),
      "JS replacement work has unrelated ownership or did not finish within the boundary");
      same(native.map((r) => JSON.stringify(r.phaseKey)).sort(), requests.map((r) => JSON.stringify(semanticRequestKey(r))).sort(),
        "JS replacement native and semantic request assignments differ");
      if (landing) need(docs.length === 1 && native.every((r) => r === final || ["Script", "Stylesheet", "Image"].includes(r.dispatch.type)
        && r.dispatch.method === "GET" && r.dispatch.sameDocumentOrigin === true && r.dispatch.initiator?.type === "parser"
        && r.dispatch.initiator.urlSha256 === final.dispatch.urlSha256 && r.response?.status >= 200 && r.response.status < 300),
      "JS landing has work other than the successful document and its ordinary parser assets");
    }
    const actions = [];
    for (const [i, row] of rows.entries()) {
      same(row.action, profile.steps[i], "Wrong action in JS replacement journey");
      const before = rows[i - 1]?.resources, after = row.resources;
      const mandatory = ["reset", "missing", "return"].includes(row.action.kind);
      if (!before?.realm || !after?.realm || before.realm === after.realm) {
        need(!mandatory && row.retired?.owned !== null, "Expected document replacement or same-document resource counts unavailable");
        continue;
      }
      const at = row.dispatchStartedAt;
      same(row.platformRetirement, { realm: before.realm, retiredAt: at }, "JS action retirement does not bind its dispatch and old realm");
      need(row.dom?.scope === after.scope && sameScope(row.resourcesAtDOM, after) && row.dom.url?.path === row.action.path
        && ordered(at, row.resourcesAtDOM.at, after.at) && after.at - at <= actionTimeoutMs, "JS replacement action DOM/resource window differs");
      replacement({ before, after, observer: row.dom.observer, retirement: row.retired, at, end: after.at, path: row.action.path,
        method: row.action.input ? "POST" : "GET", requests: row.requests,
        statuses: row.action.kind === "missing" ? [404] : ["invalid-email", "invalid-price"].includes(row.action.kind) ? [200, 400, 422] : [200] });
      actions.push(row.action.id);
    }
    const cleanup = c?.outcome === "unsupported" && Boolean(replacedRealm(c.before, c.after));
    if (cleanup) {
      need(c.navigation?.via === "native-header-link" && c.navigation.path === "/" && sameScope(c.before, rows.at(-1).resources)
        && sameScope(c.after, c.landingResources) && sameScope(c.after, c.terminalResources)
        && c.probe == null && c.dom == null && c.released == null, "JS cleanup not bound to live landing and unavailable old realm");
      same(c.failures, [c.retired?.reason], "Other JS native cleanup failures remain");
      need(ordered(rows.at(-1).resources.at, c.before.at, c.navigation.at, c.after.at, c.landingSettledAt, c.landingResources.at, b.terminalStartedAt,
        b.endedAt, c.terminalResources.at, e.requestLedgerEndedAt) && c.landingResources.at - c.navigation.at <= maxCleanupMs,
      "JS cleanup landing/terminal observation is unbounded");
      need(network.requests.every((r) => r.dispatch.receivedAt <= c.landingSettledAt),
        "Native request dispatched after JS cleanup landing settled");
      for (const s of [c.landingResources, c.terminalResources])
        need(s.scriptExecutionEnabled === true && s.document?.path === "/" && empty(s.unattributed) && s.unsupported?.length === 0
          && s.scopes?.length === 1 && s.scopes[0].scope === s.scope && s.scopes[0].connected === true && empty(s.scopes[0].owned),
        "Live JS landing retains resources or has unknown ownership");
      replacement({ before: c.before, after: c.after, observer: c.landingResources.observer, retirement: c.retired,
        at: c.navigation.at, end: c.landingSettledAt, path: "/", method: "GET", requests: c.requests, statuses: [200], landing: true });
    } else need(c?.outcome === "observed", "JS cleanup lacks a live same-document probe or a proved replacement");
    need(actions.length > 0 || cleanup, "No JS document replacement observed");
    const proof = { outcome: "proved", reason: null, actions, cleanup };
    const assigned = reconcileRequests(e, null, proof);
    need(assigned.outcome === "reconciled", assigned.reasons.join("; "));
    const upstream = reconcileUpstream(e.upstreamLedger, { source: profile.source, actions: profile.steps.map((s) => s.id), steps: rows, observationMs });
    need(upstream.outcome === "reconciled", upstream.reasons.join("; "));
    need(ordered(b.endedAt, e.upstreamLedger.terminal.startedAt, e.upstreamLedger.terminal.finishedAt, e.requestLedgerEndedAt),
      "Final upstream observation does not cover JS replacement");
    return proof;
  } catch (error) { return { ...unavailable, reason: error.message }; }
}

export const cleanupObserved = (e) => e.nativeCleanup?.outcome === "observed" || e.documentNavigationProof?.outcome === "proved"
  || e.jsDocumentNavigationProof?.outcome === "proved" && e.jsDocumentNavigationProof.cleanup;
