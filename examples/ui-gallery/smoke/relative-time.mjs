import { base, check } from "./helpers.mjs";

export async function relativeTime(browser, bug) {
  // RelativeTime: the server wrote both times; the browser's clock (faked, from now) moves them.
  const timed = await (await browser.newContext()).newPage();
  const timedErrors = [];
  timed.on("pageerror", (e) => timedErrors.push(String(e)));
  timed.on("console", (m) => m.type() === "error" && !bug(m.text()) && timedErrors.push(m.text()));
  // Paused before the page loads, so only runFor moves its time: a slow read under load adds no
  // seconds, and the pause cannot land in the page's past.
  await timed.clock.install();
  await timed.clock.pauseAt(Date.now() + 1_000);
  await timed.goto(`${base}/`);
  const listed = timed.locator("time").first();
  const expires = timed.locator("time").nth(1);
  check("the server writes a time behind now", (await listed.textContent()) === "3 hr. ago", await listed.textContent());
  check("and one ahead, with its instant", (await expires.textContent()) === "in 1 minute" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/.test((await expires.getAttribute("datetime")) ?? ""), await expires.textContent());
  // To 58.5 seconds before the expiry, measured on the page, whatever the server's and the page's
  // clocks differ by.
  const until = Date.parse((await expires.getAttribute("datetime")) ?? "") - (await timed.evaluate(() => Date.now()));
  await timed.clock.runFor(Math.max(0, until - 58_500));
  const seconds = async () => Number(/^in (5\d) seconds$/.exec((await expires.textContent()) ?? "")?.[1]);
  const first = await seconds();
  check("under a minute ahead, it counts seconds", first > 50, await expires.textContent());
  // A tick redraws only the time whose text changes: the one counting seconds, not the one hours
  // old beside it (one format call a second, not one for every time on the page).
  await timed.evaluate(() => {
    const format = Intl.RelativeTimeFormat.prototype.format;
    (/** @type {any} */ (window)).__formats = 0;
    Intl.RelativeTimeFormat.prototype.format = function (...args) {
      (/** @type {any} */ (window)).__formats++;
      return format.apply(this, args);
    };
  });
  await timed.clock.runFor(2_000);
  check("each second", (await seconds()) === first - 2, `${first} then ${await expires.textContent()}`);
  const formats = await timed.evaluate(() => (/** @type {any} */ (window)).__formats);
  check("a tick redraws only the time whose text changes", formats <= 3, `${formats} format calls in 2 seconds`);
  await timed.clock.runFor(60_000);
  check("past it, it says how long ago", /^\d+ seconds? ago$/.test((await expires.textContent()) ?? ""), await expires.textContent());
  check("the one behind kept its hour", (await listed.textContent()) === "3 hr. ago", await listed.textContent());
  await timed.clock.runFor(55 * 60_000);
  check("an hour on, the one behind moves", (await listed.textContent()) === "4 hr. ago" && (await expires.textContent()) === "55 minutes ago", `${await listed.textContent()}, ${await expires.textContent()}`);
  // Back from sleep: the clock moved two hours and no timer ran; the page coming back redraws.
  await timed.clock.setSystemTime((await timed.evaluate(() => Date.now())) + 2 * 3600_000);
  await timed.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  check("the page coming back redraws as of its clock", (await listed.textContent()) === "6 hr. ago" && (await expires.textContent()) === "2 hours ago", `${await listed.textContent()}, ${await expires.textContent()}`);
  // A time put in place of another, as a patch does: the new one is kept current, the old one let
  // go. The clock first moves past the page's timer with nothing to say so (a sleep), so the new
  // time cannot count on that timer.
  await timed.clock.setSystemTime((await timed.evaluate(() => Date.now())) + 2 * 3600_000);
  await timed.evaluate(() => {
    const old = /** @type {HTMLTimeElement} */ (document.querySelectorAll("time")[1]);
    const time = /** @type {HTMLTimeElement} */ (old.cloneNode(false));
    time.dateTime = new Date(Date.now() + 90_000).toISOString();
    time.textContent = "in 1 minute";
    old.replaceWith(time);
  });
  await timed.clock.runFor(31_000);
  check("a time that replaces another is kept current", /^in 5\d seconds$/.test((await expires.textContent()) ?? ""), await expires.textContent());
  // The clock set back half a minute while the page is shown: the timer comes before its time by
  // the page's clock, and every time is drawn again from it.
  await timed.clock.setSystemTime((await timed.evaluate(() => Date.now())) - 30_000);
  await timed.clock.runFor(2_000);
  check("a clock set back draws the times again from it", (await expires.textContent()) === "in 1 minute", await expires.textContent());
  check("no console errors with relative times", timedErrors.length === 0, timedErrors.join(" | "));
  await timed.context().close();
  // A browser without the page's locale falls back to another language: the server's text stays.
  const lacking = await (await browser.newContext()).newPage();
  const lackingErrors = [];
  lacking.on("pageerror", (e) => lackingErrors.push(String(e)));
  lacking.on("console", (m) => m.type() === "error" && !bug(m.text()) && lackingErrors.push(m.text()));
  await lacking.addInitScript(() => {
    const options = Intl.RelativeTimeFormat.prototype.resolvedOptions;
    Intl.RelativeTimeFormat.prototype.resolvedOptions = function () {
      /** @type {any} */ (window).asked = (/** @type {any} */ (window).asked ?? 0) + 1;
      return { ...options.call(this), locale: "fr" };
    };
  });
  await lacking.clock.install();
  await lacking.goto(`${base}/`);
  await lacking.clock.runFor(31_000);
  const asked = await lacking.evaluate(() => /** @type {any} */ (window).asked ?? 0);
  check(
    "a locale the browser lacks keeps the server's text",
    asked > 0 && lackingErrors.length === 0 && (await lacking.locator("time").nth(1).textContent()) === "in 1 minute",
    `${await lacking.locator("time").nth(1).textContent()}, asked ${asked}, ${lackingErrors.join(" | ")}`,
  );
  await lacking.context().close();
}
