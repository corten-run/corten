import { check } from "./helpers.mjs";

export async function layout(orders) {
  // StackStart: a column whose children keep their own width, a link as wide as its words and a
  // badge, each at most the column's; at 320px a word wider than the column breaks inside its link,
  // and a picture wider than the column narrows in its shape (#1119).
  const startColumn = async () =>
    orders.getByRole("link", { name: "How selling limits work" }).evaluate((a) => {
      const column = /** @type {HTMLElement} */ (a.parentElement);
      const box = column.getBoundingClientRect();
      const kids = [...column.children].map((c) => c.getBoundingClientRect());
      return {
        column: Math.round(box.width),
        widths: kids.map((k) => Math.round(k.width)),
        atStart: kids.every((k) => Math.abs(k.left - box.left) <= 0.5),
        inside: kids.every((k) => k.right <= box.right + 0.5),
      };
    });
  const startWide = await startColumn();
  const startSize = orders.viewportSize();
  await orders.setViewportSize({ width: 320, height: 640 });
  const startLong = await orders.getByRole("link", { name: "How selling limits work" }).evaluate(async (a) => {
    const column = /** @type {HTMLElement} */ (a.parentElement);
    const [was, one] = [a.textContent, a.getBoundingClientRect().height];
    // One word, far wider than the column: only the kit's break keeps it in.
    a.textContent = "W".repeat(100);
    const link = a.getBoundingClientRect();
    const box = column.getBoundingClientRect();
    const word = { inside: link.right <= box.right + 0.5, overflow: a.scrollWidth > a.clientWidth + 1 || column.scrollWidth > column.clientWidth + 1, wrapped: link.height > one * 1.5 };
    a.textContent = was;
    // A square picture twice the column's width, its size in its own width and height (the page's
    // own icon, which the page's CSP lets it load): narrowed to the column, and still square.
    const img = document.createElement("img");
    img.width = 640;
    img.height = 640;
    img.alt = "";
    img.src = /** @type {HTMLLinkElement} */ (document.querySelector("link[rel=icon]")).href;
    column.append(img);
    await img.decode().catch(() => {});
    const pic = img.getBoundingClientRect();
    img.remove();
    return { ...word, picture: { width: Math.round(pic.width), height: Math.round(pic.height), column: Math.round(box.width) } };
  });
  // On the phone too: a dialog or popover written in the column (beside the button that opens it)
  // keeps the browser's margin: auto and width, so a modal with a long word opens in the middle of
  // the screen, clear of its edges, the word broken inside it, and a popover without an anchor in
  // the middle (#1124). A paragraph there still drops its margin.
  const topLayer = await orders.getByRole("link", { name: "How selling limits work" }).evaluate((a) => {
    const column = /** @type {HTMLElement} */ (a.parentElement);
    const [dialog, popover, para] = [document.createElement("dialog"), document.createElement("div"), document.createElement("p")];
    const line = document.createElement("p");
    line.textContent = "W".repeat(100);
    dialog.append(line);
    popover.popover = "manual";
    popover.textContent = "Saved";
    para.textContent = "Saved";
    column.append(dialog, popover, para);
    dialog.showModal();
    popover.showPopover();
    const place = (/** @type {HTMLElement} */ el) => {
      // Against the viewport without a classic scrollbar, where the top layer lays them out.
      const r = el.getBoundingClientRect();
      const { clientWidth, clientHeight } = document.documentElement;
      return [r.top, clientHeight - r.bottom, r.left, clientWidth - r.right].map(Math.round);
    };
    const at = { dialog: place(dialog), sideways: dialog.scrollWidth > dialog.clientWidth + 1, popover: place(popover), para: getComputedStyle(para).marginBlockStart };
    popover.hidePopover();
    dialog.close();
    for (const el of [dialog, popover, para]) el.remove();
    return at;
  });
  if (startSize) await orders.setViewportSize(startSize);
  const middle = (/** @type {number[]} */ [top, bottom, left, right]) => Math.abs(top - bottom) <= 1 && Math.abs(left - right) <= 1 && top > 0;
  check(
    "Stack: a dialog or popover in it opens in the middle of a phone's screen, a dialog with a long word clear of the edges and breaking it, and a paragraph drops its margin",
    middle(topLayer.dialog) && topLayer.dialog[2] >= 16 && !topLayer.sideways && middle(topLayer.popover) && topLayer.para === "0px",
    JSON.stringify(topLayer),
  );
  check(
    "StackStart: a column's link and badge keep their own width at its start; on a phone a word wider than it breaks inside its link and a picture narrows in its shape",
    startWide.widths.every((w) => w < startWide.column - 8) && startWide.atStart && startWide.inside && startLong.inside && !startLong.overflow && startLong.wrapped && Math.abs(startLong.picture.width - startLong.picture.column) <= 1 && Math.abs(startLong.picture.height - startLong.picture.width) <= 1,
    JSON.stringify({ startWide, startLong }),
  );
}

export async function appSpacing(orders) {
  // Gap::App: the payout row is a cluster with no gap class of the kit's, so the page's .75rem is its gap.
  const appGap = await orders.evaluate(() => {
    const row = document.querySelector("[class*='orders__payout']");
    if (!row) return null;
    const style = getComputedStyle(row);
    return {
      cluster: /stack__cluster/.test(row.className),
      kitGap: /stack__(xs|sm|md|lg|xl)\b/.test(row.className),
      wraps: style.flexWrap,
      gap: parseFloat(style.columnGap) / parseFloat(getComputedStyle(document.documentElement).fontSize),
    };
  });
  check("Cluster with Gap::App: no kit gap class, so the page's own gap is the row's", appGap?.cluster === true && !appGap.kitGap && appGap.wraps === "wrap" && appGap.gap === 0.75, JSON.stringify(appGap));
  await orders.getByRole("button", { name: "Share the shop" }).click();
  check("Popover: its button opens it", await orders.locator("#share").evaluate((p) => p.matches(":popover-open")));
  await orders.keyboard.press("Escape");
  check("Popover: Escape closes it", !(await orders.locator("#share").evaluate((p) => p.matches(":popover-open"))));
  await orders.getByText("What if an order ships late?").click();
  const open = await orders.locator("details").evaluateAll((all) => all.map((d) => /** @type {HTMLDetailsElement} */ (d).open).join());
  check("Accordion: one section open at a time", open === "false,true,false", open);
  await orders.getByRole("link", { name: "Next" }).click();
  await orders.locator("caption", { hasText: "Page 2 of 3" }).waitFor({ timeout: 5000 }).catch(() => {});
  check("Pagination: Next goes to the next page", new URL(orders.url()).search === "?page=2" && (await orders.locator('[aria-current="page"]').last().textContent()) === "2", orders.url());
}
