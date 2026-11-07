// @ts-check
// Loaded by the runtime under `corten dev` only, from /corten/dev.js, which only a dev server
// serves, as written: what it reports costs a production page nothing.
import { ready } from "corten";

const CONTROLS = "input,select,textarea";
// A region a screen reader announces as it changes: the live roles and aria-live, unless
// aria-live="off" silences it (as it does a role's own politeness).
const LIVE_ROLES = ["alert", "status", "log"];
const LIVE = ':is([role="alert"],[role="status"],[role="log"],[aria-live]):not([aria-live="off"])';
/** Each control or region is reported once. @type {WeakSet<Element>} */
const reported = new WeakSet();

/** @param {Element} el */
const liveName = (el) => {
  const role = el.getAttribute("role");
  return role && LIVE_ROLES.includes(role) ? `role="${role}"` : `aria-live="${el.getAttribute("aria-live")}"`;
};

/**
 * Reports each live region in or at `root` drawn inside another (an alert in an alert, a form's
 * message inside the kit's Alert): a screen reader may announce it twice, and ARIA describes no
 * region inside a region. Draw one: a form's message as text in the alert, or a control with live
 * text of its own (a copy button) in an alert with no role.
 * @param {Element} root
 */
function nested(root) {
  for (const el of [...(root.matches(LIVE) ? [root] : []), ...root.querySelectorAll(LIVE)]) {
    const outer = el.parentElement?.closest(LIVE);
    if (!outer || reported.has(el)) continue;
    reported.add(el);
    console.error(`corten: ${el.id || el.localName} (${liveName(el)}) is a live region inside another (${liveName(outer)}), which a screen reader may announce twice: draw one`, el);
  }
}

/**
 * Whether `el` holds what the page drew, not what the user typed or chose (a patch keeps what was
 * typed, and Back restores it).
 * @param {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} el
 */
function asDrawn(el) {
  if (el instanceof HTMLSelectElement) return [...el.options].every((o) => o.selected === o.defaultSelected);
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return el.checked === el.defaultChecked;
  return el.value === el.defaultValue;
}

/**
 * Reports each control in or at `root` drawn with a value its own attributes refuse (a stored 250
 * under step="100", a count past max): it stops its form being sent until the user changes a
 * value they did not set, and nothing on the server sees it. Not a blank required field (a new
 * form), a custom error (a script's), aria-invalid (a refused form drawn again with what was
 * sent), a control in no form or in a novalidate one, or one holding what the user typed: none
 * of those is the page's value stopping a send.
 * @param {Element} root
 */
function check(root) {
  const found = /** @type {HTMLInputElement[]} */ ([...(root.matches(CONTROLS) ? [root] : []), ...root.querySelectorAll(CONTROLS)]);
  for (const el of found) {
    if (reported.has(el) || !el.willValidate || !el.form || el.form.noValidate || el.getAttribute("aria-invalid") === "true" || !asDrawn(el)) continue;
    const { valid, valueMissing, customError } = el.validity;
    if (!valid && !valueMissing && !customError) {
      reported.add(el);
      console.error(`corten: ${el.name || el.id || el.localName} is drawn with a value its own attributes refuse, so its form cannot be sent: ${el.validationMessage}`, el);
    }
  }
}

// A closed dialog or popover, which components.css keeps hidden whatever display a class gives it.
// An engine that cannot read :popover-open is checked for dialogs only.
const CLOSED = "dialog:not([open],[popover]),[popover]:not(:popover-open,dialog[open])";
const CLOSED_DIALOG = "dialog:not([open],[popover])";

/**
 * The elements in or at `root` that match `selector`.
 * @param {Element} root
 * @param {string} selector
 * @returns {Element[]}
 */
function within(root, selector) {
  try {
    return [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)];
  } catch {
    return selector === CLOSED ? within(root, CLOSED_DIALOG) : [];
  }
}

/**
 * Each style rule of the page's stylesheets that sets `display`: its selector, the condition it
 * is inside (`@media (min-width: 64rem)`, or null) and whether it is `!important`. Read again for
 * each check, as a dev server's stylesheets change; a sheet the page may not read is skipped.
 * @returns {{ selector: string, display: string, condition: string | null, important: boolean }[]}
 */
function displays() {
  /** @type {{ selector: string, display: string, condition: string | null, important: boolean }[]} */
  const found = [];
  /** @param {CSSRuleList} rules @param {string | null} condition @param {string | null} selector */
  const walk = (rules, condition, selector) => {
    for (const rule of rules) {
      const style = /** @type {CSSStyleRule} */ (rule).style;
      // A nested rule's own selector, or a nested block of declarations, which has its parent's.
      const own = rule instanceof CSSStyleRule ? rule.selectorText : selector;
      if (style && own && style.display) found.push({ selector: own, display: style.display, condition, important: style.getPropertyPriority("display") === "important" });
      const inner = /** @type {CSSGroupingRule} */ (rule).cssRules;
      if (!inner) continue;
      const at = rule instanceof CSSConditionRule ? rule.cssText.slice(0, rule.cssText.indexOf("{")).trim() : null;
      walk(inner, condition ?? at, own);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules, null, null);
    } catch {}
  }
  return found;
}

/** @param {Element} el @param {string} selector */
const matching = (el, selector) => {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
};

/**
 * Reports each closed dialog or popover in or at `root` that a rule inside a condition (`@media`,
 * `@container`, `@supports`) gives a `display`, at the viewport's width now or any other:
 * the shape of one drawn in place from a breakpoint (a filters rail that is a modal on a phone),
 * which components.css keeps hidden while it is closed, so it is simply not drawn. A look that
 * sets `display` outside a condition (a card) is the rule's own case and is not reported, nor
 * is one the app already draws with an `!important` rule of its own.
 * @param {Element} root
 */
function inPlace(root) {
  const closed = within(root, CLOSED).filter((el) => !reported.has(el));
  if (!closed.length) return;
  const rules = displays();
  for (const el of closed) {
    if (getComputedStyle(el).display !== "none") continue;
    const applies = rules.filter((r) => matching(el, r.selector));
    const drawn = applies.find((r) => r.condition && r.display !== "none");
    if (!drawn || applies.some((r) => r.important && r.display !== "none")) continue;
    reported.add(el);
    const dialog = el.localName === "dialog" && !el.hasAttribute("popover");
    // A component's file names its classes as written (`.filters`, which Corten prefixes, `.search-page__filters`).
    const cls = el.classList[0]?.split("__").pop();
    const named = cls ? "." + cls : el.localName + (el.id ? "#" + el.id : "");
    console.error(`corten: ${el.id || el.localName} is a closed ${dialog ? "dialog" : "popover"} that \`${drawn.selector}\` in \`${drawn.condition}\` gives display: ${drawn.display}, which components.css keeps hidden while it is closed: to draw it in place there, give it a rule of its own in that condition, \`${named}:not(${dialog ? "[open]" : ":popover-open"}) { display: ${drawn.display} !important }\``, el);
  }
}

/** @param {Element} root */
function checkAll(root) {
  check(root);
  nested(root);
  inPlace(root);
}

// The page once its handlers have connected (a task after `ready`, as a script's
// setCustomValidity is), then what a navigation, a patch or a live fragment draws, a task after
// it is in for the same reason.
ready.then(() =>
  setTimeout(() => {
    checkAll(document.documentElement);
    new MutationObserver((records) => {
      const drawn = new Set();
      for (const r of records) {
        if (r.type === "attributes") drawn.add(r.target);
        else for (const node of r.addedNodes) if (node instanceof Element) drawn.add(node);
      }
      setTimeout(() => {
        for (const el of drawn) if (/** @type {Element} */ (el).isConnected) checkAll(/** @type {Element} */ (el));
      });
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["value", "min", "max", "step", "role", "aria-live", "open"],
    });
  }),
);
