import { base, engine, skip, check, steps, within } from "./helpers.mjs";
import { liveRegion } from "./live-region.mjs";

export async function patchUploads(errors, page, part) {
  const errorsBeforeUpload = errors.length;
  let uploadStatus = 422;
  let uploadTaken = ' class="taken"';
  /** @type {Promise<void>} */
  let uploadHeld = Promise.resolve();
  await page.route("**/upload-test", async (route) => {
    const body = part(uploadStatus === 422 ? ' class="refused"' : uploadTaken);
    await uploadHeld;
    await route.fulfill({ status: uploadStatus, headers: { "corten-patch": "1", "content-type": "text/html; charset=utf-8" }, body }).catch(() => {});
  });
  await page.setInputFiles("#upload [name=photo]", { name: "card.png", mimeType: "image/png", buffer: Buffer.from("png") });
  const chosenFiles = () => page.evaluate(() => Array.from(/** @type {HTMLInputElement} */ (document.querySelector("#upload [name=photo]")).files ?? [], (f) => f.name).join());
  await page.click("#upload button");
  await page.waitForSelector("#upload-part.refused", { timeout: 4000 }).catch(() => {});
  const refusedFiles = await chosenFiles();
  const markedInvalid = await page.getAttribute("#upload [name=photo]", "aria-invalid");
  await page.evaluate(async (html) => {
    const { patch } = await import("corten");
    await patch(__html(html));
  }, part(' class="live"'));
  const liveFiles = await chosenFiles();
  uploadStatus = 200;
  await page.click("#upload button");
  await page.waitForSelector("#upload-part.taken", { timeout: 4000 }).catch(() => {});
  const takenFiles = await chosenFiles();
  // A file is told by its name, size and time, as a pending submit's key tells it: another file of
  // the same name chosen while the answer that takes the first is on its way is the user's new
  // choice and stays, where the same file chosen again goes with the answer.
  /** Sets the input's file to card.png of `text`, last modified at 1. @param {string} text */
  const pickPhoto = (text) =>
    page.evaluate((text) => {
      const files = new DataTransfer();
      files.items.add(new File([text], "card.png", { type: "image/png", lastModified: 1 }));
      /** @type {HTMLInputElement} */ (document.querySelector("#upload [name=photo]")).files = files.files;
    }, text);
  /** Sends card.png, picks `then` while the answer is held, and gives the file left after it. @param {string} then @param {string} marker */
  const pickedWhileOut = async (then, marker) => {
    uploadTaken = ` class="${marker}"`;
    /** @type {() => void} */
    let answer = () => {};
    uploadHeld = new Promise((resolve) => (answer = resolve));
    await pickPhoto("png");
    await page.click("#upload button");
    await pickPhoto(then);
    answer();
    await page.waitForSelector(`#upload-part.${marker}`, { timeout: 4000 }).catch(() => {});
    return page.evaluate(() => Array.from(/** @type {HTMLInputElement} */ (document.querySelector("#upload [name=photo]")).files ?? [], (f) => `${f.name} ${f.size}`).join());
  };
  const otherKept = await pickedWhileOut("another png", "taken-other");
  const sameTaken = await pickedWhileOut("png", "taken-same");
  uploadHeld = Promise.resolve();
  await page.unroute("**/upload-test");
  await page.evaluate(() => document.querySelector("#upload")?.remove());
  // The refusal is a 422 on purpose; the browser logs that as a failed resource.
  errors.splice(errorsBeforeUpload, Infinity, ...errors.slice(errorsBeforeUpload).filter((e) => !e.includes("422")));
  check(
    "a patch keeps a file input's chosen files until the answer that took them",
    refusedFiles === "card.png" && markedInvalid === "true" && liveFiles === "card.png" && takenFiles === "",
    JSON.stringify({ refusedFiles, markedInvalid, liveFiles, takenFiles }),
  );
  check(
    "the answer that took a file keeps another of the same name chosen while it was on its way, and takes the same file chosen again",
    otherKept === "card.png 11" && sameTaken === "",
    JSON.stringify({ otherKept, sameTaken }),
  );
}

export async function uploads(page, live, errors, signsIn) {
  // A multipart form is sent as FormData. /watch reads a URL-encoded form, so `Form` rejects it with
  // plain text, which a browser never sees: it gets the app's error page.
  await page.waitForSelector(`${live}[data-status="live"]`, { timeout: 5000 }).catch(() => {});
  /** @type {import("@playwright/test").Request[]} */
  const posts = [];
  const watch = new URL("/watch", base).href;
  await page.evaluate(() =>
    document.querySelector("main")?.insertAdjacentHTML(
      "beforeend",
      __html('<form id="multipart" method="post" action="/watch" enctype="multipart/form-data" data-patch><input type="hidden" name="id" value="ACME"><button>Watch</button></form>'),
    ),
  );
  const onRequest = (/** @type {import("@playwright/test").Request} */ r) => {
    if (r.method() === "POST" && r.url() === watch) posts.push(r);
  };
  page.on("request", onRequest);
  try {
    const press = steps(5000, "5 s from the multipart press elapsed");
    let phase = "press the multipart button";
    try {
      await press.step(() => page.locator("#multipart button").evaluate((button) => /** @type {HTMLButtonElement} */ (button).click(), undefined, { timeout: 5000 }));
      phase = "observe POST /watch";
      await press.poll(async () => posts.length !== 0);
    } catch (error) {
      throw new Error(phase + ": " + String(error).split("\n")[0]);
    }
    const draw = steps(5000, "multipart form: POST arrived but its error page was not drawn within 5 s");
    const answer = await draw.step(() => posts[0].response());
    const errorPage = await draw.poll(() => page.evaluate(() => document.title === "Something went wrong | Watchlist" && document.querySelector("main h1")?.textContent === "Something went wrong"));
    const types = posts.map((r) => r.headers()["content-type"] ?? "");
    const action = posts.length === 1 && !posts[0].isNavigationRequest() && posts[0].headers().corten === "action";
    check("a multipart form is posted as multipart/form-data", action && types[0].startsWith("multipart/form-data"), `action=${action}, ${types.join()}`);
    check("a request the server rejects shows the app's error page, in its layout", answer?.status() === 415 && errorPage, "HTTP " + answer?.status());
  } finally {
    page.off("request", onRequest);
  }

  // A form with a file, read as it arrives in each engine's multipart body: the account page's
  // picture. Its type is read from its bytes, and the answer shows it in the header and on the
  // page, from a URL every cache keeps. WebKit does not send its sign-in's Secure cookie back over
  // http, so it signs in through the API and is given the session's token in a cookie it does.
  const errorsBefore = errors.length;
  if (!signsIn) {
    const signedIn = await page.request.post(`${base}/sign-in`, { headers: { origin: base }, maxRedirects: 0 });
    const token = /^session=([0-9a-f]{32});/.exec(signedIn.headers()["set-cookie"] ?? "")?.[1] ?? "";
    check("WebKit signs in through the route", token.length === 32, String(signedIn.status()));
    await page.context().addCookies([{ name: "session", value: token, url: base }]);
  }
  await page.goto(`${base}/account`);
  /**
   * A route handler for the picture's uploads, the account page's own form posting back to it:
   * `answer` takes each POST, and the page itself (a GET) loads from the server as it would.
   * @param {(route: import("playwright").Route) => unknown} answer
   */
  const uploads = (answer) => (/** @type {import("playwright").Route} */ route) => (route.request().method() === "POST" ? answer(route) : route.fallback());
  /** The account page's address, whatever its query: its posts go to it with do=picture or do=name. @param {URL} url */
  const atAccount = (url) => url.pathname === "/account";
  /** Uploads one file with the account page's form and gives the status line's text. @param {{ name: string, mimeType: string, buffer: Buffer }} file */
  const upload = async (file) => {
    await page.evaluate(() => {
      const result = document.querySelector("#avatar-result");
      if (result) result.textContent = "";
    });
    await page.setInputFiles("main input[type=file]", [file]);
    await page.click("main form[enctype] button");
    await page.waitForFunction(() => document.querySelector("#avatar-result")?.textContent, null, { timeout: 8000 }).catch(() => {});
    return (await page.textContent("#avatar-result")) ?? "";
  };
  // A 1x1 PNG, then a line that looks like a multipart boundary, which a picture may hold.
  const png = Buffer.concat([
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"),
    Buffer.from("\r\n--png\r\n"),
  ]);
  const uploaded = await upload({ name: "card.png", mimeType: "image/png", buffer: png });
  const pictureUrl = await page
    .waitForFunction(
      () => {
        const img = document.querySelector("#viewer-badge img");
        const big = document.querySelector("#account-picture img");
        return img instanceof HTMLImageElement && img.complete && img.naturalWidth === 1 && big?.getAttribute("src") === img.getAttribute("src") ? img.getAttribute("src") : null;
      },
      null,
      { timeout: 5000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => null);
  check("an uploaded picture is read as it arrives and shown in the header and on the page", uploaded === "Saved card.png as your picture." && /^\/pictures\/[0-9a-f]{32}$/.test(pictureUrl ?? ""), `${uploaded}, ${pictureUrl}`);
  const served = await fetch(new URL(pictureUrl ?? "/pictures/none", base));
  check(
    "a picture is served as its type, at a URL every cache keeps",
    served.headers.get("content-type") === "image/png" && served.headers.get("cache-control") === "public, max-age=31536000, immutable",
    `${served.status} ${served.headers.get("content-type")} ${served.headers.get("cache-control")}`,
  );
  const page_ = await upload({ name: "page.png", mimeType: "image/png", buffer: Buffer.from("<script>alert(1)</script>") });
  check("a file that is not a picture is refused, whatever type it says", page_.startsWith("That file is not a picture"), page_);
  const big = await upload({ name: "big.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(70 << 10, 0xff) });
  check("a picture over its limit is refused", big === "The picture is over 64 KB. Choose a smaller one.", big);
  // A picture far over its own limit, and three times the form's (1 MiB): the rest is read past and
  // not kept, so it is the picture's message, not the body's, and the browser, which sends the
  // whole picture, shows it instead of a network error.
  const over = await upload({ name: "huge.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(3 << 20, 7) });
  check("a picture far over its limit and the form's is answered with the picture's message", over === "The picture is over 64 KB. Choose a smaller one.", over);
  // A field that keeps the form over its 1 MiB, with 3 MiB more after the limit, more than a
  // socket buffers: read past, answered 413 in the form, not as a network error.
  await page.evaluate(() => {
    const note = document.createElement("input");
    note.type = "hidden";
    note.name = "note";
    note.id = "smoke-note";
    note.value = "a".repeat(4 << 20);
    document.querySelector("main form[enctype]")?.prepend(note);
  });
  const overForm = await upload({ name: "card.png", mimeType: "image/png", buffer: png });
  await page.evaluate(() => document.getElementById("smoke-note")?.remove());
  check("a form that keeps more than its limit is answered in the form", overForm === "The form is over 1 MB.", overForm);

  // The picture's form hears its upload's progress (`on:corten:progress`), so its multipart
  // writes go by XMLHttpRequest: the uploads above were answered through it. Each event is the
  // browser's ProgressEvent for the whole body, while the form is busy; the bar shows only then,
  // and the component's handler (this listener runs after it) has set its value to the share sent,
  // with none once all of it is.
  await page.evaluate(() => {
    const form = document.querySelector("main form[enctype]");
    /** @type {any} */ (window).__progress = [];
    form?.addEventListener("corten:progress", (e) => {
      const p = /** @type {ProgressEvent} */ (e);
      const bar = /** @type {HTMLProgressElement | null} */ (form.querySelector("progress"));
      const seen = {
        loaded: p.loaded,
        total: p.total,
        computable: p.lengthComputable,
        busy: form.getAttribute("aria-busy"),
        shown: bar ? getComputedStyle(bar).display !== "none" : false,
      };
      /** @type {any} */ (window).__progress.push(seen);
    });
    // What the component's handler, which runs once its module's import resolves, sets the bar to.
    /** @type {any} */ (window).__barValues = [];
    const bar = form?.querySelector("progress");
    if (bar) {
      // A batch of changes gives each value set by the change after it (its old value), then the bar's.
      new MutationObserver((records) => {
        for (const record of records.slice(1)) /** @type {any} */ (window).__barValues.push(record.oldValue);
        /** @type {any} */ (window).__barValues.push(bar.getAttribute("value"));
      }).observe(bar, { attributes: true, attributeFilter: ["value"], attributeOldValue: true });
    }
  });
  // Chromium sends it slowly (2 MB/s up), so the bar is seen part way; the other engines have no
  // throttle a script can set, and send it at localhost's speed.
  const throttle = engine === "chromium" ? await page.context().newCDPSession(page) : null;
  await throttle?.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 2 << 20 });
  const progressRequest = page.waitForRequest((req) => req.method() === "POST" && (req.headers()["content-type"] ?? "").startsWith("multipart/form-data"), { timeout: 10000 });
  const progressed = await upload({ name: "slow.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(600 << 10, 7) });
  const progressHeaders = await progressRequest.then((req) => req.allHeaders()).catch(() => /** @type {Record<string, string>} */ ({}));
  // Sent by XMLHttpRequest, it says what a fetch submit says: a form submit, from a runtime that
  // draws a write's own page whole.
  check(
    "an upload sent by XMLHttpRequest says it is a submit from a runtime that draws a write's own page whole",
    progressHeaders.corten === "action" && progressHeaders.prefer === "corten-draws=whole",
    JSON.stringify({ corten: progressHeaders.corten ?? null, prefer: progressHeaders.prefer ?? null }),
  );
  await throttle?.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await throttle?.detach();
  /** @type {{ loaded: number, total: number, computable: boolean, busy: string | null, shown: boolean }[]} */
  const events = await page.evaluate(() => /** @type {any} */ (window).__progress);
  /** @type {(string | null)[]} */
  const barValues = await page.evaluate(() => /** @type {any} */ (window).__barValues);
  const last = events.at(-1);
  check(
    "a form's on:corten:progress hears its whole body sent, while it is busy and its bar shows",
    !!last && last.computable && last.loaded === last.total && last.total > 600 << 10 && events.every((e) => e.busy === "true" && e.shown) && progressed.startsWith("The picture is over 64 KB"),
    `${events.length} events, last ${JSON.stringify(last)}, ${progressed}`,
  );
  check(
    "the handler the form names fills the bar with the share sent, and leaves it indeterminate once all is",
    // Firefox reports only the last step of a body sent at localhost's speed: the bar is never
    // given a value then.
    (barValues.length === 0 || barValues.at(-1) === null) &&
      events.some((e) => e.computable && e.loaded === e.total) &&
      events
        .filter((e) => e.computable && e.loaded < e.total)
        .every((e) => barValues.some((v) => v !== null && Math.abs(Number(v) - e.loaded / e.total) < 0.001)) &&
      (engine !== "chromium" || events.some((e) => e.computable && e.loaded > 0 && e.loaded < e.total)),
    JSON.stringify({ events: events.map((e) => [e.loaded, e.total]), bar: barValues }),
  );
  const barAfter = await page.evaluate(() => {
    const form = document.querySelector("main form[enctype]");
    const bar = form?.querySelector("progress");
    return [form?.getAttribute("aria-busy") ?? null, bar ? getComputedStyle(bar).display : "none"];
  });
  check("once the answer is drawn the form is not busy and the bar is hidden", barAfter[0] === null && barAfter[1] === "none", JSON.stringify(barAfter));
  // A network failure reaches the form as corten:error, as a fetch's does. The browser logs the
  // request it fails on purpose (Chromium's net::ERR_FAILED), and the one a navigation abandons.
  const failedOnPurpose = errors.length;
  await page.route(atAccount, uploads((route) => route.abort()));
  const uploadFailed = page.evaluate(
    () =>
      new Promise((resolve) => {
        document.querySelector("main form[enctype]")?.addEventListener("corten:error", (e) => resolve(/** @type {CustomEvent} */ (e).detail.status), { once: true });
        setTimeout(() => resolve("none"), 8000);
      }),
  );
  await page.setInputFiles("main input[type=file]", [{ name: "card.png", mimeType: "image/png", buffer: png }]);
  await page.click("main form[enctype] button");
  check("an upload the network fails dispatches corten:error with status 0", (await uploadFailed) === 0, String(await uploadFailed));
  await page.unroute(atAccount);
  // An upload answered with a status that takes no body (204, 205, 304) is made a Response with
  // none, as fetch's is: one made with the answer's empty body would throw. A status a Response
  // cannot have (600 or more) is the failure a network error is, corten:error with status 0, and
  // the form is not left busy (#1229). Each case records the status the page's XMLHttpRequest
  // loaded with, so an engine that turns such an answer into a network error is told apart.
  const watchUpload = () =>
    page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__uploadWatch?.abort();
      w.__uploadWatch = new AbortController();
      w.__uploadError = null;
      w.__xhrStatus = [];
      // Kept for the tab too, since a redirect may load the page in full.
      sessionStorage.removeItem("smoke-upload-error");
      document.addEventListener(
        "corten:error",
        (e) => {
          w.__uploadError = /** @type {CustomEvent} */ (e).detail.status;
          sessionStorage.setItem("smoke-upload-error", String(w.__uploadError));
        },
        { signal: w.__uploadWatch.signal },
      );
      if (w.__xhrWatched) return;
      w.__xhrWatched = true;
      const send = (w.__xhrSend = XMLHttpRequest.prototype.send);
      XMLHttpRequest.prototype.send = function (/** @type {any} */ body) {
        this.addEventListener("load", () => w.__xhrStatus.push(this.status));
        return send.call(this, body);
      };
    });
  /**
   * The form's corten:error once it is not busy, or after 8 s whatever it is, with the statuses
   * loaded and the files left in its input. `quiet`: an answer that dispatches none, so the form
   * is read once the answer has loaded, it is not busy and 300 ms more have passed.
   * @param {boolean} [quiet]
   */
  const uploadEnded = (quiet = false) =>
    page
      .waitForFunction(
        (quiet) => {
          const w = /** @type {any} */ (window);
          const busy = document.querySelector("main form[enctype]")?.getAttribute("aria-busy") ?? null;
          return (quiet ? w.__xhrStatus.length > 0 : w.__uploadError !== null) && busy === null;
        },
        quiet,
        { timeout: 8000 },
      )
      .then(() => quiet && page.waitForTimeout(300), () => {})
      .then(() =>
        page.evaluate(() => {
          const w = /** @type {any} */ (window);
          const files = /** @type {HTMLInputElement | null} */ (document.querySelector("main input[type=file]"))?.files?.length ?? null;
          return { error: w.__uploadError, busy: document.querySelector("main form[enctype]")?.getAttribute("aria-busy") ?? null, loaded: w.__xhrStatus.join(), files };
        }),
      );
  /** Why the last answer could not be given, when the engine refused it (empty when it was given). */
  let unfulfilled = "";
  /**
   * Answers the upload with `status`; an engine that refuses the status has the request failed at
   * once, rather than left waiting, and the reason is kept for the skip.
   * @param {import("@playwright/test").Route} route @param {number} status
   */
  const answerUpload = (route, status) =>
    route.fulfill({ status }).catch((/** @type {Error} */ e) => {
      unfulfilled = e.message.split("\n")[0];
      return route.abort().catch(() => {});
    });
  const pressUpload = async () => {
    unfulfilled = "";
    await page.setInputFiles("main input[type=file]", [{ name: "card.png", mimeType: "image/png", buffer: png }]);
    await page.click("main form[enctype] button");
  };
  // Corten's own 204, the redirect a write's handler answers with (`corten-location`), back to
  // this page: the page the form is on is drawn again, and nothing failed.
  await watchUpload();
  await page.route(atAccount, uploads((route) => route.fulfill({ status: 204, headers: { "corten-location": "/account" } })));
  await page.evaluate(() => document.querySelector("main form[enctype]")?.setAttribute("data-smoke-old", ""));
  await pressUpload();
  const redirectedIn = await page
    .waitForFunction(() => {
      const form = document.querySelector("main form[enctype]");
      return !!form && !form.hasAttribute("data-smoke-old") && document.readyState === "complete";
    }, null, { timeout: 8000 })
    .then(() => true, () => false);
  // The redirect may load the page in full, which starts the page's records again but not the
  // tab's: the error is read from the tab's session storage.
  const afterRedirect = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    return { error: sessionStorage.getItem("smoke-upload-error"), loaded: w.__xhrStatus?.join() ?? "a full load", busy: document.querySelector("main form[enctype]")?.getAttribute("aria-busy") ?? null, path: location.pathname };
  });
  await page.unroute(atAccount);
  check(
    "an upload answered with Corten's 204 redirect goes there, with no corten:error and the form not busy",
    redirectedIn && afterRedirect.error === null && afterRedirect.busy === null && afterRedirect.path === "/account",
    `${redirectedIn ? "" : "the page was not drawn again in 8 s; "}${JSON.stringify(afterRedirect)}`,
  );
  // A bare 204 or 205, with none of Corten's headers, took the write and has nothing to draw
  // (#1258): no corten:error, and a 205 resets the form, so the file chosen is cleared. A bare 304
  // is an answer the runtime does not draw: corten:error with that status, not the 0 of a Response
  // that could not be made. A 304 is skipped where it cannot be given or XMLHttpRequest does not
  // load it.
  for (const status of [204, 205, 304]) {
    const quiet = status !== 304;
    const bareName = quiet
      ? `an upload answered with a bare ${status} dispatches no corten:error${status === 205 ? ", the form is reset" : ""}, and the form is not busy`
      : `an upload answered with a bare ${status} dispatches corten:error with status ${status}, and the form is not busy`;
    // Playwright refuses a 304 there as a redirect, and the upload after the one it refused went
    // unanswered for 8 s in a run that tried it.
    if (status === 304 && engine === "webkit") {
      skip(bareName, "Playwright cannot fulfill a 304 in WebKit (Cannot fulfill with redirect status: 304)");
      continue;
    }
    await watchUpload();
    await page.route(atAccount, uploads((route) => answerUpload(route, status)));
    await pressUpload();
    const bare = await uploadEnded(quiet);
    await page.unroute(atAccount);
    if (status === 304 && bare.loaded !== "304") skip(bareName, `the engine's XMLHttpRequest did not load a 304: ${unfulfilled || `loaded ${bare.loaded || "nothing"}, corten:error ${bare.error}`}`);
    else check(bareName, bare.error === (quiet ? null : status) && bare.busy === null && bare.loaded === String(status) && (status !== 205 || bare.files === 0), JSON.stringify(bare));
  }
  // A status of 600 or more, which a browser may log as a failed resource.
  const beyondLogged = errors.length;
  await watchUpload();
  await page.route(atAccount, uploads((route) => answerUpload(route, 600)));
  await pressUpload();
  const beyond = await uploadEnded();
  await page.unroute(atAccount);
  errors.splice(beyondLogged, errors.length, ...errors.slice(beyondLogged).filter((e) => !/status of 600\b/.test(e)));
  const beyondName = "an upload answered with a status of 600 dispatches corten:error with status 0, and the form is not busy";
  if (beyond.loaded !== "600") skip(beyondName, `the engine did not hand XMLHttpRequest a status of 600: ${unfulfilled || `loaded ${beyond.loaded || "nothing"}, corten:error ${beyond.error}`}`);
  else check(beyondName, beyond.error === 0 && beyond.busy === null, JSON.stringify(beyond));
  // The page's XMLHttpRequest and corten:error go back to what they were for the checks after.
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__uploadWatch?.abort();
    if (w.__xhrWatched) XMLHttpRequest.prototype.send = w.__xhrSend;
    w.__xhrWatched = false;
    sessionStorage.removeItem("smoke-upload-error");
  });
  // A followed redirect on the progress path: the answer the upload module hands the runtime has
  // the redirect's URL (`responseURL`), as fetch's has, which the runtime reads to know the answer
  // is this origin's before it draws it. The module is called as the runtime calls it, and its
  // POST answered with a 303 to the news page. Playwright's WebKit cannot answer a request with a
  // redirect.
  if (engine === "webkit") skip("an upload's answer after a followed redirect has the redirect's URL, as fetch's does", "Playwright cannot fulfill a redirect in WebKit");
  else {
    const redirectContext = await /** @type {import("playwright").Browser} */ (page.context().browser()).newContext();
    await redirectContext.addCookies(await page.context().cookies());
    const redirected = await redirectContext.newPage();
    await redirected.route(atAccount, uploads((route) => route.fulfill({ status: 303, headers: { location: "/news" } })));
    await redirected.goto(`${base}/account`);
    const answered = await redirected.evaluate(async () => {
      const url = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .find((name) => /\/corten-upload\.js(\?|$)/.test(name));
      if (!url) return { url: "", status: 0, path: "no module loaded" };
      /** @type {typeof import("../crates/corten/js/upload.js")} */
      const module = await import(url);
      const body = new FormData(/** @type {HTMLFormElement} */ (document.querySelector("main form[enctype]")));
      const res = await module.upload(new URL("/account", location.href), "POST", body, new AbortController().signal, () => {}, { corten: "action", prefer: "corten-draws=whole" });
      return { url: res.url, status: res.status, path: new URL(res.url, location.href).pathname };
    });
    await redirectContext.close();
    check(
      "an upload's answer after a followed redirect has the redirect's URL, as fetch's does",
      answered.status === 200 && answered.path === "/news" && answered.url.startsWith(base),
      JSON.stringify(answered),
    );
  }
  // Across a deploy: the server answers any version's module address with its own bytes, so a tab
  // opened before it may call this module, and a runtime loaded after it may be handed the module
  // from before. Called as the runtime before `headers` was passed calls it (five arguments), the
  // module sends the action header alone, so the server answers with <main>, which that runtime draws.
  const deployContext = await /** @type {import("playwright").Browser} */ (page.context().browser()).newContext();
  await deployContext.addCookies(await page.context().cookies());
  const olderCaller = await deployContext.newPage();
  /** @type {Record<string, string> | null} */
  let olderSent = null;
  await olderCaller.route(
    atAccount,
    uploads((route) => {
      olderSent = route.request().headers();
      return route.fulfill({ status: 200, contentType: "text/html", body: "<p>answered</p>" });
    }),
  );
  await olderCaller.goto(`${base}/account`);
  const olderCall = await olderCaller.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .find((name) => /\/corten-upload\.js(\?|$)/.test(name));
    if (!url) return "no module loaded";
    /** @type {typeof import("../crates/corten/js/upload.js")} */
    const module = await import(url);
    const body = new FormData(/** @type {HTMLFormElement} */ (document.querySelector("main form[enctype]")));
    try {
      const res = await module.upload(new URL("/account", location.href), "POST", body, new AbortController().signal, () => {});
      return `${res.status} ${await res.text()}`;
    } catch (error) {
      return `threw ${error}`;
    }
  });
  const olderHeaders = /** @type {Record<string, string> | null} */ (olderSent);
  check(
    "the upload module called with an older runtime's arguments sends the action header alone and answers",
    olderCall === "200 <p>answered</p>" && olderHeaders?.corten === "action" && olderHeaders.prefer === undefined,
    JSON.stringify({ olderCall, corten: olderHeaders?.corten ?? null, prefer: olderHeaders?.prefer ?? null }),
  );
  // And this runtime handed the module from before `headers` was passed (its signature, sending the
  // action header itself): the upload goes without the preference, and the <main> the server answers
  // with is drawn.
  const olderModule = await deployContext.newPage();
  let olderServed = 0;
  await olderModule.route("**/corten-upload*", (route) => {
    olderServed += 1;
    return route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: `export function upload(url, method, body, signal, progress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader("corten", "action");
    xhr.responseType = "arraybuffer";
    xhr.upload.onprogress = progress;
    xhr.onload = () => {
      const headers = new Headers();
      for (const line of xhr.getAllResponseHeaders().split("\\r\\n")) {
        const colon = line.indexOf(":");
        if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
      }
      const res = new Response(xhr.response, { status: xhr.status, statusText: xhr.statusText, headers });
      Object.defineProperty(res, "url", { value: xhr.responseURL });
      resolve(res);
    };
    xhr.onerror = () => reject(new TypeError("upload failed"));
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}
`,
    });
  });
  await olderModule.goto(`${base}/account`);
  const olderRequest = olderModule.waitForRequest((req) => req.method() === "POST" && (req.headers()["content-type"] ?? "").startsWith("multipart/form-data"), { timeout: 8000 });
  await olderModule.setInputFiles("main input[type=file]", [{ name: "page.png", mimeType: "image/png", buffer: Buffer.from("<script>alert(1)</script>") }]);
  await olderModule.click("main form[enctype] button");
  const olderAnswer = await olderModule
    .waitForFunction(() => document.querySelector("#avatar-result")?.textContent, null, { timeout: 8000 })
    .then((handle) => handle.jsonValue())
    .catch(() => "");
  const olderModuleHeaders = await olderRequest.then((req) => req.allHeaders()).catch(() => /** @type {Record<string, string>} */ ({}));
  await deployContext.close();
  check(
    "this runtime handed the upload module from before sends the upload and draws the <main> it is answered with",
    olderServed > 0 && String(olderAnswer).startsWith("That file is not a picture") && olderModuleHeaders.corten === "action" && olderModuleHeaders.prefer === undefined,
    JSON.stringify({ served: olderServed, answer: olderAnswer, corten: olderModuleHeaders.corten ?? null, prefer: olderModuleHeaders.prefer ?? null }),
  );
  // A navigation abandons an upload still waiting for its answer: no progress reaches the form after
  // it, nor its answer the page. In a context of its own (with the session's cookie), closed after,
  // since a request Playwright held and answered after the page let it go leaves the context's
  // next request to the same path unanswered.
  const leaveContext = await /** @type {import("playwright").Browser} */ (page.context().browser()).newContext();
  await leaveContext.addCookies(await page.context().cookies());
  const leave = await leaveContext.newPage();
  await leave.goto(`${base}/account`);
  await leave.evaluate(() => {
    /** @type {any} */ (window).__progress = 0;
    document.querySelector("main form[enctype]")?.addEventListener("corten:progress", () => (/** @type {any} */ (window).__progress += 1));
  });
  /** @type {import("playwright").Route[]} */
  const heldUploads = [];
  await leave.route(
    atAccount,
    uploads((route) => {
      heldUploads.push(route);
    }),
  );
  await leave.setInputFiles("main input[type=file]", [{ name: "card.png", mimeType: "image/png", buffer: png }]);
  await leave.click("main form[enctype] button");
  const wasBusy = await leave
    .waitForFunction(() => document.querySelector("main form[enctype]")?.getAttribute("aria-busy") === "true", null, { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  const beforeLeaving = await leave.evaluate(() => /** @type {any} */ (window).__progress);
  await leave.click('header a[href="/"]');
  await leave.waitForFunction(() => !document.querySelector("main form[enctype]"), null, { timeout: 5000 }).catch(() => {});
  // The held upload then answers, sending the page elsewhere: an upload still listened to would
  // take the page there.
  for (const route of heldUploads) await route.fulfill({ status: 204, headers: { "corten-location": "/news" } }).catch(() => {});
  await leave.waitForTimeout(500);
  const afterLeaving = await leave.evaluate(() => /** @type {any} */ (window).__progress);
  const leftFor = await leave.evaluate(() => location.pathname);
  const formLeft = !!(await leave.$("main form[enctype]"));
  await leaveContext.close();
  check(
    "a navigation abandons a waiting upload, its progress and its answer",
    wasBusy && heldUploads.length === 1 && afterLeaving === beforeLeaving && leftFor === "/" && !formLeft,
    `busy ${wasBusy}, ${heldUploads.length} held, ${beforeLeaving} then ${afterLeaving} events, at ${leftFor}`,
  );
  // A navigation while the upload module is still loading: the upload is never sent, as a fetch
  // is never sent with an aborted signal, and its answer cannot take the page.
  // In a context of its own (with the session's cookie), closed after, so nothing it holds reaches
  // the pages after it.
  const raceContext = await /** @type {import("playwright").Browser} */ (page.context().browser()).newContext();
  await raceContext.addCookies(await page.context().cookies());
  const race = await raceContext.newPage();
  /** @type {import("playwright").Route[]} */
  const heldModules = [];
  await race.route("**/corten-upload*", (route) => {
    heldModules.push(route);
  });
  let sentUploads = 0;
  /** @param {import("playwright").Request} request */
  const countUpload = (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/account") sentUploads += 1;
  };
  race.on("request", countUpload);
  // The form is put on a page that did not load the module (as a script or a patch may add one),
  // so its first submit waits for the module to load.
  const accountPage = await (await race.request.get(`${base}/account`)).text();
  const pictureForm = /<form[^>]*enctype="multipart\/form-data"[\s\S]*?<\/form>/.exec(accountPage)?.[0] ?? "";
  await race.goto(`${base}/`);
  await race.evaluate((html) => {
    const holder = document.createElement("div");
    holder.id = "smoke-upload-race";
    holder.innerHTML = /** @type {any} */ (/** @type {any} */ (window).__html(html));
    document.querySelector("main")?.append(holder);
  }, pictureForm);
  await race.waitForTimeout(100);
  await race.setInputFiles("#smoke-upload-race input[type=file]", [{ name: "card.png", mimeType: "image/png", buffer: png }]);
  await race.click("#smoke-upload-race button");
  await race.waitForTimeout(200);
  await race.click('header a[href="/news"]');
  await race.waitForFunction(() => location.pathname === "/news" && !document.querySelector("#smoke-upload-race"), null, { timeout: 5000 }).catch(() => {});
  const moduleHeld = heldModules.length;
  // Answered from a request of the test's own, so the held request ends here whatever the page did.
  for (const route of heldModules) {
    const module = await race.request.get(route.request().url());
    await route.fulfill({ response: module }).catch(() => {});
  }
  await race.unroute("**/corten-upload*", { behavior: "ignoreErrors" });
  await race.waitForTimeout(500);
  race.off("request", countUpload);
  const landed = await race.evaluate(() => location.pathname);
  await raceContext.close();
  check("an upload left while its module loads is never sent", moduleHeld > 0 && sentUploads === 0 && landed === "/news", `${moduleHeld} module requests held, ${sentUploads} uploads sent, at ${landed}`);
  await page.goto(`${base}/account`);
  // A multipart form with no progress handler and a control named getAttribute is still sent (by
  // fetch): the submit's check for a progress handler reads the form through Element's methods.
  await page.setInputFiles("main input[type=file]", [{ name: "card.png", mimeType: "image/png", buffer: png }]);
  const ordinary = await page.evaluate(async () => {
    const form = /** @type {HTMLFormElement} */ (document.querySelector("main form[enctype]"));
    form.removeAttribute("data-on");
    const shadow = document.createElement("input");
    shadow.type = "hidden";
    shadow.name = "getAttribute";
    form.prepend(shadow);
    const result = document.querySelector("#avatar-result");
    if (result) result.textContent = "";
    /** @type {string[]} */
    const failed = [];
    form.addEventListener("corten:error", (e) => failed.push(String(/** @type {CustomEvent} */ (e).detail?.status)), { once: true });
    HTMLFormElement.prototype.requestSubmit.call(form);
    for (let i = 0; i < 80 && !document.querySelector("#avatar-result")?.textContent && !failed.length; i++) await new Promise((r) => setTimeout(r, 100));
    return { answer: document.querySelector("#avatar-result")?.textContent ?? "", failed, busy: Element.prototype.getAttribute.call(form, "aria-busy"), files: /** @type {HTMLInputElement | null} */ (form.querySelector("input[type=file]"))?.files?.length ?? -1 };
  });
  check("a multipart form without a progress handler, with a control named getAttribute, is still sent", ordinary.answer !== "" && !ordinary.failed.length, JSON.stringify(ordinary));
  // The account page's two forms are posts of the page's own, told apart by their address alone
  // (do=picture, do=name): a multipart upload beside a urlencoded form, with JavaScript (each a
  // data-patch) and without.
  await page.goto(`${base}/account`);
  {
    const nameForm = page.locator("main form:has(input[name=name])");
    await nameForm.locator("input[name=name]").fill("Grace");
    const { stayed: nameRegionStayed } = await liveRegion(page, "name-result");
    const [sent] = await Promise.all([page.waitForRequest((r) => r.method() === "POST"), nameForm.locator("button").click()]);
    await page.waitForFunction(() => document.querySelector("#name-result")?.textContent === "Your pages now say Grace.", null, { timeout: 5000 }).catch(() => {});
    check("saving the name keeps the live region and replaces its message", await nameRegionStayed());
    const type = (await sent.headerValue("content-type")) ?? "";
    const badge = (await page.textContent("#viewer-badge")) ?? "";
    check(
      "a data-patch post of the page's own goes to its address with do=name, urlencoded, and patches the page where it is",
      new URL(sent.url()).search === "?do=name" && type.startsWith("application/x-www-form-urlencoded") && badge.includes("Grace") && new URL(page.url()).search === "",
      `${sent.url()} ${type} ${badge} ${page.url()}`,
    );
    const named = await page.evaluate(() => ({
      label: document.querySelector("#viewer-link")?.getAttribute("aria-label"),
      current: document.querySelector("#viewer-link")?.getAttribute("aria-current"),
      line: document.querySelector("#signed-in-as")?.textContent,
    }));
    check(
      "the new name replaces every place the page names them: the header link's accessible name, still current, and the account's line",
      named.label === "Grace: account" && named.current === "page" && named.line === "Signed in as Grace.",
      JSON.stringify(named),
    );
    await page.setInputFiles("main input[type=file]", [{ name: "card.png", mimeType: "image/png", buffer: png }]);
    const { stayed: pictureRegionStayed } = await liveRegion(page, "avatar-result");
    const [upload] = await Promise.all([page.waitForRequest((r) => r.method() === "POST"), page.click("main form[enctype] button")]);
    await page.waitForFunction(() => document.querySelector("#avatar-result")?.textContent === "Saved card.png as your picture.", null, { timeout: 8000 }).catch(() => {});
    check("saving the picture keeps the live region and replaces its message", await pictureRegionStayed());
    const uploadType = (await upload.headerValue("content-type")) ?? "";
    check(
      "the same page's multipart post goes to do=picture, and its handler reads the body",
      new URL(upload.url()).search === "?do=picture" && uploadType.startsWith("multipart/form-data") && (await page.textContent("#avatar-result")) === "Saved card.png as your picture.",
      `${upload.url()} ${uploadType} ${await page.textContent("#avatar-result")}`,
    );
  }
  {
    const noScript = await /** @type {import("playwright").Browser} */ (page.context().browser()).newContext({ javaScriptEnabled: false });
    let failed = false;
    try {
      await noScript.addCookies(await page.context().cookies());
      const plainAccount = await noScript.newPage();
      await plainAccount.goto(`${base}/account`);
      /** Return the POST response from this main-frame navigation, not an unrelated POST seen while it loads.
       * @param {string} button @param {string} action */
      const post = async (button, action) => {
        const budget = steps(30_000, "native account form exceeded 30 s");
        const target = new URL("/account?do=" + action, base).href;
        let phase = "load the previous document";
        try {
          await budget.step(() => plainAccount.waitForLoadState("load"));
          // Arm before activating. The catch also handles page closure if the press fails.
          const loaded = plainAccount.waitForNavigation({ waitUntil: "load", timeout: 30_000 }).catch(() => null);
          const sent = plainAccount.waitForRequest((r) => r.isNavigationRequest() && r.frame() === plainAccount.mainFrame() && r.method() === "POST" && r.url() === target,
            { timeout: 30_000 }).catch(() => null);
          phase = "activate submit";
          await budget.step(() => plainAccount.locator(button).press("Enter", { noWaitAfter: true, timeout: 30_000 }));
          phase = "observe the form POST";
          const request = await budget.step(() => sent);
          if (!request) throw new Error("no matching request");
          phase = "load the POST destination";
          const navigation = await budget.step(() => loaded);
          let origin = navigation?.request();
          while (origin?.redirectedFrom()) origin = origin.redirectedFrom();
          if (origin !== request) throw new Error("loaded navigation did not originate at the form POST");
          phase = "read the POST response";
          const response = await budget.step(() => request.response());
          if (!response) throw new Error("no POST response");
          return response;
        } catch (error) {
          throw new Error("native account " + action + ": " + phase + ": " + String(error).split("\n")[0]);
        }
      };
      const nameButton = "main form:has(input[name=name]) button";
      await plainAccount.fill("main input[name=name]", "Ada");
      const renamed = await post(nameButton, "name");
      const at = new URL(plainAccount.url());
      check(
        "without JavaScript the name's urlencoded post goes to do=name and the browser back to the page",
        new URL(renamed.url()).search === "?do=name" && renamed.status() === 303 && at.pathname === "/account" && at.search === "" && ((await plainAccount.textContent("main")) ?? "").includes("Signed in as Ada."),
        `${renamed.url()} ${renamed.status()} ${plainAccount.url()}`,
      );
      await plainAccount.fill("main input[name=name]", " ");
      const refused = await post(nameButton, "name");
      check(
        "without JavaScript a refused name is the page at its post's address, the reason in it",
        refused.status() === 422 && new URL(plainAccount.url()).search === "?do=name" && (await plainAccount.textContent("#name-result")) === "Choose a name of 1 to 40 characters.",
        `${refused.status()} ${plainAccount.url()} ${await plainAccount.textContent("#name-result")}`,
      );
      // From the page drawn at do=name, the picture's form still posts to its own address.
      await plainAccount.setInputFiles("main input[type=file]", [{ name: "card.png", mimeType: "image/png", buffer: png }]);
      const uploadedPlain = await post("main form[enctype] button", "picture");
      const plainType = (await uploadedPlain.request().headerValue("content-type")) ?? "";
      check(
        "without JavaScript the picture's multipart post goes to do=picture, from the page drawn at do=name",
        new URL(uploadedPlain.url()).search === "?do=picture" && plainType.startsWith("multipart/form-data") && uploadedPlain.status() === 200 && (await plainAccount.textContent("#avatar-result")) === "Saved card.png as your picture.",
        `${uploadedPlain.url()} ${plainType} ${uploadedPlain.status()} ${await plainAccount.textContent("#avatar-result")}`,
      );
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        await within(30_000, "native account form: context did not close", noScript.close());
      } catch (error) {
        if (!failed) throw error;
        console.error("native account form cleanup:", error);
      }
    }
  }
  errors.splice(failedOnPurpose, errors.length, ...errors.slice(failedOnPurpose).filter((e) => !/ERR_FAILED|ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(e)));
  if (!signsIn) await page.context().clearCookies({ name: "session" });

  // The posts answered 415, and the uploads 422 and 413 (the form over its limit), on purpose; the
  // browser logs those as failed resources.
  const unplanned = errors.filter((e, i) => !(e.includes("415") || (i >= errorsBefore && (e.includes("422") || e.includes("413")))));
  check("no console errors after the injected forms", unplanned.length === 0, unplanned.join(" | "));
}
