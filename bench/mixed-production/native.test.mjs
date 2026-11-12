import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { bindNativeForm } from "../workloads/mixed.mjs";
import { localURL, nativeForm, nativeTransport, redactedDocument } from "./native.mjs";

test("native URL binding refuses credentials, fragments and foreign origins", () => {
  assert.equal(localURL("/submit?native=opaque", "http://127.0.0.1:8080/page").pathname, "/submit");
  for (const url of ["//evil.test/a", "http://evil.test/", "http://user:password@127.0.0.1:8080/", "/submit#fragment"]) assert.throws(() => localURL(url, "http://127.0.0.1:8080"));
});

// An HTTP transport fixture, NOT an implementation of marketplace parity or a timing receipt.
test("real native form preserves CSRF/cookies/opaque action/repeated fields and independently reads committed state", { skip: !process.env.MIXED_BROWSER_TESTS }, async () => {
  const { chromium } = await import("@playwright/test");
  const sessions = new Map(), posts = [], reads = [];
  let nextSession = 0;
  let slowReached = false, slowClosed = false;
  const html = '<!doctype html><html><head><meta name="csrf-token" content="META-SECRET"></head><body><section class="marketplace__alert"><form method="post" action="/native-write?opaque=ACTION-SECRET"><input type="hidden" name="csrf" value="CSRF-SECRET"><input type="hidden" name="repeat" value="one"><input type="hidden" name="repeat" value="two"><input name="email" type="email"><input name="target_price" type="text"><button type="submit" name="submitter" value="native-submit">Save</button></form></section><script nonce="NONCE-SECRET">const token="SCRIPT-SECRET";</script></body></html>';
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture");
    let session = /native-session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    if (url.pathname === "/slow") {
      slowReached = true;
      const timer = setTimeout(() => res.end("late response"), 30000);
      res.on("close", () => { slowClosed = true; clearTimeout(timer); });
      return;
    }
    if (url.pathname.startsWith("/marketplace/")) {
      if (!sessions.has(session)) { session = `SESSION-SECRET-${++nextSession}`; sessions.set(session, []); }
      res.writeHead(200, { "content-type": "text/html", "set-cookie": `native-session=${session}; HttpOnly; SameSite=Lax; Path=/` });
      return res.end(url.pathname.endsWith("/item_multi") ? html.replace('method="post"', 'method="post" enctype="multipart/form-data"') : html);
    }
    if (url.pathname === "/state") {
      reads.push(req.headers.cookie); res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); return res.end(JSON.stringify(sessions.get(session) ?? []));
    }
    if (url.pathname === "/native-write" && req.method === "POST") {
      let body = ""; for await (const part of req) body += part;
      const native = await new Request("http://fixture/native-write", { method: "POST", body, headers: { "content-type": req.headers["content-type"] } }).formData();
      const fields = new URLSearchParams(native); posts.push({ fields, cookie: req.headers.cookie, origin: req.headers.origin, opaque: url.searchParams.get("opaque") });
      if (!sessions.has(session) || fields.get("csrf") !== "CSRF-SECRET" || url.searchParams.get("opaque") !== "ACTION-SECRET") { res.writeHead(403); return res.end(); }
      if (fields.get("email").includes("@") && Number(fields.get("target_price").replace(",", ".")) > 0) sessions.get(session).push({ item_id: "item_1", email: fields.get("email"), target_minor: 125 });
      res.writeHead(200, { "content-type": "text/html" }); return res.end(html);
    }
    res.writeHead(404); res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch();
  const transport = await nativeTransport({ browser, base, readbackPath: "/state", settings: { requestTimeoutMs: 5000, cancelAfterMs: 20 } });
  const request = { id: "test_1", client: 0, source: "fixture", locale: "fr-FR", itemId: "item_1", category: "accepted-write", method: "POST",
    formPage: "/marketplace/fr-FR/item_1", accept: "text/html", acceptEncoding: "br, gzip", input: { email: "transport@example.test", target_price: "1,25" } };
  const evidence = { stages: [] };
  try {
    const captured = await transport.discover(request, evidence), binding = bindNativeForm(request, captured);
    assert.equal(binding.evidence.action, "/native-write");
    assert.deepEqual(await transport.readState(request, evidence, "before"), []);
    const response = await transport.send(request, binding, evidence);
    assert.equal(response.status, 200); assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].fields.getAll("repeat"), ["one", "two"]);
    assert.equal(posts[0].fields.get("submitter"), "native-submit"); assert.equal(posts[0].origin, base);
    const expected = [{ item_id: "item_1", email: "transport@example.test", target_minor: 125 }];
    assert.deepEqual(await transport.readState(request, evidence, "after"), expected);
    assert.deepEqual(await transport.readState(request, evidence, "readback"), expected);
    assert.equal(reads.length, 3); assert.ok(reads.every((cookie) => cookie.includes("native-session=SESSION-SECRET")));
    const other = { ...request, id: "other-client", client: 1, input: { email: "other@example.test", target_price: "1,25" } };
    const otherBinding = bindNativeForm(other, await transport.discover(other, evidence));
    assert.deepEqual(await transport.readState(other, evidence, "before"), [], "a fresh native context must not inherit the first client's cookie");
    await transport.send(other, otherBinding, evidence);
    assert.deepEqual(await transport.readState(other, evidence, "readback"), [{ ...expected[0], email: "other@example.test" }]);
    assert.deepEqual(await transport.readState(request, evidence, "readback"), expected, "the first client's session must stay separate");
    const api = { ...request, id: "other-source", source: "api" };
    await transport.discover(api, evidence);
    assert.deepEqual(await transport.readState(api, evidence, "before"), [], "a fresh source must not inherit the fixture client's cookie");
    const multipart = { ...request, id: "multipart", client: 2, formPage: "/marketplace/fr-FR/item_multi" };
    const multiBinding = bindNativeForm(multipart, await transport.discover(multipart, evidence));
    assert.equal(multiBinding.evidence.contentType, "multipart/form-data");
    assert.equal((await transport.send(multipart, multiBinding, evidence)).status, 200);
    assert.deepEqual(posts.at(-1).fields.getAll("repeat"), ["one", "two"]);
    assert.deepEqual(await transport.readState(multipart, evidence, "readback"), expected);
    const invalid = { ...request, id: "test_2", category: "rejected-write", input: { email: "invalid-email", target_price: "0" } };
    const second = bindNativeForm(invalid, await transport.discover(invalid, evidence));
    assert.equal((await transport.send(invalid, second, evidence)).status, 200);
    assert.deepEqual(await transport.readState(invalid, evidence, "readback"), expected, "rejected POST must not commit");
    const cancelled = await transport.send({ ...request, category: "slow", variant: "cancel", method: "GET", path: "/slow" }, null, evidence,
      { read: async () => ({ requests: slowReached ? 1 : 0 }) });
    assert.equal(cancelled.status, 0); assert.equal(cancelled.error, "cancelled");
    for (let i = 0; i < 100 && !slowClosed; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(slowClosed, true, "native cancellation must actually close the HTTP client connection");
    assert.ok(!/SESSION-SECRET|CSRF-SECRET|ACTION-SECRET|SCRIPT-SECRET|META-SECRET|NONCE-SECRET/.test(JSON.stringify({ evidence, binding })));
    const context = await browser.newContext({ javaScriptEnabled: false }), page = await context.newPage();
    try {
      await page.goto(base + request.formPage);
      await page.locator("form").evaluate((form) => {
        form.setAttribute("data-opaque", "DATA-SECRET");
        form.insertAdjacentHTML("beforeend", '<!-- COMMENT-SECRET --><input name="unrelated" value="FIELD-SECRET"><textarea>TEXTAREA-SECRET</textarea><template><input value="TEMPLATE-SECRET"></template>');
      });
      const raw = await page.evaluate(nativeForm); assert.equal(raw.data.find(([name]) => name === "csrf")[1], "CSRF-SECRET");
      const redacted = await page.evaluate(redactedDocument);
      assert.ok(!/CSRF-SECRET|ACTION-SECRET|SCRIPT-SECRET|META-SECRET|NONCE-SECRET|DATA-SECRET|COMMENT-SECRET|FIELD-SECRET|TEXTAREA-SECRET|TEMPLATE-SECRET/.test(redacted));
      await assert.rejects(transport.snapshot(response, request, evidence));
      assert.ok(evidence.redactedNativeDOM.includes("marketplace__alert"), "a failed extractor must retain the redacted native document");
      await page.locator("form").evaluate((form) => { form.action = "https://foreign.test/submit"; });
      const foreign = await page.evaluate(nativeForm); assert.throws(() => localURL(foreign.action, base));
    } finally { await context.close(); }
  } finally { await transport.close(); await browser.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
