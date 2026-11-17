// @ts-check
// The reads of the parts a page waits for (`ReadAgain::now`): a module of its own, which only a
// page that draws a part waiting loads. Its head preloads the module with the runtime, and the
// runtime imports it once that page loads, or once markup the server sent draws such a part; from
// then on it finds the parts itself, so every page's runtime carries only the few lines that start
// it. Built into dist/part.js and served beside the runtime, at `/corten/{version}/part.js`
// (docs/design.md#choice-slow-part-link).
//
// A part's link to the page with it read in is the app's markup, shown unless a read is bringing
// the part (`aria-busy`, which this module alone sets on it): without JavaScript, when this module
// does not load, and once its read has failed (`data-corten-read-failed`).

/** A part the page waits for: its tag, in the element its read's patch replaces. */
const PART_NOW = "template[data-corten-read-now][data-from]";
/** The mark of a part no read will bring, where the app's CSS may say so. */
const FAILED = "data-corten-read-failed";
// Read through Element's and Node's own, as a form's controls may shadow them.
const own = Element.prototype;
/** @param {Element} el */
const inPage = (el) => !!Reflect.get(Node.prototype, "isConnected", el);
/** @param {Element} tag */
const fromOf = (tag) => /** @type {string} */ (own.getAttribute.call(tag, "data-from"));

/**
 * The runtime's `apply`: draws the patch `html` unless `signal.aborted`, which it reads right
 * before it draws (after the patch's modules and stylesheets have loaded); `asked` is the tag of
 * the read it answers. It parses the patch as soon as it is called, before its first `await`,
 * and keeps what it parsed as its `p`: the elements it will put in the page.
 * @typedef {((html: string, signal: AbortSignal, sent: null, took: undefined, own: boolean, asked: Element) => Promise<void>) & { p?: DocumentFragment }} Apply
 */
/**
 * A read on its way: the address it is of, the tags that wait for it, the parts they are in, its
 * busy mark (its `busyBy` owner) and what stops it.
 * @typedef {{ from: string, tags: Element[], parts: Element[], mine: object, stop: AbortController }} Read
 */

/** @type {Apply} */
let draw;
/** The work that last marked each element `aria-busy` (the runtime's, shared with forms). @type {WeakMap<Element, object>} */
let busyBy;
/** @type {MutationObserver | undefined} */
let observer;
/**
 * The read each tag waits for. A layout element kept and drawn again in place (a live region)
 * keeps the tag: a tag that keeps its address keeps its read, and one whose address changed has
 * its old read stopped and the new address read.
 * @type {WeakMap<Element, Read>}
 */
const reading = new WeakMap();
/** The reads on their way, each stopped once one of its tags leaves the page. @type {Set<Read>} */
const live = new Set();
/**
 * The address each tag's read did not bring its part for: the tag is not read again for it, and
 * the part keeps its mark (a layout element drawn again in place takes the marks away). The same
 * tag with another address is read anew.
 * @type {WeakMap<Element, string>}
 */
const failed = new WeakMap();
/**
 * The tags a part's answer holds, taken from the markup `apply` parsed before any of it is in the
 * page ({@link owned}): these elements alone are marked failed rather than read, so one read's
 * answer cannot start another, and two parts whose answers each draw the other waiting do not read
 * each other without end. Any other tag is read, whatever its address and whenever it joins the
 * page: one a form's answer drew (in the same task, when it waited for the same stylesheet), one
 * that replaced a tag the part's answer drew, one a script draws as the answer is drawn (on focus
 * it moves, or as a custom element in it connects), or one at the address of a tag in a
 * template's content.
 * @type {WeakSet<Element>}
 */
const chained = new WeakSet();

/** How many times the browser has hidden the page (the back-forward cache), and whether it is now. */
let hidden = 0;
let away = false;
addEventListener("pagehide", () => {
  hidden += 1;
  away = true;
});
addEventListener("pageshow", () => (away = false));

/**
 * Starts reading the parts the page waits for, and those markup later draws (a navigation's page,
 * a form's answer, a `<corten-live>` fragment, a layout element a write's page draws again): each
 * tag's part is the element it is in, which needs an id (the patch replaces it by its id). Tags
 * that name the same address share one read, whose patch draws each of their parts. Once only:
 * the runtime calls it each time it sees such markup. A page the browser renders before it is
 * shown (Speculation Rules' prerender) reads them once it is: the server's slow read is for a page
 * someone sees.
 * @param {Apply} apply @param {WeakMap<Element, object>} busy
 */
export function start(apply, busy) {
  if (observer) return;
  // Not in lib.dom yet; a browser without it never prerenders.
  if (Reflect.get(document, "prerendering") === true) {
    document.addEventListener("prerenderingchange", () => start(apply, busy), { once: true });
    return;
  }
  draw = apply;
  busyBy = busy;
  observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributeFilter: ["data-from", "aria-busy", FAILED] });
  take(Array.from(own.querySelectorAll.call(document.documentElement, PART_NOW)));
}

/**
 * What changed in the page: tags that joined it, a tag whose address changed, and a part whose
 * marks a layout element drawn again in place took away, are taken ({@link take}); a read one of
 * whose tags left stops.
 * @param {MutationRecord[]} records
 */
function changed(records) {
  /** @type {Set<Element>} */
  const tags = new Set();
  let removed = false;
  for (const record of records) {
    const el = record.target;
    if (record.type === "attributes") {
      if (!(el instanceof Element)) continue;
      if (own.matches.call(el, PART_NOW)) tags.add(el);
      else for (const tag of Array.from(own.querySelectorAll.call(el, `:scope > ${PART_NOW}`))) tags.add(tag);
      continue;
    }
    if (record.removedNodes.length) removed = true;
    for (const node of Array.from(record.addedNodes)) {
      if (!(node instanceof Element)) continue;
      if (own.matches.call(node, PART_NOW)) tags.add(node);
      // Not a template's content: a tag there is not in the page.
      for (const tag of Array.from(own.querySelectorAll.call(node, PART_NOW))) tags.add(tag);
    }
  }
  // Its answer is for what is no longer there (a form's answer replaced its part, a page was
  // swapped in, a layout element kept in place took new children).
  if (removed) for (const read of live) if (!read.tags.every(inPage)) read.stop.abort();
  take(Array.from(tags));
}

/**
 * Reads the parts of `tags`, or marks them as they were: a tag whose read is on its way for its
 * address keeps it, and its part its busy mark; one whose read did not bring it keeps its part's
 * failed mark. A tag a part's answer drew ({@link chained}) is marked failed rather than read, once:
 * if a page later gives it another address, that one is read.
 * @param {Element[]} tags
 */
function take(tags) {
  /** @type {Map<string, [Element[], Element[]]>} */
  const reads = new Map();
  for (const tag of tags) {
    const part = tag.parentElement;
    if (!part || !inPage(tag)) continue;
    const from = fromOf(tag);
    const now = reading.get(tag);
    if (now?.from === from) {
      if (busyBy.get(part) === now.mine && !own.hasAttribute.call(part, "aria-busy")) own.setAttribute.call(part, "aria-busy", "true");
      continue;
    }
    if (now) {
      // Its address changed: the read for the old one stops, and its other tags are read again
      // (its answer would have drawn this part as it was).
      now.stop.abort();
      for (const other of now.tags) {
        if (reading.get(other) !== now) continue;
        reading.delete(other);
        if (other !== tag) tags.push(other);
      }
    }
    const ended = failed.get(tag);
    if (ended === from) {
      if (!own.hasAttribute.call(part, FAILED)) own.setAttribute.call(part, FAILED, "");
      continue;
    }
    if (ended !== undefined) failed.delete(tag), own.removeAttribute.call(part, FAILED);
    const chain = chained.delete(tag);
    if (chain || !own.hasAttribute.call(part, "id")) {
      if (!chain) console.error("corten: ReadAgain::now goes in the element its patch replaces, which needs an id", part);
      fail(tag, from);
      continue;
    }
    let found = reads.get(from);
    if (!found) reads.set(from, (found = [[], []]));
    if (!found[0].includes(tag)) found[0].push(tag);
    if (!found[1].includes(part)) found[1].push(part);
  }
  for (const [from, [tags, parts]] of reads) readPart(from, tags, parts);
}

/**
 * Takes the waiting tags in a part's answer, as `apply` parsed it and before any of it is drawn,
 * as that answer's ({@link chained}): those in its elements, and in the content of a template
 * that appends it, which goes into the page; not those in any other template's content, which
 * does not. One whose element the page has no target for is never drawn, so never taken.
 * @param {DocumentFragment | undefined} content
 */
function owned(content) {
  if (!content) return;
  const tags = Array.from(content.querySelectorAll(PART_NOW));
  for (const el of Array.from(content.children))
    if (el instanceof HTMLTemplateElement && own.hasAttribute.call(el, "data-append")) tags.push(...Array.from(el.content.querySelectorAll(PART_NOW)));
  for (const tag of tags) chained.add(tag);
}

/** Marks `tag`'s part as one no read will bring for `from`. @param {Element} tag @param {string} from */
function fail(tag, from) {
  failed.set(tag, from);
  if (tag.parentElement) own.setAttribute.call(tag.parentElement, FAILED, "");
}

/**
 * One read of {@link take}: fetches `from` as a part read again is (`corten: action`) and draws
 * the patch it answers. Its parts are `aria-busy` until it ends. It stops once one of its tags
 * leaves the page or takes another address: its fetch ends, and its answer is not drawn over what
 * is there now. That is checked as the answer is drawn, after the stylesheets it waits for, so an
 * answer drawn first in the same task (a form's, waiting for the same stylesheet) that replaced a
 * part stops it before an observer could hear of it. Every part whose tag is still on the page,
 * at the same address, when it ends was not drawn (offline, an error page, a page, a redirect, or
 * a patch without it, or another of its parts left): it is marked `data-corten-read-failed`, and
 * shows the link a browser without JavaScript gets, which follows a redirect as any navigation
 * does. A part whose tag left belongs to what replaced it, which this read does not mark. A read
 * the browser ended by hiding the page (the back-forward cache) is made again once it is shown.
 * @param {string} from @param {Element[]} tags @param {Element[]} parts
 */
async function readPart(from, tags, parts) {
  const stop = new AbortController();
  const { signal } = stop;
  /** @type {Read} */
  const read = { from, tags, parts, mine: {}, stop };
  live.add(read);
  for (const tag of tags) reading.set(tag, read);
  // Busy is this read's own: a submit that marks a part meanwhile keeps the mark it made.
  for (const part of parts) {
    busyBy.set(part, read.mine);
    own.setAttribute.call(part, "aria-busy", "true");
  }
  const at = hidden;
  let again = false;
  const here = () => tags.every((tag) => inPage(tag) && reading.get(tag) === read && fromOf(tag) === from);
  // Read by `apply` right before it draws: its answer is for what is no longer there.
  const now = /** @type {AbortSignal} */ (/** @type {unknown} */ ({ get aborted() { return signal.aborted || !here(); } }));
  // Settled once a part leaves, even while the answer waits for a stylesheet that never loads.
  const left = new Promise((resolve) => signal.addEventListener("abort", resolve));
  try {
    const res = await fetch(from, { headers: { corten: "action" }, signal });
    if (res.headers.has("corten-patch") && res.url !== "" && new URL(res.url).origin === location.origin) {
      const html = await res.text();
      if (here()) {
        // Not one an earlier call left, should this one fail before it parses.
        draw.p = undefined;
        const drawn = draw(html, now, null, undefined, true, /** @type {Element} */ (tags[0]));
        owned(draw.p);
        await Promise.race([drawn.catch(reportError), left]);
      }
    } else if (res.ok && !res.headers.has("corten-location")) {
      // A success that is not a patch is the app's mistake (the route answered its page).
      console.error("corten: ReadAgain::now needs a patch from this origin, at", from, res);
    }
  } catch {
    // Offline, the server unreachable, or the body cut short: hidden meanwhile, read again.
    again = !signal.aborted && hidden !== at;
  }
  stop.abort();
  live.delete(read);
  // Made again only for the same tags, while it is still theirs: kept busy meanwhile.
  const end = () => {
    if (again && here()) return void readPart(from, tags, parts);
    const mine = tags.filter((tag) => reading.get(tag) === read);
    for (const tag of mine) reading.delete(tag);
    for (const part of parts) if (busyBy.get(part) === read.mine) busyBy.delete(part), own.removeAttribute.call(part, "aria-busy");
    for (const tag of mine) if (inPage(tag) && fromOf(tag) === from) fail(tag, from);
  };
  if (again && away) addEventListener("pageshow", end, { once: true });
  else end();
}
