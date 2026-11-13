import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";
import { records } from "./fixtures.mjs";
import { expectedPage, labels } from "./records.mjs";
import { alertResponse, alignNumberSpaces, comparePage, compareStyles, liveViewAlertEvent, liveViewAlertReply, navigationFinished, numericFields, numericText, observeAlertTransport, snapshotPage, styleSnapshot, submitAlert, verifyNumberSpaces } from "./check.mjs";
import { referenceHtml } from "./reference.mjs";

test("LiveView form frames require the native root, origin, V2 types and exact unique fields", () => {
  const action = "https://localhost/marketplace/fr-FR/item_1", socket = "wss://localhost/live/websocket?vsn=2.0.0";
  const fields = [["_csrf_token", "native"], ["email", "a+<&@example.test"], ["target_price", "1234,50"]];
  const frame = ["1", "2", "lv:phx-alert", "event", { type: "form", event: "save", value: new URLSearchParams(fields).toString() }];
  const match = (value, url = socket, expected = fields, root = "phx-alert") => liveViewAlertEvent(value, url, action, expected, root);
  assert.deepEqual(match(JSON.stringify(frame)), { joinRef: "1", ref: "2", topic: "lv:phx-alert" });
  for (const change of [
    (f) => { f[0] = null; }, (f) => { f[1] = 2; }, (f) => { f[1] = ""; }, (f) => { f[2] = "lv:other"; },
    (f) => { f[3] = "phx_join"; }, (f) => { f[4].type = "click"; }, (f) => { f[4].event = "change"; },
    (f) => { f[4].value = {}; }, (f) => { f[4].value += "&email=other"; },
    (f) => { f[4].value += "&target_price=1234%2C50"; }, (f) => { f[4].value += "&extra=1"; },
    (f) => { f[4].value += "&_csrf_token=native"; },
    (f) => { f[4].value = "email=a&target_price=1234%2C50"; },
    (f) => { f[4].value = new URLSearchParams(fields.slice(0, 2)).toString(); },
    (f) => { f[4].value = new URLSearchParams([fields[0], ["email", "other@example.test"], fields[2]]).toString(); },
    (f) => { f[4].value = new URLSearchParams([...fields.slice(0, 2), ["target_price", "1"]]).toString(); },
    (f) => { f[4].value = new URLSearchParams([["_csrf_token", "other"], ...fields.slice(1)]).toString(); },
    (f) => { f.push("extra"); }, (f) => { f[4] = null; }, (f) => { f[4] = []; },
  ]) { const changed = structuredClone(frame); change(changed); assert.equal(match(JSON.stringify(changed)), null); }
  for (const value of ["{", "null", "{}", "[]", JSON.stringify({ ...frame }), Buffer.from(JSON.stringify(frame))]) assert.equal(match(value), null);
  for (const url of ["wss://foreign.example/live/websocket?vsn=2.0.0", "ws://localhost/live/websocket?vsn=2.0.0",
    "wss://localhost:123/live/websocket?vsn=2.0.0", "wss://localhost/other/websocket?vsn=2.0.0",
    "wss://localhost/live/websocket?vsn=1.0.0", "wss://localhost/live/websocket", "wss://localhost/live/websocket?vsn=2.0.0&vsn=2.0.0", "bad URL"])
    assert.equal(match(JSON.stringify(frame), url), null);
  for (const root of [null, "", "phx-other"]) assert.equal(match(JSON.stringify(frame), socket, fields, root), null);
  assert.equal(match(JSON.stringify(frame), socket, [...fields, fields[1]]), null);
});

test("LiveView success replies require the saved frame's join ref, ref and topic", () => {
  const sent = { joinRef: "1", ref: "2", topic: "lv:phx-alert" };
  const reply = ["1", "2", "lv:phx-alert", "phx_reply", { status: "ok", response: { diff: {} } }];
  assert.equal(liveViewAlertReply(JSON.stringify(reply), sent), true);
  for (const change of [
    (f) => { f[0] = "other"; }, (f) => { f[1] = "other"; }, (f) => { f[2] = "lv:other"; },
    (f) => { f[0] = 1; }, (f) => { f[1] = 2; }, (f) => { f[3] = "diff"; },
    (f) => { f[4].status = "error"; }, (f) => { delete f[4].response; }, (f) => { f[4].response = []; },
    (f) => { f[4].response = null; }, (f) => { f.push("extra"); },
  ]) { const changed = structuredClone(reply); change(changed); assert.equal(liveViewAlertReply(JSON.stringify(changed), sent), false); }
  for (const value of ["{", "null", "{}", Buffer.from(JSON.stringify(reply))]) assert.equal(liveViewAlertReply(value, sent), false);
  assert.equal(liveViewAlertReply(JSON.stringify(reply), null), false);
});

for (const unrelated of [false, true]) test(`native LiveView save ${unrelated ? "rejects an unrelated reply despite a changed message" : "uses the existing socket without a POST or document reload"}`, { timeout: 25000 }, async () => {
  // Use Playwright's existing ws server, not a mocked browser WebSocket.
  const { wsServer } = createRequire(import.meta.url)("playwright-core/lib/utilsBundle");
  const server = createServer((req, res) => res.end(`<div id="phx-alert" data-phx-session="fixture"><section class="marketplace__alert">
    <form method="post" phx-submit="save"><input name="_csrf_token" type="hidden" value="fixture">
    <input name="email" value="native@example.test"><input name="target_price" value="1234,50"><button type="submit">Send</button></form>
    <p class="marketplace__message"></p></section></div><script>
    const socket = new WebSocket('ws://' + location.host + '/live/websocket?vsn=2.0.0');
    socket.onopen = () => document.querySelector('[data-phx-session]').classList.add('phx-connected');
    socket.onmessage = () => document.querySelector('.marketplace__message').textContent = 'saved';
    document.querySelector('form').onsubmit = event => {
      event.preventDefault(); socket.send(JSON.stringify(['1', '2', 'lv:phx-alert', 'event', {
        type: 'form', event: 'save', value: new URLSearchParams(new FormData(event.target)).toString()
      }]));
    };
    </script>`));
  const sockets = new wsServer({ server });
  sockets.on("connection", (socket) => socket.on("message", () => socket.send(JSON.stringify(["1", unrelated ? "unrelated" : "2", "lv:phx-alert", "phx_reply", { status: "ok", response: {} }]))));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    observeAlertTransport(page);
    page.setDefaultTimeout(15000);
    let navigations = 0, posts = 0;
    page.on("framenavigated", () => navigations++);
    page.on("request", (req) => { if (req.method() === "POST") posts++; });
    await page.goto(`http://127.0.0.1:${server.address().port}/marketplace/fr-FR/item_1`);
    await page.waitForFunction(() => document.querySelector('[data-phx-session]').classList.contains('phx-connected'));
    if (unrelated) await assert.rejects(submitAlert(page, page.locator("form"), true), /LiveView alert phx_reply: Timeout 15000ms exceeded/);
    else await submitAlert(page, page.locator("form"), true);
    assert.equal(await page.locator(".marketplace__message").textContent(), "saved");
    assert.equal(navigations, 1); assert.equal(posts, 0);
  } finally {
    await browser.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
});

test("native generated form actions require same-origin exact submitted fields", async () => {
  const fields = { email: "native@example.test", target_price: "1234,50" }, action = "http://localhost/marketplace/fr-FR/item_1";
  const candidate = async (url = "http://localhost/_server/generated", edits = {}, marked = true) => {
    const data = new FormData();
    for (const [key, value] of Object.entries({ ...fields, locale: "fr-FR", item_id: "item_1", ...edits })) data.set(key, value);
    const native = new Request(url, { method: "POST", body: data, headers: marked ? { "x-tsr-serverfn": "true" } : {} });
    const body = Buffer.from(await native.arrayBuffer());
    return { url: () => url, request: () => ({ method: () => native.method,
      headers: () => Object.fromEntries(native.headers), postDataBuffer: () => body }) };
  };
  assert.equal(await alertResponse(await candidate(), action, fields), true);
  for (const row of [await candidate("http://foreign.example/_server/generated"), await candidate(undefined, {}, false),
    await candidate(undefined, { email: "other@example.test" }), await candidate(undefined, { target_price: "1" }),
    await candidate(undefined, { locale: "de-DE" }), await candidate(undefined, { item_id: "item_2" })]) {
    assert.equal(await alertResponse(row, action, fields), false);
  }
});

test("Leptos alert responses require the native endpoint and exact URL-encoded fields", async () => {
  const fields = { email: "native@example.test", target_price: "1234,50" }, action = "http://localhost/marketplace/fr-FR/item_1";
  const candidate = (url = "http://localhost/api/marketplace-alert", edits = {}, extra = "", method = "POST", type = "application/x-www-form-urlencoded") => {
    const body = new URLSearchParams({ ...fields, tag: "fr-FR", item_id: "item_1", ...edits }).toString() + extra;
    return { url: () => url, request: () => ({ method: () => method,
      headers: () => ({ "content-type": type }), postDataBuffer: () => Buffer.from(body) }) };
  };
  assert.equal(await alertResponse(candidate(), action, fields), true);
  for (const response of [candidate("http://foreign.example/api/marketplace-alert"), candidate("http://localhost/api/other"),
    candidate(undefined, { email: "other@example.test" }), candidate(undefined, { target_price: "1" }),
    candidate(undefined, { tag: "de-DE" }), candidate(undefined, { item_id: "item_2" }),
    candidate(undefined, {}, "&email=duplicate"), candidate(undefined, {}, "", "GET"),
    candidate(undefined, {}, "", "POST", "text/plain")]) {
    assert.equal(await alertResponse(response, action, fields), false);
  }
});

test("Livewire alert responses require the native component, save call and submitted fields", async () => {
  const fields = { email: "native@example.test", target_price: "1234,50" }, action = "http://localhost/marketplace/fr-FR/item_1";
  const component = () => ({ snapshot: JSON.stringify({ memo: { name: "marketplace-alert" }, data: { itemId: "item_1", locale: "fr-FR", email: "", target: "" } }),
    updates: { email: fields.email, target: fields.target_price }, calls: [{ method: "save", params: [], metadata: {} }] });
  const candidate = (change = () => {}, url = "http://localhost/livewire-bf5bed75/update", marked = true, type = "application/json", method = "POST") => {
    const payload = { components: [component()] }; change(payload);
    return { url: () => url, request: () => ({ method: () => method, headers: () => ({ "content-type": type, ...(marked ? { "x-livewire": "" } : {}) }),
      postDataBuffer: () => Buffer.from(JSON.stringify(payload)) }) };
  };
  assert.equal(await alertResponse(candidate(), action, fields), true);
  assert.equal(await alertResponse(candidate(() => {}, "http://localhost/livewire/update"), action, fields), true);
  assert.equal(await alertResponse(candidate((p) => {
    const snapshot = JSON.parse(p.components[0].snapshot);
    Object.assign(snapshot.data, { email: fields.email, target: fields.target_price });
    p.components[0].snapshot = JSON.stringify(snapshot); p.components[0].updates = {};
  }), action, fields), true, "unchanged native properties can remain in the component snapshot");
  for (const change of [
    (p) => { p.components[0].updates.email = "other@example.test"; },
    (p) => { p.components[0].updates.target = "1"; },
    (p) => { p.components[0].updates.itemId = "item_2"; },
    (p) => { p.components[0].snapshot = JSON.stringify({ memo: { name: "other" }, data: { itemId: "item_1", locale: "fr-FR" } }); },
    (p) => { p.components[0].snapshot = JSON.stringify({ memo: { name: "marketplace-alert" }, data: { itemId: "item_2", locale: "fr-FR" } }); },
    (p) => { p.components[0].snapshot = JSON.stringify({ memo: { name: "marketplace-alert" }, data: { itemId: "item_1", locale: "en-US" } }); },
    (p) => { p.components[0].calls[0].method = "other"; },
    (p) => { p.components[0].calls[0].params.push("unexpected"); },
    (p) => { p.components.push(component()); },
    (p) => { p.components[0].snapshot = "{"; },
  ]) assert.equal(await alertResponse(candidate(change), action, fields), false);
  for (const response of [candidate(() => {}, "http://foreign.example/livewire/update"), candidate(() => {}, "http://localhost/other/update"),
    candidate(() => {}, undefined, false), candidate(() => {}, undefined, true, "text/plain"), candidate(() => {}, undefined, true, undefined, "GET")])
    assert.equal(await alertResponse(response, action, fields), false);
});

test("native Leptos enhanced alert response is observed without changing the page action", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("http://localhost/**", (route) => route.fulfill({ contentType: route.request().method() === "POST" ? "application/json" : "text/html",
      body: route.request().method() === "POST" ? '"saved"' : '<form method="post"><input name="email" value="native@example.test"><input name="target_price" value="1"><input name="tag" value="en-US"><input name="item_id" value="item_1"><button type="submit">Send</button></form><p class="marketplace__message"></p>' }));
    await page.goto("http://localhost/marketplace/en-US/item_1");
    await page.evaluate(() => document.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = new URLSearchParams(new FormData(event.currentTarget));
      const response = await fetch("/api/marketplace-alert", { method: "POST", body });
      document.querySelector(".marketplace__message").textContent = await response.json();
    }));
    await submitAlert(page, page.locator("form"), true);
    assert.equal(await page.locator(".marketplace__message").textContent(), "saved");
  } finally { await browser.close(); }
});

test("native enhanced form posts to a generated endpoint without changing its plain form action", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("http://localhost/**", (route) => route.fulfill({ contentType: route.request().method() === "POST" ? "application/json" : "text/html",
      body: route.request().method() === "POST" ? '{"message":"saved"}' : '<form method="post"><input name="email" value="native@example.test"><input name="target_price" value="1"><button type="submit">Send</button></form><p class="marketplace__message"></p>' }));
    await page.goto("http://localhost/marketplace/en-US/item_1");
    await page.evaluate(() => document.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = new FormData(event.currentTarget); body.set("locale", "en-US"); body.set("item_id", "item_1");
      const response = await fetch("/_server/generated", { method: "POST", body, headers: { "x-tsr-serverfn": "true" } });
      document.querySelector(".marketplace__message").textContent = (await response.json()).message;
    }));
    await submitAlert(page, page.locator("form"), true);
    assert.equal(await page.locator(".marketplace__message").textContent(), "saved");
  } finally { await browser.close(); }
});

test("script-free alert POST checks the new document at the same URL", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.route("http://localhost/**", async (route) => {
      const post = route.request().method() === "POST";
      if (post) await new Promise((r) => setTimeout(r, 100));
      await route.fulfill({ contentType: "text/html", body: `<form method="post"><button type="submit">Send</button></form><p class="marketplace__message">${post ? "new result" : "old result"}</p>` });
    });
    await page.goto("http://localhost/marketplace/en-US/item_1");
    await submitAlert(page, page.locator("form"), false);
    assert.equal(await page.locator(".marketplace__message").textContent(), "new result");
  } finally { await browser.close(); }
});

test("alert failure retains the exact form case, response and original timeout", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    const html = '<form method="post"><input name="email" value="invalid"><input name="target_price" value="1"><button type="submit">Send</button></form><p class="marketplace__message"></p>';
    await page.route("http://localhost/**", (route) => route.fulfill({ status: route.request().method() === "POST" ? 500 : 200,
      contentType: "text/html", body: html + "server failure fixture" }));
    await page.goto("http://localhost/marketplace/en-US/item_1");
    // Exercise the missing-message deadline after the fixture POST, not click/navigation scheduling.
    page.on("response", (response) => { if (response.request().method() === "POST") page.setDefaultTimeout(500); });
    await assert.rejects(submitAlert(page, page.locator("form"), false), (error) => {
      assert.match(error.message, /Alert POST 500 .*JS=false; fields=.*invalid.*target_price.*1/);
      assert.match(error.message, /server failure fixture/);
      assert.match(error.message, /message=""/);
      assert.match(error.cause.message, /Timeout 500ms exceeded/);
      return true;
    });
  } finally { await browser.close(); }
});

test("unfinished alert response cannot hang failure diagnostics", { timeout: 10000 }, async () => {
  const html = '<form method="post"><input name="email" value="invalid"><button type="submit">Send</button></form><p class="marketplace__message"></p>';
  const server = createServer((req, res) => {
    res.writeHead(req.method === "POST" ? 500 : 200, { "content-type": "text/html" });
    if (req.method === "POST") res.write(html); else res.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/marketplace/en-US/item_1`);
    await page.evaluate(() => document.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); fetch(location.href, { method: "POST" }); }));
    page.on("response", (response) => { if (response.request().method() === "POST") page.setDefaultTimeout(500); });
    await assert.rejects(submitAlert(page, page.locator("form"), true), (error) => {
      assert.match(error.message, /Alert POST 500 .*unavailable: diagnostic timeout/);
      assert.match(error.cause.message, /Timeout 500ms exceeded/);
      return true;
    });
  } finally {
    await browser.close(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test("navigation waits for intercepted DOM work after URL commitment", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("http://localhost/**", (route) => route.fulfill({ contentType: "text/html", body: '<a href="?filtered=1">Filter</a><p>old</p>' }));
    await page.goto("http://localhost/marketplace/en-US/item_1");
    await page.evaluate(() => {
      navigation.addEventListener("navigate", (event) => event.intercept({ handler: async () => {
        await new Promise((resolve) => { globalThis.finishMarketplaceNavigation = resolve; });
        document.querySelector("p").textContent = "filtered";
      } }));
    });
    await Promise.all([page.waitForURL((url) => url.searchParams.get("filtered") === "1"), page.locator("a").click()]);
    assert.equal(await page.locator("p").textContent(), "old");
    await page.evaluate(() => { setTimeout(() => globalThis.finishMarketplaceNavigation(), 50); });
    await navigationFinished(page);
    assert.equal(await page.locator("p").textContent(), "filtered");
  } finally { await browser.close(); }
});
test("browser oracle rejects hidden work, missing sections, wrong control semantics and executed fixture HTML", { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(); const r = records().item_17;
  try {
    // A URL gives native form.action and location the same origin/path.
    await page.route("http://localhost/**", (route) => route.fulfill({ contentType: "text/html", body: referenceHtml(r, "fr-FR") }));
    await page.goto(`http://localhost/marketplace/fr-FR/${r.id}`);
    comparePage(await page.evaluate(snapshotPage), r, "fr-FR");
    for (const mutate of [
      () => { document.querySelector("tbody tr").hidden = true; },
      () => { document.querySelector(".marketplace__details").remove(); },
      () => { document.querySelector('[name="target_price"]').inputMode = "text"; },
      () => { document.querySelector(".marketplace__listings form").method = "post"; },
      () => { document.querySelector(".marketplace__offers tbody tr").cloneNode(true) && document.querySelector(".marketplace__offers tbody").append(document.querySelector(".marketplace__offers tbody tr").cloneNode(true)); },
      () => { globalThis.marketplaceInjected = true; },
    ]) {
      await page.reload(); await page.evaluate(mutate);
      await assert.rejects(async () => comparePage(await page.evaluate(snapshotPage), r, "fr-FR"));
    }
  } finally { await browser.close(); }
});
test("geometry permits only verified numeric spaces, not different content, markup or CSS", { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  const r = records().item_1, fields = numericFields(r, "fr-FR");
  const css = ["../fullstack/apps/axum-maud/static/style.css", "../fullstack/apps/axum-maud/static/components.css", "./marketplace.css"].map((p) => readFileSync(new URL(p, import.meta.url), "utf8")).join("\n");
  const html = referenceHtml(r, "fr-FR").replace("</head>", `<style>${css}</style></head>`);
  try {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      const page = await context.newPage(), reference = await context.newPage();
      try {
        const reset = async () => {
          await page.setContent(html); await reference.setContent(html);
          await page.evaluate((fields) => {
            for (const { selector } of fields) {
              const walker = document.createTreeWalker(document.querySelector(selector), NodeFilter.SHOW_TEXT);
              let node;
              while ((node = walker.nextNode())) node.data = node.data.replace(/[\u00a0\u202f]/g, " ");
            }
          }, fields);
        };
        const check = async () => {
          const numbers = verifyNumberSpaces(fields, await page.evaluate(numericText, fields));
          await reference.evaluate(alignNumberSpaces, { fields, numbers });
          compareStyles(await page.evaluate(styleSnapshot), await reference.evaluate(styleSnapshot));
        };
        await reset(); await check();
        await page.evaluate(() => {
          for (const el of document.querySelectorAll(".marketplace__contents li, .marketplace__included li")) {
            for (const node of el.childNodes) if (node.nodeType === Node.TEXT_NODE) node.data = node.data.replace(" × ", "\n  ×\n  ");
          }
        });
        await reference.setContent(html); await check();
        for (const mutate of [
          () => { document.querySelector(".marketplace__summary strong").textContent = "9,99 $US"; },
          () => { document.querySelector(".marketplace__summary strong").textContent = document.querySelector(".marketplace__summary strong").textContent.replace(" ", "  "); },
          () => { const el = document.querySelector(".marketplace__summary strong"); el.replaceWith(el.textContent); },
          () => { document.querySelector(".marketplace__listings td").style.padding = "20px"; },
          () => { document.querySelector(".marketplace__listings table").style.width = "2000px"; },
          () => { document.querySelector(".marketplace__listings table").style.fontSize = "20px"; },
        ]) {
          await reset(); await page.evaluate(mutate); await assert.rejects(check);
        }
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
});
