import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { sources as marketplaceSources } from "../catalog/contract.mjs";
import { locales as marketplaceLocales } from "../marketplace/contract.mjs";
import { expectedPage, labels } from "../marketplace/records.mjs";
import { bindNativeForm, categories, createPlan, locales, outcomes, planSchema, responseStatuses, resultSchema, sources, validateResults, workload } from "./mixed.mjs";

// Small numeric marketplace records, not a frozen adapter inventory or deployment profile.
function fixture() {
  return Object.fromEntries(["item_1", "item_2", "item_3", "item_500"].map((id) => [id, {
    id, title: `Card ${id}`, subtitle: null, description: "A numeric marketplace test record.",
    categories: [], badges: [], tags: [], images: [], fields: [],
    summary: { lowest_minor: 125, count: 1000, quantity: 2 },
    listings: id === "item_500" ? [] : [null, 125, 125, 10].map((price_minor, i) => ({
      id: `listing_${i}`, seller: ["Alice", "Alice second", "alice", "Bob"][i], rating_hundredths: i ? 425 : null,
      reviews: 1000, condition: "Near Mint", ships_from: "US", quantity: i + 1, price_minor,
    })),
    offers: Array.from({ length: 6 }, (_, i) => ({ id: `offer_${i}`, buyer: "Buyer", condition: "Near Mint", quantity: 1, price_minor: 125 })),
    contents: [{ id: "line_1", item_id: "item_2", title: "Linked card", quantity: 2 }], included_in: [],
  }]));
}
const options = (changes = {}) => ({ seed: 7, clients: 2, repetitions: 1, records: fixture(), ...changes });

function nativeForm(request, changes = {}) {
  return { client: request.client, source: request.source, locale: request.locale, itemId: request.itemId,
    method: "POST", action: request.formPage, contentType: "application/x-www-form-urlencoded", fields: ["csrf", "email", "target_price"],
    transport: { hidden: { csrf: "DO-NOT-LOG-TOKEN" }, cookie: "DO-NOT-LOG-SESSION" }, ...changes };
}

// Synthetic independent captures exercise contract semantics, never adapter readiness.
function captureFor(plan, records) {
  const states = new Map();
  return { schema: resultSchema, workload, app: "unregistered-native-app", effectivePlan: structuredClone(plan),
    results: plan.requests.map((request) => {
      const write = request.method === "POST", slow = request.category === "slow", record = records[request.itemId];
      const outcome = request.category === "rejected-write" ? "rejected" : slow
        ? { complete: "completed", deadline: "deadline", cancel: "cancelled" }[request.variant] : "completed";
      const row = { request: structuredClone(request), outcome, status: outcome === "cancelled" ? 0 : outcome === "deadline" ? 503 : 200,
        contentType: outcome === "cancelled" ? null : request.accept, contentEncoding: outcome === "cancelled" ? null : "gzip",
        error: outcome === "cancelled" ? "cancelled" : null,
        upstream: { requests: request.source === "api" ? 1 : 0, completed: request.source === "api" && !["cancelled", "deadline"].includes(outcome) ? 1 : 0,
          cancelled: ["cancelled", "deadline"].includes(outcome) ? 1 : 0, pending: 0,
          path: request.source === "api" ? `/marketplace/records/${encodeURIComponent(request.itemId)}` : null, mode: slow ? request.variant : "normal" },
        page: null, record: null, form: null, state: null };
      let message = "";
      if (write) {
        const binding = bindNativeForm(request, nativeForm(request));
        row.form = binding.evidence;
        const key = `${request.source}:${request.client}`, before = structuredClone(states.get(key) ?? []);
        const after = request.category === "accepted-write" ? [...before, { item_id: request.itemId, email: request.input.email, target_minor: request.targetMinor }] : before;
        row.state = { before, after: structuredClone(after), readback: { via: "independent-read", alerts: structuredClone(after) } };
        states.set(key, after);
        if (request.category === "rejected-write") message = labels[request.locale][request.variant];
        else {
          // Independent conversion of the submitted locale decimal, not targetMinor's oracle.
          const target = Number(request.input.target_price.replace(",", "."));
          const price = new Intl.NumberFormat(request.locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(target);
          const values = { email: request.input.email, title: record.title, price };
          message = labels[request.locale].alert_set.split(/(\{email\}|\{title\}|\{price\})/).map((part) => values[part.slice(1, -1)] ?? part).join("");
        }
      }
      if (request.category === "json") row.record = structuredClone(record);
      else if (["completed", "rejected"].includes(outcome)) row.page = expectedPage(record, request.locale, { ...(request.query ?? {}), message });
      return row;
    }) };
}
let baseline;
function setup(changes) {
  // Mutation tests clone one bounded capture, not thousands of new Intl formatters per case.
  if (changes === undefined) {
    baseline ??= setup({});
    return structuredClone(baseline);
  }
  const input = options(changes), plan = createPlan(input);
  return { input, plan, capture: captureFor(plan, input.records) };
}
const find = (capture, category, variant) => capture.results.find((r) => r.request.category === category && (variant === undefined || r.request.variant === variant));
const validate = ({ plan, capture, input }) => validateResults(plan, capture, input.records);

test("seeded plan covers every category, source, locale and variant without a load profile", () => {
  const { plan, input } = setup();
  assert.equal(plan.schema, planSchema);
  assert.equal(plan.marketplaceWorkload, "marketplace-v2");
  assert.deepEqual(sources, marketplaceSources);
  assert.deepEqual(locales, marketplaceLocales);
  assert.deepEqual(plan.counts, { page: 6, json: 2, listings: 18, "accepted-write": 6, "rejected-write": 12, slow: 9 });
  assert.equal(plan.requests.length, 53);
  for (const source of sources) for (const locale of locales) {
    for (const category of categories.filter((c) => c !== "json" && (c !== "slow" || source === "api"))) {
      assert.ok(plan.requests.some((r) => r.source === source && r.locale === locale && r.category === category));
    }
  }
  for (const request of plan.requests) {
    assert.equal(request.acceptEncoding, "br, gzip");
    assert.ok(Object.hasOwn(input.records, request.itemId));
    if (request.category === "json") {
      assert.equal(request.locale, null);
      assert.equal(request.path, `/api/marketplace/${request.itemId}`);
    } else assert.match(request.formPage ?? request.path, /^\/marketplace\/(en-US|fr-FR|de-DE)\/item_/);
    if (request.method === "POST") assert.equal(request.path, null, "the adapter discovers the native POST action");
    if (request.category === "slow") {
      assert.equal(request.source, "api");
      assert.deepEqual(request.upstream, { path: `/marketplace/records/${request.itemId}`, mode: request.variant });
    }
    if (request.method === "POST") {
      assert.equal(request.input.target_price.includes(","), request.locale !== "en-US" && request.variant !== "invalid_price");
    }
  }
  assert.equal(plan.policy.effectivePlan, "save-with-results");
  assert.equal(plan.policy.timing, "not-specified");
  for (const name of ["duration", "rate", "cloud", "profile", "inventory"]) assert.equal(Object.hasOwn(plan, name), false);
});

test("schedule is stable across serialization, record property order and runs, but seed-sensitive", () => {
  const input = options(), first = createPlan(input);
  assert.deepEqual(createPlan(input), first);
  assert.deepEqual(createPlan(JSON.parse(JSON.stringify(input))), first);
  const reversed = Object.fromEntries(Object.entries(input.records).reverse().map(([id, record]) => [id, Object.fromEntries(Object.entries(record).reverse())]));
  assert.deepEqual(createPlan({ ...input, records: reversed }), first);
  assert.notDeepEqual(createPlan({ ...input, seed: 8 }).requests, first.requests);
  const twice = createPlan({ ...input, repetitions: 2 });
  assert.deepEqual(twice.requests.slice(0, 53), first.requests);
  for (const category of categories) assert.equal(twice.counts[category], first.counts[category] * 2);
  assert.equal(new Set(twice.requests.map((r) => r.id)).size, twice.requests.length);
  // Pin the PRNG/schedule semantics; a change requires an explicit contract-version decision.
  assert.deepEqual(first.requests.slice(0, 5).map(({ category, source, locale, itemId, variant }) => [category, source, locale, itemId, variant]), [
    ["listings", "fixture", "de-DE", "item_3", "prefix"],
    ["accepted-write", "api", "de-DE", "item_2", null],
    ["listings", "api", "de-DE", "item_2", "desc"],
    ["page", "fixture", "en-US", "item_1", null],
    ["listings", "fixture", "en-US", "item_2", "prefix"],
  ]);
});

test("current numeric schema and fixture contents are fingerprinted, not a fixed item count", () => {
  const input = options(), plan = createPlan(input);
  input.records.item_1.title = "Changed title";
  assert.notEqual(createPlan(input).recordsSha256, plan.recordsSha256);
  assert.notEqual(createPlan(input).sha256, plan.sha256);
  const reduced = { item_1: structuredClone(input.records.item_1) };
  reduced.item_1.contents = [];
  reduced.item_1.included_in = [];
  assert.ok(createPlan(options({ records: reduced })).requests.every((r) => r.itemId === "item_1"));
  for (const mutate of [(o) => { o.records = {}; }, (o) => { o.records.item_1.summary.count = -1; },
    (o) => { delete o.records.item_1.title; }, (o) => { o.records.item_1.extra = true; },
    (o) => { o.records.item_1.contents[0].item_id = "item_missing"; },
    (o) => { for (const r of Object.values(o.records)) r.listings = []; }]) {
    const bad = options(); mutate(bad); assert.throws(() => createPlan(bad), /mixed contract:/);
  }
});

test("invalid settings are refused rather than replaced with defaults", () => {
  for (const change of [{ seed: -1 }, { seed: 2 ** 32 }, { seed: 1.5 }, { clients: 0 }, { clients: "2" },
    { repetitions: 0 }, { repetitions: NaN }, { rate: 150 }, { duration: "60s" }]) {
    assert.throws(() => createPlan(options(change)), /mixed contract:/);
  }
  for (const field of ["seed", "clients", "repetitions", "records"]) {
    const input = options(); delete input[field]; assert.throws(() => createPlan(input), /mixed contract:/);
  }
});

test("native form transport stays opaque, per-client, in memory and redacted", () => {
  const { plan } = setup(), request = plan.requests.find((r) => r.method === "POST");
  const captured = nativeForm(request), binding = bindNativeForm(request, captured);
  assert.equal(binding.transport, captured.transport);
  assert.deepEqual(binding.input, request.input);
  assert.equal(binding.evidence.method, "POST");
  assert.deepEqual(JSON.parse(JSON.stringify(binding)), binding.evidence);
  for (const serialized of [JSON.stringify(binding), inspect(binding), JSON.stringify(plan)]) {
    assert.ok(!serialized.includes("DO-NOT-LOG"));
    assert.ok(!serialized.includes("csrf"));
  }
  for (const change of [{ client: request.client + 1 }, { locale: "xx" }, { source: "wrong" }, { itemId: "item_999" },
    { method: "GET" }, { action: "//foreign.example/alert" }, { action: "https://foreign.example/alert" },
    { action: "/alert?token=DO-NOT-LOG" }, { action: "/alert\\bad" }, { action: "/alert#bad" },
    { contentType: "application/json" }, { fields: ["email"] }, { transport: null }]) {
    assert.throws(() => bindNativeForm(request, nativeForm(request, change)), /mixed contract:/);
  }
  assert.throws(() => bindNativeForm(request, null), /mixed contract:/);
  assert.throws(() => bindNativeForm(plan.requests.find((r) => r.method === "GET"), captured), /write request required/);
  assert.throws(() => bindNativeForm(request, { ...captured, token: "DO-NOT-LOG" }), (error) => !inspect(error).includes("DO-NOT-LOG"));
  assert.equal(bindNativeForm(request, nativeForm(request, { contentType: "multipart/form-data" })).evidence.contentType, "multipart/form-data");
});

test("complete semantic evidence passes without certifying any native adapter or measurement", () => {
  const data = setup(), result = validate(data);
  assert.equal(result.functionalPassed, true);
  assert.equal(result.readyForLoad, false);
  assert.equal(result.app, "unregistered-native-app");
  for (const category of categories) {
    const count = result.categories[category];
    assert.equal(count.planned, data.plan.counts[category]);
    assert.equal(count.attempted, count.planned);
    assert.equal(count.succeeded, count.planned);
    assert.equal(count.failed, 0);
    assert.equal(Object.values(count.outcomes).reduce((a, b) => a + b, 0), count.planned);
    assert.equal(Object.values(count.statuses).reduce((a, b) => a + b, 0), count.planned);
  }
  assert.equal(result.categories["rejected-write"].outcomes.rejected, 12);
  assert.equal(result.categories.slow.outcomes.deadline, 3);
  assert.equal(result.categories.slow.outcomes.cancelled, 3);
  assert.equal(result.categories.slow.usefulCompletions, 3, "expected cancellations/deadlines are not useful responses");
  assert.equal(result.categories["accepted-write"].usefulCompletions, 6);
  data.capture.results.reverse();
  assert.deepEqual(validate(data), result, "artifact row order is not execution order");
  assert.ok(!JSON.stringify(result).includes("DO-NOT-LOG"));
});

test("missing, duplicated, mismatched or corrupted effective-plan and request evidence fails closed", () => {
  const mutations = [(c) => { delete c.effectivePlan; }, (c) => { c.schema = "mixed-results/v0"; }, (c) => { c.workload = "legacy-mixed"; },
    (c) => { c.app = ""; }, (c) => { c.effectivePlan.seed++; }, (c) => { c.effectivePlan.counts.page--; },
    (c) => { c.effectivePlan.requests.reverse(); }, (c) => { c.results.pop(); }, (c) => { c.results.push(c.results[0]); },
    (c) => { c.results[0] = c.results[1]; }, (c) => { c.results[0].request.path = "/items/item_1"; },
    (c) => { c.results[0].request.source = "cache"; }, (c) => { c.results[0].outcome = "ok"; },
    (c) => { c.results[0].status = NaN; }, (c) => { c.results[0].error = "token leak"; },
    (c) => { c.results[0].contentEncoding = "unknown"; }, (c) => { c.results[0].rawToken = "DO-NOT-LOG"; }];
  for (const mutate of mutations) {
    const data = setup(); mutate(data.capture); assert.throws(() => validate(data), /mixed contract:/);
  }
  for (const mutate of [(p) => { p.sha256 = "0".repeat(64); }, (p) => { p.requests.pop(); }, (p) => { p.policy.retries = "retry"; }]) {
    const data = setup(); mutate(data.plan); assert.throws(() => validate(data), /effective plan/);
  }
});

test("native forms and actual POST evidence cannot be missing or substituted with GET", () => {
  for (const mutate of [(r) => { r.form = null; }, (r) => { r.request.method = "GET"; }, (r) => { r.form.method = "GET"; },
    (r) => { r.form.action = "//foreign.example/"; }, (r) => { r.form.client++; }, (r) => { r.form.input.target_price = "1"; },
    (r) => { r.form.fields = []; }, (r) => { r.form.transport = { csrf: "DO-NOT-LOG" }; }, (r) => { r.state = null; }]) {
    const data = setup(); mutate(find(data.capture, "accepted-write")); assert.throws(() => validate(data), /mixed contract:/);
  }
});

test("false-success writes, rejected mutations, stale reads, replay and cross-client state fail", () => {
  for (const mutate of [(r) => { r.state.after = r.state.before; }, (r) => { r.state.readback.alerts = r.state.before; },
    (r) => { r.state.after.at(-1).target_minor++; }, (r) => { r.state.after.at(-1).email = "other@example.test"; },
    (r) => { r.state.readback.via = "post-echo"; }, (r) => { r.state.after.push(r.state.after.at(-1)); },
    (r) => { r.state.before.push({ item_id: "item_1", email: "stranger@example.test", target_minor: 1 }); }]) {
    const data = setup(); mutate(find(data.capture, "accepted-write")); assert.throws(() => validate(data), /mixed contract:/);
  }
  const rejected = setup(), row = find(rejected.capture, "rejected-write");
  row.state.after.push({ item_id: row.request.itemId, email: "should-not-save@example.test", target_minor: 100 });
  assert.throws(() => validate(rejected), /write effect/);
  const replay = setup({ repetitions: 2 });
  const writes = replay.capture.results.filter((r) => r.request.method === "POST" && r.request.client === 0 && r.request.source === "api");
  writes.at(-1).state.before = writes[0].state.before;
  assert.throws(() => validate(replay), /stale/);
});

test("wrong localized pages, JSON schema, sorting, prefix, offer expansion and messages fail", () => {
  for (const [category, variant, mutate] of [
    ["page", undefined, (r) => { r.page.locale = "xx"; }],
    ["page", undefined, (r) => { r.page.summary = ["cached English summary"]; }],
    ["json", undefined, (r) => { r.record.listings[0].price_minor = "$1.00"; }],
    ["json", undefined, (r) => { r.record.extra = undefined; }],
    ["json", undefined, (r) => { delete r.record.description; }],
    ["json", undefined, (r) => { r.contentType = "text/html"; }],
    ["listings", "desc", (r) => { r.page.listings.reverse(); }],
    ["listings", "prefix", (r) => { r.page.listings = []; }],
    ["listings", "prefix", (r) => { r.page.offers = r.page.offers.slice(0, 5); }],
    ["accepted-write", undefined, (r) => { r.page.message = "success"; }],
    ["rejected-write", "invalid_email", (r) => { r.page.message = ""; }],
    ["rejected-write", "invalid_price", (r) => { r.page.message = "alert saved"; }],
  ]) {
    const data = setup(); mutate(find(data.capture, category, variant)); assert.throws(() => validate(data), /mixed contract:/);
  }
});

test("localized success messages preserve data that resembles template/replacement syntax", () => {
  const input = options();
  for (const record of Object.values(input.records)) record.title = "Data $& {price} {email} $'";
  const plan = createPlan(input), capture = captureFor(plan, input.records);
  assert.equal(validateResults(plan, capture, input.records).functionalPassed, true);
  for (const row of capture.results.filter((r) => r.request.category === "accepted-write")) {
    assert.ok(row.page.message.includes("Data $& {price} {email} $'"));
  }
});

test("API work is fetched once and slow/cancelled work is accounted and cleaned up", () => {
  for (const mutate of [(r) => { r.upstream = null; }, (r) => { r.upstream.requests = 2; }, (r) => { r.upstream.pending = 1; },
    (r) => { r.upstream.cancelled = 0; }, (r) => { r.upstream.completed = 1; r.upstream.cancelled = 0; },
    (r) => { r.upstream.path = "/wrong"; }, (r) => { r.upstream.mode = "normal"; },
    (r) => { r.status = 200; }, (r) => { r.error = "timeout"; }]) {
    const data = setup(); mutate(find(data.capture, "slow", "cancel")); assert.throws(() => validate(data), /mixed contract:/);
  }
  for (const category of ["page", "json", "listings"]) {
    const data = setup(), row = data.capture.results.find((r) => r.request.category === category && r.request.source === "api");
    row.upstream.requests = row.upstream.completed = 0;
    row.upstream.path = null;
    assert.throws(() => validate(data), /fetch count/);
  }
  const data = setup(), row = data.capture.results.find((r) => r.request.source === "fixture");
  row.upstream.requests = row.upstream.completed = 1;
  // Keep the fixture's path/mode valid to isolate its forbidden upstream fetch count.
  row.upstream.path = null;
  assert.throws(() => validate(data), /fetch count/);
});

test("native action routes, rejection statuses, deadlines and redirect responses preserve semantics", () => {
  const data = setup();
  for (const row of data.capture.results) {
    if (row.form) {
      const request = row.request;
      for (const action of [request.formPage, `${request.formPage}/alert`, "/alert"]) {
        const binding = bindNativeForm(request, nativeForm(request, { action }));
        assert.equal(binding.evidence.action, action);
        row.form = binding.evidence;
      }
    }
    if (row.outcome === "rejected") row.status = 422;
    if (row.outcome === "deadline") row.status = 504;
    if (row.request.category === "accepted-write") {
      row.status = 303;
      row.contentType = row.contentEncoding = null;
      if (row.request.source === "api") row.upstream.requests = row.upstream.completed = 2;
    }
  }
  assert.equal(validate(data).functionalPassed, true);
  assert.deepEqual(responseStatuses.rejected, [200, 302, 303, 400, 422]);
  assert.deepEqual(responseStatuses.deadline, [408, 503, 504]);
  find(data.capture, "page").status = 303;
  assert.throws(() => validate(data), /successful read status/);
});

test("rejected write redirects preserve validation, unchanged state and independent readback", () => {
  for (const status of [302, 303]) for (const emptyResponse of [false, true]) {
    const data = setup();
    for (const row of data.capture.results.filter((r) => r.request.category === "rejected-write")) {
      row.status = status;
      if (emptyResponse) row.contentType = row.contentEncoding = null;
      if (row.request.source === "api") row.upstream.requests = row.upstream.completed = 2;
    }
    const result = validate(data), count = result.categories["rejected-write"];
    assert.equal(result.functionalPassed, true);
    assert.equal(result.readyForLoad, false);
    assert.equal(count.succeeded, count.planned);
    assert.equal(count.failed, 0);
    assert.equal(count.outcomes.rejected, count.planned);
    assert.equal(count.statuses[status], count.planned);
  }
});

test("rejected write redirects cannot replace validation, native form or unchanged independent state proof", () => {
  const mutations = [
    [(r) => { r.page = null; }, /localized page\/listings\/message differs/],
    [(r) => { r.page.message = ""; }, /localized page\/listings\/message differs/],
    [(r) => { r.page.message = "alert saved"; }, /localized page\/listings\/message differs/],
    [(r) => { r.form = null; }, /native form\/write evidence/],
    [(r) => { r.state = null; }, /missing or unexpected fields/],
    [(r) => { delete r.state.readback; }, /missing or unexpected fields/],
    [(r) => { r.state.readback.via = "post-echo"; }, /independent write readback required/],
    [(r) => { r.state.after.push({ item_id: r.request.itemId, email: "unexpected@example.test", target_minor: 1 }); }, /write effect\/readback differs/],
    [(r) => { r.state.readback.alerts.push({ item_id: r.request.itemId, email: "unexpected@example.test", target_minor: 1 }); }, /write effect\/readback differs/],
    [(r) => { r.upstream.pending = 1; }, /upstream work leaked or unaccounted/],
  ];
  for (const status of [302, 303]) for (const [mutate, error] of mutations) {
    const data = setup(), row = find(data.capture, "rejected-write");
    row.status = status;
    row.contentType = row.contentEncoding = null;
    mutate(row);
    assert.throws(() => validate(data), error);
  }
});

test("write-limit outcomes require native form evidence, unchanged state and independent readback", () => {
  const data = setup(), row = find(data.capture, "accepted-write");
  Object.assign(row, { outcome: "limited", status: 429, page: null, record: null,
    upstream: { requests: 0, completed: 0, cancelled: 0, pending: 0, path: null, mode: "normal" } });
  row.state.after = structuredClone(row.state.before);
  row.state.readback.alerts = structuredClone(row.state.before);
  // The later writes in this client's schedule must observe that no write took effect.
  const { email } = row.request.input;
  for (const later of data.capture.results.filter((r) => r.request.index > row.request.index && r.state !== null)) {
    for (const alerts of [later.state.before, later.state.after, later.state.readback.alerts]) {
      const index = alerts.findIndex((a) => a.email === email);
      if (index !== -1) alerts.splice(index, 1);
    }
  }
  const result = validate(data);
  assert.equal(result.functionalPassed, false);
  assert.equal(result.categories["accepted-write"].outcomes.limited, 1);
  assert.equal(result.categories["accepted-write"].failed, 1);
  const validForm = row.form;
  row.form = null;
  assert.throws(() => validate(data), /native form/);
  row.form = validForm;
  row.state.after.push({ item_id: row.request.itemId, email, target_minor: row.request.targetMinor });
  assert.throws(() => validate(data), /write effect/);
});

test("explicit failure, missing endpoint, protection and partial-load outcomes remain counted, never parity", () => {
  const statuses = { limited: 429, refused: 403, failed: 404, timeout: 0, "network-error": 0, dropped: 0, unsupported: 0, "not-run": 0 };
  for (const [outcome, status] of Object.entries(statuses)) {
    const data = setup(), row = find(data.capture, "page"), unsent = ["dropped", "unsupported", "not-run"].includes(outcome);
    Object.assign(row, { outcome, status, page: null, record: null, contentType: status === 0 ? null : "text/plain",
      contentEncoding: status === 0 ? null : "identity", error: ["timeout", "network-error"].includes(outcome) ? outcome : null,
      upstream: unsent ? null : { requests: 0, completed: 0, cancelled: 0, pending: 0, path: null, mode: "normal" } });
    const result = validate(data), count = result.categories.page;
    assert.equal(result.functionalPassed, false);
    assert.equal(result.readyForLoad, false);
    assert.equal(count.failed, 1);
    assert.equal(count.outcomes[outcome], 1);
    assert.equal(count.statuses[status], 1);
    assert.equal(count.attempted, count.planned - (unsent ? 1 : 0));
    assert.deepEqual(Object.keys(count.outcomes), outcomes);
  }
});

test("malformed success/failure classification cannot disguise outcomes", () => {
  for (const mutate of [(r) => { r.status = 429; }, (r) => { r.error = "timeout"; },
    (r) => { r.outcome = "failed"; }, (r) => { r.outcome = "network-error"; }, (r) => { r.outcome = "dropped"; },
    (r) => { r.contentType = null; }, (r) => { r.contentEncoding = null; }]) {
    const data = setup(); mutate(find(data.capture, "page")); assert.throws(() => validate(data), /mixed contract:/);
  }
});

test("offline CLI emits reproducible plans, validates saved semantics and fails safely", () => {
  const folder = mkdtempSync(join(tmpdir(), "mixed-contract-"));
  try {
    const data = setup(), optionsPath = join(folder, "options.json"), capturePath = join(folder, "capture.json");
    const script = fileURLToPath(new URL("./mixed.mjs", import.meta.url));
    const cli = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    writeFileSync(optionsPath, JSON.stringify(data.input));
    const planned = cli("plan", optionsPath);
    assert.equal(planned.status, 0, planned.stderr);
    assert.deepEqual(JSON.parse(planned.stdout), data.plan);
    writeFileSync(capturePath, JSON.stringify(data.capture));
    const checked = cli("validate", optionsPath, capturePath);
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(JSON.parse(checked.stdout).functionalPassed, true);
    find(data.capture, "accepted-write").form = null;
    writeFileSync(capturePath, JSON.stringify(data.capture));
    const missingForm = cli("validate", optionsPath, capturePath);
    assert.equal(missingForm.status, 1);
    assert.equal(missingForm.stdout, "");
    writeFileSync(capturePath, '{"DO-NOT-LOG-TOKEN":');
    const corrupt = cli("validate", optionsPath, capturePath);
    assert.equal(corrupt.status, 1);
    assert.ok(!corrupt.stderr.includes("DO-NOT-LOG"));
    assert.equal(cli("plan", optionsPath, "unwanted").status, 1);
    assert.equal(cli("run", optionsPath).status, 1);
    const source = readFileSync(script, "utf8");
    assert.ok(!source.includes("../workloads/registry"));
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
