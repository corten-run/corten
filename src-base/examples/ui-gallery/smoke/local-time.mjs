import { base, check } from "./helpers.mjs";

export async function localTime(browser) {
  // LocalTime: a browser's first page is written in UTC, since its zone is not known yet, and the
  // script writes it again in the browser's; on the next page the server writes it in that zone.
  const kiwi = await (await browser.newContext({ timezoneId: "Pacific/Auckland" })).newPage();
  await kiwi.goto(`${base}/`);
  const drafted = kiwi.locator("p", { hasText: "Drafted" }).locator("time");
  await kiwi.waitForFunction(() => document.cookie.includes("corten-zone=") && document.body.textContent?.includes("GMT+13"), null, { timeout: 5000 }).catch(() => {});
  const firstDrafted = await drafted.textContent();
  check("a first page's date is written again in the browser's zone", firstDrafted === "Mar 23, 2026, 4:04 AM GMT+13", firstDrafted);
  await kiwi.reload();
  const nextDrafted = await drafted.textContent();
  check("the next page's server writes it in that zone, with no script", nextDrafted === firstDrafted && (await drafted.getAttribute("data-on")) === null, nextDrafted);
  await kiwi.context().close();
}
