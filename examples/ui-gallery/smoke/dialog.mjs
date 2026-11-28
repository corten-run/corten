import { base, renameAt, swapped, engine, skip, check, lanBase } from "./helpers.mjs";

export async function closedTopLayer(page) {
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
}

export async function modalDialogs(browser, errors, page) {
  // dialog::modal: use callable focus overrides, even on forms, and handle named controls.
  {
    const invalid = await browser.newPage();
    invalid.on("pageerror", (e) => errors.push(e.message));
    try {
      await invalid.addInitScript(() => {
        customElements.define("smoke-field", class extends HTMLElement {
          constructor() {
            super();
            this.attachShadow({ mode: "open" }).append(document.createElement("input"));
          }
          /** @param {FocusOptions} [options] */
          focus(options) { this.shadowRoot?.querySelector("input")?.focus(options); }
          connectedCallback() {
            const form = this.closest("#invalid-form");
            if (form) form.focus = () => this.focus();
          }
        });
      });
      for (const [name, field, id, inner] of [
        ["a modal calls the invalid custom field's focus method", '<form$3><smoke-field id="invalid-field" aria-invalid="true"></smoke-field>', "invalid-field", "input"],
        ["a modal focuses an invalid form whose focus is shadowed", '<form$3 id="invalid-form" tabindex="-1" aria-invalid="true"><input type="hidden" name="focus">', "invalid-form"],
        ["a modal calls an invalid form's own focus method", '<form$3 id="invalid-form" aria-invalid="true"><smoke-field id="form-field"></smoke-field>', "form-field", "input"],
      ]) {
        const url = `${base}/`;
        await invalid.route(url, async (route) => {
          const response = await route.fetch();
          const body = (await response.text()).replace(/(<dialog\b[^>]*\bid="rename"[^>]*)(>.*?)<form(\b[^>]*)>/s,
            '$1 open$2<button type="button" id="before-invalid">Before invalid</button>' + field);
          await route.fulfill({ response, body });
        }, { times: 1 });
        await invalid.goto(url);
        await invalid.locator("#rename:modal").waitFor();
        const focus = await invalid.evaluate(() => ({
          outer: document.activeElement?.id,
          inner: document.activeElement?.shadowRoot?.activeElement?.localName,
        }));
        check(name, focus.outer === id && focus.inner === inner, JSON.stringify(focus));
      }
    } finally {
      await invalid.context().close();
    }
  }

  // dialog::modal: a dialog the server draws open is modal.
  {
    const draws = await browser.newPage();
    draws.on("pageerror", (e) => errors.push(e.message));
    await draws.addInitScript(() => {
      customElements.define("smoke-patch-root", class extends HTMLElement {
        querySelector() { return null; }
      });
      class CustomOpener extends HTMLFormElement {
        focus(options) {
          this.dataset.preventScroll = String(options?.preventScroll);
          this.querySelector("button").focus(options);
        }
      }
      customElements.define("smoke-form-focus", class extends HTMLElement {
        connectedCallback() {
          // Exercise a form's prototype override even without customized built-in support.
          Object.setPrototypeOf(this.parentElement, CustomOpener.prototype);
        }
      });
    });
    const outer = "draw-outer:patch:target;";
    const inner = "draw-inner:patch:target;";
    for (const [mode, want, focus] of [
      ["post", outer, "draw-opener"],
      ["live", outer, "draw-opener"],
      ["read", outer, "draw-opener"],
      ["nested", inner + outer, "draw-opener"],
      ["drop-inner", outer, "draw-opener"],
      ["mutate", inner, "draw-opener"],
      ["remove", "", "draw-opener"],
      ["shadow-opener", outer, "draw-opener"],
      ["custom-opener", outer, "draw-opener-button"],
      ["native-lookup", outer, "draw-opener"],
      ["reopen", "", "change"],
      ["replace-opener", outer, "draw-opener"],
      ["link", outer, "draw-opener"],
      ["native", "draw-outer:native:target;", "draw-opener"],
      ["strip-open", "", ""],
    ]) {
      const formOpener = ["shadow-opener", "custom-opener"].includes(mode);
      const url = `${base}/dialog-draw/${formOpener || mode === "native-lookup" ? "replace-opener" : ["native", "strip-open"].includes(mode) ? "post" : mode}`;
      const incoming = mode === "live" ? `${base}/dialog-draw-live` : url;
      const held = mode === "live" || mode === "read";
      let release = () => {};
      const ready = new Promise((resolve) => { release = () => resolve(undefined); });
      /** @param {import("@playwright/test").Route} route */
      const delay = async (route) => {
        if (route.request().headers().corten === "action" && route.request().method() === "GET" || mode === "live") await ready;
        await route.continue();
      };
      if (held) await draws.route(incoming, delay);
      const samePath = (target) => target.pathname === new URL(url).pathname;
      const asForm = async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace(
          /<button id="draw-opener"([^>]*)>([^<]*)<\/button>/,
          mode === "shadow-opener"
            ? '<form id="draw-opener" tabindex="-1"><input type="hidden" name="localName"><input type="hidden" name="focus"><button$1>$2</button></form>'
            : '<form id="draw-opener" tabindex="-1"><smoke-form-focus></smoke-form-focus><button id="draw-opener-button"$1>$2</button></form>',
        );
        await route.fulfill({ response, body });
      };
      if (formOpener) await draws.route(samePath, asForm);
      const asCustomRoots = async (route) => {
        const response = await route.fetch();
        let body = (await response.text()).replace(/<button id="draw-opener"[^>]*>[^<]*<\/button>/,
          '<smoke-patch-root id="smoke-opener-root">$&</smoke-patch-root>');
        if (new URL(route.request().url()).searchParams.get("do") === "draw") {
          body = body.replace(/<div([^>]*\bid="draw-area"[^>]*>[\s\S]*?<\/dialog>)<\/div>/,
            "<smoke-patch-root$1</smoke-patch-root>");
        }
        await route.fulfill({ response, body });
      };
      if (mode === "native-lookup") await draws.route(samePath, asCustomRoots);
      await draws.goto(url);
      if (formOpener) {
        await draws.locator("#draw-opener").evaluate((form) => {
          HTMLElement.prototype.focus.call(form);
          form.querySelector("button").click();
        });
      } else await draws.locator("#draw-opener").press("Enter");
      await draws.waitForFunction((count) => document.querySelectorAll("dialog:modal").length === count,
        ["nested", "drop-inner", "mutate"].includes(mode) ? 2 : 1);
      if (held) release();
      else if (mode === "native" || mode === "strip-open") {
        if (mode === "native") {
          await draws.keyboard.press("Escape");
          await draws.waitForFunction(() => document.querySelector("output")?.textContent?.includes(":native:"));
          check("Escape closes the modal natively and returns focus", await draws.locator("#draw-opener").evaluate((el) => el === document.activeElement));
        } else await draws.locator("#draw-outer").evaluate((el) => el.removeAttribute("open"));
        await draws.getByRole("button", { name: "Redraw dialog" }).evaluate((el) => /** @type {HTMLElement} */ (el).click());
      } else await draws.getByRole("button", { name: "Change dialog" }).click();
      if (mode === "remove") await draws.locator("#draw-area").waitFor({ state: "detached" });
      else await draws.locator('#draw-area[data-stage="updated"]').waitFor({ state: "attached" });
      if (mode === "reopen") await draws.locator("#draw-outer:modal").waitFor();
      const after = await draws.evaluate(() => ({
        events: document.querySelector("output")?.value,
        modal: document.querySelector("dialog:modal")?.id,
        outer: !!document.querySelector("#draw-outer"),
        focus: document.activeElement?.id || (document.activeElement?.closest("dialog:modal") ? "change" : ""),
        opener: document.activeElement?.textContent,
        preventScroll: document.querySelector("#draw-opener")?.getAttribute("data-prevent-scroll"),
        customRoot: document.querySelector("#draw-area")?.localName === "smoke-patch-root",
      }));
      check(
        `A server-drawn modal's ${mode} redraw closes, reopens or removes it as drawn`,
        after.events === want && after.modal === (mode === "reopen" ? "draw-outer" : undefined)
          && after.outer === !["remove", "mutate"].includes(mode) && (mode === "strip-open" || after.focus === focus)
          && (!(formOpener || ["replace-opener", "native-lookup"].includes(mode)) || after.opener === "Replacement opener")
          && (mode !== "custom-opener" || after.preventScroll === "true")
          && (mode !== "native-lookup" || after.customRoot),
        JSON.stringify(after),
      );
      if (held) await draws.unroute(incoming, delay);
      if (formOpener) await draws.unroute(samePath, asForm);
      if (mode === "native-lookup") await draws.unroute(samePath, asCustomRoots);
      if (mode === "reopen") {
        await draws.getByRole("button", { name: "Close redrawn dialog" }).click();
        await draws.locator("#draw-outer:not([open])").waitFor({ state: "attached" });
        const closed = await draws.evaluate(() => ({
          events: document.querySelector("output")?.value,
          focus: document.activeElement?.id,
        }));
        check("a modal redrawn open returns focus to its original opener on a later close",
          closed.events === outer && closed.focus === "draw-opener", JSON.stringify(closed));
      }
    }

    for (const mode of ["navigation", "live-during-navigation", "unrelated-reuse"]) {
      const live = mode === "live-during-navigation";
      const reuse = mode === "unrelated-reuse";
      const to = `${base}/dialog-draw/post`;
      const stream = `${base}/dialog-draw-live`;
      let releaseLive = () => {};
      let releaseNav = () => {};
      const liveHeld = new Promise((resolve) => { releaseLive = () => resolve(undefined); });
      const navHeld = new Promise((resolve) => { releaseNav = () => resolve(undefined); });
      /** @param {import("@playwright/test").Route} route */
      const holdLive = async (route) => { await liveHeld; await route.continue(); };
      /** @param {import("@playwright/test").Route} route */
      const holdNav = async (route) => { await navHeld; await route.continue(); };
      if (live) {
        await draws.route(stream, holdLive);
        await draws.route(to, holdNav);
      }
      try {
        await draws.goto(`${base}/dialog-draw/${live ? "live" : "link"}`);
        if (!reuse && !await draws.evaluate(() => {
          document.documentElement.dataset.dialogDraw = "here";
          return "navigation" in window;
        })) {
          if (live) skip("a live patch delivers one close while navigation is pending", "no Navigation API");
          skip(`${mode} does not close or focus unrelated same-id controls`, "no Navigation API");
          continue;
        }
        if (reuse) await draws.evaluate(() => {
          // A script removes the old markup and puts back unrelated controls with both ids.
          const old = document.querySelector("#draw-area");
          const opener = document.querySelector("#draw-opener");
          const reuseIds = () => {
            document.querySelector("#draw-area")?.remove();
            document.querySelector("#draw-opener")?.replaceWith(/** @type {Node} */ (opener?.cloneNode(true)));
            document.querySelector("main")?.append(/** @type {Node} */ (old?.cloneNode(true)));
          };
          document.addEventListener("reuse-ids", reuseIds, { once: true });
        });
        await draws.locator("#draw-opener").press("Enter");
        await draws.locator("#draw-outer:modal").waitFor();
        if (reuse) await draws.evaluate(() => document.dispatchEvent(new Event("reuse-ids")));
        else {
          const next = draws.getByRole("link", { name: "Next page" });
          if (live) {
            await Promise.all([draws.waitForRequest(to), next.click({ noWaitAfter: true })]);
            releaseLive();
            // Playwright's WebKit waits for the pending navigation before resolving locators.
            // Read the live patch in the current document before letting that navigation finish.
            await draws.waitForFunction(() => document.querySelector('#draw-area[data-stage="updated"]'));
            const events = await draws.evaluate(() => document.querySelector("output")?.value);
            check("a live patch delivers one close while navigation is pending", events === outer, events);
            releaseNav();
          } else await next.click();
          await draws.waitForURL(to);
        }
        await draws.locator('#draw-area[data-stage="initial"]').waitFor({ state: "attached" });
        const after = await draws.evaluate(() => ({
          events: document.querySelector("output")?.value,
          focus: document.activeElement?.id,
          swapped: document.documentElement.dataset.dialogDraw === "here",
        }));
        check(`${mode} does not close or focus unrelated same-id controls`,
          (reuse || after.swapped) && after.events === "" && after.focus !== "draw-opener", JSON.stringify(after));
      } finally {
        releaseLive();
        releaseNav();
        if (live) {
          await draws.unroute(stream, holdLive);
          await draws.unroute(to, holdNav);
        }
      }
    }

    for (const mode of ["native-connect", "native-focus", "veto-focus"]) {
      await draws.goto(`${base}/dialog-draw/${mode === "native-connect" ? mode : "post"}`);
      await draws.locator("#draw-opener").press("Enter");
      await draws.locator("#draw-outer:modal").waitFor();
      await draws.evaluate((mode) => {
        const old = /** @type {HTMLDialogElement} */ (document.querySelector("#draw-outer"));
        old.returnValue = "old";
        if (mode !== "native-connect") document.querySelector("#draw-opener")?.addEventListener("focus", () => {
          const next = /** @type {HTMLDialogElement} */ (document.querySelector("#draw-outer"));
          if (mode === "veto-focus") next.addEventListener("beforetoggle", (event) => {
            if (event.isTrusted && event.newState === "open") {
              next.dataset.vetoed = "yes";
              event.preventDefault();
            }
          }, { once: true });
          next.showModal();
          if (mode === "native-focus") next.close("new");
        }, { once: true });
      }, mode);
      await draws.getByRole("button", { name: "Change dialog" }).click();
      if (mode === "veto-focus") await draws.locator('#draw-area[data-stage="updated"]').waitFor({ state: "attached" });
      else await draws.waitForFunction(() => document.querySelector("output")?.value.includes(":native:"));
      const after = await draws.locator("#draw-outer").evaluate((el) => ({
        events: document.querySelector("output")?.value,
        value: /** @type {HTMLDialogElement} */ (el).returnValue,
        open: el.hasAttribute("open"),
        vetoed: el.getAttribute("data-vetoed"),
        focus: document.activeElement?.id,
      }));
      if (mode === "veto-focus") check("a vetoed native open does not swallow the patch close or result",
        after.vetoed === "yes" && !after.open && after.focus === "draw-opener"
          && after.events === "draw-outer:patch:target:old;" && after.value === "old", JSON.stringify(after));
      else check(`${mode} delivers exactly one native close and keeps its returnValue`,
        after.events === "draw-outer:native:target:new;" && after.value === "new", JSON.stringify(after));
    }
    for (const mode of ["overlap-dialog-first", "overlap-area-first", "focus-dialog-first", "focus-area-first", "script-dialog"]) {
      await draws.goto(`${base}/dialog-draw/${mode}`);
      await draws.locator("#draw-opener").press("Enter");
      await draws.locator("#draw-outer:modal").evaluate((el) => { /** @type {HTMLDialogElement} */ (el).returnValue = "old"; });
      await draws.locator("output").evaluate((el) => { delete el.dataset.focusRef; });
      await draws.getByRole("button", { name: "Change dialog" }).click();
      const after = await draws.locator('#draw-area[data-stage="updated"] #draw-outer').evaluate((el) => ({
        events: document.querySelector("output")?.value,
        value: /** @type {HTMLDialogElement} */ (el).returnValue,
        open: el.hasAttribute("open"),
        direct: el.hasAttribute("data-direct"),
        focus: document.activeElement?.id,
        focusRef: document.querySelector("output")?.dataset.focusRef,
      }));
      const script = mode === "script-dialog";
      const areaFirst = mode.endsWith("area-first");
      const focusRef = mode.startsWith("focus-") ? (areaFirst ? "updated;" : "opened;updated;") : undefined;
      if (focusRef) check(`${mode} runs the focus handler with the current ref`, after.focusRef === focusRef, JSON.stringify(after));
      check(script ? "a script-created same-id dialog inside the patch root receives no close or result"
        : `${mode} delivers one close and the old result to the surviving dialog`,
      !after.open && after.focus === "draw-opener" && after.direct === areaFirst
        && after.events === (script ? "" : "draw-outer:patch:target:old;") && after.value === (script ? "" : "old"), JSON.stringify(after));
    }
    await draws.goto(`${base}/dialog-draw/focus-reopen`);
    await draws.locator("#draw-opener").press("Enter");
    await draws.locator('#draw-area[data-stage="opened"] #draw-outer:modal').waitFor();
    await draws.locator("output").evaluate((el) => { delete el.dataset.focusRef; });
    await draws.getByRole("button", { name: "Change dialog" }).click();
    await draws.locator('#draw-area[data-stage="updated"] #draw-outer:modal').waitFor();
    const during = await draws.locator("output").evaluate((el) => el.dataset.focusRef);
    await draws.getByRole("button", { name: "Close redrawn dialog" }).click();
    const reopened = await draws.locator("#draw-outer:not([open])").evaluate((el) => ({
      events: el.closest("main")?.querySelector("output")?.value,
      focus: document.activeElement?.id,
    }));
    check("an overlapping redraw open with a ref lookup keeps the original opener for a later close",
      during?.startsWith("opened;") && reopened.events === outer && reopened.focus === "draw-opener",
      JSON.stringify({ during, ...reopened }));
    await draws.close();
  }
  const rename = page.locator("#rename");
  const isModal = () => rename.evaluate((d) => d.matches(":modal"));
  check("drawn closed, the dialog stays closed", !(await rename.evaluate((d) => /** @type {HTMLDialogElement} */ (d).open)));
  await page.getByRole("button", { name: "Rename draft" }).click();
  check("the button opens it as a modal (command=show-modal)", await isModal());
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#rename [aria-invalid=true]") !== null);
  check("a refused patch keeps it modal, with the error", (await isModal()) && (await rename.textContent())?.includes("Give the draft a name."));
  check("focus is on the refused field", await page.evaluate(() => document.activeElement?.id === "rename-name"));
  check("a field's error alone draws no form alert", (await rename.locator(".alert__alert[role=alert]").count()) === 0);
  // The other draft's name: the form's own message is FormAlert, the kit's soft destructive
  // alert, one live region with the tone's colors, above the marked field.
  await page.locator("#rename-name").fill("Holiday lot");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#rename form > .alert__alert") !== null, null, { timeout: 5000 }).catch(() => {});
  const formAlert = await rename.evaluate((d) => {
    const alert = d.querySelector("form > .alert__alert");
    if (!alert) return null;
    const field = /** @type {Element} */ (d.querySelector("#rename-name"));
    const look = getComputedStyle(alert);
    // The soft destructive tone, from a probe with the same classes outside any form.
    const probe = document.createElement("div");
    probe.className = "alert__alert alert__destructive alert__soft";
    document.body.append(probe);
    const tone = getComputedStyle(probe);
    const expected = { background: tone.backgroundColor, color: tone.color };
    probe.remove();
    return {
      role: alert.getAttribute("role"),
      regions: d.querySelectorAll("form [role=alert], form [role=status], form [aria-live]").length,
      text: alert.textContent,
      background: look.backgroundColor,
      color: look.color,
      expected,
      above: !!(alert.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING),
      invalid: field.getAttribute("aria-invalid"),
    };
  });
  check(
    "a form's own message is the kit's soft destructive alert, its one live region, above the marked field",
    !!formAlert &&
      formAlert.role === "alert" &&
      formAlert.regions === 1 &&
      formAlert.text === "Your other draft is named Holiday lot. Rename that one first, or choose another name." &&
      formAlert.background === formAlert.expected.background &&
      formAlert.color === formAlert.expected.color &&
      !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(formAlert.background) &&
      formAlert.above &&
      formAlert.invalid === "true",
    JSON.stringify(formAlert),
  );
  // Refused again for an empty name, the dialog is drawn without the form's alert, and its only
  // live region is FailedAlert's, which the checks below read.
  await page.locator("#rename-name").fill("");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  check(
    "refused for an empty name, the dialog is drawn without the form's alert",
    await page
      .waitForFunction(() => document.querySelector("#rename form > .alert__alert") === null && document.querySelector("#rename [aria-invalid=true]") !== null, null, { timeout: 5000 })
      .then(() => true, () => false),
  );
  await page.keyboard.press("Escape");
  check("Escape closes it", !(await rename.evaluate((d) => /** @type {HTMLDialogElement} */ (d).open)));
  // dialog::failed: a rename that gets no answer is said in the modal dialog, not by the toaster
  // the dialog covers; the next submit in it, or closing it, hides it again.
  {
    const said = rename.locator('[role="alert"] > div');
    const cutRename = (/** @type {import("@playwright/test").Route} */ route) =>
      route.request().method() === "POST" ? route.abort("connectionreset") : route.fallback();
    const errorsAt = errors.length;
    await page.route(renameAt, cutRename);
    await page.getByRole("button", { name: "Rename draft" }).click();
    // The live region: rendered in the open dialog (so text added to it is announced), and empty,
    // with no box until the kit's FailedAlert in it is shown, tinted.
    const region = () =>
      rename.locator('[role="alert"]').evaluate((r) => ({
        rendered: r.getClientRects().length > 0 && getComputedStyle(r).visibility === "visible",
        empty: !(/** @type {HTMLElement} */ (r).innerText ?? "").trim(),
        height: r.getBoundingClientRect().height,
        background: getComputedStyle(/** @type {HTMLElement} */ (r.querySelector("[data-ref=said]"))).backgroundColor,
        // In the flow (a row of the dialog's grid, under the heading) or out of it.
        position: getComputedStyle(r).position,
        belowHeading: r.getBoundingClientRect().top >= /** @type {HTMLElement} */ (r.parentElement?.querySelector("h2")).getBoundingClientRect().bottom,
      }));
    const regionBefore = await region();
    // Chromium's accessibility tree, through CDP: out of the flow and back in, the region stays an
    // assertive alert that is not ignored. (A node's id there is its DOM node's, so it is not
    // compared.) Whether a screen reader then announces it is not something CDP can show, and
    // Firefox and WebKit expose no such API to Playwright.
    const cdp = engine === "chromium" ? await page.context().newCDPSession(page) : null;
    await cdp?.send("Accessibility.enable");
    const axNode = async () => {
      if (!cdp) return null;
      const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: '#rename [role="alert"]' });
      if (!nodeId) return null;
      const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
      const node = nodes[0];
      return { ignored: node.ignored, role: node.role?.value, live: node.properties?.find((p) => p.name === "live")?.value?.value };
    };
    const axBefore = await axNode();
    // An empty region adds no row or gap to the dialog's grid: the form starts one gap under the
    // heading, as it would with no region between them (measured without changing the page; WebKit
    // rounds layout to a fraction of a pixel, and a row would add at least the gap).
    const rowless = await rename.evaluate((d) => {
      const heading = /** @type {HTMLElement} */ (d.querySelector("h2")).getBoundingClientRect().bottom;
      const form = /** @type {HTMLElement} */ (d.querySelector("form")).getBoundingClientRect().top;
      const gap = parseFloat(getComputedStyle(d).rowGap) || 0;
      return { heading, gap, form };
    });
    check("an empty FailedAlert adds no row to the dialog's grid", Math.abs(rowless.form - (rowless.heading + rowless.gap)) < 1, JSON.stringify(rowless));
    await page.locator("#rename-name").fill("Cut draft");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const shown = await said.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
    // The toaster's own check runs a microtask after the event: give it a moment.
    await page.waitForTimeout(200);
    const toast = await page.evaluate(() => {
      const m = /** @type {HTMLElement | null} */ (document.querySelector("#ui-toast"));
      return { hidden: !m || m.hidden, text: m?.textContent ?? "" };
    });
    check(
      "a submit in a modal dialog that gets no answer is said in the dialog, and the toaster behind it says nothing",
      shown && (await isModal()) && toast.hidden,
      JSON.stringify({ shown, toast }),
    );
    // The next submit hides it (and, cut again, says it again); closing the dialog hides it.
    const hidOnSubmit = page.evaluate(() => new Promise((resolve) => document.addEventListener("submit", () => queueMicrotask(() => resolve(/** @type {HTMLElement} */ (document.querySelector('#rename [role="alert"] > div')).hidden)), { once: true })));
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    const again = await said.waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
    const regionSaying = await region();
    const axSaying = await axNode();
    if (cdp) {
      const alert = (/** @type {{ ignored: boolean, role: string, live: string } | null} */ n) => !!n && !n.ignored && n.role === "alert" && n.live === "assertive";
      check("out of the flow and back in, the region is an assertive alert in the accessibility tree (Chromium)", alert(axBefore) && alert(axSaying), JSON.stringify({ axBefore, axSaying }));
      await cdp.detach();
    }
    await page.keyboard.press("Escape");
    // The dialog's `close` event is dispatched in a task after Escape.
    // Its own `hidden`, not its visibility: the closed dialog hides it either way.
    const closedHidden = await page
      .waitForFunction(() => /** @type {HTMLElement | null} */ (document.querySelector('#rename [role="alert"] > div'))?.hidden === true, null, { timeout: 5000 })
      .then(() => true, () => false);
    const hid = await hidOnSubmit;
    check("the next submit in the dialog hides it and a second failure says it again; closing the dialog hides it", hid === true && again && closedHidden, JSON.stringify({ hid, again, closedHidden, open: await rename.evaluate((d) => /** @type {HTMLDialogElement} */ (d).open) }));
    check("the alert region is in the open dialog before the failure and while it is said, only the alert in it hidden and shown", regionBefore.rendered && regionBefore.empty && regionSaying.rendered && !regionSaying.empty, JSON.stringify({ regionBefore, regionSaying }));
    // Shown, it is a row of the dialog again: in the flow, under the heading, not over it.
    check("the region FailedAlert speaks in is back in the dialog's flow, under its heading", regionBefore.position === "absolute" && regionSaying.position === "static" && regionSaying.belowHeading, JSON.stringify({ regionBefore, regionSaying }));
    // The soft destructive Alert's own background, from a probe with its classes in the dialog.
    const softDestructive = await rename.evaluate((d) => {
      const probe = document.createElement("div");
      probe.className = "alert__alert alert__destructive alert__soft";
      d.append(probe);
      const background = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return background;
    });
    check("FailedAlert draws no box before the failure, and the soft destructive alert while it is said", regionBefore.height === 0 && regionSaying.height > 0 && regionSaying.background === softDestructive && !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(softDestructive), JSON.stringify({ regionBefore, regionSaying, softDestructive }));
    await page.unroute(renameAt, cutRename);
    // Closed while the submit was on its way (Escape), the dialog shows nothing and the toaster says it.
    {
      /** @type {() => void} */
      let release = () => {};
      const gate = new Promise((resolve) => (release = () => resolve(undefined)));
      const held = async (/** @type {import("@playwright/test").Route} */ route) => {
        if (route.request().method() !== "POST") return route.fallback();
        await gate;
        await route.abort("connectionreset");
      };
      await page.route(renameAt, held);
      await page.getByRole("button", { name: "Rename draft" }).click();
      await page.locator("#rename-name").fill("Cut draft");
      const taken = page.evaluate(() => new Promise((resolve) => document.addEventListener("corten:error", (e) => queueMicrotask(() => resolve(e.defaultPrevented)), { once: true })));
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      await page.waitForTimeout(200);
      await page.keyboard.press("Escape");
      release();
      const prevented = await taken;
      const toastShown = await page.locator("#ui-toast").waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
      const stale = await said.evaluate((p) => !(/** @type {HTMLElement} */ (p).hidden));
      check("a dialog closed before its submit failed shows nothing, and the toaster says it", !prevented && toastShown && !stale, JSON.stringify({ prevented, toastShown, stale }));
      await page.unroute(renameAt, held);
      await page.getByRole("button", { name: "Dismiss" }).click().catch(() => {});
    }
    await page.locator("#rename-name").evaluate((i) => (/** @type {HTMLInputElement} */ (i).value = ""));
    errors.splice(errorsAt, errors.length - errorsAt, ...errors.slice(errorsAt).filter((e) => !/ERR_CONNECTION_RESET/.test(e)));
  }
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
      if (req.method() !== "GET" || req.resourceType() !== "fetch" || swapped(req)) return route.fallback();
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
      const whole = req.resourceType() === "document" || (req.resourceType() === "fetch" && !swapped(req));
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
    page.waitForURL(renameAt),
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
}

export async function dialogLayout(browser, orders, start, end, row) {
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
     * header and those it reached; then removes the rows. Returns the covered count, or -1 when a
     * Shift+Tab did not land on a row and -2 when a row never held its place, so neither passes.
     * @param {import("@playwright/test").Page} page
     * @param {string} selector The dialog or sheet.
     */
    const focusUp = async (page, selector) => {
      let covered = 0;
      let reached = 0;
      let unsettled = 0;
      for (let i = 0; i < 39; i++) {
        await page.keyboard.press("Shift+Tab");
        // Read once the row has stopped moving: WebKit scrolls a focused row into view over a few
        // frames, and a row read mid-scroll can sit under the header it ends well below (one read at
        // 28 px under it settled 248 px below it). Read once it has kept its place for two frames; one
        // still moving after 120 frames is not read as settled.
        const [row, under, settled] = await page.locator(selector).evaluate(async (box) => {
          const header = /** @type {HTMLElement} */ (box.querySelector(":scope > [class*='__header']"));
          const now = document.activeElement;
          if (!now?.hasAttribute("data-smoke-row")) return [false, false, true];
          const gap = () => now.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
          let last = gap();
          let same = 0;
          for (let frames = 0; same < 2 && frames < 120; frames++) {
            await new Promise((done) => requestAnimationFrame(() => done(undefined)));
            const next = gap();
            same = next === last ? same + 1 : 0;
            last = next;
          }
          return [true, last < -1, same >= 2];
        });
        if (row) reached += 1;
        if (under) covered += 1;
        if (!settled) unsettled += 1;
      }
      await page.locator(selector).evaluate((box) => {
        box.querySelectorAll("[data-smoke-row]").forEach((row) => row.remove());
        box.scrollTop = 0;
      });
      // Every Shift+Tab lands on a row and every row settles, so a covered count of 0 is a measurement.
      if (reached !== 39) return -1;
      return unsettled === 0 ? covered : -2;
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
}
