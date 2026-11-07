// Checks conformance.mjs's cells, what each column counts as doing its thing, the form reader,
// and that a stored round's rows are what its probes score now, without Docker.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { capHeld, errorOf, features, featuresOf, format, formBody, formOf, logLinesOf, maxConnections, parseAnswer, rowOf, scriptPolicyOf, securityOf, statusOf } from "./conformance.mjs";

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
  assert.equal(scriptPolicyOf(answer(200, { "content-security-policy": "script-src *" })), "any host or scheme");
  assert.equal(scriptPolicyOf(answer(200, { "content-security-policy": "script-src 'self' data:" })), "any host or scheme");
  assert.equal(scriptPolicyOf(answer(200, { "content-security-policy": "default-src https: 'unsafe-eval'" })), "any host or scheme");
  assert.equal(scriptPolicyOf(answer(200, { "content-security-policy": "script-src 'self' 'unsafe-eval'" })), "eval allowed");
  assert.equal(scriptPolicyOf(answer(200, { "content-security-policy": "script-src https://*.cdn.example" })), "any host or scheme");
  assert.equal(scriptPolicyOf(answer(200, { "content-security-policy": "Script-Src 'self' 'unsafe-inline'" })), "inline allowed");
  assert.equal(scriptPolicyOf(answer(200, { "content-security-policy": "script-src 'self' https://cdn.example 'nonce-abc'" })), "strict");
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

test("caching counts when shared caches may not keep the answer: private or no-store, not public", () => {
  for (const c of ["private, no-cache", "no-cache, no-store", "max-age=0, private, must-revalidate", "private", "no-store"]) assert.ok(meets("pageCache", { page: answer(200, { "cache-control": c }) }), c);
  for (const c of ["public, no-cache", "no-cache", "max-age=60", "public, private"]) assert.ok(!meets("pageCache", { page: answer(200, { "cache-control": c }) }), c);
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

test("readiness counts when its endpoint says not ready within 35 seconds while the item API hangs", () => {
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

test("the form columns count any 4xx or 5xx as refused once the app took its own post, and a scripted form is not counted", () => {
  for (const key of ["crossSite", "bigBody"]) {
    for (const ownPost of [answer(303), answer(200)]) {
      assert.ok(meets(key, { ownPost, [key]: answer(403) }));
      assert.ok(meets(key, { ownPost, [key]: answer(413) }));
      assert.ok(meets(key, { ownPost, [key]: answer(500) }));
      assert.ok(!meets(key, { ownPost, [key]: answer(303) }));
      assert.equal(meets(key, { ownPost, [key]: { error: "ECONNRESET", ms: 3 } }), key === "bigBody");
      assert.equal(meets(key, { ownPost, [key]: { error: "EPIPE", ms: 3 } }), key === "bigBody");
      assert.ok(!meets(key, { ownPost, [key]: { error: "closed without an answer", ms: 3 } }));
      assert.ok(!meets(key, { ownPost, [key]: answer(200) }));
      assert.ok(!meets(key, { ownPost, [key]: { timedOut: true, ms: 30_000 } }));
    }
    // The page's own post refused (SvelteKit's origin check on the wrong Origin): a refusal says nothing.
    const row = rowOf({ pages: true, ownPost: answer(403), [key]: answer(403) });
    assert.equal(row[key], "n/a: its own post answered 403");
    assert.ok(!row.unmet.includes(key));
  }
  // Leptos's refusal of a form without its script: a redirect back with the error in serverfnerror.
  const fnError = { status: 302, headers: { serverfnerror: "/api/create_alert1" }, bodyLength: 37, ms: 4 };
  assert.equal(column("bigBody").cell({ ownPost: answer(302), bigBody: fnError, afterBig: answer(200) }), "302 serverfnerror");
  assert.ok(meets("bigBody", { ownPost: answer(302), bigBody: fnError, afterBig: answer(200) }));
  assert.ok(meets("crossSite", { ownPost: answer(302), crossSite: fnError }));
  assert.equal(column("crossSite").cell({ ownPost: fnError, crossSite: fnError }), "n/a: its own post answered 302 serverfnerror");
  // A reset on the 3 MiB post counts only while the app still serves the page after it.
  assert.ok(meets("bigBody", { ownPost: answer(200), bigBody: { error: "EPIPE", ms: 3 }, afterBig: answer(200) }));
  assert.equal(column("bigBody").cell({ ownPost: answer(200), bigBody: { error: "EPIPE", ms: 3 }, afterBig: { error: "ECONNREFUSED", ms: 1 } }), "error EPIPE, then the page error ECONNREFUSED");
  assert.ok(!meets("bigBody", { ownPost: answer(200), bigBody: answer(413), afterBig: { timedOut: true, ms: 10_000 } }));
  assert.ok(meets("bigBody", { ownPost: answer(200), bigBody: answer(413), afterBig: answer(200) }));
  assert.deepEqual(formOf('<form method="post" wire:submit.prevent="save"></form>', "/x"), { script: "wire:submit" });
  const row = rowOf({ pages: true, form: "n/a: phx-submit (sent by its script)" });
  assert.equal(row.crossSite, "n/a: phx-submit (sent by its script)");
  assert.ok(!row.unmet.includes("crossSite") && !row.unmet.includes("bigBody"));
});

test("an unknown Host counts when refused with a 4xx; HEAD counts as a 200 without a body", () => {
  assert.ok(meets("host", { badHost: answer(421) }));
  assert.ok(meets("host", { badHost: answer(400) }));
  assert.ok(!meets("host", { badHost: answer(200) }));
  assert.ok(meets("head", { head: answer(200, {}, "") }));
  assert.ok(!meets("head", { head: answer(405, {}, "") }));
});

test("an app without pages is not counted on the page columns", () => {
  const row = rowOf({ pages: false, json: answer(200, { ...secure, "cache-control": "private, no-cache" }) });
  for (const f of features.filter((f) => f.pages)) assert.equal(row[f.key], "n/a");
  assert.ok(!row.unmet.includes("pageHeaders"));
  assert.ok(!row.unmet.includes("jsonHeaders"));
  assert.ok(row.unmet.includes("live"));
});

test("compression counts br or gzip when br and gzip are asked, and gzip when only gzip is", () => {
  assert.ok(meets("jsonCompression", { jsonBr: answer(200, { "content-encoding": "br" }), jsonGzip: answer(200, { "content-encoding": "gzip" }) }));
  assert.ok(meets("jsonCompression", { jsonBr: answer(200, { "content-encoding": "gzip" }), jsonGzip: answer(200, { "content-encoding": "gzip" }) }));
  assert.ok(!meets("jsonCompression", { jsonBr: answer(200, { "content-encoding": "br" }), jsonGzip: answer(200) }));
  assert.ok(!meets("jsonCompression", { jsonBr: answer(200), jsonGzip: answer(200) }));
});

test("the form is the page's first that posts: where it posts, its encoding, hidden fields as given, others filled", () => {
  const html = `<form method="get" action="/search"><input name="q"></form>
    <form method="POST" action="?_action=alert" enctype="multipart/form-data"><input type="hidden" name="$ACTION_1:0" value="{&quot;id&quot;:1}">
    <input name="title" required><input type="email" name="email"><input type="number" name="target_price"><textarea name="note"></textarea><button type="submit">Go</button></form>`;
  const form = formOf(html, "/items/item_5");
  assert.ok(form && !("script" in form));
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
  assert.deepEqual(formOf('<form method="post" wire:submit="save"><input name="title"></form>', "/x"), { script: "wire:submit" });
  assert.deepEqual(formOf('<form method="post" phx-submit="alert"></form>', "/x"), { script: "phx-submit" });
  // As a browser sends it: unchecked boxes and disabled fields left out, a select's chosen option, the typed field first.
  const choices = formOf('<form method="post"><input type="checkbox" name="off"><input type="checkbox" name="on" checked><input name="gone" disabled><select name="cond"><option value="nm">Near mint</option><option value="lp" selected>Light</option></select><input name="title"></form>', "/x");
  assert.ok(choices && !("script" in choices));
  assert.equal(formBody(choices).body, "on=on&cond=lp&title=a");
  assert.equal(formBody(choices, "BIG").body, "on=on&cond=lp&title=BIG");
  assert.equal(formOf('<form action="/search"><input name="q"></form>', "/x"), null);
});

test("an answer read from raw bytes gives its status, headers and the length after them", () => {
  const raw = Buffer.from("HTTP/1.1 413 Payload Too Large\r\nContent-Type: text/plain\r\nSet-Cookie: a=1\r\nset-cookie: b=2\r\n\r\ntoo big");
  assert.deepEqual(parseAnswer(raw), { status: 413, headers: { "content-type": "text/plain", "set-cookie": ["a=1", "b=2"] }, bodyLength: 7 });
  assert.equal(parseAnswer(Buffer.from("HTTP/1.1 200 OK\r\nX-A: 1"))?.bodyLength, 0);
  assert.equal(parseAnswer(Buffer.from("")), null);
  assert.equal(parseAnswer(Buffer.from("garbage\r\n\r\n")), null);
});

/**
 * Runs conform-probe.mjs, as conform.mjs does inside fsw-probe, against a local server that
 * answers each connection as `serve` does.
 * @param {(socket: import("node:net").Socket) => void} serve
 * @param {Record<string, any>} request
 */
const probeAgainst = async (serve, request) => {
  const server = createServer(serve);
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  const child = spawn(process.execPath, [join(import.meta.dirname, "conform-probe.mjs")]);
  child.stdin.end(JSON.stringify({ host: "127.0.0.1", port, method: "POST", path: "/form", headers: { host: "localhost" }, timeoutMs: 2000, ...request }));
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  await new Promise((r) => child.on("close", r));
  server.close();
  return JSON.parse(out);
};

test("a POST's answer is read even when the server answers before the body arrives and keeps the connection open", async () => {
  const early = await probeAgainst((s) => { s.on("error", () => {}); s.write("HTTP/1.1 413 Content Too Large\r\nContent-Length: 0\r\n\r\n"); }, { body: "a".repeat(1024 * 1024) });
  assert.equal(early.status, 413);
  assert.ok(!early.timedOut);
  const closed = await probeAgainst((s) => { s.once("data", () => s.end("HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nno")); }, { body: "a=1" });
  assert.equal(closed.status, 403);
  assert.equal(closed.bodyLength, 2);
  assert.ok(closed.ms < 1000, "settled by the close, not the limit");
  // An answer and then a reset (the server closes with the body unread): the answer is kept.
  const reset = await probeAgainst((s) => { s.on("error", () => {}); s.write("HTTP/1.1 413 Content Too Large\r\nContent-Length: 0\r\n\r\n", () => setTimeout(() => s.resetAndDestroy(), 100)); }, { body: "a".repeat(4 * 1024 * 1024) });
  assert.equal(reset.status, 413);
  assert.ok(reset.ms < 1000, "settled by the reset, not the limit");
});

test("a POST nothing answers is held until the limit, and one to a closed port keeps the connection's error", async () => {
  const held = await probeAgainst((s) => { s.on("error", () => {}); }, { body: "a=1", timeoutMs: 500 });
  assert.equal(held.timedOut, true);
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  await new Promise((r) => server.close(r));
  const refused = await probeAgainst(() => {}, { port, body: "a=1" });
  assert.equal(refused.error, "ECONNREFUSED");
  // A reset with nothing answered keeps the connection's error.
  const dropped = await probeAgainst((s) => { s.on("error", () => {}); s.once("data", () => s.resetAndDestroy()); }, { body: "a".repeat(4 * 1024 * 1024) });
  assert.match(String(dropped.error), /^(ECONNRESET|EPIPE)$/);
});

// A round of the current format is scored as stored; an older one keeps each cell it had, and its
// unmet columns, plus the 64 KiB header where it was not refused (counted from format 2).
test("every stored round's rows are what its probes score now", () => {
  const results = join(import.meta.dirname, "results");
  for (const round of readdirSync(results)) {
    const file = join(results, round, "conformance.json");
    if (!existsSync(file)) continue;
    const stored = JSON.parse(readFileSync(file, "utf8"));
    for (const [app, r] of Object.entries(stored.results)) {
      if (!r.probes) continue;
      const row = rowOf(r.probes);
      if (stored.format === format) assert.deepEqual(row, r.row, `${round} ${app}`);
      else {
        for (const [key, cell] of Object.entries(r.row)) if (key !== "unmet") assert.equal(row[key], cell, `${round} ${app} ${key}`);
        const bigHead = features.find((f) => f.key === "bigHead");
        const unmet = [...r.row.unmet, ...(bigHead && !bigHead.meets(row.bigHead) ? ["bigHead"] : [])];
        assert.deepEqual([...row.unmet].sort(), unmet.sort(), `${round} ${app} unmet`);
      }
    }
  }
});

test("a failed read, the header limit and the log lines are scored from format 2's probes", () => {
  const ok = { status: 200, headers: {}, ms: 5 };
  const row = rowOf({ pages: true, page500: { status: 502, headers: { "content-type": "text/html; charset=utf-8" }, bodyLength: 900, ms: 4 }, json500: { status: 500, headers: { "content-type": "application/problem+json" }, bodyLength: 80, ms: 3 }, bigHead: { status: 431, headers: {}, ms: 2 }, logLines: logLinesOf(10, 30, 20), json: ok, page: ok });
  assert.equal(row.page500, "502 html");
  assert.equal(row.json500, "500 problem+json");
  assert.equal(row.bigHead, "431");
  assert.equal(row.logLines, "1");
  for (const key of ["page500", "json500", "bigHead", "logLines"]) assert.ok(!row.unmet.includes(key), key);
  const bare = rowOf({ pages: true, page500: { status: 500, headers: {}, bodyLength: 0, ms: 4 }, json500: { status: 500, headers: { "content-type": "text/plain" }, bodyLength: 5, ms: 3 }, bigHead: { status: 200, headers: {}, ms: 2 } });
  assert.deepEqual([bare.page500, bare.json500, bare.bigHead, bare.logLines], ["500 empty", "500 text/plain", "200", "n/a: not probed"]);
  for (const key of ["page500", "json500", "bigHead"]) assert.ok(bare.unmet.includes(key), key);
  assert.equal(rowOf({ pages: true, bigHead: { error: "ECONNRESET", ms: 2 } }).unmet.includes("bigHead"), false);
  assert.equal(logLinesOf(null, 4, 20), "unreadable");
});

test("the matched tier's columns are its own: a defaults row has neither", () => {
  const matchedOnly = ["unfinishedHead", "connectionCap"];
  assert.deepEqual(featuresOf("defaults").filter((f) => matchedOnly.includes(f.key)), []);
  assert.deepEqual(featuresOf("matched").filter((f) => matchedOnly.includes(f.key)).map((f) => f.key), matchedOnly);
  assert.equal(featuresOf("matched").length, features.length);
  const row = rowOf({ pages: false });
  for (const key of matchedOnly) assert.ok(!(key in row), key);
  assert.ok(capHeld > maxConnections, "the cap probe holds more connections than the cap allows");
});

test("an unfinished head counts when closed within 35 seconds; the cap when the request past it waits", () => {
  const row = (/** @type {Record<string, any>} */ o) => rowOf({ pages: false, tier: "matched", ...o });
  const closed = row({ unfinishedHead: { closedMs: 30_120 }, cap: { held: capHeld, whileHeld: null, afterRelease: 200, releaseMs: 40 } });
  assert.equal(closed.unfinishedHead, "closed in 30.1 s");
  assert.equal(closed.connectionCap, "capped, then 200");
  for (const key of ["unfinishedHead", "connectionCap"]) assert.ok(!closed.unmet.includes(key), key);
  const open = row({ unfinishedHead: { timedOutMs: 45_010 }, cap: { held: capHeld, whileHeld: 200, afterRelease: null, releaseMs: 0 } });
  assert.equal(open.unfinishedHead, "held 45 s");
  assert.equal(open.connectionCap, `served with ${capHeld} held (200)`);
  for (const key of ["unfinishedHead", "connectionCap"]) assert.ok(open.unmet.includes(key), key);
  // Refused past the cap (closed) or still waiting when the probe gave up both count as capped.
  assert.equal(row({ cap: { held: capHeld, whileHeld: null, afterRelease: "closed" } }).connectionCap, "capped, then closed");
  assert.equal(row({ cap: { held: capHeld, whileHeld: null, afterRelease: null } }).connectionCap, "capped, then held");
  // Too few held to see a cap, a failed probe, or no probe at all: not counted.
  const unseen = row({ cap: { held: 900, whileHeld: null, afterRelease: null } });
  assert.equal(unseen.connectionCap, "n/a: held only 900 connections");
  assert.ok(!unseen.unmet.includes("connectionCap"));
  assert.equal(row({ unfinishedHead: { error: "could not connect" } }).unfinishedHead, "error could not connect");
  assert.ok(row({ unfinishedHead: { error: "could not connect" } }).unmet.includes("unfinishedHead"));
  assert.equal(row({}).unfinishedHead, "n/a: not probed");
});

/**
 * Runs conform-hold.mjs, as conform.mjs does inside fsw-probe, against a local server.
 * @param {import("node:net").Server} server
 * @param {Record<string, any>} request
 */
const holdAgainst = async (server, request) => {
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  const child = spawn(process.execPath, [join(import.meta.dirname, "conform-hold.mjs")]);
  child.stdin.end(JSON.stringify({ host: "127.0.0.1", port, path: "/api/items/item_5", ...request }));
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  await new Promise((r) => child.on("close", r));
  server.close();
  return JSON.parse(out);
};
const answers = (/** @type {import("node:net").Socket} */ s) => { s.on("error", () => {}); s.once("data", () => s.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")); };

test("the head probe sees a server close an unfinished head, and one that holds it until the probe's limit", async () => {
  const closes = await holdAgainst(createServer((s) => { s.on("error", () => {}); setTimeout(() => s.destroy(), 100); }), { mode: "head", timeoutMs: 5000 });
  assert.ok(closes.closedMs !== undefined && closes.closedMs < 5000, JSON.stringify(closes));
  const holds = await holdAgainst(createServer((s) => s.on("error", () => {})), { mode: "head", timeoutMs: 300 });
  assert.ok(holds.timedOutMs >= 300, JSON.stringify(holds));
});

test("the cap probe tells a server that answers past the held connections from one that refuses them", async () => {
  const uncapped = await holdAgainst(createServer(answers), { mode: "cap", hold: 5, waitMs: 1000, releaseMs: 1000 });
  assert.deepEqual([uncapped.held, uncapped.whileHeld, uncapped.afterRelease], [5, 200, null]);
  // node:net's own cap closes a connection past it at once.
  const capped = createServer(answers);
  capped.maxConnections = 5;
  const refused = await holdAgainst(capped, { mode: "cap", hold: 5, waitMs: 1000, releaseMs: 1000 });
  assert.deepEqual([refused.held, refused.whileHeld, refused.afterRelease], [5, null, "closed"]);
});
