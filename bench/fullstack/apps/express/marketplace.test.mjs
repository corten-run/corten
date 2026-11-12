// The Express app's own tests (node --test, with the app's dependencies installed): formatting,
// the page's rows and links, the cross-site post check, and both sources, each read per request.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const record = {
  id: "item_1", title: '<script>&"{price}', subtitle: "", description: "<b>Data</b>",
  categories: [{ name: "Cards", slug: "cards" }], badges: ["Rare"], tags: ["foil"],
  images: ["/one.webp", "/two.webp"], fields: [{ name: "Set", value: "Ember" }],
  summary: { lowest_minor: -123450, count: 1000000, quantity: 1234 },
  listings: [
    { id: "a", seller: "Alice", rating_hundredths: 425, reviews: 1234, condition: "NM", ships_from: "US", quantity: 2, price_minor: 100 },
    { id: "b", seller: "Alice B", rating_hundredths: 499, reviews: 0, condition: "NM", ships_from: "DE", quantity: 1000, price_minor: 100 },
    { id: "c", seller: "bob", rating_hundredths: null, reviews: 1, condition: "", ships_from: "FR", quantity: 0, price_minor: null },
    { id: "d", seller: "Alice", rating_hundredths: 0, reviews: 2, condition: "NM", ships_from: "US", quantity: 1, price_minor: -1 },
  ],
  offers: Array.from({ length: 7 }, (_, i) => ({ id: "offer_" + i, buyer: "Buyer", condition: "NM", quantity: 1000, price_minor: i === 0 ? null : i })),
  contents: [{ id: "line_1", item_id: "item/2", title: "Other", quantity: 1000 }],
  included_in: [{ id: "line_2", item_id: "item_3", title: "Bundle", quantity: 2 }],
};
const spaces = (value) => value.replace(/[\u00a0\u202f]/g, " ");

/** Starts the app as the image does (node server.mjs) with `env`, and runs `body` against it. */
async function serving(env, body) {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ["server.mjs"], { cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: { ...process.env, MARKETPLACE_SOURCE: "", ...env, PORT: String(port) }, stdio: ["ignore", "pipe", "inherit"] });
  try {
    const [line] = await Promise.race([once(child.stdout, "data"), once(child, "exit").then(([code]) => { throw new Error(`the app exited with ${code}`); })]);
    assert.match(String(line), /listening/);
    return await body(`http://127.0.0.1:${port}`);
  } finally {
    child.kill();
    if (child.exitCode === null) await once(child, "exit");
  }
}

test("Intl formats signed money, half-up ratings, grouped counts and the listing plural", async () => {
  const model = await import("./lib/marketplace.mjs");
  const prices = [0, 1, 10, 125, 123450, 123456789, -123450];
  const expected = {
    "en-US": ["$0.00", "$0.01", "$0.10", "$1.25", "$1,234.50", "$1,234,567.89", "-$1,234.50"],
    "fr-FR": ["0,00 $US", "0,01 $US", "0,10 $US", "1,25 $US", "1 234,50 $US", "1 234 567,89 $US", "-1 234,50 $US"],
    "de-DE": ["0,00 $", "0,01 $", "0,10 $", "1,25 $", "1.234,50 $", "1.234.567,89 $", "-1.234,50 $"],
  };
  for (const locale of Object.keys(expected)) {
    const f = model.formatters(locale);
    assert.deepEqual(prices.map((n) => spaces(f.money.format(n / 100))), expected[locale]);
    assert.deepEqual([0, 400, 425, 475, 499].map((n) => f.rating.format(n / 100)),
      locale === "en-US" ? ["0", "4", "4.3", "4.8", "5"] : ["0", "4", "4,3", "4,8", "5"]);
    const view = model.pageModel(locale, record, model.readQuery({}), null);
    const word = locale === "fr-FR" ? "d’annonces" : locale === "de-DE" ? "Angebote" : "listings";
    assert.equal(spaces(view.summary.count), spaces(f.count.format(1000000)) + " " + word);
    const decimal = locale === "en-US" ? "." : ",";
    assert.equal(model.targetAmount(locale, "1234" + decimal + "50"), 1234.5);
    for (const bad of ["", "0", "-1", "NaN", "Infinity", "1e3", "12wrong", locale === "en-US" ? "1,50" : "1.50"]) {
      assert.equal(model.targetAmount(locale, bad), null, bad);
    }
    assert.equal(model.alertMessage(locale, record.title, "bad", "1"), f.labels.invalid_email);
    const message = model.alertMessage(locale, "{email} $&", "a@example.test", "1234" + decimal + "50");
    assert.ok(message.includes("{email} $&") && message.includes(f.money.format(1234.5)), message);
  }
  for (const locale of ["en", "en-us", "__proto__", "toString"]) assert.equal(model.isLocale(locale), false);
});

test("listings sort by price, stable, missing last, and filter by a case-sensitive prefix", async () => {
  const { readQuery, sortedListings } = await import("./lib/marketplace.mjs");
  const ids = (query) => sortedListings(record, readQuery(query)).map((row) => row.id);
  assert.deepEqual(ids({}), ["d", "a", "b", "c"]);
  assert.deepEqual(ids({ sort: "desc" }), ["a", "b", "d", "c"]);
  assert.deepEqual(ids({ seller: "Alice B" }), ["b"]);
  assert.deepEqual(ids({ seller: "alice" }), []);
  assert.deepEqual(record.listings.map((row) => row.id), ["a", "b", "c", "d"]);
});

test("accepted forms persist in a server-issued session, with independent readback and atomic appends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marketplace-alerts-express-"));
  const path = join(directory, "marketplace.json");
  try {
    await writeFile(path, JSON.stringify({ item_1: record }));
    for (const profile of ["", "matched"]) await serving({ MARKETPLACE_SOURCE: "fixture", MARKETPLACE_FIXTURE_PATH: path, PROFILE: profile }, async (base) => {
      const read = async (cookie = "") => {
        const response = await fetch(`${base}/api/alerts`, { headers: { cookie } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("set-cookie"), null);
        return response.json();
      };
      const post = (locale, fields, cookie = "", headers = {}, id = "item_1") => fetch(`${base}/marketplace/${locale}/${id}`, {
        method: "POST", headers: { origin: base, cookie, ...headers }, body: new URLSearchParams(fields),
      });
      const chosenCookie = "marketplace-alerts=" + "0".repeat(64);
      assert.deepEqual(await read(), []);
      assert.deepEqual(await read(chosenCookie), []);
      const invalidFresh = await post("en-US", { email: "bad", target_price: "1" });
      assert.equal(invalidFresh.status, 200);
      assert.equal(invalidFresh.headers.get("set-cookie"), null);
      assert.deepEqual(await read(), []);
      const first = await post("en-US", { email: "first@example.test", target_price: "12.50" }, chosenCookie);
      assert.equal(first.status, 200);
      const setCookie = first.headers.get("set-cookie");
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Lax/i);
      assert.match(setCookie, /Path=\//i);
      const cookie = setCookie.split(";")[0];
      assert.notEqual(cookie, chosenCookie);
      const expected = [{ item_id: "item_1", email: "first@example.test", target_minor: 1250 }];
      assert.deepEqual(await read(cookie), expected);
      for (const locale of ["fr-FR", "de-DE"]) {
        const email = `${locale}@example.test`;
        const response = await post(locale, { email, target_price: "1234,50" }, cookie);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("set-cookie"), null);
        expected.push({ item_id: "item_1", email, target_minor: 123450 });
        assert.deepEqual(await read(cookie), expected);
        for (const fields of [{}, { email: "bad", target_price: "1" }, { email, target_price: "0" }, { email, target_price: "1.50" }]) {
          assert.equal((await post(locale, fields, cookie)).status, 200);
          assert.deepEqual(await read(cookie), expected);
        }
      }
      for (const headers of [{ origin: "https://attacker.test" }, { "sec-fetch-site": "cross-site" }]) {
        assert.equal((await post("en-US", { email: "evil@example.test", target_price: "1" }, cookie, headers)).status, 403);
      }
      assert.equal((await post("en-US", { email: "missing@example.test", target_price: "1" }, cookie, {}, "missing")).status, 404);
      assert.equal((await post("es-ES", { email: "badlocale@example.test", target_price: "1" }, cookie)).status, 400);
      assert.deepEqual(await read(cookie), expected);
      const other = await post("en-US", { email: "other@example.test", target_price: "2" });
      const otherCookie = other.headers.get("set-cookie").split(";")[0];
      assert.notEqual(otherCookie, cookie);
      assert.deepEqual(await read(otherCookie), [{ item_id: "item_1", email: "other@example.test", target_minor: 200 }]);
      const emails = Array.from({ length: 24 }, (_, i) => `concurrent-${i}@example.test`);
      await Promise.all(emails.map(async (email) => {
        assert.equal((await post("en-US", { email, target_price: "3.25" }, cookie)).status, 200);
        const snapshot = await read(cookie);
        assert.deepEqual(snapshot.slice(0, expected.length), expected);
        assert.equal(new Set(snapshot.map((row) => row.email)).size, snapshot.length);
      }));
      const rows = await read(cookie);
      assert.equal(rows.length, expected.length + emails.length);
      assert.deepEqual(rows.slice(expected.length).map((row) => row.email).sort(), emails.sort());
      assert.ok(rows.slice(expected.length).every((row) => row.item_id === "item_1" && row.target_minor === 325));
      assert.deepEqual(await read(cookie), rows);
      for (let count = 1; count <= 2; count++) {
        assert.equal((await post("en-US", { email: "repeat@example.test", target_price: "4" }, cookie)).status, 200);
        const repeated = await read(cookie);
        assert.equal(repeated.length, rows.length + count);
        assert.deepEqual(repeated.at(-1), { item_id: "item_1", email: "repeat@example.test", target_minor: 400 });
      }
      assert.deepEqual(await read(), []);
      assert.deepEqual(await read(chosenCookie), []);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the fixture is read once at startup; pages are escaped, localized and refuse a cross-site post", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marketplace-express-"));
  const path = join(directory, "marketplace.json");
  try {
    await writeFile(path, JSON.stringify({ item_1: record }));
    await serving({ MARKETPLACE_SOURCE: "fixture", MARKETPLACE_FIXTURE_PATH: path }, async (base) => {
      // Read at startup: the file is gone before the first request.
      await rm(path);
      for (const locale of ["en-US", "fr-FR", "de-DE"]) {
        const page = await fetch(`${base}/marketplace/${locale}/item_1`);
        const html = await page.text();
        assert.equal(page.status, 200);
        assert.ok(html.includes(`<html lang="${locale}">`));
        assert.ok(html.includes("&lt;script&gt;&amp;&#34;{price}") && !html.includes("<script>&"));
        assert.equal(html.match(/data-offer-id=/g)?.length, 5);
        assert.equal(html.match(/data-listing-id=/g)?.length, 4);
        assert.ok(html.includes(`href="/marketplace/${locale}/item%2F2">Other</a> × `));
        assert.ok(html.includes("offers=all"));
        const all = await (await fetch(`${base}/marketplace/${locale}/item_1?offers=all`)).text();
        assert.equal(all.match(/data-offer-id=/g)?.length, 7);
        assert.ok(!all.includes('class="marketplace__more"'));
        const target = locale === "en-US" ? "12.50" : "12,50";
        const form = { email: "<a>@b", target_price: target };
        const posted = await fetch(`${base}/marketplace/${locale}/item_1`, { method: "POST", body: new URLSearchParams(form) });
        assert.equal(posted.status, 200);
        assert.ok((await posted.text()).includes("&lt;a&gt;@b"));
        for (const headers of [{ origin: "http://attacker.test" }, { "sec-fetch-site": "cross-site" }]) {
          const refused = await fetch(`${base}/marketplace/${locale}/item_1`, { method: "POST", headers, body: new URLSearchParams(form) });
          assert.equal(refused.status, 403);
        }
        const same = await fetch(`${base}/marketplace/${locale}/item_1`, { method: "POST", headers: { origin: base }, body: new URLSearchParams(form) });
        assert.equal(same.status, 200);
      }
      assert.deepEqual(await (await fetch(`${base}/api/marketplace/item_1`)).json(), record);
      assert.equal((await fetch(`${base}/marketplace/es-ES/item_1`)).status, 400);
      for (const missing of ["/marketplace/en-US/missing", "/api/marketplace/missing"]) assert.equal((await fetch(base + missing)).status, 404);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the API source fetches once per request, encodes the ID, follows no redirect and fails a non-2xx", async () => {
  const requests = [];
  let status = 200;
  const upstream = createServer((request, response) => {
    requests.push(request.url);
    if (request.url.endsWith("/target")) return response.end(JSON.stringify(record));
    if (status === 302) {
      response.writeHead(302, { Location: "/marketplace/records/target" });
      return response.end();
    }
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ...record, title: String(requests.length) }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  try {
    await serving({ API_BASE: `http://127.0.0.1:${upstream.address().port}` }, async (base) => {
      assert.equal((await (await fetch(`${base}/api/marketplace/item%2F1`)).json()).title, "1");
      assert.equal((await (await fetch(`${base}/api/marketplace/item%2F1`)).json()).title, "2");
      assert.ok((await (await fetch(`${base}/marketplace/en-US/item_1`)).text()).includes("<h1>3</h1>"));
      assert.deepEqual(requests, ["/marketplace/records/item%2F1", "/marketplace/records/item%2F1", "/marketplace/records/item_1"]);
      const accepted = await fetch(`${base}/marketplace/en-US/item_1`, {
        method: "POST", body: new URLSearchParams({ email: "api@example.test", target_price: "12.50" }),
      });
      assert.equal(accepted.status, 200);
      const cookie = accepted.headers.get("set-cookie").split(";")[0];
      const beforeRead = requests.length;
      assert.deepEqual(await (await fetch(`${base}/api/alerts`, { headers: { cookie } })).json(),
        [{ item_id: "item_1", email: "api@example.test", target_minor: 1250 }]);
      assert.equal(requests.length, beforeRead, "independent readback must not fetch the record source");
      status = 404;
      assert.equal((await fetch(`${base}/marketplace/en-US/item_1`)).status, 404);
      for (status of [302, 503]) {
        requests.length = 0;
        assert.ok((await fetch(`${base}/marketplace/en-US/item_1`)).status >= 500);
        assert.deepEqual(requests, ["/marketplace/records/item_1"]);
      }
    });
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
