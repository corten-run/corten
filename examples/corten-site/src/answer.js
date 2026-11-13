// @ts-check
// Answer (steel.rs): reads back what this page's address is answered with. When the reader
// reaches it, it asks the address twice more, once as a browser does (a GET it reads the headers
// of and then drops the body of) and once for JSON, and writes in each header's value and the
// JSON. Both asks end with the element.
/** @import { Message } from "corten" */

/**
 * @param {HTMLOutputElement} status @param {HTMLElement[]} values each header's value, named by its data-header
 * @param {HTMLPreElement} json @param {HTMLParagraphElement} said what a screen reader is told
 * @param {HTMLParagraphElement} failed @param {string} page the page's address
 * @param {string} absent what to write for a header the response lacks @param {string} read
 * @param {Message<"status">} answered the status line @param {AbortSignal} signal
 */
async function ask(status, values, json, said, failed, page, absent, read, answered, signal) {
  try {
    const [got, data] = await Promise.all([
      fetch(page, { headers: { accept: "text/html" }, cache: "no-store", signal }),
      fetch(page, { headers: { accept: "application/json" }, cache: "no-store", signal }),
    ]);
    // The headers are all this reads: the page's body is not downloaded a second time.
    void got.body?.cancel();
    /** @type {unknown} */
    const sheet = await data.json();
    status.value = answered({ status: got.status });
    for (const value of values) value.textContent = got.headers.get(value.dataset.header ?? "") ?? absent;
    json.textContent = JSON.stringify(sheet, null, 2);
    said.textContent = read;
  } catch {
    if (!signal.aborted) failed.hidden = false;
  }
}

/**
 * Waits until the reader is near, so a page nobody scrolls costs no second request.
 * @param {HTMLElement} answer @param {HTMLOutputElement} status @param {HTMLElement[]} values
 * @param {HTMLPreElement} json @param {HTMLParagraphElement} said @param {HTMLParagraphElement} failed
 * @param {string} page @param {string} absent @param {string} read
 * @param {Message<"status">} answered @param {AbortSignal} signal
 */
export function read(answer, status, values, json, said, failed, page, absent, read, answered, signal) {
  const near = new IntersectionObserver(
    (seen) => {
      if (!seen.some((entry) => entry.isIntersecting)) return;
      near.disconnect();
      void ask(status, values, json, said, failed, page, absent, read, answered, signal);
    },
    { rootMargin: "300px" },
  );
  near.observe(answer);
  signal.addEventListener("abort", () => near.disconnect(), { once: true });
}
