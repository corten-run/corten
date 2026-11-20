import { base, check } from "./helpers.mjs";

export async function modules(browser, live, page) {
  // A module the network drops twice (the page's module script, then the runtime's import of it)
  // is imported again, so on:connect still runs its handler rather than never.
  {
    const dropped = await browser.newPage();
    let tries = 0;
    let status = null;
    // What happened when, said only when the check fails, so a failure names its cause (#1053).
    /** @type {string[]} */
    const seen = [];
    const started = Date.now();
    dropped.on("console", (m) => m.type() === "error" && seen.push(`${Date.now() - started} ms: ${m.text().slice(0, 200)}`));
    try {
      await dropped.route(
        (url) => url.pathname.endsWith("/scripts/live_prices.js"),
        (route) => {
          tries += 1;
          seen.push(`${Date.now() - started} ms: request ${tries} (${route.request().resourceType()})`);
          return tries <= 2 ? route.abort("internetdisconnected") : route.continue();
        },
      );
      await dropped.goto(base);
      // The script tag fails, then the runtime's import; it is tried again 0.5 s after the import fails.
      await dropped.waitForSelector(`${live}[data-status="live"]`, { timeout: 15_000 }).catch(() => {});
      status = await dropped.getAttribute(live, "data-status");
    } finally {
      await dropped.close();
    }
    const imported = status === "live" && tries > 2;
    check("a script module whose first two requests fail is imported again, and its on:connect handler runs", imported, `${status}, ${tries} requests${imported ? "" : `: ${seen.join("; ")}`}`);
  }
  // Corten's own modules retry the same way. Fail the format module until the runtime's import
  // rejects: a browser can make multiple requests before rejecting it. Measure the wait from
  // that failure, after which the on:connect handler that takes a format can run.
  {
    const refused = await browser.newPage();
    let failedAt;
    let retriedAt;
    let requests = 0;
    let status = null;
    try {
      refused.on("console", (m) => {
        if (m.type() === "error" && /^corten: script module .*\/corten-format\.js did not load/.test(m.text())) failedAt ??= performance.now();
      });
      await refused.route(
        (url) => url.pathname.endsWith("/scripts/corten-format.js"),
        (route) => {
          requests++;
          if (failedAt === undefined) return route.fulfill({ status: 503, body: "Service Unavailable" });
          retriedAt ??= performance.now();
          return route.continue();
        },
      );
      await refused.goto(base);
      await refused.waitForSelector(`${live}[data-status="live"]`, { timeout: 15_000 }).catch(() => {});
      status = await refused.getAttribute(live, "data-status");
    } finally {
      await refused.close();
    }
    const gap = failedAt !== undefined && retriedAt !== undefined ? retriedAt - failedAt : -1;
    check(
      "a format module that failed to import is asked for again after its wait, and the on:connect handler that takes a format runs",
      status === "live" && requests > 2 && gap >= 400,
      `${status}, ${requests} requests, ${Math.round(gap)} ms between import failure and retry`,
    );
  }
  // A link from a page with no fields to one with them: the swapped-in page waits for the field
  // module, which the runtime imports, so the first change runs its handler.
  {
    const linked = await browser.newPage();
    let filled = "";
    let stayed = false;
    let waited = false;
    let release = () => {};
    const held = new Promise((resolve) => (release = () => resolve(undefined)));
    try {
      await linked.route((url) => url.pathname.endsWith("/scripts/corten-field.js"), async (route) => {
        await held;
        await route.continue();
      });
      // /news has another shell key, so that link reloads the document and can expose the control
      // before its first-page scripts run. This case needs a swap, not a full load's readiness.
      await linked.goto(`${base}/smoke/quoted`);
      await linked.evaluate(() => {
        /** @type {any} */ (window).__fieldsDocument = true;
        document.addEventListener("corten:module", (event) => {
          if (/** @type {CustomEvent} */ (event).detail.name === "ship_form") /** @type {any} */ (window).__fieldsHandlerReady = true;
        });
        document.querySelector("main")?.insertAdjacentHTML("afterbegin", __html('<a id="to-fields" href="/smoke/fields">Fields</a>'));
      });
      const requested = linked.waitForRequest((r) => new URL(r.url()).pathname.endsWith("/scripts/corten-field.js"));
      const following = linked.click("#to-fields").then(() => null, (error) => error);
      await requested;
      // The handler's own module has run, so only its held field dependency can hold the swap.
      await linked.waitForFunction(() => /** @type {any} */ (window).__fieldsHandlerReady, undefined, { polling: 100 });
      waited = await linked.evaluate(() => !!/** @type {any} */ (window).__fieldsDocument && !document.querySelector("#ship-form select"));
      release();
      const error = await following;
      if (error) throw error;
      await linked.waitForSelector("#ship-form select", { timeout: 5000 });
      await linked.selectOption('#ship-form select[name="service"]', "air");
      filled = await linked
        .waitForFunction(() => document.querySelector("#ship-form output")?.textContent || null, undefined, { timeout: 5000 })
        .then((h) => h.jsonValue().then(String), () => "");
      stayed = await linked.evaluate(() => !!/** @type {any} */ (window).__fieldsDocument);
    } finally {
      release();
      await linked.close();
    }
    check("a link to a page whose handlers take a field loads the field module, and the first change runs its handler", waited && stayed && filled.startsWith("select,"), `waited: ${waited}, same document: ${stayed}, ${filled}`);
  }
  // The field module answered 503 while a link brings its page in (the page's preload of it and
  // the runtime's import): the swap goes ahead, a change then gets the browser's default, and once
  // the module is let through, a change after the wait asks for it again and a later one runs the
  // handler.
  {
    const refused = await browser.newPage();
    /** @type {[number, number, string][]} */
    const at = [];
    let open = false;
    let first = "";
    let later = "";
    try {
      await refused.route(
        (url) => url.pathname.endsWith("/scripts/corten-field.js"),
        (route) => {
          at.push([Date.now(), open ? 200 : 503, route.request().resourceType()]);
          return open ? route.continue() : route.fulfill({ status: 503, body: "Service Unavailable" });
        },
      );
      await refused.goto(`${base}/news`);
      await refused.evaluate(() => document.querySelector("main")?.insertAdjacentHTML("afterbegin", __html('<a id="to-fields" href="/smoke/fields">Fields</a>')));
      await refused.click("#to-fields");
      await refused.waitForSelector("#ship-form select", { timeout: 5000 });
      const output = () => refused.evaluate(() => document.querySelector("#ship-form output")?.textContent ?? "");
      await refused.selectOption('#ship-form select[name="service"]', "air");
      await refused.waitForTimeout(200);
      first = await output();
      open = true;
      for (let i = 0, deadline = Date.now() + 8000; !later && Date.now() < deadline; i += 1) {
        await refused.selectOption('#ship-form select[name="service"]', i % 2 ? "air" : "ground");
        await refused.waitForTimeout(250);
        later = await output();
      }
    } finally {
      await refused.close();
    }
    const loaded = at.findIndex(([, status]) => status === 200);
    const gap = loaded > 0 ? at[loaded][0] - at[loaded - 1][0] : -1;
    check(
      "a field module answered 503 gives a change the browser's default, is asked for again after its wait, and a later change runs the handler",
      first === "" && later.startsWith("select,") && gap >= 400,
      `first change: "${first}", later: "${later}", requests: ${at.map(([when, status, type]) => `${type} ${status} at ${when - (at[0]?.[0] ?? 0)} ms`).join(", ")}`,
    );
  }

  const prices = () => page.$$eval('[data-ref="price"]', (cells) => cells.map((c) => c.textContent));
  const before = await prices();
  await page.waitForFunction((b) => JSON.stringify([...document.querySelectorAll('[data-ref="price"]')].map((c) => c.textContent)) !== b, JSON.stringify(before), { timeout: 4000 }).catch(() => {});
  check("live patches update prices", JSON.stringify(await prices()) !== JSON.stringify(before), `${before.join(", ")} -> ${(await prices()).join(", ")}`);
  return { prices };
}
