// Browser-primitive apparatus tests only, never native contender captures.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { installResourceObserver } from "./resources.mjs";

test("observer subscriptions retain every native target and follow unobserve/disconnect exactly", { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(); await context.addInitScript(installResourceObserver);
    try {
      const page = await context.newPage();
      await page.goto('data:text/html,<article class="marketplace" id="a"></article><article class="marketplace" id="b"></article>');
      for (const kind of ["ResizeObserver", "IntersectionObserver", "MutationObserver"]) {
        assert.equal(await page.evaluate((kind) => { try { new globalThis[kind](null); return null; } catch (error) { return error.name; } }, kind), "TypeError");
        await page.evaluate((kind) => {
          const a = document.getElementById("a"), b = document.getElementById("b");
          globalThis.nativeObserver = new globalThis[kind](() => {});
          for (const target of [a, b, a]) nativeObserver.observe(target, kind === "MutationObserver" ? { attributes: true } : {});
        }, kind);
        const counts = () => page.evaluate(() => __fullstackBrowserAudit.checkpoint().scopes.filter((s) => s.connected).map((s) => s.owned.subscriptions));
        assert.deepEqual(await counts(), [1, 1], kind);
        if (kind !== "MutationObserver") {
          await page.evaluate(() => nativeObserver.unobserve(document.getElementById("b")));
          assert.deepEqual(await counts(), [1, 0], kind);
          await page.evaluate(() => nativeObserver.unobserve(document.getElementById("a")));
          assert.deepEqual(await counts(), [0, 0], kind);
          await page.evaluate(() => nativeObserver.observe(document.getElementById("a")));
          assert.deepEqual(await counts(), [1, 0], kind);
        }
        await page.evaluate(() => nativeObserver.disconnect()); assert.deepEqual(await counts(), [0, 0], kind);
      }
      for (const mixed of [false, true]) {
        await page.evaluate((mixed) => new Promise((resolve) => {
          const a = document.getElementById("a"), b = document.getElementById("b");
          globalThis.nativeObserver = new MutationObserver(() => {
            globalThis.callbackTimer = setInterval(() => {}, 10000); resolve();
          });
          nativeObserver.observe(a, { attributes: true }); nativeObserver.observe(b, { attributes: true });
          a.setAttribute("data-probe", String(mixed));
          if (mixed) b.setAttribute("data-probe", String(mixed));
        }), mixed);
        const snapshot = await page.evaluate(() => __fullstackBrowserAudit.checkpoint());
        assert.deepEqual(snapshot.scopes.filter((s) => s.connected).map((s) => s.owned.timers), mixed ? [0, 0] : [1, 0]);
        assert.equal(snapshot.unattributed.timers, mixed ? 1 : 0);
        await page.evaluate(() => { clearInterval(callbackTimer); nativeObserver.disconnect(); });
      }
    } finally { await context.close(); }
  } finally { await browser.close(); }
});
