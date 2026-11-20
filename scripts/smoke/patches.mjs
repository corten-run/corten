import { base, skip, check, watchBusy, busyEnded, precommits } from "./helpers.mjs";

export async function appendPatches(browser, swaps, noSwaps) {
  // Load more (view::Append): the answer adds only the new rows; the ones the page has stay. In a
  // page of its own, so it runs in every engine and leaves this page's history as it is.
  {
    const more = await browser.newPage();
    const moreNavs = [];
    more.on("request", (request) => request.headers()["corten"] === "nav" && moreNavs.push(request.url()));
    await more.goto(`${base}/news`);
    await more.waitForFunction(() => document.querySelectorAll("#stories > li").length === 3);
    await more.evaluate(() => ((/** @type {any} */ (document.querySelector("#stories > li"))).__kept = true));
    await more.click("#load-more button");
    await more.waitForFunction(() => document.querySelectorAll("#stories > li").length === 6);
    const grown = await more.evaluate(() => ({
      rows: Array.from(document.querySelectorAll("#stories h3"), (h) => h.textContent).join("|"),
      kept: (/** @type {any} */ (document.querySelector("#stories > li"))).__kept === true,
      search: location.search,
    }));
    check(
      "Load more appends the next rows in order",
      grown.rows ===
        "Acme Corp raises its full-year outlook|Globex wins approval for its northern pipeline|Initech moves its reporting software to subscriptions|Halcyon Health's flu vaccine enters its final trial|Pantry & Co recalls one batch of cereal over a labeling error|Vertigo Robotics signs a warehouse automation deal",
      grown.rows,
    );
    check("the rows the page had are the same elements", grown.kept);
    check("Load more is a patch, not a navigation", moreNavs.length === 0 && grown.search === "", `${moreNavs.length} nav(s), ${grown.search}`);
    await more.click("#load-more button");
    await more.waitForFunction(() => document.querySelectorAll("#stories > li").length === 9);
    check("the last page hides the button", await more.locator("#load-more button").isHidden());
    // A sector's box: the stories of that sector alone, three of the nine. (A navigation the
    // runtime intercepts stalls Playwright's WebKit, above.)
    if (swaps) {
      // The box is in a closed group of the rail; clicked from the page. The form that starts the
      // navigation is busy with main until the page is swapped in: when its mark goes, the
      // sector's stories are already shown.
      await watchBusy(more, "main form[data-keep-place]");
      await more.evaluate(() => /** @type {HTMLInputElement} */ (document.querySelector("main input[name=sector][value=energy]")).click());
      await more.waitForFunction(() => location.search === "?sector=energy" && !document.querySelector("main[aria-busy]"));
      const formBusy = await busyEnded(more);
      check("the GET form that starts a navigation is busy with main until its page is in", formBusy.with && formBusy.then?.stories === 3, JSON.stringify(formBusy));
      const energy = await more.$$eval("#stories > li", (items) => items.map((li) => li.querySelector("p:last-child a")?.textContent));
      check("a sector's box lists only its stories", energy.join() === "Energy,Energy,Energy" && (await more.locator("#load-more button").isHidden()), energy.join());
      // The same for a link: the header's, which the swap keeps.
      await watchBusy(more, 'header a[href="/"]');
      await more.click('header a[href="/"]');
      await more.waitForFunction(() => location.pathname === "/" && !document.querySelector("main[aria-busy]"));
      const linkBusy = await busyEnded(more);
      // The picks the page waits for are busy while their own read is on its way (#1400), which
      // the navigation did not mark.
      check(
        "the link that starts a navigation is busy with main until its page is in",
        linkBusy.with && linkBusy.then?.path === "/" && linkBusy.then.stories === 0 && !(await more.$("[aria-busy]:not(#picks)")),
        JSON.stringify(linkBusy),
      );
      // And a button outside its GET form (`form=`), in the header the swap keeps: it is busy
      // with main too, as the form is, and cleared when the page is in (#1063).
      await more.evaluate(() => {
        document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<form id="nav-busy" method="get" action="/news"></form>'));
        document.querySelector("header")?.insertAdjacentHTML("beforeend", __html('<button id="nav-busy-go" form="nav-busy">News</button>'));
      });
      await watchBusy(more, "#nav-busy-go");
      await more.click("#nav-busy-go");
      await more.waitForFunction(() => location.pathname === "/news" && !document.querySelector("main[aria-busy]"));
      const buttonBusy = await busyEnded(more);
      check("a button outside its GET form is busy with main until the page it started is in", buttonBusy.with && buttonBusy.then?.path === "/news", JSON.stringify(buttonBusy));
      await more.evaluate(() => document.getElementById("nav-busy-go")?.remove());
      await more.click('header a[href="/"]');
      await more.waitForFunction(() => location.pathname === "/" && !document.querySelector("main[aria-busy]"));
      // Where the browser lets a navigation say when its address changes (precommitHandler), a
      // slow page's address changes when its answer is in, as a full load's does, not at the click
      // while the old page is still on screen (#992). Read every frame: how long the old page was
      // shown busy at the old address, and how long the new address showed the old page (the body
      // read and the swap after the answer's headers).
      if (await more.evaluate(precommits)) {
        /** @param {URL} url */
        const news = (url) => url.pathname === "/news" && url.search === "";
        await more.route(news, async (route) => {
          if (route.request().headers().corten === "nav") await new Promise((resolve) => setTimeout(resolve, 800));
          await route.continue().catch(() => {});
        });
        await more.evaluate(() => {
          /** @type {[number, string, number, boolean][]} */
          const frames = [];
          /** @type {any} */ (window).__frames = frames;
          const read = (/** @type {number} */ at) => {
            const stories = document.querySelectorAll("#stories > li").length;
            frames.push([at, location.pathname, stories, !!document.querySelector("main[aria-busy]")]);
            if (frames.length < 5000 && !(location.pathname === "/news" && stories > 0)) requestAnimationFrame(read);
          };
          requestAnimationFrame(read);
        });
        await more.click('header a[href="/news"]');
        await more.waitForFunction(() => location.pathname === "/news" && document.querySelectorAll("#stories > li").length > 0 && !document.querySelector("main[aria-busy]"), null, { timeout: 5000 });
        /** @type {[number, string, number, boolean][]} */
        const frames = await more.evaluate(() => /** @type {any} */ (window).__frames);
        /** @param {(frame: [number, string, number, boolean]) => boolean} which */
        const span = (which) => {
          const times = frames.filter(which).map(([at]) => at);
          return times.length ? Math.round(times.at(-1) - times[0]) : 0;
        };
        const waited = span(([, path, , busy]) => path === "/" && busy);
        const ahead = span(([, path, stories]) => path === "/news" && stories === 0);
        check(
          "a slow page's address changes with its content, not before",
          waited >= 500 && ahead < 200,
          `busy at the old address ${waited} ms, the new address on the old page ${ahead} ms`,
        );
        await more.unroute(news);
      } else skip("a slow page's address changes with its content, not before", "no precommitHandler: the address changes at the click");
      // A GET form whose controls are named like the methods that mark it still navigates.
      await more.evaluate(() =>
        document
          .querySelector("main")
          ?.insertAdjacentHTML(
            "beforeend",
            __html('<form id="clobbered" method="get" action="/news"><input type="hidden" name="setAttribute" value="1"><input type="hidden" name="removeAttribute" value="1"><button>Go</button></form>'),
          ),
      );
      const clobberedErrors = [];
      const onError = (/** @type {Error} */ e) => clobberedErrors.push(e.message);
      more.on("pageerror", onError);
      await watchBusy(more, "#clobbered");
      await more.click("#clobbered button");
      const clobbered = await busyEnded(more);
      more.off("pageerror", onError);
      check(
        "a GET form with a control named setAttribute navigates and is not left busy",
        clobbered.with && clobbered.then?.path === "/news" && clobberedErrors.length === 0,
        JSON.stringify({ ...clobbered, errors: clobberedErrors }),
      );
      // A link whose prefetched answer is held is clicked, then another navigation replaces its
      // own: the link is not left busy waiting for the answer no one will use.
      let letPrefetch = () => {};
      const prefetchHeld = new Promise((resolve) => (letPrefetch = () => resolve(undefined)));
      /** @param {URL} url */
      const home = (url) => url.pathname === "/";
      await more.route(home, async (route) => {
        await prefetchHeld;
        await route.continue().catch(() => {});
      });
      const prefetching = more.waitForRequest((r) => new URL(r.url()).pathname === "/" && r.headers().corten === "nav");
      await more.hover('header a[href="/"]');
      await prefetching;
      await more.click('header a[href="/"]');
      await more.waitForSelector('header a[href="/"][aria-busy=true]');
      await more.evaluate(() => /** @type {HTMLInputElement} */ (document.querySelector("main input[name=sector][value=energy]")).click());
      await more.waitForFunction(() => location.search === "?sector=energy" && document.querySelectorAll("#stories > li").length === 3 && !document.querySelector("main[aria-busy]"));
      check("a link whose navigation another replaced is not left busy", !(await more.$('header a[href="/"][aria-busy]')));
      letPrefetch();
      await more.unroute(home);
    } else {
      skip("the GET form that starts a navigation is busy with main until its page is in", noSwaps);
      skip("a sector's box lists only its stories", noSwaps);
      skip("the link that starts a navigation is busy with main until its page is in", noSwaps);
      skip("a button outside its GET form is busy with main until the page it started is in", noSwaps);
      skip("a GET form with a control named setAttribute navigates and is not left busy", noSwaps);
      skip("a link whose navigation another replaced is not left busy", noSwaps);
    }
    await more.close();
  }
}

export async function retainedPatchState(page, browser, errors) {
  // A patch replaces markup but keeps what the user is doing: edited fields keep their state,
  // untouched ones take the server's, and focus and caret stay put (here a <corten-live> style
  // patch, with no form sent).
  await page.evaluate(() =>
    document.querySelector("main")?.insertAdjacentHTML(
      "beforeend",
      __html('<form id="kept"><input name="q" value="a"><input name="r" value="a"><input type="checkbox" name="c" value="1"><select name="s"><option value="1">1</option><option value="2">2</option></select><select name="t"><option value="1">1</option><option value="2">2</option></select><select name="m" multiple><option value="1">1</option><option value="2">2</option><option value="3">3</option></select><p><button type="button">Go</button></p></form>'),
    ),
  );
  await page.selectOption("#kept [name=m]", ["1", "3"]);
  await page.fill("#kept [name=q]", "typed");
  await page.check("#kept [name=c]");
  await page.selectOption("#kept [name=s]", "2");
  await page.focus("#kept [name=q]");
  await page.evaluate(() => /** @type {HTMLInputElement} */ (document.querySelector("#kept [name=q]")).setSelectionRange(1, 3));
  const fresh =
    '<form id="kept" class="new"><input name="q" value="b"><input name="r" value="b"><input type="checkbox" name="c" value="1"><select name="s"><option value="1">1</option><option value="2">2</option></select><select name="t"><option value="1">1</option><option value="2" selected>2</option></select><select name="m" multiple><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option></select><p><button type="button">Go</button></p></form>';
  const afterLive = await page.evaluate(async (html) => {
    const { patch } = await import("corten");
    await patch(__html(html));
    const q = /** @type {HTMLInputElement} */ (document.querySelector("#kept [name=q]"));
    return {
      server: document.querySelector("#kept")?.className,
      q: q.value,
      r: /** @type {HTMLInputElement} */ (document.querySelector("#kept [name=r]")).value,
      c: /** @type {HTMLInputElement} */ (document.querySelector("#kept [name=c]")).checked,
      s: /** @type {HTMLSelectElement} */ (document.querySelector("#kept [name=s]")).value,
      t: /** @type {HTMLSelectElement} */ (document.querySelector("#kept [name=t]")).value,
      m: Array.from(/** @type {HTMLSelectElement} */ (document.querySelector("#kept [name=m]")).selectedOptions, (o) => o.value).join(),
      focused: document.activeElement === q,
      selection: [q.selectionStart, q.selectionEnd],
    };
  }, fresh);
  check(
    "a patch keeps edited fields, focus and selection, and applies the rest",
    afterLive.server === "new" && afterLive.q === "typed" && afterLive.r === "b" && afterLive.c && afterLive.s === "2" && afterLive.t === "2" && afterLive.m === "1,3" && afterLive.focused && afterLive.selection.join() === "1,3",
    JSON.stringify(afterLive),
  );

  // What the user opened stays open across a patch (a modal dialog modal), and what the server
  // sent open and then closes closes.
  const block = (/** @type {number} */ n, /** @type {string} */ extra) =>
    `<section id="opened"><p>${n}</p><dialog id="opened-modal"><button type="button" id="opened-in">In</button></dialog><dialog id="opened-plain"></dialog><details id="opened-more"><summary>More</summary><p>Folded</p></details><div id="opened-pop" popover>Pop</div><dialog id="opened-served"${extra}></dialog></section>`;
  await page.evaluate((html) => document.querySelector("main")?.insertAdjacentHTML("beforeend", __html(html)), block(1, " open"));
  const openedState = await page.evaluate(async ([first, second]) => {
    const { patch } = await import("corten");
    const $ = (/** @type {string} */ id) => /** @type {any} */ (document.getElementById(id));
    // Markup a patch put in is what the server sent: open the served one, then the user's.
    await patch(__html(first));
    $("opened-modal").showModal();
    $("opened-plain").show();
    $("opened-more").open = true;
    $("opened-pop").showPopover();
    // Last: opening a dialog moves focus.
    $("opened-in").focus();
    await patch(__html(second));
    return {
      count: document.querySelector("#opened p")?.textContent,
      modal: $("opened-modal").matches(":modal"),
      plain: $("opened-plain").open && !$("opened-plain").matches(":modal"),
      more: $("opened-more").open,
      pop: $("opened-pop").matches(":popover-open"),
      served: $("opened-served").open,
      focused: document.activeElement?.id,
    };
  }, [block(2, " open"), block(3, "")]);
  await page.evaluate(() => {
    for (const d of Array.from(document.querySelectorAll("#opened dialog"))) /** @type {HTMLDialogElement} */ (d).close();
    document.querySelector("#opened")?.remove();
  });
  check(
    "a patch keeps a dialog, details and popover the user opened, and closes one the server closes",
    openedState.count === "3" && openedState.modal && openedState.plain && openedState.more && openedState.pop && openedState.served === false && openedState.focused === "opened-in",
    JSON.stringify(openedState),
  );
  // A dialog the server drew open in the page as it loaded, which the user left open: a patch that
  // sends it closed closes it, which takes what the load recorded of it (unrecorded, the open
  // dialog would count as the user's and stay open).
  {
    const loadedPage = await (await browser.newContext()).newPage();
    const part = (/** @type {string} */ open) => `<section id="loaded-dialog-part"><dialog id="loaded-dialog"${open}><p>Sent open</p></dialog></section>`;
    await loadedPage.route(
      (url) => url.pathname === "/news",
      async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        // Fetched uncompressed: Playwright does not decode zstd, which Firefox asks for.
        const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
        const headers = res.headers();
        delete headers["content-encoding"];
        delete headers["content-length"];
        await route.fulfill({ status: res.status(), headers, body: (await res.text()).replace(/(<main\b[^>]*>)/, `$1${part(" open")}`) });
      },
    );
    await loadedPage.goto(`${base}/news`);
    const loadedDialog = await loadedPage.evaluate(async (closed) => {
      const { patch } = await import("corten");
      const open = () => /** @type {HTMLDialogElement | null} */ (document.getElementById("loaded-dialog"))?.open;
      const before = open();
      await patch(__html(closed));
      return { before, after: open() };
    }, part(""));
    check(
      "a patch closes a dialog the loaded page drew open when the server sends it closed",
      loadedDialog.before === true && loadedDialog.after === false,
      JSON.stringify(loadedDialog),
    );
    await loadedPage.context().close();
  }
  // A table with a menu on every row: a patch of it keeps the one details (found by its place in
  // its row) and the one popover (by id) the user opened, and the rest stay as the server sent them.
  const menus = await page.evaluate(async () => {
    const { patch } = await import("corten");
    const table = (/** @type {number} */ n) =>
      `<table id="menus"><tbody>${Array.from({ length: 300 }, (_, i) => `<tr id="menus-r${i}"><td>${n}</td><td><details><summary>More</summary><p>${i}</p></details><div popover id="menus-m${i}">Edit</div></td></tr>`).join("")}</tbody></table>`;
    document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<table id="menus"></table>'));
    await patch(__html(table(1)));
    /** @type {HTMLDetailsElement} */ (document.querySelector("#menus-r7 details")).open = true;
    /** @type {HTMLElement} */ (document.getElementById("menus-m9")).showPopover();
    await patch(__html(table(2)));
    const got = {
      count: document.querySelector("#menus-r0 td")?.textContent,
      details: /** @type {HTMLDetailsElement} */ (document.querySelector("#menus-r7 details")).open,
      open: document.querySelectorAll("#menus details[open]").length,
      pop: document.querySelectorAll("#menus :popover-open").length === 1 && document.getElementById("menus-m9")?.matches(":popover-open"),
    };
    /** @type {HTMLElement} */ (document.getElementById("menus-m9")).hidePopover();
    document.getElementById("menus")?.remove();
    return got;
  });
  check("a patch of rows with a menu each keeps the details and popover the user opened", menus.count === "2" && menus.details && menus.open === 1 && menus.pop, JSON.stringify(menus));
  // A dialog the page drew closed, which a data-patch form outside it asks for: the answer draws it
  // open, and it opens again after the user closed it, since the press is newer than their close
  // (#1371). It opens as drawn, not modal: an app makes it modal with
  // on:connect={corten_ui::dialog::modal(target)}. A press inside it, and a live fragment, keep
  // what the user did (#84).
  {
    const sheet = await browser.newPage();
    sheet.on("pageerror", (e) => errors.push(`sheet: ${e.message}`));
    await sheet.goto(`${base}/smoke/sheet`);
    const state = () =>
      sheet.evaluate(() => {
        const dialog = /** @type {HTMLDialogElement} */ (document.getElementById("smoke-sheet"));
        return { replaced: dialog !== /** @type {any} */ (window).__sheet, open: dialog.open, modal: dialog.matches(":modal"), text: dialog.querySelector("p")?.textContent };
      });
    /** Does `act`, then waits for an answer to replace the dialog, and says how it is then. @param {() => Promise<unknown>} act */
    const answered = async (act) => {
      await sheet.evaluate(() => (/** @type {any} */ (window).__sheet = document.getElementById("smoke-sheet")));
      await act();
      await sheet.waitForFunction(() => document.getElementById("smoke-sheet") !== /** @type {any} */ (window).__sheet, undefined, { timeout: 5000 }).catch(() => {});
      return state();
    };
    const closed = () => sheet.waitForFunction(() => !(/** @type {HTMLDialogElement} */ (document.getElementById("smoke-sheet")).open), undefined, { timeout: 5000 }).then(() => true, () => false);
    const preview = () => sheet.getByRole("button", { name: "Preview", exact: true }).click();
    const first = await answered(preview);
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    const shut = await closed();
    const again = await answered(preview);
    check(
      "a data-patch answer to a form outside a dialog opens it again, as drawn, after the user closed it",
      first.replaced && first.open && !first.modal && shut && again.replaced && again.open && !again.modal,
      JSON.stringify({ first, shut, again }),
    );
    // A dialog the server drew closed and the user opened, which the answer to a press outside it
    // draws closed, stays open: the press asks for what the answer draws open, and never closes
    // what the user opened (#84). Opened non-modal, so the page behind it takes the press.
    const sheetAnswer = (/** @type {URL} */ url) => url.pathname === "/smoke/sheet/open";
    await sheet.route(sheetAnswer, (route) =>
      route.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "corten-patch": "1" }, body: '<dialog id="smoke-sheet"><p>Drawn closed</p></dialog>' }),
    );
    await sheet.evaluate(() => /** @type {HTMLDialogElement} */ (document.getElementById("smoke-sheet")).close());
    await answered(preview);
    await sheet.evaluate(() => /** @type {HTMLDialogElement} */ (document.getElementById("smoke-sheet")).show());
    const keptOpen = await answered(preview);
    await sheet.unroute(sheetAnswer);
    check("a data-patch answer to a form outside a dialog the user opened keeps it open when it draws it closed", keptOpen.replaced && keptOpen.text === "Drawn closed" && keptOpen.open, JSON.stringify(keptOpen));
    // The app's sheet again, with its form: closed first, so the page behind it takes the press.
    await sheet.evaluate(() => /** @type {HTMLDialogElement} */ (document.getElementById("smoke-sheet")).close());
    await answered(preview);
    // Pressed inside the dialog, closed (Escape) while the answer is on its way: it stays closed.
    // Opened modal as a button would (`command="show-modal"`), so Escape closes it.
    await sheet.evaluate(() => {
      const dialog = /** @type {HTMLDialogElement} */ (document.getElementById("smoke-sheet"));
      if (dialog.open) dialog.close();
      dialog.showModal();
    });
    /** @type {() => void} */
    let release = () => {};
    await sheet.route(sheetAnswer, async (route) => {
      await new Promise((resolve) => (release = () => resolve(undefined)));
      await route.continue();
    });
    const inside = await answered(async () => {
      const sent = sheet.waitForRequest((r) => sheetAnswer(new URL(r.url())), { timeout: 5000 }).catch(() => null);
      await sheet.getByRole("button", { name: "Again", exact: true }).click();
      await sent;
      await sheet.keyboard.press("Escape");
      await closed();
      release();
    });
    await sheet.unroute(sheetAnswer);
    check("a data-patch answer to a form inside a dialog the user closed while it was on its way keeps it closed", inside.replaced && !inside.open && !inside.modal, JSON.stringify(inside));
    // Where the press was is where it was when pressed: removing the button, redrawing the dialog
    // or replacing the form earlier in the same answer, while it is on its way, does not make it a
    // press outside the dialog, which would open it again.
    /**
     * Opens the dialog, presses Again inside it, closes it with Escape while the answer is held,
     * does `meanwhile`, then lets the answer (`body`, or the app's) through and waits for it to
     * replace the dialog.
     * @param {() => Promise<unknown>} meanwhile @param {string} [body]
     */
    const pressedInside = async (meanwhile, body) => {
      await sheet.evaluate(() => {
        const dialog = /** @type {HTMLDialogElement} */ (document.getElementById("smoke-sheet"));
        if (dialog.open) dialog.close();
        dialog.showModal();
        const form = dialog.querySelector("form");
        if (form) form.id = "smoke-again";
      });
      /** @type {() => void} */
      let let_go = () => {};
      await sheet.route(sheetAnswer, async (route) => {
        await new Promise((resolve) => (let_go = () => resolve(undefined)));
        if (body) await route.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "corten-patch": "1" }, body });
        else await route.continue();
      });
      const sent = sheet.waitForRequest((r) => sheetAnswer(new URL(r.url())), { timeout: 5000 }).catch(() => null);
      await sheet.getByRole("button", { name: "Again", exact: true }).click();
      await sent;
      await sheet.keyboard.press("Escape");
      await closed();
      await meanwhile();
      await sheet.evaluate(() => (/** @type {any} */ (window).__sheet = document.getElementById("smoke-sheet")));
      let_go();
      await sheet.waitForFunction(() => document.getElementById("smoke-sheet") !== /** @type {any} */ (window).__sheet, undefined, { timeout: 5000 }).catch(() => {});
      await sheet.unroute(sheetAnswer);
      return state();
    };
    const removed = await pressedInside(() => sheet.evaluate(() => document.querySelector("#smoke-again button")?.remove()));
    check("a data-patch answer to a form inside a dialog keeps it closed when its button was removed while it was on its way", removed.replaced && removed.text === "Preview" && !removed.open, JSON.stringify(removed));
    await sheet.route(
      (url) => url.pathname === "/smoke/live/sheet-again",
      (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: 'event: patch\ndata: <dialog id="smoke-sheet" open><p>Redrawn</p></dialog>\n\nevent: end\ndata: end\n\n' }),
    );
    const redrawn = await pressedInside(async () => {
      await sheet.evaluate(() => document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<corten-live id="sheet-again-live" src="/smoke/live/sheet-again"></corten-live>')));
      await sheet.waitForFunction(() => document.querySelector("#smoke-sheet p")?.textContent === "Redrawn", undefined, { timeout: 5000 }).catch(() => {});
    });
    check("a data-patch answer to a form inside a dialog keeps it closed when the dialog was redrawn while it was on its way", redrawn.replaced && redrawn.text === "Preview" && !redrawn.open, JSON.stringify(redrawn));
    // Redrawn above without the form; the app's answer draws it again.
    await answered(() => sheet.getByRole("button", { name: "Preview", exact: true }).click());
    const formFirst = await pressedInside(
      async () => {},
      '<form id="smoke-again"><p>Form</p></form><dialog id="smoke-sheet" open><p>Answered</p></dialog>',
    );
    check("a data-patch answer that replaces the form inside a dialog before the dialog keeps it closed", formFirst.replaced && formFirst.text === "Answered" && !formFirst.open, JSON.stringify(formFirst));
    // A live fragment that draws it open, after the user closed it: it stays closed.
    await sheet.route(
      (url) => url.pathname === "/smoke/live/sheet",
      (route) =>
        route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: 'event: patch\ndata: <dialog id="smoke-sheet" open><p>Live</p></dialog>\n\nevent: end\ndata: end\n\n' }),
    );
    const live = await answered(() =>
      sheet.evaluate(() => document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<corten-live id="sheet-live" src="/smoke/live/sheet"></corten-live>'))),
    );
    check("a live fragment that draws a dialog open keeps it closed after the user closed it", live.replaced && live.text === "Live" && !live.open, JSON.stringify(live));
    // The same for a <details>: a form outside it that asks for it unfolded unfolds it again after
    // the user folded it. The dialog is closed first, so the page behind it is not inert.
    await sheet.evaluate(() => /** @type {HTMLDialogElement} */ (document.getElementById("smoke-sheet")).close());
    const unfolded = async () => {
      await sheet.evaluate(() => (/** @type {any} */ (window).__more = document.getElementById("smoke-more")));
      await sheet.getByRole("button", { name: "Unfold", exact: true }).click();
      await sheet.waitForFunction(() => document.getElementById("smoke-more") !== /** @type {any} */ (window).__more, undefined, { timeout: 5000 }).catch(() => {});
      return sheet.evaluate(() => /** @type {HTMLDetailsElement} */ (document.getElementById("smoke-more")).open);
    };
    const unfoldedFirst = await unfolded();
    await sheet.click("#smoke-more summary");
    const folded = await sheet.evaluate(() => !(/** @type {HTMLDetailsElement} */ (document.getElementById("smoke-more")).open));
    const unfoldedAgain = await unfolded();
    check("a data-patch answer to a form outside a <details> unfolds it again after the user folded it", unfoldedFirst && folded && unfoldedAgain, JSON.stringify({ unfoldedFirst, folded, unfoldedAgain }));
    // A form around a dialog, with one field and no button: Enter in the field sends it with no
    // submitter, and so does a script's requestSubmit(). The focused field is where it was pressed,
    // inside the dialog, so the answer keeps it closed when the user closed it on the way.
    const wrapAnswer = (/** @type {URL} */ url) => url.pathname === "/smoke/sheet/wrapped";
    /** Opens the wrapped dialog modal, does `press` with its field focused, closes it with Escape while the answer is held, then lets it through. @param {() => Promise<unknown>} press */
    const wrappedInside = async (press) => {
      await sheet.evaluate(() => {
        document.getElementById("smoke-wrap")?.remove();
        document
          .querySelector("main")
          ?.insertAdjacentHTML("beforeend", __html('<form id="smoke-wrap" method="get" action="/smoke/sheet/wrapped" data-patch><dialog id="smoke-wrapped"><input name="q" aria-label="Wrapped"></dialog></form>'));
        const dialog = /** @type {HTMLDialogElement} */ (document.getElementById("smoke-wrapped"));
        dialog.showModal();
        dialog.querySelector("input")?.focus();
        /** @type {any} */ (window).__wrapped = dialog;
      });
      /** @type {() => void} */
      let let_go = () => {};
      await sheet.route(wrapAnswer, async (route) => {
        await new Promise((resolve) => (let_go = () => resolve(undefined)));
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "corten-patch": "1" },
          body: '<dialog id="smoke-wrapped" open><input name="q" aria-label="Wrapped"><p>Answered</p></dialog>',
        });
      });
      const sent = sheet.waitForRequest((r) => wrapAnswer(new URL(r.url())), { timeout: 5000 }).catch(() => null);
      await press();
      const asked = (await sent) !== null;
      await sheet.keyboard.press("Escape");
      const shut = await sheet
        .waitForFunction(() => !(/** @type {HTMLDialogElement} */ (document.getElementById("smoke-wrapped")).open), undefined, { timeout: 5000 })
        .then(() => true, () => false);
      let_go();
      await sheet.waitForFunction(() => document.getElementById("smoke-wrapped") !== /** @type {any} */ (window).__wrapped, undefined, { timeout: 5000 }).catch(() => {});
      await sheet.unroute(wrapAnswer);
      const now = await sheet.evaluate(() => {
        const dialog = /** @type {HTMLDialogElement} */ (document.getElementById("smoke-wrapped"));
        return { replaced: dialog !== /** @type {any} */ (window).__wrapped, open: dialog.open, text: dialog.querySelector("p")?.textContent };
      });
      return { asked, shut, ...now };
    };
    const entered = await wrappedInside(() => sheet.keyboard.press("Enter"));
    check(
      "a data-patch answer to Enter in a field of a dialog, in a form with no button around it, keeps it closed when the user closed it on the way",
      entered.asked && entered.shut && entered.replaced && entered.text === "Answered" && !entered.open,
      JSON.stringify(entered),
    );
    const requested = await wrappedInside(() => sheet.evaluate(() => /** @type {HTMLFormElement} */ (document.getElementById("smoke-wrap")).requestSubmit()));
    check(
      "a data-patch answer to a script's requestSubmit() from a field in a dialog keeps it closed when the user closed it on the way",
      requested.asked && requested.shut && requested.replaced && requested.text === "Answered" && !requested.open,
      JSON.stringify(requested),
    );
    await sheet.evaluate(() => document.getElementById("smoke-wrap")?.remove());
    // A submit that waits for a write: a form= button inside a dialog, pressed while the form's
    // write is on its way, is sent once the write's answer is drawn. That answer moves the button
    // outside the dialog, which the user closed meanwhile: where it was pressed is inside, so the
    // waiting submit's answer keeps the dialog closed.
    const queueAnswer = (/** @type {URL} */ url) => url.pathname === "/smoke/sheet/queued";
    /** @type {() => void} */
    let write_back = () => {};
    let asked = false;
    await sheet.route(queueAnswer, async (route) => {
      const patch = (/** @type {string} */ body) => route.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "corten-patch": "1" }, body });
      if (route.request().postData()?.includes("act=ask")) {
        asked = true;
        return patch('<dialog id="smoke-queued" open><p>Asked</p></dialog>');
      }
      await new Promise((resolve) => (write_back = () => resolve(undefined)));
      return patch('<span id="smoke-queue-in"></span><div id="smoke-queue-spot"><button form="smoke-queue" name="act" value="ask">Ask</button></div>');
    });
    await sheet.evaluate(() =>
      document
        .querySelector("main")
        ?.insertAdjacentHTML(
          "beforeend",
          __html(
            '<form id="smoke-queue" method="post" action="/smoke/sheet/queued" data-patch><input name="v" value="1" aria-label="Queued"><button name="act" value="write">Write</button></form>' +
              '<div id="smoke-queue-spot"></div><dialog id="smoke-queued"><p>Start</p><span id="smoke-queue-in"><button form="smoke-queue" name="act" value="ask">Ask</button></span></dialog>',
          ),
        ),
    );
    const wrote = sheet.waitForRequest((r) => queueAnswer(new URL(r.url())) && !!r.postData()?.includes("act=write"), { timeout: 5000 }).catch(() => null);
    await sheet.getByRole("button", { name: "Write", exact: true }).click();
    const writing = (await wrote) !== null;
    await sheet.evaluate(() => {
      const dialog = /** @type {HTMLDialogElement} */ (document.getElementById("smoke-queued"));
      dialog.showModal();
      /** @type {any} */ (window).__queued = dialog;
    });
    await sheet.locator("#smoke-queued").getByRole("button", { name: "Ask", exact: true }).click();
    await sheet.keyboard.press("Escape");
    const queuedShut = await sheet
      .waitForFunction(() => !(/** @type {HTMLDialogElement} */ (document.getElementById("smoke-queued")).open), undefined, { timeout: 5000 })
      .then(() => true, () => false);
    write_back();
    await sheet.waitForFunction(() => document.getElementById("smoke-queued") !== /** @type {any} */ (window).__queued, undefined, { timeout: 5000 }).catch(() => {});
    await sheet.unroute(queueAnswer);
    const queued = await sheet.evaluate(() => {
      const dialog = /** @type {HTMLDialogElement} */ (document.getElementById("smoke-queued"));
      return {
        replaced: dialog !== /** @type {any} */ (window).__queued,
        open: dialog.open,
        text: dialog.querySelector("p")?.textContent,
        moved: !!document.querySelector("#smoke-queue-spot button") && !dialog.querySelector("button"),
      };
    });
    check(
      "a submit from a form= button in a dialog that waited for the form's write keeps the dialog closed when the write's answer moved the button outside it",
      writing && queuedShut && asked && queued.moved && queued.replaced && queued.text === "Asked" && !queued.open,
      JSON.stringify({ writing, queuedShut, asked, ...queued }),
    );
    await sheet.evaluate(() => ["smoke-queue", "smoke-queue-spot", "smoke-queued"].forEach((id) => document.getElementById(id)?.remove()));
    await sheet.close();
    // Without JavaScript the same forms are plain GETs: each answer is the whole sheet page, in
    // its layout, with what was asked for drawn open, never the bare fragment (#1423).
    const noScript = await browser.newContext({ javaScriptEnabled: false });
    const bare = await noScript.newPage();
    await bare.goto(`${base}/smoke/sheet`);
    /** Presses `name` and says where the page landed and what is open. @param {string} name */
    const pressed = async (name) => {
      const [answer] = await Promise.all([bare.waitForNavigation(), bare.getByRole("button", { name, exact: true }).click()]);
      return bare.evaluate((status) => ({
        status,
        path: location.pathname,
        title: document.title,
        main: !!document.querySelector("main"),
        dialog: !!(/** @type {HTMLDialogElement | null} */ (document.getElementById("smoke-sheet"))?.open),
        details: !!(/** @type {HTMLDetailsElement | null} */ (document.getElementById("smoke-more"))?.open),
      }), answer?.status());
    };
    const bareSheet = await pressed("Preview");
    check(
      "without JavaScript a form that asks for a dialog gets the page with the dialog open, not the bare dialog",
      bareSheet.status === 200 && bareSheet.path === "/smoke/sheet/open" && bareSheet.main && bareSheet.title.startsWith("Sheet") && bareSheet.dialog && !bareSheet.details,
      JSON.stringify(bareSheet),
    );
    const bareMore = await pressed("Unfold");
    check(
      "without JavaScript a form that asks for a <details> gets the page with it open",
      bareMore.status === 200 && bareMore.path === "/smoke/sheet/more" && bareMore.main && bareMore.details && !bareMore.dialog,
      JSON.stringify(bareMore),
    );
    await noScript.close();
  }
  await page.focus("#kept button");
  const buttonFocus = await page.evaluate(async (html) => {
    const { patch } = await import("corten");
    await patch(__html(html));
    return document.activeElement === document.querySelector("#kept button");
  }, fresh);
  check("a patch keeps focus on an element without an id or name (by its place)", buttonFocus);
  await page.evaluate(() => document.querySelector("#kept")?.remove());

  // A patch that takes the focused element away leaves focus near it, not on the body (#267): the
  // counterpart of its nearest ancestor that has one, focusable for the move only.
  await page.evaluate(() =>
    document
      .querySelector("main")
      ?.insertAdjacentHTML("beforeend", __html('<section id="rows-gone"><ul><li id="row-a"><button>Remove A</button></li><li id="row-b"><button>Remove B</button></li></ul></section><ul id="list-gone"><li id="item-a"><button>Remove</button></li></ul>')),
  );
  await page.focus("#row-b button");
  const lostRow = await page.evaluate(async () => {
    const { patch } = await import("corten");
    await patch(__html('<section id="rows-gone"><ul><li id="row-a"><button>Remove A</button></li></ul></section>'));
    const at = document.activeElement;
    const list = document.querySelector("#rows-gone ul");
    const was = at?.getAttribute("tabindex");
    /** @type {HTMLElement} */ (document.querySelector("#row-a button")).focus();
    return { onList: at === list, was, after: list?.getAttribute("tabindex") ?? null };
  });
  check("a patch that replaces the focused row leaves focus on its list, focusable only until it leaves", lostRow.onList && lostRow.was === "-1" && lostRow.after === null, JSON.stringify(lostRow));
  // The same patch again (a live stream, a read again) keeps focus there, not one level up each time.
  await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector("#rows-gone ul")).focus());
  const again = await page.evaluate(async () => {
    const { patch } = await import("corten");
    // The list is focused (made focusable for the move above, as the runtime would).
    const list = /** @type {HTMLElement} */ (document.querySelector("#rows-gone ul"));
    list.tabIndex = -1;
    list.focus();
    const html = '<section id="rows-gone"><ul><li id="row-a"><button>Remove A</button></li></ul></section>';
    await patch(__html(html));
    await patch(__html(html));
    return document.activeElement === document.querySelector("#rows-gone ul");
  });
  check("the same patch twice leaves focus on the list", again);
  // The patched element had focus and its replacement cannot take it: the element around it.
  await page.evaluate(() => document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<div id="follow-around"><button id="follow">Follow</button></div>')));
  await page.focus("#follow");
  const disabled = await page.evaluate(async () => {
    const { patch } = await import("corten");
    await patch(__html('<button id="follow" disabled>Following</button>'));
    const at = document.activeElement?.id;
    document.querySelector("#follow-around")?.remove();
    return at;
  });
  check("a focused element patched into one that cannot take focus leaves focus around it", disabled === "follow-around", disabled);
  await page.focus("#item-a button");
  const lostItem = await page.evaluate(async () => {
    const { patch } = await import("corten");
    await patch(__html('<template id="item-a" data-remove></template>'));
    return document.activeElement?.id;
  });
  check("a patch that removes the focused element leaves focus on its parent", lostItem === "list-gone", lostItem);
  await page.evaluate(() => ["#rows-gone", "#list-gone"].forEach((s) => document.querySelector(s)?.remove()));

  // A form with a control named id (`form.id` is that control): its patch still finds it, and in
  // a patched block an edited field inside it keeps the user's text.
  await page.evaluate(() =>
    document.querySelector("main")?.insertAdjacentHTML("beforeend", __html('<form id="named-id"><input name="id" value="7"><p>old</p></form><div id="holds-named"><form><input name="id"><input name="q" value="a"></form></div>')),
  );
  await page.fill("#holds-named [name=q]", "typed");
  const namedId = await page.evaluate(async () => {
    const { patch } = await import("corten");
    await patch(__html('<form id="named-id"><input name="id" value="7"><p>new</p></form><div id="holds-named" class="new"><form><input name="id"><input name="q" value="b"></form></div>'));
    return {
      form: document.querySelector("#named-id p")?.textContent,
      block: document.querySelector("#holds-named")?.className,
      q: /** @type {HTMLInputElement} */ (document.querySelector("#holds-named [name=q]")).value,
    };
  });
  check("a form with a control named id is patched, and keeps what the user typed", namedId.form === "new" && namedId.block === "new" && namedId.q === "typed", JSON.stringify(namedId));
  await page.evaluate(() => {
    document.querySelector("#named-id")?.remove();
    document.querySelector("#holds-named")?.remove();
  });

  // A file input keeps the files the user chose across a patch, which markup cannot give back: a
  // refusal redraws it marked invalid with the file still chosen, a live patch keeps it, and only
  // the answer that took those files clears them.
  const part = (/** @type {string} */ extra) => `<div id="upload-part"${extra}><input type="file" name="photo"${extra.includes("refused") ? ' aria-invalid="true"' : ""}></div>`;
  await page.evaluate(
    (html) => document.querySelector("main")?.insertAdjacentHTML("beforeend", __html(`<form id="upload" method="post" action="/upload-test" enctype="multipart/form-data" data-patch>${html}<button>Send</button></form>`)),
    part(""),
  );
  return { part };
}
