// @ts-check
// corten/read: read(), a script's typed read of a screen's data. A module of its own (built to
// js/dist/read.js), served only to apps whose scripts import it and preloaded only with them, so a
// page whose scripts read nothing does not pay for it.

/**
 * The URL of a screen whose data is `Data`: what a handler parameter
 * `@param {ScreenUrl<SetListing>} set` gets from a route whose `#[route(..)]` says
 * `data = SetListing` (Corten checks the route and its `get` handler when the crate compiles), and
 * what `read()` takes. At run time it is the URL, a string; its `"corten.data"` is a type only,
 * which no script reads.
 * @template Data
 * @typedef {string & { readonly "corten.data": Data }} ScreenUrl
 */

/**
 * Why `read()` got no data: `status` is the answer's when it was not a success (a 404, a 503, the
 * 401 Corten's sign-in refusal answers a data client), or 0 when there was none it could use. A
 * redirect, which it does not follow, is 0 with `redirected` true (one the app writes itself:
 * middleware, or an answer replaced through `DerefMut`); otherwise 0 has the error that stopped
 * it as `cause`: `fetch`'s `TypeError` offline or with the server unreachable, a `SyntaxError`
 * for a success that is not JSON, and a `TypeError` for JSON that is not `{"title", "data"}`.
 */
export class ReadError extends Error {
  name = "ReadError";
  /** The answer's status, or 0 when there was none it could use. @readonly @type {number} */
  status = 0;
  /** Whether the answer was a redirect, which `read()` does not follow (`status` 0). @readonly @type {boolean} */
  redirected = false;
  /** @param {string} url @param {number} status @param {unknown} [cause] @param {boolean} [redirected] */
  constructor(url, status, cause, redirected = false) {
    super(`corten: ${url} answered ${status || (redirected ? "a redirect" : "nothing it could read")}`, { cause });
    // Written through `ReadErrorFields`, not `this`: checked JavaScript takes a property a
    // constructor sets first as declared, so only this way is a misspelled write an error
    // (docs/design.md#choice-handlers-checked-where-called).
    /** @type {ReadErrorFields} */ (this).status = status;
    /** @type {ReadErrorFields} */ (this).redirected = redirected;
  }
}

/** The fields `ReadError`'s constructor writes, writable. @typedef {{ status: number, redirected: boolean }} ReadErrorFields */

/**
 * The data of the screen at `url`, as its route's `req.screen` answers a data client
 * (`Accept: application/json`), typed by the route's `data = ..`. The read goes through the
 * browser's HTTP cache: an answer it keeps is asked about again with its tag, and an unchanged one
 * comes back as a 304 with no body; one still fresh (a `Public` route's `max-age`) is not asked
 * for at all. A redirect (middleware of the app's sending a visitor to sign in) is not followed,
 * since its target is not this route's data: it rejects as one (`redirected`), and a script that
 * meets it can navigate to the URL, which the browser follows. It rejects with a `ReadError` when
 * the answer is not a success, is a redirect or is not a screen's JSON, and with `signal`'s
 * reason once it aborts, whatever answer came first (in a handler, pass `signal`: the read is dropped when the element
 * leaves the page).
 * @template Data
 * @param {ScreenUrl<Data>} url
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Data>}
 */
export async function read(url, { signal } = {}) {
  let status = 0;
  let redirected = false;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, redirect: "manual", signal });
    if (res.ok) {
      /** @type {unknown} */
      const body = await res.json();
      // The envelope is checked; the data is the route's own type, which the runtime trusts.
      if (body && typeof body === "object" && "data" in body) return /** @type {Data} */ (body.data);
      throw new TypeError("not a screen's JSON");
    }
    // A redirect is opaque, status 0 and no body; any other answer's body is not read, but
    // cancelled, so the connection is not held for it.
    redirected = res.type === "opaqueredirect";
    status = res.status;
    res.body?.cancel().catch(() => {});
  } catch (error) {
    signal?.throwIfAborted();
    throw new ReadError(url, 0, error);
  }
  signal?.throwIfAborted();
  throw new ReadError(url, status, undefined, redirected);
}
