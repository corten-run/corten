// Run against the fixture-backed matched server with MARKETPLACE_PUBLIC_ORIGIN=https://localhost:8080.
import assert from "node:assert/strict";
import { request } from "node:http";

const base = process.argv[2];
assert.ok(base && new URL(base).protocol === "http:", "usage: node tests/public-origin-http.mjs HTTP_APP_URL");
const publicOrigin = "https://localhost:8080";
const page = "/marketplace/en-US/item_1";
const form = "email=edge%40example.test&target_price=1.25";

function send(path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, base), {
      method: body ? "POST" : "GET", headers, signal: AbortSignal.timeout(5000),
    }, async (res) => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve({ status: res.statusCode, cookie: res.headers["set-cookie"]?.[0], body: Buffer.concat(chunks).toString() });
      } catch (error) { reject(error); }
    });
    req.once("error", reject);
    req.end(body);
  });
}

for (const [host, origin, site, status, secure] of [
  ["localhost:8080", publicOrigin, "same-origin", 200, true],
  ["localhost:8080", "http://localhost:8080", "same-origin", 403],
  ["localhost:8080", "https://other.invalid", "same-origin", 403],
  ["localhost:8081", publicOrigin, "same-origin", 403],
  ["127.0.0.1:8080", publicOrigin, "same-origin", 403],
  ["localhost:8080", undefined, "same-origin", 403],
  ["localhost:8080", publicOrigin, "cross-site", 403],
  ["other.invalid:8080", publicOrigin, "same-origin", 421],
  ["127.0.0.1:8080", "http://127.0.0.1:8080", "same-origin", 200, false],
]) {
  const claimed = new URL(origin ?? publicOrigin), scheme = claimed.protocol.slice(0, -1);
  const forged = { Forwarded: `host="${claimed.host}";proto=${scheme}`, "X-Forwarded-Host": claimed.host, "X-Forwarded-Proto": scheme };
  const res = await send(page, { Host: host, ...(origin && { Origin: origin }), "Sec-Fetch-Site": site,
    ...(status !== 200 && forged), "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(form) }, form);
  assert.equal(res.status, status, `${host} from ${origin} (${site})`);
  if (status !== 200) {
    assert.equal(res.cookie, undefined, "rejected form created a session");
    continue;
  }
  assert.match(res.cookie, /^marketplace_session=/);
  assert.equal(/;\s*secure\b/i.test(res.cookie), secure);
  const read = await send("/api/alerts", { Host: host, Cookie: res.cookie.split(";")[0] });
  assert.equal(read.status, 200);
  assert.deepEqual(JSON.parse(read.body), [{ item_id: "item_1", email: "edge@example.test", target_minor: 125 }]);
}
