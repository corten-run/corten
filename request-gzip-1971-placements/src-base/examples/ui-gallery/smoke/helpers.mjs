import { chromium, firefox, webkit } from "@playwright/test";
import { steady } from "../../../scripts/steady.mjs";
import { stall } from "../../../scripts/stall.mjs";
import { networkInterfaces } from "node:os";

const base = process.argv[2] ?? "http://localhost:18482";
/**
 * The draft's post `name` (`post(name) = ..`), sent to the draft's own address with `do=name`,
 * from whichever view of it: a URL matcher for `route` and `waitForURL`.
 * @param {string} name
 */
const draftPost = (name) => (/** @type {URL} */ url) => url.pathname === "/" && url.searchParams.get("do") === name;
const saveAt = draftPost("save");
const renameAt = draftPost("rename");
const engines = { chromium, firefox, webkit };
/**
 * The runtime swaps this request's answer into the page (`corten: nav` or `action`); the page it
 * fetches whole after a write asks with `corten: page` and is drawn as a full load's.
 * @param {import("@playwright/test").Request} r
 */
const swapped = (r) => ["nav", "action"].includes(r.headers()["corten"] ?? "");
const names = process.argv.slice(3).length ? process.argv.slice(3) : Object.keys(engines);
const failures = [];
let engine = "";
const seen = stall(5);
/** A check this browser cannot make, and why. */
const skip = (/** @type {string} */ name, /** @type {string} */ why) => {
  seen(`[${engine}] ${name}`);
  console.log(`skip [${engine}] ${name} (${why})`);
};
const check = (name, ok, detail = "") => {
  seen(`[${engine}] ${name}`);
  console.log(`${ok ? "ok  " : "FAIL"} [${engine}] ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(`[${engine}] ${name}`);
};

/**
 * Requests the browser's pages have sent and not finished, with when each was sent: printed when
 * a run throws (a page that never fires `load`), so the report says which one hangs (#232, #252).
 * A request leaves when it finishes or fails, or when its page or context closes.
 * @type {Map<import("@playwright/test").Request, { at: number, context: import("@playwright/test").BrowserContext }>}
 */
const inflight = new Map();

/**
 * The app at an address of this machine that is not loopback, when `base` is loopback: plain http
 * there is not a secure origin, as a tool served on the LAN is not. `SMOKE_LAN` names it
 * (`http://192.168.1.5:18482`); otherwise the private (RFC 1918) addresses first, the first that
 * answers.
 * @param {string} base
 */
async function lanBase(base) {
  if (process.env.SMOKE_LAN) return process.env.SMOKE_LAN;
  const url = new URL(base);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
  const all = Object.values(networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254."));
  const private_ = (/** @type {string} */ a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  const ordered = [...all.filter((a) => a && private_(a.address)), ...all.filter((a) => a && !private_(a.address))];
  for (const a of ordered) {
    const lan = `http://${a?.address}:${url.port}`;
    if (await fetch(`${lan}/`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false)) return lan;
  }
  return null;
}
/** @param {import("@playwright/test").Browser} browser */
function track(browser) {
  /** @param {(r: import("@playwright/test").Request, at: { context: import("@playwright/test").BrowserContext }) => boolean} gone */
  const drop = (gone) => {
    for (const [r, at] of inflight) if (gone(r, at)) inflight.delete(r);
  };
  /** @param {import("@playwright/test").Request} r */
  const pageOf = (r) => {
    try {
      return r.frame().page();
    } catch {
      return null; // a service worker's request has no frame
    }
  };
  // `newPage` makes its context through `newContext`, so every context is watched here.
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    context.on("request", (r) => inflight.set(r, { at: Date.now(), context }));
    context.on("requestfinished", (r) => inflight.delete(r));
    context.on("requestfailed", (r) => inflight.delete(r));
    context.on("page", (page) => page.on("close", () => drop((r) => pageOf(r) === page)));
    context.on("close", () => drop((_, at) => at.context === context));
    return context;
  };
}
/** What is still loading, oldest first. */
function pending() {
  const now = Date.now();
  return [...inflight].sort((a, b) => a[1].at - b[1].at).map(([r, { at }]) => `  ${now - at}ms ${r.method()} ${r.url()} (${r.resourceType()})`);
}

/**
 * An Icon beside a control's text: the space between them and how far the icon's middle is from
 * the text's, in px, with the root's half rem (the kit's .5rem gap). Self-contained, as
 * `evaluate` sends it to the page.
 * @param {Element} el
 */
const besideText = (el) => {
  const svg = /** @type {Element} */ (el.querySelector("svg"));
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  /** @type {Node | null} */
  let text = null;
  while ((text = walk.nextNode()) && !(text.textContent?.trim() && svg.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING));
  const range = document.createRange();
  range.selectNodeContents(/** @type {Node} */ (text));
  const [i, t] = [svg.getBoundingClientRect(), range.getBoundingClientRect()];
  return { gap: t.left - i.right, rem: parseFloat(getComputedStyle(document.documentElement).fontSize) / 2, off: i.top + i.height / 2 - (t.top + t.height / 2) };
};
/** @param {{ gap: number, rem: number, off: number }} b */
const spacedLikeButton = (b) => Math.abs(b.gap - b.rem) <= 0.5 && Math.abs(b.off) <= 1;
// Kit Tabs and Segmented: each choice's weight and the chosen one's color are the theme's
// tab-font-weight and tab-selected-color (500 and --foreground), so a theme whose chosen tab is its
// primary color, or whose choices are semibold, sets two tokens (#1123). For each [chosen, other]
// selector pair: "chosen's weight, other's weight, chosen's color", with the kit's theme and with one
// that sets both, read with transitions off so the color is the end value, not a frame of its fade.
const tabType = (/** @type {string[][]} */ pairs) => {
  const probe = (/** @type {string} */ value) => {
    const el = document.createElement("span");
    el.style.color = value;
    document.body.append(el);
    const color = getComputedStyle(el).color;
    el.remove();
    return color;
  };
  const read = () =>
    pairs.map(([chosen, other]) => {
      const [c, o] = [document.querySelector(chosen), document.querySelector(other)];
      return c && o ? `${getComputedStyle(c).fontWeight} ${getComputedStyle(o).fontWeight} ${getComputedStyle(c).color}` : `missing ${c ? other : chosen}`;
    });
  const still = new CSSStyleSheet();
  still.replaceSync("* { transition: none !important; }");
  const theme = new CSSStyleSheet();
  theme.replaceSync(":root { --tab-font-weight: 600; --tab-selected-color: var(--primary); }");
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, still];
  const kit = read();
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, theme];
  const themed = read();
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== theme);
  // Read once more so the kit's values are computed while transitions are still off, and removing
  // that sheet starts no fade.
  read();
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== still);
  return { kit, themed, foreground: probe("var(--foreground)"), primary: probe("var(--primary)") };
};
// Hovers each chosen choice under a theme whose chosen color is its primary, with transitions off,
// and reads whether it is hovered, its color and the primary's: a chosen choice under the pointer
// keeps the theme's chosen color (#1123).
const chosenUnderPointer = async (/** @type {import("@playwright/test").Page} */ pg, /** @type {string[]} */ selectors) => {
  const hoverTheme = await pg.evaluateHandle(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(":root { --tab-selected-color: var(--primary); } * { transition: none !important; }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return sheet;
  });
  /** @type {{ hovered: boolean, color: string, primary: string }[]} */
  const hoveredChoices = [];
  try {
    for (const chosen of selectors) {
      const choice = pg.locator(chosen);
      await choice.hover();
      hoveredChoices.push(
        await choice.evaluate((el) => {
          const probe = document.createElement("span");
          probe.style.color = "var(--primary)";
          document.body.append(probe);
          const out = { hovered: el.matches(":hover"), color: getComputedStyle(el).color, primary: getComputedStyle(probe).color };
          probe.remove();
          return out;
        }),
      );
    }
  } finally {
    await pg.evaluate((sheet) => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    }, hoverTheme);
    await hoverTheme.dispose();
    await pg.mouse.move(0, 0);
  }
  return hoveredChoices;
};
/** @param {{ kit: string[], themed: string[], foreground: string, primary: string }} t */
const tabTypeIsTheThemes = (t) =>
  t.primary !== t.foreground && t.kit.every((s) => s === `500 500 ${t.foreground}`) && t.themed.every((s) => s === `600 600 ${t.primary}`);
// Kit Checkbox, Radio and Switch: the label is the whole click and tap target, so one line of it is
// a control's height, --control-height, the kit's 2.25rem and a theme's 44 px (2.75rem) alike, with
// the box on the line's middle, and on the first line's middle when the label wraps (#1388). For
// the labels `selector` finds: each one's height in rem with the kit's theme and with a theme that
// sets 2.75rem, and under that theme how far the box's middle is from the label's (px), and a copy
// whose label wraps: its height in rem, and how far its box is from where the one-line label has it,
// from the label's top (px). Then a dense theme's (1rem, shorter than a line, so the label is its line,
// 1.25rem), and the kit's height under an app that still gives the label `min-height:
// var(--control-height)` (the workaround before #1388) with no border-box reset, as `corten new`'s
// app has none: its height in rem and how far the box's middle is from the label's (px).
const choiceTargets = (/** @type {string} */ selector) => {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const labels = /** @type {HTMLElement[]} */ (Array.from(document.querySelectorAll(selector)));
  const box = (/** @type {Element} */ l) => /** @type {Element} */ (l.querySelector(":scope > input")).getBoundingClientRect();
  const heights = () => labels.map((l) => l.getBoundingClientRect().height / rem);
  const kit = heights();
  const theme = new CSSStyleSheet();
  theme.replaceSync(":root { --control-height: 2.75rem; }");
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, theme];
  const touch = heights();
  const centered = labels.map((l) => {
    const [b, t] = [box(l), l.getBoundingClientRect()];
    return (b.top + b.bottom) / 2 - (t.top + t.bottom) / 2;
  });
  const wraps = labels.map((l) => {
    const copy = /** @type {HTMLElement} */ (l.cloneNode(true));
    for (const name of ["name", "id", "required"]) copy.querySelector("input")?.removeAttribute(name);
    const text = /** @type {HTMLElement} */ (copy.querySelector(":scope > span"));
    text.textContent = "A label long enough to wrap onto lines of its own";
    // Set through the CSSOM, which the page's CSP allows where a style attribute is refused.
    copy.style.width = "8rem";
    document.body.append(copy);
    const [b, t, one, oneLabel] = [box(copy), copy.getBoundingClientRect(), box(l), l.getBoundingClientRect()];
    copy.remove();
    return { height: t.height / rem, off: b.top - t.top - (one.top - oneLabel.top) };
  });
  theme.replaceSync(":root { --control-height: 1rem; }");
  const dense = heights();
  // The app's own rule names the label's class, one class as the kit's does, in a later sheet.
  const classes = [...new Set(labels.map((l) => l.classList[0]))];
  // A label's own box as an app without the gallery's reset has it (content-box); its input keeps the
  // browser's border-box, which the reset only repeats.
  theme.replaceSync(`label { box-sizing: content-box } ${classes.map((c) => `.${c}`).join(", ")} { min-height: var(--control-height) }`);
  const leftover = labels.map((l) => {
    const [b, t] = [box(l), l.getBoundingClientRect()];
    return { height: t.height / rem, off: (b.top + b.bottom) / 2 - (t.top + t.bottom) / 2 };
  });
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== theme);
  return { kit, touch, centered, wraps, dense, leftover };
};
/** @param {{ kit: number[], touch: number[], centered: number[], wraps: { height: number, off: number }[], dense: number[], leftover: { height: number, off: number }[] }} t */
const choiceTargetsFit = (t) =>
  t.kit.length > 0 &&
  t.kit.every((h) => Math.abs(h - 2.25) < 0.02) &&
  t.touch.every((h) => Math.abs(h - 2.75) < 0.02) &&
  t.centered.every((off) => Math.abs(off) <= 0.5) &&
  // Two lines or more under the 2.75rem theme's padding: 1.25rem each, and .75rem around them.
  t.wraps.every((w) => w.height >= 3.99 && Math.abs(w.off) <= 0.5) &&
  t.dense.every((h) => Math.abs(h - 1.25) < 0.02) &&
  t.leftover.every((l) => Math.abs(l.height - 2.25) < 0.02 && Math.abs(l.off) <= 0.5);

/** @param {(browser: import("@playwright/test").Browser) => Promise<void>} run */
export async function runSmoke(run) {
  for (engine of names) {
    const browser = steady(await engines[engine].launch({ headless: true }), { gateInitialWebKitLoad: true });
    track(browser);
    try {
      await run(browser);
    } catch (error) {
      console.log(`[${engine}] still loading when it failed:\n${pending().join("\n") || "  nothing"}`);
      throw error;
    } finally {
      inflight.clear();
      await browser.close();
    }
  }

  if (failures.length) {
    console.log(`\n${failures.length} failed:\n${failures.join("\n")}`);
    process.exit(1);
  }
  console.log("\nall passed");
}

export { base, draftPost, saveAt, renameAt, swapped, engine, skip, check, lanBase, besideText, spacedLikeButton, tabType, chosenUnderPointer, tabTypeIsTheThemes, choiceTargets, choiceTargetsFit };
