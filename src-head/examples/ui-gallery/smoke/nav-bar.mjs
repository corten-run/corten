import { base, engine, skip, check } from "./helpers.mjs";

export async function navBar(orders, browser) {
  // NavBar: a look on the app's <header>; the current page's link, and only it, marked from the
  // aria-current that req.nav writes.
  const bar = await orders.evaluate(() => {
    const links = [...document.querySelectorAll("body > header[class*='nav-bar__bar'] > nav > a")];
    return {
      links: links.map((a) => `${a.textContent}${a.getAttribute("aria-current") === "page" ? "*" : ""}`).join(),
      marked: links.map((a) => getComputedStyle(a).boxShadow !== "none").join(),
    };
  });
  check("NavBar: the current page's link is marked, and only it", bar.links === "Draft,Orders*" && bar.marked === "false,true", JSON.stringify(bar));
  // On a phone, with more links than fit their own row, they stay one row that scrolls sideways inside the page,
  // and a shadow shows at the edge with links past it: the end at first, the start once scrolled to
  // the end. Sampled from screenshots a quarter of the way down the links, clear of their text,
  // against the bar's own color.
  const narrow = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await narrow.goto(`${base}/orders`);
  const sections = narrow.locator("nav[class*='nav-bar__sections']");
  const row = await sections.evaluate((nav) => {
    const first = /** @type {HTMLElement} */ (nav.firstElementChild);
    for (const name of ["Listings", "Payouts", "Settings", "Shipping", "Returns", "Reports"]) {
      const a = /** @type {HTMLElement} */ (first.cloneNode());
      a.textContent = name;
      nav.append(a);
    }
    // An icon link at the end, its name in visually hidden text (absolutely placed, clipped): the
    // row is positioned, so the text scrolls with it rather than widening the page.
    const icon = /** @type {HTMLElement} */ (first.cloneNode());
    const hidden = document.createElement("span");
    hidden.textContent = "Notifications and messages";
    Object.assign(hidden.style, { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" });
    icon.append("\u2709", hidden);
    nav.append(icon);
    const header = /** @type {HTMLElement} */ (nav.parentElement);
    return {
      sideways: nav.scrollWidth > nav.clientWidth,
      inside: document.documentElement.scrollWidth <= innerWidth,
      height: Math.round(header.getBoundingClientRect().height),
      card: getComputedStyle(header).backgroundColor,
    };
  });
  const start = (await sections.screenshot()).toString("base64");
  await sections.evaluate((nav) => (nav.scrollLeft = nav.scrollWidth));
  const end = (await sections.screenshot()).toString("base64");
  await narrow.context().close();
  check("NavBar: on a phone the links are a row of their own that scrolls sideways, not the page", row.sideways && row.inside && row.height < 110, JSON.stringify(row));
  // On a phone with a two-word name, an action and ten links, the links still have the bar's width,
  // so more than one is in view.
  {
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await phone.goto(`${base}/orders`);
    const crowded = await phone.locator("nav[class*='nav-bar__sections']").evaluate((nav) => {
      const header = /** @type {HTMLElement} */ (nav.parentElement);
      /** @type {HTMLElement} */ (header.querySelector("a")).textContent = "TCGPlayer Automation";
      const first = /** @type {HTMLElement} */ (nav.firstElementChild);
      for (const name of ["Listings", "Payouts", "Pricing", "Shipping", "Intake", "Reports", "Settings", "Help"]) {
        const a = /** @type {HTMLElement} */ (first.cloneNode());
        a.textContent = name;
        nav.append(a);
      }
      const box = nav.getBoundingClientRect();
      const inView = [...nav.children].filter((a) => {
        const r = a.getBoundingClientRect();
        return r.left >= box.left && r.right <= box.right;
      }).length;
      return { width: Math.round(box.width), bar: Math.round(header.getBoundingClientRect().width), inView, height: Math.round(header.getBoundingClientRect().height) };
    });
    check("NavBar: on a phone a long name and an action leave the links the bar's width", crowded.width >= crowded.bar - 1 && crowded.inView >= 2 && crowded.height < 110, JSON.stringify(crowded));
    // The name's focus ring is whole on a phone, its top edge inside the page.
    await phone.goto(`${base}/orders`);
    await phone.keyboard.press("Tab");
    const ring = await phone.locator("header[class*='nav-bar__bar'] > a").first().evaluate((brand) => {
      brand.focus();
      const style = getComputedStyle(brand);
      const reach = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
      return { top: Math.round((brand.getBoundingClientRect().top - reach) * 10) / 10, outline: style.outlineStyle, focused: brand.matches(":focus-visible") };
    });
    // A browser that tabs to the row of links when it scrolls (Firefox) rings it inside, in the
    // bar's color: the row given more links than fit, then the key after the name.
    await phone.locator("header[class*='nav-bar__bar'] > a").first().evaluate((brand) => {
      const nav = /** @type {HTMLElement} */ (document.querySelector("nav[class*='nav-bar__sections']"));
      const first = /** @type {HTMLElement} */ (nav.firstElementChild);
      for (const name of ["Listings", "Payouts", "Pricing", "Shipping", "Intake", "Reports", "Settings", "Help"]) {
        const a = /** @type {HTMLElement} */ (first.cloneNode());
        a.textContent = name;
        nav.append(a);
      }
      /** @type {HTMLElement} */ (brand).focus();
    });
    await phone.keyboard.press("Tab");
    const rowRing = await phone.evaluate(() => {
      const nav = /** @type {HTMLElement} */ (document.querySelector("nav[class*='nav-bar__sections']"));
      if (document.activeElement !== nav) return null;
      const style = getComputedStyle(nav);
      return { outline: style.outlineStyle, offset: parseFloat(style.outlineOffset), color: style.outlineColor, bar: getComputedStyle(/** @type {Element} */ (nav.parentElement)).color };
    });
    await phone.context().close();
    check("NavBar: on a phone the name's focus ring is inside the page", ring.focused && ring.outline !== "none" && ring.top >= 0, JSON.stringify(ring));
    const rowRingName = "NavBar: a scrolling row of links that takes focus is ringed inside it in the bar's color";
    if (engine === "firefox" || rowRing) {
      check(rowRingName, !!rowRing && rowRing.outline === "solid" && rowRing.offset < 0 && rowRing.color === rowRing.bar, JSON.stringify(rowRing));
    } else skip(rowRingName, "this browser does not tab to a scrolling row with links in it");
  }
  // Recolored as its doc says (--card and --card-foreground on the <header>), every part of the bar
  // is drawn from that pair: the name and links 4.5:1 on it, the current link's underline 3:1.
  {
    const brand = await orders.evaluate(() => {
      const header = /** @type {HTMLElement} */ (document.querySelector("body > header[class*='nav-bar__bar']"));
      header.style.setProperty("--card", "rgb(25, 118, 210)");
      header.style.setProperty("--card-foreground", "rgb(255, 255, 255)");
      /** @param {string} css */
      const rgb = (css) => {
        const g = /** @type {CanvasRenderingContext2D} */ (Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d"));
        g.fillStyle = css;
        g.fillRect(0, 0, 1, 1);
        return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      /** @param {number[]} c */
      const lum = (c) => {
        const [r, g, b] = c.map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const bg = rgb(getComputedStyle(header).backgroundColor);
      /** @param {string} css */
      const ratio = (css) => {
        const [a, b] = [lum(rgb(css)), lum(bg)].sort((x, y) => y - x);
        return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100;
      };
      const links = [...header.querySelectorAll("nav > a")];
      const current = /** @type {Element} */ (links.find((a) => a.getAttribute("aria-current") === "page"));
      const out = {
        brand: ratio(getComputedStyle(/** @type {Element} */ (header.querySelector("a"))).color),
        links: Math.min(...links.map((a) => ratio(getComputedStyle(a).color))),
        current: ratio(/** @type {string} */ (getComputedStyle(current).boxShadow.match(/rgba?\([^)]*\)/)?.[0])),
      };
      header.style.removeProperty("--card");
      header.style.removeProperty("--card-foreground");
      return out;
    });
    check("NavBar: recolored by --card and --card-foreground, its name and links are 4.5:1 on it and the current mark 3:1", brand.brand >= 4.5 && brand.links >= 4.5 && brand.current >= 3, JSON.stringify(brand));
  }
  return { start, end, row };
}

export async function touchScroll(draft, forcedMarks, browser) {
  // On a touch screen the links' scrollbar is hidden, the shadows the cue; under forced colors,
  // which drop them, it comes back. (Playwright's Firefox hides every scrollbar, and its WebKit does
  // not emulate forced colors.)
  const touchScrollbar = "NavBar: on a touch screen the scrollbar is hidden, and shown under forced colors";
  if (engine !== "webkit") {
    await draft.setViewportSize({ width: 1280, height: 800 });
    await draft.emulateMedia({ forcedColors: "active" });
    const forced = await draft.evaluate(() => {
      const [done, now, blocked] = [...document.querySelectorAll("nav[class*='steps__steps'] li")];
      const mark = now?.firstElementChild ? getComputedStyle(now.firstElementChild, "::before") : null;
      const blockedMark = blocked?.firstElementChild ? getComputedStyle(blocked.firstElementChild, "::before").content : "missing";
      const current = document.querySelector("nav[class*='nav-bar__sections'] > a[aria-current='page']");
      const highlight = document.createElement("i");
      highlight.style.cssText = "color: Highlight";
      document.body.append(highlight);
      const want = getComputedStyle(highlight).color;
      highlight.remove();
      return {
        lines: [done, now].map((li) => (li ? getComputedStyle(li, "::after").backgroundColor : "missing")),
        text: done ? getComputedStyle(done).color : "missing",
        mark: mark?.backgroundColor,
        highlight: want,
        underline: current ? getComputedStyle(current).textDecorationLine : "missing",
        blockedMark,
      };
    });
    await draft.emulateMedia({ forcedColors: "none" });
    check(
      forcedMarks,
      forced.lines.every((l) => l === forced.text) && forced.mark === forced.highlight && forced.underline === "underline" && forced.blockedMark.startsWith('"!"'),
      JSON.stringify(forced),
    );
  } else {
    skip(forcedMarks, "Playwright's WebKit does not emulate forced colors");
  }
  if (engine === "chromium") {
    const touch = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
    await touch.goto(`${base}/`);
    const width = () => touch.evaluate(() => getComputedStyle(/** @type {Element} */ (document.querySelector("nav[class*='nav-bar__sections']"))).scrollbarWidth);
    const plain = await width();
    await touch.emulateMedia({ forcedColors: "active" });
    const forced = await width();
    await touch.context().close();
    check(touchScrollbar, plain === "none" && forced === "thin", JSON.stringify({ plain, forced }));
  } else {
    skip(touchScrollbar, engine === "firefox" ? "Playwright's Firefox hides every scrollbar" : "Playwright's WebKit does not emulate forced colors");
  }
  await draft.close();
}
