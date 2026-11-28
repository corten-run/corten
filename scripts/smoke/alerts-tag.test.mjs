// Focused DOM controls for the Firefox alerts smoke. No server needed.
import assert from "node:assert/strict";
import test from "node:test";
import { firefox } from "@playwright/test";
import { askingInPlace, captureAlertsDraw } from "./page-refresh.mjs";

test("only the asking tag drawn into the original slot counts", { timeout: 30_000 }, async (t) => {
  const browser = await firefox.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const url = "http://localhost/alerts?saved=1";
  for (const where of ["slot", "wrong-parent", "wrong-sibling", "missing"]) {
    await page.setContent(`<main><p id="alert-status">Saving...</p><div><i></i><template data-corten-read-again="1" data-from="${url}"></template></div></main>`);
    const read = await page.evaluateHandle(captureAlertsDraw);
    try {
      const draw = await page.evaluate(({ read, where }) => {
        const status = document.querySelector("p");
        status.replaceWith(status.cloneNode(true));
        const tag = document.querySelector("template");
        const replacement = tag.cloneNode(true);
        tag.replaceWith(replacement);
        if (where === "wrong-parent") document.querySelector("main").append(replacement);
        if (where === "wrong-sibling") document.querySelector("div").prepend(replacement);
        if (where === "missing") replacement.parentNode.removeChild(replacement);
        return read();
      }, { read, where });
      assert.ok(draw && draw.pageTagGone);
      assert.equal(draw.status, "Saving...");
      assert.deepEqual(draw.tags, where === "missing" ? [] : [url]);
      assert.equal(askingInPlace(draw, url), where === "slot", where);
    } finally {
      await read.dispose();
    }
  }
});
