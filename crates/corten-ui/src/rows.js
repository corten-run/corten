// @ts-check
// corten_ui::rows. A table's rows sorted in place by the column whose header was clicked: the
// handler a sortable header's link calls (`on:sort={rows::sort(event, target)}` on the kit's
// SortHeader), so a table the page has every row of sorts without a request. The link stays the
// app's, to the page the server sorts, for a click with a modifier key and a page without the
// script. A table that shows one page of its rows sorts on the server: its links, not this.

/**
 * Sorts the rows of each body of the link's table by the column of the header the link is in, in
 * place of following it: ascending, then descending on the next click. Each cell sorts by its
 * `data-sort` (a number, a date written as one), else the machine value of the one `<time
 * datetime>` (as an instant, when it is a date) or `<data value>` it holds, else its text; a
 * column whose values are all decimal numbers (`-2`, `12.5`, `1e3`) or instants sorts as numbers,
 * any other by the page's language (`lang`), numbers in text in numeric order (`Item 2` before
 * `Item 10`). A number written for the reader's language (`12,5`) needs a `data-sort`. The text
 * leaves out a part hidden from a screen reader (`aria-hidden`, a stacked table's `CellLabel`) or
 * from everyone (`hidden`). Rows with an equal value keep their order, and an empty value is last
 * either way. The header gets `aria-sort` and the table's other headers lose it, as the ARIA
 * sortable table does: nothing else is announced. The links and the address stay as the server
 * drew them, so a click with a modifier key or a reload gives the server's order. A click with a
 * modifier key, a link outside a table's header, and a table whose header or bodies have a cell
 * that spans columns or rows (so a cell's place is not its column) are left to the link.
 * @param {Event} event
 * @param {HTMLElement} link the header's link (a prop's handler gets an `HTMLElement`)
 */
export function sort(event, link) {
  if (event instanceof MouseEvent && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) return;
  const header = link.closest("th");
  const table = header?.closest("table");
  if (!header || !table || !table.tHead?.contains(header)) return;
  for (const part of [table.tHead, ...table.tBodies]) if (part.querySelector(SPANS)) return;
  // Everything that can throw is done before the link is stopped, so a failure leaves the link.
  const collator = collatorFor(link);
  const column = header.cellIndex;
  const order = header.getAttribute("aria-sort") === "ascending" ? -1 : 1;
  const sorted = Array.from(table.tBodies, (body) => {
    const rows = Array.from(body.rows, (row) => ({ row, ...valueOf(row.cells[column]) }));
    const numbers = rows.every(({ text, number }) => text === "" || !Number.isNaN(number));
    rows.sort((a, b) => {
      if (a.text === "" || b.text === "") return Number(a.text === "") - Number(b.text === "");
      return order * (numbers ? a.number - b.number : collator.compare(a.text, b.text));
    });
    return { body, rows };
  });
  event.preventDefault();
  for (const { body, rows } of sorted) {
    const moved = document.createDocumentFragment();
    for (const { row } of rows) moved.append(row);
    body.append(moved);
  }
  for (const other of table.tHead.querySelectorAll("th[aria-sort]")) if (other !== header) other.removeAttribute("aria-sort");
  header.setAttribute("aria-sort", order === 1 ? "ascending" : "descending");
}

/** A cell of this part's own rows (not a table inside one) that spans more than one column or row. */
const SPANS = ":scope > tr > :is(td, th):is([colspan]:not([colspan='1']), [rowspan]:not([rowspan='1']))";

/** A decimal number, as a server writes one in `data-sort`: not `0x10` or `Infinity`. */
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;

/**
 * What a cell sorts by: its `data-sort`, else its one `<time datetime>` or `<data value>`, else its
 * text; and that as a number, when it is a finite decimal number or a time that is a date.
 * @param {HTMLTableCellElement | undefined} cell
 * @returns {{ text: string, number: number }}
 */
function valueOf(cell) {
  if (!cell) return { text: "", number: NaN };
  /** @param {string} text */
  const decimal = (text) => {
    const number = DECIMAL.test(text) ? Number(text) : NaN;
    return Number.isFinite(number) ? number : NaN;
  };
  if (cell.dataset.sort !== undefined) {
    const text = cell.dataset.sort.trim();
    return { text, number: decimal(text) };
  }
  const machine = cell.querySelectorAll("time[datetime], data[value]");
  if (machine.length === 1) {
    const part = machine[0];
    if (part instanceof HTMLTimeElement) {
      const text = part.dateTime.trim();
      return { text, number: text === "" ? NaN : Date.parse(text) };
    }
    const text = /** @type {HTMLDataElement} */ (part).value.trim();
    return { text, number: decimal(text) };
  }
  const text = read(cell).trim();
  return { text, number: decimal(text) };
}

/**
 * A collator for the link's language, or the browser's when the page's `lang` is not a tag.
 * @param {HTMLElement} link
 */
function collatorFor(link) {
  const lang = link.closest("[lang]")?.getAttribute("lang") || undefined;
  try {
    return new Intl.Collator(lang, { numeric: true });
  } catch {
    return new Intl.Collator(undefined, { numeric: true });
  }
}

/**
 * A cell's text without its parts hidden from a screen reader or from everyone.
 * @param {HTMLTableCellElement} cell
 */
function read(cell) {
  const hidden = '[aria-hidden="true"], [hidden]';
  if (!cell.querySelector(hidden)) return cell.textContent ?? "";
  const copy = /** @type {HTMLTableCellElement} */ (cell.cloneNode(true));
  for (const part of copy.querySelectorAll(hidden)) part.remove();
  return copy.textContent ?? "";
}
