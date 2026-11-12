import assert from "node:assert/strict";
import test from "node:test";
import { records as fixture } from "../marketplace/fixtures.mjs";
import { expectedPage, labels } from "../marketplace/records.mjs";
import { createPlan } from "../workloads/mixed.mjs";
import { selectedApps } from "../workloads/registry.mjs";
import { afterFunctionalGate, captureSource, checkCell, combine, emptyCapture, expectedOutcome, oracle, responseOutcome, unsent, upstreamEvidence } from "./capture.mjs";
import { parseArgs } from "./run.mjs";

const record = fixture().item_1; record.contents = []; record.included_in = [];
const records = { item_1: record }, plan = createPlan({ seed: 7, clients: 2, repetitions: 1, records });
const settings = { completeDelayMs: 1, slowDelayMs: 50, cleanupMs: 1 };

// Test vectors ONLY. No adapter imports these or saves them as native verification.
async function testVector(source, mutate = () => {}) {
  const states = new Map(), saved = [], modes = new Map();
  let current;
  const transport = {
    async discover(request) {
      return { client: request.client, source, locale: request.locale, itemId: request.itemId, method: "POST", action: request.formPage,
        contentType: "application/x-www-form-urlencoded", fields: ["email", "target_price"], transport: { secret: "DO-NOT-PERSIST" } };
    },
    async readState(request) { return structuredClone(states.get(request.client) ?? []); },
    async send(request, binding) {
      assert.equal(binding?.transport.secret ?? "DO-NOT-PERSIST", "DO-NOT-PERSIST");
      if (request.category === "accepted-write") states.set(request.client, [...(states.get(request.client) ?? []), { item_id: request.itemId, email: request.input.email, target_minor: request.targetMinor }]);
      const outcome = expectedOutcome(request);
      return { status: outcome === "deadline" ? 503 : outcome === "cancelled" ? 0 : 200,
        error: outcome === "cancelled" ? "cancelled" : null, contentType: outcome === "cancelled" ? null : request.accept,
        contentEncoding: outcome === "cancelled" ? null : "identity", body: Buffer.from(JSON.stringify(record)) };
    },
    async snapshot(response, request) {
      const message = request.category === "rejected-write" ? labels[request.locale][request.variant] : request.category !== "accepted-write" ? ""
        : labels[request.locale].alert_set.replace("{email}", request.input.email).replace("{title}", record.title)
          .replace("{price}", new Intl.NumberFormat(request.locale, { style: "currency", currency: "USD" }).format(request.targetMinor / 100));
      return expectedPage(record, request.locale, { ...request.query, message });
    },
  };
  const injector = {
    async begin(id, mode, delayMs) { current = id; modes.set(id, { mode, delayMs }); },
    async read(id) {
      assert.equal(current, id);
      const mode = modes.get(id).mode, cancelled = source === "api" && ["cancel", "deadline"].includes(mode);
      return { requests: source === "api" ? 1 : 0, completed: source === "api" && !cancelled ? 1 : 0, cancelled: cancelled ? 1 : 0,
        pending: 0, mode, events: source === "api" ? [{ path: "/marketplace/records/item_1" }] : [] };
    },
  };
  mutate({ transport, injector });
  const result = await captureSource({ plan, records, app: "corten", source, transport, injector, settings, save: async (request, value, phase) => { if (phase === "finished") saved.push({ request, ...value }); } });
  return { ...result, source, saved };
}

let baseline;
async function goodCapture() {
  baseline ??= Promise.all([testVector("fixture"), testVector("api")]).then((parts) => ({ parts, capture: combine(plan, "corten", parts) }));
  return structuredClone(await baseline);
}

test("executes all scheduled categories and isolates native state by source/client", async () => {
  const { parts, capture } = await goodCapture();
  assert.equal(capture.results.length, 53);
  assert.equal(oracle(plan, capture, records).result.functionalPassed, true);
  assert.ok(parts.every((part) => part.cells.every((cell) => cell.passed)));
  for (const part of parts) {
    assert.equal(part.saved.length, plan.requests.filter((r) => r.source === part.source).length);
    assert.ok(!JSON.stringify(part).includes("DO-NOT-PERSIST"));
  }
});

test("actual POST with missing independent readback is attempted, invalid, and never synthesized", async () => {
  const part = await testVector("api", ({ transport }) => { transport.readState = async () => null; });
  const writes = part.capture.results.filter((r) => r.request.source === "api" && r.request.method === "POST");
  assert.ok(writes.every((r) => r.status === 200 && ["completed", "rejected"].includes(r.outcome) && r.state === null));
  assert.ok(part.cells.filter((c) => c.category.endsWith("-write")).every((c) => !c.passed && c.gaps.includes("independent-alert-readback-unavailable")));
  assert.ok(part.cells.filter((c) => !c.category.endsWith("-write")).every((c) => c.passed), "one app gap must not hide independent read evidence");
});

test("missing form remains an unsupported unsent cell; no page substitution", async () => {
  let posts = 0;
  const part = await testVector("fixture", ({ transport }) => {
    transport.discover = async () => null;
    const send = transport.send; transport.send = async (...args) => { if (args[0].method === "POST") posts++; return send(...args); };
  });
  assert.equal(posts, 0);
  assert.ok(part.cells.filter((c) => c.category.endsWith("-write")).every((c) => c.outcome === "unsupported" && !c.passed));
});

test("a transport exception after the primary starts cannot be relabeled unsent", async () => {
  const part = await testVector("api", ({ transport }) => { transport.send = async () => { throw new Error("token=DO-NOT-PERSIST"); }; });
  assert.ok(part.cells.every((c) => c.outcome === "network-error" && !c.passed));
  assert.ok(!JSON.stringify(part).includes("DO-NOT-PERSIST"));
});

const attacks = {
  "wrong localized page": (row) => { row.page.locale = "en-US"; },
  "missing listing work": (row) => { row.page.listings.pop(); },
  "unlocalized labels": (row) => { row.page.headings[0] = "Listings"; },
  "missing numeric schema": (row) => { delete row.record.summary; },
  "localized JSON strings": (row) => { row.record.summary.count = "1,000"; },
  "wrong upstream path": (row) => { row.upstream.path = "/marketplace/records/item_2"; },
  "cached upstream response": (row) => { row.upstream.requests = 0; row.upstream.completed = 0; },
  "leaked upstream work": (row) => { row.upstream.pending = 1; row.upstream.cancelled = 0; },
  "client abort with upstream completion": (row) => { row.upstream.completed = 1; row.upstream.cancelled = 0; },
  "fake deadline from network timeout": (row) => { row.status = 0; row.error = "timeout"; row.outcome = "timeout"; row.contentType = null; row.contentEncoding = null; },
  "unconfirmed slow injection": (row) => { row.upstream.mode = "normal"; },
  "success message without committed state": (row) => { row.state.after = row.state.before; row.state.readback.alerts = row.state.before; },
  "echo readback": (row) => { row.state.readback.via = "post-response"; },
  "invalid write changed state": (row) => { row.state.after.push({ item_id: "item_1", email: "bad", target_minor: 1 }); },
  "stale session state": (row) => { row.state.before.push({ item_id: "item_1", email: "stale", target_minor: 1 }); },
  "wrong native form input": (row) => { row.form.input.target_price = "1.00"; },
};
for (const [name, attack] of Object.entries(attacks)) test(`oracle gate rejects ${name}`, async () => {
  const { capture } = await goodCapture();
  const row = capture.results.find((r) => name.includes("JSON") || name.includes("schema") ? r.request.category === "json"
    : name.includes("deadline") ? r.request.variant === "deadline" : name.includes("abort") || name.includes("leaked") || name.includes("slow") ? r.request.variant === "cancel"
      : name.includes("invalid write") ? r.request.category === "rejected-write"
        : /state|readback|form|message/.test(name) ? r.request.category === "accepted-write"
          : r.request.category === "listings" && r.request.source === "api" && r.request.locale === "fr-FR" && r.request.variant === "asc");
  attack(row);
  const result = oracle(plan, capture, records);
  assert.ok(!result.valid || !result.result.functionalPassed, name);
  let timed = false;
  const inventory = selectedApps("mixed-production");
  const captures = Object.fromEntries(inventory.map((app) => [app, { ...capture, app }]));
  await assert.rejects(afterFunctionalGate({ apps: inventory, inventory, plan, captures, records }, async () => { timed = true; }), /timing blocked/);
  assert.equal(timed, false);
});

test("retains all nine contenders and blocks incomplete, missing and unsupported inventory", async () => {
  const inventory = selectedApps("mixed-production");
  assert.deepEqual(inventory, ["corten", "aspnet", "spring", "django", "express", "fastapi", "topcoat", "gin", "drogon"]);
  await assert.rejects(afterFunctionalGate({ apps: ["corten"], inventory, plan, captures: {}, records }, () => assert.fail()), /incomplete inventory/);
  const captures = Object.fromEntries(inventory.map((app) => [app, emptyCapture(plan, app)]));
  assert.equal(oracle(plan, captures.corten, records).result.functionalPassed, false);
  await assert.rejects(afterFunctionalGate({ apps: inventory, inventory, plan, captures, records }, () => assert.fail()), /timing blocked/);
  assert.deepEqual(unsent(plan.requests[0]), captures.corten.results[0]);
});

test("the oracle gate can admit complete valid evidence without certifying production readiness", async () => {
  const { capture } = await goodCapture(), inventory = selectedApps("mixed-production");
  const captures = Object.fromEntries(inventory.map((app) => [app, { ...capture, app }]));
  let calls = 0;
  const result = await afterFunctionalGate({ apps: inventory, inventory, plan, captures, records }, async () => { calls++; return "gate-open"; });
  assert.equal(result, "gate-open"); assert.equal(calls, 1);
  assert.equal(oracle(plan, captures.corten, records).result.readyForLoad, false);
});

test("real native success evidence is required even for rejected writes and failure statuses", () => {
  const request = plan.requests.find((r) => r.category === "rejected-write");
  assert.equal(responseOutcome(request, { status: 403, error: null }), "refused");
  assert.equal(responseOutcome(request, { status: 429, error: null }), "limited");
  assert.equal(responseOutcome(request, { status: 500, error: null }), "failed");
  assert.equal(responseOutcome(request, { status: 200, error: null }), "rejected");
});

test("upstream facts are not rewritten to the requested path or mode", () => {
  const result = upstreamEvidence({ requests: 2, completed: 1, cancelled: 0, pending: 1, mode: "normal", events: [{ path: "/wrong" }, { path: "/also-wrong" }] }, plan.requests[0]);
  assert.equal(result.path, "multiple-paths"); assert.equal(result.pending, 1);
});

test("CLI accepts bounded explicit wN only; no cloud, nightly or timing options", () => {
  assert.equal(parseArgs(["w1"]).round, "w1");
  assert.equal(parseArgs(["w1"]).slowDelayMs, 40000);
  assert.ok(parseArgs(["w1"]).requestTimeoutMs > parseArgs(["w1"]).slowDelayMs);
  assert.equal(parseArgs(["w1", "--build", "--apps", "corten,express"]).build, true);
  assert.equal(parseArgs(["w1", "--build", "--build-ref", "e8c23cf"]).buildRef, "e8c23cf");
  for (const args of [["r17"], ["w01"], ["w1", "--cloud", "yes"], ["w1", "--duration", "1"], ["w1", "--clients", "0"],
    ["w1", "--request-timeout-ms", "NaN"], ["w1", "--apps", "corten,corten"], ["w1", "--seed", "1", "--seed", "2"],
    ["w1", "--build", "--images", "images.json"], ["w1", "--build", "--build"], ["w1", "--build-ref", "e8c23cf"],
    ["w1", "--build", "--build-ref", "main"], ["w1", "--build", "--build-ref", "--upload"]]) assert.throws(() => parseArgs(args));
});
