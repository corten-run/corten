import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as contract from "./cloud-contract.mjs";
import { groupNames, selectedApps } from "./registry.mjs";
import { accountId, archive, commit, context, harness, metadata, syntheticInspection } from "./cloud-fixtures.mjs";
import { campaignOutcome, controllerState, parseDropletArgs } from "./cloud-options.mjs";
import { remoteFiles } from "./cloud-remote.mjs";

const at = "2026-11-14T00:00:00.000Z";
const input = () => ({ round: "r21", commit: "a".repeat(40), token: "f".repeat(16),
  tokens: Object.fromEntries(groupNames.map((group, i) => [group, (i + 1).toString(16).padStart(16, "0")])),
  provider: { accountId: "team:synthetic-fleet", context: "synthetic" }, sshKey: "42" });
const plan = () => contract.fleetPlan(input(), at);
const state = (fleet, group = groupNames[0]) => contract.reservation({ round: fleet.round, commit: fleet.commit,
  token: fleet.jobs.find((row) => row.group === group).token, group, fleet }, at);
const droplet = (row, id = 123) => ({ id, name: row.name, tags: [...contract.tags, row.tag],
  size_slug: contract.host.size, region: { slug: contract.host.region },
  networks: { v4: [{ type: "public", ip_address: "192.0.2.10" }] } });

test("fleet fixes the complete current registry to one unique host per group", () => {
  const fleet = plan();
  assert.equal(contract.validateFleet(fleet), fleet);
  assert.equal(fleet.schema, "benchmark-group-fleet/v1");
  assert.deepEqual(fleet.selection, contract.selection());
  assert.deepEqual(fleet.jobs.map((row) => row.group), groupNames);
  assert.equal(new Set(fleet.jobs.map((row) => row.token)).size, groupNames.length);
  assert.equal(new Set(fleet.jobs.map((row) => row.name)).size, groupNames.length);
  for (const group of groupNames) {
    const s = state(fleet, group);
    assert.equal(s.schema, "benchmark-dedicated-group-host/v1");
    assert.equal(contract.validateState(s, "r21"), s);
    assert.deepEqual(s.selection.groups.map((row) => row.group), [group]);
    assert.deepEqual(s.selection.groups[0].apps, selectedApps(group));
    assert.deepEqual(s.fleet, fleet);
    const job = contract.remoteFiles(s)["job.sh"];
    assert.ok(job.includes(`campaign-entry.mjs r21 --commit ${fleet.commit} --state-dir /bench/campaign --group ${group}`));
    assert.ok(!job.includes("--apps") && !job.includes("--duration") && !job.includes("--passes"));
  }
});

test("partial, duplicate, reordered or altered fleet plans cannot authorize a host", () => {
  for (const alter of [
    (f) => f.jobs.pop(), (f) => f.jobs.reverse(), (f) => f.jobs[1].token = f.jobs[0].token,
    (f) => f.jobs[0].group = "arbitrary", (f) => f.jobs[0].name = "foreign",
    (f) => f.selection.groups[0].apps.pop(), (f) => f.selection.groups.pop(),
    (f) => f.host.size = "s-1vcpu-1gb", (f) => f.provider.context = "other",
    (f) => f.sshKey = "99", (f) => f.createdAt = "2026-02-30T00:00:00.000Z",
    (f) => f.commit += "\n", (f) => f.extra = true,
  ]) {
    const f = structuredClone(plan()); alter(f);
    assert.throws(() => contract.validateFleet(f));
    assert.throws(() => state(f));
  }
  for (const alter of [(i) => delete i.tokens[groupNames[0]], (i) => i.tokens.extra = "e".repeat(16),
    (i) => i.tokens[groupNames[1]] = i.tokens[groupNames[0]], (i) => i.provider.accountId = "not-scoped",
    (i) => i.apps = ["corten"]]) {
    const i = input(); alter(i); assert.throws(() => contract.fleetPlan(i, at));
  }
});

test("single-group evidence cannot be disguised as a legacy whole campaign", () => {
  const f = plan();
  for (const alter of [(s) => s.schema = "benchmark-group-host/v1", (s) => delete s.group,
    (s) => delete s.fleet, (s) => s.group = groupNames[1], (s) => s.token = "e".repeat(16),
    (s) => s.selection = contract.selection(), (s) => s.selection.groups[0].apps.pop()]) {
    const s = structuredClone(state(f)); alter(s); assert.throws(() => contract.validateState(s, "r21"));
  }
  const legacy = contract.reservation({ round: "r21", commit: f.commit, token: "e".repeat(16) }, at);
  assert.equal(legacy.schema, "benchmark-group-host/v1");
  assert.deepEqual(legacy.selection, contract.selection());
  assert.throws(() => contract.validateState({ ...legacy, group: groupNames[0] }, "r21"));
});

test("fleet census permits only exact reserved siblings, not a tag-prefix exemption", () => {
  const f = plan(), sibling = droplet(f.jobs[1]);
  assert.equal(contract.assertFleetCensus([], f), true);
  assert.equal(contract.assertFleetCensus([sibling, { id: 456, name: "unrelated", tags: [] }], f), true);
  for (const rows of [[sibling, sibling], [{ ...sibling, id: "invalid" }],
    [{ ...sibling, name: "corten-bench-groups-foreign" }], [{ ...sibling, tags: contract.tags }],
    [{ ...sibling, size_slug: "s-1vcpu-1gb" }], [{ ...sibling, region: { slug: "nyc1" } }],
    [{ id: 789, name: "corten-marketplace-r20", tags: ["corten-bench"] }],
    [sibling, { ...droplet(f.jobs[2]), id: sibling.id }]]) {
    assert.throws(() => contract.assertFleetCensus(rows, f));
  }
});

function configured(t) {
  const h = harness(t), values = input(); values.provider = { accountId, context };
  const fleet = contract.fleetPlan(values, at), path = join(h.temp, "fleet.json");
  writeFileSync(path, JSON.stringify(fleet));
  const options = { collect: undefined, detach: true, commit, sshKey: "42", accountId, context, group: groupNames[0], fleet: path };
  return { h, fleet, path, options };
}

test("group launch permits exact siblings but reserves only this group's complete work", async (t) => {
  const { h, fleet, options } = configured(t);
  h.hosts([droplet(fleet.jobs[1], 456)]);
  await h.task({}, options).launch();
  const saved = h.saved(); assert.equal(h.creates, 1); assert.equal(saved.status, "running");
  assert.equal(controllerState(saved, "r21"), saved);
  assert.equal(saved.group, groupNames[0]); assert.deepEqual(saved.fleet, fleet);
  assert.equal(saved.fullGroupQualified, false);
  const job = readFileSync(join(h.local, "job.sh"), "utf8");
  assert.ok(job.includes(`--group '${groupNames[0]}'`));
  assert.equal(job, remoteFiles(saved)["job.sh"]);
  await assert.rejects(h.task({}, options).launch()); assert.equal(h.creates, 1);
});

test("foreign benchmark, own preexisting host, or fleet/account tampering cannot create", async (t) => {
  for (const mode of ["foreign", "own", "changed-account", "changed-fleet"]) {
    const { h, fleet, options, path } = configured(t);
    if (mode === "foreign") h.hosts([{ id: 999, name: "corten-marketplace-r20", tags: ["corten-bench"] }]);
    if (mode === "own") h.hosts([droplet(fleet.jobs[0])]);
    if (mode === "changed-account") options.accountId = "user:other";
    if (mode === "changed-fleet") { fleet.jobs[0].group = "unknown"; writeFileSync(path, JSON.stringify(fleet)); }
    await assert.rejects(async () => h.task({}, options).launch());
    assert.equal(h.creates, 0); assert.equal(h.deletes, 0);
  }
});

test("first host requires account room for the whole reserved fleet, not just itself", async (t) => {
  const { h, options } = configured(t);
  h.hosts(Array.from({ length: 20 - groupNames.length + 1 }, (_, i) => ({ id: 1000 + i, name: `unrelated-${i}`, tags: [] })));
  await assert.rejects(h.task({}, options).launch(), /capacity cannot cover/);
  assert.equal(h.creates, 0); assert.equal(h.deletes, 0);
});

test("group inspection is distinct from whole-campaign evidence and retains terminal deletion gates", async (t) => {
  const { h, options } = configured(t); await h.task({}, options).launch();
  const report = syntheticInspection("verified");
  report.schema = "benchmark-isolated-group-campaign-inspection/v1";
  report.selection.groups = report.selection.groups.filter((row) => row.group === options.group);
  report.groups = report.groups.filter((row) => row.group === options.group);
  assert.equal(campaignOutcome(report, h.saved(), 0).evidenceOutcome, "validated");
  for (const alter of [(r) => r.schema = "benchmark-isolated-campaign-inspection/v1",
    (r) => r.selection.groups[0].apps.pop(), (r) => r.groups = [], (r) => r.uncollectedNativeRoots = ["partial"],
    (r) => r.collectionIntegrity = "unverified", (r) => r.commandLifecycle = "uncertain"]) {
    const r = structuredClone(report); alter(r); assert.throws(() => campaignOutcome(r, h.saved(), 0));
  }
  h.setArchive(archive([...metadata().map((row) => row.name === "exit-code" ? { ...row, body: "0\n" } : row),
    { name: "campaign/" }, { name: "campaign/fake.json", body: "{}" }]));
  assert.equal(await h.task({ inspect: async () => report }).collect(), 0);
  assert.equal(h.deletes, 1); assert.ok(h.saved().destroyedAt);
  assert.equal(h.saved().fullGroupQualified, false);
});

test("CLI group selection cannot omit the full fleet or change collection scope", () => {
  const common = ["r21", "--state-dir", join(process.cwd(), "outside")];
  const detach = [...common, "--detach", "--commit", commit, "--ssh-key", "42", "--account-id", accountId, "--context", context];
  const path = join(process.cwd(), "fleet.json");
  assert.equal(parseDropletArgs([...detach, "--group", groupNames[0], "--fleet", path]).group, groupNames[0]);
  for (const args of [[...detach, "--group", groupNames[0]], [...detach, "--fleet", path],
    [...detach, "--group", "unknown", "--fleet", path], [...common, "--collect", "--group", groupNames[0], "--fleet", path],
    [...detach, "--group", groupNames[0], "--fleet", path, "--apps", "corten"]]) assert.throws(() => parseDropletArgs(args));
});
