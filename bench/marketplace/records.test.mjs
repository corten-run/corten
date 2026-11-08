import assert from "node:assert/strict";
import test from "node:test";
import { records } from "./fixtures.mjs";
import { expectedPage, normalize, validateMarketplace, validateRecord } from "./records.mjs";
import { comparePage } from "./check.mjs";
const data = records();
test("all 500 rich fixtures are canonical, linked and deterministic", () => {
  assert.deepEqual(validateMarketplace(data), records());
  assert.equal(data.item_1.listings.length, 25);
  assert.equal(data.item_1.offers.length, 12);
  assert.equal(data.item_500.listings.length, 0);
});
test("reject formatted numbers, extra JSON keys and missing collections", () => {
  const change = (mutate) => { const r = structuredClone(data.item_1); mutate(r); assert.throws(() => validateRecord(r)); };
  change((r) => { r.listings[0].price_minor = "$1.00"; });
  change((r) => { r.extra = 1; });
  change((r) => { delete r.offers; });
  change((r) => { r.listings[0].rating_hundredths = 501; });
});
const normalized = (v) => typeof v === "string" ? normalize(v) : Array.isArray(v) ? v.map(normalized) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalized(x)])) : v;
test("whole-page oracle rejects shortened pages, incorrect money and unstably sorted rows", () => {
  const correct = normalized(expectedPage(data.item_1, "fr-FR"));
  comparePage(correct, data.item_1, "fr-FR");
  for (const mutate of [(p) => p.listings.pop(), (p) => { p.listings[0].cells[4] = "$1.00"; }, (p) => { p.fields = []; }, (p) => { p.offers.push(p.offers[0]); },
    (p) => { const nullRows = p.listings.filter((v) => v.cells[4] === "—"); p.listings = [...nullRows, ...p.listings.filter((v) => v.cells[4] !== "—")]; }]) {
    const wrong = structuredClone(correct); mutate(wrong); assert.throws(() => comparePage(wrong, data.item_1, "fr-FR"));
  }
});
test("case-sensitive prefix, nulls last, stable ties and show-all are independently checked", () => {
  assert.notDeepEqual(expectedPage(data.item_1, "en-US", { seller: "Alice" }).listings, expectedPage(data.item_1, "en-US", { seller: "alice" }).listings);
  assert.equal(expectedPage(data.item_1, "en-US", { seller: " Alice" }).listings.length, 0);
  const asc = expectedPage(data.item_1, "en-US").listings, desc = expectedPage(data.item_1, "en-US", { sort: "desc" }).listings;
  assert.equal(asc.at(-1).cells[4], "—"); assert.equal(desc.at(-1).cells[4], "—");
  assert.deepEqual(asc.filter((v) => v.cells[4] === "$0.01").map((v) => v.id), desc.filter((v) => v.cells[4] === "$0.01").map((v) => v.id));
  assert.equal(expectedPage(data.item_1, "de-DE").offers.length, 5);
  assert.equal(expectedPage(data.item_1, "de-DE", { all: true }).offers.length, 12);
});
