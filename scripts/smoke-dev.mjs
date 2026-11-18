// Browser smoke test of `corten dev` live reload: an open page reloads when the server restarts.
// Usage: node scripts/smoke-dev.mjs http://localhost:18483 corten-watchlist-dev [chromium|firefox|webkit]
// (the watchlist image, run with -e CORTEN_DEV=1 in a container of that name).
import { chromium, firefox, webkit } from "@playwright/test";
import { steady } from "./steady.mjs";
import { execFileSync } from "node:child_process";
import { stall } from "./stall.mjs";

const [base = "http://localhost:18483", container = "corten-watchlist-dev", engine = "chromium"] = process.argv.slice(2);
const failures = [];
const seen = stall(5);
const check = (name, ok, detail = "") => {
  seen(name);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
};

const browser = steady(await ({ chromium, firefox, webkit })[engine].launch({ headless: true }));
try {
  const page = await browser.newPage();
  await page.goto(base);
  const boot = await page.getAttribute('meta[name="corten-dev"]', "content");
  check("dev mode prints the server's start time", !!boot);
  check("dev mode registers no service worker", (await page.$('meta[name="corten-sw"]')) === null);
  await page.evaluate(() => ((/** @type {any} */ (window)).__marker = 1));
  await page.waitForTimeout(300);
  check("the page stays while the server runs", await page.evaluate(() => (/** @type {any} */ (window)).__marker === 1));
  // A control drawn with a value its own attributes refuse is reported, as the page loads and
  // when a patch draws one; a new form's blank required field, a refused one drawn again with what
  // was sent, a control in no form and one in a novalidate form are not (#850). Each report comes
  // in document order, so the last control's says every one before it is in.
  const drawn = await browser.newPage();
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  drawn.on("console", (m) => (m.type() === "error" ? errors : m.type() === "warning" ? warnings : []).push(m.text()));
  /** @param {string} name */
  const reportOf = (name) => drawn.waitForEvent("console", { predicate: (m) => m.text().startsWith(`corten: ${name} `), timeout: 10000 }).then(() => true, () => false);
  await drawn.route(base + "/", async (route) => {
    // The page's own load only: the runtime's read of its picks (`corten: action`) goes as it is.
    if (route.request().headers().corten) return route.continue();
    // Playwright decodes gzip here, but not zstd that Firefox can negotiate.
    const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "gzip" } });
    const controls = [
      '<form><input type="number" name="delay" min="0" step="100" value="250"><input type="number" name="fresh" required>',
      '<input type="number" name="sent" max="5" value="9" aria-invalid="true"></form>',
      '<input type="number" name="alone" max="1" value="2"><form novalidate><input type="number" name="unchecked" max="1" value="2"></form>',
      '<form><input type="number" name="last" max="1" value="2"></form>',
      // Live regions (#873): one inside another is reported; one beside another, aria-live="off"
      // inside one, one inside a region aria-live="off" silences, and plain text in one are not.
      '<div role="alert"><p id="inner" role="alert">Sold out.</p></div><p role="status">Saved.</p>',
      '<div role="alert"><span id="quiet" aria-live="off">x</span></div>',
      '<div role="status" aria-live="off"><p id="silenced" role="alert">z</p></div>',
      '<div aria-live="polite" id="lasthost"><p id="lastlive" role="status">y</p></div>',
      // Closed dialogs and popovers (#1081): one a rule inside @media gives a display is warned
      // of, at the width the page is at and one it is not at, nested too; a card look outside a
      // query, one under @supports, the open one's look, one the app draws with its own !important
      // rule, an open one and one the query hides are not.
      '<dialog id="rail" class="rail"><p>Filters</p></dialog><dialog id="card" class="card"></dialog>',
      '<dialog id="kept" class="kept"></dialog><dialog id="shown" class="rail" open></dialog>',
      '<dialog id="gone" class="gone"></dialog><dialog id="inplace" class="inplace"></dialog>',
      '<dialog id="enhanced" class="enhanced"></dialog><dialog id="modal" class="modal"></dialog>',
      '<div id="nav" class="nav" popover></div><div class="page"><dialog id="side" class="side"></dialog></div>',
      '<dialog id="keptHidden" class="kept" hidden></dialog>',
      '<div class="scoped"><dialog id="scopedPlain" class="scopedPlain"></dialog></div><dialog id="outsidePlain" class="scopedPlain"></dialog>',
      '<div class="scoped"><dialog id="scopedRoot" class="scopedRoot"></dialog></div><dialog id="outsideRoot" class="scopedRoot"></dialog>',
      '<div class="scoped"><dialog id="scopedAmp" class="scopedAmp"></dialog></div><dialog id="outsideAmp" class="scopedAmp"></dialog>',
      '<dialog id="scopedDeclarations" class="scopedDeclarations"></dialog>',
      '<div class="scoped"><dialog id="scopedContainer" class="scopedContainer"></dialog></div><dialog id="outsideContainer" class="scopedContainer"></dialog>',
      '<dialog id="scopedSelf" class="scopedSelf"></dialog>',
      '<div class="ancestorScope"><dialog id="outsideAncestor"></dialog></div>',
      '<div class="identity"><dialog id="sameRoot" class="identity"></dialog></div>',
      '<div class="impossible"><dialog id="differentRoots" class="impossible"></dialog></div>',
      '<dialog id="listSelf" class="listScope listPlain"></dialog><div class="listScope"><dialog id="listPlain" class="listPlain"></dialog><dialog id="listExplicit" class="listExplicit"></dialog></div>',
      '<div class="literalScope"><dialog id="literalAttribute" data-note=":scope"></dialog><dialog id="literalEscape" class="test:scope"></dialog><dialog id="literalImpostor" data-note=":is(.literalScope)"></dialog></div>',
      '<dialog id="literalSelf" class="literalSelf test:scope" data-note=":scope"></dialog>',
      '<div class="relativeScope"><dialog id="relativeScope"></dialog></div><dialog id="outsideRelativeScope"></dialog>',
      '<div class="relativeAmp"><dialog id="relativeAmp"></dialog></div>',
      '<div class="relativeList"><dialog id="relativeList"></dialog><dialog id="relativeOther" class="other"></dialog></div>',
      '<div class="scoped"><div id="scopedPopover" class="scopedPopover" popover></div></div><div id="outsidePopover" class="scopedPopover" popover></div>',
      '<div class="scopeHost"><div class="scopeInner"><dialog id="nestedScope" class="nestedScope"></dialog></div></div><div class="scopeInner"><dialog id="outsideNestedScope" class="nestedScope"></dialog></div>',
      '<div class="outerScope"><div class="innerScope"><dialog id="doubleScope" class="doubleScope"></dialog></div></div><div class="innerScope"><dialog id="outsideDoubleScope" class="doubleScope"></dialog></div>',
      '<div class="outerExact"><div class="innerExact"><dialog id="exactScope"></dialog></div><div><div class="innerExact"><dialog id="outsideExact"></dialog></div></div></div>',
      '<dialog id="documentScope" data-note=":scope"></dialog><dialog id="documentAmp" data-note="&"></dialog><dialog id="notDocumentScope"></dialog><dialog id="notDocumentAmp"></dialog>',
      // A scope's limit cuts its own subjects and the roots and subjects of a scope inside it.
      '<div class="limitOuter"><div class="limitStop"><div class="limitInner"><dialog id="limitCut"></dialog></div></div><div class="limitInner"><dialog id="limitKept"></dialog></div></div>',
      '<div class="limitDraws"><div class="limitStop"><dialog id="limitDrawn" class="limitDrawn"></dialog></div><dialog id="limitShown" class="limitDrawn"></dialog></div>',
      // A scope without a start has the stylesheet's parent element as its root.
      '<section><link rel="stylesheet" href="/dialog-implicit.css"><dialog id="implicitIn" class="implicitChild"></dialog><div><dialog id="implicitDeep" class="implicitChild"></dialog></div></section><dialog id="implicitOut" class="implicitChild"></dialog>',
      // A missing start is not the selector `undefined`, in either order (no element is one).
      '<section><link rel="stylesheet" href="/dialog-undefined-after.css"><dialog id="undefinedAfter"></dialog></section>',
      '<section><link rel="stylesheet" href="/dialog-undefined.css"><dialog id="undefinedStart"></dialog></section>',
      '<dialog id="lastrail" class="rail"></dialog>',
    ].join("");
    const sheet = '<link rel="stylesheet" href="/dialog-in-place.css">';
    await route.fulfill({ response: res, body: (await res.text()).replace("</head>", `${sheet}</head>`).replace("</body>", `${controls}</body>`) });
  });
  await drawn.route(base + "/dialog-in-place.css", (route) =>
    route.fulfill({
      contentType: "text/css",
      body: [
        ".card { display: flex; }",
        "@media (min-width: 9999px) { .rail { display: block; } }",
        "@media (min-width: 1px) { .kept { display: block; } .kept:not([open],[hidden]) { display: block !important; } }",
        "@media (min-width: 1px) { .gone { display: none; } }",
        "@media (min-width: 1px) { .inplace { display: block; } .modal[open] { display: grid; } }",
        "@supports (display: grid) { .enhanced { display: grid; } }",
        "@media (min-width: 1px) { .nav { display: grid; } }",
        ".page { .side { @media (min-width: 1px) { display: block; } } }",
        "@media (min-width: 1px) { @scope (.scoped) { .scopedPlain { display: flex; } :scope > .scopedRoot { display: grid; } & > .scopedAmp { display: block; } :scope > .scopedPopover { display: block; } } @scope (.scopedDeclarations) { display: flex; } }",
        "@container (min-width: 1px) { @scope (.scoped) { :scope > .scopedContainer { display: flex; } } }",
        "@scope (.scopedSelf) { @media (min-width: 1px) { dialog { display: grid; } } }",
        "@scope (.ancestorScope) { @media (min-width: 1px) { body dialog { display: flex; } } }",
        "@scope (.identity) { @media (min-width: 1px) { :scope > dialog:not(:scope) { display: flex; outline-style: solid; } } }",
        "@scope (.impossible) { @media (min-width: 1px) { :scope > :scope { display: flex; outline-style: solid; } } }",
        "@scope (.listScope) { @media (min-width: 1px) { :scope > .listExplicit, .listPlain { display: flex; outline-style: solid; } } }",
        '@scope (.literalScope) { @media (min-width: 1px) { :scope > dialog[data-note=":scope"], :scope > .test\\:scope { display: flex; outline-style: solid; } } }',
        '@scope (.literalSelf) { @media (min-width: 1px) { dialog[data-note=":scope"], .test\\:scope { display: flex; outline-style: solid; } } }',
        "@scope (.relativeScope) { @media (min-width: 1px) { > dialog:not(:scope) { display: flex; outline-style: solid; } } }",
        "@scope (.relativeAmp) { @media (min-width: 1px) { > dialog:not(&) { display: flex; outline-style: solid; } } }",
        "@scope (.relativeList) { @media (min-width: 1px) { > dialog:not(:scope, .other), .other { display: flex; outline-style: solid; } } }",
        ".scopeHost { @scope (.scopeInner) { @media (min-width: 1px) { :scope > .nestedScope { display: flex; } } } }",
        "@scope (.outerScope) { @scope (.innerScope) { @media (min-width: 1px) { :scope > .doubleScope { display: grid; } } } }",
        "@scope (.outerExact) { @scope (:scope > .innerExact:not(:scope)) { @media (min-width: 1px) { :scope > dialog:not(:scope) { display: flex; outline-style: solid; } } } }",
        '@media (min-width: 1px) { :scope > body > #documentScope[data-note=":scope"], & > body > #documentAmp[data-note="&"], :scope#notDocumentScope, &#notDocumentAmp { display: flex; outline-style: solid; } }',
        "@scope (.limitOuter) to (.limitStop) { @scope (.limitInner) { @media (min-width: 1px) { dialog { display: flex; outline-style: solid; } } } }",
        "@media (min-width: 1px) { .limitDrawn { display: flex; } }",
        "@scope (.limitDraws) to (.limitStop) { .limitDrawn { display: grid !important; outline-style: solid; } }",
      ].join("\n"),
    }),
  );
  await drawn.route(base + "/dialog-implicit.css", (route) =>
    route.fulfill({ contentType: "text/css", body: "@scope { @media (min-width: 1px) { :scope > body dialog, :scope > .implicitChild { display: flex; outline-style: solid; } } }" }),
  );
  await drawn.route(base + "/dialog-undefined.css", (route) =>
    route.fulfill({ contentType: "text/css", body: "@scope { a { color: red; } } @scope (undefined) { @media (min-width: 1px) { #undefinedStart { display: flex; outline-style: solid; } } }" }),
  );
  await drawn.route(base + "/dialog-undefined-after.css", (route) =>
    route.fulfill({ contentType: "text/css", body: "@scope (undefined) { a { color: red; } } @scope { @media (min-width: 1px) { #undefinedAfter { display: flex; outline-style: solid; } } }" }),
  );
  const loaded = reportOf("last");
  const loadedLive = reportOf("lastlive");
  const loadedRail = reportOf("lastrail");
  await drawn.goto(base + "/");
  const onLoad = (await loaded) ? errors.filter((e) => e.includes("its own attributes refuse")).map((e) => e.split(" ")[1]) : [];
  check("dev mode reports a control drawn with a value its own attributes refuse, and only those", onLoad.join(",") === "delay,last", onLoad.join(","));
  const nestedOnLoad = (await loadedLive) ? errors.filter((e) => e.includes("is a live region inside another")).map((e) => e.split(" ")[1]) : [];
  check("dev mode reports a live region drawn inside another, and only those", nestedOnLoad.join(",") === "inner,lastlive", nestedOnLoad.join(","));
  const railOnLoad = (await loadedRail) ? warnings.filter((e) => e.includes(" is a closed ")) : [];
  const railNames = railOnLoad.map((e) => e.split(" ")[1]).join(",");
  check("dev mode warns of a closed dialog or popover a rule inside a media query gives a display, and only those", railNames === "rail,inplace,nav,side,scopedPlain,scopedRoot,scopedAmp,scopedDeclarations,scopedContainer,sameRoot,listPlain,listExplicit,literalAttribute,literalEscape,relativeScope,relativeAmp,relativeList,relativeOther,scopedPopover,nestedScope,doubleScope,exactScope,documentScope,documentAmp,limitKept,limitDrawn,implicitIn,undefinedAfter,lastrail", railNames);
  const warned = new Set(railOnLoad.map((e) => e.split(" ")[1]));
  check("plain scoped selectors stay descendants, independently in each selector-list member", !warned.has("scopedSelf") && !warned.has("outsideAncestor") && !warned.has("listSelf") && warned.has("listPlain") && warned.has("listExplicit"));
  check("every :scope in a selector binds the same root", warned.has("sameRoot") && !warned.has("differentRoots"));
  check("selector strings and escaped identifiers are not scope tokens", warned.has("literalAttribute") && warned.has("literalEscape") && !warned.has("literalImpostor") && !warned.has("literalSelf"));
  check("leading combinators keep their scope anchor and other selector-list members", ["relativeScope", "relativeAmp", "relativeList", "relativeOther"].every((id) => warned.has(id)) && !warned.has("outsideRelativeScope"));
  const relativeLooks = await drawn.evaluate(() => ["relativeScope", "relativeAmp", "relativeList", "relativeOther", "outsideRelativeScope"].map((id) => getComputedStyle(/** @type {Element} */ (document.getElementById(id))).outlineStyle).join(","));
  check("the browser applies the relative scoped selectors to the same controls", relativeLooks === "solid,solid,solid,solid,none", relativeLooks);
  const scopedLooks = await drawn.evaluate(() => ["sameRoot", "differentRoots", "listSelf", "listPlain", "listExplicit", "literalAttribute", "literalEscape", "literalImpostor", "literalSelf"].map((id) => getComputedStyle(/** @type {Element} */ (document.getElementById(id))).outlineStyle).join(","));
  check("the browser applies the scoped regression rules only to the positive controls", scopedLooks === "solid,none,none,solid,solid,solid,solid,none,none", scopedLooks);
  const anchorCases = ["exactScope", "outsideExact", "documentScope", "documentAmp", "notDocumentScope", "notDocumentAmp"];
  const anchorLooks = await drawn.evaluate((ids) => ids.map((id) => getComputedStyle(/** @type {Element} */ (document.getElementById(id))).outlineStyle === "solid"), anchorCases);
  check("exact nested roots and unscoped document roots agree with native styles", anchorLooks.join(",") === "true,false,true,true,false,false" && anchorCases.every((id, i) => warned.has(id) === anchorLooks[i]), anchorLooks.join(","));
  // The limited rule's outline marks where it applies: its !important display hides nothing it misses.
  const limitCases = ["limitCut", "limitKept", "limitDrawn", "limitShown"];
  const limitLooks = await drawn.evaluate((ids) => ids.map((id) => getComputedStyle(/** @type {Element} */ (document.getElementById(id))).outlineStyle === "solid"), limitCases);
  check("a scope's limit cuts nested scopes and its own rules as the browser does, both ways", limitLooks.join(",") === "false,true,false,true" && limitCases.map((id) => warned.has(id)).join(",") === "false,true,true,false", limitLooks.join(","));
  const implicitCases = ["implicitIn", "implicitDeep", "implicitOut"];
  const implicitLooks = await drawn.evaluate((ids) => ids.map((id) => getComputedStyle(/** @type {Element} */ (document.getElementById(id))).outlineStyle === "solid"), implicitCases);
  check("a scope without a start is the stylesheet parent's, as the browser applies it", implicitLooks.join(",") === "true,false,false" && implicitCases.every((id, i) => warned.has(id) === implicitLooks[i]), implicitLooks.join(","));
  const undefinedCases = ["undefinedStart", "undefinedAfter"];
  const undefinedLooks = await drawn.evaluate((ids) => ids.map((id) => getComputedStyle(/** @type {Element} */ (document.getElementById(id))).outlineStyle === "solid"), undefinedCases);
  check("a scope without a start is not one that starts at `undefined`, in either order", undefinedLooks.join(",") === "false,true" && undefinedCases.every((id, i) => warned.has(id) === undefinedLooks[i]), undefinedLooks.join(","));
  check(
    "its warning names the rule, the query, the rule that draws it in place and the open one's look",
    !!railOnLoad[0]?.includes("`.rail` in `@media (min-width: 9999px)` gives display: block") &&
      !!railOnLoad[0]?.includes("`.rail:not([open],[hidden]) { display: block !important }`") &&
      !!railOnLoad[0]?.includes("`.rail[open]`"),
    railOnLoad[0],
  );
  // components.css's rule is what hides `inplace`, whose query holds now; the rule the warning
  // gives draws `kept` over it.
  const shown = await drawn.evaluate(() => ["inplace", "kept", "keptHidden"].map((id) => getComputedStyle(/** @type {Element} */ (document.getElementById(id))).display).join(","));
  check("components.css hides a closed dialog a query draws, and the rule the warning gives draws it but not one with hidden", shown === "none,block,none", shown);
  const patchedRail = reportOf("patchedrail");
  await drawn.evaluate(() => document.body.append(Object.assign(document.createElement("dialog"), { id: "patchedrail", className: "rail" })));
  check("dev mode warns of such a dialog a patch draws", await patchedRail);
  // One drawn with `hidden` is meant hidden and not warned of, until a script shows it.
  await drawn.evaluate(() => document.body.append(Object.assign(document.createElement("dialog"), { id: "hiddenrail", className: "rail", hidden: true })));
  const quiet = reportOf("hiddenquiet");
  await drawn.evaluate(() => document.body.append(Object.assign(document.createElement("dialog"), { id: "hiddenquiet", className: "rail" })));
  const whileHidden = (await quiet) && !warnings.some((w) => w.startsWith("corten: hiddenrail "));
  const unhidden = reportOf("hiddenrail");
  await drawn.evaluate(() => ((/** @type {HTMLElement} */ (document.getElementById("hiddenrail"))).hidden = false));
  check("dev mode warns of such a dialog once a script shows it, not while it has hidden", whileHidden && (await unhidden));
  const patchedLive = reportOf("patchedlive");
  await drawn.evaluate(() => {
    const p = Object.assign(document.createElement("p"), { id: "patchedlive", textContent: "Sent." });
    p.setAttribute("role", "alert");
    document.getElementById("lasthost")?.append(p);
  });
  check("dev mode reports such a region a patch draws", await patchedLive);
  const patched = reportOf("patched");
  await drawn.evaluate(() => {
    // Built from elements, not markup: the page requires Trusted Types.
    const form = document.createElement("form");
    const input = Object.assign(document.createElement("input"), { type: "number", name: "patched", min: "1" });
    input.setAttribute("value", "0");
    form.append(input);
    document.body.append(form);
  });
  check("dev mode reports such a control a patch draws", await patched);
  const namedInvalid = reportOf("named-invalid");
  const namedRegion = reportOf("named-region");
  await drawn.evaluate(() => {
    const form = document.createElement("form");
    form.setAttribute("role", "alert");
    const input = Object.assign(document.createElement("input"), { type: "number", name: "named-invalid", min: "1" });
    input.setAttribute("value", "0");
    const region = Object.assign(document.createElement("p"), { id: "named-region" });
    region.setAttribute("role", "status");
    for (const name of ["noValidate", "parentElement", "closest", "getAttribute", "id", "localName", "isConnected"]) {
      form.append(Object.assign(document.createElement("input"), { type: "hidden", name }));
    }
    form.append(input, region);
    document.body.append(form);
  });
  check("dev diagnostics read a form past controls named noValidate, parentElement, closest and the like", (await namedInvalid) && (await namedRegion));
  // What the user typed is theirs, not the page's: a bound a script moves past it is not reported.
  await drawn.evaluate(() => {
    const input = /** @type {HTMLInputElement} */ (document.querySelector('input[name="delay"]'));
    input.closest("form")?.append(Object.assign(document.createElement("input"), { type: "number", name: "typed" }));
    const typed = /** @type {HTMLInputElement} */ (document.querySelector('input[name="typed"]'));
    typed.value = "7";
  });
  const moved = reportOf("typed");
  await drawn.evaluate(() => document.querySelector('input[name="typed"]')?.setAttribute("max", "5"));
  const marker = reportOf("after");
  await drawn.evaluate(() => {
    const form = document.createElement("form");
    const input = Object.assign(document.createElement("input"), { type: "number", name: "after", min: "1" });
    input.setAttribute("value", "0");
    form.append(input);
    document.body.append(form);
  });
  check("dev mode does not report a value the user typed", (await marker) && !(await Promise.race([moved, Promise.resolve(false)])));
  await drawn.close();
  // Count work, not elapsed time: rule reads, fixture matches, and queries (including their results).
  // The span from the first counted match to the last is the check's time, for one that stalls.
  /** @param {string} markup @param {string} css @param {number} count @param {boolean} [patch] @param {string} [last] */
  async function dialogWork(markup, css, count, patch = false, last = `work${count - 1}`) {
    const many = await browser.newPage();
    /** @type {string[]} */
    const warned = [];
    /** @type {string[]} */
    const skipped = [];
    many.on("console", (m) => {
      if (m.type() === "warning" && m.text().startsWith("corten: work")) warned.push(m.text().split(" ")[1] ?? "");
      if (m.type() === "warning" && m.text().startsWith("corten: skipped ")) skipped.push(m.text());
    });
    await many.addInitScript(() => {
      const counter = { reads: 0, matches: 0, queries: 0, results: 0, first: 0, last: 0 };
      Object.assign(window, { dialogWork: counter });
      const selectorText = Object.getOwnPropertyDescriptor(CSSStyleRule.prototype, "selectorText");
      Object.defineProperty(CSSStyleRule.prototype, "selectorText", {
        ...selectorText,
        get() {
          const selector = selectorText?.get?.call(this) ?? "";
          if (selector.includes(".workDialog")) counter.reads++;
          return selector;
        },
      });
      const matches = Element.prototype.matches;
      Element.prototype.matches = function (selector) {
        if (selector.includes(".work") || this.classList.contains("workScope") && selector.includes(":scope")) {
          counter.last = performance.now();
          if (!counter.matches++) counter.first = counter.last;
        }
        return matches.call(this, selector);
      };
      /** @type {(this: Element | Document, selector: string) => NodeListOf<Element>} */
      function query(selector) {
        const result = (this instanceof Document ? documentQuery : elementQuery).call(this, selector);
        if (selector.includes(".work") || this instanceof Element && this.classList.contains("workScope") && selector.includes(":scope")) {
          counter.queries++;
          counter.results += result.length;
        }
        return result;
      }
      const elementQuery = Element.prototype.querySelectorAll;
      const documentQuery = Document.prototype.querySelectorAll;
      Element.prototype.querySelectorAll = query;
      Document.prototype.querySelectorAll = query;
    });
    await many.route(base + "/", async (route) => {
      if (route.request().headers().corten) return route.continue();
      const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "gzip" } });
      await route.fulfill({ response: res, body: (await res.text()).replace("</head>", '<link rel="stylesheet" href="/dialog-work.css"></head>').replace("</body>", `${markup}</body>`) });
    });
    await many.route(base + "/dialog-work.css", (route) => route.fulfill({ contentType: "text/css", body: css }));
    const done = many.waitForEvent("console", { predicate: (m) => m.text().startsWith(`corten: ${last} `), timeout: 30000 }).then(() => true, () => false);
    await many.goto(base + "/");
    if (patch) {
      // Wait for the startup check and observer before drawing one dialog in a small patch.
      await many.waitForFunction(() => !!(/** @type {any} */ (window)).dialogWork.reads);
      await many.evaluate(() => {
        const counter = (/** @type {any} */ (window)).dialogWork;
        Object.assign(counter, { reads: 0, matches: 0, queries: 0, results: 0 });
        document.getElementById("workPatch")?.append(Object.assign(document.createElement("dialog"), { id: "work0", className: "workDialog" }));
      });
    }
    const completed = await done;
    const { reads, matches, queries, results, first, last: end, looks, drawn } = await many.evaluate((count) => ({
      ...(/** @type {{reads: number, matches: number, queries: number, results: number, first: number, last: number}} */ (/** @type {any} */ (window)).dialogWork),
      looks: Array.from({ length: count }, (_, i) => document.getElementById(`work${i}`)).every((el) => el !== null && getComputedStyle(el).outlineStyle === "solid"),
      drawn: getComputedStyle(/** @type {Element} */ (document.getElementById("work0"))).outlineStyle === "solid",
    }), count);
    await many.close();
    const span = Math.round(end - first);
    return { reads, matches, queries, results, completed, warned, skipped, drawn, span, ok: completed && warned.length === count && looks, detail: `${warned.length}/${count} warnings, native styles ${looks}, ${skipped.length} skipped, ${reads} rule reads, ${matches} matches, ${queries} queries, ${results} results, ${span} ms` };
  }
  const scopedRule = "@media (min-width: 1px) { .workDialog { display: flex; outline-style: solid; } }";
  const dialog = (/** @type {number} */ i) => `<dialog class="workDialog" id="work${i}"></dialog>`;
  const scopeRoot = '<div class="workScope">';
  const count = 1600;
  const many = await dialogWork(Array.from({ length: count }, (_, i) => scopeRoot + dialog(i) + "</div>").join(""), `@scope (.workScope) { ${scopedRule} }`, count);
  check("one scoped rule is read once even with many candidates", many.ok && many.reads <= 2 && many.queries === 0 && many.matches <= 5 * count, many.detail);
  for (const depth of [80, 160, 320]) {
    // Keep the deep fixture out of layout; the browser still computes the dialog's style.
    const nested = await dialogWork("<div hidden>" + scopeRoot.repeat(depth) + dialog(0) + "</div>".repeat(depth + 1), `@scope (.workScope) { @scope (.workScope) { ${scopedRule} } }`, 1);
    check(`overlapping nested scopes do linear work at depth ${depth}`, nested.ok && nested.reads <= 2 && nested.queries === 0 && nested.matches <= 4 * depth, nested.detail);
    // A start with more after its :scope (the review's), and one that names its root twice, which
    // needs each root exactly: only an element that could be the start's subject is tried.
    const panel = "<div hidden>" + scopeRoot.repeat(depth) + '<div class="workPanel">' + dialog(0) + "</div>".repeat(depth + 2);
    for (const start of [":scope:not(.disabled) > .workPanel", ":scope > .workPanel:not(:scope)"]) {
      const exact = await dialogWork(panel, `@scope (.workScope) { @scope (${start}) { ${scopedRule} } }`, 1);
      check(`a nested start \`${start}\` does linear work at depth ${depth}`, exact.ok && exact.reads <= 2 && exact.queries === 0 && exact.matches <= 4 * depth, exact.detail);
    }
    // Every ancestor a root and a subject (the review's): a start or limit whose root is the
    // subject or its parent tries those two, and any other has a budget of tries a few times the
    // depth; past it, the rule is skipped and named. A marker dialog after the chain ends the check.
    const chain = (/** @type {string} */ last) => "<div hidden>" + '<div class="workOuter workPanel">'.repeat(depth) + last + dialog(0) + "</div>".repeat(depth + (last ? 2 : 1)) + '<dialog class="workEnd" id="workEnd"></dialog>';
    const marker = "@media (min-width: 1px) { .workEnd { display: flex; } }";
    for (const [last, scope, skips] of /** @type {[string, string, boolean][]} */ ([
      ["", "@scope (.workOuter) { @scope (:scope.disabled > .workPanel:not(:scope)) { RULE } }", false],
      ['<div class="workOuter workPanel enabled">', "@scope (.workOuter) { @scope (:scope.enabled > .workPanel:not(:scope), :scope.enabled.workPanel) { RULE } }", false],
      ["", "@scope (.workOuter) to (:scope > .workPanel) { RULE }", false],
      ["", "@scope (.workOuter) to (.workPanel) { RULE }", false],
      ["", "@scope (.workOuter) to (.missing .workPanel) { RULE }", true],
    ])) {
      const dense = await dialogWork(chain(last), `${scope.replace("RULE", scopedRule)} ${marker}`, 1, false, "workEnd");
      const verdict = skips ? !dense.warned.includes("work0") && dense.skipped.length === 1 && !!dense.skipped[0]?.includes("`.workDialog`") : dense.warned.includes("work0") === dense.drawn && dense.skipped.length === 0;
      check(`\`${scope.replace(/ \{ RULE.*/, "")}\` stays within its budget at depth ${depth}`, dense.completed && verdict && dense.matches <= 5 * depth + 128 && dense.span < 1000, `native ${dense.drawn}, warned ${dense.warned}, ${dense.detail}`);
    }
  }
  const flatScopes = await dialogWork(scopeRoot + dialog(0) + "</div>" + (scopeRoot + "</div>").repeat(count - 1), `@scope (.workScope) { @media (min-width: 1px) { ${Array.from({ length: 64 }, (_, i) => `.workDialog:not(.workSkip${i}) { display: flex; outline-style: solid; }`).join("")} } }`, 1);
  check("64 scoped rules do not scan 1,600 sibling roots", flatScopes.ok && flatScopes.reads <= 64 && flatScopes.queries === 0 && flatScopes.matches <= 128, flatScopes.detail);
  const unscopedRules = Array.from({ length: 32 }, (_, i) => `.workDialog:not(.workSkip${i}, #workReady) { display: flex; outline-style: solid; }`).join("");
  for (const unrelated of [0, 6400]) {
    const unscoped = await dialogWork('<dialog id="workReady"></dialog><div id="workPatch"></div>' + '<div class="workDialog"></div>'.repeat(unrelated), `@media (min-width: 1px) { ${unscopedRules} }`, 1, true);
    check(`a one-dialog patch does not query unscoped rules across ${unrelated} unrelated matches`, unscoped.ok && unscoped.reads <= 64 && unscoped.queries === 0 && unscoped.matches <= 32, unscoped.detail);
  }
  // A handler given a form field its form does not have as the handler takes it (the compiler
  // cannot see the control, which another component may draw) is reported when the page draws
  // it, before any event calls it, and when a later draw adds one; one whose fields fit is not.
  // The dev server mounts no smoke routes, so the calls are drawn into its home page, as
  // `ship_form` (examples/watchlist/src/smoke.rs) writes them.
  const shipped = await browser.newPage();
  /** @type {string[]} */
  const fieldErrors = [];
  shipped.on("console", (m) => m.type() === "error" && m.text().includes(" takes field ") && fieldErrors.push(m.text()));
  await shipped.route(base + "/", async (route) => {
    // The page's own read of its picks (`corten: action`, a patch) goes as it is: one still out
    // when the page closes would fail its fetch here.
    if (route.request().headers().corten) return route.continue();
    const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "gzip" } });
    const forms = [
      '<form id="ship"><input name="weight"><textarea name="note"></textarea>',
      '<input type="radio" name="size" value="s"><input type="radio" name="size" value="l">',
      `<button type="button" data-on='click:ship_form.fill(~i"weight",~t"note",~*"size")'>Fill</button>`,
      `<button type="button" data-on='click:ship_form.weigh(~i"note")'>Weigh the note</button></form>`,
      `<form><button type="button" data-on='click:ship_form.weigh(~i"weight")'>Weigh elsewhere</button></form>`,
      `<button type="button" data-on='click:ship_form.weigh(~i"weight")'>Weigh outside</button>`,
    ].join("");
    await route.fulfill({ response: res, body: (await res.text()).replace("</body>", `${forms}</body>`) });
  });
  await shipped.goto(base + "/");
  for (let waited = 0; fieldErrors.length < 3 && waited < 10000; waited += 100) await shipped.waitForTimeout(100);
  /** @param {string} message */
  const reported = (message) => fieldErrors.some((e) => e.startsWith(message));
  check(
    "dev mode reports a handler given a form field its form does not have as it takes it, as the page draws it",
    fieldErrors.length === 3 &&
      reported("corten: ship_form.weigh takes field note as one <input>, and its form has textarea") &&
      reported("corten: ship_form.weigh takes field weight as one <input>, and its form has none") &&
      reported("corten: ship_form.weigh takes field weight as one <input>, and it is in no form"),
    fieldErrors.join(" | "),
  );
  await shipped.evaluate(() => {
    // Built from elements, not markup, as a patch would draw it.
    const later = document.createElement("button");
    later.type = "button";
    later.setAttribute("data-on", 'click:ship_form.weigh(~i"size")');
    document.getElementById("ship")?.append(later);
  });
  for (let waited = 0; fieldErrors.length < 4 && waited < 10000; waited += 100) await shipped.waitForTimeout(100);
  check(
    "dev mode reports such a field a later draw adds, and not the call whose fields fit",
    fieldErrors.length === 4 &&
      !!fieldErrors[3]?.startsWith("corten: ship_form.weigh takes field size as one <input>, and its form has input, input") &&
      !fieldErrors.some((e) => e.includes("ship_form.fill")),
    fieldErrors.join(" | "),
  );
  // A form whose controls are named as the element methods the check calls is still checked.
  await shipped.evaluate(() => {
    const form = document.createElement("form");
    for (const name of ["closest", "matches", "getAttribute", "querySelectorAll"]) form.append(Object.assign(document.createElement("input"), { name }));
    const later = document.createElement("button");
    later.type = "button";
    later.setAttribute("data-on", 'click:ship_form.weigh(~t"closest")');
    form.append(later);
    document.body.append(form);
  });
  for (let waited = 0; fieldErrors.length < 5 && waited < 10000; waited += 100) await shipped.waitForTimeout(100);
  check(
    "dev mode checks a later form whose controls are named closest, matches and the like",
    !!fieldErrors[4]?.startsWith("corten: ship_form.weigh takes field closest as one <textarea>, and its form has input"),
    fieldErrors.join(" | "),
  );
  // A control drawn outside a form and joined to it with `form=` rechecks that form's calls: a
  // second weight makes the one `fill` takes ambiguous.
  await shipped.evaluate(() => {
    const extra = Object.assign(document.createElement("input"), { name: "weight" });
    extra.setAttribute("form", "ship");
    document.body.append(extra);
  });
  for (let waited = 0; fieldErrors.length < 6 && waited < 10000; waited += 100) await shipped.waitForTimeout(100);
  check(
    "dev mode rechecks a form's calls when a control joins it from outside with form=",
    !!fieldErrors[5]?.startsWith("corten: ship_form.fill takes field weight as one <input>, and its form has input, input"),
    fieldErrors.join(" | "),
  );
  await shipped.unrouteAll({ behavior: "ignoreErrors" });
  await shipped.close();
  // Bounded: a blocking call holds the event loop, so the stall watchdog could not stop it.
  execFileSync("docker", ["restart", "-t", "1", container], { stdio: "ignore", timeout: 60_000 });
  await page.waitForFunction((b) => document.querySelector('meta[name="corten-dev"]')?.getAttribute("content") !== b, boot, { timeout: 20000 }).catch(() => {});
  const after = await page.getAttribute('meta[name="corten-dev"]', "content").catch(() => null);
  check("the open page reloads when the server restarts", !!after && after !== boot && (await page.evaluate(() => (/** @type {any} */ (window)).__marker === undefined)));
} finally {
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
