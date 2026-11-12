// Harness unit tests, not application captures or evidence of native parity.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { candidates, emptyCells, parseOptions, publicURL, publicInput, publishPort, transportOf, validateTargets, nativeFailures, alertsFromReadback } from "./contract.mjs";
import { createBrowserPlan } from "../workloads/browser.mjs";
import { records } from "../marketplace/fixtures.mjs";
import { createUpstream, upstreamDelta } from "./upstream.mjs";
import { observeNetwork, architecture, classifyDisabledPreloads } from "./observe.mjs";
import { readStore, waitForSemanticChange } from "./journey.mjs";
import { imageEvidence } from "./run.mjs";
import { nativeBuildArgs } from "./build.mjs";
import { navigationDestination, normalizeSvelteKitCase } from "./navigation.mjs";
import { missingAction } from "./probes.mjs";

const req = (options = {}) => ({ method: () => "GET", headers: () => ({}), isNavigationRequest: () => false,
  url: () => "http://127.0.0.1/marketplace/en-US/item_2", resourceType: () => "fetch", postData: () => "", ...options });
const plan = createBrowserPlan({ records: records() });
test("SvelteKit native data normalization requires successful physical framework payload and transport", () => {
  const request = { id: "observed", method: "GET", path: "/marketplace/fr-FR/item_2/__data.json", status: 200, transport: "router", input: null, components: [],
    resource: "fetch", type: "application/json", nativeData: { framework: "sveltekit", type: "data", nodes: [null, "data"] } };
  const env = { app: "sveltekit", architecture: "sveltekit", js: true };
  assert.equal(navigationDestination(request, env), "/marketplace/fr-FR/item_2");
  for (const change of [{ status: 404 }, { failure: "aborted" }, { transport: "document" }, { resource: "script" }, { type: "text/html" }, { nativeData: null }, { nativeData: { framework: "sveltekit", type: "redirect", nodes: ["data"] } }]) {
    assert.equal(navigationDestination({ ...request, ...change }, env), request.path);
  }
  assert.equal(navigationDestination(request, { ...env, js: false }), request.path);
  assert.equal(navigationDestination(request, { ...env, app: "nextjs" }), request.path);
  const raw = { architecture: "sveltekit", environment: { js: true }, steps: [{ requests: [request] }] };
  const normalized = normalizeSvelteKitCase(structuredClone(raw));
  assert.equal(normalized.steps[0].requests[0].path, "/marketplace/fr-FR/item_2");
  assert.equal(raw.steps[0].requests[0].path, "/marketplace/fr-FR/item_2/__data.json");
  assert.deepEqual(Object.keys(normalized.steps[0].requests[0]).sort(), ["id", "method", "path", "status", "transport", "input", "components"].sort());
  assert.equal(missingAction("/api/marketplace/item_2", "item_2"), "/api/marketplace/item_missing");
  assert.equal(missingAction("/marketplace/fr-FR/item_1", "item_1"), "/marketplace/fr-FR/item_missing");
  assert.throws(() => missingAction("/unrelated/item_2", "item_2"));
});
test("semantic observer preserves document replacement and does not swallow other errors", async () => {
  const transitions = []; let samples = 0;
  await waitForSemanticChange({ evaluate: async () => {
    if (samples++ === 0) throw new Error("Execution context was destroyed, most likely because of a navigation");
    return "new native document";
  } }, "old native document", transitions);
  assert.equal(samples, 2); assert.equal(transitions.length, 1);
  assert.match(transitions[0].error, /Execution context was destroyed/);
  await assert.rejects(waitForSemanticChange({ evaluate: async () => { throw new Error("actual observer failure"); } }, "before"), /actual observer failure/);
});
test("full registry matrix and retained contenders, independent of selected targets", () => {
  const cells = emptyCells(plan);
  assert.equal(candidates.length, 10); assert.equal(plan.cases.length, 24);
  assert.equal(Object.values(cells).flat().length, 240);
  for (const app of ["laravel", "rails", "react-router", "leptos"]) assert.equal(cells[app].length, 24);
  assert.ok(Object.values(cells).flat().every((v) => v.outcome === "not-run" && v.evidence === null && v.qualificationPassed === false));
});
test("explicit round/options fail closed without dropping candidates", () => {
  const options = parseOptions(["w1", "--targets", "targets.json", "--out", "work/w1", "--apps", "nextjs,laravel"]);
  assert.equal(options.round, "w1"); assert.deepEqual(options.apps, ["nextjs", "laravel"]);
  assert.equal(parseOptions(["w2", "--build", "--out", "work/w2"]).build, true);
  for (const args of [["r20"], [], ["w1", "--targets", "a", "--targets", "b"], ["w1", "--targets", "a", "--out", "b", "--apps", "phoenix"]]) assert.throws(() => parseOptions(args));
});
test("build workflow uses all approved native Dockerfiles and honest source labels", () => {
  for (const app of candidates) {
    const build = nativeBuildArgs({ app, repo: "/checkout", task: "browser-abcd", commit: "commit", dirty: true, snapshot: "digest" });
    assert.equal(build.tag, `browser-abcd-${app}`);
    assert.ok(build.args.includes("agent.owner=codex"));
    assert.ok(build.args.includes("run.corten.browser.dirty=true"));
    if (app === "corten") assert.equal(build.context, "/checkout");
    if (app === "sveltekit") assert.match(build.dockerfile, /Dockerfile.marketplace$/);
    assert.ok(!build.args.includes("PROFILE=matched"), "do not silently substitute architecture/profile");
  }
  assert.equal(publishPort("sveltekit"), "127.0.0.1:8080:8080");
  assert.equal(publishPort("nextjs"), "127.0.0.1::8080");
});
test("target manifest cannot substitute endpoints or arbitrary environment", () => {
  const manifest = { schema: "native-fullstack-browser-targets/v1", targets: { nextjs: { image: "cb-marketplace-nextjs" } } };
  assert.equal(validateTargets(manifest).nextjs.image, "cb-marketplace-nextjs");
  for (const readback of [{ path: "//remote/store" }, { path: "/marketplace/en-US/item_1" }, { path: "/store?token=secret" }]) assert.throws(() => validateTargets({ ...manifest, targets: { nextjs: { ...manifest.targets.nextjs, readback } } }));
  assert.throws(() => validateTargets({ ...manifest, targets: { nextjs: { ...manifest.targets.nextjs, environment: {} } } }));
});
test("public ledger strips tokens, request headers, and unknown query fields", () => {
  assert.deepEqual(publicURL("http://local/marketplace/en-US/item_1?seller=Alice&token=SECRET&sort=desc"), { path: "/marketplace/en-US/item_1", query: { seller: "Alice", sort: "desc" } });
  const r = req({ method: () => "POST", headers: () => ({ "content-type": "application/x-www-form-urlencoded", cookie: "SECRET" }), postData: () => "email=a%40b.test&target_price=1.25&_token=SECRET" });
  assert.deepEqual(publicInput(r), { input: { email: "a@b.test", target_price: "1.25" }, components: [] });
  assert.ok(!JSON.stringify(publicInput(r)).includes("SECRET"));
});
test("native transport uses observed request signals, never the framework label", () => {
  assert.equal(transportOf(req({ isNavigationRequest: () => true })), "document");
  assert.equal(transportOf(req({ headers: () => ({ "x-livewire": "" }) })), "livewire");
  assert.equal(transportOf(req({ headers: () => ({ "x-turbo-request-id": "abc" }) })), "turbo");
  assert.equal(transportOf(req({ url: () => "http://local/_next/data/build/marketplace/en-US/item_2.json" })), "router");
  const input = publicInput(req({ method: () => "POST", headers: () => ({ "x-livewire": "", "content-type": "application/json" }),
    postData: () => JSON.stringify({ components: [{ snapshot: JSON.stringify({ memo: { id: "component-a" }, data: { email: "a@b.test", target_price: "1.25", token: "SECRET" } }), updates: { target_price: "0" } }] }) }));
  assert.deepEqual(input, { input: { email: "a@b.test", target_price: "0" }, components: ["component-a"] });
});
test("Blade and controller substitutions cannot qualify Livewire/Hotwire", () => {
  const steps = [{ dom: { native: { components: [], form: { binding: null }, turbo: false } }, action: { kind: "initial" }, requests: [] },
    { action: { kind: "accepted-write", input: {} }, requests: [{ method: "POST", transport: "document", components: [] }] }];
  assert.match(nativeFailures("laravel", { js: true }, steps).join(" "), /Blade is not Livewire/);
  assert.match(nativeFailures("rails", { js: true }, steps).join(" "), /controller document fallback/);
  assert.equal(architecture("laravel", steps[0].dom.native), "blade");
  assert.equal(architecture("rails", steps[0].dom.native), "rails-controller");
  steps[0].dom.native.turbo = true; steps[0].dom.native.turboDisabled = true;
  assert.equal(architecture("rails", steps[0].dom.native), "rails-controller");
  steps[1].requests.push({ method: "POST", transport: "turbo", path: "/unrelated", status: 200 });
  assert.match(nativeFailures("rails", { js: true }, steps).join(" "), /controller document fallback/);
});
test("source commit is not guessed from an image tag or current checkout", () => {
  const image = { Id: "sha256:immutable", RepoDigests: [], Config: { Labels: {} } };
  assert.equal(imageEvidence(image, "commit").imageSourceVerified, false);
  assert.equal(imageEvidence(image, "commit").builtCommit, null);
  image.Config.Labels = { "run.corten.marketplace.commit": "commit", "run.corten.marketplace.dirty": "false" };
  assert.equal(imageEvidence(image, "commit").imageSourceVerified, true);
  assert.equal(imageEvidence(image, "different").imageSourceVerified, false);
});
test("network observer saves measured encoded/decoded bytes and sanitized native inputs", async () => {
  const page = new EventEmitter(), ledger = observeNetwork(page);
  const response = { status: () => 200, headers: () => ({ "content-type": "text/html", "content-encoding": "gzip", "set-cookie": "SECRET" }), body: async () => Buffer.from("actual response") };
  const r = req({ method: () => "POST", isNavigationRequest: () => true,
    headers: () => ({ "content-type": "application/x-www-form-urlencoded" }), postData: () => "email=a%40b.test&target_price=1.25&csrf=SECRET",
    response: async () => response, sizes: async () => ({ responseBodySize: 12, responseHeadersSize: 80 }) });
  response.request = () => r;
  page.emit("request", r); page.emit("response", response); page.emit("requestfinished", r); await ledger.drain();
  assert.deepEqual(ledger.rows[0].bytes, { encodedBody: 12, headers: 80, decodedBody: 15 });
  assert.equal(ledger.rows[0].status, 200); assert.deepEqual(ledger.failures, []);
  assert.ok(!JSON.stringify(ledger.rows).includes("SECRET"));
});
test("uses existing strict no-JS preload classification, retaining CSP/request evidence", () => {
  const rows = [{ path: "/page", resource: "document", hasCsp: false }, { path: "/entry.js", resource: "script", failure: "csp", status: null }];
  const dom = { native: { hasMetaCsp: false, preloads: [{ path: "/entry.js", rel: "modulepreload", as: "" }] } };
  classifyDisabledPreloads(rows, dom, false); assert.equal(rows[1].intentionallyDisabledPreload, true);
  assert.equal(rows[1].failure, "csp"); assert.equal(rows[1].status, null);
  classifyDisabledPreloads(rows, dom, true); assert.equal(rows[1].intentionallyDisabledPreload, false);
  rows[0].hasCsp = true;
  classifyDisabledPreloads(rows, dom, false); assert.equal(rows[1].intentionallyDisabledPreload, false);
});
test("multipart native input is parsed without exposing hidden tokens", async () => {
  const page = new EventEmitter(), ledger = observeNetwork(page);
  const f = new FormData(); f.set("email", "a@b.test"); f.set("target_price", "1,25"); f.set("csrf", "SECRET");
  const wire = new Request("http://local/", { method: "POST", body: f }); const body = Buffer.from(await wire.arrayBuffer());
  page.emit("request", req({ method: () => "POST", headers: () => ({ "content-type": wire.headers.get("content-type") }), postDataBuffer: () => body }));
  await ledger.drain(); assert.deepEqual(ledger.rows[0].input, { email: "a@b.test", target_price: "1,25" });
  assert.ok(!JSON.stringify(ledger.rows).includes("SECRET"));
});
async function listening(server, work) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try { return await work(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}
test("independent upstream counts actual completed reads including 404s", async () => {
  await listening(createUpstream({ item_1: { id: "item_1", numeric: 125 } }), async (base) => {
    const counters = async () => (await fetch(base + "/__browser/counters")).json(); const before = await counters();
    assert.deepEqual(await (await fetch(base + "/marketplace/records/item_1")).json(), { id: "item_1", numeric: 125 });
    assert.equal((await fetch(base + "/marketplace/records/item_missing")).status, 404);
    const delta = upstreamDelta(before, await counters()); assert.equal(delta.started, 2); assert.equal(delta.completed, 2); assert.equal(delta.pending, 0);
  });
});
test("readback reads an independent store and refuses message-shaped success", async () => {
  let store = [];
  const server = createServer((_, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ alerts: store })); });
  const api = { get: async (url) => { const r = await fetch(url); return { status: () => r.status, headers: () => Object.fromEntries(r.headers), json: () => r.json() }; } };
  await listening(server, async (base) => {
    assert.deepEqual((await readStore(base, { path: "/store" }, api)).alerts, []);
    store = [{ item_id: "item_2", email: "a@b.test", target_minor: 125 }];
    assert.deepEqual((await readStore(base, { path: "/store" }, api)).alerts, store);
  });
  assert.equal((await readStore("http://127.0.0.1", null)).outcome, "unsupported");
  assert.throws(() => alertsFromReadback({ message: "Alert set" }));
  assert.deepEqual(alertsFromReadback(store), store);
  await assert.rejects(readStore("http://127.0.0.1", { path: "/store" }), /cookie jar/);
  assert.throws(() => alertsFromReadback({ alerts: [{ item_id: "item_2", email: "a@b.test", target_minor: 125, csrf: "SECRET" }] }));
});
