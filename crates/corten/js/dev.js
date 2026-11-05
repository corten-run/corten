// @ts-check
// Loaded by the runtime under `corten dev` only, from /corten/dev.js, which only a dev server
// serves, as written: what it reports costs a production page nothing.
import { ready } from "corten";

const CONTROLS = "input,select,textarea";
/** Each control is reported once. @type {WeakSet<Element>} */
const reported = new WeakSet();

/**
 * Reports each control in or at `root` drawn with a value its own attributes refuse (a stored 250
 * under step="100", a count past max): it stops its form being sent until the user changes a
 * value they did not set, and nothing on the server sees it. Not a blank required field (a new
 * form), a custom error (a script's), aria-invalid (a refused form drawn again with what was
 * sent), a control in no form or in a novalidate one: none of those stops a send that should go.
 * @param {Element} root
 */
function check(root) {
  const found = /** @type {HTMLInputElement[]} */ ([...(root.matches(CONTROLS) ? [root] : []), ...root.querySelectorAll(CONTROLS)]);
  for (const el of found) {
    if (reported.has(el) || !el.willValidate || !el.form || el.form.noValidate || el.getAttribute("aria-invalid") === "true") continue;
    const { valid, valueMissing, customError } = el.validity;
    if (!valid && !valueMissing && !customError) {
      reported.add(el);
      console.error(`corten: ${el.name || el.id} is drawn with a value its own attributes refuse, so its form cannot be sent: ${el.validationMessage}`, el);
    }
  }
}

// The page once its handlers have connected (a task after `ready`, as a script's
// setCustomValidity is), then what a navigation, a patch or a live fragment draws, a task after
// it is in for the same reason.
ready.then(() =>
  setTimeout(() => {
    check(document.documentElement);
    new MutationObserver((records) => {
      const drawn = new Set();
      for (const r of records) {
        if (r.type === "attributes") drawn.add(r.target);
        else for (const node of r.addedNodes) if (node instanceof Element) drawn.add(node);
      }
      setTimeout(() => {
        for (const el of drawn) if (/** @type {Element} */ (el).isConnected) check(/** @type {Element} */ (el));
      });
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["value", "min", "max", "step"] });
  }),
);
