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
  assert.deepEqual(perRequest(tsv).get("no-x\tpage\tidentity"), [90, 92]);
});

test("a default costs the build as it is less the build without it, repeat by repeat, with the median and range", () => {
  const row = costs(tsv).find((r) => r.variant === "no-x");
  assert.deepEqual([row.cost, row.costRange], [11, [10, 12]]);
  assert.equal(row.request, 91);
  assert.equal(row.share.toFixed(3), (11 / 102).toFixed(3));
});

test("a build with one run of a pair, or no build as it is, is an error", () => {
  assert.throws(() => perRequest(tsv.split("\n").slice(0, 2).join("\n")), /one run, not two/);
  assert.throws(() => costs(tsv.split("\n").filter((l) => !l.startsWith("as-is")).join("\n")), /no as-is build/);
});
