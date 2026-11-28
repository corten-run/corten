import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { failureClass, failureClasses, requestOutcome } from "./load-outcome.js";
import { timedFailureClasses } from "./timed.mjs";

const names = ["successes", "timeouts", "http_errors", "invalid_responses"];

// Execute the actual producer; replace only the k6 runtime imports, as in the
// marketplace producer tests. Each context represents an independent k6 VU.
function producer(responses, env = {}, { classify = failureClass } = {}) {
  const requests = [], checks = [], updates = [], counters = new Map(), created = [];
  const source = readFileSync(new URL("./load.js", import.meta.url), "utf8")
    .replace('import http from "k6/http";', "")
    .replace('import { check } from "k6";', "")
    .replace('import { Counter } from "k6/metrics";', "")
    .replace('import { failureClass, failureClasses, requestOutcome } from "./load-outcome.js";', "")
    .replace("export const options", "const options")
    .replace("export default function ()", "function iteration()");
  const result = runInNewContext(`${source}\n({ iteration, options });`, {
    __ENV: { CATALOG_TIMED_EVIDENCE: "1", TARGET: "page", MODE: "closed", VUS: "64", RATE: "150", DURATION: "60s", BASE: "http://app:8080", ...env },
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    requestOutcome, failureClasses, failureClass: classify,
    // `counters` has a series once a sample is added to it, as k6 reports only observed metrics.
    Counter: class {
      constructor(name) { this.name = name; created.push(name); }
      add(value) { updates.push([this.name, value]); counters.set(this.name, (counters.get(this.name) ?? 0) + value); }
    },
    http: { get(url, options) {
      requests.push({ url, options: JSON.parse(JSON.stringify(options)) });
      assert.ok(requests.length <= responses.length, "unexpected extra HTTP request");
      return responses[requests.length - 1];
    } },
    check(response, predicates) { checks.push(Object.fromEntries(Object.entries(predicates).map(([name, fn]) => [name, fn(response)]))); },
  });
  return { ...result, options: JSON.parse(JSON.stringify(result.options)), requests, checks, updates, counters, created };
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
      { status: 404, headers: { "Content-Type": type } },
      { status: 0, error_code: 1210, headers: {} },
      { status: 200, headers: { "Content-Type": "application/octet-stream" } },
      { status: 302, headers: {} },
      { status: 200, headers: {} },
    ];
    const run = producer(responses, { TARGET: target, MODE: mode });
    assert.equal(run.updates.length, 0, "Counter.add must not run in k6's init context");
    for (const response of responses) run.iteration();
    assert.deepEqual(Object.fromEntries(run.counters), {
      catalog_successes: 1, catalog_timeouts: 1, catalog_http_errors: 3, catalog_invalid_responses: 5,
      catalog_failed_http_429: 1, catalog_failed_http_5xx: 2, catalog_failed_other: 4, catalog_failed_transport: 1,
    });
    // A failure adds its outcome and then its class; a success or a timeout only its outcome.
    assert.deepEqual(run.updates, [
      ...names.map((name) => [`catalog_${name}`, 0]),
      ...["successes", "timeouts", "http_errors", "failed_http_429", "http_errors", "failed_http_5xx", "http_errors", "failed_http_5xx",
        "invalid_responses", "failed_other", "invalid_responses", "failed_transport",
        ...Array(3).fill(["invalid_responses", "failed_other"]).flat()].map((name) => [`catalog_${name}`, 1]),
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

test("a run without failures emits exactly the samples it did before failures were classified", () => {
  // The same four zero samples once per VU and one sample per success as before the split: the
  // class series are created in the init context but never sampled, and a success never classifies.
  const success = { status: 200, headers: { "Content-Type": "text/html" } };
  const classify = () => assert.fail("a successful request must not be classified");
  for (let vu = 0; vu < 3; vu++) {
    const run = producer([success, success, success], {}, { classify });
    for (let i = 0; i < 3; i++) run.iteration();
    assert.deepEqual(Object.fromEntries(run.counters), {
      catalog_successes: 3, catalog_timeouts: 0, catalog_http_errors: 0, catalog_invalid_responses: 0,
    });
    assert.deepEqual(run.updates, [...names.map((name) => [`catalog_${name}`, 0]), ...Array(3).fill(["catalog_successes", 1])]);
    assert.deepEqual(run.created, [...names, ...failureClasses.map((name) => `failed_${name}`)].map((name) => `catalog_${name}`));
  }
});

test("unobserved runs do not create or update evidence counters and still check every response", () => {
  const success = { status: 200, headers: { "Content-Type": "text/html" } };
  for (const value of [undefined, "0", "true"]) {
    const run = producer([success], { CATALOG_TIMED_EVIDENCE: value });
    run.iteration();
    assert.equal(run.counters.size, 0);
    assert.deepEqual(run.created, []);
    assert.deepEqual(run.updates, []);
    assert.equal(run.requests.length, 1);
    assert.deepEqual(run.checks, [{ "catalog status 200": true, "catalog content type": true }]);
  }
});

test("a replay reads the same failure classes the producer counts", () => {
  assert.deepEqual(timedFailureClasses, failureClasses);
});

test("a failure has one class: 429, 502, 503, other 5xx, a k6 transport error, or other", () => {
  const response = (status, type = "text/html", error_code = 0) => ({ status, headers: { "Content-Type": type }, error_code });
  for (const [status, name] of [[429, "http_429"], [502, "http_502"], [503, "http_503"], [500, "http_5xx"], [504, "http_5xx"], [599, "http_5xx"]])
    for (const type of ["text/html", "application/json", ""]) assert.equal(failureClass(response(status, type)), name);
  // k6 v2.4.0's network error codes: non-TCP network, TCP, TLS and HTTP/2.
  for (const code of [1010, 1200, 1201, 1202, 1210, 1211, 1212, 1213, 1220, 1300, 1301, 1310, 1311, 1610, 1630, 1650])
    assert.equal(failureClass(response(0, "", code)), "transport");
  // Generic, invalid URL, DNS and blocked-host, decompression and unknown codes are not a transport loss.
  for (const r of [response(0, "", 1000), response(0, "", 1020), response(0, "", 1100), response(0, "", 1101), response(0, "", 1110),
    response(0, "", 1111), response(0, "", 1701), response(0, "", 999), response(0, "", 2000), response(0, "", "1210"), response(0, ""),
    response(404), response(302), response(428), response(600), response(200, "application/octet-stream"), response(1210, "", 0)])
    assert.equal(failureClass(r), "other", JSON.stringify(r));
});
