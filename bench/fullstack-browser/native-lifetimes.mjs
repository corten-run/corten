import assert from "node:assert/strict";
import { encoded, sha256 } from "./native-evidence.mjs";

const finite = (v) => Number.isFinite(v) && v >= 0;
const text = (v) => typeof v === "string" && v.length > 0;
function base(journal) {
  const blocked = [], block = (reason) => { if (!blocked.includes(reason)) blocked.push(reason); };
  if (journal?.schema !== "native-browser-platform-lifetimes/v2" || !Array.isArray(journal.events)) {
    block("native-journal-missing"); return { blocked, block, valid: false };
  }
  const events = journal.events, b = journal.boundaries ?? {}, target = journal.target;
  if (!target || !text(target.target) || !text(target.context) || target.type !== "page") block("native-target-identity-missing");
  if (![b.startedAt, b.applicationStartedAt, b.terminalStartedAt, b.endedAt].every(finite)
    || !(b.startedAt <= b.applicationStartedAt && b.applicationStartedAt <= b.terminalStartedAt && b.terminalStartedAt <= b.endedAt)) block("native-journal-boundaries-incomplete");
  if (events.length > 100000 || events.some((e, i) => !text(e?.event) || !finite(e.receivedAt) || i && e.receivedAt < events[i - 1].receivedAt)) block("native-journal-order-incomplete");
  if (!Array.isArray(journal.observationFailures) || journal.observationFailures.length) block("native-observer-failure");
  const initial = events.filter((e) => e.event === "Target.getTargets" && e.phase === "initial");
  const terminal = events.filter((e) => e.event === "Target.getTargets" && e.phase === "terminal");
  const discovery = events.filter((e) => e.event === "Target.setDiscoverTargets");
  if (initial.length !== 1 || terminal.length !== 1 || ![initial[0], terminal[0]].every((e) =>
    finite(e.startedAt) && e.startedAt <= e.receivedAt && Array.isArray(e.targets))
    || initial[0]?.receivedAt > b.startedAt || terminal[0]?.startedAt < b.terminalStartedAt || terminal[0]?.receivedAt > b.endedAt) block("native-target-inventories-incomplete");
  if (discovery.length !== 1 || discovery[0].params?.discover !== true || !finite(discovery[0].startedAt)
    || discovery[0].startedAt > discovery[0].receivedAt || JSON.stringify(discovery[0].result) !== "{}"
    || discovery[0].receivedAt > initial[0]?.startedAt) block("native-target-discovery-command-missing");
  for (const domain of ["Runtime", "Page", "Network"]) if (!events.some((e) => e.event === "domain-enabled"
    && e.domain === domain && e.receivedAt <= initial[0]?.startedAt)) block("native-domain-enable-missing");
  if (events.some((e) => /Crashed|crashed|detached|session-closed/.test(e.event))) block("native-observer-interruption");
  return { blocked, block, valid: blocked.length === 0, events, b, target, initial: initial[0], terminal: terminal[0] };
}
function result(schema, journal, blocked, fields = {}) {
  return { schema, status: blocked.length ? "blocked" : "verified", blocked, journalSha256: sha256(encoded(journal ?? null)), ...fields };
}
/** No worker-network claim: prove only the empty population in a continuous scope. */
export function replayWorkerAbsence(journal) {
  const s = base(journal), population = [];
  if (!s.valid) return result("native-browser-worker-absence/v2", journal, s.blocked, { population });
  const { events, initial, terminal, target, block } = s, live = new Map();
  function observe(t) {
    if (!text(t?.target) || !text(t?.type) || !(t.context === null || text(t.context))) { block("native-target-record-incomplete"); return; }
    const relevant = t.context === target.context || t.context === null || t.opener === target.target;
    if (/worker/.test(t.type) && relevant) { population.push(t.target); block("worker-present-proof-missing"); }
    if (relevant && !["page", "browser", "tab"].includes(t.type) && !/worker/.test(t.type)) block("uncovered-native-target-type");
    if (relevant && t.type === "page" && t.target !== target.target) block("additional-page-coverage-missing");
  }
  for (const t of initial.targets) { observe(t); if (live.has(t.target)) block("duplicate-native-target"); live.set(t.target, t); }
  if (!live.has(target.target) || live.get(target.target).context !== target.context) block("native-page-not-in-initial-inventory");
  if (live.get(target.target)?.scheme !== "about:") block("initial-page-already-has-uncovered-application");
  if (events.some((e) => e.event === "Network.requestWillBeSent" && ["http:", "https:"].includes(e.scheme)
    && e.receivedAt < s.b.applicationStartedAt)) block("application-network-precedes-observation-boundary");
  // Include discovery-time transient workers, even if gone before first inventory.
  for (const e of events) if (["Target.targetCreated", "Target.targetInfoChanged"].includes(e.event)) observe(e);
  for (const e of events.filter((e) => e.receivedAt > initial.receivedAt && e.receivedAt <= terminal.receivedAt)) {
    if (e.event === "Target.targetCreated") { if (live.has(e.target)) block("duplicate-live-native-target"); live.set(e.target, e); }
    if (e.event === "Target.targetInfoChanged") {
      if (!live.has(e.target)) block("unmatched-native-target-change");
      else if (live.get(e.target).context !== e.context || live.get(e.target).type !== e.type) block("native-target-identity-changed");
      live.set(e.target, e);
    }
    if (e.event === "Target.targetDestroyed") { if (!live.delete(e.target)) block("unmatched-native-target-destruction"); }
    if (e.event === "Page.frameNavigated" && e.frame !== target.target) block("child-frame-coverage-missing");
    if (e.event === "Runtime.executionContextCreated" && e.frame && e.frame !== target.target) block("child-context-coverage-missing");
  }
  const identity = (t) => [t.target, t.context, t.type];
  const final = new Map();
  for (const t of terminal.targets) { observe(t); if (final.has(t.target)) block("duplicate-terminal-native-target"); final.set(t.target, t); }
  if (JSON.stringify([...live.values()].map(identity).sort()) !== JSON.stringify([...final.values()].map(identity).sort())) block("native-target-inventory-event-gap");
  return result("native-browser-worker-absence/v2", journal, s.blocked, { population: [...new Set(population)].sort() });
}
/** Peers mean application WebSocket/EventSource/stream, not completed HTTP sockets. */
export function replayPeerApplicability(journal, workerProof) {
  const actualWorkers = replayWorkerAbsence(journal); assert.deepEqual(workerProof, actualWorkers, "worker proof is not bound to this journal");
  const s = base(journal), peers = [];
  for (const reason of actualWorkers.blocked) s.block(reason);
  if (!s.valid || actualWorkers.status !== "verified") return result("native-browser-peer-applicability/v2", journal, s.blocked, { applicability: "unknown", peers });
  const requests = new Map(), { block } = s;
  const clocks = s.events.filter((e) => e.event === "native-clock-sample");
  const start = clocks.filter((e) => e.phase === "initial-native-clock"), end = clocks.filter((e) => e.phase === "terminal-native-clock");
  const clockOK = start.length === 1 && end.length === 1 && [start[0], end[0]].every((e) => finite(e.at) && finite(e.startedAt) && e.startedAt <= e.receivedAt)
    && start[0].receivedAt <= s.b.startedAt && end[0].startedAt >= s.b.terminalStartedAt && end[0].receivedAt <= s.b.endedAt && start[0].at <= end[0].at;
  if (!clockOK) block("native-network-clock-missing");
  for (const e of s.events) {
    if (e.event.startsWith("Network.webSocket")) { if (!peers.includes(e.request)) peers.push(e.request); continue; }
    if (!["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"].includes(e.event)) continue;
    if (!text(e.request) || !clockOK || !finite(e.at) || e.at < start[0].at || e.at > end[0].at
      || e.at > start[0].at + (e.receivedAt - start[0].startedAt) / 1000 || e.receivedAt > s.b.endedAt) block("native-network-event-outside-clock");
    if (e.event === "Network.requestWillBeSent") {
      const previous = requests.get(e.request);
      if (previous) {
        // Same bounded redirect-hop identity contract as lifecycle.mjs. Native
        // ExtraInfo enumerates each dispatch independently of the reused ID.
        const chain = s.events.filter((x) => x.event === "Network.requestWillBeSent" && x.request === e.request);
        const extra = s.events.filter((x) => x.event === "Network.requestWillBeSentExtraInfo" && x.request === e.request);
        const r = e.redirectResponse, d = previous.dispatch, index = chain.indexOf(d);
        if (previous.response || previous.terminal || !r || r.urlSha256 !== d.urlSha256 || r.path !== d.path || r.scheme !== d.scheme
          || !/^[a-f0-9]{64}$/.test(d.urlSha256 ?? "") || e.frame !== d.frame || e.loader !== d.loader || e.type !== d.type
          || e.redirectHasExtraInfo !== true || r.status !== e.redirectStatus || !Number.isInteger(r.status) || r.status < 300 || r.status >= 400
          || extra.length !== chain.length || !extra.every((x, i) => finite(x.at) && (!i || x.at > extra[i - 1].at))
          || r.timing?.requestTime !== extra[index]?.at || e.at < d.at) block("native-redirect-chain-incomplete");
      }
      if (!["http:", "https:"].includes(e.scheme) || !text(e.frame) || !text(e.loader) || !text(e.type)) block("native-network-dispatch-incomplete");
      if (["EventSource", "WebSocket"].includes(e.type)) peers.push(e.request);
      requests.set(e.request, { dispatch: e, response: null, terminal: null }); continue;
    }
    const request = requests.get(e.request);
    if (!request) { block("native-network-event-unmatched"); continue; }
    if (e.event === "Network.responseReceived") {
      if (request.response || request.terminal || e.frame !== request.dispatch.frame || e.loader !== request.dispatch.loader || e.type !== request.dispatch.type) block("native-network-response-unmatched");
      if (!Number.isInteger(e.status) || !text(e.mime)) block("native-network-response-incomplete");
      if (e.mime === "text/event-stream") peers.push(e.request);
      request.response = e;
    } else {
      if (request.terminal || e.at < request.dispatch.at) block("native-network-terminal-unmatched"); request.terminal = e;
      if (e.event === "Network.loadingFinished" && !request.response) block("native-network-response-missing");
      if (e.event === "Network.loadingFailed" && (typeof e.canceled !== "boolean" || typeof e.errorText !== "string")) block("native-network-failure-incomplete");
    }
  }
  for (const [request, value] of requests) if (!value.terminal) { peers.push(request); block("request-or-stream-still-open"); }
  // No peer endpoint collector is claimed here, even if CDP says socket closed.
  if (peers.length) block("matched-pre-teardown-peer-observations-missing");
  return result("native-browser-peer-applicability/v2", journal, s.blocked,
    { applicability: s.blocked.length ? "unknown" : "empty-set", peers: [...new Set(peers)].sort() });
}
export function expectedNativeExitCode(qualificationPassed) {
  assert.equal(typeof qualificationPassed, "boolean"); return qualificationPassed ? 0 : 1;
}
