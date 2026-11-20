import { base, skip, check } from "./helpers.mjs";

export async function history(swaps, browser, noSwaps, errors) {
  // Back to a page the runtime swapped in puts back what the user typed or chose there, as the
  // browser does without the script; the page is still drawn again from the server.
  if (swaps) {
    const typedPage = await (await browser.newContext()).newPage();
    await typedPage.goto(`${base}/alerts`);
    const drawn = await typedPage.inputValue("#alert-form select");
    await typedPage.selectOption("#alert-form select", "SOLR");
    await typedPage.fill("#alert-form input[name=above]", "123.45");
    let documents = 0;
    let reads = 0;
    typedPage.on("request", (r) => r.resourceType() === "document" && documents++);
    // The page is read again from the server, not kept.
    typedPage.on("request", (r) => new URL(r.url()).pathname === "/alerts" && r.headers()["corten"] === "nav" && reads++);
    await typedPage.click('header nav a[href="/news"]');
    await typedPage.waitForFunction(() => document.title === "News | Watchlist");
    await typedPage.goBack();
    await typedPage.waitForFunction(() => location.pathname === "/alerts" && !!document.querySelector("#alert-form"), null, { timeout: 5000 }).catch(() => {});
    const back = {
      id: await typedPage.inputValue("#alert-form select"),
      above: await typedPage.inputValue("#alert-form input[name=above]"),
      documents,
      reads,
    };
    check(
      "back to a page the runtime swapped in puts back what the user typed and chose there",
      drawn !== "SOLR" && back.id === "SOLR" && back.above === "123.45" && back.documents === 0 && back.reads === 1,
      JSON.stringify({ drawn, ...back }),
    );
    await typedPage.context().close();
    /**
     * A page whose /alerts answers are changed on their way from the server, by request count.
     * @param {(body: string, nth: number) => string} change
     */
    const changed = async (change) => {
      const p = await (await browser.newContext()).newPage();
      let nth = 0;
      await p.route(
        (url) => url.pathname === "/alerts",
        async (route) => {
          if (route.request().method() !== "GET") return route.fallback();
          const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
          const headers = res.headers();
          delete headers["content-encoding"];
          delete headers["content-length"];
          await route.fulfill({ status: res.status(), headers, body: change(await res.text(), nth++) });
        },
      );
      await p.goto(`${base}/alerts`);
      return p;
    };
    /** Types in the alert form, goes to the news page and back, and reads the form. @param {import("@playwright/test").Page} p */
    const typeAndBack = async (p) => {
      await p.selectOption("#alert-form select", "SOLR");
      await p.fill("#alert-form input[name=above]", "123.45");
      await p.click('header nav a[href="/news"]');
      await p.waitForFunction(() => document.title === "News | Watchlist");
      await p.goBack();
      await p.waitForFunction(() => location.pathname === "/alerts" && !!document.querySelector("#alert-form"), null, { timeout: 5000 }).catch(() => {});
      return { id: await p.inputValue("#alert-form select"), above: await p.inputValue("#alert-form input[name=above]") };
    };
    // A field marked autocomplete="off" is drawn as the server draws it, as the browser does; the
    // form's other field is put back.
    const offPage = await changed((body) => body.replace('name="above"', 'name="above" autocomplete="off"'));
    const off = await offPage.evaluate(() => document.querySelector("#alert-form input[name=above]")?.getAttribute("autocomplete"));
    const offBack = await typeAndBack(offPage);
    check('back to a page puts back its fields but one autocomplete="off" marks', off === "off" && offBack.id === "SOLR" && offBack.above === "", JSON.stringify({ off, ...offBack }));
    await offPage.context().close();
    // A field the server now draws otherwise (its value, here) keeps what the server draws; the
    // others are put back.
    const otherPage = await changed((body, nth) => (nth ? body.replace(/(name="above"[^>]*?value=")[^"]*"/, '$199"') : body));
    const otherBack = await typeAndBack(otherPage);
    check("back to a page leaves a field the server now draws otherwise as the server draws it", otherBack.id === "SOLR" && otherBack.above === "99", JSON.stringify(otherBack));
    await otherPage.context().close();
    // As the browser does: a form marked autocomplete="off" keeps none of its fields, and a
    // password is never put back, even one drawn the same.
    const offFormPage = await changed((body) => body.replace('<form id="alert-form"', '<form id="alert-form" autocomplete="off"'));
    const offForm = await offFormPage.evaluate(() => document.querySelector("#alert-form")?.getAttribute("autocomplete"));
    const offFormBack = await typeAndBack(offFormPage);
    check('back to a page puts back no field of a form marked autocomplete="off"', offForm === "off" && offFormBack.id !== "SOLR" && offFormBack.above === "", JSON.stringify({ offForm, ...offFormBack }));
    await offFormPage.context().close();
    const passwordPage = await changed((body) => body.replace(/<input type="text"([^>]*?name="above")/, '<input type="password"$1'));
    const password = await passwordPage.evaluate(() => document.querySelector("#alert-form input[name=above]")?.getAttribute("type"));
    const passwordBack = await typeAndBack(passwordPage);
    check("back to a page puts back its fields but a password", password === "password" && passwordBack.id === "SOLR" && passwordBack.above === "", JSON.stringify({ password, ...passwordBack }));
    await passwordPage.context().close();
    // A checkbox and a radio the user changed are put back; a select whose options the server
    // changed keeps what the server draws, and the other fields are put back.
    // A checkbox the server draws with another value is left as drawn too (one with an id, so it is
    // found by the id whatever its value and only how it was drawn tells the two apart).
    const choices = '<input type="checkbox" name="notify" value="email"><input type="checkbox" id="digest" name="digest" value="daily"><input type="radio" name="tone" value="calm" checked><input type="radio" name="tone" value="loud">';
    const choicePage = await changed((body, nth) => {
      const page = body.replace('<button id="save-alert">', `${choices}<button id="save-alert">`);
      return nth ? page.replace('<option value="VTGO">Vertigo Robotics (VTGO)</option>', "").replace('id="digest" name="digest" value="daily"', 'id="digest" name="digest" value="weekly"') : page;
    });
    await choicePage.check("#alert-form [name=notify]");
    await choicePage.check("#alert-form [name=digest]");
    await choicePage.check("#alert-form [name=tone][value=loud]");
    const choiceBack = await typeAndBack(choicePage);
    const choice = await choicePage.evaluate(() => ({
      notify: /** @type {HTMLInputElement | null} */ (document.querySelector("#alert-form [name=notify]"))?.checked,
      digest: /** @type {HTMLInputElement | null} */ (document.querySelector("#alert-form [name=digest]"))?.checked,
      tone: /** @type {HTMLInputElement | null} */ (document.querySelector("#alert-form [name=tone]:checked"))?.value,
      options: document.querySelectorAll("#alert-form select option").length,
    }));
    check(
      "back to a page puts back a checkbox and a radio, and leaves a select whose options changed and a checkbox whose value changed as the server draws them",
      choice.notify === true && choice.digest === false && choice.tone === "loud" && choice.options === 7 && choiceBack.id === "ACME" && choiceBack.above === "123.45",
      JSON.stringify({ ...choice, ...choiceBack }),
    );
    await choicePage.context().close();
    // A file chosen is never put back, as the browser does; the page's other fields are, and the
    // fields are in place before the page's own elements connect (one here reads a field as it does).
    const filePage = await changed((body) => body.replace('<button id="save-alert">', '<input type="file" name="doc"><read-field></read-field><button id="save-alert">'));
    await filePage.addInitScript(() =>
      customElements.define(
        "read-field",
        class extends HTMLElement {
          connectedCallback() {
            (/** @type {any} */ (window)).__readAtConnect = /** @type {HTMLInputElement | null} */ (this.closest("form")?.querySelector("[name=above]"))?.value;
          }
        },
      ),
    );
    await filePage.reload();
    /** @type {string[]} */
    const fileErrors = [];
    filePage.on("pageerror", (e) => fileErrors.push(e.message));
    await filePage.setInputFiles("#alert-form [name=doc]", { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("note") });
    const fileBack = await typeAndBack(filePage);
    const fileAfter = await filePage.evaluate(() => ({
      files: /** @type {HTMLInputElement | null} */ (document.querySelector("#alert-form [name=doc]"))?.files?.length,
      atConnect: (/** @type {any} */ (window)).__readAtConnect,
      main: location.pathname === "/alerts" && !!document.querySelector("main #alert-form"),
    }));
    check(
      "back to a page puts back no file, the other fields before the page's elements connect",
      fileAfter.main && fileAfter.files === 0 && fileAfter.atConnect === "123.45" && fileBack.above === "123.45" && !fileErrors.length,
      JSON.stringify({ ...fileAfter, ...fileBack, fileErrors }),
    );
    await filePage.context().close();
    // A value a script set, with no input or change event, is not put back; what the user chose is.
    const scriptPage = await changed((body) => body);
    await scriptPage.selectOption("#alert-form select", "SOLR");
    await scriptPage.evaluate(() => {
      /** @type {HTMLInputElement} */ (document.querySelector("#alert-form input[name=above]")).value = "5";
    });
    await scriptPage.click('header nav a[href="/news"]');
    await scriptPage.waitForFunction(() => document.title === "News | Watchlist");
    await scriptPage.goBack();
    await scriptPage.waitForFunction(() => location.pathname === "/alerts" && !!document.querySelector("#alert-form"), null, { timeout: 5000 }).catch(() => {});
    const scripted = { id: await scriptPage.inputValue("#alert-form select"), above: await scriptPage.inputValue("#alert-form input[name=above]") };
    check("back to a page puts back what the user chose and not a value a script set", scripted.id === "SOLR" && scripted.above === "", JSON.stringify(scripted));
    await scriptPage.context().close();
    // A value a script set and then dispatched input and change for, as a typed field sends, is.
    const toldPage = await changed((body) => body);
    await toldPage.evaluate(() => {
      const above = /** @type {HTMLInputElement} */ (document.querySelector("#alert-form input[name=above]"));
      above.value = "7";
      above.dispatchEvent(new Event("input", { bubbles: true }));
      above.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await toldPage.click('header nav a[href="/news"]');
    await toldPage.waitForFunction(() => document.title === "News | Watchlist");
    await toldPage.goBack();
    await toldPage.waitForFunction(() => location.pathname === "/alerts" && !!document.querySelector("#alert-form") && !document.querySelector("main[aria-busy]"), null, { timeout: 5000 }).catch(() => {});
    const told = await toldPage.inputValue("#alert-form input[name=above]");
    check("back to a page puts back a value a script set and dispatched input and change for", told === "7", told);
    await toldPage.context().close();
    // A form with a control named like one of a form's own methods is still read by the form's:
    // leaving it swaps the page in and Back puts back what was typed. (Playwright's own select
    // and checks call getAttribute on the form, so only the text field is typed in, by keys.)
    const shadowPage = await changed((body) => body.replace(/(<form id="alert-form"[^>]*>)/, '$1<input type="hidden" name="getAttribute" value="x">'));
    /** @type {string[]} */
    const shadowErrors = [];
    shadowPage.on("pageerror", (e) => shadowErrors.push(e.message));
    await shadowPage.focus("#alert-form input[name=above]");
    await shadowPage.keyboard.press("ControlOrMeta+a");
    await shadowPage.keyboard.type("123.45");
    await shadowPage.click('header nav a[href="/news"]');
    const shadowLeft = await shadowPage.waitForFunction(() => document.title === "News | Watchlist" && !document.querySelector("#alert-form"), null, { timeout: 5000 }).then(() => true, () => false);
    await shadowPage.goBack();
    await shadowPage.waitForFunction(() => location.pathname === "/alerts" && !!document.querySelector("#alert-form"), null, { timeout: 5000 }).catch(() => {});
    const shadowAbove = await shadowPage.evaluate(() => /** @type {HTMLInputElement | null} */ (document.querySelector("#alert-form input[name=above]"))?.value);
    check("back to a page puts back what was typed in a form with a control named getAttribute", shadowLeft && shadowAbove === "123.45" && !shadowErrors.length, JSON.stringify({ shadowLeft, shadowAbove, shadowErrors }));
    await shadowPage.context().close();
    // More fields typed in than the runtime looks up one by one (it walks the page's fields once):
    // each is found again, by id or by name and place among fields of one name.
    const manyPage = await changed((body) =>
      body.replace(
        '<button id="save-alert">',
        Array.from({ length: 70 }, (_, i) => `<input id="many-${i}" name="m${i}">`).join("") + '<input name="many">'.repeat(20) + '<button id="save-alert">',
      ),
    );
    await manyPage.evaluate(() => {
      const typed = [...document.querySelectorAll('#alert-form [id^="many-"]'), ...[...document.querySelectorAll('#alert-form [name="many"]')].filter((_, i) => i % 2)];
      for (const f of /** @type {HTMLInputElement[]} */ (typed)) {
        f.value = `typed ${f.id || [...document.querySelectorAll('[name="many"]')].indexOf(f)}`;
        f.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await manyPage.click('header nav a[href="/news"]');
    await manyPage.waitForFunction(() => document.title === "News | Watchlist");
    await manyPage.goBack();
    await manyPage.waitForFunction(() => location.pathname === "/alerts" && !!document.querySelector("#many-69"), null, { timeout: 5000 }).catch(() => {});
    const many = await manyPage.evaluate(() => {
      const ids = [...document.querySelectorAll('#alert-form [id^="many-"]')].filter((f) => /** @type {HTMLInputElement} */ (f).value !== `typed ${f.id}`).length;
      const named = [...document.querySelectorAll('#alert-form [name="many"]')].filter((f, i) => /** @type {HTMLInputElement} */ (f).value !== (i % 2 ? `typed ${i}` : "")).length;
      return { ids: document.querySelectorAll('[id^="many-"]').length, idsWrong: ids, namedWrong: named };
    });
    check("back to a page puts back what was typed in more fields than are looked up one by one", many.ids === 70 && !many.idsWrong && !many.namedWrong, JSON.stringify(many));
    await manyPage.context().close();
    /**
     * Types in the alert form, leaves the page as `leave` does, presses Back `backs` times and
     * reads the form. A read of /news (other than /news?r=...) is answered as `news` answers it.
     * @param {(route: import("@playwright/test").Route) => Promise<void>} news
     * @param {(p: import("@playwright/test").Page) => Promise<unknown>} leave
     */
    const typedThrough = async (news, leave, backs = 1) => {
      const p = await (await browser.newContext()).newPage();
      await p.route((url) => url.pathname === "/news" && !url.searchParams.has("r"), news);
      await p.goto(`${base}/alerts`);
      await p.selectOption("#alert-form select", "SOLR");
      await p.fill("#alert-form input[name=above]", "123.45");
      await leave(p);
      for (let i = 0; i < backs; i++) await p.goBack();
      await p.waitForFunction(() => location.pathname === "/alerts" && !!document.querySelector("#alert-form"), null, { timeout: 5000 }).catch(() => {});
      const read = { id: await p.inputValue("#alert-form select"), above: await p.inputValue("#alert-form input[name=above]") };
      await p.context().close();
      return read;
    };
    /** @param {import("@playwright/test").Page} p */
    const toNewsPlain = async (p) => {
      await p.click('header nav a[href="/news"]');
      await p.waitForFunction(() => document.title === "News | Watchlist");
    };
    /** @param {import("@playwright/test").Page} p */
    const toNews = async (p) => {
      await p.click('header nav a[href="/news"]');
      await p.waitForFunction(() => location.search.startsWith("?r=") && document.title === "News | Watchlist");
    };
    // The page left is recorded under its own entry, not the one a link pushed and its redirect
    // replaced: by the server naming the place (corten-location) or by an HTTP redirect.
    const named = await typedThrough(
      (route) => (route.request().headers()["corten"] ? route.fulfill({ status: 200, headers: { "corten-location": "/news?r=1" }, body: "" }) : route.fallback()),
      toNews,
    );
    check("back to a page puts back what was typed there after a link the server sent elsewhere", named.id === "SOLR" && named.above === "123.45", JSON.stringify(named));
    const redirected = await typedThrough((route) => route.fulfill({ status: 303, headers: { location: "/news?r=2" } }), toNews);
    check("back to a page puts back what was typed there after a link that redirected", redirected.id === "SOLR" && redirected.above === "123.45", JSON.stringify(redirected));
    // A second link followed before the first one's page arrives: the page left is recorded under
    // its own entry, not the one the first link pushed.
    const hurried = await typedThrough(
      async (route) => {
        await new Promise((done) => setTimeout(done, 1500));
        await route.fallback().catch(() => {});
      },
      async (p) => {
        await p.click('header nav a[href="/news"]');
        await p.waitForFunction(() => location.pathname === "/news");
        await p.click('header nav a[href="/"]');
        await p.waitForFunction(() => location.pathname === "/" && !document.querySelector("#alert-form"));
      },
      2,
    );
    check("back to a page puts back what was typed there after a second link followed before the first page arrived", hurried.id === "SOLR" && hurried.above === "123.45", JSON.stringify(hurried));
    // Forward and Back again: the page is recorded again as it is left by a traverse, with what was
    // typed after the first Back.
    const again = await typedThrough(
      (route) => route.fallback(),
      async (p) => {
        await p.click('header nav a[href="/news"]');
        await p.waitForFunction(() => document.title === "News | Watchlist");
        await p.goBack();
        await p.waitForFunction(() => location.pathname === "/alerts" && !!document.querySelector("#alert-form"));
        await p.fill("#alert-form input[name=above]", "77.5");
        await p.goForward();
        await p.waitForFunction(() => document.title === "News | Watchlist");
      },
    );
    check("back to a page after forward and back again puts back what was typed there", again.id === "SOLR" && again.above === "77.5", JSON.stringify(again));
    // An entry the runtime did not make (a link to a place on the page) shows the same page, so
    // what was typed is recorded under it when a link leaves it.
    const placed = await typedThrough(
      (route) => route.fallback(),
      async (p) => {
        await p.evaluate(() => {
          const to = document.createElement("a");
          to.id = "to-form";
          to.href = "#alert-form";
          to.textContent = "To the form";
          /** @type {Element} */ (document.querySelector("main")).append(to);
        });
        await p.click("#to-form");
        await p.waitForFunction(() => location.hash === "#alert-form");
        await toNewsPlain(p);
      },
    );
    check("back to a place on a page after a link puts back what was typed there", placed.id === "SOLR" && placed.above === "123.45", JSON.stringify(placed));
    // Back while a link's page is on its way redraws the page on screen with what was typed.
    const early = await typedThrough(
      async (route) => {
        await new Promise((done) => setTimeout(done, 1500));
        await route.fallback().catch(() => {});
      },
      async (p) => {
        await p.click('header nav a[href="/news"]');
        await p.waitForFunction(() => location.pathname === "/news");
      },
    );
    check("back before a link's page arrives keeps what was typed", early.id === "SOLR" && early.above === "123.45", JSON.stringify(early));
    // A field the server now draws as another kind (a password) is not given what was typed.
    const kindPage = await changed((body, nth) => (nth ? body.replace(/(name="above"[^>]*?)type="text"|type="text"([^>]*?name="above")/, (m) => m.replace('type="text"', 'type="password"')) : body));
    /** @type {string[]} */
    const kindErrors = [];
    kindPage.on("pageerror", (e) => kindErrors.push(e.message));
    const kindBack = await typeAndBack(kindPage);
    const kind = await kindPage.evaluate(() => document.querySelector("#alert-form input[name=above]")?.getAttribute("type"));
    check("back to a page leaves a field the server now draws as another kind empty", kind === "password" && kindBack.id === "SOLR" && kindBack.above === "" && !kindErrors.length, JSON.stringify({ kind, ...kindBack, kindErrors }));
    await kindPage.context().close();
  } else {
    for (const name of [
      "back to a page the runtime swapped in puts back what the user typed and chose there",
      'back to a page puts back its fields but one autocomplete="off" marks',
      "back to a page leaves a field the server now draws otherwise as the server draws it",
      'back to a page puts back no field of a form marked autocomplete="off"',
      "back to a page puts back its fields but a password",
      "back to a page puts back a checkbox and a radio, and leaves a select whose options changed and a checkbox whose value changed as the server draws them",
      "back to a page puts back no file, the other fields before the page's elements connect",
      "back to a page puts back what the user chose and not a value a script set",
      "back to a page puts back a value a script set and dispatched input and change for",
      "back to a page puts back what was typed in a form with a control named getAttribute",
      "back to a page puts back what was typed in more fields than are looked up one by one",
      "back to a page puts back what was typed there after a link the server sent elsewhere",
      "back to a page puts back what was typed there after a link that redirected",
      "back to a page puts back what was typed there after a second link followed before the first page arrived",
      "back to a page after forward and back again puts back what was typed there",
      "back to a place on a page after a link puts back what was typed there",
      "back before a link's page arrives keeps what was typed",
      "back to a page leaves a field the server now draws as another kind empty",
    ])
      skip(name, noSwaps);
  }
  // The submit failed on purpose above; the browser logs that request.
  const unexpected = errors.filter((e) => !e.includes("ERR_INTERNET_DISCONNECTED"));
  check("no console errors", unexpected.length === 0, unexpected.join(" | "));
  errors.length = 0;
}
