import assert from "node:assert/strict";
import { retainJSONResponse, replayDOMReads } from "../mixed-production/response-evidence.mjs";
import { exact, encoded, sha256 } from "./native-evidence.mjs";
import { replayBrowserDOM } from "./native-browser-dom.mjs";

function bindingShape(value) {
  exact(value, ["requestId", "responseSha256", "path", "status"]);
  assert.match(value.requestId, /^[a-zA-Z0-9_.:-]{1,128}$/); assert.match(value.responseSha256, /^[a-f0-9]{64}$/);
  assert.match(value.path, /^\/(?!\/)[a-zA-Z0-9_./%-]*$/);
  assert.ok(!value.path.split("/").some((p) => p === "." || p === ".."));
  assert.ok(Number.isInteger(value.status) && value.status >= 100 && value.status <= 599);
}
export function retainPublicJSON(store, body, kind, binding) {
  bindingShape(binding); body = Buffer.from(body);
  retainJSONResponse(body, kind); assert.equal(sha256(body), binding.responseSha256);
  return { schema: "native-browser-response/v2", type: "public-json-bytes", kind, binding, body: store.blob(body) };
}
const assetTypes = { js: ["application/javascript", "text/javascript"], css: ["text/css"], png: ["image/png"],
  jpg: ["image/jpeg"], jpeg: ["image/jpeg"], webp: ["image/webp"], gif: ["image/gif"], ico: ["image/x-icon", "image/vnd.microsoft.icon"],
  woff: ["font/woff"], woff2: ["font/woff2"] };
function asset(binding, contentType) {
  bindingShape(binding);
  assert.ok(assetTypes[binding.path.split(".").at(-1)]?.includes(contentType), "only known public asset types; no HTML, transport or arbitrary JSON");
}
export function retainPublicAsset(store, body, binding, contentType) {
  asset(binding, contentType); body = Buffer.from(body); assert.equal(sha256(body), binding.responseSha256);
  return { schema: "native-browser-response/v2", type: "public-asset-bytes", contentType, binding, body: store.blob(body) };
}
export function retainDOMProjection(store, transcript, binding) {
  bindingShape(binding); assert.equal(transcript.readPath, binding.path);
  const page = replayDOMReads(transcript);
  return { schema: "native-browser-response/v2", type: "public-dom-read-projection", binding, body: store.blob(encoded(transcript)), page };
}
export function retainBrowserDOMProjection(store, observation, expectedIdentity, nativeDocument) {
  const result = replayBrowserDOM(observation, expectedIdentity, nativeDocument);
  return { schema: "native-browser-response/v2", type: "public-browser-dom-observation", identity: expectedIdentity, body: store.blob(encoded(observation)), result };
}
export function replayResponse(reader, receipt, binding, nativeDocument) {
  if (receipt.type === "public-browser-dom-observation") {
    exact(receipt, ["schema", "type", "identity", "body", "result"]); assert.equal(receipt.schema, "native-browser-response/v2");
    assert.deepEqual(receipt.identity, binding);
    const result = replayBrowserDOM(reader.json(receipt.body), binding, nativeDocument); assert.deepEqual(result, receipt.result);
    return { type: receipt.type, ...result };
  }
  assert.equal(receipt.schema, "native-browser-response/v2"); bindingShape(binding); assert.deepEqual(receipt.binding, binding);
  if (receipt.type === "public-dom-read-projection") {
    exact(receipt, ["schema", "type", "binding", "body", "page"]);
    const transcript = reader.json(receipt.body); assert.equal(transcript.readPath, binding.path);
    const page = replayDOMReads(transcript); assert.deepEqual(page, receipt.page);
    return { type: receipt.type, page, extractionComplete: transcript.failure === null };
  }
  const body = reader.read(receipt.body); assert.equal(sha256(body), binding.responseSha256);
  if (receipt.type === "public-json-bytes") {
    exact(receipt, ["schema", "type", "kind", "binding", "body"]); retainJSONResponse(body, receipt.kind);
    return { type: receipt.type, value: JSON.parse(body), extractionComplete: true };
  }
  assert.equal(receipt.type, "public-asset-bytes"); exact(receipt, ["schema", "type", "contentType", "binding", "body"]);
  asset(binding, receipt.contentType); return { type: receipt.type, sha256: sha256(body), extractionComplete: true };
}
