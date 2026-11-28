import { base, engine, skip, check } from "./helpers.mjs";

export async function meterProgress(orders, browser) {
  // Meter: the native element, named by its field's label, its fill in the state's color: the
  // limit's value sits between low and high with optimum under low, one range off the good one.
  // (By its label: Playwright names a meter from its fallback text, where browsers use the label.)
  const meter = await orders.getByLabel("Sold this month").evaluate((m) => {
    const el = /** @type {HTMLMeterElement} */ (m);
    const box = el.getBoundingClientRect();
    return { tag: el.tagName, value: el.value, max: el.max, width: Math.round(box.width), height: Math.round(box.height) };
  });
  check(
    "Meter: a <meter> named by its label, drawn as a bar",
    meter.tag === "METER" && meter.value === 12375 && meter.max === 15000 && meter.width > 100 && meter.height === 8,
    JSON.stringify(meter),
  );
  // Its fill, as drawn, in each state's color: a plain measure (no low or high) in the primary
  // color; with low, high and optimum under low, the success color in the good range, the warning
  // color one range off it (the gallery's value) and the destructive color two off. The probe page
  // sets the meter's attributes from a script (attributes, not styles: the CSP allows them) and
  // samples a screenshot inside the fill, and past it on the track. The tokens are read as the page
  // has them. The screenshots are a page of their own: WebKit's adds a stylesheet the CSP refuses,
  // which is Playwright's, not the page's, so it stays out of this page's console check.
  const tokens = await orders.evaluate(() =>
    Object.fromEntries(["--primary", "--success", "--warning", "--destructive", "--border"].map((p) => [p, getComputedStyle(document.documentElement).getPropertyValue(p).trim()])),
  );
  const probe = await (await browser.newContext()).newPage();
  await probe.goto(`${base}/orders`);
  // The page's own range; each state sets every attribute, so none depends on the one before it.
  const ranged = await probe.getByLabel("Sold this month").evaluate((m) => ({ low: m.getAttribute("low"), high: m.getAttribute("high"), optimum: m.getAttribute("optimum") }));
  const states = [
    { name: "plain", attrs: { low: null, high: null, optimum: null, value: "6000" }, token: "--primary" },
    { name: "good", attrs: { ...ranged, value: "6000" }, token: "--success" },
    { name: "warning", attrs: { ...ranged, value: "12375" }, token: "--warning" },
    { name: "destructive", attrs: { ...ranged, value: "14250" }, token: "--destructive" },
  ];
  const shots = [];
  for (const state of states) {
    const filled = await probe.getByLabel("Sold this month").evaluate((m, attrs) => {
      for (const [name, value] of Object.entries(attrs)) value === null ? m.removeAttribute(name) : m.setAttribute(name, value);
      const el = /** @type {HTMLMeterElement} */ (m);
      return el.value / el.max;
    }, state.attrs);
    shots.push({ ...state, filled, png: (await probe.getByLabel("Sold this month").screenshot()).toString("base64") });
  }
  await probe.context().close();
  const blank = await orders.context().newPage();
  const drawn = await blank.evaluate(
    async ([shots, tokens]) => {
      const out = [];
      for (const { name, token, filled, png } of shots) {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        [canvas.width, canvas.height] = [img.width, img.height];
        const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
        g.drawImage(img, 0, 0);
        const at = (/** @type {number} */ x) => [...g.getImageData(Math.round(img.width * x), Math.floor(img.height / 2), 1, 1).data].slice(0, 3);
        // Inside the fill (half way to the value), and past it on the track (clear of the rounded end).
        const [fill, past] = [at(filled / 2), at((filled + 1) / 2)];
        // Each token's color, as the canvas paints it.
        const paint = (/** @type {string} */ c) => {
          g.clearRect(0, 0, 1, 1);
          g.fillStyle = c;
          g.fillRect(0, 0, 1, 1);
          return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        out.push({ name, fill, want: paint(tokens[token]), past, empty: paint(tokens["--border"]) });
      }
      return out;
    },
    [shots.map(({ name, token, filled, png }) => ({ name, token, filled, png })), tokens],
  );
  await blank.close();
  const near = (/** @type {number[]} */ a, /** @type {number[]} */ b) => a.every((c, i) => Math.abs(c - b[i]) <= 6);
  for (const { name, fill, want, past, empty } of drawn) {
    check(`Meter: ${name}, drawn in its color up to its value`, near(fill, want) && near(past, empty), JSON.stringify({ fill, want, past, empty }));
  }
  // Progress: the native element, named by its field's label, its fill in the primary color up to
  // its value and its track in the border color (sampled from a screenshot, as the meter's); with
  // no value, a band that moves, and stands still when the reader asks for less motion.
  const progress = await orders.getByLabel("Labels printed").evaluate((p) => {
    const el = /** @type {HTMLProgressElement} */ (p);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return { tag: el.tagName, filled: el.position, height: el.getBoundingClientRect().height / rem };
  });
  check("Progress: a <progress> named by its label, drawn as a bar", progress.tag === "PROGRESS" && Math.abs(progress.filled - 5 / 12) < 0.01 && progress.height === 0.5, JSON.stringify(progress));
  // The screenshot is a page of its own, as the meter's: WebKit's adds a stylesheet the CSP refuses.
  const progressProbe = await (await browser.newContext()).newPage();
  await progressProbe.goto(`${base}/orders`);
  const progressShot = (await progressProbe.getByLabel("Labels printed").screenshot()).toString("base64");
  await progressProbe.context().close();
  const progressBlank = await orders.context().newPage();
  const progressDrawn = await progressBlank.evaluate(
    async ([png, filled, tokens]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      [canvas.width, canvas.height] = [img.width, img.height];
      const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
      g.drawImage(img, 0, 0);
      const at = (/** @type {number} */ x) => [...g.getImageData(Math.round(img.width * x), Math.floor(img.height / 2), 1, 1).data].slice(0, 3);
      const [fill, past] = [at(filled / 2), at((filled + 1) / 2)];
      const paint = (/** @type {string} */ c) => {
        g.clearRect(0, 0, 1, 1);
        g.fillStyle = c;
        g.fillRect(0, 0, 1, 1);
        return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      return { fill, want: paint(tokens["--primary"]), past, empty: paint(tokens["--border"]) };
    },
    /** @type {[string, number, Record<string, string>]} */ ([progressShot, progress.filled, tokens]),
  );
  await progressBlank.close();
  check("Progress: drawn in the primary color up to its value, on the border color", near(progressDrawn.fill, progressDrawn.want) && near(progressDrawn.past, progressDrawn.empty), JSON.stringify(progressDrawn));
  // A finished run in the success tone: a full bar, so its middle is the fill, in the theme's
  // success color and not the primary one (sampled on pages of their own, as above).
  const doneProbe = await (await browser.newContext()).newPage();
  await doneProbe.goto(`${base}/orders`);
  const doneShot = (await doneProbe.getByLabel("Morning labels").screenshot()).toString("base64");
  await doneProbe.context().close();
  const doneBlank = await orders.context().newPage();
  const doneDrawn = await doneBlank.evaluate(
    async ([png, color]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      [canvas.width, canvas.height] = [img.width, img.height];
      const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
      g.drawImage(img, 0, 0);
      const fill = [...g.getImageData(Math.round(img.width / 2), Math.floor(img.height / 2), 1, 1).data].slice(0, 3);
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = color;
      g.fillRect(0, 0, 1, 1);
      return { fill, want: [...g.getImageData(0, 0, 1, 1).data].slice(0, 3) };
    },
    /** @type {[string, string]} */ ([doneShot, tokens["--success"]]),
  );
  await doneBlank.close();
  check("Progress: a finished run's success tone fills it in the success color", near(doneDrawn.fill, doneDrawn.want) && !near(doneDrawn.fill, progressDrawn.want), JSON.stringify(doneDrawn));
  const band = async () =>
    orders.getByLabel("Sending the next label").evaluate((p) => ({
      // Whether the page sees the emulated preference, so a failure says if emulation applied.
      reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      indeterminate: p.matches(":indeterminate"),
      animation: getComputedStyle(p).animationName,
      height: p.getBoundingClientRect().height / parseFloat(getComputedStyle(document.documentElement).fontSize),
    }));
  const moving = await band();
  await orders.emulateMedia({ reducedMotion: "reduce" });
  const still = await band();
  await orders.emulateMedia({ reducedMotion: null });
  check("Progress: with no value, a band that moves, and stands still under reduced motion", moving.indeterminate && moving.animation.endsWith("progress-sweep") && still.animation === "none" && moving.height === 0.25, JSON.stringify({ moving, still }));
  // Under forced colors the engine drops the theme's colors and gradients: the bar must still show
  // how far along it is, and the unknown one its stripes (sampled from screenshots, each on a page
  // of its own as above).
  /**
   * The colors at points of a screenshot, each `[x, y]` a fraction of its width and height,
   * decoded on a page of the context the page check runs in.
   * @param {Buffer} shot
   * @param {[number, number][]} points
   */
  const colorsAt = async (shot, points) => {
    const blank = await orders.context().newPage();
    const at = await blank.evaluate(
      async ([png, points]) => {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        [canvas.width, canvas.height] = [img.width, img.height];
        const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
        g.drawImage(img, 0, 0);
        return points.map(([x, y]) => [...g.getImageData(Math.round((img.width - 1) * x), Math.min(img.height - 1, Math.floor(img.height * y)), 1, 1).data].slice(0, 3));
      },
      /** @type {[string, [number, number][]]} */ ([shot.toString("base64"), points]),
    );
    await blank.close();
    return at;
  };
  const sampled = async (/** @type {string} */ label, /** @type {number[]} */ xs) => {
    const probe = await (await browser.newContext({ forcedColors: "active", reducedMotion: "reduce" })).newPage();
    await probe.goto(`${base}/orders`);
    const forced = await probe.evaluate(() => matchMedia("(forced-colors: active)").matches);
    const shot = await probe.getByLabel(label).screenshot();
    await probe.context().close();
    return { forced, at: await colorsAt(shot, xs.map((x) => [x, 0.5])) };
  };
  const apart = (/** @type {number[]} */ a, /** @type {number[]} */ b) => a.some((c, i) => Math.abs(c - b[i]) > 60);
  const forcedBar = await sampled("Labels printed", [progress.filled / 2, (progress.filled + 1) / 2]);
  const forcedStripes = await sampled("Sending the next label", Array.from({ length: 24 }, (_, i) => (i + 0.5) / 24));
  const striped = forcedStripes.at.some((c) => apart(c, forcedStripes.at[0]));
  if (forcedBar.forced) {
    check("Progress: under forced colors, the fill and the track still differ, and stripes stand for no value", apart(forcedBar.at[0], forcedBar.at[1]) && striped, JSON.stringify({ forcedBar, forcedStripes }));
  } else if (engine === "chromium") {
    check("Progress: Chromium emulates forced colors", false, JSON.stringify(forcedBar));
  } else {
    skip("Progress: under forced colors, the fill and the track still differ", "forced colors are not emulated here");
  }
  // Forced colors paints every background as the page's, so a control whose state is a fill would
  // look the same on and off. In each contrast palette (Firefox has one, whatever the scheme): a
  // checked Checkbox, a Switch that is on and a chosen Radio draw the system's selection color and
  // the unchecked ones do not; disabled and checked, they draw gray and no selection color; a focused
  // checked box and switch keep a ring in a system color; the current page in Pagination is
  // underlined, focused or not; a Slider's track shows against the page; a StatusDot does not
  // vanish (screenshots, on pages of their own as above).
  const statesName = "Checkbox, Switch, Radio, Pagination, Slider and StatusDot: under forced colors each state still shows";
  if (engine === "webkit") skip(statesName, "Playwright's WebKit does not emulate forced colors");
  for (const scheme of engine === "chromium" ? /** @type {const} */ (["light", "dark"]) : engine === "webkit" ? [] : /** @type {const} */ (["light"])) {
    const name = `${statesName} (${scheme})`;
    const shown = await (await browser.newContext({ forcedColors: "active", reducedMotion: "reduce", colorScheme: scheme })).newPage();
    await shown.goto(`${base}/`);
    const forced = await shown.evaluate(() => matchMedia("(forced-colors: active)").matches);
    // The palette's system colors, read from an element that sets them (CSSOM, which the CSP allows),
    // each with its alpha: Chromium's palette on Linux has a Highlight that is not opaque.
    const palette = await shown.evaluate(() =>
      Object.fromEntries(
        ["Highlight", "GrayText", "Canvas", "CanvasText", "ButtonText", "LinkText", "HighlightText"].map((c) => {
          const probe = document.body.appendChild(document.createElement("i"));
          probe.style.color = c;
          const [r, g, b, a] = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number) ?? [];
          probe.remove();
          return [c, [r, g, b, a ?? 1]];
        }),
      ),
    );
    /** A system color as drawn on the page: over Canvas when it is not opaque. @type {Record<string, number[]>} */
    const system = Object.fromEntries(
      Object.entries(palette).map(([c, [r, g, b, a]]) => [c, [r, g, b].map((v, i) => Math.round(v * a + palette.Canvas[i] * (1 - a)))]),
    );
    const near = (/** @type {number[]} */ a, /** @type {number[]} */ b) => a.every((c, i) => Math.abs(c - b[i]) <= 24);
    const grid = /** @type {[number, number][]} */ (Array.from({ length: 81 }, (_, i) => [(i % 9) / 8, Math.floor(i / 9) / 8]));
    /** @param {import("playwright").Locator} input @param {{ checked: boolean, disabled: boolean }} state */
    const drawn = async (input, state) => {
      // A disabled control is drawn at half opacity, which blends Firefox's CanvasText into its
      // GrayText: its shot is taken at full opacity (set through the CSSOM), so the two stay apart.
      await input.evaluate((el, state) => {
        Object.assign(/** @type {HTMLInputElement} */ (el), state);
        /** @type {HTMLElement} */ (el.parentElement).style.opacity = "1";
      }, state);
      const at = await colorsAt(await input.screenshot({ animations: "disabled" }), grid);
      await input.evaluate((el) => {
        /** @type {HTMLInputElement} */ (el).disabled = false;
        /** @type {HTMLElement} */ (el.parentElement).style.removeProperty("opacity");
      });
      return { selected: at.some((c) => near(c, system.Highlight)), gray: at.filter((c) => near(c, system.GrayText)).length };
    };
    /** @param {import("playwright").Locator} input */
    const states = async (input) => {
      const [on, off, disabledOn] = [await drawn(input, { checked: true, disabled: false }), await drawn(input, { checked: false, disabled: false }), await drawn(input, { checked: true, disabled: true })];
      // Gray on more of it than an unchecked one shows (Firefox's gray matches a border's smoothed
      // edge).
      return { on, off, disabledOn, ok: on.selected && !off.selected && disabledOn.gray > off.gray + 4 && !disabledOn.selected };
    };
    /** A focused, checked control's ring: solid, in a system color. @param {import("playwright").Locator} input */
    const ring = async (input) => {
      await input.evaluate((el) => { /** @type {HTMLInputElement} */ (el).checked = true; });
      await input.focus();
      await shown.keyboard.press("Shift");
      const style = await input.evaluate((el) => `${el.matches(":focus-visible")} ${getComputedStyle(el).outlineStyle} ${getComputedStyle(el).outlineColor}`);
      // In one of the system colors drawn against the page, as the palette has it (no transparency
      // of the kit's own): not Canvas or HighlightText.
      const [r, g, b, a] = style.match(/[\d.]+(?=[,)])/g)?.map(Number) ?? [];
      const systemDrawn = [palette.CanvasText, palette.Highlight, palette.ButtonText, palette.LinkText].some((c) => near([r, g, b], c) && Math.abs((a ?? 1) - c[3]) < 0.01);
      return { style, ok: style.startsWith("true solid") && systemDrawn && !near([r, g, b], palette.Canvas) };
    };
    const box = await states(shown.getByRole("checkbox", { name: "Canada" }));
    const boxRing = await ring(shown.getByRole("checkbox", { name: "Canada" }));
    const radio = await states(shown.getByRole("radio", { name: "Accept offers" }));
    await shown.goto(`${base}/orders`);
    const toggle = await states(shown.getByRole("switch", { name: "Email me when an order ships" }));
    const toggleRing = await ring(shown.getByRole("switch", { name: "Email me when an order ships" }));
    const pagesOf = () =>
      shown.locator("nav[class*='pagination'] a[class*='page']").evaluateAll((els) => els.map((el) => `${el.getAttribute("aria-current") ?? "-"} ${getComputedStyle(el).textDecorationLine}`));
    const pages = await pagesOf();
    await shown.locator("nav[class*='pagination'] [aria-current='page']").focus();
    await shown.keyboard.press("Shift");
    const focusedPages = await pagesOf();
    const underlined = (/** @type {string[]} */ p) => p.some((o) => o === "page underline") && p.every((o) => o.startsWith("page") || !o.includes("underline"));
    // The track's middle row past the thumb (at 2 of 1 to 5) against the row above the track.
    const xs = [0.45, 0.55, 0.65, 0.75, 0.85];
    const slider = await shown.getByLabel("Handling time (business days)").screenshot();
    const [mid, top] = [await colorsAt(slider, xs.map((x) => [x, 0.5])), await colorsAt(slider, xs.map((x) => [x, 0]))];
    const track = mid.every((c, i) => apart(c, top[i]));
    const dotAt = await colorsAt(await shown.locator("h1 ~ span > span[aria-hidden='true'][class*='status-dot__dot']").first().screenshot(), [[0.5, 0.5], [0, 0]]);
    const dot = near(dotAt[0], system.CanvasText) && apart(dotAt[0], dotAt[1]);
    await shown.context().close();
    const seen = JSON.stringify({ forced, system, box, boxRing, radio, toggle, toggleRing, pages, focusedPages, mid, top, dotAt });
    const ok = box.ok && boxRing.ok && radio.ok && toggle.ok && toggleRing.ok && underlined(pages) && underlined(focusedPages) && track && dot;
    if (forced) check(name, ok, seen);
    else if (engine === "chromium") check(`${name} (Chromium emulates forced colors)`, false, seen);
    else skip(name, "forced colors are not emulated here");
  }
  // The meter likewise, in each of its states (each a rule of its own in each engine): its state's
  // color is gone under forced colors, but its fill must still show its value against the track.
  {
    const probe = await (await browser.newContext({ forcedColors: "active", reducedMotion: "reduce" })).newPage();
    await probe.goto(`${base}/orders`);
    const forced = await probe.evaluate(() => matchMedia("(forced-colors: active)").matches);
    const forcedShots = [];
    for (const state of states) {
      const filled = await probe.getByLabel("Sold this month").evaluate((m, attrs) => {
        for (const [name, value] of Object.entries(attrs)) value === null ? m.removeAttribute(name) : m.setAttribute(name, value);
        const el = /** @type {HTMLMeterElement} */ (m);
        return el.value / el.max;
      }, state.attrs);
      forcedShots.push({ name: state.name, filled, shot: await probe.getByLabel("Sold this month").screenshot() });
    }
    await probe.context().close();
    /** @type {{ name: string, fill: number[], past: number[] }[]} */
    const forcedDrawn = [];
    for (const { name, filled, shot } of forcedShots) {
      const [fill, past] = await colorsAt(shot, [[filled / 2, 0.5], [(filled + 1) / 2, 0.5]]);
      forcedDrawn.push({ name, fill, past });
    }
    for (const { name, fill, past } of forcedDrawn) {
      const label = `Meter: ${name}, under forced colors, the fill and the track still differ`;
      if (forced) check(label, apart(fill, past), JSON.stringify({ fill, past }));
      else if (engine === "chromium") check("Meter: Chromium emulates forced colors", false, name);
      else skip(label, "forced colors are not emulated here");
    }
  }
  // Under reduced motion the unknown bar is striped across its whole track, not a band at its start
  // that reads as a value.
  await orders.emulateMedia({ reducedMotion: "reduce" });
  const stripes = await orders.getByLabel("Sending the next label").evaluate((p) => `${getComputedStyle(p).backgroundImage} (reduced motion seen: ${matchMedia("(prefers-reduced-motion: reduce)").matches})`);
  await orders.emulateMedia({ reducedMotion: null });
  check("Progress: with no value under reduced motion, stripes across the track", stripes.startsWith("repeating-linear-gradient"), stripes);
}
