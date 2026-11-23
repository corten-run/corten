import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { outcomes, requestOutcome } from "./load-outcome.js";
import { timedOutcomes } from "./timed.mjs";

const names = outcomes;

// Execute the actual producer; replace only the k6 runtime imports, as in the
// marketplace producer tests. Each context represents an independent k6 VU.
function producer(responses, env = {}) {
  const requests = [], checks = [], updates = [], counters = new Map();
  const source = readFileSync(new URL("./load.js", import.meta.url), "utf8")
    .replace('import http from "k6/http";', "")
    .replace('import { check } from "k6";', "")
    .replace('import { Counter } from "k6/metrics";', "")
    .replace('import { outcomes, requestOutcome } from "./load-outcome.js";', "")
    .replace("export const options", "const options")
    .replace("export default function ()", "function iteration()");
  const result = runInNewContext(`${source}\n({ iteration, options });`, {
    __ENV: { CATALOG_TIMED_EVIDENCE: "1", TARGET: "page", MODE: "closed", VUS: "64", RATE: "150", DURATION: "60s", BASE: "http://app:8080", ...env },
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    outcomes, requestOutcome,
    Counter: class {
      constructor(name) { this.name = name; counters.set(name, 0); }
      add(value) { updates.push([this.name, value]); counters.set(this.name, counters.get(this.name) + value); }
    },
    http: { get(url, options) {
      requests.push({ url, options: JSON.parse(JSON.stringify(options)) });
      assert.ok(requests.length <= responses.length, "unexpected extra HTTP request");
      return responses[requests.length - 1];
    } },
    check(response, predicates) { checks.push(Object.fromEntries(Object.entries(predicates).map(([name, fn]) => [name, fn(response)]))); },
  });
  return { ...result, options: JSON.parse(JSON.stringify(result.options)), requests, checks, updates, counters };
}

test("producer retains exhaustive outcome counts with one update per request after per-VU initialization", () => {
  for (const target of ["page", "json"]) for (const mode of ["fixed", "closed"]) {
    const type = target === "json" ? "application/json" : "text/html";
    const responses = [
      { status: 200, headers: { "Content-Type": `${type}; charset=utf-8` } },
      { status: 0, error_code: 1050, headers: {} },
      { status: 429, headers: { "Content-Type": "text/plain" } },
      { status: 500, headers: { "Content-Type": "application/problem+json" } },
      { status: 599, headers: {} },
      { status: 502, headers: { "Content-Type": "text/plain" } },
      { status: 503, headers: { "Content-Type": type } },
      { status: 503, headers: {} },
      { status: 404, headers: { "Content-Type": type } },
      { status: 0, error_code: 1210, headers: {} },
      { status: 0, error_code: 1000, headers: {} },
      { status: 0, error_code: 0, headers: {} },
      { status: 200, headers: { "Content-Type": "application/octet-stream" } },
      { status: 302, headers: {} },
      { status: 200, headers: {} },
    ];
    const run = producer(responses, { TARGET: target, MODE: mode });
    assert.equal(run.updates.length, 0, "Counter.add must not run in k6's init context");
    for (const response of responses) run.iteration();
    assert.deepEqual(Object.fromEntries(run.counters), {
      catalog_successes: 1, catalog_timeouts: 1, catalog_http_429: 1, catalog_http_502: 1, catalog_http_503: 2,
      catalog_http_5xx: 2, catalog_transport_errors: 2, catalog_invalid_responses: 5,
    });
    assert.deepEqual(run.updates, [
      ...names.map((name) => [`catalog_${name}`, 0]),
      ...["successes", "timeouts", "http_429", "http_5xx", "http_5xx", "http_502", "http_503", "http_503", "invalid_responses",
        "transport_errors", "transport_errors", ...Array(4).fill("invalid_responses")].map((name) => [`catalog_${name}`, 1]),
    ]);
    assert.equal(run.requests.length, responses.length);
    for (const request of run.requests) assert.deepEqual(request, {
      url: `http://app:8080${target === "json" ? "/api" : ""}/catalog/record_126`,
      options: { headers: { "Accept-Encoding": "identity", Accept: type }, redirects: 0, timeout: "10s",
        tags: { name: `${target === "json" ? "/api" : ""}/catalog/:id` } },
    });
    assert.deepEqual(run.checks, responses.map((response) => ({
      "catalog status 200": response.status === 200,
      "catalog content type": (response.headers["Content-Type"] ?? "").includes(type),
    })));
    assert.deepEqual(run.options, {
      discardResponseBodies: true,
      summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
      thresholds: { http_req_failed: ["rate==0"], checks: ["rate==1"], dropped_iterations: ["count==0"] },
      scenarios: { catalog: mode === "fixed"
        ? { executor: "constant-arrival-rate", rate: 150, timeUnit: "1s", duration: "60s", preAllocatedVUs: 200, maxVUs: 1000, gracefulStop: "10s" }
        : { executor: "constant-vus", vus: 64, duration: "60s", gracefulStop: "10s" } },
    });
  }
});

test("each VU retains zero outcome series even when all its responses succeed", () => {
  const success = { status: 200, headers: { "Content-Type": "text/html" } };
  for (let vu = 0; vu < 3; vu++) {
    const run = producer([success, success, success]);
    for (let i = 0; i < 3; i++) run.iteration();
    assert.deepEqual(Object.fromEntries(run.counters), {
      ...Object.fromEntries(names.map((name) => [`catalog_${name}`, 0])), catalog_successes: 3,
    });
    assert.equal(run.updates.length, names.length + 3);
    assert.deepEqual(run.updates.slice(0, names.length), names.map((name) => [`catalog_${name}`, 0]));
  }
});

test("unobserved runs do not create or update evidence counters and still check every response", () => {
  const success = { status: 200, headers: { "Content-Type": "text/html" } };
  for (const value of [undefined, "0", "true"]) {
    const run = producer([success], { CATALOG_TIMED_EVIDENCE: value });
    run.iteration();
    assert.equal(run.counters.size, 0);
    assert.deepEqual(run.updates, []);
    assert.equal(run.requests.length, 1);
    assert.deepEqual(run.checks, [{ "catalog status 200": true, "catalog content type": true }]);
  }
});

test("a replay reads the same request outcomes the producer counts", () => {
  assert.deepEqual(timedOutcomes, outcomes);
});

test("a success reads only its status and content type, as before the failures were split", () => {
  for (const target of ["page", "json"]) {
    const read = [];
    const watch = (value, path) => new Proxy(value, { get(object, key) {
      read.push(`${path}${String(key)}`);
      const found = object[key];
      return found && typeof found === "object" ? watch(found, `${path}${String(key)}.`) : found;
    } });
    const type = target === "json" ? "application/json" : "text/html; charset=utf-8";
    assert.equal(requestOutcome(watch({ status: 200, error_code: 0, headers: { "Content-Type": type } }, ""), target), "successes");
    assert.deepEqual(read, ["headers", "headers.Content-Type", "status"]);
  }
});

test("each failure has one class: 429, 502, 503, other 5xx, a timeout, a transport error or invalid", () => {
  const response = (status, type = "text/html", error_code = 0) => ({ status, headers: { "Content-Type": type }, error_code });
  for (const target of ["page", "json"]) {
    for (const [status, outcome] of [[429, "http_429"], [502, "http_502"], [503, "http_503"], [500, "http_5xx"], [504, "http_5xx"], [599, "http_5xx"]])
      for (const type of ["text/html", "application/json", ""]) assert.equal(requestOutcome(response(status, type), target), outcome);
    assert.equal(requestOutcome(response(0, "", 1050), target), "timeouts");
    for (const code of [1000, 1210, 1220, 1300, 1999]) assert.equal(requestOutcome(response(0, "", code), target), "transport_errors");
    for (const r of [response(0, ""), response(0, "", 999), response(0, "", 2000), response(0, "", "1210"), response(404), response(302),
      response(428), response(600), response(200, target === "json" ? "text/html" : "application/json")])
      assert.equal(requestOutcome(r, target), "invalid_responses");
  }
});
