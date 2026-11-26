import { base, shadowing, skip, check, pollFor } from "./helpers.mjs";

export async function componentLifecycle(page, live, prices, feedSources, signsIn) {
  // Text a script computes, from the catalog: on:connect={js::watch(.., updates, t.js().prices_updates())},
  // a plural message whose form the browser picks by the count (1 price update, 2 price updates).
  const counted = await page.textContent(`${live} [data-ref="updates"]`);
  check(
    "a script fills in a plural message of the page's locale, in the count's form",
    /^(1 price update|([2-9]|[1-9][\d,]+) price updates)$/.test(counted ?? ""),
    String(counted),
  );

  // A handler with per-component state (keep()): on:click={js::pause(target, price, change)}.
  check("the script reveals its controls", await page.isVisible(`${live} button`));
  await page.click(`${live} button`);
  const paused = await prices();
  await page.waitForTimeout(2500);
  check(
    "a handler changes the component's state (pause holds the prices)",
    (await page.getAttribute(`${live} button`, "aria-pressed")) === "true" && JSON.stringify(await prices()) === JSON.stringify(paused),
  );
  await page.click(`${live} button`);
  // keep() is a handler's: called outside one it throws rather than pick a component.
  const outside = await page.evaluate(async () => {
    const corten = /** @type {{ keep: (init: () => unknown) => unknown }} */ (await import(/** @type {string} */ ("corten")));
    try {
      corten.keep(() => ({}));
      return "no error";
    } catch (error) {
      return String(error);
    }
  });
  check("keep() outside a handler throws", outside.includes("keep() outside a handler"), outside);
  // keep() is each instance's, and a parent's handler on a child's element (written
  // `/live-prices`, as the server writes it) keeps its own component's: two copies of the
  // component's markup, pressed in turn. One state for all would give true,false,true; a handler
  // keyed on the child's root, true,true,true.
  const states = await page.evaluate(() => {
    const host = document.createElement("div");
    host.hidden = true;
    const on = "click:live_prices.pause($t,#price,#change)";
    host.innerHTML = __html(`<div data-scope="live-prices"><button data-on="${on}"></button></div><div data-scope="live-prices"><div data-scope="child"><button data-on="${on}/live-prices"></button></div><button data-on="${on}"></button></div>`);
    document.body.append(host);
    const buttons = Array.from(host.querySelectorAll("button"));
    for (const button of buttons) button.click();
    host.remove();
    return buttons.map((b) => b.getAttribute("aria-pressed")).join(",");
  });
  check("keep() is each instance's, and a parent's handler in a child keeps the parent's", states === "true,true,false", states);
  // The page's prices by stock id, written by the script with the page's money format
  // (t.js().money(USD)), and the feed's, which the server wrote.
  // Today's change too: its trend, and its text.
  const shown = () =>
    page.$$eval('[data-ref="price"]', (cells) =>
      JSON.stringify(
        cells
          .map((c) => {
            const id = c.getAttribute("data-key");
            const change = document.querySelector(`[data-ref="change"][data-key="${id}"]`);
            return [id, c.textContent, change?.getAttribute("data-trend")];
          })
          .sort(),
      ),
    );
  // The feed has the whole market; the page, the stocks on the list.
  const latest = async () => {
    const ids = await page.$$eval('[data-ref="price"]', (cells) => cells.map((c) => c.getAttribute("data-key")));
    const snap = await (await fetch(`${base}/feed/stocks`, { headers: { accept: "application/json" } })).json();
    /** @param {number} bp */
    const trend = (bp) => (bp > 0 ? "up" : bp < 0 ? "down" : "flat");
    return JSON.stringify(
      snap.rows
        .filter((/** @type {{ id: string }} */ r) => ids.includes(r.id))
        .map((/** @type {{ id: string, price: string, change_bp: number }} */ r) => [r.id, r.price, trend(r.change_bp)])
        .sort(),
    );
  };
  let resumed = false;
  for (let i = 0; i < 20 && !resumed; i += 1) {
    resumed = (await shown()) === (await latest());
    if (!resumed) await page.waitForTimeout(150);
  }
  check("resuming shows the latest prices and changes", resumed && (await page.getAttribute(`${live} button`, "aria-pressed")) === "false", `${await shown()} vs ${await latest()}`);
  // on:document:keydown={js::pauseKey(..)}: a component's handler for a key pressed anywhere on
  // the page, while the component is on it. "p" pauses whatever has focus, and again resumes.
  await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
  await page.keyboard.press("p");
  const pressedByKey = await page.getAttribute(`${live} button`, "aria-pressed");
  await page.keyboard.press("p");
  check(
    "a key pressed anywhere on the page runs a component's handler for it, once",
    pressedByKey === "true" && (await page.getAttribute(`${live} button`, "aria-pressed")) === "false",
    String(pressedByKey),
  );
  // An element with a page-wide handler stops getting events when it leaves the page. The key is
  // not cancelable, so the page's own button pausing first (preventDefault) does not hide it.
  const leaves = await page.evaluate(async () => {
    const host = document.createElement("div");
    host.hidden = true;
    host.innerHTML = __html('<div data-scope="live-prices"><button data-on="document.keydown:live_prices.pauseKey($e,$t,#price,#change)"></button></div>');
    document.body.append(host);
    await new Promise((resolve) => setTimeout(resolve));
    const button = /** @type {HTMLButtonElement} */ (host.querySelector("button"));
    const press = () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "p", bubbles: true, cancelable: false }));
    press();
    const on = button.getAttribute("aria-pressed");
    host.remove();
    await new Promise((resolve) => setTimeout(resolve));
    press();
    // The page's own button hears both presses, so it is back where it was.
    return `${on},${button.getAttribute("aria-pressed")}`;
  });
  check("a page-wide handler does not run once its element has left the page", leaves === "true,true", leaves);
  // shortcut(event) from corten/keys: pauseKey takes "p" only when the key is the page's. Pressed
  // for real: a ticked checkbox takes no letters, so "p" pauses from it; a text field and a modal
  // dialog keep it.
  const pressed = () => page.getAttribute(`${live} button`, "aria-pressed");
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "shortcut-host";
    host.innerHTML = __html(
      '<input type="checkbox" id="shortcut-box"><input id="shortcut-text"><dialog id="shortcut-dialog"><button type="button" id="shortcut-in">In</button></dialog>',
    );
    document.body.append(host);
  });
  await page.focus("#shortcut-box");
  await page.keyboard.press("p");
  const fromBox = await pressed();
  await page.keyboard.press("p");
  check("a shortcut's key pressed on a checkbox is the page's", fromBox === "true" && (await pressed()) === "false", String(fromBox));
  await page.focus("#shortcut-text");
  await page.keyboard.press("p");
  const typed = await page.inputValue("#shortcut-text");
  await page.evaluate(() => /** @type {HTMLDialogElement} */ (document.getElementById("shortcut-dialog")).showModal());
  await page.focus("#shortcut-in");
  await page.keyboard.press("p");
  const inDialog = await pressed();
  // A patch removes the focused button: focus falls to <body>, and the modal still holds the page.
  await page.evaluate(() => document.getElementById("shortcut-in")?.remove());
  await page.keyboard.press("p");
  const behindModal = await pressed();
  await page.evaluate(() => /** @type {HTMLDialogElement} */ (document.getElementById("shortcut-dialog")).close());
  // Fullscreen is :modal too, and is not a dialog: the page's shortcuts still work in it.
  await page.evaluate(() => {
    const go = document.createElement("button");
    go.id = "shortcut-full";
    go.textContent = "Full";
    go.addEventListener("click", () => document.documentElement.requestFullscreen().catch(() => {}));
    document.getElementById("shortcut-host")?.append(go);
  });
  await page.click("#shortcut-full");
  await page.waitForFunction(() => document.fullscreenElement !== null, null, { timeout: 2000 }).catch(() => {});
  if (await page.evaluate(() => document.fullscreenElement === null)) skip("a shortcut works in fullscreen", "the browser did not go fullscreen");
  else {
    await page.evaluate(() => /** @type {HTMLElement | null} */ (document.activeElement)?.blur());
    await page.keyboard.press("p");
    const full = await pressed();
    await page.keyboard.press("p");
    await page.evaluate(() => document.exitFullscreen());
    check("a shortcut works in fullscreen", full === "true" && (await pressed()) === "false", String(full));
  }
  check(
    "a shortcut's key typed in a field, pressed in a modal dialog or with focus fallen to <body> behind one is not the page's",
    typed === "p" && inDialog === "false" && behindModal === "false",
    `${typed} ${inDialog} ${behindModal}`,
  );
  // Each rule, with the key it gives, from events dispatched where the rule applies.
  const shortcuts = await page.evaluate(async () => {
    const { shortcut } = await import("corten/keys");
    const host = /** @type {HTMLElement} */ (document.getElementById("shortcut-host"));
    host.insertAdjacentHTML(
      "beforeend",
      __html(`<div id="sk-scope"><button id="sk-button">B</button><input type="checkbox" id="sk-check"><input type="radio" id="sk-radio"><input type="range" id="sk-range"><span role="switch" tabindex="0" id="sk-switch">S</span><ul role="listbox"><li role="option" id="sk-option">O</li></ul><div role="tablist"><span role="tab" tabindex="0" id="sk-tab">T</span></div><div role="radiogroup"><span role="radio" tabindex="0" id="sk-aria-radio">R</span></div><div role="grid"><div role="row"><span role="gridcell" tabindex="0" id="sk-cell">C</span></div></div><span role="slider" tabindex="0" id="sk-slider">S</span><select id="sk-select"><option>a</option></select><span role="combobox" tabindex="0" id="sk-combo"></span><span role="searchbox" tabindex="0" id="sk-search"></span><span role="spinbutton" tabindex="0" id="sk-spin"></span><a href="#" id="sk-link">L</a><span role="link" tabindex="0" id="sk-aria-link">L</span><details><summary id="sk-summary">S</summary></details><div role="alertdialog" id="sk-alert"><button id="sk-in-alert">A</button></div><textarea id="sk-area"></textarea><div contenteditable id="sk-edit"></div><span role="textbox" id="sk-textbox"></span><div popover id="sk-pop"><button id="sk-in-pop">P</button></div><div role="dialog" id="sk-aria-dialog"><button id="sk-in-aria">D</button></div><dialog id="sk-dialog"><div id="sk-dialog-scope"><button id="sk-in-dialog">D</button></div></dialog></div><button id="sk-outside">Out</button><span id="sk-shadow"></span>`),
    );
    const shadow = /** @type {HTMLElement} */ (document.getElementById("sk-shadow")).attachShadow({ mode: "open" });
    shadow.innerHTML = __html("<input>");
    const at = (/** @type {string} */ id) => /** @type {Element} */ (document.getElementById(id));
    /** @param {KeyboardEventInit & { prevent?: boolean }} init @param {Element} [on] @param {Element} [scope] */
    const of = ({ prevent, ...init }, on = document.body, scope) => {
      /** @type {string | null | undefined} */
      let got;
      if (prevent) on.addEventListener("keydown", (e) => e.preventDefault(), { once: true });
      document.addEventListener("keydown", (e) => (got = shortcut(e, scope)), { once: true });
      on.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, composed: true, ...init }));
      return `${init.key}=${got}`;
    };
    const k = { key: "k" };
    const rows = [
      of({ key: "P", shiftKey: true }),
      of({ key: "K" }),
      of({ key: "s", ctrlKey: true, shiftKey: true }),
      of({ key: " " }),
      of({ key: " ", shiftKey: true }),
      of({ key: "+" }),
      of({ key: "?", shiftKey: true }),
      of({ key: "Enter" }),
      of({ ...k, prevent: true }),
      of({ ...k, isComposing: true }),
      of({ ...k, keyCode: 229 }),
      of({ key: "@", ctrlKey: true, altKey: true, modifierAltGraph: true }),
      of({ key: "s", metaKey: true }, at("shortcut-text")),
      of({ key: "s" }, at("shortcut-text")),
      of({ key: "ArrowLeft", ctrlKey: true }, at("shortcut-text")),
      of({ key: "Backspace", metaKey: true }, at("sk-area")),
      of(k, at("sk-edit")),
      of(k, at("sk-textbox")),
      of(k, /** @type {Element} */ (shadow.querySelector("input"))),
      of(k, at("sk-select")),
      of(k, at("sk-combo")),
      of(k, at("sk-search")),
      of(k, at("sk-spin")),
      of(k, at("sk-range")),
      of({ key: " " }, at("sk-button")),
      of({ key: "Enter" }, at("sk-check")),
      of({ key: " " }, at("sk-switch")),
      of({ key: "Enter" }, at("sk-link")),
      of({ key: "Enter" }, at("sk-aria-link")),
      of({ key: " " }, at("sk-summary")),
      of({ key: " " }, at("sk-tab")),
      of(k, at("sk-button")),
      of({ key: "ArrowLeft" }, at("sk-radio")),
      of({ key: "End" }, at("sk-range")),
      of({ key: "PageUp" }, at("sk-slider")),
      of({ key: "ArrowLeft" }, at("sk-check")),
      of(k, at("sk-option")),
      of({ ...k, ctrlKey: true }, at("sk-option")),
      of({ key: "ArrowDown" }, at("sk-option")),
      of(k, at("sk-tab")),
      of({ key: "ArrowRight" }, at("sk-tab")),
      of(k, at("sk-aria-radio")),
      of({ key: "ArrowDown" }, at("sk-aria-radio")),
      of(k, at("sk-cell")),
      of({ key: "Home" }, at("sk-cell")),
      of(k, at("sk-in-pop")),
      of(k, at("sk-in-aria")),
      of(k, at("sk-in-alert")),
      of(k, at("sk-in-dialog")),
      of(k, at("sk-in-dialog"), at("sk-dialog-scope")),
      of(k, at("sk-outside"), at("sk-scope")),
      of(k, at("sk-button"), at("sk-scope")),
      of(k, document.body, at("sk-scope")),
    ];
    /** @type {HTMLDialogElement} */ (at("sk-dialog")).showModal();
    rows.push(of(k), of(k, document.body, at("sk-dialog-scope")));
    /** @type {HTMLDialogElement} */ (at("sk-dialog")).close();
    // WebKit 27.2 reports its own style on the <select> later; removed first, the report would
    // name the document rather than the select it filters on (scripts/browser-bugs.mjs).
    await new Promise((resolve) => setTimeout(resolve, 100));
    host.remove();
    return rows.join(" ");
  });
  const expected = [
    "P=Shift+P K=k s=Control+Shift+S  =Space  =Shift+Space +=Plus ?=? Enter=Enter k=null k=null k=null @=null",
    "s=Meta+s s=null ArrowLeft=null Backspace=null k=null k=null k=null k=null k=null k=null k=null k=k",
    " =null Enter=null  =null Enter=null Enter=null  =null  =null k=k",
    "ArrowLeft=null End=null PageUp=null ArrowLeft=ArrowLeft",
    "k=null k=Control+k ArrowDown=null k=k ArrowRight=null k=k ArrowDown=null k=k Home=null",
    "k=null k=null k=null k=null k=k k=null k=k k=k k=null k=k",
  ].join(" ");
  check("shortcut() gives each key with its modifiers, and null for each key something else has", shortcuts === expected, shortcuts);
  const formShortcut = await page.evaluate(async (names) => {
    const { shortcut } = await import("corten/keys");
    const form = document.createElement("form");
    form.innerHTML = __html(names.map((name) => `<input type="hidden" name="${name}">`).join(""));
    form.tabIndex = -1;
    document.body.append(form);
    let got;
    document.addEventListener("keydown", (event) => (got = shortcut(event)), { once: true });
    EventTarget.prototype.dispatchEvent.call(form, new KeyboardEvent("keydown", { key: "k", bubbles: true }));
    Element.prototype.remove.call(form);
    return got === "k";
  }, [...shadowing, "isContentEditable"]);
  check("shortcut() reads a focused form past controls named matches, closest and isContentEditable", formShortcut);
  // A change's text is the move in money since the open, signed (t.js().signed_money(USD), as the
  // server's t.signed_money), then a percent whose sign is its trend's.
  const changes = await page.$$eval('[data-ref="change"]', (cells) => cells.map((c) => [c.textContent ?? "", c.getAttribute("data-trend")]));
  check(
    "today's move in money is signed: a plus sign up, a minus down, none when flat",
    changes.length > 0 &&
      changes.every(([text, trend]) => {
        const moved = text.split(" ")[0];
        // The percent is rounded to basis points, so a cent's move may still be flat there.
        const zero = !/[1-9]/.test(moved);
        return /^[-+]?\$\d+\.\d{2}$/.test(moved) && (zero ? trend === "flat" && /^\$/.test(moved) : moved.startsWith("+") ? trend !== "down" : moved.startsWith("-") && trend !== "up");
      }),
    JSON.stringify(changes),
  );
  check(
    "today's change is a percent with its trend",
    changes.length > 0 &&
      changes.every(([text, trend]) => {
        // The trend follows the percent (the last word), not the money before it: a cent's move
        // can round to 0.00% and be flat. The percent has a sign exactly when it is not zero
        // (signDisplay "exceptZero"): a plus up, a minus down.
        const percent = text.split(" ").at(-1) ?? "";
        const sign = percent[0] === "+" ? "up" : /^[-\u2212]/.test(percent) ? "down" : "flat";
        return /%$/.test(percent) && (sign === "flat") === !/[1-9]/.test(percent) && trend === sign;
      }),
    JSON.stringify(changes),
  );

  // Many rows joining at once are scanned for ref names one query per name: a name that only the
  // last of them has still refreshes the refs the component has cached (pause just resolved them).
  await page.click(`${live} button`);
  await page.evaluate((live) => {
    const body = /** @type {HTMLTableSectionElement} */ (document.querySelector(`${live} tbody`));
    const old = /** @type {HTMLElement} */ (body.querySelector('[data-ref="price"][data-key="ACME"]'));
    old.removeAttribute("data-ref");
    old.id = "old-s1";
    const rows = document.createDocumentFragment();
    for (let i = 0; i < 20; i += 1) {
      const tr = document.createElement("tr");
      tr.className = "wide";
      tr.innerHTML = __html(i < 19 ? '<td data-ref="note">n</td>' : '<td data-ref="price" data-key="ACME" id="new-s1">-</td>');
      rows.append(tr);
    }
    body.append(rows);
  }, live);
  await page.click(`${live} button`);
  const repainted = await page.textContent("#new-s1");
  check("a ref name only the last row of a 20-row insert has is found", repainted !== "-", String(repainted));
  await page.evaluate(() => {
    for (const tr of Array.from(document.querySelectorAll("tr.wide"))) tr.remove();
    const old = /** @type {HTMLElement} */ (document.getElementById("old-s1"));
    old.setAttribute("data-ref", "price");
    old.removeAttribute("id");
  });

  // A marker on window survives client navigations and patches, and disappears on a full load.
  await page.evaluate(() => ((/** @type {any} */ (window)).__marker = 1));
  const sourcesBefore = await feedSources();
  await page.selectOption("select[name=id]", "HLTH");
  // Pressed in the page: the live prices move <main> under a loaded Firefox's click (#2014).
  await page.evaluate(() => /** @type {HTMLButtonElement} */ (document.querySelector("#watch-form button")).click());
  await page.waitForFunction(() => document.getElementById("watch-message")?.textContent?.startsWith("Watching Halcyon Health"));
  check("form patch replaces the message by id", true);
  check("watching a stock adds its row, and the form no longer offers it", (await page.$('[data-ref="price"][data-key="HLTH"]')) !== null && (await page.$('select[name=id] option[value="HLTH"]')) === null);
  await page.waitForSelector(`${live}[data-status="live"]`, { timeout: 5000 }).catch(() => {});
  const sources = await feedSources();
  check(
    "the list a patch put in subscribes again, and the one it replaced closes its stream",
    sources.length === sourcesBefore.length + 1 && sources.at(-1) === true && sources.slice(0, -1).every((open) => !open),
    `${JSON.stringify(sourcesBefore)} -> ${JSON.stringify(sources)}`,
  );
  // The list is kept on the server, under the browser's cookie: the page read again shows it.
  if (signsIn) {
    const kept = await page.evaluate(async () => (await (await fetch("/")).text()).includes('data-ref="price" class="live-prices__amount" data-key="HLTH"'));
    check("the list is the same after a reload", kept);
  } else skip("the list is the same after a reload", "Playwright's WebKit never sends a Secure cookie back over http");
  check("form patch keeps the page", await page.evaluate(() => (/** @type {any} */ (window)).__marker === 1));
  // A row's Remove button submits the watch form to /unwatch.
  await page.evaluate(() => /** @type {HTMLButtonElement} */ (document.querySelector('button[formaction="/unwatch"][value="HLTH"]')).click());
  // Answered within 4 s, an answer after them failing the check.
  const unwatched = !!(await pollFor(4000, () => page.evaluate(() => document.getElementById("watch-message")?.textContent === "Stopped watching Halcyon Health.")));
  check(
    "unwatching a stock takes its row away and offers it again",
    unwatched && (await page.$('[data-ref="price"][data-key="HLTH"]')) === null && (await page.$('select[name=id] option[value="HLTH"]')) !== null,
    `${unwatched ? "" : "not answered within 4 s; "}${await page.textContent("#watch-message")}`,
  );
}
