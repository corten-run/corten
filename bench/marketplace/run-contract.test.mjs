import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { cpuSettings, imageProvenance, inventory, parseArgs, resultSchema, roundIdentity, timedProfiles } from "./run-contract.mjs";
test("versioned round namespace and safe defaults", () => {
  assert.match(inventory.nextjs.label, /Pages Router/);
  assert.doesNotMatch(inventory.phoenix.label, /LiveView/);
  assert.doesNotMatch(inventory.laravel.label, /Livewire/);
  assert.deepEqual(parseArgs(["w1"], { corten: {} }).apps, ["corten"]);
  assert.equal(parseArgs(["w1"], {}).passes, 3);
  assert.equal(parseArgs(["r17"], inventory).apps.length, 18);
  assert.equal(parseArgs(["r18", "--build"], inventory).round, "r18");
  assert.throws(() => parseArgs(["r17"], { corten: {} }));
  assert.deepEqual(roundIdentity("r999"), { kind: "official", number: 999 });
  for (const round of [undefined, "r1", "r16", "r0", "r017", "r17x", "r17.0", "r17\n", "r17 ", "r-17", "r9007199254740992", "w9007199254740992", "c1", "m1", "w0", "w01"]) assert.throws(() => parseArgs([round], {}));
  for (const flags of [["--apps", "corten"], ["--passes", "1"], ["--passes", "5"], ["--check-only"]]) assert.throws(() => parseArgs(["r17", ...flags], inventory));
  assert.equal(parseArgs(["w1", "--apps", "corten", "--passes", "1", "--check-only"], inventory).checkOnly, true);
  assert.throws(() => parseArgs(["w1", "--apps", "absent"], { corten: {} }));
});

test("timed schema has six localized pages and exactly two locale-neutral JSON profiles", () => {
  assert.equal(resultSchema, "marketplace-results/v2");
  assert.equal(timedProfiles.length, 8);
  assert.equal(new Set(timedProfiles.map((p) => p.key)).size, 8);
  for (const source of ["fixture", "api"]) {
    assert.deepEqual(timedProfiles.filter((p) => p.source === source && p.target === "page").map((p) => p.locale), ["en-US", "fr-FR", "de-DE"]);
    assert.deepEqual(timedProfiles.filter((p) => p.source === source && p.target === "json"), [{ key: `${source}-neutral-json`, source, locale: null, target: "json" }]);
  }
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
