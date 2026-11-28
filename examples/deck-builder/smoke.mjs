// Browser smoke test and timings for the deck builder: every move in the browser, autosave with
// its refusals, another tab's edits, and the same forms with JavaScript off or the builder blocked.
// Usage: node examples/deck-builder/smoke.mjs http://localhost:18487 [--autosave-only | --handoff-only]
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
  // The live request follows the snapshot and proves the builder has started.
  await Promise.all([page.waitForRequest(isLive, { timeout: 10_000 }), page.goto(base)]);
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
const settled = (page, note = "Saved.", timeout) =>
  page.waitForFunction((note) => {
    const s = /** @type {HTMLElement} */ (document.querySelector("[role=status][data-state]"));
    return s.dataset.state === "" && document.getElementById("save-note")?.textContent?.startsWith(note);
  }, note, { timeout });
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
const selectedCount = (page) => page.locator("[class$=__picks] output").textContent();
const selectAll = (page) => page.getByRole("checkbox", { name: "Select every card shown" });
const version = (page) => page.inputValue("input[name=version]");
const saveButton = 'form[method=post] button:text-is("Save")';
const filterButton = "form[role=search] button";
const home = new URL("/", base).href;
const deckUrl = new URL("deck", home).href;
const isSave = (request) => request.method() === "POST" && request.url() === deckUrl;
const isLive = (request) => new URL(request.url()).pathname === "/feed/deck/live";
const builderModule = (url) => url.pathname.endsWith("/deck_builder.js");
const saveFields = (request) => new URLSearchParams(request.postData() ?? "");
const postedGravel = (request) => {
  const fields = saveFields(request);
  return fields.getAll("count")[fields.getAll("card").indexOf("gravel-sprite")];
};

/** Two edits in one enhanced document, each acknowledged before the next. */
async function successiveAutosaves() {
  const context = await browser.newContext();
  try {
    context.setDefaultTimeout(10_000);
    const page = await open(context);
    // A save must be acknowledged even if the browser cannot fetch another app script.
    const scripts = "**/scripts/*.js";
    await page.route(scripts, (route) => route.abort());
    const count = page.locator('li[data-key="gravel-sprite"] input[type=number]');
    const start = await count.inputValue();
    const loaded = Number(await version(page));
    let previousKey;
    for (const [index, copies] of [start === "2" ? "3" : "2", start].entries()) {
      const [reply] = await Promise.all([
        page.waitForResponse((r) => isSave(r.request()) && postedGravel(r.request()) === copies, { timeout: 5_000 }).catch((error) => {
          if (error.name !== "TimeoutError") throw error;
          return null;
        }),
        (async () => {
          await count.fill(copies);
          await page.locator(saveButton).click();
        })(),
      ]);
      const fields = reply && saveFields(reply.request());
      const key = fields?.get("submit");
      check(`autosave ${index + 1}: sends a new non-navigation POST and gets a 200 patch`,
        reply?.status() === 200 && !reply.request().isNavigationRequest() && "corten-patch" in reply.headers() &&
        !!key && key !== previousKey && fields?.get("version") === String(loaded + index) && fields?.get("draft") === String(index + 1),
        reply ? `HTTP ${reply.status()}` : "no matching POST response");
      const ack = reply && await settled(page, "Saved.", 5_000).then(() => true, (error) => {
        if (error.name !== "TimeoutError") throw error;
        return false;
      });
      check(`autosave ${index + 1}: acknowledges the patch and advances the version without navigating`,
        !!ack && await version(page) === String(loaded + index + 1) && page.url() === home, JSON.stringify(await status(page)));
      previousKey = key;
    }
    await page.unroute(scripts);
    await page.reload();
    const savedCount = await count.inputValue();
    const savedVersion = Number(await version(page));
    check("the server kept both autosaves", savedCount === start && savedVersion === loaded + 2,
      `count ${start} to ${savedCount}, version ${loaded} to ${savedVersion}`);
  } finally {
    await context.close();
  }
}

/** Holds exactly one answer until the test has observed the edit it is meant to cover. */
async function holdSave(page) {
  const held = Promise.withResolvers();
  await page.route("**/deck", async (route) => {
    await held.promise;
    await route.continue();
  }, { times: 1 });
  return () => held.resolve(undefined);
}

/** A box can still be invisible if it or an ancestor has zero opacity. */
const drawn = (locator) => locator.evaluate((el) => {
  const { width, height } = el.getBoundingClientRect();
  if (!width || !height || getComputedStyle(el).visibility !== "visible") return false;
  for (let at = el; at; at = at.parentElement) if (Number(getComputedStyle(at).opacity) === 0) return false;
  return true;
});

/** Block only the app's builder. The runtime runs but the deck form submits natively. */
async function blockedBuilder(engine, name) {
  const own = engine === chromium ? null : steady(await engine.launch({ timeout: 15_000 }), { gateInitialWebKitLoad: true });
  const context = await (own ?? browser).newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    let blocked = 0;
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await context.route(builderModule, (route) => {
      blocked += 1;
      return route.abort();
    });
    await page.goto(home, { timeout: 12_000 });
    check(`${name}: the builder module was requested and blocked`, blocked > 0);
    const save = page.locator(saveButton);
    const filter = page.locator(filterButton);
    check(`${name}: Filter and Save are drawn with the builder blocked`, await drawn(filter) && await drawn(save));

    const count = page.locator('li[data-key="gravel-sprite"] input[type=number]');
    const write = async (button) => {
      const previous = Number(await version(page));
      const [post, get] = await Promise.all([
        page.waitForResponse((r) => isSave(r.request())),
        page.waitForResponse((r) => r.url() === home && r.request().method() === "GET"),
        button.click(),
      ]);
      await page.waitForFunction((expected) =>
        /** @type {HTMLInputElement | null} */ (document.querySelector("input[name=version]"))?.value === expected,
      String(previous + 1));
      const fields = saveFields(post.request());
      return post.request().isNavigationRequest() && post.status() === 303 && post.headers().location === "/" && get.status() === 200 &&
        fields.get("draft") === "0" && fields.get("version") === String(previous);
    };
    const first = (await count.inputValue()) === "2" ? "3" : "2";
    await count.fill(first);
    const firstSaved = await write(save) && await count.inputValue() === first;
    await count.fill("1");
    check(`${name}: two successive fallback Saves redirect and show the saved count`,
      await write(save) && firstSaved && await count.inputValue() === "1");

    const before = await deck(page);
    const id = (await page.locator("tbody tr[data-key]:not([hidden])").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-key"))))
      .find((id) => id && !(id in before));
    if (!id) throw new Error("no card outside the saved deck");
    const added = await write(row(page, id).getByRole("button", { name: "Add", exact: true })) && (await deck(page))[id] === 1;
    await count.fill("2");
    const afterSave = await write(save);
    check(`${name}: fallback Add survives the next Save`, added && afterSave && (await deck(page))[id] === 1);

    // Two native posts from copies of the same form. Separate documents let
    // the test send the second while Playwright is waiting on the first navigation.
    for (const committed of [false, true]) {
      const firstPage = await context.newPage();
      const nextPage = await context.newPage();
      const firstCount = committed ? "2" : "1";
      const nextCount = committed ? "1" : "3";
      const release = Promise.withResolvers();
      const held = Promise.withResolvers();
      try {
        firstPage.setDefaultTimeout(8_000);
        nextPage.setDefaultTimeout(8_000);
        await Promise.all([firstPage.goto(home, { timeout: 12_000 }), nextPage.goto(home, { timeout: 12_000 })]);
        const before = await version(firstPage);
        const key = await firstPage.locator("input[name=submit]").inputValue();
        await nextPage.locator("input[name=submit]").evaluate((el, value) => { el.value = value; }, key);
        const firstInput = firstPage.locator('li[data-key="gravel-sprite"] input[type=number]');
        const nextInput = nextPage.locator('li[data-key="gravel-sprite"] input[type=number]');
        await firstInput.fill(firstCount);
        await nextInput.fill(nextCount);
        await firstPage.route(deckUrl, async (route) => {
          const answer = committed ? await route.fetch({ maxRedirects: 0, timeout: 5_000 }).catch((error) => error) : null;
          held.resolve(answer);
          await release.promise;
          await route.abort().catch(() => {});
        }, { times: 1 });
        const [first] = await Promise.all([
          firstPage.waitForRequest(isSave),
          firstPage.locator(saveButton).evaluate((button) => button.click()),
        ]);
        const answer = await held.promise;
        if (answer instanceof Error) throw answer;
        check(`${name}: first native POST was ${committed ? "committed without its answer" : "held before sending"}`,
          first.isNavigationRequest() && postedGravel(first) === firstCount && (!committed || answer?.status() === 303));

        const [second] = await Promise.all([
          nextPage.waitForResponse((r) => isSave(r.request()) && postedGravel(r.request()) === nextCount),
          nextPage.locator(saveButton).evaluate((button) => button.click()),
        ]);
        await nextPage.waitForFunction((next) => document.querySelector("input[name=version]")?.value === next, String(Number(before) + 1));
        const fields = saveFields(second.request());
        const sameForm = key && key === saveFields(first).get("submit") && key === fields.get("submit") && before === fields.get("version");
        const note = nextPage.locator("#save-note").filter({ hasText: "Not saved: This form already saved a different edit." });
        check(`${name}: ${committed ? "changed resend visibly conflicts without overwriting" : "new native Save succeeds while the first is unsent"}`,
          sameForm && second.request().isNavigationRequest() &&
          (committed
            ? second.status() === 409 && await drawn(note) && await nextInput.inputValue() === firstCount
            : second.status() === 303 && await nextInput.inputValue() === nextCount));
      } finally {
        release.resolve(undefined);
        await Promise.all([firstPage.close(), nextPage.close()]);
      }
    }
    await page.reload();

    await count.fill("99");
    const [refusal] = await Promise.all([page.waitForResponse((r) => isSave(r.request())), save.click()]);
    const note = page.locator("#save-note").filter({ hasText: "Not saved:" });
    await note.waitFor();
    check(`${name}: fallback refusal draws the page's reason`, refusal.request().isNavigationRequest() &&
      refusal.status() === 422 && await drawn(note));

    const all = await page.locator("tbody tr:not([hidden])").count();
    await page.locator("input[type=search]").fill("oracle");
    const typingKeptRows = all > 1 && await page.locator("tbody tr:not([hidden])").count() === all;
    const [get] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).searchParams.get("q") === "oracle"),
      filter.click(),
    ]);
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll("tbody tr:not([hidden])");
      return rows.length === 1 && rows[0].getAttribute("data-key") === "salt-oracle";
    });
    check(`${name}: fallback Filter sends a GET and draws the matching row`, typingKeptRows && get.status() === 200 &&
      new URL(page.url()).searchParams.get("q") === "oracle" && await drawn(row(page, "salt-oracle")));
    check(`${name}: no uncaught errors with the builder blocked`, pageErrors.length === 0, pageErrors.join(" | "));
  } finally {
    try { await context.close(); } finally { await own?.close(); }
  }
}

/** Let a native POST commit without navigating the document whose module is still loading. */
async function withholdNativeRedirect(page, button) {
  const context = page.context();
  const form = page.locator("form[method=post]");
  const [target] = await Promise.all([
    page.waitForEvent("popup"),
    form.evaluate((form) => {
      if (!window.open("about:blank", "withheldSave")) throw new Error("Could not open the answer window");
      form.target = "withheldSave";
    }),
  ]);
  try {
    let sent;
    await context.route(deckUrl, async (route) => {
      const actual = await route.fetch({ maxRedirects: 0, timeout: 5_000 });
      sent = { status: actual.status(), request: route.request() };
      await route.fulfill({ status: 204, body: "" });
    }, { times: 1 });
    await Promise.all([
      context.waitForEvent("response", { predicate: (r) => isSave(r.request()) && r.status() === 204, timeout: 8_000 }),
      button.evaluate((el) => el.click()),
    ]);
    if (!sent) throw new Error("No native save was captured");
    return sent;
  } finally {
    await form.evaluate((form) => form.removeAttribute("target"));
    await target.close();
  }
}

/** Use the real module, but release it only after the player has edited the plain HTML. */
async function delayedBuilder(scenario) {
  const context = await browser.newContext();
  const resume = Promise.withResolvers();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    const count = page.locator('li[data-key="gravel-sprite"] input[type=number]');
    const other = page.locator('li[data-key="ashen-drake"] input[type=number]');
    const post = async (button = page.locator(saveButton)) => {
      const [answer] = await Promise.all([page.waitForResponse((r) => isSave(r.request())), button.evaluate((el) => el.click())]);
      return answer;
    };
    if (scenario === "lost answer") {
      const plain = await browser.newContext({ javaScriptEnabled: false });
      try {
        const seed = await plain.newPage();
        await seed.goto(home);
        await seed.locator('li[data-key="gravel-sprite"] input[type=number]').fill("3");
        await Promise.all([seed.waitForEvent("load"), seed.locator(saveButton).click()]);
      } finally {
        await plain.close();
      }
    }
    await page.route(builderModule, async (route) => {
      await resume.promise;
      await route.continue();
    }, { times: 1 });
    await Promise.all([
      page.waitForRequest((request) => builderModule(new URL(request.url()))),
      page.goto(home, { waitUntil: "commit" }),
    ]);
    const edited = (await count.inputValue()) === "2" ? "3" : "2";
    const incomplete = scenario === "incomplete";
    const removing = scenario === "removed";
    const otherEdited = incomplete && (await other.inputValue()) === "1" ? "2" : "1";
    const previous = Number(await version(page));
    const key = await page.locator("input[name=submit]").inputValue();
    const visible = page.locator("tbody tr:not([hidden])");
    await (incomplete || removing ? other : count).fill(removing ? "" : incomplete ? otherEdited : edited);
    // Focusing the query commits the first count's change before the module can handle it.
    await page.locator("input[type=search]").fill("oracle");
    if (removing) await count.focus();
    if (incomplete) await count.fill("");
    const focused = incomplete || removing ? await count.elementHandle() : null;
    const beforeStart = await focused?.evaluate((el) => ({ value: el.value, focused: document.activeElement === el }));
    if (scenario === "lost answer") {
      const sent = await withholdNativeRedirect(page, page.locator(saveButton));
      check("the withheld native answer was a real 303 for count 2",
        sent.status === 303 && sent.request.isNavigationRequest() && postedGravel(sent.request) === "2" &&
        saveFields(sent.request).get("submit") === key);
      const saved = await context.newPage();
      try {
        await saved.goto(home, { waitUntil: "domcontentloaded" });
        check("the original page still has the old version after the server saved 2", Number(await version(page)) === previous &&
          Number(await version(saved)) === previous + 1 && (await deck(saved))["gravel-sprite"] === 2);
      } finally {
        await saved.close();
      }
    }
    check("typing before the builder starts leaves the collection unfiltered", await visible.count() > 1);
    const loaded = page.waitForEvent("load");
    resume.resolve(undefined);
    await loaded;

    if (scenario === "lost answer" && await page.locator("form[data-patch]").count()) {
      const keep = page.getByRole("button", { name: "Keep both changes" });
      await keep.waitFor();
      await post(keep);
      await settled(page);
      const actual = (await deck(page))["gravel-sprite"];
      check("a lost native answer does not offer a merge", false, `Keep both left ${actual} copies`);
      return;
    }

    if (focused) {
      check(`${scenario}: startup preserves the same focused field`, beforeStart?.focused &&
        await focused.evaluate((el, before) => el.isConnected && el.value === before && document.activeElement === el, beforeStart?.value));
      if (incomplete) await page.keyboard.type(edited);
    } else {
      await page.locator(filterButton).click();
      check("Filter applies the query typed before startup without navigating", page.url() === home &&
        await visible.count() === 1 && await visible.first().getAttribute("data-key") === "salt-oracle");
    }

    // Keep focus in the count, as some browsers do when pressing a button.
    const saved = await post();
    if (!saved.request().isNavigationRequest()) await settled(page);
    await page.waitForFunction((v) => document.querySelector("input[name=version]")?.value === v, String(previous + 1));
    check(`${scenario}: Save stays native with the original form key and version`, saved.request().isNavigationRequest() &&
      saved.status() === 303 && saveFields(saved.request()).get("draft") === "0" &&
      saveFields(saved.request()).get("version") === String(previous) && saveFields(saved.request()).get("submit") === key);
    if (!focused) {
      check(`${scenario}: native Save posts the local filter and returns to the matching row`,
        saveFields(saved.request()).get("q") === "oracle" && new URL(page.url()).searchParams.get("q") === "oracle" &&
        await visible.count() === 1 && await visible.first().getAttribute("data-key") === "salt-oracle");
    }
    if (removing) check("Save removes the cleared row from the page it leaves open", await other.count() === 0);
    else check(`${scenario}: Save leaves the intended count, not a second change`,
      await count.inputValue() === edited && (!incomplete || await other.inputValue() === otherEdited));
    await page.waitForSelector("form[data-patch]");
  } finally {
    resume.resolve(undefined);
    await context.close();
  }
}

/** A refusal rendered as a new document has no autosave to acknowledge. */
async function nativeRefusal(code) {
  const context = await browser.newContext();
  const resume = Promise.withResolvers();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    await context.route(builderModule, (route) => route.abort());
    await page.goto(home);
    const count = (p) => p.locator('li[data-key="gravel-sprite"] input[type=number]');
    const original = await count(page).inputValue();
    const edited = original === "2" ? "3" : "2";
    if (code === 409) {
      const other = await context.newPage();
      await other.goto(home);
      await count(other).fill(edited);
      await Promise.all([other.waitForEvent("load"), other.locator(saveButton).click()]);
      await other.close();
    } else {
      await count(page).fill("99");
    }
    await page.route(builderModule, async (route) => { await resume.promise; await route.continue(); }, { times: 1 });
    const [refusal] = await Promise.all([
      page.waitForResponse((r) => isSave(r.request())),
      page.waitForRequest((r) => builderModule(new URL(r.url()))),
      page.locator(saveButton).evaluate((el) => el.click()),
    ]);
    check(`native ${code}: the refusal is a full navigation with its reason`, refusal.status() === code &&
      refusal.request().isNavigationRequest() && (await page.textContent("#save-note")).includes("Not saved:"));
    check(`native ${code}: the notice has no autosave handler`, await page.locator("#save-note").getAttribute("data-on") === null);
    const previous = Number(await version(page));
    const intended = code === 409 ? original : edited;
    if (code === 422) await count(page).fill(intended);
    const before = await deck(page);
    const loaded = page.waitForEvent("load");
    resume.resolve();
    await loaded;
    const field = count(page);
    if (code === 422) {
      const kept = sameDeck(await deck(page), before) && await field.count() === 1 &&
        await field.inputValue() === intended && await field.evaluate((el) => el === document.activeElement);
      check("native 422: startup keeps the focused edit on the refusal page", kept);
      if (!kept) return;
    } else {
      await page.waitForSelector("form[data-patch]");
      await field.fill(intended);
    }
    const [next] = await Promise.all([
      page.waitForResponse((r) => isSave(r.request()), { timeout: 5_000 }).catch((e) => {
        if (e.name !== "TimeoutError") throw e;
        return null;
      }),
      code === 422 ? page.locator(saveButton).click() : field.press("Tab"),
    ]);
    if (next && code === 409) await settled(page);
    check(`native ${code}: the next edit saves by ${code === 409 ? "patch" : "native form"}`,
      next?.status() === (code === 409 ? 200 : 303) && next.request().isNavigationRequest() === (code === 422) &&
      postedGravel(next.request()) === intended && Number(await version(page)) === previous + 1 && await field.inputValue() === intended);
  } finally {
    resume.resolve();
    await context.close();
  }
}

/** Add can save before startup while all count controls still match the first draw. */
async function nativeAddHandoff(selected) {
  const name = selected ? "Add selected" : "Add";
  const context = await browser.newContext();
  const resumeModule = Promise.withResolvers();
  const resumeFeed = Promise.withResolvers();
  const snapshotUrl = new URL("feed/deck", home).href;
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    await page.route(builderModule, async (route) => {
      await resumeModule.promise;
      await route.continue();
    }, { times: 1 });
    await page.route(snapshotUrl, async (route) => {
      await resumeFeed.promise;
      await route.continue().catch(() => {});
    }, { times: 1 });
    await Promise.all([
      page.waitForRequest((request) => builderModule(new URL(request.url()))),
      page.goto(home, { waitUntil: "commit" }),
    ]);
    const key = await page.locator("input[name=submit]").inputValue();
    const previous = Number(await version(page));
    const id = await page.locator("tbody tr[data-key]").evaluateAll((rows) => rows.find((row) => {
      const [inDeck, owned] = row.querySelectorAll("td:nth-child(6) span");
      return inDeck?.textContent === "0" && Number(owned?.textContent) >= 2;
    })?.getAttribute("data-key"));
    if (!id) throw new Error("No unplayed card with two owned copies");
    const add = row(page, id).getByRole("button", { name: "Add", exact: true });
    const pick = row(page, id).getByRole("checkbox");
    const button = selected ? page.getByRole("button", { name, exact: true }) : add;
    if (selected) {
      check("only individual cards can be checked before startup", await selectAll(page).isDisabled() && await pick.isEnabled());
      const background = () => row(page, id).evaluate((el) => getComputedStyle(el).backgroundColor);
      const unselected = await background();
      await pick.check();
      await page.mouse.move(0, 0);
      check("a checkbox checked before startup highlights its row", unselected !== await background());
    }
    const sent = await withholdNativeRedirect(page, button);
    const fields = saveFields(sent.request);
    check(`${name}: native POST committed while the count controls stayed pristine`,
      sent.status === 303 && sent.request.isNavigationRequest() && fields.get("submit") === key && fields.get("draft") === "0" &&
      (selected ? fields.has("add_picked") && fields.getAll("pick").join() === id : fields.get("add") === id) &&
      (await deck(page))[id] === undefined && await page.locator('input[name=count]').evaluateAll((inputs) =>
        inputs.every((input) => input.value === input.defaultValue)));

    const started = Promise.all([page.waitForRequest(snapshotUrl), page.waitForSelector("form[data-patch]")]);
    resumeModule.resolve(undefined);
    await started;
    if (selected) {
      check("startup keeps the checked card, selected count and mixed select-all state",
        await selectAll(page).isEnabled() && await pick.isChecked() && await selectedCount(page) === "1" &&
        await selectAll(page).evaluate((box) => !box.checked && box.indeterminate));
    }
    const [reply] = await Promise.all([
      page.waitForResponse((r) => isSave(r.request())),
      button.click(),
    ]);
    const retry = saveFields(reply.request());
    resumeFeed.resolve(undefined);
    const note = page.locator("#save-note").filter({ hasText: "This form already saved before autosave started." });
    const keep = page.getByRole("button", { name: "Keep both changes" });
    await note.or(keep).waitFor();
    const nextKey = await page.locator("input[name=submit]").inputValue();
    const headers = reply.headers();
    const preserved = reply.status() === 409 && "corten-shell" in headers && !("corten-patch" in headers) && !("corten-page" in headers) &&
      !reply.request().isNavigationRequest() && retry.get("draft") === "1" && retry.get("submit") === key &&
      retry.get("version") === String(previous) && retry.getAll("count")[retry.getAll("card").indexOf(id)] === "1" &&
      await drawn(note) && !(await keep.isVisible()) &&
      (await deck(page))[id] === 1 && Number(await version(page)) === previous + 1 && nextKey !== key;
    check(`${name}: autosave cannot acknowledge or merge the native write; the new form shows one copy`, preserved);
    if (!preserved) return;

    // An intentional new edit on the fresh form still uses the normal scripted queue.
    await page.waitForSelector("form[data-patch]");
    const [fresh] = await Promise.all([page.waitForResponse((r) => isSave(r.request())), add.evaluate((el) => el.click())]);
    await settled(page);
    check(`${name}: the fresh clean form saves a new edit by patch`,
      fresh.status() === 200 && "corten-patch" in fresh.headers() && saveFields(fresh.request()).get("submit") === nextKey &&
      (await deck(page))[id] === 2 && Number(await version(page)) === previous + 2);
  } finally {
    resumeModule.resolve(undefined);
    resumeFeed.resolve(undefined);
    await context.close();
  }
}

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

async function smoke() {
  const context = await browser.newContext();
  context.setDefaultTimeout(10_000);
  const page = await open(context);
  const nav = await page.evaluate(() => {
    const t = /** @type {PerformanceNavigationTiming} */ (performance.getEntriesByType("navigation")[0]);
    return { observed: performance.now(), dcl: t.domContentLoadedEventEnd, rows: document.querySelectorAll("tbody tr").length, bytes: t.transferSize };
  });
  timings["first load: DOMContentLoaded end / smoke sample after load and deck live request"] =
    `${nav.dcl.toFixed(0)} / ${nav.observed.toFixed(0)} ms, ${nav.rows} rows, ${(nav.bytes / 1024).toFixed(0)} KB transferred`;
  const start = await deck(page);
  check("the page shows the collection and the saved deck", nav.rows === 240 && start["gravel-sprite"] === 3 && (await total(page)) === "10", JSON.stringify(start));
  check("an untouched first load starts with no cards selected",
    await selectedCount(page) === "0" && await selectAll(page).evaluate((box) => !box.checked && !box.indeterminate));

  // Filter and sort, in the page.
  await time(page, "filter 240 rows", () => {
    const input = /** @type {HTMLInputElement} */ (document.querySelector("input[type=search]"));
    input.value = "drake";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const visible = await page.locator("tbody tr:not([hidden])").count();
  check("the filter shows the matching cards and how many", visible === 1 && (await page.textContent("[class$=__counts] output")) === "1 of 240 shown", `${visible}`);
  await selectAll(page).check();
  check("after startup select-all checks the matching card only", await selectedCount(page) === "1" &&
    await row(page, "ashen-drake").getByRole("checkbox").isChecked());
  await selectAll(page).uncheck();
  const filter = page.locator(filterButton);
  const save = page.locator(saveButton);
  let posts = 0;
  const recordSave = (request) => { if (isSave(request)) posts += 1; };
  page.on("request", recordSave);
  const buttonsDrawn = await drawn(filter) && await drawn(save);
  if (buttonsDrawn) {
    await filter.click({ timeout: 5_000 });
    await save.click({ timeout: 5_000 });
  }
  page.off("request", recordSave);
  check("with the builder running, the drawn Filter and idle Save buttons keep the page",
    buttonsDrawn && page.url() === home && await page.locator("tbody tr:not([hidden])").count() === 1 && posts === 0);
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
  const loaded = Number(await version(page));
  const releaseAdd = await holdSave(page);
  const answered = page.waitForResponse((r) => isSave(r.request()), { timeout: 10_000 });
  const painted = (async () => {
    try {
      // Read the animation markers in the same turn as the click, before they clear.
      const motion = await row(page, "pearl-diver").getByRole("button", { name: "Add", exact: true }).evaluate((button) => {
        /** @type {HTMLButtonElement} */ (button).click();
        return ['tbody tr[data-key="pearl-diver"]', 'ul li[data-key="pearl-diver"]'].map((selector) => {
          const el = document.querySelector(selector);
          return [el?.getAttribute("data-motion"), el && getComputedStyle(el).animationName];
        });
      }, undefined, { timeout: 5_000 });
      check("Add shows the card in the deck at once, before the server answers", (await deck(page))["pearl-diver"] === 1 && (await status(page)).state === "saving");
      const readouts = [await total(page), await page.textContent("figure ol li:nth-child(3) span"), await row(page, "pearl-diver").locator("td:nth-child(6) span").first().textContent()];
      check("the count, the curve and the collection row follow", readouts.join() === "11,5,1", readouts.join());
      check("a change marks the collection row and deck line for motion",
        motion[0][0]?.startsWith("card-") === true && motion[1][0]?.startsWith("line-") === true);
      const animations = motion.map(([, animation]) => animation);
      check("the motion markers select the component animations", animations.every((name) => name && name !== "none"), animations.join(", "));
      await page.waitForFunction(() => !document.querySelector('tbody tr[data-motion], ul li[data-motion]'), null, { timeout: 5_000 });
      check("motion markers clear after the animation", !(await page.locator("[data-motion]").count()));
    } finally {
      releaseAdd();
    }
  })();
  await Promise.all([answered, painted]);
  await settled(page);
  check("the save is answered and the page takes the next version", Number(await version(page)) === loaded + 1, `${loaded} then ${await version(page)}`);
  await time(page, "Add (a change drawn and sent)", () => /** @type {HTMLElement} */ (document.querySelector('tbody tr[data-key="undertow-serpent"] td:last-child button')).click());
  await settled(page);

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

  // Select several and add them.
  await row(page, "lantern-warden").locator("input[type=checkbox]").check();
  await row(page, "moth-court-herald").locator("input[type=checkbox]").check();
  check("checking rows counts them", (await page.textContent("[class$=__picks] output")) === "2");
  await page.click("button:has-text('Add selected')");
  const picked = await deck(page);
  check("Add selected adds one of each and clears the selection", picked["lantern-warden"] === 3 && picked["moth-court-herald"] === 3 && await selectedCount(page) === "0", JSON.stringify(picked));
  await settled(page);

  // A change the rules refuse is rolled back, with their words.
  await row(page, "ashen-drake").locator("button", { hasText: "Add" }).click();
  await settled(page);
  const releaseRefusal = await holdSave(page);
  try {
    await row(page, "ashen-drake").locator("button", { hasText: "Add" }).click();
    check("a third Ashen Drake shows at once", (await deck(page))["ashen-drake"] === 3, JSON.stringify(await deck(page)));
  } finally {
    releaseRefusal();
  }
  await settled(page, "Not saved:");
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

  // Drag and drop, both ways.
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
  const releaseStale = await holdSave(page);
  const stale = page.waitForResponse((r) => isSave(r.request()));
  const afterOther = (async () => {
    try {
      await row(page, "kiln-colossus").locator("button", { hasText: "Add" }).click();
      await other.locator('tbody tr[data-key="undertow-serpent"] td:last-child button').click();
      await settled(other);
    } finally {
      releaseStale();
    }
  })();
  const [staleSave] = await Promise.all([stale, afterOther]);
  check("a save built on an old version is refused as stale", staleSave.status() === 409);
  await page.waitForSelector("[role=alert]:not([hidden])");
  check("the page offers to keep both changes or take the other tab's deck", (await page.textContent("[role=alert]")).includes("changed in another tab"));
  await page.click("button:has-text('Keep both changes')");
  await settled(page);
  const both = await deck(page);
  check("keeping both saves the other tab's change with this one", both["undertow-serpent"] === 2 && both["kiln-colossus"] === 1, JSON.stringify(both));
  check("and the other tab takes the merged deck", await comesToShow(other, "kiln-colossus", 1));

  // Take theirs: this page's change is dropped.
  const releaseTheirs = await holdSave(page);
  try {
    await row(page, "lantern-warden").locator("button", { hasText: "Add" }).click();
    await other.fill('li[data-key="undertow-serpent"] input[type=number]', "1");
    await other.press('li[data-key="undertow-serpent"] input[type=number]', "Enter");
    await settled(other);
  } finally {
    releaseTheirs();
  }
  await page.waitForSelector("[role=alert]:not([hidden])");
  await page.click("button:has-text(\"Use the other tab's deck\")");
  const theirs = await deck(page);
  check("taking the other tab's deck drops this page's change", theirs["undertow-serpent"] === 1 && theirs["lantern-warden"] === 3 && sameDeck(theirs, await deck(other)), JSON.stringify(theirs));

  // The server cannot be reached: nothing is lost, and Save retries through autosave.
  await page.route("**/deck", (route) => route.abort());
  await row(page, "pearl-diver").locator("button", { hasText: "Add" }).click();
  await page.waitForFunction(() => /** @type {HTMLElement} */ (document.querySelector("[role=status][data-state]")).dataset.state === "offline");
  check("an unreachable server keeps the change and says it is not saved", (await deck(page))["pearl-diver"] === 2 && (await page.isVisible("button:has-text('Try again')")));
  await page.unroute("**/deck");
  await save.click({ timeout: 5_000 });
  await settled(page);
  check("Save retries the pending edit", (await status(page)).note.startsWith("Saved.") && (await deck(page))["pearl-diver"] === 2);
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
  let letLive = () => {};
  const held = new Promise((resolve) => (letLive = () => resolve(undefined)));
  await third.route("**/feed/deck/live**", async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  // The snapshot has arrived when the feed asks for its live stream.
  await Promise.all([third.waitForRequest(isLive), third.goto(base)]);
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
  let letFourth = () => {};
  const fourthHeld = new Promise((resolve) => (letFourth = () => resolve(undefined)));
  await fourth.route("**/feed/deck/live**", async (route) => {
    await fourthHeld;
    await route.continue().catch(() => {});
  });
  await Promise.all([fourth.waitForRequest(isLive), fourth.goto(base)]);
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
  phone.setDefaultTimeout(10_000);
  const small = await open(phone);
  const wide = await small.evaluate(() => document.documentElement.scrollWidth);
  check("at 390 px the page fits the screen", wide <= 390, `${wide}`);

  // Without JavaScript: the same deck, built with forms.
  const plainContext = await browser.newContext({ javaScriptEnabled: false });
  plainContext.setDefaultTimeout(10_000);
  const plain = await plainContext.newPage();
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
  reducedContext.setDefaultTimeout(10_000);
  const reduced = await open(reducedContext, "reduce");
  await row(reduced, "pearl-diver").locator("button", { hasText: "Add" }).click();
  check("reduced motion keeps the change without animation markers", !(await reduced.locator("[data-motion]").count()));
  await reducedContext.close();

  for (const [engine, name] of [[chromium, "Chromium"], [firefox, "Firefox"], [webkit, "WebKit"]]) {
    await blockedBuilder(engine, name);
  }
}

try {
  if (process.argv.includes("--autosave-only")) await successiveAutosaves();
  else {
    if (!process.argv.includes("--handoff-only")) {
      await successiveAutosaves();
      await smoke();
    }
    for (const scenario of ["edited", "incomplete", "removed", "lost answer"]) await delayedBuilder(scenario);
    for (const selected of [false, true]) await nativeAddHandoff(selected);
    for (const code of [409, 422]) await nativeRefusal(code);
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
