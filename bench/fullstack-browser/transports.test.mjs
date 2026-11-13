// Apparatus tests only. No synthetic fixture below is a native contender capture.
import test from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { observeNetwork, sanitizeNative } from "./observe.mjs";
import { singleFetchData, writeDestination, navigationDestination, normalizeReactRouterCase } from "./navigation.mjs";
import { parseNativeFunction, resolveNativeURL, scopedDestination } from "./scopes.mjs";
import { classifyCancellation, NativeNetworkAudit } from "./cancellations.mjs";

const action = Buffer.from(JSON.stringify([{ _1: 2 }, "data", { _3: 4 }, "message", "Observed"]));
const loader = Buffer.from(JSON.stringify([{ _1: 2 }, "routes/marketplace", { _3: 4 }, "data", {}]));
const form = { method: "POST", action: "/marketplace/fr-FR/item_2", fields: ["email", "target_price"],
  enhancement: { path: "/marketplace/fr-FR/item_2", transport: "router" },
  router: { basis: "mounted-react-router-Form", wirePath: "/marketplace/fr-FR/item_2.data", routes: ["root", "routes/marketplace"] } };
const env = { app: "react-router", architecture: "react-router", js: true, form };
const post = { id: "observed", method: "POST", path: form.router.wirePath, status: 200, transport: "router", input: { email: "a@b.test", target_price: "1,25" }, components: [],
  resource: "fetch", type: "text/x-script; charset=utf-8", completed: true, failure: null, nativeData: singleFetchData(action, "POST") };

test("Single Fetch action and loader envelopes are distinct and malformed shapes stay unresolved", () => {
  assert.equal(singleFetchData(action, "POST").kind, "action");
  assert.deepEqual(singleFetchData(loader, "GET").routes, ["routes/marketplace"]);
  for (const [body, method] of [[action, "GET"], [loader, "POST"], [action, "PUT"], ["bad", "POST"], ["{}", "POST"],
    ['[{"_1":999},"data"]', "POST"], ['[{"plain":2},"data",{}]', "POST"], ['[{"_1":2},"data",null]', "POST"],
    ['[{"_1":2},"unrelated",{"_3":4},"data",{}]', "GET"]]) assert.equal(singleFetchData(body, method), null);
});

test("native handler source is hashed even in failure-page and independent-parser observations", () => {
  const native = { form: { router: { handlerSource: "()=>SECRET", componentSource: "()=>PRIVATE" } } };
  sanitizeNative(native); assert.equal(native.form.router.handlerSha256.length, 64);
  assert.ok(!JSON.stringify(native).includes("SECRET")); assert.ok(!JSON.stringify(native).includes("PRIVATE"));
  const once = structuredClone(native); assert.deepEqual(sanitizeNative(native), once);
  assert.deepEqual(sanitizeNative({ form: null }), { form: null });
});

test("RR physical paths map only through mounted native Form and observed successful Single Fetch", () => {
  assert.equal(writeDestination(post, env), form.action);
  for (const patch of [{ path: "/marketplace/fr-FR/item_1.data" }, { path: "/marketplace/en-US/item_2.data" }, { path: form.action }, { resource: "document" },
    { type: "application/json" }, { transport: "document" }, { failure: "net::ERR_ABORTED" }, { completed: false }, { status: 500 }, { nativeData: null }, { nativeData: singleFetchData(loader, "GET") }]) {
    const changed = { ...post, ...patch }; assert.equal(writeDestination(changed, env), changed.path);
  }
  for (const patch of [{ js: false }, { architecture: "next-pages" }, { app: "nextjs" }, { form: { ...form, router: null } },
    { form: { ...form, enhancement: { path: form.action, transport: "fetch" } } }]) assert.equal(writeDestination(post, { ...env, ...patch }), post.path);
  const get = { ...post, method: "GET", nativeData: singleFetchData(loader, "GET"), input: null };
  assert.equal(navigationDestination(get, env), form.action);
  assert.equal(navigationDestination(get, { ...env, form: { ...form, router: { ...form.router, routes: ["routes/unrelated"] } } }), get.path);
  const raw = { architecture: "react-router", environment: { js: true }, steps: [{ requests: [{ ...post, nativeProtocol: { framework: "react-router", form } }] }] };
  const normalized = normalizeReactRouterCase(structuredClone(raw));
  assert.equal(normalized.steps[0].requests[0].path, form.action); assert.equal(raw.steps[0].requests[0].path, post.path);
  assert.deepEqual(Object.keys(normalized.steps[0].requests[0]).sort(), ["id", "method", "path", "status", "transport", "input", "components"].sort());
  for (const patch of [{ failure: "net::ERR_ABORTED" }, { completed: false }]) {
    const failed = structuredClone(raw); Object.assign(failed.steps[0].requests[0], patch);
    assert.throws(() => normalizeReactRouterCase(failed), /cannot be normalized into success/);
  }
});

test("scoped endpoint reader resolves native template syntax without evaluation or guessed routes", () => {
  const source = parseNativeFunction('async e=>rpc(`/api/marketplace/${encodeURIComponent(String(route.params.id))}`,{method:`POST`})');
  let call;
  const visit = (node) => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "rpc") call = node; ts.forEachChild(node, visit); }; visit(source);
  const variables = new Map([["route", { params: { id: "item_2", locale: "fr-FR" } }]]);
  const value = resolveNativeURL(call.arguments[0], variables);
  assert.equal(value, "/api/marketplace/item_2"); assert.equal(resolveNativeURL(call.arguments[0], new Map()), undefined);
  assert.equal(parseNativeFunction("not valid source"), null);
  const base = "http://local", action = "/marketplace/fr-FR/item_2";
  assert.equal(scopedDestination("nuxt", value, base, action), value);
  for (const wrong of ["https://attacker.invalid" + value, "/api/marketplace/item_1", value + "?token=SECRET", "http://user:SECRET@local" + value, "http://["]) assert.equal(scopedDestination("nuxt", wrong, base, action), null);
  const nativeURL = "/_serverFn/" + "a".repeat(64);
  assert.equal(scopedDestination("tanstack-start", nativeURL, base, action), nativeURL);
  for (const wrong of ["/_serverFn/invented", nativeURL + "?token=SECRET", "https://attacker.invalid" + nativeURL]) assert.equal(scopedDestination("tanstack-start", wrong, base, action), null);
});

test("native cancellation classification requires canceled GET, replaced loader, committed frame and observed HTTP", () => {
  const request = { method: "GET", kind: "Fetch", frame: "main", loader: "old", at: 1, failed: { at: 3, canceled: true, errorText: "net::ERR_ABORTED" } };
  const document = { method: "GET", kind: "Document", frame: "main", loader: "new", at: 2, status: 404, path: "/missing" };
  const frames = [{ frame: "main", loader: "new" }];
  assert.equal(classifyCancellation(request, [document], frames).classification, "native-document-replacement-cancellation");
  for (const patch of [{ frame: "other" }, { loader: "old" }, { status: null }, { at: 4 }]) assert.equal(classifyCancellation(request, [{ ...document, ...patch }], frames).classification, "native-request-cancellation");
  assert.equal(classifyCancellation(request, [document], []).classification, "native-request-cancellation");
  assert.equal(classifyCancellation({ ...request, method: "POST" }, [document], frames).classification, "critical-request-cancellation");
  assert.equal(classifyCancellation({ ...request, kind: "Document" }, [document], frames).classification, "critical-request-cancellation");
  assert.equal(classifyCancellation({ ...request, failed: { ...request.failed, canceled: false } }, [document], frames).classification, "network-failure");
  assert.equal(classifyCancellation(request, [document, document], frames).classification, "native-request-cancellation");
});

test("CDP annotations retain abort failures and null bytes, and refuse ambiguous request pairing", () => {
  const cdp = new EventEmitter(), audit = new NativeNetworkAudit(cdp, () => ({ url: "http://local/prefetch", startTime: 1000 }));
  const request = (id) => ({ requestId: id, request: { url: "http://local/prefetch", method: "GET" }, timestamp: 1, wallTime: 1, frameId: "main", loaderId: "old", type: "Fetch" });
  cdp.emit("Network.requestWillBeSent", request("one"));
  cdp.emit("Network.loadingFailed", { requestId: "one", timestamp: 3, canceled: true, errorText: "net::ERR_ABORTED" });
  cdp.emit("Network.requestWillBeSent", { ...request("doc"), request: { url: "http://local/missing?token=SECRET", method: "GET" }, timestamp: 2, wallTime: 2, loaderId: "new", type: "Document" });
  cdp.emit("Network.responseReceived", { requestId: "doc", response: { status: 404 } });
  cdp.emit("Page.frameNavigated", { frame: { id: "main", loaderId: "new", url: "http://local/missing?token=SECRET" } });
  const row = { id: "browser", path: "/prefetch", method: "GET", failure: "net::ERR_ABORTED", completed: false, bytes: null };
  audit.annotate([row]); assert.equal(row.cancellation.classification, "native-document-replacement-cancellation");
  assert.equal(row.failure, "net::ERR_ABORTED"); assert.equal(row.completed, false); assert.equal(row.bytes, null);
  assert.ok(!JSON.stringify(row).includes("SECRET"));
  audit.identity = () => ({ url: "http://local/prefetch", startTime: 1004 });
  audit.annotate([row]); assert.equal(row.cancellation.classification, "native-document-replacement-cancellation");
  audit.identity = () => ({ url: "http://local/prefetch", startTime: 1000 });
  cdp.emit("Network.requestWillBeSent", request("ambiguous")); audit.annotate([row]);
  assert.equal(row.cancellation.classification, "unmatched-native-failure"); assert.equal(row.cancellation.matches, 2);
});

test("completion waits for the observed POST, not an interim semantic change, and never hides failures", async () => {
  const page = new EventEmitter(), network = observeNetwork(page);
  let settled = false;
  const waiting = network.settle(0, performance.now() + 1000, true).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(settled, false);
  const request = { url: () => "http://local/api/marketplace/item_1", method: () => "POST", resourceType: () => "fetch",
    headers: () => ({ "content-type": "application/x-www-form-urlencoded" }), isNavigationRequest: () => false,
    postData: () => "email=a%40b.test&target_price=1.25", failure: () => ({ errorText: "net::ERR_ABORTED" }) };
  page.emit("request", request);
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(settled, false);
  page.emit("requestfailed", request); await waiting;
  assert.equal(network.rows[0].failure, "net::ERR_ABORTED"); assert.equal(network.rows[0].completed, false);
  assert.equal(network.rows[0].bytes, null);
  await assert.rejects(network.settle(1, performance.now() + 10, true), /completion not observed/);
});
