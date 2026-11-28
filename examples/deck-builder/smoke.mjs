// Browser smoke test and timings for the deck builder: every move in the browser, autosave with
// its refusals, another tab's edits, the same deck built without JavaScript, and filtered and saved
// with JavaScript on but the builder's module not loading, in Chromium, Firefox and WebKit.
// Usage: node examples/deck-builder/smoke.mjs http://localhost:18487
import http from "node:http";
import { chromium, firefox, webkit } from "@playwright/test";
import { steady } from "../../scripts/steady.mjs";
import { stall } from "../../scripts/stall.mjs";

const base = process.argv[2];
if (!base) throw new Error("usage: node examples/deck-builder/smoke.mjs <base url>");
const failures = [];
const seen = stall(5);
const check = (name, ok, detail = "") => {
  seen(name);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
};
/** @type {Record<string, string>} */
const timings = {};
/** @type {string[]} */
const errors = [];

const browser = steady(await chromium.launch({ headless: true, args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"] }));

/** A page of its own browser (its own cookies), or another tab of `context`. */
async function open(context, reducedMotion = "no-preference") {
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion });
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  // The scripts are in, and the deck's feed is open (its snapshot has arrived).
  await page.evaluate(async () => {
    const { ready } = await import("corten");
    await ready;
  });
  return page;
}

/** The deck as the page shows it: `card id -> copies`. */
const deck = (page) =>
  page.evaluate(() =>
    Object.fromEntries(
      Array.from(document.querySelectorAll("ul li[data-key]"), (li) => [li.getAttribute("data-key"), Number(/** @type {HTMLInputElement} */ (li.querySelector("input[type=number]")).value)]),
    ),
  );
const lineOrder = (page) => page.$$eval("ul li[data-key]", (lines) => lines.map((line) => line.getAttribute("data-key")));
const sameDeck = (left, right) => JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());
const total = (page) => page.textContent("p[class$=__total] output");
const status = (page) => page.evaluate(() => {
  const s = /** @type {HTMLElement} */ (document.querySelector("[role=status][data-state]"));
  return { state: s.dataset.state, note: document.getElementById("save-note")?.textContent ?? "" };
});
/** Waits for the save on its way to be answered and taken: the status shows the note again. */
const settled = (page, note = "Saved.") =>
  page.waitForFunction((note) => {
    const s = /** @type {HTMLElement} */ (document.querySelector("[role=status][data-state]"));
    return s.dataset.state === "" && document.getElementById("save-note")?.textContent?.startsWith(note);
  }, note);
/** Whether `page` comes to show `count` copies of `id` in its deck within five seconds. */
const comesToShow = (page, id, count) =>
  page
    .waitForFunction(
      ([id, count]) => /** @type {HTMLInputElement | null} */ (document.querySelector(`ul li[data-key="${id}"] input[type=number]`))?.value === String(count),
      [id, count],
      { timeout: 5000 },
    )
    .then(
      () => true,
      () => false,
    );
const row = (page, id) => page.locator(`tbody tr[data-key="${id}"]`);
const version = (page) => page.inputValue("input[name=version]");
const saveButton = 'form[method=post] button:text-is("Save")';
/** @param {import("@playwright/test").Request} request */
const isSave = (request) => request.method() === "POST" && new URL(request.url()).pathname === "/deck";
/** @param {import("@playwright/test").Request} request */
const saveFields = (request) => new URLSearchParams(request.postData() ?? "");

/** The keys of the elements drawn, including when an ancestor supplies the opacity. */
const drawnKeys = (page, selector, attr) => page.locator(selector).evaluateAll((elements, attr) =>
  elements.filter((el) => {
    const { width, height } = el.getBoundingClientRect();
    if (!width || !height || getComputedStyle(el).visibility !== "visible") return false;
    for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) {
      if (Number(getComputedStyle(ancestor).opacity) === 0) return false;
    }
    return true;
  }).map((el) => el.getAttribute(attr)), attr);

/** Runs `act` in the page and times it: handlers run while the event is dispatched. */
const time = (page, name, act) =>
  page
    .evaluate(async (code) => {
      const fn = new Function(code);
      const start = performance.now();
      fn();
      const handled = performance.now() - start;
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
      return { handled, settled: performance.now() - start };
    }, `(${act.toString()})()`)
    .then((t) => (timings[name] = `${t.handled.toFixed(2)} ms (settled ${t.settled.toFixed(2)} ms)`));

try {
  const context = await browser.newContext();
  const page = await open(context);
  const nav = await page.evaluate(() => {
    const t = /** @type {PerformanceNavigationTiming} */ (performance.getEntriesByType("navigation")[0]);
    return { ready: performance.now(), dcl: t.domContentLoadedEventEnd, rows: document.querySelectorAll("tbody tr").length, bytes: t.transferSize };
  });
  timings["first load: DOMContentLoaded / scripts ready"] = `${nav.dcl.toFixed(0)} / ${nav.ready.toFixed(0)} ms, ${nav.rows} rows, ${(nav.bytes / 1024).toFixed(0)} KB transferred`;
  const start = await deck(page);
  check("the page shows the collection and the saved deck", nav.rows === 240 && start["gravel-sprite"] === 3 && (await total(page)) === "10", JSON.stringify(start));

  // Filter and sort, in the page.
  await time(page, "filter 240 rows", () => {
    const input = /** @type {HTMLInputElement} */ (document.querySelector("input[type=search]"));
    input.value = "drake";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const visible = await page.locator("tbody tr:not([hidden])").count();
  check("the filter shows the matching cards and how many", visible === 1 && (await page.textContent("[class$=__counts] output")) === "1 of 240 shown", `${visible}`);
  await page.fill("input[type=search]", "");
  await page.dispatchEvent("input[type=search]", "input");
  await time(page, "sort 240 rows by cost", () => /** @type {HTMLElement} */ (document.querySelector("thead th:nth-child(4) a")).click());
  const costs = await page.$$eval("tbody tr td:nth-child(4)", (tds) => tds.map((td) => Number(td.textContent)));
  check("a column header sorts in the page, cheapest first", costs.every((c, i) => i === 0 || costs[i - 1] <= c) && page.url() === `${base}/`, `${costs.slice(0, 6)}`);
  await page.click("thead th:nth-child(4) a");
  const desc = await page.$$eval("tbody tr td:nth-child(4)", (tds) => tds.map((td) => Number(td.textContent)));
  check("a second click sorts the other way", desc[0] === 7 && (await page.getAttribute("thead th:nth-child(4)", "aria-sort")) === "descending", `${desc.slice(0, 4)}`);
  await page.click("thead th:nth-child(3) a");

  // Add: shown at once, then saved. The save is held, so the line is checked before any answer.
  let release = () => {};
  const loaded = Number(await version(page));
  const firstSave = Promise.withResolvers();
  const heldSave = Promise.withResolvers();
  let holdingFirst = false;
  /** @type {URLSearchParams[]} */
  const sent = [];
  /** @param {import("@playwright/test").Request} request */
  const recordSave = (request) => { if (isSave(request)) sent.push(saveFields(request)); };
  page.on("request", recordSave);
  await page.route("**/deck", async (route) => {
    if (!holdingFirst) {
      holdingFirst = true;
      firstSave.resolve(undefined);
      await heldSave.promise;
    }
    await route.continue();
  });
  await row(page, "pearl-diver").locator("button", { hasText: "Add" }).click();
  check("Add shows the card in the deck at once, before the server answers", (await deck(page))["pearl-diver"] === 1 && (await status(page)).state === "saving");
  const drawn = [await total(page), await page.textContent("figure ol li:nth-child(3) span"), await row(page, "pearl-diver").locator("td:nth-child(6) span").first().textContent()];
  check("the count, the curve and the collection row follow", drawn.join() === "11,5,1", drawn.join());
  check(
    "a change marks the collection row and deck line for motion",
    (await row(page, "pearl-diver").getAttribute("data-motion"))?.startsWith("card-") === true &&
      (await page.locator('ul li[data-key="pearl-diver"]').getAttribute("data-motion"))?.startsWith("line-") === true,
  );
  const animations = await page.evaluate(() => [
    getComputedStyle(document.querySelector('tbody tr[data-key="pearl-diver"]')).animationName,
    getComputedStyle(document.querySelector('ul li[data-key="pearl-diver"]')).animationName,
  ]);
  check("the motion markers select the component animations", animations[0] !== "none" && animations[1] !== "none", animations.join(", "));
  await page.waitForFunction(() => !document.querySelector('tbody tr[data-motion], ul li[data-motion]'));
  check("motion markers clear after the animation", !(await page.locator("[data-motion]").count()));
  await firstSave.promise;
  try {
    await time(page, "Add (a change drawn while a save is held)", () => /** @type {HTMLElement} */ (document.querySelector('tbody tr[data-key="undertow-serpent"] td:last-child button')).click());
    await page.click(saveButton);
    check("Save during a save keeps the pending edit without sending in parallel", sent.length === 1 &&
      (await deck(page))["undertow-serpent"] === 1 && (await status(page)).state === "saving", `${sent.length} POSTs before the answer`);
  } finally {
    heldSave.resolve(undefined);
  }
  const savedQueue = await page.waitForFunction((expected) =>
    Number(/** @type {HTMLInputElement} */ (document.querySelector("input[name=version]")).value) === expected &&
    document.querySelector("[role=status][data-state=''] #save-note")?.textContent === "Saved.", loaded + 2, { timeout: 5_000 }).then(() => true, () => false);
  await page.unroute("**/deck");
  page.off("request", recordSave);
  const sentVersions = sent.map((fields) => fields.get("version"));
  const [firstKey, secondKey] = sent.map((fields) => fields.get("submit"));
  check("the queued edit saves once with the next version and a new submit key", savedQueue && sent.length === 2 &&
    sentVersions.join() === `${loaded},${loaded + 1}` && firstKey && secondKey && firstKey !== secondKey &&
    !sent[0].getAll("card").includes("undertow-serpent") && sent[1].getAll("card").includes("undertow-serpent") &&
    page.url() === `${base}/`, `POST versions ${sentVersions.join()}; page at ${await version(page)}`);

  // Undo and redo: buttons and keys, each saved.
  await page.click("button:has-text('Undo')");
  check("Undo takes the last change back", (await deck(page))["undertow-serpent"] === undefined);
  await settled(page);
  await page.click("button:has-text('Redo')");
  check("Redo does it again", (await deck(page))["undertow-serpent"] === 1);
  await settled(page);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  check("Ctrl+Z undoes", (await deck(page))["undertow-serpent"] === undefined);
  await settled(page);
  await page.keyboard.press("Control+Shift+z");
  check("Ctrl+Shift+Z redoes", (await deck(page))["undertow-serpent"] === 1);
  await settled(page);

  // The Filter and Save buttons stay drawn with JavaScript (a page whose builder module did not
  // load needs them, below); with the module, both keep the page: the rows are already filtered as
  // typed, and the deck already saved.
  await page.fill("input[type=search]", "drake");
  const typedRows = await page.locator("tbody tr:not([hidden])").count();
  const drawnWithScripts = [await page.isVisible("form[role=search] button"), await page.isVisible(saveButton)];
  const savedVersion = await version(page);
  let posted = 0;
  /** @param {import("@playwright/test").Request} r */
  const countPost = (r) => r.method() === "POST" && new URL(r.url()).pathname === "/deck" && (posted += 1);
  page.on("request", countPost);
  if (drawnWithScripts[0]) await page.click("form[role=search] button");
  if (drawnWithScripts[1]) await page.click(saveButton);
  await page.waitForTimeout(300);
  page.off("request", countPost);
  const kept = { url: page.url(), rows: await page.locator("tbody tr:not([hidden])").count(), version: await version(page), state: (await status(page)).state };
  check(
    "with JavaScript the Filter and Save buttons are drawn and keep the page, filtered and saved",
    drawnWithScripts.every(Boolean) && kept.url === `${base}/` && kept.rows === typedRows && typedRows === 1 && posted === 0 && kept.version === savedVersion && kept.state === "",
    `drawn: ${drawnWithScripts.join()}; ${kept.url}; ${kept.rows} of ${typedRows} rows; ${posted} saves sent; version ${savedVersion} then ${kept.version}; state "${kept.state}"`,
  );
  await page.fill("input[type=search]", "");

  // Select several and add them.
  await row(page, "lantern-warden").locator("input[type=checkbox]").check();
  await row(page, "moth-court-herald").locator("input[type=checkbox]").check();
  check("checking rows counts them", (await page.textContent("[class$=__picks] output")) === "2");
  await page.click("button:has-text('Add selected')");
  const picked = await deck(page);
  check("Add selected adds one of each and clears the selection", picked["lantern-warden"] === 3 && picked["moth-court-herald"] === 3 && (await page.textContent("[class$=__picks] output")) === "0", JSON.stringify(picked));
  await settled(page);

  // A change the rules refuse is rolled back, with their words.
  await row(page, "ashen-drake").locator("button", { hasText: "Add" }).click();
  await settled(page);
  await page.route("**/deck", async (route) => {
    await new Promise((r) => (release = r));
    await route.continue();
  });
  await row(page, "ashen-drake").locator("button", { hasText: "Add" }).click();
  check("a third Ashen Drake shows at once", (await deck(page))["ashen-drake"] === 3, JSON.stringify(await deck(page)));
  release();
  await settled(page, "Not saved:");
  await page.unroute("**/deck");
  check("the server refuses it and the page rolls it back with the reason", (await deck(page))["ashen-drake"] === 2 && (await status(page)).note === "Not saved: You own 2 copies of Ashen Drake.", (await status(page)).note);
  await page.click("button:has-text('Undo')");
  check("the history is as it was at the last save", (await deck(page))["ashen-drake"] === 1);
  await settled(page);

  // A count typed in.
  await page.fill('li[data-key="pearl-diver"] input[type=number]', "3");
  await page.press('li[data-key="pearl-diver"] input[type=number]', "Enter");
  check("a typed count changes the deck", (await deck(page))["pearl-diver"] === 3);
  await settled(page);
  await page.fill('li[data-key="pearl-diver"] input[type=number]', "0");
  await page.press('li[data-key="pearl-diver"] input[type=number]', "Enter");
  check("a count of 0 takes the card out", (await deck(page))["pearl-diver"] === undefined);
  await settled(page);

  // Drag and drop, both ways. With its Save button drawn, the deck's middle is over its lines, and a
  // drag Playwright aims there reached the page with no drag events at all; the drop aims at the
  // deck's heading.
  await row(page, "salt-oracle").locator("td:nth-child(2) button").dragTo(page.locator("section[class$=__deck]"), { targetPosition: { x: 40, y: 24 } });
  check("dragging a card onto the deck adds it", (await deck(page))["salt-oracle"] === 1);
  await settled(page);
  await page.locator('li[data-key="salt-oracle"] button').dragTo(page.locator("section[class$=__collection] tbody"));
  check("dragging a line onto the collection takes it out", (await deck(page))["salt-oracle"] === undefined);
  await settled(page);
  const announced = () => page.textContent("p[aria-live=assertive]");
  const beforeReorder = await lineOrder(page);
  const source = beforeReorder.at(-1);
  const target = beforeReorder[0];
  await page.locator(`li[data-key="${source}"] button`).dragTo(page.locator(`li[data-key="${target}"]`), { targetPosition: { x: 12, y: 2 } });
  const afterReorder = await lineOrder(page);
  check("dragging a deck line onto another reorders the lines", source !== target && afterReorder[0] === source && afterReorder.includes(target), `${source} before ${target}`);
  const keyboardSource = afterReorder[0];
  await page.locator(`li[data-key="${keyboardSource}"] button`).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const afterKeyboardReorder = await lineOrder(page);
  check("ArrowDown reorders a picked-up deck line", afterKeyboardReorder[1] === keyboardSource && (await announced()).endsWith(" moved."), `${keyboardSource} at ${afterKeyboardReorder.indexOf(keyboardSource)}`);

  // The same moves by keyboard: Space picks up, the arrows move, Space drops, Escape puts back.
  await row(page, "gravel-sprite").locator("td:nth-child(2) button").focus();
  await page.keyboard.press(" ");
  check("Space picks a card up and takes it over the deck", (await announced()) === "Picked up Gravel Sprite. Over the deck." && (await page.evaluate(() => document.activeElement?.matches("section[class$=__deck]"))), await announced());
  await page.keyboard.press("ArrowLeft");
  check("an arrow key moves it over the collection", (await announced()) === "Over the collection.");
  await page.keyboard.press("Escape");
  check("Escape puts it back and returns focus", (await announced()) === "Gravel Sprite put back." && (await page.evaluate(() => document.activeElement?.closest("tr")?.getAttribute("data-key"))) === "gravel-sprite");
  await row(page, "kiln-colossus").locator("td:nth-child(2) button").focus();
  await page.keyboard.press(" ");
  await page.keyboard.press(" ");
  check("Space drops it on the deck", (await deck(page))["kiln-colossus"] === 1 && (await announced()) === "Kiln Colossus added to the deck.");
  await settled(page);
  await page.locator('li[data-key="kiln-colossus"] button').focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  check("a deck line dropped on the collection by keyboard leaves the deck", (await deck(page))["kiln-colossus"] === undefined && (await announced()) === "Kiln Colossus taken out of the deck.");
  await settled(page);

  // Another tab saves: an idle page takes it at once.
  const other = await open(context);
  await other.locator('tbody tr[data-key="pearl-diver"] td:last-child button').click();
  await settled(other);
  await page.waitForFunction(() => document.querySelector('ul li[data-key="pearl-diver"]'));
  check("an idle page takes another tab's save and says so", (await status(page)).state === "updated" && (await version(page)) === (await version(other)));

  // Both change at once: the slower save is stale, and the player chooses.
  await page.route("**/deck", async (route) => {
    await new Promise((r) => (release = r));
    await route.continue();
  });
  await row(page, "kiln-colossus").locator("button", { hasText: "Add" }).click();
  await other.locator('tbody tr[data-key="undertow-serpent"] td:last-child button').click();
  await settled(other);
  const stale = page.waitForResponse("**/deck");
  release();
  check("a save built on an old version is refused as stale", (await (await stale).status()) === 409);
  await page.unroute("**/deck");
  await page.waitForSelector("[role=alert]:not([hidden])");
  check("the page offers to keep both changes or take the other tab's deck", (await page.textContent("[role=alert]")).includes("changed in another tab"));
  await page.click("button:has-text('Keep both changes')");
  await settled(page);
  const both = await deck(page);
  check("keeping both saves the other tab's change with this one", both["undertow-serpent"] === 2 && both["kiln-colossus"] === 1, JSON.stringify(both));
  check("and the other tab takes the merged deck", await comesToShow(other, "kiln-colossus", 1));

  // Take theirs: this page's change is dropped.
  await page.route("**/deck", async (route) => {
    await new Promise((r) => (release = r));
    await route.continue();
  });
  await row(page, "lantern-warden").locator("button", { hasText: "Add" }).click();
  await other.fill('li[data-key="undertow-serpent"] input[type=number]', "1");
  await other.press('li[data-key="undertow-serpent"] input[type=number]', "Enter");
  await settled(other);
  release();
  await page.waitForSelector("[role=alert]:not([hidden])");
  await page.unroute("**/deck");
  await page.click("button:has-text(\"Use the other tab's deck\")");
  const theirs = await deck(page);
  check("taking the other tab's deck drops this page's change", theirs["undertow-serpent"] === 1 && theirs["lantern-warden"] === 3 && sameDeck(theirs, await deck(other)), JSON.stringify(theirs));

  // The server cannot be reached: nothing is lost, and Save works like Try again.
  /** @type {(string | null)[]} */
  const offlineKeys = [];
  /** @param {import("@playwright/test").Request} request */
  const recordOfflineSave = (request) => { if (isSave(request)) offlineKeys.push(saveFields(request).get("submit")); };
  page.on("request", recordOfflineSave);
  await page.route("**/deck", (route) => route.abort());
  await row(page, "pearl-diver").locator("button", { hasText: "Add" }).click();
  await page.waitForFunction(() => /** @type {HTMLElement} */ (document.querySelector("[role=status][data-state]")).dataset.state === "offline");
  check("an unreachable server keeps the change and says it is not saved", (await deck(page))["pearl-diver"] === 2 && (await page.isVisible("button:has-text('Try again')")));
  await page.unroute("**/deck");
  const offlineVersion = Number(await version(page));
  await page.click(saveButton);
  await settled(page);
  page.off("request", recordOfflineSave);
  check("Save while offline retries once with the same submit key", offlineKeys.length === 2 &&
    !!offlineKeys[0] && offlineKeys[0] === offlineKeys[1] && Number(await version(page)) === offlineVersion + 1 &&
    (await deck(page))["pearl-diver"] === 2 && page.url() === `${base}/`, `${offlineKeys.length} POSTs; version ${offlineVersion} then ${await version(page)}`);
  check("the other tab sees the retried save", await comesToShow(other, "pearl-diver", 2));

  // The server saves but its answer is lost, and another tab saves before Try again: the change
  // is in the deck once, with the other tab's.
  await page.route("**/deck", async (route) => {
    await route.fetch();
    await route.abort();
  });
  await row(page, "undertow-serpent").locator("button", { hasText: "Add" }).click();
  // Not saved, or, when the feed has already brought the deck with this change, saved.
  await page.waitForFunction(() => ["offline", "saved"].includes(/** @type {HTMLElement} */ (document.querySelector("[role=status][data-state]")).dataset.state ?? ""));
  await page.unroute("**/deck");
  // The other tab has the saved deck from the feed, then saves its own change.
  await comesToShow(other, "undertow-serpent", 2);
  await other.locator('tbody tr[data-key="pearl-diver"] td:last-child button').click();
  await settled(other);
  // The feed may already have told the page its save was made; else Try again asks the server.
  if (await page.isVisible("button:has-text('Try again')")) await page.click("button:has-text('Try again')");
  const once = (await comesToShow(page, "pearl-diver", 3)) && (await comesToShow(page, "undertow-serpent", 2));
  check("a save whose answer was lost is not made twice", once && (await comesToShow(other, "undertow-serpent", 2)) && !(await page.isVisible("[role=alert]")), JSON.stringify(await deck(page)));

  // The same, where only the server can say: a tab whose feed is held (so it cannot learn of the
  // save that way) saves, the server commits it, and the answer's body is cut off after its
  // headers. Another tab saves meanwhile. Try again goes with the same key, and the server answers
  // with the save it made: the change is in the deck once. A proxy of the smoke's own cuts the body
  // (a route cannot stream one to fail midway).
  const app = new URL(base);
  const cutProxy = http.createServer((req, res) => {
    const sent = [];
    req.on("data", (c) => sent.push(c));
    req.on("end", () => {
      // As the browser sent it to the app: the override makes it look cross-site, which the app
      // refuses for a write.
      const headers = { ...req.headers, host: app.host, origin: app.origin, "sec-fetch-site": "same-origin" };
      const upstream = http.request(new URL(req.url ?? "/", base), { method: req.method, headers }, (answer) => {
        const body = [];
        answer.on("data", (c) => body.push(c));
        answer.on("end", () => {
          const whole = Buffer.concat(body);
          const { "transfer-encoding": _, ...kept } = answer.headers;
          res.writeHead(answer.statusCode ?? 502, { ...kept, "content-length": String(whole.length) });
          res.write(whole.subarray(0, whole.length >> 1), () => res.socket?.destroy());
        });
      });
      upstream.end(Buffer.concat(sent));
    });
  });
  await new Promise((resolve) => cutProxy.listen(0, "127.0.0.1", () => resolve(undefined)));
  const proxyPort = /** @type {import("node:net").AddressInfo} */ (cutProxy.address()).port;
  const third = await context.newPage();
  third.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  third.on("pageerror", (e) => errors.push(e.message));
  let liveAsked = () => {};
  const asked = new Promise((resolve) => (liveAsked = () => resolve(undefined)));
  let letLive = () => {};
  const held = new Promise((resolve) => (letLive = () => resolve(undefined)));
  await third.route("**/feed/deck/live**", async (route) => {
    liveAsked();
    await held;
    await route.continue().catch(() => {});
  });
  await third.goto(base);
  // The snapshot has arrived when the feed asks for its live stream.
  await asked;
  /** @type {string[]} */
  const keys = [];
  third.on("request", (r) => r.method() === "POST" && r.url().endsWith("/deck") && keys.push(new URLSearchParams(r.postData() ?? "").get("submit") ?? ""));
  // Two cards in no deck yet and none the steps after this one add: this tab's and the other's.
  const [mine, spare] = await third.evaluate(() => {
    const taken = new Set(["salt-oracle", "regent-of-ash", "crown-of-thorns-and-glass", "kiln-colossus"]);
    for (const li of Array.from(document.querySelectorAll("ul li[data-key]"))) taken.add(li.getAttribute("data-key") ?? "");
    return Array.from(document.querySelectorAll("tbody tr[data-key]"), (tr) => tr.getAttribute("data-key") ?? "").filter((id) => !taken.has(id)).slice(0, 2);
  });
  await third.route(`${app.origin}/deck`, (route) => route.continue({ url: `http://127.0.0.1:${proxyPort}/deck` }));
  await row(third, mine).locator("button", { hasText: "Add" }).click();
  await third.waitForFunction(() => /** @type {HTMLElement} */ (document.querySelector("[role=status][data-state]")).dataset.state === "offline");
  await third.unroute(`${app.origin}/deck`);
  await comesToShow(other, mine, 1);
  await row(other, spare).locator("button", { hasText: "Add" }).click();
  await settled(other);
  await third.click("button:has-text('Try again')");
  await settled(third);
  check("Try again after a cut-off answer sends the same submit key", keys.length === 2 && keys[0] === keys[1], keys.join(", "));
  check("and the server answers with the save it made, once", (await deck(third))[mine] === 1, JSON.stringify(await deck(third)));
  letLive();
  check("the held feed then brings the other tab's save", await comesToShow(third, spare, 1));
  check("which keeps the change once", (await comesToShow(other, mine, 1)) && (await deck(third))[mine] === 1 && !(await third.isVisible("[role=alert]")), JSON.stringify(await deck(third)));
  await third.close();
  cutProxy.close();

  // The server has forgotten a key (it keeps them a day): a tab saves, the answer is lost, another
  // tab saves, and Try again is stale, and the server cannot say whether the lost save was made.
  // The retry goes with a fresh key, as the server would see the forgotten one, and its answer says
  // it is unsure. The page does not offer to add its change again, and taking the other tab's deck
  // sends nothing more: the change is in it once.
  const fourth = await context.newPage();
  fourth.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  fourth.on("pageerror", (e) => errors.push(e.message));
  let fourthAsked = () => {};
  const fourthFeed = new Promise((resolve) => (fourthAsked = () => resolve(undefined)));
  let letFourth = () => {};
  const fourthHeld = new Promise((resolve) => (letFourth = () => resolve(undefined)));
  await fourth.route("**/feed/deck/live**", async (route) => {
    fourthAsked();
    await fourthHeld;
    await route.continue().catch(() => {});
  });
  await fourth.goto(base);
  await fourthFeed;
  const [lost, theirsToo] = await fourth.evaluate((skip) => {
    const taken = new Set(["salt-oracle", "regent-of-ash", "crown-of-thorns-and-glass", "kiln-colossus", ...skip]);
    for (const li of Array.from(document.querySelectorAll("ul li[data-key]"))) taken.add(li.getAttribute("data-key") ?? "");
    return Array.from(document.querySelectorAll("tbody tr[data-key]"), (tr) => tr.getAttribute("data-key") ?? "").filter((id) => !taken.has(id)).slice(0, 2);
  }, [mine, spare]);
  await fourth.route(`${app.origin}/deck`, async (route) => {
    await route.fetch();
    await route.abort();
  });
  await row(fourth, lost).locator("button", { hasText: "Add" }).click();
  await fourth.waitForFunction(() => /** @type {HTMLElement} */ (document.querySelector("[role=status][data-state]")).dataset.state === "offline");
  await fourth.unroute(`${app.origin}/deck`);
  await comesToShow(other, lost, 1);
  await row(other, theirsToo).locator("button", { hasText: "Add" }).click();
  await settled(other);
  let sentAfter = 0;
  await fourth.route(`${app.origin}/deck`, async (route) => {
    const form = new URLSearchParams(route.request().postData() ?? "");
    form.set("submit", crypto.randomUUID());
    const answer = await route.fetch({ postData: form.toString() });
    const text = await answer.text();
    // The note's call names the outcome as SaveOutcome declares it (types/app.d.ts).
    const body = text.replace(/("Stale",\d+,\d+,)false\)/, "$1true)");
    if (body === text) errors.push(`the stale answer to mark unsure was not found: ${text}`);
    await route.fulfill({ response: answer, body });
  });
  await fourth.click("button:has-text('Try again')");
  await fourth.waitForFunction(() => document.getElementById("save-note")?.textContent?.startsWith("Not saved: this deck was changed"));
  await fourth.unroute(`${app.origin}/deck`);
  letFourth();
  await fourth.waitForSelector("[role=alert]:not([hidden])");
  check(
    "a stale retry the server cannot place warns and does not offer to keep both changes",
    !(await fourth.isVisible("button:has-text('Keep both changes')")) && (await fourth.isVisible("text=Your last change may already be in it")),
  );
  fourth.on("request", (r) => r.method() === "POST" && r.url().endsWith("/deck") && (sentAfter += 1));
  await fourth.click("button:has-text(\"Use the other tab's deck\")");
  const unsureDeck = await deck(fourth);
  check("taking the other tab's deck then keeps the change once and sends nothing", unsureDeck[lost] === 1 && unsureDeck[theirsToo] === 1 && sentAfter === 0, JSON.stringify(unsureDeck));
  await fourth.close();

  // After adds, removals, rollbacks and another tab's decks: the list is the lines as shown.
  const listed = await page.getByLabel("Deck list", { exact: true }).inputValue();
  const shownLines = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll("ul li[data-key]"),
      (li) => `${/** @type {HTMLInputElement} */ (li.querySelector("input[type=number]")).value} ${li.querySelector(":scope > span:nth-of-type(2)")?.textContent}`,
    ).join("\n"),
  );
  check("the deck list follows the deck", listed === shownLines && listed.split("\n").includes("3 Pearl Diver"), listed.replaceAll("\n", "; "));
  await time(page, "undo (a change drawn and sent)", () => /** @type {HTMLElement} */ ([...document.querySelectorAll("button")].find((b) => b.textContent === "Undo")).click());
  await settled(page);
  const heap = await page.evaluate(() => {
    /** @type {any} */ (window).gc?.();
    return /** @type {any} */ (performance).memory?.usedJSHeapSize ?? 0;
  });
  timings["JS heap after GC"] = `${(heap / 1048576).toFixed(1)} MB`;

  // A phone: nothing wider than the screen.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const small = await open(phone);
  const wide = await small.evaluate(() => document.documentElement.scrollWidth);
  check("at 390 px the page fits the screen", wide <= 390, `${wide}`);

  // Without JavaScript: the same deck, built with forms.
  const plain = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
  await plain.goto(base);
  const before = await deck(plain);
  await Promise.all([plain.waitForEvent("load"), plain.locator('tbody tr[data-key="salt-oracle"] td:last-child button').click()]);
  check("without JavaScript Add posts the deck with the card added", (await deck(plain))["salt-oracle"] === (before["salt-oracle"] ?? 0) + 1, JSON.stringify(await deck(plain)));
  await plain.locator('tbody tr[data-key="regent-of-ash"] input[type=checkbox]').check();
  await plain.locator('tbody tr[data-key="crown-of-thorns-and-glass"] input[type=checkbox]').check();
  await Promise.all([plain.waitForEvent("load"), plain.click("button:has-text('Add selected')")]);
  const added = await deck(plain);
  check("Add selected posts every checked card", added["regent-of-ash"] === 1 && added["crown-of-thorns-and-glass"] === 1, JSON.stringify(added));
  await plain.fill('li[data-key="regent-of-ash"] input[type=number]', "");
  await Promise.all([plain.waitForEvent("load"), plain.click("form button:has-text('Save')")]);
  check("Save posts the counts as typed: a cleared one leaves the deck", (await deck(plain))["regent-of-ash"] === undefined);
  await plain.fill('li[data-key="crown-of-thorns-and-glass"] input[type=number]', "2");
  const [refusedPage] = await Promise.all([
    plain.waitForResponse((res) => res.url().endsWith("/deck")),
    plain.waitForEvent("load"),
    plain.click("form button:has-text('Save')"),
  ]);
  check("a refused save answers 422 with the page and the reason", refusedPage.status() === 422 && (await plain.textContent("#save-note")) === "Not saved: You own 1 copy of Crown of Thorns and Glass.");
  await plain.fill("input[type=search]", "oracle");
  await Promise.all([plain.waitForEvent("load"), plain.click("form[role=search] button")]);
  check("the filter is a GET form the server answers", plain.url().includes("q=oracle") && (await plain.locator("tbody tr:not([hidden])").count()) === 1);

  const reducedContext = await browser.newContext();
  const reduced = await open(reducedContext, "reduce");
  await row(reduced, "pearl-diver").locator("button", { hasText: "Add" }).click();
  check("reduced motion keeps the change without animation markers", !(await reduced.locator("[data-motion]").count()));
  await reducedContext.close();

  // With JavaScript but the builder's module never loading (every request for it, the runtime's
  // retries too, aborted), in each engine: `scripting` still matches `enabled`, so the Filter and
  // Save buttons must not depend on it to be drawn. The runtime (a module of its own) still sends
  // both forms; the server filters the page and saves the counts as typed.
  for (const [name, type] of /** @type {const} */ ([["Chromium", chromium], ["Firefox", firefox], ["WebKit", webkit]])) {
    const own = name === "Chromium" ? null : steady(await type.launch({ headless: true }));
    const blockedContext = await (own ?? browser).newContext();
    const saveCase = `${name} with JavaScript and the builder's module not loading: the Save button saves twice without navigation`;
    const filterCase = `${name} with JavaScript and the builder's module not loading: the Filter button is drawn and sends the GET the server filters`;
    const noteCase = `${name} with the builder's module not loading: the server's save note is drawn`;
    /** @type {string[]} */
    const blockedErrors = [];
    try {
      const blocked = await blockedContext.newPage();
      let aborted = 0;
      const moduleUrls = new Set();
      blocked.on("console", (m) => {
        if (m.type() !== "error") return;
        const message = m.text();
        // Only the browser's aborted resource and the runtime's report for this exact module
        // are expected. In particular, no uncaught page error (even from this URL) is ignored.
        if (moduleUrls.has(m.location().url) && /^Failed to load resource: net::ERR_FAILED\b/.test(message)) return;
        if ([...moduleUrls].some((url) => message.startsWith(`corten: script module ${new URL(url).pathname} did not load (is its component in App::components?)`))) return;
        blockedErrors.push(message);
      });
      blocked.on("pageerror", (e) => blockedErrors.push(e.message));
      await blocked.route((url) => url.pathname.endsWith("/deck_builder.js"), (route) => {
        aborted += 1;
        moduleUrls.add(route.request().url());
        return route.abort();
      });
      await blocked.goto(base);
      // The runtime ran, and it found no builder module to hand events to.
      const ran = await blocked.evaluate(async () => {
        const { ready } = await import("corten");
        await ready;
        return document.querySelectorAll('script[type="module"][src$="/deck_builder.js"]').length;
      });
      const loadedAt = Number(await version(blocked));
      const count = 'li[data-key="gravel-sprite"] input[type=number]';
      let navigations = 0;
      blocked.on("framenavigated", (frame) => { if (frame === blocked.mainFrame()) navigations += 1; });
      if (!(await blocked.isVisible(saveButton))) {
        check(saveCase, false, `aborted ${aborted}; the Save button is not drawn`);
      } else {
        const startCount = await blocked.inputValue(count);
        const saves = [];
        for (const copies of [startCount === "2" ? "3" : "2", "1"]) {
          await blocked.fill(count, copies);
          const [response] = await Promise.all([
            blocked.waitForResponse((r) => isSave(r.request()), { timeout: 15_000 }),
            blocked.click(saveButton),
          ]);
          const body = await response.text();
          const fields = saveFields(response.request());
          await blocked.locator('form[method=post][aria-busy="true"]').waitFor({ state: "hidden" });
          saves.push({ status: response.status(), sent: fields.get("version"), shown: await version(blocked), key: fields.get("submit"), saved: body.includes("Saved.") });
          if (copies !== "1") {
            const note = await blocked.locator("#save-note").textContent();
            const drawn = await drawnKeys(blocked, "#save-note", "id");
            check(noteCase, note === "Saved." && drawn.length === 1, `note: ${note}; drawn: ${drawn.length}`);
          }
        }
        const fresh = await blockedContext.newPage();
        await fresh.goto(base);
        const serverVersion = await version(fresh);
        const serverCount = await fresh.inputValue(count);
        await fresh.close();
        const [first, second] = saves;
        check(
          saveCase,
          aborted > 0 && ran === 1 && navigations === 0 &&
            saves.every((save, i) => save.status === 200 && save.saved && save.sent === String(loadedAt + i) && save.shown === String(loadedAt + i + 1)) &&
            !!first.key && !!second.key && first.key !== second.key && serverCount === "1" && Number(serverVersion) === loadedAt + 2,
          `aborted ${aborted}; ${saves.map((save) => `POST ${save.status} at ${save.sent}, page at ${save.shown}`).join("; ")}; ${navigations} navigations; saved count ${serverCount} at ${serverVersion}`,
        );
      }
      const button = "form[role=search] button";
      await blocked.fill("input[type=search]", "oracle");
      // Typing filtered nothing: no builder handler ran.
      const before = await drawnKeys(blocked, "tbody tr", "data-key");
      const all = await blocked.locator("tbody tr").count();
      if (!(await blocked.isVisible(button))) {
        check(filterCase, false, `aborted ${aborted}; the Filter button is not drawn`);
      } else {
        // The runtime sends a GET form itself (a client navigation), so the answer may be a fetch
        // rather than a document load: either is the server's filter.
        const answered = blocked.waitForResponse((r) => new URL(r.url()).searchParams.get("q") === "oracle", { timeout: 15_000 });
        const [response] = await Promise.all([answered, blocked.waitForURL(/[?&]q=oracle/), blocked.click(button)]);
        // The server's own answer first: of its collection rows, only those that match are shown.
        const rowsAnswered = Array.from((await response.text()).matchAll(/<tr\b([^>]*)>/g), ([, attrs]) => ({
          key: /data-key="([^"]+)"/.exec(attrs)?.[1] ?? "",
          hidden: /\shidden(?=[\s=>]|$)/.test(attrs),
        })).filter((r) => r.key !== "");
        const shownAnswered = rowsAnswered.filter((r) => !r.hidden).map((r) => r.key);
        const answerFiltered = rowsAnswered.length === all && shownAnswered.join() === "salt-oracle";
        // Then the page: a client navigation draws the answer after its response; give it a
        // moment, then read it.
        await blocked.waitForFunction(() => document.querySelectorAll("tbody tr:not([hidden])").length === 1, null, { timeout: 5_000 }).catch(() => {});
        const shownRows = await drawnKeys(blocked, "tbody tr", "data-key");
        check(
          filterCase,
          aborted > 0 && ran === 1 && before.length === all && response.request().method() === "GET" && response.status() === 200 && answerFiltered && shownRows.join() === "salt-oracle",
          `aborted ${aborted}; ${before.length} of ${all} shown before; ${response.request().method()} ${response.request().resourceType()} ${response.status()}; answered ${shownAnswered.join()} of ${rowsAnswered.length} rows; drawn: ${shownRows.join()}; ${blocked.url()}`,
        );
      }
    } catch (error) {
      check(`${name} with JavaScript and the builder's module not loading`, false, String(error));
    } finally {
      await blockedContext.close();
      await own?.close();
      check(`${name} with the builder's module not loading: no unexpected page or console errors`, blockedErrors.length === 0, blockedErrors.join(" | "));
    }
  }

  // The refused, stale, unreachable and cut-off saves above are the browser's own lines for those
  // answers.
  const unexpected = errors.filter((e) => !/Failed to load resource: (the server responded with a status of (409|422)\b|net::ERR_(FAILED|CONTENT_LENGTH_MISMATCH))/.test(e));
  check("no other errors in the console", unexpected.length === 0, unexpected.join(" | "));
} finally {
  await browser.close();
}

for (const [name, value] of Object.entries(timings)) console.log(`time ${name}: ${value}`);
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
