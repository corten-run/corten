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
  // A control drawn with a value its own attributes refuse is reported, as the page loads and
  // when a patch draws one; a new form's blank required field, a refused one drawn again with what
  // was sent, a control in no form and one in a novalidate form are not (#850). Each report comes
  // in document order, so the last control's says every one before it is in.
  const drawn = await browser.newPage();
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  drawn.on("console", (m) => (m.type() === "error" ? errors : m.type() === "warning" ? warnings : []).push(m.text()));
  /** @param {string} name */
  const reportOf = (name) => drawn.waitForEvent("console", { predicate: (m) => m.text().startsWith(`corten: ${name} `), timeout: 10000 }).then(() => true, () => false);
  await drawn.route(base + "/", async (route) => {
    const res = await route.fetch();
    const controls = [
      '<form><input type="number" name="delay" min="0" step="100" value="250"><input type="number" name="fresh" required>',
      '<input type="number" name="sent" max="5" value="9" aria-invalid="true"></form>',
      '<input type="number" name="alone" max="1" value="2"><form novalidate><input type="number" name="unchecked" max="1" value="2"></form>',
      '<form><input type="number" name="last" max="1" value="2"></form>',
      // Live regions (#873): one inside another is reported; one beside another, aria-live="off"
      // inside one, one inside a region aria-live="off" silences, and plain text in one are not.
      '<div role="alert"><p id="inner" role="alert">Sold out.</p></div><p role="status">Saved.</p>',
      '<div role="alert"><span id="quiet" aria-live="off">x</span></div>',
      '<div role="status" aria-live="off"><p id="silenced" role="alert">z</p></div>',
      '<div aria-live="polite" id="lasthost"><p id="lastlive" role="status">y</p></div>',
      // Closed dialogs and popovers (#1081): one a rule inside @media gives a display is warned
      // of, at the width the page is at and one it is not at, nested too; a card look outside a
      // query, one under @supports, the open one's look, one the app draws with its own !important
      // rule, an open one and one the query hides are not.
      '<dialog id="rail" class="rail"><p>Filters</p></dialog><dialog id="card" class="card"></dialog>',
      '<dialog id="kept" class="kept"></dialog><dialog id="shown" class="rail" open></dialog>',
      '<dialog id="gone" class="gone"></dialog><dialog id="inplace" class="inplace"></dialog>',
      '<dialog id="enhanced" class="enhanced"></dialog><dialog id="modal" class="modal"></dialog>',
      '<div id="nav" class="nav" popover></div><div class="page"><dialog id="side" class="side"></dialog></div>',
      '<dialog id="keptHidden" class="kept" hidden></dialog><dialog id="lastrail" class="rail"></dialog>',
    ].join("");
    const sheet = '<link rel="stylesheet" href="/dialog-in-place.css">';
    await route.fulfill({ response: res, body: (await res.text()).replace("</head>", `${sheet}</head>`).replace("</body>", `${controls}</body>`) });
  });
  await drawn.route(base + "/dialog-in-place.css", (route) =>
    route.fulfill({
      contentType: "text/css",
      body: [
        ".card { display: flex; }",
        "@media (min-width: 9999px) { .rail { display: block; } }",
        "@media (min-width: 1px) { .kept { display: block; } .kept:not([open],[hidden]) { display: block !important; } }",
        "@media (min-width: 1px) { .gone { display: none; } }",
        "@media (min-width: 1px) { .inplace { display: block; } .modal[open] { display: grid; } }",
        "@supports (display: grid) { .enhanced { display: grid; } }",
        "@media (min-width: 1px) { .nav { display: grid; } }",
        ".page { .side { @media (min-width: 1px) { display: block; } } }",
      ].join("\n"),
    }),
  );
  const loaded = reportOf("last");
  const loadedLive = reportOf("lastlive");
  const loadedRail = reportOf("lastrail");
  await drawn.goto(base + "/");
  const onLoad = (await loaded) ? errors.filter((e) => e.includes("its own attributes refuse")).map((e) => e.split(" ")[1]) : [];
  check("dev mode reports a control drawn with a value its own attributes refuse, and only those", onLoad.join(",") === "delay,last", onLoad.join(","));
  const nestedOnLoad = (await loadedLive) ? errors.filter((e) => e.includes("is a live region inside another")).map((e) => e.split(" ")[1]) : [];
  check("dev mode reports a live region drawn inside another, and only those", nestedOnLoad.join(",") === "inner,lastlive", nestedOnLoad.join(","));
  const railOnLoad = (await loadedRail) ? warnings.filter((e) => e.includes(" is a closed ")) : [];
  const railNames = railOnLoad.map((e) => e.split(" ")[1]).join(",");
  check("dev mode warns of a closed dialog or popover a rule inside a media query gives a display, and only those", railNames === "rail,inplace,nav,side,lastrail", railNames);
  check(
    "its warning names the rule, the query, the rule that draws it in place and the open one's look",
    !!railOnLoad[0]?.includes("`.rail` in `@media (min-width: 9999px)` gives display: block") &&
      !!railOnLoad[0]?.includes("`.rail:not([open],[hidden]) { display: block !important }`") &&
      !!railOnLoad[0]?.includes("`.rail[open]`"),
    railOnLoad[0],
  );
  // components.css's rule is what hides `inplace`, whose query holds now; the rule the warning
  // gives draws `kept` over it.
  const shown = await drawn.evaluate(() => ["inplace", "kept", "keptHidden"].map((id) => getComputedStyle(/** @type {Element} */ (document.getElementById(id))).display).join(","));
  check("components.css hides a closed dialog a query draws, and the rule the warning gives draws it but not one with hidden", shown === "none,block,none", shown);
  const patchedRail = reportOf("patchedrail");
  await drawn.evaluate(() => document.body.append(Object.assign(document.createElement("dialog"), { id: "patchedrail", className: "rail" })));
  check("dev mode warns of such a dialog a patch draws", await patchedRail);
  const patchedLive = reportOf("patchedlive");
  await drawn.evaluate(() => {
    const p = Object.assign(document.createElement("p"), { id: "patchedlive", textContent: "Sent." });
    p.setAttribute("role", "alert");
    document.getElementById("lasthost")?.append(p);
  });
  check("dev mode reports such a region a patch draws", await patchedLive);
  const patched = reportOf("patched");
  await drawn.evaluate(() => {
    // Built from elements, not markup: the page requires Trusted Types.
    const form = document.createElement("form");
    const input = Object.assign(document.createElement("input"), { type: "number", name: "patched", min: "1" });
    input.setAttribute("value", "0");
    form.append(input);
    document.body.append(form);
  });
  check("dev mode reports such a control a patch draws", await patched);
  // What the user typed is theirs, not the page's: a bound a script moves past it is not reported.
  await drawn.evaluate(() => {
    const input = /** @type {HTMLInputElement} */ (document.querySelector('input[name="delay"]'));
    input.closest("form")?.append(Object.assign(document.createElement("input"), { type: "number", name: "typed" }));
    const typed = /** @type {HTMLInputElement} */ (document.querySelector('input[name="typed"]'));
    typed.value = "7";
  });
  const moved = reportOf("typed");
  await drawn.evaluate(() => document.querySelector('input[name="typed"]')?.setAttribute("max", "5"));
  const marker = reportOf("after");
  await drawn.evaluate(() => {
    const form = document.createElement("form");
    const input = Object.assign(document.createElement("input"), { type: "number", name: "after", min: "1" });
    input.setAttribute("value", "0");
    form.append(input);
    document.body.append(form);
  });
  check("dev mode does not report a value the user typed", (await marker) && !(await Promise.race([moved, Promise.resolve(false)])));
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
