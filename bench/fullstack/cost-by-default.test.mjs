import assert from "node:assert/strict";
import test from "node:test";
import { costs, perRequest } from "./cost-by-default.mjs";

const tsv = [
  "variant\ttarget\tencoding\trepeat\trequests\tinstructions",
  // as-is: 100 a request, then 104; without the default: 90, then 92.
  "as-is\tpage\tidentity\t1\t300\t1000",
  "as-is\tpage\tidentity\t1\t1300\t101000",
  "as-is\tpage\tidentity\t2\t300\t1000",
  "as-is\tpage\tidentity\t2\t1300\t105000",
  "no-x\tpage\tidentity\t1\t1300\t91000",
  "no-x\tpage\tidentity\t1\t300\t1000",
  "no-x\tpage\tidentity\t2\t300\t1000",
  "no-x\tpage\tidentity\t2\t1300\t93000",
].join("\n");

test("one request is the larger run less the smaller over the requests between them, in either row order", () => {
  assert.deepEqual([...perRequest(tsv).get("no-x\tpage\tidentity")], [["1", 90], ["2", 92]]);
});

test("a default costs the build as it is less the build without it, repeat by repeat, with the median and range", () => {
  const row = costs(tsv).find((r) => r.variant === "no-x");
  assert.deepEqual([row.cost, row.costRange], [11, [10, 12]]);
  assert.equal(row.request, 91);
  assert.equal(row.share.toFixed(3), (11 / 102).toFixed(3));
});

test("a default's cost is the median of the repeats' differences, not the difference of medians", () => {
  // as-is 100, 110, 130 a request; without the default 90, 80, 125: differences 10, 30, 5.
  const rows = [["as-is", [100, 110, 130]], ["no-x", [90, 80, 125]]].flatMap(([variant, per]) =>
    per.flatMap((v, i) => [`${variant}\tpage\tidentity\t${i + 1}\t300\t1000`, `${variant}\tpage\tidentity\t${i + 1}\t1300\t${1000 + v * 1000}`]));
  const row = costs(["variant\ttarget\tencoding\trepeat\trequests\tinstructions", ...rows].join("\n")).find((r) => r.variant === "no-x");
  // The difference of the medians would be 110 - 90 = 20.
  assert.deepEqual([row.cost, row.costRange], [10, [5, 30]]);
});

test("repeats are paired by number, not by where they are in the file", () => {
  const lines = tsv.split("\n");
  // no-x's repeat 2 first: the pairing must not change.
  const swapped = [lines[0], ...lines.slice(1, 5), lines[7], lines[8], lines[5], lines[6]].join("\n");
  assert.deepEqual(costs(swapped).find((r) => r.variant === "no-x").costRange, [10, 12]);
  // A repeat with no as-is run is an error, not dropped.
  const extra = [tsv, "no-x\tpage\tidentity\t3\t300\t1000", "no-x\tpage\tidentity\t3\t1300\t91000"].join("\n");
  assert.throws(() => costs(extra), /repeat 3 has no as-is run/);
  // Nor is an as-is repeat the build without the default lacks (a run that stopped partway).
  const partial = [tsv, "as-is\tpage\tidentity\t3\t300\t1000", "as-is\tpage\tidentity\t3\t1300\t101000"].join("\n");
  assert.throws(() => costs(partial), /no-x\tpage\tidentity: no run of repeat 3, which as-is has/);
});

test("a build with one run of a pair, three runs, or no build as it is, is an error", () => {
  assert.throws(() => perRequest([tsv, "as-is\tpage\tidentity\t1\t2300\t201000"].join("\n")), /more than two runs/);
  assert.throws(() => perRequest(tsv.split("\n").slice(0, 2).join("\n")), /one run, not two/);
  assert.throws(() => perRequest([tsv, "as-is\tpage\tidentity\t1\t300\t1200"].join("\n")), /two runs of 300 requests/);
  assert.throws(() => costs(tsv.split("\n").filter((l) => !l.startsWith("as-is")).join("\n")), /no as-is build/);
});
