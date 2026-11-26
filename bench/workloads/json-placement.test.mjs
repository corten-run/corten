// The opted-in JSON API c-16 placement (issue 2057) in the fleet, its reservation and job.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import * as contract from "./cloud-contract.mjs";
import { digest } from "./cloud-local.mjs";
import { accountId, commit, context, harness, syntheticCatalogProvider, syntheticPlacement } from "./cloud-fixtures.mjs";
import { productionPlan } from "./cloud-production.mjs";
import { bootstrapMarker, bootstrapReadScript, remoteFiles } from "./cloud-remote.mjs";
import { fleetMain, fleetWorkerPaths, parseFleetArgs } from "./fleet.mjs";
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

// A single opted-in json-api offline handoff against the fake provider. No real provider is contacted.
function fakeLaunch(t, placement) {
  const h = harness(t, { active: true, ...(placement ? { placement } : {}) });
  const values = { ...input("json-api"), round: "r21", commit, provider: { accountId, context } };
  const fleet = contract.fleetPlan(values, at, "sfo3", { stagedPlacement: true,
    single: { group: "json-api", indexSha256: "1".repeat(64), checkout: h.repo, offlineHandoff: true, loadLayout: layout } });
  const path = join(h.temp, "json-c16-fleet.json");
  writeFileSync(path, JSON.stringify(fleet));
  const run = (bin, args, timeout, allowed, expiry, registration) => {
    if (bin === "ssh" && args.at(-1) === bootstrapReadScript + "\ncat /proc/sys/kernel/random/boot_id")
      return { status: 0, stdout: `${JSON.stringify(bootstrapMarker(h.saved()))}\n12345678-90ab-cdef-1234-567890abcdef\n` };
    return h.run(bin, args, timeout, allowed, expiry, registration);
  };
  const options = { collect: undefined, detach: true, commit, sshKey: "42", accountId, context, group: "json-api", fleet: path };
  const creates = () => h.calls.filter((call) => call[0] === "doctl" && call[3] === "create");
  const catalogs = () => h.calls.filter((call) => call[0] === "doctl" && call[2] === "placement");
  return { h, fleet, creates, catalogs, launch: () => h.task({ run, checkFleetAdmission: () => [] }, options).launch() };
}

test("an opted-in json-api launch posts one c-16/sfo2 create with the layout's pinned job", async (t) => {
  const f = fakeLaunch(t), { h } = f;
  await f.launch();
  assert.equal(h.creates, 1);
  const [create] = f.creates(), flag = (name) => create[create.indexOf(name) + 1];
  assert.equal(flag("--size"), "c-16"); assert.equal(flag("--region"), "sfo2"); assert.equal(flag("--image"), contract.host.image);
  // The provider catalog was checked for c-16/sfo2 before the create.
  assert.ok(f.catalogs().length >= 1 && h.calls.indexOf(f.catalogs()[0]) < h.calls.indexOf(create));
  const saved = h.saved();
  assert.deepEqual(saved.host, c16); assert.equal(contract.savedLoadLayout(saved), layout); assert.deepEqual(saved.fleet, f.fleet);
  assert.equal(saved.skipHostChromium, true);
  const job = readFileSync(join(h.local, "job.sh"), "utf8");
  assert.equal(job, remoteFiles(saved)["job.sh"]);
  assert.ok(!job.includes("bootstrap_stage=browser-install\n"));
  assert.ok(job.includes(`--group 'json-api' --load-layout '${layout}'\n`)); assert.match(job, /test "\$\(nproc\)" -ge 16\n/);
});

test("an opted-in json-api launch refuses before any create intent or POST when c-16/sfo2 is not offered", async (t) => {
  const unavailable = syntheticPlacement(); unavailable.sizes[1].available = false;
  const elsewhere = syntheticPlacement(); elsewhere.sizes[1].regions = ["sfo3"];
  elsewhere.regions = elsewhere.regions.map((row) => ({ ...row, sizes: row.slug === "sfo3" ? [...row.sizes, "c-16"] : row.sizes.filter((size) => size !== "c-16") }));
  const absent = syntheticPlacement(); absent.sizes.pop(); absent.regions = absent.regions.map((row) => ({ ...row, sizes: row.sizes.filter((size) => size !== "c-16") }));
  for (const placement of [unavailable, elsewhere, absent]) {
    const f = fakeLaunch(t, placement), { h } = f;
    await assert.rejects(f.launch(), /fleet placement not advertised: c-16\/sfo2|missing or invalid fleet catalog entry: c-16/);
    assert.ok(f.catalogs().length >= 1, "the refusal comes from the provider catalog check");
    assert.equal(h.creates, 0); assert.deepEqual(f.creates(), []);
    assert.equal(h.saved().status, "reserved"); assert.equal(h.saved().createIntentAt, undefined);
    assert.deepEqual(h.saved().host, c16);
  }
});

// The fleet's own --detach step for an independent json-api group: preparation, approval and the final
// placement recheck before the launch intent, against a fake provider catalog. The child is stubbed, so
// nothing can be created; the catalog the fleet reads at detach is the only thing a case changes.
const fleetSources = new Map(fleetWorkerPaths.map((file) => [file, readFileSync(resolve(file), "utf8").replaceAll("\r\n", "\n")]));
function fleetDetach(t, { loadLayout } = {}) {
  const h = harness(t), output = [], children = [], catalogReads = [];
  let offered = syntheticPlacement();
  writeFileSync(join(h.base, "index.json"), "[]");
  const deps = { repo: h.repo, write: (value) => output.push(JSON.parse(value)),
    spawn: (binary, argv) => {
      assert.equal(binary, "git", "the fleet parent has no provider boundary of its own");
      if (argv[0] === "show") return { status: 0, stdout: fleetSources.get(argv[1].slice(41)) };
      return h.run(binary, argv, 60000);
    },
    plan: (options, planDeps) => productionPlan(options, { ...planDeps, roleCheck: () => [] }),
    catalogProvider: syntheticCatalogProvider(() => offered, catalogReads),
    main: async (args) => { children.push(args); return 2; } };
  const args = ["r21", "--continuation-root", h.base, "--group", "json-api"], root = join(h.base, "json-api");
  return { h, root, output, children, catalogReads, intent: () => existsSync(join(root, "launch-intent.json")),
    async prepare() {
      assert.equal(await fleetMain([...args, "--prepare", "--commit", commit, "--ssh-key", "42", "--account-id", accountId,
        "--context", context, ...(loadLayout ? ["--load-layout", loadLayout] : [])], deps), 3);
      assert.equal(await fleetMain([...args, "--detach", "--print-approval"], deps), 3, JSON.stringify(output.at(-1)));
      return output.at(-1).approvalSha256;
    },
    detach(approval, catalog) {
      offered = catalog;
      return fleetMain([...args, "--detach", "--approve-reviewed-merged-ready", approval], deps);
    } };
}
const c8Nowhere = () => syntheticPlacement([]);
const c16Withdrawn = () => { const catalog = syntheticPlacement(); catalog.sizes[1].available = false; return catalog; };

test("the fleet's last placement check before an opted-in json-api launch intent reads c-16/sfo2, not the default c-8", async (t) => {
  // c-8 is offered nowhere at detach; the opted-in job needs only c-16/sfo2, so it proceeds.
  const wide = fleetDetach(t, { loadLayout: layout }), approval = await wide.prepare(), before = wide.catalogReads.length;
  assert.equal(await wide.detach(approval, c8Nowhere()), 2, JSON.stringify(wide.output.at(-1)));
  assert.ok(wide.catalogReads.length > before, "detach read the provider catalog again");
  assert.equal(wide.children.length, 1); assert.ok(wide.intent());
  const saved = JSON.parse(readFileSync(join(wide.root, "launch-intent.json"), "utf8"));
  assert.equal(saved.subject.fleet.single.loadLayout, layout); assert.deepEqual(saved.subject.fleet.jobs[0].host, c16);
  // c-16/sfo2 withdrawn at detach: refuse before the launch intent, so no child exists to POST.
  const gone = fleetDetach(t, { loadLayout: layout }), again = await gone.prepare();
  await assert.rejects(gone.detach(again, c16Withdrawn()), /fleet placement not advertised: c-16\/sfo2/);
  assert.deepEqual(gone.children, []); assert.equal(gone.intent(), false); assert.equal(gone.h.creates, 0);
});

test("without the marker the fleet's last placement check before a json-api launch intent still reads c-8 at the reserved region", async (t) => {
  // A withdrawn c-16 does not block the default c-8 host.
  const narrow = fleetDetach(t), approval = await narrow.prepare();
  assert.equal(await narrow.detach(approval, c16Withdrawn()), 2, JSON.stringify(narrow.output.at(-1)));
  assert.equal(narrow.children.length, 1); assert.ok(narrow.intent());
  const saved = JSON.parse(readFileSync(join(narrow.root, "launch-intent.json"), "utf8"));
  assert.equal(Object.hasOwn(saved.subject.fleet.single, "loadLayout"), false); assert.equal(saved.subject.fleet.jobs[0].host, undefined);
  assert.equal(saved.subject.fleet.host.region, contract.host.region);
  // c-8 withdrawn at the reserved region refuses before the launch intent, as before.
  const blocked = fleetDetach(t), again = await blocked.prepare();
  await assert.rejects(blocked.detach(again, c8Nowhere()), /reserved fleet placement not advertised: c-8\/sfo3/);
  assert.deepEqual(blocked.children, []); assert.equal(blocked.intent(), false); assert.equal(blocked.h.creates, 0);
});
