import { engine, check } from "./helpers.mjs";
import { liveRegion } from "./live-region.mjs";

export async function liveRegionControls(browser, report = check) {
  const page = await browser.newPage();
  try {
    for (const [name, ancestor, region, afterRole, expected, afterText = "After"] of [
      ["an already rendered status accepts a replacement message", "", 'role="status"', "status", true],
      ["a role added with the message does not count as a live region", "", "", "status", false],
      ["an ancestor unhidden with the message does not count as rendered", "hidden", 'role="status"', "status", false],
      ["aria-hidden removed with the update does not count as exposed", "", 'role="status" aria-hidden="true"', "status", false],
      ["an aria-hidden ancestor hides its live region", 'aria-hidden="true"', 'role="status" aria-hidden="false"', "status", false],
      ["inert removed from the region with the update does not count as exposed", "", 'role="status" inert', "status", false],
      ["inert removed from an ancestor with the update does not count as exposed", "inert", 'role="status"', "status", false],
      ["aria-live off overrides the status role", "", 'role="status" aria-live="off"', "status", false],
      ["the region must keep its live semantics", "", 'role="log"', "status", false],
      ["a known action can replace the message without changing its text", "", 'role="alert"', "alert", true, "Before"],
    ]) {
      await page.setContent(`<div ${ancestor}><div ${region}><p id="message">Before</p></div></div>`);
      const { text, stayed } = await liveRegion(page, "message");
      await page.locator("#message").evaluate((message, { afterRole, afterText }) => {
        const region = message.parentElement;
        for (const element of [region, region.parentElement]) {
          for (const attribute of ["hidden", "aria-hidden", "inert"]) element.removeAttribute(attribute);
        }
        region.setAttribute("role", afterRole);
        const replacement = message.cloneNode();
        replacement.textContent = afterText;
        message.replaceWith(replacement);
      }, { afterRole, afterText });
      report(name, (await stayed()) === expected && text === "Before");
    }

    for (const inside of [false, true]) {
      const status = '<div role="status"><p id="message">Before</p></div>';
      await page.setContent(inside ? `<dialog>${status}</dialog>` : `${status}<dialog></dialog>`);
      await page.locator("dialog").evaluate((dialog) => dialog.showModal());
      const { stayed } = await liveRegion(page, "message");
      if (!inside) await page.locator("dialog").evaluate((dialog) => dialog.close());
      await replaceMessage(page, "message", "After");
      report(inside ? "a live region inside the modal is exposed" : "a live region behind the modal is not exposed",
        (await stayed()) === inside);
    }

    for (const [name, markup] of [
      ["opening details with the patch does not expose the original status", "<details><summary>Details</summary>STATUS</details>"],
      ["revealing content-visibility with the patch does not expose the original status", '<div style="content-visibility:hidden">STATUS</div>'],
    ]) {
      await page.setContent(markup.replace("STATUS", '<div role="status"><p id="message">Before</p></div>'));
      const { stayed } = await liveRegion(page, "message");
      await page.locator("#message").evaluate((message) => {
        const details = document.querySelector("details");
        if (details) details.open = true;
        else document.querySelector("[style]").removeAttribute("style");
        const replacement = message.cloneNode();
        replacement.textContent = "After";
        message.replaceWith(replacement);
      });
      report(name, !(await stayed()));
    }

    for (const [name, markup, expected] of [
      ["closing a modal after a patch does not expose the patch retroactively", "STATUS<dialog></dialog>", false],
      ["closing a modal before a patch exposes the status again", "STATUS<dialog></dialog>", true],
      ["opening details after a patch does not expose the patch retroactively", "<details open><summary>Details</summary>STATUS</details>", false],
    ]) {
      await page.setContent(markup.replace("STATUS", '<div role="status"><p id="message">Before</p></div>'));
      const { stayed } = await liveRegion(page, "message");
      await page.locator("#message").evaluate((message, revealFirst) => {
        const dialog = document.querySelector("dialog");
        const details = document.querySelector("details");
        if (dialog) dialog.showModal();
        if (details) details.open = false;
        if (revealFirst) dialog.close();
        const replacement = message.cloneNode();
        replacement.textContent = "After";
        message.replaceWith(replacement);
        if (!revealFirst) dialog?.close();
        if (details) details.open = true;
      }, expected);
      report(name, (await stayed()) === expected);
    }

    await page.setContent('<div role="status"><p id="message">Before</p></div>');
    const fleeting = await liveRegion(page, "message");
    await page.evaluate(async () => {
      const message = document.getElementById("message");
      const replacement = message.cloneNode();
      replacement.textContent = "Briefly";
      message.replaceWith(replacement);
      await new Promise((resolve) => setTimeout(resolve, 18));
      replacement.replaceWith(message);
    });
    report("a brief replacement is recorded even between polls", (await fleeting.changed(250)) === "Briefly");

    await page.setContent('<div aria-live="polite"><p id="message">Before</p></div>');
    const locate = page.locator.bind(page);
    const evaluateHandle = page.evaluateHandle.bind(page);
    const duringCapture = () => replaceMessage(page, "message", "During capture");
    // Place the same update between locator resolution and evaluation, or just before an atomic
    // evaluation. Only the split capture retains the now-detached message.
    page.locator = (selector, options) => {
      const locator = locate(selector, options);
      locator.evaluateHandle = async (capture, arg) => {
        const stale = await locator.elementHandle();
        try {
          await duringCapture();
          return await stale.evaluateHandle(capture, arg);
        } finally {
          await stale.dispose();
        }
      };
      return locator;
    };
    page.evaluateHandle = async (capture, arg) => {
      await duringCapture();
      return evaluateHandle(capture, arg);
    };
    try {
      const { text, stayed } = await liveRegion(page, "message");
      await replaceMessage(page, "message", "After");
      report("capture sees the connected message even when a replacement arrives at lookup",
        await stayed() && text === "During capture", text);
    } finally {
      page.locator = locate;
      page.evaluateHandle = evaluateHandle;
    }

    await page.setContent('<corten-live aria-live="polite"><p id="last-trade">Last trade: first</p></corten-live>');
    page.evaluateHandle = async (capture, arg) => {
      const captured = await evaluateHandle(capture, arg);
      await replaceMessage(page, "last-trade", "Last trade: first");
      await page.evaluate(() => setTimeout(() => {
        const message = document.getElementById("last-trade");
        const replacement = message.cloneNode();
        replacement.textContent = "Last trade: second";
        message.replaceWith(replacement);
      }, 50));
      return captured;
    };
    await liveFragments(page, (name, ok, detail) => report(`after a same-text replacement: ${name}`, ok, detail));
  } finally {
    await page.close();
  }
}

function replaceMessage(page, id, text) {
  return page.evaluate(({ id, text }) => {
    const message = document.getElementById(id);
    const replacement = message.cloneNode();
    replacement.textContent = text;
    message.replaceWith(replacement);
  }, { id, text });
}

export async function liveFragments(page, report = check) {
  // <corten-live src>: the server streams fragments and the runtime swaps them in by id.
  const { text: firstTrade, changed } = await liveRegion(page, "last-trade");
  // Use the text from the same replacement that passed the live-region identity check.
  const nextTrade = await changed(4000);
  report("<corten-live> swaps in the fragments the server streams", nextTrade?.startsWith("Last trade: ") === true, `${firstTrade} -> ${nextTrade ?? "no qualifying replacement"}`);
  report("a trade replaces only the live region's message", nextTrade !== null);
}

export async function streamCompression(page) {
  // As this browser asks for it, a live stream is zstd or gzip, never brotli, which
  // Playwright's WebKit on Windows holds back past 16 KiB of an event until more of the stream
  // arrives (#1131); its first event decodes while the stream is open.
  // Bounded: an event held back fails the check rather than the whole run.
  const streamed = await page.evaluate(async () => {
    const stop = new AbortController();
    let text = "";
    let coding = null;
    try {
      const res = await fetch("/live/trades", { headers: { accept: "text/event-stream" }, signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15_000)]) });
      coding = res.headers.get("content-encoding");
      const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
      while (!text.includes("event: patch")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    } catch (error) {
      text += ` (${String(error)})`;
    }
    stop.abort();
    return { coding, patch: text.includes("event: patch"), seen: text.slice(-80) };
  });
  check("a live stream is zstd or gzip as the browser asks, and its first event decodes while it is open", ["zstd", "gzip"].includes(streamed.coding ?? "") && streamed.patch, JSON.stringify(streamed));
  // An event over 16 KiB followed by nothing, the case WebKit held back under brotli: it is
  // dispatched with the stream left quiet, well inside the keepalive's 15 s, the next thing the
  // server would send (#1131). The bound is the check's, not a pause: it ends at the event. The
  // stream's status and coding are read first, so a missing route fails as one and a late event
  // says what coding held it.
  const large = await page.evaluate(async () => {
    const stop = new AbortController();
    /** @type {{ status?: number, coding?: string | null, failed?: string }} */
    let head = {};
    try {
      const answer = await fetch("/smoke/live/large", { headers: { accept: "text/event-stream" }, signal: AbortSignal.any([stop.signal, AbortSignal.timeout(15_000)]) });
      head = { status: answer.status, coding: answer.headers.get("content-encoding") };
    } catch (error) {
      return { failed: `no answer: ${String(error)}` };
    } finally {
      stop.abort();
    }
    return new Promise((done) => {
      const started = performance.now();
      const source = new EventSource("/smoke/live/large");
      const finish = (/** @type {{ size?: number, ms?: number, failed?: string }} */ result) => {
        source.close();
        clearTimeout(bound);
        done({ ...head, ...result });
      };
      const bound = setTimeout(() => finish({ failed: "no event in 5 s" }), 5000);
      source.addEventListener("error", () => finish({ failed: `stream error, readyState ${source.readyState}` }));
      source.addEventListener("patch", (event) => finish({ size: event.data.length, ms: Math.round(performance.now() - started) }));
    });
  });
  check(
    "a live event over 16 KiB with nothing after it is dispatched while the stream is quiet",
    large.status === 200 && (large.size ?? 0) > 16_384,
    JSON.stringify(large),
  );
}

export async function streamRecovery(page) {
  // <corten-live> shows its connection: connecting, live once open, reconnecting (with when it
  // dropped) when the stream breaks, closed when the server answers it with no stream.
  let flaky = 0;
  await page.route("**/live/flaky", (route) =>
    (flaky += 1) === 1
      ? route.fulfill({ status: 200, contentType: "text/event-stream", body: 'retry: 300\nevent: patch\ndata: <p id="flaky">One</p>\n\n' })
      : route.fulfill({ status: 204, body: "" }),
  );
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__liveStates = [];
    w.__statusEvents = [];
    // Each change also dispatches a bubbling corten-status, which a handler takes with on:corten-status.
    document.addEventListener("corten-status", (event) => {
      const live = /** @type {Element} */ (event.target);
      if (live.id === "flaky-live") w.__statusEvents.push(`${live.getAttribute("status")}${live.hasAttribute("stale-since") ? "+stale" : ""}`);
    });
    document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<corten-live id="flaky-live" src="/live/flaky"><p id="flaky">Waiting</p></corten-live>'));
    const el = /** @type {Element} */ (document.querySelector("#flaky-live"));
    const record = () => w.__liveStates.push(`${el.getAttribute("status")}${el.hasAttribute("stale-since") ? "+stale" : ""}`);
    record();
    new MutationObserver(record).observe(el, { attributes: true, attributeFilter: ["status"] });
  });
  await page.waitForFunction(() => document.querySelector("#flaky-live")?.getAttribute("status") === "closed", null, { timeout: 5000 }).catch(() => {});
  const liveStates = await page.evaluate(() => (/** @type {any} */ (window)).__liveStates.join(" "));
  const staleSince = await page.getAttribute("#flaky-live", "stale-since");
  check(
    "<corten-live> shows connecting, live, reconnecting since it dropped, then closed",
    liveStates === "connecting live reconnecting+stale closed+stale" && !Number.isNaN(Date.parse(staleSince ?? "")) && (await page.textContent("#flaky")) === "One",
    `${liveStates}; stale since ${staleSince}`,
  );
  const statusEvents = await page.evaluate(() => (/** @type {any} */ (window)).__statusEvents.join(" "));
  check("each status change dispatches a bubbling corten-status", statusEvents === liveStates, `${statusEvents} against ${liveStates}`);
  await page.evaluate(() => document.querySelector("#flaky-live")?.remove());
  await page.unroute("**/live/flaky");

  // A <corten-live since> sends the page's cursor on its first connection; a fragment's id is the
  // cursor a reconnect sends back as Last-Event-ID, so the stream resumes there.
  /** @type {{ since: string | null, last: string | null }[]} */
  const resumes = [];
  await page.route("**/live/resume*", async (route) => {
    const req = route.request();
    resumes.push({ since: new URL(req.url()).searchParams.get("since"), last: (await req.allHeaders())["last-event-id"] ?? null });
    // The first answer ends without `end`, as a server that shuts down does: the browser reconnects.
    const body =
      resumes.length === 1
        ? 'retry: 100\n\nevent: patch\nid: c8\ndata: <p id="resume">At 8</p>\n\n'
        : 'event: patch\nid: c9\ndata: <p id="resume">At 9</p>\n\nevent: end\ndata: end\n\n';
    return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body });
  });
  await page.evaluate(() =>
    document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<corten-live id="resume-live" src="/live/resume" since="c7"><p id="resume">At 7</p></corten-live>')),
  );
  await page.waitForFunction(() => document.querySelector("#resume")?.textContent === "At 9", null, { timeout: 8000 }).catch(() => {});
  // Chromium adds Last-Event-ID below what Playwright's routing sees (a real server gets it, the
  // same as from the other two), so there the check is that the stream reconnected and went on.
  const headerSeen = engine !== "chromium";
  check(
    "<corten-live since> starts from the page's cursor and resumes from the last fragment's",
    (await page.textContent("#resume")) === "At 9" &&
      resumes.length === 2 &&
      resumes[0].since === "c7" &&
      resumes[0].last === null &&
      (!headerSeen || resumes[1].last === "c8"),
    JSON.stringify(resumes),
  );
  await page.evaluate(() => document.querySelector("#resume-live")?.remove());
}
