import { base, engine, skip, check } from "./helpers.mjs";

export async function steps(orders) {
  // Steps: counted, a Done step drawn with a check mark a screen reader does not read (its words
  // are, and are not shown), the current one filled, and a step with no page a <span>, numbered
  // but not a link.
  const draft = await orders.context().newPage();
  await draft.goto(`${base}/`);
  const steps = await draft.evaluate(() =>
    [...document.querySelectorAll("nav[class*='steps__steps'] li")].map((li) => {
      const step = /** @type {HTMLElement} */ (li.firstElementChild);
      const mark = getComputedStyle(step, "::before");
      const status = step.querySelector("[class*='steps__status']");
      return {
        tag: step.tagName,
        checked: mark.content.includes("\u2713"),
        numbered: mark.content.startsWith("counter(kit-step)") && mark.width === mark.height && parseFloat(mark.width) > 20,
        blocked: mark.content.startsWith('"!"'),
        fill: mark.backgroundColor,
        line: getComputedStyle(li, "::after").backgroundColor,
        hidden: status ? status.getBoundingClientRect().width <= 1 : null,
      };
    }),
  );
  const [done, now, blocked, later] = steps;
  check(
    "Steps: the done step is drawn with a check mark, the current filled, a blocked one with ! in its own color, the others numbered",
    steps.length === 4 &&
      done.checked && !now.checked && !later.checked && now.numbered && later.numbered && !done.numbered &&
      blocked.blocked && !blocked.numbered && !blocked.checked && !later.blocked &&
      done.fill !== now.fill && now.fill !== later.fill && blocked.fill !== later.fill && blocked.fill !== now.fill && done.line !== now.line,
    JSON.stringify(steps),
  );
  // A description is shown under its step's name, not part of the link's name; on a phone it is
  // read and not shown.
  const described = () =>
    draft.evaluate(() =>
      [...document.querySelectorAll("nav[class*='steps__steps'] li")].map((li) => {
        const note = li.querySelector("[class*='steps__description']");
        if (!note) return null;
        const name = /** @type {HTMLElement} */ (li.firstElementChild).getBoundingClientRect();
        // The name's own text, which ends where its column should (the element stretches to it).
        const words = document.createRange();
        words.selectNodeContents(/** @type {Node} */ (li.firstElementChild?.firstChild));
        const text = words.getBoundingClientRect();
        const box = note.getBoundingClientRect();
        // The line to the next step starts by the name, not past the description.
        const line = li.matches(":last-child") ? null : getComputedStyle(li, "::after").width;
        return {
          text: note.textContent,
          below: box.top >= name.bottom - 1,
          shown: box.width > 1 && box.height > 1,
          inLink: !!note.closest("a"),
          marked: getComputedStyle(note, "::before").content !== "none",
          top: Math.round(li.getBoundingClientRect().top),
          gap: Math.round(li.getBoundingClientRect().right - text.right - (line === null ? 0 : parseFloat(line))),
        };
      }),
    );
  const notes = await described();
  // Each step on a row starts at its top, a step with a description or not.
  const tops = await draft.evaluate(() => [...document.querySelectorAll("nav[class*='steps__steps'] li")].map((li) => Math.round(li.getBoundingClientRect().top)));
  // A long description wraps inside the step, and the step's name does not.
  const longNote = await draft.evaluate(() => {
    const note = /** @type {HTMLElement} */ (document.querySelector("nav[class*='steps__steps'] [class*='steps__description']"));
    const was = note.textContent;
    note.textContent = "Price, quantity and condition, and a note to the buyer on the card's centering and edges";
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const out = { lines: Math.round(note.getBoundingClientRect().height / parseFloat(getComputedStyle(note).lineHeight)), width: note.getBoundingClientRect().width / rem };
    note.textContent = was;
    return out;
  });
  const flow = draft.getByRole("navigation", { name: "Listing steps" });
  const named = await flow.getByRole("link").evaluateAll((all) => all.map((a) => a.getAttribute("aria-current") ?? ""));
  check(
    "Steps: a screen reader hears the done and blocked steps' status, the page does not show it, and a step not reachable is no link",
    (await flow.getByRole("link", { name: "Read the guide (done)", exact: true }).count()) === 1 &&
      (await flow.getByRole("link", { name: "Draft", exact: true }).count()) === 1 &&
      named.join() === ",step" &&
      done.hidden === true &&
      blocked.tag === "SPAN" &&
      blocked.hidden === true &&
      later.tag === "SPAN" &&
      later.hidden === true,
    JSON.stringify({ named, done, blocked, later }),
  );
  check(
    "Steps: a description is shown under its step's name, outside the link, with no mark of its own, and the line starts by the name",
    notes.length === 4 && notes[0] === null && notes[3] === null && [notes[1], notes[2]].every((n) => n && n.below && n.shown && !n.inLink && !n.marked && n.gap <= 10),
    JSON.stringify(notes),
  );
  // Tops within a step's height of each other are one row; a wrapped row starts well below.
  const rowsAligned = tops.every((t, i) => i === 0 || t === tops[i - 1] || t - tops[i - 1] > 30);
  check("Steps: the steps of a row share a top, and a long description wraps", rowsAligned && longNote.lines >= 2 && longNote.width <= 16.01, JSON.stringify({ tops, longNote }));
  await draft.setViewportSize({ width: 320, height: 640 });
  await draft.waitForFunction(() => innerWidth === 320, null, { timeout: 5000 }).catch(() => {});
  const fits = await draft.evaluate(() => ({ fits: document.documentElement.scrollWidth <= innerWidth, width: innerWidth }));
  check("Steps: on a phone they fit the page", fits.fits && fits.width === 320, JSON.stringify(fits));
  const phoneNotes = await described();
  check(
    "Steps: on a phone a description is not shown and is still in the page",
    [phoneNotes[1], phoneNotes[2]].every((n) => n && !n.shown && n.text),
    JSON.stringify(phoneNotes),
  );
  // A timeline (the orders page's payout): one step per row down the page, on a phone too, each
  // description shown beside its mark, the line from each mark down to the next, and a failed step
  // drawn with a cross in a color of its own, its words read and not shown.
  const payout = await orders.context().newPage();
  await payout.setViewportSize({ width: 390, height: 800 });
  await payout.goto(`${base}/orders`);
  const timeline = await payout.getByRole("list", { name: "Payout" }).evaluate((nav) =>
    [...nav.querySelectorAll("li")].map((li) => {
      const step = /** @type {HTMLElement} */ (li.firstElementChild);
      const mark = getComputedStyle(step, "::before");
      const note = /** @type {HTMLElement} */ (li.querySelector("[class*='steps__description']"));
      const line = getComputedStyle(li, "::after");
      const box = li.getBoundingClientRect();
      const status = step.querySelector("[class*='steps__status']");
      return {
        left: Math.round(box.left),
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        note: note.checkVisibility() && note.getBoundingClientRect().width > 50 && note.getBoundingClientRect().right <= innerWidth,
        line: li.matches(":last-child") ? null : { width: line.width, height: parseFloat(line.height) },
        crossed: mark.content.includes("\u2715"),
        fill: mark.backgroundColor,
        hidden: status ? status.getBoundingClientRect().width <= 1 : null,
      };
    }),
  );
  const failedName = await payout.getByRole("list", { name: "Payout" }).locator("li").last().locator("span").first().textContent();
  // A name that wraps keeps its mark beside its first line, and the line down starts under the mark.
  // So with a theme's larger control font, whose line is taller than the mark.
  const wrapped = await payout.getByRole("list", { name: "Payout" }).evaluate((list) => {
    const li = /** @type {HTMLElement} */ (list.querySelector("li"));
    const step = /** @type {HTMLElement} */ (li.firstElementChild);
    const text = /** @type {Text} */ ([...step.childNodes].find((n) => n.nodeType === Node.TEXT_NODE));
    text.textContent = "Provider transfer submitted and waiting on the bank to answer";
    // A reference with no place to break, which must not widen the page (measured below).
    /** @type {HTMLElement} */ (li.querySelector("[class*='steps__description']")).textContent = `Reference ${"0123456789abcdef".repeat(4)}`;
    const measure = () => {
      const range = document.createRange();
      range.selectNodeContents(text);
      const lines = range.getClientRects();
      const first = lines[0];
      const mark = getComputedStyle(step, "::before");
      const top = step.getBoundingClientRect().top + parseFloat(getComputedStyle(step).paddingTop) + parseFloat(mark.marginTop);
      const foot = top + parseFloat(mark.height);
      const after = getComputedStyle(li, "::after");
      const line = li.getBoundingClientRect().top + parseFloat(after.top);
      const end = li.getBoundingClientRect().bottom - parseFloat(after.bottom);
      const next = /** @type {HTMLElement} */ (/** @type {Element} */ (li.nextElementSibling).firstElementChild);
      const head = next.getBoundingClientRect().top + parseFloat(getComputedStyle(next).paddingTop) + parseFloat(getComputedStyle(next, "::before").marginTop);
      return {
        lines: new Set([...lines].map((r) => Math.round(r.top))).size,
        beside: Math.abs((first.top + first.bottom) / 2 - (top + foot) / 2) <= 2,
        under: Math.abs(line - foot) <= 0.5,
        reaches: Math.abs(end - head) <= 0.5,
      };
    };
    const plain = measure();
    list.style.setProperty("--control-font-size", "1.5rem");
    const large = measure();
    list.style.removeProperty("--control-font-size");
    return { plain, large };
  });
  const fitsPayout = await payout.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  // A history is a list named by its label, not a navigation landmark: it goes nowhere. Exact,
  // as the payouts card's pager below it is a navigation named "Payouts".
  const payoutLandmarks = await payout.getByRole("navigation", { name: "Payout", exact: true }).count();
  // Under forced colors the line down keeps the text's color and a failed step its cross.
  const forcedTimeline = engine === "webkit" ? null : await (async () => {
    await payout.emulateMedia({ forcedColors: "active" });
    const out = await payout.getByRole("list", { name: "Payout" }).evaluate((list) => {
      const items = [...list.querySelectorAll("li")];
      const last = /** @type {Element} */ (items[items.length - 1].firstElementChild);
      return { line: getComputedStyle(items[0], "::after").backgroundColor, text: getComputedStyle(items[0]).color, cross: getComputedStyle(last, "::before").content };
    });
    await payout.emulateMedia({ forcedColors: "none" });
    return out;
  })();
  await payout.close();
  const [payStep1, payStep2, payStep3] = timeline;
  check(
    "Steps as a timeline: one step per row down the page on a phone, each description shown, a line down from each mark",
    timeline.length === 3 &&
      timeline.every((s) => s.left === payStep1.left && s.note) &&
      payStep2.top >= payStep1.bottom - 1 && payStep3.top >= payStep2.bottom - 1 &&
      [payStep1, payStep2].every((s) => s.line && s.line.width === "1px" && s.line.height > 10) &&
      fitsPayout,
    JSON.stringify({ timeline, fitsPayout }),
  );
  check(
    "Steps as a timeline: a name that wraps keeps its mark by its first line, the line running from its foot to the next mark, with a larger control font too",
    [wrapped.plain, wrapped.large].every((w) => w.lines > 1 && w.beside && w.under && w.reaches),
    JSON.stringify(wrapped),
  );
  check("Steps as a timeline: a list named by its label, not a navigation landmark", payoutLandmarks === 0, String(payoutLandmarks));
  const forcedTimelineName = "Steps as a timeline: under forced colors the line keeps the text's color and a failed step its cross";
  if (forcedTimeline) check(forcedTimelineName, forcedTimeline.line === forcedTimeline.text && forcedTimeline.cross.includes("\u2715"), JSON.stringify(forcedTimeline));
  else skip(forcedTimelineName, "Playwright's WebKit does not emulate forced colors");
  check(
    "Steps: a failed step is drawn with a cross in its own color, told from blocked and done, its words read and not shown",
    payStep3.crossed && !payStep1.crossed && payStep3.fill !== payStep1.fill && payStep3.fill !== blocked.fill && payStep3.hidden === true && failedName === "Paid(failed)",
    JSON.stringify({ payStep3, blocked: blocked.fill, failedName }),
  );
  // Under forced colors, which drop fills and shadows: the lines between steps keep the text's
  // color, the current step's mark is the system's highlight, and the current link is underlined.
  const forcedMarks = "Steps and NavBar: under forced colors the lines, the current and blocked steps and the current link are drawn";
  return { draft, forcedMarks };
}
