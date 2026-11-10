// Browser smoke test of the production pieces, against the card-market example (API or fixture mode).
// Usage: node examples/card-market/smoke.mjs [http://localhost:18410]
import { chromium, firefox, webkit } from "@playwright/test";
import { steady } from "../../scripts/steady.mjs";
import { stall } from "../../scripts/stall.mjs";

const base = process.argv[2] ?? "http://localhost:18410";
const failures = [];
const seen = stall(5);
const check = (name, ok, detail = "") => {
  seen(name);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
};

const browser = steady(await chromium.launch({ headless: true }));
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`${base}/`);
  await page.waitForFunction(() => typeof (/** @type {any} */ (window)).__hydratedAt === "number");
  await page.evaluate(() => ((/** @type {any} */ (window)).__marker = 1));

  // Hover first so the runtime prefetches, then click.
  let prefetches = 0;
  page.on("request", (r) => r.headers()["corten"] === "nav" && r.url().endsWith("/items/item_5") && (prefetches += 1));
  await page.hover('a[href="/items/item_5"]');
  await page.waitForTimeout(300);
  await page.click('a[href="/items/item_5"]');
  await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Card Name 5");
  check("client navigation keeps the page", await page.evaluate(() => (/** @type {any} */ (window)).__marker === 1));
  check("hover prefetch is reused by the click", prefetches === 1, `${prefetches} nav request(s)`);
  check("title follows navigation", (await page.title()) === "Card Name 5 | Card Market");
  check(
    "head tags follow navigation",
    (await page.$$eval('head [data-corten-head][rel="canonical"]', (l) => l.map((x) => x.getAttribute("href")))).join() === "/items/item_5",
  );
  const scripts = await page.evaluate(() =>
    performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /\/scripts\/listing_sort\.js$/.test(n)),
  );
  check("the scripts a navigation's markup names load from versioned URLs", scripts.length === 1 && scripts.every((n) => /\/assets\/[0-9a-f]{12}\/scripts\//.test(n)), scripts.join(" "));

  // Styles: tokens, a component's scoped rules and a responsive utility, from components.css.
  const styles = await page.evaluate(() => {
    const css = (/** @type {string} */ selector) => getComputedStyle(/** @type {Element} */ (document.querySelector(selector)));
    const root = document.documentElement;
    const ink = () => getComputedStyle(root).getPropertyValue("--color-ink").trim();
    const light = ink();
    root.dataset.theme = "dark";
    const dark = ink();
    delete root.dataset.theme;
    // A context on an element inside the page applies there, and a compact density's spacing too.
    const panel = document.createElement("section");
    panel.dataset.theme = "dark";
    panel.dataset.density = "compact";
    document.body.append(panel);
    const inner = getComputedStyle(panel);
    const scoped = [inner.getPropertyValue("--color-ink").trim(), inner.getPropertyValue("--space-4").trim()];
    // A light part inside the dark panel is light again, controls included.
    const nested = document.createElement("div");
    nested.dataset.theme = "light";
    panel.append(nested);
    const deeper = getComputedStyle(nested);
    scoped.push(deeper.getPropertyValue("--color-ink").trim(), deeper.colorScheme);
    panel.remove();
    return {
      accent: getComputedStyle(root).getPropertyValue("--color-accent").trim(),
      price: css("[data-scope=listing-sort] tbody td:last-child").fontVariantNumeric,
      themes: [light, dark],
      scoped,
    };
  });
  check("design tokens are custom properties", styles.accent === "#6b3fd4", styles.accent);
  check("a component's scoped stylesheet applies", styles.price === "tabular-nums", styles.price);
  // The item page's top: on a desktop the picture beside the title and the price; on a phone one
  // column, title, picture, price. The price's row is spaced by a responsive utility: the
  // --space-5 token on a desktop, --space-3 on a phone.
  const top = () =>
    page.evaluate(() => {
      const box = (/** @type {string} */ s) => /** @type {Element} */ (document.querySelector(s)).getBoundingClientRect();
      const [title, gallery, price] = [box("article h1"), box("article > div > div:nth-child(2)"), box("article > div > section")];
      const probe = document.body.appendChild(document.createElement("div"));
      const token = (/** @type {string} */ name) => ((probe.style.columnGap = `var(${name})`), getComputedStyle(probe).columnGap);
      const space = { 3: token("--space-3"), 5: token("--space-5") };
      probe.remove();
      return {
        beside: gallery.right <= title.left && gallery.right <= price.left && price.top < gallery.bottom,
        stacked: title.bottom <= gallery.top && gallery.bottom <= price.top,
        gap: getComputedStyle(/** @type {Element} */ (document.querySelector("article > div > section"))).columnGap,
        space,
      };
    });
  await page.setViewportSize({ width: 1280, height: 720 });
  const wide = await top();
  await page.setViewportSize({ width: 390, height: 844 });
  const phone = await top();
  await page.setViewportSize({ width: 1280, height: 720 });
  check("the item's picture sits beside its title and price on a desktop, above the price on a phone", wide.beside && phone.stacked, JSON.stringify({ wide, phone }));
  check(
    "a responsive utility spaces the price's row by the width's token",
    wide.space[5] !== wide.space[3] && wide.gap === wide.space[5] && phone.gap === phone.space[3],
    JSON.stringify({ wide: [wide.gap, wide.space], phone: [phone.gap, phone.space] }),
  );
  check("a theme overrides tokens", styles.themes[0] === "#1d1b26" && styles.themes[1] === "#ecebf2", styles.themes.join(" "));
  check(
    "a theme and a density set on an element apply inside it, and a light part inside a dark one is light",
    styles.scoped.join(" ") === "#ecebf2 12px #1d1b26 light",
    styles.scoped.join(" "),
  );
  // The system's dark mode applies when the page chose no theme, and a page's own choice wins.
  await page.emulateMedia({ colorScheme: "dark" });
  const system = await page.evaluate(() => {
    const root = document.documentElement;
    const ink = () => getComputedStyle(root).getPropertyValue("--color-ink").trim();
    const scheme = () => getComputedStyle(root).colorScheme;
    const chose = [ink(), scheme()];
    // A light panel on the dark page: the default context declares its values, so it is light.
    const panel = document.createElement("section");
    panel.dataset.theme = "light";
    document.body.append(panel);
    const inner = [getComputedStyle(panel).getPropertyValue("--color-ink").trim(), getComputedStyle(panel).colorScheme];
    panel.remove();
    root.dataset.theme = "light";
    const light = [ink(), scheme()];
    delete root.dataset.theme;
    return { chose, light, inner };
  });
  await page.emulateMedia({ colorScheme: null });
  check(
    "a dark system makes a page that chose no theme dark, and data-theme=light keeps the page or a panel in it light",
    system.chose.join(" ") === "#ecebf2 light dark" && system.light.join(" ") === "#1d1b26 light" && system.inner.join(" ") === "#1d1b26 light",
    JSON.stringify(system),
  );

  const firstPrice = () => page.textContent("[data-scope=listing-sort] tbody tr:first-child td:last-child");
  const rowOrder = () => page.$$eval("[data-scope=listing-sort] tbody tr", (rows) => rows.map((r) => r.textContent).join("|"));
  const sort = "[data-scope=listing-sort] > button";
  const before = await firstPrice();
  const order = await rowOrder();
  await page.click(sort);
  check("a click runs the listing sort handler", (await firstPrice()) !== before && (await page.innerText(sort)) === "Price: high to low");
  await page.click(sort);
  check(
    "a second click restores the server's order, rows with the same price included",
    (await firstPrice()) === before && (await rowOrder()) === order && (await page.innerText(sort)) === "Price: low to high",
  );
  const more = await page.$("#show-all button");
  if (more) {
    const rows = await page.$$eval("#offer-rows tr", (r) => r.length);
    const want = Number(/\d+/.exec(await more.innerText())?.[0]);
    await more.click();
    await page.waitForSelector("#show-all", { state: "detached", timeout: 5000 }).catch(() => {});
    const after = await page.$$eval("#offer-rows tr", (r) => r.length);
    check("Show all adds the rest of the offers as a patch", rows === 5 && after === want && new URL(page.url()).search === "", `${rows} then ${after} of ${want}, at ${page.url()}`);
  }

  await page.fill('input[name="email"]', "buyer@example.com");
  await page.fill('input[name="target_price"]', "abc");
  await page.click('form[data-patch] button[type="submit"]');
  await page.waitForSelector("#alert-form-target_price-error", { timeout: 5000 }).catch(() => {});
  check("an invalid field shows its error from the server", ((await page.textContent("#alert-form-target_price-error").catch(() => "")) ?? "").includes("above zero"));
  check("focus moves to the invalid field", await page.evaluate(() => document.activeElement?.getAttribute("name") === "target_price"));
  check("valid input survives the error patch", (await page.inputValue('input[name="email"]')) === "buyer@example.com");
  await page.fill('input[name="target_price"]', "4.5");
  await page.click('form[data-patch] button[type="submit"]');
  await page.waitForFunction(() => /Alert set/.test(document.getElementById("alert-message")?.textContent ?? ""));
  check("form action patches the message", await page.evaluate(() => (/** @type {any} */ (window)).__marker === 1));

  const registration = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return reg.active?.scriptURL ?? null;
  });
  check("service worker is registered and active", registration === `${base}/service-worker.js`);
  const manifest = await page.evaluate(async () => (await fetch("/manifest.webmanifest")).json());
  check("manifest is installable (name, 192 and 512 icons)", manifest.name === "Card Market" && manifest.icons.some((i) => i.sizes === "512x512"));
  // The browser reads every member the app sets (categories, screenshots, a shortcut) without an
  // error, and the images they name are served. (The smoke's catalog has no categories, so the
  // shortcut's page is checked to be the category page; a unit test checks the demo catalog has
  // items in it.)
  const manifestCdp = await context.newCDPSession(page);
  const read = await manifestCdp.send("Page.getAppManifest");
  check("the browser reads the manifest without errors", read.errors.length === 0, JSON.stringify(read.errors));
  const images = [...manifest.screenshots.map((s) => s.src), ...manifest.shortcuts.flatMap((s) => s.icons.map((i) => i.src))];
  const served = await page.evaluate(async (urls) => Promise.all(urls.map(async (u) => (await fetch(u)).status)), images);
  check("the manifest's screenshots and shortcut icon are served", images.length === 3 && served.every((s) => s === 200), JSON.stringify(served));
  // Each screenshot is the size the manifest says, or Chrome leaves it out of its install dialog.
  const sizes = await page.evaluate(async (shots) => Promise.all(shots.map(async (s) => {
    const img = new Image();
    img.src = s.src;
    try {
      await img.decode();
    } catch (error) {
      return [s.sizes, String(error)];
    }
    return [s.sizes, `${img.naturalWidth}x${img.naturalHeight}`];
  })), manifest.screenshots);
  check("each screenshot is the size the manifest says", sizes.length === 2 && sizes.every(([said, is]) => said === is), JSON.stringify(sizes));
  const shortcut = await page.evaluate(async (url) => {
    const r = await fetch(url);
    return { status: r.status, type: r.headers.get("content-type") ?? "", title: /<title>([^<]*)/.exec(await r.text())?.[1] ?? "" };
  }, manifest.shortcuts[0]?.url ?? "/none");
  check("a shortcut opens a page of the app", shortcut.status === 200 && shortcut.type.startsWith("text/html") && /ember.reach/i.test(shortcut.title), JSON.stringify(shortcut));
  await manifestCdp.detach();

  // Push: the app's worker script (Pwa::import_script) handles a push sent through DevTools.
  await context.grantPermissions(["notifications"], { origin: base });
  const cdp = await context.newCDPSession(page);
  /** @type {string | null} */
  let registrationId = null;
  cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
    for (const r of registrations) if (r.scopeURL === `${base}/` && !r.isDeleted) registrationId = r.registrationId;
  });
  await cdp.send("ServiceWorker.enable");
  for (let i = 0; i < 50 && registrationId === null; i += 1) await page.waitForTimeout(100);
  if (registrationId !== null) {
    const data = JSON.stringify({ title: "Price drop", body: "Card Name 5 is below $4.50", url: "/items/item_5" });
    await cdp.send("ServiceWorker.deliverPushMessage", { origin: base, registrationId, data });
  }
  const shown = await page
    .waitForFunction(async () => (await (await navigator.serviceWorker.ready).getNotifications()).some((n) => n.title === "Price drop"), null, { timeout: 5000 })
    .then(() => true, () => false);
  check("a push message shows a notification", shown, registrationId === null ? "no registration id" : "");

  // Offline: a fresh navigation through the runtime falls back to the worker's offline page.
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.click('header a[href="/"]');
  await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Not available", null, { timeout: 10_000 }).catch(() => {});
  check("offline navigation shows the offline page", (await page.textContent("h1")) === "Not available");
  await context.setOffline(false);

  const csp = errors.filter((e) => /Content Security Policy|Refused to/.test(e));
  check("no CSP violations", csp.length === 0, csp.join(" | "));
  const other = errors.filter((e) => !/Content Security Policy|Refused to|ERR_INTERNET_DISCONNECTED|Failed to load resource|net::ERR/.test(e));
  check("no other console errors", other.length === 0, other.join(" | "));

  // Compression, as a real browser negotiates it: pages per request, the runtime once at brotli 11.
  // A context without the service worker, whose cache would answer instead of the network.
  const plain = await (await browser.newContext({ serviceWorkers: "block" })).newPage();
  await plain.goto(`${base}/items/item_5`);
  const encodings = await plain.evaluate(async () => {
    const runtime = /** @type {HTMLScriptElement} */ (document.querySelector('script[type="module"][src*="/corten/"]')).src;
    const entries = () => /** @type {PerformanceResourceTiming[]} */ (performance.getEntriesByType("resource"));
    await fetch(runtime, { cache: "no-store" });
    await new Promise((r) => setTimeout(r, 1500)); // the first request starts brotli 11 in the background
    const res = await fetch(runtime, { cache: "no-store" });
    const text = await res.text();
    const timing = entries().filter((e) => e.name === runtime).at(-1);
    return { runtime: text.startsWith("// Corten runtime"), encoded: timing?.encodedBodySize ?? 0, decoded: timing?.decodedBodySize ?? 0 };
  });
  check(
    "the browser gets the runtime compressed",
    encodings.runtime && encodings.encoded > 0 && encodings.encoded < encodings.decoded / 2,
    `${encodings.encoded} of ${encodings.decoded} bytes`,
  );
  const runtimeUrl = await page.evaluate(() => /** @type {HTMLScriptElement} */ (document.querySelector('script[type="module"][src*="/corten/"]')).src);
  const runtimeBr = await fetch(runtimeUrl, { headers: { "accept-encoding": "br" } });
  check("the runtime is sent as brotli", runtimeBr.headers.get("content-encoding") === "br" && (await runtimeBr.text()).startsWith("// Corten runtime"));
  const styleUrl = await page.evaluate(() => /** @type {HTMLLinkElement} */ (document.querySelector('link[rel="stylesheet"]')).href);
  await fetch(styleUrl, { headers: { "accept-encoding": "br" } });
  await page.waitForTimeout(500);
  const style = await fetch(styleUrl, { headers: { "accept-encoding": "br" } });
  check(
    "assets are precompressed once, with their own ETag per coding",
    style.headers.get("content-encoding") === "br" && /-br"$/.test(style.headers.get("etag") ?? ""),
    `${style.headers.get("content-encoding")} ${style.headers.get("etag")}`,
  );
  const iconUrl = await page.evaluate(() => /** @type {HTMLLinkElement} */ (document.querySelector('link[rel="icon"]')).href);
  const icon = await fetch(iconUrl);
  check("the favicon is a versioned SVG asset", icon.ok && /\/assets\//.test(iconUrl) && icon.headers.get("content-type") === "image/svg+xml", `${icon.status} ${iconUrl}`);
  // The path browsers ask for on their own is the same icon, cached a day, and a 304 when kept.
  const iconBytes = await icon.arrayBuffer();
  const fixed = await fetch(`${base}/favicon.ico`, { headers: { accept: "image/avif,image/webp,*/*" } });
  const fixedBytes = await fixed.arrayBuffer();
  const fixedAgain = await fetch(`${base}/favicon.ico`, { headers: { "if-none-match": fixed.headers.get("etag") ?? "" } });
  check(
    "/favicon.ico is the static directory's icon, cached a day, with a 304 for a kept copy",
    fixed.status === 200 &&
      fixed.headers.get("content-type") === "image/svg+xml" &&
      fixed.headers.get("cache-control") === "public, max-age=86400" &&
      Buffer.from(fixedBytes).equals(Buffer.from(iconBytes)) &&
      fixedAgain.status === 304,
    `${fixed.status} ${fixed.headers.get("content-type")} ${fixed.headers.get("cache-control")}, then ${fixedAgain.status}`,
  );
  const zstd = await fetch(`${base}/items/item_5`, { headers: { "accept-encoding": "zstd" } });
  check("pages are compressed with zstd when the client accepts it", zstd.headers.get("content-encoding") === "zstd" && /accept-encoding/.test(zstd.headers.get("vary") ?? ""));
  const br = await fetch(`${base}/items/item_5`, { headers: { "accept-encoding": "gzip, br" } });
  check("pages fall back to brotli", br.headers.get("content-encoding") === "br" && (await br.text()).includes("Card Name 5"));
  // A page's weak tag is its body's, the same compressed or not; a tag the client names is a 304
  // with no body, type or length, and the browser revisiting the page sends it and shows its copy.
  const tag = br.headers.get("etag") ?? "";
  const notModified = await fetch(`${base}/items/item_5`, { headers: { "accept-encoding": "gzip, br", "if-none-match": tag } });
  const nothing = await notModified.arrayBuffer();
  check(
    "a page's tag the client has is answered 304, with no body",
    /^W\/"[0-9a-f]{16}"$/.test(tag) &&
      zstd.headers.get("etag") === tag &&
      notModified.status === 304 &&
      notModified.headers.get("etag") === tag &&
      nothing.byteLength === 0 &&
      !notModified.headers.has("content-type") &&
      !notModified.headers.has("content-length") &&
      !notModified.headers.has("content-encoding") &&
      /accept-encoding/.test(notModified.headers.get("vary") ?? ""),
    `${tag} ${zstd.headers.get("etag")} ${notModified.status} ${JSON.stringify([...notModified.headers])}`,
  );
  // The browser's revisit sends the tag it kept, and the server's 304 carries no body: the
  // navigation's transfer is its headers alone, and the page shows the copy the browser kept.
  const again = await plain.goto(`${base}/items/item_5`);
  const asked = (await again?.request().allHeaders())?.["if-none-match"];
  const revisit = await plain.evaluate(() => {
    const entry = /** @type {PerformanceNavigationTiming} */ (performance.getEntriesByType("navigation")[0]);
    return { transfer: entry.transferSize, decoded: entry.decodedBodySize, h1: document.querySelector("h1")?.textContent ?? "" };
  });
  check(
    "the browser revisiting a page asks with its tag, is sent no body and shows its copy",
    /^W\/"[0-9a-f]{16}"$/.test(asked ?? "") && revisit.decoded > 5000 && revisit.transfer < 2000 && revisit.h1.includes("Card Name 5"),
    `${asked} ${JSON.stringify(revisit)}`,
  );
  // The runtime's navigation fetch revalidates the same way (Chromium; WebKit does not ask). Chromium
  // sends the document's tag on the first one, though the copy varies on `corten`: the server
  // compares what it rendered, so the swap is sent whole, and the next fetch names the swap's tag.
  const navTags = [];
  plain.on("request", async (request) => {
    const headers = await request.allHeaders();
    if (headers.corten === "nav") navTags.push(headers["if-none-match"] ?? "");
  });
  const navStatuses = await plain.evaluate(async () => {
    const statuses = [];
    for (let i = 0; i < 2; i++) {
      const res = await fetch(location.href, { headers: { corten: "nav" } });
      const length = (await res.text()).length;
      const entry = /** @type {PerformanceResourceTiming[]} */ (performance.getEntriesByName(location.href, "resource")).at(-1);
      statuses.push(`${res.status} ${length} ${entry?.transferSize ?? -1}`);
    }
    return statuses;
  });
  await plain.waitForTimeout(200);
  check(
    "the runtime's navigation fetch sends its tag the second time and gets its copy",
    navTags.length === 2 &&
      (navTags[0] === "" || navTags[0] === tag) &&
      /^W\/"[0-9a-f]{16}"$/.test(navTags[1]) &&
      navTags[1] !== tag &&
      navStatuses.every((s) => /^200 [1-9]/.test(s)) &&
      Number(navStatuses[1].split(" ")[2]) < 2000 &&
      Number(navStatuses[0].split(" ")[2]) > 2000,
    `${JSON.stringify(navTags)} ${JSON.stringify(navStatuses)}`,
  );

  const cross = await fetch(`${base}/items/item_5`, { method: "POST", headers: { "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded" }, body: "title=a&email=a@b.c&target_price=1" });
  check("cross-site form post is refused", cross.status === 403);

  // The MCP endpoint is a JSON-only route (App::api). The container is started with
  // AGENT_ORIGINS set to the other loopback name (http://127.0.0.1:18481 for a base on
  // localhost), so an agent's page there may call it.
  const wrongMethod = await fetch(`${base}/mcp`);
  const wrongBody = await wrongMethod.json().catch(() => null);
  check("the MCP endpoint answers a failure as a JSON-RPC error to any client (Api::errors)", wrongMethod.status === 405 && wrongBody?.jsonrpc === "2.0" && wrongBody?.error?.code === -32600, `${wrongMethod.status} ${wrongMethod.headers.get("content-type")}`);
  check("an API route has its own CSP", wrongMethod.headers.get("content-security-policy") === "default-src 'none'; frame-ancestors 'none'");
  // Pages, and the service worker whose imports the push check above ran, require Trusted Types with
  // only the runtime's policy.
  const tt = (/** @type {Response} */ r) => (r.headers.get("content-security-policy") ?? "").includes("; require-trusted-types-for 'script'; trusted-types corten;");
  const [home, worker] = await Promise.all([fetch(base), fetch(`${base}/service-worker.js`)]);
  const script = worker.ok && (worker.headers.get("content-type") ?? "").startsWith("text/javascript");
  check("pages and the service worker require Trusted Types", tt(home) && tt(worker) && script, `page: ${home.headers.get("content-security-policy")}; worker: ${worker.headers.get("content-security-policy")}`);
  // What a page's policy blocks reaches the app (Policy::report_to): a script that writes markup
  // from a string, which Trusted Types refuses, is reported to /csp-reports, and the app reads the
  // violation in it (204, not 415, nor 202 for a body it found none in) whichever shape the browser sends: Firefox a batch in the Reporting
  // API's format, WebKit one report as application/csp-report. (Chromium queues its reports for a
  // local endpoint and does not send them.)
  for (const [name, type, options] of [
    ["Firefox", firefox, { firefoxUserPrefs: { "dom.reporting.delivering.timeout": 1 } }],
    ["WebKit", webkit, {}],
  ]) {
    const other = await type.launch({ headless: true, ...options });
    try {
      const context = await other.newContext();
      /** @type {string[]} */
      const sent = [];
      const answered = new Promise((resolve) => {
        context.on("requestfinished", async (r) => {
          if (!r.url().endsWith("/csp-reports")) return;
          const status = (await r.response())?.status();
          sent.push(`${r.headers()["content-type"]} ${status}`);
          resolve(status);
        });
      });
      const reportingPage = await context.newPage();
      const loaded = await reportingPage.goto(`${base}/items/item_5`);
      const blocked = await reportingPage.evaluate(() => {
        try {
          document.body.insertAdjacentHTML("beforeend", "<b>from a string</b>");
          return false;
        } catch {
          return true;
        }
      });
      const status = await Promise.race([answered, new Promise((resolve) => setTimeout(() => resolve(null), 30000))]);
      check(
        `${name}: a script writing markup from a string is blocked, reported to the app's endpoint and read (Policy::report_to, Violations)`,
        blocked && loaded?.headers()["reporting-endpoints"] === 'csp="/csp-reports"' && status === 204,
        `blocked: ${blocked}; endpoints: ${loaded?.headers()["reporting-endpoints"]}; sent: ${sent.join(", ")}`,
      );
    } finally {
      await other.close();
    }
  }
  // A full document denies the powerful features no page uses: Chromium reads the header (no
  // console warning for a name it does not know, but `bluetooth` where the build has no Web
  // Bluetooth, as on Linux) and refuses them; a navigation is not sent it.
  const denied = await browser.newPage();
  const deniedLog = [];
  denied.on("console", (m) => (m.type() === "error" || m.type() === "warning") && deniedLog.push(`${m.type()}: ${m.text()}`));
  await denied.goto(base);
  const stillAllowed = await denied.evaluate(() => {
    const policy = /** @type {any} */ (document).featurePolicy;
    return ["camera", "microphone", "geolocation", "payment", "usb", "accelerometer", "window-management"].filter((name) => policy.allowsFeature(name));
  });
  const noBluetooth = await denied.evaluate(() => !("bluetooth" in navigator));
  const linuxBluetooth = (/** @type {string} */ line) => noBluetooth && line.endsWith("Unrecognized feature: 'bluetooth'.");
  const policyLines = deniedLog.filter((line) => line.includes("Permissions-Policy"));
  const warned = policyLines.filter((line) => !linuxBluetooth(line)).length > 0 || policyLines.length > 1;
  const nav = await fetch(base, { headers: { corten: "nav" } });
  check("a full document denies powerful features, with no warning but Linux's one for bluetooth, and a navigation is not sent the header", stillAllowed.length === 0 && !warned && (home.headers.get("permissions-policy") ?? "").includes("camera=()") && nav.headers.get("permissions-policy") === null, `allowed: ${stillAllowed.join(",")}; ${deniedLog.join(" | ")}; nav: ${nav.headers.get("permissions-policy")}`);
  await denied.close();
  const baseUrl = new URL(base);
  const otherOrigin = `${baseUrl.protocol}//${baseUrl.hostname === "localhost" ? "127.0.0.1" : "localhost"}:${baseUrl.port}`;
  // A page at one origin calling the endpoint at another. Both are this server's loopback names
  // (Chromium keeps loopback pages from reaching loopback servers only when the page is not
  // local), and the page's own CSP is bypassed so that only CORS decides.
  const agents = await browser.newContext({ bypassCSP: true });
  /** Calls tools/list from a page at `pageOrigin` on the endpoint at `apiOrigin`: the tool count, or "blocked". */
  const callFrom = async (pageOrigin, apiOrigin) => {
    const agent = await agents.newPage();
    await agent.goto(`${pageOrigin}/robots.txt`);
    const result = await agent.evaluate(async (url) => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer dev-token" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        return String((await res.json()).result?.tools?.length);
      } catch {
        return "blocked";
      }
    }, `${apiOrigin}/mcp`);
    await agent.close();
    return result;
  };
  const allowed = await callFrom(otherOrigin, base);
  check("an allowed origin calls the API from the browser (preflight, then the write)", allowed === "2", allowed);
  const stranger = await callFrom(base, otherOrigin);
  check("any other origin is blocked by the browser", stranger === "blocked", stranger);
  await agents.close();

  // A partner's page frames an item's card: the origin EMBED_ORIGINS names may (the other loopback
  // name, as for agents), any other may not, and the item's own page may be framed by no one. Each
  // parent page is made here, at its origin, with no policy of its own, so only the framed page's
  // frame-ancestors decides. Chromium keeps a page it did not load from an address from framing a
  // loopback server unless the page may reach the local network, so the parents are given that,
  // and each is a loopback name; a frame counts as blocked only when its response blocked it.
  const framing = await browser.newContext();
  await framing.grantPermissions(["local-network-access"]);
  /** The card's title as the frame at `parentOrigin` shows `path`, "blocked", or why it failed. */
  const framedFrom = async (/** @type {string} */ parentOrigin, /** @type {string} */ path) => {
    const parent = await framing.newPage();
    /** @type {string | undefined} */
    let failure;
    parent.on("requestfailed", (request) => {
      if (request.url() === `${base}${path}`) failure = request.failure()?.errorText;
    });
    await parent.route(`${parentOrigin}/partner`, (route) =>
      route.fulfill({ contentType: "text/html", body: `<!DOCTYPE html><title>Partner</title><iframe src="${base}${path}"></iframe>` }),
    );
    await parent.goto(`${parentOrigin}/partner`);
    const frame = await (await parent.waitForSelector("iframe")).contentFrame();
    await frame?.waitForLoadState("load").catch(() => {});
    const title = await frame?.locator("strong").first().textContent({ timeout: 3000 }).catch(() => null);
    await parent.close();
    return title ?? (failure === "net::ERR_BLOCKED_BY_RESPONSE" ? "blocked" : (failure ?? "nothing shown"));
  };
  const card = await fetch(`${base}/embed/items/item_5`);
  const itemPage = await fetch(`${base}/items/item_5`);
  check(
    "an item's card names the partner that may frame it, and sends no X-Frame-Options; the item page denies every frame",
    (card.headers.get("content-security-policy") ?? "").includes(`frame-ancestors ${otherOrigin};`) &&
      card.headers.get("x-frame-options") === null &&
      (itemPage.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none';") &&
      itemPage.headers.get("x-frame-options") === "DENY",
    `${card.headers.get("content-security-policy")} | ${card.headers.get("x-frame-options")} | ${itemPage.headers.get("x-frame-options")}`,
  );
  const partnerSees = await framedFrom(otherOrigin, "/embed/items/item_5");
  check("the partner's page shows an item's card in a frame", partnerSees === "Card Name 5", partnerSees);
  const strangerSees = await framedFrom(`http://[::1]:${baseUrl.port}`, "/embed/items/item_5");
  check("another site's frame of the card is blocked by the browser", strangerSees === "blocked", strangerSees);
  const itemFramed = await framedFrom(otherOrigin, "/items/item_5");
  check("the partner's frame of the item page is blocked by the browser", itemFramed === "blocked", itemFramed);
  await framing.close();

  // Cache headers: the home page is the same for every visitor, so a CDN may keep it; with the
  // visitor's cookie it is theirs alone, and other pages are private unless they say otherwise.
  const cacheOf = async (/** @type {string} */ path, /** @type {Record<string, string>} */ headers = {}) =>
    (await fetch(`${base}${path}`, { headers })).headers.get("cache-control") ?? "";
  const shared = await cacheOf("/");
  check("a public page may be kept by shared caches", shared === "public, max-age=60, stale-while-revalidate=600", shared);
  const mine = await cacheOf("/", { cookie: "session=abc" });
  check("the same page requested with a cookie is private", mine === "private, no-cache", mine);
  const item = await cacheOf("/items/item_5");
  check("other pages are private by default", item === "private, no-cache", item);

  // What a crawler and a load balancer see: an old address moved for good, a category's
  // structured data and longer shared lifetime, and readiness once the item source answers.
  const old = await fetch(`${base}/item/item_5`, { redirect: "manual" });
  check("an old address is a permanent redirect", old.status === 301 && old.headers.get("location") === "/items/item_5", `${old.status} ${old.headers.get("location")}`);
  const category = await fetch(`${base}/categories/promo`);
  const categoryCache = category.headers.get("cache-control") ?? "";
  check("a category page may be kept longer by shared caches", categoryCache.includes("s-maxage=3600"), categoryCache);
  check("a category page carries its breadcrumbs as structured data", (await category.text()).includes('"@type":"BreadcrumbList"'));
  const ready = await fetch(`${base}/health/ready`);
  check("the app is ready once its item source answers", ready.status === 200, String(ready.status));

  // In French the item page is French throughout: its prices as French writes US dollars, the
  // ratings with a decimal comma, and the conditions the catalog names (the fixture's cheapest
  // listing is Lightly Played; the rest are "Near Mint, English", shown as the item API sent it).
  const french = await (await fetch(`${base}/items/item_5`, { headers: { "accept-language": "fr" } })).text();
  const cheapest = new Intl.NumberFormat("fr", { style: "currency", currency: "USD" }).format(0.79);
  check(
    "in French a price, a rating and a condition are French",
    french.includes(cheapest) && french.includes("4,58 ★ (274)") && french.includes("Peu joué") && !french.includes("$0.79"),
    [cheapest, "4,58 ★ (274)", "Peu joué"].map((t) => `${t}: ${french.includes(t)}`).join(", "),
  );

  // A partner's service sets alerts with its API key (`X-Api-Key`, `API_KEYS`); without one it
  // is a JSON 401, and the form's rules answer with the fields.
  const alertFrom = (/** @type {Record<string, string>} */ headers, body = { id: "item_5", email: "ada@example.com", target_price: "1.00" }) =>
    fetch(`${base}/api/alerts`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const anonymous = await alertFrom({});
  const anonymousBody = await anonymous.json().catch(() => null);
  check(
    "a partner write without an API key is a Problem Details 401 that says what to send",
    anonymous.status === 401 && anonymous.headers.get("content-type") === "application/problem+json" && anonymousBody?.status === 401 && anonymousBody?.detail === "Send a valid partner API key in X-Api-Key.",
    `${anonymous.headers.get("content-type")} ${JSON.stringify(anonymousBody)}`,
  );
  const keyed = await alertFrom({ "x-api-key": "dev-key" });
  const keyedBody = await keyed.json().catch(() => null);
  check("with its key the partner's alert is set", keyed.status === 200 && keyedBody?.partner === "dev" && /^Alert set: /.test(keyedBody?.message ?? ""), JSON.stringify(keyedBody));
  const refused = await alertFrom({ "x-api-key": "dev-key" }, { id: "item_5", email: "ada", target_price: "1.00" });
  const refusedBody = await refused.json().catch(() => null);
  check("a field the rules refuse is a 422 with the field", refused.status === 422 && typeof refusedBody?.fields?.email === "string", JSON.stringify(refusedBody));

  // Writes are limited per client address (20 a minute), a key no partner has included, so
  // guessing keys is limited too. The container trusts Docker's networks as its proxies
  // (`PROXIES`), so each address below is the client its proxy forwarded.
  const writeAs = (/** @type {string} */ address, key = "guess") => alertFrom({ "x-api-key": key, "x-forwarded-for": address });
  // Addresses of this run's own, so a second run against the same container starts at zero.
  const octet = () => 1 + Math.floor(Math.random() * 254);
  const limited = `198.51.${octet()}.${octet()}`;
  // Until the first 429: if the minute turns during the loop, the count starts again, so up to
  // twice the limit may pass first.
  const statuses = [];
  let over = await writeAs(limited);
  for (; over.status !== 429 && statuses.length < 41; over = await writeAs(limited)) statuses.push(over.status);
  const wait = Number(over.headers.get("retry-after"));
  check("an address past its writes a minute is a 429 with Retry-After", statuses.length >= 20 && statuses.every((s) => s === 401) && over.status === 429 && wait >= 1 && wait <= 60, `${statuses.length} x ${statuses[0]} then ${over.status} after ${wait}s`);
  const elsewhere = await writeAs(`203.0.${octet()}.${octet()}`);
  check("another forwarded address has its own count", elsewhere.status === 401, String(elsewhere.status));
  const asPartner = await writeAs(limited, "dev-key");
  check("a partner's alert from a limited address is counted as the partner's", asPartner.status === 200, String(asPartner.status));
  const stillReads = await fetch(`${base}/items/item_5`, { headers: { "x-forwarded-for": limited } });
  check("reads from a limited address still pass", stillReads.status === 200, String(stillReads.status));

  // Back and forward restore a page from memory. Playwright turns the back/forward cache off, and
  // its default headless shell never restores a page; the full Chromium in headless mode does.
  const restoring = steady(
    await chromium.launch({
      channel: "chromium",
      headless: true,
      ignoreDefaultArgs: ["--disable-back-forward-cache"],
    }),
  );
  try {
    const tab = await (await restoring.newContext()).newPage();
    await tab.addInitScript(() =>
      addEventListener("pageshow", (event) => event.persisted && ((/** @type {any} */ (window)).__restored = true)),
    );
    await tab.goto(`${base}/items/item_5`);
    // A fresh profile installs the app's service worker, which claims the open page, and Chrome
    // never keeps a page a worker claimed. Load it again once the worker controls the profile.
    await tab.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 5000 }).catch(() => {});
    await tab.goto(`${base}/items/item_5`);
    // The runtime and the page's handler modules are loaded.
    await tab.evaluate(async () => {
      const { ready } = await import("corten");
      await ready;
    });
    await tab.goto(`${base}/robots.txt`);
    await tab.goBack({ waitUntil: "commit" });
    const restored = await tab
      .waitForFunction(() => (/** @type {any} */ (window)).__restored === true, null, { timeout: 3000 })
      .then(() => true, () => false);
    const reasons = restored
      ? ""
      : await tab.evaluate(() => JSON.stringify((/** @type {any} */ (performance.getEntriesByType("navigation")[0]))?.notRestoredReasons ?? null));
    check("going back restores the page from the back/forward cache", restored, reasons);
  } finally {
    await restoring.close();
  }
} finally {
  await browser.close();
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
