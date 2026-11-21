import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as contract from "./cloud-contract.mjs";
import { host as catalogHost } from "../catalog/droplet-contract.mjs";
import { groupNames, selectedApps } from "./registry.mjs";
import { accountId, archive, commit, context, harness, metadata, syntheticInspection, syntheticPlacement } from "./cloud-fixtures.mjs";
import { campaignOutcome, controllerState, parseDropletArgs } from "./cloud-options.mjs";
import { bootstrapReadScript, remoteFiles } from "./cloud-remote.mjs";
import { digest } from "./cloud-local.mjs";
import { guardianSource, guardianSha256 } from "./cloud-control-runtime.mjs";

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
  assert.equal(fleet.schema, "benchmark-group-fleet/v4");
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
    assert.equal(job.includes("--load-layout c16-generator-v1"), group === "catalog-page");
    assert.ok(!job.includes("--apps") && !job.includes("--duration") && !job.includes("--passes"));
  }
});

test("the reviewed roster binds only catalog to c-16/sfo2, including census and recovery", () => {
  const fleet = plan(), s = state(fleet), [catalog, sibling] = fleet.jobs;
  const actual = { ...droplet(catalog), size_slug: "c-16", region: { slug: "sfo2" } };
  assert.equal(catalog.group, "catalog-page");
  assert.deepEqual(catalog.host, { ...catalogHost, size: "c-16", region: "sfo2" });
  assert.equal(catalog.loadLayout, "c16-generator-v1");
  assert.deepEqual(s.host, catalog.host);
  assert.deepEqual(fleet.host, { ...catalogHost, size: "c-8", region: "sfo3" });
  for (const job of fleet.jobs.slice(1)) {
    assert.equal(job.host, undefined); assert.equal(job.loadLayout, undefined);
    assert.deepEqual(state(fleet, job.group).host, fleet.host);
  }
  assert.equal(contract.assertFleetCensus([actual, droplet(sibling, 124)], fleet), true);
  assert.equal(contract.ownedDroplet([actual], s), actual);
  for (const wrong of [droplet(catalog), { ...actual, size_slug: "c-8" }, { ...actual, region: { slug: "sfo3" } }]) {
    assert.throws(() => contract.assertFleetCensus([wrong], fleet));
    assert.throws(() => contract.ownedDroplet([wrong], s));
  }
  assert.throws(() => contract.validateState({ ...s, host: fleet.host }, s.round));
  const { fleetSha256, ...body } = structuredClone(fleet);
  body.jobs[0].loadLayout = "arbitrary";
  assert.throws(() => contract.validateFleet({ ...body, fleetSha256: digest(JSON.stringify(body)) }));
});

test("uniform v2 receipts stay bound to c-8/sfo3 and cannot authorize a new launch", () => {
  const current = plan(), { fleetSha256, ...body } = structuredClone(current);
  body.schema = "benchmark-group-fleet/v2";
  delete body.jobs[0].host; delete body.jobs[0].loadLayout;
  const fleet = { ...body, fleetSha256: digest(JSON.stringify(body)) };
  const s = { ...state(current), fleet, host: fleet.host }, owned = droplet(fleet.jobs[0]);
  assert.equal(contract.validateFleet(fleet), fleet);
  assert.equal(contract.validateState(s, s.round), s);
  assert.equal(contract.ownedDroplet([owned], s), owned);
  assert.match(remoteFiles(s)["job.sh"], /nproc\)" -ge 8/);
  assert.doesNotMatch(remoteFiles(s)["job.sh"], /--load-layout/);
  assert.throws(() => contract.validateLaunchFleet(fleet), /historical fleet cannot authorize launch/);
});

test("saved v3 uses the old placement and job bytes, not the current catalog", () => {
  const current = plan(), { fleetSha256, ...body } = current;
  body.schema = "benchmark-group-fleet/v3";
  const fleet = { ...body, fleetSha256: digest(JSON.stringify(body)) };
  for (const group of groupNames) {
    const s = state(current, group), legacy = { ...s, fleet };
    assert.equal(contract.validateState(legacy, s.round), legacy);
    const job = remoteFiles(legacy)["job.sh"];
    assert.equal(job, remoteFiles(s)["job.sh"]);
    assert.doesNotMatch(job, /--placement/);
    // The preflight base's v3 generator, evaluated with the same synthetic state.
    if (group === "catalog-page") assert.equal(digest(job), "da0e490641bee439d4551a0fe1c1520eaf3995107ce980cb7c5673f32464a630");
    if (group === "json-api") assert.equal(digest(job), "a58effb2bab110723920fe62374c21e0119e72bcc83c6501478e02b7521a9e8d");
    assert.throws(() => contract.validateState({ ...legacy, host: { ...s.host, region: "sfo1" } }, s.round));
  }
  assert.throws(() => contract.validateLaunchFleet(fleet), /historical fleet cannot authorize launch/);
  const altered = { ...body, host: { ...body.host, region: "sfo2" } };
  assert.throws(() => contract.validateFleet({ ...altered, fleetSha256: digest(JSON.stringify(altered)) }));
});

test("alternate placement agrees across saved identity, census, remote entry and collection", () => {
  const f = contract.fleetPlan(input(), at, "sfo2"), group = groupNames[1], s = state(f, group);
  const row = droplet(f.jobs[1]), actual = { ...row, region: { slug: "sfo2" } };
  assert.deepEqual(contract.providerCreateHost(contract.fleetCreateMode(group, f)), s.host);
  assert.equal(contract.ownedDroplet([actual], s), actual);
  assert.equal(contract.assertFleetCensus([actual], f), true);
  assert.throws(() => contract.ownedDroplet([row], s));
  assert.throws(() => contract.assertFleetCensus([row], f));
  assert.match(remoteFiles(s)["job.sh"], /--placement 'dedicated-sfo2'/);
  const report = { ...syntheticInspection("verified"), commit: s.commit,
    schema: "benchmark-isolated-group-campaign-inspection/v1", selection: s.selection,
    groups: syntheticInspection("verified").groups.filter((r) => r.group === group) };
  assert.throws(() => campaignOutcome(report, s, 0), /replayed host placement differs/);
  report.placement = "dedicated-sfo2";
  assert.equal(campaignOutcome(report, s, 0).evidenceOutcome, "validated");
  assert.throws(() => campaignOutcome(report, state(plan(), group), 0), /replayed host placement differs/);
});

// Captured by evaluating the committed 9f3d3588 generator and its committed
// imports against synthetic account/SSH/ownership values, not today's fleetPlan.
const originalReservation = () => JSON.parse(readFileSync(new URL("./test-fixtures/grouped-sfo2-reservation.json", import.meta.url)));

test("a historical sfo2 fleet is readable, but cannot authorize a fresh dedicated launch", async (t) => {
  const s = originalReservation(), fleet = s.fleet;
  assert.notDeepEqual(fleet.selection, contract.selection());
  assert.equal(contract.validateFleet(fleet), fleet);
  assert.equal(contract.validateState(s, s.round), s);
  const owned = { ...droplet(fleet.jobs[0]), region: { slug: "sfo2" } };
  assert.equal(contract.ownedDroplet([owned], s), owned);
  assert.throws(() => contract.ownedDroplet([{ ...owned, region: { slug: "sfo3" } }], s));
  assert.throws(() => contract.validateState({ ...s, host: { ...s.host, region: "sfo3" } }, s.round));
  const changed = structuredClone(s);
  changed.fleet.selection.groups[0].contractSha256 = "0".repeat(64);
  changed.selection.groups[0] = changed.fleet.selection.groups[0];
  const { fleetSha256, ...body } = changed.fleet;
  changed.fleet.fleetSha256 = digest(JSON.stringify(body));
  assert.throws(() => contract.validateState(changed, changed.round));

  const { h, options, path } = configured(t);
  writeFileSync(path, JSON.stringify(fleet));
  await assert.rejects(async () => h.task({}, { ...options, commit: fleet.commit,
    accountId: fleet.provider.accountId, context: fleet.provider.context }).launch(), /historical fleet cannot authorize launch/);
  assert.equal(h.creates, 0);
  assert.deepEqual(h.calls, []);
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

function configured(t, flags = {}) {
  const h = harness(t, { active: true, ...flags }), values = input(); values.provider = { accountId, context };
  const fleet = contract.fleetPlan(values, at), path = join(h.temp, "fleet.json");
  writeFileSync(path, JSON.stringify(fleet));
  const options = { collect: undefined, detach: true, commit, sshKey: "42", accountId, context, group: groupNames[0], fleet: path };
  return { h, fleet, path, options };
}

test("direct grouped launch checks every pinned size before writing any create intent", async (t) => {
  const { h, options } = configured(t, { placement: syntheticPlacement(["sfo2"]) });
  // The catalog host itself is advertised, but all eight siblings are not.
  await assert.rejects(h.task({}, options).launch(), /reserved fleet placement not advertised/);
  assert.equal(h.creates, 0);
  assert.equal(h.saved().status, "reserved");
  assert.equal(h.saved().createIntentAt, undefined);
});

test("a direct sibling launch cannot stand in for verified remaining admission", async (t) => {
  const placement = syntheticPlacement(["sfo3"]);
  placement.sizes.pop();
  placement.regions[0].sizes = [];
  const { h, options } = configured(t, { placement });
  await assert.rejects(h.task({}, { ...options, group: groupNames[1] }).launch(), /missing or invalid fleet catalog entry: c-16/);
  assert.equal(h.creates, 0);
  assert.equal(h.saved().createIntentAt, undefined);
});

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

test("ingress verification failure stays outside admission and retires only with terminal custody", async (t) => {
  const { h, options, fleet } = configured(t);
  options.group = groupNames[1]; h.flags.active = true; h.flags.bootstrapPending = 1;
  // Replay the real guardian against the in-memory kernel, including the
  // actual controller requests and the original exit archive's custody bytes.
  const kernel = spawn(process.platform === "win32" ? "python" : "python3",
    ["-I", fileURLToPath(new URL("./test-fixtures/control-session-kernel.py", import.meta.url)), "setup-fleet"],
    { timeout: 25000, killSignal: "SIGKILL", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: kernel.stdout })[Symbol.asyncIterator]();
  let stderr = ""; kernel.stderr.on("data", (part) => { stderr = (stderr + part).slice(-4096); });
  const closed = new Promise((resolve) => { kernel.on("error", (e) => resolve(String(e))); kernel.on("close", resolve); });
  t.after(async () => { kernel.stdin.end(); assert.equal(await closed, 0, stderr); });
  const token = fleet.jobs[1].token;
  kernel.stdin.write(JSON.stringify({ mode: "setup-fleet", token, source: guardianSource }) + "\n");
  const run = async (binary, args, timeout, allowFail, expiry, control) => {
    if (!control) return h.run(binary, args, timeout, allowFail);
    const s = h.saved(), script = args.at(-1), request = control.request;
    const exitArchive = request.epoch === "bootstrap" && script === bootstrapReadScript;
    // Re-running pack.sh extends remote custody even though the exit archive
    // is immutable. A second pack here must fail the custody comparison.
    const pack = exitArchive || script === "timeout 600 /bin/bash /bench/pack.sh";
    const query = script.includes("<<'CORTEN_FAILED_SETUP_HOST'");
    const expected = query && { sequence: request.sequence, requests: s.control.ledger.slice(0, -1).map((r) => r.request),
      binding: { round: s.round, commit, token, helperSha256: guardianSha256 },
      queryArgv: ["/usr/bin/python3", "-", s.id, s.unit, JSON.stringify(Object.fromEntries(Object.entries(remoteFiles(s)).map(([k, v]) => [k, digest(v)]))), "1"] };
    const result = query ? null : await h.run(binary, args, timeout, allowFail);
    if (exitArchive) {
      assert.equal(h.flags.active, true);
      assert.equal(s.status, "running"); assert.equal(s.preBootstrapTerminal, undefined);
      assert.equal(result.status, 3); assert.equal(h.deletes, 0);
      h.flags.active = false;
    }
    kernel.stdin.write(JSON.stringify({ request, payload: binary === "ssh" ? `set -euo pipefail\n${script}\n` : "synthetic SFTP",
      pack, code: result?.status ?? 0, ...(query ? { expected } : {}) }) + "\n");
    const line = await lines.next(); assert.equal(line.done, false, stderr);
    const reply = JSON.parse(line.value);
    if (exitArchive) h.setArchive(archive([...metadata().slice(1),
      { name: "run.log", body: "benchmark job failed: stage=ssh-ingress-verification line=129 exit=1\n" }, { name: "control/" },
      ...Object.entries(reply.custody).map(([k, v]) => ({ name: "control/" + k, body: Buffer.from(v, "hex") }))]));
    if (query) return { status: 0, stdout: JSON.stringify({ schema: "benchmark-failed-setup-host/v2", hostId: s.id, unit: s.unit,
      setupFailed: true, exitCode: 1, observedAtMs: Date.now(), control: reply.proof }) };
    return result;
  };
  await assert.rejects(h.task({ run }, options).launch(), /ended before common bootstrap admission/);
  assert.equal(h.saved().status, "starting"); assert.equal(h.saved().group, groupNames[1]);
  assert.ok(h.saved().preBootstrapTerminal); assert.equal(h.saved().bootstrapReady, undefined);
  assert.deepEqual(h.saved().control.sealed, []); assert.equal(h.saved().control.monitor.phase, "pending");
  assert.equal(h.saved().control.ledger.at(-2).code, 3);
  assert.equal(h.creates, 1); assert.equal(h.deletes, 0); assert.equal(h.inspections, 0);
  h.flags.active = true;
  await assert.rejects(h.task({ run }).collect(), /startup unit no longer identically terminal/);
  h.flags.active = false; h.flags.wrongUnit = true;
  await assert.rejects(h.task({ run }).collect());
  h.flags.wrongUnit = false;
  assert.equal(h.deletes, 0); assert.equal(h.saved().archiveSha256, undefined);
  assert.equal(await h.task({ run }).collect(), 1);
  const s = h.saved();
  assert.equal(s.status, "retired"); assert.equal(s.retirement.kind, "setup-failed"); assert.ok(s.destroyedAt);
  assert.ok(s.archiveSha256 && s.evidenceSha256); assert.equal(s.validation, undefined); assert.equal(s.collectedAt, undefined);
  assert.match(readFileSync(join(h.local, s.evidence, "run.log"), "utf8"), /stage=ssh-ingress-verification/);
  assert.equal(await h.task({ run }).collect(), 1); assert.equal(h.inspections, 0);
  assert.equal(h.saved().fullGroupQualified, false);
  assert.equal(h.creates, 1); assert.equal(h.deletes, 1);

  for (const mode of ["native", "absent-proof", "active", "unacknowledged", "monitor-artifact", "changed-record", "foreign-unit"]) {
    const f = configured(t), g = f.h;
    // The first group passes its first running check, then exits inside commonBootstrap.
    g.flags.hook = (bin, a) => { if (bin === "ssh" && a.at(-1).startsWith("systemctl show") && g.units === 1) g.flags.active = false; };
    g.flags.startLost = mode === "unacknowledged";
    await assert.rejects(g.task({}, f.options).launch(), mode === "unacknowledged" ? /start acknowledgement/ : /ended before common bootstrap/);
    assert.equal(!!g.saved().preBootstrapTerminal, mode !== "unacknowledged"); g.flags.hook = undefined;
    if (mode === "active") g.flags.active = true;
    if (mode === "foreign-unit") g.flags.wrongUnit = true;
    if (mode === "absent-proof") g.setArchive(archive(metadata()));
    if (mode === "monitor-artifact") writeFileSync(join(g.local, "monitor-journal.jsonl"), "");
    if (mode === "changed-record") g.change((v) => { v.preBootstrapTerminal.invocation = "f".repeat(32); });
    let inspections = 0;
    await assert.rejects(g.task({ inspect() { inspections++; return syntheticInspection("verified"); } }).collect());
    assert.equal(g.calls.filter(([bin, ...a]) => bin === "scp" && a.at(-2).endsWith(":/bench/results.tgz")).length,
      ["native", "absent-proof"].includes(mode) ? 1 : 0); assert.equal(inspections, 0);
    if (mode === "native") {
      assert.ok(g.saved().archiveSha256 && g.saved().evidenceSha256);
      assert.equal(readFileSync(join(g.local, g.saved().evidence, "campaign/fake.json"), "utf8"), "{}");
    }
    assert.equal(g.deletes, 0); assert.equal(g.saved().validation, undefined); assert.equal(g.saved().retirement, undefined);
  }
});

test("a nonterminal later group retains ordinary running admission", async (t) => {
  const { h, options } = configured(t); options.group = groupNames[1];
  await h.task({}, options).launch();
  assert.equal(h.saved().status, "running"); assert.equal(h.saved().group, groupNames[1]);
  assert.equal(h.saved().bootstrapReady, undefined); assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
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

function finishSupervisedFixture(h, status) {
  h.flags.active = false; h.flags.reportStatus = status;
  const path = join(h.local, "monitor-local-closed.json"), closed = JSON.parse(readFileSync(path));
  closed.closedAtMs = Date.now() - 31000; closed.recoverAfterMs = closed.closedAtMs + 30000;
  writeFileSync(path, JSON.stringify(closed));
  return h.report();
}

test("group inspection is distinct from whole-campaign evidence and retains terminal deletion gates", async (t) => {
  const { h, options } = configured(t); await h.task({}, options).launch();
  const report = finishSupervisedFixture(h, "verified");
  report.schema = "benchmark-isolated-group-campaign-inspection/v1";
  report.loadLayout = "c16-generator-v1";
  report.selection.groups = report.selection.groups.filter((row) => row.group === options.group);
  report.groups = report.groups.filter((row) => row.group === options.group);
  assert.equal(campaignOutcome(report, h.saved(), 0).evidenceOutcome, "validated");
  for (const alter of [(r) => r.schema = "benchmark-isolated-campaign-inspection/v1",
    (r) => delete r.loadLayout, (r) => r.loadLayout = "arbitrary",
    (r) => r.selection.groups[0].apps.pop(), (r) => r.groups = [], (r) => r.uncollectedNativeRoots = ["partial"],
    (r) => r.collectionIntegrity = "unverified", (r) => r.commandLifecycle = "uncertain"]) {
    const r = structuredClone(report); alter(r); assert.throws(() => campaignOutcome(r, h.saved(), 0));
  }
  h.setArchive(archive([...metadata().map((row) => row.name === "exit-code" ? { ...row, body: "0\n" } : row),
    { name: "campaign/" }, { name: "campaign/fake.json", body: "{}" }]));
  const { loadLayout, ...narrowReport } = report;
  await assert.rejects(h.task({ inspect: async () => narrowReport }).collect(), /native campaign validation unavailable or invalid/);
  assert.equal(h.deletes, 0);
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

test("failed and blocked collection preserves a host when evidence belongs to another selection", async (t) => {
  for (const status of ["failed", "blocked"]) for (const change of ["group", "apps", "contract"]) {
    const { h, options } = configured(t); await h.task({}, options).launch();
    const report = finishSupervisedFixture(h, status);
    report.schema = "benchmark-isolated-group-campaign-inspection/v1";
    report.selection.groups = report.selection.groups.filter((row) => row.group === options.group);
    report.groups = [];
    if (change === "group") report.selection.groups[0].group = groupNames[1];
    if (change === "apps") report.selection.groups[0].apps.pop();
    if (change === "contract") report.selection.groups[0].contractSha256 = "0".repeat(64);
    assert.throws(() => campaignOutcome(report, h.saved(), 1), /complete current native selection required/);
    await assert.rejects(h.task({ inspect: async () => report }).collect(), /native campaign validation unavailable or invalid/);
    assert.equal(h.deletes, 0); assert.equal(h.saved().destroyedAt, undefined);
    assert.equal(h.saved().deletionIntentAt, undefined);
  }
});

test("first official group waits for the bound common bootstrap marker, not native qualification", async (t) => {
  const { h, options } = configured(t); h.flags.bootstrapPending = 1;
  const saved = await h.task({}, options).launch();
  assert.equal(saved.status, "running"); assert.ok(saved.bootstrapReady.sha256); assert.ok(saved.bootstrapReady.observedAt);
  assert.equal(saved.fullGroupQualified, false); assert.equal(h.creates, 1);
  assert.equal(h.calls.filter((c) => c[0] === "ssh" && c.at(-1).startsWith("if test ! -e /bench/bootstrap-ready.json")).length, 2);
});

test("failed or wrong common bootstrap leaves the first host observable without another allocation", async (t) => {
  for (const mode of ["read-failed", "wrong-identity", "ended", "expired", "reverse-time", "cancelled"]) {
    const { h, options } = configured(t); let clock = 0;
    if (mode === "read-failed") h.flags.bootstrapError = true;
    if (mode === "wrong-identity") h.flags.bootstrapMarker = { schema: "benchmark-common-bootstrap/v1", commit: "foreign" };
    if (mode === "ended") h.flags.active = false;
    if (["expired", "reverse-time", "cancelled"].includes(mode)) h.flags.hook = (binary, args) => {
      if (binary === "ssh" && args.at(-1).startsWith("if test ! -e /bench/bootstrap-ready.json")) {
        clock = mode === "expired" ? 45 * 60000 : -1;
        if (mode === "cancelled") h.flags.cancelled = true;
      }
    };
    await assert.rejects(h.task({ now: () => clock }, options).launch());
    const saved = h.saved(), witness = saved.preBootstrapTerminal;
    if (mode === "ended") {
      assert.equal(saved.status, "starting");
      const row = saved.control.ledger.at(-1), query = h.calls.filter(([binary]) => binary === "ssh").at(-1).at(-1);
      assert.ok(query.startsWith(`systemctl show ${saved.unit} `));
      assert.equal(row.request.epoch, "bootstrap"); assert.equal(row.request.invocation.channel, "ssh");
      assert.equal(row.request.invocation.requestSha256, digest(`set -euo pipefail\n${query}\n`));
      assert.equal(row.localTerminal, true); assert.equal(row.code, 0);
      assert.equal(witness.invocation, row.request.invocation.id); assert.equal(witness.monitorId, saved.control.monitor.id);
      assert.equal(witness.hostId, saved.id); assert.equal(witness.ip, saved.ip);
      assert.equal(contract.terminalUnit(witness.stdout, saved), true);
    } else {
      assert.equal(saved.status, "running", mode); assert.equal(witness, undefined, mode);
    }
    assert.equal(saved.control.monitor.phase, "pending"); assert.equal(saved.bootstrapReady, undefined);
    assert.equal(saved.fullGroupQualified, false); assert.equal(saved.validation, undefined);
    assert.equal(saved.deletionIntentAt, undefined); assert.equal(saved.destroyedAt, undefined);
    assert.equal(h.creates, 1); assert.equal(h.deletes, 0); assert.equal(h.inspections, 0);
  }
});
