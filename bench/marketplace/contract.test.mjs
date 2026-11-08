import assert from "node:assert/strict";
import test from "node:test";
import { apps, cases, checkFormattingCapture, expected, fixtureSha256, locales, validateCases, workload } from "./contract.mjs";

function capture(locale = "en-US", input = cases()) {
  return { workload, app: "corten", source: "fixture", locale, fixtureSha256: fixtureSha256(input), ...expected(locale, input) };
}
test("the contract covers all eighteen page frameworks, never the JSON-only entry", () => {
  assert.equal(apps.length, 18);
  assert.ok(!apps.includes("aspnet-aot"));
  assert.deepEqual(locales, ["en-US", "fr-FR", "de-DE"]);
});
test("locale outputs differ in actual number formatting, not only labels", () => {
  assert.equal(expected("en-US").prices[4].text, "$1,234.50");
  assert.equal(expected("fr-FR").prices[4].text.replace(/[\u00a0\u202f]/g, " "), "1 234,50 $US");
  assert.equal(expected("de-DE").prices[4].text.replace(/\u00a0/g, " "), "1.234,50 $");
  assert.equal(expected("en-US").prices[0].text, "$0.00");
  assert.equal(expected("en-US").prices[6].text, "-$1,234.50");
  assert.equal(expected("en-US").ratings[2].text, "4.3");
  assert.equal(expected("fr-FR").ratings[2].text, "4,3");
  assert.equal(expected("en-US").counts[0].text, "0 listings");
  assert.equal(expected("fr-FR").counts[0].text, "0 annonce");
  assert.match(expected("fr-FR").counts[4].text, /d\u2019annonces$/);
});
test("an English price/rating/count copied into another locale fails", () => {
  for (const key of ["prices", "ratings", "counts"]) {
    const c = capture("fr-FR");
    c[key] = expected("en-US")[key];
    assert.throws(() => checkFormattingCapture(c), /formatting differs/);
  }
});
test("all apps and both sources use one oracle and no capture certifies load readiness", () => {
  for (const app of apps) for (const source of ["fixture", "api"]) for (const locale of locales) {
    const result = checkFormattingCapture({ ...capture(locale), app, source });
    assert.equal(result.formattingPassed, true);
    assert.equal(result.readyForLoad, false);
  }
});
test("spacing tolerance does not hide wrong symbols, digits, repeated spaces or ordering", () => {
  const c = capture("fr-FR");
  for (const row of c.prices) row.text = row.text.replace(/[\u00a0\u202f]/g, " ");
  assert.equal(checkFormattingCapture(c).formattingPassed, true);
  for (const text of ["1 234,50 EUR", "1 234.50 $US", "1  234,50 $US", "1 234,50 $"]) {
    const wrong = structuredClone(c); wrong.prices[4].text = text;
    assert.throws(() => checkFormattingCapture(wrong), /formatting differs/);
  }
  c.prices.reverse();
  assert.throws(() => checkFormattingCapture(c), /formatting differs/);
});
test("changed numbers require new answers and their own fixture fingerprint", () => {
  const input = cases();
  input.prices[4].minor = 99999;
  const stale = capture();
  assert.throws(() => checkFormattingCapture(stale, input), /different numeric fixture/);
  stale.fixtureSha256 = fixtureSha256(input);
  assert.throws(() => checkFormattingCapture(stale, input), /formatting differs/);
  assert.equal(checkFormattingCapture(capture("en-US", input), input).formattingPassed, true);
  const reordered = cases();
  reordered.prices = reordered.prices.map(({ id, minor, currency }) => ({ currency, minor, id }));
  assert.equal(fixtureSha256(reordered), fixtureSha256());
});
test("malformed, unsupported and incomplete captures fail closed", () => {
  for (const change of [(c) => { c.app = "aspnet-aot"; }, (c) => { c.locale = "es-ES"; }, (c) => { c.source = "cached"; },
    (c) => { c.workload = "catalog-v1"; }, (c) => { c.prices.pop(); }, (c) => { c.prices[0].text = 0; },
    (c) => { c.prices[1].id = c.prices[0].id; }, (c) => { c.unexpected = true; }]) {
    const c = capture(); change(c); assert.throws(() => checkFormattingCapture(c));
  }
  for (const change of [(i) => { i.prices[0].minor = Infinity; }, (i) => { i.prices[0].currency = "EUR"; },
    (i) => { i.ratings[0].hundredths = 501; }, (i) => { i.counts[0].value = -1; }, (i) => { i.prices = []; }]) {
    const input = cases(); change(input); assert.throws(() => validateCases(input));
  }
});
