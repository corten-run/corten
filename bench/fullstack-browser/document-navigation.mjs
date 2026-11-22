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

export const cleanupObserved = (e) => e.nativeCleanup?.outcome === "observed" || e.documentNavigationProof?.outcome === "proved";
