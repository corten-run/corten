import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { nightly } from "../marketplace/droplet-contract.mjs";
import { groupNames } from "./registry.mjs";
import { markdown, plan } from "./plan.mjs";

test("planning discovers current official options, but never fabricates ready evidence", () => {
  for (const name of groupNames) {
    const p = plan(name);
    assert.ok(p.coverage.cells.every((c) => c.parity === "not-run" && c.measurement === "not-run"));
    if (name === "localized-marketplace") assert.deepEqual(p.execution.options, nightly);
    else assert.equal(p.execution.status, "pending-group-runner-integration");
  }
});
test("documented group matrix is generated from the registry", () => {
  const doc = readFileSync(new URL("README.md", import.meta.url), "utf8");
  assert.equal(doc.split("<!-- groups:start -->\n")[1]?.split("\n<!-- groups:end -->")[0], markdown());
});
