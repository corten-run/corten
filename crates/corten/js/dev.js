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
const SCOPE_REF = /:scope(?![-\w])|&/gi;
// Only descendant and child combinators, with no references inside functions or attributes.
const SCOPE_MEMBER = /^(?:[-\w.#*\s>]|\[[-\w]+\]|:(?:is|not|where)\(\s*(?:[.#]?[-\w]+|\[[-\w]+\])\s*\)|:scope(?![-\w])|&)+$/i;

/** @param {string} selector @param {string | null} parent @param {boolean} [styleParent] */
function composed(selector, parent, styleParent = false) {
  if (selector.length > MAX_SELECTOR || /[^\x09-\x0d\x20-\x7e]/.test(selector)) return null;
  const anchor = parent && `:is(${parent})`;
  let out = "";
  for (const part of selector.split(",")) {
    const member = part.trim();
    if (!SCOPE_MEMBER.test(member)) return null;
    const refs = member.match(SCOPE_REF);
    const relative = member.startsWith(">");
    if (refs && (refs.length !== 1 || relative || !anchor || styleParent && refs[0] !== "&")) return null;
    if (relative && !anchor) return null;
    // A plain inner root needs a strict ancestor. Only an explicit reference can
    // bind to the same element; in a nested style rule & binds to that style's selector.
    const next = !anchor ? member : refs ? member.replace(SCOPE_REF, anchor) : `${anchor} ${member}`;
    out += (out ? "," : "") + next;
    if (out.length > MAX_SELECTOR) return null;
  }
  // Validate even intermediate selectors before embedding them in forgiving :is() lists.
  return CSS.supports(`selector(:is(${out}))`) ? out : null;
}

/**
 * A nested rule's selector as one that matches on its own: `&` is the parent's, and a selector
 * without one is inside it.
 * @param {string} selector
 * @param {string | null} parent
 */
const resolved = (selector, parent) => {
  if (!parent) return selector;
  if (selector.includes("&")) return selector.replaceAll("&", `:is(${parent})`);
  return /^\s*[>+~]/.test(selector) ? `:is(${parent}) ${selector}` : `:is(${parent}) :is(${selector})`;
};

/** @typedef {{ selector: string, written: string }} Selector */
/** @typedef {Selector & { display: string, condition: string | null, important: boolean, scope?: Selector }} Display */
/** @param {CSSRule} rule */
const isBreakpoint = (rule) => rule instanceof CSSMediaRule || (globalThis.CSSContainerRule && rule instanceof CSSContainerRule);
/** @param {CSSRule} rule */
const breakpoint = (rule) => isBreakpoint(rule)
  ? rule.cssText.slice(0, rule.cssText.indexOf("{")).trim()
  : null;

/** @param {CSSRuleList} rules @returns {boolean} */
function hasBreakpoint(rules) {
  try {
    for (const rule of rules) {
      if (isBreakpoint(rule)) return true;
      const inner = /** @type {CSSGroupingRule} */ (rule).cssRules;
      if (inner?.length && hasBreakpoint(inner)) return true;
    }
  } catch {}
  return false;
}

/** @param {boolean} adopted */
function* sheetRules(adopted) {
  for (const sheet of adopted ? document.adoptedStyleSheets ?? [] : document.styleSheets) {
    try {
      if (adopted) {
        const media = sheet.media.mediaText;
        if (sheet.disabled || media && !matchMedia(media).matches) continue;
      }
      const rules = sheet.cssRules;
      if (adopted && Array.prototype.some.call(rules, (/** @type {CSSRule} */ rule) => rule.type === CSSRule.NAMESPACE_RULE)) continue;
      yield rules;
    } catch {}
  }
}

// Read display rules again on each check, since a dev server's stylesheets can change.
/** @param {boolean} [adopted] @param {boolean} [linkedBreakpoint] */
function displays(adopted = false, linkedBreakpoint = false) {
  /** @type {Display[]} */
  const found = [];
  /**
   * @param {CSSRuleList} rules
   * @param {string | null} condition
   * @param {string | null} selector
   * @param {string | null} written
   * @param {Selector | null} [scope]
   */
  const walk = (rules, condition, selector, written, scope) => {
    for (const rule of rules) {
      if (rule.type === CSSRule.NAMESPACE_RULE) scope = null;
      const style = /** @type {CSSStyleRule} */ (rule).style;
      // A nested rule's own selector, or a nested block of declarations, which has its parent's.
      const styled = rule instanceof CSSStyleRule;
      const asWritten = styled ? rule.selectorText : written;
      let own = selector;
      if (styled && asWritten) {
        if (!adopted || scope) own = resolved(asWritten, selector);
        else if (selector) own = composed(asWritten, selector, true);
        else own = asWritten.search(SCOPE_REF) < 0 ? asWritten : null;
      }
      let scoped = scope;
      // undefined: unscoped; null: legacy only, including descendants.
      if (scope !== null) {
        try {
          if ((globalThis.CSSStartingStyleRule && rule instanceof CSSStartingStyleRule) ||
              (rule instanceof CSSSupportsRule && !CSS.supports(rule.conditionText))) {
            scoped = null;
          } else if (globalThis.CSSScopeRule && rule instanceof CSSScopeRule) {
            const start = rule.start;
            const root = start && !selector && rule.end === null && composed(start, scope?.selector ?? null);
            scoped = root && start ? { selector: root, written: start } : null;
          } else if (scope && styled && asWritten) {
            const child = composed(asWritten, scope.selector, selector !== null);
            scoped = child ? { selector: child, written: asWritten } : null;
          }
        } catch {
          scoped = null;
        }
      }
      // Adopted rules have no legacy fallback: do not guess at an unresolved scope or selector.
      if (adopted && (scoped === null || styled && !own && !scoped)) continue;
      const scopeDisplay = scoped && (styled || globalThis.CSSNestedDeclarations && rule instanceof CSSNestedDeclarations) ? scoped : null;
      const display = style?.display;
      if (display && (scopeDisplay || own && asWritten)) {
        const important = style.getPropertyPriority("display") === "important";
        if (!adopted || display !== "none" && (condition || important)) {
          found.push({ selector: own ?? "", written: asWritten ?? "", display, condition,
            important, scope: scopeDisplay || undefined });
        }
      }
      const inner = /** @type {CSSGroupingRule} */ (rule).cssRules;
      if (!inner) continue;
      // @media and @container mark breakpoints, whether currently active or not.
      if (adopted && !styled && !isBreakpoint(rule) &&
          !(globalThis.CSSScopeRule && rule instanceof CSSScopeRule) &&
          !(globalThis.CSSLayerBlockRule && rule instanceof CSSLayerBlockRule) &&
          !(rule instanceof CSSSupportsRule)) continue;
      walk(inner, condition ?? breakpoint(rule), own, asWritten, scoped);
    }
  };
  const sheets = sheetRules(adopted);
  // Without a linked breakpoint to override, there is nothing to resolve unless an adopted
  // sheet has a breakpoint. Check the rule tree without reading selectors or declarations.
  const readable = adopted && !linkedBreakpoint ? [...sheets] : sheets;
  if (Array.isArray(readable) && !readable.some(hasBreakpoint)) return found;
  for (const rules of readable) {
    try {
      walk(rules, null, null, null);
    } catch {}
  }
  return found;
}

/** @param {Element} el @param {string} selector */
const matching = (el, selector) => {
  try {
    return own.matches.call(el, selector);
  } catch {
    return false;
  }
};

/** @param {Element} el @param {Display[]} rules */
function scopedMatches(el, rules) {
  const applies = [];
  for (const r of rules) {
    if (r.scope) {
      try {
        if (own.matches.call(el, r.scope.selector)) applies.push({ ...r, ...r.scope, composed: true });
        continue;
      } catch {}
    }
    if (r.selector && matching(el, r.selector)) applies.push(r);
  }
  return applies;
}

/** Warn about a closed dialog or popover kept hidden despite a breakpoint display. @param {Element} root */
function inPlace(root) {
  // One the app hides with `hidden` is meant to be hidden, whatever its rules say.
  const closed = within(root, CLOSED).filter((el) => {
    if (reported.has(el) || own.hasAttribute.call(el, "hidden")) return false;
    try {
      return getComputedStyle(el).display === "none";
    } catch {
      return false;
    }
  });
  if (!closed.length) return;
  const rules = displays();
  const linkedBreakpoint = rules.some((r) => r.condition && r.display !== "none");
  const adopted = displays(true, linkedBreakpoint);
  if (!linkedBreakpoint && !adopted.some((r) => r.condition)) return;
  const scoped = rules.some((r) => r.scope);
  for (const el of closed) {
    const linked = scoped ? scopedMatches(el, rules) : rules.filter((r) => matching(el, r.selector));
    // Hidden by components.css's rule (`dialog:where(..)`, `[popover]:where(..)`), not only the
    // browser's own, which an app's rule outranks.
    if (!linked.some((r) => r.important && r.display === "none" && /^(dialog|\[popover\]):where\(/.test(r.written))) continue;
    // In .card, a breakpoint .rail display can go unwarned if `@scope (.card) { & > * { display:grid !important } }` matches but loses.
    // A .card scope's .rail:not(.gone,.pending) display can warn outside .card and .other despite a .other scope's .rail !important.
    if (linked.some((r) => r.important && r.display !== "none")) continue;
    const linkedDrawn = linked.find((r) => r.condition && r.display !== "none");
    const matches = adopted.filter((r) => matching(el, r.scope?.selector ?? r.selector));
    const drawn = linkedDrawn ?? matches.find((r) => r.condition);
    if (!drawn || matches.some((r) => r.important)) continue;
    reported.add(el);
    const dialog = el instanceof HTMLDialogElement && !own.hasAttribute.call(el, "popover");
    const kind = dialog ? "dialog" : "popover";
    const message = `corten: ${labelOf(el)} is a closed ${kind} that \`${drawn.written}\` in \`${drawn.condition}\` gives display: ${drawn.display}, which components.css keeps hidden while it is closed.`;
    if ("composed" in drawn || !linkedDrawn) {
      console.warn(message, el);
      continue;
    }
    const state = dialog ? "[open]" : ":popover-open";
    // Not [hidden] either, so a rail the app hides with the attribute stays hidden.
    const closedState = dialog ? "[open],[hidden]" : ":popover-open,[hidden]";
    // The class as the component's file writes it (`.filters`, which Corten prefixes:
    // `.search-page__filters`), from the rule's own selector.
    const cls = [...drawn.selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1] ?? "").find((c) => /** @type {DOMTokenList} */ (Reflect.get(own, "classList", el)).contains(c))?.split("__").pop();
    const id = attrOf(el, "id");
    const named = cls ? "." + cls : Reflect.get(own, "localName", el) + (id ? "#" + id : "");
    console.warn(`${message} To draw it in place there, give it a rule of its own in that query, \`${named}:not(${closedState}) { display: ${drawn.display} !important }\`; if it is the open ${kind}'s look, write it as \`${named}${state}\``, el);
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
