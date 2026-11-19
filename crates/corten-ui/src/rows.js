// @ts-check
// corten_ui::rows. A table's rows sorted in place by the column whose header was clicked: the
// handler a sortable header's link calls (`on:sort={rows::sort(event, target, head)}` on the kit's
// SortHeader), so a table the page has every row of sorts without a request. The link stays the
// app's, to the page the server sorts, for a click with a modifier key and a page without the
// script. A table that shows one page of its rows sorts on the server: its links, not this.

import { ReadSortLinks } from "corten/events";

/**
 * @typedef {{ link: HTMLAnchorElement, up: string, down: string, first: 1 | -1, other: string, href: string, active: string | null }} SortLink
 */
/** @type {WeakMap<HTMLAnchorElement, SortLink>} */
const routes = new WeakMap();
/** @type {WeakMap<ReadSortLinks, SortLink[]>} */
const requests = new WeakMap();

/**
 * Reads the current sort routes for the table's own head, in response to sorting or an ordered
 * control. Each link has one valued ref, for the URL not in its native href. Which ref the link
 * has says which way it sorts first; aria-sort says when the native href goes the other way.
 * @param {ReadSortLinks} event
 * @param {Map<HTMLAnchorElement, string>} ascendingFirst
 * @param {Map<HTMLAnchorElement, string>} descendingFirst
 */
export function read(event, ascendingFirst, descendingFirst) {
  const head = event.target;
  if (!(event instanceof ReadSortLinks) || !(head instanceof HTMLTableSectionElement)) return;
  const links = requests.get(event);
  event.stopPropagation();
  for (const link of head.querySelectorAll(/** @type {"a"} */ (":scope > tr > th > a"))) {
    const up = ascendingFirst.get(link);
    const down = descendingFirst.get(link);
    // No value, or the same ref incorrectly passed for both directions: leave the link alone.
    const upFirst = typeof up === "string";
    if (upFirst === (typeof down === "string")) continue;
    const other = upFirst ? up : /** @type {string} */ (down);
    const first = upFirst ? 1 : -1;
    const href = link.getAttribute("href");
    if (href === null) continue;
    const active = link.parentElement?.getAttribute("aria-sort") ?? null;
    let route = routes.get(link);
    // Retained anchors can receive a new route pair without another connect, even if only
    // aria-sort changed. Client rewrites record their own href and aria-sort together.
    if (!route || route.other !== other || route.first !== first || route.href !== href || route.active !== active) {
      const hrefIsUp = active === "descending" || (active !== "ascending" && first === 1);
      route = { link, up: hrefIsUp ? href : other, down: hrefIsUp ? other : href, first, other, href, active };
      routes.set(link, route);
    }
    if (links) links.push(route);
    else event.urls.push(route.up, route.down);
  }
}

/**
 * Read from today's refs, including a replaced header or one changed in place, without
 * resolving the same maps once per anchor at startup.
 * @param {HTMLTableSectionElement} head
 */
function sortLinks(head) {
  /** @type {SortLink[]} */
  const links = [];
  const event = new ReadSortLinks({ urls: [] });
  requests.set(event, links);
  head.dispatchEvent(event);
  requests.delete(event);
  return links;
}

/**
 * Sorts the rows of each body of the link's table by the column of the header the link is in, in
 * place of following it: ascending, then descending on the next click (or the first direction
 * given by the header's ref). Each cell sorts by the machine value of the one
 * `<time datetime>` (as an instant, when it is a date or a date and time) or `<data value>`
 * it holds outside its hidden parts, else its text. Use `sortByNumber` or `sortByText` for cells
 * with explicit values. A
 * column whose values are all decimal numbers (`-2`, `12.5`, `1e3`) or instants sorts as numbers,
 * any other by the page's language (`lang`), numbers in text in numeric order (`Item 2` before
 * `Item 10`). A number written for the reader's language (`12,5`) needs a machine or ref value. The text
 * leaves out a part hidden from a screen reader (`aria-hidden`, a stacked table's `CellLabel`) or
 * from everyone (`hidden`). Rows with an equal value are in the order the page drew them, whatever
 * earlier clicks did; an empty value is last either way. That is the server's order for ties when
 * the page was drawn in the order the server sorts from, not when it was drawn already sorted (a
 * reload of a sorted address): then ties follow the order it was drawn in. The header gets `aria-sort` and the table's other headers lose it, as the ARIA
 * sortable table does: nothing else is announced. With both sort routes read by the head's
 * `on:ReadSortLinks` handler from the kit's `SortHeader` links, the
 * address becomes the page sorted as shown, in place of its history entry, and each header's link
 * the page its next click gives, as the server draws them: a reload and a page that reads itself
 * again (`ReadAgain`) get the order on screen, a part of it read again from its own route around
 * the table (`ReadAgain::from`) reads with the same keys (a form elsewhere whose route reads the
 * order calls `ordered::send`, a link `ordered::link`), and a click with a modifier key opens the order that
 * click would give. Only the query keys the header links differ in are taken from
 * them, so what another control put in the address (a tab, a choice) and its fragment stay, as
 * corten-ui's `TabGroup` does. A click with a modifier key, a link outside a
 * table's header, a missing sort route, and a table whose header or bodies have a cell that spans
 * columns or rows (so a cell's place is not its column) are left to the link.
 * @param {Event} event
 * @param {HTMLElement} link the header's link (a prop's handler gets an `HTMLElement`)
 * @param {HTMLTableSectionElement} head the table's head with its route reader
 */
export function sort(event, link, head) {
  sortRows(event, link, head);
}

/**
 * Like `sort`, with cells that give a numeric ref value (`ref={cell.with(cents)}`) instead of
 * sorting by their contents.
 * @param {Event} event @param {HTMLElement} link @param {HTMLTableSectionElement} head @param {Map<HTMLTableCellElement, number>} cells
 */
export function sortByNumber(event, link, head, cells) {
  sortRows(event, link, head, cells);
}

/**
 * Like `sort`, with cells that give a text ref value (`ref={cell.with(text)}`) instead of
 * sorting by their contents.
 * @param {Event} event @param {HTMLElement} link @param {HTMLTableSectionElement} head @param {Map<HTMLTableCellElement, string>} cells
 */
export function sortByText(event, link, head, cells) {
  sortRows(event, link, head, cells);
}

/** @param {Event} event @param {HTMLElement} link @param {HTMLTableSectionElement} head @param {ReadonlyMap<HTMLTableCellElement, number | string>} [cells] */
function sortRows(event, link, head, cells) {
  if (event instanceof MouseEvent && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) return;
  const header = link.closest("th");
  const table = header?.closest("table");
  if (!header || !table || !head || table.tHead !== head || !head.contains(header)) return;
  const sorters = sortLinks(head);
  const route = sorters.find((sorter) => sorter.link === link);
  if (!route) return;
  for (const part of [head, ...table.tBodies]) if (part.querySelector(SPANS)) return;
  const links = sorters.flatMap(({ up, down }) => [up, down]).map((to) => new URL(to, location.href).searchParams);
  // Everything that can throw is done before the link is stopped, so a failure leaves the link.
  const collator = collatorFor(link);
  const column = header.cellIndex;
  // The other way when sorted by this column, else the way its first click goes.
  const now = route.active;
  const order = now === "ascending" ? -1 : now === "descending" ? 1 : route.first;
  const sorted = Array.from(table.tBodies, (body) => {
    // A body none of whose rows were seen is as the page drew it.
    const fresh =
      !drawnIds.get(body)?.size && !Array.prototype.some.call(body.rows, (/** @type {HTMLTableRowElement} */ row) => drawn.has(row));
    const rows = Array.from(body.rows, (row, at) => ({ row, drawn: drawnAt(body, row, fresh ? at : ADDED + at), ...valueOf(row.cells[column], cells) }));
    const numbers = rows.every(({ text, number }) => text === "" || !Number.isNaN(number));
    rows.sort((a, b) => {
      if (a.text === "" || b.text === "") return Number(a.text === "") - Number(b.text === "") || a.drawn - b.drawn;
      return order * (numbers ? a.number - b.number : collator.compare(a.text, b.text)) || a.drawn - b.drawn;
    });
    return { body, rows };
  });
  event.preventDefault();
  for (const { body, rows } of sorted) {
    const moved = document.createDocumentFragment();
    for (const { row } of rows) moved.append(row);
    body.append(moved);
  }
  for (const other of head.querySelectorAll("th[aria-sort]")) if (other !== header) other.removeAttribute("aria-sort");
  const active = order === 1 ? "ascending" : "descending";
  header.setAttribute("aria-sort", active);
  const shown = order === 1 ? route.up : route.down;
  // The address is the page sorted as shown, and each link the page its next click gives: this
  // header's the other way, the others' first direction (none of them is sorted now).
  for (const sorter of sorters) {
    const { link: other, up, down, first } = sorter;
    const way = other === link ? -order : first;
    const to = keeping(way === 1 ? up : down, links);
    to.hash = "";
    sorter.href = to.href;
    sorter.active = other === link ? active : null;
    other.setAttribute("href", sorter.href);
  }
  const to = keeping(shown, links);
  if (to.origin === location.origin && to.href !== location.href) history.replaceState(history.state, "", to);
  // A part of the page that reads itself again from its own route (`ReadAgain::from`) reads the
  // same order: its read's address takes the keys the header links differ in, as this one did. A
  // part is as the runtime's `readPartsAgain` finds it: an element with an id around the table (or
  // the table) and the tag beside it, up to <main>. So does each form in the part that sends to
  // this origin other than by GET (a form's own fields are a GET's query): its answer, which may
  // bring the part's next read, is drawn in the order on screen.
  const sortedAs = new URL(shown, location.href);
  for (let el = /** @type {Element | null} */ (table); el?.parentElement && el.localName !== "main"; el = el.parentElement) {
    if (!el.id) continue;
    const beside = Array.from(el.parentElement.children);
    if (!beside.some((sibling) => sibling.matches(PART_AGAIN))) continue;
    for (const sibling of beside) {
      if (sibling.matches(PART_AGAIN)) taken(sibling, "data-from", sortedAs, links);
      else if (sibling.id) for (const sends of [sibling, ...Array.from(sibling.querySelectorAll("form, button[formaction], input[formaction]"))]) sendsIn(sends, sibling, sortedAs, links);
    }
  }
}

/**
 * Takes the keys the header links differ in from `order` into the same-origin address in `el`'s
 * `name` attribute, keeping its path, its other keys and its fragment.
 * @param {Element} el @param {string} name @param {URL} order @param {URLSearchParams[]} links
 */
function taken(el, name, order, links) {
  const at = new URL(/** @type {string} */ (Element.prototype.getAttribute.call(el, name) ?? ""), location.href);
  if (at.origin !== location.origin) return;
  at.search = taking(at, order, links).toString();
  Element.prototype.setAttribute.call(el, name, `${at.pathname}${at.search}${at.hash}`);
}

/**
 * `taken` for where a form in `part`, or a submit button of its own, sends other than by GET: a
 * form's `action`, a button's `formaction`. A form without one sends to the address, which has
 * the order. Read through `Element`'s methods: a control named `getAttribute` or `method`
 * shadows a form's.
 * @param {Element} el @param {Element} part @param {URL} order @param {URLSearchParams[]} links
 */
function sendsIn(el, part, order, links) {
  const attr = (/** @type {Element | null | undefined} */ of, /** @type {string} */ name) => (of ? Element.prototype.getAttribute.call(of, name) : null);
  const button = el.localName !== "form";
  const name = button ? "formaction" : "action";
  if (attr(el, name) === null) return;
  const form = button ? /** @type {HTMLButtonElement} */ (el).form : el;
  if (!form || !part.contains(form)) return;
  const method = (button && attr(el, "formmethod")) || attr(form, "method") || "get";
  if (method.toLowerCase() === "post") taken(el, name, order, links);
}

/** A part of the page read again from its own route: the runtime's `PART_AGAIN`. */
const PART_AGAIN = "template[data-corten-read-again][data-from]";

/**
 * A header's link, on this page: the address as it is with only the query keys the table's header
 * links differ in taken from the link (in the link's order, then any key only the address has), so
 * another control's keys and the fragment stay. A link to another page is as it is.
 * @param {string} link @param {URLSearchParams[]} links every header's two @returns {URL}
 */
function keeping(link, links) {
  const to = new URL(link, location.href);
  const now = new URL(location.href);
  if (to.origin !== now.origin || to.pathname !== now.pathname) return to;
  now.search = taking(now, to, links).toString();
  return now;
}

/**
 * `at`'s query with the keys the table's header links differ in taken from `link` (in the link's
 * order, then any key only `at` has).
 * @param {URL} at @param {URL} link @param {URLSearchParams[]} links every header's two
 * @returns {URLSearchParams}
 */
function taking(at, link, links) {
  const differ = (/** @type {string} */ key) => new Set(links.map((q) => q.getAll(key).join("\u0000"))).size > 1;
  const query = new URLSearchParams();
  for (const key of new Set([...link.searchParams.keys(), ...at.searchParams.keys()])) {
    for (const value of (differ(key) ? link.searchParams : at.searchParams).getAll(key)) query.append(key, value);
  }
  return query;
}

/** Where a row the page added after a body's first sort goes: after every row drawn in it. */
const ADDED = 1e9;

/**
 * Each row's place in the order the page drew its body, recorded the first time the body is
 * sorted: what equal values are ordered by, so a tie comes out the same however earlier clicks
 * left it. A row the page adds after that (a feed's, a patch's) comes after
 * those drawn, in the order it has; one that replaces a row with its `id` takes that row's place.
 * @type {WeakMap<HTMLTableRowElement, number>}
 */
const drawn = new WeakMap();

/** Each sorted body's places by row `id`, for a row a patch or a feed replaces. @type {WeakMap<HTMLTableSectionElement, Map<string, number>>} */
const drawnIds = new WeakMap();

/**
 * A row's place in the order the page drew it, or that of the row with its `id` it replaced, or
 * `place` when it has none yet (a row new to a body sorted before goes after the drawn ones).
 * @param {HTMLTableSectionElement} body @param {HTMLTableRowElement} row @param {number} place
 */
function drawnAt(body, row, place) {
  let ids = drawnIds.get(body);
  if (!ids) drawnIds.set(body, (ids = new Map()));
  const known = drawn.get(row) ?? (row.id ? ids.get(row.id) : undefined);
  const at = known ?? place;
  drawn.set(row, at);
  if (row.id && known === undefined) ids.set(row.id, at);
  return at;
}

/** A cell of this part's own rows (not a table inside one) that spans more than one column or row. */
const SPANS = ":scope > tr > :is(td, th):is([colspan]:not([colspan='1']), [rowspan]:not([rowspan='1']))";

/** A cell's machine value that is not inside a part hidden from a screen reader or everyone. */
const MACHINE = ':is(time[datetime], data[value]):not([aria-hidden="true"] *, [hidden] *)';

/**
 * A date (`2026-10-30`) or a date and time with `Z` or an offset, as `LocalTime` writes it: what
 * sorts as an instant (a date alone as midnight UTC, so a column writes one form). A duration, a
 * week or a time with no zone sorts as text, so a column of them that text does not order needs
 * a ref value. A value inside a hidden part, or a table inside a hidden region, is passed over.
 */
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/;

/** A decimal number, not `0x10` or `Infinity`. */
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;

/**
 * What a cell sorts by: its ref value, else its one `<time datetime>` or `<data value>`, else its
 * text; and that as a number, when it is a finite decimal number or a time that is a date.
 * @param {HTMLTableCellElement | undefined} cell
 * @param {ReadonlyMap<HTMLTableCellElement, number | string> | undefined} cells
 * @returns {{ text: string, number: number }}
 */
function valueOf(cell, cells) {
  if (!cell) return { text: "", number: NaN };
  /** @param {string} text */
  const decimal = (text) => {
    const number = DECIMAL.test(text) ? Number(text) : NaN;
    return Number.isFinite(number) ? number : NaN;
  };
  const value = cells?.get(cell);
  if (value != null) {
    const text = String(value).trim();
    return { text, number: typeof value === "number" ? value : decimal(text) };
  }
  const machine = cell.querySelectorAll(MACHINE);
  if (machine.length === 1) {
    const part = machine[0];
    if (part instanceof HTMLTimeElement) {
      const text = part.dateTime.trim();
      return { text, number: ISO.test(text) ? Date.parse(text) : NaN };
    }
    const text = /** @type {HTMLDataElement} */ (part).value.trim();
    return { text, number: decimal(text) };
  }
  const text = cellText(cell).trim();
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
function cellText(cell) {
  const hidden = '[aria-hidden="true"], [hidden]';
  if (!cell.querySelector(hidden)) return cell.textContent ?? "";
  const copy = /** @type {HTMLTableCellElement} */ (cell.cloneNode(true));
  for (const part of copy.querySelectorAll(hidden)) part.remove();
  return copy.textContent ?? "";
}
