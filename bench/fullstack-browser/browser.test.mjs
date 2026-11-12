// Apparatus integration only. This minimal HTTP fixture is NOT a contender,
// renderer, oracle capture or claim of application/native-framework parity.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { readStore, semanticSignature, waitForSemanticChange } from "./journey.mjs";
import { mutationProbes } from "./probes.mjs";
import { installResourceObserver, ResourceAudit } from "./resources.mjs";

test("independent cookie readback and CSP-safe semantic observation", { timeout: 30000 }, async () => {
  const stores = new Map();
  const server = createServer(async (req, res) => {
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'none'; form-action 'self'");
    const cookie = /session=([a-f0-9-]+)/.exec(req.headers.cookie ?? "")?.[1];
    if (req.url === "/api/alerts") {
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(stores.get(cookie) ?? [])); return;
    }
    if (req.method === "POST") {
      if (req.headers["sec-fetch-site"] === "cross-site" || req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403); res.end("Forbidden"); return; }
      if (req.url.endsWith("/item_missing")) { res.writeHead(404); res.end("Not found"); return; }
      let body = ""; for await (const p of req) body += p;
      const values = new URLSearchParams(body), id = cookie ?? randomUUID();
      const rows = stores.get(id) ?? [];
      if (values.get("email")?.includes("@") && values.get("target_price") === "1.25") rows.push({ item_id: "item_2", email: values.get("email"), target_minor: 125 });
      stores.set(id, rows); res.setHeader("set-cookie", `session=${id}; HttpOnly; SameSite=Lax; Path=/`);
    }
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><article class="marketplace"><h1>${req.method === "POST" ? "Submitted" : "Ready"}</h1><div class="marketplace__alert"><form method="post" action="/marketplace/en-US/item_1"><input name="email"><input name="target_price"><input type="hidden" name="csrf" value="SECRET"><button>Submit</button></form></div></article>`);
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
      const probes = await mutationProbes({ browser, context, page, base, profile: { key: "apparatus", steps: [{ kind: "accepted-write", input: { target_price: "1.25" } }, { itemId: "item_1" }] }, readback: store });
      assert.deepEqual(probes.failures, []); assert.deepEqual(probes.attempts.map((p) => p.status), [403, 403, 404]);
      assert.ok(probes.attempts.every((p) => JSON.stringify(p.readback.alerts) === JSON.stringify(accepted)));
      assert.ok(!JSON.stringify(probes).includes("SECRET"));
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

test("resource audit observes real retirement, leaked callbacks/timers, and destroyed realms", { timeout: 60000 }, async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><header><a href="/">Away</a></header><article class="marketplace"><h1>Before</h1><button>Start</button></article><script>
      const root = document.querySelector('article'), button = root.querySelector('button'); let timer;
      const callback = () => { root.dataset.calls = String(Number(root.dataset.calls || 0) + 1); timer ??= setInterval(() => { root.dataset.tick = String(Date.now()); }, 30); };
      button.addEventListener('click', callback);
      const observer = new MutationObserver(() => {}); observer.observe(root, { attributes: true });
      ${req.url === "/opaque" ? "window.addEventListener('opaque-page-event', () => {});" : ""}
      document.querySelector('header a').addEventListener('click', event => { event.preventDefault();
        ${req.url !== "/leak" ? "button.removeEventListener('click', callback); clearInterval(timer); observer.disconnect();" : ""}
        root.remove(); document.body.append(document.createElement('main'));
      });
    </script>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const path of ["/clean", "/leak", "/opaque"]) {
      const context = await browser.newContext(); await context.addInitScript(installResourceObserver);
      try {
        const page = await context.newPage(), cdp = await context.newCDPSession(page);
        const audit = new ResourceAudit(page, cdp, true); await cdp.send("Runtime.enable");
        const baseline = await audit.checkpoint(); assert.ok(baseline.scopes.every((s) => Object.values(s.owned).every((n) => n === 0)));
        await page.goto(`http://127.0.0.1:${server.address().port}${path}`); await page.getByRole("button", { name: "Start" }).click();
        const before = await audit.checkpoint(); const owned = before.scopes.find((s) => s.scope === before.scope).owned;
        assert.equal(owned.listeners, 1); assert.equal(owned.timers, 1); assert.equal(owned.subscriptions, 1);
        const cleanup = await audit.cleanup({ timeoutMs: 15000, observationMs: 100, network: { rows: [], drain: async () => {} }, runtimeErrors: [] });
        if (path === "/clean") { assert.equal(cleanup.outcome, "observed", JSON.stringify(cleanup)); assert.equal(cleanup.probe.beforeSha256, cleanup.probe.afterSha256); }
        else if (path === "/leak") { assert.equal(cleanup.outcome, "failed"); assert.ok(cleanup.probe.owned.listeners > 0 && cleanup.probe.owned.timers > 0); assert.notEqual(cleanup.probe.beforeSha256, cleanup.probe.immediateSha256); }
        else { assert.equal(cleanup.outcome, "failed"); assert.ok(cleanup.after.unattributed.listeners > 0); assert.match(cleanup.failures.join(" "), /Unattributed native resources/); }
        await page.goto(`http://127.0.0.1:${server.address().port}/clean`);
        const previous = await audit.checkpoint(); await page.reload(); const next = await audit.checkpoint();
        const retired = audit.retired(previous, next);
        assert.equal(retired.owned, null); assert.equal(retired.probeAvailable, false); assert.ok(next.nativeContextEvents.length);
      } finally { await context.close(); }
    }
    const disabled = await browser.newContext({ javaScriptEnabled: false });
    try {
      await disabled.addInitScript(installResourceObserver); const page = await disabled.newPage(); const cdp = await disabled.newCDPSession(page);
      const audit = new ResourceAudit(page, cdp, false); await page.goto(`http://127.0.0.1:${server.address().port}/clean`);
      const snapshot = await audit.checkpoint(); assert.equal(snapshot.scriptExecutionEnabled, false);
      assert.ok(snapshot.scopes.every((s) => Object.values(s.owned).every((n) => n === 0)));
    } finally { await disabled.close(); }
  } finally { if (browser) await browser.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});
