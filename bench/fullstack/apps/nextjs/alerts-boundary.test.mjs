// Build the six native apps first. Run with node --test --test-concurrency=1 alerts-boundary.test.mjs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium, expect } from "@playwright/test";

const commands = {
  nextjs: ["server.mjs"], nuxt: [".output/server/index.mjs"], "react-router": ["server.mjs"],
  sveltekit: ["build"], astro: ["--import", "./dist/server/virtual_astro_middleware.mjs", "dist/server/entry.mjs"],
  "tanstack-start": [".output/server/index.mjs"],
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function withApp(app, run) {
  const state = { field: null, value: "", delay: 0, failed: false }, calls = [];
  const upstream = createServer(async (request, response) => {
    calls.push(request.url);
    const record = { id: "item_1", title: "Synthetic item", subtitle: null, description: "",
      categories: [], badges: [], tags: [], images: [], fields: [], summary: null,
      listings: [], offers: [], contents: [], included_in: [] };
    if (state.field === "id") record.id = state.value;
    else if (state.field) record[state.field] = [{ id: "line_1", item_id: state.value, title: "Synthetic link", quantity: 1 }];
    const failed = state.failed;
    await sleep(state.delay);
    response.setHeader("Content-Type", "application/json");
    response.writeHead(failed ? 503 : 200).end(JSON.stringify(failed ? { error: "Unavailable" } : record));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const socket = createServer();
  await new Promise((resolve) => socket.listen(app === "sveltekit" ? 20133 : 0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const base = "http://127.0.0.1:" + port;
  const server = spawn(process.execPath, commands[app], {
    cwd: fileURLToPath(new URL("../" + app + "/", import.meta.url)), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production", NODE_OPTIONS: "--max-old-space-size=1024",
      HOST: "127.0.0.1", HOSTNAME: "127.0.0.1", PORT: String(port), ORIGIN: base,
      MARKETPLACE_SOURCE: "http", API_BASE: "http://127.0.0.1:" + upstream.address().port },
  });
  const exited = once(server, "exit");
  let log = "";
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (chunk) => log = (log + chunk).slice(-6000));
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      assert.equal(server.exitCode, null, log);
      try {
        // This readiness client's cookie is discarded, never shared with a test client or browser.
        const response = await fetch(base + "/api/alerts", { signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer();
        if (response.ok) { ready = true; break; }
      } catch {}
      await sleep(100);
    }
    assert.ok(ready, log);
    await run({ base, state, calls });
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
      const pair = cookie.split(";")[0], equals = pair.indexOf("=");
      jar.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
    return response;
  };
}
for (const app of Object.keys(commands)) test(app + ": render-sensitive links fail before any plain POST write", { timeout: 90000 }, async () => {
  await withApp(app, async ({ base, state, calls }) => {
    const request = client(base), expected = [];
    assert.deepEqual(await (await request("/api/alerts")).json(), []);
    for (const locale of ["en-US", "fr-FR", "de-DE"]) {
      const post = (email) => request("/marketplace/" + locale + "/item_1", { method: "POST",
        headers: { Origin: base }, body: new URLSearchParams({ email, target_price: locale === "en-US" ? "1.25" : "1,25" }) });
      for (const field of ["contents", "included_in", "id"]) for (const value of ["\ud800", "\udc00"]) {
        state.field = field; state.value = value;
        for (let attempt = 0; attempt < 2; attempt++) {
          calls.length = 0;
          const response = await post("failed@example.test");
          await response.arrayBuffer();
          const rows = await (await request("/api/alerts")).json();
          assert.deepEqual(rows, expected, JSON.stringify({ app, locale, field, value, attempt, status: response.status, rows }));
          assert.equal(response.status, 500, JSON.stringify({ app, locale, field, value, attempt }));
          assert.equal(calls.length, 1, "one native source fetch per plain POST, including failed preparation");
        }
      }
      state.field = "contents"; state.value = "item/\ud83d\ude00";
      calls.length = 0;
      const response = await post("valid@example.test");
      assert.equal(response.status, 200);
      assert.ok((await response.text()).includes("item%2F%F0%9F%98%80"), "valid Unicode link remains natively encoded");
      expected.push({ item_id: "item_1", email: "valid@example.test", target_minor: 125 });
      assert.deepEqual(await (await request("/api/alerts")).json(), expected);
      assert.equal(calls.length, 1);
    }
  });
});

for (const app of ["nextjs", "tanstack-start"]) test(app + ": fresh native JS form serializes first submissions without readback prewarm", { timeout: 60000 }, async () => {
  await withApp(app, async ({ base, state, calls }) => {
    const browser = await chromium.launch({ headless: true, args: ["--renderer-process-limit=2"] });
    try {
      const context = await browser.newContext();
      try {
        const page = await context.newPage(), posts = [], replies = [], errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          if (request.method() === "POST") posts.push(request);
        });
        page.on("response", (response) => {
          if (response.request().method() === "POST") replies.push(response.status());
        });
        assert.equal((await page.goto(base + "/marketplace/en-US/item_1")).status(), 200);
        await page.waitForFunction(() => window.__hydratedAt !== undefined || window.next?.router?.isReady === true,
          undefined, { timeout: 15000 });
        assert.equal((await context.cookies()).filter((cookie) => cookie.name.includes("alert")).length, 0);
        const form = page.locator(".marketplace__alert form"), button = form.locator('button[type="submit"]');
        const message = page.locator(".marketplace__message");
        const fill = async (email) => {
          await form.locator('[name="email"]').fill(email);
          await form.locator('[name="target_price"]').fill("1.25");
        };
        state.delay = 300; calls.length = 0;
        await fill("first@example.test");
        const firstPost = page.waitForRequest((request) => request.method() === "POST");
        await button.click(); await firstPost;
        await sleep(50); // The reported race window, with a real delayed upstream.
        await expect(button).toBeDisabled();
        await fill("second@example.test");
        await button.click();
        await expect(message).toContainText("second@example.test", { timeout: 15000 });
        const expected = ["first@example.test", "second@example.test"].map((email) =>
          ({ item_id: "item_1", email, target_minor: 125 }));
        const rows = await (await context.request.get(base + "/api/alerts")).json();
        const probes = await Promise.all(posts.map(async (request) => ({
          type: request.resourceType(), hasAlertCookie: /(?:nextjs|tanstack_start)_alerts=/.test((await request.allHeaders()).cookie ?? ""),
        })));
        assert.deepEqual(rows, expected, JSON.stringify({ posts: probes, replies, rows }));
        assert.deepEqual(replies, [200, 200]);
        assert.equal(probes[0].hasAlertCookie, false);
        assert.equal(probes[1].hasAlertCookie, true, "second request must carry the first native response's session cookie");
        assert.ok(probes.every((post) => post.type !== "document"), JSON.stringify(probes));
        assert.equal(calls.length, 2, "one real upstream fetch for each native enhanced POST");
        await expect(button).toBeEnabled();
        state.delay = 0;
        for (const failure of ["invalid-link", "upstream"]) {
          state.failed = failure === "upstream";
          state.field = failure === "invalid-link" ? "contents" : null;
          state.value = "\ud800";
          await fill("failed@example.test");
          const failedPost = page.waitForResponse((response) => response.request().method() === "POST");
          await button.click();
          const failed = await failedPost;
          if (app === "nextjs") {
            assert.equal(failed.status(), 502);
            assert.deepEqual(await failed.json(), { error: "marketplace source failed" });
          } else {
            // Native TanStack server functions serialize action errors in a 200 envelope.
            const wire = await failed.text();
            assert.equal(failed.status(), 200, wire);
            assert.equal(failed.headers()["x-tss-serialized"], "true", wire);
            assert.match(wire, /"error"/, wire);
          }
          await expect(message).not.toContainText("second@example.test", { timeout: 15000 });
          await expect(message).not.toBeEmpty();
          await expect(button).toBeEnabled();
          assert.deepEqual(await (await context.request.get(base + "/api/alerts")).json(), expected);
        }
        state.failed = false; state.field = null;
        await fill("recovered@example.test"); await button.click();
        await expect(message).toContainText("recovered@example.test", { timeout: 15000 });
        expected.push({ item_id: "item_1", email: "recovered@example.test", target_minor: 125 });
        assert.deepEqual(await (await context.request.get(base + "/api/alerts")).json(), expected);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    } finally { await browser.close(); }
  });
});
