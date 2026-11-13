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
  const server = spawn(process.execPath, [".output/server/index.mjs"], {
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

test("enhanced submission clears prior success and reports real upstream failure, then recovers", { timeout: 120000 }, async (t) => {
  await withApp(async ({ base, source }) => {
    const browser = await chromium.launch({ headless: true, args: ["--renderer-process-limit=2"] });
    try {
      for (const locale of ["en-US", "fr-FR", "de-DE"]) await t.test(locale, async () => {
        source("healthy");
        const context = await browser.newContext();
        try {
          const page = await context.newPage(), errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await context.request.get(base + "/api/alerts");
          await page.goto(base + `/marketplace/${locale}/item_1`);
          await page.waitForFunction(() => window.__hydratedAt !== undefined);
          const form = page.locator(".marketplace__alert form"), message = page.locator(".marketplace__message");
          const submit = async (email) => {
            await form.locator('[name="email"]').fill(email);
            await form.locator('[name="target_price"]').fill(locale === "en-US" ? "1.25" : "1,25");
            const posted = page.waitForResponse((response) => response.request().method() === "POST");
            await form.locator('button[type="submit"]').click();
            return posted;
          };
          assert.equal((await submit("first@example.test")).status(), 200);
          await expect(message).toContainText("first@example.test");
          const previous = await message.textContent();
          const expected = [{ item_id: "item_1", email: "first@example.test", target_minor: 125 }];
          source("down");
          const failed = await submit("failed@example.test");
          assert.equal(failed.status(), 500);
          assert.notEqual(failed.request().resourceType(), "document");
          await expect(message).not.toHaveText(previous, { timeout: 15000 });
          const failures = { "en-US": "Alert request failed. Please try again.",
            "fr-FR": "La demande d'alerte a échoué. Réessayez.",
            "de-DE": "Die Alarmanfrage ist fehlgeschlagen. Bitte erneut versuchen." };
          await expect(message).toHaveText(failures[locale]);
          assert.deepEqual(await (await context.request.get(base + "/api/alerts")).json(), expected);
          assert.deepEqual(errors, []);
          source("healthy");
          assert.equal((await submit("recovered@example.test")).status(), 200);
          await expect(message).toContainText("recovered@example.test");
          expected.push({ item_id: "item_1", email: "recovered@example.test", target_minor: 125 });
          assert.deepEqual(await (await context.request.get(base + "/api/alerts")).json(), expected);
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
});
