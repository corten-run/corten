import { base, check } from "./helpers.mjs";

export async function sortTable(page, tab) {
  // The month's sales sort in place by the header clicked, by a numeric or text ref value when
  // given, otherwise by the cell's text. The second click reverses the order, with no request.
  const sales = page.locator("table", { has: page.locator("caption", { hasText: "This month's last sales" }) });
  const sortedBy = async () => ({
    buyers: (await sales.locator("tbody td:nth-child(2)").allTextContents()).join("|"),
    sort: await sales.locator("thead th").evaluateAll((ths) => ths.map((th) => th.getAttribute("aria-sort") ?? "").join()),
  });
  let sortRequests = 0;
  /** @param {import("@playwright/test").Request} r */
  const countSort = (r) => void (new URL(r.url()).searchParams.has("sold") && sortRequests++);
  page.on("request", countSort);
  const unsorted = page.url();
  const sortOrders = [];
  for (const name of ["Price", "Price", "Buyer", "Sold"]) {
    await sales.getByRole("link", { name }).click();
    sortOrders.push(await sortedBy());
  }
  page.off("request", countSort);
  const sortWant = [
    { buyers: "Alan Turing|Grace Hopper|Ada Lovelace", sort: ",,,,ascending" },
    { buyers: "Ada Lovelace|Grace Hopper|Alan Turing", sort: ",,,,descending" },
    { buyers: "Ada Lovelace|Alan Turing|Grace Hopper", sort: ",ascending,,," },
    { buyers: "Grace Hopper|Alan Turing|Ada Lovelace", sort: "ascending,,,," },
  ];
  check(
    "a sort header sorts in place by ref value or cell text, reverses on a second click, and moves aria-sort, with no request",
    JSON.stringify(sortOrders) === JSON.stringify(sortWant) && sortRequests === 0,
    `${JSON.stringify(sortOrders)} ${sortRequests} request(s)`,
  );
  // The address is the page sorted as shown (in place of its history entry), and each header's link
  // the page its next click gives, so a reload shows the order on screen.
  const sortLinks = await sales.locator("thead th a").evaluateAll((links) => links.map((a) => new URL(/** @type {HTMLAnchorElement} */ (a).href).searchParams.get("sold")).join());
  check(
    "a sort in place puts its order in the address and each header's next order in its link",
    new URL(page.url()).searchParams.get("sold") === "day" && new URL(unsorted).pathname === new URL(page.url()).pathname && sortLinks === "day_down,buyer,price",
    `${page.url()} ${sortLinks}`,
  );
  // A write redraws a layout part containing a live region in place. Its retained anchors
  // get new sort routes without another connect, even if a sort already rewrote their hrefs.
  {
    const redraw = await page.context().newPage();
    let version = 0;
    await redraw.route((url) => url.pathname === "/" || url.pathname === "/sort-redraw", async (route) => {
      const request = route.request();
      const fresh = request.method() === "POST";
      if (fresh) version++;
      const res = await route.fetch({
        url: fresh ? `${base}/?sold=${version === 1 ? "buyer" : "buyer_down"}` : request.url(),
        method: "GET",
        headers: { "accept-encoding": "identity", ...(fresh ? { corten: "page" } : {}) },
      });
      const headers = res.headers();
      delete headers["content-encoding"];
      delete headers["content-length"];
      let body = await res.text();
      const at = body.search(/<table[^>]*>\s*<caption>This month/);
      const end = body.indexOf("</table>", at) + "</table>".length;
      let table = body.slice(at, end);
      if (fresh) table = table.replaceAll("sold=", "order=");
      // Invert what the two route tokens mean, without changing either URL or the first ref.
      if (fresh && version === 3) table = table.replace('aria-sort="descending"', 'aria-sort="ascending"');
      const ordered = /click:([\w.]+)\.sort\(/.exec(table)?.[1]?.replace(/rows$/, "ordered");
      const id = /<table\b[^>]*\bid="([^"]+)"/.exec(table)?.[1];
      if (!ordered || !id) throw new Error("missing sales table handlers or id");
      const ids = `[&quot;${id}&quot;]`;
      const layout =
        `<div id="sort-layout"><p role="status">Sort layout ${fresh ? version : 0}</p>${table}` +
        `<form id="order-send" method="post" action="/keep-order" data-on="submit:${ordered}.send($e,$t,${ids})"><button>Send order</button></form>` +
        `<a id="order-link" href="/keep-order" data-no-prefetch data-on="connect:${ordered}.link($t,${ids},$s)">Open order</a></div>`;
      body = `${body.slice(0, at)}${body.slice(end)}`.replace(
        /<main\b[^>]*>/,
        (main) => `${layout}${main}<form method="post" action="/sort-redraw" data-patch><button>Redraw layout</button></form>`,
      );
      await route.fulfill({ status: res.status(), headers, body });
    });
    await redraw.goto(`${base}/`);
    const layout = redraw.locator("#sort-layout");
    // Rewrite the links but put the rows back in their drawn order before the layout redraw.
    const sold = layout.getByRole("link", { name: "Sold" });
    await sold.click();
    await sold.click();
    const rewritten = (await sold.getAttribute("href")) === `${base}/?sold=day_down`;
    const buyer = layout.getByRole("link", { name: "Buyer" });
    const retained = await buyer.elementHandle();
    const draw = async (n) => {
      await redraw.getByRole("button", { name: "Redraw layout" }).click();
      await layout.getByText(`Sort layout ${n}`, { exact: true }).waitFor();
    };
    await draw(1);
    const same = await buyer.evaluate((link, old) => link === old, retained);
    const newHref = await buyer.getAttribute("href");
    await redraw.evaluate(() => history.replaceState(history.state, "", "/?sold=filter&order=buyer"));
    const sent = await layout.locator("#order-send").evaluate((form) => {
      form.addEventListener("submit", (event) => event.preventDefault(), { once: true });
      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      return form.getAttribute("action");
    });
    const orderedLink = layout.locator("#order-link");
    await orderedLink.focus();
    const opened = await orderedLink.getAttribute("href");
    check(
      "a retained sort header supplies redrawn routes to ordered forms and links",
      rewritten && same && newHref === "/?order=buyer_down" && sent === "/keep-order?order=buyer" && opened === sent,
      JSON.stringify({ rewritten, same, newHref, sent, opened }),
    );
    await buyer.click();
    const after = new URL(redraw.url()).searchParams;
    const buyers = (await layout.locator("tbody td:nth-child(2)").allTextContents()).join("|");
    const next = new URL((await buyer.getAttribute("href")) ?? "", redraw.url());
    check(
      "a retained sort header uses its redrawn routes for the next in-place sort",
      same && after.get("order") === "buyer_down" && after.get("sold") === "filter" && next.searchParams.get("order") === "buyer" && buyers === "Grace Hopper|Alan Turing|Ada Lovelace",
      `${redraw.url()} ${next.href} ${buyers}`,
    );

    await draw(2);
    const readBuyer = () => buyer.evaluate((link) => ({
      href: link.getAttribute("href"),
      alternate: link.getAttribute("data-ref-value"),
      first: link.getAttribute("data-ref"),
      sort: link.parentElement?.getAttribute("aria-sort"),
    }));
    const beforeFlip = await readBuyer();
    // The ordered link reads and caches the current pair without rewriting the sort header.
    await orderedLink.focus();
    await draw(3);
    const afterFlip = await readBuyer();
    const kept = await buyer.evaluate((link, old) => link === old, retained);
    await buyer.click();
    const sorted = new URL(redraw.url()).searchParams;
    const nextAfterFlip = new URL((await buyer.getAttribute("href")) ?? "", redraw.url());
    check(
      "a retained sort header reinterprets unchanged routes when only aria-sort flips",
      kept && beforeFlip.sort === "descending" && afterFlip.sort === "ascending" &&
        beforeFlip.href === "/?order=buyer" && afterFlip.href === beforeFlip.href &&
        beforeFlip.alternate === '"/?order=buyer_down"' && afterFlip.alternate === beforeFlip.alternate &&
        beforeFlip.first !== null && afterFlip.first === beforeFlip.first &&
        (await readBuyer()).sort === "descending" && sorted.get("order") === "buyer" &&
        nextAfterFlip.searchParams.get("order") === "buyer_down",
      JSON.stringify({ kept, beforeFlip, afterFlip, sorted: redraw.url(), next: nextAfterFlip.href }),
    );
    await redraw.close();
  }
  // A part of the page that reads itself again from its own route (ReadAgain::from, here put
  // around the table on its way from the server) reads the order a sort in place gave: its read's
  // address takes the sort's key and keeps its own. A part that does not hold the table is left.
  {
    const partPage = await page.context().newPage();
    await partPage.route(
      (url) => url.href === unsorted,
      async (route) => {
        const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
        const headers = res.headers();
        delete headers["content-encoding"];
        delete headers["content-length"];
        let body = await res.text();
        const at = body.search(/<table[^>]*>\s*<caption>This month/);
        const end = body.indexOf("</table>", at) + "</table>".length;
        body = `${body.slice(0, at)}<template data-corten-read-again="3" data-from="/sales-part?after=r1"></template><div id="sales-part">${body.slice(at, end)}</div>${body.slice(end)}`;
        body = body.replace(/(<main\b[^>]*>)/, '$1<div><template data-corten-read-again="3" data-from="/other-part?after=r2"></template><div id="other-part"></div></div>');
        await route.fulfill({ status: res.status(), headers, body });
      },
    );
    /** @type {string[]} */
    const partReads = [];
    await partPage.route(
      (url) => url.pathname === "/sales-part" || url.pathname === "/other-part",
      async (route) => {
        const url = new URL(route.request().url());
        partReads.push(`${url.pathname}?${url.searchParams}`);
        // The sales part's first answer asks again, as a route that writes the order it read into
        // its next ReadAgain::from does. Its second, slow, asks again in the order it read, which a
        // sort while it is on its way has changed; the next answers ask nothing.
        const sales = url.pathname === "/sales-part";
        const after = url.searchParams.get("after");
        let body = "";
        if (sales && after === "r1") body = '<template data-corten-read-again="2" data-from="/sales-part?sold=price&amp;after=r2"></template>';
        else if (sales && after === "r2" && url.searchParams.get("sold") === "buyer") {
          await new Promise((done) => setTimeout(done, 1500));
          body = '<template data-corten-read-again="2" data-from="/sales-part?sold=buyer&amp;after=r3"></template>';
        }
        await route.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "corten-patch": "1" }, body }).catch(() => {});
      },
    );
    await partPage.goto(unsorted);
    const partSales = partPage.locator("table", { has: partPage.locator("caption", { hasText: "This month's last sales" }) });
    await partSales.getByRole("link", { name: "Price" }).click();
    for (let i = 0; i < 60 && partReads.length < 2; i++) await partPage.waitForTimeout(100);
    const first = [...partReads].sort().join(" ");
    // A sort after the part's first read is kept in the read the part's answer asked for, whose tag
    // took the old one's place.
    await partPage.waitForFunction(() => document.querySelector('main template[data-from^="/sales-part"]')?.getAttribute("data-from")?.includes("after=r2"), null, { timeout: 3000 });
    const tags = await partPage.evaluate(() => Array.from(document.querySelectorAll('main template[data-from^="/sales-part"]'), (t) => t.getAttribute("data-from")));
    await partSales.getByRole("link", { name: "Buyer" }).click();
    for (let i = 0; i < 60 && partReads.length < 3; i++) await partPage.waitForTimeout(100);
    // A sort while that read is on its way: its answer, drawn in the old order, is dropped and the
    // part read again in the new one.
    await partSales.getByRole("link", { name: "Sold" }).click();
    const day = new URL(partPage.url()).searchParams.get("sold");
    for (let i = 0; i < 60 && partReads.length < 4; i++) await partPage.waitForTimeout(100);
    check(
      "a part read again from its own route reads the order a sort in place gave",
      first === "/other-part?after=r2 /sales-part?sold=price&after=r1",
      first,
    );
    check(
      "a part's next read, which its answer asked for, reads the order a later sort gave",
      tags.length === 1 && partReads[2] === "/sales-part?sold=buyer&after=r2",
      `${JSON.stringify(tags)} ${partReads.join(" ")}`,
    );
    check(
      "a part's read whose order a sort changed while it was on its way is read again in that order",
      !!day && day !== "buyer" && partReads[3] === `/sales-part?sold=${day}&after=r2`,
      `${day} ${partReads.join(" ")}`,
    );
    await partPage.close();
  }
  // A form in such a part whose answer brings the part's next read (`ReadAgain::from` in the
  // patch): a sort before the form is in where the form sends, and one after it in the read its
  // answer asked for, whose tag took the part's in the page.
  {
    const formPage = await page.context().newPage();
    await formPage.route(
      (url) => url.href === unsorted,
      async (route) => {
        const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
        const headers = res.headers();
        delete headers["content-encoding"];
        delete headers["content-length"];
        let body = await res.text();
        const at = body.search(/<table[^>]*>\s*<caption>This month/);
        const end = body.indexOf("</table>", at) + "</table>".length;
        const form = '<form id="refresh-sales" method="post" action="/sales-refresh?shop=a&amp;sold=day" data-patch><button>Refresh</button><button formaction="/sales-refresh?shop=b">Other shop</button></form>';
        const get = '<form id="find-sales" action="/sales-find?q=a"><button>Find</button></form>';
        // The part is the elements with an id beside its tag: the form, a GET form and the table.
        body = `${body.slice(0, at)}<template data-corten-read-again="60" data-from="/sales-part?after=r1"></template>${form}${get}<div id="sales-part">${body.slice(at, end)}</div>${body.slice(end)}`;
        await route.fulfill({ status: res.status(), headers, body });
      },
    );
    /** @type {string[]} */
    const sent = [];
    await formPage.route(
      (url) => url.pathname === "/sales-refresh" || url.pathname === "/sales-part",
      async (route) => {
        const url = new URL(route.request().url());
        sent.push(`${route.request().method()} ${url.pathname}?${url.searchParams}`);
        // The form's answer: the part's form drawn again and its next read, in the order it was sent.
        const body =
          url.pathname === "/sales-refresh"
            ? `<form id="refresh-sales" method="post" action="/sales-refresh?${url.searchParams.toString().replaceAll("&", "&amp;")}" data-patch><button>Refresh</button></form><template data-from="/sales-part?${url.searchParams.toString().replaceAll("&", "&amp;")}&amp;after=f1" data-corten-read-again="2"></template>`
            : "";
        await route.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "corten-patch": "1" }, body }).catch(() => {});
      },
    );
    await formPage.goto(unsorted);
    const formSales = formPage.locator("table", { has: formPage.locator("caption", { hasText: "This month's last sales" }) });
    await formSales.getByRole("link", { name: "Price" }).click();
    const sends = await formPage.evaluate(() => ({
      action: document.querySelector("#refresh-sales")?.getAttribute("action"),
      formaction: document.querySelector("#refresh-sales button[formaction]")?.getAttribute("formaction"),
      get: document.querySelector("#find-sales")?.getAttribute("action"),
    }));
    await formPage.getByRole("button", { name: "Refresh" }).click();
    await formPage.waitForFunction(() => document.querySelectorAll('main template[data-from*="after=f1"]').length === 1, null, { timeout: 3000 });
    const tags = await formPage.evaluate(() => Array.from(document.querySelectorAll('main template[data-from^="/sales-part"]'), (t) => t.getAttribute("data-from")));
    await formSales.getByRole("link", { name: "Buyer" }).click();
    for (let i = 0; i < 40 && !sent.some((s) => s.startsWith("GET /sales-part")); i++) await formPage.waitForTimeout(100);
    check(
      "a sort in place puts its order where a form in a part read again sends, not a GET form's",
      sends.action === "/sales-refresh?sold=price&shop=a" && sends.formaction === "/sales-refresh?sold=price&shop=b" && sends.get === "/sales-find?q=a",
      JSON.stringify(sends),
    );
    check(
      "a part's next read a form's answer brings takes the part's tag and reads the order a later sort gave",
      sent[0] === "POST /sales-refresh?sold=price&shop=a" && tags.length === 1 && sent.includes("GET /sales-part?sold=buyer&shop=a&after=f1"),
      `${JSON.stringify(tags)} ${sent.join(" ")}`,
    );
    await formPage.close();
  }
  // A form or link elsewhere on the page whose route reads the table's order (the port's Refresh
  // supply, beside the table, which redirects back) calls `ordered::send` with the table's id, and
  // sends or goes to the order on screen when it is sent or clicked: also when the page is in its
  // default order and the address has none of the keys, through a submit button of its own or
  // one outside it (`form=`), and after a patch drew it again. A form or link without the call (a
  // reset to the default order), a link naming no table and a link without `href`
  // are left. A GET form's hidden inputs (`keep_query`'s) take the order instead, and a sort key
  // a control the user sees sends is left to it.
  {
    const outside = await page.context().newPage();
    /** @type {string[]} */
    const outsideErrors = [];
    outside.on("console", (m) => m.type() === "error" && outsideErrors.push(m.text()));
    await outside.route(
      (url) => url.href === unsorted,
      async (route) => {
        const res = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
        const headers = res.headers();
        delete headers["content-encoding"];
        delete headers["content-length"];
        let body = await res.text();
        // The rows module as the page's own sort links name it in `data-on`.
        const rows = /(?:data-on='| )click:([\w.]+)\.sort\(/.exec(body)?.[1];
        if (!rows) throw new Error("no rows::sort call on the page");
        const ordered = rows.replace(/rows$/, "ordered");
        const list = (/** @type {string[]} */ ids) => `[${ids.map((id) => `&quot;${id}&quot;`).join(",")}]`;
        const on = (/** @type {string} */ type, /** @type {string[]} */ ids) => `data-on="${type}:${ordered}.send($e,$t,${list(ids)})"`;
        const linked = (/** @type {string[]} */ ids) => `data-on="connect:${ordered}.link($t,${list(ids)},$s)"`;
        const at = body.search(/<table[^>]*>\s*<caption>This month/);
        const end = body.indexOf("</table>", at) + "</table>".length;
        const forms =
          `<form id="supply" method="post" action="/sales-supply?shop=a" ${on("submit", ["sales-box"])}><input type="hidden" name="method" value="x"><button>Refresh supply</button><button formaction="/sales-supply?shop=b">Other shop</button></form>` +
          '<button form="supply" formaction="/sales-supply?shop=c">Outside</button>' +
          `<form id="cancel" method="post" action="/sales-cancel?shop=a&amp;sold=day" ${on("submit", ["sales-box"])}><button>Cancel</button></form>` +
          '<form id="reset" method="post" action="/sales-reset?shop=a&amp;sold=day"><button>Reset</button></form>' +
          `<form id="find" action="/sales-find?q=a&amp;sold=day" ${on("submit", ["sales-box"])}><button>Find</button></form>` +
          // A GET form carrying the page's query in hidden inputs (`keep_query`), and one whose
          // sort key is a control the user sees.
          `<form id="source" method="get" action="/sales-source" ${on("submit", ["sales-box"])}><select name="src"><option>1</option></select><input type="hidden" name="elements" value="x"><input type="hidden" name="sold" value="day"><input type="hidden" name="shop" value="a"><button>Source</button></form>` +
          `<form id="pick" method="get" action="/sales-pick" ${on("submit", ["sales-box"])}><select name="sold"><option>buyer</option></select><button>Pick</button></form>` +
          `<a id="back" href="/sales-back?shop=a&amp;sold=day&amp;src=2#rows" ${linked(["other-table", "sales-box"])}>Previous</a> ` +
          `<a id="mid" href="/sales-back?src=3" ${linked(["sales-box"])}>Middle</a> ` +
          `<form id="far" method="get" action="https://example.com/far" ${on("submit", ["sales-box"])}><input type="hidden" name="sold" value="day"><button>Far</button></form>` +
          `<a id="away" href="/sales-back?sold=day" ${linked(["find"])}>Away</a> <a id="bare" ${linked(["sales-box"])}>Bare</a>` +
          // An image map's link is a link too.
          `<map name="sales-map"><area id="mapped" shape="rect" coords="0,0,10,10" href="/sales-back?src=4" alt="Mapped" ${linked(["sales-box"])}></map>` +
          // An element that is not a link, which the compiler cannot refuse to a pager's handler.
          `<span id="unlinked" ${linked(["sales-box"])}>Not a link</span>`;
        // The wrapper holds a table without sort links first: the sorted one is still found.
        body = `${body.slice(0, at)}${forms}<div id="sales-box"><table><thead><tr><th>Plain</th></tr></thead></table>${body.slice(at, end)}</div>${body.slice(end)}`;
        await route.fulfill({ status: res.status(), headers, body });
      },
    );
    /** @type {string[]} */
    const sentTo = [];
    for (const path of ["/sales-supply", "/sales-back", "/sales-source"])
      await outside.route(
        (url) => url.pathname === path,
        async (route) => {
          sentTo.push(`${path}${new URL(route.request().url()).search}`);
          await route.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: "<!doctype html><title>Sent</title><main>Sent</main>" });
        },
      );
    // Where each submit or click goes, read after the page's handlers ran, and kept from going.
    const record = () =>
      outside.evaluate(() => {
        /** @type {(string | null)[]} */
        const seen = [];
        /** @type {any} */ (window).seen = seen;
        addEventListener("submit", (event) => {
          const submitter = /** @type {SubmitEvent} */ (event).submitter;
          const form = /** @type {HTMLFormElement} */ (event.target);
          const to = submitter?.getAttribute("formaction") ?? Element.prototype.getAttribute.call(form, "action");
          // A GET form's address is its fields.
          const fields = new URLSearchParams(/** @type {any} */ (new FormData(form, submitter)));
          seen.push(Element.prototype.getAttribute.call(form, "method") !== "post" ? `${to} ${[...fields].map(([k, v]) => `${k}=${v}`).sort().join("&")}` : to);
          event.preventDefault();
        });
        for (const type of ["click", "auxclick"])
          addEventListener(type, (event) => {
            const a = event.target instanceof Element ? event.target.closest("a") : null;
            if (!a || a.closest("table")) return;
            seen.push(a.getAttribute("href"));
            event.preventDefault();
          });
      });
    const seen = () => outside.evaluate(() => /** @type {any} */ (window).seen);
    await outside.goto(unsorted);
    await record();
    await outside.getByRole("button", { name: "Cancel" }).click();
    await outside.getByRole("button", { name: "Source" }).click();
    const unsortedSeen = await seen();
    await outside.locator("table", { has: outside.locator("caption", { hasText: "This month's last sales" }) }).getByRole("link", { name: "Price" }).click();
    for (const name of ["Refresh supply", "Other shop", "Outside", "Reset", "Find", "Source", "Pick", "Far"]) await outside.getByRole("button", { name, exact: true }).click();
    for (const name of ["Previous", "Away", "Bare"]) await outside.getByText(name, { exact: true }).click();
    const sortedSeen = await seen();
    await outside.getByText("Middle", { exact: true }).click({ button: "middle" });
    const middle = (await seen()).slice(sortedSeen.length);
    const bare = await outside.evaluate(() => document.getElementById("bare")?.hasAttribute("href"));
    const mapped = await outside.evaluate(() => {
      const area = document.getElementById("mapped");
      area?.dispatchEvent(new PointerEvent("pointerover"));
      return area?.getAttribute("href");
    });
    // Each submit above was cancelled: a GET form's listener ended with its submit's task, so a
    // list of its fields made later reads its hidden input as drawn.
    const later = await outside.evaluate(() => new FormData(/** @type {HTMLFormElement} */ (document.getElementById("source"))).get("sold"));
    check("a cancelled GET submit leaves no listener on the form: a later read of its fields is as drawn", later === "day", String(later));
    check(
      "a form, a submit button or a link elsewhere that calls ordered::send sends the order on screen when it is sent, and the others are left",
      JSON.stringify(unsortedSeen) === JSON.stringify(["/sales-cancel?shop=a", "/sales-source elements=x&shop=a&src=1"]) &&
        JSON.stringify(sortedSeen) ===
          JSON.stringify([
            "/sales-cancel?shop=a",
            "/sales-source elements=x&shop=a&src=1",
            "/sales-supply?shop=a&sold=price",
            "/sales-supply?shop=b&sold=price",
            "/sales-supply?shop=c&sold=price",
            "/sales-reset?shop=a&sold=day",
            "/sales-find?q=a&sold=day sold=price",
            "/sales-source elements=x&shop=a&sold=price&src=1",
            "/sales-pick sold=buyer",
            "https://example.com/far sold=day",
            "/sales-back?shop=a&src=2&sold=price#rows",
            "/sales-back?sold=day",
            null,
          ]) &&
        bare === false &&
        mapped === "/sales-back?src=4&sold=price" &&
        middle.length > 0 &&
        middle.every((to) => to === "/sales-back?src=3&sold=price"),
      `${JSON.stringify(unsortedSeen)} ${JSON.stringify(sortedSeen)} bare href ${bare} area ${mapped} middle ${JSON.stringify(middle)}`,
    );
    // Drawn again after the sort (as a patch does), the form still sends the order, and the
    // browser goes there. (The runtime may have fetched a link above as a navigation.)
    await outside.goto(unsorted);
    sentTo.length = 0;
    await outside.locator("table", { has: outside.locator("caption", { hasText: "This month's last sales" }) }).getByRole("link", { name: "Price" }).click();
    await outside.evaluate(() => {
      const form = /** @type {HTMLFormElement} */ (document.getElementById("supply"));
      const again = /** @type {HTMLFormElement} */ (form.cloneNode(true));
      form.replaceWith(again);
    });
    await outside.getByRole("button", { name: "Refresh supply" }).click();
    for (let i = 0; i < 40 && !sentTo.length; i++) await outside.waitForTimeout(100);
    const posted = sentTo.splice(0);
    // The browser goes on to the answer; the next `goto` would abort that navigation, or race it.
    const landed = async () => {
      await outside.getByText("Sent", { exact: true }).waitFor();
      await outside.waitForLoadState("load");
      sentTo.length = 0;
    };
    await landed();
    await outside.goto(unsorted);
    await outside.locator("table", { has: outside.locator("caption", { hasText: "This month's last sales" }) }).getByRole("link", { name: "Price" }).click();
    await outside.getByText("Previous", { exact: true }).click();
    for (let i = 0; i < 40 && !sentTo.length; i++) await outside.waitForTimeout(100);
    const followed = sentTo.splice(0);
    await landed();
    // A GET form the browser really sends (its hidden inputs as drawn) sends the order on screen.
    await outside.goto(unsorted);
    await outside.locator("table", { has: outside.locator("caption", { hasText: "This month's last sales" }) }).getByRole("link", { name: "Price" }).click();
    // A later handler that reads the form's fields and lets the submit go on does not take the
    // order from what the browser sends.
    await outside.evaluate(() => document.addEventListener("submit", (e) => void new FormData(/** @type {HTMLFormElement} */ (e.target))));
    await outside.getByRole("button", { name: "Source", exact: true }).click();
    await outside.getByText("Sent", { exact: true }).waitFor();
    await outside.waitForLoadState("load");
    const gotten = sentTo.splice(0).map((to) => to.split(/[?&]/).sort().join(" "));
    check(
      "a GET form the browser sends carries the order on screen in place of its hidden input's, with another handler reading its fields",
      // The runtime fetches it first, then loads the answer, which is not one of its pages, in full.
      gotten.length > 0 && gotten.length <= 2 && gotten.every((to) => to === "/sales-source elements=x shop=a sold=price src=1"),
      JSON.stringify(gotten),
    );
    // A hover prefetches a link's page: with the order on screen, so the click can use it; and its
    // menu ("Copy link") reads the order on screen too.
    await outside.goto(unsorted);
    await outside.locator("table", { has: outside.locator("caption", { hasText: "This month's last sales" }) }).getByRole("link", { name: "Price" }).click();
    sentTo.length = 0;
    await outside.getByText("Previous", { exact: true }).hover();
    for (let i = 0; i < 20 && !sentTo.length; i++) await outside.waitForTimeout(100);
    const hovered = sentTo.splice(0);
    await outside.getByText("Middle", { exact: true }).click({ button: "right" });
    const menuHref = await outside.evaluate(() => document.getElementById("mid")?.getAttribute("href"));
    await outside.keyboard.press("Escape");
    check(
      "a link that calls ordered::link has the order on screen when hovered, so its prefetch is the page it opens, and when its menu opens",
      hovered.length > 0 && hovered.every((to) => to === "/sales-back?shop=a&src=2&sold=price") && menuHref === "/sales-back?src=3&sold=price",
      `${JSON.stringify(hovered)} ${menuHref}`,
    );
    // By the keyboard: a later sort, then the link focused and opened with Enter, no pointer on it.
    await outside.locator("table", { has: outside.locator("caption", { hasText: "This month's last sales" }) }).getByRole("link", { name: "Buyer" }).click();
    await outside.mouse.move(0, 0);
    sentTo.length = 0;
    const previous = outside.getByText("Previous", { exact: true });
    await previous.focus();
    const focusedHref = await previous.getAttribute("href");
    await previous.press("Enter");
    for (let i = 0; i < 40 && !sentTo.length; i++) await outside.waitForTimeout(100);
    const entered = sentTo.splice(0);
    check(
      "a link that calls ordered::link has the order on screen when focused, and opened with Enter goes to it",
      focusedHref === "/sales-back?shop=a&src=2&sold=buyer#rows" && entered[0] === "/sales-back?shop=a&src=2&sold=buyer",
      `${focusedHref} ${JSON.stringify(entered)}`,
    );
    sentTo.splice(0, sentTo.length, ...followed);
    check(
      "a form drawn again after a sort posts the order on screen, and a link goes to it",
      JSON.stringify(posted) === JSON.stringify(["/sales-supply?shop=a&sold=price"]) && sentTo[0] === "/sales-back?shop=a&src=2&sold=price",
      `${posted.join(" ")} ${sentTo.join(" ")}`,
    );
    check(
      // Once each time the element joins the page, and this page is loaded several times.
      "ordered::link on an element that is not a link says so in the console",
      outsideErrors.some((text) => text.includes("corten-ui: ordered::link keeps the order in a link's href; this element is not a link")),
      JSON.stringify(outsideErrors),
    );
    await outside.close();
  }
  await sales.getByRole("link", { name: "Price" }).click();
  // The gallery's own link beside the table (ordered::link, from its markup) takes the order.
  {
    const share = page.getByRole("link", { name: "Link to this order" });
    await share.hover();
    const href = await share.getAttribute("href");
    check("a link in the page's markup that calls ordered::link carries the order a sort in place gave", new URL(href ?? "", page.url()).searchParams.get("sold") === "price", String(href));
  }
  const shownBeforeReload = await sortedBy();
  await page.reload();
  check("a reload after a sort in place shows the order on screen", JSON.stringify(await sortedBy()) === JSON.stringify(shownBeforeReload), `${JSON.stringify(shownBeforeReload)} -> ${JSON.stringify(await sortedBy())}`);
  // The kit's pager under the table takes the same call as `on:link`, on each link it draws
  // (#1107): after a sort in place, its Earlier sales link opens the earlier page in the order on
  // screen, and after another sort in place there, that page's Later sales link comes back in it.
  {
    const salesTable = (/** @type {string} */ caption) => page.locator("table", { has: page.locator("caption", { hasText: caption }) });
    await salesTable("This month's last sales").getByRole("link", { name: "Buyer" }).click();
    const pager = page.getByRole("navigation", { name: "Sales pages" });
    const marks = await pager.evaluate((nav) => Array.from(nav.querySelectorAll("li > *"), (el) => `${el.localName} ${el.hasAttribute("data-on")}`).join(", "));
    const earlier = pager.getByRole("link", { name: "Earlier sales" });
    await earlier.hover();
    const href = await earlier.getAttribute("href");
    await earlier.click();
    await page.getByText("This month's earlier sales, sorted among themselves", { exact: true }).waitFor();
    const there = new URL(page.url()).searchParams;
    const buyers = await salesTable("This month's earlier sales").locator("tbody tr td:nth-child(2)").allTextContents();
    check(
      "a kit pager's link that calls ordered::link (on:link) opens its page in the order a sort in place gave, and its disabled end has no handler",
      marks === "span false, a true" &&
        new URL(href ?? "", page.url()).searchParams.get("sold") === "buyer" &&
        there.get("sold") === "buyer" &&
        there.get("sales") === "earlier" &&
        JSON.stringify(buyers) === JSON.stringify(["Barbara Liskov", "Edsger Dijkstra", "Katherine Johnson"]),
      `${marks} ${href} ${page.url()} ${JSON.stringify(buyers)}`,
    );
    await salesTable("This month's earlier sales").getByRole("link", { name: "Price" }).click();
    await page.getByRole("navigation", { name: "Sales pages" }).getByRole("link", { name: "Later sales" }).click();
    await page.getByText("This month's last sales, sorted among themselves", { exact: true }).waitFor();
    const back = new URL(page.url()).searchParams;
    check("the earlier page's Later sales link (PreviousNext's previous) takes a sort in place there too", back.get("sold") === "price" && !back.has("sales"), page.url());
  }
  await page.goto(unsorted);
  // A tab chosen in place since the page came in, and the fragment, stay in the address and the
  // header links: only the key the sort links differ in (`sold`) is taken from them.
  await tab("Offers").click();
  await page.evaluate(() => history.replaceState(history.state, "", `${location.pathname}${location.search}#sales`));
  await sales.getByRole("link", { name: "Buyer" }).click();
  const kept = new URL(page.url());
  const keptLink = new URL(/** @type {string} */ (await sales.getByRole("link", { name: "Price" }).getAttribute("href")), page.url());
  check(
    "a sort in place keeps a tab's key and the fragment in the address and its links",
    kept.searchParams.get("tab") === "offers" && kept.searchParams.get("sold") === "buyer" && kept.hash === "#sales" && keptLink.searchParams.get("tab") === "offers" && keptLink.searchParams.get("sold") === "price",
    `${page.url()} ${keptLink}`,
  );
  await page.goto(unsorted);
  // Tied rows are in the order the page drew them, however earlier clicks left them, as the
  // server's stable sort gives.
  await sales.getByRole("link", { name: "Buyer" }).click();
  const tied = await sales.evaluate((table) => {
    const prices = [...table.querySelectorAll("tbody td:last-child")].map((td) => /** @type {HTMLElement} */ (td));
    const attr = "data-ref-value";
    const was = prices.map((td) => td.getAttribute(attr) ?? "");
    for (const td of prices) td.setAttribute(attr, "5");
    /** @type {HTMLElement} */ (table.querySelector("thead th:last-child a")).click();
    const order = [...table.querySelectorAll("tbody td:nth-child(2)")].map((td) => td.textContent).join("|");
    prices.forEach((td, i) => td.setAttribute(attr, was[i]));
    return order;
  });
  check("tied rows sort in the order the page drew them, not the last click's", tied === "Grace Hopper|Alan Turing|Ada Lovelace", tied);
  await page.goto(unsorted);
  // Replace just Buyer's unsorted header, as a patch can. Its new link must supply its own
  // values, including a first click that goes descending, not use those of the removed link.
  await sales.getByRole("columnheader", { name: "Buyer" }).evaluate((header) => {
    const replacement = /** @type {HTMLTableCellElement} */ (header.cloneNode(true));
    const link = replacement.querySelector("a");
    const ref = link?.getAttribute("data-ref");
    if (!link || !ref) throw new Error("missing sort link or ref");
    const first = link.getAttribute("href");
    link.setAttribute("data-ref", ref.replace(/up$/, "down"));
    link.setAttribute("href", JSON.parse(link.getAttribute("data-ref-value") ?? "null"));
    link.setAttribute("data-ref-value", JSON.stringify(first));
    header.replaceWith(replacement);
  });
  await sales.getByRole("link", { name: "Buyer" }).click();
  const newest = await sortedBy();
  const newestNext = new URL(/** @type {string} */ (await sales.getByRole("link", { name: "Buyer" }).getAttribute("href")), page.url());
  check(
    "a header whose first click sorts descending does so, with the address and its next link to match",
    newest.buyers === "Grace Hopper|Alan Turing|Ada Lovelace" && newest.sort === ",descending,,," && new URL(page.url()).searchParams.get("sold") === "buyer_down" && newestNext.searchParams.get("sold") === "buyer",
    `${JSON.stringify(newest)} ${page.url()} ${newestNext}`,
  );
  await page.goto(`${base}/?sold=price`);
  const wrappedSortStopped = await sales.getByRole("link", { name: "Price" }).evaluate((link) => {
    const span = document.createElement("span");
    link.before(span);
    span.append(link);
    // Observe whether the sort handled the click without letting a regression navigate away.
    let stopped = false;
    window.addEventListener("click", (event) => {
      stopped = event.defaultPrevented;
      event.preventDefault();
    }, { once: true });
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return stopped;
  });
  const wrappedOrder = await sortedBy();
  check(
    "a wrapped sort link reverses the header's order in place and updates the address",
    wrappedSortStopped && wrappedOrder.buyers === "Ada Lovelace|Grace Hopper|Alan Turing" && wrappedOrder.sort === ",,,,descending" && new URL(page.url()).searchParams.get("sold") === "price_down",
    `${wrappedSortStopped} ${JSON.stringify(wrappedOrder)} ${page.url()}`,
  );
  await page.goto(unsorted);
  // A ref-valued link in a table nested in a header cell is that table's, not a sorter of this
  // head: sorting the outer table leaves its address alone.
  const nestedHref = await sales.getByRole("columnheader", { name: "Price" }).evaluate((header) => {
    const source = header.querySelector("a");
    if (!source) throw new Error("missing sort link");
    const inner = document.createElement("table");
    const sorted = document.createElement("th");
    sorted.setAttribute("aria-sort", "ascending");
    inner.createTHead().insertRow().append(sorted);
    const cell = inner.createTBody().insertRow().insertCell();
    const link = /** @type {HTMLAnchorElement} */ (source.cloneNode(true));
    link.textContent = "Nested";
    link.setAttribute("href", "?inner=kept");
    cell.append(link);
    header.append(inner);
    return link.getAttribute("href");
  });
  await sales.getByRole("link", { name: "Buyer" }).click();
  const nestedAfter = await sales.getByRole("link", { name: "Nested" }).getAttribute("href");
  const nestedSort = await sales.locator("thead table th").getAttribute("aria-sort");
  check(
    "a nested table's links and sort are its own, not the outer head's",
    (await sortedBy()).buyers === "Ada Lovelace|Alan Turing|Grace Hopper" && nestedAfter === nestedHref && nestedSort === "ascending",
    `${nestedHref} -> ${nestedAfter} ${nestedSort}`,
  );
  await page.goto(unsorted);
  // A handler still wired to an old or misconfigured kit must not partially sort in place.
  await sales.locator("thead").evaluate((head) => head.removeAttribute("data-on"));
  const nativeSort = page.waitForRequest((request) => new URL(request.url()).searchParams.get("sold") === "buyer");
  await sales.getByRole("link", { name: "Buyer" }).click();
  await nativeSort;
  await page.waitForURL((url) => url.searchParams.get("sold") === "buyer");
  await sales.locator('th[aria-sort="ascending"]').getByRole("link", { name: "Buyer" }).waitFor();
  check("a sort without its route reader follows the server link", (await sortedBy()).buyers === "Ada Lovelace|Alan Turing|Grace Hopper", page.url());
  await page.goto(unsorted);
  // Numbers as numbers (-10 before -2, where text would put -2 first) and an empty value last; a
  // click with a modifier key is the link's.
  const sortEdges = await sales.evaluate((table) => {
    const prices = [...table.querySelectorAll("tbody td:last-child")].map((td) => /** @type {HTMLElement} */ (td));
    const attr = "data-ref-value";
    const was = prices.map((td) => td.getAttribute(attr) ?? "");
    const blank = [...prices[1].childNodes];
    prices[1].replaceChildren();
    ["-2", "null", "-10"].forEach((v, i) => prices[i].setAttribute(attr, v));
    const link = /** @type {HTMLElement} */ (table.querySelector("thead th:last-child a"));
    // Whether the handler stopped each click, read after it ran; the link is never followed.
    /** @type {boolean[]} */
    const stopped = [];
    const after = (/** @type {Event} */ e) => (stopped.push(e.defaultPrevented), e.preventDefault());
    window.addEventListener("click", after);
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    window.removeEventListener("click", after);
    const order = [...table.querySelectorAll("tbody td:last-child")].map((td) => JSON.parse(td.getAttribute(attr) ?? "null")).join("|");
    prices.forEach((td, i) => td.setAttribute(attr, was[i]));
    prices[1].replaceChildren(...blank);
    return { stopped: stopped.join(), order };
  });
  check(
    "a column of numbers sorts as numbers with an empty value last, and a ctrl-click is left to the link",
    sortEdges.stopped === "false,true" && sortEdges.order === "-10|-2|",
    JSON.stringify(sortEdges),
  );
  await page.goto(unsorted);
  const dateValueOrder = await sales.evaluate((table) => {
    const rows = [...table.tBodies[0].rows];
    const labels = rows.map((row) => [...row.cells[0].childNodes]);
    // Sold starts ascending. Descending display text would leave the rows in the drawn order.
    rows.forEach((row, i) => (row.cells[0].textContent = ["Zulu", "Mike", "Alpha"][i]));
    /** @type {HTMLAnchorElement} */ (table.querySelector("thead th:first-child a")).click();
    rows.forEach((row, i) => row.cells[0].replaceChildren(...labels[i]));
    return [...table.tBodies[0].rows].map((row) => row.cells[1].textContent).join("|");
  });
  check("a text ref value sorts the cell rather than its displayed text", dateValueOrder === "Ada Lovelace|Alan Turing|Grace Hopper", dateValueOrder);
  await page.goto(unsorted);
  // Without a ref value, a cell's one <data value> or <time datetime> is what it sorts by (a date as an
  // instant), not the text the reader sees.
  const sortMachine = await sales.evaluate((table) => {
    const body = table.tBodies[0];
    const rows = [...body.rows];
    const cells = rows.map((row) => row.cells[row.cells.length - 1]);
    const link = /** @type {HTMLElement} */ (table.querySelector("thead th:last-child a"));
    const header = /** @type {HTMLElement} */ (link.closest("th"));
    const heads = [.../** @type {HTMLTableSectionElement} */ (table.tHead).rows[0].cells];
    const arias = heads.map((th) => th.getAttribute("aria-sort"));
    const stop = (/** @type {Event} */ e) => e.preventDefault();
    window.addEventListener("click", stop);
    // Built with the DOM: the page requires Trusted Types for HTML.
    let current = cells;
    const run = (/** @type {[string | null, string, string, string?][]} */ parts) => {
      current = current.map((old, i) => {
        const [tag, value, text, refValue] = parts[i];
        const td = /** @type {HTMLTableCellElement} */ (cells[i].cloneNode(false));
        if (refValue !== undefined) {
          td.setAttribute("data-ref-value", refValue);
        } else {
          td.removeAttribute("data-ref");
          td.removeAttribute("data-ref-value");
        }
        if (tag) {
          const part = document.createElement(tag);
          part.setAttribute(tag === "time" ? "datetime" : "value", value);
          part.textContent = text;
          td.replaceChildren(part);
        } else {
          td.textContent = text;
        }
        old.replaceWith(td);
        return td;
      });
      header.removeAttribute("aria-sort");
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return [...body.rows].map((row) => row.cells[row.cells.length - 1].textContent).join("|");
    };
    // Values whose order as numbers and instants differs from their text's and from their own as
    // text: 12.10 before 12.5 before 80, and 23:00 at -05:00 after 01:00Z the next day.
    const data = run([
      ["data", "12.5", "twelve fifty"],
      ["data", "80", "eighty"],
      ["data", "12.10", "twelve ten"],
    ]);
    const times = run([
      ["time", "2025-12-24T23:00:00-05:00", "Dec 24, 11 PM EST"],
      ["time", "2025-12-25T01:00:00Z", "Dec 25, 1 AM UTC"],
      ["time", "2025-12-01", "Dec 1"],
    ]);
    // Only the last cell has a ref. Its zero beats both its machine value and its text.
    const mixed = run([
      ["data", "10", "-20"],
      [null, "", "5"],
      ["data", "100", "200", "0"],
    ]);
    window.removeEventListener("click", stop);
    current.forEach((td, i) => td.replaceWith(cells[i]));
    for (const row of rows) body.append(row);
    heads.forEach((th, i) => {
      const aria = arias[i];
      if (aria) th.setAttribute("aria-sort", aria);
      else th.removeAttribute("aria-sort");
    });
    return { data, times, mixed };
  });
  check(
    "a cell's <data value> and <time datetime> are what it sorts by, not its text",
    sortMachine.data === "twelve ten|twelve fifty|eighty" && sortMachine.times === "Dec 1|Dec 25, 1 AM UTC|Dec 24, 11 PM EST",
    JSON.stringify(sortMachine),
  );
  check("a zero ref wins over machine value and text, and cells without refs use machine value or text", sortMachine.mixed === "200|5|-20", sortMachine.mixed);
}
