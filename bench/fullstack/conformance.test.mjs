// Checks conformance.mjs's cells, what each column counts as doing its thing, the form reader,
// and that a stored round's rows are what its probes score now, without Docker.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { errorOf, features, formBody, formOf, parseAnswer, rowOf, scriptPolicyOf, securityOf, statusOf } from "./conformance.mjs";

const answer = (/** @type {number} */ status, /** @type {Record<string, string>} */ headers = {}, body = "x", ms = 5) => ({ status, headers, bodyLength: body.length, ms });
const secure = { "content-security-policy": "default-src 'none'; frame-ancestors 'none'", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-opener-policy": "same-origin" };
const column = (/** @type {string} */ key) => {
  const f = features.find((f) => f.key === key);
  assert.ok(f, key);
  return f;
};
const meets = (/** @type {string} */ key, /** @type {Record<string, any>} */ o) => column(key).meets(column(key).cell(o));

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
  assert.equal(scriptPolicyOf(answer(200, { "content-security-policy": "img-src 'self'" })), "scripts unrestricted");
});

test("an error is its status and format, and a failure says how it failed", () => {
  assert.equal(errorOf(answer(404, { "content-type": "application/problem+json" })), "404 problem+json");
  assert.equal(errorOf(answer(404, { "content-type": "text/html; charset=utf-8" })), "404 html");
  assert.equal(errorOf(answer(404, { "content-type": "text/html" }, "")), "404 empty");
  assert.equal(statusOf({ timedOut: true, ms: 45_000 }), "held 45 s");
  assert.equal(statusOf({ error: "ECONNRESET", ms: 3 }), "error ECONNRESET");
  assert.equal(statusOf({ didNotStart: true, error: "no answer in 120 s", ms: 0 }), "did not start");
});

test("a missing item's JSON counts by its format alone, problem+json or json", () => {
  assert.ok(meets("json404", { json404: answer(404, { "content-type": "application/problem+json" }) }));
  assert.ok(meets("json404", { json404: answer(404, { "content-type": "application/json" }) }));
  assert.ok(!meets("json404", { json404: answer(404, { "content-type": "text/plain" }) }));
  assert.equal(column("json404").cell({ json404: answer(404, { "content-type": "application/json" }) }), "404 json");
});

test("caching counts when shared caches may not keep the answer: no-cache or no-store, not public", () => {
  for (const c of ["private, no-cache", "no-cache, no-store", "private, no-cache, no-store, max-age=0, must-revalidate", "no-store"]) assert.ok(meets("pageCache", { page: answer(200, { "cache-control": c }) }), c);
  for (const c of ["public, no-cache", "max-age=60"]) assert.ok(!meets("pageCache", { page: answer(200, { "cache-control": c }) }), c);
  assert.ok(!meets("jsonCache", { json: answer(200) }));
});

test("a deadline is any 5xx within 35 seconds, not an answer held until the probe gives up", () => {
  assert.equal(column("deadline").cell({ slow: answer(503, {}, "x", 10_100) }), "503 in 10.1 s");
  assert.ok(meets("deadline", { slow: answer(503, {}, "x", 10_100) }));
  assert.ok(meets("deadline", { slow: answer(504, {}, "x", 29_900) }));
  assert.ok(meets("deadline", { slow: answer(500, {}, "x", 30_500) }));
  assert.ok(!meets("deadline", { slow: answer(503, {}, "x", 36_000) }));
  assert.ok(!meets("deadline", { slow: answer(200, {}, "x", 1_000) }));
  assert.ok(!meets("deadline", { slow: { timedOut: true, ms: 45_000 } }));
  assert.equal(column("deadline").cell({ slow: { didNotStart: true, ms: 0 } }), "did not start");
});

test("readiness counts when its endpoint says not ready within 35 seconds of the item API hanging", () => {
  assert.equal(column("readyDown").cell({ readyPath: null }), "no readiness endpoint");
  assert.ok(!meets("readyDown", { readyPath: null }));
  assert.equal(column("readyDown").cell({ readyPath: "/readyz", readyDown: answer(503, {}, "x", 2_000) }), "/readyz 503 in 2.0 s");
  assert.ok(meets("readyDown", { readyPath: "/readyz", readyDown: answer(503, {}, "x", 2_000) }));
  assert.ok(!meets("readyDown", { readyPath: "/readyz", readyDown: answer(200, {}, "x", 2_000) }));
  assert.ok(!meets("readyDown", { readyPath: "/readyz", readyDown: { timedOut: true, ms: 45_000 } }));
});

test("liveness counts on any of the conventional paths that answers 200", () => {
  assert.ok(meets("live", { live: { ...answer(200), path: "/up" } }));
  assert.equal(column("live").cell({ live: null }), "none");
  assert.ok(!meets("live", { live: null }));
});

test("the form columns count any 4xx or 5xx as refused, and a websocket form is not counted", () => {
  for (const key of ["crossSite", "bigBody"]) {
    assert.ok(meets(key, { [key]: answer(403) }));
    assert.ok(meets(key, { [key]: answer(413) }));
    assert.ok(meets(key, { [key]: answer(500) }));
    assert.ok(!meets(key, { [key]: answer(303) }));
    assert.ok(!meets(key, { [key]: { error: "ECONNRESET", ms: 3 } }));
    assert.ok(!meets(key, { [key]: answer(200) }));
    assert.ok(!meets(key, { [key]: { timedOut: true, ms: 30_000 } }));
  }
  const row = rowOf({ pages: true, form: "n/a: phx-submit (a websocket)" });
  assert.equal(row.crossSite, "n/a: phx-submit (a websocket)");
  assert.ok(!row.unmet.includes("crossSite") && !row.unmet.includes("bigBody"));
});

test("an unknown Host counts when refused with a 4xx; HEAD counts as a 200 without a body", () => {
  assert.ok(meets("host", { badHost: answer(421) }));
  assert.ok(meets("host", { badHost: answer(400) }));
  assert.ok(!meets("host", { badHost: answer(200) }));
  assert.ok(meets("head", { head: answer(200, {}, "") }));
  assert.equal(column("head").cell({ head: answer(200, {}, "x") }), "200 with a body");
  assert.ok(!meets("head", { head: answer(405, {}, "") }));
});

test("an app without pages is not counted on the page columns", () => {
  const row = rowOf({ pages: false, json: answer(200, { ...secure, "cache-control": "private, no-cache" }) });
  for (const f of features.filter((f) => f.pages)) assert.equal(row[f.key], "n/a");
  assert.ok(!row.unmet.includes("pageHeaders"));
  assert.ok(!row.unmet.includes("jsonHeaders"));
  assert.ok(row.unmet.includes("live"));
});

test("compression counts br, gzip or zstd when br and gzip are asked, and gzip when only gzip is", () => {
  assert.ok(meets("jsonCompression", { jsonBr: answer(200, { "content-encoding": "br" }), jsonGzip: answer(200, { "content-encoding": "gzip" }) }));
  assert.ok(!meets("jsonCompression", { jsonBr: answer(200), jsonGzip: answer(200) }));
});

test("the form is the page's first that posts: where it posts, its encoding, hidden fields as given, others filled", () => {
  const html = `<form method="get" action="/search"><input name="q"></form>
    <form method="POST" action="?_action=alert" enctype="multipart/form-data"><input type="hidden" name="$ACTION_1:0" value="{&quot;id&quot;:1}">
    <input name="title" required><input type="email" name="email"><input type="number" name="target_price"><textarea name="note"></textarea><button type="submit">Go</button></form>`;
  const form = formOf(html, "/items/item_5");
  assert.ok(form && !("socket" in form));
  assert.equal(form.path, "/items/item_5?_action=alert");
  assert.equal(form.multipart, true);
  assert.deepEqual(form.fields, [
    { name: "$ACTION_1:0", value: '{"id":1}', hidden: true },
    { name: "title", value: "a", hidden: false },
    { name: "email", value: "a@example.com", hidden: false },
    { name: "target_price", value: "1", hidden: false },
    { name: "note", value: "a", hidden: false },
  ]);
  const big = formBody(form, "BIG");
  assert.match(big.type, /^multipart\/form-data; boundary=/);
  assert.match(big.body, /name="title"\r\n\r\nBIG\r\n/);
  assert.match(big.body, /name="\$ACTION_1:0"\r\n\r\n\{"id":1\}\r\n/);
  assert.equal(formOf('<form method="post" action="/items/item_5"><input name="title"></form>', "/items/item_5")?.path, "/items/item_5");
  assert.equal(formBody(/** @type {any} */ (formOf('<form method=post><input type=hidden name=csrf value=t><input name=title></form>', "/items/item_5"))).body, "csrf=t&title=a");
  assert.deepEqual(formOf('<form method="post" wire:submit="save"><input name="title"></form>', "/x"), { socket: "wire:submit" });
  assert.deepEqual(formOf('<form method="post" phx-submit="alert"></form>', "/x"), { socket: "phx-submit" });
  assert.equal(formOf('<form action="/search"><input name="q"></form>', "/x"), null);
});

test("an answer read from raw bytes gives its status, headers and the length after them", () => {
  const raw = Buffer.from("HTTP/1.1 413 Payload Too Large\r\nContent-Type: text/plain\r\nSet-Cookie: a=1\r\nset-cookie: b=2\r\n\r\ntoo big");
  assert.deepEqual(parseAnswer(raw), { status: 413, headers: { "content-type": "text/plain", "set-cookie": ["a=1", "b=2"] }, bodyLength: 7 });
  assert.equal(parseAnswer(Buffer.from("HTTP/1.1 200 OK\r\nX-A: 1"))?.bodyLength, 0);
  assert.equal(parseAnswer(Buffer.from("")), null);
  assert.equal(parseAnswer(Buffer.from("garbage\r\n\r\n")), null);
});

test("every stored round's rows are what its probes score now", () => {
  const results = join(import.meta.dirname, "results");
  for (const round of readdirSync(results)) {
    const file = join(results, round, "conformance.json");
    if (!existsSync(file)) continue;
    const stored = JSON.parse(readFileSync(file, "utf8"));
    if (!stored.commit) continue;
    for (const [app, r] of Object.entries(stored.results)) if (r.probes) assert.deepEqual(rowOf(r.probes), r.row, `${round} ${app}`);
  }
});
