// @ts-check
// A GET `data-patch` form marked `data-address`, whose answer is the page at the address it asked
// for: the address follows its patch into history, and Back and Forward between the entries it
// made draw that patch again (docs/design.md, the Choice for `data-address`). A module of its own,
// which only a page with such a form loads: with the page's scripts, the server having noted the
// form as it rendered it, or with the page or patch the runtime inserts that has one. Every page's
// runtime carries only the few lines that hand it the form's submit and such a traversal, and leaves
// the form to the browser until it has loaded. Built into dist/address.js and served as the
// `corten-address` script module.

/** @typedef {import("./corten.js").AddressCore} Core */
/**
 * What the runtime's `send` hands a marked form's answer to: `page` takes one that is a page (it
 * reads the page at the address, and says so), `patch` draws a patch in place of `apply`.
 * @typedef {{ page(res: Response, url: URL): boolean, patch: Core[0] }} Answers
 */

const navigation = /** @type {Navigation | undefined} */ (window.navigation);
/** Element's own members, for an element that may be a form, whose controls' names shadow them. */
const own = Element.prototype;

/** Whether a response's URL is this origin's (none: a `Response` a script made). @param {string} url */
const fromHere = (url) => url !== "" && new URL(url).origin === location.origin;

/**
 * The path of the page on screen: the document's, then each page a navigation drew. Only entries
 * at it are patch entries ({@link addressed}): a patch of another route, drawn into this page, is
 * not what that route's page draws. A page drawn at that path since is the same screen, the
 * route's page, its part drawn for its entry's address, so the entries stay.
 */
let screenPath = location.pathname;
navigation?.addEventListener("navigatesuccess", () => (screenPath = location.pathname));

/**
 * The history entries whose part a marked form's patch drew for their address, and the entry each
 * such form was sent from, by key: Back and Forward between two of them at the screen's path read
 * the patch again ({@link read}), not the page.
 * @type {Set<string>}
 */
const addressed = new Set();

/**
 * Refuses a patch that is not the page at an address: one with no element, an element with no
 * place on the page, or one that adds to an element (`data-append`), which draws more of what is
 * there rather than the part as the address has it. The runtime calls it once the patch is parsed
 * and its stylesheet links are taken out (a stylesheet alone is none), before it draws anything.
 * @param {DocumentFragment} content
 */
function check(content) {
  const els = Array.from(content.children);
  const placed = (/** @type {Element} */ el) => {
    const id = own.getAttribute.call(el, "id");
    if (own.matches.call(el, "[data-corten-read-again], template[data-remove]")) return true;
    return !own.matches.call(el, "template[data-append]") && !!id && !!document.getElementById(id);
  };
  if (!els.length || !els.every(placed)) throw new Error("corten: a data-address form's patch is not the page at its address");
}

/**
 * The runtime's `apply` with {@link check}: whether the patch was drawn whole. One that throws as
 * it is drawn was not either. An abort is the caller's: it rejects.
 * @param {Core} core @param {string} html @param {AbortSignal} signal
 * @param {Parameters<Core[0]>[2]} sent @param {boolean | undefined} took @param {Set<string>} [within]
 */
const drawWhole = ([apply], html, signal, sent, took, within) =>
  apply(html, signal, sent, took, true, undefined, within, check).then(
    () => true,
    (error) => {
      if (signal.aborted) throw error;
      return false;
    },
  );

/**
 * A marked form's submit, from the runtime's. One that posts (a button's `formmethod`) is any
 * `data-patch` form's. A GET is sent by the runtime's `send`, which hands this module its answer,
 * where the browser has the Navigation API that Back to its address needs, and is left to the
 * browser elsewhere, as without JavaScript. One sent while a navigation is on its way (a link's
 * page, a traversal) is left to the browser too, which drops that navigation for the form's, as
 * it does without JavaScript: the runtime reads the page at the form's address in its place.
 * Another marked form's submit still on its
 * way is dropped, as a navigation drops the page asked before it, since it would draw an older
 * choice over this one. A patch drawn whole puts the address it asked for in history
 * ({@link address}); a page, or a patch not drawn whole, has the page at that address read
 * instead, as the browser reads it for the form without JavaScript: in an entry of its own (none
 * when it is the address already), the form busy until it is drawn.
 * @param {Event} event @param {HTMLFormElement} form
 * @param {HTMLElement | null | undefined} by the button that sent it
 * @param {Parameters<Core[8]>[2]} sends how the form is sent @param {Core} core
 */
export function submit(event, form, by, sends, core) {
  const get = sends.method === "get";
  if (get && (!navigation || navigation.transition)) return;
  const [, , , submits, go, LOAD, SOURCE, , send] = core;
  event.preventDefault();
  if (!get) return void send(form, by, sends);
  for (const [other, pending] of submits) if (other !== form && !pending.write && own.hasAttribute.call(other, "data-address")) pending.controller.abort();
  let at = "";
  const read = () => {
    submits.delete(form);
    go(at, { info: { [LOAD]: true, [SOURCE]: by ?? form } });
  };
  send(form, by, sends, undefined, {
    // An answer that is a page (not a redirect the server asks for) is read at the address.
    page(res, url) {
      // The address, its `#fragment` too, which the browser keeps for the form without JavaScript,
      // across a redirect whose `Location` names none: `fetch` shows no fragment of a redirect's
      // own. A `Response` a script made has no URL: the request's stands in.
      const to = new URL(res.url || url);
      to.hash ||= url.hash;
      at = to.href;
      if (!fromHere(res.url) || !res.headers.has("corten-page") || res.headers.has("corten-location")) return false;
      // Not read: the page's read does not share the connection with it.
      res.body?.cancel().catch(() => {});
      read();
      return true;
    },
    async patch(html, signal, sent, took, _own, _asked, within) {
      const whole = await drawWhole(core, html, /** @type {AbortSignal} */ (signal), sent, took, within);
      signal?.throwIfAborted();
      if (whole) address(at, core);
      else read();
    },
  });
}

/**
 * Puts `to` in the address bar once its patch is drawn, as the browser does for the form without
 * JavaScript: in a new history entry, none when it is the address already. What the user typed in
 * the entry left is kept for Back to it (`remember`), as for a link followed.
 * @param {string} to @param {Core} core
 */
function address(to, [, remember, , , , , , markCurrent]) {
  if (to === location.href) return;
  const from = navigation?.currentEntry?.key;
  // Only entries at the screen's path: the entry it was sent from shows the same screen as the new one.
  const here = new URL(to).pathname === screenPath;
  if (here && from && location.pathname === screenPath) addressed.add(from);
  const main = document.querySelector("main");
  if (main && from) remember(from, main);
  history.pushState(null, "", to);
  if (here) addressed.add(navigation?.currentEntry?.key ?? "");
  // The entries the new one dropped (those it was ahead of) are forgotten.
  const live = new Set(navigation?.entries().map((e) => e.key));
  for (const key of addressed) if (!live.has(key)) addressed.delete(key);
  // A nav link to the new address is the current one, as a navigation marks it.
  markCurrent();
}

/**
 * Back or Forward, from the runtime's `navigate`: between two entries a marked form's patches drew
 * ({@link addressed}) at the screen's path, the patch again ({@link read}), the rest of the screen
 * and the focus staying. Not while a write is on its way, which the navigation cancels but which
 * may land: the patch would leave what it changed outside the part as it was. Otherwise nothing,
 * and the runtime reads the page.
 * @param {NavigateEvent} event @param {URL} url
 * @param {{ handler: () => Promise<unknown> }} page how the runtime reads the page at `url`
 * @param {Core} core
 * @returns {NavigationInterceptOptions | undefined}
 */
export function traverse(event, url, page, core) {
  const submits = core[3];
  const between = addressed.has(event.destination.key) && addressed.has(navigation?.currentEntry?.key ?? "");
  if (!between || url.pathname !== screenPath || Array.from(submits.values()).some((p) => p.write)) return;
  return { focusReset: "manual", handler: () => read(url, event.signal, page.handler, core) };
}

/**
 * Back or Forward between entries a marked form's patches drew: the entry's address is read as
 * the form read it (`corten: action`), so the HTTP cache can answer it, and its patch drawn. An
 * answer that is not a whole 2xx patch from here (a page, a redirect, an error, even one that
 * carries a patch, none, a body cut off), or a patch not drawn whole ({@link check}), has the page
 * read instead, as for any other entry. The traversal's signal ends it, as a newer navigation does
 * any visit; the screen stays, so the fields outside the patch keep what the user typed (kept for
 * the entry left too, as a page read keeps it), and the patch keeps a field they are editing as
 * any patch does.
 * @param {URL} url @param {AbortSignal} signal @param {() => Promise<unknown>} visit @param {Core} core
 */
async function read(url, signal, visit, core) {
  const [, remember, drawn] = core;
  // The page: the traversal kept focus for the patch, so focus the swap left where it was (outside
  // `<main>`) or let fall to the body (from what it took away, or before, with Tab going on from
  // there) goes where the browser puts it for a page, the document's start, which the next Tab
  // starts from: the body takes it for the move. Focus the page gave a control as it was drawn stays.
  const page = async () => {
    const was = document.activeElement;
    await visit();
    const body = document.body;
    const now = document.activeElement;
    if (signal.aborted || (now && now !== was && now !== body)) return;
    const made = !body.hasAttribute("tabindex");
    if (made) body.tabIndex = -1;
    body.focus({ preventScroll: true });
    if (made) body.removeAttribute("tabindex");
  };
  const res = await fetch(url, { headers: { corten: "action" }, signal }).catch(() => null);
  signal.throwIfAborted();
  if (!res?.ok || !res.headers.has("corten-patch") || res.redirected || !fromHere(res.url)) {
    // Its body is not read: the page's read does not share the connection with it.
    res?.body?.cancel().catch(() => {});
    return page();
  }
  const html = await res.text().catch(() => null);
  signal.throwIfAborted();
  if (html === null) return page();
  const left = navigation?.transition?.from.key;
  const main = document.querySelector("main");
  if (main && left) remember(left, main);
  const whole = await drawWhole(core, html, signal, null, undefined);
  signal.throwIfAborted();
  if (!whole) return page();
  if (navigation?.currentEntry) drawn(navigation.currentEntry.key);
}
