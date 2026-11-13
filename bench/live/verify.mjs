import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { coverage } from "../workloads/evidence.mjs";
import { contractSha256, selectedApps } from "../workloads/registry.mjs";
import { recordedInventory, portFor, scenarios, settingsFor, workloadFor } from "./native.mjs";
import { verifyArtifact } from "./parity.mjs";
import { fanoutProfile, verifyFanout } from "./fanout.mjs";

export async function verifyRound(directory) {
  if (directory instanceof URL) directory = fileURLToPath(directory);
  const inspectedJson = new Set();
  const json = async (file) => { inspectedJson.add(file); return JSON.parse(await readFile(join(directory, file), "utf8")); };
  const plan = await json("plan.json"), saved = await json("coverage.json");
  const sourceDiff = gunzipSync(await readFile(join(directory, "source.diff.gz")), { maxOutputLength: 16 * 1024 * 1024 });
  assert.equal(createHash("sha256").update(sourceDiff).digest("hex"), plan.diffSha256, "saved source diff changed");
  assert.ok(["native-live-plan/v1", "native-live-plan/v2"].includes(plan.schema));
  const inventoryVersion = plan.schema === "native-live-plan/v1" ? 1 : 2;
  assert.equal(plan.contractSha256, contractSha256(plan.group));
  assert.deepEqual(plan.apps, selectedApps(plan.group), "selected app disappeared");
  const profile = plan.profile ?? "bounded";
  assert.deepEqual(plan.workload, workloadFor(profile));
  const capturedInventory = recordedInventory(plan.group, plan.inventory, profile, inventoryVersion);
  assert.deepEqual(plan.scenarios, scenarios(plan.group));
  assert.deepEqual(plan.settings, scenarios(plan.group).map((s) => settingsFor(plan.group, s, profile)));
  if (plan.measurement) assert.deepEqual(plan.measurement, fanoutProfile);
  const rows = [];
  const names = new Set(await readdir(directory)), inspected = new Set(), unqualified = [], passedApps = [], measuredApps = [];
  assert.ok(plan.requested.length && new Set(plan.requested).size === plan.requested.length
    && plan.requested.every((a) => plan.apps.includes(a)), "invalid requested native inventory");
  const artifactFile = async (file, maxOutputLength = 32 * 1024 * 1024) => {
    assert.match(file.file, /^[a-z0-9-]+\.json\.gz$/, "unsafe native artifact path");
    const bytes = await readFile(join(directory, file.file));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, "artifact bytes changed");
    inspected.add(file.file);
    return JSON.parse(gunzipSync(bytes, { maxOutputLength }));
  };
  const attempt = (app, detail, check) => {
    try { check(); return true; }
    catch (error) { unqualified.push({ app, ...detail, reason: error.message.slice(0, 600) }); return false; }
  };
  for (const entry of capturedInventory) {
    const cell = saved.cells.find((r) => r.app === entry.app);
    assert.ok(cell, "missing coverage cell");
    assert.equal(cell.implementation, entry.implementation, "native implementation status was relabeled");
    const manifestName = `${entry.app}-artifacts.json`, measurementName = `${entry.app}-measurements.json`;
    const hasScenarios = names.has(manifestName), hasMeasurements = names.has(measurementName);
    let startupFailure;
    if (names.has(`${entry.app}-failure.json`)) {
      assert.ok(plan.requested.includes(entry.app), "unrequested native failure evidence");
      startupFailure = await json(`${entry.app}-failure.json`);
      assert.equal(startupFailure.app, entry.app);
      assert.ok(typeof startupFailure.error === "string" && startupFailure.error.length, "missing native startup failure evidence");
    }
    let artifacts = [], qualified = [], manifest;
    if (hasScenarios || cell.parity === "passed" || cell.artifact) {
      assert.ok(plan.requested.includes(entry.app), "unrequested app claims native evidence");
      assert.equal(cell.artifact, manifestName, "retained scenario manifest hidden by coverage flags");
      manifest = await json(manifestName);
      assert.equal(manifest.app, entry.app); assert.equal(manifest.group, plan.group);
      assert.deepEqual(manifest.files.map((r) => r.file), scenarios(plan.group).map((s) => `${entry.app}-${s}.json.gz`), "incomplete scenario inventory");
      for (const [i, file] of manifest.files.entries()) {
        const artifact = await artifactFile(file);
        assert.equal(artifact.app, entry.app); assert.equal(artifact.group, plan.group);
        assert.equal(artifact.scenario, scenarios(plan.group)[i]);
        assert.equal(artifact.profile ?? "bounded", profile);
        assert.equal(artifact.provenance.commit, plan.commit);
        assert.deepEqual(artifact.provenance.code, plan.code);
        assert.equal(artifact.provenance.diffSha256, plan.diffSha256);
        if (artifacts.length) assert.deepEqual(artifact.provenance, artifacts[0].provenance,
          "qualification scenario provenance differs from the measured native instance");
        artifacts.push(artifact);
        if (artifact.schema === "native-live-evidence/v1") {
          if (attempt(entry.app, { scenario: artifact.scenario }, () => verifyArtifact(artifact,
            { app: entry.app, group: plan.group, scenario: artifact.scenario }))) qualified.push(artifact);
        } else {
          assert.equal(artifact.schema, "native-live-failure/v1");
          assert.ok(typeof artifact.error === "string" && artifact.error.length, "failure artifact missing actual error");
          assert.equal(artifact.summary, undefined, "failed scenario presents passing numbers");
        }
      }
      const capturedPasses = artifacts.filter((a) => a.schema === "native-live-evidence/v1").length;
      assert.equal(cell.parity, capturedPasses === scenarios(plan.group).length ? "passed" : "failed", "scenario coverage flag hides retained evidence");
      assert.equal(cell.reason, `${capturedPasses}/${scenarios(plan.group).length} bounded native browser journeys passed; no load qualification`);
      if (qualified.length === scenarios(plan.group).length) passedApps.push(entry.app);
    } else if (plan.requested.includes(entry.app) && entry.implementation === "implemented"
      && (!entry.profiles || entry.profiles.includes(profile))) {
      assert.ok(startupFailure, "missing native startup failure evidence");
      assert.equal(cell.parity, "failed");
    } else {
      assert.equal(cell.parity, "not-run");
    }
      if (hasMeasurements || ["complete", "failed"].includes(cell.measurement)
        || (plan.measurement && artifacts.length && artifacts.every((a) => a.schema === "native-live-evidence/v1"))) {
        assert.deepEqual(plan.measurement, fanoutProfile, "measurement was not explicitly requested");
        assert.ok(manifest, "measurement lacks native qualification manifest");
        assert.equal(cell.measurementArtifact, measurementName, "retained measurement manifest hidden by coverage flags");
        const measured = await json(cell.measurementArtifact);
        assert.deepEqual(measured.profile, fanoutProfile);
        assert.deepEqual(measured.files.map((r) => r.file), fanoutProfile.clients.map((n) => `${entry.app}-fanout-${n}.json.gz`));
        let capturedPasses = 0, validated = 0;
        for (const [i, file] of measured.files.entries()) {
          const artifact = await artifactFile(file);
          assert.equal(artifact.clients, fanoutProfile.clients[i]);
          assert.equal(artifact.app, entry.app); assert.equal(artifact.group, plan.group);
          assert.deepEqual(artifact.provenance, artifacts[0].provenance);
          assert.deepEqual(artifact.qualification, manifest.files);
          if (["native-live-fanout/v1", "native-live-fanout/v2"].includes(artifact.schema)) {
            capturedPasses++;
            if (attempt(entry.app, { clients: artifact.clients }, () => {
              verifyFanout(artifact, { app: entry.app, group: plan.group, provenance: artifacts[0].provenance,
                qualification: manifest.files, settings: artifacts[0].settings, wire: portFor(entry.app, profile)?.wire });
              assert.equal(qualified.length, scenarios(plan.group).length, "measurement native qualification is incomplete");
            })) validated++;
          } else {
            assert.equal(artifact.schema, "native-live-fanout-failure/v1");
            assert.ok(typeof artifact.error === "string" && artifact.error.length > 0);
            assert.equal(artifact.summary, undefined, "failed measurement cannot present numeric results");
          }
        }
        assert.equal(cell.measurement, capturedPasses === fanoutProfile.clients.length ? "complete" : "failed", "measurement coverage flag hides retained evidence");
        if (validated === fanoutProfile.clients.length) measuredApps.push(entry.app);
      } else {
        assert.equal(cell.measurement, "not-run");
        assert.equal(cell.measurementArtifact, undefined);
      }
    rows.push(cell);
  }
  const expected = coverage(plan.group, rows);
  expected.readyForLoad = inventoryVersion === 1 ? false : rows.every((r) => r.implementation === "implemented" && r.parity === "passed"
    && (!plan.measurement || r.measurement === "complete"));
  assert.deepEqual(saved, expected, "coverage ledger changed or claims load qualification");
  for (const name of names) if (name.endsWith(".json.gz")) assert.ok(inspected.has(name), `uninspected retained native artifact: ${name}`);
  for (const name of names) if (/-(artifacts|measurements|failure)\.json$/.test(name)) {
    assert.ok(inspectedJson.has(name), `uninspected retained native manifest/failure: ${name}`);
  }
  return { group: plan.group, passed: passedApps, measured: measuredApps, unqualified,
    inspected: [...inspected], missing: plan.apps.filter((a) => !passedApps.includes(a)),
    readyForLoad: capturedInventory.every((r) => r.implementation === "implemented" && passedApps.includes(r.app)
      && (!plan.measurement || measuredApps.includes(r.app))) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(process.argv[2], "usage: node bench/live/verify.mjs <artifact-directory>");
  const result = await verifyRound(resolve(process.argv[2]));
  console.log(JSON.stringify(result, null, 2));
  if (result.unqualified.length) process.exitCode = 1;
}
