import { base, engine, seen, check } from "./helpers.mjs";

export async function dataClients(page, browser) {
  // Without the page's cookie: the three stocks a first visit watches.
  const json = await (await fetch(base, { headers: { accept: "application/json" } })).json();
  check("same URL as JSON for data clients", json.title === "Stocks | Watchlist" && json.data.stocks.length === 3, JSON.stringify(json.data.stocks.map((/** @type {{ id: string }} */ s) => s.id)));

  // A WebSocket (GET /quotes): the page's own origin opens it, names a stock and is sent its row.
  // Another site's page cannot, though the browser would send the user's cookies with its handshake.
  const talk = (/** @type {string} */ url) =>
    new Promise((resolve) => {
      const socket = new WebSocket(url);
      socket.onopen = () => socket.send("ACME");
      socket.onmessage = (e) => {
        resolve(e.data);
        socket.close();
      };
      socket.onerror = () => resolve("refused");
      setTimeout(() => resolve("no answer"), 4000);
    });
  const quotesUrl = `${base.replace(/^http/, "ws")}/quotes`;
  const quoted = String(await page.evaluate(talk, quotesUrl));
  check("a WebSocket from the page's own origin is sent the stock it names", quoted.startsWith("{") && JSON.parse(quoted).id === "ACME", quoted);
  const elsewhere = await browser.newPage();
  await elsewhere.route("http://other.test/", (route) => route.fulfill({ contentType: "text/html", body: "<title>Other</title>" }));
  await elsewhere.goto("http://other.test/");
  const crossed = await elsewhere.evaluate(talk, quotesUrl);
  check("another site's page cannot open it", crossed === "refused", String(crossed));
  // CI's Firefox once stopped between that check and the next for an hour (#317), not seen
  // locally: its route is let go before its context closes, and each step is named to the
  // watchdog, so a stall says which one.
  seen(`[${engine}] (step) closing the other site's page`);
  await elsewhere.unrouteAll({ behavior: "ignoreErrors" });
  await elsewhere.context().close();
}
