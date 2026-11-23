import { base, engine, check } from "./helpers.mjs";

export async function copyButton(browser, bug, errors) {
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
  await clip.evaluate(() => {
    const sku = document.querySelector("#sku");
    const form = document.createElement("form");
    form.id = sku.id;
    form.textContent = "form SKU";
    const field = document.createElement("input");
    field.type = "hidden";
    field.name = "textContent";
    form.append(field);
    sku.removeAttribute("id");
    sku.parentElement.after(form);
    Object.defineProperty(navigator.clipboard, "writeText", { value: async (text) => { window.copiedFormText = String(text); } });
  });
  await copyButton.click();
  await copies.filter({ hasText: "2" }).waitFor({ timeout: 5000 }).catch(() => {});
  check("CopyButton: a form with a control named textContent still copies the form's text",
    await copies.textContent() === "2" && await clip.evaluate(() => window.copiedFormText) === "form SKU");
  const adopted = await clip.evaluate(() => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const from = frame.contentDocument;
    const form = from.createElement("form");
    form.id = "sku";
    form.textContent = "adopted SKU";
    const field = from.createElement("input");
    field.type = "hidden";
    field.name = "textContent";
    form.append(field);
    document.getElementById("sku").replaceWith(document.adoptNode(form));
    return form.ownerDocument === document && form.textContent === field;
  });
  await copyButton.click();
  await copies.filter({ hasText: "3" }).waitFor({ timeout: 5000 }).catch(() => {});
  const adoptedText = await clip.evaluate(() => window.copiedFormText);
  check("CopyButton: an adopted form with a control named textContent still copies the form's text",
    adopted && await copies.textContent() === "3" && adoptedText === "adopted SKU", JSON.stringify({ adopted, adoptedText }));
  await clip.context().close();
  // Removal cancels even a write that has not answered yet. Returning the same button starts
  // a new lifetime; the previous click must not publish into it or start a new label timer.
  {
    const late = await browser.newPage();
    late.on("pageerror", (e) => errors.push(e.message));
    await late.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
      writeText: () => new Promise((resolve) => { window.finishCopy = resolve; }),
    } }));
    await late.goto(`${base}/`);
    await late.getByRole("button", { name: "Copy", exact: true }).click();
    await late.evaluate(() => {
      window.lateButton = document.querySelector('[data-scope="ui-copy-button"]');
      window.returnCopy = document.createComment("copy returns here");
      window.lateButton.before(window.returnCopy);
      window.lateButton.remove();
    });
    await late.waitForTimeout(50);
    await late.evaluate(() => window.returnCopy.replaceWith(window.lateButton));
    await late.waitForTimeout(50);
    await late.evaluate(() => window.finishCopy());
    await late.waitForTimeout(50);
    check("a copy finishing after removal and reconnect cannot change the new lifetime's label or report a copy",
      await late.locator('[data-scope="ui-copy-button"] [aria-live]').textContent() === "Copy" && await late.locator('output[aria-label="Copies"]').textContent() === "0");
    await late.close();
  }
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
}
