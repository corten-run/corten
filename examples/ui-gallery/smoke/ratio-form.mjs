import { base, check } from "./helpers.mjs";
import { liveRegion } from "../../../scripts/smoke/live-region.mjs";

export async function ratioForm(browser, report = check) {
  const page = await browser.newPage();
  try {
    await page.goto(`${base}/help`);
    const minimum = page.getByLabel("Minimum ratio example");
    const submit = page.getByRole("button", { name: "Check the example ratios" });
    const post = async (value) => {
      await minimum.fill(value);
      const observer = await liveRegion(page, "result");
      const [response] = await Promise.all([
        page.waitForResponse((r) => new URL(r.url()).pathname === "/help" && r.request().method() === "POST", { timeout: 5000 }),
        submit.click(),
      ]);
      return { response, ...observer };
    };

    const success = "Both ratios are in range.";
    const valid = await post("0.002");
    await page.waitForFunction((text) => document.getElementById("result")?.textContent === text, success, { timeout: 5000 });
    const keptOnSuccess = await valid.stayed();
    report("a valid ratio patches success into the existing live region",
      keptOnSuccess && valid.text === "" && valid.response.status() === 200 && valid.response.headers()["corten-patch"] === "1");

    // The browser's inclusive minimum admits this value; the server's exclusive minimum refuses it.
    const invalid = await post("0.001");
    await page.waitForFunction(() => document.getElementById("result")?.textContent === "", null, { timeout: 5000 });
    const keptOnRefusal = await invalid.stayed();
    report("a refused ratio clears the success inside the same live region",
      keptOnRefusal && invalid.text === success && invalid.response.status() === 422 && invalid.response.headers()["corten-patch"] === "1");
    const [hint, error] = (await minimum.getAttribute("aria-describedby") ?? "").split(/\s+/);
    const message = error && page.locator(`[id="${error}"]`);
    report("the refused ratio patch still renders its linked field error",
      Boolean(hint && hint !== error && message && await message.isVisible() &&
        await minimum.getAttribute("aria-invalid") === "true" && await minimum.inputValue() === "0.001" &&
        await message.textContent() === "Enter a ratio above 0.001 and at most 1."));
  } finally {
    await page.close();
  }
}
