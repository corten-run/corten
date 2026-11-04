// @ts-check
// corten_ui::rows. A table's rows sorted in place by the column whose header was clicked: the
// handler a sortable header's link calls (`on:sort={rows::sort(event, target)}` on the kit's
// SortHeader), so a table the page has every row of sorts without a request. The link stays the
// app's, to the page the server sorts, for a click with a modifier key and a page without the
// script. A table that shows one page of its rows sorts on the server: its links, not this.

/**
 * Sorts the rows of each body of the link's table by the column of the header the link is in, in
 * place of following it: ascending, then descending on the next click. Each cell sorts by its
 * `data-sort` (a number, a date written as one) or else its text; a column whose values are all
 * numbers sorts as numbers, any other by the page's language (`lang`), numbers in text in
 * numeric order (`Item 2` before `Item 10`). The text is what a screen reader reads: a part
 * hidden from it (`aria-hidden`, a stacked table's `CellLabel`) is left out. Rows with an equal
 * value keep their order, and an empty value is last either way. The header gets `aria-sort` and the table's other headers lose
 * it. A click with a modifier key, a link outside a table's header, and a table with a cell that
 * spans columns or rows (so a cell's place is not its column) are left to the link.
 * @param {Event} event
 * @param {HTMLElement} link the header's link (a prop's handler gets an `HTMLElement`)
 */
export function sort(event, link) {
  if (event instanceof MouseEvent && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) return;
  const header = link.closest("th");
  const table = header?.closest("table");
  if (!header || !table || !table.tHead?.contains(header)) return;
  for (const row of table.rows) for (const cell of row.cells) if (cell.colSpan > 1 || cell.rowSpan > 1) return;
  event.preventDefault();
  const column = header.cellIndex;
  const order = header.getAttribute("aria-sort") === "ascending" ? -1 : 1;
  const collator = new Intl.Collator(link.closest("[lang]")?.getAttribute("lang") || undefined, { numeric: true });
  for (const body of table.tBodies) {
    const rows = Array.from(body.rows, (row) => {
      const cell = row.cells[column];
      return { row, value: (cell?.dataset.sort ?? (cell ? read(cell) : "")).trim() };
    });
    const numbers = rows.every(({ value }) => value === "" || Number.isFinite(Number(value)));
    rows.sort((a, b) => {
      if (a.value === "" || b.value === "") return Number(a.value === "") - Number(b.value === "");
      return order * (numbers ? Number(a.value) - Number(b.value) : collator.compare(a.value, b.value));
    });
    body.append(...rows.map(({ row }) => row));
  }
  for (const other of table.tHead.querySelectorAll("th[aria-sort]")) if (other !== header) other.removeAttribute("aria-sort");
  header.setAttribute("aria-sort", order === 1 ? "ascending" : "descending");
}

/**
 * A cell's text without its parts hidden from a screen reader.
 * @param {HTMLTableCellElement} cell
 */
function read(cell) {
  if (!cell.querySelector('[aria-hidden="true"]')) return cell.textContent ?? "";
  const copy = /** @type {HTMLTableCellElement} */ (cell.cloneNode(true));
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent ?? "";
}
