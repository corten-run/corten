// Checks conformance.mjs's cells and what counts as doing what card-market does, without Docker.
import assert from "node:assert/strict";
import { test } from "node:test";
import { errorOf, features, rowOf, scriptPolicyOf, securityOf } from "./conformance.mjs";

const answer = (/** @type {number} */ status, /** @type {Record<string, string>} */ headers = {}, body = "x", ms = 5) => ({ status, headers, body: Buffer.from(body), ms });
const secure = { "content-security-policy": "default-src 'none'; frame-ancestors 'none'", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-opener-policy": "same-origin" };

test("security headers are all, none, or the ones missing; frame-ancestors counts for framing", () => {
  assert.equal(securityOf(answer(200, secure)), "all");
  assert.equal(securityOf(answer(200)), "none");
  assert.equal(securityOf(answer(200, { "x-content-type-options": "nosniff", "x-frame-options": "DENY" })), "missing csp, referrer, opener");
  assert.equal(securityOf(null), "no answer");
});

test("a CSP is strict unless it lets inline scripts run without a nonce or hash", () => {
  assert.equal(scriptPolicyOf(answer(200)), "no CSP");
  assert.equal(scriptPolicyOf(answer(200, { "content-security-policy": "script-src 'self'" })), "strict");
  assert.equal(scriptPolicyOf(answer(200, { "content-security-policy": "script-src 'self' 'unsafe-inline'" })), "inline allowed");
  assert.equal(scriptPolicyOf(answer(200, { "content-security-policy": "script-src 'unsafe-inline' 'nonce-abc'" })), "strict");
  assert.equal(scriptPolicyOf(answer(200, { "content-security-policy": "default-src 'self' 'unsafe-inline'" })), "inline allowed");
  assert.equal(scriptPolicyOf(answer(200, { "content-security-policy": "img-src 'self'" })), "scripts unrestricted");
});

test("an error is its status and format; an empty body is empty whatever its type", () => {
  assert.equal(errorOf(answer(404, { "content-type": "application/problem+json" })), "404 problem+json");
  assert.equal(errorOf(answer(404, { "content-type": "text/html; charset=utf-8" })), "404 html");
  assert.equal(errorOf(answer(404, { "content-type": "text/html" }, "")), "404 empty");
  assert.equal(errorOf({ timedOut: true, ms: 45_000 }), "held 45 s");
});

test("an app without pages is not counted on the page columns", () => {
  const row = rowOf({ pages: false, json: answer(200, { ...secure, "cache-control": "private, no-cache" }) });
  for (const f of features.filter((f) => f.pages)) assert.equal(row[f.key], "n/a");
  assert.ok(!row.unmet.includes("pageHeaders"));
  assert.ok(!row.unmet.includes("jsonHeaders"));
  assert.ok(row.unmet.includes("health"));
});

test("a deadline is met by a 503 near ten seconds, not by an answer held until the probe gives up", () => {
  const deadline = features.find((f) => f.key === "deadline");
  assert.ok(deadline);
  const cell = (/** @type {any} */ slow) => deadline.cell({ slow });
  assert.equal(cell(answer(503, {}, "x", 10_100)), "503 in 10.1 s");
  assert.ok(deadline.meets(cell(answer(503, {}, "x", 10_100))));
  assert.ok(!deadline.meets(cell(answer(503, {}, "x", 30_000))));
  assert.ok(!deadline.meets(cell({ timedOut: true, ms: 45_000 })));
});

test("compression is met by br or gzip when both are asked, and gzip when only gzip is", () => {
  const c = features.find((f) => f.key === "jsonCompression");
  assert.ok(c);
  assert.ok(c.meets(c.cell({ jsonBr: answer(200, { "content-encoding": "br" }), jsonGzip: answer(200, { "content-encoding": "gzip" }) })));
  assert.ok(!c.meets(c.cell({ jsonBr: answer(200), jsonGzip: answer(200) })));
});
