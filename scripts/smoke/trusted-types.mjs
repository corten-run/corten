import { base, check } from "./helpers.mjs";

export async function trustedTypes(page, browser) {
  // Only what the page's own origin answered goes through the runtime's policy: not another
  // origin's answer (one connect-src allows), a Response a script made, or an event a script
  // dispatched. On a page of its own, whose CSP lets it reach the other origin.
  {
    const csp = (await page.request.get(base)).headers()["content-security-policy"] ?? "";
    check("pages require Trusted Types and allow the runtime's, the app's and the script loader's policies", /; require-trusted-types-for 'script'; trusted-types corten smoke default$/.test(csp), csp);
    const other = "http://other.test";
    const probe = await browser.newPage();
    /** @type {string[]} */
    const said = [];
    probe.on("console", (m) => m.type() === "error" && said.push(m.text()));
    let opened = false;
    await probe.route(`${base}/`, async (route) => {
      // The page's own load only: the runtime's read of its picks (`corten: action`) goes as it is.
      if (route.request().headers().corten) return route.continue();
      // Unencoded: Playwright does not decode Firefox's zstd for a fulfilled body.
      const response = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
      const headers = response.headers();
      const csp = headers["content-security-policy"] ?? "";
      headers["content-security-policy"] = csp.replace("connect-src 'self'", `connect-src 'self' ${other}`);
      opened ||= headers["content-security-policy"] !== csp;
      await route.fulfill({ response, headers });
    });
    await probe.route(`${other}/**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        headers: { "access-control-allow-origin": new URL(base).origin, "access-control-allow-headers": "*", "access-control-expose-headers": "corten-patch", "corten-patch": "1" },
        body: '<p id="watch-message">From another origin</p>',
      }),
    );
    await probe.goto(`${base}/`);
    // The stream need not be open (a third stream to this host can wait in Firefox): the checks
    // need only the element's EventSource.
    await probe.waitForFunction(() => /** @type {any} */ (document.querySelector("corten-live"))?.source);
    const logged = probe.waitForEvent("console", { predicate: (m) => m.text().includes("an event a script dispatched"), timeout: 3000 }).catch(() => {});
    const [cross, made, dispatched] = await probe.evaluate(async (other) => {
      const message = () => document.getElementById("watch-message")?.textContent ?? "";
      /** A data-patch form posting to `action`: whether the runtime said it drew nothing, and the message after. @param {string} action */
      const submit = async (action) => {
        const form = document.createElement("form");
        form.method = "post";
        form.action = action;
        form.setAttribute("data-patch", "");
        const button = document.createElement("button");
        form.append(button);
        /** @type {HTMLElement} */ (document.querySelector("main")).append(form);
        // The answer came (200) and was not drawn; a fetch that failed would say status 0.
        const refused = new Promise((resolve) => form.addEventListener("corten:error", (e) => resolve(/** @type {CustomEvent} */ (e).detail.status), { once: true }));
        button.click();
        const said = await Promise.race([refused, new Promise((resolve) => setTimeout(() => resolve("none"), 5000))]);
        form.remove();
        return [said, message()].join(" / ");
      };
      const cross = await submit(`${other}/watch`);
      const fetch = window.fetch;
      window.fetch = async () => new Response('<p id="watch-message">Made by a script</p>', { headers: { "corten-patch": "1" } });
      const made = await submit("/watch");
      window.fetch = fetch;
      const live = /** @type {any} */ (document.querySelector("corten-live"));
      live.source.dispatchEvent(new MessageEvent("patch", { data: '<p id="last-trade">Dispatched</p>', origin: location.origin }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return [cross, made, document.getElementById("last-trade")?.textContent ?? ""];
    }, other);
    await logged;
    check("another origin's data-patch answer is not drawn", opened && cross.startsWith("200 / ") && !cross.includes("From another origin"), `${opened ? "" : "CSP not opened; "}${cross}`);
    check("a Response a script made is not drawn", made.startsWith("200 / ") && !made.includes("Made by a script"), made);
    check("an event a script dispatches on <corten-live> is not drawn", dispatched !== "Dispatched" && said.some((s) => s.includes("an event a script dispatched")), `${dispatched}; ${said.join(" | ")}`);
    await probe.close();
  }
  // An origin the page's script-src lists (the app's, under this test) is one a script loads from the usual way,
  // `script.src = ..`, through the `default` policy `<Corten />` makes, and so is a part the loaded
  // script loads itself (an SDK's). The policy passes nothing else: a URL on this origin or a
  // `data:` one, or markup from a string, is still refused, and an origin the page does not list
  // is blocked by the CSP.
  {
    const loader = await browser.newPage();
    await loader.route("http://scripts.test/**", (route) => {
      const body = route.request().url().endsWith("/sdk.js")
        ? 'window.smokeSdk = "loaded"; const part = document.createElement("script"); part.src = "http://scripts.test/part.js"; document.head.append(part);'
        : 'window.smokePart = "loaded";';
      return route.fulfill({ contentType: "text/javascript", body });
    });
    await loader.goto(`${base}/`);
    const loads = await loader.evaluate(async () => {
      const w = /** @type {any} */ (window);
      /** @param {() => void} set */
      const outcome = (set) => {
        try {
          set();
          return "set";
        } catch (e) {
          return e instanceof TypeError ? "refused" : String(e);
        }
      };
      const sdk = document.createElement("script");
      const other = outcome(() => (sdk.src = "http://scripts.test/sdk.js"));
      document.head.append(sdk);
      const deadline = Date.now() + 5000;
      while (!(w.smokeSdk && w.smokePart) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      const own = outcome(() => (document.createElement("script").src = "/assets/nothing.js"));
      const data = outcome(() => (document.createElement("script").src = "data:text/javascript,1"));
      const unlisted = await new Promise((resolve) => {
        const script = document.createElement("script");
        script.src = "http://unlisted.test/x.js";
        script.onload = () => resolve("loaded");
        script.onerror = () => resolve("blocked");
        document.head.append(script);
      });
      const markup = outcome(() => (document.createElement("div").innerHTML = "<b>x</b>"));
      return { other, sdk: w.smokeSdk ?? "", part: w.smokePart ?? "", own, data, unlisted, markup };
    });
    await loader.close();
    check(
      "a script loads from an origin the page's script-src lists, and so do the parts it loads; a URL on this origin, a data: URL and markup stay refused, and an unlisted origin is blocked",
      loads.other === "set" && loads.sdk === "loaded" && loads.part === "loaded" && loads.own === "refused" && loads.data === "refused" && loads.unlisted === "blocked" && loads.markup === "refused",
      JSON.stringify(loads),
    );
    // The policy is there before a script after `<Corten />` runs: a listed-host `<script src>` the
    // parser meets next sets a script's `src` as it runs, before the page is parsed. One before
    // `<Corten />` that makes `default` itself is named in the console.
    const tag = "<script>self.trustedTypes&&(";
    /** @param {(html: string) => string} edit */
    const edited = async (edit) => {
      const early = await browser.newPage();
      /** @type {string[]} */
      const said = [];
      early.on("console", (m) => said.push(m.text()));
      await early.route("http://scripts.test/**", (route) => {
        const url = route.request().url();
        const body = url.endsWith("/early.js")
          ? 'try { document.createElement("script").src = "http://scripts.test/later.js"; window.smokeEarly = document.readyState; } catch (e) { window.smokeEarly = String(e); }'
          : 'trustedTypes.createPolicy("default", { createScriptURL: (u) => u }); window.smokeFirst = "made";';
        return route.fulfill({ contentType: "text/javascript", body });
      });
      await early.route(`${base}/`, async (route) => {
        // The page's own load only: the runtime's read of its picks goes as it is.
        if (route.request().headers().corten) return route.continue();
        // Uncompressed, since Playwright's Firefox hands a zstd body over undecoded.
        const response = await route.fetch({ headers: { ...route.request().headers(), "accept-encoding": "identity" } });
        return route.fulfill({ response, body: edit(await response.text()) });
      });
      await early.goto(`${base}/`);
      const seen = await early.evaluate(() => ({ early: /** @type {any} */ (window).smokeEarly ?? "", first: /** @type {any} */ (window).smokeFirst ?? "" }));
      await early.close();
      return { ...seen, told: said.some((s) => s.includes("a script before <Corten /> made the default Trusted Types policy")) };
    };
    const after = await edited((html) => {
      const at = html.indexOf("</script>", html.indexOf(tag)) + "</script>".length;
      return `${html.slice(0, at)}<script src="http://scripts.test/early.js"></script>${html.slice(at)}`;
    });
    check("a script right after <Corten /> sets a script's src while the page is parsed", after.early === "loading" && !after.told, JSON.stringify(after));
    const before = await edited((html) => html.replace(tag, `<script src="http://scripts.test/first.js"></script>${tag}`));
    check("a script before <Corten /> that makes the default policy is named in the console", before.first === "made" && before.told, JSON.stringify(before));
  }
}
