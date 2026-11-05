// @ts-check
// Loaded by the runtime under `corten dev` only, from /corten/dev.js, which only a dev server
// serves: what it reports costs a production page nothing.
import { ready } from "corten";

// A control drawn with a value its own attributes refuse (a stored 250 under step="100", a
// count past max) stops its form being sent until the user changes a value they did not set, and
// nothing on the server sees it. Checked once the page's handlers have connected (a task after
// `ready`, as a script's setCustomValidity is). Blank and required is a new form, a custom error
// is a script's, and aria-invalid a refused form drawn again with what was sent, so none of them
// is reported.
ready.then(() =>
  setTimeout(() => {
    for (const el of /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll("input,select,textarea"))) {
      const { valid, valueMissing, customError } = el.validity;
      if (el.willValidate && !valid && !valueMissing && !customError && el.getAttribute("aria-invalid") !== "true") {
        console.error(`corten: ${el.name || el.id} is drawn with a value its own attributes refuse, so its form cannot be sent: ${el.validationMessage}`, el);
      }
    }
  }),
);
