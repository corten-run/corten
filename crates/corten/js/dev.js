// @ts-check
// Loaded by the runtime under `corten dev` only, from /corten/dev.js, which only a dev server
// serves, as written: what it reports costs a production page nothing.
import { ready } from "corten";
import { LISTED, field, formOf, why } from "./field.js";
import { parseOn } from "./on.js";
/** @import { Arg } from "./on.js" */
// Served without bundling: use the prototypes here too, without another dev-only module.
const own = Element.prototype;
/** @param {Element} el @param {string} name */
const attrOf = (el, name) => own.getAttribute.call(el, name);
/** @param {Element} el */
const labelOf = (el) => attrOf(el, "id") || Reflect.get(own, "localName", el);

const CONTROLS = "input,select,textarea";
// A region a screen reader announces as it changes: the live roles and aria-live, unless
// aria-live="off" silences it (as it does a role's own politeness).
const LIVE_ROLES = ["alert", "status", "log"];
const LIVE = ':is([role="alert"],[role="status"],[role="log"],[aria-live]):not([aria-live="off"])';
/** Each control or region is reported once. @type {WeakSet<Element>} */
const reported = new WeakSet();

/** @param {Element} el */
const liveName = (el) => {
  const role = attrOf(el, "role");
  return role && LIVE_ROLES.includes(role) ? `role="${role}"` : `aria-live="${attrOf(el, "aria-live")}"`;
};

/**
 * Reports each live region in or at `root` drawn inside another (an alert in an alert, a form's
 * message inside the kit's Alert): a screen reader may announce it twice, and ARIA describes no
 * region inside a region. Draw one: a form's message as text in the alert, or a control with live
 * text of its own (a copy button) in an alert with no role.
 * @param {Element} root
 */
function nested(root) {
  for (const el of within(root, LIVE)) {
    const parent = /** @type {Element | null} */ (Reflect.get(Node.prototype, "parentElement", el));
    const outer = parent && own.closest.call(parent, LIVE);
    if (!outer || reported.has(el)) continue;
    reported.add(el);
    console.error(`corten: ${labelOf(el)} (${liveName(el)}) is a live region inside another (${liveName(outer)}), which a screen reader may announce twice: draw one`, el);
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
  const found = /** @type {HTMLInputElement[]} */ (within(root, CONTROLS));
  for (const el of found) {
    if (reported.has(el) || !el.willValidate || !el.form || Reflect.get(HTMLFormElement.prototype, "noValidate", el.form) || el.getAttribute("aria-invalid") === "true" || !asDrawn(el)) continue;
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
    // Through the prototypes: a form whose control is named `matches` is still a form.
    return [...(Element.prototype.matches.call(root, selector) ? [root] : []), ...Element.prototype.querySelectorAll.call(root, selector)];
  } catch {
    return selector === CLOSED ? within(root, CLOSED_DIALOG) : [];
  }
}

const MAX_SELECTOR = 1024;
const SCOPE_REF = /:scope(?![-\w\u0080-\uffff])|&/gi;
// Keep scoped composition to selector lists with no nested lists, ambiguous tokens or
// sibling escapes. A single scope reference can stand for any matching root.
const UNSUPPORTED = /[\\/'"()+~|]|::/;
const SIMPLE_PSEUDO = /:(?:is|not|where)\(\s*(?:[.#]?[-\w]+|\[[-\w]+\])\s*\)/gi;

/** @param {string} selector */
const unsupported = (selector) => UNSUPPORTED.test(selector.replace(SIMPLE_PSEUDO, ""));

/** @param {string} selector @param {string | null} parent @param {boolean} scoped */
function resolved(selector, parent, scoped) {
  if (selector.length > MAX_SELECTOR || parent === "" || scoped && unsupported(selector)) return "";
  if (parent === null) return selector;
  const anchor = `:is(${parent})`;
  let out = "";
  for (const part of scoped ? selector.split(",") : [selector]) {
    const member = part.trim();
    const parts = member.split(scoped ? SCOPE_REF : /&/g);
    const refs = parts.length - 1;
    const relative = /^[>+~]/.test(member);
    if (scoped && (refs > 1 || refs && relative)) return "";
    const length = refs ? parts.reduce((n, p) => n + p.length, refs * anchor.length)
      : member.length + anchor.length + (scoped || relative ? 1 : 6);
    if (out.length + length + (out ? 1 : 0) > MAX_SELECTOR) return "";
    out += (out ? "," : "") + (refs ? parts.join(anchor)
      : scoped || relative ? anchor + " " + member : anchor + " :is(" + member + ")");
  }
  return out;
}

/** @type {Set<string>} */
const skipped = new Set();

/** @typedef {{ selector: string, written: string, display: string, condition: string | null, important: boolean, scoped: boolean }} Display */
/** @typedef {{ root: string, standalone: string, outer: Scope | null, limited: boolean }} Scope */
/** @typedef {{ selector: string, plain: string, scope: Scope | null }} Override */

/**
 * Read each display rule once, then match only the candidate dialogs and popovers.
 */
function displays() {
  /** @type {Display[]} */
  const found = [];
  /** @type {Override[]} */
  const possibleOverrides = [];
  /**
   * @param {CSSRuleList} rules
   * @param {string | null} condition
   * @param {string | null} selector
   * @param {string | null} written
   * @param {Scope | null} scope
   */
  const walk = (rules, condition, selector, written, scope) => {
    for (const rule of rules) {
      if (globalThis.CSSScopeRule && rule instanceof CSSScopeRule) {
        const start = rule.start;
        const standalone = start && !start.match(SCOPE_REF) ? start : "";
        const root = !start || (!scope && selector !== null) || (selector === null && !standalone)
          ? "" : resolved(start, selector, true);
        walk(rule.cssRules, condition, root, start || "@scope", { root, standalone, outer: scope, limited: !!scope?.limited || !!rule.end });
        continue;
      }
      const styled = rule instanceof CSSStyleRule;
      const style = styled || (globalThis.CSSNestedDeclarations && rule instanceof CSSNestedDeclarations) ? rule.style : null;
      const asWritten = styled ? rule.selectorText : written;
      const own = styled ? resolved(asWritten ?? "", selector, !!scope) : selector;
      if (style?.display && asWritten && own !== null) {
        const display = style.display;
        const important = style.getPropertyPriority("display") === "important";
        const skip = !own || scope?.limited;
        if (important && display !== "none") {
          const plain = !own && asWritten.length <= MAX_SELECTOR && !unsupported(asWritten) && !asWritten.match(SCOPE_REF) && !/(^|,)\s*>/.test(asWritten) ? asWritten : "";
          possibleOverrides.push({ selector: own, plain, scope });
        } else if (!skip) {
          found.push({ selector: own, written: asWritten, display, condition, important, scoped: !!scope });
        }
        if (skip && !skipped.has(asWritten)) {
          skipped.add(asWritten);
          console.warn(`corten: skipped \`${asWritten}\`: cannot compose its selector for the closed dialog and popover check`);
        }
      }
      const inner = /** @type {CSSGroupingRule} */ (rule).cssRules;
      if (!inner) continue;
      // A width (or a container's size) is a breakpoint; @supports is not, and passes its own on.
      const query = rule instanceof CSSMediaRule || (globalThis.CSSContainerRule && rule instanceof CSSContainerRule);
      walk(inner, condition ?? (query ? rule.cssText.slice(0, rule.cssText.indexOf("{")).trim() : null), scope && styled ? "" : own, asWritten, scope);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules, null, null, null, null);
    } catch {}
  }
  return { found, possibleOverrides };
}

/** @param {Element} el @param {string} selector */
const matching = (el, selector) => {
  try {
    return own.matches.call(el, selector);
  } catch {
    return null;
  }
};

/** Keep every known root when a selector cannot be composed or read. Ignore scope limits.
 * @param {Element} el @param {Scope} scope
 */
function inside(el, scope) {
  let matched = false;
  for (let bound = /** @type {Scope | null} */ (scope); bound; bound = bound.outer) {
    try {
      // A composed root already includes the outer roots.
      if (bound.root) return !!own.closest.call(el, bound.root);
    } catch {}
    if (!bound.standalone || bound.standalone === bound.root) continue;
    try {
      const root = own.closest.call(el, bound.standalone);
      if (!root) return false;
      el = root;
      matched = true;
    } catch {}
  }
  return matched;
}

/** @param {Element} el @param {Override} rule */
function couldOverride(el, { selector, plain, scope }) {
  const match = selector ? matching(el, selector) : null;
  return match ?? ((!plain || matching(el, plain) !== false) && (scope ? inside(el, scope) : !selector));
}

/**
 * Warns of each closed dialog or popover in or at `root` that components.css keeps hidden while a
 * matching rule inside `@media` or `@container` gives it a `display` (at the viewport's width now
 * or any other). That is either one drawn in place
 * from a breakpoint (a filters rail that is a modal on a phone), which is then simply not drawn,
 * or the open one's look written for a width, which is right; the page cannot tell which, so the
 * warning gives the rule for each. A look outside a query (a card) is the hidden rule's own case
 * and is not reported, nor is one the app already draws with an `!important` rule of its own
 * or one a skipped rule could draw with its own `!important` display.
 * @param {Element} root
 */
function inPlace(root) {
  // One the app hides with `hidden` is meant to be hidden, whatever its rules say.
  const closed = within(root, CLOSED).filter((el) => !reported.has(el) && !own.hasAttribute.call(el, "hidden"));
  if (!closed.length) return;
  const { found, possibleOverrides } = displays();
  for (const el of closed) {
    if (getComputedStyle(el).display !== "none") continue;
    const applies = found.filter((r) => matching(el, r.selector));
    // Hidden by components.css's rule (`dialog:where(..)`, `[popover]:where(..)`), not only the
    // browser's own, which an app's rule outranks.
    if (!applies.some((r) => r.important && r.display === "none" && /^(dialog|\[popover\]):where\(/.test(r.written))) continue;
    const drawn = applies.find((r) => r.condition && r.display !== "none");
    if (!drawn || possibleOverrides.some((r) => couldOverride(el, r))) continue;
    reported.add(el);
    const dialog = el instanceof HTMLDialogElement && !own.hasAttribute.call(el, "popover");
    const kind = dialog ? "dialog" : "popover";
    const warning = `corten: ${labelOf(el)} is a closed ${kind} that \`${drawn.written}\` in \`${drawn.condition}\` gives display: ${drawn.display}, which components.css keeps hidden while it is closed.`;
    if (drawn.scoped) {
      console.warn(warning, el);
      continue;
    }
    const state = dialog ? "[open]" : ":popover-open";
    // Not [hidden] either, so a rail the app hides with the attribute stays hidden.
    const closedState = dialog ? "[open],[hidden]" : ":popover-open,[hidden]";
    // The class as the component's file writes it (`.filters`, which Corten prefixes:
    // `.search-page__filters`), from the resolved selector.
    const cls = [...drawn.selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1] ?? "").find((c) => /** @type {DOMTokenList} */ (Reflect.get(own, "classList", el)).contains(c))?.split("__").pop();
    const id = attrOf(el, "id");
    const named = cls ? "." + cls : Reflect.get(own, "localName", el) + (id ? "#" + id : "");
    console.warn(`${warning} To draw it in place there, give it a rule of its own in that query, \`${named}:not(${closedState}) { display: ${drawn.display} !important }\`; if it is the open ${kind}'s look, write it as \`${named}${state}\``, el);
  }
}

/** Handlers whose form fields were reported. @type {WeakSet<Element>} */
const fieldsReported = new WeakSet();

/** A call's arguments, a group's fields among them. @param {Arg[]} args @returns {Arg[]} */
const flat = (args) => args.flatMap((arg) => (arg.kind === "{" ? flat(arg.fields.map(([, f]) => f)) : [arg]));

/**
 * Reports each handler in or at `root`, or in the form around it, given a form field
 * (`js::fill(f.weight)`) that its form does not have as the handler takes it: none of that name, or
 * a control of another kind (a select where it takes an input). The compiler cannot see the
 * control, which another component may draw, so this is reported when the page draws it, not on
 * the first event that calls the handler, which the runtime refuses with the same message.
 * @param {Element} root
 */
function fields(root) {
  // The calls drawn, and every call of each form a control drawn belongs to (the one around it, or
  // another it joins with `form=`, and the calls joined to that form from outside it): the control
  // can be the one such a call is given, or another of its name. Read through the prototypes, so a
  // form's control named `closest` or `getAttribute` stands in for neither.
  const calls = new Set(within(root, "[data-on]"));
  const forms = new Set([Element.prototype.closest.call(root, "form"), ...within(root, LISTED).map(formOf)]);
  for (const form of forms) {
    if (!form) continue;
    for (const el of within(form, "[data-on]")) calls.add(el);
    for (const el of /** @type {HTMLFormControlsCollection} */ (Reflect.get(HTMLFormElement.prototype, "elements", form))) {
      if (Element.prototype.hasAttribute.call(el, "data-on")) calls.add(el);
    }
  }
  for (const el of calls) {
    if (fieldsReported.has(el)) continue;
    /** @type {string[]} */
    const wrong = [];
    /** @type {ReturnType<typeof parseOn>} */
    let bound;
    try {
      bound = parseOn(Element.prototype.getAttribute.call(el, "data-on") ?? "");
    } catch {
      continue; // The runtime reports an attribute it cannot read.
    }
    for (const b of bound) {
      for (const arg of flat(b.args)) {
        if (arg.kind !== "~" || field(el, arg)) continue;
        wrong.push(why(el, arg, b));
      }
    }
    if (!wrong.length) continue;
    fieldsReported.add(el);
    console.error(`corten: ${wrong.join("; ")}`, el);
  }
}

/** @param {Element} root */
function checkAll(root) {
  check(root);
  nested(root);
  inPlace(root);
  fields(root);
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
        for (const el of drawn) if (Reflect.get(Node.prototype, "isConnected", el)) checkAll(/** @type {Element} */ (el));
      });
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      // `open` for a dialog closed after it was drawn (a <details> toggling it reruns the checks
      // too), `hidden` for one a script shows.
      attributeFilter: ["value", "min", "max", "step", "role", "aria-live", "open", "hidden"],
    });
  }),
);
