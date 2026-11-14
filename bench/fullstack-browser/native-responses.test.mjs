import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { records } from "../marketplace/fixtures.mjs";
import { referenceHtml } from "../marketplace/reference.mjs";
import { snapshotMixedPage } from "../mixed-production/snapshot.mjs";
import { collectDOMReads } from "../mixed-production/response-evidence.mjs";
import { EvidenceStore, openEvidence, sha256 } from "./native-evidence.mjs";
import { retainPublicJSON, retainPublicAsset, retainDOMProjection, replayResponse } from "./native-responses.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "corten-native-response-")); t.after(() => rmSync(root, { recursive: true }));
  return { root, store: new EvidenceStore(root) };
}
const bind = (body, path = "/api/alerts") => ({ requestId: "observed-request", responseSha256: sha256(body), path, status: 200 });
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
