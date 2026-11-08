// @ts-check
// corten_ui::ordered. A form or link outside a sorted table's part whose route reads the table's
// order (a "Refresh" beside the table whose answer redirects back to the page) sends the order
// `rows::sort` put on screen: called from its own markup with the tables' ids. Its own module, so
// a page that only sorts a table does not load it.
/** @import { ElementId } from "corten" */

/**
 * Sends the order sorted tables show where a form sends, as it is sent: the form's handler,
 * `on:submit={ordered::send(event, target, [sorted(&SalesId)])}`. Each id names a table or an
 * element around sorted tables (`corten_ui::sorted`); for each table, the query keys its header
 * links differ in are taken from the page's address, which `rows::sort` keeps as the order
 * shown: added, replaced or taken out, the rest of the address kept. A POST form's address is its
 * submitter's `formaction`, else its `action`: rewritten in place. A GET form's address is its
 * fields, so those keys are set in every list of its fields made while it is sent (the browser's,
 * and one a later handler makes), unless a control the user sees sends the key: that control's
 * value stands. A form to another origin, without an address, or a `dialog` form is left.
 * @param {SubmitEvent} event @param {HTMLFormElement} el @param {ElementId[]} tables
 */
export function send(event, el, tables) {
  const links = tableLinks(tables);
  if (!links.length) return;
  const submitter = event.submitter;
  // The method and address the browser sends with, read through the prototypes' getters: a
  // control named `method` or `action` shadows a form's own.
  const own = submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement ? submitter : null;
  const method = own?.hasAttribute("formmethod") ? own.formMethod : idl(HTMLFormElement.prototype, "method", el);
  if (method === "post") {
    if (own?.hasAttribute("formaction")) taken(own, "formaction", links);
    else taken(el, "action", links);
  } else if (method === "get") {
    const to = own?.hasAttribute("formaction") ? own.formAction : idl(HTMLFormElement.prototype, "action", el);
    if (new URL(to, location.href).origin !== location.origin) return;
    // Set as the form is read, so nothing is added to the page: by the browser and by any handler
    // that reads it during this submit, which all happen in its task, so the listener ends with
    // it and a submit a later handler cancels leaves none.
    el.addEventListener("formdata", (data) => fields(el, data.formData, links), { signal: AbortSignal.timeout(0) });
  }
}

/**
 * Keeps the order sorted tables show in a link's address: the link's `on:connect`,
 * `ordered::link(target, [sorted(&SalesId)], signal)`. Its `href` takes the tables' order keys
 * from the page's address, as `send` does a form's, whenever the link is about to be read: the
 * pointer over it (before the runtime prefetches it), focus (before Enter follows it), a click, a
 * middle click and its menu ("Copy link", "Open in new tab"). A link to another origin or without
 * `href` is left. A component's links take it as a prop (the kit's `Pagination` and
 * `PreviousNext`, `on:link`), whose handler gets an `HTMLElement`, so that is what it takes;
 * the compiler no longer refuses another element, so one that is not a link (an `<a>` or
 * `<area>`), which has no address to keep, is reported in the console and left.
 * @param {HTMLElement} a the link @param {ElementId[]} tables @param {AbortSignal} signal
 */
export function link(a, tables, signal) {
  if (!(a instanceof HTMLAnchorElement || a instanceof HTMLAreaElement)) {
    console.error("corten-ui: ordered::link keeps the order in a link's href; this element is not a link", a);
    return;
  }
  const keep = () => {
    const links = tableLinks(tables);
    if (links.length) taken(a, "href", links);
  };
  for (const type of ["pointerover", "focus", "click", "auxclick", "contextmenu"]) a.addEventListener(type, keep, { capture: true, signal });
}

/** A getter of `proto` read on `el`, past a control that shadows it. @param {object} proto @param {string} name @param {Element} el @returns {any} */
const idl = (proto, name, el) => /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(proto, name)).get?.call(el);

/**
 * The header links' queries of each sorted table the ids name: the table, or every table inside
 * the element, that has them.
 * @param {ElementId[]} tables @returns {URLSearchParams[][]}
 */
function tableLinks(tables) {
  return tables.flatMap((id) => {
    const found = document.getElementById(id);
    if (!found) return [];
    const all = found instanceof HTMLTableElement ? [found] : Array.from(found.querySelectorAll("table"));
    return all.flatMap((table) => {
      const sorters = table.tHead ? Array.from(table.tHead.querySelectorAll(SORTERS)) : [];
      const queries = sorters.flatMap((a) => [a.dataset.ascending, a.dataset.descending]).map((to) => new URL(to ?? "", location.href).searchParams);
      return queries.length ? [queries] : [];
    });
  });
}

/** A table's sort header links that name the page sorted each way, as the kit's `SortHeader` writes them. */
const SORTERS = /** @type {"a"} */ (":scope > tr > th > a[data-ascending][data-descending]");

/**
 * The keys `links` differ in, which carry a table's order.
 * @param {URLSearchParams[]} links @returns {string[]}
 */
function orderKeys(links) {
  const keys = new Set(links.flatMap((q) => Array.from(q.keys())));
  return Array.from(keys).filter((key) => new Set(links.map((q) => q.getAll(key).join("\u0000"))).size > 1);
}

/**
 * The same-origin address in `el`'s `name` attribute with each table's order keys as the page's
 * address has them, its path, other keys and fragment kept.
 * @param {Element} el @param {string} name @param {URLSearchParams[][]} tables
 */
function taken(el, name, tables) {
  const was = Element.prototype.getAttribute.call(el, name);
  if (was === null) return;
  const at = new URL(was, location.href);
  if (at.origin !== location.origin) return;
  const page = new URL(location.href).searchParams;
  for (const key of tables.flatMap(orderKeys)) {
    at.searchParams.delete(key);
    for (const value of page.getAll(key)) at.searchParams.append(key, value);
  }
  Element.prototype.setAttribute.call(el, name, `${at.pathname}${at.search}${at.hash}`);
}

/**
 * What a GET form sends, with each table's order keys as the page's address has them, but for a
 * key a control the user sees sends.
 * @param {HTMLFormElement} form @param {FormData} data @param {URLSearchParams[][]} tables
 */
function fields(form, data, tables) {
  const page = new URL(location.href).searchParams;
  /** @type {Element[]} */
  const controls = Array.from(idl(HTMLFormElement.prototype, "elements", form));
  for (const key of tables.flatMap(orderKeys)) {
    const seen = controls.some((c) => Element.prototype.getAttribute.call(c, "name") === key && !(c instanceof HTMLInputElement && c.type === "hidden"));
    if (seen) continue;
    data.delete(key);
    for (const value of page.getAll(key)) data.append(key, value);
  }
}
