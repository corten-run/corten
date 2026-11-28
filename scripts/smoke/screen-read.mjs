import { base, engine, skip, check } from "./helpers.mjs";

export async function screenRead(browser) {
  // A script reads a screen's data with read() (corten/read), typed by its route's data = Reading:
  // the route's JSON, asked for with Accept: application/json through the browser's HTTP cache, so
  // a second read asks with the tag it kept and is answered 304, with no body. An answer that is
  // not a success rejects with a ReadError of its status, and an abort with the signal's reason.
  {
    const reader = await browser.newPage();
    /** Each read's Accept, If-None-Match and status, in order, and the tags it was answered with. @type {string[]} */
    const reads = [];
    /** @type {string[]} */
    const tags = [];
    reader.on("response", async (response) => {
      const request = response.request();
      if (new URL(request.url()).pathname !== "/smoke/reading" || request.resourceType() === "document") return;
      const headers = await request.allHeaders();
      reads.push(`${headers.accept} ${headers["if-none-match"] ?? "-"} ${response.status()}`);
      tags.push((await response.allHeaders()).etag ?? "-");
    });
    await reader.goto(`${base}/smoke/reading`);
    const readOnce = async () => {
      await reader.evaluate(() => {
        const out = document.getElementById("reader");
        if (out) out.textContent = "";
      });
      await reader.getByRole("button", { name: "Read" }).click();
      return reader
        .waitForFunction(() => document.getElementById("reader")?.textContent || null, undefined, { timeout: 5000 })
        .then((shown) => shown.jsonValue(), () => null);
    };
    const first = await readOnce();
    const second = await readOnce();
    await reader.waitForTimeout(200);
    const served = await (await reader.request.get(`${base}/smoke/reading`)).text();
    check(
      "a script's read() gets its screen's typed data from the route's JSON",
      first === "Reading 40" && second === "Reading 40" && reads.length > 0 && reads.every((r) => r.startsWith("application/json ")) && served.includes(`data-on='click:reader.show(@out,"/smoke/reading",$s)'`),
      `${first} ${second} ${JSON.stringify(reads)} ${/data-on='[^']*'/.exec(served)?.[0] ?? "no data-on"}`,
    );
    // Engines show the revalidation differently: Chromium names the tag it kept where Playwright
    // sees it and reports the 304 as the copy it kept (a 200); Firefox adds the tag below where
    // Playwright sees headers and reports the 304. Either way the server's answer to that tag is
    // checked here: a 304 with no body. Playwright's WebKit asks again without the tag (as it does
    // for the runtime's navigation fetch, examples/card-market/smoke.mjs) and gets the whole answer.
    const revalidateName = "a second read() asks with the tag the browser kept, and an unchanged answer is a 304";
    const [, named = "", status = ""] = (reads[1] ?? "").split(" ");
    const revalidated = await fetch(`${base}/smoke/reading`, { headers: { accept: "application/json", "if-none-match": tags[0] ?? "" } });
    const revalidatedBody = await revalidated.text();
    if (engine === "webkit") skip(revalidateName, "Playwright's WebKit does not revalidate a fetch it kept: it asks again without If-None-Match");
    else
      check(
        revalidateName,
        reads.length === 2 &&
          /^W\/"[0-9a-f]{16}"$/.test(tags[0] ?? "") &&
          (engine === "chromium" ? named === tags[0] : status === "304") &&
          revalidated.status === 304 &&
          revalidatedBody === "",
        `${JSON.stringify(reads)} ${JSON.stringify(tags)} ${revalidated.status} ${revalidatedBody.length}`,
      );
    const outcomes = await reader.evaluate(async () => {
      const { read, ReadError } = await import("corten/read");
      /** @param {Promise<unknown>} p */
      const settled = (p) =>
        p.then(
          () => "resolved",
          (e) => (e instanceof ReadError ? `${e.name} ${e.status}${e.redirected ? " redirected" : ""}` : e instanceof DOMException ? e.name : String(e)),
        );
      /** @param {Promise<unknown>} p */
      const cause = (p) =>
        p.then(
          () => "resolved",
          (e) => (e instanceof ReadError ? `${e.name} ${e.status} ${e.cause instanceof Error ? e.cause.name : String(e.cause)}` : String(e)),
        );
      const missing = await settled(read(/** @type {any} */ ("/smoke/reading?missing=true")));
      const moved = await settled(read(/** @type {any} */ ("/smoke/reading?moved=true")));
      const stop = new AbortController();
      const reading = read(/** @type {any} */ ("/smoke/reading"), { signal: stop.signal });
      stop.abort();
      const aborted = await settled(reading);
      const before = await settled(read(/** @type {any} */ ("/smoke/reading"), { signal: AbortSignal.abort(new Error("left")) }));
      // Two answers no server here gives, from a stand-in fetch: a 404 that arrives as the signal
      // aborts, and a success that is not a screen's JSON.
      const real = window.fetch;
      let late, bare, notJson;
      try {
        const leaving = new AbortController();
        window.fetch = async () => {
          leaving.abort();
          return new Response("", { status: 404 });
        };
        late = await settled(read(/** @type {any} */ ("/smoke/reading"), { signal: leaving.signal }));
        window.fetch = async () => new Response('{"rows":[]}', { headers: { "content-type": "application/json" } });
        bare = await cause(read(/** @type {any} */ ("/smoke/reading")));
        window.fetch = async () => new Response("<p>not JSON</p>", { headers: { "content-type": "text/html" } });
        notJson = await cause(read(/** @type {any} */ ("/smoke/reading")));
      } finally {
        window.fetch = real;
      }
      return { missing, moved, aborted, before, late, bare, notJson };
    });
    check(
      "read() rejects with a ReadError of the status when the answer is not a success, with a redirected ReadError 0 for a redirect it does not follow, with a ReadError 0 whose cause is a SyntaxError for a success that is not JSON and a TypeError for JSON that is not a screen's, and with the signal's reason once it aborts, even after a failed answer (the last three from a stand-in fetch)",
      outcomes.missing === "ReadError 404" &&
        outcomes.moved === "ReadError 0 redirected" &&
        outcomes.aborted === "AbortError" &&
        outcomes.before === "Error: left" &&
        outcomes.late === "AbortError" &&
        outcomes.bare === "ReadError 0 TypeError" &&
        outcomes.notJson === "ReadError 0 SyntaxError",
      JSON.stringify(outcomes),
    );
    await reader.close();
  }
}
