import { base, skip, check } from "./helpers.mjs";

export async function checkboxGroup(page, browser, bug, errors) {
  // CheckboxGroup: no region checked stops the form at the group's first box.
  const lastResult = await page.textContent("#result");
  const sellValid = () => page.evaluate(() => /** @type {HTMLFormElement} */ (document.querySelector('form[method=post][action="/"]')).checkValidity());
  const shipsValid = () => page.evaluate(() => Array.from(document.querySelectorAll('form[method=post][action="/"] fieldset input[type="checkbox"]')).every((box) => /** @type {HTMLInputElement} */ (box).checkValidity()));
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
  // A script that sets checked sends no change, so the group keeps its answer until the script
  // dispatches input and change on each box it set, as the CheckboxGroup doc says. The filled step
  // sets only the last box, so the group answers a change from a box other than its first.
  const scripted = await page.evaluate(() => {
    const boxes = /** @type {HTMLInputElement[]} */ (Array.from(document.querySelectorAll('form[method=post][action="/"] fieldset input[type="checkbox"]')));
    const was = boxes.map((b) => b.checked);
    const valid = () => boxes.every((b) => b.checkValidity());
    /** @param {HTMLInputElement[]} set */
    const tell = (set) => {
      for (const b of set) {
        b.dispatchEvent(new Event("input", { bubbles: true }));
        b.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };
    for (const b of boxes) b.checked = false;
    const cleared = valid();
    tell(boxes);
    const clearedTold = valid();
    const last = /** @type {HTMLInputElement} */ (boxes.at(-1));
    last.checked = true;
    const filled = valid();
    const message = boxes[0].validationMessage;
    tell([last]);
    const filledTold = valid();
    for (const [i, b] of boxes.entries()) b.checked = was[i];
    tell(boxes);
    return { count: boxes.length, cleared, clearedTold, filled, message, filledTold, back: valid() };
  });
  check(
    "CheckboxGroup: boxes a script sets keep the group's old answer until it dispatches input and change on them (cleared: valid, then refused; last box filled: refused with the app's message, then valid)",
    scripted.count > 1 && scripted.cleared && !scripted.clearedTold && !scripted.filled && scripted.message === "Choose where you ship." && scripted.filledTold && scripted.back,
    JSON.stringify(scripted),
  );
  // Back to a page the runtime swapped in brings back a box a script set with input and change,
  // and one it set without them as drawn (the runtime keeps only fields it saw an event on). On a
  // page of its own, so the form above keeps its state; only where the Navigation API is, which
  // the runtime's back/forward needs.
  const navContext = await browser.newContext();
  const nav = await navContext.newPage();
  nav.on("console", (m) => m.type() === "error" && !bug(m.text()) && errors.push(m.text()));
  nav.on("pageerror", (e) => errors.push(e.message));
  await nav.goto(`${base}/`);
  const galleryTitle = await nav.title();
  const backCheck = "CheckboxGroup: back to a swapped page keeps a box a script set with input and change, and brings one set without them back as drawn";
  if (await nav.evaluate(() => "navigation" in window)) {
    const set = await nav.evaluate(() => {
      const boxes = /** @type {HTMLInputElement[]} */ (Array.from(document.querySelectorAll('form[method=post][action="/"] fieldset input[type="checkbox"]')));
      const [told, untold] = boxes.filter((b) => !b.defaultChecked);
      told.checked = true;
      told.dispatchEvent(new Event("input", { bubbles: true }));
      told.dispatchEvent(new Event("change", { bubbles: true }));
      untold.checked = true;
      (/** @type {any} */ (window)).__sameDocument = 1;
      return { told: told.value, untold: untold.value };
    });
    // Wait for each page's title, not its address: without NavigationPrecommitController the
    // runtime moves the address at the click, before the page is drawn, and a Back taken then, or
    // read before the page it brings back is in, reads the old <main>.
    const drawn = (/** @type {string} */ title) => !!document.querySelector("main") && document.title === title && !document.querySelector("main[aria-busy]");
    await nav.getByRole("link", { name: "Orders", exact: true }).first().click();
    const left = await nav.waitForFunction(drawn, "Orders | corten-ui", { timeout: 10000 }).then(() => true, () => false);
    // Back from the page, as the runtime's smoke takes it: Playwright's Linux WebKit loses the page
    // when it drives a traverse the runtime intercepts.
    await nav.evaluate(() => history.back());
    const back = left && (await nav.waitForFunction(drawn, galleryTitle, { timeout: 10000 }).then(() => true, () => false));
    const after = await nav.evaluate(({ told, untold }) => {
      const box = (/** @type {string} */ value) => /** @type {HTMLInputElement | null} */ (document.querySelector(`form[method=post][action="/"] fieldset input[type="checkbox"][value="${value}"]`));
      return { swapped: (/** @type {any} */ (window)).__sameDocument === 1, told: box(told)?.checked, untold: box(untold)?.checked };
    }, set);
    check(backCheck, left && back && after.swapped && after.told === true && after.untold === false, JSON.stringify({ left, back, set, after }));
  } else skip(backCheck, "no Navigation API: a navigation is a full page load");
  await navContext.close();
  await us.uncheck();
  const shipMessage = await us.evaluate((i) => /** @type {HTMLInputElement} */ (i).validationMessage);
  await page.getByRole("button", { name: "List for sale" }).click();
  await page.waitForTimeout(300);
  check("a group with no box checked stops the form at its first box, with the app's message", shipMessage === "Choose where you ship." && !(await sellValid()) && (await page.textContent("#result")) === lastResult, shipMessage);
  // From the keyboard: Firefox's message for the refused box sits over the next box, and a click
  // there only closes the message, as it would for a user.
  await page.getByRole("checkbox", { name: "Canada" }).press("Space");
  check("one box checked, the group is valid", (await us.evaluate((i) => /** @type {HTMLInputElement} */ (i).validationMessage)) === "");
  return { lastResult, us, shipsValid };
}
