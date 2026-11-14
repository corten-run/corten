import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "@playwright/test";
import { records } from "../marketplace/fixtures.mjs";
import { referenceHtml } from "../marketplace/reference.mjs";
import { snapshotMixedPage } from "./snapshot.mjs";
import { createPlan } from "../workloads/mixed.mjs";
import { collectDOMReads, replayDOMReads, retainJSONResponse, replayResponseEvidence } from "./response-evidence.mjs";

test("actual Chromium DOM source reads replay the unchanged native snapshot, not a normalized summary", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false }), page = await context.newPage();
    const html = referenceHtml(records().item_1, "en-US");
    await page.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: html }));
    await page.goto("http://localhost/marketplace/en-US/item_1");
    const actual = await page.evaluate(snapshotMixedPage, { readPath: "/marketplace/en-US/item_1" });
    const receipt = await page.evaluate(collectDOMReads, { source: snapshotMixedPage.toString(), readPath: "/marketplace/en-US/item_1" });
    assert.equal(receipt.failure, null); assert.ok(receipt.events.length > 100);
    assert.deepEqual(replayDOMReads(receipt), actual);
    const changed = structuredClone(receipt); changed.page.title = "forged normalized title";
    assert.throws(() => replayDOMReads(changed));
    const missing = structuredClone(receipt); missing.events.splice(3, 1); assert.throws(() => replayDOMReads(missing));
    const extra = structuredClone(receipt); extra.events.push(extra.events[0]); assert.throws(() => replayDOMReads(extra));
    const roots = structuredClone(receipt); roots.roots.global = roots.roots.document; assert.throws(() => replayDOMReads(roots));
    await page.setContent(html.replace("</body>", '<input type="hidden" value="credential-canary"><div class="marketplace__title">credential-canary</div></body>'));
    await page.locator("h1").evaluate((el) => { el.textContent = "credential-canary"; });
    const filtered = await page.evaluate(collectDOMReads, { source: snapshotMixedPage.toString(), readPath: "/marketplace/en-US/item_1" });
    assert.equal(filtered.failure, "credential-filter-blocked"); assert.equal(filtered.page, null);
    assert.doesNotMatch(JSON.stringify(filtered), /credential-canary/);
    await context.close();
  } finally { await browser.close(); }
});

test("public record normalization is bound to exact original JSON bytes and response hash", async () => {
  const { sha256 } = await import("./capture.mjs"), record = records().item_1, body = Buffer.from(JSON.stringify(record));
  const value = { row: { record, page: null, form: null, state: null }, evidence: { stages: [{ stage: "primary",
    decodedBodyBytes: body.length, decodedBodySha256: sha256(body), sourceBody: retainJSONResponse(body, "record") }] } };
  assert.equal(replayResponseEvidence(value, {}), true);
  for (const mutate of [(v) => { v.row.record.title = "wrong body"; },
    (v) => { v.evidence.stages[0].decodedBodySha256 = "0".repeat(64); },
    (v) => { v.evidence.stages[0].sourceBody.base64 = Buffer.from("{}").toString("base64"); }]) {
    const v = structuredClone(value); mutate(v); assert.throws(() => replayResponseEvidence(v, {}));
  }
});

test("public JSON source retains exact bytes and refuses credential-bearing state shapes", () => {
  const body = Buffer.from('[ {"email":"person@example.test","item_id":"item_1","target_minor":100} ]');
  assert.equal(retainJSONResponse(body, "state").base64, body.toString("base64"));
  for (const value of [{ cookie: "credential-canary" }, [{ email: "credential-canary", item_id: "item_1", target_minor: 1, token: "secret" }]])
    assert.throws(() => retainJSONResponse(Buffer.from(JSON.stringify(value)), "state"));
});

test("missing successful extraction source is blocked, never complete target-failure proof", () => {
  for (const category of ["json", "read"]) {
    const value = { row: { record: null, page: null, form: null, state: null, outcome: "completed" },
      evidence: { stages: [{ stage: "primary", status: 200, contentType: category === "json" ? "application/json" : "text/html" }], gaps: ["native-body-extraction-failed"] } };
    assert.equal(replayResponseEvidence(value, { category }), false);
  }
});

test("unknown or malformed JSON is not retained as credential-safe public record proof", () => {
  for (const text of ['{"broken":', '{"credential":"canary"}']) assert.throws(() => retainJSONResponse(Buffer.from(text), "record"));
});

test("public record leaves cannot hide unrecognized credential objects or arrays", () => {
  for (const change of [(r) => { r.title = { credential: "synthetic-private-canary" }; },
    (r) => { r.description = [{ credential: "synthetic-private-canary" }]; },
    (r) => { r.categories[0].name = { credential: "synthetic-private-canary" }; },
    (r) => { r.listings[0].seller = { credential: "synthetic-private-canary" }; },
    (r) => { r.summary.count = { credential: "synthetic-private-canary" }; }]) {
    const record = records().item_1; change(record);
    assert.throws(() => retainJSONResponse(Buffer.from(JSON.stringify(record)), "record"));
  }
});

test("public image URLs refuse credentials before retaining original JSON bytes", () => {
  for (const url of ["https://username-canary:password-canary@example.test/image", "//username-canary@example.test/image",
    "https://example.test/image?access_token=credential-canary", "https://example.test/image#credential-canary", "data:text/plain,credential-canary"]) {
    const record = records().item_1; record.images = [url];
    assert.throws(() => retainJSONResponse(Buffer.from(JSON.stringify(record)), "record"));
  }
  for (const url of ["/cards/dragon.webp", "https://example.test/public.webp"]) {
    const record = records().item_1; record.images = [url]; const body = Buffer.from(JSON.stringify(record));
    assert.equal(retainJSONResponse(body, "record").base64, body.toString("base64"));
  }
});

test("public image query names cannot authorize arbitrary values without an image query contract", () => {
  for (const query of ["seller=credential-canary", "sort=credential-canary", "offers=credential-canary", "s%65ller=credential%2Dcanary",
    "seller=A", "sort=asc", "offers=all", "seller=&seller=credential-canary", "sort=asc&sort=credential-canary"]) {
    const record = records().item_1; record.images = [`https://example.test/image?${query}`];
    assert.throws(() => retainJSONResponse(Buffer.from(JSON.stringify(record)), "record"), undefined, "nonempty image queries require a known public contract");
  }
  const record = records().item_1; record.images = ["/cards/dragon.webp?seller=&sort=&offers=&unknown="];
  const body = Buffer.from(JSON.stringify(record));
  assert.equal(retainJSONResponse(body, "record").base64, body.toString("base64"));
});

test("Chromium DOM query values are closed to exact mixed page contract values", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage(), readPath = "/marketplace/en-US/item_1", html = referenceHtml(records().item_1, "en-US");
    await page.route("**/*", (r) => r.fulfill({ contentType: "text/html", body: html })); await page.goto(`http://localhost${readPath}`);
    const inspect = async (url, attribute = "href") => {
      await page.setContent(html);
      await page.locator(attribute === "href" ? ".marketplace__contents a" : ".marketplace__image").first()
        .evaluate((el, { attribute, url }) => el.setAttribute(attribute, url), { attribute, url });
      return page.evaluate(collectDOMReads, { source: snapshotMixedPage.toString(), readPath });
    };
    const supported = new Set(createPlan({ records: records(), seed: 42, clients: 1, repetitions: 1 }).requests
      .filter((r) => r.category === "listings").map((r) => r.path));
    for (const url of [...supported, "/marketplace/en-US/item_2?seller=&sort=asc&offers=all", "/marketplace/de-DE/item_500?sort=desc"]) {
      const receipt = await inspect(url); assert.equal(receipt.failure, null); assert.deepEqual(replayDOMReads(receipt), receipt.page);
      assert.equal(receipt.page.contents[0].href, url, "accepted URL must stay exact, not be redacted into a positive");
    }
    for (const url of ["seller=credential-canary", "sort=credential-canary", "offers=credential-canary", "s%65ller=credential%2Dcanary",
      "seller=A&seller=credential-canary", "sort=asc&sort=credential-canary", "seller=&seller=", "seller=Alice", "sort=ASC", "offers=true"]
      .map((q) => `/marketplace/en-US/item_2?${q}`).concat(["/unknown?seller=A", "/marketplace/en-US/item_501?sort=asc",
        "https://example.test/marketplace/en-US/item_2?seller=A", "/marketplace/es-ES/item_2?sort=asc"])) {
      const receipt = await inspect(url);
      assert.equal(/credential-canary/.test(JSON.stringify(receipt)), false, "unknown query values must not enter DOM source");
      assert.equal(receipt.failure, "credential-filter-blocked"); assert.equal(receipt.page, null); assert.deepEqual(receipt.events, []);
    }
    for (const query of ["seller=A", "sort=asc", "offers=all", "seller=credential-canary"])
      assert.equal((await inspect(`/cards/dragon.webp?${query}`, "data-src")).failure, "credential-filter-blocked");
  } finally { await browser.close(); }
});

test("actual browser page remains blocked with original outcome when only DOM reads are missing", async () => {
  const { sha256 } = await import("./capture.mjs"), browser = await chromium.launch();
  try {
    const page = await browser.newPage(), html = referenceHtml(records().item_1, "en-US"), readPath = "/marketplace/en-US/item_1";
    await page.route("**/*", (r) => r.fulfill({ contentType: "text/html", body: html })); await page.goto(`http://localhost${readPath}`);
    const domReads = await page.evaluate(collectDOMReads, { source: snapshotMixedPage.toString(), readPath });
    assert.equal(domReads.failure, null);
    const value = { row: { outcome: "completed", status: 200, page: domReads.page, record: null, form: null, state: null },
      evidence: { stages: [{ stage: "primary", status: 200, contentType: "text/html", decodedBodySha256: sha256(html) }], domReads, domResponseSha256: sha256(html) } };
    assert.equal(replayResponseEvidence(value, { category: "read", path: readPath }), true);
    delete value.evidence.domReads;
    const before = JSON.stringify(value); assert.equal(replayResponseEvidence(value, { category: "read", path: readPath }), false);
    assert.equal(JSON.stringify(value), before); assert.equal(value.row.outcome, "completed");
    const contradictory = structuredClone(value); contradictory.evidence.domResponseSha256 = "0".repeat(64);
    assert.throws(() => replayResponseEvidence(contradictory, { category: "read", path: readPath }));
    value.evidence.domReads = null; assert.throws(() => replayResponseEvidence(value, { category: "read", path: readPath }));
  } finally { await browser.close(); }
});

test("missing record and state source proof stays incomplete; present contradictions reject", async () => {
  const { sha256 } = await import("./capture.mjs");
  const record = records().item_1;
  const value = { row: { outcome: "completed", record, page: null, form: null, state: null },
    evidence: { stages: [{ stage: "primary", status: 200, contentType: "application/json" }] } };
  assert.equal(replayResponseEvidence(value, { category: "json" }), false);
  assert.equal(value.row.outcome, "completed");
  const state = { row: { record: null, page: null, form: null, state: { before: [], after: [], readback: { alerts: [] } } },
    evidence: { stages: ["before", "after", "readback"].map((name) => ({ stage: `state-${name}`, status: 200, contentType: "application/json" })) } };
  assert.equal(replayResponseEvidence(state, {}), false);
  for (const original of [value, state]) for (const body of [null, false, {}, { kind: "unknown", base64: "" }]) {
    const wrong = structuredClone(original); wrong.evidence.stages[0].sourceBody = body;
    assert.throws(() => replayResponseEvidence(wrong, { category: "json" }));
  }
  for (const [original, body, kind] of [[value, Buffer.from("[]"), "state"], [state, Buffer.from(JSON.stringify(record)), "record"]]) {
    const wrong = structuredClone(original);
    Object.assign(wrong.evidence.stages[0], { decodedBodyBytes: body.length, decodedBodySha256: sha256(body), sourceBody: retainJSONResponse(body, kind) });
    assert.throws(() => replayResponseEvidence(wrong, { category: "json" }));
  }
});

test("Chromium credential-bearing action is refused before any DOM event exposes it", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (r) => r.fulfill({ contentType: "text/html", body: referenceHtml(records().item_1, "en-US") }));
    await page.goto("http://localhost/marketplace/en-US/item_1");
    for (const authority of ["username-canary@", ":password-canary@", "username-canary:password-canary@"]) {
      await page.locator("form").first().evaluate((form, authority) => { form.action = `http://${authority}localhost/marketplace/en-US/item_1`; }, authority);
      const receipt = await page.evaluate(collectDOMReads, { source: snapshotMixedPage.toString(), readPath: "/marketplace/en-US/item_1" });
      assert.equal(/username-canary|password-canary/.test(JSON.stringify(receipt)), false);
      assert.equal(receipt.failure, "credential-filter-blocked"); assert.equal(receipt.page, null);
    }
  } finally { await browser.close(); }
});
