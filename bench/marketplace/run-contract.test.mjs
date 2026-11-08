import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { cpuSettings, imageProvenance, inventory, parseArgs } from "./run-contract.mjs";
test("versioned round namespace and safe defaults", () => {
  assert.match(inventory.nextjs.label, /Pages Router/);
  assert.doesNotMatch(inventory.phoenix.label, /LiveView/);
  assert.doesNotMatch(inventory.laravel.label, /Livewire/);
  assert.deepEqual(parseArgs(["w1"], { corten: {} }).apps, ["corten"]);
  assert.equal(parseArgs(["w1"], {}).passes, 3);
  for (const round of ["r17", "c1", "m1", "w0"]) assert.throws(() => parseArgs([round], {}));
  assert.throws(() => parseArgs(["w1", "--apps", "absent"], { corten: {} }));
});
test("v2 CPU placement ignores catalog environment and rejects overlapping roles", () => {
  assert.equal(cpuSettings({ CATALOG_APP_CPUS: "0" }).app.cpuset, null);
  assert.equal(cpuSettings({ MARKETPLACE_APP_CPUS: "0" }).app.cpuset, "0");
  assert.throws(() => cpuSettings({ MARKETPLACE_APP_CPUS: "0", MARKETPLACE_LOAD_CPUS: "0-3" }));
});

test("load rejects dirty-built or unproven images even at the same HEAD", () => {
  const commit = "a".repeat(40), labels = { "run.corten.marketplace.commit": commit, "run.corten.marketplace.dirty": "false" };
  assert.deepEqual(imageProvenance(labels, commit, false), { builtCommit: commit, builtDirty: false });
  for (const dirty of ["true", undefined]) assert.throws(() => imageProvenance({ ...labels, "run.corten.marketplace.dirty": dirty }, commit, false));
  assert.throws(() => imageProvenance(labels, "b".repeat(40), false));
  assert.equal(imageProvenance({}, commit, true).builtDirty, true);
});
test("legacy selection cannot silently reduce the eighteen-app default", () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import { inventory, parseArgs } from ${JSON.stringify(new URL("./run-contract.mjs", import.meta.url).href)}; console.log(parseArgs(['w1'], inventory).apps.length);`], { env: { ...process.env, BENCH_APPS: "corten", BENCH_TIER: "matched" }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "18");
});
