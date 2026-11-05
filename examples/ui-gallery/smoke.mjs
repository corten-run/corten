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

/**
 * An Icon beside a control's text: the space between them and how far the icon's middle is from
 * the text's, in px, with the root's half rem (the kit's .5rem gap). Self-contained, as
 * `evaluate` sends it to the page.
 * @param {Element} el
 */
const besideText = (el) => {
  const svg = /** @type {Element} */ (el.querySelector("svg"));
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  /** @type {Node | null} */
  let text = null;
  while ((text = walk.nextNode()) && !(text.textContent?.trim() && svg.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING));
  const range = document.createRange();
  range.selectNodeContents(/** @type {Node} */ (text));
  const [i, t] = [svg.getBoundingClientRect(), range.getBoundingClientRect()];
  return { gap: t.left - i.right, rem: parseFloat(getComputedStyle(document.documentElement).fontSize) / 2, off: i.top + i.height / 2 - (t.top + t.height / 2) };
};
/** @param {{ gap: number, rem: number, off: number }} b */
const spacedLikeButton = (b) => Math.abs(b.gap - b.rem) <= 0.5 && Math.abs(b.off) <= 1;

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
  check("the seventeen scripts load and connect", loaded === 17, `${loaded} script(s)`);
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
  // Held until it has repeated, however long a loaded machine takes to run the timers (#666): a
  // fixed wait counted the repeats the machine had time for.
  const repeated = await page.waitForFunction(() => Number(/** @type {HTMLInputElement} */ (document.getElementById("qty")).value) >= 4, null, { timeout: 10_000 }).then(() => true, () => false);
  await page.mouse.up();
  const held = Number(await qty.inputValue());
  check("press and hold repeats", repeated && held >= 4, String(held));
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
  // A press released off its button makes no click, so nothing is left to skip the next key's. The
  // press and its release are sent in one task: from real input, a release more than 400 ms after
  // the press (a loaded machine) is a hold, which repeats, as it should (#666).
  await page.locator("[data-scope=ui-number-field]").nth(1).locator("button").nth(1).evaluate((button) => {
    const at = { bubbles: true, cancelable: true, composed: true, button: 0, pointerId: 9, isPrimary: true };
    button.dispatchEvent(new PointerEvent("pointerdown", at));
    document.body.dispatchEvent(new PointerEvent("pointerup", at));
  });
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
  // InputGroup: the lowest offer's "$" is hidden from a screen reader, and inside the group's
  // border before the input (measured once the field is shown); the group draws the border, ring,
  // invalid and disabled states, the input inside none of them, so a disabled one is dimmed once.
  const floorGroup = () =>
    floor.evaluate((input) => {
      const box = /** @type {HTMLElement} */ (input.parentElement);
      const sign = /** @type {HTMLElement} */ (box.firstElementChild);
      // The border and ring are transitioned: read where they end.
      for (const a of box.getAnimations()) a.finish();
      const [b, s, i] = [box, sign, input].map((e) => e.getBoundingClientRect());
      const probe = document.createElement("span");
      probe.style.color = "var(--destructive)";
      box.append(probe);
      const destructive = getComputedStyle(probe).color;
      probe.remove();
      const [style, own] = [getComputedStyle(box), getComputedStyle(input)];
      return {
        inside: s.left >= b.left + 1 && s.right <= i.left + 0.5 && i.right <= b.right - 0.5 && s.top >= b.top && s.bottom <= b.bottom,
        hidden: sign.getAttribute("aria-hidden"),
        borders: `${style.borderTopWidth} ${own.borderTopWidth}`,
        opacity: `${style.opacity} ${own.opacity}`,
        ring: style.boxShadow.includes("3px"),
        ownRing: own.boxShadow,
        invalid: style.borderTopColor === destructive,
      };
    });
  const floorOff = await floorGroup();
  check(
    "InputGroup: its sign is hidden from a screen reader; disabled, the group is dimmed once and draws the border",
    floorOff.hidden === "true" && floorOff.borders === "1px 0px" && floorOff.opacity === "0.5 1" && !floorOff.invalid,
    JSON.stringify(floorOff),
  );
  await page.getByLabel("Accept offers").check();
  check("accepting offers makes the lowest offer required", (await floor.isEnabled()) && (await floorRequired()));
  await floor.focus();
  const floorFocused = await floorGroup();
  check(
    "InputGroup: its sign is inside the border before the input; the input's focus rings the group, and the input draws no ring of its own",
    floorFocused.inside && floorFocused.ring && floorFocused.ownRing === "none" && floorFocused.opacity === "1 1",
    JSON.stringify(floorFocused),
  );
  // A button inside sits within the border: a Sm one, and an Icon one, which alone is the
  // control's height.
  const floorButton = await floor.evaluate((input) => {
    const box = /** @type {HTMLElement} */ (input.parentElement);
    const small = document.querySelector("[class*='button__sm']");
    const at = (/** @type {DOMRect} */ r) => [r.left, r.top, r.right, r.bottom].map((v) => Math.round(v * 10) / 10).join();
    /** @param {string} className */
    const placed = (className) => {
      const find = document.createElement("button");
      find.type = "button";
      find.className = className;
      find.textContent = "Find";
      box.append(find);
      const [b, f, i] = [box, find, input].map((e) => e.getBoundingClientRect());
      find.remove();
      // Within the border: inside the group's padding box, after the input.
      const edge = box.clientTop;
      const inside = f.top >= b.top + edge - 0.5 && f.bottom <= b.bottom - edge + 0.5 && f.right <= b.right - edge + 0.5 && f.left >= i.right - 0.5;
      return inside ? "inside" : `${at(b)} ${at(f)}`;
    };
    const sm = small?.className ?? "";
    return { small: !!small, sm: placed(sm), icon: placed(sm.replace(/(button__)sm\b/, "$1icon")) };
  });
  check("InputGroup: a small or icon button after the input sits within the border", floorButton.small && floorButton.sm === "inside" && floorButton.icon === "inside", JSON.stringify(floorButton));
  // An Icon beside a button's text: the button's gap (.5rem) before the text, its middle on the
  // text's middle.
  const buttonIcon = await page.getByRole("button", { name: "All sales" }).evaluate((b) => {
    const svg = /** @type {Element} */ (b.querySelector("svg"));
    const text = document.createRange();
    text.selectNodeContents(/** @type {Node} */ ([...b.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())));
    const [i, t] = [svg.getBoundingClientRect(), text.getBoundingClientRect()];
    return { gap: t.left - i.right, rem: parseFloat(getComputedStyle(document.documentElement).fontSize) / 2, off: i.top + i.height / 2 - (t.top + t.height / 2) };
  });
  check("Icon: beside a button's text, the button's gap apart and on the text's middle", spacedLikeButton(buttonIcon), JSON.stringify(buttonIcon));
  // Under forced colors the box shadow is not drawn: the group's outline is the focus ring.
  const forcedRingName = "InputGroup: under forced colors its input's focus draws the group's outline";
  if (engine === "webkit") skip(forcedRingName, "Playwright's WebKit does not emulate forced colors");
  else {
    await page.emulateMedia({ forcedColors: "active" });
    const forcedRing = await floor.evaluate((input) => {
      const style = getComputedStyle(/** @type {HTMLElement} */ (input.parentElement));
      return `${document.activeElement === input} ${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`;
    });
    await page.emulateMedia({ forcedColors: "none" });
    check(forcedRingName, forcedRing.startsWith("true solid 2px ") && !forcedRing.endsWith("rgba(0, 0, 0, 0)"), forcedRing);
  }
  await page.getByRole("button", { name: "List for sale" }).click();
  await page.waitForTimeout(300);
  check("an empty lowest offer stops the form", (await floor.evaluate((i) => /** @type {HTMLInputElement} */ (i).validationMessage)) !== "" && (await page.textContent("#result")) === lastResult);
  const floorRefused = await floorGroup();
  check("InputGroup: a refused input draws the group's border in the destructive color", floorRefused.invalid, JSON.stringify(floorRefused));
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
  // An Icon beside a tab's text, as beside a button's (#793).
  const tabIcon = await tab("Listings").evaluate(besideText);
  check("Tabs: an icon beside a tab's text is the kit's gap apart and on its middle", spacedLikeButton(tabIcon), JSON.stringify(tabIcon));

  // ChoiceGroup and ShownFor: one choice, parts in two cards.
  const period = (name) => page.getByRole("radio", { name });
  // The parts' sentences (the month's table of sales, a part too, is checked at a phone's width).
  const showing = () =>
    page.$$eval('[data-on^="connect:ui.choice.part"]', (parts) => parts.filter((p) => !(/** @type {HTMLElement} */ (p).hidden) && !p.querySelector("table")).map((p) => p.textContent).join("|"));
  check("the server draws the default choice and only its parts", (await period("Month").getAttribute("aria-checked")) === "true" && (await showing()) === "Average $11.95 this month.|Sold 14 this month.", await showing());
  check("only the chosen option is in the tab order", (await page.$$eval('[role="radio"]', (r) => r.map((x) => /** @type {HTMLElement} */ (x).tabIndex).join())) === "-1,0");

  // corten_ui::rows::sort: the month's sales sort in place by the header clicked, each cell by its
  // data-sort (a price in cents) or its text, the other way on a second click, with no request.
  const sales = page.locator("table", { has: page.locator("caption", { hasText: "This month's last sales" }) });
  const sortedBy = async () => ({
    buyers: (await sales.locator("tbody td:nth-child(2)").allTextContents()).join("|"),
    sort: await sales.locator("thead th").evaluateAll((ths) => ths.map((th) => th.getAttribute("aria-sort") ?? "").join()),
  });
  let sortRequests = 0;
  /** @param {import("@playwright/test").Request} r */
  const countSort = (r) => void (new URL(r.url()).searchParams.has("sold") && sortRequests++);
  page.on("request", countSort);
  const unsorted = page.url();
  const sortOrders = [];
  for (const name of ["Price", "Price", "Buyer", "Sold"]) {
    await sales.getByRole("link", { name }).click();
    sortOrders.push(await sortedBy());
  }
  page.off("request", countSort);
  const sortWant = [
    { buyers: "Alan Turing|Grace Hopper|Ada Lovelace", sort: ",,,,ascending" },
    { buyers: "Ada Lovelace|Grace Hopper|Alan Turing", sort: ",,,,descending" },
    { buyers: "Ada Lovelace|Alan Turing|Grace Hopper", sort: ",ascending,,," },
    { buyers: "Grace Hopper|Alan Turing|Ada Lovelace", sort: "ascending,,,," },
  ];
  check(
    "a sort header sorts the rows in place (data-sort, then text), the other way on a second click, and moves aria-sort, with no request",
    JSON.stringify(sortOrders) === JSON.stringify(sortWant) && sortRequests === 0,
    `${JSON.stringify(sortOrders)} ${sortRequests} request(s)`,
  );
  // The address is the page sorted as shown (in place of its history entry), and each header's link
  // the page its next click gives, so a reload shows the order on screen.
  const sortLinks = await sales.locator("thead th a").evaluateAll((links) => links.map((a) => new URL(/** @type {HTMLAnchorElement} */ (a).href).searchParams.get("sold")).join());
  check(
    "a sort in place puts its order in the address and each header's next order in its link",
    new URL(page.url()).searchParams.get("sold") === "day" && new URL(unsorted).pathname === new URL(page.url()).pathname && sortLinks === "day_down,buyer,price",
    `${page.url()} ${sortLinks}`,
  );
  // A part of the page that reads itself again from its own route (ReadAgain::from, here put
  // around the table on its way from the server) reads the order a sort in place gave: its read's
  // address takes the sort's key and keeps its own. A part that does not hold the table is left.
  {
    const partPage = await page.context().newPage();
    await partPage.route(
      (url) => url.href === unsorted,
      async (route) => {
        const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
        const headers = res.headers();
        delete headers["content-encoding"];
        delete headers["content-length"];
        let body = await res.text();
        const at = body.search(/<table>\s*<caption>This month/);
        const end = body.indexOf("</table>", at) + "</table>".length;
        body = `${body.slice(0, at)}<template data-corten-read-again="3" data-from="/sales-part?after=r1"></template><div id="sales-part">${body.slice(at, end)}</div>${body.slice(end)}`;
        body = body.replace(/(<main\b[^>]*>)/, '$1<div><template data-corten-read-again="3" data-from="/other-part?after=r2"></template><div id="other-part"></div></div>');
        await route.fulfill({ status: res.status(), headers, body });
      },
    );
    /** @type {string[]} */
    const partReads = [];
    await partPage.route(
      (url) => url.pathname === "/sales-part" || url.pathname === "/other-part",
      async (route) => {
        const url = new URL(route.request().url());
        partReads.push(`${url.pathname}?${url.searchParams}`);
        // The sales part's first answer asks again, as a route that writes the order it read into
        // its next ReadAgain::from does. Its second, slow, asks again in the order it read, which a
        // sort while it is on its way has changed; the next answers ask nothing.
        const sales = url.pathname === "/sales-part";
        const after = url.searchParams.get("after");
        let body = "";
        if (sales && after === "r1") body = '<template data-corten-read-again="2" data-from="/sales-part?sold=price&amp;after=r2"></template>';
        else if (sales && after === "r2" && url.searchParams.get("sold") === "buyer") {
          await new Promise((done) => setTimeout(done, 1500));
          body = '<template data-corten-read-again="2" data-from="/sales-part?sold=buyer&amp;after=r3"></template>';
        }
        await route.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "corten-patch": "1" }, body }).catch(() => {});
      },
    );
    await partPage.goto(unsorted);
    const partSales = partPage.locator("table", { has: partPage.locator("caption", { hasText: "This month's last sales" }) });
    await partSales.getByRole("link", { name: "Price" }).click();
    for (let i = 0; i < 60 && partReads.length < 2; i++) await partPage.waitForTimeout(100);
    const first = [...partReads].sort().join(" ");
    // A sort after the part's first read is kept in the read the part's answer asked for, whose tag
    // took the old one's place.
    await partPage.waitForFunction(() => document.querySelector('main template[data-from^="/sales-part"]')?.getAttribute("data-from")?.includes("after=r2"), null, { timeout: 3000 });
    const tags = await partPage.evaluate(() => Array.from(document.querySelectorAll('main template[data-from^="/sales-part"]'), (t) => t.getAttribute("data-from")));
    await partSales.getByRole("link", { name: "Buyer" }).click();
    for (let i = 0; i < 60 && partReads.length < 3; i++) await partPage.waitForTimeout(100);
    // A sort while that read is on its way: its answer, drawn in the old order, is dropped and the
    // part read again in the new one.
    await partSales.getByRole("link", { name: "Sold" }).click();
    const day = new URL(partPage.url()).searchParams.get("sold");
    for (let i = 0; i < 60 && partReads.length < 4; i++) await partPage.waitForTimeout(100);
    check(
      "a part read again from its own route reads the order a sort in place gave",
      first === "/other-part?after=r2 /sales-part?sold=price&after=r1",
      first,
    );
    check(
      "a part's next read, which its answer asked for, reads the order a later sort gave",
      tags.length === 1 && partReads[2] === "/sales-part?sold=buyer&after=r2",
      `${JSON.stringify(tags)} ${partReads.join(" ")}`,
    );
    check(
      "a part's read whose order a sort changed while it was on its way is read again in that order",
      !!day && day !== "buyer" && partReads[3] === `/sales-part?sold=${day}&after=r2`,
      `${day} ${partReads.join(" ")}`,
    );
    await partPage.close();
  }
  // A form in such a part whose answer brings the part's next read (`ReadAgain::from` in the
  // patch): a sort before the form is in where the form sends, and one after it in the read its
  // answer asked for, whose tag took the part's in the page.
  {
    const formPage = await page.context().newPage();
    await formPage.route(
      (url) => url.href === unsorted,
      async (route) => {
        const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
        const headers = res.headers();
        delete headers["content-encoding"];
        delete headers["content-length"];
        let body = await res.text();
        const at = body.search(/<table>\s*<caption>This month/);
        const end = body.indexOf("</table>", at) + "</table>".length;
        const form = '<form id="refresh-sales" method="post" action="/sales-refresh?shop=a&amp;sold=day" data-patch><button>Refresh</button><button formaction="/sales-refresh?shop=b">Other shop</button></form>';
        const get = '<form id="find-sales" action="/sales-find?q=a"><button>Find</button></form>';
        // The part is the elements with an id beside its tag: the form, a GET form and the table.
        body = `${body.slice(0, at)}<template data-corten-read-again="60" data-from="/sales-part?after=r1"></template>${form}${get}<div id="sales-part">${body.slice(at, end)}</div>${body.slice(end)}`;
        await route.fulfill({ status: res.status(), headers, body });
      },
    );
    /** @type {string[]} */
    const sent = [];
    await formPage.route(
      (url) => url.pathname === "/sales-refresh" || url.pathname === "/sales-part",
      async (route) => {
        const url = new URL(route.request().url());
        sent.push(`${route.request().method()} ${url.pathname}?${url.searchParams}`);
        // The form's answer: the part's form drawn again and its next read, in the order it was sent.
        const body =
          url.pathname === "/sales-refresh"
            ? `<form id="refresh-sales" method="post" action="/sales-refresh?${url.searchParams.toString().replaceAll("&", "&amp;")}" data-patch><button>Refresh</button></form><template data-from="/sales-part?${url.searchParams.toString().replaceAll("&", "&amp;")}&amp;after=f1" data-corten-read-again="2"></template>`
            : "";
        await route.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "corten-patch": "1" }, body }).catch(() => {});
      },
    );
    await formPage.goto(unsorted);
    const formSales = formPage.locator("table", { has: formPage.locator("caption", { hasText: "This month's last sales" }) });
    await formSales.getByRole("link", { name: "Price" }).click();
    const sends = await formPage.evaluate(() => ({
      action: document.querySelector("#refresh-sales")?.getAttribute("action"),
      formaction: document.querySelector("#refresh-sales button[formaction]")?.getAttribute("formaction"),
      get: document.querySelector("#find-sales")?.getAttribute("action"),
    }));
    await formPage.getByRole("button", { name: "Refresh" }).click();
    await formPage.waitForFunction(() => document.querySelectorAll('main template[data-from*="after=f1"]').length === 1, null, { timeout: 3000 });
    const tags = await formPage.evaluate(() => Array.from(document.querySelectorAll('main template[data-from^="/sales-part"]'), (t) => t.getAttribute("data-from")));
    await formSales.getByRole("link", { name: "Buyer" }).click();
    for (let i = 0; i < 40 && !sent.some((s) => s.startsWith("GET /sales-part")); i++) await formPage.waitForTimeout(100);
    check(
      "a sort in place puts its order where a form in a part read again sends, not a GET form's",
      sends.action === "/sales-refresh?sold=price&shop=a" && sends.formaction === "/sales-refresh?sold=price&shop=b" && sends.get === "/sales-find?q=a",
      JSON.stringify(sends),
    );
    check(
      "a part's next read a form's answer brings takes the part's tag and reads the order a later sort gave",
      sent[0] === "POST /sales-refresh?sold=price&shop=a" && tags.length === 1 && sent.includes("GET /sales-part?sold=buyer&shop=a&after=f1"),
      `${JSON.stringify(tags)} ${sent.join(" ")}`,
    );
    await formPage.close();
  }
  await sales.getByRole("link", { name: "Price" }).click();
  const shownBeforeReload = await sortedBy();
  await page.reload();
  check("a reload after a sort in place shows the order on screen", JSON.stringify(await sortedBy()) === JSON.stringify(shownBeforeReload), `${JSON.stringify(shownBeforeReload)} -> ${JSON.stringify(await sortedBy())}`);
  await page.goto(unsorted);
  // A tab chosen in place since the page came in, and the fragment, stay in the address and the
  // header links: only the key the sort links differ in (`sold`) is taken from them.
  await tab("Offers").click();
  await page.evaluate(() => history.replaceState(history.state, "", `${location.pathname}${location.search}#sales`));
  await sales.getByRole("link", { name: "Buyer" }).click();
  const kept = new URL(page.url());
  const keptLink = new URL(/** @type {string} */ (await sales.getByRole("link", { name: "Price" }).getAttribute("href")), page.url());
  check(
    "a sort in place keeps a tab's key and the fragment in the address and its links",
    kept.searchParams.get("tab") === "offers" && kept.searchParams.get("sold") === "buyer" && kept.hash === "#sales" && keptLink.searchParams.get("tab") === "offers" && keptLink.searchParams.get("sold") === "price",
    `${page.url()} ${keptLink}`,
  );
  await page.goto(unsorted);
  // Tied rows are in the order the page drew them, however earlier clicks left them, as the
  // server's stable sort gives.
  await sales.getByRole("link", { name: "Buyer" }).click();
  const tied = await sales.evaluate((table) => {
    const prices = [...table.querySelectorAll("tbody td:last-child")].map((td) => /** @type {HTMLElement} */ (td));
    const was = prices.map((td) => td.dataset.sort ?? "");
    for (const td of prices) td.dataset.sort = "5";
    /** @type {HTMLElement} */ (table.querySelector("thead th:last-child a")).click();
    const order = [...table.querySelectorAll("tbody td:nth-child(2)")].map((td) => td.textContent).join("|");
    for (const td of table.querySelectorAll("tbody td:last-child")) /** @type {HTMLElement} */ (td).dataset.sort = was[prices.indexOf(/** @type {HTMLElement} */ (td))];
    return order;
  });
  check("tied rows sort in the order the page drew them, not the last click's", tied === "Grace Hopper|Alan Turing|Ada Lovelace", tied);
  await page.goto(unsorted);
  // A column read newest first (SortHeader's `first: Sort::Descending`, `data-first` on its link)
  // sorts descending on its first click, puts that order in the address, and links to ascending.
  // Buyer, which the page does not draw sorted, so the click is a first one, not a reversal.
  await sales.getByRole("link", { name: "Buyer" }).evaluate((a) => a.setAttribute("data-first", "descending"));
  await sales.getByRole("link", { name: "Buyer" }).click();
  const newest = await sortedBy();
  const newestNext = new URL(/** @type {string} */ (await sales.getByRole("link", { name: "Buyer" }).getAttribute("href")), page.url());
  check(
    "a header whose first click sorts descending does so, with the address and its next link to match",
    newest.buyers === "Grace Hopper|Alan Turing|Ada Lovelace" && newest.sort === ",descending,,," && new URL(page.url()).searchParams.get("sold") === "buyer_down" && newestNext.searchParams.get("sold") === "buyer",
    `${JSON.stringify(newest)} ${page.url()} ${newestNext}`,
  );
  await page.goto(unsorted);
  // Numbers as numbers (-10 before -2, where text would put -2 first) and an empty value last; a
  // click with a modifier key is the link's.
  const sortEdges = await sales.evaluate((table) => {
    const prices = [...table.querySelectorAll("tbody td:last-child")].map((td) => /** @type {HTMLElement} */ (td));
    const was = prices.map((td) => td.dataset.sort ?? "");
    ["-2", "", "-10"].forEach((v, i) => (prices[i].dataset.sort = v));
    const link = /** @type {HTMLElement} */ (table.querySelector("thead th:last-child a"));
    // Whether the handler stopped each click, read after it ran; the link is never followed.
    /** @type {boolean[]} */
    const stopped = [];
    const after = (/** @type {Event} */ e) => (stopped.push(e.defaultPrevented), e.preventDefault());
    window.addEventListener("click", after);
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    window.removeEventListener("click", after);
    const order = [...table.querySelectorAll("tbody td:last-child")].map((td) => /** @type {HTMLElement} */ (td).dataset.sort).join("|");
    prices.forEach((td, i) => (td.dataset.sort = was[i]));
    return { stopped: stopped.join(), order };
  });
  check(
    "a column of numbers sorts as numbers with an empty value last, and a ctrl-click is left to the link",
    sortEdges.stopped === "false,true" && sortEdges.order === "-10|-2|",
    JSON.stringify(sortEdges),
  );
  // Without data-sort, a cell's one <data value> or <time datetime> is what it sorts by (a date as an
  // instant), not the text the reader sees.
  const sortMachine = await sales.evaluate((table) => {
    const body = table.tBodies[0];
    const rows = [...body.rows];
    const cells = rows.map((row) => /** @type {HTMLElement} */ (row.cells[row.cells.length - 1]));
    const was = cells.map((td) => /** @type {const} */ ([[...td.childNodes], td.dataset.sort]));
    const link = /** @type {HTMLElement} */ (table.querySelector("thead th:last-child a"));
    const header = /** @type {HTMLElement} */ (link.closest("th"));
    const heads = [.../** @type {HTMLTableSectionElement} */ (table.tHead).rows[0].cells];
    const arias = heads.map((th) => th.getAttribute("aria-sort"));
    const stop = (/** @type {Event} */ e) => e.preventDefault();
    window.addEventListener("click", stop);
    // Built with the DOM: the page requires Trusted Types for HTML.
    const run = (/** @type {[string, string, string][]} */ parts) => {
      cells.forEach((td, i) => {
        const [tag, value, text] = parts[i];
        delete td.dataset.sort;
        const part = document.createElement(tag);
        part.setAttribute(tag === "time" ? "datetime" : "value", value);
        part.textContent = text;
        td.replaceChildren(part);
      });
      header.removeAttribute("aria-sort");
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return [...body.rows].map((row) => row.cells[row.cells.length - 1].textContent).join("|");
    };
    // Values whose order as numbers and instants differs from their text's and from their own as
    // text: 12.10 before 12.5 before 80, and 23:00 at -05:00 after 01:00Z the next day.
    const data = run([
      ["data", "12.5", "twelve fifty"],
      ["data", "80", "eighty"],
      ["data", "12.10", "twelve ten"],
    ]);
    const times = run([
      ["time", "2025-12-24T23:00:00-05:00", "Dec 24, 11 PM EST"],
      ["time", "2025-12-25T01:00:00Z", "Dec 25, 1 AM UTC"],
      ["time", "2025-12-01", "Dec 1"],
    ]);
    window.removeEventListener("click", stop);
    cells.forEach((td, i) => {
      td.replaceChildren(...was[i][0]);
      if (was[i][1] !== undefined) td.dataset.sort = was[i][1];
    });
    for (const row of rows) body.append(row);
    heads.forEach((th, i) => {
      const aria = arias[i];
      if (aria) th.setAttribute("aria-sort", aria);
      else th.removeAttribute("aria-sort");
    });
    return { data, times };
  });
  check(
    "a cell's <data value> and <time datetime> are what it sorts by, not its text",
    sortMachine.data === "twelve ten|twelve fifty|eighty" && sortMachine.times === "Dec 1|Dec 25, 1 AM UTC|Dec 24, 11 PM EST",
    JSON.stringify(sortMachine),
  );
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
  // The menu gives focus back on the dialog's `close` event, a task after `open` turns false, so
  // the check reads focus in the task after that event, once anything the browser does after it
  // is done too, not when `open` turns false (#666). Only WebKit tests the menu here: Chromium and
  // Firefox's dialog gives focus back to the button by itself.
  await page.evaluate(() => {
    const dialog = /** @type {HTMLDialogElement} */ (document.querySelector("dialog[aria-label='Rename the draft']"));
    dialog.addEventListener("close", () => setTimeout(() => (/** @type {any} */ (window).renameFocus = document.activeElement?.outerHTML.slice(0, 80) ?? "")), {
      once: true,
    });
  });
  await page.keyboard.press("Escape");
  const renameClosed = await page.waitForFunction(() => /** @type {any} */ (window).renameFocus !== undefined, null, { timeout: 5000 }).then(() => true, () => false);
  const focusedOnClose = renameClosed ? await page.evaluate(() => /** @type {string} */ (/** @type {any} */ (window).renameFocus)) : "the dialog did not close";
  check("closing the dialog an item opened returns focus to the button", focusedOnClose.includes('id="actions-button"'), focusedOnClose);

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
  // A save that gets no answer (corten:error): the toaster's failed text, kept past its seconds until
  // the next submit, another page or its close button.
  const cut = (/** @type {import("@playwright/test").Route} */ route) =>
    route.request().method() === "POST" ? route.abort("connectionreset") : route.fallback();
  await page.route("**/save", cut);
  const errorsBefore = errors.length;
  await save.click();
  const failedShown = await page.waitForFunction(() => document.querySelector("#ui-toast")?.textContent?.startsWith("That did not go through"), null, { timeout: 5000 }).then(() => true, () => false);
  check("a save with no answer shows the toaster's failed text, and its close button", failedShown && (await toast.isVisible()) && (await dismiss.isVisible()));
  // It is marked as a failure, which the kit's Toasts draws in the destructive tone (checked below,
  // against a notice).
  const failedDrawn = await toast.evaluate((m) => {
    const box = /** @type {HTMLElement} */ (m.closest("[role=status]")?.parentElement);
    return { failed: m.hasAttribute("data-failed"), background: getComputedStyle(box).backgroundColor };
  });
  check("the failed text is marked data-failed", failedDrawn.failed, JSON.stringify(failedDrawn));
  await page.mouse.move(0, 0);
  await page.waitForTimeout(2600);
  check("the failed text stays past the toaster's seconds", await toast.isVisible());
  // The next submit takes it away, and a second failure is said again, as a new message.
  await page.evaluate(() => ((/** @type {any} */ (document.querySelector("#ui-toast"))).__first = 1));
  const gone = page.evaluate(() => new Promise((resolve) => document.addEventListener("submit", () => queueMicrotask(() => resolve(/** @type {HTMLElement} */ (document.querySelector("#ui-toast")).hidden)), { once: true })));
  await save.click();
  const again = await page
    .waitForFunction(() => { const m = /** @type {any} */ (document.querySelector("#ui-toast")); return !m.hidden && m.__first !== 1 && m.textContent.startsWith("That did not go through"); }, null, { timeout: 5000 })
    .then(() => true, () => false);
  check("the next submit takes the failed text away, and a second failure says it again", (await gone) === true && again);
  // The page changing its own address (a tab's replaceState, a link to a place on it) keeps it.
  await page.evaluate(() => {
    history.replaceState(history.state, "", `${location.pathname}${location.search}`);
    location.hash = "ui-toast-kept";
  });
  await page.waitForTimeout(300);
  check("a failure is kept while the page changes only its own address", await toast.isVisible());
  await page.evaluate(() => history.replaceState(history.state, "", `${location.pathname}${location.search}`));
  // So does the page reading itself again (a navigation to its own address, as ReadAgain makes).
  if (await page.evaluate(() => "navigation" in window)) {
    await page.evaluate(() => (/** @type {any} */ (window)).navigation.navigate(location.href, { history: "replace" }).finished);
    await page.waitForTimeout(300);
    check("a failure is kept while the page reads itself again", await toast.evaluate((m) => !(/** @type {HTMLElement} */ (m).hidden)));
  } else skip("a failure is kept while the page reads itself again", "no Navigation API: a navigation is a full page load");
  await dismiss.click();
  check("and it closes", await toast.isHidden());
  // An empty `failed` says nothing.
  const failedText = await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll("template")).find((t) => t.content.textContent?.startsWith("That did not go through"));
    if (!t) return false;
    (/** @type {any} */ (window)).__failed = [t, Array.from(t.content.childNodes)];
    t.content.replaceChildren();
    return true;
  });
  await save.click();
  await page.waitForTimeout(500);
  // Unhidden but empty, the message has no height, so it is read by its hidden attribute.
  const emptySaid = await toast.evaluate((m) => !(/** @type {HTMLElement} */ (m).hidden));
  await page.evaluate(() => {
    const [t, kept] = /** @type {any} */ (window).__failed;
    t.content.replaceChildren(...kept);
  });
  check("an empty failed text says nothing", failedText && !emptySaid);
  // A notice after a failure is not marked: the toaster's copy of the message drops the mark.
  const notice = await toast.evaluate((m) => {
    document.dispatchEvent(new CustomEvent("corten:notice", { detail: { message: "Saved." } }));
    const now = /** @type {HTMLElement} */ (document.querySelector("#ui-toast"));
    const box = /** @type {HTMLElement} */ (now.closest("[role=status]")?.parentElement);
    return { before: m.hasAttribute("data-failed"), after: now.hasAttribute("data-failed"), text: now.textContent, background: getComputedStyle(box).backgroundColor };
  });
  check("a notice after a failure is not marked, and the kit draws the two in different colors", notice.before && !notice.after && notice.text === "Saved." && notice.background !== failedDrawn.background, JSON.stringify(notice));
  await dismiss.click();
  // An action that did not do what was asked answers with a failed Toast: marked as the failed
  // text is, drawn the same, kept past the toaster's seconds, and taken away by the next submit.
  {
    const publish = page.getByRole("button", { name: "Publish", exact: true });
    await publish.click();
    const said = await page.waitForFunction(() => document.querySelector("#ui-toast")?.textContent?.startsWith("Not published"), null, { timeout: 5000 }).then(() => true, () => false);
    const drawn = await toast.evaluate((m) => {
      const box = /** @type {HTMLElement} */ (m.closest("[role=status]")?.parentElement);
      return { failed: m.hasAttribute("data-failed"), background: getComputedStyle(box).backgroundColor };
    });
    check("an action's failed Toast is marked and drawn as the failed text is", said && drawn.failed && drawn.background === failedDrawn.background, JSON.stringify(drawn));
    await page.mouse.move(0, 0);
    await page.waitForTimeout(2600);
    const stayed = await toast.isVisible();
    const gone = page.evaluate(() => new Promise((resolve) => document.addEventListener("submit", () => queueMicrotask(() => resolve(/** @type {HTMLElement} */ (document.querySelector("#ui-toast")).hidden)), { once: true })));
    await publish.click();
    const hid = await gone;
    await page.waitForFunction(() => !(/** @type {HTMLElement} */ (document.querySelector("#ui-toast")).hidden), null, { timeout: 5000 });
    check("an action's failed Toast stays past the toaster's seconds and the next submit takes it away", stayed && hid === true, JSON.stringify({ stayed, hid }));
    await dismiss.click();
  }
  // Another page takes it away.
  {
    const other = await page.context().newPage();
    await other.route("**/save", cut);
    await other.goto(page.url());
    await other.getByRole("button", { name: "Save draft" }).click();
    const shown = await other.waitForFunction(() => document.querySelector("#ui-toast")?.textContent?.startsWith("That did not go through"), null, { timeout: 5000 }).then(() => true, () => false);
    await other.locator('header a[href="/help"]').click();
    await other.waitForFunction(() => location.pathname === "/help");
    const after = await other.evaluate(() => /** @type {HTMLElement | null} */ (document.querySelector("#ui-toast"))?.hidden ?? true);
    check("another page takes a failure away", shown && after, JSON.stringify({ shown, after }));
    await other.close();
  }
  // A handler that says it itself takes the event, even one the page added on the document after
  // the toaster's: the toaster stays quiet.
  await page.evaluate(() => document.addEventListener("corten:error", (e) => e.preventDefault(), { once: true }));
  const taken = page.evaluate(() => new Promise((resolve) => document.addEventListener("corten:error", (e) => resolve(e.defaultPrevented), { once: true })));
  await save.click();
  check("corten:error is cancelable, and a handler took it", (await taken) === true);
  await page.waitForTimeout(300);
  check("a corten:error a handler took leaves the toaster quiet", await toast.isHidden());
  await page.unroute("**/save", cut);
  // The two saves cut on purpose: Chromium logs each as a resource that failed to load.
  errors.splice(errorsBefore, errors.length - errorsBefore, ...errors.slice(errorsBefore).filter((e) => !/ERR_CONNECTION_RESET/.test(e)));

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
  {
    const glyphPage = await (await browser.newContext()).newPage();
    await glyphPage.goto(`${base}/`);
    // The app's own glyphs (src/glyphs.rs, outside the kit's icon.rs): a line glyph is drawn in
    // lines only, and one made with Glyph::filled is filled in the text's color, and follows it.
    const ownGlyphs = await glyphPage.locator("p", { hasText: "rated 4.8 of 5" }).evaluate((p) => {
      const [line, star] = /** @type {SVGSVGElement[]} */ ([...p.querySelectorAll("svg")]);
      const was = p.style.color;
      p.style.color = "rgb(1, 2, 3)";
      const follows = getComputedStyle(star).fill;
      p.style.color = was;
      return {
        count: p.querySelectorAll("svg").length,
        line: { fill: getComputedStyle(line).fill, stroke: getComputedStyle(line).stroke, parts: line.children.length },
        star: { fill: getComputedStyle(star).fill, stroke: getComputedStyle(star).stroke, hidden: star.getAttribute("aria-hidden") },
        color: getComputedStyle(p).color,
        follows,
      };
    });
    check(
      "Icon: an app's own glyph draws in lines, and a Glyph::filled one fills in the text's color",
      ownGlyphs.count === 2 && ownGlyphs.line.fill === "none" && ownGlyphs.line.stroke === ownGlyphs.color && ownGlyphs.line.parts === 4 && ownGlyphs.star.fill === ownGlyphs.color && ownGlyphs.star.stroke === ownGlyphs.color && ownGlyphs.star.hidden === "true" && ownGlyphs.follows === "rgb(1, 2, 3)",
      JSON.stringify(ownGlyphs),
    );
    await glyphPage.context().close();
  }
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
  // Tooltip: an icon-only link named by its tooltip and a link described by one. Where the browser
  // has interestfor (Chromium) it shows them itself; elsewhere the script does, on the page's
  // fake clock, so its delays are read exactly: shown after the pointer rests half a second, kept
  // while it moves onto the tooltip, hidden a quarter second after it leaves both; at once on
  // keyboard focus; closed by Escape. Above its control either way.
  {
    const tips = await (await browser.newContext()).newPage();
    tips.on("pageerror", (e) => errors.push(e.message));
    await tips.goto(`${base}/`);
    await tips.waitForFunction(() => document.querySelector("[data-scope=ui-combo-box] input")?.checkVisibility(), null, { timeout: 5000 }).catch(() => {});
    const native = await tips.evaluate(() => "interestForElement" in HTMLButtonElement.prototype);
    const orders = tips.getByRole("link", { name: "Open the orders", exact: true });
    const lastSale = tips.getByRole("link", { name: "Last sale", exact: true });
    const described = await lastSale.evaluate((a) => document.getElementById(a.getAttribute("aria-describedby") ?? "")?.textContent);
    check("Tooltip: an icon-only link is named by its tooltip, and a link is described by one", (await orders.count()) === 1 && described === "Opens beside the draft; Escape closes it", String(described));
    const tipOf = (/** @type {import("@playwright/test").Locator} */ control) => control.evaluate((c) => c.getAttribute("interestfor") ?? "");
    const ordersTip = await tipOf(orders);
    const isOpen = (/** @type {string} */ id) => tips.evaluate((id) => document.getElementById(id)?.matches(":popover-open") ?? false, id);
    /** Waits for the tooltip to open or close, natively; on the fake clock, moves time on first. @param {string} id @param {boolean} open @param {number} ms */
    const after = async (id, open, ms) => {
      if (!native) {
        await tips.clock.runFor(ms);
        return (await isOpen(id)) === open;
      }
      return tips.waitForFunction(([id, open]) => document.getElementById(/** @type {string} */ (id))?.matches(":popover-open") === open, [id, open], { timeout: 5000 }).then(() => true, () => false);
    };
    // Paused, so only runFor moves the page's time: a slow hover under load adds none.
    if (!native) {
      await tips.clock.install();
      await tips.clock.pauseAt((await tips.evaluate(() => Date.now())) + 1_000);
    }
    await tips.mouse.move(1, 1);
    await orders.hover();
    const early = native ? null : (await tips.clock.runFor(450), await isOpen(ordersTip));
    const shown = await after(ordersTip, true, 100);
    const place = await tips.evaluate((id) => {
      const tip = /** @type {HTMLElement} */ (document.getElementById(id)).getBoundingClientRect();
      const control = /** @type {HTMLElement} */ (document.querySelector(`[interestfor="${id}"]`)).getBoundingClientRect();
      return { above: tip.bottom <= control.top + 1, gap: Math.round(control.top - tip.bottom), across: tip.left < control.right && tip.right > control.left };
    }, ordersTip);
    check(`Tooltip: shown when the pointer rests on its control${native ? " (the browser's interestfor)" : ", after half a second"}, above it`, early !== true && shown && place.above && place.gap <= 8 && place.across, JSON.stringify({ native, early, shown, place }));
    const box = await tips.locator(`[id="${ordersTip}"]`).boundingBox();
    if (box) await tips.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    const kept = native ? await isOpen(ordersTip) : (await tips.clock.runFor(600), await isOpen(ordersTip));
    await tips.mouse.move(1, 1);
    const hidden = await after(ordersTip, false, 300);
    check("Tooltip: kept while the pointer moves onto it, hidden once it leaves both", kept && hidden, JSON.stringify({ kept, hidden }));
    // Swept across another tooltip's control without resting there: the first still hides, and
    // the second never shows.
    const lastSaleTip = await tipOf(lastSale);
    await orders.hover();
    const again = await after(ordersTip, true, 600);
    await lastSale.hover();
    if (!native) await tips.clock.runFor(100);
    await tips.mouse.move(1, 1);
    const sweptAway = await after(ordersTip, false, 300);
    const otherShown = native ? false : (await tips.clock.runFor(600), await isOpen(lastSaleTip));
    check("Tooltip: swept over another tooltip's control, the shown one still hides and the other does not show", again && sweptAway && !otherShown, JSON.stringify({ again, sweptAway, otherShown }));
    // Keyboard focus, on the held count's button (TipText) reached by Tab from a button just
    // before it: Playwright's WebKit on Windows does not Tab to a link, so a link here would make
    // the check fail on the machine, not the code (#712). The script listens for focus on any
    // control with interestfor, so a button exercises the same path a link does.
    const keyed = tips.getByRole("button", { name: "3 orders", exact: true });
    const keyedTip = await tipOf(keyed);
    await keyed.evaluate((b) => b.before(Object.assign(document.createElement("button"), { type: "button", id: "before-keyed", textContent: "Before" })));
    await tips.focus("#before-keyed");
    await tips.keyboard.press("Tab");
    const focusedKeyed = await keyed.evaluate((b) => b === document.activeElement);
    const onFocus = native ? await after(keyedTip, true, 0) : await isOpen(keyedTip);
    await tips.keyboard.press("Escape");
    const escaped = await after(keyedTip, false, 0);
    const stillFocused = await keyed.evaluate((b) => b === document.activeElement);
    check("Tooltip: shown on keyboard focus, closed by Escape with focus kept", focusedKeyed && onFocus && escaped && stillFocused, JSON.stringify({ focusedKeyed, onFocus, escaped, stillFocused }));
    // A link too. Playwright's WebKit on Windows does not Tab to one; anywhere else a missed Tab
    // fails the check rather than skipping it.
    const linkName = "Tooltip: a link's tooltip is shown on keyboard focus";
    await tips.getByRole("button", { name: "Print label", exact: true }).focus();
    await tips.keyboard.press("Tab");
    const focusedLink = await orders.evaluate((a) => a === document.activeElement);
    if (focusedLink || !(engine === "webkit" && process.platform === "win32")) {
      const linkShown = native ? await after(ordersTip, true, 0) : await isOpen(ordersTip);
      await tips.keyboard.press("Escape");
      const linkClosed = await after(ordersTip, false, 0);
      check(linkName, focusedLink && linkShown && linkClosed, JSON.stringify({ focusedLink, linkShown, linkClosed }));
    } else skip(linkName, "Playwright's WebKit on Windows does not Tab to a link");
    await keyed.focus();
    if (!native) {
      // The script's own: focus holds a tooltip while the pointer brushes another control, and
      // Escape stops one waiting to show.
      await tips.keyboard.press("Shift+Tab");
      await tips.keyboard.press("Tab");
      const held = await isOpen(keyedTip);
      await lastSale.hover();
      await tips.clock.runFor(100);
      await tips.mouse.move(1, 1);
      await tips.clock.runFor(600);
      const stillHeld = await isOpen(keyedTip);
      await tips.keyboard.press("Escape");
      await tips.locator("h1").first().click();
      await lastSale.hover();
      await tips.clock.runFor(200);
      await tips.keyboard.press("Escape");
      await tips.clock.runFor(600);
      const stopped = !(await isOpen(lastSaleTip));
      check("Tooltip: keyboard focus holds it while the pointer brushes another control; Escape stops one waiting", held && stillHeld && stopped, JSON.stringify({ held, stillHeld, stopped }));
    }
    await tips.context().close();
  }
  // TipText: text that shows a tooltip is a button drawn as the text around it, with a dotted
  // underline and the kit's focus ring. An app's `button {}` rule does not undo it, and an app's
  // class on it wins, each placed before the kit's rules and after them (CSSOM, not markup).
  {
    const textTip = await (await browser.newContext()).newPage();
    textTip.on("pageerror", (e) => errors.push(e.message));
    await textTip.goto(`${base}/`);
    const held = textTip.getByRole("button", { name: "3 orders", exact: true });
    const drawn = await held.evaluate((b) => {
      const p = /** @type {HTMLElement} */ (b.parentElement);
      const kit = /** @type {CSSStyleSheet} */ ([...document.styleSheets].find((s) => [...s.cssRules].some((r) => r.cssText.includes(b.classList[0]))));
      /** How the button is drawn against the paragraph's text: what differs, its box, its line. */
      const read = () => {
        const own = getComputedStyle(b);
        const around = getComputedStyle(p);
        const span = document.createElement("span");
        span.textContent = b.textContent;
        p.append(span);
        const widths = [b.getBoundingClientRect().width, span.getBoundingClientRect().width];
        span.remove();
        return {
          differs: ["font-family", "font-size", "font-style", "font-weight", "line-height", "color", "letter-spacing", "word-spacing", "text-transform", "text-shadow"].filter((n) => own.getPropertyValue(n) !== around.getPropertyValue(n)),
          box: [own.borderTopWidth, own.paddingLeft, own.paddingTop, own.backgroundColor, own.marginTop].join(),
          line: [own.textDecorationLine, own.textDecorationStyle].join(),
          asText: Math.abs(widths[0] - widths[1]) < 0.5,
          size: own.fontSize,
        };
      };
      /** Reads the button with `rule` placed first in the kit's stylesheet, then last. @param {string} rule */
      const placed = (rule) =>
        [0, kit.cssRules.length].map((at) => {
          const i = kit.insertRule(rule, at);
          const got = read();
          kit.deleteRule(i);
          return got;
        });
      const plain = read();
      const appButton = placed("button { padding: 14px; border: 1px solid; background: rgb(238, 238, 238); font-weight: 700; text-transform: uppercase; }");
      b.classList.add("app-size");
      const appClass = placed(".app-size { font-size: 23px; }");
      b.classList.remove("app-size");
      return {
        plain,
        appButton,
        appClass: appClass.map((r) => r.size),
        described: document.getElementById(b.getAttribute("aria-describedby") ?? "")?.textContent,
        tip: b.getAttribute("interestfor") === b.getAttribute("aria-describedby"),
      };
    });
    const asText = (/** @type {typeof drawn.plain} */ r) => r.differs.length === 0 && r.box === "0px,0px,0px,rgba(0, 0, 0, 0),0px" && r.line === "underline,dotted" && r.asText;
    check(
      "TipText: a button that shows a tooltip is drawn as the text around it (as wide as a span of it), underlined dotted",
      asText(drawn.plain) && drawn.described === "#1041, #1043 and #1050" && drawn.tip,
      JSON.stringify(drawn.plain),
    );
    check("TipText: an app's button {} rule, before the kit's or after it, does not draw it as a button", drawn.appButton.every(asText), JSON.stringify(drawn.appButton));
    check("TipText: an app's class on it that sets its size wins, before the kit's rules or after them", drawn.appClass.join() === "23px,23px", JSON.stringify(drawn.appClass));
    await held.focus();
    const ring = await held.evaluate((b) => ({ visible: b.matches(":focus-visible"), outline: [getComputedStyle(b).outlineStyle, getComputedStyle(b).outlineWidth] }));
    check("TipText: focused, it has the kit's focus ring", ring.visible && ring.outline.join() === "solid,2px", JSON.stringify(ring));
    await held.blur();
    const tipId = (await held.getAttribute("interestfor")) ?? "";
    const closed = await textTip.waitForFunction((id) => !document.getElementById(id)?.matches(":popover-open"), tipId, { timeout: 5000 }).then(() => true, () => false);
    await held.hover();
    const shown = await textTip.waitForFunction((id) => document.getElementById(id)?.matches(":popover-open"), tipId, { timeout: 5000 }).then(() => true, () => false);
    check("TipText: closed until the pointer rests on the text, then its tooltip shows", closed && shown, JSON.stringify({ closed, shown }));
    // Its tooltip on keyboard focus is the Tooltip block's check, which Tabs to this button.
    await textTip.context().close();
  }
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
  // The tones the kit's looks take, as each engine computes them: a soft alert is its tone mixed
  // 12% into the card, an outline one the card's, a solid one its tone's fill and text, and a
  // toned button is filled with its tone.
  const tones = await orders.locator("strong", { hasText: "past its ship-by date" }).evaluate((s) => {
    const soft = /** @type {Element} */ (s.parentElement);
    const style = getComputedStyle(soft);
    const hex = (/** @type {string} */ name) => {
      const value = style.getPropertyValue(name).trim();
      return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
    };
    // `rgb(246, 234, 225)`, or `color(srgb 0.96 0.92 0.88)` for a color-mix.
    const rgb = (/** @type {Element} */ el) => {
      const text = getComputedStyle(el).backgroundColor;
      const n = (text.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      return text.startsWith("color(") ? n.map((c) => c * 255) : n;
    };
    const near = (/** @type {number[]} */ got, /** @type {number[]} */ want) =>
      got.length === 3 && got.every((g, i) => Math.abs(g - want[i]) <= 1.5);
    const [warning, card] = [hex("--warning"), hex("--card")];
    const outline = /** @type {Element} */ (
      [...document.querySelectorAll("p")].find((p) => p.textContent?.startsWith("Orders paid before"))?.parentElement
    );
    const button = (/** @type {string} */ name) =>
      /** @type {Element} */ ([...soft.querySelectorAll("button")].find((b) => b.textContent?.trim() === name));
    const solid = /** @type {Element} */ (
      [...document.querySelectorAll("p")].find((p) => p.textContent?.startsWith("Every return this month"))?.parentElement
    );
    const text = getComputedStyle(solid).color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
    return {
      soft: near(rgb(soft), warning.map((t, i) => t * 0.12 + card[i] * 0.88)),
      outline: near(rgb(outline), card),
      solid: near(rgb(solid), hex("--success")) && near(text, hex("--success-foreground")),
      buttons: [
        ["Mark shipped", "--success"],
        ["Buy postage (test mode)", "--warning"],
        ["Message the buyer", "--info"],
      ].map(([name, token]) => near(rgb(button(name)), hex(token))),
    };
  });
  check(
    "Alert and Button tones: a soft warning is its tone mixed 12% into the card, an outline alert the card's, a solid one its tone's fill and text, a toned button its tone",
    tones.soft && tones.outline && tones.solid && tones.buttons.every(Boolean),
    JSON.stringify(tones),
  );
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
  // Its Icon: an svg a screen reader skips, at the text's size, its lines in the text's color and
  // unfilled, centered in the square.
  // The glyph is drawn: its three dots are SVG elements (not text the page escaped), with the
  // extent ellipsis-vertical has on its 24-unit grid, and its lines follow the text's color.
  const glyph = await rowMenu.evaluate((b) => {
    const svg = /** @type {SVGSVGElement | null} */ (b.querySelector("svg"));
    if (!svg) return null;
    const box = svg.getBoundingClientRect();
    const outer = b.getBoundingClientRect();
    const drawn = svg.getBBox();
    const style = getComputedStyle(svg);
    const was = b.style.color;
    b.style.color = "rgb(1, 2, 3)";
    const follows = getComputedStyle(svg).stroke;
    b.style.color = was;
    return {
      hidden: svg.getAttribute("aria-hidden"),
      dots: [...svg.children].filter((c) => c.localName === "circle" && c.namespaceURI === "http://www.w3.org/2000/svg").length,
      drawn: [Math.round(drawn.width), Math.round(drawn.height)],
      size: [box.width, box.height],
      em: parseFloat(getComputedStyle(b).fontSize),
      stroke: style.stroke,
      color: getComputedStyle(b).color,
      follows,
      fill: style.fill,
      off: [box.left + box.width / 2 - (outer.left + outer.width / 2), box.top + box.height / 2 - (outer.top + outer.height / 2)],
    };
  });
  check(
    "Icon: an aria-hidden svg drawing its glyph at 1em in the text's color, unfilled, centered in a menu's icon trigger",
    !!glyph && glyph.hidden === "true" && glyph.dots === 3 && glyph.drawn[0] === 2 && glyph.drawn[1] === 16 && glyph.size.every((s) => Math.abs(s - glyph.em) < 0.5) && glyph.stroke === glyph.color && glyph.follows === "rgb(1, 2, 3)" && glyph.fill === "none" && glyph.off.every((d) => Math.abs(d) <= 1),
    JSON.stringify(glyph),
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
    const rowTrigger = menuPage.getByRole("button", { name: "More actions for Ada Lovelace's order" });
    await rowTrigger.focus();
    await menuPage.keyboard.press("ArrowDown");
    await menuPage.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem", null, { timeout: 5000 }).catch(() => {});
    check("DropdownMenu: a row's icon menu opens on its first item", (await menuPage.evaluate(() => document.activeElement?.textContent)) === "Help with this order");
    await menuPage.keyboard.press("Escape");
    // The trigger's aria-expanded follows the popover's toggle event, which fires after the key.
    await menuPage.waitForFunction((id) => document.getElementById(id)?.getAttribute("aria-expanded") === "false", await rowTrigger.getAttribute("id"), { timeout: 5000 }).catch(() => {});
    const backTo = await rowTrigger.evaluate((b) => ({ focused: document.activeElement === b, expanded: b.getAttribute("aria-expanded") }));
    check("DropdownMenu: Escape closes a row's icon menu and returns focus to its trigger", backTo.focused && backTo.expanded === "false", JSON.stringify(backTo));
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
  // A badge is never wider than its box, on a phone: a key with no break in it (a hash) wraps inside
  // the badge, and one with hyphens (the report's) stays inside it, in a row that wraps (a
  // Cluster), a column (a Stack, where a badge keeps its own width) and a block, and the page does
  // not scroll sideways; a short label, and one led by a StatusDot or an Icon, keep one line with a
  // quarter rem after the mark. Measured by the text's own line boxes, which can run out of a
  // badge whose box is held, with the gallery's `box-sizing` reset off, as an app may not have one.
  {
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await phone.goto(`${base}/orders`);
    const badges = await phone.evaluate(() => {
      const reset = new CSSStyleSheet();
      reset.replaceSync("*, *::before, *::after { box-sizing: content-box; }");
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, reset];
      const kit = /** @type {HTMLElement} */ (document.querySelector("td > [class*='badge__badge']"));
      const dot = /** @type {HTMLElement} */ (document.querySelector("[class*='badge__badge'] > [class*='status-dot__dot']"));
      const icon = /** @type {SVGElement} */ (document.querySelector("svg[class*='icon__icon']"));
      /** The badge's text, without its mark. @param {Element} el */
      const text = (el) => {
        const rects = Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .flatMap((n) => {
            const range = document.createRange();
            range.selectNodeContents(n);
            return Array.from(range.getClientRects()).filter((r) => r.width > 0);
          });
        const first = rects.reduce((a, r) => (r.top < a.top ? r : a), rects[0]);
        return { lines: new Set(rects.map((r) => Math.round(r.top))).size, left: first.left, right: Math.max(...rects.map((r) => r.right)) };
      };
      /** @param {Partial<CSSStyleDeclaration>} style */
      const row = (style) => {
        const box = document.createElement("div");
        // Set through the CSSOM, which the page's CSP allows where a style attribute is refused.
        Object.assign(box.style, style);
        const labels = ["Paid", "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "Unit: tcgdex:pokemon:single-card:source-observation-import"];
        const made = labels.map((label) => {
          const badge = /** @type {HTMLElement} */ (kit.cloneNode(false));
          badge.textContent = label;
          return badge;
        });
        const marked = [dot, icon].map((mark) => {
          const badge = /** @type {HTMLElement} */ (kit.cloneNode(false));
          badge.append(mark.cloneNode(true), "Open");
          return badge;
        });
        box.append(...made, ...marked);
        (document.querySelector("main") ?? document.body).prepend(box);
        const page = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        const outer = box.getBoundingClientRect();
        const counted = [...made, ...marked].map((badge) => {
          const b = badge.getBoundingClientRect();
          const inner = b.right - parseFloat(getComputedStyle(badge).paddingRight) - parseFloat(getComputedStyle(badge).borderRightWidth);
          const t = text(badge);
          const mark = badge.firstElementChild?.getBoundingClientRect();
          return { width: Math.round(b.width), past: Math.round(b.right - outer.right), spill: Math.round(t.right - inner), lines: t.lines, after: mark ? Math.round(t.left - mark.right) : 4 };
        });
        box.remove();
        return { page, short: counted[0], hash: counted[1], hyphens: counted[2], dotted: counted[3], iconed: counted[4] };
      };
      const shown = { cluster: row({ display: "flex", flexWrap: "wrap", gap: ".5rem" }), stack: row({ display: "flex", flexDirection: "column", gap: ".5rem" }), block: row({ display: "block" }) };
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== reset);
      return shown;
    });
    await phone.context().close();
    check(
      "Badge: on a phone a long key (a hash, or with hyphens) stays inside its badge, in a Cluster, a Stack and a block, and the page does not scroll; a short label and one led by a dot or an icon keep one line, a quarter rem after the mark, and their own width in a Stack",
      [badges.cluster, badges.stack, badges.block].every(
        (r) =>
          r.page === 0 &&
          r.hash.lines >= 2 &&
          [r.hash, r.hyphens].every((b) => b.past <= 0 && b.spill <= 0) &&
          [r.short, r.dotted, r.iconed].every((b) => b.past <= 0 && b.spill <= 0 && b.lines === 1 && b.after === 4 && b.width < 120),
      ),
      JSON.stringify(badges),
    );
  }
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
    // A compact density sets it lower.
    document.documentElement.style.setProperty("--control-height", "1.75rem");
    const compact = of();
    document.documentElement.style.removeProperty("--control-height");
    return { before, after, compact };
  });
  check(
    "Sizes: --control-height sets the height of a select and a button of the default size, not a small one",
    heights.before[0] === 2.25 && heights.before[1] === 2.25 && heights.after[0] === 2.75 && heights.after[1] === 2.75 && heights.after[2] === heights.before[2],
    JSON.stringify(heights),
  );
  check("Sizes: a lower --control-height (a compact density) is a button's height too", heights.compact[0] === 1.75 && heights.compact[1] === 1.75, JSON.stringify(heights.compact));
  // A label wider than the room wraps and the button grows, so a 320 px page does not scroll
  // sideways (WCAG reflow); a one-line button, a <button> or an <a>, keeps the size's height.
  const wraps = await orders.evaluate(() => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const md = /** @type {HTMLElement} */ (document.querySelector("button[class*='button__md']"));
    const box = document.createElement("div");
    // Set through the CSSOM, which the page's CSP allows where a style attribute is refused.
    Object.assign(box.style, { width: "240px", display: "flex", flexWrap: "wrap" });
    // As in the report: a form's button in a card's row.
    const form = document.createElement("form");
    const long = /** @type {HTMLElement} */ (md.cloneNode(false));
    long.textContent = "Reprice all inventory using saved curves";
    form.append(long);
    const link = document.createElement("a");
    link.className = md.className;
    link.href = "#";
    link.textContent = "Save";
    box.append(form, link);
    document.body.append(box);
    const [b, l, outer] = [long.getBoundingClientRect(), link.getBoundingClientRect(), box.getBoundingClientRect()];
    const one = parseFloat(getComputedStyle(md).minHeight) / rem;
    box.remove();
    return { width: Math.round(b.width), right: Math.round(b.right - outer.right), height: b.height / rem, link: l.height / rem, one };
  });
  check(
    "Button: a label wider than its box wraps and the button grows; one line keeps the size's height, <a> too",
    wraps.width <= 240 && wraps.right <= 0 && wraps.height > wraps.one && wraps.link === wraps.one,
    JSON.stringify(wraps),
  );
  // A row that shrinks to its content (a table's action cell) keeps each word whole: the label's
  // words go on lines of their own, never "Mark / shipp / ed".
  const words = await orders.evaluate(() => {
    const md = /** @type {HTMLElement} */ (document.querySelector("button[class*='button__md']"));
    const table = document.createElement("table");
    // As narrow as its content lets it be: each word on a line of its own.
    Object.assign(table.style, { width: "1px" });
    const cell = table.insertRow().insertCell();
    const button = /** @type {HTMLElement} */ (md.cloneNode(false));
    button.textContent = "Mark shipped";
    cell.append(button);
    document.body.append(table);
    // Each line's text, read from the label's character boxes.
    const text = /** @type {Text} */ (button.firstChild);
    const range = document.createRange();
    /** @type {[number, string][]} */
    const lines = [];
    for (let i = 0; i < text.length; i += 1) {
      range.setStart(text, i);
      range.setEnd(text, i + 1);
      const top = Math.round(range.getBoundingClientRect().top);
      const last = lines[lines.length - 1];
      if (last && Math.abs(last[0] - top) <= 2) last[1] += text.data[i];
      else lines.push([top, text.data[i]]);
    }
    table.remove();
    return lines.map(([, s]) => s.trim()).filter(Boolean);
  });
  check("Button: a row that shrinks to its content breaks a label between words, never inside one", JSON.stringify(words) === '["Mark","shipped"]', JSON.stringify(words));
  // A small button inside an InputGroup stays inside its border, at the 44 px touch-target size too.
  // On the gallery's home page, whose Lowest offer field is an InputGroup: a group of its classes
  // gets a Sm button (the page links button.css too).
  const groupPage = await orders.context().newPage();
  await groupPage.goto(`${base}/`);
  const grouped = await groupPage.getByLabel("Lowest offer (USD)").evaluate((floor) => {
    const sm = document.querySelector("button[class*='button__sm']");
    const kit = floor.parentElement;
    if (!sm || !kit) return { styled: false, found: { sm: !!sm, group: !!kit } };
    const group = document.createElement("span");
    group.className = kit.className;
    const button = /** @type {HTMLElement} */ (sm.cloneNode(false));
    button.textContent = "Go";
    group.append(document.createElement("input"), button);
    document.body.append(group);
    const root = document.documentElement.style;
    /** @param {string} size */
    const at = (size) => {
      for (const token of ["--control-height", "--control-height-sm"]) root.setProperty(token, size);
      const [g, b] = [group.getBoundingClientRect(), button.getBoundingClientRect()];
      return { group: g.height, top: b.top - g.top, bottom: g.bottom - b.bottom };
    };
    const shown = { styled: getComputedStyle(group).display === "inline-flex", normal: at("2.25rem"), touch: at("2.75rem") };
    for (const token of ["--control-height", "--control-height-sm"]) root.removeProperty(token);
    group.remove();
    return shown;
  });
  check(
    "InputGroup: a small button stays inside the group's border, at the touch-target size too",
    grouped.styled && !!grouped.normal && !!grouped.touch && [grouped.normal, grouped.touch].every((g) => g.top >= 1 && g.bottom >= 1),
    JSON.stringify(grouped),
  );
  await groupPage.close();
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
      // Whether the page sees the emulated preference, so a failure says if emulation applied.
      reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
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
  /**
   * The colors at points of a screenshot, each `[x, y]` a fraction of its width and height,
   * decoded on a page of the context the page check runs in.
   * @param {Buffer} shot
   * @param {[number, number][]} points
   */
  const colorsAt = async (shot, points) => {
    const blank = await orders.context().newPage();
    const at = await blank.evaluate(
      async ([png, points]) => {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        [canvas.width, canvas.height] = [img.width, img.height];
        const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
        g.drawImage(img, 0, 0);
        return points.map(([x, y]) => [...g.getImageData(Math.round((img.width - 1) * x), Math.min(img.height - 1, Math.floor(img.height * y)), 1, 1).data].slice(0, 3));
      },
      /** @type {[string, [number, number][]]} */ ([shot.toString("base64"), points]),
    );
    await blank.close();
    return at;
  };
  const sampled = async (/** @type {string} */ label, /** @type {number[]} */ xs) => {
    const probe = await (await browser.newContext({ forcedColors: "active", reducedMotion: "reduce" })).newPage();
    await probe.goto(`${base}/orders`);
    const forced = await probe.evaluate(() => matchMedia("(forced-colors: active)").matches);
    const shot = await probe.getByLabel(label).screenshot();
    await probe.context().close();
    return { forced, at: await colorsAt(shot, xs.map((x) => [x, 0.5])) };
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
  // Forced colors paints every background as the page's, so a control whose state is a fill would
  // look the same on and off. In each contrast palette (Firefox has one, whatever the scheme): a
  // checked Checkbox, a Switch that is on and a chosen Radio draw the system's selection color and
  // the unchecked ones do not; disabled and checked, they draw gray and no selection color; a focused
  // checked box and switch keep a ring in a system color; the current page in Pagination is
  // underlined, focused or not; a Slider's track shows against the page; a StatusDot does not
  // vanish (screenshots, on pages of their own as above).
  const statesName = "Checkbox, Switch, Radio, Pagination, Slider and StatusDot: under forced colors each state still shows";
  if (engine === "webkit") skip(statesName, "Playwright's WebKit does not emulate forced colors");
  for (const scheme of engine === "chromium" ? /** @type {const} */ (["light", "dark"]) : engine === "webkit" ? [] : /** @type {const} */ (["light"])) {
    const name = `${statesName} (${scheme})`;
    const shown = await (await browser.newContext({ forcedColors: "active", reducedMotion: "reduce", colorScheme: scheme })).newPage();
    await shown.goto(`${base}/`);
    const forced = await shown.evaluate(() => matchMedia("(forced-colors: active)").matches);
    // The palette's system colors, read from an element that sets them (CSSOM, which the CSP allows),
    // each with its alpha: Chromium's palette on Linux has a Highlight that is not opaque.
    const palette = await shown.evaluate(() =>
      Object.fromEntries(
        ["Highlight", "GrayText", "Canvas", "CanvasText", "ButtonText", "LinkText", "HighlightText"].map((c) => {
          const probe = document.body.appendChild(document.createElement("i"));
          probe.style.color = c;
          const [r, g, b, a] = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number) ?? [];
          probe.remove();
          return [c, [r, g, b, a ?? 1]];
        }),
      ),
    );
    /** A system color as drawn on the page: over Canvas when it is not opaque. @type {Record<string, number[]>} */
    const system = Object.fromEntries(
      Object.entries(palette).map(([c, [r, g, b, a]]) => [c, [r, g, b].map((v, i) => Math.round(v * a + palette.Canvas[i] * (1 - a)))]),
    );
    const near = (/** @type {number[]} */ a, /** @type {number[]} */ b) => a.every((c, i) => Math.abs(c - b[i]) <= 24);
    const grid = /** @type {[number, number][]} */ (Array.from({ length: 81 }, (_, i) => [(i % 9) / 8, Math.floor(i / 9) / 8]));
    /** @param {import("playwright").Locator} input @param {{ checked: boolean, disabled: boolean }} state */
    const drawn = async (input, state) => {
      // A disabled control is drawn at half opacity, which blends Firefox's CanvasText into its
      // GrayText: its shot is taken at full opacity (set through the CSSOM), so the two stay apart.
      await input.evaluate((el, state) => {
        Object.assign(/** @type {HTMLInputElement} */ (el), state);
        /** @type {HTMLElement} */ (el.parentElement).style.opacity = "1";
      }, state);
      const at = await colorsAt(await input.screenshot({ animations: "disabled" }), grid);
      await input.evaluate((el) => {
        /** @type {HTMLInputElement} */ (el).disabled = false;
        /** @type {HTMLElement} */ (el.parentElement).style.removeProperty("opacity");
      });
      return { selected: at.some((c) => near(c, system.Highlight)), gray: at.filter((c) => near(c, system.GrayText)).length };
    };
    /** @param {import("playwright").Locator} input */
    const states = async (input) => {
      const [on, off, disabledOn] = [await drawn(input, { checked: true, disabled: false }), await drawn(input, { checked: false, disabled: false }), await drawn(input, { checked: true, disabled: true })];
      // Gray on more of it than an unchecked one shows (Firefox's gray matches a border's smoothed
      // edge).
      return { on, off, disabledOn, ok: on.selected && !off.selected && disabledOn.gray > off.gray + 4 && !disabledOn.selected };
    };
    /** A focused, checked control's ring: solid, in a system color. @param {import("playwright").Locator} input */
    const ring = async (input) => {
      await input.evaluate((el) => { /** @type {HTMLInputElement} */ (el).checked = true; });
      await input.focus();
      await shown.keyboard.press("Shift");
      const style = await input.evaluate((el) => `${el.matches(":focus-visible")} ${getComputedStyle(el).outlineStyle} ${getComputedStyle(el).outlineColor}`);
      // In one of the system colors drawn against the page, as the palette has it (no transparency
      // of the kit's own): not Canvas or HighlightText.
      const [r, g, b, a] = style.match(/[\d.]+(?=[,)])/g)?.map(Number) ?? [];
      const systemDrawn = [palette.CanvasText, palette.Highlight, palette.ButtonText, palette.LinkText].some((c) => near([r, g, b], c) && Math.abs((a ?? 1) - c[3]) < 0.01);
      return { style, ok: style.startsWith("true solid") && systemDrawn && !near([r, g, b], palette.Canvas) };
    };
    const box = await states(shown.getByRole("checkbox", { name: "Canada" }));
    const boxRing = await ring(shown.getByRole("checkbox", { name: "Canada" }));
    const radio = await states(shown.getByRole("radio", { name: "Accept offers" }));
    await shown.goto(`${base}/orders`);
    const toggle = await states(shown.getByRole("switch", { name: "Email me when an order ships" }));
    const toggleRing = await ring(shown.getByRole("switch", { name: "Email me when an order ships" }));
    const pagesOf = () =>
      shown.locator("nav[class*='pagination'] a[class*='page']").evaluateAll((els) => els.map((el) => `${el.getAttribute("aria-current") ?? "-"} ${getComputedStyle(el).textDecorationLine}`));
    const pages = await pagesOf();
    await shown.locator("nav[class*='pagination'] [aria-current='page']").focus();
    await shown.keyboard.press("Shift");
    const focusedPages = await pagesOf();
    const underlined = (/** @type {string[]} */ p) => p.some((o) => o === "page underline") && p.every((o) => o.startsWith("page") || !o.includes("underline"));
    // The track's middle row past the thumb (at 2 of 1 to 5) against the row above the track.
    const xs = [0.45, 0.55, 0.65, 0.75, 0.85];
    const slider = await shown.getByLabel("Handling time (business days)").screenshot();
    const [mid, top] = [await colorsAt(slider, xs.map((x) => [x, 0.5])), await colorsAt(slider, xs.map((x) => [x, 0]))];
    const track = mid.every((c, i) => apart(c, top[i]));
    const dotAt = await colorsAt(await shown.locator("h1 ~ span > span[aria-hidden='true'][class*='status-dot__dot']").first().screenshot(), [[0.5, 0.5], [0, 0]]);
    const dot = near(dotAt[0], system.CanvasText) && apart(dotAt[0], dotAt[1]);
    await shown.context().close();
    const seen = JSON.stringify({ forced, system, box, boxRing, radio, toggle, toggleRing, pages, focusedPages, mid, top, dotAt });
    const ok = box.ok && boxRing.ok && radio.ok && toggle.ok && toggleRing.ok && underlined(pages) && underlined(focusedPages) && track && dot;
    if (forced) check(name, ok, seen);
    else if (engine === "chromium") check(`${name} (Chromium emulates forced colors)`, false, seen);
    else skip(name, "forced colors are not emulated here");
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
      forcedShots.push({ name: state.name, filled, shot: await probe.getByLabel("Sold this month").screenshot() });
    }
    await probe.context().close();
    /** @type {{ name: string, fill: number[], past: number[] }[]} */
    const forcedDrawn = [];
    for (const { name, filled, shot } of forcedShots) {
      const [fill, past] = await colorsAt(shot, [[filled / 2, 0.5], [(filled + 1) / 2, 0.5]]);
      forcedDrawn.push({ name, fill, past });
    }
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
  const stripes = await orders.getByLabel("Sending the next label").evaluate((p) => `${getComputedStyle(p).backgroundImage} (reduced motion seen: ${matchMedia("(prefers-reduced-motion: reduce)").matches})`);
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
    // The same table in a CardPanel the app places in its own grid, a flex row, a bare div in a grid
    // and an inline-block: the table's width is not its box's least width, so it scrolls in the
    // panel and the page does not (#796).
    const placed = await phone.locator("caption", { hasText: "This month's last sales" }).evaluate((caption) => {
      const box = /** @type {HTMLElement} */ (caption.closest("table")?.parentElement);
      return ["grid", "flex", "div", "inline-block"].map((place) => {
        const row = document.createElement("section");
        row.style.display = place === "flex" ? "flex" : place === "inline-block" ? "block" : "grid";
        const around = place === "div" ? row.appendChild(document.createElement("div")) : row;
        const panel = around.appendChild(document.createElement("div"));
        panel.className = "card__panel";
        if (place === "inline-block") panel.style.display = "inline-block";
        const table = /** @type {HTMLElement} */ (panel.appendChild(box.cloneNode(true)));
        document.querySelector("main")?.append(row);
        const inner = /** @type {HTMLTableElement} */ (table.querySelector("table"));
        const out = {
          place,
          scrolls: table.scrollWidth > table.clientWidth,
          // The table's box reaches its last cell (WebKit sized the box, and its rows, to the
          // scroller, with the cells running past them, without min-content).
          spans: inner.getBoundingClientRect().right + 1 >= /** @type {HTMLElement} */ ([...inner.rows[0].cells].at(-1)).getBoundingClientRect().right,
          panelFits: panel.getBoundingClientRect().right <= innerWidth + 0.5,
          page: document.documentElement.scrollWidth,
        };
        row.remove();
        return out;
      });
    });
    await phone.context().close();
    check("Table: in a ShownFor part on a phone, scrolls inside its card and the page does not", wide.scrolls && wide.cardFits && wide.page <= wide.width, JSON.stringify(wide));
    check("Table: in a CardPanel in an app's grid, flex row, a div in a grid or an inline-block on a phone, scrolls inside the panel and the page does not", placed.every((p) => p.scrolls && p.spans && p.panelFits && p.page <= wide.width), JSON.stringify(placed));
  }
  // A stacked table (the orders, TableLayout::Stack): at the desktop's width its cells' labels are
  // hidden. On a phone each order is a block of its cells, each label with what follows it on its
  // line, and the page does not scroll sideways, also with a row header, a long value, a cell of
  // text and an element, and a cell with no label (added here). The headers hold the sort link, so
  // they stay drawn, and in Chromium's accessibility tree it is still a table whose cells are not
  // named by the labels. An element after a label (the kit's Button, an app's pill) is as wide on a
  // phone as at the desktop's width, not stretched across the value column.
  {
    const hidden = await orders.evaluate(() => [...document.querySelectorAll("[class*='table__label']")].map((l) => getComputedStyle(l).display));
    /**
     * Adds two cells to the first order and reads them. A labelled one holds the kit's `Button`
     * (the orders page's own), a pill with no width of its own, a long word in a padded
     * content-box span, a button with the kit's `Tip` popover open beside it, and a kit `Dialog`
     * (`DialogSize::Sm`) open as a modal. A cell with no label holds a block. Returns the button's
     * and pill's widths, whether the word stays in the cell, where the popover is placed against
     * its control and its width (there and outside the table), the dialog's width (there and
     * outside the table), and whether the block fills its cell.
     * @param {import("@playwright/test").Page} page
     */
    const widths = (page) =>
      page.evaluate(async () => {
        const table = [...document.querySelectorAll("table")].find((t) => /^Page /.test(t.caption?.textContent ?? ""));
        const row = /** @type {HTMLTableRowElement} */ (table?.tBodies[0]?.rows[0]);
        const label = /** @type {Element} */ (row.querySelector("[class*='table__label']")).cloneNode(true);
        label.textContent = "Actions";
        const kit = /** @type {Element} */ (document.querySelector("[class*='button__button']"));
        const open = Object.assign(document.createElement("a"), { href: "#open", className: kit.className, textContent: "Open" });
        const pill = Object.assign(document.createElement("span"), { textContent: "Shipped" });
        pill.style.cssText = "display: inline-block; padding: 0 .5rem; border: 1px solid";
        const long = Object.assign(document.createElement("span"), { textContent: "acct_7f3a9c2e5b1d4f8a6c0e2b9d7a5f3c1e_7f3a9c2e5b1d4f8a" });
        long.style.cssText = "display: inline-block; box-sizing: content-box; padding: 0 .5rem; border: 1px solid";
        const shows = Object.assign(document.createElement("button"), { type: "button", textContent: "Why" });
        const tip = Object.assign(document.createElement("span"), { id: "stack-tip", className: "tip__tip", textContent: "A short reason" });
        tip.popover = "manual";
        const dialog = Object.assign(document.createElement("dialog"), { className: "dialog__dialog dialog__sm", textContent: "Refund this order? The buyer is told at once." });
        const cell = document.createElement("td");
        cell.append(label, open, pill, long, shows, tip, dialog);
        row.append(cell);
        const bare = document.createElement("td");
        const block = document.createElement("div");
        block.textContent = "Ships Monday";
        bare.append(block);
        row.append(bare);
        /** Where the tip shows beside the button: its center against the button's, and its width. */
        const placed = () => {
          tip.showPopover({ source: shows });
          const [t, s] = [tip.getBoundingClientRect(), shows.getBoundingClientRect()];
          tip.hidePopover();
          return [Math.round(t.left + t.width / 2 - (s.left + s.width / 2)), Math.round(t.width)];
        };
        /** The dialog's width, opened as a modal. */
        const modal = () => {
          dialog.showModal();
          const width = Math.round(dialog.getBoundingClientRect().width);
          dialog.close();
          return width;
        };
        const padding = parseFloat(getComputedStyle(bare).paddingLeft) + parseFloat(getComputedStyle(bare).paddingRight);
        const got = {
          sizes: [open, pill].map((e) => Math.round(e.getBoundingClientRect().width)),
          word: long.getBoundingClientRect().right <= cell.getBoundingClientRect().right + 0.5,
          block: Math.abs(block.getBoundingClientRect().width - (bare.clientWidth - padding)) <= 1,
          tip: placed(),
          tipOutside: [0, 0],
          dialog: [modal(), 0],
        };
        cell.remove();
        bare.remove();
        document.body.append(shows, tip, dialog);
        got.tipOutside = placed();
        got.dialog[1] = modal();
        shows.remove();
        tip.remove();
        dialog.remove();
        return got;
      });
    const wide = await widths(orders);
    check("Table: a stacked table's cell labels are hidden at the desktop's width", hidden.length > 0 && hidden.every((d) => d === "none"), JSON.stringify(hidden));
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await phone.goto(`${base}/orders`);
    const table = phone.locator("table", { has: phone.locator("caption", { hasText: /^Page / }) });
    const stacked = await table.evaluate((t) => {
      const body = /** @type {HTMLTableSectionElement} */ (t.tBodies[0]);
      const first = /** @type {HTMLTableRowElement} */ (body.rows[0]);
      const label = /** @type {HTMLElement} */ (first.querySelector("[class*='table__label']"));
      // A row the app might write: a row header with a long name, text and an element in one cell,
      // and a cell with no label.
      const extra = /** @type {HTMLTableRowElement} */ (first.cloneNode(true));
      const head = document.createElement("th");
      head.scope = "row";
      head.append(label.cloneNode(true), "Annabelle Kensington-Featherstonehaugh of acct_7f3a9c2e5b1d4f8a6c0e2b9d7a5f3c1e");
      extra.cells[0].replaceWith(head);
      const mixed = /** @type {HTMLTableCellElement} */ (extra.cells[1]);
      mixed.replaceChildren(label.cloneNode(true), "Max ", Object.assign(document.createElement("small"), { textContent: "(annual)" }));
      const bare = document.createElement("td");
      bare.append(Object.assign(document.createElement("button"), { type: "button", textContent: "Refund this order now" }));
      extra.append(bare);
      body.append(extra);
      // A row whose first cell is a row header holding a text cell's label and text (Card's): its
      // line is as tall as that cell's, not a column header's 2.5rem.
      const headed = /** @type {HTMLTableRowElement} */ (first.cloneNode(true));
      const short = document.createElement("th");
      short.scope = "row";
      short.append(...[...first.cells[1].childNodes].map((n) => n.cloneNode(true)));
      headed.cells[0].replaceWith(short);
      body.append(headed);
      /** @param {Element} cell */
      const beside = (cell) => {
        const tag = cell.querySelector("[class*='table__label']");
        if (!tag) return "-";
        const range = document.createRange();
        range.setStartAfter(tag);
        range.setEnd(cell, cell.childNodes.length);
        const [l, v] = [tag.getBoundingClientRect(), range.getBoundingClientRect()];
        return v.left >= l.right - 0.5 && v.top < l.bottom ? "beside" : `${Math.round(l.right)}/${Math.round(l.bottom)} ${Math.round(v.left)}/${Math.round(v.top)}`;
      };
      const cells = [...first.cells];
      const shown = cells.map((td) => {
        const tag = td.querySelector("[class*='table__label']");
        return tag && getComputedStyle(tag).display !== "none" && tag.getAttribute("aria-hidden") === "true" ? tag.textContent : "-";
      });
      const button = bare.firstElementChild?.getBoundingClientRect();
      const wrapper = /** @type {HTMLElement} */ (t.parentElement);
      // How far into its box each label's text starts: the same for a number's cell (Total).
      const indent = cells.map((td) => {
        const tag = td.querySelector("[class*='table__label']");
        if (!tag) return "-";
        const text = document.createRange();
        text.selectNodeContents(tag);
        return Math.round(text.getBoundingClientRect().left - tag.getBoundingClientRect().left);
      });
      // And where the number starts in its column: at the start, as text does, not at the end.
      const total = /** @type {HTMLTableCellElement} */ (first.cells[3]);
      const totalTag = /** @type {Element} */ (total.querySelector("[class*='table__label']"));
      const value = document.createRange();
      value.setStartAfter(totalTag);
      value.setEnd(total, total.childNodes.length);
      const number = Math.round(value.getBoundingClientRect().left - (totalTag.getBoundingClientRect().right + parseFloat(getComputedStyle(total).columnGap)));
      const out = {
        row: getComputedStyle(first).display,
        labels: shown.join(),
        beside: cells.map(beside).join(),
        indent: indent.join(),
        number,
        extra: [head, mixed].map(beside).join(),
        bare: !!button && Math.round(button.left - bare.getBoundingClientRect().left) <= 12,
        head: Math.round(/** @type {HTMLElement} */ (t.tHead).getBoundingClientRect().height),
        rowHeader: [short, first.cells[1]].map((c) => Math.round(c.getBoundingClientRect().height)).join(),
        // The long row header's text, which wraps, stays inside its box.
        longFits: (() => {
          const text = document.createRange();
          text.selectNodeContents(head);
          return text.getBoundingClientRect().bottom <= head.getBoundingClientRect().bottom + 0.5;
        })(),
        page: document.documentElement.scrollWidth <= innerWidth,
        wrapper: wrapper.scrollWidth <= wrapper.clientWidth,
      };
      extra.remove();
      headed.remove();
      return out;
    });
    check(
      "Table: on a phone a stacked table's rows are blocks of labelled cells inside the page, the labels lined up (a number's too), a row header (as tall as a cell, a long one holding its text) and mixed content too",
      stacked.row === "grid" &&
        stacked.labels === "Buyer,Card,Status,Total,-" &&
        stacked.beside === "beside,beside,beside,beside,-" &&
        stacked.indent === "0,0,0,0,-" &&
        Math.abs(stacked.number) <= 1 &&
        stacked.extra === "beside,beside" &&
        stacked.rowHeader.split(",")[0] === stacked.rowHeader.split(",")[1] &&
        stacked.longFits &&
        stacked.bare &&
        stacked.page &&
        stacked.wrapper,
      JSON.stringify(stacked),
    );
    const narrow = await widths(phone);
    // A small tablet, still stacked: wide enough that a dialog's own max-width, not the window,
    // sets its width, so a rule that overrode it would show.
    await phone.setViewportSize({ width: 600, height: 844 });
    const tablet = await widths(phone);
    await phone.setViewportSize({ width: 390, height: 844 });
    check(
      "Table: stacked, an element after a cell's label (a Button, a pill) is as wide as at the desktop's width, a padded long word stays in the cell, a tooltip there is centered on its control at its own width, a dialog there is as wide as outside the table (at 390 and 600px), and a block in a cell with no label fills it",
      wide.sizes.every((w, i) => w > 0 && Math.abs(w - narrow.sizes[i]) <= 1) &&
        narrow.word &&
        narrow.block &&
        Math.abs(narrow.tip[0]) <= 1 &&
        Math.abs(narrow.tip[1] - narrow.tipOutside[1]) <= 1 &&
        [narrow, tablet].every((r) => r.dialog[0] > 0 && Math.abs(r.dialog[0] - r.dialog[1]) <= 1),
      JSON.stringify({ wide, narrow, tablet: tablet.dialog }),
    );
    const sorter = await table.locator("thead a").first().evaluate((a) => {
      const box = a.getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height), inside: box.left >= 0 && box.right <= innerWidth };
    });
    check("Table: on a phone a stacked table's sort link is drawn, so it sorts by touch", stacked.head > 1 && sorter.width > 1 && sorter.height > 1 && sorter.inside, JSON.stringify({ head: stacked.head, ...sorter }));
    const rolesName = "Table: stacked, the accessibility tree still has a table, its column headers and cells, which the labels do not name";
    if (engine === "chromium") {
      const cdp = await phone.context().newCDPSession(phone);
      const { nodes } = await cdp.send("Accessibility.getFullAXTree");
      const named = (/** @type {string} */ role) => nodes.filter((n) => n.role?.value === role && !n.ignored).map((n) => String(n.name?.value ?? ""));
      const tree = { tables: named("table").length, headers: named("columnheader").join("|"), cells: named("cell").slice(0, 4).join("|") };
      check(
        rolesName,
        tree.tables >= 1 && tree.headers.includes("Buyer") && tree.cells !== "" && !/(^|\|)(Buyer|Card|Status|Total) /.test(tree.cells),
        JSON.stringify(tree),
      );
    } else skip(rolesName, "Playwright reads the accessibility tree only through Chromium's DevTools protocol");
    await phone.context().close();
  }
  // A dialog's size and header, and a sheet's width and header: a long one scrolls with its header
  // held at the top (rows are added on the page to make it long).
  {
    /** @param {Element} box What scrolls: the dialog or the sheet. */
    const heldHeader = (box) => {
      // Rows a user can focus, so moving focus up the long box is checked (focusUp, below); they
      // stay until then.
      const rows = Array.from({ length: 40 }, (_, i) => Object.assign(document.createElement("button"), { type: "button", textContent: `Row ${i}` }));
      rows.forEach((row) => row.setAttribute("data-smoke-row", ""));
      // A part that scrolls on its own (a table's wrapper) keeps its content's height.
      const wrap = Object.assign(document.createElement("div"), { style: "overflow-x: auto" });
      wrap.append(Object.assign(document.createElement("p"), { textContent: "A wide row ".repeat(40), style: "white-space: nowrap; margin: 0" }));
      wrap.setAttribute("data-smoke-row", "");
      box.append(wrap, ...rows);
      box.scrollTop = box.scrollHeight;
      const header = /** @type {HTMLElement} */ (box.querySelector(":scope > [class*='__header']"));
      const at = header.getBoundingClientRect().top - box.getBoundingClientRect().top;
      // What is drawn just under the header's middle is the header, not a row scrolled under it.
      const r = header.getBoundingClientRect();
      // and is painted opaque, so a row scrolled under it does not show through.
      const fill = getComputedStyle(header).backgroundColor;
      const onTop = header.contains(document.elementFromPoint(r.left + 4, r.top + r.height / 2)) && fill !== "transparent" && !/rgba\(.*, 0\)$/.test(fill);
      const kept = wrap.getBoundingClientRect().height >= 10;
      const scrolled = box.scrollTop > 0;
      // The layout width in rem (offsetWidth, which the opening animation's scale does not change).
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      rows[rows.length - 1].focus();
      return { width: Math.round((/** @type {HTMLElement} */ (box).offsetWidth / rem) * 100) / 100, window: Math.round((innerWidth / rem) * 100) / 100, scrolled, at: Math.round(at), onTop, kept, covered: 0 };
    };
    /**
     * Moves focus up the long box from its last row with Shift+Tab, as a user does (WebKit does
     * not scroll a dialog for a script's focus()), counting the rows that land under the held
     * header and those it reached; then removes the rows.
     * @param {import("@playwright/test").Page} page
     * @param {string} selector The dialog or sheet.
     */
    const focusUp = async (page, selector) => {
      let covered = 0;
      let reached = 0;
      for (let i = 0; i < 39; i++) {
        await page.keyboard.press("Shift+Tab");
        const [row, under] = await page.locator(selector).evaluate((box) => {
          const header = /** @type {HTMLElement} */ (box.querySelector(":scope > [class*='__header']"));
          const now = document.activeElement;
          const row = !!now?.hasAttribute("data-smoke-row");
          return [row, row && /** @type {Element} */ (now).getBoundingClientRect().top < header.getBoundingClientRect().bottom - 1];
        });
        if (row) reached += 1;
        if (under) covered += 1;
      }
      await page.locator(selector).evaluate((box) => {
        box.querySelectorAll("[data-smoke-row]").forEach((row) => row.remove());
        box.scrollTop = 0;
      });
      // Every Shift+Tab lands on a row, so a covered count of 0 is a measurement.
      return reached === 39 ? covered : -1;
    };
    for (const width of [1280, 390]) {
      const at = await (await browser.newContext({ viewport: { width, height: 600 } })).newPage();
      await at.goto(`${base}/`);
      await at.getByRole("button", { name: "All sales" }).click();
      await at.waitForFunction(() => document.querySelector("#sales")?.matches(":modal"), null, { timeout: 5000 }).catch(() => {});
      // Measured once it has finished opening (its animation moves it).
      await at.locator("#sales").evaluate((d) => Promise.all(d.getAnimations().map((a) => a.finished)));
      const shown = await at.locator("#sales").evaluate(heldHeader);
      shown.covered = await focusUp(at, "#sales");
      // 48rem, or the window less 2rem when that is narrower.
      const want = Math.min(48, shown.window - 2);
      check(`Dialog: DialogSize::Lg at ${width}px is ${width === 1280 ? "48rem" : "the window less 2rem"} wide, and long, it scrolls with its header held and focus never under it`, Math.abs(shown.width - want) <= 0.1 && shown.scrolled && shown.at >= 0 && shown.at <= 2 && shown.onTop && shown.kept && shown.covered === 0, JSON.stringify(shown));
      if (width === 1280) {
        // Its close button is a ButtonSize::Icon one, named by aria-label: a square at the
        // control's height with the Icon centered in it.
        const close = await at.locator("#sales > [class*='dialog__header']").getByRole("button", { name: "Close" }).evaluate((b) => {
          const [o, i] = [b.getBoundingClientRect(), /** @type {Element} */ (b.querySelector("svg")).getBoundingClientRect()];
          const height = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--control-height")) * parseFloat(getComputedStyle(document.documentElement).fontSize);
          return { size: [Math.round(o.width), Math.round(o.height)], want: Math.round(height), off: [i.left + i.width / 2 - (o.left + o.width / 2), i.top + i.height / 2 - (o.top + o.height / 2)] };
        });
        check("Icon: centered in a ButtonSize::Icon button, a square at the control's height", close.size[0] === close.want && close.size[1] === close.want && close.off.every((d) => Math.abs(d) <= 1), JSON.stringify(close));
        await at.locator("#sales > [class*='dialog__header']").getByRole("button", { name: "Close" }).click();
        check("Dialog: the header's close button closes it", !(await at.locator("#sales").evaluate((d) => /** @type {HTMLDialogElement} */ (d).open)));
        await at.getByRole("link", { name: "Last sale" }).click({ noWaitAfter: true });
        await at.waitForFunction(() => document.querySelector('dialog[aria-label="Last sale"]')?.matches(":modal"), null, { timeout: 5000 }).catch(() => {});
        await at.locator('dialog[aria-label="Last sale"]').evaluate((d) => Promise.all(d.getAnimations().map((a) => a.finished)));
        const side = await at.locator('dialog[aria-label="Last sale"]').evaluate(heldHeader);
        side.covered = await focusUp(at, 'dialog[aria-label="Last sale"]');
        check("Sheet: Side::Right(SheetWidth::Md) is 24rem wide, and long, it scrolls with its header held and focus never under it", Math.abs(side.width - 24) <= 0.1 && side.scrolled && side.at >= 0 && side.at <= 2 && side.onTop && side.kept && side.covered === 0, JSON.stringify(side));
      }
      await at.context().close();
    }
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
    // An Icon after a choice's input, beside its label, as beside a button's text (#793).
    const radioIcon = await sizes.locator("label", { hasText: "Letter" }).evaluate(besideText);
    check("SegmentedRadios: an icon beside a choice's label is the kit's gap apart and on its middle", spacedLikeButton(radioIcon), JSON.stringify(radioIcon));
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
  // The kit's Stepper draws NumberField's buttons only with the script; the input is the control,
  // with its own spin buttons for a mouse or a touch.
  const plainField = plain.locator("[data-scope=ui-number-field]").first();
  const plainSteps = [
    ...(await plainField.locator("button").evaluateAll((buttons) => buttons.map((b) => getComputedStyle(b).display))),
    String(await plainField.locator("input").isVisible()),
  ];
  // A click on the upper half of the input's own spin button steps it (14 px in from its right
  // edge is on that button in all three engines).
  const plainInput = plainField.locator("input");
  const plainWas = await plainInput.inputValue();
  await plainInput.fill("5");
  const plainBox = /** @type {{ x: number, y: number, width: number, height: number }} */ (await plainInput.boundingBox());
  await plain.mouse.click(plainBox.x + plainBox.width - 14, plainBox.y + plainBox.height * 0.3);
  plainSteps.push(await plainInput.inputValue());
  await plainInput.fill(plainWas);
  check(
    "no script: a NumberField's step buttons are not drawn, its input is, and its own spin button steps it",
    plainSteps.join() === "none,none,true,6",
    plainSteps.join(),
  );
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
  // A client that skips the inputs' min, max and step is refused by the handler with the same bounds.
  await plain.goto(`${base}/`);
  await plain.locator("[data-scope=ui-combo-box] select").selectOption("lp");
  const pastBounds = await plain.evaluate(() => {
    const form = /** @type {HTMLFormElement} */ (document.querySelector('form[action$="/sell"]'));
    form.noValidate = true;
    for (const [id, value] of [["qty", "11"], ["weight", "0.55"]]) {
      const input = /** @type {HTMLInputElement} */ (document.getElementById(id));
      input.removeAttribute("max");
      input.step = "any";
      input.value = value;
    }
    return [form.checkValidity(), document.getElementById("qty")?.getAttribute("min")].join(" ");
  });
  await Promise.all([plain.waitForURL("**/sell"), plain.getByRole("button", { name: "List for sale" }).click()]);
  const refusedBounds = (await plain.textContent("#result")) ?? "";
  check("no script: a quantity past the input's bounds is refused by the handler with them", pastBounds === "true 1" && refusedBounds === "List from 1 to 10 copies.", `${pastBounds} ${refusedBounds}`);
  check("no script: the refused form is drawn again with the numbers as sent", (await plain.inputValue("#qty")) === "11" && (await plain.inputValue("#weight")) === "0.55", `${await plain.inputValue("#qty")} ${await plain.inputValue("#weight")}`);
  // A whole number a number input sends as 2.0 is 2 (#842); text that is no number is the field's
  // message and the form again, not the error page (#846).
  /** @param {string} qty */
  const postQty = async (qty) => {
    await plain.goto(`${base}/`);
    await plain.locator("[data-scope=ui-combo-box] select").selectOption("lp");
    await plain.evaluate((qty) => {
      /** @type {HTMLFormElement} */ (document.querySelector('form[action$="/sell"]')).noValidate = true;
      const input = /** @type {HTMLInputElement} */ (document.getElementById("qty"));
      input.type = "text";
      input.value = qty;
    }, qty);
    const [answer] = await Promise.all([
      plain.waitForResponse((r) => r.url().endsWith("/sell") && r.request().method() === "POST"),
      plain.waitForURL("**/sell"),
      plain.getByRole("button", { name: "List for sale" }).click(),
    ]);
    await plain.waitForLoadState();
    // The text as sent is the input's value attribute; a number input shows text that is no number as empty.
    return `${answer.status()} ${(await plain.textContent("#result")) ?? ""} ${await plain.getAttribute("#qty", "value")}`;
  };
  const whole = await postQty("2.0");
  check("no script: a quantity sent as 2.0 is listed as 2", whole.startsWith("200 Listed 2 Lightly Played"), whole);
  const unreadable = await postQty("two");
  check("no script: a quantity that is no number is the form with its message and what was sent", unreadable === "422 List from 1 to 10 copies. two", unreadable);
  // The page shows the first message, so the weight's off-step decimal is posted on its own.
  await plain.goto(`${base}/`);
  await plain.locator("[data-scope=ui-combo-box] select").selectOption("lp");
  await plain.evaluate(() => {
    /** @type {HTMLFormElement} */ (document.querySelector('form[action$="/sell"]')).noValidate = true;
    const weight = /** @type {HTMLInputElement} */ (document.getElementById("weight"));
    weight.step = "any";
    weight.value = "0.55";
  });
  await Promise.all([plain.waitForURL("**/sell"), plain.getByRole("button", { name: "List for sale" }).click()]);
  const offStep = (await plain.textContent("#result")) ?? "";
  check("no script: a weight between the input's steps is refused by the handler", offStep === "Enter a weight from 0.1 to 16 oz, in tenths.", offStep);
  await plain.goto(`${base}/`);
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
  await plain.goto(`${base}/`);
  await Promise.all([plain.waitForURL("**/publish"), plain.getByRole("button", { name: "Publish", exact: true }).click()]);
  {
    const failed = await plain.locator("#ui-toast").evaluate((m) => ({ text: m.textContent, marked: m.hasAttribute("data-failed"), shown: !(/** @type {HTMLElement} */ (m).hidden) }));
    check("no script: an action's failed Toast is in the page, marked", failed.shown && failed.marked && !!failed.text?.startsWith("Not published"), JSON.stringify(failed));
  }
  await plain.goto(`${base}/`);
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
