// Real nested branches, their durable state, IDs, and cancellation in all three browser engines.
// Usage: node examples/deck-builder/preview-smoke.mjs <base url> [chromium|firefox|webkit ...]
import { chromium, firefox, webkit } from "@playwright/test";
import { steady } from "../../scripts/steady.mjs";
import { stall } from "../../scripts/stall.mjs";

const base = process.argv[2];
if (!base) throw new Error("A base URL is required");
const engines = { chromium, firefox, webkit };
const names = process.argv.slice(3).length ? process.argv.slice(3) : Object.keys(engines);
const failures = [];
const seen = stall(5);
for (const name of names) {
  const check = (label, ok, detail = "") => {
    seen(`${name}: ${label}`);
    console.log(`${ok ? "ok" : "FAIL"} [${name}] ${label}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures.push(`${name}: ${label}`);
  };
  const browser = steady(await engines[name].launch({ headless: true }));
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      window.writes = [];
      Object.defineProperty(navigator, "clipboard", { value: { writeText: (text) => {
        window.writes.push(text);
        return window.deferCopy ? new Promise((resolve) => { window.finishCopy = resolve; }) : Promise.resolve();
      } } });
    });
    await page.goto(base);
    await page.evaluate(async () => { const { ready } = await import("corten"); await ready; });
    await page.getByText("Deck list", { exact: true }).click();
    const a = page.getByRole("region", { name: "Plan A", exact: true });
    const b = page.getByRole("region", { name: "Plan B", exact: true });
    await a.getByRole("button", { name: "Edit draft" }).waitFor({ state: "visible" });
    const ids = await page.evaluate(() => {
      const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
      const labels = [...document.querySelectorAll('[aria-label="Plan A"] label, [aria-label="Plan B"] label')];
      return ids.length === new Set(ids).size && labels.length === 4 && labels.every((label) => {
        const field = document.getElementById(label.htmlFor);
        return field?.closest('[aria-label="Plan A"], [aria-label="Plan B"]') === label.closest('[aria-label="Plan A"], [aria-label="Plan B"]');
      });
    });
    check("two real trees have unique IDs and labels resolve within their own instance", ids);
    await a.getByLabel("Notes", { exact: true }).fill("Sideboard against flyers");
    await b.getByLabel("Notes", { exact: true }).fill("Plan B only");
    await a.getByText("About this draft", { exact: true }).click();
    await a.getByLabel("Notes", { exact: true }).focus();
    const retained = await a.evaluate(async (root) => {
      const field = root.querySelector("textarea");
      field.setSelectionRange(3, 8);
      const branch = root.querySelector('[id^="preview-editor-"]');
      const { DeckPreviewChanged } = await import("corten/events");
      root.dispatchEvent(new DeckPreviewChanged({ total: 7, text: "7 Gravel Sprite" }));
      return field === root.querySelector("textarea") && document.activeElement === field && field.selectionStart === 3 && branch === root.querySelector('[id^="preview-editor-"]') && root.querySelector("details").open;
    });
    check("same-branch data updates retain child identity, focus, selection and native disclosure state", retained);
    await a.getByRole("button", { name: "Copy export", exact: true }).click();
    await page.waitForFunction(() => window.writes.length === 1);
    check("the real CopyButton reads the active typed-ID field", await page.evaluate(() => window.writes[0] === "7 Gravel Sprite"));
    await a.evaluate((root) => {
      const field = root.querySelector("textarea");
      field.value = "Keep this draft";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      window.oldNotes = root.querySelector('[data-scope="draft-notes"]');
      window.oldHelp = window.oldNotes.querySelector("details");
      window.oldHelp.open = true;
      [...root.querySelectorAll("button")].find((b) => b.textContent === "Summary").click();
    });
    await page.keyboard.press("Escape");
    // Wait beyond the child's known debounce to prove no late work touched the detached tree.
    await page.waitForTimeout(300);
    check("removed children stop their timer and document handler", await page.evaluate(() => !window.oldNotes.isConnected && window.oldHelp.open && !window.oldNotes.querySelector("p[data-ref=editing]").hidden));
    check("switching A leaves B's independent draft intact", await b.getByLabel("Notes", { exact: true }).inputValue() === "Plan B only");
    const reconnected = await a.evaluate(async (root) => {
      const before = root.querySelector('[id^="preview-summary-"]');
      const marker = document.createComment("return here");
      root.before(marker);
      root.remove();
      await new Promise((r) => setTimeout(r, 50));
      marker.replaceWith(root);
      await new Promise((r) => setTimeout(r, 50));
      return root.querySelector('[id^="preview-summary-"]') === before;
    });
    check("reconnect adopts the actual summary without replacing or assuming the editor", reconnected);
    await a.getByRole("button", { name: "Edit draft", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Plan A"] textarea')?.value === "Keep this draft");
    check("a fresh nested editor restores parent-owned state but resets native disclosure state", await a.getByLabel("Notes", { exact: true }).inputValue() === "Keep this draft" && await a.locator("details").getAttribute("open") === null);
    await a.getByText("About this draft", { exact: true }).click();
    await page.keyboard.press("Escape");
    check("the new grandchild's document listener connects", await a.locator("details").getAttribute("open") === null);
    await page.evaluate(() => { window.deferCopy = true; });
    await a.getByRole("button", { name: "Copy export", exact: true }).click();
    await a.evaluate((root) => { window.oldCopy = root.querySelector('[data-scope="ui-copy-button"]'); });
    await a.getByRole("button", { name: "Summary", exact: true }).click();
    await page.evaluate(() => window.finishCopy());
    await page.waitForTimeout(50);
    check("a clipboard result after branch removal cannot restart a child's UI work", await page.evaluate(() => window.oldCopy.textContent === "Copy export"));
    const replaced = await a.evaluate(async (root) => {
      const old = root.querySelector('[id^="preview-summary-"]');
      const fresh = old.cloneNode(true);
      old.replaceWith(fresh);
      const { DeckPreviewChanged } = await import("corten/events");
      root.dispatchEvent(new DeckPreviewChanged({ total: 9, text: "9 Gravel Sprite" }));
      return fresh === root.querySelector('[id^="preview-summary-"]') && fresh.querySelector("strong").textContent === "9";
    });
    check("an external replacement is read rather than a cached detached branch", replaced);
    await a.evaluate((root) => {
      window.removedExport = root.querySelector('textarea[readonly]');
      root.querySelector('[id^="preview-summary-"]').parentElement.replaceChildren();
    });
    await a.getByRole("button", { name: "Summary", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Plan A"] textarea')?.value === "9 Gravel Sprite");
    const exportLifetimes = await a.evaluate(async (root) => {
      const old = window.removedExport.value;
      const { DeckPreviewChanged } = await import("corten/events");
      root.dispatchEvent(new DeckPreviewChanged({ total: 11, text: "11 Gravel Sprite" }));
      return !window.removedExport.isConnected && window.removedExport.value === old && root.querySelector("textarea").value === "11 Gravel Sprite" && document.querySelector('[aria-label="Plan B"] textarea[readonly]').value !== "11 Gravel Sprite";
    });
    check("an empty host recovers without child refs, and only the live owner's export handles updates", exportLifetimes);
    const count = page.locator('ul li input[type="number"]').first();
    const before = Number(await count.inputValue());
    const saved = page.waitForResponse((r) => new URL(r.url()).pathname === "/deck" && r.request().method() === "POST");
    await count.fill(String(before - 1));
    await count.press("Tab");
    check("the real count edit is accepted by the server", (await saved).status() === 200);
    await page.waitForFunction(() => {
      const total = Number(document.querySelector('p[class$="__total"] output').textContent);
      return [...document.querySelectorAll('[aria-label="Plan A"] strong, [aria-label="Plan B"] strong')].every((el) => Number(el.textContent) === total);
    });
    check("a real deck edit updates both nested owners without erasing B's draft", await b.getByLabel("Notes", { exact: true }).inputValue() === "Plan B only");
    await page.waitForFunction(() => document.querySelector('#save-note')?.textContent === "Saved.");
    const undone = page.waitForResponse((r) => new URL(r.url()).pathname === "/deck" && r.request().method() === "POST");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    check("undo restores the saved fixture before the next engine", (await undone).status() === 200);
    await page.waitForFunction(() => document.querySelector('#save-note')?.textContent === "Saved.");
    check("no handler, CSP or browser errors", errors.length === 0, errors.join("; "));
    if (name === "chromium" && process.env.PREVIEW_SCREENSHOT) {
      await page.setViewportSize({ width: 1400, height: 1100 });
      await a.getByRole("button", { name: "Edit draft", exact: true }).click();
      await a.scrollIntoViewIfNeeded();
      await page.screenshot({ path: process.env.PREVIEW_SCREENSHOT });
    }
    const plain = await browser.newPage({ javaScriptEnabled: false });
    await plain.goto(base);
    await plain.getByText("Deck list", { exact: true }).click();
    check("without scripts the server-rendered editor and export remain usable", await plain.getByRole("region", { name: "Plan A", exact: true }).getByLabel("Notes", { exact: true }).isVisible());
  } finally { await browser.close(); }
}
if (failures.length) throw new Error(failures.join("\n"));
