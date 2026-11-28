import { base, engine, skip, check } from "./helpers.mjs";

export async function tooltip(browser, errors) {
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
    if (!native) {
      const hoverErrors = await tips.locator('form[method="post"][action="/"]').evaluate((form) => {
        const field = document.createElement("input");
        field.type = "hidden";
        field.name = "closest";
        form.append(field);
        const errors = [];
        const failed = (event) => errors.push(event.message);
        window.addEventListener("error", failed);
        form.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
        window.removeEventListener("error", failed);
        field.remove();
        return errors;
      });
      check("Tooltip: a pointer over a form with a control named closest does not throw",
        hoverErrors.length === 0, hoverErrors.join(" | "));
    }
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
}
