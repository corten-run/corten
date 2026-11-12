import assert from "node:assert/strict";
import test from "node:test";
import { records as marketplaceRecords } from "../marketplace/fixtures.mjs";
import { expectedPage, labels } from "../marketplace/records.mjs";
import { definition, selectedApps } from "./registry.mjs";
import { browserCaptureSchema, createBrowserPlan, validateBrowserCapture } from "./browser.mjs";

const zero = () => ({ subscriptions: 0, connections: 0, listeners: 0, timers: 0, pendingTasks: 0 });
function fixtureRecords() {
  return Object.fromEntries(["item_1", "item_2"].map((id) => [id, {
    id, title: `Card ${id}`, subtitle: null, description: "Numeric fixture", categories: [], badges: [], tags: [], images: [], fields: [],
    summary: { lowest_minor: 125, count: 2, quantity: 3 },
    listings: [125, 250, 375].map((price_minor, i) => ({ id: `listing-${i}`, seller: ["Alice", "Alice two", "Bob"][i],
      rating_hundredths: 425, reviews: 1000, condition: "New", ships_from: "US", quantity: 1, price_minor })),
    offers: Array.from({ length: 6 }, (_, i) => ({ id: `offer-${i}`, buyer: "Buyer", condition: "New", quantity: 1, price_minor: 125 })),
    contents: [{ id: "linked", item_id: id === "item_1" ? "item_2" : "item_1", title: "Linked card", quantity: 1 }], included_in: [],
  }]));
}
const settings = () => ({ profiles: {
  desktop: { viewport: { width: 1280, height: 800 }, network: "unthrottled", cache: "cold", serviceWorker: "blocked" },
  mobile: { viewport: { width: 390, height: 844 }, network: "reviewed-mobile", cache: "cold", serviceWorker: "blocked" },
}, maxCleanupMs: 10, cleanupObservationMs: 5 });
const architectures = { corten: "corten", nextjs: "next-pages", nuxt: "nuxt", "react-router": "react-router", rails: "hotwire",
  laravel: "livewire", sveltekit: "sveltekit", astro: "astro", "tanstack-start": "tanstack-start", leptos: "leptos" };

// Synthetic oracle fixtures only. expectedPage is reused for the existing marketplace
// representation; actions, requests, resources and alert-store effects are built separately.
function makeCapture(app = "laravel") {
  const records = fixtureRecords(), plan = createBrowserPlan({ records }), config = settings();
  let observation = 0, request = 0;
  const capture = { schema: browserCaptureSchema, app, effectivePlan: structuredClone(plan), cases: plan.cases.map((profile) => {
    let at = 0, alerts = [];
    const steps = profile.steps.map((action, index) => {
      const write = Object.hasOwn(action, "input"), missing = action.kind === "missing";
      const components = app === "laravel" && !missing ? ["offers", "price-alert"] : [];
      let message = "";
      if (action.kind.startsWith("invalid-")) message = labels[profile.locale][action.kind.replace("-", "_")];
      if (action.kind === "accepted-write") {
        const values = { email: action.input.email, title: records[action.itemId].title,
          price: new Intl.NumberFormat(profile.locale, { style: "currency", currency: "USD" }).format(Number(action.input.target_price.replace(",", "."))) };
        message = labels[profile.locale].alert_set.replace(/\{(email|title|price)\}/g, (_, key) => values[key]);
        alerts.push({ item_id: action.itemId, email: action.input.email, target_minor: 125 });
      }
      const dom = { id: `dom-${++observation}`, scope: `${profile.key}-page-${index}`, path: action.path,
        page: missing ? null : expectedPage(records[action.itemId], profile.locale, { ...action.query, message }),
        error: missing ? { status: 404, text: "Not found" } : null,
        form: missing ? null : { method: "POST", action: `/marketplace/${profile.locale}/item_2`, fields: ["email", "target_price", "csrf"],
          enhancement: app === "laravel" ? { path: "/livewire/update", transport: "livewire" } : null }, components };
      const transport = !profile.js || index === 0 ? "document" : app === "laravel" && write ? "livewire" : app === "rails" ? "turbo" : "router";
      return { at: ++at, action: structuredClone(action), requests: [{ id: `request-${++request}`, method: write ? "POST" : "GET",
        path: app === "laravel" && profile.js && write ? "/livewire/update" : action.path, status: missing ? 404 : 200, transport, input: write ? structuredClone(action.input) : null,
        components: app === "laravel" && profile.js && write ? ["price-alert"] : components }],
        dom, document: index === 0 ? { ...structuredClone(dom), id: `document-${++observation}` } : null,
        readback: write ? { id: `readback-${++observation}`, via: "independent-read", alerts: structuredClone(alerts) } : null,
        retired: index ? [{ scope: `${profile.key}-page-${index - 1}`, owned: zero() }] : [],
        upstream: { started: profile.source === "api" && !missing ? 1 : 0, completed: profile.source === "api" && !missing ? 1 : 0, cancelled: 0, pending: 0 }, errors: [] };
    });
    return { case: profile.key, outcome: "captured", reason: null, architecture: architectures[app],
      environment: { ...structuredClone(config.profiles[profile.device]), js: profile.js, device: profile.device }, baseline: zero(), steps,
      cleanup: { detachedAt: at + 1, releasedAt: at + 2, probeAt: at + 3, afterAt: at + 8, detached: zero(), afterProbe: zero(),
        probe: { scope: steps.at(-1).dom.scope, kind: "retired-page-event" },
        dom: { ...structuredClone(steps.at(-1).dom), id: `cleanup-dom-${++observation}` }, network: [], errors: [] } };
  }) };
  return { plan, capture, records, settings: config };
}
let saved;
const fixture = () => { saved ??= makeCapture(); return structuredClone(saved); };
const validate = (f, normalizer) => validateBrowserCapture(f.plan, f.capture, f.records, f.settings, normalizer);
const step = (f, kind, js = true) => f.capture.cases.find((c) => c.environment?.js === js).steps.find((s) => s.action.kind === kind);

test("plan follows exact registry JS/device/source/locale matrix with no ready adapter filter", () => {
  const f = fixture(); assert.deepEqual(f.plan.cases.map(({ steps, ...profile }) => profile), definition("fullstack-browser").cases);
  assert.equal(f.plan.cases.length, 24); assert.equal(new Set(f.plan.cases.flatMap((c) => c.steps.map((s) => s.id))).size, 264);
  const reversed = Object.fromEntries(Object.entries(f.records).reverse()); assert.deepEqual(createBrowserPlan({ records: reversed }), f.plan);
  assert.equal(f.plan.policy.timing, "not-specified"); assert.equal(Object.hasOwn(f.plan, "readyForLoad"), false);
});

test("canonical marketplace fixtures produce observable filter/sort and linked journeys", () => {
  const records = marketplaceRecords(), before = structuredClone(records), plan = createBrowserPlan({ records });
  for (const profile of plan.cases) {
    const find = (kind) => profile.steps.find((s) => s.kind === kind);
    const initial = find("initial"), navigate = find("navigate"), filter = find("filter"), sort = find("sort");
    assert.ok(records[initial.itemId].contents.some((line) => line.item_id === navigate.itemId));
    assert.notEqual(initial.itemId, navigate.itemId);
    const record = records[navigate.itemId], page = (query) => expectedPage(record, profile.locale, query);
    assert.ok(filter.query.seller.length > 0);
    assert.ok(page(filter.query).listings.length < page({}).listings.length);
    assert.notDeepEqual(page(filter.query).listings, page(sort.query).listings);
    assert.ok(page(find("show-all").query).offers.length > page(sort.query).offers.length);
  }
  assert.deepEqual(records, before);
  assert.deepEqual(createBrowserPlan({ records: Object.fromEntries(Object.entries(records).reverse()) }), plan);
});

test("pair selection skips a linked item without observable price variation", () => {
  const records = fixtureRecords();
  records.item_3 = { ...structuredClone(records.item_2), id: "item_3" };
  records.item_1.contents.push({ id: "other-link", item_id: "item_3", title: "Other card", quantity: 1 });
  records.item_2.listings.forEach((row) => { row.price_minor = 125; });
  const plan = createBrowserPlan({ records });
  assert.ok(plan.cases.every((c) => c.steps.find((s) => s.kind === "navigate").itemId === "item_3"));
  for (const record of Object.values(records)) record.listings.forEach((row) => { row.price_minor = 125; });
  assert.throws(() => createBrowserPlan({ records }), /browser contract:/);
});

function nextDataCapture() {
  const f = makeCapture("nextjs");
  for (const c of f.capture.cases.filter((c) => c.environment.js)) {
    for (const row of c.steps.filter((row) => ["navigate", "reset", "missing", "return"].includes(row.action.kind))) {
      row.requests[0].path = `/_next/data/build.current-2026${row.action.path}.json`;
    }
  }
  return f;
}

test("Next Pages native data navigation binds to logical destinations without rewriting raw paths", () => {
  const f = nextDataCapture(), before = structuredClone(f.capture), result = validate(f);
  assert.equal(result.functionalPassed, true); assert.equal(result.readyForLoad, false);
  assert.deepEqual(f.capture, before);
  for (const c of f.capture.cases.filter((c) => c.environment.js)) {
    const row = c.steps.find((s) => s.action.kind === "navigate");
    assert.notEqual(row.requests[0].path, row.dom.path);
    assert.equal(row.dom.path, row.action.path);
  }
});

const invalidNextNavigation = {
  "wrong item": (f) => { step(f, "navigate").requests[0].path = step(f, "navigate").requests[0].path.replace("item_2.json", "item_1.json"); },
  "wrong locale": (f) => { step(f, "navigate").requests[0].path = step(f, "navigate").requests[0].path.replace("en-US", "de-DE"); },
  "missing build": (f) => { step(f, "navigate").requests[0].path = `/_next/data/${step(f, "navigate").action.path}.json`; },
  "dot build": (f) => { step(f, "navigate").requests[0].path = `/_next/data/../${step(f, "navigate").action.path.slice(1)}.json`; },
  "extra route segment": (f) => { step(f, "navigate").requests[0].path = step(f, "navigate").requests[0].path.replace("/marketplace/", "/extra/marketplace/"); },
  "wrong extension": (f) => { step(f, "navigate").requests[0].path = step(f, "navigate").requests[0].path.replace(".json", ".html"); },
  "suffix": (f) => { step(f, "navigate").requests[0].path += "/extra"; },
  "document transport": (f) => { step(f, "navigate").requests[0].transport = "document"; },
  "unbound fetch transport": (f) => { step(f, "navigate").requests[0].transport = "fetch"; },
  "App Router architecture": (f) => { f.capture.cases.find((c) => c.environment.js).architecture = "next-app"; },
  "non-Next architecture": (f) => { f.capture.app = "nuxt"; f.capture.cases.forEach((c) => { c.architecture = "nuxt"; }); },
  "no-JS data navigation": (f) => { const row = step(f, "navigate", false); row.requests[0].path = `/_next/data/build${row.action.path}.json`; },
  "initial data instead of HTML": (f) => { const row = step(f, "initial"); row.requests[0].path = `/_next/data/build${row.action.path}.json`; },
  "wrong missing status": (f) => { step(f, "missing").requests[0].status = 200; },
};
for (const [name, mutate] of Object.entries(invalidNextNavigation)) test(`rejects Next Pages ${name}`, () => {
  const f = nextDataCapture(); mutate(f); assert.throws(() => validate(f), /missing native navigation\/error request/);
});

test("Next data transport cannot replace the observed logical DOM route", () => {
  const f = nextDataCapture(), row = step(f, "navigate"); row.dom.path = row.requests[0].path;
  assert.throws(() => validate(f), /wrong visible scope\/route/);
});

test("every native architecture can supply captures, never qualification or timing", () => {
  for (const app of selectedApps("fullstack-browser")) {
    const result = validate(makeCapture(app));
    assert.equal(result.functionalPassed, true); assert.equal(result.readyForLoad, false); assert.equal(result.cases.length, 24);
    assert.ok(result.cases.every((c) => c.observedSteps === 11));
    assert.equal(Object.hasOwn(result, "timingMs"), false);
  }
});

for (const [name, path, status] of [
  ["unrelated failed Turbo request", "/unrelated", 500],
  ["unrelated successful Turbo request", "/unrelated", 200],
  ["failed Turbo destination request", null, 500],
]) test(`Rails document navigation cannot borrow ${name}`, () => {
  const f = makeCapture("rails"), row = step(f, "navigate");
  row.requests[0].transport = "document";
  row.requests.push({ ...structuredClone(row.requests[0]), id: "decoy-turbo", transport: "turbo", path: path ?? row.action.path, status });
  assert.throws(() => validate(f), /browser contract:/);
});

test("unsupported/not-run/failed profiles remain visible, never zero measurements", () => {
  const f = fixture();
  for (const [index, outcome] of ["unsupported", "not-run", "failed"].entries()) Object.assign(f.capture.cases[index], {
    outcome, reason: "Native journey evidence unavailable", architecture: null, environment: null, baseline: null, steps: null, cleanup: null,
  });
  const result = validate(f); assert.equal(result.functionalPassed, false); assert.equal(result.readyForLoad, false);
  assert.deepEqual(result.cases.slice(0, 3).map((r) => r.observedSteps), [null, null, null]);
  assert.deepEqual(result.cases.slice(0, 3).map((r) => r.functionalPassed), [null, null, false]);
  f.capture.cases[0].steps = []; assert.throws(() => validate(f), /browser contract:/);
});

const mutations = {
  "missing profile": (f) => { f.capture.cases.pop(); },
  "duplicate profile": (f) => { f.capture.cases[1] = structuredClone(f.capture.cases[0]); },
  "missing operation": (f) => { f.capture.cases[0].steps.pop(); },
  "duplicate operation": (f) => { f.capture.cases[0].steps[1].action = structuredClone(f.capture.cases[0].steps[0].action); },
  "out-of-order action": (f) => { [f.capture.cases[0].steps[1], f.capture.cases[0].steps[2]] = [f.capture.cases[0].steps[2], f.capture.cases[0].steps[1]]; },
  "manufactured ready flag": (f) => { step(f, "initial").dom = { ready: true }; },
  "SSR-only Livewire label": (f) => { step(f, "accepted-write").requests[0].transport = "document"; },
  "Blade architecture": (f) => { f.capture.cases[0].architecture = "blade"; },
  "LiveView substituted controller": (f) => { f.capture.app = "phoenix"; f.capture.cases[0].architecture = "controller-heex"; },
  "empty Livewire component ledger": (f) => { step(f, "accepted-write").requests[0].components = []; },
  "wrong Livewire component": (f) => { step(f, "accepted-write").requests[0].components = ["unmounted-component"]; },
  "invented enhancement endpoint": (f) => { step(f, "accepted-write").requests[0].path = "/fake-livewire"; },
  "missing native enhancement binding": (f) => { step(f, "reset").dom.form.enhancement = null; },
  "wrong JS mode": (f) => { f.capture.cases[0].environment.js = false; },
  "wrong mobile viewport": (f) => { f.capture.cases.find((c) => c.environment.device === "mobile").environment.viewport.width++; },
  "no-JS fetch": (f) => { step(f, "navigate", false).requests[0].transport = "fetch"; },
  "dead no-JS form": (f) => { step(f, "accepted-write", false).requests = []; },
  "GET substituted for POST": (f) => { step(f, "accepted-write").requests[0].method = "GET"; step(f, "accepted-write").requests[0].input = null; },
  "duplicate POST": (f) => { const s = step(f, "accepted-write"); s.requests.push({ ...structuredClone(s.requests[0]), id: "duplicate-post" }); },
  "wrong POST data": (f) => { step(f, "accepted-write").requests[0].input.email = "other@example.test"; },
  "missing form capture": (f) => { step(f, "reset").dom.form = null; },
  "wrong action path": (f) => { step(f, "accepted-write").requests[0].path = "/fake-action"; },
  "false success/readback": (f) => { step(f, "accepted-write").readback.alerts = []; },
  "rejected write mutated store": (f) => { step(f, "invalid-price").readback.alerts.push({ item_id: "item_2", email: "wrong", target_minor: 1 }); },
  "self-reported readback": (f) => { step(f, "accepted-write").readback.via = "post-response"; },
  "wrong success message": (f) => { step(f, "accepted-write").dom.page.message = "ok"; },
  "missing validation error": (f) => { step(f, "invalid-email").dom.page.message = ""; },
  "static initial shell": (f) => { step(f, "initial").document.page.listings = []; },
  "DOM reused as SSR observation": (f) => { step(f, "initial").document.id = step(f, "initial").dom.id; },
  "wrong listing order": (f) => { step(f, "sort").dom.page.listings.reverse(); },
  "wrong filter": (f) => { step(f, "filter").dom.page.listings.pop(); },
  "duplicate listing": (f) => { const s = step(f, "initial"); s.dom.page.listings.push(structuredClone(s.dom.page.listings[0])); },
  "missing show-all": (f) => { step(f, "show-all").dom.page.offers.pop(); },
  "stale route": (f) => { step(f, "navigate").dom.path = "/marketplace/en-US/item_1"; },
  "missing HTTP error": (f) => { step(f, "missing").requests[0].status = 200; },
  "missing visible error": (f) => { step(f, "missing").dom.error.text = ""; },
  "hidden hydration error": (f) => { step(f, "navigate").errors.push("pageerror"); },
  "missing source work": (f) => { const s = f.capture.cases.find((c) => c.case.startsWith("api-")).steps[0]; s.upstream = { started: 0, completed: 0, cancelled: 0, pending: 0 }; },
  "leaked upstream": (f) => { step(f, "navigate").upstream.pending++; },
  "missing retired subscription accounting": (f) => { step(f, "navigate").retired = []; },
  "cross-page listener leak": (f) => { step(f, "navigate").retired[0].owned.listeners = 1; },
  "resurrected scope": (f) => { step(f, "filter").dom.scope = step(f, "initial").dom.scope; },
  "missing cleanup probe": (f) => { f.capture.cases[0].cleanup.probe = { cleanup: true }; },
  "cleanup resource leak": (f) => { f.capture.cases[0].cleanup.afterProbe.pendingTasks = 1; },
  "cleanup too late": (f) => { f.capture.cases[0].cleanup.releasedAt += 100; },
  "probe before cleanup": (f) => { f.capture.cases[0].cleanup.probeAt = f.capture.cases[0].cleanup.detachedAt; },
  "cleanup observed too soon": (f) => { f.capture.cases[0].cleanup.afterAt--; },
  "post-detach mutation": (f) => { f.capture.cases[0].cleanup.dom.page.title = "late mutation"; },
  "post-detach HTTP": (f) => { f.capture.cases[0].cleanup.network.push({ method: "POST" }); },
  "invented metrics": (f) => { f.capture.timingMs = 0; },
  "changed plan": (f) => { f.plan.cases.pop(); },
};
for (const [name, mutate] of Object.entries(mutations)) test(`rejects ${name}`, () => {
  const f = fixture(); mutate(f); assert.throws(() => validate(f), /browser contract:/);
});

test("normalizer cannot skip cases or mutate saved raw captures", () => {
  const f = fixture(), before = structuredClone(f.capture);
  validate(f, (c) => { c.reason = null; return c; }); assert.deepEqual(f.capture, before);
  assert.throws(() => validate(f, () => null), /browser contract:/);
});

test("missing records/linked workload and unreviewed configuration are refused", () => {
  for (const records of [{}, { item_1: fixtureRecords().item_1 }]) assert.throws(() => createBrowserPlan({ records }), /browser contract:/);
  const f = fixture(); f.settings.maxCleanupMs = 0; assert.throws(() => validate(f), /browser contract:/);
});
