// Conformance groundwork, not a load runner or a production formatting helper.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { allApps } from "../fullstack/apps.mjs";

export const workload = "marketplace-v2";
export const locales = ["en-US", "fr-FR", "de-DE"];
export const apps = Object.keys(allApps).filter((name) => allApps[name].pages !== false);
// Explicit minor units avoid differing binary-float parses of decimal prices.
// Ratings are hundredths; formatting rounds to one fraction digit, half away from zero.
export function cases() {
  return {
    prices: [0, 1, 10, 125, 123450, 123456789, -123450].map((minor, i) => ({ id: `price_${i}`, minor, currency: "USD" })),
    ratings: [0, 400, 425, 475, 499].map((hundredths, i) => ({ id: `rating_${i}`, hundredths })),
    counts: [0, 1, 2, 1000, 1000000].map((value, i) => ({ id: `count_${i}`, value })),
  };
}
const exact = (value, keys, at) => {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${at}: object required`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${at}: keys`);
};
export function validateCases(input) {
  exact(input, ["prices", "ratings", "counts"], "input");
  for (const [key, fields, valueKey] of [["prices", ["id", "minor", "currency"], "minor"],
    ["ratings", ["id", "hundredths"], "hundredths"], ["counts", ["id", "value"], "value"]]) {
    assert.ok(Array.isArray(input[key]) && input[key].length > 0, `${key}: non-empty array required`);
    const ids = new Set();
    for (const row of input[key]) {
      exact(row, fields, key);
      assert.ok(typeof row.id === "string" && /^[a-z]+_\d+$/.test(row.id) && !ids.has(row.id), `${key}: distinct id required`);
      ids.add(row.id);
      assert.ok(Number.isSafeInteger(row[valueKey]) && Math.abs(row[valueKey]) <= 1000000000, `${key}: bounded integer required`);
      if (key === "prices") assert.equal(row.currency, "USD", "v2 measures USD, not a currency-conversion service");
      if (key === "ratings") assert.ok(row.hundredths >= 0 && row.hundredths <= 500, "rating must be between zero and five");
      if (key === "counts") assert.ok(row.value >= 0, "count must not be negative");
    }
  }
  return input;
}
export function fixtureSha256(input = cases()) {
  validateCases(input);
  // Fixed field order makes the fingerprint independent of a JSON parser's object order.
  const canonical = {
    prices: input.prices.map(({ id, minor, currency }) => ({ id, minor, currency })),
    ratings: input.ratings.map(({ id, hundredths }) => ({ id, hundredths })),
    counts: input.counts.map(({ id, value }) => ({ id, value })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
export function expected(locale, input = cases()) {
  assert.ok(locales.includes(locale), `unsupported benchmark locale ${locale}`);
  validateCases(input);
  assert.equal(Intl.NumberFormat.supportedLocalesOf([locale]).length, 1, `Intl lacks ${locale}`);
  const price = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", currencyDisplay: "symbol", useGrouping: true,
    minimumFractionDigits: 2, maximumFractionDigits: 2, roundingMode: "halfExpand" });
  const rating = new Intl.NumberFormat(locale, { useGrouping: true, minimumFractionDigits: 0, maximumFractionDigits: 1, roundingMode: "halfExpand" });
  const count = new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 0 });
  const plurals = new Intl.PluralRules(locale, { type: "cardinal" });
  const words = { "en-US": { one: "listing", other: "listings" }, "fr-FR": { one: "annonce", many: "d\u2019annonces", other: "annonces" },
    "de-DE": { one: "Angebot", other: "Angebote" } };
  return {
    prices: input.prices.map((row) => ({ id: row.id, text: price.format(row.minor / 100) })),
    ratings: input.ratings.map((row) => ({ id: row.id, text: rating.format(row.hundredths / 100) })),
    counts: input.counts.map((row) => ({ id: row.id, text: `${count.format(row.value)} ${words[locale][plurals.select(row.value)] ?? words[locale].other}` })),
  };
}
// CLDR/ICU releases differ in grouping/currency space choice. Do not normalize punctuation,
// symbols, digits, signs, words, repeated whitespace, or currency codes into equivalence.
const spaces = (text) => text.replace(/[\u00a0\u202f]/g, " ");
export function checkFormattingCapture(capture, input = cases()) {
  exact(capture, ["workload", "app", "source", "locale", "fixtureSha256", "prices", "ratings", "counts"], "capture");
  assert.equal(capture.workload, workload, "wrong workload");
  assert.ok(apps.includes(capture.app), "capture must name one of the eighteen page apps");
  assert.ok(["fixture", "api"].includes(capture.source), "source must be fixture or api");
  assert.equal(capture.fixtureSha256, fixtureSha256(input), "capture used a different numeric fixture");
  const wanted = expected(capture.locale, input);
  for (const key of ["prices", "ratings", "counts"]) {
    assert.ok(Array.isArray(capture[key]), `${key}: expected array`);
    const actual = capture[key].map((row) => {
      exact(row, ["id", "text"], key);
      assert.equal(typeof row.text, "string", `${key}: formatted text required`);
      return { id: row.id, text: spaces(row.text) };
    });
    assert.deepEqual(actual, wanted[key].map((row) => ({ ...row, text: spaces(row.text) })), `${capture.locale} ${key}: formatting differs`);
  }
  return { workload, app: capture.app, locale: capture.locale, source: capture.source, formattingPassed: true,
    readyForLoad: false, scope: "Formatting capture only; does not prove request-time work, whole-page parity, interactions, JSON parity or measurement readiness." };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 2, "usage: node bench/marketplace/contract.mjs");
  console.log(JSON.stringify({ workload, locales, fixtureSha256: fixtureSha256(), input: cases() }, null, 2));
}
