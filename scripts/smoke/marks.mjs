import http from "node:http";
import { check, again, isMark, within, opened, closeContext } from "./helpers.mjs";

/**
 * The smoke's own marks on a request (`smoke-note`, `smoke-control`, `smoke-start`,
 * `smoke-styled`: any `smoke-*`, `isMark`) never reach a server (`unmarks` in helpers.mjs). A page
 * served by a recording server here, so its fetches are same-origin and need no preflight, sends
 * marked requests through a case's page route (falling back, continuing and fetching), a context
 * route set after the guard, no route at all, the page route once removed, the context's
 * `unrouteAll` while a route it removes still holds a request (and without a `behavior`), and the
 * diagnostic replay of a request a route still holds with its marks on (`again`). Each case's
 * route sees the four marks; the server sees the requests the check sends, in order, each with
 * none of them and with its method, body and other headers as the page sent them. Requests the
 * browser makes of its own accord (a Firefox `/favicon.ico`) are not in that order, but no request
 * of any kind may reach the server with a mark.
 * @param {import("@playwright/test").Browser} browser
 */
export async function smokeMarks(browser) {
  const marks = { "smoke-note": "3", "smoke-control": "bare", "smoke-start": "12.5", "smoke-styled": "1" };
  /** @typedef {{ method: string, path: string, headers: http.IncomingHttpHeaders, body: string }} Got */
  /** What reached the server since the last check, in order. @type {Got[]} */
  const got = [];
  /** Everything that reached the server, in order, for the check that none of it carried a mark. @type {Got[]} */
  const all = [];
  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const g = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() };
      got.push(g);
      all.push(g);
      res.writeHead(200, { "content-type": req.url === "/" ? "text/html" : "text/plain" });
      res.end(req.url === "/" ? "<!doctype html><title>Marks</title>" : "ok");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  const origin = `http://127.0.0.1:${address.port}`;
  /** The paths (with their queries) the check's own fetches ask for. */
  const sent = new Set();
  /** @param {Got} g */
  const marksOf = (g) => Object.keys(g.headers).filter(isMark).sort().join(",") || "none";
  /** The check's own requests that reached the server, by method and path, each with its marks or `none`. */
  const reached = () => got.filter((g) => sent.has(g.path)).map((g) => `${g.method} ${g.path} ${marksOf(g)}`);
  /** Whether each of the check's own requests kept the page's header of its own. */
  const keptOwn = () => got.filter((g) => sent.has(g.path)).every((g) => g.headers["x-kept"] === "1");
  /** The marks each case's route saw on a request, by its path. @type {string[]} */
  const seenByRoutes = [];
  /** @param {import("@playwright/test").Request} request */
  const routeMarks = (request) => Object.keys(request.headers()).filter(isMark).sort().join(",") || "none";
  /** @param {import("@playwright/test").Route} route */
  const saw = (route) => seenByRoutes.push(`${new URL(route.request().url()).pathname}${new URL(route.request().url()).search} ${routeMarks(route.request())}`);
  /** @param {() => unknown} ready @param {string} what */
  const until = (ready, what) =>
    within(5000, `${what} within 5 s`, (async () => {
      while (!ready()) await new Promise((resolve) => setTimeout(resolve, 20));
    })());
  const allMarks = "smoke-control,smoke-note,smoke-start,smoke-styled";
  const context = await opened("the marks check's context", browser.newContext());
  try {
    const page = await within(30_000, "the marks check's page was not made within 30 s", context.newPage());
    await page.goto(`${origin}/`);
    /**
     * The page's fetch of `path` with the four marks and a header of its own, settled within `ms`.
     * @param {string} path @param {RequestInit} [init] @param {number} [ms]
     */
    const send = (path, init = {}, ms = 5000) => {
      sent.add(path);
      return within(ms, `the marks check's fetch of ${path} did not settle within ${ms / 1000} s`, page.evaluate(([path, init, marks]) => fetch(path, { ...init, headers: { ...marks, "x-kept": "1" } }).then((r) => r.text()), /** @type {const} */ ([path, init, marks])));
    };
    /** @param {import("@playwright/test").Route} route */
    const fixture = async (route) => {
      saw(route);
      const via = new URL(route.request().url()).searchParams.get("via");
      if (via === "continue") return route.continue();
      if (via === "fetch") return route.fulfill({ response: await route.fetch() });
      return route.fallback();
    };
    /** @param {import("@playwright/test").Route} route */
    const contextFixture = (route) => (saw(route), route.fallback());
    await within(5000, "the marks check's page route was not set within 5 s", page.route("**/fixture*", fixture));
    await within(5000, "the marks check's context route was not set within 5 s", context.route("**/in-context", contextFixture));
    await send("/fixture?via=fallback", { method: "POST", body: "payload" });
    await send("/fixture?via=continue");
    await send("/fixture?via=fetch");
    await send("/in-context");
    await send("/no-route");
    const posted = got.find((g) => g.path === "/fixture?via=fallback");
    check(
      "a smoke mark (smoke-*) reaches each case's route but not the server, through a fallback, continue or fetch, a context route or none",
      seenByRoutes.length === 4 &&
        seenByRoutes.every((s) => s.endsWith(` ${allMarks}`)) &&
        reached().join(" | ") === "POST /fixture?via=fallback none | GET /fixture?via=continue none | GET /fixture?via=fetch none | GET /in-context none | GET /no-route none" &&
        keptOwn() &&
        posted?.body === "payload",
      `routes saw ${JSON.stringify(seenByRoutes)}; server got ${JSON.stringify(reached())}, x-kept ${JSON.stringify(got.filter((g) => sent.has(g.path)).map((g) => g.headers["x-kept"] ?? "-"))}, posted body ${JSON.stringify(posted?.body)}`,
    );
    got.length = 0;
    await within(5000, "the marks check's page route was not removed within 5 s", page.unroute("**/fixture*", fixture));
    await within(5000, "the marks check's context route was not removed within 5 s", context.unroute("**/in-context", contextFixture));
    await send("/fixture?via=after");
    check("a smoke mark does not reach the server once the case's route is removed", reached().join(" | ") === "GET /fixture?via=after none" && keptOwn(), JSON.stringify(reached()));
    got.length = 0;
    seenByRoutes.length = 0;
    // The context's `unrouteAll` while a route it removes still holds a request: with `wait`, it
    // waits for that route, and a request sent meanwhile must still lose its marks. Then without
    // a `behavior`, which must take the case's route and leave the guard.
    /** @type {() => void} */
    let letGo = () => {};
    const holding = new Promise((resolve) => (letGo = () => resolve(undefined)));
    /** @type {import("@playwright/test").Route | undefined} */
    let waitingRoute;
    /** @param {import("@playwright/test").Route} route */
    const holdingFixture = async (route) => {
      saw(route);
      waitingRoute = route;
      await holding;
      return route.fallback();
    };
    /** @param {import("@playwright/test").Route} route */
    const plainFixture = (route) => (saw(route), route.fallback());
    /** @type {Promise<unknown> | undefined} */
    let waiting;
    /** @type {Promise<void> | undefined} */
    let clearing;
    let cleared = false;
    let duringWhileWaiting = false;
    try {
      await within(5000, "the marks check's held context route was not set within 5 s", context.route("**/waiting", holdingFixture));
      waiting = send("/waiting", {}, 15_000);
      waiting.catch(() => {});
      await until(() => waitingRoute, "the held context route did not get its request");
      clearing = context.unrouteAll({ behavior: "wait" });
      clearing.then(() => (cleared = true), () => {});
      await send("/during");
      duringWhileWaiting = !cleared;
    } finally {
      letGo();
    }
    await within(5000, "the context's unrouteAll did not end within 5 s of its held route letting go", clearing ?? Promise.resolve());
    await within(5000, "the held request did not settle within 5 s of its route letting go", (waiting ?? Promise.resolve()).then(() => undefined));
    await send("/after-all");
    await within(5000, "the marks check's plain context route was not set within 5 s", context.route("**/plain", plainFixture));
    await within(5000, "the context's unrouteAll without a behavior did not end within 5 s", context.unrouteAll());
    await send("/plain");
    check(
      "a smoke mark does not reach the server while the context's unrouteAll waits for a route it removed, or after it",
      duringWhileWaiting &&
        seenByRoutes.join(" | ") === `/waiting ${allMarks}` &&
        reached().join(" | ") === "GET /during none | GET /waiting none | GET /after-all none | GET /plain none" &&
        keptOwn(),
      `${duringWhileWaiting ? "" : "the request meant for while unrouteAll waited was sent after it ended; "}routes saw ${JSON.stringify(seenByRoutes)}; server got ${JSON.stringify(reached())}`,
    );
    got.length = 0;
    seenByRoutes.length = 0;
    // A request a case's route still holds, its marks still on, sent again from Node with the
    // browser's headers (`again`): the replay takes them off itself, as the guard has not yet.
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = () => resolve(undefined)));
    /** @type {import("@playwright/test").Route | undefined} */
    let heldRoute;
    /** @param {import("@playwright/test").Route} route */
    const heldFixture = async (route) => {
      heldRoute = route;
      await held;
      return route.fallback();
    };
    let marksWhenRead = "not read";
    /** @type {string[]} */
    let replayed = [];
    try {
      await within(5000, "the marks check's held page route was not set within 5 s", page.route("**/held", heldFixture));
      const loading = send("/held", {}, 30_000);
      loading.catch(() => {});
      await until(() => heldRoute, "the held page route did not get its request");
      marksWhenRead = routeMarks(/** @type {import("@playwright/test").Route} */ (heldRoute).request());
      replayed = await within(15_000, "the replay did not settle within 15 s", again());
      release();
      await loading;
    } finally {
      release();
      await within(5000, "the marks check's held page route was not removed within 5 s", page.unroute("**/held", heldFixture));
    }
    check(
      "the diagnostic replay of a request still loading sends none of its smoke marks",
      marksWhenRead === allMarks && reached().join(" | ") === "GET /held none | GET /held none" && keptOwn() && replayed.some((line) => line.endsWith(` 200 ${origin}/held`)),
      `the held request carried ${marksWhenRead} as the replay read it; server got ${JSON.stringify(reached())}; replay ${JSON.stringify(replayed)}`,
    );
    const carried = all.filter((g) => marksOf(g) !== "none").map((g) => `${g.method} ${g.path} ${marksOf(g)}`);
    check("no request of any kind reaches the marks check's server with a smoke mark", carried.length === 0, JSON.stringify(carried));
  } finally {
    await closeContext(context, "the marks check's context").catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}