// @ts-check
// Tooltip (tooltip.rs). A button or link with `interestfor` naming a `popover="hint"` shows it on
// hover and keyboard focus where the browser has interest invokers (Chromium), which do all of
// this themselves. This does the same where the browser does not (Firefox, WebKit), and nothing
// where it does, so it can go once they all have them. One set of listeners on the document
// serves every tooltip on the page, so a control a patch adds later shows its tooltip too.

/** How long the pointer rests on a control before its tooltip shows, and how long it may be away from both before it hides, in milliseconds. */
const SHOW = 500;
const HIDE = 250;

/** The controls that show a tooltip, as `interestfor` allows. */
const CONTROL = "a[interestfor],button[interestfor],area[interestfor]";

const native = "interestForElement" in HTMLButtonElement.prototype;

/** The tooltips on the page that this script shows. @type {Set<HTMLElement>} */
const tips = new Set();
/** The document's listeners, while there is a tooltip to show. @type {AbortController | null} */
let listening = null;
/** @typedef {{ tip: HTMLElement, control: HTMLElement }} Pair */
/** The tooltip shown (or closed by Escape while its control still has the pointer or focus), and the control that showed it. @type {Pair | null} */
let shown = null;
/** The control the pointer rests on, waiting to show its tooltip. @type {Pair | null} */
let pending = null;
let showTimer = 0;
let hideTimer = 0;

/**
 * Shows `tip` for the controls that name it, where the browser does not. When the tooltip leaves
 * the page it is no longer shown, and the listeners go with the last one.
 * @param {HTMLSpanElement} tip @param {AbortSignal} signal
 */
export function connect(tip, signal) {
  if (native || signal.aborted) return;
  tips.add(tip);
  listen();
  signal.addEventListener(
    "abort",
    () => {
      tips.delete(tip);
      if (pending?.tip === tip) cancelPending();
      if (shown?.tip === tip) {
        clearTimeout(hideTimer);
        shown = null;
      }
      if (!tips.size) {
        listening?.abort();
        listening = null;
      }
    },
    { once: true },
  );
}

function listen() {
  if (listening) return;
  listening = new AbortController();
  const options = { signal: listening.signal };
  document.addEventListener("pointerover", over, options);
  document.addEventListener("pointerout", out, options);
  document.addEventListener("focusin", focused, options);
  document.addEventListener("focusout", blurred, options);
  document.addEventListener("keydown", escape, options);
}

/**
 * The control an event is in and the tooltip it names, when this script shows that tooltip.
 * @param {EventTarget | null} target
 */
function controlOf(target) {
  const control = target instanceof Element ? target.closest(CONTROL) : null;
  if (!(control instanceof HTMLElement)) return null;
  const tip = document.getElementById(control.getAttribute("interestfor") ?? "");
  return tip && tips.has(tip) ? { tip, control } : null;
}

/** Whether `node` is inside `pair`'s control or its tooltip. @param {Pair | null} pair @param {EventTarget | null} node */
const inside = (pair, node) => node instanceof Node && !!pair && (pair.control.contains(node) || pair.tip.contains(node));

/** Whether the shown tooltip's control has keyboard focus, which keeps it shown. */
const focusHolds = () => !!shown && shown.control === document.activeElement && shown.control.matches(":focus-visible");

/** @param {PointerEvent} event */
function over(event) {
  if (inside(shown, event.target)) {
    // Back on the control or onto its tooltip before it hid: it stays.
    clearTimeout(hideTimer);
    if (!inside(pending, event.target)) cancelPending();
    return;
  }
  const found = controlOf(event.target);
  if (!found || pending?.control === found.control) return;
  cancelPending();
  pending = found;
  showTimer = setTimeout(() => {
    pending = null;
    show(found);
  }, SHOW);
  // Another control's tooltip goes as it would had the pointer left for anywhere else.
  if (shown) hideLater();
}

/** @param {PointerEvent} event */
function out(event) {
  if (inside(pending, event.target) && !inside(pending, event.relatedTarget)) cancelPending();
  if (inside(shown, event.target) && !inside(shown, event.relatedTarget) && !focusHolds()) hideLater();
}

/** @param {FocusEvent} event */
function focused(event) {
  const found = controlOf(event.target);
  // Keyboard focus only: a click that focuses a button is the pointer's, which waits.
  if (!found || !found.control.matches(":focus-visible")) return;
  cancelPending();
  show(found);
}

/** @param {FocusEvent} event */
function blurred(event) {
  if (shown && event.target === shown.control) hide();
}

/** Escape closes the tooltip (the browser does, a hint being a popover) and stops one about to show. @param {KeyboardEvent} event */
function escape(event) {
  if (event.key === "Escape") cancelPending();
}

function cancelPending() {
  clearTimeout(showTimer);
  pending = null;
}

/** @param {Pair} found */
function show(found) {
  clearTimeout(hideTimer);
  if (shown && shown.tip !== found.tip) hide();
  shown = found;
  if (!found.tip.isConnected || found.tip.matches(":popover-open")) return;
  try {
    // `source` (HTML's ShowPopoverOptions) anchors it to the control; TypeScript's lib.dom does
    // not have it yet.
    /** @type {(options: { source: HTMLElement }) => void} */ (found.tip.showPopover).call(found.tip, { source: found.control });
  } catch {
    // Not a popover (the app's markup changed it): nothing to show.
  }
}

function hideLater() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, HIDE);
}

function hide() {
  clearTimeout(hideTimer);
  if (shown?.tip.matches(":popover-open")) shown.tip.hidePopover();
  shown = null;
}
