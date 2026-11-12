import assert from "node:assert/strict";
import { contractSha256, definition, registrySchema, selectedApps } from "./registry.mjs";

export const evidenceSchema = "benchmark-group-coverage/v1";
const parityStates = ["not-run", "passed", "failed", "unsupported"];
const measurementStates = ["not-run", "complete", "failed", "unsupported"];
// A coverage ledger is not proof of parity or a replacement for runner validation.
// Runners must derive these cells from their raw, versioned correctness evidence.
export function coverage(group, evidence = []) {
  const d = definition(group), apps = selectedApps(group);
  assert.ok(Array.isArray(evidence));
  const seen = new Set();
  for (const row of evidence) {
    assert.ok(apps.includes(row.app), "evidence names an unselected adapter");
    assert.ok(d.cases.some((c) => c.key === row.case), "evidence names an unknown case");
    const key = `${row.app}/${row.case}`;
    assert.ok(!seen.has(key), "duplicate coverage cell"); seen.add(key);
    assert.ok(["unknown", "implemented", "not-implemented"].includes(row.implementation), "implementation state required");
    assert.ok(parityStates.includes(row.parity), "parity state required");
    assert.ok(measurementStates.includes(row.measurement), "measurement state required");
    assert.ok(typeof row.reason === "string" && row.reason.trim(), "cell needs its evidence or missing-work reason");
    if (row.implementation !== "implemented") {
      assert.equal(row.parity, "not-run"); assert.equal(row.measurement, "not-run");
    }
    if (row.measurement === "complete") {
      assert.equal(row.parity, "passed", "unequal work cannot supply comparative measurements");
      assert.ok(row.artifact && typeof row.artifact === "string", "completed cell needs raw artifact reference");
    }
    if (row.metrics !== undefined) {
      assert.equal(row.measurement, "complete", "missing/failed/unsupported is not a numeric result");
      assert.ok(row.metrics && typeof row.metrics === "object" && !Array.isArray(row.metrics));
      assert.ok(Object.keys(row.metrics).length > 0, "empty metrics are not results");
      for (const value of Object.values(row.metrics)) assert.ok(Number.isFinite(value) && value >= 0, "invalid metric");
    }
  }
  const cells = apps.flatMap((app) => d.cases.map((c) => evidence.find((row) => row.app === app && row.case === c.key)
    ?? { app, case: c.key, implementation: "unknown", parity: "not-run", measurement: "not-run", reason: "No current group evidence supplied" }));
  return { schema: evidenceSchema, registry: registrySchema, contractSha256: contractSha256(group), group, apps, cases: d.cases, cells };
}
