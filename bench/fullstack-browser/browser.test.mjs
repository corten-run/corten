// Apparatus integration only. This minimal HTTP fixture is NOT a contender,
// renderer, oracle capture or claim of application/native-framework parity.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { readStore, semanticSignature, waitForSemanticChange } from "./journey.mjs";

test("independent cookie readback and CSP-safe semantic observation", { timeout: 30000 }, async () => {
  const stores = new Map();
  const server = createServer(async (req, res) => {
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'none'; form-action 'self'");
    const cookie = /session=([a-f0-9-]+)/.exec(req.headers.cookie ?? "")?.[1];
    if (req.url === "/api/alerts") {
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(stores.get(cookie) ?? [])); return;
    }
    if (req.method === "POST") {
      let body = ""; for await (const p of req) body += p;
      const values = new URLSearchParams(body), id = cookie ?? randomUUID();
      const rows = stores.get(id) ?? [];
      if (values.get("email")?.includes("@") && values.get("target_price") === "1.25") rows.push({ item_id: "item_2", email: values.get("email"), target_minor: 125 });
      stores.set(id, rows); res.setHeader("set-cookie", `session=${id}; HttpOnly; SameSite=Lax; Path=/`);
    }
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><article class="marketplace"><h1>${req.method === "POST" ? "Submitted" : "Ready"}</h1><form method="post"><input name="email"><input name="target_price"><button>Submit</button></form></article>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ javaScriptEnabled: false });
    const other = await browser.newContext({ javaScriptEnabled: false });
    const store = { path: "/api/alerts" };
    try {
      const page = await context.newPage(); await page.goto(base);
      assert.deepEqual((await readStore(base, store, context.request)).alerts, []);
      const submit = async (email, price) => {
        await page.locator('[name="email"]').fill(email); await page.locator('[name="target_price"]').fill(price);
        await page.getByRole("button", { name: "Submit" }).click();
      };
      await submit("browser@example.test", "1.25");
      const accepted = (await readStore(base, store, context.request)).alerts;
      assert.deepEqual(accepted, [{ item_id: "item_2", email: "browser@example.test", target_minor: 125 }]);
      assert.deepEqual((await readStore(base, store, other.request)).alerts, []);
      await submit("invalid-email", "1.25"); assert.deepEqual((await readStore(base, store, context.request)).alerts, accepted);
      await submit("browser@example.test", "0"); assert.deepEqual((await readStore(base, store, context.request)).alerts, accepted);
    } finally { await context.close(); await other.close(); }
    const csp = await browser.newContext({ javaScriptEnabled: true });
    try {
      const page = await csp.newPage(); await page.goto(base);
      const before = await page.evaluate(semanticSignature);
      await page.getByRole("button", { name: "Submit" }).click();
      await waitForSemanticChange(page, before);
      assert.match(await page.locator("h1").innerText(), /^Submitted$/);
    } finally { await csp.close(); }
  } finally {
    if (browser) await browser.close(); server.closeAllConnections(); await new Promise((r) => server.close(r));
  }
});
