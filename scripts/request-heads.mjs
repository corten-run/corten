// The header names each browser sends over HTTP/1.1 with a request that has no body, the
// evidence for the names Corten's own connection takes by their bytes
// (docs/design.md#choice-own-http1, `field_name` in crates/corten/src/h1/head.rs). A socket of its
// own reads each head as the browser wrote it, every name in its own case: a navigation, a link
// the user follows, a reload, a stylesheet and an image (each sent again for what came with an
// `ETag` and a `Last-Modified`), and the fetches Corten's runtime makes for a request without a
// body, with the headers it gives them (crates/corten/js/corten.js: a visit's `corten`, a prefetch's
// `corten` and `purpose`, a feed's `accept`, a read after an action's `corten`).
//
// Run from a checkout after `npm ci` and `npx playwright install chromium firefox webkit`:
// node scripts/request-heads.mjs [--heads]. It prints each engine's version, then every name in
// each spelling sent and in how many of its requests, and with --heads every head as it came.
import net from "node:net";
import { chromium, firefox, webkit } from "playwright";

const showHeads = process.argv.includes("--heads");
const page = `<!doctype html><html><head><title>t</title><link rel="stylesheet" href="/style.css"></head><body>
<a id="next" href="/next">next</a><img src="/image.png" alt="">
<script>
(async () => {
  await fetch("/visit", { headers: { corten: "nav" } });
  await fetch("/prefetch", { headers: { corten: "nav", purpose: "prefetch" }, priority: "low" });
  await fetch("/feed", { headers: { accept: "application/json" } });
  await fetch("/read", { headers: { corten: "action" } });
  document.title = "done";
})();
</script></body></html>`;

/** @type {string[]} */
const heads = [];
const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let end = buffer.indexOf("\r\n\r\n"); end >= 0; end = buffer.indexOf("\r\n\r\n")) {
      const head = buffer.subarray(0, end).toString("latin1");
      buffer = buffer.subarray(end + 4);
      heads.push(head);
      const path = head.split(" ")[1] ?? "";
      const html = path === "/" || path === "/next";
      const body = html ? page : path === "/style.css" ? "body{}" : "ok";
      const type = html ? "text/html" : path === "/style.css" ? "text/css" : "text/plain";
      socket.write(
        `HTTP/1.1 200 OK\r\ncontent-type: ${type}\r\ncontent-length: ${Buffer.byteLength(body)}\r\n` +
          `etag: "v1"\r\nlast-modified: Thu, 26 Nov 2026 00:00:00 GMT\r\ncache-control: no-cache\r\n` +
          `set-cookie: s=1; Path=/\r\n\r\n${body}`,
      );
    }
  });
  socket.on("error", () => {});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
const address = server.address();
const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

for (const type of [chromium, firefox, webkit]) {
  heads.length = 0;
  const browser = await type.launch();
  const tab = await (await browser.newContext()).newPage();
  const done = () => tab.waitForFunction(() => document.title === "done", null, { timeout: 15000 });
  await tab.goto(`${origin}/`);
  await done();
  await tab.click("#next");
  await tab.waitForURL(`${origin}/next`);
  await done();
  await tab.reload();
  await done();
  console.log(`${type.name()} ${browser.version()}: ${heads.length} requests`);
  /** @type {Map<string, number>} */
  const names = new Map();
  for (const head of heads) {
    const fields = head.split("\r\n").slice(1);
    for (const name of new Set(fields.map((field) => field.slice(0, field.indexOf(":"))))) names.set(name, (names.get(name) ?? 0) + 1);
  }
  for (const [name, count] of [...names].sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b))) {
    console.log(`  ${name} ${count}`);
  }
  if (showHeads) for (const head of heads) console.log(`---\n${head}`);
  await browser.close();
}
server.close();
