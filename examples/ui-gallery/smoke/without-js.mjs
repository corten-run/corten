import { base, draftPost, saveAt, renameAt, engine, skip, check } from "./helpers.mjs";

export async function withoutJs(browser) {
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
  /** Presses List for sale and waits for the page its post answers with: the listing form posts to the draft's own address, so the address alone does not say the page is new. */
  const listForSale = () =>
    Promise.all([
      plain.waitForResponse((r) => new URL(r.url()).pathname === "/" && r.request().method() === "POST"),
      plain.waitForEvent("load"),
      plain.getByRole("button", { name: "List for sale" }).click(),
    ]).then(([answer]) => answer);
  const listing = await listForSale();
  check(
    "no script: the form posts the page, at the draft's own address",
    (await plain.textContent("#result")) === "Listed 1 Lightly Played Ashen Drake at $12.50 each, 0.5 oz to ship." && listing.status() === 200 && new URL(plain.url()).pathname === "/",
    `${listing.status()} ${plain.url()} ${await plain.textContent("#result")}`,
  );
  // A client that skips the inputs' min, max and step is refused by the handler with the same bounds.
  await plain.goto(`${base}/`);
  await plain.locator("[data-scope=ui-combo-box] select").selectOption("lp");
  const pastBounds = await plain.evaluate(() => {
    const form = /** @type {HTMLFormElement} */ (document.querySelector('form[method=post][action="/"]'));
    form.noValidate = true;
    for (const [id, value] of [["qty", "11"], ["weight", "0.55"]]) {
      const input = /** @type {HTMLInputElement} */ (document.getElementById(id));
      input.removeAttribute("max");
      input.step = "any";
      input.value = value;
    }
    return [form.checkValidity(), document.getElementById("qty")?.getAttribute("min")].join(" ");
  });
  await listForSale();
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
      /** @type {HTMLFormElement} */ (document.querySelector('form[method=post][action="/"]')).noValidate = true;
      const input = /** @type {HTMLInputElement} */ (document.getElementById("qty"));
      input.type = "text";
      input.value = qty;
    }, qty);
    const answer = await listForSale();
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
    /** @type {HTMLFormElement} */ (document.querySelector('form[method=post][action="/"]')).noValidate = true;
    const weight = /** @type {HTMLInputElement} */ (document.getElementById("weight"));
    weight.step = "any";
    weight.value = "0.55";
  });
  await listForSale();
  const offStep = (await plain.textContent("#result")) ?? "";
  check("no script: a weight between the input's steps is refused by the handler", offStep === "Enter a weight from 0.1 to 16 oz, in tenths.", offStep);
  // The browser admits both hinted endpoints, but the handler refuses them. Values inside post
  // without bypassing validation. Only the extra long spelling probe below bypasses validation.
  /** @param {string} discount */
  const postDiscount = async (discount, bypass = false) => {
    await plain.goto(`${base}/`);
    await plain.locator("[data-scope=ui-combo-box] select").selectOption("lp");
    await plain.fill("#discount", discount);
    const valid = await plain.evaluate((bypass) => {
      const form = /** @type {HTMLFormElement} */ (document.querySelector('form[method=post][action="/"]'));
      const valid = form.checkValidity();
      if (bypass) form.noValidate = true;
      return valid;
    }, bypass);
    if (!valid && !bypass) return "blocked by native validation";
    const answer = await listForSale();
    return `${valid} ${answer.status()} ${(await plain.textContent("#result")) ?? ""}`;
  };
  for (const end of ["0", "100"]) {
    const atEnd = await postDiscount(end);
    check(`no script: a discount of ${end} posts natively and is refused by the handler`, atEnd === "true 422 Enter a discount above 0 and below 100 percent, or none.", atEnd);
  }
  const roundedEnd = await postDiscount("0.00000000000000999999999999999999e16", true);
  check("no script: the handler refuses a value that rounds to 100 even if native validation admits it",
    roundedEnd.split(" ").slice(1).join(" ") === "422 Enter a discount above 0 and below 100 percent, or none.", roundedEnd);
  const precise = await postDiscount("12.345");
  check("no script: a discount with any decimals is listed", precise === "true 200 Listed 1 Lightly Played Ashen Drake at $12.50 each, 0.5 oz to ship, 12.345% off two or more.", precise);
  // The least double above zero still posts in a spelling that used to be blocked by the hint.
  for (const typed of ["4e-324", "1e-20"]) {
    const tiny = await postDiscount(typed);
    const [valid, status] = tiny.split(" ");
    check(`no script: a discount of ${typed} posts natively and is held by the handler`, status === "200" && valid === "true", tiny.slice(0, 80));
  }
  await plain.goto(`${base}/help`);
  const prefill = plain.getByLabel("Example discount (%)");
  const defaultDiscount = await prefill.inputValue();
  const discountMin = await prefill.getAttribute("min");
  const [prefilled] = await Promise.all([
    plain.waitForResponse((r) => new URL(r.url()).pathname === "/" && r.request().method() === "POST"),
    plain.waitForEvent("load"),
    plain.getByRole("button", { name: "Try listing with this discount" }).click(),
  ]);
  const postedDiscount = new URLSearchParams(prefilled.request().postData() ?? "").get("discount");
  check("no script: a plain any-step input posts its tiny prefill unchanged",
    defaultDiscount === "1e-20" && discountMin === "0" && postedDiscount === defaultDiscount && prefilled.status() === 200,
    `${defaultDiscount} min=${discountMin} posted=${postedDiscount} ${prefilled.status()}`);
  const ratios = [
    { label: "Minimum ratio example", attr: "min", end: "0.001", inside: "1.0000000000000002e-3", rule: "Enter a ratio above 0.001 and at most 1." },
    { label: "Maximum ratio example", attr: "max", end: "1", inside: "0.9999999701976776123046874", rule: "Enter a ratio of at least 0 and below 1." },
  ];
  const postRatios = async () => {
    const [response] = await Promise.all([
      plain.waitForResponse((r) => new URL(r.url()).pathname === "/help" && r.request().method() === "POST"),
      plain.waitForEvent("load"),
      plain.getByRole("button", { name: "Check the example ratios" }).click(),
    ]);
    return response;
  };
  /** @param {import("@playwright/test").Locator} input @param {string} rule */
  const showsRatioError = async (input, rule) => {
    const [hintId, errorId, ...extra] = (await input.getAttribute("aria-describedby") ?? "").split(/\s+/);
    if (!hintId || !errorId || extra.length || await input.getAttribute("aria-invalid") !== "true") return false;
    const hint = plain.locator(`[id="${hintId}"]`);
    const error = plain.locator(`[id="${errorId}"]`);
    return hintId !== errorId && await hint.isVisible() && await hint.textContent() === rule &&
      await error.isVisible() && await error.textContent() === rule;
  };
  for (const { label, attr, end, inside, rule } of ratios) {
    for (const typed of [end, inside]) {
      await plain.goto(`${base}/help`);
      const input = plain.getByLabel(label);
      const hint = await input.getAttribute(attr);
      await input.fill(typed);
      const { name, valid } = await input.evaluate((el) => {
        const input = /** @type {HTMLInputElement} */ (el);
        return { name: input.name, valid: input.form?.checkValidity() };
      });
      const test = `no script: ${label} posts ${typed} natively (${typed === end ? "422 with the field error" : "200"})`;
      if (!valid) {
        check(test, false, `native validation blocked the form with ${attr}=${hint}`);
        continue;
      }
      const response = await postRatios();
      const posted = new URLSearchParams(response.request().postData() ?? "").get(name);
      const refused = typed === end;
      check(test, hint === end && posted === typed && response.status() === (refused ? 422 : 200) &&
        (refused ? await showsRatioError(input, rule) : await plain.textContent("#result") === "Both ratios are in range."),
      `${attr}=${hint} posted=${posted} ${response.status()}`);
    }
  }
  await plain.goto(`${base}/help`);
  for (const { label, end } of ratios) await plain.getByLabel(label).fill(end);
  const bothValid = await plain.getByRole("button", { name: "Check the example ratios" }).evaluate(
    (el) => /** @type {HTMLButtonElement} */ (el).form?.checkValidity(),
  );
  const both = bothValid ? await postRatios() : undefined;
  check("no script: one refused submission redisplays both typed ratio errors",
    both?.status() === 422 && (await Promise.all(ratios.map(({ label, rule }) => showsRatioError(plain.getByLabel(label), rule)))).every(Boolean),
    both ? String(both.status()) : "native validation blocked the form");
  await plain.goto(`${base}/`);
  const plainFloor = plain.getByLabel("Lowest offer");
  check("no script: the lowest offer is enabled and optional (the handler checks it)", (await plainFloor.isEnabled()) && !(await plainFloor.evaluate((i) => /** @type {HTMLInputElement} */ (i).required)));
  await plain.getByRole("tab", { name: "Offers" }).click();
  await plain.waitForURL("**/?tab=offers");
  check("no script: a tab is a link to its page", (await plain.getByRole("tabpanel").textContent()) === "Two offers, the best at $10.00.");
  await plain.getByRole("button", { name: "More actions" }).click();
  check("no script: the menu opens (popover)", await plain.getByRole("menuitem", { name: "Help" }).isVisible());
  // Saving is a post of the draft's own (do=save), so it sends the browser back to the view of the
  // draft it was on, whose toaster says it.
  await plain.goto(`${base}/`);
  const saved = await Promise.all([
    plain.waitForResponse((r) => saveAt(new URL(r.url())) && r.request().method() === "POST"),
    plain.waitForEvent("load"),
    plain.getByRole("button", { name: "Save draft" }).click(),
  ]).then(([answer]) => answer);
  check("no script: a save sends the browser back to the draft", saved.status() === 303 && saved.headers().location === "/" && new URL(plain.url()).pathname === "/", `${saved.status()} ${plain.url()}`);
  // The notice rides in a `__Host-` cookie, which must be Secure, and Playwright's WebKit never sends
  // a Secure cookie back over http, so it cannot be given back as a plain one either.
  const savedToast = "no script: the draft a save goes back to shows its toast";
  if (engine !== "webkit") check(savedToast, (await plain.locator("#ui-toast").textContent()) === "Draft saved." && (await plain.locator("#ui-toast").isVisible()), await plain.locator("#ui-toast").textContent());
  else skip(savedToast, "the notice's __Host- cookie must be Secure, and Playwright's WebKit never sends a Secure cookie back over http");
  await plain.goto(`${base}/?tab=offers`);
  const fromOffers = await Promise.all([
    plain.waitForResponse((r) => saveAt(new URL(r.url())) && r.request().method() === "POST"),
    plain.waitForEvent("load"),
    plain.getByRole("button", { name: "Save draft" }).click(),
  ]).then(([answer]) => answer);
  check(
    "no script: a save from another view of the draft is sent to that view's address and goes back to it",
    new URL(fromOffers.url()).search === "?tab=offers&do=save" && fromOffers.headers().location === "/?tab=offers" && new URL(plain.url()).search === "?tab=offers",
    `${fromOffers.url()} ${fromOffers.headers().location} ${plain.url()}`,
  );
  await plain.goto(`${base}/`);
  await Promise.all([plain.waitForURL(draftPost("publish")), plain.getByRole("button", { name: "Publish", exact: true }).click()]);
  {
    const failed = await plain.locator("#ui-toast").evaluate((m) => ({ text: m.textContent, marked: m.hasAttribute("data-failed"), shown: !(/** @type {HTMLElement} */ (m).hidden) }));
    check("no script: an action's failed Toast is in the page, marked", failed.shown && failed.marked && !!failed.text?.startsWith("Not published"), JSON.stringify(failed));
  }
  await plain.goto(`${base}/`);
  await plain.getByRole("button", { name: "Rename draft" }).click();
  check("no script: the button opens the dialog", await plain.locator("#rename").isVisible());
  await Promise.all([plain.waitForURL(renameAt), plain.getByRole("button", { name: "Rename", exact: true }).click()]);
  check("no script: refused, the dialog is open with the error", (await plain.locator("#rename").isVisible()) && ((await plain.locator("#rename").textContent()) ?? "").includes("Give the draft a name."));
  // The other draft's name: the whole page drawn again has the dialog open with the form's alert.
  await plain.locator("#rename-name").fill("Holiday lot");
  await Promise.all([plain.waitForEvent("load"), plain.getByRole("button", { name: "Rename", exact: true }).click()]);
  {
    const alert = plain.locator("#rename form > .alert__alert[role=alert]");
    check(
      "no script: refused for a taken name, the dialog is open with the form's alert",
      (await plain.locator("#rename").isVisible()) &&
        (await alert.count()) === 1 &&
        (await alert.textContent()) === "Your other draft is named Holiday lot. Rename that one first, or choose another name.",
      String(await alert.first().textContent({ timeout: 1000 }).catch(() => null)),
    );
  }
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
  const plainSales = plain.getByRole("table", { name: "This month's last sales, sorted among themselves" });
  for (const [order, aria, buyers] of [
    ["price", "ascending", "Alan Turing|Grace Hopper|Ada Lovelace"],
    ["price_down", "descending", "Ada Lovelace|Grace Hopper|Alan Turing"],
  ]) {
    await Promise.all([plain.waitForURL((url) => url.searchParams.get("sold") === order), plainSales.getByRole("link", { name: "Price" }).click()]);
    const rows = (await plainSales.locator("tbody td:nth-child(2)").allTextContents()).join("|");
    const sort = await plainSales.getByRole("columnheader", { name: "Price" }).getAttribute("aria-sort");
    check(`no script: Price follows the server's ${aria} sort link`, rows === buyers && sort === aria, `${plain.url()} ${rows} ${sort}`);
  }
  await Promise.all([
    plain.waitForURL((url) => url.searchParams.get("sales") === "earlier"),
    plain.getByRole("navigation", { name: "Sales pages" }).getByRole("link", { name: "Earlier sales" }).click(),
  ]);
  const earlierSales = plain.getByRole("table", { name: "This month's earlier sales, sorted among themselves" });
  check(
    "no script: the sorted table's pager preserves the server's order",
    new URL(plain.url()).searchParams.get("sold") === "price_down" && (await earlierSales.getByRole("columnheader", { name: "Price" }).getAttribute("aria-sort")) === "descending",
    plain.url(),
  );
  await plain.goto(`${base}/orders`);
  await plain.getByRole("button", { name: "Share the shop" }).click();
  check("no script: the popover opens", await plain.locator("#share").isVisible());
  await plain.keyboard.press("Escape");
  await Promise.all([plain.waitForURL("**/orders?page=3"), plain.getByRole("link", { name: "3", exact: true }).click()]);
  check("no script: a page number is a link to that page", (await plain.locator("caption").textContent()) === "Page 3 of 3");
}
