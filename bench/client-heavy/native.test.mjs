import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium } from "playwright";
import { journey, serve, qualifyAndMeasure } from "./run.mjs";
import { socketFixture } from "./socket-fixture.mjs";
import { selectedApps } from "../workloads/registry.mjs";

const directory = process.env.CLIENT_NATIVE_DIR;
test("all six native assets qualify and pass a separate measured journey", { skip: !directory && "Set CLIENT_NATIVE_DIR to a runner's native build directory", timeout: 180000 }, async (t) => {
  const dir = resolve(directory), workload = JSON.parse(await readFile(join(dir, "workload.json"), "utf8"));
  const server = await serve(dir);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const app of selectedApps("client-heavy")) await t.test(app, async () => {
      const calls = [];
      const result = await qualifyAndMeasure((phase) => {
        calls.push(phase);
        return journey(browser, server.url, app, workload, { maxCleanupMs: 2000, cleanupObservationMs: 100 }, 15000, undefined, phase === "measurement");
      });
      assert.deepEqual(calls, ["qualification", "measurement"], JSON.stringify(result.qualification.failure));
      assert.equal(result.readyForMeasurement, true, JSON.stringify(result.measurement?.failure));
      assert.equal(result.qualification.actions, null);
      assert.equal(result.measurement.actions.length, workload.operations.length);
    });
  } finally { try { await browser?.close(); } finally { await server.close(); } }
});

test("an invisible measured journey releases no timings after a clean qualification", { skip: !directory && "Set CLIENT_NATIVE_DIR to a runner's native build directory", timeout: 30000 }, async () => {
  const dir = resolve(directory), workload = JSON.parse(await readFile(join(dir, "workload.json"), "utf8"));
  const server = await serve(dir);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const result = await qualifyAndMeasure((phase) => journey(browser, server.url, "react", workload,
      { maxCleanupMs: 2000, cleanupObservationMs: 100 }, 15000,
      phase === "measurement" ? (page) => page.evaluate(() => { document.getElementById("screen").style.opacity = "0"; }) : undefined,
      phase === "measurement"));
    assert.equal(result.qualification.oracle.functionalPassed, true);
    assert.equal(result.measurement.oracle.functionalPassed, false);
    assert.equal(result.measurement.failure.phase, "operation-0");
    assert.equal(result.measurement.actions, null);
    assert.equal(result.measurement.readyMs, null);
    assert.equal(result.readyForMeasurement, false);
  } finally { try { await browser?.close(); } finally { await server.close(); } }
});

test("native hostile mutations are rejected before a measurement pass", { skip: !directory && "Set CLIENT_NATIVE_DIR to a runner's native build directory", timeout: 120000 }, async (t) => {
  const dir = resolve(directory), workload = JSON.parse(await readFile(join(dir, "workload.json"), "utf8"));
  const server = await serve(dir);
  let browser;
  const settings = { maxCleanupMs: 2000, cleanupObservationMs: 100 };
  const attacks = {
    "static shell with real ready DOM": () => document.getElementById("screen").addEventListener("click", (e) => e.stopImmediatePropagation(), true),
    "ignored filter": () => document.getElementById("filter").addEventListener("input", (e) => e.stopImmediatePropagation(), true),
    "ignored sort": () => document.getElementById("sort-desc").addEventListener("click", (e) => e.stopImmediatePropagation(), true),
    "CSS-hidden row": () => { document.querySelector("tr[data-row]").style.display = "none"; },
    "visibility-hidden screen": () => { document.getElementById("screen").style.visibility = "hidden"; },
    "transparent screen": () => { document.getElementById("screen").style.opacity = "0"; },
    "visibility-hidden row": () => { document.querySelector("tr[data-row]").style.visibility = "hidden"; },
    "transparent row": () => { document.querySelector("tr[data-row]").style.opacity = "0"; },
    "hidden row label": () => { document.querySelector("[data-select]").style.visibility = "hidden"; },
    "transparent row label": () => { document.querySelector("[data-select]").style.opacity = "0"; },
    "hidden card value": () => { document.querySelector("[data-card] span").style.visibility = "hidden"; },
    "transparent card label": () => { document.querySelector("[data-card] b").style.opacity = "0"; },
    "hidden dashboard total": () => { document.getElementById("total").style.visibility = "hidden"; },
    "transparent dashboard total": () => { document.getElementById("total").style.opacity = "0"; },
    "wrong dashboard total": () => document.getElementById("tick-all").addEventListener("click", () => setTimeout(() => document.getElementById("total").textContent = "1", 0)),
    "keyed node replaced with identical markup": () => document.getElementById("update-tenth").addEventListener("click", () => setTimeout(() => { const row = document.querySelector("tr[data-row]"); row.replaceWith(row.cloneNode(true)); }, 0)),
    "failed HTTP": () => document.getElementById("swap").addEventListener("click", () => fetch("http://127.0.0.1:1/forbidden").catch(() => {})),
    "browser error": () => document.getElementById("swap").addEventListener("click", () => { throw new Error("hostile-test"); }),
    "leaked subscription": () => window.clientSource.addEventListener("tick", () => {}),
    "leaked global input listener": () => document.addEventListener("input", () => {}),
    "leaked global input property": () => { document.oninput = () => {}; },
    "leaked global property retaining detached screen": () => { const screen = document.getElementById("screen"); document.oninput = () => { if (!screen.isConnected) screen.querySelector("#total").textContent = "1"; }; },
    "leaked timer": () => { const detach = window.clientDetach; window.clientDetach = () => { detach(); setInterval(() => {}, 60000); }; },
    "leaked animation task": () => { const detach = window.clientDetach; window.clientDetach = () => { detach(); const again = () => requestAnimationFrame(again); again(); }; },
    "post-detach update": () => { const screen = document.getElementById("screen"); window.clientSource.addEventListener("tick", () => { if (!screen.isConnected) screen.querySelector("#total").textContent = "1"; }); },
  };
  try {
    browser = await chromium.launch({ headless: true });
    const cases = Object.entries(attacks).map(([name, attack]) => ({ app: "react", name, attack }));
    for (const name of ["leaked subscription", "leaked global input listener", "leaked global input property", "leaked global property retaining detached screen", "visibility-hidden screen", "transparent screen"]) cases.push({ app: "corten", name, attack: attacks[name] });
    for (const { app, name, attack } of cases) await t.test(`${app}: ${name}`, async () => {
      const calls = [];
      const result = await qualifyAndMeasure(async (phase) => {
        calls.push(phase);
        return journey(browser, server.url, app, workload, settings, 15000, (page) => page.evaluate(attack));
      });
      assert.deepEqual(calls, ["qualification"]);
      assert.equal(result.readyForMeasurement, false);
      assert.equal(result.qualification.capture.outcome, "failed");
      assert.equal(result.measurement, null);
      assert.equal(result.qualification.actions, null);
      const invisibleContent = /screen|row label|card value|card label|dashboard total/.test(name) && /hidden|transparent/.test(name);
      assert.equal(result.qualification.failure.phase, invisibleContent ? "operation-0" : "oracle", JSON.stringify(result.qualification.failure));
    });
  } finally { try { await browser?.close(); } finally { await server.close(); } }
});

test("bootstrap sockets send during operations and cleanup but never qualify for timing", { skip: !directory && "Set CLIENT_NATIVE_DIR to a runner's native build directory", timeout: 30000 }, async () => {
  const dir = resolve(directory), workload = JSON.parse(await readFile(join(dir, "workload.json"), "utf8"));
  const peer = await socketFixture();
  let server, browser;
  try {
    server = await serve(dir);
    browser = await chromium.launch({ headless: true });
    const code = await readFile(join(dir, "react/app.js"), "utf8"), sent = [], calls = [];
    const bootstrap = `\nwindow.reviewSocket = new WebSocket(${JSON.stringify(peer.url)});
      await new Promise((ok, reject) => { reviewSocket.onopen = ok; reviewSocket.onerror = reject; });
      window.clientSource.addEventListener("tick", () => reviewSocket.send(document.getElementById("screen") ? "operation" : "cleanup"));`;
    const decorated = { async newContext(options) {
      const context = await browser.newContext(options);
      context.on("page", (page) => page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => sent.push(payload))));
      await context.route("**/react/app.js", (route) => route.fulfill({ contentType: "text/javascript", body: code + bootstrap }));
      return context;
    } };
    const result = await qualifyAndMeasure((phase) => {
      calls.push(phase);
      return journey(decorated, server.url, "react", workload, { maxCleanupMs: 2000, cleanupObservationMs: 100 }, 15000);
    });
    assert.deepEqual(calls, ["qualification"]);
    assert.equal(result.readyForMeasurement, false);
    assert.equal(result.measurement, null);
    assert.equal(result.qualification.actions, null);
    assert.equal(result.qualification.failure.phase, "oracle");
    const records = result.qualification.failure.records, baseline = records[0].owned, final = records.at(-1);
    assert.equal(baseline.subscriptions, 1);
    assert.equal(baseline.connections, 1);
    assert.equal(final.owned.subscriptions, 1);
    assert.equal(final.owned.connections, 1);
    assert.ok(records.filter((r) => r.kind === "operation").flatMap((r) => r.network).some((r) => r.transport === "WebSocket.send"));
    assert.ok(records.find((r) => r.kind === "cleanup-probe").network.some((r) => r.transport === "WebSocket.send"));
    assert.deepEqual(sent, ["operation", "operation", "cleanup"]);
    assert.ok(peer.receivedBytes() > 0);
  } finally {
    try { await browser?.close(); } finally { try { await server?.close(); } finally { await peer.close(); } }
  }
});
