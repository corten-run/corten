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
  check("dev mode warns of a closed dialog or popover a rule inside a media query gives a display, and only those", railNames === "rail,inplace,nav,side,scopedPlain,scopedRoot,scopedAmp,scopedDeclarations,scopedContainer,sameRoot,listPlain,listExplicit,literalAttribute,literalEscape,relativeScope,relativeAmp,relativeList,relativeOther,scopedPopover,nestedScope,doubleScope,lastrail", railNames);
  const warned = new Set(railOnLoad.map((e) => e.split(" ")[1]));
  check("plain scoped selectors stay descendants, independently in each selector-list member", !warned.has("scopedSelf") && !warned.has("outsideAncestor") && !warned.has("listSelf") && warned.has("listPlain") && warned.has("listExplicit"));
  check("every :scope in a selector binds the same root", warned.has("sameRoot") && !warned.has("differentRoots"));
  check("selector strings and escaped identifiers are not scope tokens", warned.has("literalAttribute") && warned.has("literalEscape") && !warned.has("literalImpostor") && !warned.has("literalSelf"));
  check("leading combinators keep their scope anchor and other selector-list members", ["relativeScope", "relativeAmp", "relativeList", "relativeOther"].every((id) => warned.has(id)) && !warned.has("outsideRelativeScope"));
  const relativeLooks = await drawn.evaluate(() => ["relativeScope", "relativeAmp", "relativeList", "relativeOther", "outsideRelativeScope"].map((id) => getComputedStyle(/** @type {Element} */ (document.getElementById(id))).outlineStyle).join(","));
  check("the browser applies the relative scoped selectors to the same controls", relativeLooks === "solid,solid,solid,solid,none", relativeLooks);
  const scopedLooks = await drawn.evaluate(() => ["sameRoot", "differentRoots", "listSelf", "listPlain", "listExplicit", "literalAttribute", "literalEscape", "literalImpostor", "literalSelf"].map((id) => getComputedStyle(/** @type {Element} */ (document.getElementById(id))).outlineStyle).join(","));
  check("the browser applies the scoped regression rules only to the positive controls", scopedLooks === "solid,none,none,solid,solid,solid,solid,none,none", scopedLooks);
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
  // Count queries, not elapsed time: each scoped rule/root is queried once, not once per dialog.
  const many = await browser.newPage();
  const count = 1600;
  let manyWarnings = 0;
  many.on("console", (m) => { if (m.type() === "warning" && m.text().startsWith("corten: many")) manyWarnings++; });
  await many.addInitScript(() => {
    const query = Element.prototype.querySelectorAll;
    (/** @type {any} */ (window)).__scopeQueries = 0;
    Element.prototype.querySelectorAll = function (selector) {
      if (this.classList.contains("manyScope")) (/** @type {any} */ (window)).__scopeQueries++;
      return query.call(this, selector);
    };
  });
  await many.route(base + "/", async (route) => {
    if (route.request().headers().corten) return route.continue();
    const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "gzip" } });
    const roots = Array.from({ length: count }, (_, i) => `<div class="manyScope"><dialog id="many${i}"></dialog></div>`).join("");
    await route.fulfill({ response: res, body: (await res.text()).replace("</head>", '<link rel="stylesheet" href="/many-scopes.css"></head>').replace("</body>", `${roots}</body>`) });
  });
  await many.route(base + "/many-scopes.css", (route) => route.fulfill({ contentType: "text/css", body: "@scope (.manyScope) { @media (min-width: 1px) { dialog { display: flex; } } }" }));
  const manyDone = many.waitForEvent("console", { predicate: (m) => m.text().startsWith(`corten: many${count - 1} `), timeout: 30000 });
  await many.goto(base + "/");
  await manyDone;
  const queries = await many.evaluate(() => (/** @type {any} */ (window)).__scopeQueries);
  check("each scoped display rule queries its root once, independently of dialog count", manyWarnings === count && queries === count, `${manyWarnings} warnings, ${queries} queries for ${count} roots`);
  await many.close();
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
