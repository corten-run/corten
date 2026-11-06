// "Show all N offers" in a browser, for each app: on an item with more than five offers the page
// shows five rows, and a click on the button shows all N, with JavaScript (each framework's own
// way) and without it (the GET form loads the page with ?offers=all). check-app.mjs runs it.
// Usage: node show-all.mjs [apps=all] [item=item_1]  (apps running on their catalog ports)
import { chromium } from "@playwright/test";
import { pageApps as apps } from "./apps.mjs";

const names = Object.keys(apps).filter((n) => !process.argv[2] || process.argv[2].split(",").includes(n));
const item = process.argv[3] ?? "item_1";
/** The rows of the table under the "Offers" heading. */
const offerRows = () => {
  const heading = Array.from(document.querySelectorAll("h2")).find((h) => h.textContent?.trim() === "Offers");
  return heading?.closest("section")?.querySelectorAll("tbody tr").length ?? -1;
};
const browser = await chromium.launch({ headless: true });
let failures = 0;
try {
  for (const n of names) {
    for (const javaScriptEnabled of [true, false]) {
      const context = await browser.newContext({ javaScriptEnabled });
      const page = await context.newPage();
      const how = javaScriptEnabled ? "script" : "no script";
      try {
        const url = `http://localhost:${apps[n].port}/items/${item}`;
        // Once more on a reset connection alone, as look.mjs does (Docker Desktop's port proxy
        // drops some on a busy machine).
        await page.goto(url, { waitUntil: "load", timeout: 60_000 }).catch((error) => {
          if (!/ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED/.test(String(error))) throw error;
          console.log(JSON.stringify({ app: n, how, retry: String(error).split("\n")[0] }));
          return page.goto(url, { waitUntil: "load", timeout: 60_000 });
        });
        // Hydrated, so a click is the framework's own and not the form's plain submit.
        if (javaScriptEnabled) await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        const before = await page.evaluate(offerRows);
        const button = page.getByRole("button", { name: /^Show all \d+ offers$/ });
        const total = Number(/\d+/.exec(await button.innerText({ timeout: 5_000 }))?.[0]);
        await button.click();
        // Polled until the rows are there (a page's CSP may refuse eval, so no function is built
        // from text in the page).
        const rowsAre = (/** @type {number} */ want) => {
          const heading = Array.from(document.querySelectorAll("h2")).find((h) => h.textContent?.trim() === "Offers");
          return (heading?.closest("section")?.querySelectorAll("tbody tr").length ?? -1) === want;
        };
        const after = await page.waitForFunction(rowsAre, total, { timeout: 10_000 }).then(() => total, () => page.evaluate(offerRows));
        const ok = before === 5 && after === total;
        if (!ok) failures += 1;
        console.log(JSON.stringify({ app: n, how, ok, rows: [before, after], total, url: page.url() }));
      } catch (error) {
        failures += 1;
        console.log(JSON.stringify({ app: n, how, ok: false, error: String(error).split("\n")[0] }));
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify({ apps: names, item, failures }));
process.exit(failures ? 1 : 0);
