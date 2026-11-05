// Browser smoke test of `corten dev` live reload: an open page reloads when the server restarts.
// Usage: node scripts/smoke-dev.mjs http://localhost:18483 corten-watchlist-dev
// (the watchlist image, run with -e CORTEN_DEV=1 in a container of that name).
import { chromium } from "@playwright/test";
import { steady } from "./steady.mjs";
import { execFileSync } from "node:child_process";
import { stall } from "./stall.mjs";

const [base = "http://localhost:18483", container = "corten-watchlist-dev"] = process.argv.slice(2);
const failures = [];
const seen = stall(5);
const check = (name, ok, detail = "") => {
  seen(name);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
};

const browser = steady(await chromium.launch({ headless: true }));
try {
  const page = await browser.newPage();
  await page.goto(base);
  const boot = await page.getAttribute('meta[name="corten-dev"]', "content");
  check("dev mode prints the server's start time", !!boot);
  check("dev mode registers no service worker", (await page.$('meta[name="corten-sw"]')) === null);
  await page.evaluate(() => ((/** @type {any} */ (window)).__marker = 1));
  await page.waitForTimeout(300);
  check("the page stays while the server runs", await page.evaluate(() => (/** @type {any} */ (window)).__marker === 1));
  // A control drawn with a value its own attributes refuse is reported; a new form's blank
  // required field and a refused one drawn again with what was sent are not (#850).
  const drawn = await browser.newPage();
  /** @type {string[]} */
  const errors = [];
  drawn.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await drawn.route(base + "/", async (route) => {
    const res = await route.fetch();
    const form = '<form><input type="number" name="delay" min="0" step="100" value="250"><input type="number" name="fresh" required><input type="number" name="sent" max="5" value="9" aria-invalid="true"></form>';
    await route.fulfill({ response: res, body: (await res.text()).replace("</body>", `${form}</body>`) });
  });
  await drawn.goto(base + "/");
  const reported = await drawn.waitForEvent("console", { predicate: (m) => m.text().includes("its own attributes refuse"), timeout: 10000 }).then(() => true, () => errors.some((e) => e.includes("its own attributes refuse")));
  const drawnErrors = errors.filter((e) => e.includes("its own attributes refuse"));
  check("dev mode reports a control drawn with a value its own attributes refuse, and only that one", reported && drawnErrors.length === 1 && drawnErrors[0].startsWith("corten: delay "), drawnErrors.join(" | "));
  await drawn.close();
  // Bounded: a blocking call holds the event loop, so the stall watchdog could not stop it.
  execFileSync("docker", ["restart", "-t", "1", container], { stdio: "ignore", timeout: 60_000 });
  await page.waitForFunction((b) => document.querySelector('meta[name="corten-dev"]')?.getAttribute("content") !== b, boot, { timeout: 20000 }).catch(() => {});
  const after = await page.getAttribute('meta[name="corten-dev"]', "content").catch(() => null);
  check("the open page reloads when the server restarts", !!after && after !== boot && (await page.evaluate(() => (/** @type {any} */ (window)).__marker === undefined)));
} finally {
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
