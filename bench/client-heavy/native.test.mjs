import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium } from "playwright";
import { journey, serve, qualifyAndMeasure } from "./run.mjs";

const directory = process.env.CLIENT_NATIVE_DIR;
test("native hostile mutations are rejected before a measurement pass", { skip: !directory && "Set CLIENT_NATIVE_DIR to a runner's native build directory", timeout: 120000 }, async (t) => {
  const dir = resolve(directory), workload = JSON.parse(await readFile(join(dir, "workload.json"), "utf8"));
  const server = await serve(dir), browser = await chromium.launch({ headless: true });
  const settings = { maxCleanupMs: 2000, cleanupObservationMs: 100 };
  const attacks = {
    "static shell with real ready DOM": () => document.getElementById("screen").addEventListener("click", (e) => e.stopImmediatePropagation(), true),
    "ignored filter": () => document.getElementById("filter").addEventListener("input", (e) => e.stopImmediatePropagation(), true),
    "ignored sort": () => document.getElementById("sort-desc").addEventListener("click", (e) => e.stopImmediatePropagation(), true),
    "CSS-hidden row": () => { document.querySelector("tr[data-row]").style.display = "none"; },
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
    const cases = Object.entries(attacks).map(([name, attack]) => ({ app: "react", name, attack }));
    for (const name of ["leaked subscription", "leaked global input listener", "leaked global input property", "leaked global property retaining detached screen"]) cases.push({ app: "corten", name, attack: attacks[name] });
    for (const { app, name, attack } of cases) await t.test(`${app}: ${name}`, async () => {
      const calls = [];
      const result = await qualifyAndMeasure(async (phase) => {
        calls.push(phase);
        return journey(browser, server.url, app, workload, settings, 15000, (page) => page.evaluate(attack));
      });
      assert.deepEqual(calls, ["qualification"]);
      assert.equal(result.readyForMeasurement, false);
      assert.equal(result.qualification.capture.outcome, "failed");
      assert.equal(result.qualification.failure.phase, "oracle", JSON.stringify(result.qualification.failure));
    });
  } finally { await browser.close(); await server.close(); }
});
