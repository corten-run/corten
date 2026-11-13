import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { records as fixture } from "../marketplace/fixtures.mjs";
import { createPlan } from "../workloads/mixed.mjs";
import { control, sleep, upstreamEvidence, emptyCapture, checkCell, sha256 } from "./capture.mjs";
import { loadUpstream } from "./load-upstream.mjs";
import { reconcileLedger, upstreamManifest, upstreamPhase } from "./upstream-ledger.mjs";
import { nativeTransport } from "./native.mjs";
import { mergeResourceSamples } from "./resources.mjs";
import { referenceHtml } from "../marketplace/reference.mjs";
import { expectedPage } from "../marketplace/records.mjs";
import { buildInputPaths, sourceAuditIdentity, sourceSnapshot, verifySourceAudit } from "./source-audit.mjs";
import { parseArgs } from "./run.mjs";

const records = fixture(), path = "/marketplace/records/item_1", token = "review-private";
async function listen(server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }

test("an old delayed second fetch is not credited to a zero-pending replacement operation", async () => {
  const upstream = loadUpstream({ item_1: records.item_1 }, token), base = await listen(upstream);
  let late, cached, oldWire;
  const app = createServer(async (req, res) => {
    if (req.url === "/old") {
      const headers = { traceparent: req.headers.traceparent };
      cached = Buffer.from(await (await fetch(base + path, { headers })).arrayBuffer());
      late = sleep(150).then(async () => (await fetch(base + path, { headers })).arrayBuffer());
    } else await sleep(300);
    res.end(cached);
  });
  const native = await listen(app);
  try {
    oldWire = await control(base, token, "old", { path, mode: "normal", delayMs: 0 });
    await (await fetch(native + "/old", { headers: oldWire })).arrayBuffer();
    assert.equal((await control(base, token, "old")).pending, 0);
    const newWire = await control(base, token, "new", { path, mode: "normal", delayMs: 0 });
    await (await fetch(native + "/new", { headers: newWire })).arrayBuffer(); await late;
    await control(base, token, "seal", { action: "seal" });
    const ledger = await control(base, token, "ledger");
    assert.deepEqual(ledger.operations.map((op) => op.requests), [2, 0]);
    const manifest = ledger.operations.map((op) => ({ id: op.id, path, mode: "normal", requests: 1, cancelled: 0, receipt: upstreamEvidence(op) }));
    assert.equal(reconcileLedger(ledger, manifest).valid, false, "actual old=2/new=0 must not become attributed 1/1");
  } finally { await late; await close(app); await close(upstream); }
});

test("a valid API POST/303/GET observation retains two primary reads in the ledger contract", () => {
  const plan = createPlan({ seed: 42, clients: 2, repetitions: 1, records }), capture = emptyCapture(plan, "corten");
  for (const row of capture.results.filter((r) => r.request.source === "api")) row.upstream = {
    requests: row.request.method === "POST" ? 2 : 1, completed: row.request.method === "POST" ? 2 : 1,
    cancelled: 0, pending: 0, path: `/marketplace/records/${row.request.itemId}`, mode: row.request.category === "slow" ? row.request.variant : "normal" };
  const startup = { id: "startup", path, mode: "normal", requests: 0, completed: 0, cancelled: 0, pending: 0, events: [] };
  const manifest = upstreamManifest(plan, "api", startup, [upstreamPhase("cycle", 0, capture, "api")]);
  const post = capture.results.find((r) => r.request.source === "api" && r.request.method === "POST");
  assert.equal(manifest.find((r) => r.id === `cycle_0_${post.request.id}`).requests, 2);
});

test("a real byte-forwarding native endpoint passes semantic JSON extraction, not a source audit", { skip: !process.env.MIXED_BROWSER_TESTS }, async () => {
  const { chromium } = await import("@playwright/test"), browser = await chromium.launch();
  const upstream = loadUpstream(records, token), base = await listen(upstream);
  const app = createServer(async (req, res) => {
    const recordPath = new URL(req.url, "http://native").pathname.replace("/api/marketplace/", "/marketplace/records/");
    const body = Buffer.from(await (await fetch(base + recordPath, { headers: { traceparent: req.headers.traceparent } })).arrayBuffer());
    res.writeHead(200, { "content-type": "application/json" }); res.end(body);
  });
  const native = await listen(app), transport = await nativeTransport({ browser, base: native, settings: { requestTimeoutMs: 5000 } });
  try {
    const plan = createPlan({ seed: 7, clients: 2, repetitions: 1, records });
    const request = plan.requests.find((r) => r.source === "api" && r.category === "json"), evidence = { stages: [] };
    const wire = await control(base, token, "json", { path: `/marketplace/records/${request.itemId}`, mode: "normal", delayMs: 0 });
    const response = await transport.send(request, null, evidence, null, wire), capture = emptyCapture(plan, "corten");
    capture.results[request.index] = { request, outcome: "completed", status: response.status, error: response.error, contentType: response.contentType,
      contentEncoding: response.contentEncoding, record: JSON.parse(response.body), page: null, form: null, state: null,
      upstream: upstreamEvidence(await control(base, token, "json")) };
    assert.equal(checkCell(plan, capture, records, request).passed, true,
      "the semantic oracle cannot certify native parsing: a separate exact-source gate is required");
    assert.throws(() => verifySourceAudit(null, { commit: "a".repeat(40), nativeProfile: "defaults" }, { sourceFiles: [], files: {} },
      { buildCommit: "a".repeat(40), buildDirty: "false", profile: "defaults", id: `sha256:${"a".repeat(64)}` }), /independent source audit/);
  } finally { await transport.close(); await browser.close(); await close(app); await close(upstream); }
});

// Audit objects below are deliberately test-only attestations, never evidence
// about an actual adapter/image. The runner cannot mint these positive receipts.
function auditVector() {
  const files = { "bench/fullstack/apps/express/server.mjs": Buffer.from("const record = await source.get(id); res.json(record);"),
    "bench/fullstack/apps/express/lib/source.mjs": Buffer.from("export const get = async id => (await fetch(base + id)).json();") };
  const sourceFiles = Object.entries(files).map(([path, body]) => ({ path, sha256: sha256(body) }));
  const expected = { app: "express", payload: "marketplace-v2", key: "mixed-native-source", commit: "a".repeat(40),
    contractSha256: "b".repeat(64), nativeProfile: "defaults", buildInputsSha256: sha256(JSON.stringify(sourceFiles)) };
  const receipt = { schema: "json-api-native-audit/v1", identity: expected, auditor: "independent-unit-vector", auditedAt: "2026-11-12T00:00:00Z",
    traceContext: { requestScoped: true, delayedWorkRetainsTrace: true, noAmbientCurrentOperation: true },
    findings: [], verified: { typedCompleteRecord: true, nativeSerialization: true, noOutputCache: true, noJsonPassthrough: true,
      fixtureParsedAtStartup: true, requestTimeFetchParse: true, upstreamErrors: true }, sourceFiles };
  return { expected, snapshot: { files, sourceFiles }, receipt, image: { id: `sha256:${"c".repeat(64)}`,
    buildCommit: expected.commit, buildDirty: "false", profile: "defaults" } };
}

test("source audits bind the independent review to exact complete inputs, source commit, native configuration and built image", () => {
  const x = auditVector(); assert.equal(verifySourceAudit(x.receipt, x.expected, x.snapshot, x.image).imageId, x.image.id);
  for (const mutate of [
    (x) => { x.receipt = null; },
    (x) => { x.receipt.sourceFiles.pop(); },
    (x) => { x.receipt.auditor = ""; },
    (x) => { x.receipt.findings.push("byte forwarding"); },
    (x) => { x.receipt.verified.nativeSerialization = false; },
    (x) => { x.receipt.verified.requestTimeFetchParse = false; },
    (x) => { delete x.receipt.traceContext; },
    (x) => { x.receipt.traceContext.delayedWorkRetainsTrace = false; },
    (x) => { x.receipt.traceContext.noAmbientCurrentOperation = false; },
    (x) => { x.image.buildCommit = "d".repeat(40); },
    (x) => { x.image.buildDirty = "true"; },
    (x) => { x.image.profile = "matched"; },
    (x) => { x.receipt.identity = { ...x.expected, contractSha256: "e".repeat(64) }; },
    (x) => { x.snapshot.files["bench/fullstack/apps/express/server.mjs"] = Buffer.from("res.end(await upstream.arrayBuffer());"); },
  ]) { const bad = auditVector(); mutate(bad); assert.throws(() => verifySourceAudit(bad.receipt, bad.expected, bad.snapshot, bad.image)); }
});

test("source requests are derived from native build inputs, not positive qualification declarations", () => {
  const x = auditVector(), summary = { provenance: { nativeSource: { commit: x.expected.commit } }, contractSha256: x.expected.contractSha256,
    options: { profile: "defaults" }, apps: { express: { buildInputs: x.snapshot.sourceFiles } } };
  assert.deepEqual(sourceAuditIdentity(summary, "express"), x.expected);
  assert.deepEqual(buildInputPaths("express"), ["bench/fullstack/apps/express"]);
  assert.deepEqual(buildInputPaths("corten"), ["."]);
  assert.throws(() => sourceSnapshot(process.cwd(), ["../outside"]));
  assert.equal(parseArgs(["w123", "--build", "--measure", "--native-audits", "reviewed.json"]).nativeAudits, "reviewed.json");
});

test("resource merge refuses an originally backwards stream rather than sorting away the evidence", () => {
  const sample = (t) => ({ t, cpu: 1, mem: 64 });
  assert.throws(() => mergeResourceSamples([sample(0)], [sample(500), sample(1000), sample(900), sample(1500)], [sample(2000)]));
});

test("mixed extraction accepts a separate local native POST action without changing the captured DOM", { skip: !process.env.MIXED_BROWSER_TESTS }, async () => {
  const { chromium } = await import("@playwright/test"), browser = await chromium.launch();
  // A transport/extraction fixture only, never native benchmark evidence.
  let html = referenceHtml(records.item_1, "en-US").replace(/<base[^>]*>/, "")
    .replace('action="/marketplace/en-US/item_1" method="post"', 'action="/native-write" method="post"');
  const app = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
  const base = await listen(app), transport = await nativeTransport({ browser, base, settings: { requestTimeoutMs: 5000 } });
  try {
    const request = { client: 0, source: "fixture", formPage: "/marketplace/en-US/item_1", path: "/marketplace/en-US/item_1", category: "page",
      method: "GET", accept: "text/html", acceptEncoding: "identity" }, evidence = { stages: [] };
    const response = await transport.send(request, null, evidence);
    assert.deepEqual(await transport.snapshot(response, request, evidence), expectedPage(records.item_1, "en-US"));
    assert.ok(evidence.redactedNativeDOM.includes('action="/native-write"'));
    const inline = await transport.send({ ...request, path: "/native-write" }, null, evidence);
    assert.deepEqual(await transport.snapshot(inline, request, evidence), expectedPage(records.item_1, "en-US"));
    const original = html;
    for (const bad of [original.replace('action="/native-write"', 'action="https://foreign.test/write"'),
      original.replace('action="/marketplace/en-US/item_1" method="get"', 'action="/marketplace/fr-FR/item_2" method="get"'),
      original.replace('<h1>', '<h1 hidden>')]) {
      html = bad;
      await assert.rejects(transport.snapshot(await transport.send(request, null, evidence), request, evidence));
    }
  } finally { await transport.close(); await browser.close(); await close(app); }
});

test("wire identity has no path/current-operation fallback and accepts child spans only within the original trace", async () => {
  const upstream = loadUpstream({ item_1: records.item_1 }, token), base = await listen(upstream);
  try {
    const wire = await control(base, token, "original", { path, mode: "normal", delayMs: 0 });
    assert.equal((await fetch(base + path)).status, 503);
    assert.equal((await fetch(base + path, { headers: { traceparent: "00-00000000000000000000000000000000-1111111111111111-00" } })).status, 503);
    assert.equal((await fetch(base + path, { headers: { traceparent: "00-11111111111111111111111111111111-1111111111111111-00" } })).status, 503);
    const child = wire.traceparent.replace(/-[0-9a-f]{16}-00$/, "-2222222222222222-00");
    assert.equal((await fetch(base + path, { headers: { traceparent: child } })).status, 200);
    assert.equal((await control(base, token, "original")).requests, 1);
    const orphans = await control(base, token, "orphans");
    assert.deepEqual(orphans.map((o) => o.reason), ["missing-wire-identity", "missing-wire-identity", "unknown-wire-identity"]);
  } finally { await close(upstream); }
});

test("real native POST/303/GET carries one immutable primary trace and retains both upstream reads", { skip: !process.env.MIXED_BROWSER_TESTS }, async () => {
  const { chromium } = await import("@playwright/test"), browser = await chromium.launch();
  const upstream = loadUpstream({ item_1: records.item_1 }, token), base = await listen(upstream), requests = [];
  const app = createServer(async (req, res) => {
    for await (const _ of req) { /* Consume the real native POST body. */ }
    requests.push({ method: req.method, traceparent: req.headers.traceparent });
    await (await fetch(base + path, { headers: { traceparent: req.headers.traceparent } })).arrayBuffer();
    if (req.method === "POST") { res.writeHead(303, { location: "/marketplace/en-US/item_1" }); res.end(); }
    else { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><p>native redirect result</p>"); }
  });
  const native = await listen(app), transport = await nativeTransport({ browser, base: native, settings: { requestTimeoutMs: 5000 } });
  try {
    const wire = await control(base, token, "write", { path, mode: "normal", delayMs: 0 });
    const request = { client: 0, source: "api", method: "POST", formPage: "/marketplace/en-US/item_1", category: "accepted-write",
      accept: "text/html", acceptEncoding: "identity" }, evidence = { stages: [] };
    const binding = { transport: { url: native + "/native-write", data: [["email", "native@example.test"]] },
      input: { email: "native@example.test" }, evidence: { contentType: "application/x-www-form-urlencoded" } };
    const response = await transport.send(request, binding, evidence, null, wire);
    assert.equal(response.status, 303); assert.equal(response.visible.status, 200);
    assert.deepEqual(requests.map((r) => r.method), ["POST", "GET"]);
    assert.ok(requests.every((r) => r.traceparent === wire.traceparent));
    const saved = await control(base, token, "write"); assert.equal(saved.requests, 2);
    await control(base, token, "seal", { action: "seal" });
    assert.equal(reconcileLedger(await control(base, token, "ledger"), [{ id: "write", path, mode: "normal", requests: saved.requests,
      minimumRequests: 1, cancelled: 0, receipt: upstreamEvidence(saved) }]).valid, true);
  } finally { await transport.close(); await browser.close(); await close(app); await close(upstream); }
});
