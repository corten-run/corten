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
  const drawn = await browser.newPage({ viewport: { width: 600, height: 800 } });
  let skippedShapes = false;
  let fallbackChild = "";
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
      '<div class="plainPage"><dialog id="scopedPlain" class="scopedPlain"></dialog></div><dialog id="outsidePlain" class="scopedPlain"></dialog>',
      '<div class="rootPage"><dialog id="scopedRoot" class="scopedRoot"></dialog></div><dialog id="outsideRoot" class="scopedRoot"></dialog>',
      '<div class="scoped"><dialog id="scopedAmp" class="scopedAmp"></dialog></div><dialog id="outsideAmp" class="scopedAmp"></dialog>',
      '<dialog id="scopedDeclarations" class="scopedDeclarations"></dialog>',
      '<div class="scoped"><dialog id="scopedContainer" class="scopedContainer"></dialog></div><dialog id="outsideContainer" class="scopedContainer"></dialog>',
      '<dialog id="scopedSelf" class="scopedSelf"></dialog>',
      '<div class="ancestorScope"><dialog id="outsideAncestor"></dialog></div>',
      '<div class="listScope"><dialog id="listPlain" class="listPlain"></dialog><dialog id="listExplicit" class="listExplicit"></dialog></div><dialog id="listSelf" class="listScope listPlain"></dialog>',
      '<div class="relativeScope"><dialog id="relativeChild"></dialog></div>',
      '<div class="scoped"><div id="scopedPopover" class="scopedPopover" popover></div></div><div id="outsidePopover" class="scopedPopover" popover></div>',
      '<div class="outerScope"><div class="innerScope"><dialog id="doubleScope" class="doubleScope"></dialog></div></div><div class="innerScope"><dialog id="outsideDoubleScope" class="doubleScope"></dialog></div>',
      '<div class="limitOuter"><div class="limitStop"><dialog class="cut" id="limitCut"></dialog></div><dialog class="cut" id="limitKept"></dialog></div>',
      '<section>' + (skippedShapes ? '<link rel="stylesheet" href="/dialog-implicit.css">' : '') + '<div class="implicitOuter"><dialog id="implicitNested"></dialog></div></section>',
      '<div class="identity"><dialog id="differentRoots" class="identity"></dialog></div>',
      '<dialog id="explicitScopeRoot" class="explicitScopeRoot"></dialog>',
      '<dialog id="keyframeRail" class="keyframeRail"></dialog>',
      '<dialog class="anonymousRail"></dialog>',
      '<div class="overridePanel"><dialog id="insideOverride" class="overrideRail"></dialog></div><dialog id="outsideOverride" class="overrideRail"></dialog>',
      '<div class="panel"><dialog id="closedInsidePanel"></dialog></div><dialog id="closedOutsidePanel"></dialog>',
      '<div class="card"><div id="skipCardBody" class="card-body"></div><div class="slot"></div></div>',
      fallbackChild ? '<div class="card"><dialog id="insideFallback" class="rail card-body" data-state="READY"><span class="flag"></span></dialog><div class="slot"></div></div>' : '',
      '<dialog class="filters"></dialog>',
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
        skippedShapes ? "@media (min-width: 900px) { .rail { display: flex; } }" : "@media (min-width: 9999px) { .rail { display: block; } }",
        "@media (min-width: 1px) { .kept { display: block; } .kept:not([open],[hidden]) { display: block !important; } }",
        "@media (min-width: 1px) { .gone { display: none; } }",
        "@media (min-width: 1px) { .inplace { display: block; } .modal[open] { display: grid; } }",
        "@supports (display: grid) { .enhanced { display: grid; } }",
        "@media (min-width: 1px) { .nav { display: grid; } }",
        ".page { .side { @media (min-width: 1px) { display: block; } } }",
        "@media (min-width: 1px) { @scope (.plainPage) { dialog.scopedPlain { display: flex; outline-style: solid; } } @scope (.rootPage) { :scope > dialog.scopedRoot { display: grid; outline-style: solid; } } @scope (.scoped) { & > .scopedAmp { display: block; } :scope > .scopedPopover { display: block; } } @scope (.scopedDeclarations) { display: flex; outline-style: solid; } }",
        "@container (min-width: 1px) { @scope (.scoped) { :scope > .scopedContainer { display: flex; } } }",
        "@scope (.scopedSelf) { @media (min-width: 1px) { dialog.scopedSelf { display: grid; } } }",
        "@scope (.ancestorScope) { @media (min-width: 1px) { body #outsideAncestor { display: flex; } } }",
        "@scope (.listScope) { @media (min-width: 1px) { :scope > .listExplicit, .listPlain { display: flex; } } }",
        "@scope (.relativeScope) { @media (min-width: 1px) { > #relativeChild { display: flex; } } }",
        "@scope (.outerScope) { @scope (.innerScope) { @media (min-width: 1px) { :scope > .doubleScope { display: grid; } } } }",
        "@scope (.limitOuter) to (.limitStop) { @media (min-width: 1px) { .cut { display: flex; outline-style: solid; } .cut { display: grid; } } }",
        "@media (min-width: 1px) { @scope (.keyframeRail) { @keyframes unused { to { display: flex; } } } }",
        "@media (min-width: 1px) { @scope (.anonymousRail) { :scope { display: flex; } } }",
        "@media (min-width: 900px) { .overrideRail { display: flex; } @scope (.overridePanel) to (.stop) { .overrideRail { display: flex !important; } } }",
        "@scope (.panel) { @media (min-width: 1px) { dialog:not([open]) { display: flex; outline-style: solid; } } }",
        ".filters { @media (min-width: 900px) { & { display: flex; } } }",
        fallbackChild ? `@scope (.card) to (.slot) { @media (min-width: 900px) { ${fallbackChild} { display: grid !important; content: ""; } } }` : "",
        ...(skippedShapes ? [
          "@scope (.card) to (.slot) { :scope > .card-body { display: grid !important; } :scope dialog { display: none !important; } }",
          "@scope (.card) to (.slot) { :scope > .card-body:not(.gone,.pending) { display: grid !important; outline-style: solid; } }",
          "@scope (.identity) { @media (min-width: 1px) { :scope > :scope { display: flex; outline-style: solid; } } }",
          "@scope (:scope) { @media (min-width: 1px) { .explicitScopeRoot { display: flex; outline-style: solid; } } }",
        ] : []),
      ].join("\n"),
    }),
  );
  await drawn.route(base + "/dialog-implicit.css", (route) =>
    route.fulfill({ contentType: "text/css", body: "@scope (.implicitOuter) { @scope { @media (min-width: 1px) { :scope .implicitOuter > #implicitNested { display: flex; outline-style: solid; } } } }" }),
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
  check("dev mode warns of a closed dialog or popover a rule inside a media query gives a display, and only those", railNames === "rail,inplace,nav,side,scopedPlain,scopedRoot,scopedAmp,scopedDeclarations,scopedContainer,listPlain,listExplicit,relativeChild,scopedPopover,doubleScope,dialog,outsideOverride,closedInsidePanel,dialog,lastrail", railNames);
  const warned = new Set(railOnLoad.map((e) => e.split(" ")[1]));
  check("a plain scoped dialog rule does not warn outside its root", warned.has("scopedPlain") && !warned.has("outsidePlain"), railNames);
  check(":scope > dialog warns only inside its root", warned.has("scopedRoot") && !warned.has("outsideRoot"), railNames);
  const closedStateLooks = await drawn.locator("#closedInsidePanel, #closedOutsidePanel").evaluateAll((els) => els.map((el) => getComputedStyle(el).outlineStyle).join(","));
  check("dialog:not([open]) warns only inside its scope root", closedStateLooks === "solid,none" && railOnLoad.some((m) => m.startsWith("corten: closedInsidePanel ") && m.includes("`dialog:not([open])` in")) && !warned.has("closedOutsidePanel"), closedStateLooks);
  check("declarations directly in @scope warn on the root", railOnLoad.some((m) => m.startsWith("corten: scopedDeclarations ") && m.includes("`.scopedDeclarations` in")), railNames);
  const reproLooks = await drawn.evaluate(() => ["scopedPlain", "outsidePlain", "scopedRoot", "outsideRoot", "scopedDeclarations"].map((id) => getComputedStyle(/** @type {Element} */ (document.getElementById(id))).outlineStyle).join(","));
  check("native styles apply only to the three scope repros' positive controls", reproLooks === "solid,none,solid,none,solid", reproLooks);
  const limitLooks = await drawn.evaluate(() => ["limitCut", "limitKept"].map((id) => getComputedStyle(/** @type {Element} */ (document.getElementById(id))).outlineStyle).join(","));
  const notes = (/** @type {string} */ selector) => warnings.filter((m) => m.startsWith("corten: skipped `" + selector + "`:")).length;
  check("limited scopes are named once per written selector and do not warn", limitLooks === "none,solid" && !warned.has("limitCut") && !warned.has("limitKept") && notes(".cut") === 1, limitLooks);
  check("keyframes under a scope do not warn on the root", !warned.has("keyframeRail") && await drawn.locator("#keyframeRail").evaluate((el) => getComputedStyle(el).display) === "none");
  check("a scoped warning does not suggest a selector that drops the scope", railOnLoad.some((m) => m.startsWith("corten: dialog is a closed dialog that `:scope`") && !m.includes("dialog:not(")));
  const overrideDisplays = () => drawn.locator(".overrideRail").evaluateAll((els) => els.map((el) => getComputedStyle(el).display).join(","));
  const smallOverride = await overrideDisplays();
  check("a skipped override withholds only the inside rail warning at 600px and notes its selector once", smallOverride === "none,none" && !warned.has("insideOverride") && warned.has("outsideOverride") && notes(".overrideRail") === 1, smallOverride);
  const nestedRail = railOnLoad.find((m) => m.startsWith("corten: dialog is a closed dialog that `&`"));
  check("a nested & rule suggests the matching class on an idless dialog", !!nestedRail?.includes("`.filters:not([open],[hidden]) { display: flex !important }`"), nestedRail);
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
  await drawn.setViewportSize({ width: 1000, height: 800 });
  warnings.length = 0;
  const wideRail = reportOf("lastrail");
  await drawn.reload();
  const largeOverride = await overrideDisplays();
  check("the native scoped override draws only the inside rail at 1000px", await wideRail && largeOverride === "flex,none" && !warnings.some((m) => m.startsWith("corten: insideOverride ")) && warnings.some((m) => m.startsWith("corten: outsideOverride ")) && notes(".overrideRail") === 1, largeOverride);

  await drawn.setViewportSize({ width: 600, height: 800 });
  skippedShapes = true;
  warnings.length = 0;
  const skippedLoad = reportOf("lastrail");
  const skippedImplicit = drawn.waitForEvent("console", { predicate: (m) => m.text().startsWith("corten: skipped `:scope .implicitOuter > #implicitNested`:"), timeout: 10000 }).then(() => true, () => false);
  await drawn.reload();
  const implicitLooks = await drawn.locator("#implicitNested").evaluate((el) => getComputedStyle(el).outlineStyle);
  const warnedOnSkip = (/** @type {string} */ id) => warnings.some((m) => m.startsWith(`corten: ${id} is a closed`));
  const cardDisplay = await drawn.locator("#skipCardBody").evaluate((el) => getComputedStyle(el).display);
  check("skipped important rules in an unrelated limited scope do not silence dialog.rail at 600px", await skippedLoad && cardDisplay === "grid" && warnings.some((m) => m.startsWith("corten: rail is a closed dialog that `.rail` in `@media (min-width: 900px)` gives display: flex")) && notes(":scope > .card-body") === 1 && notes(":scope dialog") === 1, cardDisplay);
  check("the round 10 rule styles the card body but leaves the outside rail warning intact", warnedOnSkip("rail") && await drawn.locator("#skipCardBody").evaluate((el) => getComputedStyle(el).outlineStyle) === "solid" && warnings.some((m) => m.startsWith("corten: skipped `:scope > .card-body:not(")));
  check("a skip note names the selector and the check without a warning caveat", warnings.includes("corten: skipped `:scope > .card-body`: cannot compose its selector for the closed dialog and popover check"));
  check("nested implicit roots are skipped in every engine, including where WebKit applies them", await skippedImplicit && implicitLooks === (engine === "webkit" ? "solid" : "none") && !warnedOnSkip("implicitNested") && notes(":scope .implicitOuter > #implicitNested") === 1, implicitLooks);
  check("multiple scope references are skipped rather than matched to different roots", !warnedOnSkip("differentRoots") && notes(":scope > :scope") === 1);
  check("top-level explicit :scope roots are skipped", !warnedOnSkip("explicitScopeRoot") && notes(".explicitScopeRoot") === 1 && await drawn.locator("#explicitScopeRoot").evaluate((el) => getComputedStyle(el).outlineStyle) === "solid");
  skippedShapes = false;
  const attrFlag = await drawn.evaluate(() => CSS.supports("selector([data-state=READY s])")) ? '[data-state="READY" s]' : '[data-state="ready" i]';
  for (const [name, suffix] of [
    ["a :not() list", ":not(.gone,.pending)"],
    [":has()", ":has(> .flag)"],
    ["a complex :is() argument", ":is(.card > .card-body)"],
    [`an attribute flag (${attrFlag})`, attrFlag],
    ["a pseudo-element", "::before"],
  ]) {
    fallbackChild = ":scope > .card-body" + suffix;
    warnings.length = 0;
    const note = drawn.waitForEvent("console", { predicate: (m) => m.text().startsWith("corten: skipped `:scope > .card-body"), timeout: 10000 }).then(() => true, () => false);
    await drawn.reload();
    const inside = drawn.locator("#insideFallback");
    const noted = await note;
    const narrow = await inside.evaluate((el) => getComputedStyle(el).display);
    const outsideWarns = warnedOnSkip("rail");
    const insideQuiet = !warnedOnSkip("insideFallback");
    await drawn.setViewportSize({ width: 1000, height: 800 });
    const wide = await inside.evaluate((el, pseudo) => getComputedStyle(el, pseudo).display, suffix === "::before" ? suffix : null);
    await drawn.setViewportSize({ width: 600, height: 800 });
    check(`limited scope with ${name} withholds only the inside rail warning`, noted && narrow === "none" && wide === "grid" && outsideWarns && insideQuiet, `${narrow},${wide}; outside warns ${outsideWarns}, inside quiet ${insideQuiet}`);
  }
  await drawn.close();
  // Count work, not elapsed time: rule reads, fixture matches, and queries (including their results).
  // Time from the start of the closed-element check to its last fixture match.
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
      const counter = { reads: 0, matches: 0, queries: 0, results: 0, first: 0, last: 0, rejected: 0 };
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
        if (!counter.first && selector.startsWith("dialog:not([open],[popover])")) counter.first = performance.now();
        if (selector.startsWith(":is(") && selector.endsWith(".workRejectedLeaf")) {
          counter.rejected++;
          throw new DOMException("fixture rejects the composed child", "SyntaxError");
        }
        const result = matches.call(this, selector);
        if (selector.includes(".work") || this.classList.contains("workScope") && selector.includes(":scope")) {
          counter.last = performance.now();
          counter.matches++;
        }
        return result;
      };
      const closest = Element.prototype.closest;
      Element.prototype.closest = function (selector) {
        if (selector.startsWith(":is(") && selector.endsWith(".workRejectedRoot")) throw new DOMException("fixture rejects the composed root", "SyntaxError");
        return closest.call(this, selector);
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
        Object.assign(counter, { reads: 0, matches: 0, queries: 0, results: 0, first: 0, last: 0 });
        document.getElementById("workPatch")?.append(Object.assign(document.createElement("dialog"), { id: "work0", className: "workDialog" }));
      });
    }
    const completed = await done;
    const { reads, matches, queries, results, first, last: end, looks, drawn, rejected } = await many.evaluate((count) => ({
      ...(/** @type {{reads: number, matches: number, queries: number, results: number, first: number, last: number, rejected: number}} */ (/** @type {any} */ (window)).dialogWork),
      looks: Array.from({ length: count }, (_, i) => document.getElementById(`work${i}`)).every((el) => el !== null && getComputedStyle(el).outlineStyle === "solid"),
      drawn: getComputedStyle(/** @type {Element} */ (document.getElementById("work0"))).outlineStyle === "solid",
    }), count);
    await many.close();
    const span = first && end >= first ? end - first : Infinity;
    return { reads, matches, queries, results, completed, warned, skipped, drawn, span, rejected, ok: completed && warned.length === count && looks, detail: `${warned.length} warnings, native styles ${looks}, ${skipped.length} skipped, ${reads} rule reads, ${matches} matches, ${queries} queries, ${results} results, ${span.toFixed(1)} ms` };
  }
  const scopedRule = "@media (min-width: 1px) { .workDialog { display: flex; outline-style: solid; } }";
  const dialog = (/** @type {number} */ i) => `<dialog class="workDialog" id="work${i}"></dialog>`;
  const scopeRoot = '<div class="workScope">';
  const count = 1600;
  const many = await dialogWork(Array.from({ length: count }, (_, i) => scopeRoot + dialog(i) + "</div>").join(""), `@scope (.workScope) { ${scopedRule} }`, count);
  check("one scoped rule is read once even with many candidates", many.ok && many.reads <= 2 && many.queries === 0 && many.matches <= 5 * count, many.detail);
  const endDialog = '<dialog class="workEnd" id="workEnd"></dialog>';
  const markerRule = "@media (min-width: 1px) { .workEnd { display: flex; } }";
  const nonOverrides = await dialogWork(scopeRoot + dialog(0) + "</div>" + endDialog, scopedRule + "@scope (.workScope) to (.stop) { :scope > .workDialog:not(.gone,.pending) { display: grid; } :scope > .workDialog:has(*) { display: none !important; } }" + markerRule, 1, false, "workEnd");
  check("a skipped normal display and a skipped display: none !important do not silence a warning even inside their root", nonOverrides.completed && nonOverrides.drawn && nonOverrides.warned.join(",") === "work0,workEnd" && nonOverrides.skipped.length === 2, nonOverrides.detail);
  const noise = Array.from({ length: 80 }, (_, i) => `.workNoise${i} { display: flex; }`).join("");
  const rail = ".workDialog.rail { display: flex; outline-style: solid; }";
  for (const rules of [noise + rail, rail + noise]) {
    const result = await dialogWork('<section class="workScope"><dialog class="workDialog rail" id="work0"></dialog></section>', `@scope (.workScope) to (.stop) { @media (min-width: 1px) { ${noise} } } @scope (.workScope) { @media (min-width: 1px) { ${rules} } }`, 1);
    check(`unrelated rules cannot starve a supported rail (${rules === noise + rail ? "last" : "first"})`, result.ok && result.matches === 81 && result.skipped.length === 80, result.detail);
  }
  // The marker ends the measured span even when the rule under test is skipped.
  const depth = 320;
  const deepMarkup = '<div hidden>' + scopeRoot.repeat(depth) + dialog(0) + '</div>'.repeat(depth + 1) + endDialog;
  const deep = await dialogWork(deepMarkup, `@scope (.workScope) { @scope (.workScope) { ${scopedRule} } } ${markerRule}`, 1, false, "workEnd");
  check("overlapping roots at depth 320 use one match per rule and dialog", deep.completed && deep.drawn && deep.warned.includes("work0") && deep.matches === 4 && deep.span < 1000, deep.detail);
  const limit = await dialogWork(deepMarkup, `@scope (.workScope) to (:scope > .workScope) { ${scopedRule} } ${markerRule}`, 1, false, "workEnd");
  check("a direct-child limit at depth 320 skips the rule without matching its normal display as an override", limit.completed && limit.drawn && !limit.warned.includes("work0") && limit.matches === 2 && limit.skipped.length === 1 && limit.span < 1000, limit.detail);
  const wide = await dialogWork('<div class="a">'.repeat(18) + dialog(0) + '</div>'.repeat(18) + endDialog, "@scope (.a, .b) {".repeat(18) + scopedRule + "}".repeat(18) + markerRule, 1, false, "workEnd");
  check("18 nested two-member scope roots stop at the selector cap", wide.completed && wide.drawn && !wide.warned.includes("work0") && wide.matches === 2 && wide.skipped.length === 1 && wide.span < 1000, wide.detail);
  const overlongOverride = await dialogWork('<div class="a">'.repeat(18) + dialog(0) + '</div>'.repeat(18) + dialog(1) + endDialog, scopedRule + "@scope (.a, .b) {".repeat(18) + "@media (min-width: 9999px) { .workDialog { display: flex !important; } }" + "}".repeat(18) + markerRule, 2, false, "workEnd");
  check("an over-long composition keeps the scope bound even for the same plain selector outside it", overlongOverride.ok && overlongOverride.warned.join(",") === "work1,workEnd" && overlongOverride.matches === 9 && overlongOverride.skipped.length === 1, overlongOverride.detail);
  const inner = (/** @type {number} */ i) => `<div class="workInner workRejectedRoot"><span class="flag"></span>${dialog(i)}</div>`;
  const nestedMarkup = `<div class="workOuter">${inner(0)}${dialog(1)}</div>${inner(2)}${endDialog}`;
  const importantDisplay = (/** @type {string} */ child) => `@media (min-width: 9999px) { ${child} { display: grid !important; } }`;
  const nestedLimit = await dialogWork(nestedMarkup, scopedRule + `@scope (.workOuter) { @scope (.workInner:has(.flag)) to (.stop) { ${importantDisplay(":scope > .workDialog:not(.gone,.pending)")} } }` + markerRule, 3, false, "workEnd");
  check("a skipped nested scope keeps both its standalone root and its outer root", nestedLimit.ok && nestedLimit.warned.join(",") === "work1,work2,workEnd" && nestedLimit.skipped.length === 1, nestedLimit.detail);
  const nestedDeclarations = await dialogWork(nestedMarkup, scopedRule + "@scope (.workOuter) { .workDialog { @media (min-width: 9999px) { display: grid !important; } } }" + markerRule, 3, false, "workEnd");
  check("skipped declarations in a scoped style rule keep the scope bound", nestedDeclarations.completed && nestedDeclarations.drawn && nestedDeclarations.warned.join(",") === "work2,workEnd" && nestedDeclarations.skipped.length === 1, nestedDeclarations.detail);
  for (const limit of ["", " to (.stop)"]) {
    const parsed = await dialogWork(nestedMarkup.replaceAll('class="workDialog"', 'class="workDialog workRejectedLeaf"'), scopedRule + `@scope (.workOuter) { @scope (.workInner.workRejectedRoot)${limit} { ${importantDisplay(":scope > .workDialog.workRejectedLeaf")} } }` + markerRule, 3, false, "workEnd");
    check(`native selector parse failures keep outer and inner bounds (${limit ? "limited" : "unlimited"})`, parsed.ok && parsed.warned.join(",") === "work1,work2,workEnd" && parsed.rejected === 4, `${parsed.detail}, ${parsed.rejected} rejected child matches`);
  }
  const unknownRoot = await dialogWork(dialog(0) + endDialog, scopedRule + `@scope (:scope) { ${importantDisplay(":scope .workDialog:not(.gone,.pending)")} }` + markerRule, 2, false, "workEnd");
  check("a skipped rule without a matchable scope root cannot withhold a warning", unknownRoot.completed && unknownRoot.drawn && unknownRoot.warned.join(",") === "work0,workEnd" && unknownRoot.skipped.length === 1, unknownRoot.detail);
  const repeated = await dialogWork(scopeRoot + dialog(0) + "</div>" + endDialog, ".workScope { " + "&:is(&) { ".repeat(16) + scopedRule.replace(".workDialog", "& .workDialog") + "}".repeat(17) + markerRule, 1, false, "workEnd");
  check("expanding ordinary nesting stops at the selector cap without silencing an unrelated warning", repeated.completed && repeated.drawn && repeated.warned.join(",") === "workEnd" && repeated.matches === 2 && repeated.skipped.length === 1, repeated.detail);
  const flatScopes = await dialogWork(scopeRoot + dialog(0) + "</div>" + (scopeRoot + "</div>").repeat(count - 1), `@scope (.workScope) { @media (min-width: 1px) { ${Array.from({ length: 64 }, (_, i) => `.workDialog, .workOther${i} { display: flex; outline-style: solid; }`).join("")} } }`, 1);
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
