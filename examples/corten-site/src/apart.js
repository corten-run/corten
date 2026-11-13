// @ts-check
// Apart (apart.rs): the wall's three files, cut to the lines where they meet and whole behind a
// disclosure, with the names one gives another marked. Pointing at a marked name, or tapping
// it, lights every place that name appears and brings the first one into view inside the other
// files. The window is never moved: the reader stays where they are reading. The server marks one name itself, so the files read the same where this script does
// not run.

/** How a pane or the page moves to show a name: at once for a reader who asked for less motion. */
function pace() {
  return matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

/**
 * Lights every end of `seam` and no other, and shows the first one in each file but `held`,
 * the file the reader is pointing into, which stays where they have it. A file that already
 * shows the name is not moved.
 * @param {HTMLElement[]} links every marked name, named by its data-seam
 * @param {HTMLPreElement[]} panes the files @param {string} seam @param {HTMLPreElement | null} held
 * @param {HTMLDetailsElement} whole the disclosure the whole files are behind
 */
function light(links, panes, seam, held, whole) {
  for (const link of links) link.toggleAttribute("data-lit", link.dataset.seam === seam);
  const edge = 24;
  for (const pane of panes) {
    // A file behind the closed disclosure is left at its top, where it opens.
    if (pane === held || (!whole.open && whole.contains(pane))) continue;
    const first = links.find((link) => link.dataset.seam === seam && pane.contains(link));
    if (!first) continue;
    const [inner, outer] = [first.getBoundingClientRect(), pane.getBoundingClientRect()];
    const top = inner.top < outer.top || inner.bottom > outer.bottom ? inner.top - outer.top - pane.clientHeight / 2 : 0;
    const left =
      inner.left < outer.left + edge ? inner.left - outer.left - edge : inner.right > outer.right - edge ? inner.right - outer.right + edge : 0;
    if (top !== 0 || left !== 0) pane.scrollBy({ top, left, behavior: pace() });
  }
}

/**
 * @param {UIEvent} event the pointer over a name, or a click or tap on one
 * @param {HTMLElement} name the marked name it is on
 * @param {HTMLElement[]} links @param {HTMLPreElement[]} panes @param {HTMLDetailsElement} whole
 */
export function trace(event, name, links, panes, whole) {
  if (event.type !== "click") {
    // A finger on a name is scrolling until it lifts as a tap, and the tap is the click.
    if (!(event instanceof PointerEvent) || event.pointerType !== "mouse" || name.hasAttribute("data-lit")) return;
  }
  light(links, panes, name.dataset.seam ?? "", panes.find((pane) => pane.contains(name)) ?? null, whole);
}

/**
 * The buttons under the files: one name of each kind, lit in every file.
 * @param {HTMLElement[]} links @param {HTMLPreElement[]} panes @param {HTMLDetailsElement} whole @param {string} seam
 */
export function follow(links, panes, whole, seam) {
  light(links, panes, seam, null, whole);
}
