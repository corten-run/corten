import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { coverage } from "../workloads/evidence.mjs";
import { contractSha256, selectedApps } from "../workloads/registry.mjs";
import { inventory, scenarios, settingsFor } from "./native.mjs";
import { verifyArtifact } from "./parity.mjs";

export async function verifyRound(directory) {
  if (directory instanceof URL) directory = fileURLToPath(directory);
  const json = async (file) => JSON.parse(await readFile(join(directory, file), "utf8"));
  const plan = await json("plan.json"), saved = await json("coverage.json");
  const sourceDiff = gunzipSync(await readFile(join(directory, "source.diff.gz")), { maxOutputLength: 16 * 1024 * 1024 });
  assert.equal(createHash("sha256").update(sourceDiff).digest("hex"), plan.diffSha256, "saved source diff changed");
  assert.equal(plan.schema, "native-live-plan/v1");
  assert.equal(plan.contractSha256, contractSha256(plan.group));
  assert.deepEqual(plan.apps, selectedApps(plan.group), "selected app disappeared");
  assert.deepEqual(plan.inventory, inventory(plan.group));
  assert.deepEqual(plan.scenarios, scenarios(plan.group));
  assert.deepEqual(plan.settings, scenarios(plan.group).map((s) => settingsFor(plan.group, s)));
  const rows = [];
  for (const entry of inventory(plan.group)) {
    const cell = saved.cells.find((r) => r.app === entry.app);
    assert.ok(cell, "missing coverage cell");
    assert.equal(cell.implementation, entry.implementation, "native implementation status was relabeled");
    if (cell.parity === "passed") {
      assert.ok(plan.requested.includes(entry.app), "unrequested app claims passing evidence");
      const manifest = await json(`${entry.app}-artifacts.json`);
      assert.equal(manifest.app, entry.app); assert.equal(manifest.group, plan.group);
      assert.deepEqual(manifest.files.map((r) => r.file), scenarios(plan.group).map((s) => `${entry.app}-${s}.json.gz`), "incomplete scenario inventory");
      for (const [i, file] of manifest.files.entries()) {
        const bytes = await readFile(join(directory, file.file));
        assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, "artifact bytes changed");
        const artifact = JSON.parse(gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 }));
        assert.equal(artifact.provenance.commit, plan.commit);
        assert.deepEqual(artifact.provenance.code, plan.code);
        assert.equal(artifact.provenance.diffSha256, plan.diffSha256);
        verifyArtifact(artifact, { app: entry.app, group: plan.group, scenario: scenarios(plan.group)[i] });
      }
      assert.equal(cell.reason, `${scenarios(plan.group).length}/${scenarios(plan.group).length} bounded native browser journeys passed; no load qualification`);
    } else {
      assert.notEqual(cell.measurement, "complete");
      if (entry.implementation === "not-implemented") assert.equal(cell.parity, "not-run");
    }
    rows.push(cell);
  }
  const expected = coverage(plan.group, rows); expected.readyForLoad = false;
  assert.deepEqual(saved, expected, "coverage ledger changed or claims load qualification");
  return { group: plan.group, passed: rows.filter((r) => r.parity === "passed").map((r) => r.app),
    missing: rows.filter((r) => r.parity !== "passed").map((r) => r.app), readyForLoad: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(process.argv[2], "usage: node bench/live/verify.mjs <artifact-directory>");
  console.log(JSON.stringify(await verifyRound(resolve(process.argv[2])), null, 2));
}
