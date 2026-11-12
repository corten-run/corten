import assert from "node:assert/strict";
import test from "node:test";
import { options, summarize, cellKeys, expectedChecks } from "./run.mjs";
import { verifyIdentity, pins } from "./build.mjs";
import { invalidRecords, requireJsonError } from "./checks.mjs";
import { verifyAlertRows } from "./alerts.mjs";
import { records as catalogRecords } from "../../catalog/fixtures.mjs";
import { records as marketplaceRecords } from "../../marketplace/fixtures.mjs";
import { validateRecord as catalogRecord } from "../../catalog/contract.mjs";
import { validateRecord as marketplaceRecord } from "../../marketplace/records.mjs";

test("explicit round, no runtime/source/profile filtering or load mode", () => {
  assert.equal(options(["bounded"]).round, "bounded");
  for (const args of [[], ["../bad"], ["x", "--runtime", "bun"], ["x", "--load", "1"], ["x", "--built", "forged.json"], ["x", "--image", "sha256:fake"], ["x", "--out"], ["x", "--out", "a", "--out", "b"]]) assert.throws(() => options(args));
  assert.equal(cellKeys().length, 8); assert.equal(new Set(cellKeys()).size, 8);
});
test("missing/failed native cells never qualify, even identical failures", () => {
  // Structural unit test only, not native evidence.
  const cells = Object.fromEntries(cellKeys().map((key) => [key, { outcome: "passed", tests: expectedChecks(key.split("-")[1]).map((name) => ({ name, outcome: "passed" })) }]));
  assert.equal(summarize(cells).functionalPassed, true);
  assert.equal(summarize(cells).readyForMeasurement, false); assert.equal(summarize(cells).readyForLoad, false);
  for (const key of cellKeys()) {
    const changed = structuredClone(cells); changed[key].outcome = "failed";
    assert.equal(summarize(changed).functionalPassed, false); delete changed[key]; assert.equal(summarize(changed).functionalPassed, false);
    const missing = structuredClone(cells); missing[key].tests.pop(); assert.equal(summarize(missing).functionalPassed, false);
    const duplicated = structuredClone(cells); duplicated[key].tests[0] = duplicated[key].tests[1]; assert.equal(summarize(duplicated).functionalPassed, false);
  }
  assert.ok(Object.values(summarize({}).pairs).every((pair) => !pair.independentChecksPassed));
});
test("identity gate rejects runtime, source, dependency and artifact substitutions", () => {
  const sources = [{ path: "server.mjs", sha256: "source" }], manifest = { dependencies: { express: "5.3.0" } };
  const node = { versions: { node: "24.22.2" }, installed: manifest.dependencies, sources: [...sources, { path: "static/htmx.min.js", sha256: "d6fdc75f204e6bdefa99b69bf1e6d4ac69b8a364f77929f45c13476b4000f717" }], dependenciesSha256: "deps", lockSha256: "lock" };
  const bun = { ...structuredClone(node), versions: { bun: pins.bunVersion, node: "24.3.0" } };
  verifyIdentity(node, bun, sources, manifest);
  for (const modify of [
    (n, b) => b.versions.bun = "0.0.0", (n) => n.versions.bun = pins.bunVersion,
    (n, b) => b.installed.express = "other", (n, b) => b.sources[0].sha256 = "stale",
    (n, b) => b.sources.push({ path: "replacement-renderer.js", sha256: "extra" }),
    (n, b) => b.dependenciesSha256 = "other", (n, b) => b.lockSha256 = "other",
  ]) { const n = structuredClone(node), b = structuredClone(bun); modify(n, b); assert.throws(() => verifyIdentity(n, b, sources, manifest)); }
});
test("invalid record probes are distinct from canonical fixtures", () => {
  for (const [kind, record, validate] of [["catalog", catalogRecords().record_1, catalogRecord], ["marketplace", marketplaceRecords().item_1, marketplaceRecord]]) {
    for (const [name, body] of Object.entries(invalidRecords(kind, record))) {
      // Unicode scalar validation is an additional robustness probe, not a current
      // shared record oracle guarantee (the record contracts accept JS strings).
      if (name === "lone-surrogate") continue;
      assert.throws(() => validate(JSON.parse(body), record.id), name);
    }
    validate(record, record.id);
  }
});
test("error response gate rejects false success, HTML, cacheability and leaked source errors", () => {
  const good = { status: 502, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: '{"error":"unavailable"}' };
  requireJsonError(good);
  for (const change of [{ status: 200 }, { headers: { ...good.headers, "content-type": "text/html" } }, { headers: { ...good.headers, "cache-control": "public" } }, { body: "" }, { body: '{"error":"private fault marker"}' }]) assert.throws(() => requireJsonError({ ...good, ...change }));
});
test("display-only alert, duplicate writes, wrong minor units and cross-session rows fail readback", () => {
  const expected = [{ item_id: "item_1", email: "test@example.test", target_minor: 1234 }];
  verifyAlertRows(expected, expected);
  for (const actual of [[], [...expected, ...expected], [{ ...expected[0], target_minor: 12.34 }], [{ ...expected[0], target_minor: "1234" }], [{ ...expected[0], email: "other@example.test" }], [{ ...expected[0], hidden: true }]]) assert.throws(() => verifyAlertRows(actual, expected));
});
