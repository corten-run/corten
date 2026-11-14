import test from "node:test";
import assert from "node:assert/strict";
import { replayWorkerAbsence, replayPeerApplicability, expectedNativeExitCode } from "./native-lifetimes.mjs";

export function journalFixture() {
  const target = { target: "page", context: "context", type: "page", opener: null, scheme: "about:", path: null };
  return { schema: "native-browser-platform-lifetimes/v2", target,
    boundaries: { startedAt: 10, applicationStartedAt: 11, terminalStartedAt: 300, endedAt: 560 }, observationFailures: [],
    events: [
      { event: "Target.setDiscoverTargets", startedAt: 0, receivedAt: 1, params: { discover: true }, result: {} },
      ...["Runtime", "Page", "Network"].map((domain) => ({ event: "domain-enabled", domain, receivedAt: 2 })),
      { event: "native-clock-sample", phase: "initial-native-clock", startedAt: 3, receivedAt: 4, at: 1 },
      { event: "Target.getTargets", phase: "initial", startedAt: 5, receivedAt: 6, targets: [target] },
      { event: "Network.requestWillBeSent", request: "r1", receivedAt: 20, at: 1.01, type: "Document", frame: "page", loader: "l1", scheme: "http:", path: "/" },
      { event: "Network.responseReceived", request: "r1", receivedAt: 30, at: 1.02, type: "Document", frame: "page", loader: "l1", status: 200, mime: "text/html" },
      { event: "Network.loadingFinished", request: "r1", receivedAt: 40, at: 1.03 },
      { event: "native-clock-sample", phase: "terminal-native-clock", startedAt: 550, receivedAt: 551, at: 1.54 },
      { event: "Target.getTargets", phase: "terminal", startedAt: 552, receivedAt: 553, targets: [target] },
    ] };
}
test("continuous worker-free completed HTTP journal derives applicability, not semantic cleanup", () => {
  const journal = journalFixture(), workers = replayWorkerAbsence(journal), peers = replayPeerApplicability(journal, workers);
  assert.equal(workers.status, "verified"); assert.equal(peers.status, "verified"); assert.equal(peers.applicability, "empty-set");
  assert.equal("cleanupComplete" in peers, false); assert.equal("qualificationPassed" in peers, false);
  assert.equal(expectedNativeExitCode(true), 0); assert.equal(expectedNativeExitCode(false), 1);
  for (const bad of [null, 1, "false", {}, undefined]) assert.throws(() => expectedNativeExitCode(bad));
});
test("flags cannot repair absent discovery/inventory/domain/event/observer evidence", () => {
  for (const mutate of [
    (j) => { j.events = j.events.filter((e) => e.event !== "Target.setDiscoverTargets"); },
    (j) => { j.events = j.events.filter((e) => e.phase !== "initial"); },
    (j) => { j.events = j.events.filter((e) => e.phase !== "terminal"); },
    (j) => { j.events = j.events.filter((e) => e.domain !== "Network"); },
    (j) => { j.observationFailures.push({ phase: "session-closed" }); },
    (j) => { j.events.at(-1).targets.push({ target: "extra", context: "other", type: "page" }); },
    (j) => { j.events[6].receivedAt = 0; },
  ]) {
    const j = journalFixture(); mutate(j); j.coverage = { workerNetwork: true, browserTargetDiscovery: true };
    assert.equal(replayWorkerAbsence(j).status, "blocked");
  }
});
test("transient dedicated/shared/service workers and uncovered frames remain proof-missing", () => {
  for (const type of ["worker", "shared_worker", "service_worker", "iframe", "page"]) {
    const j = journalFixture(); j.events.splice(9, 0,
      { event: "Target.targetCreated", receivedAt: 50, target: "transient", context: "context", type },
      { event: "Target.targetDestroyed", receivedAt: 51, target: "transient" });
    assert.equal(replayWorkerAbsence(j).status, "blocked", type);
  }
  const j = journalFixture(); j.events.splice(9, 0, { event: "Page.frameNavigated", receivedAt: 50, frame: "child", parent: "page" });
  assert.equal(replayWorkerAbsence(j).status, "blocked");
});
test("WebSocket, EventSource, streams and missing terminals require real peer proof even after CDP close", () => {
  for (const mutate of [
    (j) => j.events.splice(9, 0, { event: "Network.webSocketCreated", receivedAt: 50, request: "socket" }, { event: "Network.webSocketClosed", receivedAt: 51, request: "socket" }),
    (j) => { j.events[6].type = "EventSource"; j.events[7].type = "EventSource"; },
    (j) => { j.events[7].mime = "text/event-stream"; },
    (j) => { j.events.splice(8, 1); },
    (j) => { j.events.splice(7, 1); },
    (j) => { j.events = j.events.filter((e) => e.event !== "native-clock-sample"); },
  ]) {
    const j = journalFixture(); mutate(j); const workers = replayWorkerAbsence(j);
    assert.equal(replayPeerApplicability(j, workers).status, "blocked");
  }
  const j = journalFixture(), proof = replayWorkerAbsence(j); proof.status = "blocked";
  assert.throws(() => replayPeerApplicability(j, proof));
});
test("ordinary loadingFailed is a terminal observation, not an invented passing response", () => {
  const j = journalFixture(); j.events.splice(7, 2, { event: "Network.loadingFailed", request: "r1", receivedAt: 40, at: 1.03, canceled: false, errorText: "net::ERR_CONNECTION_REFUSED" });
  const peers = replayPeerApplicability(j, replayWorkerAbsence(j)); assert.equal(peers.status, "verified");
  assert.equal("outcome" in peers, false);
});

function redirectFixture() {
  const j = journalFixture(), first = { ...j.events[6], path: "/start", urlSha256: "a".repeat(64), redirectStatus: null, redirectResponse: null };
  const final = { ...first, receivedAt: 30, at: 1.02, path: "/final", urlSha256: "b".repeat(64), redirectStatus: 302, redirectHasExtraInfo: true,
    redirectResponse: { scheme: "http:", path: "/start", urlSha256: first.urlSha256, status: 302, timing: { requestTime: 1.011 } } };
  j.events.splice(6, 3, first,
    { event: "Network.requestWillBeSentExtraInfo", request: "r1", receivedAt: 22, at: 1.011 }, final,
    { event: "Network.requestWillBeSentExtraInfo", request: "r1", receivedAt: 32, at: 1.021 },
    { ...j.events[7], receivedAt: 40, at: 1.03 },
    { event: "Page.frameNavigated", receivedAt: 41, frame: "page", loader: "l1", scheme: "http:", path: "/final" },
    { ...j.events[8], receivedAt: 50, at: 1.04 });
  j.documents = [{ frame: "page", loader: "l1", path: "/final", observedAt: 60,
    identityObservation: { documentSha256: final.urlSha256 }, assets: [], preloads: [] }];
  return j;
}
test("retained redirect, ExtraInfo and document observations prevent deleted Network success", async (t) => {
  const original = redirectFixture();
  assert.equal(replayPeerApplicability(original, replayWorkerAbsence(original)).status, "verified");
  for (const [name, mutate] of [
    ["predecessor", (j) => { j.events.splice(j.events.findIndex((e) => e.event === "Network.requestWillBeSent"), 1); }],
    ["main-stream", (j) => { j.events = j.events.filter((e) => !["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished"].includes(e.event)); }],
    ["whole-stream", (j) => { j.events = j.events.filter((e) => !e.event.startsWith("Network.")); }],
    ["parser-only", (j) => { j.events = j.events.filter((e) => !e.event.startsWith("Network.") && e.event !== "Page.frameNavigated"); }],
    ["orphan-extra", (j) => { j.events = j.events.filter((e) => !e.event.startsWith("Network.") || e.event === "Network.requestWillBeSentExtraInfo"); j.events = j.events.filter((e) => e.event !== "Page.frameNavigated"); j.documents = []; }],
  ]) await t.test(name, () => {
    const j = structuredClone(original); mutate(j);
    assert.equal(replayPeerApplicability(j, replayWorkerAbsence(j)).status, "blocked");
  });
});
