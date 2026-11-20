import { base, check } from "./helpers.mjs";

export async function printButton(browser, errors) {
  // PrintButton: shown once its script connects; a click opens the print dialog (counted here).
  const printing = await (await browser.newContext()).newPage();
  printing.on("pageerror", (e) => errors.push(e.message));
  await printing.addInitScript(() => {
    window.print = () => {
      /** @type {any} */ (window).printed = (/** @type {any} */ (window).printed ?? 0) + 1;
    };
  });
  await printing.goto(`${base}/`);
  const printButton = printing.getByRole("button", { name: "Print label", exact: true });
  await printButton.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  check("the print button shows once its script connects", await printButton.isVisible());
  await printButton.click();
  const printed = await printing.evaluate(() => /** @type {any} */ (window).printed ?? 0);
  check("a click opens the print dialog once", printed === 1, String(printed));
  await printing.context().close();
}
