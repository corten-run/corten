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
 * Why `read()` got no data: `status` is the answer's when it was not a success (a 404, a 503), or
 * 0 when there was none it could use (offline, the server unreachable, a redirect, or an answer
 * that is not a screen's JSON), with the error that stopped it as `cause`.
 */
export class ReadError extends Error {
  /** @param {string} url @param {number} status @param {unknown} [cause] */
  constructor(url, status, cause) {
    super(`corten: ${url} answered ${status || "nothing it could read"}`, { cause });
    this.name = "ReadError";
    /** The answer's status, or 0 when there was none it could use. @readonly */
    this.status = status;
  }
}

/**
 * The data of the screen at `url`, as its route's `req.screen` answers a data client
 * (`Accept: application/json`), typed by the route's `data = ..`. The read goes through the
 * browser's HTTP cache: an answer it keeps is asked about again with its tag, and an unchanged one
 * comes back as a 304 with no body; one still fresh (a `Public` route's `max-age`) is not asked
 * for at all. A redirect (middleware sending a signed-out visitor to sign in) is not followed, since
 * its target is not this route's data. It rejects with a `ReadError` when the answer is not a
 * success, is a redirect or is not a screen's JSON, and with `signal`'s reason once it aborts (in a handler, pass `signal`: the read is dropped
 * when the element leaves the page).
 * @template Data
 * @param {ScreenUrl<Data>} url
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Data>}
 */
export async function read(url, { signal } = {}) {
  let status = 0;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, redirect: "error", signal });
    if (res.ok) {
      /** @type {unknown} */
      const body = await res.json();
      // The envelope is checked; the data is the route's own type, which the runtime trusts.
      if (body && typeof body === "object" && "data" in body) return /** @type {Data} */ (body.data);
    } else {
      status = res.status;
      // Its body is not read: cancelled, so the connection is not held for it.
      res.body?.cancel().catch(() => {});
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new ReadError(url, 0, error);
  }
  throw new ReadError(url, status);
}
