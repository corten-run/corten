import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { records } from "../marketplace/fixtures.mjs";
import { referenceHtml } from "../marketplace/reference.mjs";
import { snapshotMixedPage } from "../mixed-production/snapshot.mjs";
import { collectDOMReads, replayDOMReads } from "../mixed-production/response-evidence.mjs";
import { snapshotPage } from "../marketplace/check.mjs";
import { definition } from "../workloads/registry.mjs";
import { installResourceObserver } from "./resources.mjs";
import { collectBrowserDOM, replayBrowserDOM } from "./native-browser-dom.mjs";
import { EvidenceStore, openEvidence, sha256, encoded } from "./native-evidence.mjs";
import { retainPublicJSON, retainPublicAsset, retainDOMProjection, retainBrowserDOMProjection, replayResponse } from "./native-responses.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "corten-native-response-")); t.after(() => rmSync(root, { recursive: true }));
  return { root, store: new EvidenceStore(root) };
}
const bind = (body, path = "/api/alerts") => ({ requestId: "observed-request", responseSha256: sha256(body), path, status: 200 });

const caseKey = definition("fullstack-browser").cases[0].key;
const expectation = (o) => Object.fromEntries(["observer", "context", "case", "action", "scope", "originatingResponse", "readInterval", "url"].map((key) => [key, o[key]]));
async function browserDOMFixture(t) {
  let body = referenceHtml(records().item_2, "en-US");
  const server = createServer((req, res) => {
    res.writeHead(req.url.endsWith("/item_missing") ? 404 : 200, { "content-type": "text/html" });
    res.end(body.replaceAll("http://localhost", `http://127.0.0.1:${server.address().port}`));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  let browser;
  t.after(async () => { try { await browser?.close(); } finally { await new Promise((done) => server.close(done)); } });
  browser = await chromium.launch({ headless: true });
  const contextId = randomUUID(), context = await browser.newContext(); await context.addInitScript(installResourceObserver); const page = await context.newPage();
  await page.route("**/*", (route) => route.request().resourceType() === "document" ? route.continue() : route.abort());
  return { page, setBody(value) { body = value; }, async read(path = "/marketplace/en-US/item_2") {
    const response = await page.goto(`http://127.0.0.1:${server.address().port}${path}`), bytes = await response.body();
    const identity = { context: contextId, case: caseKey, action: `${caseKey}-0`,
      scope: await page.evaluate(() => globalThis.__fullstackBrowserAudit.checkpoint().scope),
      originatingResponse: { requestId: randomUUID(), sha256: sha256(bytes) } };
    return { identity, observation: await collectBrowserDOM(page, identity), response };
  } };
}
test("actual strict page/Alice observations replay installed snapshot and preserve mixed API behavior", async (t) => {
  const f = await browserDOMFixture(t);
  const ordinary = await f.read(), page = await f.page.evaluate(snapshotPage);
  assert.equal(ordinary.response.status(), 200);
  assert.equal(ordinary.observation.failure, null);
  assert.deepEqual(replayBrowserDOM(ordinary.observation, expectation(ordinary.observation)).page, page);
  const mixed = await f.page.evaluate(collectDOMReads, { source: snapshotMixedPage.toString(), readPath: "/marketplace/en-US/item_2" });
  assert.equal(mixed.failure, null); assert.deepEqual(replayDOMReads(mixed), page);
  f.setBody(referenceHtml(records().item_2, "en-US").replace("seller=&amp;sort=asc", "seller=Alice&amp;sort=desc"));
  const alice = await f.read("/marketplace/en-US/item_2?seller=Alice&sort=desc");
  assert.equal(alice.observation.failure, null); assert.deepEqual(alice.observation.url.query, { seller: "Alice", sort: "desc" });
  assert.deepEqual(replayBrowserDOM(alice.observation, expectation(alice.observation)).page, await f.page.evaluate(snapshotPage));
  const old = await f.page.evaluate(collectDOMReads, { source: snapshotMixedPage.toString(), readPath: "/marketplace/en-US/item_2" });
  assert.equal(old.failure, "credential-filter-blocked");
  const root = mkdtempSync(join(tmpdir(), "corten-browser-dom-"));
  try {
    const store = new EvidenceStore(root), expected = expectation(alice.observation), receipt = retainBrowserDOMProjection(store, alice.observation, expected);
    const ref = store.record("live-dom", receipt); store.seal(); const reader = openEvidence(root), result = replayResponse(reader, reader.json(ref), expected);
    assert.equal(result.type, "public-browser-dom-observation"); assert.deepEqual(result.page, page); reader.finish();
    const wrongResult = structuredClone(receipt); wrongResult.result.page.title = "forged";
    assert.throws(() => replayResponse(reader, wrongResult, expected));
    const wrongIdentity = structuredClone(expected); wrongIdentity.originatingResponse.requestId = "other-request";
    assert.throws(() => replayResponse(reader, receipt, wrongIdentity));
    const changed = structuredClone(alice.observation);
    // This observed guard value is not returned in snapshotPage's result. Its
    // exact bytes still belong to the sealed transcript, not just the summary.
    const guard = changed.events.find((e) => e.key === "getAttribute" && e.args[0]?.scalar === "aria-hidden");
    assert.deepEqual(guard.result, { scalar: null }); guard.result = { scalar: "false" };
    writeFileSync(join(root, receipt.body.path), encoded(changed));
    assert.throws(() => openEvidence(root));
  } finally { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true }); }
  t.diagnostic(`ordinary ${ordinary.observation.events.length} reads; Alice ${alice.observation.events.length} reads/${Buffer.byteLength(JSON.stringify(alice.observation))} bytes`);
});
test("actual missing-item captures article absence and exact visible error, never arbitrary body text", async (t) => {
  const f = await browserDOMFixture(t);
  f.setBody('<!doctype html><html><body><input type="hidden" value="csrf-private-canary"><meta name="csrf-token" content="csrf-private-canary"><h1>Not found</h1><p>arbitrary diagnostic text that must not be retained</p><x-private-tag-canary role="alert">unknown text</x-private-tag-canary><p aria-hidden="attribute-private-canary">unknown text</p></body></html>');
  const { observation, response } = await f.read("/marketplace/en-US/item_missing"), result = replayBrowserDOM(observation, expectation(observation));
  assert.equal(response.status(), 404);
  assert.equal(observation.failure, null);
  assert.deepEqual(result, { kind: "missing-item", page: null, error: { code: "not-found", text: "Not found", tag: "h1" }, articleCount: 0, extractionComplete: true });
  assert.doesNotMatch(JSON.stringify(observation), /csrf-private-canary|arbitrary diagnostic|private-tag-canary|attribute-private-canary/);
  for (const html of [
    '<body><h1>unknown private error text</h1></body>',
    '<body><section hidden><h1>Not found</h1></section></body>',
    '<body><x-private-canary role="alert">Not found</x-private-canary></body>',
    '<body><input type="hidden" value="Not found"><h1>Not found</h1></body>',
    '<body><article class="marketplace"></article><h1>Not found</h1></body>',
  ]) {
    f.setBody(html); const read = await f.read("/marketplace/en-US/item_missing");
    assert.notEqual(read.observation.failure, null); assert.equal(replayBrowserDOM(read.observation, expectation(read.observation)).extractionComplete, false);
    assert.equal(read.observation.events.length, 0); assert.doesNotMatch(JSON.stringify(read.observation), /unknown private error text/);
  }
});
test("unknown/secret queries, hidden/meta values, wrong scope and caller-selected code fail closed", async (t) => {
  const f = await browserDOMFixture(t), { identity } = await f.read();
  for (const query of ["token=secret-query-canary", "seller=secret-query-canary", "seller=A", "seller=Alice&seller=Alice", "unknown=", "sort=unknown", "offers=unknown", "seller=%41lice", "seller=Alice&"]) {
    await f.page.goto(new URL(`?${query}`, f.page.url()).href);
    await assert.rejects(() => collectBrowserDOM(f.page, identity));
  }
  for (const attr of ['href="/marketplace/en-US/item_2?token=private-canary"', 'action="/marketplace/en-US/item_2?csrf=private-canary"', 'href="http://user:password@localhost/x"']) {
    f.setBody(referenceHtml(records().item_2, "en-US").replace("</article>", `<a ${attr}>link</a></article>`));
    const read = await f.read(); assert.equal(read.observation.failure, "credential-filter-blocked"); assert.doesNotMatch(JSON.stringify(read.observation), /private-canary|user:password/);
  }
  f.setBody(referenceHtml(records().item_2, "en-US").replace("</body>", '<input type="hidden" value="private-canary"><meta name="csrf-token" content="meta-canary"></body>')
    .replace(/<h1>[^<]*<\/h1>/, "<h1>private-canary</h1>"));
  const secret = await f.read(); assert.equal(secret.observation.failure, "credential-filter-blocked"); assert.doesNotMatch(JSON.stringify(secret.observation), /private-canary|meta-canary/);
  await assert.rejects(() => collectBrowserDOM(f.page, { ...secret.identity, source: "()=>document.body.innerHTML" }));
  const badScope = await collectBrowserDOM(f.page, { ...secret.identity, scope: "wrong" }); assert.equal(badScope.failure, "native-scope-mismatch");
  f.setBody(referenceHtml(records().item_2, "en-US").replace(/<h1>[^<]*<\/h1>/, '<h1>Public title<script type="application/json">script-private-canary</script></h1>'));
  const nested = await f.read(); assert.equal(nested.observation.failure, "credential-filter-blocked"); assert.doesNotMatch(JSON.stringify(nested.observation), /script-private-canary/);
  f.setBody(referenceHtml(records().item_2, "en-US").replace('action="/marketplace/en-US/item_2" method="post"', 'action="/marketplace/en-US/item_3" method="post"'));
  const wrongForm = await f.read(); assert.equal(wrongForm.observation.failure, "native-dom-snapshot-failed");
  assert.equal(replayBrowserDOM(wrongForm.observation, expectation(wrongForm.observation)).extractionComplete, false);
});
test("ordered reads, fixed source, original response and unique observation identity cannot be substituted", async (t) => {
  const f = await browserDOMFixture(t), { observation } = await f.read(), expected = expectation(observation);
  for (const mutate of [
    (o) => { o.events.push(o.events[0]); }, (o) => { o.events.splice(3, 1); },
    (o) => { o.events[0].key = "innerHTML"; }, (o) => { o.result.page.title = "substituted"; },
    (o) => { o.snapshotSha256 = sha256(snapshotMixedPage.toString()); },
    (o) => { o.source = "()=>document.cookie"; }, (o) => { o.context = "other-context"; },
    (o) => { o.originatingResponse.sha256 = "0".repeat(64); }, (o) => { o.scopeObservation.after = "new-scope"; },
    (o) => { o.urlObservation.after.query = { token: "untrusted" }; },
    (o) => { o.readInterval.finishedAt = o.readInterval.startedAt + 15001; },
  ]) { const o = structuredClone(observation); mutate(o); assert.throws(() => replayBrowserDOM(o, expected)); }
  const later = await collectBrowserDOM(f.page, { ...expectation(observation), observer: undefined }).catch(() => null);
  assert.equal(later, null); // Extra identity/source fields are not collector configuration.
  await f.page.locator("h1").evaluate((el) => { el.textContent = "Public later title"; });
  const live = await collectBrowserDOM(f.page, { context: observation.context, case: observation.case, action: observation.action, scope: observation.scope, originatingResponse: observation.originatingResponse });
  assert.notEqual(live.observer, observation.observer); assert.equal(live.originatingResponse.sha256, observation.originatingResponse.sha256);
  assert.equal(replayBrowserDOM(live, expectation(live)).page.title, "Public later title");
});
test("public JSON and asset bytes replay exact original bytes with independent binding", (t) => {
  const { root, store } = fixture(t), body = Buffer.from('[ {"email":"native@example.test","item_id":"item_1","target_minor":125} ]');
  const json = retainPublicJSON(store, body, "state", bind(body)), js = Buffer.from('export const value = 1;\n'), assetBinding = bind(js, "/assets/native.js");
  const asset = retainPublicAsset(store, js, assetBinding, "text/javascript"); store.seal(); const reader = openEvidence(root);
  assert.deepEqual(replayResponse(reader, json, bind(body)).value, JSON.parse(body));
  assert.equal(replayResponse(reader, asset, assetBinding).sha256, sha256(js)); reader.finish();
  assert.throws(() => replayResponse(reader, json, { ...bind(body), requestId: "other" }));
  assert.throws(() => replayResponse(reader, asset, { ...assetBinding, responseSha256: "0".repeat(64) }));
});
test("raw HTML, unknown JSON, credential keys and query-bearing transport bodies are refused before storage", (t) => {
  const { store } = fixture(t);
  for (const body of ['{"session":"private-canary"}', '[{"email":"native@example.test","item_id":"item_1","target_minor":1,"csrf":"private-canary"}]', '{"email":1,"email":2}'])
    assert.throws(() => retainPublicJSON(store, Buffer.from(body), "state", bind(body)));
  const html = Buffer.from('<input type="hidden" value="private-canary">');
  assert.throws(() => retainPublicAsset(store, html, bind(html, "/native.html"), "text/html"));
  assert.throws(() => retainPublicAsset(store, html, bind(html, "/a.js?token=private-canary"), "text/javascript"));
  assert.equal(store.files.size, 0);
});
test("native Chromium public semantic read transcript is typed projection, never raw HTML or CSRF", async (t) => {
  const { root, store } = fixture(t), browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false }), page = await context.newPage();
    const html = referenceHtml(records().item_1, "en-US").replace("</body>", '<input type="hidden" value="native-secret-canary"></body>');
    const path = "/marketplace/en-US/item_1";
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(`http://localhost${path}`);
    const transcript = await page.evaluate(collectDOMReads, { source: snapshotMixedPage.toString(), readPath: path });
    assert.equal(transcript.failure, null); assert.doesNotMatch(JSON.stringify(transcript), /native-secret-canary/);
    const binding = bind(html, path), receipt = retainDOMProjection(store, transcript, binding);
    const ref = store.record("response", receipt); store.seal(); const reader = openEvidence(root);
    assert.equal(replayResponse(reader, reader.json(ref), binding).extractionComplete, true); reader.finish();
    assert.equal(receipt.type, "public-dom-read-projection"); assert.notEqual(receipt.body.sha256, binding.responseSha256);
    const v = structuredClone(receipt); v.page.title = "forged"; assert.throws(() => replayResponse(reader, v, binding));
    await context.close();
  } finally { await browser.close(); }
});
