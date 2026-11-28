import http from "node:http";
import zlib from "node:zlib";

// The markup this test writes into pages goes through a policy of its own, which the watchlist
// allows only when run with SMOKE_TRUSTED_TYPES=1 (CONTRIBUTING): without it, say so here rather
// than fail at each case it sets up.
export async function validateServer(base) {
  const csp = (await fetch(base)).headers.get("content-security-policy") ?? "";
  if (!/trusted-types corten smoke\b/.test(csp)) {
    console.error(`The watchlist at ${base} does not allow the test's Trusted Types policy: run it with -e SMOKE_TRUSTED_TYPES=1.\n${csp}`);
    process.exit(1);
  }
}

// A live stream is compressed for clients that accept it and flushed after each event: the
// first event decodes while the stream is still open.
export async function httpChecks(base, check) {
  /** @param {string} accept @returns {Promise<{ coding: string | undefined, first: string }>} */
  const liveEvent = (accept) =>
    new Promise((resolve, reject) => {
      const req = http.get(`${base}/live/trades`, { headers: { "accept-encoding": accept } }, (res) => {
        const coding = res.headers["content-encoding"];
        const body = coding === "gzip" ? res.pipe(zlib.createGunzip()) : coding === "br" ? res.pipe(zlib.createBrotliDecompress()) : res;
        let text = "";
        const timer = setTimeout(() => (req.destroy(), resolve({ coding, first: text })), 5000);
        body.on("data", (chunk) => {
          text += chunk.toString();
          if (text.includes("event: patch")) {
            clearTimeout(timer);
            req.destroy();
            resolve({ coding, first: text });
          }
        });
        body.on("error", () => {});
      });
      req.on("error", (e) => (e.message.includes("socket hang up") ? undefined : reject(e)));
    });
  {
    const zstd = await liveEvent("gzip, deflate, br, zstd");
    check("a live stream is zstd for a client that accepts it", zstd.coding === "zstd", String(zstd.coding));
    // Never brotli, which Playwright's Windows WebKit holds back past 16 KiB of an event (#1131): a
    // client without zstd, as that WebKit asks.
    const gzip = await liveEvent("gzip, deflate, br");
    check("a live stream's first event decodes before the stream ends (gzip, flushed per event, for a client without zstd)", gzip.coding === "gzip" && gzip.first.includes("Last trade"), `${gzip.coding}: ${gzip.first.slice(0, 60)}`);
    const plain = await liveEvent("br");
    check("a client that takes only brotli gets the stream as it is", plain.coding === undefined && plain.first.includes("event: patch"), String(plain.coding));
  }

  // A DNS-rebound page reaches the server under a name the app is not: 421, and nothing of the app.
  {
    /** @param {string | null} host its `Host` line, or `null` for none @returns {Promise<[number | undefined, string]>} */
    const get = (host) =>
      new Promise((resolve, reject) => {
        const req = http.get(base, host === null ? { setHost: false } : { headers: { host } }, (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve([res.statusCode, text]));
        });
        req.on("error", reject);
      });
    const port = new URL(base).port;
    const [rebound, body] = await get(`rebound.attacker.example:${port}`);
    check("a request for another host (DNS rebinding) is misdirected", rebound === 421 && !body.includes("<html"), `${rebound} ${body.slice(0, 40)}`);
    const [local] = await get(`localhost:${port}`);
    check("localhost is answered", local === 200, String(local));
    // A request HTTP/1.1 does not allow (RFC 9112 3.2) is a 400 the same way: no `Host` line, or
    // one that is no host. Of a request-target only the host it names itself is held to the same.
    const [unnamed, said] = await get(null);
    check("an HTTP/1.1 request with no Host line is a 400", unnamed === 400 && said === "Bad request.", `${unnamed} ${said.slice(0, 40)}`);
    const [pathed, why] = await get(`localhost:${port}/x`);
    check("a Host that is not a host and a port is a 400", pathed === 400 && why === "Bad request.", `${pathed} ${why.slice(0, 40)}`);
  }
}
