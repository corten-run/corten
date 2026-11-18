// Browser smoke test of `corten dev` live reload: an open page reloads when the server restarts.
// Usage: node scripts/smoke-dev.mjs http://localhost:18483 corten-watchlist-dev [chromium|firefox|webkit]
// (the watchlist image, run with -e CORTEN_DEV=1 in a container of that name).
// Set CORTEN_DEV_BASELINE to a Git revision to replay the parity cases with its dev.js.
import { chromium, firefox, webkit } from "@playwright/test";
import { steady } from "./steady.mjs";
import { execFileSync } from "node:child_process";
import { stall } from "./stall.mjs";

const [base = "http://localhost:18483", container = "corten-watchlist-dev", engine = "chromium"] = process.argv.slice(2);
const baseline = process.env.CORTEN_DEV_BASELINE && execFileSync("git", ["show", `${process.env.CORTEN_DEV_BASELINE}:crates/corten/js/dev.js`]);
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
      '<dialog id="keyframeRail" class="keyframeRail"></dialog>',
      '<dialog class="anonymousRail"></dialog>',
      '<div class="panel"><dialog id="closedInsidePanel"></dialog></div><dialog id="closedOutsidePanel"></dialog>',
      '<div class="card inner"><dialog id="sameRoot" class="nestedRail"></dialog></div><div class="card"><div class="inner"><dialog id="strictRoot" class="nestedRail"></dialog></div></div>',
      '<div class="boundCard inner"><dialog id="explicitInner" class="nestedRail"></dialog></div>',
      '<div class="scopeParent"><dialog id="outsideStyleParent" class="nestedRail"></dialog><div class="styleParent"><dialog id="insideStyleParent" class="nestedRail"></dialog></div></div>',
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
        "@media (min-width: 9999px) { .rail { display: block; } }",
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
        "@media (min-width: 1px) { @scope (.keyframeRail) { @keyframes unused { to { display: flex; } } } }",
        "@media (min-width: 1px) { @scope (.anonymousRail) { :scope { display: flex; } } }",
        "@scope (.panel) { @media (min-width: 1px) { dialog:not([open]) { display: flex; outline-style: solid; } } }",
        ".filters { @media (min-width: 900px) { & { display: flex; } } }",
        "@scope (.card) { @scope (.inner) { @media (min-width: 1px) { :scope > .nestedRail { display: grid; outline-style: solid; } } } }",
        "@scope (.boundCard) { @scope (:scope.inner) { @media (min-width: 1px) { :scope > .nestedRail { display: grid; outline-style: solid; } } } }",
        "@scope (.scopeParent) { .styleParent { @media (min-width: 1px) { & > .nestedRail { display: grid; outline-style: solid; } } } }",
      ].join("\n"),
    }),
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
  check("dev mode warns of a closed dialog or popover a rule inside a media query gives a display, and only those", railNames === "rail,inplace,nav,side,scopedPlain,scopedRoot,scopedAmp,scopedDeclarations,scopedContainer,listPlain,listExplicit,relativeChild,scopedPopover,doubleScope,dialog,closedInsidePanel,strictRoot,explicitInner,insideStyleParent,dialog,lastrail", railNames);
  const warned = new Set(railOnLoad.map((e) => e.split(" ")[1]));
  check("a plain scoped dialog rule does not warn outside its root", warned.has("scopedPlain") && !warned.has("outsidePlain"), railNames);
  check(":scope > dialog warns only inside its root", warned.has("scopedRoot") && !warned.has("outsideRoot"), railNames);
  const closedStateLooks = await drawn.locator("#closedInsidePanel, #closedOutsidePanel").evaluateAll((els) => els.map((el) => getComputedStyle(el).outlineStyle).join(","));
  check("dialog:not([open]) warns only inside its scope root", closedStateLooks === "solid,none" && railOnLoad.some((m) => m.startsWith("corten: closedInsidePanel ") && m.includes("`dialog:not([open])` in")) && !warned.has("closedOutsidePanel"), closedStateLooks);
  check("declarations directly in @scope warn on the root", railOnLoad.some((m) => m.startsWith("corten: scopedDeclarations ") && m.includes("`.scopedDeclarations` in")), railNames);
  const reproLooks = await drawn.evaluate(() => ["scopedPlain", "outsidePlain", "scopedRoot", "outsideRoot", "scopedDeclarations"].map((id) => getComputedStyle(/** @type {Element} */ (document.getElementById(id))).outlineStyle).join(","));
  check("native styles apply only to the three scope repros' positive controls", reproLooks === "solid,none,solid,none,solid", reproLooks);
  const nestedLooks = await drawn.locator("#sameRoot, #strictRoot, #explicitInner, #outsideStyleParent, #insideStyleParent").evaluateAll((els) => els.map((el) => getComputedStyle(el).outlineStyle).join(","));
  check("a plain inner root needs a strict ancestor, :scope can name it explicitly and a nested & uses the style parent", nestedLooks === "none,solid,solid,none,solid" &&
    !warned.has("sameRoot") && warned.has("strictRoot") && warned.has("explicitInner") && !warned.has("outsideStyleParent") && warned.has("insideStyleParent"), nestedLooks);
  check("keyframes under a scope do not warn on the root", !warned.has("keyframeRail") && await drawn.locator("#keyframeRail").evaluate((el) => getComputedStyle(el).display) === "none");
  check("a scoped warning does not suggest a selector that drops the scope", railOnLoad.some((m) => m.startsWith("corten: dialog is a closed dialog that `:scope`") && !m.includes("dialog:not(")));
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
  const attrFlag = await drawn.evaluate(() => CSS.supports("selector([data-state=READY s])")) ? '[data-state="READY" s]' : '[data-state="ready" i]';
  await drawn.close();

  const dialogSheet = '<link rel="stylesheet" href="/dialog-fixture.css">';
  /** @param {import("@playwright/test").Page} page @param {string} markup @param {string} css */
  async function dialogFixture(page, markup, css) {
    await page.route(base + "/", async (route) => {
      if (route.request().headers().corten) return route.continue();
      const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "gzip" } });
      const html = (await res.text()).replace("</body>", `${markup}</body>`);
      await route.fulfill({ response: res, body: markup.includes(dialogSheet) ? html : html.replace("</head>", `${dialogSheet}</head>`) });
    });
    await page.route(base + "/dialog-fixture.css", (route) => route.fulfill({ contentType: "text/css", body: css }));
  }
  /**
   * The expected IDs are the warnings from main, also replayed from the Git blob when supplied.
   * Compare full messages in that mode to check the legacy suggestion as well as warn/no warn.
   * @param {string} name @param {string} markup @param {string} css @param {string} expected
   * @param {{wide?: string, outline?: string, pseudo?: string, reject?: "leaf" | "root"}} [options]
   */
  async function dialogParity(name, markup, css, expected, options = {}) {
    /** @param {Buffer} [source] */
    async function run(source) {
      const page = await browser.newPage({ viewport: { width: 600, height: 800 } });
      try {
        /** @type {string[]} */
        const messages = [];
        page.on("console", (m) => m.type() === "warning" && /^corten: (case\w*|dialog) is a closed/.test(m.text()) && messages.push(m.text()));
        if (source) await page.route(base + "/corten/dev.js", (route) => route.fulfill({ contentType: "text/javascript", body: source }));
        if (options.reject) await page.addInitScript((reject) => {
          const matches = Element.prototype.matches;
          Element.prototype.matches = function (selector) {
            if (reject === "leaf" && selector.startsWith(":is(") && selector.endsWith(".rejectedLeaf")) throw new DOMException("fixture rejects the composed child", "SyntaxError");
            return matches.call(this, selector);
          };
          const supports = CSS.supports;
          CSS.supports = function (property, value) {
            if (reject === "root" && property.startsWith("selector(:is(:is(") && property.endsWith(".rejectedRoot))")) return false;
            return value === undefined ? supports(property) : supports(property, value);
          };
        }, options.reject);
        await dialogFixture(page, markup + '<dialog id="fixtureEnd"></dialog>', css + '@media (min-width: 1px) { #fixtureEnd { display: flex } }');
        const done = page.waitForEvent("console", { predicate: (m) => m.text().startsWith("corten: fixtureEnd "), timeout: 10000 }).then(() => true, () => false);
        await page.goto(base + "/");
        const completed = await done;
        const cases = page.locator('[id^="case"]');
        const outline = options.outline === undefined ? "" : await cases.evaluateAll((els) => els.map((el) => getComputedStyle(el).outlineStyle).join(","));
        const hidden = options.wide === undefined || await cases.evaluateAll((els) => els.every((el) => !(el instanceof HTMLDialogElement) || getComputedStyle(el).display === "none"));
        if (options.wide !== undefined) await page.setViewportSize({ width: 1000, height: 800 });
        const wide = options.wide === undefined ? "" : await cases.evaluateAll((els, pseudo) => els.map((el) => getComputedStyle(el, pseudo ?? null).display).join(","), options.pseudo);
        return { completed, messages, outline, hidden, wide, ids: messages.map((m) => m.split(" ")[1]).join(",") };
      } finally {
        await page.close();
      }
    }
    const head = await run();
    const main = baseline ? await run(baseline) : null;
    check(name, head.completed && head.hidden && head.ids === expected && head.wide === (options.wide ?? "") && head.outline === (options.outline ?? "") &&
      (!main || main.completed && main.hidden && main.messages.join("\n") === head.messages.join("\n") && main.wide === head.wide && main.outline === head.outline),
    `head: ${head.ids || "no warnings"}; main: ${(main?.ids ?? expected) || "no warnings"}${head.wide ? `; wide: ${head.wide}` : ""}${head.outline ? `; outline: ${head.outline}` : ""}`);
  }
  const rails = "@media (min-width: 900px) { .rail { display: flex } }";
  const cardBody = '<div class="card"><div class="card-body"><dialog class="rail" id="caseInside"></dialog></div><dialog class="rail" id="caseOutside"></dialog></div>';
  const wideRule = (/** @type {string} */ selector) => `@media (min-width: 900px) { ${selector} { display: grid !important; content: "" } }`;
  await dialogParity("limited scope preserves main's warnings for a plain rule on both sides of the limit",
    '<div class="limitOuter"><div class="limitStop"><dialog class="cut" id="caseCut"></dialog></div><dialog class="cut" id="caseKept"></dialog></div>',
    "@scope (.limitOuter) to (.limitStop) { @media (min-width: 1px) { .cut { display: flex; outline-style: solid } .cut { display: grid } } }",
    "caseCut,caseKept", { outline: "none,solid" });
  await dialogParity("round 9: a limited plain override uses main's result on both rails",
    '<div class="overridePanel"><dialog class="rail" id="caseInside"></dialog></div><dialog class="rail" id="caseOutside"></dialog>',
    rails + "@scope (.overridePanel) to (.stop) {" + wideRule(".rail") + "}", "", { wide: "grid,none" });
  await dialogParity("round 9: nested & keeps main's suggestion for the idless dialog", '<dialog class="filters"></dialog>',
    ".filters { @media (min-width: 900px) { & { display: flex } } }", "dialog");
  const outsideRail = '<dialog class="rail" id="caseOutside"></dialog>';
  const unrelatedCard = '<div class="card"><div class="card-body" id="caseBody"></div><div class="slot"></div></div>';
  await dialogParity("rounds 8 and 9: unrelated normal, none and important displays keep the outside warning", outsideRail + unrelatedCard,
    rails + "@scope (.card) to (.slot) { :scope > .card-body { display: grid } :scope dialog { display: none !important } :scope > .card-body { display: grid !important } }",
    "caseOutside", { wide: "none,grid" });
  await dialogParity("round 10: the limited card-body rule styles the body without silencing the outside warning", outsideRail + unrelatedCard,
    rails + "@scope (.card) to (.slot) { :scope > .card-body:not(.gone,.pending) { display: grid !important; outline-style: solid } }",
    "caseOutside", { outline: "none,solid" });
  for (const [name, suffix] of [
    ["a :not() list", ":not(.gone,.pending)"],
    [":has()", ":has(> .flag)"],
    ["a complex :is() argument", ":is(.card > .card-body)"],
    [`an attribute flag (${attrFlag})`, attrFlag],
    ["a pseudo-element", "::before"],
  ]) {
    await dialogParity(`round 10: limited scope with ${name} uses main's result on both rails`,
      '<div class="card"><dialog id="caseInside" class="rail card-body" data-state="READY"><span class="flag"></span></dialog><div class="slot"></div></div>' + outsideRail,
      rails + "@scope (.card) to (.slot) {" + wideRule(":scope > .card-body" + suffix) + "}",
      "caseInside,caseOutside", suffix === "::before" ? { wide: "grid,inline", pseudo: suffix } : { wide: "grid,none" });
  }
  await dialogParity("round 11: an unsupported standalone inner root uses main's result for same and distinct roots",
    '<div class="card inner"><i></i><dialog class="rail" id="caseSame"></dialog></div><div class="card"><div class="inner"><i></i><dialog class="rail" id="caseDistinct"></dialog></div></div>',
    rails + "@scope (.card) { @scope (.inner:has(i)) {" + wideRule(":scope > .rail:not(.gone,.pending)") + "} }",
    "caseSame,caseDistinct", { wide: "none,grid" });
  await dialogParity("round 11: unsupported nesting in a scoped style uses main's style parent",
    cardBody, rails + "@scope (.card) { .card-body {" + wideRule(".rail:not(.gone,.pending)") + "} }", "caseOutside", { wide: "grid,none" });
  await dialogParity("round 11: a scope nested in a style uses main's style parent",
    cardBody + outsideRail.replace("caseOutside", "caseBeyond"), rails + ".card { @scope (.card-body) {" + wideRule(".rail") + "} }", "caseBeyond", { wide: "grid,none,none" });
  const longClass = "x".repeat(1024);
  await dialogParity("round 11: an unrelated over-length unscoped override cannot veto main's warning",
    outsideRail, rails + wideRule("." + longClass), "caseOutside", { wide: "none" });
  await dialogParity("round 11: a matching over-length unscoped rule still warns as on main",
    `<dialog class="${longClass}" id="caseLong"></dialog>`, rails.replace(".rail", "." + longClass), "caseLong");
  await dialogParity("implicit inner scopes use main's result even where WebKit applies the rule",
    `<section>${dialogSheet}<div class="implicitOuter"><dialog id="caseImplicit"></dialog></div></section>`,
    "@scope (.implicitOuter) { @scope { @media (min-width: 1px) { :scope .implicitOuter > #caseImplicit { display: flex; outline-style: solid } } } }",
    "", { outline: engine === "webkit" ? "solid" : "none" });
  await dialogParity("multiple scope references and top-level :scope roots use main's result",
    '<div class="identity"><dialog id="caseDifferent" class="identity"></dialog></div><dialog id="caseExplicit" class="explicitScopeRoot"></dialog>',
    "@scope (.identity) { @media (min-width: 1px) { :scope > :scope { display: flex } } } @scope (:scope) { @media (min-width: 1px) { .explicitScopeRoot { display: flex; outline-style: solid } } }",
    "caseExplicit", { outline: "none,solid" });
  await dialogParity("scopes in a stylesheet with a default namespace use main's result",
    '<div class="card"><dialog class="rail" id="caseInside"></dialog></div>' + outsideRail,
    '@namespace "http://www.w3.org/1999/xhtml"; @scope (.card) { @media (min-width: 1px) { dialog.rail { display: flex; outline-style: solid } } }',
    "caseInside,caseOutside", { outline: "solid,none" });
  // Count work, not elapsed time: rule reads, fixture matches, and queries (including their results).
  // Time from the start of the closed-element check to its last fixture match.
  /** @param {string} markup @param {string} css @param {number} count @param {boolean} [patch] @param {string} [last] */
  async function dialogWork(markup, css, count, patch = false, last = `work${count - 1}`) {
    const many = await browser.newPage();
    /** @type {string[]} */
    const warned = [];
    many.on("console", (m) => {
      if (m.type() === "warning" && m.text().startsWith("corten: work")) warned.push(m.text().split(" ")[1] ?? "");
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
        if (!counter.first && selector.startsWith("dialog:not([open],[popover])")) counter.first = performance.now();
        const result = matches.call(this, selector);
        if (selector.includes(".work") || this.classList.contains("workScope") && selector.includes(":scope")) {
          counter.last = performance.now();
          counter.matches++;
        }
        return result;
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
    await dialogFixture(many, markup, css);
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
    const { reads, matches, queries, results, first, last: end, looks, drawn } = await many.evaluate((count) => ({
      ...(/** @type {{reads: number, matches: number, queries: number, results: number, first: number, last: number}} */ (/** @type {any} */ (window)).dialogWork),
      looks: Array.from({ length: count }, (_, i) => document.getElementById(`work${i}`)).every((el) => el !== null && getComputedStyle(el).outlineStyle === "solid"),
      drawn: getComputedStyle(/** @type {Element} */ (document.getElementById("work0"))).outlineStyle === "solid",
    }), count);
    await many.close();
    const span = first && end >= first ? end - first : Infinity;
    return { reads, matches, queries, completed, warned, drawn, span, ok: completed && warned.length === count && looks, detail: `${warned.length} warnings, native styles ${looks}, ${reads} rule reads, ${matches} matches, ${queries} queries, ${results} results, ${span.toFixed(1)} ms` };
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
  check("an unsupported normal display and display: none !important do not silence a warning", nonOverrides.completed && nonOverrides.drawn && nonOverrides.warned.join(",") === "work0,workEnd", nonOverrides.detail);
  const noise = Array.from({ length: 80 }, (_, i) => `.workNoise${i} { display: flex; }`).join("");
  const rail = ".workDialog.rail { display: flex; outline-style: solid; }";
  for (const rules of [noise + rail, rail + noise]) {
    const result = await dialogWork('<section class="workScope"><dialog class="workDialog rail" id="work0"></dialog></section>', `@scope (.workScope) to (.stop) { @media (min-width: 1px) { ${noise} } } @scope (.workScope) { @media (min-width: 1px) { ${rules} } }`, 1);
    check(`unrelated rules cannot starve a supported rail (${rules === noise + rail ? "last" : "first"})`, result.ok && result.matches === 161, result.detail);
  }
  // The marker ends the measured span after either matching path.
  const depth = 320;
  const deepMarkup = '<div hidden>' + scopeRoot.repeat(depth) + dialog(0) + '</div>'.repeat(depth + 1) + endDialog;
  const deep = await dialogWork(deepMarkup, `@scope (.workScope) { @scope (.workScope) { ${scopedRule} } } ${markerRule}`, 1, false, "workEnd");
  check("overlapping roots at depth 320 use one match per rule and dialog", deep.completed && deep.drawn && deep.warned.includes("work0") && deep.matches === 4 && deep.span < 1000, deep.detail);
  const limit = await dialogWork(deepMarkup, `@scope (.workScope) to (:scope > .workScope) { ${scopedRule} } ${markerRule}`, 1, false, "workEnd");
  check("a direct-child limit at depth 320 uses main's flat match", limit.completed && limit.drawn && limit.warned.includes("work0") && limit.matches === 4 && limit.span < 1000, limit.detail);
  const wide = await dialogWork('<div class="a">'.repeat(18) + dialog(0) + '</div>'.repeat(18) + endDialog, "@scope (.a, .b) {".repeat(18) + scopedRule + "}".repeat(18) + markerRule, 1, false, "workEnd");
  check("18 nested two-member scope roots use main's flat match past the composition cap", wide.completed && wide.drawn && wide.warned.includes("work0") && wide.matches === 4 && wide.span < 1000, wide.detail);
  const nestedMarkup = '<div class="outer"><div class="inner rejectedRoot"><i></i><dialog class="rail rejectedLeaf" id="caseInside"></dialog></div><dialog class="rail rejectedLeaf" id="caseOuter"></dialog></div><div class="inner rejectedRoot"><i></i><dialog class="rail rejectedLeaf" id="caseBeyond"></dialog></div>';
  const nestedScope = (/** @type {string} */ root, /** @type {string} */ child) => rails + `@scope (.outer) { @scope ${root} { ${wideRule(child)} } }`;
  await dialogParity("an over-length scoped override uses main's flat match for both rails",
    '<div class="a">'.repeat(18) + '<dialog class="rail" id="caseInside"></dialog>' + '</div>'.repeat(18) + outsideRail,
    rails + "@scope (.a, .b) {".repeat(18) + wideRule(".rail") + "}".repeat(18), "", { wide: "grid,none" });
  await dialogParity("an unsupported inner root with a limit uses main's result",
    nestedMarkup, nestedScope("(.inner:has(i)) to (.stop)", ":scope > .rail:not(.gone,.pending)"), "caseInside,caseOuter,caseBeyond", { wide: "grid,none,none" });
  const nestedDeclarations = await dialogWork(`<div class="workOuter">${dialog(0)}${dialog(1)}</div>${dialog(2)}${endDialog}`,
    scopedRule + "@scope (.workOuter) { .workDialog { @media (min-width: 9999px) { display: grid !important; } } }" + markerRule, 3, false, "workEnd");
  check("composed declarations in a scoped style rule only override the inside rails", nestedDeclarations.completed && nestedDeclarations.drawn && nestedDeclarations.warned.join(",") === "work2,workEnd", nestedDeclarations.detail);
  for (const reject of /** @type {const} */ (["leaf", "root"])) {
    await dialogParity(`a native selector parse failure at the ${reject} uses main's result`,
      nestedMarkup, nestedScope("(.inner.rejectedRoot)", ":scope > .rail.rejectedLeaf"), "caseInside,caseOuter,caseBeyond", { wide: "grid,none,none", reject });
  }
  await dialogParity("a limited scope with an unreadable child uses main's result",
    nestedMarkup, nestedScope("(.inner.rejectedRoot) to (.stop)", ":scope > .rail.rejectedLeaf"), "caseInside,caseOuter,caseBeyond", { wide: "grid,none,none", reject: "leaf" });
  await dialogParity("an unsupported top-level :scope override uses main's result",
    outsideRail, rails + `@scope (:scope) { ${wideRule(":scope .rail:not(.gone,.pending)")} }`, "caseOutside");
  const repeated = await dialogWork(scopeRoot + dialog(0) + "</div>" + endDialog, ".workScope { " + "&:is(&) { ".repeat(16) + scopedRule.replace(".workDialog", "& .workDialog") + "}".repeat(17) + markerRule, 1, false, "workEnd");
  check("ordinary nesting keeps main's match even past the scoped selector cap", repeated.completed && repeated.drawn && repeated.warned.join(",") === "work0,workEnd" && repeated.matches === 4, repeated.detail);
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
