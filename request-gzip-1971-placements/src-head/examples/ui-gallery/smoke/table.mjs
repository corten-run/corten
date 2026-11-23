import { base, engine, skip, check } from "./helpers.mjs";

export async function tableCells(orders) {
  // A look is classes on the app's own element: the badge is the cell's child, a button's parent is
  // the app's, and no element of the kit's takes no box around one.
  const looks = await orders.evaluate(() => ({
    badge: document.querySelector("td > [class*='badge__badge']")?.tagName ?? "missing",
    wrappers: [...document.querySelectorAll(["button", "input", "select", "textarea", "slider", "badge", "card", "dialog", "sheet", "popover", "accordion"].map((n) => `[class*='${n}__']`).join())]
      .filter((e) => getComputedStyle(e).display === "contents").length,
    button: document.querySelector("[class*='button__button']")?.parentElement?.className.includes("button__") ?? "missing",
  }));
  check("Looks: the kit's classes are on the app's elements, with none of its own around them", looks.badge === "SPAN" && looks.wrappers === 0 && looks.button === false, JSON.stringify(looks));
  // The cells have no specificity of their own (`:where`): a text cell wraps, a number cell is end
  // aligned on one line, and the header stays on one line.
  const cells = await orders.evaluate(() => {
    const style = (/** @type {string} */ sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el) : null;
    };
    const text = style("tbody td:nth-child(2)");
    const number = style("tbody td[class*='table__numeric']");
    return { text: text?.whiteSpace, number: number && `${number.textAlign} ${number.whiteSpace}`, head: style("thead th")?.whiteSpace };
  });
  check("Table: a text cell wraps, a number cell is end aligned on one line", cells.text === "normal" && cells.number === "end nowrap" && cells.head === "nowrap", JSON.stringify(cells));
  // SortHeader's arrow is drawn from the header's aria-sort, the state a script that sorts the rows
  // in place sets (an attribute, which the CSP allows), so the arrow follows it (#606).
  const arrows = await orders.evaluate(() => {
    const arrow = document.querySelector("[class*='table__arrow']");
    const th = arrow?.closest("th");
    if (!arrow || !th) return null;
    const drawn = () => `${getComputedStyle(arrow).opacity} ${getComputedStyle(arrow).clipPath}`;
    const out = [drawn()];
    for (const sort of ["descending", "ascending"]) {
      th.setAttribute("aria-sort", sort);
      out.push(drawn());
    }
    th.removeAttribute("aria-sort");
    return out;
  });
  check(
    "SortHeader: the arrow follows aria-sort, unsorted, descending and ascending each drawn",
    arrows !== null && arrows[0].startsWith("0.35 ") && arrows[1].startsWith("1 ") && arrows[2].startsWith("1 ") && new Set(arrows.map((a) => a.slice(a.indexOf(" ")))).size === 3,
    JSON.stringify(arrows),
  );
}

export async function responsiveTables(browser, orders) {
  // On a phone, a wide table in a part ShownFor wraps, in a card's content, scrolls inside the card
  // rather than widening the page: the card's column is no wider than the card.
  {
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await phone.goto(`${base}/`);
    const wide = await phone.locator("caption", { hasText: "This month's last sales" }).evaluate((caption) => {
      const box = /** @type {HTMLElement} */ (caption.closest("table")?.parentElement);
      const card = /** @type {HTMLElement} */ (box.closest("section"));
      return {
        scrolls: box.scrollWidth > box.clientWidth,
        cardFits: card.getBoundingClientRect().right <= innerWidth + 0.5,
        page: document.documentElement.scrollWidth,
        width: innerWidth,
      };
    });
    // The same table in a CardPanel the app places in its own grid, a flex row, a bare div in a grid
    // and an inline-block: the table's width is not its box's least width, so it scrolls in the
    // panel and the page does not (#796).
    const placed = await phone.locator("caption", { hasText: "This month's last sales" }).evaluate((caption) => {
      const box = /** @type {HTMLElement} */ (caption.closest("table")?.parentElement);
      return ["grid", "flex", "div", "inline-block"].map((place) => {
        const row = document.createElement("section");
        row.style.display = place === "flex" ? "flex" : place === "inline-block" ? "block" : "grid";
        const around = place === "div" ? row.appendChild(document.createElement("div")) : row;
        const panel = around.appendChild(document.createElement("div"));
        panel.className = "card__panel";
        if (place === "inline-block") panel.style.display = "inline-block";
        const table = /** @type {HTMLElement} */ (panel.appendChild(box.cloneNode(true)));
        document.querySelector("main")?.append(row);
        const inner = /** @type {HTMLTableElement} */ (table.querySelector("table"));
        const out = {
          place,
          scrolls: table.scrollWidth > table.clientWidth,
          // The table's box reaches its last cell (WebKit sized the box, and its rows, to the
          // scroller, with the cells running past them, without min-content).
          spans: inner.getBoundingClientRect().right + 1 >= /** @type {HTMLElement} */ ([...inner.rows[0].cells].at(-1)).getBoundingClientRect().right,
          panelFits: panel.getBoundingClientRect().right <= innerWidth + 0.5,
          page: document.documentElement.scrollWidth,
        };
        row.remove();
        return out;
      });
    });
    await phone.context().close();
    check("Table: in a ShownFor part on a phone, scrolls inside its card and the page does not", wide.scrolls && wide.cardFits && wide.page <= wide.width, JSON.stringify(wide));
    check("Table: in a CardPanel in an app's grid, flex row, a div in a grid or an inline-block on a phone, scrolls inside the panel and the page does not", placed.every((p) => p.scrolls && p.spans && p.panelFits && p.page <= wide.width), JSON.stringify(placed));
  }
  // A stacked table (the orders, TableLayout::Stack): at the desktop's width its cells' labels are
  // hidden. On a phone each order is a block of its cells, each label with what follows it on its
  // line, and the page does not scroll sideways, also with a row header, a long value, a cell of
  // text and an element, and a cell with no label (added here). The headers hold the sort link, so
  // they stay drawn, and in Chromium's accessibility tree it is still a table whose cells are not
  // named by the labels. An element after a label (the kit's Button, an app's pill) is as wide on a
  // phone as at the desktop's width, not stretched across the value column.
  {
    const hidden = await orders.evaluate(() => [...document.querySelectorAll("[class*='table__label']")].map((l) => getComputedStyle(l).display));
    /**
     * Adds two cells to the first order and reads them. A labelled one holds the kit's `Button`
     * (the orders page's own), a pill with no width of its own, a long word in a padded
     * content-box span, a button with the kit's `Tip` popover open beside it, and a kit `Dialog`
     * (`DialogSize::Sm`) open as a modal. A cell with no label holds a block. Returns the button's
     * and pill's widths, whether the word stays in the cell, where the popover is placed against
     * its control and its width (there and outside the table), the dialog's width (there and
     * outside the table), and whether the block fills its cell.
     * @param {import("@playwright/test").Page} page
     */
    const widths = (page) =>
      page.evaluate(async () => {
        const table = [...document.querySelectorAll("table")].find((t) => /^Page /.test(t.caption?.textContent ?? ""));
        const row = /** @type {HTMLTableRowElement} */ (table?.tBodies[0]?.rows[0]);
        const label = /** @type {Element} */ (row.querySelector("[class*='table__label']")).cloneNode(true);
        label.textContent = "Actions";
        const kit = /** @type {Element} */ (document.querySelector("[class*='button__button']"));
        const open = Object.assign(document.createElement("a"), { href: "#open", className: kit.className, textContent: "Open" });
        const pill = Object.assign(document.createElement("span"), { textContent: "Shipped" });
        pill.style.cssText = "display: inline-block; padding: 0 .5rem; border: 1px solid";
        const long = Object.assign(document.createElement("span"), { textContent: "acct_7f3a9c2e5b1d4f8a6c0e2b9d7a5f3c1e_7f3a9c2e5b1d4f8a" });
        long.style.cssText = "display: inline-block; box-sizing: content-box; padding: 0 .5rem; border: 1px solid";
        const shows = Object.assign(document.createElement("button"), { type: "button", textContent: "Why" });
        const tip = Object.assign(document.createElement("span"), { id: "stack-tip", className: "tip__tip", textContent: "A short reason" });
        tip.popover = "manual";
        const dialog = Object.assign(document.createElement("dialog"), { className: "dialog__dialog dialog__sm", textContent: "Refund this order? The buyer is told at once." });
        const cell = document.createElement("td");
        cell.append(label, open, pill, long, shows, tip, dialog);
        row.append(cell);
        const bare = document.createElement("td");
        const block = document.createElement("div");
        block.textContent = "Ships Monday";
        bare.append(block);
        row.append(bare);
        /** Where the tip shows beside the button: its center against the button's, and its width. */
        const placed = () => {
          tip.showPopover({ source: shows });
          const [t, s] = [tip.getBoundingClientRect(), shows.getBoundingClientRect()];
          tip.hidePopover();
          return [Math.round(t.left + t.width / 2 - (s.left + s.width / 2)), Math.round(t.width)];
        };
        /** The dialog's width, opened as a modal. */
        const modal = () => {
          dialog.showModal();
          const width = Math.round(dialog.getBoundingClientRect().width);
          dialog.close();
          return width;
        };
        const padding = parseFloat(getComputedStyle(bare).paddingLeft) + parseFloat(getComputedStyle(bare).paddingRight);
        const got = {
          sizes: [open, pill].map((e) => Math.round(e.getBoundingClientRect().width)),
          word: long.getBoundingClientRect().right <= cell.getBoundingClientRect().right + 0.5,
          block: Math.abs(block.getBoundingClientRect().width - (bare.clientWidth - padding)) <= 1,
          tip: placed(),
          tipOutside: [0, 0],
          dialog: [modal(), 0],
        };
        cell.remove();
        bare.remove();
        document.body.append(shows, tip, dialog);
        got.tipOutside = placed();
        got.dialog[1] = modal();
        shows.remove();
        tip.remove();
        dialog.remove();
        return got;
      });
    const wide = await widths(orders);
    check("Table: a stacked table's cell labels are hidden at the desktop's width", hidden.length > 0 && hidden.every((d) => d === "none"), JSON.stringify(hidden));
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await phone.goto(`${base}/orders`);
    const table = phone.locator("table", { has: phone.locator("caption", { hasText: /^Page / }) });
    const stacked = await table.evaluate((t) => {
      const body = /** @type {HTMLTableSectionElement} */ (t.tBodies[0]);
      const first = /** @type {HTMLTableRowElement} */ (body.rows[0]);
      const label = /** @type {HTMLElement} */ (first.querySelector("[class*='table__label']"));
      // A row the app might write: a row header with a long name, text and an element in one cell,
      // and a cell with no label.
      const extra = /** @type {HTMLTableRowElement} */ (first.cloneNode(true));
      const head = document.createElement("th");
      head.scope = "row";
      head.append(label.cloneNode(true), "Annabelle Kensington-Featherstonehaugh of acct_7f3a9c2e5b1d4f8a6c0e2b9d7a5f3c1e");
      extra.cells[0].replaceWith(head);
      const mixed = /** @type {HTMLTableCellElement} */ (extra.cells[1]);
      mixed.replaceChildren(label.cloneNode(true), "Max ", Object.assign(document.createElement("small"), { textContent: "(annual)" }));
      const bare = document.createElement("td");
      bare.append(Object.assign(document.createElement("button"), { type: "button", textContent: "Refund this order now" }));
      extra.append(bare);
      body.append(extra);
      // A row whose first cell is a row header holding a text cell's label and text (Card's): its
      // line is as tall as that cell's, not a column header's 2.5rem.
      const headed = /** @type {HTMLTableRowElement} */ (first.cloneNode(true));
      const short = document.createElement("th");
      short.scope = "row";
      short.append(...[...first.cells[1].childNodes].map((n) => n.cloneNode(true)));
      headed.cells[0].replaceWith(short);
      body.append(headed);
      /** @param {Element} cell */
      const beside = (cell) => {
        const tag = cell.querySelector("[class*='table__label']");
        if (!tag) return "-";
        const range = document.createRange();
        range.setStartAfter(tag);
        range.setEnd(cell, cell.childNodes.length);
        const [l, v] = [tag.getBoundingClientRect(), range.getBoundingClientRect()];
        return v.left >= l.right - 0.5 && v.top < l.bottom ? "beside" : `${Math.round(l.right)}/${Math.round(l.bottom)} ${Math.round(v.left)}/${Math.round(v.top)}`;
      };
      const cells = [...first.cells];
      const shown = cells.map((td) => {
        const tag = td.querySelector("[class*='table__label']");
        return tag && getComputedStyle(tag).display !== "none" && tag.getAttribute("aria-hidden") === "true" ? tag.textContent : "-";
      });
      const button = bare.firstElementChild?.getBoundingClientRect();
      const wrapper = /** @type {HTMLElement} */ (t.parentElement);
      // How far into its box each label's text starts: the same for a number's cell (Total).
      const indent = cells.map((td) => {
        const tag = td.querySelector("[class*='table__label']");
        if (!tag) return "-";
        const text = document.createRange();
        text.selectNodeContents(tag);
        return Math.round(text.getBoundingClientRect().left - tag.getBoundingClientRect().left);
      });
      // And where the number starts in its column: at the start, as text does, not at the end.
      const total = /** @type {HTMLTableCellElement} */ (first.cells[3]);
      const totalTag = /** @type {Element} */ (total.querySelector("[class*='table__label']"));
      const value = document.createRange();
      value.setStartAfter(totalTag);
      value.setEnd(total, total.childNodes.length);
      const number = Math.round(value.getBoundingClientRect().left - (totalTag.getBoundingClientRect().right + parseFloat(getComputedStyle(total).columnGap)));
      const out = {
        row: getComputedStyle(first).display,
        labels: shown.join(),
        beside: cells.map(beside).join(),
        indent: indent.join(),
        number,
        extra: [head, mixed].map(beside).join(),
        bare: !!button && Math.round(button.left - bare.getBoundingClientRect().left) <= 12,
        head: Math.round(/** @type {HTMLElement} */ (t.tHead).getBoundingClientRect().height),
        rowHeader: [short, first.cells[1]].map((c) => Math.round(c.getBoundingClientRect().height)).join(),
        // The long row header's text, which wraps, stays inside its box.
        longFits: (() => {
          const text = document.createRange();
          text.selectNodeContents(head);
          return text.getBoundingClientRect().bottom <= head.getBoundingClientRect().bottom + 0.5;
        })(),
        page: document.documentElement.scrollWidth <= innerWidth,
        wrapper: wrapper.scrollWidth <= wrapper.clientWidth,
      };
      extra.remove();
      headed.remove();
      return out;
    });
    check(
      "Table: on a phone a stacked table's rows are blocks of labelled cells inside the page, the labels lined up (a number's too), a row header (as tall as a cell, a long one holding its text) and mixed content too",
      stacked.row === "grid" &&
        stacked.labels === "Buyer,Card,Status,Total,-" &&
        stacked.beside === "beside,beside,beside,beside,-" &&
        stacked.indent === "0,0,0,0,-" &&
        Math.abs(stacked.number) <= 1 &&
        stacked.extra === "beside,beside" &&
        stacked.rowHeader.split(",")[0] === stacked.rowHeader.split(",")[1] &&
        stacked.longFits &&
        stacked.bare &&
        stacked.page &&
        stacked.wrapper,
      JSON.stringify(stacked),
    );
    const narrow = await widths(phone);
    // A small tablet, still stacked: wide enough that a dialog's own max-width, not the window,
    // sets its width, so a rule that overrode it would show.
    await phone.setViewportSize({ width: 600, height: 844 });
    await phone.waitForFunction(() => innerWidth === 600, null, { timeout: 5000 }).catch(() => {});
    const tablet = await widths(phone);
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.waitForFunction(() => innerWidth === 390, null, { timeout: 5000 }).catch(() => {});
    check(
      "Table: stacked, an element after a cell's label (a Button, a pill) is as wide as at the desktop's width, a padded long word stays in the cell, a tooltip there is centered on its control at its own width, a dialog there is as wide as outside the table (at 390 and 600px), and a block in a cell with no label fills it",
      wide.sizes.every((w, i) => w > 0 && Math.abs(w - narrow.sizes[i]) <= 1) &&
        narrow.word &&
        narrow.block &&
        Math.abs(narrow.tip[0]) <= 1 &&
        Math.abs(narrow.tip[1] - narrow.tipOutside[1]) <= 1 &&
        [narrow, tablet].every((r) => r.dialog[0] > 0 && Math.abs(r.dialog[0] - r.dialog[1]) <= 1),
      JSON.stringify({ wide, narrow, tablet: tablet.dialog }),
    );
    const sorter = await table.locator("thead a").first().evaluate((a) => {
      const box = a.getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height), inside: box.left >= 0 && box.right <= innerWidth, at: innerWidth };
    });
    check("Table: on a phone a stacked table's sort link is drawn, so it sorts by touch", stacked.head > 1 && sorter.width > 1 && sorter.height > 1 && sorter.inside && sorter.at === 390, JSON.stringify({ head: stacked.head, ...sorter }));
    const rolesName = "Table: stacked, the accessibility tree still has a table, its column headers and cells, which the labels do not name";
    if (engine === "chromium") {
      const cdp = await phone.context().newCDPSession(phone);
      const { nodes } = await cdp.send("Accessibility.getFullAXTree");
      const named = (/** @type {string} */ role) => nodes.filter((n) => n.role?.value === role && !n.ignored).map((n) => String(n.name?.value ?? ""));
      const tree = { tables: named("table").length, headers: named("columnheader").join("|"), cells: named("cell").slice(0, 4).join("|") };
      check(
        rolesName,
        tree.tables >= 1 && tree.headers.includes("Buyer") && tree.cells !== "" && !/(^|\|)(Buyer|Card|Status|Total) /.test(tree.cells),
        JSON.stringify(tree),
      );
    } else skip(rolesName, "Playwright reads the accessibility tree only through Chromium's DevTools protocol");
    await phone.context().close();
  }
}
