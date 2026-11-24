import { check } from "./helpers.mjs";

export async function submitQueue(delayWatch, page, abandoned, errors, zero) {
  // The cases below press their buttons in the page (`button.click()`), so each submit has run
  // before the case changes the form, presses again or releases a held answer. A loaded Firefox
  // can acknowledge Playwright's click before the page gets it, and by then the page can have
  // moved under the point clicked: the press lands on another element and sends nothing (#2014).
  const press = (/** @type {string} */ selector) => page.evaluate((selector) => /** @type {HTMLButtonElement} */ (document.querySelector(selector)).click(), selector);
  // The latest submit wins, but a pending write is not abandoned (the server may have applied
  // it): the newer submit waits for its answer and goes out after it, from the form as the answer
  // left it.
  delayWatch.value = 1200;
  /** @type {string[]} */
  const writes = [];
  /** @param {import("@playwright/test").Request} r */
  const onWrite = (r) => r.method() === "POST" && r.url().endsWith("/watch") && writes.push(`sent ${new URLSearchParams(r.postData() ?? "").get("id")}`);
  /** @param {import("@playwright/test").Response} r */
  const onAnswer = (r) => r.request().method() === "POST" && r.url().endsWith("/watch") && writes.push(`answered ${new URLSearchParams(r.request().postData() ?? "").get("id")}`);
  page.on("request", onWrite);
  page.on("response", onAnswer);
  await page.selectOption("select[name=id]", "PNTR");
  // Each press runs in the page, so the first is out before the form changes.
  const firstWrite = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/watch"), { timeout: 6000 });
  await press("#watch-form button");
  await firstWrite;
  // The same press again sends nothing, and two newer ones are one submit of where the form ended.
  await press("#watch-form button");
  await page.selectOption("select[name=id]", "NRTH");
  await press("#watch-form button");
  await page.selectOption("select[name=id]", "VTGO");
  await press("#watch-form button");
  const busyWhileWriting = await page.getAttribute("#watch-form", "aria-busy");
  await page.waitForFunction(() => document.getElementById("watch-message")?.textContent?.startsWith("Watching Vertigo Robotics"), null, { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(300);
  page.off("request", onWrite);
  page.off("response", onAnswer);
  check(
    "a newer submit waits for a pending write, which is answered, and then goes out",
    ((await page.textContent("#watch-message")) ?? "").startsWith("Watching Vertigo Robotics") &&
      busyWhileWriting === "true" &&
      abandoned.length === 0 &&
      writes.join() === "sent PNTR,answered PNTR,sent VTGO,answered VTGO",
    `${await page.textContent("#watch-message")}; busy: ${busyWhileWriting}; ${writes.join()}; abandoned: ${abandoned.join()}`,
  );
  check("the form is not left busy", (await page.getAttribute("#watch-form", "aria-busy")) === null);

  // The queue's other answers, against a form of the smoke's own whose answers it writes: each
  // case presses once, changes the field and presses again while the first is out.
  /** @type {{ status: number, headers?: Record<string, string>, body: string }} */
  let queueAnswer = { status: 200, body: "" };
  /** @type {string[]} */
  let queueSent = [];
  // Requests the route has answered or tried to (an aborted one's answer goes nowhere, and counts).
  let queueAnswered = 0;
  // The n of each request the page gave up on (an aborted read), which every engine reports as
  // failed even while the route holds it (net::ERR_ABORTED, NS_BINDING_ABORTED, Load request
  // cancelled); fulfilling it afterwards does not throw.
  /** @type {string[]} */
  let queueRefused = [];
  const queueGaveUp = (/** @type {import("@playwright/test").Request} */ request) => {
    if (new URL(request.url()).pathname !== "/queue") return;
    const fields = request.method() === "GET" ? new URL(request.url()).searchParams : new URLSearchParams(request.postData() ?? "");
    const n = fields.get("n") ?? "";
    if (!queueRefused.includes(n)) queueRefused.push(n);
  };
  page.on("requestfailed", queueGaveUp);
  // No answer goes before the case's second press is made, so that press meets the first submit
  // still out: the check is of the queue and not of two sends, however slow the press.
  /** @type {Promise<void>} */
  let queuePressed = Promise.resolve();
  await page.route("**/queue*", async (route) => {
    const request = route.request();
    const fields = request.method() === "GET" ? new URL(request.url()).searchParams : new URLSearchParams(request.postData() ?? "");
    queueSent.push(`${request.method()} ${fields.get("n")}${fields.has("submit") ? ` ${fields.get("submit")}` : ""}${fields.has("b") ? ` ${fields.get("b")}` : ""}`);
    const answer = queueAnswer;
    // The first of two reads answers last, so a read that was not aborted would draw over the newer.
    const late = request.method() === "GET" && fields.get("n") === "1";
    await queuePressed;
    await new Promise((resolve) => setTimeout(resolve, late ? 1200 : 400));
    const body = answer.body.replace("{n}", fields.get("n") ?? "");
    await route
      .fulfill({ status: answer.status, headers: { "content-type": "text/html; charset=utf-8", ...answer.headers }, body })
      .catch(() => {});
    queueAnswered += 1;
  });
  /**
   * Puts the form (in a box a patch can redraw), presses, sets n to 2 and presses again, then
   * waits until `done` says the case's outcome is on the page (6 s at most, and `ended` is false)
   * and 700 ms more, in which a send the queue must not make would be seen. `status`: the case's
   * `corten:error`, or null, heard on the form too, so one sent to a form the answer took off the
   * page is not missed. `refused`: the n of each request the page gave up on.
   * @param {string} form @param {() => Promise<boolean>} done
   */
  const queueCase = async (form, done) => {
    queueSent = [];
    queueAnswered = 0;
    queueRefused = [];
    /** @type {() => void} */
    let pressed = () => {};
    queuePressed = new Promise((resolve) => (pressed = resolve));
    await page.evaluate((form) => {
      document.getElementById("queue-box")?.remove();
      document.querySelector("main")?.insertAdjacentHTML("beforeend", __html(`<div id="queue-box">${form}<p id="queue-out"></p></div>`));
      // The case's corten:error, if it gets one; the listener goes with the case.
      const w = /** @type {any} */ (window);
      w.__queueCase?.abort();
      w.__queueCase = new AbortController();
      w.__queueError = null;
      const heard = (/** @type {Event} */ e) => (w.__queueError = /** @type {CustomEvent} */ (e).detail.status);
      document.addEventListener("corten:error", heard, { signal: w.__queueCase.signal });
      document.querySelector("#queue-box form")?.addEventListener("corten:error", heard, { signal: w.__queueCase.signal });
    }, form);
    // The first press must run before n changes, the second before pressed().
    const first = page.waitForRequest((r) => new URL(r.url()).pathname === "/queue", { timeout: 6000 });
    await press("#queue-box button");
    await first;
    await page.fill("#queue-box [name=n]", "2");
    const busy = await page.getAttribute("#queue-box form", "aria-busy");
    await press("#queue-box button");
    pressed();
    const until = Date.now() + 6000;
    let ended = await done();
    while (!ended && Date.now() < until) {
      await page.waitForTimeout(50);
      ended = await done();
    }
    await page.waitForTimeout(700);
    const status = await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__queueCase.abort();
      return /** @type {number | null} */ (w.__queueError);
    });
    return { sent: queueSent.join(), status, busy, ended, refused: queueRefused.join() };
  };
  const queueOut = () => page.evaluate(() => document.getElementById("queue-out")?.textContent ?? null);
  const queueLogged = errors.length;
  const patchHeaders = { "corten-patch": "1" };
  const queueForm = (/** @type {string} */ method, /** @type {string} */ extra = "") =>
    `<form id="queue" method="${method}" action="/queue" data-patch><input name="n" value="1">${extra}<button>Go</button></form>`;

  // A newer GET aborts the older one, whose answer is worth nothing now: the first answers last,
  // and the page keeps the newer's.
  queueAnswer = { status: 200, headers: patchHeaders, body: '<p id="queue-out">read {n}</p>' };
  // Ended once the older's late answer was tried too, so it had its chance to draw.
  const read = await queueCase(queueForm("get"), async () => queueAnswered === 2 && (await queueOut()) === "read 2");
  check(
    "a newer GET submit aborts the older one",
    read.ended && read.status === null && read.sent === "GET 1,GET 2" && read.refused === "1" && (await queueOut()) === "read 2",
    `${read.sent}; ${await queueOut()}; ended: ${read.ended}; error: ${read.status}; refused: ${read.refused}`,
  );

  // An answer the runtime does not draw (a proxy's 503) drops the submit that waited.
  queueAnswer = { status: 503, body: "Service Unavailable" };
  const undrawn = await queueCase(queueForm("post"), async () => (await page.evaluate(() => /** @type {any} */ (window).__queueError)) !== null);
  check(
    "a submit that waited for an answer the runtime does not draw is not sent",
    undrawn.ended && undrawn.sent === "POST 1" && undrawn.status === 503,
    `${undrawn.sent}; ${undrawn.status}; ended: ${undrawn.ended}`,
  );

  // A 5xx patch is drawn, but the write may or may not have applied: the waiting submit drops.
  queueAnswer = { status: 500, headers: patchHeaders, body: '<p id="queue-out">failed</p>' };
  const failedPatch = await queueCase(queueForm("post"), async () => (await queueOut()) === "failed");
  check(
    "a submit that waited for a 5xx is not sent, and the 5xx's patch is drawn",
    failedPatch.ended && failedPatch.status === null && failedPatch.sent === "POST 1" && (await queueOut()) === "failed",
    `${failedPatch.sent}; ${await queueOut()}; ended: ${failedPatch.ended}; error: ${failedPatch.status}`,
  );

  // A refusal of the state the write was made against (Errors::refuse, 409) is drawn and drops
  // the waiting submit: the user reads it before anything else goes.
  queueAnswer = { status: 409, headers: patchHeaders, body: '<p id="queue-out">stale</p>' };
  const stale = await queueCase(queueForm("post"), async () => (await queueOut()) === "stale");
  check(
    "a submit that waited is not sent after a 409 refusal, which is drawn",
    stale.ended && stale.status === null && stale.sent === "POST 1" && (await queueOut()) === "stale",
    `${stale.sent}; ${await queueOut()}; ended: ${stale.ended}; error: ${stale.status}`,
  );

  // An answer that removes the form drops it.
  queueAnswer = { status: 200, headers: patchHeaders, body: '<template id="queue" data-remove></template>' };
  const removed = await queueCase(queueForm("post"), async () => (await page.$("#queue")) === null);
  check(
    "a submit that waited is not sent when the answer removes its form",
    removed.ended && removed.status === null && removed.sent === "POST 1" && (await page.$("#queue")) === null,
    `${removed.sent}; ended: ${removed.ended}; error: ${removed.status}`,
  );

  // A form without an id that the answer took off the page is not found again: its values are
  // the ones from before the answer.
  queueAnswer = { status: 200, headers: patchHeaders, body: '<div id="queue-box"><form method="post" action="/queue" data-patch><input name="n" value="1"><button>Go</button></form></div>' };
  // The answer's box has no #queue-out: drawn once it is gone.
  const noId = await queueCase('<form method="post" action="/queue" data-patch><input name="n" value="1"><button>Go</button></form>', async () => (await queueOut()) === null);
  check(
    "a submit that waited is not sent when its form without an id left the page",
    noId.ended && noId.status === null && noId.sent === "POST 1",
    `${noId.sent}; ended: ${noId.ended}; error: ${noId.status}`,
  );

  // The submit that waited goes under the form's new key: the write's answer renewed it.
  queueAnswer = { status: 200, headers: patchHeaders, body: '<p id="queue-out">saved {n}</p>' };
  // Ended once the waiting submit's own answer is drawn.
  const keyed = await queueCase(queueForm("post", `<input type="hidden" name="submit" data-submit value="${zero}">`), async () => (await queueOut()) === "saved 2");
  const [firstKey, secondKey] = keyed.sent.split(",").map((s) => s.split(" ")[2]);
  check(
    "a submit that waited goes out after the write's answer, under the key the answer renewed",
    keyed.ended && keyed.status === null && keyed.busy === "true" && keyed.sent.split(",").length === 2 && keyed.sent.startsWith("POST 1 ") && keyed.sent.includes(",POST 2 ") && firstKey === zero && /^[0-9a-f-]{36}$/.test(secondKey ?? "") && secondKey !== zero,
    `${keyed.sent}; ended: ${keyed.ended}; error: ${keyed.status}`,
  );

  // A 204 or 205 with none of Corten's headers took the write and has nothing to draw (RFC 9110,
  // 15.3.5 and 15.3.6; #1258): no corten:error, and the submit that waited goes, under the key the
  // answer renewed. A 205 resets the form only when nothing waits: the second submit goes with the
  // values it was pressed with, and its own 205 then resets the form, which has a new key after.
  // The placeholder key matches the UUID pattern, so each key is also held apart from it.
  const keyField = `<input type="hidden" name="submit" data-submit value="${zero}">`;
  const queueFields = () =>
    page.evaluate(() => ({
      n: /** @type {HTMLInputElement | null} */ (document.querySelector("#queue-box [name=n]"))?.value,
      key: /** @type {HTMLInputElement | null} */ (document.querySelector("#queue-box [name=submit]"))?.value,
    }));
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  for (const status of [204, 205]) {
    queueAnswer = { status, body: "" };
    // Ended once the waiting submit's own answer is in and the form is no longer busy.
    const quiet = await queueCase(queueForm("post", keyField), async () => queueAnswered === 2 && (await page.getAttribute("#queue-box form", "aria-busy")) === null);
    const [first, second] = quiet.sent.split(",").map((s) => s.split(" ")[2]);
    const left = await queueFields();
    check(
      `a submit that waited for a bare ${status} goes out after it under a new key, with no corten:error${status === 205 ? ", and the last 205 resets the form" : ""}`,
      quiet.ended &&
        quiet.status === null &&
        quiet.busy === "true" &&
        quiet.sent.split(",").length === 2 &&
        quiet.sent.startsWith("POST 1 ") &&
        quiet.sent.includes(",POST 2 ") &&
        first === zero &&
        uuid.test(second ?? "") &&
        second !== zero &&
        left.n === (status === 205 ? "1" : "2") &&
        uuid.test(left.key ?? "") &&
        left.key !== zero &&
        left.key !== second,
      `${quiet.sent}; ended: ${quiet.ended}; error: ${quiet.status}; left ${JSON.stringify(left)}`,
    );
  }
  // With nothing waiting, a 205 resets the form that sent it to the markup's values, and the form
  // has a new key after (the reset comes before the key is renewed, so this does not see the reset
  // leave a key alone: a hidden input's value is its attribute, which a reset keeps). A form the
  // user changed after it was sent keeps their work, as it does against a patch, and so does one a
  // control was added to: a hidden input too, which has no state of its own the reset could be
  // seen to change. So does another file of the same name chosen while the write is out (its size
  // differs), and text a number input cannot read, whose value is "" as an empty field's is. The
  // form has a control named reset, so `form.reset` is that control and the form's own method has
  // to be reached through its prototype.
  /** Sets the queue form's file to one named card.png, of `text`. @param {string} text */
  const pickQueueFile = (text) =>
    page.evaluate((text) => {
      const files = new DataTransfer();
      files.items.add(new File([text], "card.png", { type: "image/png", lastModified: 1 }));
      /** @type {HTMLInputElement} */ (document.querySelector("#queue-box [name=f]")).files = files.files;
    }, text);
  for (const change of ["none", "edited", "added", "hidden", "file", "unreadable"]) {
    queueSent = [];
    queueAnswered = 0;
    queueAnswer = { status: 205, body: "" };
    /** @type {() => void} */
    let pressed = () => {};
    queuePressed = new Promise((resolve) => (pressed = resolve));
    await page.evaluate((form) => {
      document.getElementById("queue-box")?.remove();
      document.querySelector("main")?.insertAdjacentHTML("beforeend", __html(`<div id="queue-box">${form}</div>`));
      const w = /** @type {any} */ (window);
      w.__queueCase?.abort();
      w.__queueCase = new AbortController();
      w.__queueError = null;
      document.addEventListener("corten:error", (e) => (w.__queueError = /** @type {CustomEvent} */ (e).detail.status), { signal: w.__queueCase.signal });
    }, queueForm("post", `${keyField}<input type="hidden" name="reset" value="x">${change === "file" ? '<input type="file" name="f">' : change === "unreadable" ? '<input type="number" name="q">' : ""}`));
    await page.fill("#queue-box [name=n]", "5");
    if (change === "file") await pickQueueFile("first");
    const sent = page.waitForRequest((r) => new URL(r.url()).pathname === "/queue", { timeout: 6000 });
    await press("#queue-box button");
    await sent;
    if (change === "edited") await page.fill("#queue-box [name=n]", "6");
    if (change === "added") await page.evaluate(() => document.querySelector("#queue-box form")?.insertAdjacentHTML("beforeend", __html('<input name="extra">')));
    if (change === "hidden") await page.evaluate(() => document.querySelector("#queue-box form")?.insertAdjacentHTML("beforeend", __html('<input type="hidden" name="tag" value="a">')));
    if (change === "file") await pickQueueFile("another picture");
    if (change === "unreadable") {
      await page.focus("#queue-box [name=q]");
      await page.keyboard.type("1e");
    }
    pressed();
    const until = Date.now() + 6000;
    while (!(queueAnswered === 1 && (await page.getAttribute("#queue-box form", "aria-busy")) === null) && Date.now() < until) await page.waitForTimeout(50);
    // Time for a corten:error to be heard, or a waiting submit to go.
    await page.waitForTimeout(300);
    const reset = await queueFields();
    // What the case says it changed is still there: the second file, and the number input's text.
    const other = await page.evaluate(() => ({
      file: /** @type {HTMLInputElement | null} */ (document.querySelector("#queue-box [name=f]"))?.files?.[0]?.size,
      bad: /** @type {HTMLInputElement | null} */ (document.querySelector("#queue-box [name=q]"))?.validity.badInput,
    }));
    const error = await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__queueCase.abort();
      return /** @type {number | null} */ (w.__queueError);
    });
    /** @type {Record<string, string>} */
    const keeps = {
      edited: "a form the user changed after it was sent",
      added: "a form a control was added to after it was sent",
      hidden: "a form a hidden input was added to after it was sent",
      file: "a form whose file was swapped for another of the same name after it was sent",
      unreadable: "a form whose number input was given text it cannot read after it was sent",
    };
    check(
      change === "none" ? "a bare 205 with nothing waiting resets the form that sent it, gives it a new key, and dispatches no corten:error" : `a bare 205 keeps ${keeps[change]}, with no corten:error`,
      queueSent.length === 1 &&
        queueSent[0].startsWith("POST 5 ") &&
        error === null &&
        reset.n === (change === "none" ? "1" : change === "edited" ? "6" : "5") &&
        uuid.test(reset.key ?? "") &&
        reset.key !== zero &&
        (change !== "file" || other.file === "another picture".length) &&
        (change !== "unreadable" || other.bad === true),
      `${queueSent.join()}; error: ${error}; left ${JSON.stringify({ ...reset, ...other })}`,
    );
  }
  // A press with other values while a write is out waits, and the write's 205 does not reset the
  // form under it: the waiting submit goes with what the user typed, and its own 205 then resets
  // the form. The second press is the form's other button, so the values differ only by the button
  // and nothing is typed between the presses: only the waiting submit keeps the first 205 from
  // resetting the form.
  {
    queueSent = [];
    queueAnswered = 0;
    queueAnswer = { status: 205, body: "" };
    /** @type {() => void} */
    let pressed = () => {};
    queuePressed = new Promise((resolve) => (pressed = resolve));
    await page.evaluate((form) => {
      document.getElementById("queue-box")?.remove();
      document.querySelector("main")?.insertAdjacentHTML("beforeend", __html(`<div id="queue-box">${form}</div>`));
      const w = /** @type {any} */ (window);
      w.__queueCase?.abort();
      w.__queueCase = new AbortController();
      w.__queueError = null;
      document.addEventListener("corten:error", (e) => (w.__queueError = /** @type {CustomEvent} */ (e).detail.status), { signal: w.__queueCase.signal });
    }, `<form id="queue" method="post" action="/queue" data-patch><input name="n" value="1">${keyField}<button name="b" value="save">Save</button><button name="b" value="other">Other</button></form>`);
    await page.fill("#queue-box [name=n]", "5");
    const first = page.waitForRequest((r) => new URL(r.url()).pathname === "/queue", { timeout: 6000 });
    await press("#queue-box button[value=save]");
    await first;
    await press("#queue-box button[value=other]");
    pressed();
    const until = Date.now() + 6000;
    while (!(queueAnswered === 2 && (await page.getAttribute("#queue-box form", "aria-busy")) === null) && Date.now() < until) await page.waitForTimeout(50);
    await page.waitForTimeout(300);
    const after = await queueFields();
    const error = await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__queueCase.abort();
      return /** @type {number | null} */ (w.__queueError);
    });
    const [one, two] = queueSent;
    check(
      "a 205 does not reset a form pressed again with other values while it was out: the waiting submit goes with the typed value, and its own 205 resets the form",
      queueSent.length === 2 &&
        (one ?? "").startsWith(`POST 5 ${zero} `) &&
        (one ?? "").endsWith(" save") &&
        (two ?? "").startsWith("POST 5 ") &&
        (two ?? "").endsWith(" other") &&
        !(two ?? "").includes(zero) &&
        error === null &&
        after.n === "1",
      `${queueSent.join()}; error: ${error}; left ${JSON.stringify(after)}`,
    );
  }
  queuePressed = Promise.resolve();
  await page.unroute("**/queue*");
  page.off("requestfailed", queueGaveUp);
  await page.evaluate(() => document.getElementById("queue-box")?.remove());
  // The browser logs the 503, 500 and 409 the smoke answered; nothing else is expected.
  errors.splice(queueLogged, errors.length, ...errors.slice(queueLogged).filter((e) => !/Failed to load resource/.test(e)));

  // A file is in a pending submit's key by its size and time as well as its name, so another file
  // of the same name, chosen while a write sending the first is out, is a new submit: it goes once
  // the write's answer is drawn. The same press again with the same file sends nothing (#1229).
  // Each write's answer is held until the second press is made, so that press meets it still out.
  // The files are made in the page, so each part of the key is told apart: another size at the
  // same time, and the same size at another time.
  let fileSends = 0;
  /** @type {Promise<void>} */
  let filePressed = Promise.resolve();
  await page.route("**/queue-file", async (route) => {
    const n = (fileSends += 1);
    await filePressed;
    await route
      .fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "corten-patch": "1" }, body: `<p id="queue-file-out">saved ${n}</p>` })
      .catch(() => {});
  });
  /** Sets the form's file to one named card.png, of `text`, last modified at `time`. @param {[string, number]} file */
  const pickFile = (file) =>
    page.evaluate(([text, time]) => {
      const files = new DataTransfer();
      files.items.add(new File([text], "card.png", { type: "image/png", lastModified: time }));
      /** @type {HTMLInputElement} */ (document.querySelector("#queue-file [name=f]")).files = files.files;
    }, file);
  /** Presses with a file, then again with `second` chosen (or the same file), and counts the sends. @param {[string, number] | null} second */
  const fileCase = async (second) => {
    fileSends = 0;
    /** @type {() => void} */
    let pressed = () => {};
    filePressed = new Promise((resolve) => (pressed = resolve));
    await page.evaluate(() => {
      document.getElementById("queue-file-box")?.remove();
      document
        .querySelector("main")
        ?.insertAdjacentHTML(
          "beforeend",
          __html('<div id="queue-file-box"><form id="queue-file" method="post" action="/queue-file" enctype="multipart/form-data" data-patch><input type="file" name="f"><button>Send</button></form><p id="queue-file-out"></p></div>'),
        );
    });
    await pickFile(["first", 1]);
    // As in queueCase, the submit must run before changing the file or releasing its answer.
    const first = page.waitForRequest((r) => new URL(r.url()).pathname === "/queue-file", { timeout: 6000 });
    await press("#queue-file button");
    await first;
    if (second) await pickFile(second);
    const busy = await page.getAttribute("#queue-file", "aria-busy");
    await press("#queue-file button");
    pressed();
    const want = second ? "saved 2" : "saved 1";
    // Read the outcome even when a loaded browser is not delivering animation frames.
    const ended = await page
      .waitForFunction((want) => document.getElementById("queue-file-out")?.textContent === want, want, { timeout: 6000, polling: 50 })
      .then(() => true, () => false);
    // Time in which a send the queue must not make would be seen.
    await page.waitForTimeout(700);
    const out = await page.evaluate(() => document.getElementById("queue-file-out")?.textContent ?? null);
    return { sends: fileSends, busy, ended, out };
  };
  const sameFile = await fileCase(null);
  const otherSize = await fileCase(["another picture", 1]);
  const otherTime = await fileCase(["secnd", 2]);
  await page.unroute("**/queue-file");
  await page.evaluate(() => document.getElementById("queue-file-box")?.remove());
  check(
    "another file of the same name pressed while a write sending one is out is sent after it, whether its size or its time differs; the same file pressed again is not",
    [sameFile, otherSize, otherTime].every((c) => c.busy === "true" && c.ended) && sameFile.sends === 1 && otherSize.sends === 2 && otherTime.sends === 2,
    `same file: ${JSON.stringify(sameFile)}; another size: ${JSON.stringify(otherSize)}; another time: ${JSON.stringify(otherTime)}`,
  );
}
