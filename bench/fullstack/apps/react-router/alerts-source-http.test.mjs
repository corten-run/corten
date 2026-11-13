// Build this native app first, then run node --test alerts-source-http.test.mjs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, expect } from "@playwright/test";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function withApp(run) {
  const calls = [];
  let mode = "healthy";
  const upstream = createServer((request, response) => {
    const id = decodeURIComponent(request.url.split("/").at(-1));
    calls.push(id);
    response.setHeader("Content-Type", "application/json");
    if (mode === "down" || id === "failed" || (mode === "once" && calls.length > 1)) {
      response.writeHead(503).end('{"error":"unavailable"}'); return;
    }
    if (id === "malformed") { response.end('{"id":"malformed"}'); return; }
    response.end(JSON.stringify({ id, title: "Synthetic " + id, subtitle: null, description: "",
      categories: [], badges: [], tags: [], images: [], fields: [], summary: null,
      listings: [], offers: [], contents: [], included_in: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${await freePort()}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: fileURLToPath(new URL(".", import.meta.url)), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production", NODE_OPTIONS: "--max-old-space-size=1024",
      HOST: "127.0.0.1", HOSTNAME: "127.0.0.1", PORT: new URL(base).port,
      MARKETPLACE_SOURCE: "http", API_BASE: `http://127.0.0.1:${upstream.address().port}` },
  });
  const exited = once(server, "exit");
  let log = "";
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (chunk) => log = (log + chunk).slice(-16000));
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      assert.equal(server.exitCode, null, log);
      try {
        const response = await fetch(base + "/api/alerts", { signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer();
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, log);
    await run({ base, calls, source: (value) => { mode = value; calls.length = 0; } });
  } catch (error) {
    throw new Error(error.message + "; native server log: " + log, { cause: error });
  } finally {
    if (server.exitCode === null && server.signalCode === null) server.kill();
    await exited;
    await new Promise((resolve) => upstream.close(resolve));
  }
}
function client(base) {
  const jar = new Map();
  return async (path, options = {}) => {
    const response = await fetch(base + path, { ...options, redirect: "manual",
      headers: { Accept: "text/html", Cookie: [...jar].map(([key, value]) => key + "=" + value).join("; "), ...options.headers },
      signal: AbortSignal.timeout(15000) });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";"), equals = pair.indexOf("=");
      jar.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
    return response;
  };
}

test("plain POST uses its validated action record for the same request's loader", { timeout: 45000 }, async () => {
  await withApp(async ({ base, calls, source }) => {
    const request = client(base);
    assert.deepEqual(await (await request("/api/alerts")).json(), []);
    source("once");
    const response = await request("/marketplace/en-US/item_1", {
      method: "POST", headers: { Origin: base },
      body: new URLSearchParams({ email: "plain@example.test", target_price: "1.25" }),
    });
    const body = await response.text();
    const rows = await (await request("/api/alerts")).json();
    assert.equal(response.status, 200, JSON.stringify({ calls, rows, body: body.slice(0, 200) }));
    assert.ok(body.includes("plain@example.test"));
    assert.deepEqual(rows, [{ item_id: "item_1", email: "plain@example.test", target_minor: 125 }]);
    assert.deepEqual(calls, ["item_1"], "no second source fetch inside the same POST");
    const later = await request("/marketplace/en-US/item_1");
    assert.equal(later.status, 500, "an independent GET must still fetch the failing source");
    await later.arrayBuffer();
    assert.deepEqual(await (await request("/api/alerts")).json(), rows, "a later read failure cannot roll back a successful POST");
  });
});
test("non-POST actions and source failures do not append alerts", { timeout: 45000 }, async (t) => {
  await withApp(async ({ base, calls, source }) => {
    for (const method of ["PUT", "PATCH", "DELETE"]) await t.test(method, async () => {
      const request = client(base);
      assert.deepEqual(await (await request("/api/alerts")).json(), []);
      source("healthy");
      const response = await request("/marketplace/en-US/item_1", {
        method, headers: { Origin: base },
        body: new URLSearchParams({ email: "unsafe@example.test", target_price: "1.25" }),
      });
      await response.arrayBuffer();
      assert.deepEqual(await (await request("/api/alerts")).json(), []);
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "GET, HEAD, POST");
      assert.deepEqual(calls, [], "reject the method before reading the source or form");
      const malformed = await request("/marketplace/en-US/item_1", {
        method, headers: { Origin: base, "Content-Type": "application/json" }, body: "{",
      });
      await malformed.arrayBuffer();
      assert.equal(malformed.status, 405, "reject before attempting form parsing");
      assert.deepEqual(await (await request("/api/alerts")).json(), []);
      assert.deepEqual(calls, []);
    });
    source("healthy");
    for (const id of ["failed", "malformed"]) await t.test(id, async () => {
      const request = client(base);
      assert.deepEqual(await (await request("/api/alerts")).json(), []);
      const response = await request("/marketplace/en-US/" + id, {
        method: "POST", headers: { Origin: base },
        body: new URLSearchParams({ email: "failure@example.test", target_price: "1.25" }),
      });
      assert.equal(response.status, 500);
      await response.arrayBuffer();
      assert.deepEqual(await (await request("/api/alerts")).json(), []);
    });
  });
});
test("enhanced POST success remains committed when native GET revalidation subsequently fails", { timeout: 60000 }, async () => {
  await withApp(async ({ base, calls, source }) => {
    const browser = await chromium.launch({ headless: true, args: ["--renderer-process-limit=2"] });
    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await context.request.get(base + "/api/alerts");
        await page.goto(base + "/marketplace/en-US/item_1");
        await page.waitForFunction(() => window.__hydratedAt !== undefined);
        source("once");
        const form = page.locator(".marketplace__alert form");
        await form.locator('[name="email"]').fill("enhanced@example.test");
        await form.locator('[name="target_price"]').fill("1.25");
        const posted = page.waitForResponse((response) => response.request().method() === "POST");
        const revalidated = page.waitForResponse((response) => response.request().method() === "GET" && response.url().includes(".data"));
        await form.locator('button[type="submit"]').click();
        const post = await posted, revalidation = await revalidated;
        assert.equal(post.status(), 200);
        assert.notEqual(post.request().resourceType(), "document");
        assert.equal(revalidation.status(), 500);
        await expect(page.locator("body")).toContainText("Application Error", { timeout: 15000 });
        assert.deepEqual(await (await context.request.get(base + "/api/alerts")).json(),
          [{ item_id: "item_1", email: "enhanced@example.test", target_minor: 125 }]);
        assert.deepEqual(calls, ["item_1", "item_1"], "the later native GET revalidation is real work, not a POST rollback");
      } finally { await context.close(); }
    } finally { await browser.close(); }
  });
});
