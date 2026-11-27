// @ts-check
// Corten runtime. Served by the corten crate at /corten/{version}/corten.js, minified from this
// file into dist/corten.js by `npm run build:js`, and imported as "corten".
//
// What it does, and nothing else:
// 1. Same-origin navigations: fetch the next page with `corten: nav` and swap it into <main>; a
//    redirect's notice the page did not draw is `corten:notice` on the document.
// 2. <form data-patch>: submit with `corten: action` and apply the returned fragments by id (a
//    `<template id data-remove>` removes its element, `<template id data-append>` adds to it). A newer
//    submit of a form replaces a pending read and waits for a pending write; a navigation abandons
//    pending ones.
// 3. <corten-live src>: apply fragments streamed as server-sent `patch` events, until an `end`.
// 4. Handlers: `data-on='click:cart_line.confirm($e,@dialog)'` (what `on:click={js::confirm(event, dialog)}`
//    prints) runs the export `confirm` of `{scripts dir}/cart_line.js` with the event and the
//    element with `data-ref="dialog"` in the same component. One listener per event type on the
//    document; modules are imported when markup that names them joins the page, and markup the
//    runtime inserts (a navigation, a patch) waits for its modules, so handlers always run while
//    the event is dispatched. `on:connect` runs when the element joins, and its `signal` aborts
//    when it leaves.
// 5. subscribe(): live rows from a corten::feed (snapshot + ordered patches) for scripts that keep state.
// 6. Hover prefetch of same-origin links, the page's head tags and section stylesheets on
//    navigation (a stylesheet loads before the swap and stays), `aria-current` on
//    shell links with `data-nav`, and the service worker when the shell names one (corten::pwa).
// 7. A page response whose shell key differs from this page's (the user signed in or out, or a
//    deploy changed the runtime or assets) is loaded in full instead of swapped.
// 8. A page that asks to be read again (`ReadAgain`) is fetched again after its delay and
//    swapped in place, however it was reached (a write's page whole, with its layout, as the
//    write read it); a patch or a page that asks for a part
//    (`ReadAgain::from`) has it read again from its route and applied (and such a page is not
//    read whole).
// Without JavaScript, links and forms still work as plain HTML.

import { patchOf, snapshotOf } from "./feed.js";
import { parseOn } from "./on.js";
import { getter } from "./dom.js";

// Trusted Types (the CSP's `require-trusted-types-for 'script'`, `trusted-types corten`): markup and
// the worker's URL reach the DOM only through this policy, which only this module holds, so it
// takes the server's answers to the runtime's own requests. It holds a script to the rule, not
// against a script that forges what the runtime reads (a replaced `fetch` or `EventSource`).
// Where the browser has no Trusted Types it is the identity.
/**
 * The platform's Trusted Types, which TypeScript's DOM types do not have yet.
 * @typedef {{ toString(): string, toJSON(): string }} TrustedHTML
 * @typedef {{ createHTML(text: string): TrustedHTML, createScriptURL(url: string): unknown }} TrustedPolicy
 * @typedef {{ createPolicy(name: string, rules: { createHTML(text: string): string, createScriptURL(url: string): string }): TrustedPolicy }} TrustedTypes
 */
const trusted = (() => {
  try {
    return /** @type {{ trustedTypes?: TrustedTypes }} */ (globalThis).trustedTypes?.createPolicy("corten", {
      createHTML: (text) => text,
      createScriptURL: (url) => url,
    });
  } catch (error) {
    // A script that ran first made a policy of this name: the runtime runs, and draws nothing
    // from a string, which the browser refuses at each sink.
    console.error('corten: a script made the Trusted Types policy "corten" before the runtime', error);
  }
})();
/**
 * Whether an answer came from this page's origin (after any redirect): only those are the server's,
 * and only those go through the policy. A form's `action`, a `ReadAgain`'s `data-from` or a
 * `<corten-live src>` a script set to another origin gets nothing drawn, nor does a `Response` a
 * script made (no URL).
 * @param {string} url
 */
const fromHere = (url) => url !== "" && new URL(url).origin === location.origin;
/** The part module, beside the runtime: a variable, so the build leaves it a module of its own. */
const PART = "./part.js";
/**
 * Has the part module (`js/part.js`) read the parts the page waits for (`ReadAgain::now`): imported
 * once the page loaded with one (its head preloads the module) or markup the server sent, or a
 * script's {@link patch}, draws one, and handed what draws its answers ({@link apply}); from then on
 * it finds the parts itself, so later calls (the
 * browser's own module, imported once) do nothing. A page that never draws one fetches and runs
 * none of it, and one whose module does not load shows each part's link, as without JavaScript
 * (docs/design.md#choice-slow-part-link).
 */
const readParts = () => import(PART).then((/** @type {typeof import("./part.js")} */ part) => part.start(apply, busyBy));
/**
 * The server's markup, through the policy, or a script's (`own` false, {@link patch}) as it is;
 * markup with a part waiting has the part module read it. The tag's name is searched for in any
 * case and after any separator, as HTML reads it: a script's markup need not be written as the
 * server writes it, and a name in the text that is no tag only fetches the module.
 * @param {string | TrustedHTML} text @param {boolean | Function} [own]
 */
const trustedHTML = (text, own = true) => {
  if (/data-corten-read-now/i.test(/** @type {string} */ (text))) readParts();
  return /** @type {string} */ (/** @type {unknown} */ (trusted && own ? trusted.createHTML(/** @type {string} */ (text)) : text));
};

const scriptsMeta = document.querySelector('meta[name="corten-scripts"]');
const scriptsDir = scriptsMeta?.getAttribute("content") ?? "/assets/scripts/";
/**
 * Where Corten's other meta tags are: `<Corten />` writes them all together, after this one. Looked
 * for there alone, as one missing from a long page (most are optional) would be looked for through
 * all of it.
 */
const metas = scriptsMeta?.parentElement ?? document;

/** @typedef {import("./on.js").Binding} Binding */
/** @typedef {import("./on.js").Arg} Arg */

// Numbers, money and dates for a script (format.js) are a module of their own, served with the
// app's scripts: only a page whose handlers take a format (`t.js().money(USD)`) loads it, as it
// loads the handlers' own modules.
const FORMAT = "corten-format";

// A form field a handler is given (`js::fill(f.weight)`) is found by field.js, a module of its own
// as the formatter is: only a page whose handlers take a field loads it, with theirs.
const FIELD = "corten-field";

// A multipart submit whose progress a form's `on:corten:progress` handler is told of goes by
// XMLHttpRequest (upload.js), a module of its own that only a page with such a form loads, as
// soon as the form's handlers are read; fetch reports no upload progress. Without it (it did not
// load), the submit is a fetch, with no progress.
const UPLOAD = "corten-upload";
/** The runtime's event on such a form, a `ProgressEvent`. */
const PROGRESS = "corten:progress";

/** Script modules by name, once imported. @type {Map<string, Record<string, unknown>>} */
const modules = new Map();
/** @type {Map<string, Promise<unknown>>} */
const loading = new Map();
/**
 * Script modules whose import failed: the wait after the last failure, which doubles with each one
 * in a row as a feed's reconnect does, and when it is over (`performance.now()`).
 * @type {Map<string, [wait: number, at: number]>}
 */
const failed = new Map();

/** How long until script module `name` may be asked for again: 0 when it may now. @param {string} name */
const untilRetry = (name) => Math.max(0, (failed.get(name)?.[1] ?? 0) - performance.now());

/** Modules the first page loads with its own module scripts, until they arrive. @type {Map<string, () => void>} */
const arriving = new Map();
let contentLoaded = false;
document.addEventListener("DOMContentLoaded", () => {
  contentLoaded = true;
  // A module script that failed or never arrived: imported the usual way instead.
  for (const done of arriving.values()) done();
  arriving.clear();
});

/** The page's own module script for script module `name`, if it has one. @param {string} name */
const moduleScript = (name) => /** @type {HTMLScriptElement | null} */ (document.querySelector(`script[type="module"][src="${scriptsDir}${name}.js"]`));

// Corten ends each script module it serves with a "corten:module" event carrying the module's
// name, URL and exports, so a module the page loads with a module script is found without waiting
// on an import(). It is not an API: the runtime takes exports only from the module the page's own
// script tag for that name loaded (its URL), once, and only while the page loads.
document.addEventListener("corten:module", (event) => {
  const { name, url, exports } = /** @type {CustomEvent<{ name: string, url: string, exports: Record<string, unknown> }>} */ (event).detail;
  if (contentLoaded || modules.has(name) || moduleScript(name)?.src !== url) return;
  modules.set(name, exports);
  arriving.get(name)?.();
  arriving.delete(name);
});

/**
 * Imports the script module `name` (`{scripts dir}/name.js`) once. The first page's modules are
 * module scripts of its own, which hand their exports over as they run, before `DOMContentLoaded` and without
 * waiting on an `import()`; markup the runtime inserts later waits for its modules, so a handler
 * always runs while its event is dispatched (and can call `event.preventDefault()`). An event
 * that arrives before its module (a click while the first page still loads) gets the browser's
 * default, as it would without JavaScript. A module that did not load (a request the network
 * dropped) is imported again when something next needs it, once its wait is over; until then the
 * promise settles without it.
 * @param {string} name
 */
function load(name) {
  let pending = loading.get(name);
  if (!pending) {
    if (untilRetry(name) > 0) return Promise.resolve();
    const url = `${scriptsDir}${name}.js`;
    const fromUrl = () =>
      import(url).then(
        (module) => {
          modules.set(name, module);
          failed.delete(name);
        },
        (error) => {
          loading.delete(name);
          const wait = Math.min(30_000, (failed.get(name)?.[0] ?? 250) * 2);
          failed.set(name, [wait, performance.now() + wait]);
          // Corten's own modules (`corten-format`) are served with any app's scripts: no component to list.
          console.error(`corten: script module ${url} did not load (is its component in App::components?)`, error);
        },
      );
    if (modules.has(name)) pending = Promise.resolve();
    else if (!contentLoaded && moduleScript(name)) {
      pending = new Promise((done) => arriving.set(name, () => done(undefined))).then(() => (modules.has(name) ? undefined : fromUrl()));
    } else pending = fromUrl();
    loading.set(name, pending);
  }
  return pending;
}

/**
 * Element's own members (and Node's), for an element that may be a form: a form control's `name`
 * shadows the form's member of that name (`<input name="hasAttribute">` makes
 * `form.hasAttribute` the input, `<button name="remove">` makes `form.remove` the button). So on
 * an element it did not make that may be a form (one it dispatches to, binds, finds refs in, scans
 * as it joins the page, patches, draws again, focuses or keeps the scroll of) the runtime reads
 * attributes, children, scroll and whether it is on the page, queries, finds what is around it and
 * puts or takes elements through these, which are formCall's rule without its lookup; it
 * focuses one through focusOn, sets the custom properties of one through styleOf, and dispatches
 * to, listens on and marks one busy through formCall.
 * A field it reads (an input, select or textarea) has no controls, so its members are read
 * directly. Navigation, identity and markup reads use the captured getters in dom.js.
 * It writes `tabIndex`, which sets the attribute
 * whatever a control is named. Being the prototype's own, these also skip a custom element's
 * override of the member. Held as `elementOwn.closest` rather than taken off the prototype by
 * name: the runtime ships smaller.
 */
const elementOwn = Element.prototype;
const parentElementOf = getter(Node.prototype, "parentElement");
const childNodesOf = getter(Node.prototype, "childNodes");
const nodeNameOf = getter(Node.prototype, "nodeName");
const textOf = getter(Node.prototype, "textContent");
const localNameOf = getter(elementOwn, "localName");
const outerOf = getter(elementOwn, "outerHTML");
/** @param {Element} el @param {string} name */
const attrOf = (el, name) => elementOwn.getAttribute.call(el, name);
/** @param {Element} el @param {string} name */
const hasAttr = (el, name) => elementOwn.hasAttribute.call(el, name);
/** @param {Element} el @param {string} selector */
const closestOf = (el, selector) => elementOwn.closest.call(el, selector);
/** @param {Element} el @param {string} selector */
const matchesOf = (el, selector) => elementOwn.matches.call(el, selector);
/** `root.querySelector(selector)`, for a root that may be a form or a fragment (see queryAll). @param {ParentNode} root @param {string} selector */
const queryOne = (root, selector) => (root instanceof Element ? elementOwn.querySelector.call(root, selector) : root.querySelector(selector));
/** @param {Element} el @param {string} tag */
const tagsIn = (el, tag) => elementOwn.getElementsByTagName.call(el, tag);
/** @param {Node} el @param {Node | null} other */
const holds = (el, other) => Node.prototype.contains.call(el, other);
/**
 * Whether `el` is on the page. Read directly first, as reading it through Node's own is twice as
 * slow and the end of a life reads it for every element with one: a control that shadows it is an
 * element, never a boolean.
 * @param {Node} el @returns {boolean}
 */
const inPage = (el) => {
  const on = /** @type {unknown} */ (el.isConnected);
  return typeof on === "boolean" ? on : Reflect.get(Node.prototype, "isConnected", el);
};
/** @param {ParentNode} el @returns {HTMLCollection} */
const childrenOf = (el) => (el instanceof Element ? Reflect.get(elementOwn, "children", el) : el.children);
/** @param {Element} el @returns {NamedNodeMap} */
const attributesOf = (el) => Reflect.get(elementOwn, "attributes", el);
/**
 * `el.style`, for an element that may be a form (`<select name="style">`). The getter is
 * HTMLElement's or SVGElement's; an SVG element is never a form.
 * @param {HTMLElement | SVGElement} el @returns {CSSStyleDeclaration}
 */
const styleOf = (el) => (el instanceof HTMLElement ? Reflect.get(HTMLElement.prototype, "style", el) : el.style);
/** `el.scrollTop` or `el.scrollLeft`. @param {Element} el @param {"scrollTop" | "scrollLeft"} side @returns {number} */
const scrollOf = (el, side) => Reflect.get(elementOwn, side, el);
/**
 * `root.querySelectorAll(selector)`, for a root that may be a form or a fragment (whose
 * querySelectorAll, like its querySelector and children, is not Element's).
 * @param {ParentNode} root @param {string} selector @returns {NodeListOf<Element>}
 */
const queryAll = (root, selector) => (root instanceof Element ? elementOwn.querySelectorAll.call(root, selector) : root.querySelectorAll(selector));

/** Each element's parsed `data-on`, until the attribute changes. @type {WeakMap<Element, { source: string, list: Binding[] }>} */
const parsed = new WeakMap();

/** @param {Element} el */
function bindings(el) {
  const source = attrOf(el, "data-on") ?? "";
  let entry = parsed.get(el);
  if (!entry || entry.source !== source) {
    entry = { source, list: parseOn(source) };
    for (const b of entry.list) {
      /** @type {string[]} */
      const extra = [];
      if (b.args.some(takes("f"))) extra.push(FORMAT);
      if (b.args.some(takes("~"))) extra.push(FIELD);
      if (extra.length) needs.set(b, [b.module, ...extra]);
      if (b.type === PROGRESS) load(UPLOAD);
    }
    parsed.set(el, entry);
  }
  return entry.list;
}

/**
 * The modules of the bindings that need more than their own: the format module for a format
 * argument, the field module for a field. @type {WeakMap<Binding, string[]>}
 */
const needs = new WeakMap();

/** The modules binding `b` needs: its own, and those of its arguments. @param {Binding} b */
const needed = (b) => needs.get(b) ?? [b.module];

/** Whether module `name` is in. @param {string} name */
const isLoaded = (name) => modules.has(name);

/** Whether an argument, or one in its group, is of kind `kind`. @param {string} kind @returns {(arg: Arg) => boolean} */
const takes = (kind) => (arg) => arg.kind === kind || (arg.kind === "{" && arg.fields.some(([, part]) => takes(kind)(part)));

/**
 * Imports what binding `b` needs: its module, and the format or field module when it takes one.
 * @param {Binding} b
 */
function loadFor(b) {
  const names = needs.get(b);
  return names ? Promise.all(names.map(load)) : load(b.module);
}

/**
 * The root element of the component that owns `from`'s markup (`owner`: of that component, an
 * ancestor of it).
 * @param {Element} from
 * @param {string | null} owner
 */
function scopeOf(from, owner) {
  const scope = closestOf(from, owner ? `[data-scope="${owner}"]` : "[data-scope]");
  if (!scope) throw new Error(`corten: no component root ${owner ? `data-scope="${owner}"` : "[data-scope]"} around`, { cause: from });
  return scope;
}

/**
 * The elements of ref `name` in the component that owns `from`'s markup. A ref is the
 * component's own (`data-ref="rows"` inside its root and not inside a nested component's root) or
 * was put on an element a child component rendered (`data-ref="offer-list/rows"`).
 * @param {Element} from
 * @param {string | null} owner
 * @param {string} name
 * @returns {Element[]}
 */
function findRefs(from, owner, name) {
  const scope = scopeOf(from, owner);
  // Resolved refs are kept per component root until the page's elements change: a click on a
  // row of a 500-row grid then costs a lookup, not a query of every row. During a patch, read
  // the current tree directly: draining records would wire or abort unfinished markup.
  /** @type {ReturnType<typeof refCache.get>} */
  let cached;
  let changes = 0;
  if (patching) patching = 2;
  else {
    const pending = observer.takeRecords();
    if (pending.length) observed(pending);
    cached = refCache.get(scope);
    if (!cached) refCache.set(scope, (cached = new Map()));
    // Still right while no element with this ref name joined the page and none it found left.
    changes = refChanges.get(name) ?? 0;
    const hit = cached.get(name);
    if (hit && hit.changes === changes && hit.found.every(inPage)) return hit.found.slice();
  }
  const own = attrOf(scope, "data-scope");
  const qualified = `${own}/${name}`;
  /** @type {Element[]} */
  const found = [];
  const check = (/** @type {Element} */ el) => {
    const ref = attrOf(el, "data-ref");
    if (ref === name ? closestOf(el, "[data-scope]") === scope : ref === qualified && closestOf(el, `[data-scope="${own}"]`) === scope) found.push(el);
  };
  check(scope);
  for (const el of Array.from(queryAll(scope, `[data-ref="${name}"],[data-ref="${qualified}"]`))) check(el);
  cached?.set(name, { changes, found });
  return found.slice();
}

/**
 * The latest change for each ref name (`rows`, for `rows` and `offer-list/rows`) that joined
 * the page. Only those can add to what a ref resolves to; elements that leave are noticed when a
 * cached ref is next used. So 10,000 rows put in or taken out of a list leave the refs of the
 * list's component cached.
 * @type {Map<string, number>}
 */
const refChanges = new Map();
let refVersion = 0;
/** Each component root's resolved refs. @type {WeakMap<Element, Map<string, { changes: number, found: Element[] }>>} */
let refCache = new WeakMap();

/** @param {Element} el @param {Set<string>} names */
function refName(el, names) {
  const ref = attrOf(el, "data-ref");
  if (ref !== null) names.add(ref.slice(ref.indexOf("/") + 1));
}

/** Each component root's kept state. @type {WeakMap<Element, unknown>} */
const states = new WeakMap();

/** The handler running, and the element it is bound on: whose component `keep` is for. @type {[Element, Binding] | null} */
let running = null;

/**
 * The state the running handler's component keeps, made by `init` the first time and kept while
 * the component's root is on the page: `const s = keep(() => ({ paused: false }))`. Handlers are
 * plain functions, so state that lasts between events lives here (or in the DOM) rather than in
 * the module, which every instance of the component shares; each instance keeps its own, with no
 * element passed. The component is the one whose script the handler is in (a component that
 * imports `keep` is always scoped), also when a parent passed the handler to a child. A component
 * has one state, whichever of its handlers asks first: a later call gets that object whatever its
 * `init`, so keep everything in one object (a `const kept = () => keep(() => ({ .. }))` the
 * handlers share). Take it first, before an `await` or anything that dispatches an event: a
 * timer, a listener or a feed's rows the handler sets up use the object it got.
 * @template T
 * @param {() => T} init
 * @returns {T}
 */
export function keep(init) {
  if (!running) throw new Error("corten: keep() outside a handler");
  const root = scopeOf(running[0], running[1].home);
  if (states.has(root)) return /** @type {T} */ (states.get(root));
  const made = init();
  states.set(root, made);
  return made;
}

/** Each element's life, for `signal`: aborted when it leaves the page. @type {Map<Element, AbortController>} */
const lives = new Map();

/** @param {Element} el */
function signalOf(el) {
  let life = lives.get(el);
  if (!life) {
    life = new AbortController();
    lives.set(el, life);
  }
  return life.signal;
}

/** Patch roots that left, kept through the removal sweep only when asked for.
 * @type {Map<Node, Element | null> | undefined} */
let replacements;

/**
 * Internal to corten-ui. Opt into patch provenance. The lookup is for use during an element's
 * `signal` abort: it finds the root a patch put in place of that element or its ancestor.
 * Null means removal; undefined means no patch. The second lookup reads a dialog's drawn
 * open state, before its connect handler or focus could change it.
 * @returns {[(el: Element | null) => Element | null | undefined, (el: HTMLDialogElement) => boolean | undefined]}
 * @internal
 */
export function patchRoots() {
  const roots = replacements ??= new Map();
  return [(el) => {
    for (; el; el = parentElementOf(el)) {
      const root = roots.get(el);
      if (root !== undefined) return root;
    }
  }, (el) => served.get(el)];
}

/** A `^ref` argument with no such element around the event's target: the handler is not for it. */
const SKIP = Symbol("skip");

/**
 * The element with ref `name` (of the component that owns `el`'s markup) that holds the event's
 * target, or nothing.
 * @param {Element} el @param {string | null} owner @param {string} name @param {Event} event
 */
function closestRef(el, owner, name, event) {
  const scope = scopeOf(el, owner);
  const own = attrOf(scope, "data-scope");
  const qualified = `${own}/${name}`;
  for (const node of event.composedPath()) {
    if (!(node instanceof Element)) continue;
    const ref = attrOf(node, "data-ref");
    if (ref === name ? closestOf(node, "[data-scope]") === scope : ref === qualified && closestOf(node, `[data-scope="${own}"]`) === scope) return node;
    if (node === scope) break;
  }
  return null;
}

/**
 * A message of the app's catalog with the arguments `K`, which a handler fills in and shows with
 * `textContent`: `label({ count: rows.length })`. The markup passes it in the page's locale
 * (`js::count(total, t.js().rows_selected())`), and the compiler checks that the message's
 * arguments are the ones named here.
 * @template {string} K
 * @typedef {(args: Record<K, string | number>) => string} Message
 */

/**
 * An element's id as the markup passes it from its `#[derive(Id)]` type (`corten::script::ElementId`),
 * so a script that finds an element elsewhere on the page (`document.getElementById`) is given
 * one that the server's markup names. To a script it is a string; the markup's call is what takes
 * no string in its place, since the crate checks it when it compiles.
 * @typedef {string} ElementId
 */

/**
 * The runtime's event on a `data-patch` form whose submit got no answer it can draw (it bubbles,
 * and is cancelable): `status` is that answer's (one with no patch or page to draw, other than a
 * 204 or 205, which says the submit was done and there is nothing to draw), or 0 when
 * none could be used (offline, the server unreachable, or an answer whose body failed to read or
 * draw), with the `error` that stopped it. A handler takes it as `@param {CortenError} event`,
 * so the markup that passes it is checked (`on:corten:error={js::failed(event, target)}`).
 * @typedef {CustomEvent<{ status: number, error?: unknown }>} CortenError
 */

/**
 * The runtime's event on the document for a redirect's notice the page did not draw: `message` is
 * its text. A handler takes it as `@param {CortenNotice} event`
 * (`on:document:corten:notice={js::said(event)}`).
 * @typedef {CustomEvent<{ message: string }>} CortenNotice
 */

/**
 * The page's number format: `format(1234)` is `1,234` in en, as the server's `t.number` writes it.
 * The markup passes it (`t.js().number()`); a decimal is passed as its text (`"21.5"`).
 * @typedef {(n: number | string) => string} NumberFormat
 */

/**
 * An amount's format in one currency: `format(123450)` (minor units, an integer) is `$1,234.50`
 * in en, as `t.money(Minor(123450), USD)` writes it. The markup passes it (`t.js().money(USD)`).
 * @typedef {(minor: number) => string} MoneyFormat
 */

/**
 * The page's percentage format: `format(0.029)` is `2.9%` in en and `2,9 %` in fr, as the
 * server's `t.percent` writes it, with the fraction digits the markup chose
 * (`t.js().percent(2)`). It takes a ratio; a decimal may be passed as its text (`"0.029"`).
 * @typedef {(ratio: number | string) => string} PercentFormat
 */

/**
 * A date's format: `format(at)` (a `Date`, milliseconds or ISO text) as the server's `t.date`,
 * `t.time` or `t.date_time` writes it, in the zone the markup chose (`t.js().date(DateStyle::Medium)`),
 * or `format(at, { offset })` at another offset, in seconds east (the browser's at that instant:
 * `-new Date(at).getTimezoneOffset() * 60`).
 * @typedef {(at: Date | number | string, options?: { offset?: number }) => string} DateFormat
 */

/**
 * The function a `Message` argument is: its text with each argument put in.
 * @param {string[]} parts text and argument names, alternating, text first and last
 * @returns {(args: Record<string, string | number>) => string}
 */
function message(parts) {
  // `parts` alternates text and names and starts and ends with text, so each read is in range.
  return (args) => {
    let text = /** @type {string} */ (parts[0]);
    for (let i = 1; i < parts.length; i += 2) text += String(args[/** @type {string} */ (parts[i])]) + parts[i + 1];
    return text;
  };
}

/**
 * The value of one argument.
 * @param {Arg} arg @param {Element} el @param {Event} event @param {Binding} binding
 * @returns {unknown}
 */
function resolve(arg, el, event, binding) {
  switch (arg.kind) {
    case "v":
      return arg.value;
    case "%":
      return message(arg.parts);
    case "f":
      return /** @type {{ formatter: (spec: import("./format.js").Spec) => unknown }} */ (modules.get(FORMAT)).formatter(arg.spec);
    case "$e":
      return event;
    case "$t":
      return el;
    case "$s":
      return signalOf(el);
    case "$c":
      return scopeOf(el, arg.owner);
    case "*":
      return findRefs(el, arg.owner, arg.name);
    case "#":
      return new Map(findRefs(el, arg.owner, arg.name).map((found) => [attrOf(found, "data-key"), found]));
    case "=":
      // `ref={row.with(cents)}`: the value as the server wrote it, JSON, so a number is one.
      return new Map(findRefs(el, arg.owner, arg.name).map((found) => [found, JSON.parse(attrOf(found, "data-ref-value") ?? "null")]));
    case "^":
      return closestRef(el, arg.owner, arg.name, event) ?? SKIP;
    case "~":
      return /** @type {typeof import("./field.js")} */ (modules.get(FIELD)).given(el, arg, binding);
    case "{": {
      /** @type {Record<string, unknown>} */
      const group = {};
      for (const [key, part] of arg.fields) {
        const value = resolve(part, el, event, binding);
        if (value === SKIP) return SKIP;
        group[key] = value;
      }
      return group;
    }
    default: {
      const [first] = findRefs(el, arg.owner, arg.name);
      if (!first) throw new Error(`corten: ${binding.module}.${binding.name} takes ref ${arg.name}, and its component has no element with it`);
      return first;
    }
  }
}

/**
 * Runs `el`'s `on:connect` handler once its module is in: a module that did not load is asked for
 * again when its wait is over, until `el` leaves the page (`signal`, so an element that left and
 * came back runs it once, from its new connection).
 * @param {Element} el @param {Binding} binding @param {Event} event @param {() => boolean} ready
 * @param {AbortSignal} signal
 */
function connectWhenLoaded(el, binding, event, ready, signal) {
  loadFor(binding).then(() => {
    if (signal.aborted || !inPage(el)) return;
    if (ready()) return void run(el, binding, event);
    const wait = Math.max(...needed(binding).map(untilRetry));
    setTimeout(() => connectWhenLoaded(el, binding, event, ready, signal), wait);
  });
}

/**
 * Runs one handler for `el`, while `event` is dispatched. A module still loading (an event before
 * the first page's scripts are in) runs nothing, so the browser does what it would without
 * JavaScript; `on:connect` waits for it instead.
 * @param {Element} el
 * @param {Binding} binding
 * @param {Event} event
 */
function run(el, binding, event) {
  const module = modules.get(binding.module);
  const extra = needs.get(binding);
  if (!module || (extra && !extra.every(isLoaded))) {
    const ready = () => needed(binding).every(isLoaded);
    // Another event gets the browser's default; a module that did not load is asked for again, so
    // the next one finds it.
    if (event.type === "connect") connectWhenLoaded(el, binding, event, ready, signalOf(el));
    else loadFor(binding);
    return;
  }
  const handler = module[binding.name];
  if (typeof handler !== "function") {
    console.error(`corten: ${binding.module}.js exports no function ${binding.name}`, el);
    return;
  }
  const outer = running;
  try {
    const args = [];
    for (const arg of binding.args) {
      const value = resolve(arg, el, event, binding);
      if (value === SKIP) return;
      args.push(value);
    }
    running = [el, binding];
    const result = handler(...args);
    if (result instanceof Promise) result.catch(reportError);
  } catch (error) {
    reportError(error);
  } finally {
    running = outer;
  }
}

/** Event types with a listener on the document. */
const listening = new Set();

/** Elements with a handler for events anywhere on the page (`on:document:keydown`). @type {Set<Element>} */
const onPage = new Set();

/** The `data-on` type of a handler for `type` anywhere on the page. */
const PAGE = "document.";

/**
 * Listens for `type` on the document, once: an event that bubbles runs the handlers of every
 * element on its path, innermost first, until one stops it, and then those of the elements on
 * the page with a handler for it anywhere (`on:document:keydown`), each as a listener of its own
 * on the document would; one that does not (`focus`, `mouseenter`) reaches the document only by
 * capture and runs its target's handlers.
 * @param {string} type
 */
function listen(type) {
  if (type === "connect" || listening.has(type)) return;
  listening.add(type);
  const anywhere = PAGE + type;
  document.addEventListener(type, (event) => {
    if (!event.bubbles) return;
    for (const node of event.composedPath()) {
      if (!(node instanceof Element)) continue;
      if (hasAttr(node, "data-on")) for (const b of bindings(node)) if (b.type === type) run(node, b, event);
      // A handler that stops a submit's propagation keeps it from the page's outer handlers, not
      // from the runtime: a data-patch form is still sent as a patch.
      if (event.cancelBubble) return type === "submit" && patchSubmit(event);
    }
    // Each element's page-wide handlers are a listener of their own on the document: stopping the
    // event does not keep it from another's, and an element that joins during the event waits
    // for the next one. A submit one of them stopped is still sent as a patch.
    if (!onPage.size) return;
    for (const el of [...onPage]) {
      if (!inPage(el)) continue;
      for (const b of bindings(el)) if (b.type === anywhere) run(el, b, event);
    }
    if (event.cancelBubble && type === "submit") patchSubmit(event);
  });
  document.addEventListener(
    type,
    (event) => {
      const target = event.composedPath()[0];
      if (event.bubbles || !(target instanceof Element) || !hasAttr(target, "data-on")) return;
      for (const b of bindings(target)) if (b.type === type) run(target, b, event);
    },
    { capture: true },
  );
}

/** Elements whose `on:connect` handlers ran in their current life. @type {Set<Element>} */
const connected = new Set();

/**
 * Wires the markup under `root`: imports the modules its handlers name, listens for their events
 * and runs `on:connect` handlers. The names of the refs in it go in `names`, which the caller counts
 * as changed; with none they are not read.
 * @param {Element} root
 * @param {Set<string> | null} names
 * @param {boolean} [inside] only what is inside `root` joined the page
 */
function scan(root, names, inside = false) {
  for (const template of /** @type {HTMLTemplateElement[]} */ (Array.from(tagsIn(root, "template")))) modulesOf(template.content);
  const marked = Array.from(queryAll(root, "[data-on]"));
  if (!inside) {
    if (hasAttr(root, "data-on")) marked.unshift(root);
    if (names) refName(root, names);
  }
  // Rows cloned from one template carry the same refs, so a name is added once per run of them.
  if (names && !(inside && fewRefNames(root, names))) {
    // Indexed, as it was: this runs for every element a change adds (rows a view makes too).
    const refs = queryAll(root, "[data-ref]");
    let last = null;
    for (let i = 0; i < refs.length; i += 1) {
      const ref = attrOf(/** @type {Element} */ (refs[i]), "data-ref");
      if (ref !== last && ref !== null) names.add(ref.slice(ref.indexOf("/") + 1));
      last = ref;
    }
  }
  for (const el of marked) {
    let connects = false;
    for (const b of bindings(el)) {
      loadFor(b);
      if (b.type === "connect") connects = true;
      else if (b.type.startsWith(PAGE)) {
        onPage.add(el);
        listen(b.type.slice(PAGE.length));
      } else listen(b.type);
    }
    if (connects && !connected.has(el)) {
      connected.add(el);
      const event = new Event("connect");
      for (const b of bindings(el)) if (b.type === "connect") run(el, b, event);
    }
  }
}

/**
 * Adds the names of the refs under `root` to `names` when there are only a few, and says whether
 * it found them all. Many children put in at once (rows() or a patch filling a list) are clones of
 * a few components, so each query looks for a ref not yet seen and the last finds none: a few
 * passes of the browser's selector engine instead of reading 20,000 attributes from script.
 * @param {Element} root @param {Set<string>} names
 */
function fewRefNames(root, names) {
  let selector = "[data-ref]";
  for (let seen = 0; seen < FEW_NAMES; seen += 1) {
    const el = queryOne(root, selector);
    if (!el) return true;
    const ref = /** @type {string} */ (attrOf(el, "data-ref"));
    names.add(ref.slice(ref.indexOf("/") + 1));
    selector += `:not([data-ref="${CSS.escape(ref)}"])`;
  }
  return false;
}

/** Distinct ref names fewRefNames looks for, one query each, before scan reads every ref. */
const FEW_NAMES = 8;

/**
 * Ends the life of every element that left the page: its `signal` aborts, and `on:connect` runs
 * again if it comes back. It runs after the mutations that removed it, so an element moved within
 * the page (removed and inserted in one task) keeps its life.
 */
function sweep() {
  // Read isConnected here: sharing the read with dispatch, scan and patches slowed the sweep.
  for (const group of [lives, connected, onPage]) for (const el of group.keys()) {
    const on = /** @type {unknown} */ (el.isConnected);
    if (on === true || (on !== false && inPage(el))) continue;
    const life = group === lives ? lives.get(el) : undefined;
    group.delete(el);
    life?.abort();
  }
}

/**
 * More elements than this joining in one change, and at least half of their parent's children,
 * are scanned with one query of the parent (see `observed`).
 */
const MANY = 16;

// 0: idle, 1: applying a patch, 2: a ref was read while applying it.
let patching = 0;

/**
 * Markup that joins the page (a navigation, a patch, a script's insert) is wired;
 * markup that leaves it ends.
 * @param {MutationRecord[]} records
 */
function observed(records) {
  let removed = false;
  /** The names of the refs of the elements that joined. @type {Set<string>} */
  const names = new Set();
  /** Parents that got many children at once: scanned whole, with one query each. @type {Set<Element>} */
  const wide = new Set();
  for (const record of records) {
    if (record.removedNodes.length) removed = true;
    const added = record.addedNodes;
    const parent = record.target;
    if (added.length > MANY && parent instanceof Element && added.length * 2 >= childrenOf(parent).length) wide.add(parent);
    else for (const node of added) if (node instanceof Element && inPage(node)) scan(node, names);
  }
  // Wiring is the same however often it runs, so a parent scanned whole may hold rows wired before.
  for (const parent of wide) if (inPage(parent)) scan(parent, names, true);
  for (const name of names) refChanges.set(name, ++refVersion);
  if (removed) sweep();
  if (replacements?.size) for (const { removedNodes } of records) for (const node of removedNodes) replacements.delete(node);
}

const observer = new MutationObserver(observed);
observer.observe(document.documentElement, { childList: true, subtree: true });

/**
 * @template Row
 * @typedef {{ op: "upsert", id: string, value: Row } | { op: "remove", id: string }} FeedChange
 */

/**
 * The URL of a feed whose rows are `Row`: what a handler parameter `@param {FeedUrl<Level>} feed`
 * gets from a route whose `#[route(..)]` says `rows = Level` (Corten checks the route when the
 * crate compiles), and what `subscribe()` takes. At run time it is the URL, a string; its
 * `"corten.rows"` is a type only, which no script reads.
 * @template Row
 * @typedef {string & { readonly "corten.rows": Row[] }} FeedUrl
 */

/**
 * @template Row
 * @typedef {object} FeedHandlers
 * @property {(rows: Row[], seq: number, epoch: string) => void} snapshot Every row; replaces what the
 * script had. `seq` counts writes within `epoch`, the feed's generation: after a restart the
 * epoch differs, and its `seq` is not comparable with the old one's.
 * @property {(changes: FeedChange<Row>[], seq: number, receivedAt: number) => void} patch One write, in order, never twice.
 * @property {(status: "syncing" | "live" | "reconnecting") => void} [status]
 */

/**
 * Live rows from a `corten::feed` at `url`: calls `snapshot` with every row, then `patch` with each
 * later write in order. Reconnects resume where they stopped; a gap, an unknown cursor or a client
 * that fell behind loads a new snapshot. It runs until `signal` aborts (in a handler, pass
 * `signal`: the subscription ends when the element leaves the page), or, without one, for the
 * life of the page. `Row` comes from `url`, a `FeedUrl<Row>` handler parameter.
 * @template Row
 * @param {FeedUrl<Row>} url
 * @param {FeedHandlers<Row>} handlers
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {void}
 */
export function subscribe(url, handlers, { signal } = {}) {
  if (signal?.aborted) return;
  /** @type {EventSource | null} */
  let source = null;
  /** @type {AbortController | null} */
  let request = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let seq = 0;
  let failures = 0;
  // Snapshots in a row whose own cursor the stream refused as it opened.
  let refused = 0;
  // Snapshots in a row whose stream then sent a patch that is not one.
  let rejected = 0;
  const status = handlers.status ?? (() => {});
  signal?.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      request?.abort();
      source?.close();
    },
    { once: true },
  );

  /** Runs `next` after a backoff that grows with `times`. @param {() => void} next @param {number} times */
  function wait(next, times) {
    clearTimeout(timer);
    timer = setTimeout(next, Math.min(30_000, 500 * 2 ** times));
  }

  /**
   * Runs `next` after a backoff that doubles every second failure in a row: 1, 1, 1, 2, 2, 4, 4 s
   * and on to 30 s, for a failed snapshot and a stream answered with an HTTP error alike. After
   * the browser's own retry at 1 s, the tries come about 1, 2, 3, 4, 6, 8, 12, 16, 24, 32 s after a
   * cut (modeled): sooner after a short outage than doubling from 1 s, 2 s later after some long
   * ones.
   * @param {() => void} next
   */
  function retry(next) {
    wait(next, Math.max(1, (failures += 1) >> 1));
  }

  /** @param {boolean} [shown] the status already says `syncing` */
  async function sync(shown = false) {
    source?.close();
    source = null;
    request?.abort();
    if (signal?.aborted) return;
    if (!shown) status("syncing");
    const current = (request = new AbortController());
    try {
      const res = await fetch(url, { headers: { accept: "application/json" }, signal: current.signal });
      if (!res.ok) throw new Error(`corten: feed ${url} answered ${res.status}`);
      const snap = snapshotOf(await res.json());
      if (!snap) throw new Error(`corten: feed ${url} sent no snapshot`);
      failures = 0;
      seq = snap.seq;
      // The rows are the server's own type, which the runtime does not check (`Row` is erased).
      handlers.snapshot(/** @type {Row[]} */ (snap.rows), snap.seq, snap.epoch);
      listen(`${url}/live?since=${encodeURIComponent(`${snap.epoch}-${snap.seq}`)}`, true);
    } catch (error) {
      if (current.signal.aborted) return;
      console.error(error);
      retry(() => sync(true));
    }
  }

  /** @param {string} liveUrl @param {boolean} [fresh] its cursor is the snapshot's just loaded */
  function listen(liveUrl, fresh = false) {
    const es = new EventSource(liveUrl);
    source = es;
    let cursor = new URL(liveUrl, location.href).searchParams.get("since") ?? "";
    let opened = 0;
    let opens = 0;
    es.addEventListener("open", () => {
      failures = 0;
      opened = performance.now();
      opens += 1;
      status("live");
    });
    // EventSource retries by itself and sends Last-Event-ID, so the server resumes after `seq`.
    // It gives up for good on an HTTP error (a load balancer with no healthy server, say); then
    // listen again from the last event, with backoff, so no snapshot is needed.
    es.addEventListener("error", () => {
      status("reconnecting");
      if (es.readyState === EventSource.CLOSED && source === es) retry(() => listen(`${url}/live?since=${encodeURIComponent(cursor)}`));
    });
    // A stream that answers the cursor the snapshot just gave with `sync` as it first opens
    // refuses it (the URL serves more than one feed, say): load the snapshot again after a
    // backoff that grows, not straight away in a loop. A `sync` later, or after a reconnect (a
    // reset), loads it at once. 900 ms leaves room for a task that delays the event.
    es.addEventListener("sync", () => {
      if (!fresh || opens > 1 || performance.now() - opened > 900) {
        refused = 0;
        return void sync();
      }
      es.close();
      source = null;
      status("syncing");
      wait(() => sync(true), (refused += 1));
    });
    es.addEventListener("patch", (event) => {
      const receivedAt = performance.now();
      const batch = patchOf(/** @type {MessageEvent<string>} */ (event).data);
      // Not a patch (a server of another version, a route that sends other events): the write it
      // carried is lost, so load the snapshot, after a backoff that grows while the patches after it
      // are not either.
      if (!batch) {
        console.error(new Error(`corten: feed ${url} sent a bad patch`));
        es.close();
        source = null;
        status("syncing");
        return void wait(() => sync(true), (rejected += 1));
      }
      if (batch.seq <= seq) return;
      if (batch.seq !== seq + 1) return void sync();
      seq = batch.seq;
      fresh = false;
      refused = 0;
      rejected = 0;
      cursor = /** @type {MessageEvent<string>} */ (event).lastEventId;
      handlers.patch(/** @type {FeedChange<Row>[]} */ (batch.changes), batch.seq, receivedAt);
    });
  }

  sync();
}

/**
 * Markup from the server, as a fragment. A template parses it with scripting off, so a
 * `<noscript>`'s content would come out as live elements (a `<meta http-equiv="refresh">`
 * reloads the page once it is in the document); with scripting on a browser never shows it, so
 * it is dropped. Markup the runtime fetched (`own`) goes through its Trusted Types policy; a
 * script's ({@link patch}, `own` false) does not. A function `own` is shown the fragment before
 * anything else can run: a part's read, whose answer it is ({@link apply}).
 * @param {string | TrustedHTML} text @param {false | ((content: DocumentFragment) => void)} [own]
 */
function parse(text, own = () => {}) {
  const template = document.createElement("template");
  // lib.dom types this sink as string only; own requests carry text, patch() carries TrustedHTML.
  template.innerHTML = trustedHTML(text, own);
  for (const noscript of Array.from(template.content.querySelectorAll("noscript"))) noscript.replaceChildren();
  own && own(template.content);
  return template.content;
}

/**
 * Gives the elements in `root` (itself included) the custom properties the server wrote for
 * them: `style={FILL.pct(42.0)}` in markup is `data-vars="--meter__fill:42%"`. A full page brings
 * them in a style block its CSP allows by hash; markup a patch or a navigation brings in is
 * under the policy the document loaded with, which allows neither that block nor a style
 * attribute, so they are set through the CSSOM, which the policy does not govern, `!important`
 * as the block's rules are, so markup wins over the component's rules either way. Called once
 * the markup is in the document, before the browser paints it.
 * @param {Element | DocumentFragment} root
 */
function setVars(root) {
  const found = Array.from(queryAll(root, "[data-vars], template"));
  for (const el of root instanceof Element ? [root, ...found] : found) {
    // A template's markup gets its values too, so they move with it when a script puts its content
    // in the page (`rows.append(rest.content)`).
    if (el instanceof HTMLTemplateElement) setVars(el.content);
    const vars = attrOf(el, "data-vars");
    if (!vars || !(el instanceof HTMLElement || el instanceof SVGElement)) continue;
    for (const one of vars.split(";")) {
      const at = one.indexOf(":");
      // Custom properties only: the server writes nothing else here.
      if (one.startsWith("--") && at > 2) styleOf(el).setProperty(one.slice(0, at), one.slice(at + 1), "important");
    }
  }
}

/**
 * Imports the modules the handlers in `node` name, including those in its templates' content
 * (rows a script will move into the page).
 * @param {ParentNode} node
 * @returns {Promise<unknown>}
 */
function modulesOf(node) {
  /** @type {Promise<unknown>[]} */
  const pending = [];
  if (node instanceof Element && hasAttr(node, "data-on")) for (const b of bindings(node)) pending.push(loadFor(b));
  for (const el of Array.from(queryAll(node, "[data-on]"))) for (const b of bindings(el)) pending.push(loadFor(b));
  for (const template of /** @type {HTMLTemplateElement[]} */ (Array.from(queryAll(node, "template")))) pending.push(modulesOf(template.content));
  return Promise.all(pending);
}

/**
 * Applies a patch: every top-level element in `html` replaces the element with its id, a
 * `<template id="row-7" data-remove>` removes it, a `<template id="rows" data-append>` adds
 * its content at the end of it, and a `<template data-corten-read-again>` reads the patch again
 * ({@link readPatchAgain}). The modules the new markup's handlers name are imported first, so its
 * handlers run from the first event, and so are the section stylesheets of the handler's area
 * (`Area::components`) the page lacks ({@link stylesOf}), so a patch from another area's handler
 * is styled when it appears. The server's markup wins, except for
 * what the user is doing: a field they edited keeps their text, a dialog, `<details>` or popover
 * they opened stays open (a modal dialog modal) unless the server changed it, and focus stays where
 * it was, or near it when the patch takes its element away ({@link focusNear}).
 * Pages require Trusted Types, so a string from a script is refused (a `TypeError`), as at any
 * other sink: markup comes from the server. A test that needs one passes a `TrustedHTML` from a
 * policy the page allows.
 * To read a part of this page again, submit a hidden GET form marked `data-patch` instead:
 * `form.requestSubmit()` (not `form.submit()`). Or render `ReadAgain::from` to read it after a
 * server-chosen delay. Both draw the server's answer through the runtime's policy; fetching
 * text yourself and passing it to patch() does not. See docs/guide/scripts.md#reading-a-part-again.
 * @param {TrustedHTML} html
 * @param {AbortSignal} [signal] Nothing changes once it aborts.
 */
export function patch(html, signal) {
  // Not through the runtime's policy: under Trusted Types a script's string is refused here as
  // at any other sink, so markup still comes only from the server.
  return apply(html, signal, null, undefined, false);
}

/**
 * {@link patch}, for a form's response: `sent` holds the values the form sent, so a field counts
 * as edited only when it changed after the request left; `took`, that the answer accepted them.
 * @param {string | TrustedHTML} html @param {AbortSignal | undefined} signal @param {Map<Element, string | undefined> | null} sent @param {boolean} [took]
 * @param {false | ((content: DocumentFragment) => void)} [own] false for a script's markup, which the
 *   runtime did not fetch ({@link parse}); a part's read (part.js) passes a function, shown what
 *   this call parsed before anything can run: an argument only the runtime and its part module
 *   pass, never the signal, which may be a script's
 * @param {Element} [asked] the `ReadAgain` tag of a part of the page the patch answers a read of:
 * the patch's own tag takes its place, so the part's next read is the one on the page
 * @param {Set<string>} [within] for a submit's answer, the dialogs and details the control that
 *   sent it was in when it was pressed ({@link asking}), which decides whose open state an element
 *   it replaces takes ({@link opened})
 * @param {() => boolean} [here] a read draws only while it is still to be drawn ({@link pressed})
 * @param {() => void} [done] called in the same task once the patch drew without skipping an
 *   element: a `data-address` form's answer puts its address in the entry there ({@link send})
 */
async function apply(html, signal, sent, took, own, asked, within, here, done) {
  const content = parse(html, own);
  // A stylesheet that fails to load leaves the patch unstyled rather than lose a write's answer;
  // the next patch that links it tries again.
  await Promise.all([modulesOf(content), stylesOf(content)]);
  if (signal?.aborted || (here && !here())) return;
  /** The elements this patch puts on the page. @type {Element[]} */
  const put = [];
  let again;
  // Whether it drew something (an element in, or one out that is gone, as a removal by an id the
  // page no longer has leaves it), and whether it skipped an element that found no place (a
  // removal with no id names none).
  let placed = false;
  let skipped = false;
  // Whether it removes a nav link, which can leave another of its nav current.
  let navs = false;
  // A press made by what it draws is this answer's ({@link drawingFor}).
  drawingFor = (done && draws.get(done)) ?? null;
  patching = 1;
  try {
    for (const el of Array.from(content.children)) {
      // Read from the attribute, as `target.id` is a control named id when the target is a form.
      const id = idOf(el) ?? "";
      const target = id && document.getElementById(id);
      if (hasAttr(el, "data-corten-read-again")) again = el;
      else if (el instanceof HTMLTemplateElement && hasAttr(el, "data-remove")) {
        if (target) {
          // Focus in it goes to the nearest element around it that can take focus.
          const parent = parentElementOf(target);
          const up = holds(target, document.activeElement) && parent;
          navs ||= holdsNav(target);
          if (parent) changedIn(parent, ["x", id, []]);
          replacements?.set(target, null);
          elementOwn.remove.call(target);
          if (up) focusNear(up);
        }
        if (id) placed = true;
        else skipped = true;
      } else if (!target) {
        skipped = true;
        console.error(`corten: patch element <${localNameOf(el)}> needs an id that exists on the page`, el);
      } else if (el instanceof HTMLTemplateElement && hasAttr(el, "data-append")) {
        put.push(...Array.from(el.content.children));
        serve(el.content);
        const nodes = Array.from(childNodesOf(el.content));
        changedIn(target, ["a", id, nodes]);
        elementOwn.append.call(target, el.content);
        placed ||= nodes.length > 0;
      } else {
        const parent = parentElementOf(target);
        if (parent) changedIn(parent, ["r", id, [el]]);
        replacements?.set(target, el);
        replaceKeeping(target, el, sent, took, true, within);
        put.push(el);
        placed = true;
      }
    }
    const complete = done && placed && !skipped;
    if (complete) done();
    // The server marked a nav link in the patch against the request that made it (a form's action),
    // not this page: mark it as a navigation would. Only then, or once the address changed: a patch
    // without one (a ticker's) only looks through what it put.
    if (complete || navs || put.some(holdsNav)) markCurrent();
    for (const el of put) setVars(el);
  } finally {
    // A ref read would normally already have swept. End those lives before the observer wires
    // later replacements, but only now that the whole chain of replacement roots is available.
    try {
      if (patching === 2) {
        // Later connects can read refs before the deferred observer counts their changes.
        refCache = new WeakMap();
        sweep();
      }
    } finally {
      patching = 0;
      drawingFor = null;
    }
  }
  if (again) {
    const beside = asked?.isConnected ? asked : partTagBeside(put);
    if (beside) beside.replaceWith(again);
    readPatchAgain(again, put);
  }
}

/**
 * The tag of the part of the page (`ReadAgain::from` among its markup, {@link readPartsAgain})
 * beside an element a patch put on the page (a form's answer, a script's, a live one), which its own `ReadAgain` takes the place
 * of: then the part's next read is the one on the page, where a script may change it (corten-ui's
 * `rows::sort` puts a table's order in it), as for the part's own reads.
 * @param {Element[]} put
 */
function partTagBeside(put) {
  for (const el of put) {
    const parent = parentElementOf(el);
    if (!idOf(el) || !parent) continue;
    const tag = Array.from(childrenOf(parent)).find((sibling) => matchesOf(sibling, PART_AGAIN));
    if (tag) return tag;
  }
}

/**
 * A patch's `ReadAgain` (`<template data-corten-read-again="2" data-from="/alerts?after=r7">`):
 * after that many seconds, once the tab is visible and no form's answer is on its way, fetches
 * `data-from` as a GET `data-patch` form would and applies the patch it answers, which may ask
 * again, whatever its status (a handler that cannot read says so as a patch). It lasts while the
 * page and the elements the patch put on it are there: a later patch of them or a page swapped in
 * stops it, and so does a read that fails without a patch (the server logged it) or offline.
 * @param {Element} tag @param {Element[]} put
 */
function readPatchAgain(tag, put) {
  const page = swapped;
  const here = () => page === swapped && put.every(inPage);
  readLater(Number(tag.getAttribute("data-corten-read-again")), here, async () => {
    for (;;) {
      // Read when it is sent: a script may have changed it since (corten-ui's rows::sort keeps a
      // part's order in it).
      const from = /** @type {string} */ (tag.getAttribute("data-from"));
      // Offline or unreachable: the part stays as it is.
      const res = await fetch(from, { headers: { corten: "action" } }).catch(() => {});
      if (!res?.headers.has("corten-patch") || !fromHere(res.url)) {
        // A success that is not a patch is the app's mistake (the route answered its page).
        if (res?.ok) console.error("corten: ReadAgain needs a patch from this origin, at", from, res);
        return;
      }
      const html = await res.text();
      if (!here()) return;
      // Changed while the read was on its way: its answer is drawn for what was, so read again.
      if (tag.isConnected && tag.getAttribute("data-from") !== from) continue;
      await apply(html, undefined, null, undefined, undefined, tag);
      return;
    }
  });
}

/** A page's request to read one of its parts again (`ReadAgain::from` in the page). */
const PART_AGAIN = "template[data-corten-read-again][data-from]";

/**
 * The parts a page asks to have read again (`ReadAgain::from` in the page, as in a patch): each
 * such tag in `<main>` starts the same read a patch's does once the page is on the screen, and the
 * patch it answers may ask again. It lasts while the page, the tag and the elements with an id
 * beside it are there: a patch of one of them (a form's answer, which brings its own read) stops it.
 * @param {Element} main
 */
function readPartsAgain(main) {
  for (const tag of Array.from(queryAll(main, PART_AGAIN))) {
    readPatchAgain(tag, [tag, ...Array.from(childrenOf(/** @type {Element} */ (parentElementOf(tag)))).filter((el) => idOf(el))]);
  }
}

/**
 * A field's state as text: what the user has (or, with `initial`, what the markup set). A file
 * input's is each file's name, size and time, so another file of the same name is a change, as
 * it is in a pending submit's key. Buttons and hidden inputs are not fields here: undefined.
 * @param {Element} f @param {boolean} [initial] @returns {string | undefined}
 */
function stateOf(f, initial) {
  if (f instanceof HTMLSelectElement) {
    const marks = Array.from(f.options, (o) => +(initial ? o.defaultSelected : o.selected));
    if (initial && !f.multiple) {
      // What the browser selects from the markup: the last option marked selected, else the
      // first enabled one (none in a list box).
      const last = marks.lastIndexOf(1);
      const i = last >= 0 ? last : f.size > 1 ? -1 : Array.from(f.options).findIndex((o) => !o.disabled);
      marks.fill(0);
      if (i >= 0) marks[i] = 1;
    }
    return marks.join("");
  }
  if (f instanceof HTMLTextAreaElement) return initial ? f.defaultValue : f.value;
  if (!(f instanceof HTMLInputElement) || /^(hidden|submit|button|reset|image)$/.test(f.type)) return;
  if (/^(checkbox|radio)$/.test(f.type)) return String(initial ? f.defaultChecked : f.checked);
  if (f.type === "file" && !initial) return Array.from(f.files ?? [], (file) => `${file.name}\0${file.size}\0${file.lastModified}`).join("\0");
  return initial ? f.defaultValue : f.value;
}

/**
 * An element's id, read from its attribute: a form's `id` property is its control named `id`
 * when it has one (see formProperty), and any element may be a form.
 * @param {Element} el
 */
const idOf = (el) => attrOf(el, "id");

/**
 * The form's own property `name`, past a control named like it: in the DOM `<button name="action">`
 * makes `form.action` that button, and `<input name="id">` makes `form.id` the input, so the
 * runtime never reads a form's properties or calls its methods directly.
 * @template {keyof HTMLFormElement} K
 * @param {Element} form
 * @param {K} name
 * @returns {HTMLFormElement[K]}
 */
const formProperty = (form, name) => Reflect.get(HTMLFormElement.prototype, name, form);

/**
 * Calls the form's own method `name` (see formProperty), or an element's: `setAttribute` on a
 * link or form is Element's, whatever the form's controls are named.
 * @template {"setAttribute" | "removeAttribute" | "dispatchEvent" | "addEventListener" | "removeEventListener" | "focus" | "reset"} K
 * @param {Element} form
 * @param {K} name
 * @param {Parameters<HTMLFormElement[K]>} args
 */
const formCall = (form, name, ...args) => /** @type {(...args: Parameters<HTMLFormElement[K]>) => unknown} */ (formProperty(form, name)).call(form, ...args);

/**
 * Focuses `el`, without scrolling to it unless `scroll` (a field the server refused, which the
 * user must see). A form's `focus` goes through formCall, as a control may shadow it; any other
 * element's is its own, which for an SVG or MathML element is not HTMLElement's (the one formCall
 * would call, and which throws on them).
 * @param {Element} el
 * @param {boolean} [scroll]
 */
const focusOn = (el, scroll = false) => {
  const how = { preventScroll: !scroll };
  if (el instanceof HTMLFormElement) formCall(el, "focus", how);
  else /** @type {HTMLElement} */ (el).focus(how);
};

/** A random UUID v4. `crypto.randomUUID` is only there in secure contexts. */
function uuid() {
  // The version (4) in byte 6 and the variant (10xx) in byte 8.
  const b = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(b, (x, i) => (i === 6 ? (x & 0x0f) | 0x40 : i === 8 ? (x & 0x3f) | 0x80 : x).toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Gives the form's submit keys (`SubmitKey::field`, `data-submit`) new values once a submission
 * has its answer, so the next submit is a new one. Until then a retry sends the same key.
 * @param {HTMLFormElement} form
 */
function renewSubmitKeys(form) {
  for (const field of Array.from(formProperty(form, "elements"))) {
    if (field instanceof HTMLInputElement && field.hasAttribute("data-submit")) {
      field.value = uuid();
    }
  }
}

/**
 * Gives each of the form's submit keys that has none yet (`SubmitKey::template_field`, in a form a
 * script copied from a `<template>`) a new one. Run in the capture phase of every `submit`, before
 * any handler of the page reads the form and before the runtime or the browser sends it, so each
 * copy is a submission of its own. `form.submit()` fires no event and gets no key; `requestSubmit()`
 * does.
 * @param {HTMLFormElement} form
 */
function fillSubmitKeys(form) {
  for (const field of Array.from(formProperty(form, "elements"))) {
    if (field instanceof HTMLInputElement && !field.value && field.hasAttribute("data-submit")) field.value = uuid();
  }
}

/** The fields of a form and their state, when it is sent. @param {HTMLFormElement} form */
function sentState(form) {
  /** @type {Map<Element, string | undefined>} */
  const sent = new Map();
  for (const f of Array.from(formProperty(form, "elements"))) sent.set(f, stateOf(f));
  return sent;
}

/**
 * The element in `fresh` (the new markup for `root`) that stands for `el` (inside `root`). An
 * element with an id is the one with that id. Otherwise, within its nearest ancestor with an id
 * (or the root): the one with its name (and value, for a checkbox or radio) when exactly one has
 * it on both sides, else (unless `exact`) the one at the same place. `ids` finds an element of
 * `fresh` by id, for a caller that looks up many ({@link idsIn}).
 * @param {Element} root @param {Element} fresh @param {Element} el @param {boolean} [exact]
 * @param {(id: string) => Element | null} [ids]
 * @returns {Element | null}
 */
function counterpart(root, fresh, el, exact, ids) {
  if (el === root) return fresh;
  const id = idOf(el);
  if (id) return ids ? ids(id) : queryOne(fresh, `#${CSS.escape(id)}`);
  const anchor = anchorOf(root, el);
  const home = anchor === root ? fresh : counterpart(root, fresh, anchor, false, ids);
  const name = attrOf(el, "name");
  if (!home) return null;
  if (name) {
    const selector = named(el, name);
    const theirs = queryAll(home, selector);
    if (theirs.length === 1 && queryAll(anchor, selector).length === 1) return theirs.item(0);
  }
  if (exact) return null;
  /** @type {Element | undefined} */
  let found = home;
  for (let at = el, path = []; ; at = /** @type {Element} */ (parentElementOf(at))) {
    if (at === anchor) {
      for (const i of path) found = found && childrenOf(found)[i];
      return found && localNameOf(found) === localNameOf(el) ? found : null;
    }
    path.unshift(Array.prototype.indexOf.call(childrenOf(/** @type {Element} */ (parentElementOf(at))), at));
  }
}

/**
 * Finds the elements of `fresh` by id, as `fresh.querySelector("#id")` does (the first one in
 * document order), from a map made on the first lookup: a patch that looks up an element for
 * each row (a form's submit key, an opened menu) reads `fresh` once, not once a row. For one
 * patch only: `fresh` must not change while it is used.
 * @param {Element} fresh @returns {(id: string) => Element | null}
 */
function idsIn(fresh) {
  /** @type {Map<string, Element> | null} */
  let byId = null;
  return (id) => {
    if (!byId) {
      byId = new Map();
      for (const el of Array.from(queryAll(fresh, "[id]"))) {
        const at = /** @type {string} */ (idOf(el));
        if (!byId.has(at)) byId.set(at, el);
      }
    }
    return byId.get(id) ?? null;
  };
}

/** Whether each `<details>` and `<dialog>` was open as the server sent it (its `open` attribute
 * follows the user, so the markup's is kept here). */
const served = new WeakMap();

/** Records what `root` and the elements in it were sent as. @param {ParentNode} root */
function serve(root) {
  // A query a tag each: the browser finds one tag faster than a list of them, and a load runs it
  // over the whole page.
  for (const el of [root, ...Array.from(queryAll(root, "details")), ...Array.from(queryAll(root, "dialog"))]) {
    if (el instanceof HTMLDetailsElement || el instanceof HTMLDialogElement) served.set(el, el.open);
  }
}

/**
 * What the user opened or closed in `root` (a `<dialog>`, modal or not, a `<details>`, a shown
 * popover), applied to its counterpart in `fresh` once that is in the page. One the user left as
 * the server sent it takes the fresh markup's state, so a server that sends a dialog closed after
 * sending it open closes it. `root` itself, closed by the user and drawn open in answer to a
 * press outside it (a form's trigger beside a dialog), opens: the press is newer than their
 * close, so a dialog they closed and ask for again opens. One they opened stays open whatever the
 * answer draws. Outside is where the control was when it was pressed (`within`), so one removed,
 * or a dialog redrawn, while the answer was on its way does not turn a press inside into one
 * outside. A popover has no markup that shows it, so it stays as the user left it.
 * @param {Element} root @param {Element} fresh @param {(id: string) => Element | null} ids
 * @param {Set<string>} [within] the ids of the dialogs and details the control that asked for the
 *   patch was in when it was pressed ({@link asking})
 * @returns {() => void}
 */
function opened(root, fresh, ids, within) {
  /** @type {(() => void)[]} */
  const later = [];
  for (const el of [root, ...Array.from(queryAll(root, "details, dialog, [popover]"))]) {
    const dialog = el instanceof HTMLDialogElement;
    const toggles = dialog || el instanceof HTMLDetailsElement;
    const popover = hasAttr(el, "popover");
    const shown = popover && matchesOf(el, ":popover-open");
    const now = toggles && /** @type {HTMLDialogElement} */ (el).open;
    // Left as the server sent it, and not a shown popover: the fresh markup says, so its
    // counterpart is not looked up (a lookup is a query of `fresh`; most patches open nothing).
    if (!shown && (!toggles || (served.has(el) && served.get(el) === now))) continue;
    // A dialog or popover only by id: by place, another row's could open over the page.
    const to = counterpart(root, fresh, el, dialog || popover, ids);
    if (!to || localNameOf(to) !== localNameOf(el)) continue;
    if (shown && hasAttr(to, "popover")) later.push(() => HTMLElement.prototype.showPopover.call(to));
    if (!toggles) continue;
    const drawnOpen = /** @type {HTMLDialogElement} */ (to).open;
    // Unchanged since the server sent it (or unknown, markup a script added): the fresh markup
    // says. Changed by the user: theirs, which is also what a server that changed it now says.
    // Closed by the user and drawn open in answer to a press outside it: the answer's.
    if (now === (served.has(el) ? served.get(el) : drawnOpen) || (el === root && within && !now && drawnOpen && !within.has(attrOf(root, "id") ?? ""))) continue;
    if (!dialog) /** @type {HTMLDetailsElement} */ (to).open = now;
    else if (!now) to.removeAttribute("open");
    else {
      const modal = el.matches(":modal");
      const dialogTo = /** @type {HTMLDialogElement} */ (to);
      // Modal again, not just open: the top layer, the backdrop and the rest of the page inert.
      later.push(() => {
        if (!modal) return dialogTo.show();
        dialogTo.removeAttribute("open");
        dialogTo.showModal();
      });
    }
  }
  return () => {
    for (const open of later) {
      try {
        open();
      } catch {}
    }
  };
}

/**
 * Replaces `root` with `fresh`, carrying over the fields the user edited (since `sent`, for a
 * field the form sent; else since the markup set them), what the user opened, the focus and the
 * caret. Markup cannot give back a file input's files, so it keeps them unless the answer `took`
 * the ones it sent.
 * @param {Element} root @param {Element} fresh @param {Map<Element, string | undefined> | null} sent @param {boolean} [took]
 * @param {boolean} [focus] whether focus in `root`, and its caret, is carried into `fresh`: a
 *   page's part a link replaces leaves it to the navigation, which moves it as a link does
 * @param {Set<string>} [within] where the control that asked for `fresh` was ({@link opened})
 */
function replaceKeeping(root, fresh, sent, took, focus = true, within) {
  // A layout element keeps its place in the layout a write's page is compared with.
  if (drawn.has(root)) drawn.set(fresh, markupOf(fresh));
  serve(fresh);
  // Every lookup until `fresh` is in the page, where a script may change it.
  const ids = idsIn(fresh);
  const reopen = opened(root, fresh, ids, within);
  const focused = document.activeElement;
  const inside = focus && focused && focused !== document.body && holds(root, focused);
  const next = inside ? counterpart(root, fresh, focused, false, ids) : null;
  /** File inputs of `fresh` and the files to give them once they are in the page. @type {[HTMLInputElement, FileList | null][]} */
  const files = [];
  for (const f of [root, ...Array.from(queryAll(root, "input, textarea, select"))]) {
    // A submit key stays the form's own: renewed in place once an answer took the write, and kept
    // as sent after a 5xx (which may hide a write that applied), whatever key the answer drew.
    if (f instanceof HTMLInputElement && hasAttr(f, "data-submit")) {
      const to = counterpart(root, fresh, f, true, ids);
      if (to instanceof HTMLInputElement && hasAttr(to, "data-submit")) to.value = f.value;
      continue;
    }
    const now = stateOf(f);
    // Only a field found by id or name gets the user's text: by place, rows that moved could
    // put it into another row's field.
    const field = /** @type {HTMLInputElement} */ (f);
    const file = f instanceof HTMLInputElement && field.type === "file";
    const to = now !== undefined && (now !== (sent?.has(f) ? sent.get(f) : stateOf(f, true)) || (file && !took)) && counterpart(root, fresh, f, true, ids);
    if (!to || localNameOf(to) !== localNameOf(f)) continue;
    typedFields.add(to);
    // An input, as `f` is: the names are the same.
    if (file) files.push([/** @type {HTMLInputElement} */ (to), field.files]);
    else if (f instanceof HTMLSelectElement) {
      // Every chosen option, by value, so a multiple select keeps them all.
      const chosen = new Set(Array.from(f.selectedOptions, (o) => o.value));
      for (const o of Array.from(/** @type {HTMLSelectElement} */ (to).options)) o.selected = chosen.has(o.value);
    } else if (/^(checkbox|radio)$/.test(field.type)) /** @type {HTMLInputElement} */ (to).checked = field.checked;
    else /** @type {HTMLInputElement} */ (to).value = field.value;
  }
  elementOwn.replaceWith.call(root, fresh);
  for (const [to, chosen] of files) to.files = chosen;
  reopen();
  if (next instanceof HTMLElement) {
    focusOn(next);
    try {
      if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
        const { selectionStart, selectionEnd, selectionDirection } = focused;
        if (selectionStart !== null) /** @type {HTMLInputElement} */ (next).setSelectionRange(selectionStart, selectionEnd, selectionDirection ?? undefined);
      }
    } catch {}
  }
  // The focused element went with the patch, or its counterpart cannot take focus.
  if (inside && document.activeElement === document.body) focusNear(focused, root, fresh);
}

/**
 * Focuses `el`, or else the nearest element around it that can take focus, so a keyboard or
 * screen reader user whose element a patch took away stays where they were rather than at the
 * top of the document. With `fresh`, `el` is in `root`, which `fresh` replaced: each element up
 * to `root` stands for its counterpart in `fresh`, then the walk goes on from `fresh`'s parent.
 * One that is not focusable is made so for the move (`tabindex="-1"`), until focus leaves it
 * for another element (not for another window, which leaves it focused).
 * @param {Element | null | undefined} el @param {Element} [root] @param {Element} [fresh]
 */
function focusNear(el, root, fresh) {
  while (el && el !== document.body) {
    const to = fresh ? counterpart(/** @type {Element} */ (root), fresh, el) : el;
    if (to instanceof HTMLElement) {
      const made = !hasAttr(to, "tabindex");
      if (made) to.tabIndex = -1;
      // Through focusOn: `to` may be a form around the element that left.
      focusOn(to);
      if (document.activeElement === to) {
        if (made) {
          const off = () => document.activeElement !== to && (elementOwn.removeAttribute.call(to, "tabindex"), formCall(to, "removeEventListener", "blur", off));
          formCall(to, "addEventListener", "blur", off);
        }
        return;
      }
      if (made) elementOwn.removeAttribute.call(to, "tabindex");
    }
    if (fresh && el === root) {
      el = parentElementOf(fresh);
      fresh = undefined;
    } else el = parentElementOf(el);
  }
}

/**
 * Swaps a page response (`<title>`, the page's head tags, then the page) into <main>, once the
 * modules its handlers name are imported and the section stylesheets it links are loaded. A
 * stylesheet that fails to load makes the runtime load the page in full rather than show it
 * unstyled.
 * @param {string} html
 * @param {AbortSignal} [signal]
 * @param {boolean} [stay] keep the user's place: the scroll position (Chromium can reset it when
 *   <main> empties), what scrolls inside the page and the `<details>` open on screen
 * @param {Notice} [notice] the answer's, kept if the page has to load in full instead
 * @param {{ apply: () => void } | null} [layout] what changes around `<main>`, drawn in the same
 *   frame as the page ({@link swapDocument})
 * @param {DocumentFragment} [content] `html` parsed already (a whole page's head tags and page)
 * @param {boolean} [wholePoll] a whole read again may be superseded by a visible write failure
 * @param {string} [drew] the address (`pageKey`) a navigation drew the page for; none for a
 *   submit's page, which stays the page on screen
 * @param {() => boolean} [here] a read draws only while it is still to be drawn ({@link pressed})
 * @param {() => void} [done] called in the same task once the page is drawn: a `data-address`
 *   form's answer puts its address in the entry there ({@link send})
 * @returns {Promise<boolean>} false when it loaded the page in full instead, or drew nothing
 */
async function swapPage(html, signal, stay, notice = null, layout = null, content = parse(html), wholePoll, drew, here, done) {
  preload(content);
  const [, styled] = await Promise.all([modulesOf(content), stylesOf(content)]);
  signal?.throwIfAborted();
  if (deferWholeRead(wholePoll) || (here && !here())) return false;
  if (!styled) {
    reload(notice);
    return false;
  }
  const main = document.querySelector("main");
  if (!main) throw new Error("corten: the shell must render a <main> element");
  // The layout's elements that are the page's (`page` in `html!`, a section's nav), each for the
  // one on screen with its id, taken out of the answer so what is left is `<main>`'s children,
  // which the user's place is found in by position. One the page lacks is another layout's: the
  // page loads in full. One a patch replaced has no `page` mark, and is still the one to replace.
  // An app without them skips the walk: a search of the text costs less than one of the answer.
  /** @type {[Element, Element][]} */
  const parts = [];
  if (html.includes(" data-corten-page")) {
    for (const part of Array.from(content.children)) {
      if (!hasAttr(part, "data-corten-page")) continue;
      const id = idOf(part);
      notePart(part);
      const old = id ? document.getElementById(id) : null;
      if (!old || main.contains(old)) {
        reload(notice);
        return false;
      }
      elementOwn.remove.call(part);
      // One the server drew as the one on screen is left as it is: its scroll, its scripts' state
      // and the focus in it, as a write's page leaves a layout element that did not change. Compared
      // as layout elements are, so a nav link's `aria-current` (`req.nav`), which `markCurrent`
      // moves, does not count.
      const markup = markupOf(part);
      if (partSent.get(old) === markup) continue;
      partSent.set(part, markup);
      parts.push([old, part]);
    }
  }
  // A press made by what it draws is this answer's ({@link drawingFor}).
  drawingFor = (done && draws.get(done)) ?? null;
  const title = content.querySelector("title");
  if (title) {
    document.title = textOf(title) ?? "";
    title.remove();
  }
  const tags = Array.from(content.querySelectorAll("[data-corten-head]"));
  for (const old of Array.from(document.head.querySelectorAll("[data-corten-head]"))) old.remove();
  document.head.append(...tags);
  const view = stay ? viewOf(main, content) : null;
  // The page being left, as it is now, under the entry it was drawn for: a replace keeps the entry
  // (a link that redirects replaces the entry it pushed, not the one left), and so does a read again.
  // Back or forward records it too when it is the entry's own (Back before a link's page came).
  const traverse = navigation?.transition?.navigationType === "traverse";
  const key = navigation?.currentEntry?.key;
  if (key && drawnFor && (drawnFor !== key || traverse)) remember(drawnFor, main);
  if (key) drawnFor = key;
  typedFields.clear();
  // Back or forward to an entry: what the user typed there and had not sent, put in before the
  // page joins, so a component that reads its fields as it connects reads them.
  const typed = traverse ? typedIn.get(key ?? "") : undefined;
  if (typed) putTyped(content, typed);
  serve(content);
  const [x, y] = [scrollX, scrollY];
  for (const [old, part] of parts) {
    // One inside an element the layout drew changes what a write's page is compared with, as a
    // patch there does; one that is such an element takes its place (`replaceKeeping`).
    const parent = parentElementOf(old);
    if (!drawn.has(old) && parent) changedIn(parent, ["r", /** @type {string} */ (idOf(part)), [part]]);
    // A link followed moves the focus as one in the header does; a read again keeps it.
    replaceKeeping(old, part, null, false, !!stay);
  }
  main.replaceChildren(content);
  // A navigation's page at another address is a turn: a failed write sent from a form before it is
  // not said on one of its forms ({@link sayFailed}). Read from the address the navigation drew,
  // not the one shown, which a browser may have changed already for a navigation still on its way.
  if (drew !== undefined && drew !== shownAt) (shownAt = drew), (turns += 1);
  // A page that sets no value skips the walk: a search of the text costs less than one of the DOM.
  if (html.includes("data-vars")) for (const el of [main, ...parts.map(([, part]) => part)]) setVars(el);
  layout?.apply();
  scrolledIn.clear();
  sideways.clear();
  const kept = view?.() ?? [];
  if (stay) scrollTo(x, y);
  swapped = html;
  swappedWhole = "";
  shown = notice?.has("d") ? (notice.get("m") ?? "") : null;
  done?.();
  drawingFor = null;
  markCurrent(kept);
  readAgainLater();
  readPartsAgain(main);
  return true;
}

/**
 * An element's markup as the server drew it, comparable between this document and a page parsed
 * with DOMParser: a `<noscript>`'s content and a nonce are dropped, as one or the other hides them,
 * and `aria-current="page"`, which the runtime moves to the page's link after each navigation
 * (`markCurrent`).
 * @param {Element} el
 */
const markupOf = (el) => comparable(outerOf(el));
/**
 * Each pattern runs only on markup that holds its start: a load compares the head's tags, which
 * hold none, and a pattern's first use costs more than the rest of the load's comparison.
 * @param {string} html
 */
const comparable = (html) => {
  if (/<noscript/i.test(html)) html = html.replace(/<noscript\b([^>]*)>[\s\S]*?<\/noscript>/gi, "<noscript$1></noscript>");
  if (html.includes(' nonce="')) html = html.replace(/ nonce="[^"]*"/g, "");
  if (html.includes("<a")) html = html.replace(/<a\b[^>]*>/g, (tag) => (tag.includes(" data-nav") ? tag.replace(' aria-current="page"', "") : tag));
  return html;
};

/**
 * A patch into a layout element: what it replaced (`"r"`, by its id, with the new element), removed
 * (`"x"`) or appended to (`"a"`).
 * @typedef {["r" | "x" | "a", string, Node[]]} Put
 */
/**
 * The markup the server drew as a layout element with the patches since (a cart count, a toast)
 * applied, parsed: a copy apart from the page, which scripts do not touch. Each patch makes a new
 * one around the same copy.
 * @typedef {{ copy: Element }} Patched
 */
/**
 * The elements the server drew beside `<main>` and beside each element around it, up to `<body>`,
 * with their markup as it was sent: the layout a write's navigation compares ({@link swapDocument}).
 * Anything a script put there (a toast region, a browser extension's markup) is not one, and is
 * left as it is. An element a patch or a layout change puts in place of one takes its place here.
 * One a patch went into holds a copy with the patches applied, or, when one went into what a
 * script added, a marker (`\0` and a count) that no markup is.
 * @type {WeakMap<Element, string | Patched>}
 */
const drawn = new WeakMap();

/**
 * The markup each of the layout's elements that are the page's (`data-corten-page`) was sent as
 * (`markupOf`), so a navigation whose answer draws it the same leaves the one on screen in place.
 * One a patch or a write's page changed in place is forgotten, so the next navigation draws it.
 * @type {WeakMap<Element, string>}
 */
const partSent = new WeakMap();
/**
 * The ids of the layout's elements that have been the page's: a navigation draws the one with the
 * id, marked or not (a patch may have replaced it), so a write's failure from a form in it waits
 * for the navigation ({@link sayFailed}).
 * @type {Set<string>}
 */
const partIds = new Set();
/** @param {Element} part */
const notePart = (part) => {
  const id = idOf(part);
  if (id) partIds.add(id);
};

/**
 * A patch (`put`) changed what the server drew inside `el`: the layout element around it, if any,
 * applies it to its copy, so the next write's page is compared with what the server and the
 * patches drew there.
 * @param {Element} el @param {Put} put
 */
function changedIn(el, [how, id, nodes]) {
  partSent.delete(/** @type {Element} */ (closestOf(el, "[data-corten-page]")));
  for (let up = /** @type {Element | null} */ (el); up; up = parentElementOf(up)) {
    const was = drawn.get(up);
    if (was === undefined) continue;
    // Parsed at the first patch into it, not at load.
    const copy = typeof was !== "string" ? was.copy : was.startsWith("\0") ? null : parse(was).firstElementChild;
    const at = copy && queryOne(copy, `[id="${CSS.escape(id)}"]`);
    if (!copy || !at) {
      // No markup is the marker, and none is another's.
      drawn.set(up, `\0${(patched += 1)}`);
      return;
    }
    const fresh = nodes.map((n) => Node.prototype.cloneNode.call(n, true));
    if (how === "x") elementOwn.remove.call(at);
    else if (how === "a") elementOwn.append.call(at, ...fresh);
    else elementOwn.replaceWith.call(at, ...fresh);
    // Appends a script trims on the page (a feed in the header) would grow the copy without end:
    // once it holds well more than the element does, the marker takes its place, and the next
    // write's page draws the element again.
    const held = tagsIn(copy, "*").length;
    drawn.set(up, how === "a" && held > 2 * tagsIn(up, "*").length + 64 ? `\0${(patched += 1)}` : { copy });
    return;
  }
}
/** Patches into what a script added to the layout so far. */
let patched = 0;

/**
 * The markup the server and the patches since drew as a layout element (`was`, from {@link drawn}),
 * or null when a patch went where the server's markup has no element of its id.
 * @param {string | Patched} was @returns {string | null}
 */
function drawnAs(was) {
  if (typeof was !== "string") return outerOf(was.copy);
  return was.startsWith("\0") ? null : was;
}
for (let el = document.querySelector("main"); el && el !== document.body; el = parentElementOf(el)) {
  // As sent, made comparable only if a write's page is compared with it, so a load pays for the copy alone.
  const parent = parentElementOf(el);
  for (const beside of parent ? Array.from(childrenOf(parent)) : []) if (beside !== el) drawn.set(beside, outerOf(beside));
}
for (const part of Array.from(document.querySelectorAll("[data-corten-page]"))) partSent.set(part, markupOf(part)), notePart(part);

/**
 * What a write's page can change only by loading in full, one entry each: the element path from
 * `<main>` up and each of those elements' attributes (`lang`, a theme on `<html>`), and the layout's
 * own head tags (not the page's head tags, its title, stylesheets or scripts).
 * @param {Document} doc
 */
function frameOf(doc) {
  const parts = [];
  // Each element by its distance from <main>, so two <div>s around it are two entries.
  let depth = 0;
  for (let el = doc.querySelector("main"); el; el = parentElementOf(el), depth++) {
    parts.push(`${depth}<${localNameOf(el)}`);
    for (const a of Array.from(attributesOf(el))) if (a.name !== "nonce" && a.name !== "aria-busy") parts.push(`${depth} ${a.name}="${a.value}"`);
  }
  for (const el of Array.from(doc.head.children)) {
    // The page's values (`style={..}`) are its own, set on what is swapped in (`setVars`).
    if (localNameOf(el) === "style" && textOf(el)?.startsWith("[data-vars=")) continue;
    if (!matchesOf(el, 'title, script, [data-corten-head], link[data-corten-style], link[rel="modulepreload"]')) parts.push(markupOf(el));
  }
  return parts;
}
/**
 * This document's frame. At first it is read from the page as it loaded, which may hold what an
 * extension added before the runtime ran (an attribute on `<html>`, a `<style>` in the head), so
 * a write's page only has to have nothing it lacks: one that adds or changes an entry loads in
 * full, and an entry it only stops writing stays until a full load. Once a
 * write's page is swapped in, it is that page's, as the server sent it (`sent`, its entries in
 * order), and must match.
 * @type {{ parts: Set<string>, sent: string | null }}
 */
let frame = { parts: new Set(frameOf(document)), sent: null };

/**
 * What `doc`, a whole page, draws around `<main>` otherwise than the server drew it here: at each
 * level up to `<body>`, the elements before and after the one `<main>` is in, compared with what
 * the server sent for each. Each that changed is replaced, keeping what the user typed or opened,
 * as a patch does. Null when only a full load draws the page as the server would: another element
 * around `<main>`, more or fewer elements beside one, or another frame ({@link frameOf}). One that
 * shows the notice the page drew is replaced even when its markup is the same, since the last one
 * a script hid (a toast) is drawn again by the same text.
 * Drawing it draws what the writes `covers` names changed ({@link drew}).
 * @param {Document} doc @param {Notice} notice @param {Covers} covers
 * @returns {{ fresh: Element[], apply: () => void } | null}
 */
function layoutChanges(doc, notice, covers) {
  const said = notice?.has("d") ? notice.get("m") || null : null;
  const parts = frameOf(doc);
  const sent = parts.join("\n");
  if (frame.sent === null ? !parts.every((part) => frame.parts.has(part)) : sent !== frame.sent) return null;
  /** @type {[Element, Element, string | Patched | undefined][]} */
  const changed = [];
  let here = document.querySelector("main");
  let there = doc.querySelector("main");
  while (here && there && here !== document.body) {
    const up = parentElementOf(here);
    const upThere = parentElementOf(there);
    if (!up || !upThere || localNameOf(up) !== localNameOf(upThere)) return null;
    const mine = Array.from(childrenOf(up)).filter((el) => el === here || drawn.has(el));
    const theirs = Array.from(childrenOf(upThere));
    if (mine.length !== theirs.length || mine.indexOf(here) !== theirs.indexOf(there)) return null;
    for (const [i, el] of mine.entries()) {
      const their = theirs[i];
      if (el === here) continue;
      if (!their || localNameOf(el) !== localNameOf(their)) return null;
      const was = drawn.get(el);
      const as = was === undefined ? "" : drawnAs(was);
      if (as === null || comparable(as) !== markupOf(their) || shows(their, said)) changed.push([el, their, was]);
    }
    here = up;
    there = upThere;
  }
  if (here !== document.body || there !== doc.body) return null;
  return {
    fresh: changed.map(([, el]) => el),
    apply() {
      // An entry the load had and this page lacks stays: the runtime cannot tell the server's (a
      // theme it stopped writing) from a script's or an extension's (a theme set before first paint).
      frame = { parts: frame.parts, sent };
      drew(covers);
      for (const [old, el, was] of changed) {
        // One a patch replaced, or changed inside, while the page was on its way is newer than the
        // page: it stays.
        if (!inPage(old) || drawn.get(old) !== was) continue;
        const markup = markupOf(el);
        // The server's markup of each page's part in it, before drawing adds what the user had
        // (a <details> they opened) or a focus move's tabindex.
        const parts = [el, ...Array.from(queryAll(el, "[data-corten-page]"))]
          .filter((part) => hasAttr(part, "data-corten-page"))
          .map((part) => /** @type {const} */ ([part, part === el ? markup : markupOf(part)]));
        const as = was === undefined ? null : drawnAs(was);
        drawLayout(old, el, as === null ? null : parse(as).firstElementChild, said);
        const now = inPage(old) ? old : el;
        drawn.set(now, markup);
        // A page's part the write's page drew anew is what the next navigation compares with.
        if (now !== old) for (const [part, sent] of parts) partSent.set(part, sent);
        setVars(now);
      }
    },
  };
}

/** A live region: what goes into it is announced, but not one inserted with its message. */
const LIVE = '[role="status"], [role="alert"], [aria-live]';
/**
 * The notice (`said`) is in a live region in or at `el`: the one place a script may have hidden
 * the last one (a toast), so it is drawn again even when the markup is the same. Text elsewhere
 * that happens to hold it (a "Saved searches" link for "Saved") leaves the element as it is.
 * @param {Element} el @param {string | null} said
 */
const shows = (el, said) =>
  said !== null && [...(matchesOf(el, LIVE) ? [el] : []), ...Array.from(queryAll(el, LIVE))].some((live) => textOf(live)?.includes(said));
/**
 * Draws `fresh`, the server's markup for the layout element `old`, in its place, as a patch
 * replaces an element ({@link replaceKeeping}), except that a live region in it (a toaster's)
 * stays and takes the new content, as a patch inside it would, so its message is announced.
 * Inside an element kept for a region, what the server draws as it drew it before (`before`, its
 * earlier markup, when known) stays as it is, with what a script did to it (a toaster's button it
 * showed), unless it shows the notice (`said`); anything else of the same shape is drawn in place,
 * so an element a script holds stays the one it holds, and one of another shape is replaced.
 * @param {Element} old @param {Element} fresh @param {Element | null} before @param {string | null} said @param {boolean} [inside]
 */
function drawLayout(old, fresh, before, said, inside = false) {
  if (localNameOf(old) !== localNameOf(fresh) || !(inside || matchesOf(old, LIVE) || queryOne(old, LIVE))) return replaceKeeping(old, fresh, null);
  // Changed in place: a page's part that is or holds it is drawn by the next navigation.
  partSent.delete(/** @type {Element} */ (closestOf(old, "[data-corten-page]")));
  const wiring = () => ["data-on", "data-ref", "data-scope"].map((a) => attrOf(old, a)).join("\n");
  const was = wiring();
  // The ref it had too, whose holders look again.
  const names = new Set();
  refName(old, names);
  // What the user opened or closed stays as they left it, as a patch keeps it ({@link opened}).
  const toggles = old instanceof HTMLDetailsElement || old instanceof HTMLDialogElement;
  for (const a of Array.from(attributesOf(old))) if (!hasAttr(fresh, a.name) && !(toggles && a.name === "open")) elementOwn.removeAttribute.call(old, a.name);
  for (const a of Array.from(attributesOf(fresh))) if (attrOf(old, a.name) !== a.value && !(toggles && a.name === "open")) elementOwn.setAttribute.call(old, a.name, a.value);
  if (toggles) {
    const [now, want] = [old.open, hasAttr(fresh, "open")];
    // Left as the server sent it: the server's state now. A modal one closes by `close()`, which
    // also ends the rest of the page being inert; taking away its `open` would not.
    if ((!served.has(old) || served.get(old) === now) && now !== want) {
      if (!(old instanceof HTMLDialogElement)) old.open = want;
      else if (want) old.show();
      else old.close();
    }
    served.set(old, want);
  }
  // Its new handlers are listened for and its refs found again, as for an element that joined; a
  // kept element's `on:connect` does not run again.
  if (wiring() !== was) {
    scan(old, names);
    for (const name of names) refChanges.set(name, ++refVersion);
  }
  if (matchesOf(old, LIVE)) {
    const content = document.createDocumentFragment();
    content.append(...Array.from(childNodesOf(fresh)));
    serve(content);
    elementOwn.replaceChildren.call(old, content);
    return;
  }
  const [mine, theirs] = [Array.from(childNodesOf(old)), Array.from(childNodesOf(fresh))];
  if (mine.length !== theirs.length || mine.some((n, i) => nodeNameOf(n) !== (theirs[i] ? nodeNameOf(theirs[i]) : undefined))) return replaceKeeping(old, fresh, null);
  const then = before && childNodesOf(before).length === theirs.length ? childNodesOf(before) : null;
  mine.forEach((n, i) => {
    const [there, was] = [theirs[i], then?.[i]];
    // The same length as `mine`, checked above.
    if (!there) return;
    if (!(n instanceof Element)) {
      if (was?.nodeValue !== there.nodeValue && n.nodeValue !== there.nodeValue) n.nodeValue = there.nodeValue;
      return;
    }
    const fresh = /** @type {Element} */ (there);
    const same = was instanceof Element && localNameOf(was) === localNameOf(n) && comparable(outerOf(was)) === markupOf(fresh);
    if (!same || shows(fresh, said)) drawLayout(n, fresh, was instanceof Element ? was : null, said, true);
  });
}

/**
 * Swaps in the whole page a write sent the browser to, or answered with (`own`): `<main>` and the
 * page's head tags as a navigation's answer has them ({@link swapPage}), and each element around
 * `<main>` the server now draws otherwise, so what the write changed there (a count in the header)
 * is current, as it is after the full load a browser without JavaScript makes. A page whose frame or
 * layout differs in shape loads in full; a write's own page, which a load of its address would not
 * draw, swaps in `<main>` alone instead, and the next navigation reads the whole page. The page
 * reading itself again (`again`) is left as it is when neither the page nor the layout changed, and
 * the notice it sent back ({@link shown}) is not taken for a new one. False when it loaded in full
 * or was left as it is.
 * @param {string} html @param {AbortSignal} signal @param {Notice} notice @param {boolean} again
 * @param {boolean} stay keep the user's place ({@link swapPage})
 * @param {boolean} own the write's own answer, not a page at an address
 * @param {Covers} covers the writes whose change to the layout the page draws
 * @param {string} [drew] the address a navigation drew the page for ({@link swapPage})
 * @param {() => boolean} [here] a read draws only while it is still to be drawn ({@link pressed})
 * @returns {Promise<boolean>}
 */
async function swapDocument(html, signal, notice, again, stay, own, covers, drew, here) {
  const doc = new DOMParser().parseFromString(trustedHTML(html), "text/html");
  // Parsed with scripting off, as `parse` does, so a `<noscript>`'s content would be live.
  for (const noscript of Array.from(doc.querySelectorAll("noscript"))) noscript.replaceChildren();
  const main = doc.querySelector("main");
  const layout = main && layoutChanges(doc, again ? null : notice, covers);
  if (!main || (!layout && !own)) {
    reload(notice);
    return false;
  }
  preload(doc.head);
  await Promise.all((layout?.fresh ?? []).map(modulesOf));
  signal.throwIfAborted();
  // What a navigation's answer holds: the title, the page's head tags, the section stylesheets and
  // the page.
  const head = [doc.querySelector("title"), ...Array.from(doc.head.querySelectorAll("[data-corten-head], link[data-corten-style]"))].filter(
    (el) => el !== null,
  );
  // A write's own page whose frame differs swaps in what a navigation's answer holds, the layout's
  // elements that are the page's (`page` in `html!`, a section's nav) included ({@link swapPage}).
  // With the layout drawn, they are drawn with it.
  const marked = Array.from(doc.body.querySelectorAll("[data-corten-page]"));
  // With the layout drawn, its parts are the page's from now on ({@link partIds}).
  for (const el of marked) notePart(el);
  const parts = layout ? [] : marked.filter((el) => {
    const parent = parentElementOf(el);
    return !parent || !closestOf(parent, "[data-corten-page]");
  });
  const text = head.map((el) => outerOf(el)).join("") + parts.map((el) => outerOf(el)).join("") + main.innerHTML;
  // Read again with nothing new in the page: it stays as it is, with what the user typed and its
  // live streams, and only what changed around it (a count the layout reads) is drawn.
  if (again && layout && text === swappedWhole) {
    if (deferWholeRead(true)) return false;
    if (layout.fresh.length === 0) {
      readAgainLater();
      return false;
    }
    // Its section stylesheets are the page's, which are on the page already.
    layout.apply();
    readAgainLater();
    return true;
  }
  // The nodes parsed above, not the text parsed again.
  const content = document.createDocumentFragment();
  content.append(...head, ...parts, ...Array.from(childNodesOf(main)));
  const swappedIn = await swapPage(text, signal, stay, notice, layout, content, again, drew, here);
  // The layout not drawn, the write's own page among the writes it has not drawn: the next
  // navigation reads the page whole, as after a write that redirected.
  if (swappedIn && layout) swappedWhole = text;
  return swappedIn;
}

/**
 * A page answer's notice (`corten-notice`, `m=<text>`, with `&d` when the page drew it): what
 * the write that redirected to it said (`req.redirect_with_notice`). Kept across a reload that
 * draws the page in full instead (`reload`), where nothing draws it.
 * @typedef {URLSearchParams | null} Notice
 */
const NOTICE = "corten-notice";
/** @param {Response} res @returns {Notice} */
const noticeOf = (res) => (res.headers.has(NOTICE) ? new URLSearchParams(res.headers.get(NOTICE) ?? "") : null);

/**
 * After a page answer is drawn: the notice it did not draw as `corten:notice` on the document
 * (`detail.message`), for the app's toaster. The layout around `<main>` does not run for a swap.
 * It bubbles, so an element's `on:document:corten:notice` hears it as a page-wide handler.
 * @param {Notice} notice
 */
function announce(notice) {
  if (notice && !notice.has("d")) document.dispatchEvent(new CustomEvent("corten:notice", { bubbles: true, detail: { message: notice.get("m") ?? "" } }));
}

/**
 * The elements the user (or a script) scrolled since the page was swapped in: noted as they
 * scroll, so keeping a page's place does not read the scroll of every element in it.
 * @type {Set<Element>}
 */
const scrolledIn = new Set();
/** Of those, the ones scrolled sideways at some point, back to their start too: the rows. @type {Set<Element>} */
const sideways = new Set();
document.addEventListener(
  "scroll",
  (event) => {
    const el = event.target;
    if (!(el instanceof Element)) return;
    scrolledIn.add(el);
    if (scrollOf(el, "scrollLeft")) sideways.add(el);
  },
  { capture: true, passive: true },
);

/**
 * What the user sees in `root` that a swap to `fresh` keeps when it keeps their place: a
 * `<details>` open on screen stays open, one they closed stays closed (the rest take the new
 * markup's state), and an element that scrolls on its own (a filter rail) keeps its scroll, so
 * the control focus returns to is open and in view. Each is matched as a patch matches it. Read
 * before `fresh` is inserted; the function it returns applies it after. The scrolled elements are
 * those a `scroll` event named and the ones around the focused control, since that event comes at
 * the next frame and a swap can land first (a control focus scrolled into view, a slow machine).
 * @param {Element} root @param {DocumentFragment} fresh @returns {() => Element[]} applies it and
 * returns the rows the user scrolled sideways (back to the start too), each where they left it
 */
function viewOf(root, fresh) {
  const to = /** @type {Element} */ (/** @type {unknown} */ (fresh));
  /** @type {[HTMLDetailsElement, boolean][]} */
  const open = [];
  for (const el of /** @type {HTMLDetailsElement[]} */ (Array.from(queryAll(root, "details")))) {
    if (!(el.open || served.get(el))) continue;
    const there = counterpart(root, to, el);
    if (there instanceof HTMLDetailsElement) open.push([there, el.open]);
  }
  /** @type {[Element, number, number][]} */
  const scrolled = [];
  /** The rows the user scrolled sideways, back to their start too. @type {Element[]} */
  const rows = [];
  const around = new Set(scrolledIn);
  for (let el = document.activeElement; el && el !== root; el = parentElementOf(el)) around.add(el);
  for (const el of around) {
    const top = scrollOf(el, "scrollTop");
    const left = scrollOf(el, "scrollLeft");
    if (!holds(root, el) || !(top || left || sideways.has(el))) continue;
    const there = counterpart(root, to, el);
    if ((there ? localNameOf(there) : undefined) !== localNameOf(el)) continue;
    if (top || left) scrolled.push([/** @type {Element} */ (there), top, left]);
    // Scrolled sideways now, or before (back to its start too): a scroll in the same frame as the
    // swap has not had its event yet.
    if (left || sideways.has(el)) rows.push(/** @type {Element} */ (there));
  }
  return () => {
    for (const [el, now] of open) el.open = now;
    // A restored scroll's event comes later too, and the next swap may come first.
    for (const [el, top, left] of scrolled) elementOwn.scrollTo.call(el, left, top), scrolledIn.add(el);
    for (const el of rows) scrolledIn.add(el), sideways.add(el);
    // A nav row's current link stays where the user left it.
    return rows;
  };
}

/**
 * The section stylesheets {@link stylesOf} added to <head> that have not loaded yet, by URL, so a
 * second answer that links one (a patch while another is in flight, a navigation) waits for the
 * same load rather than take a link in the head for a loaded stylesheet.
 * @type {Map<string, Promise<boolean>>}
 */
const loadingStyles = new Map();

/**
 * Moves the section stylesheets a page or a patch links (`Area::components`) out of it, adds those
 * this document lacks to <head> and resolves when they have loaded: true, or false when one
 * failed, which is taken out again so a later answer that links it tries again. Those that load
 * are never removed: their rules only match their own components' classes. One that neither
 * loads nor fails holds the answer, as the browser holds a page on a stylesheet.
 * @param {DocumentFragment} content
 * @returns {Promise<boolean>}
 */
async function stylesOf(content) {
  const links = /** @type {NodeListOf<HTMLLinkElement>} */ (content.querySelectorAll("link[data-corten-style]"));
  if (!links.length) return true;
  const have = Array.from(document.head.querySelectorAll("link[data-corten-style]"), (link) => link.getAttribute("href"));
  const loads = Array.from(links, (link) => {
    link.remove();
    const href = link.getAttribute("href") ?? "";
    const loading = loadingStyles.get(href);
    if (loading) return loading;
    if (have.includes(href)) return true;
    document.head.append(link);
    /** @type {Promise<boolean>} */
    const load = new Promise((resolve) => {
      link.onload = () => {
        loadingStyles.delete(href);
        resolve(true);
      };
      link.onerror = () => {
        loadingStyles.delete(href);
        link.remove();
        resolve(false);
      };
    });
    loadingStyles.set(href, load);
    return load;
  });
  return (await Promise.all(loads)).every(Boolean);
}

/**
 * Starts the fetches of the modules a swapped-in page's handler modules import (its
 * `<link rel="modulepreload">` tags), so they arrive with those modules rather than one round trip
 * after, as on a full load. Each link moves to the head, once per URL; none is left in `content`.
 * One of the page's own head tags (`data-corten-head`) is left for the swap to put in place.
 * @param {ParentNode} content
 */
function preload(content) {
  for (const link of Array.from(queryAll(content, 'link[rel="modulepreload"]:not([data-corten-head])'))) {
    link.remove();
    const href = link.getAttribute("href");
    if (href && !document.head.querySelector(`link[rel="modulepreload"][href="${CSS.escape(href)}"]`)) document.head.append(link);
  }
}

/** A nav link the runtime keeps `aria-current` on (`Req::nav`). */
const NAV = "a[href][data-nav]";

/**
 * True when `el` is or holds a nav link. Called through the prototype: a form's field named
 * `matches` would hide the form's own.
 * @param {Element} el
 */
const holdsNav = (el) => matchesOf(el, NAV) || !!queryOne(el, NAV);

/**
 * Sets `aria-current="page"` on `<a data-nav>` links to this page (`data-nav="section"`: to this
 * page or any page under it) and removes it from the rest, after a navigation and after a patch
 * that puts one on the page or removes one. Of the links of one `data-nav-group` (`Req::nav_of`),
 * only the deepest that holds the page is current. The shell is not re-rendered by client
 * navigation, so its menu would otherwise keep pointing at the first page. A link made current,
 * or current when first seen (the server's mark on a full load, or in a row a write's page or a
 * patch drew again), is brought into view in the row that scrolls it, so a long nav row does not
 * mark a page out of sight; one that stays current is left where the user scrolled it. `kept`: the
 * rows a swap that keeps the user's place found the user had scrolled sideways, back to their
 * start too (`viewOf`), so a link in one, current when first seen, is left where the user put it
 * (a new row inside one still brings its own link into view).
 * @param {Element[]} [kept]
 */
function markCurrent(kept = []) {
  const here = location.pathname;
  /** Each link, its group (itself when it has none) and how deep it is when it holds the page. @type {[Element, Element | string, number][]} */
  const links = [];
  /** The deepest link that holds the page in each group. @type {Map<Element | string, number>} */
  const deepest = new Map();
  for (const link of Array.from(document.querySelectorAll(NAV))) {
    const path = new URL(/** @type {HTMLAnchorElement} */ (link).href).pathname;
    const base = path.replace(/\/+$/, "");
    const holds = here === path || (link.getAttribute("data-nav") === "section" && here.startsWith(`${base}/`));
    const group = link.getAttribute("data-nav-group") ?? link;
    const depth = holds ? base.length : -1;
    links.push([link, group, depth]);
    deepest.set(group, Math.max(deepest.get(group) ?? -1, depth));
  }
  /** Each link to bring into view, and the rows to leave as they are for it. @type {[Element, Element[]][]} */
  const made = [];
  for (const [link, group, depth] of links) {
    if (depth >= 0 && depth === deepest.get(group)) {
      if (link.getAttribute("aria-current") !== "page") {
        link.setAttribute("aria-current", "page");
        made.push([link, []]);
      } else if (!seenNav.has(link)) made.push([link, kept]);
    } else if (link.hasAttribute("aria-current")) link.removeAttribute("aria-current");
    seenNav.add(link);
  }
  // In the next frame, once the page is laid out.
  if (made.length) requestAnimationFrame(() => made.forEach(([link, leave]) => inView(link, leave)));
}

/** The nav links `markCurrent` has seen. @type {WeakSet<Element>} */
const seenNav = new WeakSet();
const scrollWidthOf = getter(Element.prototype, "scrollWidth");
const clientWidthOf = getter(Element.prototype, "clientWidth");
const clientLeftOf = getter(Element.prototype, "clientLeft");

/**
 * When `el` is shown and not wholly in view in the nearest box around it that overflows sideways
 * and scrolls (a nav row wider than the bar), scrolls that box at once to put it in the middle, or
 * its start at the box's when it is wider than the box: never the page, which a current link in a
 * header scrolled out of sight (a full load at a fragment) must not be moved to, and only sideways.
 * A box in `leave` (a row the user scrolled) is left as it is. This stands in for
 * `el.scrollIntoView({ inline: "center", block: "nearest", container: "nearest" })`, which scrolls
 * only the nearest scroll container, until every supported browser has `container`; that call
 * would still need the checks for a box in `leave`, a link already in view and a link wider than
 * the box.
 * @param {Element} el @param {Element[]} leave
 */
function inView(el, leave) {
  if (!el.getClientRects().length) return;
  for (let box = parentElementOf(el); box && box !== document.body; box = parentElementOf(box)) {
    if (scrollWidthOf(box) <= clientWidthOf(box) || !/auto|scroll/.test(getComputedStyle(box).overflowX)) continue;
    if (leave.includes(box)) return;
    const [b, e] = [elementOwn.getBoundingClientRect.call(box), el.getBoundingClientRect()];
    if (e.left >= b.left && e.right <= b.right) return;
    // A link wider than the box: its start at the start of the box's content, inside its border
    // and padding.
    const style = getComputedStyle(box);
    const left =
      e.width < b.width
        ? (e.left + e.right - b.left - b.right) / 2
        : style.direction === "rtl"
          ? e.right - (b.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight))
          : e.left - (b.left + clientLeftOf(box) + parseFloat(style.paddingLeft));
    /** @type {(options: ScrollToOptions) => void} */ (elementOwn.scrollBy).call(box, { left, behavior: "instant" });
    return;
  }
}

/** The shell key the server printed for this document. */
const shellKey = queryOne(metas, 'meta[name="corten-shell"]')?.getAttribute("content") ?? null;

/**
 * True when a page response belongs to another shell: the document must be loaded in full.
 * @param {Response} res
 */
function shellChanged(res) {
  const key = res.headers.get("corten-shell");
  return key !== null && shellKey !== null && key !== shellKey;
}

/**
 * Moves focus to the first field the server marked invalid in `form` (or in its replacement,
 * found by id), else in <main>; unless the user has moved on to something outside it.
 * @param {HTMLFormElement} form
 */
function focusInvalid(form) {
  const id = formProperty(form, "id");
  const home = (inPage(form) ? form : id && document.getElementById(id)) || document.querySelector("main");
  const active = document.activeElement;
  if (active && active !== document.body && (!home || !holds(home, active))) return;
  const field = (home && queryOne(home, '[aria-invalid="true"]')) ?? document.querySelector('main [aria-invalid="true"]');
  if (field instanceof HTMLElement) focusOn(field, true);
}

/**
 * Navigation responses fetched ahead of a likely click, by URL without the hash, oldest first.
 * At most `PREFETCH_MAX`: a page hovered and never followed is dropped (its body cancelled) once
 * newer ones push it out or it goes stale, so a long session does not hold every page it hovered.
 * @type {Map<string, { at: number, response: Promise<Response>, stop: AbortController }>}
 */
const prefetched = new Map();
const PREFETCH_FRESH_MS = 10_000;
const PREFETCH_MAX = 8;

/**
 * Drops a prefetch: aborting it cancels the request (so the server sees the client go, as for a
 * navigation away) or, once it has answered, the body.
 * @param {{ stop: AbortController } | undefined} entry
 */
function discard(entry) {
  entry?.stop.abort();
}

/** @param {URL} url */
function pageKey(url) {
  const key = new URL(url);
  key.hash = "";
  return key.href;
}

/** @param {EventTarget | null} target */
function prefetch(target) {
  // Without the Navigation API a click is a full page load, which cannot use a prefetched swap.
  if (!("navigation" in window)) return;
  const link = target instanceof Element ? closestOf(target, "a[href]") : null;
  if (!(link instanceof HTMLAnchorElement) || link.target || link.hasAttribute("download")) return;
  if (link.closest("[data-reload], [data-no-prefetch]")) return;
  const url = new URL(link.href, location.href);
  // The page a visit is fetching is not prefetched as well: the address stays this page's until
  // it is in, and a hover then (the pointer back on its link, on a part of it, on another link to
  // it) would fetch it a second time.
  if (url.origin !== location.origin || pageKey(url) === pageKey(new URL(location.href)) || pageKey(url) === fetching?.key) return;
  const key = pageKey(url);
  // The user asked the browser to save data.
  if (/** @type {Navigator & { connection?: { saveData?: boolean } }} */ (navigator).connection?.saveData) return;
  const now = performance.now();
  const hit = prefetched.get(key);
  if (hit && now - hit.at < PREFETCH_FRESH_MS) return;
  prefetched.delete(key);
  discard(hit);
  for (const [old, entry] of prefetched) {
    if (prefetched.size < PREFETCH_MAX && now - entry.at < PREFETCH_FRESH_MS) break;
    prefetched.delete(old);
    discard(entry);
  }
  const stop = new AbortController();
  // `Purpose: prefetch` says no one asked for the page yet (a script may not send `Sec-Purpose`),
  // so a debug build can name a page too costly to fetch on a hover.
  // An answer that is neither a page nor Corten's redirect (a proxy's 204 or 503 to a prefetch) is
  // not handed to the click, which fetches the page again rather than load the document in full;
  // its body is not read, so the request is aborted. The entry stays until it is stale, so a
  // hover does not ask a refusing proxy again sooner.
  const response = fetch(key, { headers: { corten: "nav", purpose: "prefetch" }, priority: "low", signal: stop.signal }).then(
    (res) => (res.headers.has("corten-page") || res.headers.has("corten-location") ? res : Promise.reject(res)),
  );
  response.catch(() => stop.abort());
  prefetched.set(key, { at: now, response, stop });
}

/** The page the newest visit is fetching, until that visit ends. @type {{ key: string } | null} */
let fetching = null;
/**
 * Navigations on their way, each with whether it draws the whole page, from the start of its visit
 * until the visit ends or is abandoned: a write's failure waits for the last to end
 * ({@link sayFailed}), and a marked answer does not draw meanwhile ({@link pressed}). The page
 * reading itself again is not one: a whole read again puts itself off while a failure is undrawn
 * ({@link deferWholeRead}).
 * @type {Set<{ whole: boolean }>}
 */
const reading = new Set();
/** What waits for that, each run in a task of its own once no navigation is on its way. @type {(() => void)[]} */
const afterReads = [];
/**
 * The transition of the page's last read of itself again (`ReadAgain`), the one navigation of the
 * runtime's own that a marked answer's replace may cancel, as it reads again later ({@link send}).
 * @type {NavigationTransition | null | undefined}
 */
let readAgainTransition;

/** @type {ReturnType<typeof setTimeout> | undefined} */
let hoverTimer;
document.addEventListener("pointerover", (event) => {
  clearTimeout(hoverTimer);
  // A short dwell, so moving the pointer across a list does not fetch every link.
  hoverTimer = setTimeout(() => prefetch(event.target), 65);
});
document.addEventListener("pointerout", () => clearTimeout(hoverTimer));
document.addEventListener("touchstart", (event) => prefetch(event.target), { passive: true });

/**
 * @param {URL} url
 * @param {AbortSignal} signal
 * @param {Response} [redirected] the answer to this URL, already fetched by a navigation that
 *   the server redirected here
 * @param {boolean} [again] the page reading itself again (`ReadAgain`): never a prefetched
 *   answer, not marked busy, and not swapped when nothing changed
 * @param {ReturnType<typeof placeOf>} [place] where a `data-keep-place` navigation leaves the
 *   user, handed on when the server redirects
 * @param {Element | null} [source] what started it, marked busy with `main`: a link, a form, or
 *   the button that sent a form (and that button's form)
 * @param {boolean} [whole] read the whole page and draw its layout again
 * @param {number} [through] the writes answered before the page is asked for, which its layout
 *   draws ({@link Covers})
 * @param {Precommit} [precommit] where the address waits for the answer ({@link interceptVisit})
 */
async function visit(url, signal, redirected, again, place, source, whole, through = writesIn, precommit) {
  // Another page on this entry, even one that keeps its key (a redirect's): a marked answer pressed
  // before it, as a `navigate` listener heard it too, is for the page it leaves ({@link entry}).
  if (!again) moves += 1;
  else readAgainTransition = navigation?.transition;
  const key = pageKey(url);
  // A read again fetches the page on screen, which no prefetch takes.
  const going = again ? null : { key };
  const hit = again || whole ? undefined : prefetched.get(key);
  prefetched.delete(key);
  const fresh = hit && performance.now() - hit.at < PREFETCH_FRESH_MS;
  // A redirected visit has its answer already, so a prefetch of the same page goes unused.
  if (!fresh || redirected) discard(hit);
  // A visit left before its prefetched answer is used stops that request too.
  else signal.addEventListener("abort", () => discard(hit), { once: true });
  // Counted until it ends or is abandoned, whichever comes first: an abandoned visit draws nothing
  // (it checks its signal before each draw), and what it still awaits (a section stylesheet, a
  // prefetched answer) may never end. Then what waits runs, after the navigation's own end (its
  // focus reset, its scroll), in a task. Counted before anything is marked busy, which runs the
  // page's code (a customized link's `attributeChangedCallback`): a marked form pressed there is
  // for the page this visit leaves, and is not sent ({@link pressed}).
  const read = { whole: !!whole };
  if (!again) reading.add(read);
  const done = () => {
    if (reading.delete(read) && !reading.size) for (const run of afterReads.splice(0)) setTimeout(run);
  };
  // Marked busy as this visit's (past a form control named setAttribute): a newer visit's mark
  // is not cleared when this one ends. A form's navigation marks the form and the button that
  // sent it, one outside it (`form=`) too.
  const mine = {};
  const form = source instanceof HTMLButtonElement || source instanceof HTMLInputElement ? source.form : null;
  const busy = again ? [] : [document.querySelector("main"), form ?? source, form && source];
  for (const el of busy) if (el) busyBy.set(el, mine), formCall(el, "setAttribute", "aria-busy", "true");
  // Cleared when the visit ends, or at once when it is abandoned: a prefetched answer it awaits
  // is not cancelled with it. Cleared while the visit is still counted, as clearing runs the page's
  // code too: a marked form pressed there is not sent either.
  const idle = () => {
    for (const el of busy) if (el && busyBy.get(el) === mine) formCall(el, "removeAttribute", "aria-busy");
  };
  const abandoned = () => (idle(), done());
  signal.addEventListener("abort", abandoned);
  // One abandoned before it started, or as it was marked, gets no abort event.
  if (signal.aborted) abandoned();
  if (going) fetching = going;
  try {
    /** @type {Response} */
    let res;
    try {
      res = redirected
        ? redirected
        : hit && fresh
          ? await hit.response.catch(() => fetch(url, { headers: { corten: "nav" }, signal }))
          : // After a write, the whole document, as a full load reads it. A read again sends back
            // the notice the page drew, which it draws the same.
            await fetch(url, { headers: readHeaders(!!whole, again), signal });
    } catch (error) {
      if (signal.aborted) throw error;
      if (deferWholeRead(whole && again)) return;
      // Offline or the server is unreachable: load the URL as a normal navigation, which the
      // service worker (if any) answers with the offline page, and the browser otherwise explains.
      await precommit?.commit();
      signal.throwIfAborted();
      reload();
      return;
    }
    signal.throwIfAborted();
    // Sent to a place on a page (`route.at(id)`) or another site: the server names it here, since
    // `fetch` follows a redirect but drops its `#id`, and cannot read another origin's answer.
    // Where the address waits for the answer, this navigation has not changed it yet: the next one
    // takes its place in history (a link's new entry) and this one ends unseen, so the link's
    // address never shows. Elsewhere the link's address is already in, and is replaced.
    // Read against the answer's URL, as a full load's redirect is, whatever the address is now.
    const to = res.headers.get("corten-location");
    if (to) {
      go(new URL(to, res.url).href, { history: precommit?.history ?? "replace", info: { [LOAD]: true, [KEEP_PLACE]: place, [SOURCE]: source, [WRITTEN]: whole } });
      return;
    }
    // The address changes now that the answer is here, as a full load's does: whatever is done
    // with the answer after this (a swap, a full load) starts from it.
    const took = (await precommit?.commit(res)) ?? false;
    // The address it draws the page for: the redirect's target when the address took it.
    const drew = pageKey(took ? new URL(res.url) : url);
    signal.throwIfAborted();
    if (deferWholeRead(whole && again)) return;
    const notice = noticeOf(res);
    // A read again's notice is the one the page drew and the user has seen: a full load in its
    // place does not say it again. The answer does not say whether the notice was sent back or is
    // another tab's cookie notice for this path; that one is then not announced here either.
    if (again) notice?.set("r", "");
    if (!res.headers.has(whole ? "corten-shell" : "corten-page") || shellChanged(res)) {
      reload(notice);
      return;
    }
    // The server redirected (a `Caller` sending someone to sign in). Changing the address with
    // history.replaceState would abort this navigation and the body with it, so read the body,
    // then navigate again to where it came from, in place of this entry, with the page in hand.
    if (res.redirected && !redirected && !took) {
      const page = new Response(await res.text(), { headers: res.headers });
      askedAfter.set(page, through);
      signal.throwIfAborted();
      go(res.url, { history: "replace", info: { [REDIRECTED]: page, [KEEP_PLACE]: place, [SOURCE]: source, [WRITTEN]: whole } });
      return;
    }
    const html = await res.text();
    signal.throwIfAborted();
    if (deferWholeRead(whole && again)) return;
    // Read again with nothing new (the write has not landed yet): the page stays as it is, with
    // what the user typed and its live streams.
    if (again && !whole && html === swapped) {
      readAgainLater();
      return;
    }
    // A page loaded in full instead announces the notice once it has loaded. A read again's is the
    // one the page drew already.
    const stay = again || place !== undefined;
    const swappedIn = whole
      ? await swapDocument(html, signal, notice, !!again, stay, false, { through }, drew)
      : await swapPage(html, signal, stay, notice, null, undefined, undefined, drew);
    if (swappedIn && !again) announce(notice);
  } finally {
    signal.removeEventListener("abort", abandoned);
    idle();
    if (fetching === going) fetching = null;
    done();
  }
}

/**
 * A visit's request headers: `corten: nav` for `<main>` alone, `corten: page` for the whole
 * document (rendered as a full load's, but a redirect to a place or another site is named in
 * `corten-location`, which `fetch` cannot follow with its `#id`), and on a read again the notice
 * the page on screen drew ({@link shown}), with the page it is for.
 * @param {boolean} whole @param {boolean | undefined} again @returns {Record<string, string>}
 */
function readHeaders(whole, again) {
  /** @type {Record<string, string>} */
  const headers = { corten: whole ? "page" : "nav" };
  if (again && shown !== null) headers[NOTICE] = new URLSearchParams({ p: location.pathname, m: shown }).toString();
  return headers;
}

/** The visit that last marked each element busy. @type {WeakMap<Element, object>} */
const busyBy = new WeakMap();

/** The last page `visit` swapped in, as the server sent it. */
let swapped = "";
/**
 * The notice that page drew (a write's, `req.notice()`), sent back when it reads itself again so
 * the server draws it the same: the read is not taken for a change, and the notice stays until the
 * user moves on. Null when it drew none.
 * @type {string | null}
 */
let shown = null;
/** The last page serialized by `swapDocument`, or empty after a partial draw. */
let swappedWhole = "";

/** Bumped by each page, so a read-again timer of an earlier one does nothing. */
let readAgainPage = 0;
const READ_AGAIN = Symbol("corten.readAgain");

/**
 * When this page's head asks for it (`<noscript data-corten-read-again="2">`, written by
 * `ReadAgain`), reads the page again after that many seconds, once the tab is visible:
 * the address as it is then, in place of this history entry, keeping scroll and focus, so a query
 * a script put in it (`history.replaceState`, as corten-ui's `rows::sort` does) is read too. A
 * navigation to another history entry (or a page that no longer asks) stops it, and one on its
 * way puts it off: the page it brings starts its own. A page that also asks for parts of it to be read again
 * ({@link readPartsAgain}) is not read whole: its head's tag is for a browser without JavaScript.
 */
function readAgainLater() {
  const page = ++readAgainPage;
  const tag = document.head.querySelector("noscript[data-corten-read-again]");
  const seconds = Number(tag?.getAttribute("data-corten-read-again"));
  if (!(seconds > 0) || document.querySelector(`main ${PART_AGAIN}`)) return;
  // A script's `replaceState` keeps the entry's key, a navigation to another entry does not.
  const entry = navigation?.currentEntry?.key;
  const path = location.pathname;
  readLater(
    seconds,
    () => page === readAgainPage && (navigation ? navigation.currentEntry?.key === entry : location.pathname === path),
    () => {
      if (!navigation) return reload();
      // A read cancelled on its way (a script's `replaceState`, as a sort in place does) is read
      // again later while this is still the entry: only a swapped page starts the next. A read
      // that failed stops them, as before.
      go(location.href, { history: "replace", info: { [READ_AGAIN]: true } }).catch((/** @type {unknown} */ error) => {
        const cancelled = error instanceof DOMException && error.name === "AbortError";
        if (cancelled && page === readAgainPage && navigation.currentEntry?.key === entry) readAgainLater();
      });
    },
  );
}

/**
 * Calls `read` after `seconds` while `wanted()`, once the tab is visible and no form's answer or
 * navigation is on its way (it will change the page: read after it).
 * @param {number} seconds @param {() => boolean} wanted @param {() => unknown} read
 */
function readLater(seconds, wanted, read) {
  const wait = () => {
    if (!wanted()) return;
    if (document.hidden) document.addEventListener("visibilitychange", wait, { once: true });
    else if (submits.size || navigation?.transition) setTimeout(wait, seconds * 1000);
    else read();
  };
  setTimeout(wait, seconds * 1000);
}

/**
 * What the runtime's own navigations carry in `info` ({@link go}), under keys only this module has.
 * @typedef {{ [REDIRECTED]?: Response, [KEEP_PLACE]?: ReturnType<typeof placeOf>, [LOAD]?: boolean, [SOURCE]?: Element | null, [WRITTEN]?: boolean, [READ_AGAIN]?: boolean }} Info
 * @typedef {Omit<NavigateEvent, "info"> & { readonly info: Info | undefined }} RuntimeNavigateEvent
 */
// The Navigation API, where the browser has it.
const navigation = /** @type {Navigation | undefined} */ (window.navigation);
/**
 * The history entry on screen as the runtime knows it: its key where the Navigation API is (another
 * after a link, an `#id` or a script's `pushState`; the same after a `replaceState`), else its
 * address, which is all a page has of its entry without the API.
 */
const where = () => (navigation ? navigation.currentEntry?.key : location.href);
let entrySeen = where();
/**
 * How many times the entry on screen was seen to change, or the runtime began a visit: a count
 * that only goes up ({@link entry}).
 */
let moves = 0;
/**
 * Without the Navigation API, whether the runtime counted a change of the address in this task
 * ({@link look}): as a press a page's `popstate` listener heard before the runtime's makes does.
 */
let counted = false;
/**
 * Looks at the entry on screen: as a press reads it, as its answer draws, and on every move the
 * browser says it made (`currententrychange`, else `popstate`), so a move there and back is counted
 * twice. The entry has changed before the browser says so to any page's listener, so a press made
 * in a listener heard before the runtime's is counted on the entry it is made on.
 */
const look = () => {
  if (where() === entrySeen) return;
  entrySeen = where();
  moves += 1;
  if (!navigation) (counted = true), setTimeout(() => (counted = false));
};
/**
 * How many times the Navigation API said another entry took the screen or the entry was replaced:
 * not a change of its state alone (`updateCurrentEntry`, whose `navigationType` is null), which
 * keeps the entry and is counted on its own ({@link writes}). The last one's `navigationType` is
 * {@link changed}.
 */
let changes = 0;
/**
 * How many times the Navigation API said only an entry's state changed ({@link changes}), by the
 * entry it was put in: the one on screen as the browser says so, which a `navigate` listener's
 * write before a replace commits leaves the replaced entry's, and a `currententrychange` listener's
 * as the replace runs puts on the entry it made, whichever listener the browser told first.
 * @type {WeakMap<NavigationHistoryEntry, number>}
 */
const writes = new WeakMap();
/** How many states were put in `at` ({@link writes}). @param {NavigationHistoryEntry | null | undefined} at */
const written = (at) => (at && writes.get(at)) || 0;
/** The `navigationType` of the last change {@link changes} counted. @type {NavigationType | undefined} */
let changed;
navigation
  ? navigation.addEventListener("currententrychange", (event) => {
      const at = navigation.currentEntry;
      event.navigationType === null ? at && writes.set(at, written(at) + 1) : ((changes += 1), (changed = event.navigationType));
      look();
    })
  : // Every `popstate` the browser fires is a move, its address changed or not (Back between two
    // entries of one address, each with a null state), counted once: not again where its change of
    // address was counted in this task, as a press in a listener heard before the runtime's counts it.
    // Where the address did not change, a press that listener made saw no move, though the browser
    // had moved before it fired the event: one made since then (at or after the event's time) is on
    // the entry the move reached, and is counted with it.
    addEventListener("popstate", (event) => {
      if (!event.isTrusted) return;
      look();
      if (counted) return void (counted = false);
      moves += 1;
      for (const press of presses.values()) if (press.at === moves - 1 && /** @type {number} */ (press.t) >= event.timeStamp) press.at = moves;
    });
/**
 * The history entry on screen and the page on it, by the moves since the page loaded
 * ({@link moves}). A page drawn in place on the entry (a form's answer, the page reading itself
 * again) and a navigation that is cancelled leave it.
 */
const entry = () => (look(), moves);
/**
 * The entry on screen exactly: its id where the Navigation API is, another after any replace of it
 * (a script's `replaceState`, a navigation that replaces, a marked answer's own, each keeping the
 * key), else its address and state, all a page has of it without. A press of a marked form keeps
 * it, and its answer puts its address in only while the entry is still exactly that one
 * ({@link unreplaced}).
 */
const exact = () => (navigation ? [navigation.currentEntry?.id] : [location.href, history.state]);
/**
 * Whether two readings of the entry ({@link exact}) are of exactly the same one, each part the
 * same as `Object.is` compares it (a `NaN` state is itself).
 * @param {unknown[] | undefined} a @param {unknown[] | undefined} b
 */
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
/**
 * Whether the entry on screen is exactly the one `seen` ({@link exact}) was taken on.
 * @param {unknown[] | undefined} seen
 */
const unreplaced = (seen) => same(seen, exact());
/**
 * A marked answer's draw, which a press made by it keeps ({@link drawingFor}): the entry the
 * answer's own replace found and the one it left ({@link exact}), set only where nothing else
 * changed the entry inside that `replaceState`. A plain object, so a press keeps neither the
 * answer nor the press it answered, and a chain of presses each made by the last one's draw keeps
 * no answer that has settled.
 * @typedef {{ found?: unknown[], left?: unknown[] }} Draw
 */
/**
 * The draw of the marked answer drawing now, by the call that puts its address in ({@link apply},
 * {@link swapPage}): a press made by what it draws (a `connectedCallback` that presses the form it
 * drew) is taken in that draw, before the address goes in, and keeps it ({@link Press}).
 * @type {Draw | null}
 */
let drawingFor = null;
/** Each marked answer's draw, by the call that puts its address in ({@link send}). @type {WeakMap<() => void, Draw>} */
const draws = new WeakMap();
/**
 * Whether a press's answer may put its address in the entry on screen: the entry is exactly the
 * one the press was made on, or the press was made by the draw of a marked answer (`by`) on the
 * entry that answer's own replace found, and the entry is exactly the one that replace left. Any
 * other replace since the press leaves the address ({@link send}).
 * @param {Press | undefined} press
 */
const onEntry = (press) => {
  const by = press?.by;
  return unreplaced(press?.seen) || (!!by?.left && same(press?.seen, by.found) && unreplaced(by.left));
};
/** Key of the response a redirected navigation hands to the next one, in its `info`. */
const REDIRECTED = Symbol("corten.redirected");
/** Key of the place a `data-keep-place` navigation hands to the one a redirect starts. */
const KEEP_PLACE = Symbol("corten.keepPlace");
/**
 * Key of a navigation the server sent the browser on (after a write): its page is fetched even
 * when only the `#id` differs from the address, since the write may have changed the page.
 */
const LOAD = Symbol("corten.load");
/** What started a navigation the server redirected, or a write's answer sent on: still marked busy. */
const SOURCE = Symbol("corten.source");
/**
 * Key of the navigation a write sent the browser on: its page is fetched whole, as a full load
 * would, so what the write changed in the layout around `<main>` (a count in the header) is drawn
 * again too ({@link swapDocument}).
 */
const WRITTEN = Symbol("corten.written");
/**
 * The writes that may change what the layout draws, numbered in the order their outcome came: one
 * that redirected, answered with its own page whole or with a patch that took it, one a navigation
 * cut off once it was sent, and one that failed where the page says so (the network failed, a 5xx,
 * an answer cut off on its way), each of which the server may have applied.
 */
let writesIn = 0;
/**
 * Those whose change no whole page's layout has drawn yet: the user went elsewhere before its page
 * came, its frame differed, its outcome is not known, its patch is not in yet, or a page made before
 * it was drawn after it (over what its patch drew).
 * While any is, a navigation reads the whole page, so what each write changed in the layout is
 * drawn.
 * @type {Set<number>}
 */
const undrawn = new Set();
/**
 * Which writes failed where the page says so: while one is undrawn, a same-page read does not
 * replace the whole layout. A number stays here (a few bytes a failed write), since a page drawn
 * late can make it undrawn again.
 * @type {Set<number>}
 */
const failedInView = new Set();
/** Whether a write that failed in view is undrawn: the page reading itself leaves the layout as it is. */
function failedUndrawn() {
  for (const n of undrawn) if (failedInView.has(n)) return true;
  return false;
}
/** A write can fail while a whole poll waits for its answer or assets. Retry as a partial read. @param {boolean} [wholePoll] */
function deferWholeRead(wholePoll) {
  if (!wholePoll || !failedUndrawn()) return false;
  readAgainLater();
  return true;
}
/**
 * A write that failed where the page says so, which the server may have applied: undrawn, for the
 * next navigation to another page. Reuse its number if another page has drawn since its headers.
 * @param {number} [n]
 */
function failedWrite(n = ++writesIn) {
  failedInView.add(n);
  undrawn.add(n);
  return n;
}
/**
 * What a whole page's layout draws: every write answered before it was asked for (`through`, the
 * count of them then), and the write it answers, for a write's own page (`write`). A write
 * answered while it was on its way may not be in it.
 * @typedef {{ through: number, write?: number }} Covers
 */
/**
 * A whole page's layout is drawn: the writes it `covers` are, and every other write answered since
 * it was asked for is undrawn again, though a page drawn before this one drew it: this layout,
 * drawn last, may be older than what that write changed.
 * @param {Covers} covers
 */
function drew({ through, write }) {
  for (const n of undrawn) if (n <= through || n === write) undrawn.delete(n);
  for (let n = through + 1; n <= writesIn; n++) if (n !== write) undrawn.add(n);
}
/**
 * The count of writes answered when each page a redirect handed on was asked for. A key in the
 * navigation's `info` would do as well, and costs a few bytes more.
 * @type {WeakMap<Response, number>}
 */
const askedAfter = new WeakMap();

/**
 * Whether the first document has fired `load`. Before it, a navigation is the browser's own (a
 * full load): a script's form submit (one made from on:connect) makes Chromium stop loading the
 * document before `navigate` fires, so `readyState` reads "complete" but `load` never comes, and
 * a page taken over then would never load.
 */
let loaded = document.readyState === "complete";
if (!loaded) addEventListener("load", () => (loaded = true), { once: true });

/**
 * How, where and in what encoding `form` goes when `submitter` sends it, read as the browser
 * reads them: the button's `formmethod`, `formaction` and `formenctype` when it has them (an
 * invalid method is "get", an empty action the document's address), else the form's. Lowercase
 * method, absolute action. `target` is not read: a `data-patch` answer patches this page.
 * @param {HTMLFormElement} form
 * @param {Element | null | undefined} submitter
 */
function sendsAs(form, submitter) {
  const button = submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement ? submitter : null;
  return {
    method: button?.hasAttribute("formmethod") ? button.formMethod : formProperty(form, "method"),
    action: button?.hasAttribute("formaction") ? button.formAction : formProperty(form, "action"),
    enctype: button?.hasAttribute("formenctype") ? button.formEnctype : formProperty(form, "enctype"),
  };
}

/**
 * What started a navigation, if anything: a link, a form, or the button that sent one.
 * @param {RuntimeNavigateEvent} event
 */
function startedBy(event) {
  const el = event.info?.[SOURCE] ?? event.sourceElement;
  return el instanceof Element ? el : null;
}

/**
 * Whether a navigation is a form sent by POST, which the browser sends itself. Chromium names
 * the submit button as the source but sets `formData` from the form's own method, so a POST
 * button in a GET form has none (#190); Firefox names the form there, and its `formData`
 * follows the button.
 * @param {NavigateEvent} event
 */
function posts(event) {
  const button = event.sourceElement;
  if (!(button instanceof HTMLButtonElement || button instanceof HTMLInputElement) || !(button.form instanceof HTMLFormElement)) return !!event.formData;
  return sendsAs(button.form, button).method === "post";
}

/**
 * Whether the element a navigation came from (a link, a button, or the form, when no button sent
 * it) is in `selector`, read past a control named `closest`.
 * @param {{ sourceElement: Element | null }} event @param {string} selector
 */
const sourceIn = (event, selector) => event.sourceElement instanceof Element && !!closestOf(event.sourceElement, selector);

/**
 * The element a page's `#fragment` names, found as HTML finds the one a full load scrolls to: an
 * id, else an `<a name>`, as written, then percent-decoded. Decoded as HTML does, never throwing: a
 * `%` without two hex digits stays as written, and bytes that are not UTF-8 read as U+FFFD.
 * @param {string} fragment an address's, which is ASCII: the URL parser escapes every other character
 */
function fragmentOf(fragment) {
  const find = (/** @type {string} */ name) =>
    name ? (document.getElementById(name) ?? Array.from(document.getElementsByName(name)).find((el) => localNameOf(el) === "a")) : undefined;
  // One character per byte: each escape's, and each ASCII character's own.
  const bytes = fragment.replace(/%([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return find(fragment) ?? find(new TextDecoder(undefined, { ignoreBOM: true }).decode(Uint8Array.from(bytes, (c) => c.charCodeAt(0))));
}

// Only this module has these symbol keys; another script's info has none of them.
navigation?.addEventListener("navigate", (/** @type {RuntimeNavigateEvent} */ event) => {
  // One another script dispatches is no navigation.
  if (!event.isTrusted) return;
  // A script's history.pushState or replaceState (a tab that puts itself in the address) is the
  // page's own: nothing to fetch. Back and forward between pages this runtime swapped are
  // same-document traversals too, and do need the page.
  const skip =
    !event.canIntercept ||
    // Aborted as it is heard: a listener heard before the runtime's began another navigation.
    event.signal.aborted ||
    !loaded ||
    // A navigation the server sent, or the page reading itself again, is fetched even when only
    // the `#id` differs from the address, or nothing does.
    (!event.info?.[LOAD] && !event.info?.[READ_AGAIN] && (event.hashChange || (event.destination.sameDocument && event.navigationType !== "traverse"))) ||
    event.downloadRequest !== null ||
    posts(event) ||
    event.navigationType === "reload" ||
    sourceIn(event, "[data-reload]");
  if (skip) return;
  const url = new URL(event.destination.url);
  const again = event.info?.[READ_AGAIN];
  // The dwell of the link followed ends: the server may answer with another page (a redirect),
  // which a prefetch of the link would fetch again. A read again leaves a dwell over another link.
  if (!again) clearTimeout(hoverTimer);
  const redirected = event.info?.[REDIRECTED];
  // A write this navigation cuts off before its answer came: the server may have applied it, so
  // the page is read whole, as after a write whose page is not drawn yet. It is numbered after
  // `through`: the server may still be running it as this page is read, so it stays undrawn once
  // the page is drawn, for the next navigation to read whole again. One whose answer came is in the
  // record already (a patch not in yet is undrawn), numbered before the page is asked for.
  // The writes answered before the page is asked for, which its layout draws.
  const through = redirected ? (askedAfter.get(redirected) ?? 0) : writesIn;
  let cut = false;
  if (!again && submits.size) {
    for (const pending of submits.values()) {
      if (!pending.write || pending.answered) continue;
      cut = true;
      if (pending.went) undrawn.add(++writesIn);
    }
    // Replies would patch the wrong page. Record every cut-off before aborting any of them.
    for (const pending of submits.values()) pending.controller.abort();
  }
  // A whole draw can replace the layout's failure UI. Leave it to another page, even if another
  // write is undrawn or the last whole page asked to be read again while its write lands.
  const written = !!event.info?.[WRITTEN] ||
    ((undrawn.size > 0 || cut || (!!again && swappedWhole !== "")) &&
      !((again || pageKey(url) === pageKey(new URL(location.href))) && failedUndrawn()));
  // The same page read again, or a form or link marked `data-keep-place` (filters applied as they
  // change): the page changes under the user, who stays where they were reading, on the control
  // they used. Kept across a redirect the server answers with.
  const place = again || sourceIn(event, "[data-keep-place]") ? placeOf(document.activeElement) : event.info?.[KEEP_PLACE];
  if (place === undefined) {
    // Back and forward: the browser puts the user back where they were on that entry.
    if (event.navigationType === "traverse") {
      event.intercept({ handler: () => visit(url, event.signal, redirected, false, undefined, undefined, written, through) });
      return;
    }
    // A new page starts at its `#id`, else at the top, by the browser's own scroll to the fragment
    // (`scroll()`), as a full load does: it makes the element `:target`, finds an `<a name>` too,
    // moves focus to it when it can take focus, and reads the address the navigation committed (a
    // redirect's). Focus is then the Navigation API's to reset, as for any navigation. Called here
    // once the page is swapped in (`scroll: "manual"`), so what it did can be checked after it:
    // Firefox's may neither scroll there nor set `:target` (as after a document's first fragment
    // scroll, a full load's included), may scroll to the top instead, or keeps an element the swap
    // left in place (outside `<main>`) as the target without scrolling to it again, so a changed
    // position does not show where it went. Only a focus in it or a `:target` it set does; else the
    // element is scrolled to here. A `focus` event, heard on the window before the element's own
    // handlers (which may blur it again, so that no `focusin` follows), or another focused element
    // after it, shows a focus whatever the page did next. Then the page's own code ran in it, and
    // what it did stands: a scroll or a focus of its own, or a change to the address, which ends
    // this navigation (its fragment is read before). `scroll()` may throw (a handler of the page's
    // called it first), and the listener goes either way.
    const after = () => {
      if (event.signal.aborted) return;
      const fragment = location.hash.slice(1);
      const [was, focused] = [document.querySelector(":target"), document.activeElement];
      let moved = false;
      const move = () => (moved = true);
      addEventListener("focus", move, true);
      try {
        event.scroll();
      } finally {
        removeEventListener("focus", move, true);
      }
      if (event.signal.aborted || !fragment || moved || focused !== document.activeElement) return;
      const at = fragmentOf(fragment);
      if (at && (at === was || document.querySelector(":target") !== at)) elementOwn.scrollIntoView.call(at);
    };
    interceptVisit(event, (precommit) => visit(url, event.signal, redirected, false, undefined, startedBy(event), written, through, precommit), after, { scroll: "manual" });
    return;
  }
  const after = () => {
    // Back to the control, unless the user has moved on meanwhile.
    const now = document.activeElement;
    const el = place && (!now || now === document.body) ? placeAt(place) : undefined;
    if (!el || !place) return;
    focusOn(el);
    // One that cannot take focus (disabled, hidden, inert) did not: no other control is tried.
    if (document.activeElement !== el) return;
    try {
      const [start, end, direction] = place.caret;
      if (start !== null && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) el.setSelectionRange(start, end, direction);
    } catch {}
  };
  const visiting = (/** @type {Precommit | undefined} */ precommit) => visit(url, event.signal, redirected, again, place, startedBy(event), written, through, precommit);
  // A page reading itself again keeps its address: nothing to wait for.
  interceptVisit(event, visiting, after, { scroll: "manual", focusReset: "manual" }, !again);
});

/**
 * The runtime's own navigation (a redirect followed, a `corten-location`, a write's page):
 * `navigation.navigate`, with its `committed` promise handled, since one that another navigation
 * replaces before its address changes (the user clicks on while the page is on its way) rejects
 * it, which the browser would log as uncaught. Returns `finished`, for the caller that wants to know how it ended.
 * @param {string} url
 * @param {{ history?: "push" | "replace", info?: Info }} options
 * @returns {Promise<unknown>}
 */
function go(url, options) {
  // Called only where the browser has the Navigation API.
  // navigate() returns both promises; lib.dom models the Web IDL dictionary's fields as optional.
  const { committed, finished } = /** @type {Required<NavigationResult>} */ (/** @type {NonNullable<typeof navigation>} */ (navigation).navigate(url, options));
  committed.catch(() => {});
  return finished;
}

/** Whether the browser lets a navigation say when its address changes (`precommitHandler`). */
const PRECOMMIT = "NavigationPrecommitController" in window;

/**
 * A navigation whose address waits for its answer: `commit` changes the address once the answer
 * is in (none when there is none), to the redirect's target when the server redirected, and is
 * true when it took that target; `history` is how the navigation enters history, for the one
 * that takes its place before it commits (a `corten-location`).
 * @typedef {{ commit(res?: Response): Promise<boolean>, history: "push" | "replace" }} Precommit
 */

/**
 * Intercepts `event` with `run`, a visit, and then `after`. Where the browser lets it
 * (`precommitHandler`), the address waits for the page's answer, as a full load's does: it changes
 * when the answer is in, to the redirect's target when the server redirected (one entry, never the
 * link's), so reloading, copying or sharing the address during a slow handler gets the page on
 * screen (#992). A `corten-location` answer is followed before the address changes, by a
 * navigation that takes this one's place in history (`Precommit.history`), so the link's address
 * never shows. `main` is busy from the click either way. Elsewhere, and for back and forward, the
 * address changes at once, as before.
 * @param {NavigateEvent} event
 * @param {(precommit: Precommit | undefined) => Promise<void>} run
 * @param {() => void} after
 * @param {NavigationInterceptOptions} options
 * @param {boolean} [early] whether the address may wait for the answer (not a page read again)
 */
function interceptVisit(event, run, after, options, early = true) {
  if (!early || !PRECOMMIT || !event.cancelable || event.navigationType === "traverse") {
    event.intercept({ ...options, handler: () => run(undefined).then(after) });
    return;
  }
  /** @type {() => void} */
  let committed = () => {};
  // The commit's handler runs once the address is the page's; an abandoned navigation never gets
  // there, so its abort lets the visit stop waiting.
  const ready = new Promise((resolve) => {
    committed = () => resolve(undefined);
    event.signal.addEventListener("abort", committed, { once: true });
  });
  /** @type {Promise<void>} */
  let visiting = Promise.resolve();
  event.intercept({
    ...options,
    precommitHandler: (controller) =>
      new Promise((answered, failed) => {
        const commit = async (/** @type {Response | undefined} */ res) => {
          let took = false;
          if (res?.redirected) {
            // `fetch` drops the `#id`; a full load's redirect keeps the link's when it names none.
            const to = new URL(res.url);
            to.hash ||= new URL(event.destination.url).hash;
            try {
              controller.redirect(to.href);
              took = true;
            } catch {
              // Not one the address can take (another origin): navigated to again, as before.
            }
          }
          answered(undefined);
          await ready;
          return took;
        };
        visiting = run({ commit, history: event.navigationType === "replace" ? "replace" : "push" });
        // A visit that ends before its answer (a full load) lets the navigation end too. One left
        // for another (back, or a second link) ends quietly: the browser does not handle a
        // precommit handler's failure once its navigation is aborted, and would log it.
        visiting.then(answered, (error) => (event.signal.aborted ? answered(undefined) : failed(error)));
      }),
    handler: () => {
      committed();
      return visiting.then(after);
    },
  });
}

/**
 * What the user typed or chose in the page of each history entry they left, by the entry's key:
 * the fields of `<main>` whose state is not the markup's, each as a selector that finds it in the
 * page drawn again (by id, else by name, and which of those it is), its state (`stateOf`) and
 * how the markup drew it. Back or forward to the entry puts each back, as the browser does for a
 * page it loaded, into the field found there only when the server draws it as it did, so a list
 * whose rows moved or a select whose options changed keeps what the server draws. As the browser
 * does, never a password, a file or a field with `autocomplete="off"` (its own or its form's), and
 * never a hidden input or a submit key. Forgotten when the browser drops the entry.
 * @type {Map<string, Typed[]>}
 */
const typedIn = new Map();

/**
 * A field the user typed in: its selector, the id or name in it, which of the selector's fields it
 * is, its state and how the markup drew it (`fieldDrawn`).
 * @typedef {[at: string, key: string, nth: number, state: string, drawn: string]} Typed
 */

/** The key of the history entry whose page `<main>` shows. */
let drawnFor = navigation?.currentEntry?.key ?? "";
/**
 * The address (`pageKey`) of the page `<main>` shows, as the last navigation drew it or a script
 * put it in the address since, and how many times a navigation changed it.
 */
let shownAt = pageKey(new URL(location.href));
let turns = 0;
// An entry the runtime did not go to (a link to a fragment, a script's `pushState` or
// `replaceState`, as a sort in place does) shows the page that was there, at that address: a read
// of it again is not a turn.
navigation?.addEventListener("currententrychange", () => {
  if (!navigation?.transition) (drawnFor = navigation?.currentEntry?.key ?? drawnFor), (shownAt = pageKey(new URL(location.href)));
});

/**
 * The fields an `input` or `change` was seen on (the user's, or one a script dispatched) since
 * `<main>` was drawn, and those the runtime gave the user's state back to: the only ones
 * `remember` reads, so leaving a page of many fields costs nothing for those left as drawn. A
 * value a script sets fires neither unless the script dispatches them.
 * @type {Set<Element>}
 */
const typedFields = new Set();
for (const type of ["input", "change"])
  document.addEventListener(type, (event) => event.target instanceof Element && typedFields.add(event.target), { capture: true, passive: true });

/**
 * A field whose state the browser does not keep for its history entry: a password, a file, one with
 * `autocomplete="off"` (its own or its form's), or a submit key.
 * @param {Element} f
 */
function unkept(f) {
  const field = /** @type {HTMLInputElement} */ (f);
  const form = field.form;
  const auto = f.getAttribute("autocomplete")?.trim() || (form && attrOf(form, "autocomplete")?.trim());
  return /^(password|file)$/.test(field.type) || f.hasAttribute("data-submit") || auto?.toLowerCase() === "off";
}

/**
 * How the markup drew a field: its element and type, its state as drawn, a select's options and a
 * checkbox's or radio's value.
 * @param {Element} f
 */
const fieldDrawn = (f) => {
  const field = /** @type {HTMLInputElement} */ (f);
  const more = f instanceof HTMLSelectElement ? Array.from(f.options, (o) => `\0${o.value}`).join("") : /^(checkbox|radio)$/.test(field.type) ? `\0${field.value}` : "";
  return `${localNameOf(f)}\0${field.type}\0${stateOf(f, true)}${more}`;
};

/**
 * Records what the user typed in `main`, the page of the entry `key`, which they are leaving
 * (`typedIn`).
 * @param {string} key @param {Element} main
 */
function remember(key, main) {
  /** @type {[Element, string, string, string][]} */
  const fields = [];
  for (const f of typedFields) {
    // Through matchesOf: `f` is any target of an input or change event, a form among them.
    if (!matchesOf(f, "input, textarea, select") || !main.contains(f) || unkept(f)) continue;
    const now = stateOf(f);
    const name = f.getAttribute("name");
    const at = f.id ? `#${CSS.escape(f.id)}` : name ? named(f, name) : "";
    if (now === undefined || now === stateOf(f, true) || !at) continue;
    fields.push([f, at, f.id || /** @type {string} */ (name), now]);
  }
  const found = fieldsAt(main, new Map(fields.map(([, at, key]) => [at, key])));
  /** @type {Typed[]} */
  const typed = fields.map(([f, at, key, now]) => [at, key, /** @type {Element[]} */ (found.get(at)).indexOf(f), now, fieldDrawn(f)]);
  // The entry as it is now: a replace since the page was drawn made a new one with the same key.
  const entry = navigation?.entries().find((e) => e.key === key);
  if (!typed.length || !entry) return void typedIn.delete(key);
  typedIn.set(key, typed);
  entry.addEventListener("dispose", forget);
}

/** @param {Event} event the dispose of an entry `typedIn` has */
function forget(event) {
  const key = /** @type {NavigationHistoryEntry} */ (event.target).key;
  // A replace disposes the entry it replaces and gives the new one its key.
  const entry = navigation?.entries().find((e) => e.key === key);
  if (entry) entry.addEventListener("dispose", forget);
  else typedIn.delete(key);
}

/**
 * Puts what the user typed (`typedIn`) into the fields of a page drawn again, before it joins.
 * @param {ParentNode} content @param {Typed[]} typed
 */
function putTyped(content, typed) {
  const found = fieldsAt(content, new Map(typed.map(([at, key]) => [at, key])));
  for (const [at, , nth, state, drawn] of typed) {
    const f = found.get(at)?.[nth];
    if (!f || unkept(f) || fieldDrawn(f) !== drawn) continue;
    if (f instanceof HTMLSelectElement) Array.from(f.options, (o, i) => (o.selected = state[i] === "1"));
    else if (/^(checkbox|radio)$/.test(/** @type {HTMLInputElement} */ (f).type)) /** @type {HTMLInputElement} */ (f).checked = state === "true";
    else /** @type {HTMLInputElement} */ (f).value = state;
    typedFields.add(f);
  }
}

/**
 * The fields of `root` each selector of `wanted` (`#id` or `named`, to the id or name in it) finds,
 * in the page's order: a query each for a few, one walk of the fields for many, so leaving or
 * drawing again a page where many fields were typed reads it once, making a selector only for a
 * field whose id or name one of them has.
 * @param {ParentNode} root @param {Map<string, string>} wanted @returns {Map<string, Element[]>}
 */
function fieldsAt(root, wanted) {
  /** @type {Map<string, Element[]>} */
  const found = new Map();
  if (wanted.size <= 64) {
    for (const at of wanted.keys()) found.set(at, Array.from(root.querySelectorAll(at)).filter((el) => matchesOf(el, "input, textarea, select")));
    return found;
  }
  const ids = new Set();
  const names = new Set();
  for (const [at, key] of wanted) {
    found.set(at, []);
    (at[0] === "#" ? ids : names).add(key);
  }
  for (const el of root.querySelectorAll("input, textarea, select")) {
    const name = el.getAttribute("name");
    if (ids.has(el.id)) found.get(`#${CSS.escape(el.id)}`)?.push(el);
    if (name && names.has(name)) found.get(named(el, name))?.push(el);
  }
  return found;
}

/**
 * The control that has focus, as a selector that finds it again in a swapped page (by id, else by
 * its name inside the nearest ancestor with an id (else <main>), and which control with that name
 * it is, counting those that cannot take focus now but not inputs of type hidden), the same in
 * <main> for when nothing under that ancestor matches any more, and its caret. Null when nothing
 * is focused.
 * @param {Element | null} el
 * @returns {{ at: string, nth: number, main: string, mainNth: number, caret: [number | null, number | null, "forward" | "backward" | "none" | undefined] } | null}
 */
function placeOf(el) {
  const name = el && attrOf(el, "name");
  const id = el && idOf(el);
  const root = el && closestOf(el, "main");
  const anchor = !id && name && root && el && idOf(anchorOf(root, el));
  const control = name && el ? `${named(el, name)}:not([type=hidden i])` : "";
  const main = !id && control ? `main ${control}` : "";
  const at = id ? `#${CSS.escape(id)}` : anchor ? `#${CSS.escape(anchor)} ${control}` : main;
  if (!at) return null;
  const f = el;
  /** @type {[number | null, number | null, "forward" | "backward" | "none" | undefined]} */
  let caret = [null, null, undefined];
  try {
    if (f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement) caret = [f.selectionStart, f.selectionEnd, f.selectionDirection ?? undefined];
  } catch {}
  const nth = (/** @type {string} */ selector) => Array.prototype.indexOf.call(document.querySelectorAll(selector), el);
  return { at, nth: nth(at), main, mainNth: main ? nth(main) : -1, caret };
}

/**
 * The same control, at its index among the matches under its ancestor (none when fewer are left).
 * Only when nothing there matches (the ancestor is gone, or every match in it) is it looked for in
 * <main>, by its index there.
 * @param {NonNullable<ReturnType<typeof placeOf>>} place
 */
function placeAt(place) {
  const at = document.querySelectorAll(place.at);
  return at.length || !place.main ? at[place.nth] : document.querySelectorAll(place.main)[place.mainNth];
}

/** The nearest ancestor with an id, bounded by `root`. @param {Element} root @param {Element} el */
function anchorOf(root, el) {
  let anchor = el;
  while (anchor !== root) {
    anchor = /** @type {Element} */ (parentElementOf(anchor));
    if (idOf(anchor)) break;
  }
  return anchor;
}

/**
 * The selector of the controls named `name` like `el` (with its value attribute, for a checkbox
 * or radio: one without it has the value "on" but does not match `[value="on"]`).
 * @param {Element} el @param {string} name
 */
function named(el, name) {
  const value = attrOf(el, "value");
  const choice = /^(checkbox|radio)$/.test(attrOf(el, "type") ?? "") ? (value === null ? ":not([value])" : `[value="${CSS.escape(value)}"]`) : "";
  return `${localNameOf(el)}[name="${CSS.escape(name)}"]${choice}`;
}
/**
 * How many times the page began to be left (the runtime reloads it, or the browser hides it for a
 * full navigation): a submit that waited for a write is sent only if the count is the one it had
 * when the write went out. A count, not a flag, so a reload the user cancels (an app's
 * `beforeunload` prompt) drops only the submits waiting then, not every later one.
 */
let left = 0;
/**
 * Loads the page again from the server, with the notice of the answer it takes the place of: kept
 * for that page's load, for as long as its cookie would have lasted (not one a read again sent
 * back, which the user has seen).
 * @param {Notice} [notice]
 */
function reload(notice = null) {
  left += 1;
  if (notice && !notice.has("r")) {
    try {
      sessionStorage.setItem(NOTICE, JSON.stringify([location.pathname, notice.get("m"), Date.now() + 60000]));
    } catch {
      // No session storage (a sandboxed frame): the page loads without it.
    }
  }
  location.reload();
}
addEventListener("pagehide", () => (left += 1));

/**
 * The pending submit of each `data-patch` form. The same submit again while it is pending (a
 * double click) is ignored rather than sent twice. A newer submit aborts a pending read (a GET,
 * whose old answer is worth nothing). It does not abort a write: the server may have applied it,
 * and its answer is the page's next state. The newer submit waits (`next`; several become the
 * latest) and is sent once the write's answer is drawn, with the form's values as they are then,
 * so a version or a count the answer wrote goes out with it. Only after a 2xx (a bare 204 or 205
 * too) or a 422: a refusal of the form's state (409, 410), a 5xx, another answer the runtime does
 * not draw, a redirect, a reload or no answer at all drops it. A navigation aborts them all, so a
 * late reply never patches a page it was not meant for. A read is also dropped by a newer press of
 * the form drawn in its place ({@link pressed}).
 * @type {Map<HTMLFormElement, { key: string, controller: AbortController, write: boolean, went: boolean, answered: boolean, n: number, next?: HTMLElement | null, nextWithin?: Set<string>, nextPress?: Press | null, here?: Press, mine: object, busy: HTMLElement[], by: HTMLElement | null | undefined }>}
 */
const submits = new Map();
/** The forms that have sent a submit ({@link sayFailed}). @type {WeakSet<HTMLFormElement>} */
const sentFrom = new WeakSet();

/**
 * The latest press of a form of each id ({@link pressed}), kept only until it settles: its submit
 * has ended, or it is let go unsent ({@link settled}). An older press of the id is never the one
 * kept, so a newer press drops it whether or not that one has settled.
 * @type {Map<string, Press>}
 */
const presses = new Map();

/**
 * The navigation a page's `navigate` listener holds the runtime's own replace in before its address
 * goes in (`precommitHandler`), or one it began in that replace's place: while the browser shows it
 * on its way ({@link holding}), a marked press is for the page it may yet change, and is taken as
 * one made while a visit is on its way ({@link pressed}), never sent, and a marked answer already
 * on its way draws nothing ({@link standing}), so nothing is drawn under the address it may put in.
 * @type {NavigationTransition | null | undefined}
 */
let held;

/**
 * The press whose answer's replace is held ({@link held}), set with it: that answer has drawn, and
 * goes on as any drawn answer does.
 * @type {Press | undefined}
 */
let heldFor;

/**
 * Whether the browser still shows the navigation that holds the runtime's replace ({@link held}),
 * for any press but the one whose answer it holds ({@link heldFor}): until that navigation
 * finishes, is aborted or another takes its place, not merely until it commits, so a page's handler
 * that never settles holds it for good.
 * @param {Press} [press]
 */
const holding = (press) => !!held && held === navigation?.transition && press !== heldFor;

/**
 * A press of a form: its id ({@link presses}), and for a `data-address` form with an id the entry
 * it was made on ({@link entry}), null while a visit of the runtime's or a held replace
 * ({@link held}) was on its way, and that entry exactly ({@link exact}), with the draw of the
 * marked answer that made it, if one did ({@link drawingFor}), and when it was made
 * (`performance.now()`), for a move the browser made before
 * it and says so only after it ({@link moves}). A marked form without an id cannot tell its latest
 * press from an older one, and is pressed as an unmarked form is: its answer leaves the address.
 * @typedef {{ id: string | null, at?: number | null, seen?: unknown[], by?: Draw | null, t?: number }} Press
 */

/**
 * Takes a press of `form` by its id, which the form a patch draws in its place keeps, as the
 * runtime takes the submit: after the page's own `submit` listeners, before its `formdata` ones.
 * Whatever it sends, a press fences only a read ({@link standing}), and keeps where it was made for when
 * it is sent again as one (an answer drew its form with another method).
 * @param {HTMLFormElement} form
 * @returns {Press}
 */
function pressed(form) {
  const id = idOf(form);
  const marked = id && hasAttr(form, "data-address");
  const press = marked ? { id, at: reading.size || holding() ? null : entry(), seen: exact(), by: drawingFor, t: performance.now() } : { id };
  if (id) presses.set(id, press);
  return press;
}

/**
 * Lets `press` go once nothing is left to send or draw for it: the latest press of its id is no
 * longer kept, so ids pressed once do not pile up for the page's life ({@link presses}).
 * @param {Press | null | undefined} press
 */
const settled = (press) => void (press?.id && presses.get(press.id) === press && presses.delete(press.id));

/**
 * Whether a read of `press` is still to be sent or drawn: always for one of a form without the
 * mark (or without an id), as before the mark. A `data-address` form's, until it draws, only while
 * it is the latest press of a form with its id (a newer one, of this form or the one drawn in its
 * place, marked or not, drops it wherever it is), not once it is `drawing`, which a press its draw
 * makes (a `connectedCallback`) does not stop; and only on the entry and page it was pressed on
 * and while no visit of the runtime's is on its way, whose navigation its replace would cancel:
 * never one pressed while a visit is on its way, for the page it leaves, or while a page's listener
 * holds the runtime's replace ({@link held}); nor one that would draw while that replace is held,
 * though pressed before (a press the held answer's own draw made), as one that would draw while a
 * visit is on its way does not.
 * @param {Press} press @param {boolean} [drawing]
 */
const standing = (press, drawing) =>
  press.at === undefined || ((drawing || presses.get(/** @type {string} */ (press.id)) === press) && !reading.size && !holding(press) && press.at === entry());

/** The preference (`Prefer`, RFC 7240) by which a submit says this runtime draws a write's own page whole. */
const DRAWS_WHOLE = "corten-draws=whole";

/**
 * A form's entries as the browser sends them in a body that is not multipart, or in a GET's
 * query: a file is its name, and every line break in a name or value is CRLF.
 * @param {FormData} data
 * @returns {[string, string][]}
 */
const sentEntries = (data) => {
  const crlf = (/** @type {string} */ text) => text.replace(/\r\n?|\n/g, "\r\n");
  return Array.from(data, ([name, value]) => [crlf(name), crlf(typeof value === "string" ? value : value.name)]);
};

// On the window, so it runs after every other handler of the submit (an `on:submit` listens on
// the document, and calls it itself when one stops the submit's propagation): one that cancels
// it stops the form, as it would without the runtime.
addEventListener("submit", patchSubmit);
// An empty submit key is filled first of all, in the window's capture phase: every handler of the
// submit, and whatever sends the form, sees the key.
addEventListener("submit", (event) => event.target instanceof HTMLFormElement && fillSubmitKeys(event.target), true);

/** Sends a `data-patch` form's submit as a patch, unless a handler cancelled it. @param {Event} event */
function patchSubmit(event) {
  const form = event.target;
  if (event.defaultPrevented || !(form instanceof HTMLFormElement) || !hasAttr(form, "data-patch")) return;
  const submitter = /** @type {SubmitEvent} */ (event).submitter;
  const sends = sendsAs(form, submitter);
  // A dialog's form closes the dialog and sends nothing: the browser's to do.
  if (sends.method === "dialog") return;
  event.preventDefault();
  send(form, submitter, sends);
}

/**
 * The ids of the dialogs and details the control that sent `form`'s submit is in, read when it is
 * pressed, so its answer knows what it was asked from inside ({@link opened}). The control is the
 * submitter; with none (Enter in a form without a button, a script's `requestSubmit()`), the
 * focused control if it is one of the form's, else the form.
 * @param {HTMLFormElement} form @param {HTMLElement | null | undefined} submitter @returns {Set<string>}
 */
function asking(form, submitter) {
  const focused = document.activeElement;
  const el = submitter ?? (focused && Array.from(formProperty(form, "elements")).includes(focused) ? focused : form);
  const ids = new Set();
  for (let at = closestOf(el, "dialog, details"); at;) {
    const id = attrOf(at, "id");
    if (id) ids.add(id);
    const parent = parentElementOf(at);
    at = parent && closestOf(parent, "dialog, details");
  }
  return ids;
}

/**
 * Sends a `data-patch` form's submit, by `submitter`, as `sends` says (its method, action and
 * encoding).
 * @param {HTMLFormElement} form @param {HTMLElement | null | undefined} submitter @param {ReturnType<typeof sendsAs>} sends
 * @param {Set<string>} [within] where it was pressed ({@link asking}): read now, unless it waited
 *   for a write's answer, which read it at the press
 * @param {Press | null} [press] its press ({@link pressed}): taken now for a new one, kept by one that waited
 */
async function send(form, submitter, sends, within = asking(form, submitter), press = pressed(form)) {
  sentFrom.add(form);
  const turn = turns;
  /** @type {FormData} */
  let data;
  try {
    data = new FormData(form, submitter);
  } catch (error) {
    // A `submit` listener took the button out of the form, or made it no submit button: nothing
    // is sent, and the press is let go with it.
    settled(press);
    throw error;
  }
  // The press fences only a read: a write is never dropped.
  const read = sends.method === "get" ? press : null;
  // The one place a read is let go before it is sent, whether new or sent again after a write:
  // what runs of the page from here to the fetch is the runtime's, so a read that could not draw
  // (a `formdata` listener pressed the form again or moved the page, or a visit is on its way) is
  // not sent. Checked once more as the fetch starts, after the busy marks a page's element hears.
  if (read && !standing(read)) return void settled(read);
  const method = sends.method.toUpperCase();
  const url = new URL(sends.action);
  const entries = sentEntries(data);
  const fields = new URLSearchParams(entries);
  // A file by its size and time too: another file of the same name is a new submit. A marked read
  // asks for another address than an unmarked one of the same values (an empty query keeps its
  // `?`, below), so neither is the other's request.
  const key = `${read?.at === undefined ? "" : "address "}${method} ${url.href} ${fields} ${Array.from(data.values(), (v) => (typeof v === "string" ? "" : `${v.size}/${v.lastModified}`))}`;
  // A marked form's one a navigation aborted is over, though its own code has not yet run to say so:
  // nothing waits for it or takes it over. An unmarked form's is as before the mark.
  let previous = submits.get(form);
  if (previous?.controller.signal.aborted && press?.at !== undefined) previous = undefined;
  if (previous?.write) {
    // Sent once the write's answer is in; the same values as the write's again send nothing. A
    // button that waits is busy with the write's marks, one it replaced no longer.
    const waiting = previous.next;
    previous.next = previous.key === key ? undefined : (submitter ?? null);
    previous.nextWithin = within;
    // The press it replaces is never sent: let go, as its form's id may have changed since.
    if (previous.nextPress !== press) settled(previous.nextPress);
    previous.nextPress = press;
    if (waiting && waiting !== previous.next && waiting !== previous.by && busyBy.get(waiting) === previous.mine) formCall(waiting, "removeAttribute", "aria-busy");
    if (previous.next) previous.busy.push(previous.next), busyBy.set(previous.next, previous.mine), formCall(previous.next, "setAttribute", "aria-busy", "true");
    return;
  }
  // The same read as one on its way is that one, which this press takes over while no answer has
  // come: it is drawn as this press's, on the entry this press is on. Once one has come, what may be
  // drawing keeps its own press, and a marked form's press is sent anew; an unmarked one's is that
  // read still, as before the mark.
  if (previous?.key === key && (!previous.answered || read?.at === undefined)) {
    // The press it took over from draws nothing now: let go, as its form's id may have changed since.
    if (previous.here !== read) settled(previous.here);
    return void (previous.here = read ?? undefined);
  }
  const sent = sentState(form);
  const controller = new AbortController();
  const { signal } = controller;
  // The form and the control that sent it (a button outside it, by `form=`, too) are busy until
  // the answer is drawn, as this submit's: a newer submit's marks are not cleared when this one
  // ends.
  const mine = {};
  const busy = submitter ? [form, submitter] : [form];
  // Cleared at once when it is abandoned (a newer submit of the form, a navigation), not when its
  // own code next runs, after its fetch rejects or once what it waits on to draw has loaded (#1108).
  signal.addEventListener("abort", () => {
    for (const el of busy) if (busyBy.get(el) === mine) formCall(el, "removeAttribute", "aria-busy");
  });
  const pending = { key, controller, write: method !== "GET", went: false, answered: false, n: 0, next: /** @type {HTMLElement | null | undefined} */ (undefined), nextWithin: /** @type {Set<string> | undefined} */ (undefined), nextPress: /** @type {Press | null | undefined} */ (undefined), here: read ?? undefined, mine, busy, by: submitter };
  // Its presses are let go at once too: nothing is sent or drawn for them now, and what it awaits
  // (a stylesheet a patch's element needs) may never end.
  signal.addEventListener("abort", () => {
    settled(press);
    settled(pending.here);
    settled(pending.nextPress);
  });
  // A read dropped by a newer press, or whose `data-address` entry was left, draws nothing and says
  // nothing, as a submit a navigation cuts off: the page it was for, and the form, are gone.
  const here = (/** @type {boolean} */ drawing = false) => !pending.here || standing(pending.here, drawing);
  const leftAt = left;
  submits.set(form, pending);
  /** @type {RequestInit} */
  // This runtime draws a write's own page whole, which a server sends only to one that says so, as
  // an HTTP preference (RFC 7240): a runtime from before gets `<main>`, and a server from before
  // ignores a preference it does not know.
  const init = { method, headers: { corten: "action", prefer: DRAWS_WHOLE }, signal };
  // A marked form's query as the browser's own GET writes it, `?` kept for none (the `search`
  // setter drops it), for the address its answer puts in.
  if (method === "GET")
    read?.at === undefined ? (url.search = `${fields}`) : (url.href = `${url.href.replace(/[?#].*/, "")}?${fields}${url.href.replace(/^[^#]*/, "")}`);
  else if (sends.enctype === "multipart/form-data") init.body = data;
  else {
    // The browser's content types, which name no charset (fetch adds one to a URLSearchParams).
    const plain = sends.enctype === "text/plain";
    init.body = plain ? entries.map(([name, value]) => `${name}=${value}\r\n`).join("") : fields.toString();
    init.headers = { corten: "action", prefer: DRAWS_WHOLE, "content-type": plain ? "text/plain" : "application/x-www-form-urlencoded" };
  }
  for (const el of busy) busyBy.set(el, mine), formCall(el, "setAttribute", "aria-busy", "true");
  // The submit this one replaces ends once this one holds the marks they share, so the form and a
  // button sending again are not cleared and marked again.
  previous?.controller.abort();
  // A write can change any page, so nothing fetched before it is reused, nor anything prefetched
  // while it was on its way (which may predate it, or use up a notice it sets).
  const forget = () => {
    if (method === "GET") return;
    for (const entry of prefetched.values()) discard(entry);
    prefetched.clear();
  };
  forget();
  // The writes answered before this one is sent, which its own page, if it answers with one, draws.
  const through = writesIn;
  try {
    // A multipart write whose form has an `on:corten:progress` handler goes by XMLHttpRequest, which
    // reports how much of the body is sent; fetch does not. Any other submit is a fetch.
    const progress =
      init.body instanceof FormData && url.origin === location.origin && hasAttr(form, "data-on") && bindings(form).some((b) => b.type === PROGRESS);
    const upload = progress && (await load(UPLOAD), /** @type {typeof import("./upload.js") | undefined} */ (modules.get(UPLOAD)))?.upload;
    // Left while the module loaded (a navigation; a newer submit of a write waits for this one):
    // nothing is sent.
    signal.throwIfAborted();
    // Nor a read that can no longer draw: marking the form and its button busy runs the page's
    // code (a customized button's `attributeChangedCallback`), which may have pressed the form
    // again or moved the page. Nothing runs of the page from here to the fetch.
    if (!here()) return;
    // Out: one a navigation cuts off from here, or that fails on its way, may be applied all the same.
    pending.went = true;
    const res = upload
      ? await upload(
          url,
          method,
          /** @type {FormData} */ (init.body),
          signal,
          ({ loaded, total, lengthComputable }) => {
            if (!signal.aborted) formCall(form, "dispatchEvent", new ProgressEvent(PROGRESS, { loaded, total, lengthComputable }));
          },
          /** @type {Record<string, string>} */ (init.headers),
        )
      : await fetch(url, init);
    forget();
    if (!here()) return;
    // A whole answer below 500 is definitive: the write applied or was refused, and the form gets
    // a new key. A 5xx (a 502 from a proxy can hide a committed write), a network error, an abort
    // or a body cut off on the way keeps the key, so a retry is the same submission.
    // Only the submit still in flight for the form renews its key: a newer one of the same form
    // (which aborted this one) went with this key, and its answer is still to come.
    const renew = () => res.status < 500 && submits.get(form)?.controller === controller && renewSubmitKeys(form);
    const location_ = res.headers.get("corten-location");
    if (location_) {
      renew();
      submits.delete(form);
      if (navigation) {
        if (method !== "GET") undrawn.add(++writesIn);
        // The page it sends the browser to keeps the marks until it is drawn.
        go(location_, { info: { [LOAD]: true, [WRITTEN]: method !== "GET", [SOURCE]: submitter ?? form } });
      } else {
        // Without the Navigation API, a URL that differs only in its `#id` would only scroll.
        const to = new URL(location_, location.href);
        const same = pageKey(to) === pageKey(new URL(location.href));
        location.assign(to);
        if (same) reload();
      }
    } else if (fromHere(res.url) && res.headers.has("corten-shell") && shellChanged(res)) {
      renew();
      reload(noticeOf(res));
    } else if (fromHere(res.url) && (res.headers.has("corten-patch") || res.headers.has("corten-shell"))) {
      // A write's own page, whole: the write is done, and what it changed around `<main>` is drawn
      // only once the page is in. Until then (its modules loading, or a navigation that leaves it),
      // every navigation reads the whole page, as after a write that redirects. A `<main>`
      // answer with a matching shell key leaves that to the next navigation.
      const patch = res.headers.has("corten-patch");
      const whole = !patch && !res.headers.has("corten-page");
      // Its page whole, or one that took it (a patch, `<main>`), is numbered as it comes, undrawn
      // until it is in: a patch that drew a layout element may be drawn over by an older page's
      // layout, which then puts it back as undrawn ({@link drew}).
      const write = method !== "GET" && (whole || res.ok) ? ++writesIn : 0;
      if (write) undrawn.add(write);
      // A 5xx says the write failed (a toast), but a proxy's 502 can hide one that was applied.
      // In the record now, or with nothing to record (a refusal): a navigation from here on does
      // not count it as cut off, and a page asked for from now on is made after it.
      pending.n = write || (method !== "GET" && res.status >= 500 ? failedWrite() : 0);
      pending.answered = true;
      const body = await res.text();
      if (!here()) return;
      renew();
      signal.throwIfAborted();
      // A marked form's answer drawn whole, a patch or a page, is the page at the address it asked
      // for (with the `#id` of its action, which fetch leaves out, a bare `#` too), in place of the
      // entry's: as the browser's own GET puts it in, without adding an entry. A 5xx is no such page.
      // A redirect's address is put in without a fragment: the browser's own GET reaches the
      // `Location`'s if it names one, else the action's, and `fetch` shows neither, so the runtime
      // does not guess.
      // Only for a press made on a marked form, which knows its entry: one sent again from a form an
      // answer marked draws as an unmarked form's does, and leaves the address. So does a whole
      // document ({@link swapDocument}), which takes no draw note.
      /** @type {(() => void) | undefined} */
      let done;
      if (pending.here?.at != null && !whole && hasAttr(form, "data-address") && res.status < 500) {
        /** @type {Draw} */
        const draw = {};
        done = function replace() {
          const to = res.url + (res.redirected ? "" : url.href.replace(/^[^#]*/, ""));
          const path = location.pathname;
          // Not if what it drew began a visit or moved to another entry (a script that navigates
          // as it connects): the replace would cancel that navigation, or write over that entry.
          // A press it made does not stop it, as it has drawn. Nor while the browser says a
          // navigation the runtime did not begin is on its way (`transition`: one a page's
          // `navigate` listener took, its address changed or not), which the replace would
          // cancel too; the page reading itself again is the runtime's, and reads again later.
          // Nor once anything has replaced the entry since the press, keeping its key (a script's
          // `replaceState`, a navigation of the page's that replaced it, another marked answer's
          // own replace): the runtime does not tell whose it was, and the answer is drawn under
          // the address put in then, as an unmarked form's is. The one exception is the replace
          // of the marked answer whose draw made this press, which it came before ({@link onEntry}).
          // The entry's state is kept, as the browser's own GET leaves it with no new entry: its
          // `history.state`, and the Navigation API's own (`getState()`), which `replaceState`
          // drops, put back once the address is in. One the runtime cannot read leaves the address.
          // It is read once everything above has been checked, which reads no page code, so an
          // answer that would leave the address copies nothing; and everything is checked again
          // after it, so what runs as it is read (a page's own `getState`, which can move or replace
          // the entry) is checked too. Each state put in an entry from then on is counted on that
          // entry ({@link writes}), and is the page's, newer, which is the one kept. The
          // `history.state` it passes is a copy taken then too (which runs a getter of the page's on
          // it), so the browser runs no page code as it takes it for the replace, after the checks.
          const goes = () => here(true) && to !== location.href && (!navigation?.transition || navigation.transition === readAgainTransition) && onEntry(pending.here);
          if (!goes()) return;
          /** @type {unknown} */
          let state;
          /** @type {unknown} */
          let kept;
          const old = navigation?.currentEntry;
          try {
            kept = structuredClone(history.state);
            state = old?.getState();
          } catch {
            return;
          }
          const wrote = written(old);
          const transition = navigation?.transition;
          if (!goes()) return;
          const before = exact();
          const seen = changes;
          const key = where();
          try {
            history.replaceState(kept, "", to);
          } catch {
            // Refused (WebKit throws past its limit of history updates): as below.
          }
          // Not in the entry: the browser refused it (Chromium past its limit says nothing), or a
          // page's `navigate` listener cancelled it, perhaps for a navigation of its own. The
          // address stays as it was, the answer drawn under it, as an unmarked form's is: the
          // runtime neither guesses which nor reads the page again over what it cannot see.
          // A listener that holds it (`precommitHandler`), or began a navigation in its place,
          // leaves a navigation on its way, which may yet put this address in: until it ends, no
          // marked press is sent ({@link held}), so no answer is drawn under it.
          if (location.href !== to) {
            if (navigation?.transition && navigation.transition !== transition) (held = navigation.transition), (heldFor = pending.here);
            return;
          }
          // The entry the answer was drawn on, at its new address, by this replace.
          entrySeen = where();
          // What it left, for a press this draw made: only when the Navigation API saw one change
          // of the entry inside the call, a replace that kept its key (not a listener's own
          // `replaceState` there, another's replace, nor a push a `navigate` listener made in its
          // place to the same address). A state a listener puts in the entry there changes no entry.
          const alone = !navigation || (changes === seen + 1 && changed === "replace" && where() === key);
          if (alone) {
            draw.found = before;
            draw.left = exact();
          }
          // Its Navigation API state, back in the entry this replace made (`updateCurrentEntry`
          // keeps its key and id, adding no entry and beginning no navigation). Not in one a
          // listener replaced or pushed inside the call, which is that listener's, nor once a
          // listener has put a state in the entry this replace made (one cleared included), which is
          // newer. One a listener put in the entry before this replace took its place (a `navigate`
          // listener's, as it commits) is newer than the one the runtime read, and goes in instead.
          // Reading it runs a page's own `getState`: only if the entry this replace made is still
          // the screen's and still holds no state of the page's after that does it go in.
          const made = navigation?.currentEntry;
          if (alone && !written(made))
            try {
              const put = written(old) === wrote ? state : old?.getState();
              if (put !== undefined && navigation?.currentEntry === made && !written(made)) navigation?.updateCurrentEntry({ state: put });
            } catch {
              // A document no longer fully active, or a state the runtime cannot read: it is left.
            }
          // Read again at the new address, which without the Navigation API goes by the path.
          if (location.pathname !== path) readAgainLater();
        };
        draws.set(done, draw);
      }
      if (res.headers.has("corten-patch")) {
        await apply(body, signal, sent, res.ok, undefined, undefined, within, here, done);
        // In: what it drew is current until a page made before it is drawn over it.
        if (!signal.aborted) undrawn.delete(write);
      } else {
        const notice = noticeOf(res);
        // A page: a `GET` form's is `<main>` alone (`corten-page`), as a navigation's is. A write's
        // own page is whole, as the page a write redirects to is, so what the write changed around
        // `<main>` (a count the layout reads) is drawn as a browser without JavaScript draws it.
        // Its notice is said unless it was dropped (one loaded in full instead is said too).
        if (res.headers.has("corten-page")) {
          if ((await swapPage(body, signal, false, notice, null, undefined, undefined, undefined, here, done)) || here()) announce(notice);
        } else if (await swapDocument(body, signal, notice, false, false, true, { through, write }, undefined, here)) announce(notice);
      }
      // Dropped, the visit left while it waited for its modules or stylesheets, or left as it
      // drew: nothing more.
      if (!here()) return;
      signal.throwIfAborted();
      if (!write && pending.n) failedWrite(pending.n);
      if (res.status === 422) focusInvalid(form);
      // Sent after an answer that took the write (2xx) or refused only its input (422). Not after a
      // refusal of the state it was made against (a 409 or 410, "someone saved first"): the user
      // reads it first, or the waiting submit would overwrite what they have not seen. Nor after a
      // 5xx, which may hide a write that was applied or not, under the same key.
      if (!res.ok && res.status !== 422) pending.next = undefined;
    } else {
      // A 5xx it does not draw failed where the page says so (`corten:error`), applied or not.
      if (method !== "GET" && res.status >= 500) pending.n = failedWrite();
      // Nothing to draw: a navigation from here on does not count it as cut off.
      pending.answered = true;
      // An answer the runtime does not draw is whole once its body has arrived too.
      await res.arrayBuffer();
      if (!here()) return;
      signal.throwIfAborted();
      if (res.status === 204 || res.status === 205) {
        // Done, with nothing to draw (RFC 9110, 15.3.5): the page stays and a waiting submit goes.
        // A 205 also asks for the form as it came (15.3.6), unless the user changed a field since
        // it was sent (a control added since counts, and so does text a number or date input
        // cannot read, whose value is "") or pressed again with other values: their work is kept,
        // as against a patch.
        const unchanged = (/** @type {Element} */ f) => sent.has(f) && stateOf(f) === sent.get(f) && !(/** @type {HTMLInputElement} */ (f).validity?.badInput);
        if (res.status === 205 && pending.next === undefined && Array.from(formProperty(form, "elements")).every(unchanged)) formCall(form, "reset");
        renew();
      } else {
        renew();
        // The page did not change, so the waiting submit would meet the same answer (a 409 for its
        // version): the page says so with `corten:error`, and the user sends it again.
        if (pending.n) failedWrite(pending.n);
        pending.next = undefined;
        sayFailed(form, { status: res.status }, turn);
      }
    }
  } catch (error) {
    // A write a navigation cut off was numbered by that navigation. One that failed on its way where
    // the page says so (the network failed, or the body of an answer that took it was cut off, or
    // did not draw) may have been applied too: the next navigation reads the whole page, but not the
    // page reading itself again, which would draw away the failure shown.
    if (signal.aborted || !here()) return;
    if (pending.n) failedWrite(pending.n);
    else if (pending.went && !pending.answered && method !== "GET") failedWrite();
    // Offline, the server unreachable, or the browser leaving the page (a full navigation without
    // the Navigation API cancels it): the form stays as it is, and the page can say so. A submit
    // that waited goes with it, since it would fail the same way, and the user sends it again.
    pending.next = undefined;
    sayFailed(form, { status: 0, error }, turn);
  } finally {
    // Cleared when this submit ends, but not those a newer submit of the form or the page a
    // redirect sends the browser to marked again (theirs, cleared when they end).
    const current = submits.get(form)?.controller === controller;
    for (const el of busy) if (busyBy.get(el) === mine) formCall(el, "removeAttribute", "aria-busy");
    settled(press);
    settled(pending.here);
    if (current) {
      submits.delete(form);
      // In a task of its own, after the answer is drawn; not into a page being left.
      const { next, nextWithin, nextPress } = pending;
      if (next !== undefined && !signal.aborted) setTimeout(() => (left === leftAt ? sendAgain(form, next, nextWithin, nextPress) : settled(nextPress)));
      else settled(nextPress);
    } else settled(pending.nextPress);
  }
}

/**
 * The form that sent a submit while it is on the page, else the element that has its id now: the
 * form an answer or a read drew in its place. Null for one without an id that left the page.
 * @param {HTMLFormElement} form
 */
function inPlaceOf(form) {
  const id = idOf(form);
  return formProperty(form, "isConnected") ? form : id ? document.getElementById(id) : null;
}

/**
 * Says a `data-patch` submit got no answer it can draw (`corten:error`, cancelable, with `detail`),
 * where the page hears it, once no navigation is on its way: its draw would take away what a
 * handler showed; a form no navigation on its way can draw over (one outside `<main>` and the
 * page's parts, with no whole page on its way) hears it at once. Then on the form that sent it,
 * while that is in the page; else on the form a read drew in its place: the one with its id now
 * ({@link inPlaceOf}), with the same `action` and `method`, drawn with no navigation to another
 * address since the press (`turn`), that has sent no submit itself. Else on the document: an
 * event on a form no longer in the page reaches no handler, and a form of another page, or one
 * used since, did not send this write.
 * @param {HTMLFormElement} form @param {{ status: number, error?: unknown }} detail @param {number} turn
 */
function sayFailed(form, detail, turn) {
  // A navigation draws `<main>` and the layout's elements that are the page's, and the whole
  // layout only after a write: a form in the page outside them it leaves where it is.
  let kept = formProperty(form, "isConnected") && !Array.from(reading).some((read) => read.whole);
  for (let up = /** @type {Element | null} */ (form); kept && up; up = parentElementOf(up))
    kept = localNameOf(up) !== "main" && !hasAttr(up, "data-corten-page") && !partIds.has(idOf(up) ?? "");
  if (reading.size && !kept) {
    afterReads.push(() => sayFailed(form, detail, turn));
    return;
  }
  const at = inPlaceOf(form);
  const event = new CustomEvent("corten:error", { bubbles: true, cancelable: true, detail });
  const successor =
    at instanceof HTMLFormElement &&
    turn === turns &&
    hasAttr(at, "data-patch") &&
    !sentFrom.has(at) &&
    /** @type {const} */ (["action", "method"]).every((name) => formProperty(at, name) === formProperty(form, name));
  if (at === form || successor) formCall(/** @type {HTMLFormElement} */ (at), "dispatchEvent", event);
  else document.dispatchEvent(event);
}

/**
 * Sends the submit that waited for a write's answer, from the form as it is now, without a
 * second `submit` event (its handlers ran at the press) and without the browser's constraint
 * validation again (the server checks what it gets). A form the answer replaced is found by its
 * id; one it removed (its row is gone) sends nothing, and so does one without an id that is no
 * longer on the page, whose values are the ones from before the answer.
 * The button is the one pressed, or the one the answer put in its place; where it was is where it
 * was pressed (`within`), not where the answer drew it.
 * A read a newer press dropped while it waited, or one pressed on a visit the page has left, is not
 * sent ({@link pressed}).
 * @param {HTMLFormElement} form @param {HTMLElement | null} submitter @param {Set<string>} [within]
 * @param {Press | null} [press]
 */
function sendAgain(form, submitter, within, press) {
  const now = inPlaceOf(form);
  if (!(now instanceof HTMLFormElement) || !hasAttr(now, "data-patch")) return void settled(press);
  const all = /** @type {HTMLElement[]} */ (Array.from(formProperty(now, "elements")));
  const by =
    !submitter || all.includes(submitter)
      ? submitter
      : all.find(
          (el) =>
            localNameOf(el) === localNameOf(submitter) &&
            ["type", "name", "value", "formaction", "formmethod", "formenctype", "formnovalidate"].every((a) => el.getAttribute(a) === submitter.getAttribute(a)),
        );
  if (by === undefined) return void settled(press);
  const sends = sendsAs(now, by);
  // Fenced as what the form sends now: a press the answer drew its form to send as a write (with
  // `method="post"`) is one, which no newer press drops; one it drew to send as a read is a read,
  // on the entry it was pressed on, so one that cannot draw does not read the form again.
  if (sends.method !== "get" || (press && standing(press))) send(now, by, sends, within, press ?? null);
  else settled(press);
}

/**
 * Sets a `<corten-live>`'s `status` and says so with a bubbling `corten-status` event, which a
 * handler takes like any other (`on:corten-status={js::show(target)}`) and reads the attributes.
 * @param {Element} el @param {string} status
 */
function liveStatus(el, status) {
  el.setAttribute("status", status);
  el.dispatchEvent(new Event("corten-status", { bubbles: true }));
}

/** The fields `<corten-live>` declares, writable. @typedef {{ source: EventSource | null, applied: Promise<void> }} LiveFields */
customElements.define(
  "corten-live",
  class extends HTMLElement {
    /** @type {EventSource | null} */
    source = null;
    /** Patches apply in the order they arrive, each after the modules it needs. */
    applied = Promise.resolve();
    connectedCallback() {
      const src = this.getAttribute("src");
      if (!src) throw new Error("corten: <corten-live> needs a src attribute");
      // `since` is the app's cursor the page was rendered at: the first connection sends it, so
      // the server only sends what changed after it. A reconnect sends the last fragment's id as
      // Last-Event-ID, which the server reads first.
      const since = this.getAttribute("since");
      const url = new URL(src, location.href);
      if (since) url.searchParams.set("since", since);
      // The connection shows on the element, for CSS and scripts: `status` is connecting, live,
      // reconnecting (the browser retries), closed (it gave up) or ended (the server finished), and
      // `stale-since` is when a live stream dropped, until it is live again. Each change of
      // `status` dispatches `corten-status`.
      // Its fields are written through `LiveFields`, not `this`: checked JavaScript takes a property a
      // method sets first as declared (docs/design.md#choice-handlers-checked-where-called).
      const source = (/** @type {LiveFields} */ (this).source = new EventSource(url));
      liveStatus(this, "connecting");
      source.addEventListener("open", () => {
        this.removeAttribute("stale-since");
        liveStatus(this, "live");
      });
      source.addEventListener("error", () => {
        if (this.getAttribute("status") === "ended") return;
        if (this.getAttribute("status") === "live") this.setAttribute("stale-since", new Date().toISOString());
        liveStatus(this, source.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
      });
      source.addEventListener("patch", (event) => {
        const { data, origin } = /** @type {MessageEvent<string>} */ (event);
        // The origin the stream came from, after any redirect: another's fragment is not drawn, nor
        // an event a script dispatched.
        if (!event.isTrusted || origin !== location.origin) return console.error("corten: <corten-live> draws only fragments its stream brought from this origin, not", event.isTrusted ? origin : "an event a script dispatched");
        /** @type {LiveFields} */ (this).applied = this.applied.then(() => apply(data, undefined, null)).catch(reportError);
      });
      // The server's stream finished: stay as it is instead of reconnecting.
      source.addEventListener("end", () => {
        source.close();
        liveStatus(this, "ended");
      });
    }
    disconnectedCallback() {
      this.source?.close();
    }
  },
);

markCurrent();
// No names: nothing counts the first page's as changed (they went into a set nothing read), and a
// page of rows has thousands.
scan(document.documentElement, null);
serve(document);
readAgainLater();
{
  const main = document.querySelector("main");
  if (main) readPartsAgain(main);
}
// The server marks the part module's preload when the page draws a part waiting.
if (metas.querySelector("[data-corten-part]")) readParts();

/** Resolves once the script modules the first page's handlers use are imported. */
export const ready = Promise.all(loading.values()).then(() => undefined);

// A navigation's notice whose page loaded in full instead (`reload`): announced once the page's
// modules are in and their `on:connect` handlers ran (a task later), if this is still that page.
try {
  const kept = sessionStorage.getItem(NOTICE);
  if (kept !== null) {
    sessionStorage.removeItem(NOTICE);
    // What `reload` wrote, or not: storage is the browser's, and outlives a version of the runtime.
    const [path, text, until] = /** @type {unknown[]} */ (JSON.parse(kept));
    if (path === location.pathname && typeof text === "string" && typeof until === "number" && Date.now() < until) ready.then(() => setTimeout(() => announce(new URLSearchParams({ m: text }))));
  }
} catch {
  // No session storage, or not what reload wrote: nothing to say.
}

// Under `corten dev` the server sends the time it started; after a restart (a rebuild) the stream
// reconnects to a server that started later, and the page reloads. Its other checks are a module
// only a dev server serves (js/dev.js).
const devStart = queryOne(metas, 'meta[name="corten-dev"]')?.getAttribute("content");
if (devStart) {
  new EventSource("/corten/dev").addEventListener("message", (event) => {
    if (/** @type {MessageEvent<string>} */ (event).data !== devStart) reload();
  });
  // A failed load is the browser's own error, which names the URL: a message of the runtime's
  // would be bytes every production page carries.
  const checks = "/corten/dev.js";
  import(checks);
}

// App::client_zone: the browser's time zone, kept in a cookie for the server's ClientZone. Written
// on each full load, so a visitor who travels is followed from their next page.
if (queryOne(metas, 'meta[name="corten-zone"]')) {
  document.cookie = `corten-zone=${Intl.DateTimeFormat().resolvedOptions().timeZone};path=/;max-age=31536000;samesite=lax`;
}

const worker = queryOne(metas, 'meta[name="corten-sw"]')?.getAttribute("content");
if (worker && "serviceWorker" in navigator) {
  addEventListener("load", () => {
    navigator.serviceWorker.register(/** @type {string} */ (/** @type {unknown} */ (trusted ? trusted.createScriptURL(worker) : worker))).catch((error) => console.error("corten: service worker registration failed", error));
  });
}
