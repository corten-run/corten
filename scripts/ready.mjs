// @ts-check
// A smoke that loads a page before the app listens gets nothing it can use: on Docker Desktop the
// port published for a container accepts a connection and closes it unanswered until the app
// listens, which a page load reports as net::ERR_EMPTY_RESPONSE (#2140). So a smoke begins when
// the app says it is ready, as a load balancer asks it. A 503 (a dependency not answering yet), a
// refused or reset connection and an answer whose body breaks off are waited out; any other status,
// or an answer that is not HTTP, is a failure of the readiness route itself and ends the wait at once. The budget is kept by the
// monotonic clock, and no attempt or pause runs past it.
import http from "node:http";

/**
 * Waits until `base`'s `/health/ready` answers a whole 200 directly, or throws naming why not.
 * Each ask is Node's own client on a connection of its own: it neither follows nor retries anything
 * (fetch retries a 421 and reports a 101 or a 407 as a network error), and no proxy set in the
 * environment can answer for the app.
 * @param {string} base the app's plain-http origin, as CI and CONTRIBUTING run it
 * @param {{ budget?: number, now?: () => number }} [options] the budget in milliseconds and the clock
 * @returns {Promise<void>}
 */
export async function ready(base, { budget = 120_000, now = () => performance.now() } = {}) {
  /** @type {URL} */
  let url;
  try {
    url = new URL("/health/ready", base);
  } catch {
    // Node's parse error carries the input, credentials and all, so it is not passed on.
    throw new Error("/health/ready: the readiness wait was not given a URL it can read");
  }
  // Named without any credentials the base carries.
  url.username = "";
  url.password = "";
  const name = url.href;
  if (url.protocol !== "http:") throw new Error(`${name}: the readiness wait asks the app over plain http`);
  const readyBy = now() + budget;
  /** Whole milliseconds left before the budget runs out; none once it has. */
  const remaining = () => Math.max(0, Math.floor(readyBy - now()));
  /**
   * One ask: the first final status as its headers arrive, whether its body came whole, or why no
   * answer came.
   * @param {number} within
   * @returns {Promise<{ status?: number, whole: boolean, cause?: string }>}
   */
  const ask = (within) =>
    new Promise((resolve) => {
      /** @type {number | undefined} The status once its headers have come, kept whatever then ends the body. */
      let status;
      const req = http.get(url, { agent: false, signal: AbortSignal.timeout(within) });
      req.on("upgrade", (/** @type {any} */ _res, /** @type {any} */ socket) => {
        socket.destroy();
        resolve({ status: 101, whole: false });
      });
      req.on("response", (res) => {
        status = res.statusCode;
        if (status !== 200 && status !== 503) {
          res.destroy();
          resolve({ status, whole: false });
          return;
        }
        res.on("error", (e) => resolve({ status, whole: false, cause: String(/** @type {any} */ (e).code ?? e.message) }));
        res.on("aborted", () => resolve({ status, whole: false, cause: "aborted" }));
        res.on("end", () => resolve({ status, whole: res.complete, cause: res.complete ? undefined : "cut short" }));
        res.resume();
      });
      req.on("error", (e) => resolve({ status, whole: false, cause: String(/** @type {any} */ (e).code ?? e.message) }));
    });
  let last = "no answer";
  const late = () => new Error(`${name} did not answer 200 within ${budget / 1000} s (last: ${last})`);
  for (;;) {
    const left = remaining();
    if (left === 0) throw late();
    const within = Math.min(5000, left);
    const { status, whole, cause } = await ask(within);
    const after = remaining();
    const outcome =
      whole || (status !== undefined && status !== 200 && status !== 503)
        ? `${status}`
        : status === undefined
          ? String(cause)
          : `${status}, then its body broke off (${cause})`;
    // Nothing that arrives once the budget is over is read as an answer, but it is named.
    if (after === 0) {
      last = outcome;
      throw late();
    }
    // Nor once its attempt's time is over, however its abort was delayed: the attempt is asked again.
    if (left - after >= within) {
      last = `${outcome}, after its attempt's ${within / 1000} s`;
      const pause = Math.min(250, remaining());
      if (pause === 0) throw late();
      await new Promise((r) => setTimeout(r, pause));
      continue;
    }
    if (status !== undefined && status !== 200 && status !== 503) throw new Error(`${name} answered ${status}, not 200 or 503`);
    // An answer Node's HTTP parser refuses is the route's failure, not the app still starting.
    if (cause?.startsWith("HPE_")) throw new Error(`${name} answered what is not HTTP (${cause})`);
    if (whole && status === 200) return;
    last = outcome;
    const pause = Math.min(250, remaining());
    if (pause === 0) throw late();
    await new Promise((r) => setTimeout(r, pause));
  }
}
