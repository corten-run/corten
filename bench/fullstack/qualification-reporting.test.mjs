import assert from "node:assert/strict";
import test from "node:test";
import { produceBoundedQualification, qualification, validateActiveQualification, validateQualification } from "../marketplace/feature-contract.mjs";
import { boundedQualificationProbes, qualificationProbes } from "../marketplace/qualification-fixture.mjs";

test("an archived pass is readable but cannot establish bounded qualification", () => {
  const archived = validateQualification(qualification(qualificationProbes(), "api"));
  assert.equal(archived.eligible, true);
  assert.match(archived.cells.connectionCap, /^capped/);
  assert.throws(() => validateActiveQualification(archived));

  const current = validateActiveQualification(produceBoundedQualification(boundedQualificationProbes("api"), "api"));
  assert.equal(current.eligible, true);
  assert.notEqual(current.profile, archived.profile);
  assert.ok(current.unmeasured.includes("connectionCap"));
  assert.ok(current.unmeasured.includes("unfinishedHead"));
  assert.equal(Object.hasOwn(current.cells, "connectionCap"), false);
  assert.equal(Object.hasOwn(current.cells, "unfinishedHead"), false);
  assert.throws(() => validateQualification(current));
  assert.throws(() => validateActiveQualification({ ...current, probes: archived.probes }), /unexpected or missing/);
});
