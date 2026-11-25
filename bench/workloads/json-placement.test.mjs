// The opted-in JSON API c-16 placement (issue 2057) in the fleet, its reservation and job.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import * as contract from "./cloud-contract.mjs";
import { digest } from "./cloud-local.mjs";
import { remoteFiles } from "./cloud-remote.mjs";
import { parseFleetArgs } from "./fleet.mjs";
import { groupNames } from "./registry.mjs";

const at = "2026-11-25T00:00:00.000Z", layout = "json-c16-generator-v1", c16 = { ...contract.host, size: "c-16", region: "sfo2" };
const tokens = Object.fromEntries(groupNames.map((group, i) => [group, (i + 1).toString(16).padStart(16, "0")]));
const input = (group) => ({ round: "r90", commit: "a".repeat(40), token: "f".repeat(16), tokens: { [group]: tokens[group] },
  provider: { accountId: "team:synthetic-fleet", context: "synthetic" }, sshKey: "42" });
const single = (group, extra = {}) => contract.fleetPlan(input(group), at, contract.host.region,
  { stagedPlacement: true, single: { group, indexSha256: "1".repeat(64), checkout: resolve("."), ...extra } });
const state = (fleet) => contract.reservation({ round: fleet.round, commit: fleet.commit, token: fleet.jobs[0].token,
  group: fleet.jobs[0].group, fleet }, at);
const resign = (fleet, change) => {
  const { fleetSha256, ...body } = structuredClone(fleet); change(body);
  return { ...body, fleetSha256: digest(JSON.stringify(body)) };
};
const catalog = (c16Available = true) => ({
  sizes: [{ slug: "c-8", available: true, regions: ["sfo3", "sfo2"] }, { slug: "c-16", available: c16Available, regions: ["sfo2"] }],
  regions: [{ slug: "sfo3", available: true, sizes: ["c-8"] }, { slug: "sfo2", available: true, sizes: ["c-8", "c-16"] }] });

test("an independent json-api fleet saved with the marker reserves c-16/sfo2 and passes the layout to its campaign", () => {
  for (const extra of [{ loadLayout: layout }, { loadLayout: layout, offlineHandoff: true }]) {
    const fleet = single("json-api", extra), s = state(fleet), [job] = fleet.jobs;
    assert.equal(contract.validateFleet(fleet), fleet); assert.equal(contract.validateLaunchFleet(fleet), fleet);
    assert.deepEqual(fleet.single, { group: "json-api", indexSha256: "1".repeat(64), checkout: resolve("."), ...extra });
    assert.deepEqual(job.host, c16); assert.equal(job.loadLayout, layout);
    assert.deepEqual(s.host, c16); assert.equal(contract.validateState(s, s.round), s);
    assert.equal(contract.fleetCreateMode("json-api", fleet), layout);
    assert.deepEqual(contract.providerCreateHost(layout), c16);
    assert.equal(contract.savedLoadLayout(s), layout); assert.equal(contract.savedPlacement(s), undefined);
    const job0 = contract.remoteFiles(s)["job.sh"], uploaded = remoteFiles(s)["job.sh"];
    assert.match(job0, /test "\$\(nproc\)" -ge 16\n/);
    assert.ok(job0.includes(`--group json-api --load-layout ${layout}\n`));
    assert.ok(uploaded.includes(`--group 'json-api' --load-layout '${layout}'\n`));
    assert.match(uploaded, /test "\$\(nproc\)" -ge 16\n/);
    assert.ok(!job0.includes("--placement") && !uploaded.includes("--placement"));
    const actual = { id: 123, name: job.name, tags: [...contract.tags, job.tag], size_slug: "c-16", region: { slug: "sfo2" },
      networks: { v4: [{ type: "public", ip_address: "192.0.2.10" }] } };
    assert.equal(contract.assertFleetCensus([actual], fleet), true);
    assert.throws(() => contract.assertFleetCensus([{ ...actual, size_slug: "c-8", region: { slug: "sfo3" } }], fleet));
  }
});

test("without the marker the json-api fleet, reservation and job keep the default c-8 placement and bytes", () => {
  const fleet = single("json-api"), s = state(fleet), [job] = fleet.jobs;
  assert.equal(Object.hasOwn(fleet.single, "loadLayout"), false);
  assert.equal(job.host, undefined); assert.equal(job.loadLayout, undefined);
  assert.deepEqual(s.host, contract.host);
  assert.equal(contract.fleetCreateMode("json-api", fleet), "dedicated");
  const job0 = contract.remoteFiles(s)["job.sh"];
  assert.match(job0, /test "\$\(nproc\)" -ge 8\n/);
  assert.ok(!job0.includes("--load-layout") && !job0.includes(layout));
  // Building an opted-in fleet elsewhere changes none of these default bytes.
  const before = { files: contract.remoteFiles(s), uploaded: remoteFiles(s) };
  single("json-api", { loadLayout: layout });
  assert.deepEqual({ files: contract.remoteFiles(s), uploaded: remoteFiles(s) }, before);
  // The full roster still binds only catalog to c-16, and never with the JSON API layout.
  const full = contract.fleetPlan({ ...input("json-api"), tokens }, at);
  for (const row of full.jobs) assert.equal(row.loadLayout, row.group === "catalog-page" ? "c16-generator-v1" : undefined);
});

test("a saved fleet cannot drop, add or change the marker apart from its job placement", () => {
  const wide = single("json-api", { loadLayout: layout }), narrow = single("json-api");
  for (const change of [(b) => { delete b.single.loadLayout; }, (b) => { delete b.jobs[0].host; delete b.jobs[0].loadLayout; },
    (b) => { b.jobs[0].loadLayout = "c16-generator-v1"; }, (b) => { b.single.loadLayout = "c16-generator-v1"; }])
    assert.throws(() => contract.validateFleet(resign(wide, change)), /fleet differs|load layout/);
  for (const change of [(b) => { b.jobs[0].host = c16; b.jobs[0].loadLayout = layout; }])
    assert.throws(() => contract.validateFleet(resign(narrow, change)), /fleet differs/);
  // Removing both copies yields the default fleet, but under a different digest than the saved one.
  const stripped = resign(wide, (b) => { delete b.single.loadLayout; delete b.jobs[0].host; delete b.jobs[0].loadLayout; });
  assert.equal(contract.validateFleet(stripped), stripped); assert.notEqual(stripped.fleetSha256, wide.fleetSha256);
  assert.throws(() => contract.validateFleet({ ...wide, fleetSha256: narrow.fleetSha256 }), /fleet differs/);
});

test("the marker refuses another group, value or fleet shape", () => {
  for (const group of groupNames.filter((name) => name !== "json-api"))
    assert.throws(() => single(group, { loadLayout: layout }), /unknown independent group load layout/);
  for (const value of ["c16-generator-v1", "", true, "JSON-C16-GENERATOR-V1", null])
    assert.throws(() => single("json-api", { loadLayout: value }), /load layout|unexpected or missing fields/);
  assert.throws(() => contract.fleetPlan(input("json-api"), at, contract.host.region,
    { single: { group: "json-api", indexSha256: "1".repeat(64), checkout: resolve("."), loadLayout: layout } }));
});

test("placement selection checks c-16 availability for the opted-in JSON API job only", () => {
  assert.equal(contract.fleetRegion(catalog(), undefined, { staged: true, group: "json-api", loadLayout: layout }), contract.host.region);
  assert.throws(() => contract.fleetRegion(catalog(false), undefined, { staged: true, group: "json-api", loadLayout: layout }),
    /not advertised: c-16\/sfo2/);
  for (const scope of [{ staged: false, group: "json-api", loadLayout: layout }, { staged: true, loadLayout: layout },
    { staged: true, group: "localized-marketplace", loadLayout: layout }, { staged: true, group: "json-api", loadLayout: "c16-generator-v1" }])
    assert.throws(() => contract.fleetRegion(catalog(), undefined, scope), /load layout/);
  // Without the marker an unavailable c-16 does not block the default c-8 JSON API host.
  assert.equal(contract.fleetRegion(catalog(false), undefined, { staged: true, group: "json-api" }), contract.host.region);
});

test("the fleet command selects the layout only at single-group json-api preparation", () => {
  const prepare = ["r90", "--prepare", "--continuation-root", resolve("work/fleet-test"), "--group", "json-api", "--commit", "a".repeat(40),
    "--ssh-key", "42", "--account-id", "team:synthetic-fleet", "--context", "synthetic"];
  assert.equal(parseFleetArgs([...prepare, "--load-layout", layout]).loadLayout, layout);
  assert.equal(parseFleetArgs(prepare).loadLayout, undefined);
  const marketplace = prepare.map((arg) => arg === "json-api" ? "localized-marketplace" : arg);
  for (const args of [[...prepare, "--load-layout", "c16-generator-v1"], [...prepare, "--load-layout", "JSON"],
    [...marketplace, "--load-layout", layout], [...prepare, "--load-layout"], [...prepare, "--load-layout", layout, "--load-layout", layout],
    ["r90", "--detach", "--fleet-root", resolve("work/fleet-test"), "--load-layout", layout]])
    assert.throws(() => parseFleetArgs(args));
});
