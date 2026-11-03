// Browser smoke test of corten-ui's components, against the ui-gallery example, in Chromium,
// Firefox and WebKit (Playwright's builds: `npx playwright install chromium firefox webkit`).
// Usage: node examples/ui-gallery/smoke.mjs [http://localhost:18482] [chromium|firefox|webkit ...]
import { chromium, firefox, webkit } from "@playwright/test";
import { steady } from "../../scripts/steady.mjs";
import { stall } from "../../scripts/stall.mjs";
import { browserBug } from "../../scripts/browser-bugs.mjs";
import { networkInterfaces } from "node:os";

const base = process.argv[2] ?? "http://localhost:18482";
const engines = { chromium, firefox, webkit };
const names = process.argv.slice(3).length ? process.argv.slice(3) : Object.keys(engines);
const failures = [];
let engine = "";
const seen = stall(5);
/** A check this browser cannot make, and why. */
const skip = (/** @type {string} */ name, /** @type {string} */ why) => {
  seen(`[${engine}] ${name}`);
  console.log(`skip [${engine}] ${name} (${why})`);
};
const check = (name, ok, detail = "") => {
  seen(`[${engine}] ${name}`);
  console.log(`${ok ? "ok  " : "FAIL"} [${engine}] ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(`[${engine}] ${name}`);
};

/**
 * Requests the browser's pages have sent and not finished, with when each was sent: printed when
 * a run throws (a page that never fires `load`), so the report says which one hangs (#232, #252).
 * A request leaves when it finishes or fails, or when its page or context closes.
 * @type {Map<import("@playwright/test").Request, { at: number, context: import("@playwright/test").BrowserContext }>}
 */
const inflight = new Map();

/**
 * The app at an address of this machine that is not loopback, when `base` is loopback: plain http
 * there is not a secure origin, as a tool served on the LAN is not. `SMOKE_LAN` names it
 * (`http://192.168.1.5:18482`); otherwise the private (RFC 1918) addresses first, the first that
 * answers.
 * @param {string} base
 */
async function lanBase(base) {
  if (process.env.SMOKE_LAN) return process.env.SMOKE_LAN;
  const url = new URL(base);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
  const all = Object.values(networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254."));
  const private_ = (/** @type {string} */ a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  const ordered = [...all.filter((a) => a && private_(a.address)), ...all.filter((a) => a && !private_(a.address))];
  for (const a of ordered) {
    const lan = `http://${a?.address}:${url.port}`;
    if (await fetch(`${lan}/`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false)) return lan;
  }
  return null;
}
/** @param {import("@playwright/test").Browser} browser */
function track(browser) {
  /** @param {(r: import("@playwright/test").Request, at: { context: import("@playwright/test").BrowserContext }) => boolean} gone */
  const drop = (gone) => {
    for (const [r, at] of inflight) if (gone(r, at)) inflight.delete(r);
  };
  /** @param {import("@playwright/test").Request} r */
  const pageOf = (r) => {
    try {
      return r.frame().page();
    } catch {
      return null; // a service worker's request has no frame
    }
  };
  // `newPage` makes its context through `newContext`, so every context is watched here.
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    context.on("request", (r) => inflight.set(r, { at: Date.now(), context }));
    context.on("requestfinished", (r) => inflight.delete(r));
    context.on("requestfailed", (r) => inflight.delete(r));
    context.on("page", (page) => page.on("close", () => drop((r) => pageOf(r) === page)));
    context.on("close", () => drop((_, at) => at.context === context));
    return context;
  };
}
/** What is still loading, oldest first. */
function pending() {
  const now = Date.now();
  return [...inflight].sort((a, b) => a[1].at - b[1].at).map(([r, { at }]) => `  ${now - at}ms ${r.method()} ${r.url()} (${r.resourceType()})`);
}

for (engine of names) {
  const browser = steady(await engines[engine].launch({ headless: true }));
  track(browser);
  try {
    await run(browser);
  } catch (error) {
    console.log(`[${engine}] still loading when it failed:\n${pending().join("\n") || "  nothing"}`);
    throw error;
  } finally {
    inflight.clear();
    await browser.close();
  }
}

if (failures.length) {
  console.log(`\n${failures.length} failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nall passed");

/** @param {import("@playwright/test").Browser} browser */
async function run(browser) {
  // A console error the browser logs for its own bug (scripts/browser-bugs.mjs) is not the page's.
  const bug = browserBug(browser);
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && !bug(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  /** @type {string[]} */
  const failed = [];
  /** @param {import("@playwright/test").Request} r */
  const lost = (r) => failed.push(`${new URL(r.url()).pathname} ${r.failure()?.errorText}`);
  /** @param {import("@playwright/test").Response} r */
  const refused = (r) => r.status() >= 400 && failed.push(`${new URL(r.url()).pathname} ${r.status()}`);
  page.on("requestfailed", lost);
  page.on("response", refused);
  await page.goto(`${base}/`);
  // The combo box's input shows once its script connects (#252): on a timeout, say what had
  // loaded and what failed rather than throwing without the engine.
  const connected = await page
    .waitForFunction(() => document.querySelector('[data-scope=ui-combo-box] [role="combobox"]:not([hidden])') !== null)
    .then(() => true)
    .catch(() => false);
  if (!connected) {
    // The page may have crashed or gone: say so rather than lose the rest of the report.
    const state = await page
      .evaluate(() => ({
        readyState: document.readyState,
        scripts: performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.includes("/scripts/") || n.includes("corten")).map((n) => new URL(n).pathname),
      }))
      .catch((e) => ({ readyState: `unavailable: ${e instanceof Error ? e.message : e}`, scripts: [] }));
    check("the first page's combo box connects", false, JSON.stringify({ ...state, failed, errors }));
    return;
  }
  // Only the first load's: the gallery's refused forms answer 422 later, as they should.
  page.off("requestfailed", lost);
  page.off("response", refused);
  const loaded = await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.includes("/scripts/")).length);
  check("the fifteen scripts load and connect", loaded === 15, `${loaded} script(s)`);
  // A look that sets display (the card's flex) on a closed popover or dialog: components.css keeps
  // it hidden until it opens, as the browser's own rule would without the look. Before any control is
  // used: showing a dialog moves focus, and a manual popover closes no other.
  const closed = await page.evaluate(async (chromium) => {
    const card = document.querySelector('[class~="card__card"]')?.className ?? "";
    const pop = Object.assign(document.createElement("div"), { className: card, popover: "manual", textContent: "Never opened" });
    const dialog = Object.assign(document.createElement("dialog"), { className: card, textContent: "Never opened" });
    // A dialog that is also a popover: open as a modal (open) or as a popover (:popover-open).
    const both = Object.assign(document.createElement("dialog"), { className: card, popover: "manual", textContent: "Both" });
    document.body.append(pop, dialog, both);
    const shown = (/** @type {Element} */ el) => getComputedStyle(el).display;
    const out = [card !== "", shown(pop), shown(dialog), shown(both)];
    pop.showPopover();
    dialog.show();
    out.push(shown(pop), shown(dialog));
    pop.hidePopover();
    dialog.close();
    out.push(shown(pop), shown(dialog));
    both.showPopover();
    out.push(shown(both));
    both.hidePopover();
    both.showModal();
    out.push(shown(both));
    both.close();
    out.push(shown(both));
    // A closing display transition still plays (Chromium runs one for a popover): a transition
    // outranks the !important rule.
    if (chromium) {
      pop.style.transition = "display 10s allow-discrete";
      pop.showPopover();
      shown(pop);
      pop.hidePopover();
      out.push(shown(pop));
    }
    pop.remove();
    dialog.remove();
    both.remove();
    return out.join(" ");
  }, engine === "chromium");
  const closedWant = `true none none none flex flex none none flex flex none${engine === "chromium" ? " flex" : ""}`;
  check("a closed popover or dialog with a look that sets display is not drawn; open (a dialog popover either way), it is", closed === closedWant, closed);

  // NumberField
  const qty = page.locator("#qty");
  const qtyButtons = page.locator("[data-scope=ui-number-field]").first().locator("button");
  check("at the minimum, decrease is disabled", (await qtyButtons.nth(0).isDisabled()) && (await qty.inputValue()) === "1");
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.changes = 0;
    document.querySelector("#qty")?.addEventListener("change", () => (w.changes += 1));
  });
  await qtyButtons.nth(1).click();
  check("increase steps once per click", (await qty.inputValue()) === "2", await qty.inputValue());
  check("a step sends change", (await page.evaluate(() => /** @type {any} */ (window).changes)) === 1);
  check("decrease is enabled above the minimum", !(await qtyButtons.nth(0).isDisabled()));
  await qty.focus();
  await page.keyboard.press("ArrowUp");
  check("the arrow keys step (native)", (await qty.inputValue()) === "3");
  await page.keyboard.press("PageUp");
  check("Page Up adds ten steps, up to the maximum", (await qty.inputValue()) === "10" && (await qtyButtons.nth(1).isDisabled()));
  await page.keyboard.press("Home");
  check("Home goes to the minimum", (await qty.inputValue()) === "1");
  const box = await qtyButtons.nth(1).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  const held = Number(await qty.inputValue());
  check("press and hold repeats", held >= 4, String(held));
  await page.waitForTimeout(200);
  check("release stops the repeat", Number(await qty.inputValue()) === held);
  check("the button kept focus where it was", await page.evaluate(() => document.activeElement?.id === "qty"));
  await page.locator("[data-scope=ui-number-field]").nth(1).locator("button").nth(1).click();
  check("a step keeps the step's decimals", (await page.locator("#weight").inputValue()) === "0.6", await page.locator("#weight").inputValue());
  // Each field keeps its own state (keep()): while the quantity's button is held, the weight's
  // button still steps from the keyboard. Sharing one, the held pointer would make it skip.
  await qty.focus();
  await page.keyboard.press("Home");
  const before = Number(await qty.inputValue());
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const holding = Number(await qty.inputValue());
  await page.locator("[data-scope=ui-number-field]").nth(1).locator("button").nth(1).press("Enter");
  const own = await page.locator("#weight").inputValue();
  await page.mouse.up();
  // The quantity stepped on the press, so its pointer was held while the weight stepped.
  check("each field keeps its own state", holding > before && own === "0.7", `quantity ${before} -> ${holding}, weight ${own}`);
  // A press released off its button makes no click, so nothing is left to skip the next key's.
  const up = await page.locator("[data-scope=ui-number-field]").nth(1).locator("button").nth(1).boundingBox();
  await page.mouse.move(up.x + up.width / 2, up.y + up.height / 2);
  await page.mouse.down();
  await page.mouse.move(up.x + up.width / 2, up.y - 80);
  await page.mouse.up();
  await page.locator("[data-scope=ui-number-field]").nth(1).locator("button").nth(1).press("Enter");
  const after = await page.locator("#weight").inputValue();
  check("a press released elsewhere steps once, and the next key steps", after === "0.9", after);
  // A key's click right after a pointer's, in the same task (before any timer can run): the
  // pointer's stepped on its press, its click does not step again, and the key's does (#316).
  const sameTask = await page.locator("[data-scope=ui-number-field]").nth(1).locator("button").nth(1).evaluate((button) => {
    const input = /** @type {HTMLInputElement} */ (document.getElementById("weight"));
    const from = input.value;
    const at = { bubbles: true, cancelable: true, composed: true, button: 0, pointerId: 7, isPrimary: true };
    button.dispatchEvent(new PointerEvent("pointerdown", at));
    button.dispatchEvent(new PointerEvent("pointerup", at));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    button.click();
    return `${from} -> ${input.value}`;
  });
  check("a key's click right after a pointer's steps once more", sameTask === "0.9 -> 1.1", sameTask);
  const fewer = page.locator("[data-scope=ui-number-field]").nth(1).locator("button").nth(0);
  for (const key of ["Enter", "Space", "Enter", "Space"]) await fewer.press(key);
  check("Enter and Space on decrease step down", (await page.locator("#weight").inputValue()) === "0.7", await page.locator("#weight").inputValue());
  const layout = await page.evaluate(() => {
    // The number field's root is a div; the wrapper that lays out its parts and the adornment holds it.
    const field = /** @type {Element} */ (document.querySelector("#weight")?.closest("[data-scope=ui-number-field]")?.parentElement);
    return Array.from(field.querySelectorAll("button, span, input"), (el) => [el.localName, Math.round(el.getBoundingClientRect().x)])
      .sort((a, b) => Number(a[1]) - Number(b[1]))
      .map((p) => p[0])
      .join(" ");
  });
  check("the design system orders an adornment between the parts", layout === "button span input button", layout);

  // ComboBox
  const color = page.getByLabel("Condition");
  check("the label names the text input once the script runs", (await color.getAttribute("role")) === "combobox");
  check("the select is hidden", await page.locator("[data-scope=ui-combo-box] select").isHidden());
  await color.fill("light");
  const popup = page.locator("[data-scope=ui-combo-box] [popover]");
  check("typing opens the list", (await popup.evaluate((p) => p.matches(":popover-open"))) && (await color.getAttribute("aria-expanded")) === "true");
  const matched = await page.locator('[data-scope=ui-combo-box] [role="status"]').evaluate((p) => [p.hidden, getComputedStyle(p).display].join(" "));
  check("a part the component hides stays hidden under its design system's display (components.css)", matched === "true none", matched);
  const shown = await page.locator('[data-scope=ui-combo-box] [role="option"]:visible').allTextContents();
  check("the list filters by what was typed", shown.join() === "Lightly Played", shown.join());
  check("the first match is highlighted", (await color.getAttribute("aria-activedescendant")) !== null);
  await page.keyboard.press("Enter");
  check("Enter picks it", (await color.inputValue()) === "Lightly Played" && (await page.locator("[data-scope=ui-combo-box] select").inputValue()) === "lp");
  check("picking closes the list", (await color.getAttribute("aria-expanded")) === "false" && !(await popup.evaluate((p) => p.matches(":popover-open"))));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const active = await color.getAttribute("aria-activedescendant");
  check("Arrow Down opens at the value and moves", active !== null && (await page.locator(`#${active}`).textContent()) === "Moderately Played");
  await page.keyboard.press("Escape");
  check("Escape closes and keeps the value", (await color.inputValue()) === "Lightly Played" && (await color.getAttribute("aria-expanded")) === "false");
  const visible = () => page.locator('[data-scope=ui-combo-box] [role="option"]:visible').allTextContents();
  await color.fill("mp");
  const graded = await visible();
  check("a choice's terms find it (a grade the label does not show)", graded.join() === "Moderately Played", graded.join());
  await color.fill("d");
  const ranked = await visible();
  check("matches are ranked: a label or term that starts with the text first", ranked.join() === "Damaged,Lightly Played,Moderately Played,Heavily Played", ranked.join());
  const best = await color.getAttribute("aria-activedescendant");
  check("the best match is highlighted", best !== null && (await page.locator(`#${best}`).textContent()) === "Damaged");
  const marked = await page.locator("[data-scope=ui-combo-box] [data-highlighted]").count();
  check("only it is highlighted after the list was reordered", marked === 1, String(marked));
  // Its highlight is a background, which forced colors does not paint, so it has an outline that
  // is transparent otherwise and painted then: which option Enter picks still shows.
  const optionCheck = "the highlighted option's outline is transparent, and painted under forced colors";
  if (engine !== "webkit") {
    const highlight = () =>
      page.locator("[data-scope=ui-combo-box] [data-highlighted]").evaluate((el) => {
        const s = getComputedStyle(el);
        return `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`;
      });
    const plainOutline = await highlight();
    await page.emulateMedia({ forcedColors: "active" });
    const forcedOutline = await highlight();
    await page.emulateMedia({ forcedColors: "none" });
    check(
      optionCheck,
      plainOutline === "solid 2px rgba(0, 0, 0, 0)" && forcedOutline.startsWith("solid 2px ") && !forcedOutline.endsWith("rgba(0, 0, 0, 0)"),
      `${plainOutline} | ${forcedOutline}`,
    );
  } else skip(optionCheck, "Playwright's WebKit does not emulate forced colors");
  await color.fill("");
  const all = await visible();
  check("an emptied query lists the options in their own order again", all.join() === "Near Mint,Lightly Played,Moderately Played,Heavily Played,Damaged", all.join());
  await page.keyboard.press("Escape");
  await color.fill("zzz");
  check("no match shows the status", await page.locator('[data-scope=ui-combo-box] [role="status"]').isVisible());
  await page.keyboard.press("Tab");
  check("leaving restores the value's text", (await color.inputValue()) === "Lightly Played");
  await color.click();
  await page.locator('[data-scope=ui-combo-box] [role="option"]', { hasText: "Heavily Played" }).click();
  check("a click picks", (await page.locator("[data-scope=ui-combo-box] select").inputValue()) === "hp" && (await color.inputValue()) === "Heavily Played");
  // Open, then measure: CSS anchor positioning puts the list under the input, at least as wide.
  // In the window's middle, so there is room under it (with none, the list goes above, as it should).
  await color.evaluate((input) => input.scrollIntoView({ block: "center" }));
  await color.press("ArrowDown");
  const listBox = await page.evaluate(() => {
    const input = document.querySelector('[data-scope=ui-combo-box] [role="combobox"]')?.getBoundingClientRect();
    const list = document.querySelector("[data-scope=ui-combo-box] [popover]")?.getBoundingClientRect();
    return input && list && { gap: list.top - input.bottom, left: list.left - input.left, wider: list.width >= input.width - 1 };
  });
  check("the popup is anchored under the input (CSS anchor positioning)", !!listBox && listBox.gap >= 0 && listBox.gap <= 8 && Math.abs(listBox.left) <= 1 && listBox.wider, JSON.stringify(listBox));
  await color.press("Escape");
  await color.fill("");
  await page.keyboard.press("Tab");
  check("emptying the field clears the value", (await page.locator("[data-scope=ui-combo-box] select").inputValue()) === "");
  await page.getByRole("button", { name: "List for sale" }).click();
  const message = await color.evaluate((i) => /** @type {HTMLInputElement} */ (i).validationMessage);
  check("a required, empty combobox stops the form on the input", message !== "", message);
  await color.fill("near mint");
  await page.keyboard.press("Tab");
  check("typing a label exactly picks it", (await page.locator("[data-scope=ui-combo-box] select").inputValue()) === "nm");

  await qty.fill("3");
  await page.getByRole("button", { name: "List for sale" }).click();
  await page.waitForFunction(() => document.querySelector("#result")?.textContent?.startsWith("Listed"));
  check("the form sends the components' values", (await page.textContent("#result")) === "Listed 3 Near Mint Ashen Drake at $12.50 each, 0.7 oz to ship.", await page.textContent("#result"));

  // CheckboxGroup: no region checked stops the form at the group's first box.
  const lastResult = await page.textContent("#result");
  const sellValid = () => page.evaluate(() => /** @type {HTMLFormElement} */ (document.querySelector('form[action$="/sell"]')).checkValidity());
  const shipsValid = () => page.evaluate(() => Array.from(document.querySelectorAll('form[action$="/sell"] fieldset input[type="checkbox"]')).every((box) => /** @type {HTMLInputElement} */ (box).checkValidity()));
  const us = page.getByRole("checkbox", { name: "United States" });
  // A kit Checkbox draws its input as a checkbox, and not one a role makes a switch.
  const drawnBox = await us.evaluate((box) => {
    const look = (/** @type {Element} */ el) => getComputedStyle(el).appearance;
    const copy = /** @type {HTMLInputElement} */ (box.cloneNode());
    copy.setAttribute("role", "switch");
    copy.removeAttribute("name");
    copy.removeAttribute("id");
    box.parentElement?.append(copy);
    const result = { box: look(box), asSwitch: look(copy) };
    copy.remove();
    return result;
  });
  check("Checkbox: drawn as a checkbox, but not an input whose role is switch", drawnBox.box === "none" && drawnBox.asSwitch === "auto", JSON.stringify(drawnBox));
  await us.uncheck();
  const shipMessage = await us.evaluate((i) => /** @type {HTMLInputElement} */ (i).validationMessage);
  await page.getByRole("button", { name: "List for sale" }).click();
  await page.waitForTimeout(300);
  check("a group with no box checked stops the form at its first box, with the app's message", shipMessage === "Choose where you ship." && !(await sellValid()) && (await page.textContent("#result")) === lastResult, shipMessage);
  // From the keyboard: Firefox's message for the refused box sits over the next box, and a click
  // there only closes the message, as it would for a user.
  await page.getByRole("checkbox", { name: "Canada" }).press("Space");
  check("one box checked, the group is valid", (await us.evaluate((i) => /** @type {HTMLInputElement} */ (i).validationMessage)) === "");
  // RequiredWhen: the lowest offer applies only to offers.
  const floor = page.getByLabel("Lowest offer");
  const floorRequired = () => floor.evaluate((i) => /** @type {HTMLInputElement} */ (i).required);
  check("for a fixed price the lowest offer is disabled and not required", (await floor.isDisabled()) && !(await floorRequired()));
  await page.getByLabel("Accept offers").check();
  check("accepting offers makes the lowest offer required", (await floor.isEnabled()) && (await floorRequired()));
  await page.getByRole("button", { name: "List for sale" }).click();
  await page.waitForTimeout(300);
  check("an empty lowest offer stops the form", (await floor.evaluate((i) => /** @type {HTMLInputElement} */ (i).validationMessage)) !== "" && (await page.textContent("#result")) === lastResult);
  await floor.fill("5");
  await qty.fill("2");
  await page.getByRole("button", { name: "List for sale" }).click();
  await page.waitForFunction(() => document.querySelector("#result")?.textContent?.startsWith("Listed 2"), null, { timeout: 5000 }).catch(() => {});
  check("with a lowest offer the listing is sent", (await page.textContent("#result")) === "Listed 2 Near Mint Ashen Drake at $12.50 each, 0.7 oz to ship.", await page.textContent("#result"));
  await page.getByLabel("Fixed price").check();
  check("back to a fixed price, the lowest offer is disabled again", await floor.isDisabled());
  // A reset puts the boxes back as drawn ("United States" checked), and the group is checked again.
  // Only the group's boxes: the reset also empties the condition, which is drawn with no choice.
  await us.uncheck();
  await page.getByRole("checkbox", { name: "Canada" }).uncheck();
  const unchecked = await us.evaluate((i) => /** @type {HTMLInputElement} */ (i).validationMessage);
  await page.evaluate(() => /** @type {HTMLFormElement} */ (document.querySelector('form[action$="/sell"]')).reset());
  await page.waitForTimeout(100);
  check("a form reset checks the group again", unchecked === "Choose where you ship." && (await us.isChecked()) && (await us.evaluate((i) => /** @type {HTMLInputElement} */ (i).validationMessage)) === "" && (await shipsValid()), unchecked);

  // TabGroup
  const tab = (name) => page.getByRole("tab", { name });
  await page.evaluate(() => (/** @type {any} */ (window).__tabs = document.querySelector("[data-scope=ui-tab-group]")));
  await tab("Offers").click();
  check("a click selects the tab and shows its panel", (await tab("Offers").getAttribute("aria-selected")) === "true" && (await page.getByRole("tabpanel").textContent()) === "Two offers, the best at $10.00.");
  check("the address follows the tab", page.url().endsWith("/?tab=offers"), page.url());
  check("a handler's history.replaceState is not a navigation", await page.evaluate(() => (/** @type {any} */ (window).__tabs === document.querySelector("[data-scope=ui-tab-group]"))));
  await page.keyboard.press("ArrowRight");
  check("Arrow Right moves and selects", (await page.evaluate(() => document.activeElement?.textContent)) === "Sales" && (await tab("Sales").getAttribute("aria-selected")) === "true");
  await page.keyboard.press("ArrowRight");
  check("the arrow keys wrap", (await tab("Listings").getAttribute("aria-selected")) === "true" && page.url() === `${base}/`);
  check("only the selected tab is in the tab order", (await page.$$eval('[role="tab"]', (t) => t.map((x) => /** @type {HTMLElement} */ (x).tabIndex).join())) === "0,-1,-1");
  await page.keyboard.press("End");
  check("End selects the last", (await tab("Sales").getAttribute("aria-selected")) === "true");

  // ChoiceGroup and ShownFor: one choice, parts in two cards.
  const period = (name) => page.getByRole("radio", { name });
  // The parts' sentences (the month's table of sales, a part too, is checked at a phone's width).
  const showing = () =>
    page.$$eval('[data-on^="connect:ui.choice.part"]', (parts) => parts.filter((p) => !(/** @type {HTMLElement} */ (p).hidden) && !p.querySelector("table")).map((p) => p.textContent).join("|"));
  check("the server draws the default choice and only its parts", (await period("Month").getAttribute("aria-checked")) === "true" && (await showing()) === "Average $11.95 this month.|Sold 14 this month.", await showing());
  check("only the chosen option is in the tab order", (await page.$$eval('[role="radio"]', (r) => r.map((x) => /** @type {HTMLElement} */ (x).tabIndex).join())) === "-1,0");
  // The kit's looks for corten-ui's ChoiceGroup, NumberField and CheckboxGroup (#610): a segmented
  // choice with the chosen one raised, the number field's parts at the controls' height in a row,
  // and the group's fieldset without the browser's border.
  const kitLooks = await page.evaluate(() => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const style = (/** @type {string} */ sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el) : null;
    };
    const radiogroup = document.querySelector('[role="radiogroup"]');
    // Its box's parent: the Segmented around it takes none (display: contents).
    let parent = radiogroup?.parentElement;
    while (parent && getComputedStyle(parent).display === "contents") parent = parent.parentElement;
    const fits = radiogroup && parent ? radiogroup.getBoundingClientRect().width < parent.getBoundingClientRect().width : false;
    const [group, chosen, other] = [style('[role="radiogroup"]'), style('[role="radio"][aria-checked="true"]'), style('[role="radio"][aria-checked="false"]')];
    // The drawn boxes, so a border outside a content-box height counts, with the gallery's own
    // border-box reset undone for the measure: the kit's rule has to box them by itself.
    const reset = new CSSStyleSheet();
    reset.replaceSync("*, *::before, *::after { box-sizing: content-box }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, reset];
    const rect = (/** @type {string} */ s) => document.querySelector(s)?.getBoundingClientRect();
    const [input, button] = [rect("[class*='stepper__stepper'] input"), rect("[class*='stepper__stepper'] button")];
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== reset);
    const fieldset = style("[class*='checkboxes__checkboxes'] > fieldset");
    return {
      group: group && `${fits} ${group.backgroundColor !== "rgba(0, 0, 0, 0)"}`,
      chosen: chosen?.backgroundColor,
      other: other?.backgroundColor,
      stepper: input && button && [input.height, button.height, button.width].map((h) => Math.round((h / rem) * 100) / 100).join(" "),
      fieldset: fieldset && `${fieldset.display} ${fieldset.borderTopStyle}`,
    };
  });
  check(
    "Segmented, Stepper and Checkboxes: corten-ui's ChoiceGroup, NumberField and CheckboxGroup drawn by the kit",
    kitLooks.group === "true true" && kitLooks.chosen !== kitLooks.other && kitLooks.other === "rgba(0, 0, 0, 0)" && kitLooks.stepper === "2.25 2.25 2.25" && kitLooks.fieldset === "grid none",
    JSON.stringify(kitLooks),
  );
  await period("Week").click();
  check("a click chooses in place, and every part of the group follows", (await period("Week").getAttribute("aria-checked")) === "true" && (await showing()) === "Average $12.10 this week.|Sold 3 this week.", await showing());
  check("the address follows the choice", new URL(page.url()).searchParams.get("period") === "week", page.url());
  await page.keyboard.press("ArrowRight");
  check("Arrow Right moves and chooses", (await page.evaluate(() => document.activeElement?.textContent)) === "Month" && (await showing()) === "Average $11.95 this month.|Sold 14 this month." && !new URL(page.url()).searchParams.has("period"), page.url());
  await page.keyboard.press("ArrowUp");
  check("Arrow Up moves back", (await period("Week").getAttribute("aria-checked")) === "true");
  await page.goto(`${base}/?tab=sales`);
  await period("Week").click();
  check("choosing keeps another control's key in the address", new URL(page.url()).search === "?tab=sales&period=week", page.url());
  await tab("Offers").click();
  check("and a tab keeps the choice", new URL(page.url()).search === "?tab=offers&period=week", page.url());
  await page.goto(`${base}/?period=week`);
  check("the address draws the choice on a load", (await period("Week").getAttribute("aria-checked")) === "true" && (await showing()) === "Average $12.10 this week.|Sold 3 this week.", await showing());
  await page.goto(`${base}/`);

  // MenuButton
  // The popover's toggle event comes a task after it opens or closes: wait for what it sets.
  const trigger = page.getByRole("button", { name: "More actions" });
  const expanded = (/** @type {string} */ value) =>
    page.waitForFunction((v) => document.querySelector("#actions-button")?.getAttribute("aria-expanded") === v, value);
  await trigger.click();
  await expanded("true");
  check("the button opens the menu", (await trigger.getAttribute("aria-expanded")) === "true");
  check("focus moves to the first item", (await page.evaluate(() => document.activeElement?.textContent)) === "Help");
  // Under the button, or above it where the viewport has no room below (flip-block).
  const menuBox = await page.evaluate(() => {
    const button = document.querySelector("#actions-button")?.getBoundingClientRect();
    const menu = document.querySelector("#actions")?.getBoundingClientRect();
    return button && menu && { gap: Math.max(menu.top - button.bottom, button.top - menu.bottom), left: menu.left - button.left };
  });
  check("the menu is anchored to its button", !!menuBox && menuBox.gap >= 0 && menuBox.gap <= 8 && Math.abs(menuBox.left) <= 1, JSON.stringify(menuBox));
  await page.keyboard.press("ArrowDown");
  check("Arrow Down moves", (await page.evaluate(() => document.activeElement?.textContent)) === "Archive");
  await page.keyboard.press("ArrowDown");
  check("a disabled item is passed over", (await page.evaluate(() => document.activeElement?.textContent)) === "Rename…");
  await page.keyboard.press("w");
  check("typing a letter moves to the item", (await page.evaluate(() => document.activeElement?.textContent)) === "Watch");
  await page.keyboard.press("Escape");
  await expanded("false");
  check("Escape closes and returns focus", (await trigger.getAttribute("aria-expanded")) === "false" && (await page.evaluate(() => document.activeElement?.textContent)) === "More actions");
  await page.keyboard.press("ArrowUp");
  await expanded("true");
  check("Arrow Up on the button opens at the last item", (await page.evaluate(() => document.activeElement?.textContent)) === "Watch");
  await page.keyboard.press("Escape");
  await expanded("false");
  await trigger.click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page.waitForFunction(() => document.querySelector("#menu-result")?.textContent === "Archived.");
  check("a form item posts and patches", true);
  await expanded("false");
  check("using an item closes the menu", (await trigger.getAttribute("aria-expanded")) === "false");
  // An item is any element the app writes: here a command that opens a dialog.
  await trigger.click();
  await expanded("true");
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  await page.waitForFunction(() => /** @type {HTMLDialogElement | null} */ (document.querySelector("dialog[aria-label='Rename the draft']"))?.open === true);
  await expanded("false");
  check("a command item opens its dialog and closes the menu", (await trigger.getAttribute("aria-expanded")) === "false");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => /** @type {HTMLDialogElement | null} */ (document.querySelector("dialog[aria-label='Rename the draft']"))?.open === false);
  check("closing the dialog an item opened returns focus to the button", (await page.evaluate(() => document.activeElement?.id)) === "actions-button", String(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))));

  // Toaster (2 seconds in the gallery)
  const toast = page.locator("#ui-toast");
  const dismiss = page.getByRole("button", { name: "Dismiss" });
  check("no message: nothing shows", (await toast.isHidden()) && (await dismiss.isHidden()));
  const region = await page.evaluate(() => {
    const toaster = document.querySelector('[role="status"]:has(#ui-toast)');
    return [toaster, toaster?.parentElement, document.querySelector("#menu-result")].map((e) => (e ? getComputedStyle(e).display : "missing")).join();
  });
  check("empty live regions stay in the page, so a message is announced", !/none|missing/.test(region), region);
  const save = page.getByRole("button", { name: "Save draft" });
  await save.click();
  await page.waitForFunction(() => document.querySelector("#ui-toast")?.textContent === "Draft saved.");
  check("the patch puts the message in the live region", (await page.getByRole("status").filter({ has: toast }).count()) === 1 && (await toast.isVisible()));
  check("the close button shows with a message", await dismiss.isVisible());
  await dismiss.click();
  check("the button dismisses it", (await toast.isHidden()) && (await dismiss.isHidden()));
  await save.click();
  await toast.waitFor({ state: "visible" });
  await toast.hover();
  await page.waitForTimeout(2600);
  check("it waits while the pointer is over it", await toast.isVisible());
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  check("it is still there just after the pointer leaves (the rest of its time)", await toast.isVisible());
  await toast.waitFor({ state: "hidden", timeout: 4000 }).catch(() => {});
  check("then it goes after its time", (await toast.isHidden()) && (await dismiss.isHidden()));

  // dialog::modal: a dialog the server draws open is modal.
  const rename = page.locator("#rename");
  const isModal = () => rename.evaluate((d) => d.matches(":modal"));
  check("drawn closed, the dialog stays closed", !(await rename.evaluate((d) => /** @type {HTMLDialogElement} */ (d).open)));
  await page.getByRole("button", { name: "Rename draft" }).click();
  check("the button opens it as a modal (command=show-modal)", await isModal());
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#rename [aria-invalid=true]") !== null);
  check("a refused patch keeps it modal, with the error", (await isModal()) && (await rename.textContent())?.includes("Give the draft a name."));
  check("focus is on the refused field", await page.evaluate(() => document.activeElement?.id === "rename-name"));
  await page.keyboard.press("Escape");
  check("Escape closes it", !(await rename.evaluate((d) => /** @type {HTMLDialogElement} */ (d).open)));
  // A rename that is taken redirects to the draft with a notice (`req.redirect_with_notice`): the
  // write's page is fetched whole, and its layout draws the notice in the toaster.
  // The notice rides in a Secure cookie, which Playwright's WebKit never sends back over http.
  const noticeChecks = [
    "a redirect's notice reaches the layout's toaster",
    "and the toaster offers to dismiss it",
    "the notice is said once",
    "the same notice again is shown again",
    "the toaster's live region stays, so its message is announced",
    "a notice whose page loads in full instead reaches the toaster after the load",
    "the toaster's Dismiss button stays the one its script holds after a dismiss and a write",
    "a write while the toast shows keeps the button, and it closes the toast",
    "after a toast's patch, what a script set on the layout stays through a write",
  ];
  /** The Dismiss button, marked by `__mine` when it is still the one first drawn, and whether it shows. */
  const dismissState = () =>
    page.evaluate(() => {
      const button = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Dismiss");
      return { mine: (/** @type {any} */ (button))?.__mine === 1, visible: !!button?.checkVisibility() };
    });
  if (engine !== "webkit") {
    // A full load would draw the same toast: the marker says the document was kept.
    await page.evaluate(() => {
      (/** @type {any} */ (window)).__kept = 1;
      (/** @type {any} */ (document.querySelector("#ui-toast")?.parentElement)).__region = 1;
    });
    const keptDoc = () => page.evaluate(() => (/** @type {any} */ (window)).__kept === 1);
    // The toasts above were patches into the toaster: what the server draws there as before
    // (the button) still stays as a script left it, here with an attribute of its own.
    await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Dismiss")?.setAttribute("data-smoke", "kept"));
    await page.getByRole("button", { name: "Rename draft" }).click();
    await page.locator("#rename-name").fill("Spring draft");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const renamed = await page.waitForFunction(() => document.querySelector("#ui-toast")?.textContent === "Renamed to Spring draft.", null, { timeout: 5000 }).then(() => true, () => false);
    check(noticeChecks[0], renamed && (await keptDoc()) && (await page.locator("#ui-toast").isVisible()) && !(await rename.evaluate((d) => /** @type {HTMLDialogElement} */ (d).open)), await page.locator("#ui-toast").textContent());
    check(noticeChecks[1], await page.getByRole("button", { name: "Dismiss" }).isVisible());
    check(noticeChecks[8], (await page.getByRole("button", { name: "Dismiss" }).getAttribute("data-smoke")) === "kept");
    await page.getByRole("button", { name: "Dismiss" }).evaluate((b) => ((/** @type {any} */ (b)).__mine = 1));
    await page.getByRole("button", { name: "Dismiss" }).click();
    check(noticeChecks[2], !(await page.evaluate(async () => (await (await fetch("/")).text()).includes("Renamed to"))));
    // The layout draws the same toast as before, which the user dismissed: it is shown again.
    await page.getByRole("button", { name: "Rename draft" }).click();
    await page.locator("#rename-name").fill("Spring draft");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const again = await page.waitForFunction(() => {
      const toast = /** @type {HTMLElement | null} */ (document.querySelector("#ui-toast"));
      return toast?.textContent === "Renamed to Spring draft." && !toast.hidden && toast.checkVisibility();
    }, null, { timeout: 5000 }).then(() => true, () => false);
    const region = await page.evaluate(() => {
      const status = document.querySelector("#ui-toast")?.parentElement;
      return { same: (/** @type {any} */ (status))?.__region === 1, role: status?.getAttribute("role") };
    });
    check(noticeChecks[4], region.same && region.role === "status", JSON.stringify(region));
    check(noticeChecks[3], again && (await keptDoc()), await page.locator("#ui-toast").evaluate((t) => JSON.stringify({ text: t.textContent, hidden: /** @type {HTMLElement} */ (t).hidden })));
    const afterDismiss = await dismissState();
    check(noticeChecks[6], afterDismiss.mine && afterDismiss.visible, JSON.stringify(afterDismiss));
    // Another write while that toast still shows.
    await page.getByRole("button", { name: "Rename draft" }).click();
    await page.locator("#rename-name").fill("Summer draft");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const summer = await page.waitForFunction(() => document.querySelector("#ui-toast")?.textContent === "Renamed to Summer draft.", null, { timeout: 5000 }).then(() => true, () => false);
    const whileShown = await dismissState();
    await page.getByRole("button", { name: "Dismiss" }).click({ timeout: 3000 }).catch(() => {});
    const closed = await page
      .waitForFunction(() => !(/** @type {HTMLElement | null} */ (document.querySelector("#ui-toast"))?.checkVisibility()), null, { timeout: 3000 })
      .then(() => true, () => false);
    check(noticeChecks[7], summer && whileShown.mine && whileShown.visible && closed, `${summer} ${JSON.stringify(whileShown)} closed ${closed}`);
    // The write's page comes with another frame (here an attribute on <html> changed on the way):
    // the runtime loads it in full, and the notice, whose cookie that answer removed, goes with it.
    await page.route("**/*", async (route) => {
      const req = route.request();
      if (req.method() !== "GET" || req.resourceType() !== "fetch" || req.headers()["corten"]) return route.fallback();
      const res = await route.fetch();
      await page.context().clearCookies({ name: "__Host-corten-notice" });
      const body = (await res.text()).replace("<html ", '<html data-frame="changed" ');
      await route.fulfill({ response: res, body });
    });
    await page.evaluate(() => ((/** @type {any} */ (window)).__before = 1));
    await page.getByRole("button", { name: "Rename draft" }).click();
    await page.locator("#rename-name").fill("Autumn draft");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const kept = await page.waitForFunction(() => document.querySelector("#ui-toast")?.textContent === "Renamed to Autumn draft.", null, { timeout: 5000 }).then(() => true, () => false);
    const loaded = await page.evaluate(() => (/** @type {any} */ (window)).__before === undefined);
    check(noticeChecks[5], kept && loaded && (await page.locator("#ui-toast").isVisible()), `${loaded} ${await page.locator("#ui-toast").textContent()}`);
    await page.unroute("**/*");
  } else for (const name of noticeChecks) skip(name, "Playwright's WebKit never sends a Secure cookie back over http");
  // A layout with <main> inside two <div>s: one write's page after another is swapped into the
  // same document.
  const nestedCheck = "writes in a layout that nests <main> in two <div>s keep the document";
  if (engine !== "webkit") {
    const nest = async (/** @type {import("@playwright/test").Route} */ route) => {
      const req = route.request();
      const whole = req.resourceType() === "document" || (req.resourceType() === "fetch" && !req.headers()["corten"]);
      if (req.method() !== "GET" || !whole || new URL(req.url()).pathname !== "/") return route.fallback();
      // Fetched uncompressed: Playwright does not decode zstd, which Firefox asks for.
      const res = await route.fetch({ headers: { ...req.headers(), "accept-encoding": "identity" } });
      const headers = res.headers();
      delete headers["content-encoding"];
      delete headers["content-length"];
      const body = (await res.text()).replace("<main>", '<div class="frame"><div class="inner"><main>').replace("</main>", "</main></div></div>");
      await route.fulfill({ status: res.status(), headers, body });
    };
    await page.route("**/*", nest);
    await page.goto(`${base}/`);
    await page.evaluate(() => ((/** @type {any} */ (window)).__nested = 1));
    let documents = 0;
    const onDocument = (/** @type {import("@playwright/test").Request} */ r) => r.resourceType() === "document" && documents++;
    page.on("request", onDocument);
    let drawn = 0;
    for (const name of ["Nested draft", "Nested again"]) {
      await page.getByRole("button", { name: "Rename draft" }).click();
      await page.locator("#rename-name").fill(name);
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      const shown = await page
        .waitForFunction((name) => document.querySelector("#ui-toast")?.textContent === `Renamed to ${name}.`, name, { timeout: 5000 })
        .then(() => true, () => false);
      if (shown) drawn++;
      await page.getByRole("button", { name: "Dismiss" }).click();
    }
    page.off("request", onDocument);
    const nested = await page.evaluate(() => ({ kept: (/** @type {any} */ (window)).__nested === 1, inner: !!document.querySelector(".frame > .inner > main") }));
    check(nestedCheck, drawn === 2 && nested.kept && nested.inner && documents === 0, `${drawn} drawn, ${JSON.stringify(nested)}, document requests ${documents}`);
    await page.unroute("**/*", nest);
    await page.goto(`${base}/`);
  } else skip(nestedCheck, "no Navigation API: navigations are full page loads");
  // A plain navigation whose page comes with another layout (here a shell key changed on the way)
  // loads in full, as a write's does when its frame changed.
  const shellCheck = "a navigation to a page in another layout loads it in full";
  if (engine !== "webkit") {
    await page.goto(`${base}/`);
    await page.route("**/*", async (route) => {
      if (route.request().method() !== "GET" || route.request().headers()["corten"] !== "nav") return route.fallback();
      const res = await route.fetch();
      await route.fulfill({ response: res, headers: { ...res.headers(), "corten-shell": "0000000000000000" } });
    });
    await page.evaluate(() => ((/** @type {any} */ (window)).__before = 1));
    // Only a full load fires the page's load event; a swap does not.
    const reloaded = page.waitForEvent("load", { timeout: 5000 }).then(() => true, () => false);
    await page.getByRole("link", { name: "Orders", exact: true }).first().click();
    const full = await reloaded;
    await page.waitForURL(/\/orders$/);
    check(shellCheck, full && (await page.evaluate(() => (/** @type {any} */ (window)).__before === undefined)));
    await page.unroute("**/*");
    await page.goto(`${base}/`);
  } else skip(shellCheck, "no Navigation API: navigations are full page loads");
  // Over plain http from an address that is not loopback (a tool on the LAN) the browser refuses
  // the Secure `__Host-` cookie, so the notice rides in a plain one there, in every engine (#498).
  const lan = await lanBase(base);
  const lanCheck = "a redirect's notice on a plain-http LAN address reaches the toaster";
  if (lan) {
    const onLan = await (await browser.newContext()).newPage();
    await onLan.goto(`${lan}/`);
    await onLan.getByRole("button", { name: "Rename draft" }).click();
    await onLan.locator("#rename-name").fill("Lan draft");
    await onLan.getByRole("button", { name: "Rename", exact: true }).click();
    const shown = await onLan.waitForFunction(() => document.querySelector("#ui-toast")?.textContent === "Renamed to Lan draft.", null, { timeout: 5000 }).then(() => true, () => false);
    // The page's answer removed it, so a reload does not say it again.
    const cookies = (await onLan.context().cookies()).map((c) => c.name).filter((name) => name.includes("corten-notice"));
    check(lanCheck, shown && (await onLan.locator("#ui-toast").isVisible()) && !cookies.length, `${lan} ${await onLan.locator("#ui-toast").textContent()}; notice cookies left: ${cookies.join(",") || "none"}`);
    await onLan.context().close();
  } else skip(lanCheck, "no address other than loopback to reach the app on");
  // A post without the runtime (no data-patch): the whole page, the dialog drawn open.
  await page.getByRole("button", { name: "Rename draft" }).click();
  await Promise.all([
    page.waitForURL("**/rename"),
    page.locator("#rename form[action]").evaluate((f) => {
      f.removeAttribute("data-patch");
      /** @type {HTMLFormElement} */ (f).requestSubmit();
    }),
  ]);
  await page.waitForFunction(() => document.querySelector("#rename")?.matches(":modal"), null, { timeout: 5000 }).catch(() => {});
  check("drawn open in a whole page, it becomes modal", await isModal());
  check("focus goes to the refused field", await page.evaluate(() => document.activeElement?.id === "rename-name"));
  const trapped = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    trapped.push(await page.evaluate(() => !!document.activeElement?.closest("#rename") || document.activeElement === document.body));
  }
  check("Tab stays in the dialog (the page behind is inert)", trapped.every(Boolean), trapped.join());
  check("the page behind is inert to clicks", await page.evaluate(() => {
    const h1 = /** @type {HTMLElement} */ (document.querySelector("h1"));
    const r = h1.getBoundingClientRect();
    // The backdrop covers it: the point hits the dialog (its ::backdrop), not the heading.
    return document.elementFromPoint(r.left + 2, r.top + 2) === document.querySelector("#rename");
  }));
  await page.keyboard.press("Escape");
  check("Escape closes the page's dialog", !(await isModal()) && !(await rename.evaluate((d) => /** @type {HTMLDialogElement} */ (d).open)));

  // dialog::modalClosedBy: a sheet the address opens, which a close request leaves for its
  // link's address.
  await page.goto(`${base}/`);
  /**
   * This entry's place in the history, where the browser has the Navigation API (a browser
   * without it loads whole pages, and the link's address replaces the sheet's).
   */
  const at = () => page.evaluate(() => /** @type {any} */ (window).navigation?.currentEntry?.index ?? -1);
  /**
   * The page's own address. Not `page.url()` or `waitForURL`: Playwright's WebKit does not
   * report the runtime's navigation from `/` to `/?sale=last` (a push that changes only the
   * query), so its URL stays at `/` while `location` and the history have moved on, and a click
   * that waits for that navigation never returns (`noWaitAfter` on the link's clicks).
   */
  const href = () => page.evaluate(() => location.href);
  /** @param {boolean} open whether the address names the sale */
  const saleInAddress = (open) =>
    page.waitForFunction((open) => new URL(location.href).searchParams.has("sale") === open, open, { timeout: 5000 }).catch(() => {});
  const listEntry = await at();
  await page.getByRole("link", { name: "Last sale" }).click({ noWaitAfter: true });
  await saleInAddress(true);
  const sheet = page.locator('dialog[aria-label="Last sale"]');
  const sheetModal = () => page.evaluate(() => !!document.querySelector('dialog[aria-label="Last sale"]')?.matches(":modal"));
  await page.waitForFunction(() => document.querySelector('dialog[aria-label="Last sale"]')?.matches(":modal"), null, { timeout: 5000 }).catch(() => {});
  check("the address opens the sheet as a modal", await sheetModal());
  /** Escape on the sheet, then the page without it: the address drops `sale` and the sheet goes. */
  const escape = async (/** @type {string} */ how) => {
    await page.keyboard.press("Escape");
    await saleInAddress(false);
    await sheet.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    check(`${how}: Escape goes to the close link's address, which does not name the sale`, !new URL(await href()).searchParams.has("sale"), await href());
    check(`${how}: the page without it replaces the sheet`, (await sheet.count()) === 0);
  };
  const openSheet = async () => {
    await page.getByRole("link", { name: "Last sale" }).click({ noWaitAfter: true });
    await saleInAddress(true);
    await page.waitForFunction(() => document.querySelector('dialog[aria-label="Last sale"]')?.matches(":modal"), null, { timeout: 5000 }).catch(() => {});
  };
  // Opened from the list, closing goes back to the list's entry: no entry is added, so Back
  // after it leaves the list, and Android's Back on the open sheet cannot loop through it.
  await escape("opened by a click");
  check("opened by a click: closing goes back to the list's entry", (await at()) === listEntry, `${listEntry} -> ${await at()}`);
  if (listEntry < 0) {
    // Without the Navigation API the list's address replaced the sheet's: Back shows the list
    // once more, not the sheet.
    await page.goBack();
    await page.waitForLoadState();
    check("no Navigation API: Back shows the list, not the sheet", new URL(page.url()).pathname === "/" && !new URL(page.url()).search && (await sheet.count()) === 0, page.url());
    await page.goForward();
    await page.waitForLoadState();
  }
  await page.reload();
  check("a reload does not open it again", (await sheet.count()) === 0);
  // A close request other than Escape (Android's Back, closedby="any") is the same `cancel`.
  if (await page.evaluate(() => "requestClose" in HTMLDialogElement.prototype)) {
    await openSheet();
    // Not the locator's evaluate: the close replaces the sheet as it runs, and a locator then
    // waits for it to come back.
    await page.evaluate(() => /** @type {any} */ (document.querySelector('dialog[aria-label="Last sale"]'))?.requestClose());
    await saleInAddress(false);
    await sheet.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    check("requestClose() leaves the sheet's address too", !new URL(await href()).searchParams.has("sale") && (await sheet.count()) === 0, await href());
  }
  // Loaded at its address (a shared link), with no click since: Chromium does not let the page
  // keep it open on Escape, and the address is still left, in place of the sheet's entry (the
  // entry before is another page, so there is no going back to the list).
  await page.goto(`${base}/?tab=offers`);
  await page.goto(`${base}/?sale=last`);
  await page.waitForFunction(() => document.querySelector('dialog[aria-label="Last sale"]')?.matches(":modal"), null, { timeout: 5000 }).catch(() => {});
  check("loaded at its address, the sheet is modal", await sheetModal());
  const shared = await at();
  await escape("loaded at its address");
  check("loaded at its address: the list replaces the sheet's entry", (await at()) === shared, `${shared} -> ${await at()}`);
  await page.goBack();
  await page.waitForLoadState();
  check("Back from there goes to the page before the shared link", new URL(await href()).searchParams.get("tab") === "offers", await href());
  // CopyButton: shown where the browser has the Clipboard API; a click copies the SKU.
  const clip = await (await browser.newContext(engine === "chromium" ? { permissions: ["clipboard-read", "clipboard-write"] } : {})).newPage();
  clip.on("console", (m) => m.type() === "error" && !bug(m.text()) && errors.push(m.text()));
  clip.on("pageerror", (e) => errors.push(e.message));
  await clip.goto(`${base}/`);
  const copyButton = clip.getByRole("button", { name: "Copy", exact: true });
  await copyButton.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  check("the copy button shows once its script connects", await copyButton.isVisible());
  await copyButton.click();
  const said = clip.locator('[data-scope=ui-copy-button] [aria-live="polite"]');
  await clip.waitForFunction(() => document.querySelector('[data-scope=ui-copy-button] [aria-live]')?.textContent === "Copied", null, { timeout: 5000 }).catch(() => {});
  check("a click says it copied, in its live region", (await said.textContent()) === "Copied", await said.textContent());
  const copies = clip.locator('output[aria-label="Copies"]');
  check("the copy is reported once to the page (Copied bubbles to the paragraph)", (await copies.textContent()) === "1", await copies.textContent());
  if (engine === "chromium") {
    check("the clipboard holds the SKU, from the page's own element", (await clip.evaluate(() => navigator.clipboard.readText())) === "ASH-DRAKE-NM");
  }
  await clip.waitForFunction(() => document.querySelector('[data-scope=ui-copy-button] [aria-live]')?.textContent === "Copy", null, { timeout: 5000 }).catch(() => {});
  check("then its label again", (await said.textContent()) === "Copy", await said.textContent());
  await clip.context().close();
  // A write the browser refuses changes nothing: the button never says it copied.
  const denied = await (await browser.newContext()).newPage();
  denied.on("pageerror", (e) => errors.push(e.message));
  await denied.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) } });
  });
  await denied.goto(`${base}/`);
  const deniedButton = denied.getByRole("button", { name: "Copy", exact: true });
  await deniedButton.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  await deniedButton.click();
  await denied.waitForTimeout(300);
  check("a denied write leaves the label as it was", (await denied.locator('[data-scope=ui-copy-button] [aria-live]').textContent()) === "Copy");
  check("a denied write reports no copy", (await denied.locator('output[aria-label="Copies"]').textContent()) === "0");
  await denied.context().close();
  // Without the Clipboard API (an insecure origin) the button stays hidden.
  const insecure = await (await browser.newContext()).newPage();
  await insecure.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: undefined }));
  await insecure.goto(`${base}/`);
  await insecure.waitForFunction(() => document.querySelector("[data-scope=ui-combo-box] input")?.checkVisibility(), null, { timeout: 5000 }).catch(() => {});
  check("without the Clipboard API the button stays hidden", await insecure.locator("[data-scope=ui-copy-button]").isHidden());
  await insecure.context().close();
  // PrintButton: shown once its script connects; a click opens the print dialog (counted here).
  const printing = await (await browser.newContext()).newPage();
  printing.on("pageerror", (e) => errors.push(e.message));
  await printing.addInitScript(() => {
    window.print = () => {
      /** @type {any} */ (window).printed = (/** @type {any} */ (window).printed ?? 0) + 1;
    };
  });
  await printing.goto(`${base}/`);
  const printButton = printing.getByRole("button", { name: "Print label", exact: true });
  await printButton.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  check("the print button shows once its script connects", await printButton.isVisible());
  await printButton.click();
  const printed = await printing.evaluate(() => /** @type {any} */ (window).printed ?? 0);
  check("a click opens the print dialog once", printed === 1, String(printed));
  await printing.context().close();
  // RelativeTime: the server wrote both times; the browser's clock (faked, from now) moves them.
  const timed = await (await browser.newContext()).newPage();
  const timedErrors = [];
  timed.on("pageerror", (e) => timedErrors.push(String(e)));
  timed.on("console", (m) => m.type() === "error" && !bug(m.text()) && timedErrors.push(m.text()));
  // Paused before the page loads, so only runFor moves its time: a slow read under load adds no
  // seconds, and the pause cannot land in the page's past.
  await timed.clock.install();
  await timed.clock.pauseAt(Date.now() + 1_000);
  await timed.goto(`${base}/`);
  const listed = timed.locator("time").first();
  const expires = timed.locator("time").nth(1);
  check("the server writes a time behind now", (await listed.textContent()) === "3 hr. ago", await listed.textContent());
  check("and one ahead, with its instant", (await expires.textContent()) === "in 1 minute" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/.test((await expires.getAttribute("datetime")) ?? ""), await expires.textContent());
  // To 58.5 seconds before the expiry, measured on the page, whatever the server's and the page's
  // clocks differ by.
  const until = Date.parse((await expires.getAttribute("datetime")) ?? "") - (await timed.evaluate(() => Date.now()));
  await timed.clock.runFor(Math.max(0, until - 58_500));
  const seconds = async () => Number(/^in (5\d) seconds$/.exec((await expires.textContent()) ?? "")?.[1]);
  const first = await seconds();
  check("under a minute ahead, it counts seconds", first > 50, await expires.textContent());
  // A tick redraws only the time whose text changes: the one counting seconds, not the one hours
  // old beside it (one format call a second, not one for every time on the page).
  await timed.evaluate(() => {
    const format = Intl.RelativeTimeFormat.prototype.format;
    (/** @type {any} */ (window)).__formats = 0;
    Intl.RelativeTimeFormat.prototype.format = function (...args) {
      (/** @type {any} */ (window)).__formats++;
      return format.apply(this, args);
    };
  });
  await timed.clock.runFor(2_000);
  check("each second", (await seconds()) === first - 2, `${first} then ${await expires.textContent()}`);
  const formats = await timed.evaluate(() => (/** @type {any} */ (window)).__formats);
  check("a tick redraws only the time whose text changes", formats <= 3, `${formats} format calls in 2 seconds`);
  await timed.clock.runFor(60_000);
  check("past it, it says how long ago", /^\d+ seconds? ago$/.test((await expires.textContent()) ?? ""), await expires.textContent());
  check("the one behind kept its hour", (await listed.textContent()) === "3 hr. ago", await listed.textContent());
  await timed.clock.runFor(55 * 60_000);
  check("an hour on, the one behind moves", (await listed.textContent()) === "4 hr. ago" && (await expires.textContent()) === "55 minutes ago", `${await listed.textContent()}, ${await expires.textContent()}`);
  // Back from sleep: the clock moved two hours and no timer ran; the page coming back redraws.
  await timed.clock.setSystemTime((await timed.evaluate(() => Date.now())) + 2 * 3600_000);
  await timed.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  check("the page coming back redraws as of its clock", (await listed.textContent()) === "6 hr. ago" && (await expires.textContent()) === "2 hours ago", `${await listed.textContent()}, ${await expires.textContent()}`);
  // A time put in place of another, as a patch does: the new one is kept current, the old one let
  // go. The clock first moves past the page's timer with nothing to say so (a sleep), so the new
  // time cannot count on that timer.
  await timed.clock.setSystemTime((await timed.evaluate(() => Date.now())) + 2 * 3600_000);
  await timed.evaluate(() => {
    const old = /** @type {HTMLTimeElement} */ (document.querySelectorAll("time")[1]);
    const time = /** @type {HTMLTimeElement} */ (old.cloneNode(false));
    time.dateTime = new Date(Date.now() + 90_000).toISOString();
    time.textContent = "in 1 minute";
    old.replaceWith(time);
  });
  await timed.clock.runFor(31_000);
  check("a time that replaces another is kept current", /^in 5\d seconds$/.test((await expires.textContent()) ?? ""), await expires.textContent());
  // The clock set back half a minute while the page is shown: the timer comes before its time by
  // the page's clock, and every time is drawn again from it.
  await timed.clock.setSystemTime((await timed.evaluate(() => Date.now())) - 30_000);
  await timed.clock.runFor(2_000);
  check("a clock set back draws the times again from it", (await expires.textContent()) === "in 1 minute", await expires.textContent());
  check("no console errors with relative times", timedErrors.length === 0, timedErrors.join(" | "));
  await timed.context().close();
  // A browser without the page's locale falls back to another language: the server's text stays.
  const lacking = await (await browser.newContext()).newPage();
  const lackingErrors = [];
  lacking.on("pageerror", (e) => lackingErrors.push(String(e)));
  lacking.on("console", (m) => m.type() === "error" && !bug(m.text()) && lackingErrors.push(m.text()));
  await lacking.addInitScript(() => {
    const options = Intl.RelativeTimeFormat.prototype.resolvedOptions;
    Intl.RelativeTimeFormat.prototype.resolvedOptions = function () {
      /** @type {any} */ (window).asked = (/** @type {any} */ (window).asked ?? 0) + 1;
      return { ...options.call(this), locale: "fr" };
    };
  });
  await lacking.clock.install();
  await lacking.goto(`${base}/`);
  await lacking.clock.runFor(31_000);
  const asked = await lacking.evaluate(() => /** @type {any} */ (window).asked ?? 0);
  check(
    "a locale the browser lacks keeps the server's text",
    asked > 0 && lackingErrors.length === 0 && (await lacking.locator("time").nth(1).textContent()) === "in 1 minute",
    `${await lacking.locator("time").nth(1).textContent()}, asked ${asked}, ${lackingErrors.join(" | ")}`,
  );
  await lacking.context().close();

  // The refused renames are 422s, which Chromium and WebKit log; nothing else may be. WebKit also
  // reports a request to the gallery's own origin that did not finish (the hover prefetch of
  // /?sale=last, or a load the next navigation dropped) as a fetch that "cannot load
  // http://localhost:18482/?sale=last due to access control checks"; Playwright splits that page
  // error at its first colon, so the text here starts "/localhost:18482/?sale=last" (#301). A
  // request to its own origin is never refused by CORS, so only another origin's still counts.
  const ownOrigin = `/${new URL(base).host}/`;
  const unexpected = errors.filter((e) => {
    const refused = /(\S+) due to access control checks/.exec(e)?.[1];
    return !/status of 422/.test(e) && !refused?.startsWith(ownOrigin);
  });
  check("no console errors", unexpected.length === 0, unexpected.join(" | "));

  // LocalTime: a browser's first page is written in UTC, since its zone is not known yet, and the
  // script writes it again in the browser's; on the next page the server writes it in that zone.
  const kiwi = await (await browser.newContext({ timezoneId: "Pacific/Auckland" })).newPage();
  await kiwi.goto(`${base}/`);
  const drafted = kiwi.locator("p", { hasText: "Drafted" }).locator("time");
  await kiwi.waitForFunction(() => document.cookie.includes("corten-zone=") && document.body.textContent?.includes("GMT+13"), null, { timeout: 5000 }).catch(() => {});
  const firstDrafted = await drafted.textContent();
  check("a first page's date is written again in the browser's zone", firstDrafted === "Mar 23, 2026, 4:04 AM GMT+13", firstDrafted);
  await kiwi.reload();
  const nextDrafted = await drafted.textContent();
  check("the next page's server writes it in that zone, with no script", nextDrafted === firstDrafted && (await drafted.getAttribute("data-on")) === null, nextDrafted);
  await kiwi.context().close();

  // The orders page: the kit's other components, each as plain HTML that works before any script.
  const orders = await (await browser.newContext()).newPage();
  const ordersErrors = [];
  orders.on("console", (m) => m.type() === "error" && !bug(m.text()) && ordersErrors.push(m.text()));
  orders.on("pageerror", (e) => ordersErrors.push(e.message));
  await orders.goto(`${base}/orders`);
  // Alert's role follows its variant: a warning is an alert, read at once.
  const alertRole = await orders.locator("strong", { hasText: "past its ship-by date" }).evaluate((s) => s.parentElement?.getAttribute("role"));
  check("Alert: a warning is role=alert", alertRole === "alert", String(alertRole));
  // A row's menu: an icon trigger, named by its hidden text, square at the control's height and
  // with no chevron; the hidden text takes no room.
  const rowMenu = orders.getByRole("button", { name: "More actions for Ada Lovelace's order" });
  const iconTrigger = await rowMenu.evaluate((b) => {
    const box = b.getBoundingClientRect();
    const hidden = /** @type {Element} */ (b.querySelector("span:not([aria-hidden])")).getBoundingClientRect();
    const height = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--control-height")) * parseFloat(getComputedStyle(document.documentElement).fontSize);
    return { width: Math.round(box.width), height: Math.round(box.height), want: Math.round(height), chevron: getComputedStyle(b, "::after").content, hidden: [hidden.width, hidden.height] };
  });
  check(
    "DropdownMenu: an icon trigger is a square at the control's height with no chevron, named by hidden text",
    iconTrigger.width === iconTrigger.want && iconTrigger.height === iconTrigger.want && iconTrigger.chevron === "none" && iconTrigger.hidden[0] <= 1 && iconTrigger.hidden[1] <= 1,
    JSON.stringify(iconTrigger),
  );
  // On a phone, a table wider than the page scrolls in its wrapper, and the hidden text of a row's
  // menu in a cell scrolled out of view does not widen the page.
  {
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await phone.goto(`${base}/orders`);
    const wide = await phone.getByRole("button", { name: "More actions for Ada Lovelace's order" }).evaluate((b) => {
      const table = /** @type {HTMLTableElement} */ (b.closest("table"));
      table.style.minWidth = "60rem";
      return { scrolls: /** @type {HTMLElement} */ (table.parentElement).scrollWidth > innerWidth, page: document.documentElement.scrollWidth, width: innerWidth };
    });
    await phone.context().close();
    check("Table: a row's hidden text in a cell scrolled out of view does not widen the page", wide.scrolls && wide.page <= wide.width, JSON.stringify(wide));
  }
  // By the keyboard, on a page of its own, so an open menu leaves nothing for the checks after it.
  {
    const menuPage = await orders.context().newPage();
    await menuPage.goto(`${base}/orders`);
    await menuPage.getByRole("button", { name: "More actions for Ada Lovelace's order" }).focus();
    await menuPage.keyboard.press("ArrowDown");
    await menuPage.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem", null, { timeout: 5000 }).catch(() => {});
    check("DropdownMenu: a row's icon menu opens on its first item", (await menuPage.evaluate(() => document.activeElement?.textContent)) === "Help with this order");
    // The draft page's text trigger keeps its chevron.
    await menuPage.goto(`${base}/`);
    const textChevron = await menuPage.locator("#actions-button").evaluate((b) => getComputedStyle(b, "::after").content).catch(() => "missing");
    check("DropdownMenu: a text trigger keeps its chevron", textChevron !== "none" && textChevron !== "missing", textChevron);
    await menuPage.close();
  }
  // One width rule: in a Field the control fills the field's row, a select as an input does; a
  // ControlWidth holds there (the price, on the home page).
  const fills = await orders.getByLabel("Ship from", { exact: true }).evaluate((s) => [s.getBoundingClientRect().width, /** @type {Element} */ (s.parentElement).getBoundingClientRect().width].map(Math.round));
  check("Select: in a Field, fills the field's row", fills[0] === fills[1] && fills[0] > 200, JSON.stringify(fills));
  const home = await orders.context().newPage();
  await home.goto(`${base}/`);
  const priced = await home.getByLabel("Price (USD)", { exact: true }).evaluate((i) => {
    const root = getComputedStyle(document.documentElement);
    const want = parseFloat(root.getPropertyValue("--control-width-sm")) * parseFloat(root.fontSize);
    return {
      width: Math.round(i.getBoundingClientRect().width),
      want: Math.round(Math.min(want, /** @type {Element} */ (i.parentElement).getBoundingClientRect().width)),
      classes: [...i.classList].filter((c) => c.startsWith("control-width")),
    };
  });
  // The condition combobox (a corten-ui widget) fills its field's row too.
  const combo = await home.getByRole("combobox", { name: "Condition" }).evaluate((i) => [i.getBoundingClientRect().width, /** @type {Element} */ (i.closest("[class*=field__control]")).getBoundingClientRect().width].map(Math.round));
  // An input outside a field has its natural width and sits beside its button in a row that wraps
  // (a Cluster); the price's look classes, without its width, on an input in such a row.
  const beside = await home.getByLabel("Price (USD)", { exact: true }).evaluate((price) => {
    const row = document.createElement("div");
    row.style.cssText = "display: flex; flex-wrap: wrap; gap: .5rem; width: 360px";
    const input = document.createElement("input");
    input.className = [...price.classList].filter((c) => !c.startsWith("control-width")).join(" ");
    const button = document.createElement("button");
    button.textContent = "Find";
    row.append(input, button);
    document.body.append(row);
    const out = { input: Math.round(input.getBoundingClientRect().width), sameRow: input.getBoundingClientRect().top === button.getBoundingClientRect().top };
    row.remove();
    return out;
  });
  // A Field in a column narrower than its control's natural width keeps the control inside it: a
  // copy of an input's field and a ComboBox's, without a ControlWidth, in a grid of 8rem columns (a
  // Stepper keeps its width and full-size buttons). In a box with room that sizes to its content
  // (absolutely placed), a field is still as wide as its control asks.
  const narrowFields = await home.evaluate(() => {
    const labels = ["Price (USD)", "Condition"];
    const fields = [...document.querySelectorAll("[class*=field__field]")].filter((f) => labels.includes(f.querySelector("label")?.textContent?.trim() ?? ""));
    /** @param {Element} field */
    const copyOf = (field) => {
      const copy = /** @type {Element} */ (field.cloneNode(true));
      for (const el of copy.querySelectorAll("[id]")) el.removeAttribute("id");
      for (const input of copy.querySelectorAll("input")) {
        input.classList.remove(...[...input.classList].filter((c) => c.startsWith("control-width")));
      }
      return copy;
    };
    /** @param {Element} copy */
    const past = (copy) =>
      Math.max(...[...copy.querySelectorAll("input, select, textarea, button")].map((el) => Math.round(el.getBoundingClientRect().right - copy.getBoundingClientRect().right)));
    const grid = document.createElement("div");
    grid.style.cssText = "display: grid; grid-template-columns: repeat(3, 8rem); gap: 1rem";
    grid.append(...fields.map(copyOf));
    document.body.append(grid);
    const narrow = [...grid.children].map(past);
    grid.remove();
    const price = copyOf(/** @type {Element} */ (fields.find((f) => f.querySelector("label")?.textContent?.trim() === "Price (USD)")));
    const box = document.createElement("div");
    box.style.cssText = "position: absolute; top: 0; left: 0";
    box.append(price);
    document.body.append(box);
    const own = Math.round(price.getBoundingClientRect().width);
    const input = /** @type {HTMLInputElement} */ (price.querySelector("input"));
    input.style.cssText = "position: absolute";
    const natural = Math.round(input.getBoundingClientRect().width);
    box.remove();
    // A Stepper keeps its width and its buttons their size, however narrow the column.
    const quantity = /** @type {Element} */ ([...document.querySelectorAll("[class*=field__field]")].find((f) => f.querySelector("label")?.textContent?.trim() === "Quantity"));
    /** @param {Element} field */
    const buttons = (field) => [...field.querySelectorAll("button")].map((b) => Math.round(b.getBoundingClientRect().width));
    const onPage = buttons(quantity);
    const thin = document.createElement("div");
    thin.style.cssText = "display: grid; grid-template-columns: 8rem";
    const quantityCopy = copyOf(quantity);
    thin.append(quantityCopy);
    document.body.append(thin);
    const squeezed = buttons(quantityCopy);
    thin.remove();
    return { kinds: fields.length, narrow, own, natural, stepper: { onPage, squeezed } };
  });
  await home.close();
  check("Field: in a column narrower than its control's natural width, the control stays inside the field", narrowFields.kinds === 2 && narrowFields.narrow.every((px) => px <= 0), JSON.stringify(narrowFields));
  check("Field: in a box with room sized to its content, as wide as its control's natural width", narrowFields.own >= narrowFields.natural - 1, JSON.stringify(narrowFields));
  check(
    "Field: a Stepper in a column narrower than it keeps its buttons' size",
    narrowFields.stepper.onPage.length === 2 && narrowFields.stepper.onPage.every((w, i) => w > 20 && w === narrowFields.stepper.squeezed[i]),
    JSON.stringify(narrowFields.stepper),
  );
  check("ControlWidth: a field's row keeps the control's width", priced.width === priced.want, JSON.stringify(priced));
  check("ComboBox: in a Field, fills the field's row", combo[0] === combo[1] && combo[0] > 200, JSON.stringify(combo));
  check("Input: outside a Field, its natural width, beside its button", beside.sameRow && beside.input < 260, JSON.stringify(beside));
  // A textarea fills its field's row, and a ControlWidth on one holds there too (both stylesheets
  // weigh the same, so the width's two classes win wherever they come).
  const note = await orders.getByLabel("Note to buyers", { exact: true }).evaluate((area, sm) => {
    const row = /** @type {Element} */ (area.parentElement);
    const fills = Math.round(area.getBoundingClientRect().width) === Math.round(row.getBoundingClientRect().width);
    // The copy alone in the row, in the textarea's place.
    const copy = /** @type {HTMLTextAreaElement} */ (area.cloneNode());
    copy.removeAttribute("id");
    copy.removeAttribute("name");
    copy.classList.add(...sm);
    area.replaceWith(copy);
    const root = getComputedStyle(document.documentElement);
    const want = Math.round(parseFloat(root.getPropertyValue("--control-width-sm")) * parseFloat(root.fontSize));
    const limited = Math.round(copy.getBoundingClientRect().width);
    // Outside a field, the textarea fills its container.
    const box = document.createElement("div");
    box.style.width = "300px";
    const loose = /** @type {HTMLTextAreaElement} */ (area.cloneNode());
    loose.removeAttribute("id");
    loose.removeAttribute("name");
    box.append(loose);
    document.body.append(box);
    const outside = Math.round(loose.getBoundingClientRect().width);
    box.remove();
    copy.replaceWith(area);
    return { fills, limited, want, outside };
  }, priced.classes);
  check("Textarea: in a Field, fills the row; a ControlWidth on one holds; outside one, fills its container", note.fills && note.limited === note.want && note.outside === 300, JSON.stringify(note));
  // Badge's tones: the paid order's text and its background meet WCAG AA (4.5:1), as drawn.
  const paid = await orders.locator("td > span", { hasText: /^Paid$/ }).first().evaluate((el) => {
    // `rgb(r, g, b)`, or `color(srgb r g b)` (0 to 1) for a color-mix in sRGB.
    const rgb = (/** @type {string} */ c) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => (c.startsWith("color(srgb") ? Number(v) * 255 : Number(v)));
    const lum = (/** @type {number[]} */ c) => c.map((v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const style = getComputedStyle(el);
    const [a, b] = [lum(rgb(style.color)), lum(rgb(style.backgroundColor))].sort((x, y) => y - x);
    return { ratio: (a + 0.05) / (b + 0.05), color: style.color, background: style.backgroundColor };
  });
  check("Badge: a soft success badge's text meets 4.5:1", paid.ratio >= 4.5, JSON.stringify(paid));
  // A look is classes on the app's own element: the badge is the cell's child, a button's parent is
  // the app's, and no element of the kit's takes no box around one.
  const looks = await orders.evaluate(() => ({
    badge: document.querySelector("td > [class*='badge__badge']")?.tagName ?? "missing",
    wrappers: [...document.querySelectorAll(["button", "input", "select", "textarea", "slider", "badge", "card", "dialog", "sheet", "popover", "accordion"].map((n) => `[class*='${n}__']`).join())]
      .filter((e) => getComputedStyle(e).display === "contents").length,
    button: document.querySelector("[class*='button__button']")?.parentElement?.className.includes("button__") ?? "missing",
  }));
  check("Looks: the kit's classes are on the app's elements, with none of its own around them", looks.badge === "SPAN" && looks.wrappers === 0 && looks.button === false, JSON.stringify(looks));
  // The cells have no specificity of their own (`:where`): a text cell wraps, a number cell is end
  // aligned on one line, and the header stays on one line.
  const cells = await orders.evaluate(() => {
    const style = (/** @type {string} */ sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el) : null;
    };
    const text = style("tbody td:nth-child(2)");
    const number = style("tbody td[class*='table__numeric']");
    return { text: text?.whiteSpace, number: number && `${number.textAlign} ${number.whiteSpace}`, head: style("thead th")?.whiteSpace };
  });
  check("Table: a text cell wraps, a number cell is end aligned on one line", cells.text === "normal" && cells.number === "end nowrap" && cells.head === "nowrap", JSON.stringify(cells));
  // SortHeader's arrow is drawn from the header's aria-sort, the state a script that sorts the rows
  // in place sets (an attribute, which the CSP allows), so the arrow follows it (#606).
  const arrows = await orders.evaluate(() => {
    const arrow = document.querySelector("[class*='table__arrow']");
    const th = arrow?.closest("th");
    if (!arrow || !th) return null;
    const drawn = () => `${getComputedStyle(arrow).opacity} ${getComputedStyle(arrow).clipPath}`;
    const out = [drawn()];
    for (const sort of ["descending", "ascending"]) {
      th.setAttribute("aria-sort", sort);
      out.push(drawn());
    }
    th.removeAttribute("aria-sort");
    return out;
  });
  check(
    "SortHeader: the arrow follows aria-sort, unsorted, descending and ascending each drawn",
    arrows !== null && arrows[0].startsWith("0.35 ") && arrows[1].startsWith("1 ") && arrows[2].startsWith("1 ") && new Set(arrows.map((a) => a.slice(a.indexOf(" ")))).size === 3,
    JSON.stringify(arrows),
  );
  // SegmentedLinks: the order of the orders as navigation, the current link raised on the track.
  const links = await orders.evaluate(() => {
    const nav = document.querySelector("nav[class*='segmented__links']");
    const a = [...(nav?.querySelectorAll("a") ?? [])];
    return {
      current: a.filter((x) => x.getAttribute("aria-current") === "page").map((x) => x.textContent).join(),
      fills: a.map((x) => getComputedStyle(x).backgroundColor),
      track: nav ? getComputedStyle(nav).backgroundColor : "missing",
      // As wide as its links, also as a grid item, where inline-flex computes to flex.
      fits: nav && nav.parentElement ? nav.getBoundingClientRect().width < nav.parentElement.getBoundingClientRect().width - 1 : false,
    };
  });
  const clear = "rgba(0, 0, 0, 0)";
  check(
    "SegmentedLinks: the current link is raised on the track, the others are not",
    links.current === "Newest" && links.fits && links.fills[0] !== clear && links.fills[0] !== links.track && links.fills.slice(1).every((c) => c === clear),
    JSON.stringify(links),
  );
  // Card: an action on the heading's row at its end, the description under them; a panel is one
  // element with the card's padding on every side; a compact card is denser (#573, #605).
  const cards = await orders.evaluate(() => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const box = (/** @type {Element | null | undefined} */ e) => e?.getBoundingClientRect();
    const action = document.querySelector("[class*='card__action']");
    const header = action?.parentElement;
    const [heading, note] = [header?.querySelector("h2"), header?.querySelector(":scope > p")];
    const mid = (/** @type {DOMRect | undefined} */ r) => (r ? r.top + r.height / 2 : NaN);
    const panel = document.querySelector("[class*='card__panel']");
    const compact = document.querySelector("[class*='card__compact']");
    const pad = (/** @type {Element | null} */ e) => (e ? [getComputedStyle(e).paddingTop, getComputedStyle(e).paddingLeft].map((p) => parseFloat(p) / rem) : []);
    return {
      row: Math.abs(mid(box(heading)) - mid(box(action))) <= 2,
      // The header's padding after it, to a pixel (Firefox lays out to fractions).
      end: Math.abs((box(header)?.right ?? 0) - (box(action)?.right ?? 0) - 1.5 * rem) <= 1,
      gap: (box(header)?.right ?? 0) - (box(action)?.right ?? 0),
      note: (box(note)?.top ?? 0) >= (box(action)?.bottom ?? Infinity) - 1,
      // The surface (background and border) and padding are the panel's; its layout is the Stack's.
      panel: panel ? `${getComputedStyle(panel).display} ${pad(panel).join(" ")} ${getComputedStyle(panel).backgroundColor !== "rgba(0, 0, 0, 0)"} ${getComputedStyle(panel).borderTopStyle}` : "missing",
      compact: pad(compact)[0],
    };
  });
  check(
    "Card: an action at the end of the heading's row, the description under it; a panel and a compact card",
    cards.row && cards.end && cards.note && cards.panel === "flex 1.5 1.5 true solid" && cards.compact === 1,
    JSON.stringify(cards),
  );
  // Sizes are the theme's tokens: one value makes every control a 44 px touch target.
  const heights = await orders.evaluate(() => {
    // In rem, as the tokens are: the page's root font size is its own.
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const of = () => ["select", "button[class*='button__md']", "button[class*='button__sm']"].map((s) => (document.querySelector(s)?.getBoundingClientRect().height ?? 0) / rem);
    const before = of();
    document.documentElement.style.setProperty("--control-height", "2.75rem");
    const after = of();
    document.documentElement.style.removeProperty("--control-height");
    return { before, after };
  });
  check(
    "Sizes: --control-height sets the height of a select and a button of the default size, not a small one",
    heights.before[0] === 2.25 && heights.before[1] === 2.25 && heights.after[0] === 2.75 && heights.after[1] === 2.75 && heights.after[2] === heights.before[2],
    JSON.stringify(heights),
  );
  // Under forced colors a box shadow is not painted, so a focused field shows its outline, which is
  // transparent otherwise.
  const forcedCheck = "Select and Textarea: a focused field's outline is transparent, and painted under forced colors";
  if (engine !== "webkit") {
    /** @param {string} label */
    const ring = async (label) => {
      const field = orders.getByLabel(label);
      await field.focus();
      await orders.keyboard.press("Shift");
      return field.evaluate((el) => {
        const s = getComputedStyle(el);
        return `${el.matches(":focus-visible")} ${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`;
      });
    };
    const seen = [];
    let ok = true;
    for (const label of ["Ship from", "Note to buyers"]) {
      const plain = await ring(label);
      await orders.emulateMedia({ forcedColors: "active" });
      const forced = await ring(label);
      await orders.emulateMedia({ forcedColors: "none" });
      seen.push(plain, forced);
      ok &&= plain === "true solid 2px rgba(0, 0, 0, 0)" && forced.startsWith("true solid 2px ") && !forced.endsWith("rgba(0, 0, 0, 0)");
    }
    check(forcedCheck, ok, seen.join(" | "));
  } else skip(forcedCheck, "Playwright's WebKit does not emulate forced colors");
  // Meter: the native element, named by its field's label, its fill in the state's color: the
  // limit's value sits between low and high with optimum under low, one range off the good one.
  // (By its label: Playwright names a meter from its fallback text, where browsers use the label.)
  const meter = await orders.getByLabel("Sold this month").evaluate((m) => {
    const el = /** @type {HTMLMeterElement} */ (m);
    const box = el.getBoundingClientRect();
    return { tag: el.tagName, value: el.value, max: el.max, width: Math.round(box.width), height: Math.round(box.height) };
  });
  check(
    "Meter: a <meter> named by its label, drawn as a bar",
    meter.tag === "METER" && meter.value === 12375 && meter.max === 15000 && meter.width > 100 && meter.height === 8,
    JSON.stringify(meter),
  );
  // Its fill, as drawn, in each state's color: a plain measure (no low or high) in the primary
  // color; with low, high and optimum under low, the success color in the good range, the warning
  // color one range off it (the gallery's value) and the destructive color two off. The probe page
  // sets the meter's attributes from a script (attributes, not styles: the CSP allows them) and
  // samples a screenshot inside the fill, and past it on the track. The tokens are read as the page
  // has them. The screenshots are a page of their own: WebKit's adds a stylesheet the CSP refuses,
  // which is Playwright's, not the page's, so it stays out of this page's console check.
  const tokens = await orders.evaluate(() =>
    Object.fromEntries(["--primary", "--success", "--warning", "--destructive", "--border"].map((p) => [p, getComputedStyle(document.documentElement).getPropertyValue(p).trim()])),
  );
  const probe = await (await browser.newContext()).newPage();
  await probe.goto(`${base}/orders`);
  // The page's own range; each state sets every attribute, so none depends on the one before it.
  const ranged = await probe.getByLabel("Sold this month").evaluate((m) => ({ low: m.getAttribute("low"), high: m.getAttribute("high"), optimum: m.getAttribute("optimum") }));
  const states = [
    { name: "plain", attrs: { low: null, high: null, optimum: null, value: "6000" }, token: "--primary" },
    { name: "good", attrs: { ...ranged, value: "6000" }, token: "--success" },
    { name: "warning", attrs: { ...ranged, value: "12375" }, token: "--warning" },
    { name: "destructive", attrs: { ...ranged, value: "14250" }, token: "--destructive" },
  ];
  const shots = [];
  for (const state of states) {
    const filled = await probe.getByLabel("Sold this month").evaluate((m, attrs) => {
      for (const [name, value] of Object.entries(attrs)) value === null ? m.removeAttribute(name) : m.setAttribute(name, value);
      const el = /** @type {HTMLMeterElement} */ (m);
      return el.value / el.max;
    }, state.attrs);
    shots.push({ ...state, filled, png: (await probe.getByLabel("Sold this month").screenshot()).toString("base64") });
  }
  await probe.context().close();
  const blank = await orders.context().newPage();
  const drawn = await blank.evaluate(
    async ([shots, tokens]) => {
      const out = [];
      for (const { name, token, filled, png } of shots) {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        [canvas.width, canvas.height] = [img.width, img.height];
        const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
        g.drawImage(img, 0, 0);
        const at = (/** @type {number} */ x) => [...g.getImageData(Math.round(img.width * x), Math.floor(img.height / 2), 1, 1).data].slice(0, 3);
        // Inside the fill (half way to the value), and past it on the track (clear of the rounded end).
        const [fill, past] = [at(filled / 2), at((filled + 1) / 2)];
        // Each token's color, as the canvas paints it.
        const paint = (/** @type {string} */ c) => {
          g.clearRect(0, 0, 1, 1);
          g.fillStyle = c;
          g.fillRect(0, 0, 1, 1);
          return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        out.push({ name, fill, want: paint(tokens[token]), past, empty: paint(tokens["--border"]) });
      }
      return out;
    },
    [shots.map(({ name, token, filled, png }) => ({ name, token, filled, png })), tokens],
  );
  await blank.close();
  const near = (/** @type {number[]} */ a, /** @type {number[]} */ b) => a.every((c, i) => Math.abs(c - b[i]) <= 6);
  for (const { name, fill, want, past, empty } of drawn) {
    check(`Meter: ${name}, drawn in its color up to its value`, near(fill, want) && near(past, empty), JSON.stringify({ fill, want, past, empty }));
  }
  // Progress: the native element, named by its field's label, its fill in the primary color up to
  // its value and its track in the border color (sampled from a screenshot, as the meter's); with
  // no value, a band that moves, and stands still when the reader asks for less motion.
  const progress = await orders.getByLabel("Labels printed").evaluate((p) => {
    const el = /** @type {HTMLProgressElement} */ (p);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return { tag: el.tagName, filled: el.position, height: el.getBoundingClientRect().height / rem };
  });
  check("Progress: a <progress> named by its label, drawn as a bar", progress.tag === "PROGRESS" && Math.abs(progress.filled - 5 / 12) < 0.01 && progress.height === 0.5, JSON.stringify(progress));
  // The screenshot is a page of its own, as the meter's: WebKit's adds a stylesheet the CSP refuses.
  const progressProbe = await (await browser.newContext()).newPage();
  await progressProbe.goto(`${base}/orders`);
  const progressShot = (await progressProbe.getByLabel("Labels printed").screenshot()).toString("base64");
  await progressProbe.context().close();
  const progressBlank = await orders.context().newPage();
  const progressDrawn = await progressBlank.evaluate(
    async ([png, filled, tokens]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      [canvas.width, canvas.height] = [img.width, img.height];
      const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
      g.drawImage(img, 0, 0);
      const at = (/** @type {number} */ x) => [...g.getImageData(Math.round(img.width * x), Math.floor(img.height / 2), 1, 1).data].slice(0, 3);
      const [fill, past] = [at(filled / 2), at((filled + 1) / 2)];
      const paint = (/** @type {string} */ c) => {
        g.clearRect(0, 0, 1, 1);
        g.fillStyle = c;
        g.fillRect(0, 0, 1, 1);
        return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      return { fill, want: paint(tokens["--primary"]), past, empty: paint(tokens["--border"]) };
    },
    /** @type {[string, number, Record<string, string>]} */ ([progressShot, progress.filled, tokens]),
  );
  await progressBlank.close();
  check("Progress: drawn in the primary color up to its value, on the border color", near(progressDrawn.fill, progressDrawn.want) && near(progressDrawn.past, progressDrawn.empty), JSON.stringify(progressDrawn));
  const band = async () =>
    orders.getByLabel("Sending the next label").evaluate((p) => ({
      indeterminate: p.matches(":indeterminate"),
      animation: getComputedStyle(p).animationName,
      height: p.getBoundingClientRect().height / parseFloat(getComputedStyle(document.documentElement).fontSize),
    }));
  const moving = await band();
  await orders.emulateMedia({ reducedMotion: "reduce" });
  const still = await band();
  await orders.emulateMedia({ reducedMotion: null });
  check("Progress: with no value, a band that moves, and stands still under reduced motion", moving.indeterminate && moving.animation.endsWith("progress-sweep") && still.animation === "none" && moving.height === 0.25, JSON.stringify({ moving, still }));
  // Under forced colors the engine drops the theme's colors and gradients: the bar must still show
  // how far along it is, and the unknown one its stripes (sampled from screenshots, each on a page
  // of its own as above).
  const sampled = async (/** @type {string} */ label, /** @type {number[]} */ xs) => {
    const probe = await (await browser.newContext({ forcedColors: "active", reducedMotion: "reduce" })).newPage();
    await probe.goto(`${base}/orders`);
    const forced = await probe.evaluate(() => matchMedia("(forced-colors: active)").matches);
    const shot = (await probe.getByLabel(label).screenshot()).toString("base64");
    await probe.context().close();
    const blank = await orders.context().newPage();
    const at = await blank.evaluate(
      async ([png, xs]) => {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        [canvas.width, canvas.height] = [img.width, img.height];
        const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
        g.drawImage(img, 0, 0);
        return xs.map((x) => [...g.getImageData(Math.round((img.width - 1) * x), Math.floor(img.height / 2), 1, 1).data].slice(0, 3));
      },
      /** @type {[string, number[]]} */ ([shot, xs]),
    );
    await blank.close();
    return { forced, at };
  };
  const apart = (/** @type {number[]} */ a, /** @type {number[]} */ b) => a.some((c, i) => Math.abs(c - b[i]) > 60);
  const forcedBar = await sampled("Labels printed", [progress.filled / 2, (progress.filled + 1) / 2]);
  const forcedStripes = await sampled("Sending the next label", Array.from({ length: 24 }, (_, i) => (i + 0.5) / 24));
  const striped = forcedStripes.at.some((c) => apart(c, forcedStripes.at[0]));
  if (forcedBar.forced) {
    check("Progress: under forced colors, the fill and the track still differ, and stripes stand for no value", apart(forcedBar.at[0], forcedBar.at[1]) && striped, JSON.stringify({ forcedBar, forcedStripes }));
  } else if (engine === "chromium") {
    check("Progress: Chromium emulates forced colors", false, JSON.stringify(forcedBar));
  } else {
    skip("Progress: under forced colors, the fill and the track still differ", "forced colors are not emulated here");
  }
  // The meter likewise, in each of its states (each a rule of its own in each engine): its state's
  // color is gone under forced colors, but its fill must still show its value against the track.
  {
    const probe = await (await browser.newContext({ forcedColors: "active", reducedMotion: "reduce" })).newPage();
    await probe.goto(`${base}/orders`);
    const forced = await probe.evaluate(() => matchMedia("(forced-colors: active)").matches);
    const forcedShots = [];
    for (const state of states) {
      const filled = await probe.getByLabel("Sold this month").evaluate((m, attrs) => {
        for (const [name, value] of Object.entries(attrs)) value === null ? m.removeAttribute(name) : m.setAttribute(name, value);
        const el = /** @type {HTMLMeterElement} */ (m);
        return el.value / el.max;
      }, state.attrs);
      forcedShots.push({ name: state.name, filled, png: (await probe.getByLabel("Sold this month").screenshot()).toString("base64") });
    }
    await probe.context().close();
    const blank = await orders.context().newPage();
    const forcedDrawn = await blank.evaluate(async (shots) => {
      const out = [];
      for (const { name, filled, png } of shots) {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        [canvas.width, canvas.height] = [img.width, img.height];
        const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
        g.drawImage(img, 0, 0);
        const at = (/** @type {number} */ x) => [...g.getImageData(Math.round((img.width - 1) * x), Math.floor(img.height / 2), 1, 1).data].slice(0, 3);
        out.push({ name, fill: at(filled / 2), past: at((filled + 1) / 2) });
      }
      return out;
    }, forcedShots.map(({ name, filled, png }) => ({ name, filled, png })));
    await blank.close();
    for (const { name, fill, past } of forcedDrawn) {
      const label = `Meter: ${name}, under forced colors, the fill and the track still differ`;
      if (forced) check(label, apart(fill, past), JSON.stringify({ fill, past }));
      else if (engine === "chromium") check("Meter: Chromium emulates forced colors", false, name);
      else skip(label, "forced colors are not emulated here");
    }
  }
  // Under reduced motion the unknown bar is striped across its whole track, not a band at its start
  // that reads as a value.
  await orders.emulateMedia({ reducedMotion: "reduce" });
  const stripes = await orders.getByLabel("Sending the next label").evaluate((p) => getComputedStyle(p).backgroundImage);
  await orders.emulateMedia({ reducedMotion: null });
  check("Progress: with no value under reduced motion, stripes across the track", stripes.startsWith("repeating-linear-gradient"), stripes);
  // NavBar: a look on the app's <header>; the current page's link, and only it, marked from the
  // aria-current that req.nav writes.
  const bar = await orders.evaluate(() => {
    const links = [...document.querySelectorAll("body > header[class*='nav-bar__bar'] > nav > a")];
    return {
      links: links.map((a) => `${a.textContent}${a.getAttribute("aria-current") === "page" ? "*" : ""}`).join(),
      marked: links.map((a) => getComputedStyle(a).boxShadow !== "none").join(),
    };
  });
  check("NavBar: the current page's link is marked, and only it", bar.links === "Draft,Orders*" && bar.marked === "false,true", JSON.stringify(bar));
  // On a phone, with more links than fit their own row, they stay one row that scrolls sideways inside the page,
  // and a shadow shows at the edge with links past it: the end at first, the start once scrolled to
  // the end. Sampled from screenshots a quarter of the way down the links, clear of their text,
  // against the bar's own color.
  const narrow = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await narrow.goto(`${base}/orders`);
  const sections = narrow.locator("nav[class*='nav-bar__sections']");
  const row = await sections.evaluate((nav) => {
    const first = /** @type {HTMLElement} */ (nav.firstElementChild);
    for (const name of ["Listings", "Payouts", "Settings", "Shipping", "Returns", "Reports"]) {
      const a = /** @type {HTMLElement} */ (first.cloneNode());
      a.textContent = name;
      nav.append(a);
    }
    // An icon link at the end, its name in visually hidden text (absolutely placed, clipped): the
    // row is positioned, so the text scrolls with it rather than widening the page.
    const icon = /** @type {HTMLElement} */ (first.cloneNode());
    const hidden = document.createElement("span");
    hidden.textContent = "Notifications and messages";
    Object.assign(hidden.style, { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" });
    icon.append("\u2709", hidden);
    nav.append(icon);
    const header = /** @type {HTMLElement} */ (nav.parentElement);
    return {
      sideways: nav.scrollWidth > nav.clientWidth,
      inside: document.documentElement.scrollWidth <= innerWidth,
      height: Math.round(header.getBoundingClientRect().height),
      card: getComputedStyle(header).backgroundColor,
    };
  });
  const start = (await sections.screenshot()).toString("base64");
  await sections.evaluate((nav) => (nav.scrollLeft = nav.scrollWidth));
  const end = (await sections.screenshot()).toString("base64");
  await narrow.context().close();
  check("NavBar: on a phone the links are a row of their own that scrolls sideways, not the page", row.sideways && row.inside && row.height < 110, JSON.stringify(row));
  // On a phone with a two-word name, an action and ten links, the links still have the bar's width,
  // so more than one is in view.
  {
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await phone.goto(`${base}/orders`);
    const crowded = await phone.locator("nav[class*='nav-bar__sections']").evaluate((nav) => {
      const header = /** @type {HTMLElement} */ (nav.parentElement);
      /** @type {HTMLElement} */ (header.querySelector("a")).textContent = "TCGPlayer Automation";
      const first = /** @type {HTMLElement} */ (nav.firstElementChild);
      for (const name of ["Listings", "Payouts", "Pricing", "Shipping", "Intake", "Reports", "Settings", "Help"]) {
        const a = /** @type {HTMLElement} */ (first.cloneNode());
        a.textContent = name;
        nav.append(a);
      }
      const box = nav.getBoundingClientRect();
      const inView = [...nav.children].filter((a) => {
        const r = a.getBoundingClientRect();
        return r.left >= box.left && r.right <= box.right;
      }).length;
      return { width: Math.round(box.width), bar: Math.round(header.getBoundingClientRect().width), inView, height: Math.round(header.getBoundingClientRect().height) };
    });
    check("NavBar: on a phone a long name and an action leave the links the bar's width", crowded.width >= crowded.bar - 1 && crowded.inView >= 2 && crowded.height < 110, JSON.stringify(crowded));
    // The name's focus ring is whole on a phone, its top edge inside the page.
    await phone.goto(`${base}/orders`);
    await phone.keyboard.press("Tab");
    const ring = await phone.locator("header[class*='nav-bar__bar'] > a").first().evaluate((brand) => {
      brand.focus();
      const style = getComputedStyle(brand);
      const reach = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
      return { top: Math.round((brand.getBoundingClientRect().top - reach) * 10) / 10, outline: style.outlineStyle, focused: brand.matches(":focus-visible") };
    });
    // A browser that tabs to the row of links when it scrolls (Firefox) rings it inside, in the
    // bar's color: the row given more links than fit, then the key after the name.
    await phone.locator("header[class*='nav-bar__bar'] > a").first().evaluate((brand) => {
      const nav = /** @type {HTMLElement} */ (document.querySelector("nav[class*='nav-bar__sections']"));
      const first = /** @type {HTMLElement} */ (nav.firstElementChild);
      for (const name of ["Listings", "Payouts", "Pricing", "Shipping", "Intake", "Reports", "Settings", "Help"]) {
        const a = /** @type {HTMLElement} */ (first.cloneNode());
        a.textContent = name;
        nav.append(a);
      }
      /** @type {HTMLElement} */ (brand).focus();
    });
    await phone.keyboard.press("Tab");
    const rowRing = await phone.evaluate(() => {
      const nav = /** @type {HTMLElement} */ (document.querySelector("nav[class*='nav-bar__sections']"));
      if (document.activeElement !== nav) return null;
      const style = getComputedStyle(nav);
      return { outline: style.outlineStyle, offset: parseFloat(style.outlineOffset), color: style.outlineColor, bar: getComputedStyle(/** @type {Element} */ (nav.parentElement)).color };
    });
    await phone.context().close();
    check("NavBar: on a phone the name's focus ring is inside the page", ring.focused && ring.outline !== "none" && ring.top >= 0, JSON.stringify(ring));
    const rowRingName = "NavBar: a scrolling row of links that takes focus is ringed inside it in the bar's color";
    if (engine === "firefox" || rowRing) {
      check(rowRingName, !!rowRing && rowRing.outline === "solid" && rowRing.offset < 0 && rowRing.color === rowRing.bar, JSON.stringify(rowRing));
    } else skip(rowRingName, "this browser does not tab to a scrolling row with links in it");
  }
  // Recolored as its doc says (--card and --card-foreground on the <header>), every part of the bar
  // is drawn from that pair: the name and links 4.5:1 on it, the current link's underline 3:1.
  {
    const brand = await orders.evaluate(() => {
      const header = /** @type {HTMLElement} */ (document.querySelector("body > header[class*='nav-bar__bar']"));
      header.style.setProperty("--card", "rgb(25, 118, 210)");
      header.style.setProperty("--card-foreground", "rgb(255, 255, 255)");
      /** @param {string} css */
      const rgb = (css) => {
        const g = /** @type {CanvasRenderingContext2D} */ (Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d"));
        g.fillStyle = css;
        g.fillRect(0, 0, 1, 1);
        return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      /** @param {number[]} c */
      const lum = (c) => {
        const [r, g, b] = c.map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const bg = rgb(getComputedStyle(header).backgroundColor);
      /** @param {string} css */
      const ratio = (css) => {
        const [a, b] = [lum(rgb(css)), lum(bg)].sort((x, y) => y - x);
        return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100;
      };
      const links = [...header.querySelectorAll("nav > a")];
      const current = /** @type {Element} */ (links.find((a) => a.getAttribute("aria-current") === "page"));
      const out = {
        brand: ratio(getComputedStyle(/** @type {Element} */ (header.querySelector("a"))).color),
        links: Math.min(...links.map((a) => ratio(getComputedStyle(a).color))),
        current: ratio(/** @type {string} */ (getComputedStyle(current).boxShadow.match(/rgba?\([^)]*\)/)?.[0])),
      };
      header.style.removeProperty("--card");
      header.style.removeProperty("--card-foreground");
      return out;
    });
    check("NavBar: recolored by --card and --card-foreground, its name and links are 4.5:1 on it and the current mark 3:1", brand.brand >= 4.5 && brand.links >= 4.5 && brand.current >= 3, JSON.stringify(brand));
  }
  // On a phone, a wide table in a part ShownFor wraps, in a card's content, scrolls inside the card
  // rather than widening the page: the card's column is no wider than the card.
  {
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await phone.goto(`${base}/`);
    const wide = await phone.locator("caption", { hasText: "This month's last sales" }).evaluate((caption) => {
      const box = /** @type {HTMLElement} */ (caption.closest("table")?.parentElement);
      const card = /** @type {HTMLElement} */ (box.closest("section"));
      return {
        scrolls: box.scrollWidth > box.clientWidth,
        cardFits: card.getBoundingClientRect().right <= innerWidth + 0.5,
        page: document.documentElement.scrollWidth,
        width: innerWidth,
      };
    });
    await phone.context().close();
    check("Table: in a ShownFor part on a phone, scrolls inside its card and the page does not", wide.scrolls && wide.cardFits && wide.page <= wide.width, JSON.stringify(wide));
  }
  const edges = await orders.context().newPage();
  const shaded = await edges.evaluate(
    async ([shots, card]) => {
      const out = [];
      for (const png of shots) {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        [canvas.width, canvas.height] = [img.width, img.height];
        const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
        g.fillStyle = card;
        g.fillRect(0, 0, 1, 1);
        const bar = [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
        g.drawImage(img, 0, 0);
        const y = Math.round(img.height / 4);
        // How far each edge's pixel is from the bar's color.
        const off = (/** @type {number} */ x) => Math.max(...[...g.getImageData(x, y, 1, 1).data].slice(0, 3).map((c, i) => Math.abs(c - bar[i])));
        out.push([off(1), off(img.width - 2)]);
      }
      return out;
    },
    [[start, end], row.card],
  );
  await edges.close();
  const [[startLeft, startRight], [endLeft, endRight]] = shaded;
  check(
    "NavBar: a shadow marks the edge with more links past it",
    startLeft <= 3 && startRight >= 10 && endLeft >= 10 && endRight <= 3,
    JSON.stringify(shaded),
  );
  // Steps: counted, a Done step drawn with a check mark a screen reader does not read (its words
  // are, and are not shown), the current one filled, and a step with no page a <span>, numbered
  // but not a link.
  const draft = await orders.context().newPage();
  await draft.goto(`${base}/`);
  const steps = await draft.evaluate(() =>
    [...document.querySelectorAll("nav[class*='steps__steps'] li")].map((li) => {
      const step = /** @type {HTMLElement} */ (li.firstElementChild);
      const mark = getComputedStyle(step, "::before");
      const status = step.querySelector("[class*='steps__status']");
      return {
        tag: step.tagName,
        checked: mark.content.includes("\u2713"),
        numbered: mark.content.startsWith("counter(kit-step)") && mark.width === mark.height && parseFloat(mark.width) > 20,
        blocked: mark.content.startsWith('"!"'),
        fill: mark.backgroundColor,
        line: getComputedStyle(li, "::after").backgroundColor,
        hidden: status ? status.getBoundingClientRect().width <= 1 : null,
      };
    }),
  );
  const [done, now, blocked, later] = steps;
  check(
    "Steps: the done step is drawn with a check mark, the current filled, a blocked one with ! in its own color, the others numbered",
    steps.length === 4 &&
      done.checked && !now.checked && !later.checked && now.numbered && later.numbered && !done.numbered &&
      blocked.blocked && !blocked.numbered && !blocked.checked && !later.blocked &&
      done.fill !== now.fill && now.fill !== later.fill && blocked.fill !== later.fill && blocked.fill !== now.fill && done.line !== now.line,
    JSON.stringify(steps),
  );
  // A description is shown under its step's name, not part of the link's name; on a phone it is
  // read and not shown.
  const described = () =>
    draft.evaluate(() =>
      [...document.querySelectorAll("nav[class*='steps__steps'] li")].map((li) => {
        const note = li.querySelector("[class*='steps__description']");
        if (!note) return null;
        const name = /** @type {HTMLElement} */ (li.firstElementChild).getBoundingClientRect();
        // The name's own text, which ends where its column should (the element stretches to it).
        const words = document.createRange();
        words.selectNodeContents(/** @type {Node} */ (li.firstElementChild?.firstChild));
        const text = words.getBoundingClientRect();
        const box = note.getBoundingClientRect();
        // The line to the next step starts by the name, not past the description.
        const line = li.matches(":last-child") ? null : getComputedStyle(li, "::after").width;
        return {
          text: note.textContent,
          below: box.top >= name.bottom - 1,
          shown: box.width > 1 && box.height > 1,
          inLink: !!note.closest("a"),
          marked: getComputedStyle(note, "::before").content !== "none",
          top: Math.round(li.getBoundingClientRect().top),
          gap: Math.round(li.getBoundingClientRect().right - text.right - (line === null ? 0 : parseFloat(line))),
        };
      }),
    );
  const notes = await described();
  // Each step on a row starts at its top, a step with a description or not.
  const tops = await draft.evaluate(() => [...document.querySelectorAll("nav[class*='steps__steps'] li")].map((li) => Math.round(li.getBoundingClientRect().top)));
  // A long description wraps inside the step, and the step's name does not.
  const longNote = await draft.evaluate(() => {
    const note = /** @type {HTMLElement} */ (document.querySelector("nav[class*='steps__steps'] [class*='steps__description']"));
    const was = note.textContent;
    note.textContent = "Price, quantity and condition, and a note to the buyer on the card's centering and edges";
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const out = { lines: Math.round(note.getBoundingClientRect().height / parseFloat(getComputedStyle(note).lineHeight)), width: note.getBoundingClientRect().width / rem };
    note.textContent = was;
    return out;
  });
  const flow = draft.getByRole("navigation", { name: "Listing steps" });
  const named = await flow.getByRole("link").evaluateAll((all) => all.map((a) => a.getAttribute("aria-current") ?? ""));
  check(
    "Steps: a screen reader hears the done and blocked steps' status, the page does not show it, and a step not reachable is no link",
    (await flow.getByRole("link", { name: "Read the guide (done)", exact: true }).count()) === 1 &&
      (await flow.getByRole("link", { name: "Draft", exact: true }).count()) === 1 &&
      named.join() === ",step" &&
      done.hidden === true &&
      blocked.tag === "SPAN" &&
      blocked.hidden === true &&
      later.tag === "SPAN" &&
      later.hidden === true,
    JSON.stringify({ named, done, blocked, later }),
  );
  check(
    "Steps: a description is shown under its step's name, outside the link, with no mark of its own, and the line starts by the name",
    notes.length === 4 && notes[0] === null && notes[3] === null && [notes[1], notes[2]].every((n) => n && n.below && n.shown && !n.inLink && !n.marked && n.gap <= 10),
    JSON.stringify(notes),
  );
  // Tops within a step's height of each other are one row; a wrapped row starts well below.
  const rowsAligned = tops.every((t, i) => i === 0 || t === tops[i - 1] || t - tops[i - 1] > 30);
  check("Steps: the steps of a row share a top, and a long description wraps", rowsAligned && longNote.lines >= 2 && longNote.width <= 16.01, JSON.stringify({ tops, longNote }));
  await draft.setViewportSize({ width: 320, height: 640 });
  const fits = await draft.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  check("Steps: on a phone they fit the page", fits);
  const phoneNotes = await described();
  check(
    "Steps: on a phone a description is not shown and is still in the page",
    [phoneNotes[1], phoneNotes[2]].every((n) => n && !n.shown && n.text),
    JSON.stringify(phoneNotes),
  );
  // A timeline (the orders page's payout): one step per row down the page, on a phone too, each
  // description shown beside its mark, the line from each mark down to the next, and a failed step
  // drawn with a cross in a color of its own, its words read and not shown.
  const payout = await orders.context().newPage();
  await payout.setViewportSize({ width: 390, height: 800 });
  await payout.goto(`${base}/orders`);
  const timeline = await payout.getByRole("list", { name: "Payout" }).evaluate((nav) =>
    [...nav.querySelectorAll("li")].map((li) => {
      const step = /** @type {HTMLElement} */ (li.firstElementChild);
      const mark = getComputedStyle(step, "::before");
      const note = /** @type {HTMLElement} */ (li.querySelector("[class*='steps__description']"));
      const line = getComputedStyle(li, "::after");
      const box = li.getBoundingClientRect();
      const status = step.querySelector("[class*='steps__status']");
      return {
        left: Math.round(box.left),
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        note: note.checkVisibility() && note.getBoundingClientRect().width > 50 && note.getBoundingClientRect().right <= innerWidth,
        line: li.matches(":last-child") ? null : { width: line.width, height: parseFloat(line.height) },
        crossed: mark.content.includes("\u2715"),
        fill: mark.backgroundColor,
        hidden: status ? status.getBoundingClientRect().width <= 1 : null,
      };
    }),
  );
  const failedName = await payout.getByRole("list", { name: "Payout" }).locator("li").last().locator("span").first().textContent();
  // A name that wraps keeps its mark beside its first line, and the line down starts under the mark.
  // So with a theme's larger control font, whose line is taller than the mark.
  const wrapped = await payout.getByRole("list", { name: "Payout" }).evaluate((list) => {
    const li = /** @type {HTMLElement} */ (list.querySelector("li"));
    const step = /** @type {HTMLElement} */ (li.firstElementChild);
    const text = /** @type {Text} */ ([...step.childNodes].find((n) => n.nodeType === Node.TEXT_NODE));
    text.textContent = "Provider transfer submitted and waiting on the bank to answer";
    // A reference with no place to break, which must not widen the page (measured below).
    /** @type {HTMLElement} */ (li.querySelector("[class*='steps__description']")).textContent = `Reference ${"0123456789abcdef".repeat(4)}`;
    const measure = () => {
      const range = document.createRange();
      range.selectNodeContents(text);
      const lines = range.getClientRects();
      const first = lines[0];
      const mark = getComputedStyle(step, "::before");
      const top = step.getBoundingClientRect().top + parseFloat(getComputedStyle(step).paddingTop) + parseFloat(mark.marginTop);
      const foot = top + parseFloat(mark.height);
      const after = getComputedStyle(li, "::after");
      const line = li.getBoundingClientRect().top + parseFloat(after.top);
      const end = li.getBoundingClientRect().bottom - parseFloat(after.bottom);
      const next = /** @type {HTMLElement} */ (/** @type {Element} */ (li.nextElementSibling).firstElementChild);
      const head = next.getBoundingClientRect().top + parseFloat(getComputedStyle(next).paddingTop) + parseFloat(getComputedStyle(next, "::before").marginTop);
      return {
        lines: new Set([...lines].map((r) => Math.round(r.top))).size,
        beside: Math.abs((first.top + first.bottom) / 2 - (top + foot) / 2) <= 2,
        under: Math.abs(line - foot) <= 0.5,
        reaches: Math.abs(end - head) <= 0.5,
      };
    };
    const plain = measure();
    list.style.setProperty("--control-font-size", "1.5rem");
    const large = measure();
    list.style.removeProperty("--control-font-size");
    return { plain, large };
  });
  const fitsPayout = await payout.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  // A history is a list named by its label, not a navigation landmark: it goes nowhere.
  const payoutLandmarks = await payout.getByRole("navigation", { name: "Payout" }).count();
  // Under forced colors the line down keeps the text's color and a failed step its cross.
  const forcedTimeline = engine === "webkit" ? null : await (async () => {
    await payout.emulateMedia({ forcedColors: "active" });
    const out = await payout.getByRole("list", { name: "Payout" }).evaluate((list) => {
      const items = [...list.querySelectorAll("li")];
      const last = /** @type {Element} */ (items[items.length - 1].firstElementChild);
      return { line: getComputedStyle(items[0], "::after").backgroundColor, text: getComputedStyle(items[0]).color, cross: getComputedStyle(last, "::before").content };
    });
    await payout.emulateMedia({ forcedColors: "none" });
    return out;
  })();
  await payout.close();
  const [payStep1, payStep2, payStep3] = timeline;
  check(
    "Steps as a timeline: one step per row down the page on a phone, each description shown, a line down from each mark",
    timeline.length === 3 &&
      timeline.every((s) => s.left === payStep1.left && s.note) &&
      payStep2.top >= payStep1.bottom - 1 && payStep3.top >= payStep2.bottom - 1 &&
      [payStep1, payStep2].every((s) => s.line && s.line.width === "1px" && s.line.height > 10) &&
      fitsPayout,
    JSON.stringify({ timeline, fitsPayout }),
  );
  check(
    "Steps as a timeline: a name that wraps keeps its mark by its first line, the line running from its foot to the next mark, with a larger control font too",
    [wrapped.plain, wrapped.large].every((w) => w.lines > 1 && w.beside && w.under && w.reaches),
    JSON.stringify(wrapped),
  );
  check("Steps as a timeline: a list named by its label, not a navigation landmark", payoutLandmarks === 0, String(payoutLandmarks));
  const forcedTimelineName = "Steps as a timeline: under forced colors the line keeps the text's color and a failed step its cross";
  if (forcedTimeline) check(forcedTimelineName, forcedTimeline.line === forcedTimeline.text && forcedTimeline.cross.includes("\u2715"), JSON.stringify(forcedTimeline));
  else skip(forcedTimelineName, "Playwright's WebKit does not emulate forced colors");
  check(
    "Steps: a failed step is drawn with a cross in its own color, told from blocked and done, its words read and not shown",
    payStep3.crossed && !payStep1.crossed && payStep3.fill !== payStep1.fill && payStep3.fill !== blocked.fill && payStep3.hidden === true && failedName === "Paid(failed)",
    JSON.stringify({ payStep3, blocked: blocked.fill, failedName }),
  );
  // Under forced colors, which drop fills and shadows: the lines between steps keep the text's
  // color, the current step's mark is the system's highlight, and the current link is underlined.
  const forcedMarks = "Steps and NavBar: under forced colors the lines, the current and blocked steps and the current link are drawn";
  // On a touch screen the links' scrollbar is hidden, the shadows the cue; under forced colors,
  // which drop them, it comes back. (Playwright's Firefox hides every scrollbar, and its WebKit does
  // not emulate forced colors.)
  const touchScrollbar = "NavBar: on a touch screen the scrollbar is hidden, and shown under forced colors";
  if (engine !== "webkit") {
    await draft.setViewportSize({ width: 1280, height: 800 });
    await draft.emulateMedia({ forcedColors: "active" });
    const forced = await draft.evaluate(() => {
      const [done, now, blocked] = [...document.querySelectorAll("nav[class*='steps__steps'] li")];
      const mark = now?.firstElementChild ? getComputedStyle(now.firstElementChild, "::before") : null;
      const blockedMark = blocked?.firstElementChild ? getComputedStyle(blocked.firstElementChild, "::before").content : "missing";
      const current = document.querySelector("nav[class*='nav-bar__sections'] > a[aria-current='page']");
      const highlight = document.createElement("i");
      highlight.style.cssText = "color: Highlight";
      document.body.append(highlight);
      const want = getComputedStyle(highlight).color;
      highlight.remove();
      return {
        lines: [done, now].map((li) => (li ? getComputedStyle(li, "::after").backgroundColor : "missing")),
        text: done ? getComputedStyle(done).color : "missing",
        mark: mark?.backgroundColor,
        highlight: want,
        underline: current ? getComputedStyle(current).textDecorationLine : "missing",
        blockedMark,
      };
    });
    await draft.emulateMedia({ forcedColors: "none" });
    check(
      forcedMarks,
      forced.lines.every((l) => l === forced.text) && forced.mark === forced.highlight && forced.underline === "underline" && forced.blockedMark.startsWith('"!"'),
      JSON.stringify(forced),
    );
  } else {
    skip(forcedMarks, "Playwright's WebKit does not emulate forced colors");
  }
  if (engine === "chromium") {
    const touch = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
    await touch.goto(`${base}/`);
    const width = () => touch.evaluate(() => getComputedStyle(/** @type {Element} */ (document.querySelector("nav[class*='nav-bar__sections']"))).scrollbarWidth);
    const plain = await width();
    await touch.emulateMedia({ forcedColors: "active" });
    const forced = await width();
    await touch.context().close();
    check(touchScrollbar, plain === "none" && forced === "thin", JSON.stringify({ plain, forced }));
  } else {
    skip(touchScrollbar, engine === "firefox" ? "Playwright's Firefox hides every scrollbar" : "Playwright's WebKit does not emulate forced colors");
  }
  await draft.close();
  // Stats: a term and its descriptions, as many to a row as fit and two on a phone.
  const stats = await orders.evaluate(() => {
    const dl = document.querySelector("dl[class*='stats__stats']");
    const items = [...(dl?.children ?? [])];
    return {
      terms: items.map((i) => i.querySelector("dt")?.textContent).join(),
      rows: new Set(items.map((i) => Math.round(i.getBoundingClientRect().top))).size,
    };
  });
  check("Stats: labelled figures on one row", stats.terms === "Sales,Orders,To ship,Late" && stats.rows === 1, JSON.stringify(stats));
  // Two to a row on a small phone and a large one, the figure in the phone's size (1.25rem).
  for (const width of [390, 430]) {
    await orders.setViewportSize({ width, height: 844 });
    const phone = await orders.evaluate(() => {
      // The page's first list, the figures as cards; the one inside a card follows.
      const items = [...(document.querySelector("dl[class*='stats__stats']")?.children ?? [])];
      const value = items[0]?.querySelector("[class*='stats__value']");
      return {
        tops: items.map((i) => Math.round(i.getBoundingClientRect().top)),
        size: value ? parseFloat(getComputedStyle(value).fontSize) / parseFloat(getComputedStyle(document.documentElement).fontSize) : 0,
      };
    });
    const [a, b, c, d] = phone.tops;
    check(`Stats: two to a row on a phone, in the phone's size (${width}px)`, new Set(phone.tops).size === 2 && a === b && c === d && phone.size === 1.25, JSON.stringify(phone));
  }
  await orders.setViewportSize({ width: 390, height: 844 });
  // A long figure is never broken: on one line, inside its card, and the card inside the page.
  const long = await orders.evaluate(() => {
    const value = /** @type {HTMLElement} */ (document.querySelector("dl[class*='stats__stats'] [class*='stats__value']"));
    const was = value.textContent;
    value.textContent = "$1,234,567.89";
    const card = /** @type {HTMLElement} */ (value.parentElement);
    const line = parseFloat(getComputedStyle(value).lineHeight);
    const drawn = {
      lines: Math.round(value.getBoundingClientRect().height / line),
      inside: value.scrollWidth <= value.clientWidth + 1 && card.getBoundingClientRect().right <= document.documentElement.clientWidth,
    };
    value.textContent = was;
    return drawn;
  });
  check("Stats: a long figure stays on one line, inside its card, on a phone", long.lines === 1 && long.inside, JSON.stringify(long));
  await orders.setViewportSize({ width: 1280, height: 800 });
  // Once the layout has settled at the new width (an engine may read the old positions just after).
  await orders
    .waitForFunction(() => {
      const term = document.querySelector("dl[class*='stats__plain'] dt");
      const content = term?.closest("dl")?.parentElement;
      if (!term || !content) return true;
      return Math.abs(term.getBoundingClientRect().left - (content.getBoundingClientRect().left + parseFloat(getComputedStyle(content).paddingLeft))) < 1;
    }, null, { timeout: 3000 })
    .catch(() => {});
  // StatsSurface::Plain: a summary inside a card is drawn on the card, its figures' text at the card's
  // content edge, with no surface of their own.
  const plainStats = await orders.evaluate(() => {
    const dl = document.querySelector("dl[class*='stats__plain']");
    const figure = /** @type {HTMLElement | null} */ (dl?.querySelector("[class*='stats__stat']") ?? null);
    const content = /** @type {HTMLElement | null} */ (dl?.parentElement ?? null);
    if (!figure || !content) return null;
    const style = getComputedStyle(figure);
    const term = /** @type {HTMLElement} */ (figure.querySelector("dt"));
    const inset = parseFloat(getComputedStyle(content).paddingLeft);
    return {
      terms: [...dl.querySelectorAll("dt")].map((t) => t.textContent).join(),
      surface: style.backgroundColor === "rgba(0, 0, 0, 0)" && style.borderTopWidth === "0px" && style.boxShadow === "none",
      edge: Math.abs(term.getBoundingClientRect().left - (content.getBoundingClientRect().left + inset)) < 1,
    };
  });
  check("Stats with no surface: figures inside a card have no surface and line up with its text", plainStats?.terms === "Open,Refunded" && plainStats.surface && plainStats.edge, JSON.stringify(plainStats));
  // StatusDot: drawn beside the words, not read; Stack and Cluster: the gap is the space.
  const spacing = await orders.evaluate(() => {
    const dot = document.querySelector("[class*='status-dot__dot']");
    const stack = document.querySelector("form[class*='stack__stack']");
    return {
      dot: dot?.getAttribute("aria-hidden") === "true" && (dot.parentElement?.textContent ?? "").includes("Taking orders"),
      // Gap::Lg, 1.5rem.
      gap: stack ? parseFloat(getComputedStyle(stack).rowGap) / parseFloat(getComputedStyle(document.documentElement).fontSize) : "missing",
      // A paragraph's default margins (1em) are dropped: the form has one among its fields.
      paragraph: stack?.querySelector(":scope > p") ? 1 : 0,
      margins: stack ? [...stack.children].filter((c) => parseFloat(getComputedStyle(c).marginBlockStart) + parseFloat(getComputedStyle(c).marginBlockEnd) !== 0).length : -1,
    };
  });
  check("StatusDot and Stack: the dot is not read, and a stack's gap is its only space", spacing.dot && spacing.gap === 1.5 && spacing.paragraph === 1 && spacing.margins === 0, JSON.stringify(spacing));
  await orders.getByRole("button", { name: "Share the shop" }).click();
  check("Popover: its button opens it", await orders.locator("#share").evaluate((p) => p.matches(":popover-open")));
  await orders.keyboard.press("Escape");
  check("Popover: Escape closes it", !(await orders.locator("#share").evaluate((p) => p.matches(":popover-open"))));
  await orders.getByText("What if an order ships late?").click();
  const open = await orders.locator("details").evaluateAll((all) => all.map((d) => /** @type {HTMLDetailsElement} */ (d).open).join());
  check("Accordion: one section open at a time", open === "false,true,false", open);
  await orders.getByRole("link", { name: "Next" }).click();
  await orders.locator("caption", { hasText: "Page 2 of 3" }).waitFor({ timeout: 5000 }).catch(() => {});
  check("Pagination: Next goes to the next page", new URL(orders.url()).search === "?page=2" && (await orders.locator('[aria-current="page"]').last().textContent()) === "2", orders.url());
  // SegmentedRadios: native radios in a fieldset, the checked one's label raised from :has(:checked),
  // the arrow keys moving the choice and the focus ring with it, a disabled fieldset drawn disabled,
  // and under forced colors the checked one outlined. The form sends the choice (below).
  {
    const sizes = orders.getByRole("group", { name: "Label size" });
    const raised = () =>
      sizes.locator("label").evaluateAll((all) =>
        all.map((l) => `${l.textContent}:${getComputedStyle(l).backgroundColor !== "rgba(0, 0, 0, 0)"}`).join(),
      );
    const before = await raised();
    await sizes.getByRole("radio", { name: "4 x 6 in" }).focus();
    await orders.keyboard.press("ArrowRight");
    const after = await raised();
    // The ring follows the browser's :focus-visible, which WebKit gives a radio the arrow keys reach
    // only once focus comes back by Tab: leave the group and come back to the checked one.
    await orders.keyboard.press("Tab");
    await orders.keyboard.press("Shift+Tab");
    const ring = await sizes.locator("label", { hasText: "Letter" }).evaluate((l) => `${getComputedStyle(l).outlineStyle} ${getComputedStyle(l).outlineWidth}`);
    check(
      "SegmentedRadios: the checked radio's label is raised, an arrow key moves the choice, and the focused one is ringed",
      before === "4 x 6 in:true,Letter:false" && after === "4 x 6 in:false,Letter:true" && (await sizes.getByRole("radio", { name: "Letter" }).isChecked()) && ring === "solid 2px",
      JSON.stringify({ before, after, ring }),
    );
    const disabled = await sizes.evaluate((f) => {
      const set = /** @type {HTMLFieldSetElement} */ (f);
      set.disabled = true;
      const drawn = [...set.querySelectorAll("label")].map((l) => getComputedStyle(l).opacity).join();
      set.disabled = false;
      return drawn;
    });
    check("SegmentedRadios: a disabled fieldset draws its choices disabled", disabled === "0.5,0.5", disabled);
    // Each input is hidden under its label and fills it, so a click anywhere on the label lands on
    // the input; one disabled input draws only its own choice disabled.
    const cover = await sizes.locator("label").evaluateAll((all) =>
      all.map((l) => {
        const input = /** @type {HTMLInputElement} */ (l.querySelector("input"));
        const [a, b] = [l.getBoundingClientRect(), input.getBoundingClientRect()];
        const edge = document.elementFromPoint(a.left + 2, a.top + a.height / 2);
        return getComputedStyle(input).opacity === "0" && a.width === b.width && a.height === b.height && edge === input;
      }),
    );
    const one = await sizes.evaluate((f) => {
      const input = /** @type {HTMLInputElement} */ (f.querySelector("input[value='letter']"));
      input.disabled = true;
      const drawn = [...f.querySelectorAll("label")].map((l) => getComputedStyle(l).opacity).join();
      input.disabled = false;
      return drawn;
    });
    check("SegmentedRadios: each input is hidden under its label and fills it; one disabled input dims only its choice", cover.every(Boolean) && one === "1,0.5", JSON.stringify({ cover, one }));
    // A hidden legend (Legend::Hidden) still names the group and takes no room over the track.
    const hiddenClass = await sizes.evaluate((f) => [...f.classList].find((c) => c.endsWith("__radios"))?.replace("__radios", "__hidden") ?? "");
    const legendShown = await sizes.evaluate((f) => /** @type {HTMLElement} */ (f.querySelector("div")).getBoundingClientRect().top - f.getBoundingClientRect().top);
    await sizes.evaluate((f, c) => f.querySelector("legend")?.classList.add(c), hiddenClass);
    const legendHidden = await sizes.evaluate((f) => /** @type {HTMLElement} */ (f.querySelector("div")).getBoundingClientRect().top - f.getBoundingClientRect().top);
    const stillNamed = await orders.getByRole("group", { name: "Label size" }).count();
    await sizes.evaluate((f, c) => f.querySelector("legend")?.classList.remove(c), hiddenClass);
    check("SegmentedRadios: a hidden legend still names the group and takes no room", legendShown > 10 && legendHidden < 1 && stillNamed === 1, JSON.stringify({ legendShown, legendHidden, stillNamed }));
    const forcedRadios = "SegmentedRadios: under forced colors the checked choice is outlined";
    if (engine !== "webkit") {
      await orders.locator("h1").click();
      await orders.emulateMedia({ forcedColors: "active" });
      const outlines = await sizes.locator("label").evaluateAll((all) => all.map((l) => getComputedStyle(l).outlineStyle).join());
      await orders.emulateMedia({ forcedColors: "none" });
      check(forcedRadios, outlines === "none,solid", outlines);
    } else skip(forcedRadios, "Playwright's WebKit does not emulate forced colors");
  }
  // A switch is drawn as one only with its role: what is drawn is what a screen reader says.
  const drawnSwitch = await orders.evaluate(() => {
    const sw = /** @type {HTMLInputElement} */ (document.querySelector('input[role="switch"]'));
    const look = () => ({ appearance: getComputedStyle(sw).appearance, width: Math.round(parseFloat(getComputedStyle(sw).width)) });
    const role = look();
    sw.removeAttribute("role");
    const plain = look();
    sw.setAttribute("role", "switch");
    return { role, plain };
  });
  // A switch is a pill wider than a checkbox's box.
  check(
    "Switch: drawn as a switch only with role=switch",
    drawnSwitch.role.appearance === "none" && drawnSwitch.role.width > 20 && drawnSwitch.plain.appearance === "auto" && drawnSwitch.plain.width < 20,
    JSON.stringify(drawnSwitch),
  );
  await orders.getByLabel("Ship from").selectOption("toronto");
  await orders.getByRole("switch", { name: "Email me when an order ships" }).uncheck();
  await orders.getByRole("button", { name: "Save settings" }).click();
  if (engine !== "webkit") {
    await orders.locator("#ui-toast:not([hidden])").waitFor({ timeout: 5000 }).catch(() => {});
    const saved = await orders.locator("#ui-toast").textContent();
    check("Select, SegmentedRadios, Slider, Switch and Textarea post with the form", saved === "Saved: ships from Toronto, ON in 2 days on Letter labels with your note; shipping emails off.", saved ?? "");
  } else skip("Select, SegmentedRadios, Slider, Switch and Textarea post with the form", "Playwright's WebKit never sends a Secure cookie back over http");
  check("the orders page: no console errors", ordersErrors.length === 0, ordersErrors.join(" | "));
  await orders.context().close();

  // Without JavaScript
  const plain = await (await browser.newContext({ javaScriptEnabled: false })).newPage();
  await plain.goto(`${base}/`);
  check("no script: the server's relative time is the text", (await plain.locator("time").first().textContent()) === "3 hr. ago");
  const plainDrafted = plain.locator("p", { hasText: "Drafted" }).locator("time");
  check("no script: a first page's date is in UTC", (await plainDrafted.textContent()) === "Mar 22, 2026, 3:04 PM UTC", await plainDrafted.textContent());
  check("no script: the select is the control", (await plain.locator("[data-scope=ui-combo-box] select").isVisible()) && (await plain.locator("[data-scope=ui-combo-box] input").isHidden()));
  // In a column narrower than the select, the ComboBox's select stays inside its field, as its
  // input does once the script runs.
  const plainNarrow = await plain.locator("[data-scope=ui-combo-box]").evaluate((scope) => {
    const copy = /** @type {Element} */ (/** @type {Element} */ (scope.closest("[class*=field__field]")).cloneNode(true));
    for (const el of copy.querySelectorAll("[id]")) el.removeAttribute("id");
    const grid = document.createElement("div");
    grid.style.cssText = "display: grid; grid-template-columns: 8rem";
    grid.append(copy);
    document.body.append(grid);
    const past = Math.round(/** @type {Element} */ (copy.querySelector("select")).getBoundingClientRect().right - copy.getBoundingClientRect().right);
    grid.remove();
    return past;
  });
  check("no script: in a column narrower than its select, a ComboBox stays inside its field", plainNarrow <= 0, String(plainNarrow));
  await plain.locator("[data-scope=ui-combo-box] select").selectOption("lp");
  // The post loads a new page; waitForLoadState alone can return for the page it left.
  await Promise.all([plain.waitForURL("**/sell"), plain.getByRole("button", { name: "List for sale" }).click()]);
  check("no script: the form posts the page", (await plain.textContent("#result")) === "Listed 1 Lightly Played Ashen Drake at $12.50 each, 0.5 oz to ship.", await plain.textContent("#result"));
  const plainFloor = plain.getByLabel("Lowest offer");
  check("no script: the lowest offer is enabled and optional (the handler checks it)", (await plainFloor.isEnabled()) && !(await plainFloor.evaluate((i) => /** @type {HTMLInputElement} */ (i).required)));
  await plain.getByRole("tab", { name: "Offers" }).click();
  await plain.waitForURL("**/?tab=offers");
  check("no script: a tab is a link to its page", (await plain.getByRole("tabpanel").textContent()) === "Two offers, the best at $10.00.");
  await plain.getByRole("button", { name: "More actions" }).click();
  check("no script: the menu opens (popover)", await plain.getByRole("menuitem", { name: "Help" }).isVisible());
  await plain.goto(`${base}/`);
  await Promise.all([plain.waitForURL("**/save"), plain.getByRole("button", { name: "Save draft" }).click()]);
  check("no script: the page the post answers with shows the toast", (await plain.locator("#ui-toast").textContent()) === "Draft saved." && (await plain.locator("#ui-toast").isVisible()));
  await plain.getByRole("button", { name: "Rename draft" }).click();
  check("no script: the button opens the dialog", await plain.locator("#rename").isVisible());
  await Promise.all([plain.waitForURL("**/rename"), plain.getByRole("button", { name: "Rename", exact: true }).click()]);
  check("no script: refused, the dialog is open with the error", (await plain.locator("#rename").isVisible()) && ((await plain.locator("#rename").textContent()) ?? "").includes("Give the draft a name."));
  if (engine !== "webkit") {
    await plain.locator("#rename-name").fill("Winter draft");
    await Promise.all([plain.waitForURL(`${base}/`), plain.getByRole("button", { name: "Rename", exact: true }).click()]);
    check("no script: the page a redirect lands on shows its notice in the layout", (await plain.locator("#ui-toast").textContent()) === "Renamed to Winter draft.", await plain.locator("#ui-toast").textContent());
    await plain.reload();
    check("no script: a reload does not say it again", (await plain.locator("#ui-toast").textContent()) === "");
  } else for (const name of ["no script: the page a redirect lands on shows its notice in the layout", "no script: a reload does not say it again"]) skip(name, "Playwright's WebKit never sends a Secure cookie back over http");
  await plain.goto(`${base}/?sale=last`);
  const plainSheet = plain.locator('dialog[aria-label="Last sale"]');
  check("no script: the address opens the sheet", await plainSheet.isVisible());
  // The sheet slides in; without the page's script Chromium does not tell Playwright the link has
  // stopped moving, so the click waits for the slide itself to end. Asked again until it has (a
  // promise does not settle in Firefox's page without script), for at most the 200 ms slide many
  // times over.
  const sliding = () => plainSheet.evaluate((sheet) => sheet.getAnimations().some((a) => a.playState === "running"));
  for (let tries = 0; tries < 40 && (await sliding()); tries++) await plain.waitForTimeout(50);
  await Promise.all([plain.waitForURL((url) => !url.searchParams.has("sale")), plain.getByRole("link", { name: "Close" }).click()]);
  check("no script: its link closes it", (await plainSheet.count()) === 0);
  await plain.goto(`${base}/`);
  check("no script: the SKU is on the page and the copy button is not", (await plain.locator("code", { hasText: "ASH-DRAKE-NM" }).isVisible()) && (await plain.locator("[data-scope=ui-copy-button]").isHidden()));
  const plainPrint = plain.locator("button", { hasText: "Print label" });
  check("no script: the print button is on the page, hidden", (await plainPrint.count()) === 1 && (await plainPrint.isHidden()));
  await plain.goto(`${base}/orders`);
  await plain.getByRole("button", { name: "Share the shop" }).click();
  check("no script: the popover opens", await plain.locator("#share").isVisible());
  await plain.keyboard.press("Escape");
  await Promise.all([plain.waitForURL("**/orders?page=3"), plain.getByRole("link", { name: "3", exact: true }).click()]);
  check("no script: a page number is a link to that page", (await plain.locator("caption").textContent()) === "Page 3 of 3");
}
