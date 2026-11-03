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
/** The tooltip shown, or about to be, and the control that shows it. @type {{ tip: HTMLElement, control: HTMLElement } | null} */
let current = null;
let timer = 0;

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
      if (current?.tip === tip) {
        clearTimeout(timer);
        current = null;
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

/** Whether `node` is inside the tooltip shown or its control. @param {EventTarget | null} node */
const inCurrent = (node) => node instanceof Node && !!current && (current.control.contains(node) || current.tip.contains(node));

/** @param {PointerEvent} event */
function over(event) {
  if (inCurrent(event.target)) {
    // Back on the control or onto the tooltip before it hid: it stays. A tooltip waiting to show
    // keeps waiting.
    if (current?.tip.matches(":popover-open")) clearTimeout(timer);
    return;
  }
  const found = controlOf(event.target);
  if (!found) return;
  clearTimeout(timer);
  timer = setTimeout(() => show(found), SHOW);
  current = found;
}

/** @param {PointerEvent} event */
function out(event) {
  if (!current || !inCurrent(event.target) || inCurrent(event.relatedTarget)) return;
  clearTimeout(timer);
  if (current.tip.matches(":popover-open")) timer = setTimeout(hide, HIDE);
  else current = null;
}

/** @param {FocusEvent} event */
function focused(event) {
  const found = controlOf(event.target);
  // Keyboard focus only: a click that focuses a button is the pointer's, which waits.
  if (found && found.control.matches(":focus-visible")) show(found);
}

/** @param {FocusEvent} event */
function blurred(event) {
  if (current && event.target === current.control) hide();
}

/** @param {{ tip: HTMLElement, control: HTMLElement }} found */
function show(found) {
  clearTimeout(timer);
  if (current && current.tip !== found.tip) hide();
  current = found;
  if (!found.tip.isConnected || found.tip.matches(":popover-open")) return;
  try {
    // `source` (HTML's ShowPopoverOptions) anchors it to the control; TypeScript's lib.dom does
    // not have it yet.
    /** @type {(options: { source: HTMLElement }) => void} */ (found.tip.showPopover).call(found.tip, { source: found.control });
  } catch {
    // Not a popover (the app's markup changed it): nothing to show.
  }
}

function hide() {
  clearTimeout(timer);
  if (current?.tip.matches(":popover-open")) current.tip.hidePopover();
  current = null;
}
