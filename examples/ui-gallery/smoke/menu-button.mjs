import { base, check } from "./helpers.mjs";
import { liveRegion } from "../../../scripts/smoke/live-region.mjs";

export async function menuButton(page, errors) {
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
  // Put the real MenuButton at the viewport's bottom: its component-local option, not the
  // built-in flip-block tactic, must move the menu above the button.
  await trigger.evaluate((button) => button.scrollIntoView({ block: "end" }));
  // Right after the scroll the menu can still be drawn where it was, which is above the moved
  // button too, before the browser chooses a position option again: wait for the menu against
  // the button's top with the option applied, and report what there is if that never comes.
  // (Both are functions, not strings: the page's Trusted Types policy refuses a string eval.)
  const placed = () => {
    const button = document.querySelector("#actions-button");
    const menu = document.querySelector("#actions");
    if (!button || !menu) return null;
    const b = button.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const style = getComputedStyle(menu);
    return { names: style.positionTryFallbacks, area: style.positionArea, gap: b.top - m.bottom, atBottom: b.bottom >= innerHeight - 1 };
  };
  await page
    .waitForFunction(
      () => {
        const button = document.querySelector("#actions-button")?.getBoundingClientRect();
        const menu = document.querySelector("#actions");
        if (!button || !menu) return false;
        const gap = button.top - menu.getBoundingClientRect().bottom;
        return button.bottom >= innerHeight - 1 && gap >= 0 && gap <= 8 && getComputedStyle(menu).positionArea.includes("start");
      },
      null,
      { timeout: 10_000 },
    )
    .catch(() => {});
  const fallback = await page.evaluate(placed);
  check(
    "the menu uses its component-local @position-try when below overflows",
    !!fallback && fallback.atBottom && fallback.gap >= 0 && fallback.gap <= 8 && fallback.names.includes("--gallery__above") && fallback.area.includes("start"),
    JSON.stringify(fallback),
  );
  await page.keyboard.press("ArrowDown");
  check("Arrow Down moves", (await page.evaluate(() => document.activeElement?.textContent)) === "Archive");
  await page.keyboard.press("ArrowDown");
  check("a disabled item is passed over", (await page.evaluate(() => document.activeElement?.textContent)) === "Rename…");
  await page.keyboard.press("w");
  check("typing a letter moves to the item", (await page.evaluate(() => document.activeElement?.textContent)) === "Watch");
  const focused = () => page.evaluate(() => document.activeElement?.textContent);
  await page.keyboard.press("ArrowDown");
  check("Arrow Down from the last item wraps to the first", (await focused()) === "Help", await focused());
  await page.keyboard.press("ArrowUp");
  check("Arrow Up from the first item wraps to the last", (await focused()) === "Watch", await focused());
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  check("Arrow Up moves back, past a disabled item", (await focused()) === "Archive", await focused());
  await page.keyboard.press("End");
  check("End moves to the last item", (await focused()) === "Watch", await focused());
  // Home from an item in the middle, where neither arrow goes to the first.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Home");
  check("Home moves to the first", (await focused()) === "Help", await focused());
  await page.keyboard.press("Escape");
  await expanded("false");
  check("Escape closes and returns focus", (await trigger.getAttribute("aria-expanded")) === "false" && (await page.evaluate(() => document.activeElement?.textContent)) === "More actions");
  await page.keyboard.press("ArrowUp");
  await expanded("true");
  check("Arrow Up on the button opens at the last item", (await page.evaluate(() => document.activeElement?.textContent)) === "Watch");
  await page.keyboard.press("Escape");
  await expanded("false");
  await page.keyboard.press("ArrowDown");
  await expanded("true");
  await page.keyboard.press("Tab");
  await expanded("false");
  // Where Tab lands is the browser's (WebKit passes over links), so only that it left the menu.
  const left = await page.evaluate(() => {
    const at = document.activeElement;
    return !!at && at !== document.body && !at.closest("[data-scope=ui-menu-button]") && !document.querySelector("#actions")?.matches(":popover-open");
  });
  check("Tab closes the menu and moves on from it", left);
  await trigger.click();
  await expanded("true");
  const menuErrors = errors.length;
  await page.getByRole("menuitem", { name: "Archive" }).evaluate((button) => {
    const form = button.closest("form");
    const field = document.createElement("input");
    field.type = "hidden";
    field.name = "closest";
    form.append(field);
    // A click on the form itself (not on its button) should leave the menu open.
    form.click();
    field.remove();
  });
  check("MenuButton: clicking a form with a control named closest leaves the menu open without throwing",
    (await trigger.getAttribute("aria-expanded")) === "true" && errors.length === menuErrors, errors.slice(menuErrors).join(" | "));
  await page.keyboard.press("Escape");
  await expanded("false");
  await trigger.click();
  const { stayed: regionStayed } = await liveRegion(page, "menu-result");
  await page.getByRole("menuitem", { name: "Archive" }).click();
  await page.waitForFunction(() => document.querySelector("#menu-result")?.textContent === "Archived.");
  check("a form item posts and patches", true);
  check("a menu action keeps the live region and replaces its message", await regionStayed());
  await expanded("false");
  check("using an item closes the menu", (await trigger.getAttribute("aria-expanded")) === "false");
  // Enter and Space on a focused item are the browser's click on it: the menu's keys (a letter
  // moves to an item) must leave both alone.
  // Each wait is caught, so a key that does nothing is a named failure, and whatever it left open
  // is closed before the checks after it.
  const within = (/** @type {() => boolean} */ holds) => page.waitForFunction(holds, null, { timeout: 10_000 }).then(() => true, () => false);
  const closed = () => within(() => document.querySelector("#actions-button")?.getAttribute("aria-expanded") === "false");
  const nothingOpen = () => page.waitForFunction(() => !document.querySelector("dialog[open]") && !document.querySelector("#actions")?.matches(":popover-open"));
  await trigger.click();
  await expanded("true");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  const watched = await within(() => document.querySelector("#menu-result")?.textContent === "Watching.");
  check("Enter on a focused item uses it and closes the menu", watched && (await closed()), await page.locator("#menu-result").textContent());
  if ((await trigger.getAttribute("aria-expanded")) === "true") await page.keyboard.press("Escape");
  await nothingOpen();
  await trigger.click();
  await expanded("true");
  await page.keyboard.press("r");
  await page.keyboard.press("Space");
  const renaming = await within(() => /** @type {HTMLDialogElement | null} */ (document.querySelector("dialog[aria-label='Rename the draft']"))?.open === true);
  check("Space on a focused item uses it and closes the menu", renaming && (await closed()), await focused());
  await page.keyboard.press("Escape");
  await nothingOpen();
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
}

export async function rowMenus(orders, browser) {
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
}
