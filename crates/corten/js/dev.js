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

// CSSOM cannot contain a NUL. Mark actual scope references once, before substituting a root.
const SCOPE = "\0";
/** @param {string} selector @param {string} root */
const bindScope = (selector, root) => selector.replaceAll(SCOPE, () => root);

/**
 * A nested rule's selector as one that matches on its own: `&` is the parent's, and a selector
 * without one is inside it.
 * @param {string} selector
 * @param {string | null} parent
 * @param {boolean} scoped
 */
const resolved = (selector, parent, scoped) => {
  // CSSOM normalizes pseudo-class names. Keep strings and identifiers (including CSS escapes)
  // whole, so their colons, ampersands and commas are never read as selector syntax.
  const tokens = selector.match(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\*[\s\S]*?\*\/|(?:\\(?:[\da-f]{1,6}[ \t\n\r\f]?|[^\n\r\f])|[-\w\u0080-\uffff])+|::|[\s\S]/gi) ?? [];
  /** @type {string[][]} */
  const members = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token === "," && !depth) members.push([]);
    else members[members.length - 1]?.push(token);
    if (token === "(" || token === "[") depth++;
    if (token === ")" || token === "]") depth--;
  }
  let anchored = true;
  const text = members.map((member) => {
    let scope = false;
    const nesting = member.includes("&");
    const text = member.map((token, i) => {
      if (token === "&") return parent ? `:is(${parent})` : SCOPE;
      if (token === ":" && member[i + 1]?.toLowerCase() === "scope") {
        scope = true;
        return SCOPE;
      }
      if (token.toLowerCase() === "scope" && member[i - 1] === ":") return "";
      return token;
    }).join("");
    const relative = /^[>+~]/.test(text.trimStart());
    // Each plain member selects descendants. A leading combinator still needs an anchor when
    // :scope or & occurs later in the member.
    const anchor = parent ?? (scoped && (relative || !scope && !nesting) ? SCOPE : null);
    const result = anchor && (!nesting || relative) ? `:is(${anchor}) ${text}` : text;
    // One positive reference on the left, with only descendants (or the root itself) as
    // subjects, can match any eligible root directly. Other uses need one exact root at a time.
    const head = result.trimStart();
    const prefix = head.startsWith(`:is(${SCOPE}) `) ? `:is(${SCOPE})` : SCOPE;
    const tail = head.slice(prefix.length);
    anchored &&= head.startsWith(prefix) && !tail.includes(SCOPE) &&
      (!tail || /^[\s>]/.test(tail) && !/^[+~|]/.test(tail.trimStart()));
    return result;
  }).join(",");
  return { text, anchored };
};

/** @typedef {{ start: ReturnType<typeof resolved>, parent: Scope | null, selector: string | null }} Scope */
/** @typedef {{ selector: string, scope: Scope | null, written: string, display: string, condition: string | null, important: boolean, classes: string[] }} Display */

/**
 * Each style rule of the page's stylesheets that sets `display`: its selector (resolved, and as
 * written), the `@media` or `@container` query it is inside and whether it is
 * `!important`. Read again for each check, as a dev server's stylesheets change; a sheet the page
 * may not read is skipped.
 * @returns {Display[]}
 */
function displays() {
  /** @type {Display[]} */
  const found = [];
  /** @type {Map<Scope | null, Map<string, Scope>>} */
  const scopes = new Map();
  /**
   * @param {CSSRuleList} rules
   * @param {string | null} condition
   * @param {ReturnType<typeof resolved> | null} selector
   * @param {string | null} written
   * @param {Scope | null} scope
   */
  const walk = (rules, condition, selector, written, scope) => {
    for (const rule of rules) {
      const prelude = globalThis.CSSScopeRule && rule instanceof CSSScopeRule ? rule.start : null;
      if (prelude) {
        const start = resolved(prelude, selector?.text ?? null, !!scope);
        let siblings = scopes.get(scope);
        if (!siblings) scopes.set(scope, siblings = new Map());
        let child = siblings.get(start.text);
        if (!child) {
          const root = !scope ? ":root" : start.anchored && scope.selector ? `:is(${scope.selector})` : null;
          siblings.set(start.text, child = { start, parent: scope, selector: root ? bindScope(start.text, root) : null });
        }
        walk(/** @type {CSSScopeRule} */ (rule).cssRules, condition, null, ":scope", child);
        continue;
      }
      const style = /** @type {CSSStyleRule} */ (rule).style;
      // A nested rule's own selector, or a nested block of declarations, which has its parent's.
      const asWritten = rule instanceof CSSStyleRule ? rule.selectorText : written;
      const own = rule instanceof CSSStyleRule ? resolved(asWritten ?? "", selector?.text ?? null, !!scope) : selector ?? (scope ? { text: SCOPE, anchored: true } : null);
      if (style && own && asWritten && style.display) {
        // matches() normally binds :scope to the candidate. Unscoped rules use the document root.
        const root = !scope ? ":root" : own.anchored && scope.selector ? `:is(${scope.selector})` : null;
        const classes = [...own.text.matchAll(/\.([\w-]+)/g)].map((m) => m[1] ?? "");
        found.push({ selector: root ? bindScope(own.text, root) : own.text, scope: root ? null : scope, written: asWritten, display: style.display, condition, important: style.getPropertyPriority("display") === "important", classes });
      }
      const inner = /** @type {CSSGroupingRule} */ (rule).cssRules;
      if (!inner) continue;
      // A width (or a container's size) is a breakpoint; @supports is not, and passes its own on.
      const query = rule instanceof CSSMediaRule || (globalThis.CSSContainerRule && rule instanceof CSSContainerRule);
      walk(inner, condition ?? (query ? rule.cssText.slice(0, rule.cssText.indexOf("{")).trim() : null), rule instanceof CSSStyleRule ? own : selector, asWritten, scope);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules, null, null, null, null);
    } catch {}
  }
  return found;
}

/** @param {Element} el @param {string} selector */
function matches(el, selector) {
  try {
    return own.matches.call(el, selector);
  } catch {
    return false;
  }
}

/**
 * Match one candidate, not a scope's entire subtree. When a selector needs an exact root,
 * identify it by its position without changing the DOM or depending on unique author IDs.
 * @param {Element} el
 * @param {Map<Element, string>} positions
 */
function scopedMatches(el, positions) {
  /** @type {Map<Scope, Element[]>} */
  const cache = new Map();
  // Include the candidate itself: :scope or a declaration can match its own root.
  /** @type {Element[]} */
  const ancestors = [];
  for (let node = /** @type {Element | null} */ (el); node; node = Reflect.get(Node.prototype, "parentElement", node)) ancestors.push(node);
  const indices = new Map(ancestors.map((node, i) => [node, i]));
  /** @param {Element} node @returns {string} */
  const position = (node) => {
    const known = positions.get(node);
    if (known) return known;
    const parent = /** @type {Element | null} */ (Reflect.get(Node.prototype, "parentElement", node));
    let path = ":root";
    if (parent) {
      let index = 1;
      for (let prev = Reflect.get(own, "previousElementSibling", node); prev; prev = Reflect.get(own, "previousElementSibling", prev)) index++;
      path = `${position(parent)} > :nth-child(${index})`;
    }
    positions.set(node, path);
    return path;
  };
  /** @param {Element} target @param {string} selector @param {Element} root */
  const at = (target, selector, root) => matches(target, bindScope(selector, `:is(${position(root)})`));
  /** @param {Scope} scope @returns {Element[]} */
  const roots = (scope) => {
    const known = cache.get(scope);
    if (known) return known;
    const parents = !scope.selector && scope.parent ? roots(scope.parent) : [];
    // An ordinary nested start can match all eligible parent roots with one selector, even if
    // discovering those parents required exact matching.
    const selector = scope.selector ?? (scope.start.anchored && parents.length
      ? bindScope(scope.start.text, `:is(${parents.map(position).join(",")})`) : null);
    const found = [];
    for (const [i, node] of ancestors.entries()) {
      if (selector ? matches(node, selector) : parents.some((parent) => (indices.get(parent) ?? -1) >= i && at(node, scope.start.text, parent))) found.push(node);
    }
    cache.set(scope, found);
    return found;
  };
  /** @param {string} selector @param {Scope} scope */
  return (selector, scope) => roots(scope).some((root) => at(el, selector, root));
}

/**
 * Warns of each closed dialog or popover in or at `root` that components.css keeps hidden while a
 * rule inside `@media` or `@container` gives it a `display` (at the viewport's width now or any
 * other) with no `[open]` or `:popover-open` in its selector. That is either one drawn in place
 * from a breakpoint (a filters rail that is a modal on a phone), which is then simply not drawn,
 * or the open one's look written for a width, which is right; the page cannot tell which, so the
 * warning gives the rule for each. A look outside a query (a card) is the hidden rule's own case
 * and is not reported, nor is one the app already draws with an `!important` rule of its own.
 * @param {Element} root
 */
function inPlace(root) {
  // One the app hides with `hidden` is meant to be hidden, whatever its rules say.
  const closed = within(root, CLOSED).filter((el) => !reported.has(el) && !own.hasAttribute.call(el, "hidden"));
  if (!closed.length) return;
  const rules = displays();
  /** @type {Map<Element, string>} */
  const positions = new Map();
  for (const el of closed) {
    if (getComputedStyle(el).display !== "none") continue;
    /** @type {ReturnType<typeof scopedMatches> | undefined} */
    let scoped;
    const applies = rules.filter((rule) => rule.scope
      ? (scoped ??= scopedMatches(el, positions))(rule.selector, rule.scope)
      : matches(el, rule.selector));
    // Hidden by components.css's rule (`dialog:where(..)`, `[popover]:where(..)`), not only the
    // browser's own, which an app's rule outranks.
    if (!applies.some((r) => r.important && r.display === "none" && /^(dialog|\[popover\]):where\(/.test(r.written))) continue;
    const drawn = applies.find((r) => r.condition && r.display !== "none");
    if (!drawn || applies.some((r) => r.important && r.display !== "none")) continue;
    reported.add(el);
    const dialog = el instanceof HTMLDialogElement && !own.hasAttribute.call(el, "popover");
    const state = dialog ? "[open]" : ":popover-open";
    // Not [hidden] either, so a rail the app hides with the attribute stays hidden.
    const closedState = dialog ? "[open],[hidden]" : ":popover-open,[hidden]";
    // The class as the component's file writes it (`.filters`, which Corten prefixes:
    // `.search-page__filters`), from the rule's own selector.
    const cls = drawn.classes.find((c) => /** @type {DOMTokenList} */ (Reflect.get(own, "classList", el)).contains(c))?.split("__").pop();
    const id = attrOf(el, "id");
    const named = cls ? "." + cls : Reflect.get(own, "localName", el) + (id ? "#" + id : "");
    console.warn(`corten: ${labelOf(el)} is a closed ${dialog ? "dialog" : "popover"} that \`${drawn.written}\` in \`${drawn.condition}\` gives display: ${drawn.display}, which components.css keeps hidden while it is closed. To draw it in place there, give it a rule of its own in that query, \`${named}:not(${closedState}) { display: ${drawn.display} !important }\`; if it is the open ${dialog ? "dialog" : "popover"}'s look, write it as \`${named}${state}\``, el);
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
