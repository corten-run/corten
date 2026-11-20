import { base, engine, seen, skip, check } from "./helpers.mjs";

export async function withoutJs(browser, signsIn) {
  seen(`[${engine}] (step) opening a context without JavaScript`);
  const noJs = await browser.newContext({ javaScriptEnabled: false });
  const plain = await noJs.newPage();
  seen(`[${engine}] (step) loading the page without JavaScript`);
  const plainFirst = await plain.goto(base);
  check("without JavaScript prices are server-rendered", (await plain.$$('[data-ref="price"]')).length === 3);
  // The visitor's list rides in a Secure cookie, which Playwright's WebKit never sends back over
  // http: there the id the first page set, read from its answer as the sign-in's token is, is given
  // back as a plain cookie, so the write and the page it goes back to are the same visitor's.
  if (!signsIn) {
    const setCookie = (await plainFirst?.headerValue("set-cookie")) ?? "";
    const visitor = /(?:^|\n)visitor=([0-9a-f]{32});/.exec(setCookie)?.[1];
    check("WebKit is given the visitor id the first page set, to send back as a plain cookie", visitor !== undefined, `set-cookie: ${setCookie || "(none)"}`);
    if (visitor) {
      await noJs.clearCookies({ name: "visitor" });
      await noJs.addCookies([{ name: "visitor", value: visitor, url: base }]);
    }
  }
  await plain.selectOption("select[name=id]", "SOLR");
  // `/watch` is a path of its own with no page: the write sends the browser back to the watchlist,
  // whose form says what changed (a notice), so a reload there is a GET.
  const watched = await Promise.all([
    plain.waitForResponse((r) => new URL(r.url()).pathname === "/watch" && r.request().method() === "POST"),
    plain.waitForNavigation(),
    plain.click("#watch-form button"),
  ]).then(([answer]) => answer);
  check("without JavaScript the form posts and the write sends the browser back to the watchlist", watched.status() === 303 && new URL(plain.url()).pathname === "/", `${watched.status()} ${plain.url()}`);
  // The notice rides in a `__Host-` cookie, which must be Secure, so WebKit never sends it back
  // over http and its checks are skipped there; the list is checked in every engine.
  const plainWatched = ["without JavaScript the watchlist says what the write did", "without JavaScript the visitor's time zone is not known"];
  if (signsIn) {
    check(plainWatched[0], ((await plain.textContent("#watch-message")) ?? "").startsWith("Watching Sunreach Solar"), (await plain.textContent("#watch-message")) ?? "");
    check(plainWatched[1], !((await plain.textContent("#watch-message")) ?? "").includes("Alerts follow"));
  } else for (const name of plainWatched) skip(name, "the notice's __Host- cookie must be Secure, and Playwright's WebKit never sends a Secure cookie back over http");
  check("the page it goes back to has the stock on the list", (await plain.$('[data-ref="price"][data-key="SOLR"]')) !== null);
  // A stock the market does not list is refused where it was posted: the watchlist drawn at
  // `/watch` with a 422, the form saying so and the list as it was.
  await plain.goto(base);
  await plain.evaluate(() => {
    const option = document.createElement("option");
    option.value = "ZZZZ";
    document.querySelector("select[name=id]")?.append(option);
  });
  await plain.selectOption("select[name=id]", "ZZZZ");
  const refusedWatch = await Promise.all([
    plain.waitForResponse((r) => new URL(r.url()).pathname === "/watch" && r.request().method() === "POST"),
    plain.waitForNavigation(),
    plain.click("#watch-form button"),
  ]).then(([answer]) => answer);
  check(
    "without JavaScript a stock the market does not list is refused with the page, where it was posted",
    refusedWatch.status() === 422 && new URL(plain.url()).pathname === "/watch" && (await plain.textContent("#watch-message")) === "That stock is not on the market.",
    `${refusedWatch.status()} ${plain.url()} ${await plain.textContent("#watch-message")}`,
  );
  check("the refused page shows the list as it was", (await plain.$('[data-ref="price"][data-key="SOLR"]')) !== null);
  await plain.goto(base);
  // A slow part the page waits for: nothing reads it, so the line saying it is on its way is
  // hidden under @media (scripting: none), and the link to the same page with it read in is not
  // (#1264). Followed only when shown, so a link that is not fails the checks, not the run.
  const plainLink = await plain.isVisible("#picks a");
  check("without JavaScript a slow part's placeholder is a link, not a line that waits", !(await plain.isVisible("#picks span")) && plainLink);
  if (plainLink) await Promise.all([plain.waitForNavigation({ timeout: 5000 }), plain.click("#picks a", { timeout: 3000 })]).catch(() => {});
  check(
    "the page it links to has the slow part read in",
    new URL(plain.url()).search === "?picks=true" && (await plain.$$("ul#picks li")).length === 2 && (await plain.$("template[data-corten-read-now]")) === null,
    plain.url(),
  );
  await noJs.close();

  // Req::resend_to: a browser's first alert names it (a 307 that sets its cookie) and the same
  // form goes on to /alerts/first, sent again by the runtime's fetch for a data-patch form and by
  // the browser without JavaScript, so the alert is written under the id the browser presents.
  for (const js of [true, false]) {
    const name = js ? "a data-patch form" : "without JavaScript, a form";
    seen(`[${engine}] (step) ${name} sent on`);
    const fresh = await browser.newContext({ javaScriptEnabled: js });
    const first = await fresh.newPage();
    /** @type {import("@playwright/test").Request[]} */
    const sentOn = [];
    first.on("request", (r) => r.method() === "POST" && new URL(r.url()).pathname === "/alerts/first" && sentOn.push(r));
    await first.goto(`${base}/alerts`);
    await first.selectOption("#alert-form select", "SOLR");
    await first.fill("#alert-form input[name=above]", "42");
    if (js) {
      await first.click("#alert-form button");
      await first.waitForFunction(() => document.getElementById("alert-status")?.textContent === "Saving...", null, { timeout: 5000 }).catch(() => {});
    } else {
      await Promise.all([first.waitForURL(/\/alerts\?saved=\d+$/, { timeout: 5000 }).catch(() => {}), first.click("#alert-form button")]);
    }
    const body = new URLSearchParams(sentOn[0]?.postData() ?? "");
    check(`${name} sent on by resend_to goes with the same fields`, sentOn.length === 1 && body.get("id") === "SOLR" && body.get("above") === "42", `${sentOn.length} sent: ${body}`);
    const cookie = (await sentOn[0]?.allHeaders())?.cookie ?? "";
    if (signsIn) check(`${name} sent on presents the cookie its 307 set`, /(^|; )visitor=[0-9a-f]{32}($|;)/.test(cookie), cookie);
    else skip(`${name} sent on presents the cookie its 307 set`, "the browser does not send Secure cookies over http");
    const answered = js ? (await first.textContent("#alert-status")) === "Saving..." && first.url() === `${base}/alerts` : /\/alerts\?saved=\d+$/.test(first.url());
    check(`${name} sent on is answered as the write's own`, answered, first.url());
    await fresh.close();
  }

  // App::client_zone: the runtime keeps the browser's time zone in a cookie once a page has
  // loaded, so the next request (a form's post) tells the server where the visitor is.
  const abroad = await browser.newContext({ timezoneId: "Pacific/Auckland" });
  const kiwi = await abroad.newPage();
  await kiwi.goto(base);
  await kiwi.waitForFunction(() => document.cookie.includes("corten-zone="), null, { timeout: 4000 }).catch(() => {});
  await kiwi.selectOption("select[name=id]", "SOLR");
  await kiwi.click("#watch-form button");
  await kiwi.waitForFunction(() => document.getElementById("watch-message")?.textContent?.startsWith("Watching Sunreach Solar"), null, { timeout: 4000 }).catch(() => {});
  const zoned = (await kiwi.textContent("#watch-message")) ?? "";
  check("a post after the first page knows the visitor's time zone", zoned.includes("Alerts follow Pacific/Auckland time."), zoned);
  await abroad.close();
}
