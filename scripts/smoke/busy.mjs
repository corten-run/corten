import { skip, check, pollFor } from "./helpers.mjs";

export async function busyForms(page) {
  // A data-patch form's submit marks the button that sent it busy with the form, one outside the
  // form (`form=`) too, until the answer is drawn; a newer submit by another button takes the
  // marks, and the first button's goes (#1063).
  // A's read is answered only once B's marks are read, so B replaces a read still on its way.
  /** @type {() => void} */
  let answerA = () => {};
  /** @type {Promise<unknown>} */
  let heldA = Promise.resolve();
  const holdA = () => (heldA = new Promise((resolve) => (answerA = () => resolve(undefined))));
  holdA();
  await page.route("**/busy-read*", async (route) => {
    const by = new URL(route.request().url()).searchParams.get("by");
    if (by === "a") await heldA;
    await route.fulfill({ headers: { "content-type": "text/html; charset=utf-8", "corten-patch": "1" }, body: `<p id="busy-said">read ${by}</p>` }).catch(() => {});
  });
  await page.evaluate(() =>
    document.querySelector("main")?.insertAdjacentHTML(
      "beforeend",
      __html('<form id="busy-form" method="get" action="/busy-read" data-patch></form><p id="busy-said"></p><button id="busy-a" form="busy-form" name="by" value="a">A</button><button id="busy-b" form="busy-form" name="by" value="b">B</button>'),
    ),
  );
  const busyMarks = () => page.evaluate(() => ["busy-form", "busy-a", "busy-b"].map((id) => document.getElementById(id)?.getAttribute("aria-busy") ?? "-").join());
  // Each click and the read of the marks in one task: the marks are moved by the submit itself,
  // not by A's read settling later (#1108).
  /** @param {string} id @param {string[]} marked */
  const clickAndMarks = (id, marked = ["busy-form", "busy-a", "busy-b"]) =>
    page.evaluate(([id, marked]) => {
      document.getElementById(id)?.click();
      return marked.map((id) => document.getElementById(id)?.getAttribute("aria-busy") ?? "-").join();
    }, /** @type {[string, string[]]} */ ([id, marked]));
  let whileA = "";
  let whileB = "";
  try {
    whileA = await clickAndMarks("busy-a");
    whileB = await clickAndMarks("busy-b");
  } finally {
    answerA();
  }
  await page.waitForFunction(() => document.querySelector("#busy-said")?.textContent === "read b", null, { timeout: 5000 }).catch(() => {});
  const busyAfter = await busyMarks();
  check(
    "a data-patch form's submit marks the button that sent it, one outside the form too, until its answer is drawn",
    whileA === "true,true,-" && whileB === "true,-,true" && busyAfter === "-,-,-",
    `${whileA} | ${whileB} | ${busyAfter}`,
  );
  // A navigation abandons a read on its way, which drops its marks at once, not when its own code
  // next runs (#1108). The page navigates to its own address, so the check stays on this page.
  const abandonName = "a submit a navigation abandons drops its marks at once";
  if (!(await page.evaluate(() => "navigation" in window))) skip(abandonName, "without the Navigation API a navigation is a full load");
  else {
    holdA();
    /** @type {string[]} */
    let abandoned = [];
    try {
      abandoned = await page.evaluate(() => {
        const marks = () => ["busy-form", "busy-a", "busy-b"].map((id) => document.getElementById(id)?.getAttribute("aria-busy") ?? "-").join();
        document.getElementById("busy-a")?.click();
        const before = marks();
        /** @type {any} */ (window).navigation.navigate(location.pathname + location.search);
        return [before, marks()];
      });
    } finally {
      answerA();
    }
    // The checks after this one draw into <main>, so this one fails if the page has not swapped.
    const swapped = await page
      .waitForFunction(() => !document.getElementById("busy-said") && !document.querySelector("main")?.hasAttribute("aria-busy"), null, { timeout: 10000 })
      .then(() => true, () => false);
    check(abandonName, swapped && abandoned[0] === "true,true,-" && abandoned[1] === "-,-,-", `${abandoned.join(" -> ")}${swapped ? "" : ", the page did not swap within 10 s"}`);
  }
  await page.unroute("**/busy-read*");
  await page.evaluate(() => ["busy-form", "busy-said", "busy-a", "busy-b"].forEach((id) => document.getElementById(id)?.remove()));

  // A write is not cut short by another button: the one pressed while it is on its way is marked
  // beside it and sends once its answer is drawn. A write whose answer sends the browser to
  // another page keeps its button marked until that page is in, and then clears it, a button in
  // the header (outside what the page swaps) included (#1063).
  // A's answer is held until B is pressed and the marks are read, so B meets it still out however
  // slowly the presses come, and both presses run in the page (#2014). The page's fetch is
  // wrapped so each post is seen where the browser sends it, with what the page showed then: B
  // must be sent only once A's answer (`wrote a`) is drawn, which the route's log cannot show (its
  // handler runs in this process, some time after the browser sent the request). The route logs
  // each post as it comes and each answer as it goes, so the posts are counted, and B's answer is
  // seen drawn: a runtime that dropped B and cleared its mark with A's would leave `wrote a`.
  /** @type {() => void} */
  let answerWriteA = () => {};
  /** @type {Promise<unknown>} */
  let heldWriteA = Promise.resolve();
  /** @type {string[]} */
  const writeLog = [];
  await page.route("**/busy-write*", async (route) => {
    const by = new URLSearchParams(route.request().postData() ?? "").get("by");
    writeLog.push(`post ${by}`);
    if (by === "a") await heldWriteA;
    if (by === "go") await new Promise((resolve) => setTimeout(resolve, 600));
    const headers = by === "go" ? { "corten-location": "/" } : { "content-type": "text/html; charset=utf-8", "corten-patch": "1" };
    // Logged before it goes, so a post it lets out comes after it in the log.
    writeLog.push(`answer ${by}`);
    await route.fulfill({ headers, body: by === "go" ? "" : `<p id="busy-w-said">wrote ${by}</p>` }).catch(() => {});
  });
  await page.evaluate(() => {
    document
      .querySelector("main")
      ?.insertAdjacentHTML(
        "beforeend",
        __html('<form id="busy-w" method="post" action="/busy-write" data-patch></form><p id="busy-w-said"></p><button id="busy-wa" form="busy-w" name="by" value="a">A</button><button id="busy-wb" form="busy-w" name="by" value="b">B</button>'),
      );
    document.querySelector("header")?.insertAdjacentHTML("beforeend", __html('<button id="busy-wgo" form="busy-w" name="by" value="go">Go</button>'));
    const held = /** @type {HTMLElement} */ (document.getElementById("busy-wgo"));
    /** @type {any} */ (window).__goHeld = held;
    // Whether the page the write sent the browser to was in (the form gone) when the mark went.
    new MutationObserver((_, observer) => {
      if (held.getAttribute("aria-busy") === "true") return;
      /** @type {any} */ (window).__goCleared = { pageIn: !document.getElementById("busy-w") };
      observer.disconnect();
    }).observe(held, { attributes: true, attributeFilter: ["aria-busy"] });
    // Each post of the form as the runtime calls fetch for it: the button it is for, and what the
    // page showed of the answers then.
    const w = /** @type {any} */ (window);
    const sent = /** @type {string[]} */ ([]);
    const fetch = window.fetch;
    w.__writesSent = sent;
    w.__unwrapFetch = () => (window.fetch = fetch);
    window.fetch = function (input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.pathname === "/busy-write") {
        const body = init?.body;
        const by = typeof body === "string" ? new URLSearchParams(body).get("by") : body instanceof URLSearchParams || body instanceof FormData ? body.get("by") : null;
        sent.push(`${by} with "${document.getElementById("busy-w-said")?.textContent ?? "no answer"}" drawn`);
      }
      return fetch.call(window, input, init);
    };
  });
  const writeMarks = () => page.evaluate(() => ["busy-w", "busy-wa", "busy-wb"].map((id) => document.getElementById(id)?.getAttribute("aria-busy") ?? "-").join());
  heldWriteA = new Promise((resolve) => (answerWriteA = () => resolve(undefined)));
  let whileWrite = "";
  /** The posts the page had sent once B was pressed, in the same task as the press. */
  let sentAtPress = "";
  /** Whether B's answer was drawn and the form left unmarked within 5 s. */
  let settled = false;
  try {
    try {
      await page.evaluate(() => document.getElementById("busy-wa")?.click());
      [whileWrite, sentAtPress] = await page.evaluate(() => {
        document.getElementById("busy-wb")?.click();
        return [["busy-w", "busy-wa", "busy-wb"].map((id) => document.getElementById(id)?.getAttribute("aria-busy") ?? "-").join(), /** @type {any} */ (window).__writesSent.join("; ")];
      });
    } finally {
      answerWriteA();
    }
    // Polled on a timer, as a loaded browser may not be delivering animation frames; settling after
    // the 5 s fails the check.
    settled = !!(await pollFor(5000, () => page.evaluate(() => document.querySelector("#busy-w-said")?.textContent === "wrote b" && !document.querySelector("#busy-w[aria-busy]"))));
  } finally {
    await page.evaluate(() => /** @type {any} */ (window).__unwrapFetch?.());
  }
  const afterWrites = await writeMarks();
  const wrote = await page.evaluate(() => document.querySelector("#busy-w-said")?.textContent ?? null);
  const sentWrites = await page.evaluate(() => /** @type {any} */ (window).__writesSent.join("; "));
  const logged = writeLog.join();
  check(
    "a button pressed while a write is on its way is marked beside it and sends after its answer",
    settled &&
      whileWrite === "true,true,true" &&
      sentAtPress === 'a with "" drawn' &&
      sentWrites === 'a with "" drawn; b with "wrote a" drawn' &&
      logged === "post a,answer a,post b,answer b" &&
      wrote === "wrote b" &&
      afterWrites === "-,-,-",
    `${settled ? "" : "not settled within 5 s; "}${whileWrite} | ${afterWrites}; ${wrote}; sent: ${sentWrites} (${sentAtPress || "nothing"} when B was pressed); route: ${logged}`,
  );
  const redirectName = "a write that sends the browser to another page keeps its button busy until that page is in";
  return { redirectName };
}
