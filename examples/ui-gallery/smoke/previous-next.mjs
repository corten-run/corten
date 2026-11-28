import { check } from "./helpers.mjs";

export async function previousNext(orders) {
  // PreviousNext: the payouts card knows only its neighbours, so each end it is at is a disabled
  // step in Pagination's look and each neighbour a link with its rel (#1073).
  {
    const payouts = orders.getByRole("navigation", { name: "Payouts" });
    /** Each step's tag, rel and aria-disabled. */
    const steps = () =>
      payouts.locator("[class*='pagination__step']").evaluateAll((all) =>
        all.map((el) => `${el.tagName.toLowerCase()} ${el.getAttribute("rel") ?? "-"} ${el.getAttribute("aria-disabled") ?? "-"}`).join(", "),
      );
    /** The card's heading and its timeline's references, so a pager that moves only the address fails. */
    const shown = async () => {
      // The innermost section around the pager: the card, not a column around it.
      const card = orders.locator("section", { has: payouts }).last();
      const heading = await card.locator("h2").textContent();
      const refs = (await card.getByRole("list", { name: "Payout", exact: true }).textContent())?.match(/PX-\d+/g) ?? [];
      return `${heading} ${refs.join()}`;
    };
    check("PreviousNext: the newest payout is shown first", (await shown()) === "Payout of Mar 21 PX-20431", await shown());
    const newest = await steps();
    check("PreviousNext: the newest payout's Newer is disabled and Older a next link", newest === "span - true, a next -", newest);
    await payouts.getByRole("link", { name: "Older" }).click();
    await orders.getByRole("heading", { name: "Payout of Mar 14" }).waitFor({ timeout: 5000 }).catch(() => {});
    const middle = await steps();
    const older = await shown();
    check("PreviousNext: Older goes to the older payout on the same page of orders, whose both neighbours are links", new URL(orders.url()).search === "?page=2&payout=1" && middle === "a prev -, a next -" && older === "Payout of Mar 14 PX-20377", `${orders.url()} ${middle} ${older}`);
    await payouts.getByRole("link", { name: "Older" }).click();
    await orders.getByRole("heading", { name: "Payout of Mar 7" }).waitFor({ timeout: 5000 }).catch(() => {});
    const oldest = await steps();
    const look = await payouts.locator("[aria-disabled='true']").evaluate((el) => getComputedStyle(el).opacity);
    const oldestShown = await shown();
    check("PreviousNext: the oldest payout's Older is disabled in Pagination's look", oldest === "a prev -, span - true" && look === "0.5" && oldestShown === "Payout of Mar 7 PX-20318", `${oldest} opacity ${look} ${oldestShown}`);
    await payouts.getByRole("link", { name: "Newer" }).click();
    await orders.getByRole("heading", { name: "Payout of Mar 14" }).waitFor({ timeout: 5000 }).catch(() => {});
    check("PreviousNext: Newer goes back", new URL(orders.url()).search === "?page=2&payout=1" && (await shown()) === "Payout of Mar 14 PX-20377", `${orders.url()} ${await shown()}`);
  }
}
