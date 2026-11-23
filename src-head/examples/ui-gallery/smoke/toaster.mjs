import { base, saveAt, skip, check } from "./helpers.mjs";

export async function toaster(page, errors) {
  // Toaster (2 seconds in the gallery)
  const toast = page.locator("#ui-toast");
  const dismiss = page.getByRole("button", { name: "Dismiss" });
  check("no message: nothing shows", (await toast.isHidden()) && (await dismiss.isHidden()));
  const region = await page.evaluate(() => {
    const toaster = document.querySelector('[role="status"]:has(#ui-toast)');
    return [toaster, toaster?.parentElement, document.querySelector("#menu-result")].map((e) => (e ? getComputedStyle(e).display : "missing")).join();
  });
  check("empty live regions stay in the page, so a message is announced", !/none|missing/.test(region), region);
  // A data-patch save from another view of the draft goes to that view's address with do=save, and
  // the page stays on that view.
  {
    const viewed = await page.context().newPage();
    await viewed.goto(`${base}/?tab=offers`);
    const [sent] = await Promise.all([viewed.waitForRequest((r) => r.method() === "POST"), viewed.getByRole("button", { name: "Save draft" }).click()]);
    const toasted = await viewed.waitForFunction(() => document.querySelector("#ui-toast")?.textContent === "Draft saved.", null, { timeout: 5000 }).then(() => true, () => false);
    const mode = await sent.headerValue("corten");
    check(
      "a data-patch save from another view is sent to that view's address with do=save, and the page stays there",
      new URL(sent.url()).search === "?tab=offers&do=save" && mode === "action" && toasted && new URL(viewed.url()).search === "?tab=offers",
      `${sent.url()} ${mode} ${toasted} ${viewed.url()}`,
    );
    await viewed.close();
  }
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
  await page.route(saveAt, cut);
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
  // A layout with a fixed bar along the bottom lifts the toaster above it with --toasts-inset-bottom,
  // in a rule on body as the kit guide says (the theme's :root value is what it overrides).
  const lifted = await toast.evaluate(async (m) => {
    const toasts = /** @type {HTMLElement} */ (m.closest("[role=status]")?.parentElement?.parentElement);
    const gap = () => Math.round(innerHeight - toasts.getBoundingClientRect().bottom);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const before = gap();
    // The rule a layout writes, as a stylesheet (a constructed one, which the CSP allows).
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("body { --toasts-inset-bottom: 6rem; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    const after = gap();
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    return { rem, before, after, back: gap() };
  });
  const atRems = (/** @type {number} */ px, /** @type {number} */ rems) => Math.abs(px - rems * lifted.rem) <= 1;
  check("the toaster sits 1rem above the bottom, and --toasts-inset-bottom lifts it", atRems(lifted.before, 1) && atRems(lifted.after, 6) && atRems(lifted.back, 1), JSON.stringify(lifted));
  await page.mouse.move(0, 0);
  await page.waitForTimeout(2600);
  check("the failed text stays past the toaster's seconds", await toast.isVisible());
  // The next submit takes it away even if a control shadows the form's getAttribute.
  const gone = await save.evaluate((button) => {
    const field = document.createElement("input");
    field.type = "hidden";
    field.name = "getAttribute";
    button.closest("form").append(field);
    const first = document.querySelector("#ui-toast");
    first.__first = 1;
    button.click();
    const hidden = first.hidden;
    field.remove();
    return hidden;
  });
  const again = await page
    .waitForFunction(() => { const m = document.querySelector("#ui-toast"); return !m.hidden && m.__first !== 1 && m.textContent.startsWith("That did not go through"); }, null, { timeout: 5000 })
    .then(() => true, () => false);
  check("Toaster: the next submit takes the failed text away with a control named getAttribute, then another failure says it again", gone && again);
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
    await other.route(saveAt, cut);
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
  await page.unroute(saveAt, cut);
  // A success after an action's failed Toast is a notice again: unmarked, and gone after its seconds.
  {
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#ui-toast")?.hasAttribute("data-failed"), null, { timeout: 5000 });
    await save.click();
    await page.waitForFunction(() => document.querySelector("#ui-toast")?.textContent === "Draft saved.", null, { timeout: 5000 });
    const marked = await toast.evaluate((m) => m.hasAttribute("data-failed"));
    await page.mouse.move(0, 0);
    const gone = await toast.waitFor({ state: "hidden", timeout: 4000 }).then(() => true, () => false);
    check("a success after an action's failed Toast is not marked, and goes after its seconds", !marked && gone, JSON.stringify({ marked, gone }));
  }
  // The two saves cut on purpose: Chromium logs each as a resource that failed to load.
  errors.splice(errorsBefore, errors.length - errorsBefore, ...errors.slice(errorsBefore).filter((e) => !/ERR_CONNECTION_RESET/.test(e)));
}
