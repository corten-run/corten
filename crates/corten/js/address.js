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
 * route's page, its part drawn for its entry's address, so the entries stay. A same-document push
 * or replace (`pushState`, a `#fragment`) draws none, though it ends in `navigatesuccess` too.
 */
let screenPath = location.pathname;
let drawsNone = false;
/**
 * The key of the entry whose screen is drawn. The address moves to an entry as Back or Forward to
 * it starts, its screen once it is drawn: a traversal a newer one supersedes before it draws
 * leaves the screen it found, which is not its entry's.
 */
let shown = navigation?.currentEntry?.key;
navigation?.addEventListener("navigate", (event) => {
  drawsNone = event.destination.sameDocument && event.navigationType !== "traverse";
  // Where the screen left was scrolled, read before anything is drawn: Back or Forward to its
  // entry by its patch puts it there again ({@link read}). Only while the address is its entry's:
  // one a traversal moved before drawing was read as that traversal began, and the browser may
  // have scrolled the screen since (Firefox does, to the entry it went to).
  const key = navigation?.currentEntry?.key;
  if (!drawsNone && key && key === shown && addressed.has(key)) places.set(key, [scrollX, scrollY]);
});
navigation?.addEventListener("navigatesuccess", () => {
  shown = navigation?.currentEntry?.key;
  drawsNone || (screenPath = location.pathname);
});

/**
 * The history entries whose part a marked form's patch drew for their address, and the entry each
 * such form was sent from, by key: Back and Forward between two of them at the screen's path read
 * the patch again ({@link read}), not the page.
 * @type {Set<string>}
 */
const addressed = new Set();

/**
 * Where each entry a marked form's patch left or Back and Forward between them left was scrolled,
 * by key, read before its screen changed. A traversal that draws the patch restores it itself, once
 * the patch is drawn: the browser's own restoring, which Firefox does as the address changes,
 * would meet the screen it leaves, which may be shorter.
 * @type {Map<string, [number, number]>}
 */
const places = new Map();

/**
 * Each marked form's write on its way, by its submit (`submits`): whether, once its answer is
 * drawn, a GET of another marked form sent while it was on its way goes ({@link submit}).
 * @type {WeakMap<object, Promise<boolean>>}
 */
const writes = new WeakMap();
/** The marked GET sent last: one that waits for a write goes only if it still is. */
let latest = {};

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
 * it is drawn was not either. An abort is the caller's: it rejects. `before` runs once the patch
 * passed the check, before it draws anything.
 * @param {Core} core @param {Parameters<Core[0]>[0]} html @param {AbortSignal} signal
 * @param {Parameters<Core[0]>[2]} sent @param {boolean | undefined} took @param {Set<string> | undefined} within
 * @param {(content: DocumentFragment) => void} before
 */
const drawWhole = ([apply], html, signal, sent, took, within, before) =>
  apply(html, signal, sent, took, undefined, undefined, within, (content) => (check(content), before(content))).then(
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
 * Another marked form's GET still on its way is dropped, as a navigation drops the page asked
 * before it, since it would draw an older choice over this one. Another marked form's write still
 * on its way is not: the server may have applied it, and its answer may be the only update of
 * parts outside this form's patch, so this is sent once that answer is drawn ({@link writes}), and
 * its patch, drawn after, is the screen. It is not sent after an answer that would stop a submit of
 * the write's own form waiting for it (`send`: a refusal of the state, a 5xx, a redirect, an error),
 * which the user reads first, nor once another marked GET has been sent since; a submit of the
 * write's form waiting for it is dropped, pressed before this. A write of this form makes this wait
 * for it (`send`). A patch drawn whole puts the address it asked for in history ({@link address});
 * a page, or a patch not drawn whole, has the page at that address read instead, as the browser
 * reads it for the form without JavaScript: in an entry of its own (none when it is the address
 * already), the form busy until it is drawn. A submit that waited for a write's answer comes again,
 * with no submit event (`sendAgain`), from the form as it is now.
 * @param {Event} event @param {HTMLFormElement} form
 * @param {HTMLElement | null | undefined} by the button that sent it
 * @param {Parameters<Core[8]>[2]} sends how the form is sent @param {Core} core @param {Set<string>} [within]
 */
export function submit(event, form, by, sends, core, within) {
  const get = sends.method === "get";
  if (get && (!navigation || navigation.transition)) return;
  const [apply, remember, , submits, go, LOAD, SOURCE, , send, , , sendAgain] = core;
  event.preventDefault();
  if (!get) {
    const before = submits.get(form);
    /** @type {Response | undefined} */
    let res;
    let failed = false;
    const off = new AbortController();
    own.addEventListener.call(form, "corten:error", () => (failed = true), { signal: off.signal });
    const sent = send(form, by, sends, within, { page: (r) => ((res = r), false), patch: apply });
    const pending = submits.get(form);
    // Only a write sent now: one sent while another of the form is on its way waits in `send`.
    if (pending?.write && pending !== before)
      writes.set(
        pending,
        sent.then(() => {
          off.abort();
          return !!res && !failed && !pending.controller.signal.aborted && !res.headers.has("corten-location") && (res.ok || res.status === 422);
        }),
      );
    else off.abort();
    return;
  }
  const mine = (latest = {});
  /** @type {(Promise<boolean> | undefined)[]} */
  const waits = [];
  for (const [other, pending] of submits)
    if (other !== form && own.hasAttribute.call(other, "data-address"))
      if (pending.write) waits.push(writes.get(pending)), (pending.next = undefined);
      else pending.controller.abort();
  if (waits.length) return void Promise.all(waits).then((ok) => ok.every(Boolean) && latest === mine && sendAgain(form, by ?? null));
  let at = "";
  const read = () => {
    submits.delete(form);
    go(at, { info: { [LOAD]: true, [SOURCE]: by ?? form } });
  };
  send(form, by, sends, within, {
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
      // The entry left, as it is before the patch changes it: what the user typed there and had
      // not sent (`remember`), the patch's part too, and where it was scrolled, for Back to it.
      const leave = () => {
        const from = navigation?.currentEntry?.key;
        const main = document.querySelector("main");
        if (at === location.href || !from) return;
        if (main) remember(from, main);
        places.set(from, [scrollX, scrollY]);
      };
      const whole = await drawWhole(core, html, /** @type {AbortSignal} */ (signal), sent, took, within, leave);
      signal?.throwIfAborted();
      if (whole) address(at, core);
      else read();
    },
  });
}

/**
 * Puts `to` in the address bar once its patch is drawn, as the browser does for the form without
 * JavaScript: in a new history entry, none when it is the address already. What the user typed in
 * the entry left, and where it was scrolled, was kept as the patch was about to be drawn.
 * @param {string} to @param {Core} core
 */
function address(to, [, , , , , , , markCurrent]) {
  if (to === location.href) return;
  const from = navigation?.currentEntry?.key;
  // Only entries at the screen's path: the entry it was sent from shows the same screen as the new one.
  const here = new URL(to).pathname === screenPath;
  if (here && from && location.pathname === screenPath) addressed.add(from);
  history.pushState(null, "", to);
  shown = navigation?.currentEntry?.key;
  if (here) addressed.add(shown ?? "");
  // The entries the new one dropped (those it was ahead of) are forgotten.
  const live = new Set(navigation?.entries().map((e) => e.key));
  for (const kept of [addressed, places]) for (const key of kept.keys()) if (!live.has(key)) kept.delete(key);
  // A nav link to the new address is the current one, as a navigation marks it.
  markCurrent();
}

/**
 * Back or Forward, from the runtime's `navigate`: between two entries a marked form's patches drew
 * ({@link addressed}) at the screen's path, the patch again ({@link read}), the rest of the screen
 * and the focus staying, and the scroll restored once it is drawn. Not while a write is on its way,
 * which the navigation cancels but which may land: the patch would leave what it changed outside
 * the part as it was. Otherwise nothing, and the runtime reads the page.
 * @param {NavigateEvent} event @param {URL} url
 * @param {{ handler: () => Promise<unknown> }} page how the runtime reads the page at `url`
 * @param {Core} core
 * @returns {NavigationInterceptOptions | undefined}
 */
export function traverse(event, url, page, core) {
  const submits = core[3];
  const between = addressed.has(event.destination.key) && addressed.has(navigation?.currentEntry?.key ?? "");
  if (!between || url.pathname !== screenPath || Array.from(submits.values()).some((p) => p.write)) return;
  return { focusReset: "manual", scroll: "manual", handler: () => read(url, event, page.handler, core) };
}

/**
 * Back or Forward between entries a marked form's patches drew: the entry's address is read as
 * the form read it (`corten: action`), so the HTTP cache can answer it, and its patch drawn. An
 * answer that is not a whole 2xx patch from here (a page, a redirect, an error, even one that
 * carries a patch, none, a body cut off), or a patch not drawn whole ({@link check}), has the page
 * read instead, as for any other entry. The traversal's signal ends it, as a newer navigation does
 * any visit; the screen stays, so the fields outside the patch keep what the user typed (kept for
 * the entry left too, as a page read keeps it), and the patch keeps a field they are editing as
 * any patch does. What the user typed in the part on that entry and had not sent is put back in
 * the part drawn for it, and the entry's scroll is restored once it is drawn ({@link places}).
 * @param {URL} url @param {NavigateEvent} event @param {() => Promise<unknown>} visit @param {Core} core
 */
async function read(url, event, visit, core) {
  const [, remember, drawn, , , , , , , typedIn, putTyped] = core;
  const { signal, destination } = event;
  const key = destination.key;
  // Where the entry was scrolled, or, for one this module did not see left, where the browser keeps it.
  const scroll = () => {
    const at = places.get(key);
    if (at) scrollTo(at[0], at[1]);
    else
      try {
        event.scroll();
      } catch {}
  };
  // The page: the traversal kept focus for the patch, so focus the swap left where it was (outside
  // `<main>`) or let fall to the body (from what it took away, or before, with Tab going on from
  // there) goes where the browser puts it for a page, the document's start, which the next Tab
  // starts from: the body takes it for the move. Focus the page gave a control as it was drawn stays.
  const page = async () => {
    const was = document.activeElement;
    await visit();
    const body = document.body;
    const now = document.activeElement;
    if (signal.aborted) return;
    scroll();
    if (now && now !== was && now !== body) return;
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
  const main = document.querySelector("main");
  /** @type {(string | null)[]} */
  let ids = [];
  // What the user typed is kept for the entry whose screen this draws over ({@link shown}), not
  // the entry the address left, which a traversal superseded before drawing left undrawn.
  const whole = await drawWhole(core, html, signal, null, undefined, undefined, (content) => {
    if (main && shown) remember(shown, main);
    shown = key;
    ids = Array.from(content.children, (el) => own.getAttribute.call(el, "id"));
  });
  signal.throwIfAborted();
  if (!whole) return page();
  const typed = typedIn.get(key);
  if (main && typed) {
    // Only the fields in what the patch drew: those outside it stay as the user has them now.
    const parts = ids.map((id) => id && document.getElementById(id));
    const isField = (/** @type {Element} */ el) => own.matches.call(el, "input, textarea, select");
    putTyped(
      main,
      typed.filter(([at, , nth]) => {
        const f = Array.from(main.querySelectorAll(at)).filter(isField)[nth];
        // Element's own `contains`: a part may be a form, whose controls' names shadow it.
        return !!f && parts.some((part) => !!part && own.contains.call(part, f));
      }),
    );
  }
  scroll();
  if (navigation?.currentEntry) drawn(navigation.currentEntry.key);
}