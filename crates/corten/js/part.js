// @ts-check
// The reads of the parts a page waits for (`ReadAgain::now`): a module of its own, which only a
// page that draws a part waiting loads (its head preloads it with the runtime, and a navigation's
// answer preloads it too); every page's runtime carries only the few lines that find such a part
// and hand it here. Built into dist/part.js and served beside the runtime, at
// `/corten/{version}/part.js` (docs/design.md#choice-slow-part-link).

/** A part the page waits for: its tag, in the element its read's patch replaces. */
const PART_NOW = "template[data-corten-read-now][data-from]";
/** The mark of a part no read will bring, where the app's CSS shows its link. */
const FAILED = "data-corten-read-failed";
// Read through Element's and Node's own, as a form's controls may shadow them.
const own = Element.prototype;
/** @param {Element} el */
const inPage = (el) => !!Reflect.get(Node.prototype, "isConnected", el);

/** How many times the browser has hidden the page (the back-forward cache), and whether it is now. */
let hidden = 0;
let away = false;
addEventListener("pagehide", () => {
  hidden += 1;
  away = true;
});
addEventListener("pageshow", () => (away = false));

/**
 * The runtime's `apply`: draws the patch `html` unless `signal` has aborted once its modules and
 * stylesheets have loaded; `asked` is the tag of the read it answers.
 * @typedef {(html: string, signal: AbortSignal, sent: null, took: undefined, own: boolean, asked: Element) => Promise<void>} Apply
 */

/**
 * Reads the parts `roots` draw waiting: each tag's part is the element it is in, which needs an
 * id (the patch replaces it by its id). Tags that name the same address share one read, whose
 * patch draws each of their parts. `chained`: `roots` are what an answer to a part's read drew,
 * whose parts are marked failed rather than read, so one read cannot start another without end.
 * A page the browser renders before it is shown (Speculation Rules' prerender) reads them once
 * it is: the server's slow read is for a page someone sees.
 * @param {Element[]} roots @param {boolean} chained @param {Apply} apply
 * @param {(el: Element) => AbortSignal} signalOf aborts when `el` leaves the page
 * @param {WeakMap<Element, object>} busyBy the work that last marked each element `aria-busy`
 */
export function read(roots, chained, apply, signalOf, busyBy) {
  // Not in lib.dom yet; a browser without it never prerenders.
  if (Reflect.get(document, "prerendering") === true) {
    document.addEventListener("prerenderingchange", () => read(roots, chained, apply, signalOf, busyBy), { once: true });
    return;
  }
  /** @type {Map<string, [Element[], Element[]]>} */
  const reads = new Map();
  for (const root of roots) {
    for (const tag of Array.from(own.querySelectorAll.call(root, PART_NOW))) {
      const part = tag.parentElement;
      if (!part || !inPage(tag)) continue;
      if (chained || !own.hasAttribute.call(part, "id")) {
        if (!chained) console.error("corten: ReadAgain::now goes in the element its patch replaces, which needs an id", part);
        own.setAttribute.call(part, FAILED, "");
        continue;
      }
      const from = /** @type {string} */ (own.getAttribute.call(tag, "data-from"));
      let found = reads.get(from);
      if (!found) reads.set(from, (found = [[], []]));
      found[0].push(tag);
      if (!found[1].includes(part)) found[1].push(part);
    }
  }
  for (const [from, [tags, parts]] of reads) readPart(from, tags, parts, apply, signalOf, busyBy);
}

/**
 * One read of {@link read}: fetches `from` as a part read again is (`corten: action`) and draws
 * the patch it answers. Its parts are `aria-busy` until it ends. It stops once one of them leaves
 * the page (a form's answer replaced it, a page was swapped in): its fetch ends, and its answer
 * is not drawn over what is there now. Every part still on the page when it ends was not drawn
 * (offline, an error page, a page, a redirect, or a patch without it, or one of its parts left):
 * it is marked `data-corten-read-failed`, where the app's CSS shows the link a browser without
 * JavaScript gets, which follows a redirect as any navigation does. A read the browser ended by
 * hiding the page (the back-forward cache) is made again once the page is shown.
 * @param {string} from @param {Element[]} tags @param {Element[]} parts @param {Apply} apply
 * @param {(el: Element) => AbortSignal} signalOf @param {WeakMap<Element, object>} busyBy
 */
async function readPart(from, tags, parts, apply, signalOf, busyBy) {
  const stop = new AbortController();
  const { signal } = stop;
  // Busy is this read's own: a submit that marks a part meanwhile keeps the mark it made.
  const mine = {};
  for (const part of parts) {
    signalOf(part).addEventListener("abort", () => stop.abort(), { signal });
    busyBy.set(part, mine);
    own.setAttribute.call(part, "aria-busy", "true");
  }
  const at = hidden;
  let again = false;
  // Settled once a part leaves, even while the answer waits for a stylesheet that never loads:
  // `apply` draws nothing once `signal` has aborted.
  const left = new Promise((resolve) => signal.addEventListener("abort", resolve));
  try {
    const res = await fetch(from, { headers: { corten: "action" }, signal });
    if (res.headers.has("corten-patch") && res.url !== "" && new URL(res.url).origin === location.origin) {
      const html = await res.text();
      await Promise.race([apply(html, signal, null, undefined, true, /** @type {Element} */ (tags[0])).catch(reportError), left]);
    } else if (res.ok && !res.headers.has("corten-location")) {
      // A success that is not a patch is the app's mistake (the route answered its page).
      console.error("corten: ReadAgain::now needs a patch from this origin, at", from, res);
    }
  } catch {
    // Offline, the server unreachable, or the body cut short: hidden meanwhile, read again.
    again = !signal.aborted && hidden !== at;
  }
  stop.abort();
  for (const part of parts) if (busyBy.get(part) === mine) own.removeAttribute.call(part, "aria-busy");
  // Made again only for the same parts: one a form's answer replaced meanwhile is not read over,
  // and the rest are marked failed, as when a part leaves while the read is on its way.
  const end = () => {
    if (again && parts.every(inPage)) readPart(from, tags, parts, apply, signalOf, busyBy);
    else for (const part of parts) if (inPage(part)) own.setAttribute.call(part, FAILED, "");
  };
  if (again && away) addEventListener("pageshow", end, { once: true });
  else end();
}
