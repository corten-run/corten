// @ts-check
// What the classes in `corten/views` share. #[component(view)] generates a class per component
// whose properties are its holes: `row.label = "x"` writes that text node and nothing else, and
// `row.label` reads it back. A handler changes the page by assigning to them, as plain
// JavaScript writes to the DOM, but by name and with types. There is no state to compare, no
// tracking and no scheduler: the page holds what is shown, and a handler writes what it changed.
//
// rows(parent, Row, template) is the list of those views under `parent`: push, remove, swap,
// replace and clear change the elements, and at(i) / of(event.target) give the view to write.
// New rows are clones of the server-rendered `<template>` (one Row in it), filled with their
// data. Corten serves this file inside `corten/views` (scripts/build-js.mjs builds it).

/**
 * Element's own members, for a row, a root or a parent that may be a form: a form control's
 * `name` shadows the form's member of that name (`<button name="remove">` makes `form.remove` the
 * button, `<input name="id">` makes `form.id` the input). Held whole, as the runtime holds it,
 * rather than each member taken off by name: the file ships smaller. Still read directly, names
 * no form gives a field: `insertBefore` and `textContent` (on the rows' parent),
 * `firstElementChild`, `cloneNode`, `tagName`, `ownerDocument`, and the text holes of a generated
 * view class and the path to its holes. A generated class reads and writes an attribute hole on a
 * `<form>` (and a form row's `key`) through Element's own. A form's `style` is read through
 * HTMLElement's own, and a row's `parentNode` and `nextSibling` through Node's.
 */
const own = Element.prototype;
/** `el.id`, for an element that may be a form. @param {Element} el @returns {string} */
const idOf = (el) => Reflect.get(own, "id", el);
/**
 * `node.parentNode`, for a node that may be a form: a form's control named `parentNode` would
 * make a walk up from a row's contents cycle inside the form.
 * @param {Node} node @returns {Node | null}
 */
const parentOf = (node) => Reflect.get(Node.prototype, "parentNode", node);
/** `el.children`, for an element that may be a form. @param {Element} el @returns {Element[]} */
const childrenOf = (el) => Array.from(Reflect.get(own, "children", el));

/**
 * Gives a row cloned from a `<template>` the custom properties the server wrote for the
 * template's row (`style={..}`, `data-vars`): set through the CSSOM, as the runtime sets a
 * patch's, since a clone is under the document's policy. A script that fills rows draws their own
 * sizes itself.
 * @param {Element} root
 */
function vars(root) {
  for (const el of [root, ...own.querySelectorAll.call(root, "[data-vars]")]) {
    const list = own.getAttribute.call(el, "data-vars");
    if (!list || !(el instanceof HTMLElement || el instanceof SVGElement)) continue;
    for (const one of list.split(";")) {
      const at = one.indexOf(":");
      // `style` through HTMLElement's own getter: a form's control may be named `style`.
      const style = el instanceof HTMLElement ? Reflect.get(HTMLElement.prototype, "style", el) : el.style;
      if (one.startsWith("--") && at > 2) style.setProperty(one.slice(0, at), one.slice(at + 1), "important");
    }
  }
}

/**
 * Makes `value` the text of `el`, which holds only that text.
 * @param {Element} el @param {string} value
 */
export function text(el, value) {
  const t = /** @type {Text | null} */ (el.firstChild);
  if (t === null) el.textContent = value;
  else if (t.data !== value) t.data = value;
}

/**
 * Makes `value` what an `<input>` shows (even after the user typed) and what a form reset goes
 * back to.
 * @param {Element} el @param {string} v
 */
export function value(el, v) {
  const input = /** @type {HTMLInputElement} */ (el);
  input.defaultValue = v;
  if (input.value !== v) input.value = v;
}

/**
 * Checks or unchecks an `<input>` (even after the user clicked it), and what a form reset goes
 * back to.
 * @param {Element} el @param {boolean} on
 */
export function checked(el, on) {
  const input = /** @type {HTMLInputElement} */ (el);
  input.defaultChecked = on;
  if (input.checked !== on) input.checked = on;
}

/**
 * Shows one server-rendered branch. Its root id identifies the branch and instance: retain that
 * element when already shown (including SSR and reconnects), otherwise clone the template.
 * State that must survive a branch change belongs to a component above `host`, not the clone.
 * @template {{ el: Element }} V
 * @param {Element} host
 * @param {new (el: Element) => V} View
 * @param {HTMLTemplateElement} template
 * @returns {V}
 */
export function view(host, View, template) {
  const proto = template.content.firstElementChild;
  if (!proto || !idOf(proto) || template.content.children.length !== 1 || [...template.content.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim())) {
    throw new Error("corten: view() needs a template with one root with an id", { cause: template });
  }
  if (own.matches.call(proto, "script") || own.querySelector.call(proto, "script")) throw new Error("corten: view() does not clone scripts", { cause: template });
  const current = host.firstElementChild;
  if (childrenOf(host).length === 1 && current && idOf(current) === idOf(proto) && current.tagName === proto.tagName) return new View(current);
  const next = /** @type {Element} */ (proto.cloneNode(true));
  const ids = new Set();
  for (const el of [next, ...own.querySelectorAll.call(next, "[id]")]) {
    const id = idOf(el);
    if (!id) continue;
    const outside = [...host.ownerDocument.querySelectorAll(`#${CSS.escape(id)}`)].some((old) => old === host || !Node.prototype.contains.call(host, old));
    if (ids.has(id) || outside) {
      throw new Error(`corten: view() would duplicate id ${id}`, { cause: el });
    }
    ids.add(id);
  }
  vars(next);
  const shown = new View(next);
  own.replaceChildren.call(host, next);
  return shown;
}

/**
 * What #[component(view)] generates for a component whose root has `key={..}`. `keyOf` is there
 * when the key is one of its holes, so a script can make rows; a view whose key the markup also
 * shows elsewhere (a cell's form, an element id) has only `key`, and the server makes its rows.
 * `key` reads the root's `data-key` attribute: `rows()` watches that attribute to notice a key
 * set since it last read them.
 * @template D the data it is made from: every hole's value
 * @template {object} V the view
 * @typedef {{
 *   new (el: Element): V,
 *   fill(el: Element, data: D): void,
 *   key(el: Element): string,
 *   keyOf?: (data: D) => string,
 * }} ViewClass
 */

/**
 * The views of every child of a parent element, all made from one component: `at(i)`,
 * `get(key)` and `of(event.target)` give one; `replace(items)` shows exactly `items` (rows
 * with a key it had keep their element and are filled again, the rest are made, and the order
 * follows `items`).
 * @template D
 * @template {{ el: Element }} V
 * @typedef {{
 *   readonly length: number,
 *   at(i: number): V,
 *   get(key: string): V | undefined,
 *   of(target: EventTarget | null): V | undefined,
 *   indexOf(view: V): number,
 *   push(items: readonly D[]): void,
 *   remove(view: V): void,
 *   swap(i: number, j: number): void,
 *   clear(): void,
 *   replace(items: readonly D[]): void,
 *   [Symbol.iterator](): IterableIterator<V>,
 * }} Rows
 */

const SERVER_MADE = "corten: the server makes these rows: a script makes only rows of a view whose key={..} is one of its holes";

/** @type {WeakMap<Element, { View: unknown, list: unknown, use: (t: HTMLTemplateElement | undefined) => void }>} */
const lists = new WeakMap();

/**
 * The rows under `parent`, each a `View`. Every call for one parent returns the same list, so a
 * handler calls it each time it runs; it follows changes made elsewhere (a server patch, a
 * sort) when it is next used.
 * @template D
 * @template {{ el: Element }} V
 * @param {Element} parent
 * @param {ViewClass<D, V>} View
 * @param {HTMLTemplateElement} [template] holds one server-rendered row, cloned for new rows
 * @returns {Rows<D, V>}
 */
export function rows(parent, View, template) {
  const known = lists.get(parent);
  if (known) {
    if (known.View !== View) throw new Error("corten: rows() of one element are one view", { cause: parent });
    known.use(template);
    return /** @type {Rows<D, V>} */ (known.list);
  }
  /** @type {Element[]} */
  let els = childrenOf(parent);
  /**
   * The rows by key, made on the first get() and kept through the list's own changes: get() after
   * a push or a remove does not read every row's key again. @type {Map<string, Element> | null}
   */
  let byKey = null;
  /** Whether two rows share a key: the last one has it, and only making the map again says which. */
  let twice = false;
  // Changes to the children made elsewhere: the list reads them again before its next use.
  // Its own changes are taken (and dropped) as it makes them.
  let stale = false;
  const watch = new MutationObserver(() => {
    stale = true;
  });
  watch.observe(parent, { childList: true });
  // A key written while the map is kept (a view's key set by a script, at once or after an await)
  // makes it again. Watched only while there is a map, so filling rows without one (replace) costs
  // nothing.
  let rekeyed = false;
  /** Whether a row's own key changed, not a `data-key` inside it (a keyed ref, a nested list). @param {MutationRecord[]} records */
  const rowKeyed = (records) => records.some((r) => parentOf(r.target) === parent);
  const keys = new MutationObserver((records) => {
    rekeyed ||= rowKeyed(records);
  });
  const forget = () => {
    if (byKey) keys.disconnect();
    byKey = null;
    rekeyed = false;
  };
  /** Reads the children again after a change made elsewhere, and the keys after one set since. */
  const sync = () => {
    if (byKey && (rowKeyed(keys.takeRecords()) || rekeyed)) forget();
    if (watch.takeRecords().length || stale) {
      els = childrenOf(parent);
      forget();
      stale = false;
    }
  };
  /** After a change the list made: its own writes are not news. */
  const done = () => {
    watch.takeRecords();
    if (byKey) {
      keys.takeRecords();
      if (twice) forget();
    }
  };
  /** @type {Element | null | undefined} */
  let proto;
  /** Whether the template's row has custom properties to give its copies. */
  let protoVars = false;
  const use = (/** @type {HTMLTemplateElement | undefined} */ t) => {
    if (!t) return;
    proto = t.content.firstElementChild;
    protoVars = !!proto && (own.hasAttribute.call(proto, "data-vars") || !!own.querySelector.call(proto, "[data-vars]"));
  };
  use(template);
  /** @param {D} data */
  const make = (data) => {
    if (!proto) throw new Error("corten: rows() makes new rows from a <template> with one row in it", { cause: parent });
    const el = /** @type {Element} */ (proto.cloneNode(true));
    if (protoVars) vars(el);
    View.fill(el, data);
    return el;
  };
  /** @param {readonly D[]} items @param {Element[]} out @param {number} from @param {Node | null} before */
  const add = (items, out, from, before) => {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < items.length; i += 1) frag.appendChild((out[from + i] = make(items[i])));
    parent.insertBefore(frag, before);
  };
  /** @type {Rows<D, V>} */
  const list = {
    get length() {
      sync();
      return els.length;
    },
    at(i) {
      sync();
      return new View(els[i]);
    },
    get(key) {
      sync();
      if (!byKey) {
        byKey = new Map();
        twice = false;
        for (const el of els) {
          const k = View.key(el);
          if (byKey.has(k)) twice = true;
          byKey.set(k, el);
        }
        keys.observe(parent, { subtree: true, attributeFilter: ["data-key"] });
      }
      const el = byKey.get(key);
      return el ? new View(el) : undefined;
    },
    of(target) {
      let el = /** @type {Node | null} */ (target);
      // An event's target may be no node (`window`), which Node's getter refuses: no row, as
      // `el.parentNode` gave. A node from another realm (an iframe's document) is read as any.
      try {
        while (el && parentOf(el) !== parent) el = parentOf(el);
      } catch {
        el = null;
      }
      return el ? new View(/** @type {Element} */ (el)) : undefined;
    },
    indexOf(view) {
      sync();
      return els.indexOf(view.el);
    },
    push(items) {
      if (!View.keyOf) throw new Error(SERVER_MADE, { cause: parent });
      sync();
      const from = els.length;
      add(items, els, from, null);
      if (byKey) for (let i = from; i < els.length; i += 1) {
        const k = View.key(els[i]);
        if (byKey.has(k)) twice = true;
        byKey.set(k, els[i]);
      }
      done();
    },
    remove(view) {
      sync();
      const el = view.el;
      const i = els.indexOf(el);
      if (i < 0) return;
      els.splice(i, 1);
      own.remove.call(el);
      if (byKey) {
        const k = View.key(el);
        if (byKey.get(k) === el) byKey.delete(k);
        else forget();
      }
      done();
    },
    swap(i, j) {
      sync();
      const a = els[i];
      const b = els[j];
      if (!a || !b || a === b) return;
      // Either may come first, and they may be neighbors: a goes where b is, then b where a was.
      const afterA = /** @type {ChildNode | null} */ (Reflect.get(Node.prototype, "nextSibling", a));
      if (afterA === b) parent.insertBefore(b, a);
      else {
        parent.insertBefore(a, b);
        parent.insertBefore(b, afterA);
      }
      els[i] = b;
      els[j] = a;
      done();
    },
    clear() {
      parent.textContent = "";
      els = [];
      forget();
      done();
    },
    replace(items) {
      sync();
      // Kept rows are filled again: the map is made on the next get(), not kept through the fills.
      forget();
      const n = items.length;
      /** @type {Map<string, number>} */
      const where = new Map();
      const keyOf = View.keyOf;
      if (!keyOf) throw new Error(SERVER_MADE, { cause: parent });
      for (let j = 0; j < els.length; j += 1) where.set(View.key(els[j]), j);
      // Each new item's old element, or -1.
      const from = new Int32Array(n).fill(-1);
      let kept = 0;
      // With no rows to keep (a first fill, or after clear()), no key is looked up.
      if (where.size) for (let i = 0; i < n; i += 1) {
        const k = keyOf(items[i]);
        const j = where.get(k);
        if (j !== undefined) {
          from[i] = j;
          where.delete(k);
          kept += 1;
        }
      }
      /** @type {Element[]} */
      const next = new Array(n);
      if (kept === 0) {
        // A new list: clear and build in one go.
        parent.textContent = "";
        add(items, next, 0, null);
      } else {
        for (const j of where.values()) own.remove.call(els[j]);
        // Elements on the longest run already in order stay; the rest move or are made.
        const stay = lis(from);
        let s = stay.length - 1;
        /** @type {Node | null} */
        let before = null;
        for (let i = n - 1; i >= 0; i -= 1) {
          const j = from[i];
          let el;
          if (j < 0) {
            el = make(items[i]);
            parent.insertBefore(el, before);
          } else {
            el = els[j];
            View.fill(el, items[i]);
            if (s >= 0 && stay[s] === i) s -= 1;
            else parent.insertBefore(el, before);
          }
          next[i] = el;
          before = el;
        }
      }
      els = next;
      done();
    },
    *[Symbol.iterator]() {
      sync();
      for (const el of els.slice()) yield new View(el);
    },
  };
  lists.set(parent, { View, list, use });
  return list;
}

/** Positions (into `a`) of a longest increasing run of its non-negative values. @param {Int32Array} a */
function lis(a) {
  /** @type {number[]} */
  const tails = [];
  const prev = new Int32Array(a.length);
  for (let i = 0; i < a.length; i += 1) {
    const v = a[i];
    if (v < 0) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[tails[mid]] < v) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const run = new Array(tails.length);
  for (let i = tails.length - 1, k = tails[tails.length - 1]; i >= 0; i -= 1, k = prev[k]) run[i] = k;
  return run;
}
