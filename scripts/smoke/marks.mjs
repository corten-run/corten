import http from "node:http";
import { check, again, isMark, within, opened, closeContext } from "./helpers.mjs";

/**
 * The smoke's own marks on a request (`smoke-note`, `smoke-control`, `smoke-start`,
 * `smoke-styled`: any `smoke-*`, `isMark`) never reach a server (`unmarks` in helpers.mjs). A page
 * served by a recording server here, so its fetches are same-origin and need no preflight, sends
 * marked requests through a case's page route (falling back, continuing and fetching), a context
 * route set after the guard, no route at all, the page route once removed, and the diagnostic
 * replay of a request still loading (`again`). Each case's route sees the four marks; the server
 * sees none, and the request's method, body and other headers as the page sent them.
 * @param {import("@playwright/test").Browser} browser
 */
export async function smokeMarks(browser) {
  const marks = { "smoke-note": "3", "smoke-control": "bare", "smoke-start": "12.5", "smoke-styled": "1" };
  /** What reached the server, in order. @type {{ method: string, path: string, headers: http.IncomingHttpHeaders, body: string }[]} */
  const got = [];
  /** The answer to the first `/held`, kept back until the replay has been sent. @type {http.ServerResponse | undefined} */
  let held;
  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      got.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url === "/held" && !held) return void (held = res);
      res.writeHead(200, { "content-type": req.url === "/" ? "text/html" : "text/plain" });
      res.end(req.url === "/" ? "<!doctype html><title>Marks</title>" : "ok");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  const origin = `http://127.0.0.1:${address.port}`;
  /** The marks a request reached the server with, by its method and path, each `none` when it had none. */
  const reached = () => got.filter((g) => g.path !== "/").map((g) => `${g.method} ${g.path} ${Object.keys(g.headers).filter(isMark).sort().join(",") || "none"}`);
  /** The marks each case's route saw on a request, by its path. @type {string[]} */
  const seenByRoutes = [];
  /** @param {import("@playwright/test").Route} route */
  const saw = (route) => seenByRoutes.push(`${new URL(route.request().url()).pathname}${new URL(route.request().url()).search} ${Object.keys(route.request().headers()).filter(isMark).sort().join(",") || "none"}`);
  const context = await opened("the marks check's context", browser.newContext());
  try {
    const page = await within(30_000, "the marks check's page was not made within 30 s", context.newPage());
    await page.goto(`${origin}/`);
    /** The page's fetch of `path` with the four marks and a header of its own, settled within 5 s. @param {string} path @param {RequestInit} [init] */
    const send = (path, init = {}) =>
      within(5000, `the marks check's fetch of ${path} did not settle within 5 s`, page.evaluate(([path, init, marks]) => fetch(path, { ...init, headers: { ...marks, "x-kept": "1" } }).then((r) => r.text()), /** @type {const} */ ([path, init, marks])));
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
        seenByRoutes.every((s) => s.endsWith(" smoke-control,smoke-note,smoke-start,smoke-styled")) &&
        reached().join(" | ") === "POST /fixture?via=fallback none | GET /fixture?via=continue none | GET /fixture?via=fetch none | GET /in-context none | GET /no-route none" &&
        got.every((g) => g.path === "/" || g.headers["x-kept"] === "1") &&
        posted?.body === "payload",
      `routes saw ${JSON.stringify(seenByRoutes)}; server got ${JSON.stringify(reached())}, x-kept ${JSON.stringify(got.map((g) => g.headers["x-kept"] ?? "-"))}, posted body ${JSON.stringify(posted?.body)}`,
    );
    got.length = 0;
    await within(5000, "the marks check's page route was not removed within 5 s", page.unroute("**/fixture*", fixture));
    await within(5000, "the marks check's context route was not removed within 5 s", context.unroute("**/in-context", contextFixture));
    await send("/fixture?via=after");
    check("a smoke mark does not reach the server once the case's route is removed", reached().join(" | ") === "GET /fixture?via=after none" && got[0]?.headers["x-kept"] === "1", JSON.stringify(reached()));
    got.length = 0;
    // A request still loading, sent again from Node with the browser's headers (`again`).
    const loading = send("/held");
    await within(5000, "the held request did not reach the server within 5 s", (async () => {
      while (!held) await new Promise((resolve) => setTimeout(resolve, 20));
    })());
    const replayed = await within(15_000, "the replay did not settle within 15 s", again());
    /** @type {http.ServerResponse} */ (held).end("ok");
    await loading;
    check(
      "the diagnostic replay of a request still loading sends none of its smoke marks",
      reached().join(" | ") === "GET /held none | GET /held none" && got.every((g) => g.headers["x-kept"] === "1") && replayed.some((line) => line.endsWith(` 200 ${origin}/held`)),
      `${JSON.stringify(reached())} ${JSON.stringify(replayed)}`,
    );
  } finally {
    held?.end("ok");
    await closeContext(context, "the marks check's context").catch(() => {});
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}
