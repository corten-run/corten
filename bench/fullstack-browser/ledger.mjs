import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { classifyNoJSRequests, nativeNetworkRequests } from "./lifecycle.mjs";
import { nativeOriginId } from "./cancellations.mjs";

const hash = /^[a-f0-9]{64}$/;
const text = (v) => typeof v === "string" && v.length > 0;
const finite = (v) => Number.isFinite(v) && v >= 0;
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const need = (ok, message) => assert.ok(ok, message);
const same = (a, b, message) => need(isDeepStrictEqual(a, b), message);
const exactKeys = (v, names, message) => same(Object.keys(v).sort(), [...names].sort(), message);

export function semanticRequestKey(r) {
  return [r.scheme, r.path, r.urlSha256, r.method, r.resource, r.status, r.completed, r.failure ?? null, r.bodySha256 ?? null, r.bytes?.decodedBody ?? null];
}

// Recompute from raw rows, never from an earlier positive qualification flag.
export function reconcileRequests(evidence, navigation = null, jsNavigation = null) {
  const result = { outcome: "unknown", reasons: [], assignments: [] };
  try {
    const alternate = navigation?.outcome === "proved";
    const disabled = new Set(alternate ? navigation.requests.filter((r) => r.classification === "intentionally-disabled-preload").map((r) => r.request) : []);
    assert.ok(Array.isArray(evidence.requestLedger), "Final native request ledger unavailable");
    const final = new Map();
    for (const row of evidence.requestLedger) {
      assert.ok(typeof row?.id === "string" && row.id && !final.has(row.id), "Missing/duplicate final request ID");
      assert.ok(!row.captureError && (disabled.has(row.id)
        ? row.completed === false && row.status === null && Boolean(row.failure)
        : row.completed === true && !row.failure && Number.isInteger(row.status) && row.status >= 100 && row.status <= 599), `Failed/unfinished final request ${row.id}`);
      final.set(row.id, row);
    }
    const assigned = new Set();
    const include = (rows, phase) => {
      assert.ok(Array.isArray(rows), `Native request ledger unavailable for ${phase}`);
      for (const row of rows) {
        assert.ok(row?.id && final.has(row.id) && !assigned.has(row.id), `Unmatched/duplicate assigned request ${row?.id}`);
        // This classification is local to the step snapshot, not an outcome waiver.
        const { intentionallyDisabledPreload, ...native } = row;
        const { intentionallyDisabledPreload: finalClassification, ...terminal } = final.get(row.id);
        if (disabled.has(row.id)) {
          // Later documents can preload the same URL and change these diagnostic
          // candidates. The independent native phase ledger supplies this match.
          delete native.cancellation; delete terminal.cancellation;
          same(native, terminal, `Stale request outcome/evidence ${row.id}`);
        } else assert.deepEqual(native, terminal, `Stale request outcome/evidence ${row.id}`);
        assigned.add(row.id); result.assignments.push({ request: row.id, phase });
      }
    };
    assert.ok(Array.isArray(evidence.steps), "Native step request assignments unavailable");
    for (const row of evidence.steps) include(row.requests, row.action.id);
    include(evidence.nativeCleanup?.requests, "cleanup-navigation");
    if (!alternate && !(jsNavigation?.outcome === "proved" && jsNavigation.cleanup))
      include(evidence.nativeCleanup?.probe?.requests, "retired-event-probe");
    for (const id of final.keys()) assert.ok(assigned.has(id), `Unassigned final native request ${id}`);
    assert.deepEqual(evidence.networkFailures, [], "Final network observer errors remain or were not retained");
    assert.deepEqual(evidence.runtimeErrors, [], "Final browser errors remain or were not retained");
    result.outcome = "reconciled";
  } catch (error) { result.reasons.push(error.message); }
  return result;
}

// This is multiset conservation, not a guessed bijection between protocol IDs.
export function reconcileNativeNetwork(evidence, documentNavigation = evidence.documentNavigationProof !== undefined) {
  const result = { outcome: "unknown", reasons: [], namespace: null, requests: [] };
  try {
    const j = evidence.platformLifecycle, events = j?.events;
    need(Array.isArray(events) && events.length <= 100000, "Native network journal unavailable");
    const observers = events.filter((e) => e.event === "native-network-observer");
    need(observers.length === 1, "Native network observer namespace missing/duplicated");
    const ns = observers[0];
    exactKeys(ns, ["event", "namespaceKind", "observerSession", "targetId", "receivedAt"], "Unknown native observer namespace field");
    need(ns.namespaceKind === "observer-assigned" && text(ns.observerSession) && text(ns.targetId) && ns.targetId === j.target?.target
      && finite(ns.receivedAt) && ns.receivedAt <= j.boundaries?.startedAt, "Native observer/target binding unavailable");
    const inventories = events.filter((e) => e.event === "Target.getTargets" && e.phase === "initial");
    need(inventories.length === 1 && inventories[0].targets?.filter((t) => t.target === ns.targetId && t.context === j.target.context && t.type === "page").length === 1,
      "Native observer target lacks actual discovery inventory");
    const classified = documentNavigation ? classifyNoJSRequests(j) : null;
    if (classified) need(classified.outcome === "classified", classified.reasons.join("; ") || "Native no-JS requests not completely classified");
    const classes = new Map((classified?.requests ?? []).map((r) => [JSON.stringify([r.dispatch.request, r.dispatch.at]), r.classification]));
    const disabled = new Set((classified?.requests ?? []).filter((r) => r.classification === "intentionally-disabled-preload"
      && r.dispatch.method === "GET" && !r.response && r.terminal?.blockedReason === "csp" && r.terminal.errorText === "" && r.terminal.canceled === false)
      .map((r) => r.dispatch.request));
    const network = nativeNetworkRequests(j, disabled); need(!network.reasons.length, network.reasons.join("; "));
    const bodies = events.filter((e) => ["native-document-body", "native-response-body"].includes(e.event)), byDispatch = new Map(), used = new Set(), origins = new Set();
    for (const body of bodies) {
      const key = JSON.stringify([body.request, body.dispatchAt]);
      need(!byDispatch.has(key), "Duplicated native body receipt"); byDispatch.set(key, body);
    }
    const browser = new Map(), native = new Map();
    const add = (groups, tuple, date) => { const key = JSON.stringify(tuple); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(date); };
    for (const r of network.requests) {
      const d = r.dispatch, redirected = r.terminal?.event === "native-redirect", failed = r.terminal?.event === "Network.loadingFailed";
      const status = redirected ? r.terminal.status : r.response?.status ?? null;
      let body = null;
      if (!redirected && !failed) {
        body = byDispatch.get(JSON.stringify([d.request, d.at])); need(body, "Completed native response lacks bounded body receipt"); used.add(body);
        exactKeys(body, ["event", "observerSession", "targetId", "originId", "hop", "request", "dispatchAt", "frame", "loader", "urlSha256", "method", "status", "dateSha256", "bodySha256", "bytes", "queuedAt", "startedAt", "receivedAt"], "Unknown native body receipt field");
        const originId = nativeOriginId(ns, d, r.hop);
        same([body.event, body.observerSession, body.targetId, body.originId, body.hop, body.frame, body.loader, body.urlSha256, body.method, body.status],
          [d.type === "Document" ? "native-document-body" : "native-response-body", ns.observerSession, ns.targetId, originId, r.hop, d.frame, d.loader, d.urlSha256, d.method, status], "Native response body/dispatch identity differs");
        need(!origins.has(originId), "Duplicated native origin identity"); origins.add(originId);
        need(hash.test(body.bodySha256 ?? "") && integer(body.bytes) && body.bytes <= 16 * 1024 ** 2
          && [body.queuedAt, body.startedAt, body.receivedAt].every(finite) && r.terminal.receivedAt <= body.queuedAt
          && body.queuedAt <= body.startedAt && body.startedAt <= body.receivedAt && body.receivedAt - body.queuedAt <= 1000
          && body.receivedAt <= j.boundaries.endedAt, "Native body observation is missing/beyond its bounded window");
        need(body.dateSha256 === null || hash.test(body.dateSha256 ?? ""), "Malformed optional native response date");
        need(r.response.dateSha256 === null || r.response.dateSha256 === undefined || hash.test(r.response.dateSha256 ?? ""), "Malformed optional native response-header date");
        if (body.dateSha256 && r.response.dateSha256) same(body.dateSha256, r.response.dateSha256, "Native response date consistency differs");
      }
      r.body = body;
      r.classification = classes.get(JSON.stringify([d.request, d.at])) ?? null;
      if (r.classification === "intentionally-disabled-preload") need(disabled.has(d.request), "Disabled preload lacks the pre-network blocked receipt");
      const failure = failed ? disabled.has(d.request) ? "csp" : r.terminal.errorText : null;
      r.phaseKey = [d.scheme, d.path, d.urlSha256, d.method, d.type.toLowerCase(), status, !failed, failure, body?.bodySha256 ?? null, body?.bytes ?? null];
      add(native, r.phaseKey, body?.dateSha256 ?? null);
    }
    need(used.size === bodies.length, "Orphan/late native response body receipt");
    need(Array.isArray(evidence.requestLedger), "Semantic browser request ledger missing");
    const ids = new Set();
    for (const r of evidence.requestLedger) {
      need(text(r.id) && !ids.has(r.id), "Duplicate/missing semantic request ID"); ids.add(r.id);
      need(hash.test(r.urlSha256 ?? "") && typeof r.completed === "boolean" && !r.captureError, "Incomplete semantic request identity/body capture");
      need(r.dateSha256 === null || r.dateSha256 === undefined || hash.test(r.dateSha256 ?? ""), "Malformed optional semantic response date");
      need(!r.failure || r.completed === false, "Semantic failed request claims completion");
      add(browser, semanticRequestKey(r), r.dateSha256 ?? null);
    }
    same([...native.keys()].sort(), [...browser.keys()].sort(), "Native/semantic request methods/paths/status/bodies/failures differ");
    for (const [key, dates] of native) {
      same(dates.length, browser.get(key).length, "Native/semantic request multiplicity differs");
      // Optional dates can contradict a group; they never distinguish its IDs.
      if (dates.every(text) && browser.get(key).every(text)) same([...dates].sort(), [...browser.get(key)].sort(), "Native/semantic response date consistency differs");
    }
    result.namespace = ns; result.requests = network.requests; result.outcome = "reconciled";
  } catch (error) { result.reasons.push(error.message); }
  return result;
}
