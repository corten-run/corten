import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { marketplaceFixture, marketplaceRecord } from "./marketplace.fixture.mjs";

const app = "sveltekit";
const cwd = fileURLToPath(new URL(".", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const entities = (text) => text.replace(/&(?:amp|lt|gt|quot|apos|#39|#x27|#34|#x22|#(?:x[0-9a-f]+|[0-9]+));/gi, (entity) => {
  const names = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
  if (names[entity]) return names[entity];
  const code = entity.slice(2, -1); return String.fromCodePoint(code[0] === "x" ? parseInt(code.slice(1), 16) : Number(code));
});
const text = (html) => entities(html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, ""));
const rows = (html, attr) => [...html.matchAll(new RegExp(`<tr[^>]*${attr}="([^"]+)"[^>]*>([\\s\\S]*?)</tr>`, "g"))]
  .map((match) => ({ id: match[1], cells: [...match[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => text(cell[1])) }));
const section = (html, name) => html.match(new RegExp(`<section[^>]*class="marketplace__${name}"[^>]*>([\\s\\S]*?)</section>`))?.[1] ?? "";
const message = (html) => text(html.match(/<p[^>]*class="marketplace__message"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "");

async function freePort() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill(); await exited;
}

test("built native routes: complete SSR, form POSTs, exact JSON, statuses and source parity", { timeout: 120000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), `marketplace-${app}-`));
  const path = join(directory, "fixture.json");
  const records = marketplaceFixture();
  await writeFile(path, JSON.stringify(records));
  let upstreamCalls = 0;
  const upstream = createServer((request, response) => {
    const id = decodeURIComponent(new URL(request.url, "http://test").pathname.split("/").at(-1));
    if (request.url.startsWith("/marketplace/records/")) {
      upstreamCalls++;
      if (id === "failed") { response.writeHead(503).end("unavailable"); return; }
      if (id === "malformed") { response.writeHead(200, { "content-type": "application/json" }).end("{}"); return; }
      const record = records[id];
      response.writeHead(record ? 200 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify(record ? { ...record, upstream_only: "must not be relayed" } : { error: "not found" }));
      return;
    }
    if (request.url.startsWith("/catalog/records/")) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        id: "record_1", title: "Legacy catalog", subtitle: "", description: "Unchanged",
        tags: [], fields: [], related: [],
      })); return;
    }
    response.writeHead(404).end();
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const fixturePages = new Map();
  try {
    for (const source of ["fixture", "http"]) await t.test(source, async () => {
      const port = await freePort(), base = `http://127.0.0.1:${port}`;
      const args = app === "nuxt" ? [".output/server/index.mjs"] : app === "sveltekit" ? ["build"] :
        ["--import", "./dist/server/virtual_astro_middleware.mjs", "dist/server/entry.mjs"];
      const env = { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port),
        API_BASE: `http://127.0.0.1:${upstream.address().port}`, MARKETPLACE_SOURCE: source,
        MARKETPLACE_FIXTURE_PATH: path, ITEM_SOURCE: "http", CATALOG_SOURCE: "http",
      };
      const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
      try {
        let ready = false;
        for (let i = 0; i < 150; i++) {
          if (child.exitCode !== null) throw new Error(`server exited: ${output}`);
          try { if ((await fetch(base + "/api/marketplace/item_1")).ok) { ready = true; break; } } catch {}
          await pause(100);
        }
        assert.ok(ready, output);
        const get = async (url, options) => {
          const before = upstreamCalls;
          const response = await fetch(base + url, { ...options, headers: { Accept: "text/html", ...options?.headers } });
          const body = await response.text();
          const wanted = source === "http" && !url.startsWith("/marketplace/es-ES/") && !url.startsWith("/catalog/") && !url.endsWith(".css")
            && options?.headers?.Origin !== "https://attacker.example" ? 1 : 0;
          assert.equal(upstreamCalls - before, wanted, `upstream fetch count: ${url}`);
          return { response, body };
        };
        let result = await get("/api/marketplace/item_1");
        assert.equal(result.response.status, 200);
        assert.deepEqual(JSON.parse(result.body), marketplaceRecord());
        assert.match(result.response.headers.get("content-type"), /application\/json/);
        result = await get("/api/marketplace/item_2");
        assert.deepEqual(JSON.parse(result.body), records.item_2);
        for (const locale of ["en-US", "fr-FR", "de-DE"]) {
          const url = `/marketplace/${locale}/item_1`;
          const { response, body } = await get(url);
          assert.equal(response.status, 200, body);
          assert.match(body, new RegExp(`<html[^>]*lang="${locale}"`));
          assert.equal((body.match(/<article[^>]*class="marketplace"/g) ?? []).length, 1);
          assert.match(body, /<header[^>]*class="site-header__bar"/);
          assert.match(body, /href="\/marketplace.css"/);
          assert.ok(text(body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)[1]).includes(records.item_1.title));
          assert.ok(!body.includes("<h1><script>"));
          assert.match(body, /class="marketplace__subtitle"/);
          assert.equal((body.match(/class="marketplace__image"/g) ?? []).length, 2);
          const listingRows = rows(body, "data-listing-id");
          assert.deepEqual(listingRows.map((row) => row.id), [6, 0, 1, 2, 3, 8, 4, 5, 7].map((i) => `listing_${i}`));
          const formatter = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" });
          assert.equal(listingRows[0].cells[4], formatter.format(-1234.5));
          assert.ok(listingRows.find((row) => row.id === "listing_2").cells[0].includes(locale === "en-US" ? "4.3" : "4,3"));
          assert.equal(rows(body, "data-offer-id").length, 5);
          assert.equal(message(body), "");
          for (const name of ["summary", "listings", "offers", "alert", "details", "contents", "included"])
            assert.ok(section(body, name).length > 0, name);
          assert.match(section(body, "contents"), new RegExp(`href="/marketplace/${locale}/item_2"`));
          if (source === "fixture") fixturePages.set(locale, {
            listings: listingRows, offers: rows(body, "data-offer-id"), summary: text(section(body, "summary")).replace(/\s+/g, " ").trim(),
          });
          else assert.deepEqual({
            listings: listingRows, offers: rows(body, "data-offer-id"), summary: text(section(body, "summary")).replace(/\s+/g, " ").trim(),
          }, fixturePages.get(locale));
          const origin = process.env.BENCHMARK_ORIGIN ?? "http://localhost:18413";
          const post = (email, target_price, customOrigin = origin) => get(url, {
            method: "POST", headers: { Origin: customOrigin }, body: new URLSearchParams({ email, target_price }),
          });
          const success = await post("person@example.test", locale === "en-US" ? "1234.50" : "1234,50");
          assert.equal(success.response.status, 200, success.body);
          assert.ok(message(success.body).includes("person@example.test"), success.body);
          assert.ok(message(success.body).includes(formatter.format(1234.5)));
          assert.equal(rows(success.body, "data-listing-id").length, 9);
          const invalidEmail = await post("bad", "1");
          assert.equal(invalidEmail.response.status, 200);
          assert.ok(message(invalidEmail.body).length > 0);
          assert.ok(!message(invalidEmail.body).includes("bad"));
          const invalidPrice = await post("person@example.test", "0");
          assert.equal(invalidPrice.response.status, 200);
          assert.ok(message(invalidPrice.body).length > 0);
          assert.notEqual(message(invalidEmail.body), message(invalidPrice.body));
          const forbidden = await post("person@example.test", "1", "https://attacker.example");
          assert.equal(forbidden.response.status, 403);
        }
        result = await get("/marketplace/fr-FR/item_1?seller=Alice&sort=desc&offers=all");
        assert.deepEqual(rows(result.body, "data-listing-id").map((row) => row.id), [5, 4, 3, 2, 1, 0, 6].map((i) => `listing_${i}`));
        assert.equal(rows(result.body, "data-offer-id").length, 8);
        assert.ok(!result.body.includes('class="marketplace__more"'));
        result = await get("/marketplace/de-DE/item_2");
        assert.equal(result.response.status, 200);
        assert.ok(!result.body.includes('class="marketplace__subtitle"'));
        assert.equal(rows(result.body, "data-listing-id").length, 0);
        assert.ok(section(result.body, "summary").includes("Noch keine Angebote"));
        assert.equal((await get("/marketplace/es-ES/item_1")).response.status, 400);
        assert.equal((await get("/marketplace/en-US/missing")).response.status, 404);
        assert.equal((await get("/api/marketplace/missing")).response.status, 404);
        assert.equal((await get("/marketplace.css")).response.status, 200);
        result = await get("/catalog/record_1");
        assert.equal(result.response.status, 200);
        assert.ok(result.body.includes("Legacy catalog"));
        if (source === "http") {
          assert.ok((await get("/marketplace/en-US/failed")).response.status >= 500);
          assert.ok((await get("/api/marketplace/failed")).response.status >= 500);
          assert.ok((await get("/api/marketplace/malformed")).response.status >= 500);
          records.item_1.title = "Updated title, not cached";
          result = await get("/marketplace/fr-FR/item_1");
          assert.ok(result.body.includes("Updated title, not cached"));
          result = await get("/api/marketplace/item_1");
          assert.equal(JSON.parse(result.body).title, "Updated title, not cached");
        }
      } finally { await stop(child); }
    });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
