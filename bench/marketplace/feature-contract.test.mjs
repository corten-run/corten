import assert from "node:assert/strict";
import test from "node:test";
import { admitted, qualification, requiredFeatures, sourceFeatures, validateQualification } from "./feature-contract.mjs";
import { qualificationProbes } from "./qualification-fixture.mjs";

test("production admission requires all features from both sources, not a score or anchor status", () => {
  const q = (source) => qualification(qualificationProbes(), source);
  const a = { qualification: { fixture: q("fixture"), api: q("api") } };
  for (const source of ["fixture", "api"]) { validateQualification(a.qualification[source]); assert.deepEqual(a.qualification[source].missing, []); }
  assert.equal(admitted(a), true);
  delete a.qualification.api.probes.json.headers["x-content-type-options"];
  a.qualification.api = qualification(a.qualification.api.probes, "api");
  assert.equal(admitted(a), false); assert.deepEqual(a.qualification.api.missing, ["jsonHeaders"]);
  a.qualification.api.eligible = true;
  assert.throws(() => validateQualification(a.qualification.api));
  assert.equal(admitted({}), false);
});

test("fixture omits only upstream failure checks; exceptions are named and never silently scored n/a", () => {
  assert.deepEqual(requiredFeatures.filter((f) => !sourceFeatures("fixture").includes(f)).map((f) => f.key), ["page500", "json500", "deadline"]);
  const q = qualification({}, "api");
  assert.deepEqual(q.missing, requiredFeatures.map((f) => f.key));
  assert.throws(() => validateQualification(q), /missing raw HTTP probe/);
  assert.ok(!requiredFeatures.some((f) => ["etag", "readyDown", "logLines"].includes(f.key)));
  assert.throws(() => qualification({}, "unknown"));
});

test("raw probe inventory and health cannot be omitted or converted to an exclusion", () => {
  for (const key of ["page", "json", "pageBr", "crossSite", "liveness", "unfinishedHead", "cap", "slow", "afterUpstream", "afterConnections"]) {
    const p = qualificationProbes(); delete p[key];
    assert.throws(() => validateQualification(qualification(p, "api")), key);
  }
  for (const key of ["belowHeld", "afterwards"]) {
    const p = qualificationProbes(); p.cap[key] = 500;
    const q = validateQualification(qualification(p, "api"));
    assert.equal(q.eligible, false); assert.ok(q.missing.includes("connectionCap"));
  }
  const p = qualificationProbes(); p.page404 = { status: 404, ms: 1, headers: {}, bodyLength: 0 };
  assert.equal(validateQualification(qualification(p)).eligible, true, "native 404 representation need not imitate Corten's HTML");
});

test("inconclusive or contradictory transport probes cannot become capability results", () => {
  for (const h of [{ error: "could not connect" }, { closedMs: "0", timedOutMs: 40000 }, { closedMs: "0" }, { closedMs: 0, timedOutMs: 40000 }, { timedOutMs: -1 }]) {
    const p = qualificationProbes(); p.unfinishedHead = h;
    assert.throws(() => validateQualification(qualification(p)));
  }
  for (const mutate of [(p) => { p.page.timedOut = true; }, (p) => { p.page.error = "ECONNRESET"; }, (p) => { p.cap.releaseMs = "1"; }, (p) => { p.cap.error = "could not connect"; }]) {
    const p = qualificationProbes(); mutate(p);
    assert.throws(() => validateQualification(qualification(p)));
  }
  const p = qualificationProbes(); p.unfinishedHead = { timedOutMs: 40000 };
  assert.equal(validateQualification(qualification(p)).eligible, false, "an established connection held too long is an observed missing timeout");
});
