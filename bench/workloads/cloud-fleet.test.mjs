import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import fs, { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join, resolve } from "node:path";
import * as contract from "./cloud-contract.mjs";
import { host as catalogHost } from "../catalog/droplet-contract.mjs";
import { groupNames, selectedApps } from "./registry.mjs";
import { accountId, archive, campaign, commit, context, harness, metadata, subject, syntheticDelivery, syntheticInspection, syntheticPlacement, syntheticProviderRequest } from "./cloud-fixtures.mjs";
import { campaignOutcome, controllerFailure, controllerState, parseDropletArgs } from "./cloud-options.mjs";
import { bootstrapMarker, bootstrapReadScript, remoteFiles } from "./cloud-remote.mjs";
import { digest, treeHash } from "./cloud-local.mjs";
import { guardianSource, guardianSha256 } from "./cloud-control-runtime.mjs";
import setupDrainSource from "./cloud-setup-drain-source.mjs";
import { shellTransport } from "./cloud-transport.mjs";
import { productionDispatch } from "./cloud-production.mjs";
import { createProviderEngine } from "./cloud-engine-test-fixture.mjs";
import { recheckSetupRetirement, verifyFleet } from "./fleet-verify.mjs";
import { continuationAdmission } from "./group-continuation.mjs";
import { SetupWatcherProofMissing, verifyFailedSetupRetirement } from "./cloud-retirement.mjs";

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

test("independent census binds a supervised sibling's exact host without admitting foreign hosts", () => {
  const [first, second] = groupNames, indexSha256 = "1".repeat(64);
  const single = (group, index = indexSha256) => {
    const spec = input(); spec.tokens = { [group]: spec.tokens[group] };
    return contract.fleetPlan(spec, at, "sfo3",
      { stagedPlacement: true, single: { group, indexSha256: index, checkout: resolve(".") } });
  };
  const source = single(second), launch = single(first);
  const peer = { ...state(source, second), status: "running", provider: source.provider, id: "123", ip: "192.0.2.10" };
  const actual = droplet(source.jobs[0]);
  assert.equal(contract.assertFleetCensus([actual], launch, undefined, [peer]), true);
  for (const rows of [[], [{ ...actual, id: 456 }], [{ ...actual, region: { slug: "sfo2" } }],
    [{ ...actual, size_slug: "c-16" }], [{ ...actual, tags: [] }], [{ ...actual, networks: {} }],
    [actual, { ...actual, id: 456 }], [actual, { id: 999, name: "foreign", tags: [contract.tags[0]] }]]) {
    assert.throws(() => contract.assertFleetCensus(rows, launch, undefined, [peer]));
  }
  assert.throws(() => contract.assertFleetCensus([actual], launch), /foreign benchmark host/);
  assert.throws(() => contract.assertFleetCensus([actual], single(first, "2".repeat(64)), undefined, [peer]), /different reservation/);
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

test("the exact pre-rotation all-group roster can be collected but never supplies a new launch", async (t) => {
  // Output of selection() at 83b3b8772, not reconstructed from today's registry.
  const prior = JSON.parse(readFileSync(new URL("./test-fixtures/pre-rotation-all-group-selection.json", import.meta.url)));
  const saved = { ...contract.reservation({ round: "r21", commit, token: "0123456789abcdef" }, at), selection: prior };
  assert.equal(contract.validateState(saved, saved.round), saved);
  for (const change of [(s) => s.groups.reverse(), (s) => s.groups.pop(),
    (s) => s.groups[2].apps.reverse(), (s) => s.groups[1].contractSha256 = "0".repeat(64)]) {
    const changed = structuredClone(prior); change(changed);
    assert.throws(() => contract.validateState({ ...saved, selection: changed }, saved.round), /registry selection differs/);
  }
  const fresh = contract.reservation({ round: saved.round, commit, token: saved.token });
  assert.deepEqual(fresh.selection, contract.selection());
  assert.notDeepEqual(fresh.selection, prior);
  assert.throws(() => contract.reservation({ round: saved.round, commit, token: saved.token, selection: prior }), /unexpected or missing fields/);
  const withPrior = ({ fleetSha256, ...body }) => {
    body.selection = prior;
    return { ...body, fleetSha256: digest(JSON.stringify(body)) };
  };
  assert.throws(() => contract.validateLaunchFleet(withPrior(plan())), /fixed registry/);
  assert.throws(() => contract.validateFleet(withPrior(originalReservation().fleet)), /historical fleet selection differs/);

  const h = harness(t); h.seed(); h.change((s) => { s.selection = prior; });
  await assert.rejects(h.launch().launch(), /already reserved/);
  const inspect = async () => ({ ...syntheticInspection(), selection: prior });
  assert.equal(await h.task({ inspect }).collect(), 1); // Terminal blocked evidence retained, not qualified.
  assert.deepEqual(h.saved().selection, prior);
  assert.equal(h.saved().evidenceOutcome, "blocked");
  assert.equal(h.creates, 0);
});

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

test("a v5 sibling rechecks its consumed c-8 region before create intent, with no fallback", async (t) => {
  const { h, fleet: old, path, options } = configured(t, { placement: syntheticPlacement(["blr1"]) });
  const values = input(); values.provider = old.provider;
  const fleet = contract.fleetPlan(values, at, "sfo2", { stagedPlacement: true });
  writeFileSync(path, JSON.stringify(fleet));
  const launch = { ...options, group: groupNames[1] };
  assert.throws(() => h.task({}, launch), /consumed fleet approval/);
  const remainingPlacement = { region: "lon1", intentSha256: "f".repeat(64) };
  await assert.rejects(h.task({ remainingAdmission: true, remainingPlacement, checkFleetAdmission() {} }, launch).launch(),
    /reserved fleet placement not advertised: c-8\/lon1/);
  assert.equal(h.creates, 0);
  assert.equal(h.saved().status, "reserved");
  assert.equal(h.saved().createIntentAt, undefined);
  assert.deepEqual(h.saved().remainingPlacement, remainingPlacement);
  assert.equal(h.saved().host.region, "lon1");
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

for (const cancelAtProof of [false, true]) test(cancelAtProof
  ? "cancellation at acknowledged valid setup proof preserves the host and lock"
  : "ingress verification failure stays outside admission and retires only with terminal custody", async (t) => {
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
    if (query) {
      if (cancelAtProof) h.flags.cancelled = true;
      return { status: 0, stdout: JSON.stringify({ schema: "benchmark-failed-setup-host/v2", hostId: s.id, unit: s.unit,
        setupFailed: true, exitCode: 1, observedAtMs: Date.now(), control: reply.proof }) };
    }
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
  if (cancelAtProof) {
    await assert.rejects(h.task({ run }).collect(), /cancelled/);
    const saved = h.saved();
    assert.equal(saved.control.ledger.at(-1).code, 0); assert.equal(saved.control.ledger.at(-1).setupProofRejected, undefined);
    assert.ok(existsSync(join(h.local, "operation.lock"))); assert.equal(saved.retirement, undefined);
    assert.equal(saved.deletionIntentAt, undefined); assert.equal(h.deletes, 0);
    return;
  }
  assert.equal(await h.task({ run }).collect(), 1);
  const s = h.saved();
  assert.equal(s.status, "retired"); assert.equal(s.retirement.kind, "setup-failed"); assert.ok(s.destroyedAt);
  assert.ok(s.archiveSha256 && s.evidenceSha256); assert.equal(s.validation, undefined); assert.equal(s.collectedAt, undefined);
  assert.match(readFileSync(join(h.local, s.evidence, "run.log"), "utf8"), /stage=ssh-ingress-verification/);
  assert.equal(await h.task({ run }).collect(), 1); assert.equal(h.inspections, 0);
  assert.equal(h.saved().fullGroupQualified, false);
  assert.equal(h.creates, 1); assert.equal(h.deletes, 1);

  const root = join(h.temp, "verification"), child = join(root, s.group), local = join(child, "groups-r21");
  mkdirSync(child, { recursive: true });
  writeFileSync(join(root, "fleet-r21.json"), JSON.stringify(fleet));
  cpSync(h.local, local, { recursive: true });
  assert.ok(readFileSync(join(local, "failed-setup-host.json")).length > 4096, "real v2 receipt exceeds the legacy bound");
  assert.equal(JSON.parse(readFileSync(join(local, "failed-setup-host.json"))).schema, "benchmark-failed-setup-retirement/v2");
  verifyFailedSetupRetirement(local, s);
  const verify = () => verifyFleet({ root, round: "r21", commit }, { inspect: () => assert.fail("no native result") });
  let report = await verify();
  assert.equal(report.groups.find(({ group }) => group === s.group)?.outcome, "setup-failed-retired");
  assert.equal(report.publishableBaseline, false);
  const continuation = join(h.temp, "continuation");
  mkdirSync(continuation);
  writeFileSync(join(continuation, "index.json"), JSON.stringify([
    { archives: {}, checkout: root, commit, root, round: "r21" },
  ]));
  // A legacy v4 fleet's unrelated intent file is outside continuation custody.
  writeFileSync(join(root, "launch-intent.json"), "ignored legacy record");
  const admission = await continuationAdmission(continuation, s.group);
  const [retired] = admission.subject.setupRetirements;
  assert.equal(retired.launch, undefined);
  const dispatchRecheck = recheckSetupRetirement(continuation, retired, admission.subject.indexedCustody);
  admission.recheck();
  const lateLock = join(local, "stream-recovery.lock");
  writeFileSync(lateLock, "{}", { flag: "wx" });
  assert.throws(dispatchRecheck, /group recovery remains active/);
  assert.throws(() => admission.recheck(), /group recovery remains active/);
  unlinkSync(lateLock);
  dispatchRecheck();
  admission.recheck();
  const extracted = join(local, s.evidence), custody = join(extracted, "control");
  const entry = join(custody, readdirSync(custody)[0]), changed = readFileSync(entry);
  changed[0] ^= 1;
  writeFileSync(entry, changed);
  report = await verify();
  assert.equal(report.groups.find(({ group }) => group === s.group)?.error, "group-evidence-invalid");
  const receipt = join(local, "failed-setup-host.json"), record = JSON.parse(readFileSync(receipt));
  const evidenceSha256 = treeHash(extracted), bytes = JSON.stringify({ ...record, evidenceSha256 });
  const rebound = { ...s, evidenceSha256, retirement: { ...s.retirement, evidenceSha256: digest(bytes) } };
  writeFileSync(receipt, bytes);
  writeFileSync(join(local, "state.json"), JSON.stringify(rebound));
  assert.throws(() => verifyFailedSetupRetirement(local, rebound), /original control custody bytes differ/);
  report = await verify();
  assert.equal(report.groups.find(({ group }) => group === s.group)?.error, "group-evidence-invalid");

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

// Wraps node:fs functions for the rest of the test; the controller's named imports see them.
// The restore runs once, from its own hook or from restoreFs(t), whichever comes first, so a
// failing earlier hook (the Python fixture's exit check) cannot leave the wrappers installed.
const fsRestores = new WeakMap();
const restoreFs = (t) => { for (const restore of fsRestores.get(t) ?? []) restore(); };
const hookFs = (t, wrappers) => {
  const mocks = Object.entries(wrappers).map(([name, wrap]) => t.mock.method(fs, name, wrap(fs[name])));
  syncBuiltinESMExports();
  const restore = () => { if (!mocks.length) return; for (const m of mocks.splice(0)) m.mock.restore(); syncBuiltinESMExports(); };
  fsRestores.set(t, [...fsRestores.get(t) ?? [], restore]);
  t.after(restore);
};
// The first exclusive write of a file whose name matches is torn: 80 bytes, then an error.
const tearWrite = (t, pattern) => {
  const fds = new Set(); let torn = false;
  hookFs(t, {
    openSync: (original) => (path, flags, ...rest) => {
      const fd = original(path, flags, ...rest);
      if (!torn && flags === "wx" && pattern.test(basename(String(path)))) { torn = true; fds.add(fd); }
      return fd;
    },
    writeFileSync: (original) => (target, data, ...rest) => {
      if (!fds.has(target)) return original(target, data, ...rest);
      fds.delete(target); fs.writeSync(target, Buffer.from(data).subarray(0, 80));
      throw new Error("injected torn write");
    },
  });
  return () => torn;
};
// A deletion intent and destroyedAt are each saved through their own fresh exclusive stage.
const intentStage = /^state\.json\.deletion-intent-[a-f0-9]{32}\.tmp$/, destroyedStage = /^state\.json\.destroyed-[a-f0-9]{32}\.tmp$/;
const receiptName = /^failed-setup-host\.json(?:\.stage)?$/, historyName = /^failed-setup-host\.interrupted-[a-f0-9]{64}\.json(?:\.stage)?$/;

const withdrawalModes = {
  "withdrawal-save-torn": "a partial unsent withdrawal stage leaves the intent and permits only exact absence",
  "withdrawal-save-complete": "a complete unsent withdrawal stage resumes on a fresh drain proof and sends only one DELETE across retries",
  "withdrawal-save-complete-absent": "a complete unsent withdrawal stage preserves the intent when the exact host is already absent",
  "withdrawal-save-complete-unavailable": "a complete unsent withdrawal stage preserves the intent when the exact host read fails",
  "withdrawal-other-attempt": "a withdrawal stage for a different create attempt leaves the DELETE intent",
  "withdrawal-other-session": "a withdrawal stage for a different control session leaves the DELETE intent",
  "withdrawal-other-host": "a withdrawal stage for a different droplet leaves the DELETE intent",
  "withdrawal-later-intent": "a withdrawal stage copied beside a later DELETE intent leaves that intent, even under its name",
  "withdrawal-other-bytes": "a withdrawal stage with nonmatching bytes leaves the DELETE intent",
  "withdrawal-unbound": "a complete legacy unbound withdrawal stage leaves the DELETE intent",
  "withdrawal-sent": "a stale withdrawal stage cannot clear a later intent whose DELETE was sent",
  "withdrawal-unknown": "a stale withdrawal stage cannot clear a later intent whose dispatch is unknown",
};

// The first bootstrap session stays open until its watcher misses its deadline, so the
// exit archive holds a real watch-failure and no receipt for it.
for (const mode of ["drained", "lost-acknowledgement", "pending-monitor", "refused", "invalid-proof", "delete-expired", "delete-in-time", "receipt-expired", "receipt-expired-kept", "receipt-expired-rebound", "receipt-expired-edited", "receipt-expired-unrecorded",
  "receipt-expired-history-torn", "receipt-edited-before-intent", "receipt-edited-before-delete", "receipt-torn", "receipt-unpublished",
  "receipt-edited-at-dispatch", "dispatch-unchanged", "pending-save-torn",
  "state-edited-at-dispatch", "custody-edited-at-dispatch", "lock-replaced-at-dispatch", "archive-edited-at-dispatch", "evidence-edited-at-dispatch",
  "archive-edited-during-dispatch-walk", "dispatch-walk-unchanged",
  "receipt-edited-at-engine", "engine-unchanged", "lock-replaced-at-read",
  "state-edited-at-preflight", "archive-edited-at-preflight", "lock-replaced-at-absence",
  "state-edited-at-read", "state-edited-at-verification", "proof-expired-at-verification", "state-edited-at-intent-stage",
  "receipt-edited-at-dispatch-evidence", "receipt-edited-at-intent-stage", "state-edited-at-receipt-stage", "proof-expired-at-receipt-stage",
  "delete-unsent-after-intent", "delete-cancelled-after-intent", "delete-expired-after-dispatch", "delete-failed-after-intent", ...Object.keys(withdrawalModes),
  "intent-save-torn", "destroyed-save-torn"]) test({
  drained: "a failed pre-registration watcher retires once on a fresh drain proof, and a restart repeats nothing",
  "lost-acknowledgement": "a drain query whose result is lost stays uncertain and keeps the host and lock",
  "pending-monitor": "a monitor registration beside a failed watcher refuses before any query",
  // The restart recognizes the refused drain query only by its exact drain script digest.
  refused: "a drain query that exits nonzero refuses, and a restart sends no second query",
  "invalid-proof": "a drain query that exits zero with unusable proof refuses, and a restart sends no second query",
  "delete-expired": "a drain proof that expires during the DELETE's account preflight saves no intent and sends no DELETE, and a restart deletes once on a fresh proof",
  "delete-in-time": "a drain proof still current after the DELETE's account preflight sends one DELETE with its own deadline",
  "receipt-expired": "a drain proof that expires between its receipt and the intent is kept, and a restart deletes once on a fresh proof",
  "receipt-expired-kept": "a restart whose earlier recovery already kept the interrupted receipt recovers it at the receipt's own bound",
  "receipt-expired-rebound": "an interrupted receipt edited to name an earlier ledger prefix refuses, keeps nothing and sends no DELETE",
  "receipt-expired-edited": "an interrupted receipt whose local start time alone was edited refuses, keeps nothing and sends no DELETE",
  "receipt-expired-unrecorded": "an interrupted receipt with no digest recorded before it was written refuses, keeps nothing and sends no DELETE",
  "receipt-expired-history-torn": "a history copy torn while it is written is never published, and the next collect keeps it whole and deletes once",
  "receipt-edited-before-intent": "a receipt edited after it is published and before the intent refuses with no intent and no DELETE",
  "receipt-edited-before-delete": "a receipt edited during the DELETE's account preflight refuses before the DELETE is sent",
  "receipt-torn": "a receipt torn while it is written is never published, so the next collect retires on a fresh proof",
  "receipt-unpublished": "a receipt whose stage link fails leaves its complete stage and no receipt, and the next collect retires on a fresh proof",
  "receipt-edited-at-dispatch": "a receipt edited during the production dispatch checkpoint refuses at the dispatch guard and sends no DELETE",
  "dispatch-unchanged": "an unchanged receipt passes the production dispatch guard and sends exactly one DELETE",
  "pending-save-torn": "a torn save of the receipt digest leaves its own stage, and the next collect retires on a fresh proof",
  "state-edited-at-dispatch": "a saved retirement digest edited during the production dispatch checkpoint refuses and sends no DELETE",
  "custody-edited-at-dispatch": "an archived watcher record edited during the production dispatch checkpoint refuses and sends no DELETE",
  "lock-replaced-at-dispatch": "an operation lock replaced during the production dispatch checkpoint refuses, sends no DELETE and keeps the replacement",
  "archive-edited-at-dispatch": "a byte appended to results.tgz during the production dispatch checkpoint refuses and sends no DELETE",
  "evidence-edited-at-dispatch": "an extracted file outside control/ edited during the production dispatch checkpoint refuses and sends no DELETE",
  "archive-edited-during-dispatch-walk": "a byte appended to results.tgz while the production dispatch guard walks the extracted tree refuses after the walk and sends no DELETE",
  "dispatch-walk-unchanged": "an archive left unchanged while the production dispatch guard walks the extracted tree passes and sends exactly one DELETE",
  "receipt-edited-at-engine": "a receipt edited at the in-process provider engine's checkpoint refuses there and sends no DELETE",
  "engine-unchanged": "an unchanged receipt passes the provider engine's guard and sends exactly one DELETE",
  "lock-replaced-at-read": "an operation lock replaced during the retirement's exact host read refuses with no digest, receipt, intent or DELETE",
  "state-edited-at-preflight": "a saved digest edited during the DELETE's account preflight refuses before the intent would overwrite it, and sends no DELETE",
  "archive-edited-at-preflight": "a byte appended to results.tgz during the DELETE's account preflight refuses with no intent, and once restored a restart deletes once on a fresh proof",
  "lock-replaced-at-absence": "an operation lock replaced during the absence read after the DELETE writes no destroyedAt, and a later collect confirms absence with no second DELETE",
  "state-edited-at-read": "a reservation changed during the retirement's exact host read refuses with no digest, receipt, intent or DELETE and keeps the change",
  "state-edited-at-verification": "a reservation changed while the evidence is verified for the intent refuses with no intent or DELETE and keeps the change",
  "proof-expired-at-verification": "a drain proof that expires while the evidence is verified for the intent saves no intent and sends no DELETE, and a restart deletes once on a fresh proof",
  "state-edited-at-intent-stage": "a reservation changed while the intent's own stage is written refuses before its rename, removes that stage and sends no DELETE",
  "receipt-edited-at-dispatch-evidence": "a receipt edited while the final dispatch guard checks the archive's identity refuses after that check and sends no DELETE",
  "receipt-edited-at-intent-stage": "a receipt edited while the intent's own stage is written refuses before its rename, removes that stage and saves no intent",
  "state-edited-at-receipt-stage": "a saved digest edited while the receipt's stage is written refuses before its link, removes that stage and publishes no receipt",
  "proof-expired-at-receipt-stage": "a drain proof that expires while the receipt's stage is written publishes no receipt, and a restart deletes once on a fresh proof",
  "delete-unsent-after-intent": "a drain proof that expires after the intent, before the provider sends the DELETE, withdraws the intent on that acknowledgement, and a restart deletes once on a fresh proof",
  "delete-cancelled-after-intent": "a controller cancelled after the intent, so the production checkpoint never sends the DELETE, still withdraws the intent, and a restart deletes once on a fresh proof",
  "delete-expired-after-dispatch": "a drain proof that expires after the DELETE request started keeps the intent when the provider answers with an error, and a restart only confirms absence",
  "delete-failed-after-intent": "a DELETE the provider answers with a failure that does not say it was unsent keeps the intent, and a restart only confirms absence",
  ...withdrawalModes,
  "intent-save-torn": "a torn deletion intent save leaves its own stage and no intent, and the next collect deletes once on a fresh proof",
  "destroyed-save-torn": "a torn destroyedAt save after the one DELETE leaves its own stage, and the next collect records absence with no second DELETE",
}[mode], async (t) => {
  const { h, options, fleet } = configured(t);
  options.group = groupNames[1]; h.flags.active = true; h.flags.bootstrapPending = 1;
  const kernel = spawn(process.platform === "win32" ? "python" : "python3",
    ["-I", fileURLToPath(new URL("./test-fixtures/control-session-kernel.py", import.meta.url)), "setup-fleet"],
    { timeout: 25000, killSignal: "SIGKILL", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: kernel.stdout })[Symbol.asyncIterator]();
  let stderr = ""; kernel.stderr.on("data", (part) => { stderr = (stderr + part).slice(-4096); });
  const closed = new Promise((resolve) => { kernel.on("error", (e) => resolve(String(e))); kernel.on("close", resolve); });
  t.after(async () => {
    try { kernel.stdin.end(); assert.equal(await closed, 0, stderr); }
    finally { restoreFs(t); }
  });
  const token = fleet.jobs[1].token;
  kernel.stdin.write(JSON.stringify({ mode: "setup-fleet", token, source: guardianSource, drainSource: setupDrainSource }) + "\n");
  let failed, queries = 0, offset = 0, stall, stalled = false, deleteExpiry, editAtPreflight = false, edited, replacedAtRead;
  let changedAtPreflight, replacedAtAbsence, changedAtRead, preflightSeen = false, changedAtVerification;
  // Another writer's change to the reservation: one more recorded extraction attempt.
  const editState = () => {
    const path = join(h.local, "state.json"), before = readFileSync(path), s = JSON.parse(before);
    s.extractionAttempts = [...s.extractionAttempts ?? [], "evidence-Concurrent0"];
    writeFileSync(path, `${JSON.stringify(s, null, 2)}\n`); return { before, after: readFileSync(path) };
  };
  const receipt = join(h.local, "failed-setup-host.json"), lockReplacement = `${JSON.stringify({ pid: 1, at: "2026-01-01T00:00:00.000Z" })}\n`;
  const editReceipt = () => {
    const bytes = readFileSync(receipt), record = JSON.parse(bytes); record.startedAtMs -= 1000;
    writeFileSync(receipt, `${JSON.stringify(record, null, 2)}\n`); edited = bytes;
  };
  const run = async (binary, args, timeout, allowFail, expiry, control) => {
    if (!control) {
      // After the receipt is published, the first provider read is the DELETE's own account
      // preflight; the drain proof's intent is saved only after it.
      const preflight = binary === "doctl" && args[0] === "account" && existsSync(receipt);
      if (stall && !stalled && preflight) { stalled = true; offset += stall; }
      if (editAtPreflight && !edited && preflight) editReceipt();
      if (preflight) preflightSeen = true;
      // The first exact host read after the drain query is the retirement's own ownership read.
      if (mode === "state-edited-at-read" && !changedAtRead && queries === 1 && binary === "doctl"
        && args[0] === "compute" && args[1] === "droplet" && args[2] === "get" && !existsSync(receipt)) changedAtRead = editState();
      if (preflight && !changedAtPreflight && mode === "state-edited-at-preflight") {
        // Only the recorded digest changes; the receipt and everything it names stay.
        const path = join(h.local, "state.json"), s = h.saved();
        changedAtPreflight = readFileSync(path); s.pendingRetirement.evidenceSha256 = "0".repeat(64);
        writeFileSync(path, `${JSON.stringify(s, null, 2)}\n`);
      }
      if (preflight && !changedAtPreflight && mode === "archive-edited-at-preflight") {
        const tgz = join(h.local, "results.tgz");
        changedAtPreflight = readFileSync(tgz); appendFileSync(tgz, Buffer.from([0]));
      }
      // After the DELETE, the next exact host read is its absence confirmation.
      if (mode === "lock-replaced-at-absence" && !replacedAtAbsence && h.deletes === 1 && binary === "doctl"
        && args[0] === "compute" && args[2] === "get") {
        const path = join(h.local, "operation.lock");
        replacedAtAbsence = readFileSync(path); unlinkSync(path); writeFileSync(path, lockReplacement);
      }
      // The first exact host read after the drain query is the retirement's own ownership read.
      if (mode === "lock-replaced-at-read" && !replacedAtRead && queries === 1 && binary === "doctl"
        && args[0] === "compute" && args[1] === "droplet" && args[2] === "get" && !existsSync(receipt)) {
        const path = join(h.local, "operation.lock");
        replacedAtRead = readFileSync(path); unlinkSync(path); writeFileSync(path, lockReplacement);
      }
      if (binary === "doctl" && args[2] === "delete") deleteExpiry = expiry;
      return h.run(binary, args, timeout, allowFail);
    }
    const s = h.saved(), script = args.at(-1), request = control.request;
    const exitArchive = request.epoch === "bootstrap" && script === bootstrapReadScript;
    const pack = exitArchive || script === "timeout 600 /bin/bash /bench/pack.sh";
    const query = script.includes("<<'CORTEN_FAILED_SETUP_HOST'");
    if (query) {
      queries++;
      assert.ok(script.includes("control_namespace['setup_drain_query']") && script.includes("benchmark-failed-setup-host/v3"));
      if (mode === "lost-acknowledgement") return shellTransport({ repo: h.repo, spawn: () => ({ status: 0, stdout: "{}",
        stderr: `CORTEN_CONTROL ${request.invocation.id} ${"a".repeat(64)}\n` }) })(binary, args, timeout, allowFail, expiry, control);
      if (mode === "refused" || mode === "invalid-proof") {
        const status = mode === "refused" ? 1 : 0;
        return shellTransport({ repo: h.repo, spawn: () => ({ status, stdout: '{"setupFailed":false}',
          stderr: `CORTEN_CONTROL ${request.invocation.id} ${"a".repeat(64)}\nCORTEN_RESULT ${request.invocation.id} ${status}\n` }) })(binary, args, timeout, allowFail, expiry, control);
      }
    }
    const expected = query && { sequence: request.sequence, requests: s.control.ledger.slice(0, -1).map((r) => r.request),
      binding: { round: s.round, commit, token, helperSha256: guardianSha256 },
      queryArgv: ["/usr/bin/python3", "-", s.id, s.unit, JSON.stringify(Object.fromEntries(Object.entries(remoteFiles(s)).map(([k, v]) => [k, digest(v)]))), "1"],
      watcherFailures: [{ id: failed.id, code: s.control.ledger[0].code, failureSha256: digest(failed.bytes) }] };
    const result = query ? null : await h.run(binary, args, timeout, allowFail);
    if (exitArchive) {
      assert.equal(s.preBootstrapTerminal, undefined); assert.equal(result.status, 3); assert.equal(h.deletes, 0);
      h.flags.active = false;
    }
    kernel.stdin.write(JSON.stringify({ request, payload: binary === "ssh" ? `set -euo pipefail\n${script}\n` : "synthetic SFTP",
      pack, hold: request.sequence === 0, code: result?.status ?? 0, ...(query ? { expected } : {}) }) + "\n");
    const line = await lines.next(); assert.equal(line.done, false, stderr);
    const reply = JSON.parse(line.value);
    if (exitArchive) {
      const names = Object.keys(reply.custody).filter((name) => name.startsWith("watch-failure-"));
      assert.equal(names.length, 1);
      failed = { id: names[0].slice("watch-failure-".length, -".json".length), bytes: Buffer.from(reply.custody[names[0]], "hex") };
      assert.equal(failed.id, s.control.ledger[0].request.invocation.id); assert.equal(reply.custody[`receipt-${failed.id}.json`], undefined);
      h.setArchive(archive([...metadata().slice(1),
        { name: "run.log", body: "benchmark job failed: stage=ssh-ingress-verification line=129 exit=1\n" }, { name: "control/" },
        ...Object.entries(reply.custody).map(([k, v]) => ({ name: "control/" + k, body: Buffer.from(v, "hex") }))]));
    }
    if (query) return { status: 0, stdout: JSON.stringify({ schema: "benchmark-failed-setup-host/v3", hostId: s.id, unit: s.unit,
      setupFailed: true, exitCode: 1, observedAtMs: Date.now(), control: reply.proof }) };
    return result;
  };
  await assert.rejects(h.task({ run }, options).launch(), /ended before common bootstrap admission/);
  assert.ok(h.saved().preBootstrapTerminal); assert.deepEqual(h.saved().control.sealed, []);
  assert.equal(h.saved().control.monitor.phase, "pending"); assert.ok(failed);
  const lock = join(h.local, "operation.lock");
  const deletesSent = () => h.calls.filter(([binary, ...args]) => binary === "doctl" && args[2] === "delete").length;
  // Every exclusive write or link of the receipt sees its digest already saved.
  const atPublication = [];
  const recordPublication = (path) => { if (receiptName.test(basename(String(path)))) atPublication.push(h.saved().pendingRetirement ?? null); };
  if (mode === "drained") hookFs(t, {
    openSync: (original) => (path, flags, ...rest) => { if (flags === "wx") recordPublication(path); return original(path, flags, ...rest); },
    linkSync: (original) => (from, to) => { recordPublication(to); return original(from, to); },
  });
  if (mode === "receipt-edited-before-intent" || mode === "receipt-edited-before-delete") {
    if (mode === "receipt-edited-before-intent") {
      // The first clock read after publication is the proof check just before the intent.
      const real = Date.now;
      t.mock.method(Date, "now", () => { if (!edited && existsSync(receipt)) editReceipt(); return real(); });
    } else editAtPreflight = true;
    await assert.rejects(h.task({ run }).collect(), /published retirement receipt differs from the bytes written; preserve host/);
    const saved = h.saved();
    assert.ok(edited); assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    assert.equal(saved.destroyedAt, undefined); assert.notEqual(digest(readFileSync(receipt)), digest(edited));
    // Edited before the intent, or during the DELETE's account preflight, which precedes a
    // drain proof's intent: either way no intent is saved and the recorded digest stays.
    assert.equal(saved.deletionIntentAt, undefined); assert.equal(saved.retirement, undefined); assert.equal(saved.status, "starting");
    assert.deepEqual(saved.pendingRetirement, { kind: "setup-failed", evidenceSha256: digest(edited) });
    // The edited receipt stays refused on restart.
    await assert.rejects(h.task({ run }).collect(), /interrupted retirement receipt differs from its recorded digest; preserve host/);
    assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    return;
  }
  if (mode === "receipt-edited-at-dispatch" || mode === "dispatch-unchanged") {
    // The real production dispatch steps: a cancellation checkpoint, which yields, then the
    // controller's dispatch guard, then the provider. The edit lands inside that checkpoint,
    // after the controller's own last check before run().
    let deleting = false;
    const dispatch = productionDispatch({ processRun: run, provider: () => (...args) => run("doctl", ...args),
      interrupted: () => { if (deleting && !edited && mode === "receipt-edited-at-dispatch") editReceipt(); return false; } });
    const production = (...args) => { if (args[0] === "doctl" && args[1][2] === "delete") deleting = true; return dispatch(...args); };
    if (mode === "dispatch-unchanged") {
      assert.equal(await h.task({ run: production }).collect(), 1);
      const s = h.saved();
      assert.equal(edited, undefined); assert.ok(deleting); assert.equal(queries, 1);
      assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1); assert.ok(s.destroyedAt);
      assert.equal(s.retirement.evidenceSha256, digest(readFileSync(receipt)));
      assert.doesNotThrow(() => verifyFailedSetupRetirement(h.local, s));
      return;
    }
    await assert.rejects(h.task({ run: production }).collect(), /published retirement receipt differs from the bytes written; preserve host/);
    const saved = h.saved();
    assert.ok(edited); assert.ok(deleting); assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    assert.ok(saved.deletionIntentAt); assert.equal(saved.destroyedAt, undefined);
    assert.equal(saved.retirement.evidenceSha256, digest(edited)); assert.notEqual(digest(readFileSync(receipt)), digest(edited));
    await assert.rejects(h.task({ run: production }).collect(), /retirement evidence changed/);
    assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    return;
  }
  if (mode === "archive-edited-during-dispatch-walk" || mode === "dispatch-walk-unchanged") {
    // The real production dispatch: its checkpoint, then the controller's guard, then the
    // provider. After that checkpoint the first directory opened under an extraction is the
    // guard's tree walk, which follows its first check of the archive's identity.
    const tgz = join(h.local, "results.tgz");
    let deleting = false, armed = false, walked = false, changed;
    hookFs(t, {
      opendirSync: (original) => (path, ...rest) => {
        if (armed && !walked && /^evidence-/.test(basename(String(path)))) {
          walked = true;
          if (mode === "archive-edited-during-dispatch-walk") { changed = readFileSync(tgz); appendFileSync(tgz, Buffer.from([0])); }
        }
        return original(path, ...rest);
      },
    });
    const dispatch = productionDispatch({ processRun: run, provider: () => (...args) => run("doctl", ...args),
      interrupted: () => { if (deleting) armed = true; return false; } });
    const production = (...args) => { if (args[0] === "doctl" && args[1][2] === "delete") deleting = true; return dispatch(...args); };
    if (mode === "dispatch-walk-unchanged") {
      assert.equal(await h.task({ run: production }).collect(), 1);
      const s = h.saved();
      assert.ok(walked); assert.equal(changed, undefined); assert.equal(queries, 1);
      assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1); assert.ok(s.destroyedAt);
      assert.doesNotThrow(() => verifyFailedSetupRetirement(h.local, s));
      return;
    }
    await assert.rejects(h.task({ run: production }).collect(), /setup archive changed; preserve host/);
    assert.ok(walked && changed); assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    const saved = h.saved();
    assert.ok(saved.deletionIntentAt); assert.equal(saved.destroyedAt, undefined);
    assert.equal(readFileSync(tgz).length, changed.length + 1); assert.equal(existsSync(lock), false);
    restoreFs(t);
    await assert.rejects(h.task({ run: production }).collect());
    assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    return;
  }
  if (["state-edited-at-dispatch", "custody-edited-at-dispatch", "lock-replaced-at-dispatch", "archive-edited-at-dispatch", "evidence-edited-at-dispatch"].includes(mode)) {
    // Each edit lands inside the production dispatch checkpoint, after the controller's last
    // check before run(), on something other than the receipt the DELETE relies on.
    const statePath = join(h.local, "state.json"), replacement = `${JSON.stringify({ pid: 1, at: "2026-01-01T00:00:00.000Z" })}\n`;
    let deleting = false, changed;
    const change = () => {
      const s = h.saved();
      if (mode === "state-edited-at-dispatch") {
        changed = readFileSync(statePath); s.retirement.evidenceSha256 = "0".repeat(64);
        writeFileSync(statePath, `${JSON.stringify(s, null, 2)}\n`);
      } else if (mode === "custody-edited-at-dispatch") {
        const record = join(h.local, s.evidence, "control", `watch-failure-${failed.id}.json`);
        changed = readFileSync(record); writeFileSync(record, Buffer.concat([changed, Buffer.from(" ")]));
      } else if (mode === "archive-edited-at-dispatch") {
        const tgz = join(h.local, "results.tgz");
        changed = readFileSync(tgz); appendFileSync(tgz, Buffer.from([0]));
      } else if (mode === "evidence-edited-at-dispatch") {
        const log = join(h.local, s.evidence, "run.log");
        changed = readFileSync(log); appendFileSync(log, "x");
      } else {
        changed = readFileSync(lock); unlinkSync(lock); writeFileSync(lock, replacement);
      }
    };
    const dispatch = productionDispatch({ processRun: run, provider: () => (...args) => run("doctl", ...args),
      interrupted: () => { if (deleting && !changed) change(); return false; } });
    const production = (...args) => { if (args[0] === "doctl" && args[1][2] === "delete") deleting = true; return dispatch(...args); };
    await assert.rejects(h.task({ run: production }).collect(), {
      "state-edited-at-dispatch": /saved retirement reservation changed; preserve host/,
      "custody-edited-at-dispatch": /archived control custody changed; preserve host/,
      "lock-replaced-at-dispatch": /operation\.lock was replaced during this operation; the replacement is kept; preserve custody/,
      "archive-edited-at-dispatch": /setup archive changed; preserve host/,
      "evidence-edited-at-dispatch": /setup evidence changed; preserve host/,
    }[mode]);
    assert.ok(changed); assert.ok(deleting); assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    assert.equal(h.saved().destroyedAt, undefined);
    if (mode === "lock-replaced-at-dispatch") {
      // Teardown leaves the replacement for its owner, and nothing runs past it.
      assert.equal(readFileSync(lock, "utf8"), replacement);
      await assert.rejects(h.task({ run: production }).collect());
      assert.equal(readFileSync(lock, "utf8"), replacement);
    } else assert.equal(existsSync(lock), false);
    assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    return;
  }
  if (mode === "receipt-edited-at-engine" || mode === "engine-unchanged") {
    // Provider commands go through a real in-process engine, whose own checkpoint runs after
    // the production dispatch guard. The edit lands at the engine's checkpoint for the DELETE.
    let engineDeleting = false;
    const engine = createProviderEngine({ repo: h.repo, spawn: () => ({ status: 0, stdout: Buffer.from("SYNTHETIC_ONLY_CREDENTIAL_A\n") }),
      request: syntheticProviderRequest(h), sleep: async () => {},
      interrupted: () => { if (engineDeleting && !edited && mode === "receipt-edited-at-engine") editReceipt(); return false; } });
    const provider = (argv, ...rest) => { engineDeleting = argv[2] === "delete"; return engine(argv, ...rest); };
    const production = productionDispatch({ processRun: run, provider: () => provider, interrupted: () => false });
    if (mode === "engine-unchanged") {
      assert.equal(await h.task({ run: production }).collect(), 1);
      const s = h.saved();
      assert.equal(edited, undefined); assert.equal(queries, 1);
      assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1); assert.ok(s.destroyedAt);
      assert.doesNotThrow(() => verifyFailedSetupRetirement(h.local, s));
      return;
    }
    await assert.rejects(h.task({ run: production }).collect(), /published retirement receipt differs from the bytes written; preserve host/);
    const saved = h.saved();
    assert.ok(edited); assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    assert.ok(saved.deletionIntentAt); assert.equal(saved.destroyedAt, undefined);
    return;
  }
  if (mode === "pending-save-torn") {
    // The first state save that carries the receipt digest is torn: 80 bytes, then an error.
    const fds = new Set(); let torn;
    hookFs(t, {
      openSync: (original) => (path, flags, ...rest) => {
        const fd = original(path, flags, ...rest);
        if (!torn && flags === "wx" && /^state\.json\..*tmp$/.test(basename(String(path)))) fds.add(fd);
        return fd;
      },
      writeFileSync: (original) => (target, data, ...rest) => {
        if (!fds.has(target)) return original(target, data, ...rest);
        fds.delete(target);
        if (torn || !String(data).includes('"pendingRetirement"')) return original(target, data, ...rest);
        torn = true; fs.writeSync(target, Buffer.from(data).subarray(0, 80));
        throw new Error("injected torn write");
      },
    });
    await assert.rejects(h.task({ run }).collect(), /injected torn write/);
    const interrupted = h.saved();
    assert.ok(torn); assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    assert.equal(interrupted.pendingRetirement, undefined); assert.equal(interrupted.deletionIntentAt, undefined);
    assert.equal(existsSync(receipt), false); assert.equal(existsSync(join(h.local, "state.json.tmp")), false);
    const stages = readdirSync(h.local).filter((name) => /^state\.json\..*tmp$/.test(name));
    assert.equal(stages.length, 1); assert.match(stages[0], /^state\.json\.pending-retirement-[a-f0-9]{32}\.tmp$/);
    const tornBytes = readFileSync(join(h.local, stages[0]));
    assert.equal(tornBytes.length, 80);
    assert.equal(await h.task({ run }).collect(), 1);
    const s = h.saved();
    assert.equal(queries, 2); assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1); assert.ok(s.destroyedAt);
    assert.equal(s.retirement.evidenceSha256, digest(readFileSync(receipt))); assert.equal(s.pendingRetirement, undefined);
    // The torn stage is never read or removed; it stays for the operator.
    assert.ok(readFileSync(join(h.local, stages[0])).equals(tornBytes));
    assert.doesNotThrow(() => verifyFailedSetupRetirement(h.local, s));
    return;
  }
  if (mode === "receipt-torn" || mode === "receipt-unpublished") {
    const stage = `${receipt}.stage`;
    if (mode === "receipt-torn") tearWrite(t, receiptName);
    else {
      // Fail at the publication itself, after the digest save: the link that publishes the
      // receipt's complete stage under its final name.
      let failedOnce = false;
      hookFs(t, {
        linkSync: (original) => (from, to) => {
          if (!failedOnce && basename(String(to)) === "failed-setup-host.json") { failedOnce = true; throw new Error("injected publication failure"); }
          return original(from, to);
        },
      });
    }
    await assert.rejects(h.task({ run }).collect(), mode === "receipt-torn" ? /injected torn write/ : /injected publication failure/);
    const interrupted = h.saved(), published = existsSync(receipt);
    assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    assert.equal(interrupted.deletionIntentAt, undefined); assert.equal(interrupted.retirement, undefined);
    // The checkpoint is the digest alone, saved before the receipt was published.
    assert.equal(interrupted.pendingRetirement?.kind, "setup-failed");
    if (mode === "receipt-unpublished") {
      // Staged publication: the failed link leaves the whole receipt as its stage, never as the receipt.
      assert.ok(existsSync(stage), "a failed link left no complete stage");
      assert.equal(digest(readFileSync(stage)), interrupted.pendingRetirement.evidenceSha256);
    }
    assert.equal(await h.task({ run }).collect(), 1);
    const s = h.saved(), current = readFileSync(receipt);
    assert.equal(published, false, "an interrupted write published the receipt");
    assert.equal(existsSync(stage), false);
    assert.equal(queries, 2); assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1); assert.ok(s.destroyedAt);
    assert.equal(s.retirement.evidenceSha256, digest(current)); assert.equal(s.pendingRetirement, undefined);
    assert.notEqual(s.retirement.evidenceSha256, interrupted.pendingRetirement.evidenceSha256);
    assert.equal(JSON.parse(current).observation.control.requests.length, s.control.ledger.length);
    assert.ok(!readdirSync(h.local).some((name) => name.endsWith(".stage")));
    assert.doesNotThrow(() => verifyFailedSetupRetirement(h.local, s));
    return;
  }
  if (mode === "lock-replaced-at-read") {
    await assert.rejects(h.task({ run }).collect(), (error) => /operation\.lock was replaced during this operation; the replacement is kept/.test(error.message)
      && /operation\.lock changed; preserve custody/.test(error.cause?.message));
    const saved = h.saved();
    assert.ok(replacedAtRead); assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    assert.equal(saved.pendingRetirement, undefined); assert.equal(saved.deletionIntentAt, undefined); assert.equal(saved.retirement, undefined);
    assert.equal(existsSync(receipt), false); assert.ok(!readdirSync(h.local).some((name) => name.startsWith("failed-setup-host")));
    assert.ok(!readdirSync(h.local).some((name) => /^state\.json\..*tmp$/.test(name)));
    assert.equal(readFileSync(lock, "utf8"), lockReplacement, "the replacement lock is kept for its owner");
    return;
  }
  if (mode === "state-edited-at-preflight") {
    await assert.rejects(h.task({ run }).collect(), /saved reservation changed before the deletion intent; preserve host/);
    const saved = h.saved(), current = readFileSync(receipt);
    assert.ok(changedAtPreflight); assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    // The change stays as it was made: no intent was saved over it.
    assert.equal(saved.deletionIntentAt, undefined); assert.equal(saved.retirement, undefined); assert.equal(saved.status, "starting");
    assert.deepEqual(saved.pendingRetirement, { kind: "setup-failed", evidenceSha256: "0".repeat(64) });
    assert.equal(JSON.parse(changedAtPreflight).pendingRetirement.evidenceSha256, digest(current));
    // The receipt no longer matches the recorded digest, so a restart refuses it as well.
    await assert.rejects(h.task({ run }).collect(), /interrupted retirement receipt differs from its recorded digest; preserve host/);
    assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0); assert.equal(h.saved().deletionIntentAt, undefined);
    return;
  }
  if (mode === "archive-edited-at-preflight") {
    await assert.rejects(h.task({ run }).collect(), /archive changed; preserve host/);
    const saved = h.saved(), old = readFileSync(receipt);
    assert.ok(changedAtPreflight); assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    // The evidence is verified before the intent, so only the receipt and its digest remain.
    assert.equal(saved.deletionIntentAt, undefined); assert.equal(saved.retirement, undefined); assert.equal(saved.status, "starting");
    assert.deepEqual(saved.pendingRetirement, { kind: "setup-failed", evidenceSha256: digest(old) }); assert.equal(existsSync(lock), false);
    // With the archive restored, a restart keeps the old receipt and deletes once on a fresh proof.
    writeFileSync(join(h.local, "results.tgz"), changedAtPreflight);
    assert.equal(await h.task({ run }).collect(), 1);
    const s = h.saved();
    assert.equal(queries, 2); assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1); assert.ok(s.destroyedAt);
    assert.ok(readFileSync(join(h.local, `failed-setup-host.interrupted-${digest(old)}.json`)).equals(old));
    assert.equal(s.retirement.evidenceSha256, digest(readFileSync(receipt))); assert.equal(s.pendingRetirement, undefined);
    assert.doesNotThrow(() => verifyFailedSetupRetirement(h.local, s));
    return;
  }
  if (mode === "lock-replaced-at-absence") {
    await assert.rejects(h.task({ run }).collect(), (error) => /operation\.lock was replaced during this operation; the replacement is kept/.test(error.message)
      && /operation\.lock changed; preserve custody/.test(error.cause?.message));
    const saved = h.saved();
    assert.ok(replacedAtAbsence); assert.equal(queries, 1); assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1);
    assert.equal(saved.status, "retired"); assert.ok(saved.deletionIntentAt); assert.equal(saved.destroyedAt, undefined);
    assert.equal(readFileSync(lock, "utf8"), lockReplacement, "the replacement lock is kept for its owner");
    // While the replacement holds custody nothing runs; once it is gone, a collect confirms
    // absence under its own lock and sends no second DELETE.
    await assert.rejects(h.task({ run }).collect());
    assert.equal(deletesSent(), 1); assert.equal(h.saved().destroyedAt, undefined);
    unlinkSync(lock);
    assert.equal(await h.task({ run }).collect(), 1);
    const s = h.saved();
    assert.ok(s.destroyedAt); assert.equal(queries, 1); assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1);
    assert.doesNotThrow(() => verifyFailedSetupRetirement(h.local, s));
    return;
  }
  if (mode === "receipt-edited-at-dispatch-evidence") {
    // After the intent's rename, the first identity read of results.tgz is the final dispatch
    // guard's archive pin, which follows its control custody walk and precedes the rest.
    let intentRenamed = false;
    hookFs(t, {
      renameSync: (original) => (from, to) => {
        original(from, to);
        if (preflightSeen && intentStage.test(basename(String(from))) && basename(String(to)) === "state.json") intentRenamed = true;
      },
      lstatSync: (original) => (path, ...rest) => {
        if (intentRenamed && !edited && basename(String(path)) === "results.tgz") editReceipt();
        return original(path, ...rest);
      },
    });
    await assert.rejects(h.task({ run }).collect(), /published retirement receipt differs from the bytes written; preserve host/);
    const saved = h.saved();
    assert.ok(intentRenamed && edited); assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    assert.ok(saved.deletionIntentAt); assert.equal(saved.destroyedAt, undefined);
    assert.equal(saved.retirement.evidenceSha256, digest(edited)); assert.notEqual(digest(readFileSync(receipt)), digest(edited));
    restoreFs(t);
    await assert.rejects(h.task({ run }).collect(), /retirement evidence changed/);
    assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    return;
  }
  if (mode === "receipt-edited-at-intent-stage") {
    // After the DELETE's account preflight, the first exclusive open of the intent's own
    // stage; the receipt is edited while that stage is written.
    let stage;
    hookFs(t, {
      openSync: (original) => (path, flags, ...rest) => {
        const fd = original(path, flags, ...rest);
        if (preflightSeen && !stage && flags === "wx" && intentStage.test(basename(String(path)))) { stage = String(path); editReceipt(); }
        return fd;
      },
    });
    await assert.rejects(h.task({ run }).collect(), /published retirement receipt differs from the bytes written; preserve host/);
    const saved = h.saved();
    assert.ok(stage && edited); assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    // No intent: the refused stage is gone and the recorded digest is still the one written.
    assert.equal(existsSync(stage), false);
    assert.equal(saved.deletionIntentAt, undefined); assert.equal(saved.retirement, undefined); assert.equal(saved.status, "starting");
    assert.deepEqual(saved.pendingRetirement, { kind: "setup-failed", evidenceSha256: digest(edited) });
    restoreFs(t);
    await assert.rejects(h.task({ run }).collect(), /interrupted retirement receipt differs from its recorded digest; preserve host/);
    assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    return;
  }
  if (mode === "state-edited-at-receipt-stage" || mode === "proof-expired-at-receipt-stage") {
    // The receipt's own publication stage is opened after its digest is saved and the custody
    // check before the write; the change lands while that stage is written and synced.
    const real = Date.now; t.mock.method(Date, "now", () => real() + offset);
    const statePath = join(h.local, "state.json");
    let stage, changed;
    hookFs(t, {
      openSync: (original) => (path, flags, ...rest) => {
        const fd = original(path, flags, ...rest);
        if (!stage && flags === "wx" && basename(String(path)) === "failed-setup-host.json.stage") {
          stage = String(path);
          if (mode === "proof-expired-at-receipt-stage") offset += 61000;
          else {
            const s = JSON.parse(readFileSync(statePath)); s.pendingRetirement.evidenceSha256 = "0".repeat(64);
            writeFileSync(statePath, `${JSON.stringify(s, null, 2)}\n`); changed = readFileSync(statePath);
          }
        }
        return fd;
      },
    });
    await assert.rejects(h.task({ run }).collect(), mode === "proof-expired-at-receipt-stage"
      ? /retirement proof expired before deletion/ : /saved reservation changed before the deletion intent; preserve host/);
    const saved = h.saved();
    assert.ok(stage); assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    // Nothing published: no receipt and no stage, and no intent.
    assert.equal(existsSync(stage), false); assert.equal(existsSync(receipt), false);
    assert.equal(saved.deletionIntentAt, undefined); assert.equal(saved.retirement, undefined); assert.equal(saved.status, "starting");
    if (mode === "state-edited-at-receipt-stage") {
      // The change is kept as made.
      assert.ok(readFileSync(statePath).equals(changed));
      return;
    }
    assert.ok(saved.pendingRetirement); assert.equal(existsSync(lock), false);
    restoreFs(t);
    // A restart finds the digest and no receipt and deletes once on its own fresh proof.
    assert.equal(await h.task({ run }).collect(), 1);
    const s = h.saved(), record = JSON.parse(readFileSync(receipt));
    assert.equal(queries, 2); assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1); assert.ok(s.destroyedAt);
    assert.ok(!readdirSync(h.local).some((name) => name.startsWith("failed-setup-host.interrupted-")));
    assert.equal(s.retirement.evidenceSha256, digest(readFileSync(receipt))); assert.equal(s.pendingRetirement, undefined);
    assert.equal(deleteExpiry, record.startedAtMs + 60000);
    assert.doesNotThrow(() => verifyFailedSetupRetirement(h.local, s));
    return;
  }
  if (mode === "state-edited-at-read") {
    await assert.rejects(h.task({ run }).collect(), /saved reservation changed before the deletion intent; preserve host/);
    const saved = h.saved();
    assert.ok(changedAtRead); assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    // The change stays as it was made: no digest, receipt or intent was saved over it.
    assert.ok(readFileSync(join(h.local, "state.json")).equals(changedAtRead.after));
    assert.equal(saved.pendingRetirement, undefined); assert.equal(saved.deletionIntentAt, undefined); assert.equal(saved.retirement, undefined);
    assert.equal(existsSync(receipt), false); assert.ok(!readdirSync(h.local).some((name) => name.startsWith("failed-setup-host")));
    assert.ok(!readdirSync(h.local).some((name) => /^state\.json\..*tmp$/.test(name)));
    return;
  }
  if (mode === "state-edited-at-intent-stage") {
    // After the DELETE's account preflight, the first exclusive open of the intent's own
    // stage, written after the custody check that follows its verification.
    let stage;
    hookFs(t, {
      openSync: (original) => (path, flags, ...rest) => {
        const fd = original(path, flags, ...rest);
        if (preflightSeen && !changedAtVerification && flags === "wx" && intentStage.test(basename(String(path)))) {
          stage = String(path); changedAtVerification = editState();
        }
        return fd;
      },
    });
    await assert.rejects(h.task({ run }).collect(), /saved reservation changed before the deletion intent; preserve host/);
    const saved = h.saved(), current = readFileSync(receipt);
    assert.ok(changedAtVerification && stage); assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    // The change stays as it was made, and the refused stage is gone, so it blocks no later save.
    assert.ok(readFileSync(join(h.local, "state.json")).equals(changedAtVerification.after));
    assert.equal(existsSync(stage), false);
    assert.equal(saved.deletionIntentAt, undefined); assert.equal(saved.retirement, undefined); assert.equal(saved.status, "starting");
    assert.deepEqual(saved.pendingRetirement, { kind: "setup-failed", evidenceSha256: digest(current) });
    return;
  }
  if (mode === "state-edited-at-verification" || mode === "proof-expired-at-verification") {
    // After the DELETE's account preflight, the first open of results.tgz is the intent's own
    // verification, which follows the custody check made just after that preflight.
    const real = Date.now; t.mock.method(Date, "now", () => real() + offset);
    hookFs(t, {
      openSync: (original) => (path, ...rest) => {
        if (preflightSeen && !changedAtVerification && basename(String(path)) === "results.tgz") {
          if (mode === "state-edited-at-verification") changedAtVerification = editState();
          else { changedAtVerification = true; offset += 61000; }
        }
        return original(path, ...rest);
      },
    });
    if (mode === "state-edited-at-verification") {
      await assert.rejects(h.task({ run }).collect(), /saved reservation changed before the deletion intent; preserve host/);
      const saved = h.saved(), current = readFileSync(receipt);
      assert.ok(changedAtVerification); assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
      // The change stays as it was made: no intent was saved over it.
      assert.ok(readFileSync(join(h.local, "state.json")).equals(changedAtVerification.after));
      assert.equal(saved.deletionIntentAt, undefined); assert.equal(saved.retirement, undefined); assert.equal(saved.status, "starting");
      assert.deepEqual(saved.pendingRetirement, { kind: "setup-failed", evidenceSha256: digest(current) });
      return;
    }
    await assert.rejects(h.task({ run }).collect(), /retirement proof expired before deletion/);
    const saved = h.saved(), old = readFileSync(receipt);
    assert.ok(changedAtVerification); assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    // The expired proof leaves only its receipt and digest.
    assert.equal(saved.deletionIntentAt, undefined); assert.equal(saved.retirement, undefined); assert.equal(saved.status, "starting");
    assert.deepEqual(saved.pendingRetirement, { kind: "setup-failed", evidenceSha256: digest(old) }); assert.equal(existsSync(lock), false);
    // A restart keeps that receipt for archival and deletes once on its own fresh proof.
    assert.equal(await h.task({ run }).collect(), 1);
    const s = h.saved(), record = JSON.parse(readFileSync(receipt));
    assert.equal(queries, 2); assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1); assert.ok(s.destroyedAt);
    assert.ok(readFileSync(join(h.local, `failed-setup-host.interrupted-${digest(old)}.json`)).equals(old));
    assert.equal(s.retirement.evidenceSha256, digest(readFileSync(receipt))); assert.equal(s.pendingRetirement, undefined);
    assert.equal(deleteExpiry, record.startedAtMs + 60000);
    assert.doesNotThrow(() => verifyFailedSetupRetirement(h.local, s));
    return;
  }
  if (mode === "pending-monitor") {
    writeFileSync(join(h.local, "monitor-registration.json"), "{}");
    await assert.rejects(h.task({ run }).collect(), /ambiguous pre-bootstrap custody/);
    assert.equal(queries, 0); assert.equal(h.deletes, 0); assert.equal(h.saved().archiveSha256, undefined);
    assert.equal(h.saved().retirement, undefined); assert.equal(h.saved().deletionIntentAt, undefined);
    return;
  }
  if (mode === "lost-acknowledgement") {
    await assert.rejects(h.task({ run }).collect(), /remote control completion uncertain/);
    const saved = h.saved();
    assert.equal(queries, 1); assert.equal(saved.control.ledger.at(-1).localTerminal, false); assert.ok(existsSync(lock));
    assert.equal(saved.retirement, undefined); assert.equal(saved.deletionIntentAt, undefined); assert.equal(h.deletes, 0);
    await assert.rejects(h.task({ run }).collect(), /ambiguous pre-bootstrap custody/);
    assert.equal(queries, 1); assert.deepEqual(h.saved(), saved); assert.ok(existsSync(lock)); assert.equal(h.deletes, 0);
    return;
  }
  if (mode === "refused" || mode === "invalid-proof") {
    await assert.rejects(h.task({ run }).collect(), { controllerStage: "setup-host-proof-refused" });
    const saved = h.saved(), last = saved.control.ledger.at(-1);
    assert.equal(queries, 1); assert.equal(last.request.epoch, "collection"); assert.equal(last.localTerminal, true);
    assert.equal(last.code, mode === "refused" ? 1 : 0); assert.equal(last.setupProofRejected, mode === "invalid-proof" ? true : undefined);
    assert.ok(saved.archiveSha256 && saved.evidenceSha256); assert.equal(saved.status, "starting");
    assert.equal(saved.retirement, undefined); assert.equal(saved.deletionIntentAt, undefined);
    assert.equal(existsSync(lock), false); assert.equal(h.deletes, 0);
    const calls = h.calls.length;
    await assert.rejects(h.task({ run }).collect(), { controllerStage: "setup-host-proof-refused" });
    assert.equal(queries, 1); assert.equal(h.calls.length, calls); assert.deepEqual(h.saved(), saved);
    assert.equal(existsSync(lock), false); assert.equal(h.deletes, 0); assert.equal(h.inspections, 0);
    return;
  }
  if (mode === "delete-failed-after-intent") {
    // The provider answers the DELETE, after it reached the provider, with a failure that carries
    // no not-dispatched acknowledgement. Only that acknowledgement withdraws the intent.
    let intentAtDelete;
    const failing = async (binary, args, timeout, allowFail, expiry, ctl) => {
      const result = await run(binary, args, timeout, allowFail, expiry, ctl);
      if (ctl || binary !== "doctl" || args[2] !== "delete") return result;
      intentAtDelete = h.saved().deletionIntentAt;
      return { ...result, status: 1 };
    };
    await assert.rejects(h.task({ run: failing }).collect(), /delete outcome uncertain; preserve intent/);
    const saved = h.saved();
    assert.ok(intentAtDelete); assert.equal(queries, 1); assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1);
    assert.equal(saved.status, "retired"); assert.equal(saved.deletionIntentAt, intentAtDelete); assert.equal(saved.destroyedAt, undefined);
    assert.equal(saved.pendingRetirement, undefined); assert.equal(existsSync(lock), false);
    assert.ok(!readdirSync(h.local).some((name) => /^state\.json\..*tmp$/.test(name)));
    // Recovery is exact absence alone: no second query and no second DELETE.
    assert.equal(await h.task({ run }).collect(), 1);
    const s = h.saved();
    assert.equal(queries, 1); assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1); assert.ok(s.destroyedAt);
    assert.equal(s.deletionIntentAt, intentAtDelete);
    assert.doesNotThrow(() => verifyFailedSetupRetirement(h.local, s));
    return;
  }
  if (mode === "delete-unsent-after-intent" || mode === "delete-expired-after-dispatch" || Object.hasOwn(withdrawalModes, mode)) {
    // The DELETE goes through the real production dispatch and an in-process provider engine,
    // which checks the proof's deadline itself just before its request. The clock passes that
    // deadline once, after the intent is saved: at the engine's checkpoint before the request
    // (nothing sent), or inside the request after the provider deleted the droplet, which then
    // answers with an error (sent; its outcome cannot be ruled out).
    const real = Date.now; t.mock.method(Date, "now", () => real() + offset);
    let engineDeleting = false, jumped = false, intentAtJump;
    const jump = () => { jumped = true; intentAtJump = h.saved().deletionIntentAt; offset += 61000; };
    const synthetic = syntheticProviderRequest(h);
    const engine = createProviderEngine({ repo: h.repo, spawn: () => ({ status: 0, stdout: Buffer.from("SYNTHETIC_ONLY_CREDENTIAL_A\n") }),
      request: async (input) => {
        if (mode !== "delete-expired-after-dispatch" || input.method !== "DELETE" || jumped) return synthetic(input);
        jump(); await synthetic(input); return { status: 500, value: null };
      },
      sleep: async () => {},
      interrupted: () => { if (mode !== "delete-expired-after-dispatch" && engineDeleting && !jumped) jump(); return false; } });
    const provider = (argv, ...rest) => { engineDeleting = argv[2] === "delete"; return engine(argv, ...rest); };
    const production = productionDispatch({ processRun: run, provider: () => provider, interrupted: () => false });
    if (mode === "delete-expired-after-dispatch") {
      await assert.rejects(h.task({ run: production }).collect(), /provider control failed; preserve state\/evidence\/host/);
      const saved = h.saved();
      assert.ok(jumped && intentAtJump); assert.equal(queries, 1); assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1);
      // The request was sent, so the intent stays and nothing is withdrawn.
      assert.equal(saved.status, "retired"); assert.equal(saved.deletionIntentAt, intentAtJump); assert.equal(saved.destroyedAt, undefined);
      assert.equal(saved.pendingRetirement, undefined); assert.equal(existsSync(lock), false);
      // Recovery is exact absence alone: no second query and no second DELETE.
      assert.equal(await h.task({ run: production }).collect(), 1);
      const s = h.saved();
      assert.equal(queries, 1); assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1); assert.ok(s.destroyedAt);
      assert.equal(s.deletionIntentAt, intentAtJump);
      assert.doesNotThrow(() => verifyFailedSetupRetirement(h.local, s));
      return;
    }
    if (Object.hasOwn(withdrawalModes, mode)) {
      const partial = mode === "withdrawal-save-torn", fds = new Set(); let torn = false;
      hookFs(t, {
        openSync: (original) => (path, flags, ...rest) => {
          const fd = original(path, flags, ...rest);
          if (partial && jumped && flags === "wx" && basename(String(path)).startsWith("state.json.delete-unsent-")) fds.add(fd);
          return fd;
        },
        writeFileSync: (original) => (target, data, ...rest) => {
          if (!fds.has(target)) return original(target, data, ...rest);
          torn = true; fs.writeSync(target, Buffer.from(data).subarray(0, 80));
          throw new Error("injected interrupted withdrawal");
        },
        renameSync: (original) => (from, to) => {
          if (!partial && jumped && basename(String(from)).startsWith("state.json.delete-unsent-")) {
            torn = true; throw new Error("injected interrupted withdrawal");
          }
          return original(from, to);
        },
      });
      await assert.rejects(h.task({ run: production }).collect(), /injected interrupted withdrawal/);
      restoreFs(t);
      const statePath = join(h.local, "state.json"), intent = h.saved(), old = readFileSync(receipt);
      assert.ok(torn && jumped && intentAtJump); assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
      assert.equal(intent.status, "retired"); assert.equal(intent.deletionIntentAt, intentAtJump); assert.equal(intent.destroyedAt, undefined);
      assert.equal(existsSync(lock), false);
      assert.equal(existsSync(join(h.local, "state.json.tmp")), false);
      const stages = readdirSync(h.local).filter((name) => /^state\.json\.delete-unsent-[a-f0-9]+\.tmp$/.test(name));
      assert.equal(stages.length, 1);
      let stage = join(h.local, stages[0]);
      if (partial) {
        assert.equal(readFileSync(stage).length, 80);
      } else if (mode === "withdrawal-save-complete-absent" || mode === "withdrawal-save-complete-unavailable") {
        const intentBytes = readFileSync(statePath);
        const stageBytes = readFileSync(stage);
        assert.equal(JSON.parse(stageBytes).intentSha256, digest(intentBytes));
        const calls = h.calls.length;
        if (mode === "withdrawal-save-complete-unavailable") {
          const unavailable = (binary, args, ...rest) => {
            if (binary === "doctl" && args[2] === "get") {
              assert.equal(args[3], intent.id);
              return { status: 1, providerDiagnostic: { code: "get-http", httpStatus: 503 } };
            }
            return run(binary, args, ...rest);
          };
          await assert.rejects(h.task({ run: unavailable }).collect(), /exact host observation failed; preserve state/);
          assert.ok(readFileSync(statePath).equals(intentBytes));
          assert.ok(readFileSync(stage).equals(stageBytes));
        }
        h.hosts([]);
        assert.equal(await h.task({ run }).collect(), 1);
        const saved = h.saved();
        assert.ok(saved.destroyedAt);
        assert.deepEqual(saved, { ...intent, destroyedAt: saved.destroyedAt });
        assert.ok(readFileSync(stage).equals(stageBytes));
        assert.ok(readFileSync(receipt).equals(old));
        assert.doesNotThrow(() => verifyFailedSetupRetirement(h.local, saved));
        assert.equal(await h.task({ run }).collect(), 1);
        assert.deepEqual(h.saved(), saved);
        assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
        assert.ok(h.calls.slice(calls).every(([binary, resource, kind, verb, id]) =>
          binary === "doctl" && (resource === "account" || resource === "compute" && kind === "droplet" && verb === "get" && id === intent.id)));
        return;
      } else if (mode === "withdrawal-save-complete") {
        assert.equal(await h.task({ run }).collect(), 1);
        const saved = h.saved(), fresh = readFileSync(receipt);
        assert.equal(queries, 2); assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1); assert.ok(saved.destroyedAt);
        assert.notEqual(digest(fresh), digest(old)); assert.equal(deleteExpiry, JSON.parse(fresh).startedAtMs + 60000);
        assert.ok(readFileSync(join(h.local, `failed-setup-host.interrupted-${digest(old)}.json`)).equals(old));
        assert.doesNotThrow(() => verifyFailedSetupRetirement(h.local, saved));
        assert.equal(await h.task({ run }).collect(), 1);
        assert.equal(queries, 2); assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1);
        return;
      } else {
        const serialized = (s) => `${JSON.stringify(s, null, 2)}\n`;
        const bytes = readFileSync(stage), proof = JSON.parse(bytes), restored = proof.restore ?? proof;
        if (mode === "withdrawal-other-attempt") restored.createIntentAt = at;
        if (mode === "withdrawal-other-session") restored.control.monitor.id = "e".repeat(32);
        if (mode === "withdrawal-other-host") restored.id = "124";
        if (["withdrawal-other-attempt", "withdrawal-other-session", "withdrawal-other-host"].includes(mode)) writeFileSync(stage, serialized(proof));
        if (mode === "withdrawal-other-bytes") appendFileSync(stage, " ");
        if (mode === "withdrawal-unbound") {
          unlinkSync(stage); stage = join(h.local, `state.json.delete-unsent-${"d".repeat(32)}.tmp`);
          writeFileSync(stage, serialized(restored));
        }
        if (mode === "withdrawal-later-intent") {
          writeFileSync(statePath, serialized({ ...intent, deletionIntentAt: new Date(Date.parse(intentAtJump) + 1).toISOString() }));
          // Even relabeling the old stage with the later intent's hash cannot rebind its contents.
          const relabeled = join(h.local, `state.json.delete-unsent-${digest(readFileSync(statePath))}.tmp`);
          fs.renameSync(stage, relabeled); stage = relabeled;
        }
        if (mode === "withdrawal-sent" || mode === "withdrawal-unknown") {
          // Complete the earlier withdrawal in the fixture, leaving its actual stale stage.
          // Then drive an independent fresh intent into a sent-or-unknown result, not an ack.
          writeFileSync(statePath, serialized(restored));
          h.flags.deleteUnconfirmed = true;
          const later = async (binary, args, ...rest) => {
            if (binary !== "doctl" || args[2] !== "delete") return run(binary, args, ...rest);
            if (mode === "withdrawal-unknown") throw new Error("synthetic dispatch outcome unknown");
            const result = await run(binary, args, ...rest); return { ...result, status: 1 };
          };
          await assert.rejects(h.task({ run: later }).collect(), /delete outcome uncertain|synthetic dispatch outcome unknown/);
          assert.equal(queries, 2); assert.equal(deletesSent(), mode === "withdrawal-sent" ? 1 : 0);
          assert.notEqual(h.saved().retirement.evidenceSha256, intent.retirement.evidenceSha256);
        }
      }
      const priorBytes = readFileSync(statePath), stageBytes = readFileSync(stage), beforeQueries = queries, beforeDeletes = deletesSent();
      await assert.rejects(h.task({ run }).collect(), /deletion not confirmed; outcome uncertain/);
      assert.equal(queries, beforeQueries); assert.equal(h.deletes, beforeDeletes); assert.equal(deletesSent(), beforeDeletes);
      assert.ok(readFileSync(statePath).equals(priorBytes)); assert.ok(readFileSync(stage).equals(stageBytes));
      if (!partial) return;
      h.hosts([]);
      assert.equal(await h.task({ run }).collect(), 1);
      const s = h.saved();
      assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
      assert.ok(s.destroyedAt); assert.equal(s.deletionIntentAt, intentAtJump);
      assert.ok(readFileSync(stage).equals(stageBytes));
      assert.doesNotThrow(() => verifyFailedSetupRetirement(h.local, s));
      return;
    }
    await assert.rejects(h.task({ run: production }).collect(), /DELETE was not dispatched; the next collect retires on a fresh proof$/);
    const saved = h.saved(), old = readFileSync(receipt), oldRecord = JSON.parse(old);
    assert.ok(jumped && intentAtJump); assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    // The positively unsent DELETE withdraws the intent: the receipt and its recorded digest stay.
    assert.equal(saved.status, "starting"); assert.equal(saved.retirement, undefined);
    assert.equal(saved.deletionIntentAt, undefined); assert.equal(saved.destroyedAt, undefined);
    assert.deepEqual(saved.pendingRetirement, { kind: "setup-failed", evidenceSha256: digest(old) }); assert.equal(existsSync(lock), false);
    assert.ok(!readdirSync(h.local).some((name) => /^state\.json\..*tmp$/.test(name)));
    // A restart keeps that receipt for archival and deletes once on its own fresh drain proof.
    assert.equal(await h.task({ run: production }).collect(), 1);
    const s = h.saved(), record = JSON.parse(readFileSync(receipt));
    assert.equal(queries, 2); assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1); assert.ok(s.destroyedAt);
    assert.ok(readFileSync(join(h.local, `failed-setup-host.interrupted-${digest(old)}.json`)).equals(old));
    assert.equal(s.retirement.evidenceSha256, digest(readFileSync(receipt))); assert.equal(s.pendingRetirement, undefined);
    assert.notEqual(record.startedAtMs, oldRecord.startedAtMs);
    assert.equal(record.observation.control.requests.length, s.control.ledger.length);
    assert.doesNotThrow(() => verifyFailedSetupRetirement(h.local, s));
    return;
  }
  if (mode === "delete-cancelled-after-intent") {
    // The real production dispatch: the controller is cancelled once the intent's own stage is
    // renamed over state.json, so the production checkpoint refuses before the provider and
    // reports the DELETE unsent. The withdrawal only records how the DELETE ended, so it still
    // runs under cancellation; nothing reaches the provider.
    let intentAtCancel, providerDeletes = 0;
    hookFs(t, {
      renameSync: (original) => (from, to) => {
        original(from, to);
        if (intentAtCancel === undefined && intentStage.test(basename(String(from))) && basename(String(to)) === "state.json") {
          intentAtCancel = h.saved().deletionIntentAt; h.flags.cancelled = true;
        }
      },
    });
    const production = productionDispatch({ processRun: run, interrupted: () => h.flags.cancelled,
      provider: () => (argv, ...rest) => { if (argv[2] === "delete") providerDeletes++; return run("doctl", argv, ...rest); } });
    await assert.rejects(h.task({ run: production }).collect(), /DELETE was not dispatched; the next collect retires on a fresh proof$/);
    const saved = h.saved(), old = readFileSync(receipt);
    assert.ok(intentAtCancel); assert.equal(queries, 1); assert.equal(providerDeletes, 0);
    assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    // The intent is withdrawn: the receipt and its recorded digest stay, with no intent.
    assert.equal(saved.status, "starting"); assert.equal(saved.retirement, undefined);
    assert.equal(saved.deletionIntentAt, undefined); assert.equal(saved.destroyedAt, undefined);
    assert.deepEqual(saved.pendingRetirement, { kind: "setup-failed", evidenceSha256: digest(old) }); assert.equal(existsSync(lock), false);
    assert.ok(!readdirSync(h.local).some((name) => /^state\.json\..*tmp$/.test(name)));
    // A restart, no longer cancelled, keeps that receipt for archival and deletes once on its own fresh proof.
    h.flags.cancelled = false; restoreFs(t);
    assert.equal(await h.task({ run: production }).collect(), 1);
    const s = h.saved();
    assert.equal(queries, 2); assert.equal(providerDeletes, 1); assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1); assert.ok(s.destroyedAt);
    assert.ok(readFileSync(join(h.local, `failed-setup-host.interrupted-${digest(old)}.json`)).equals(old));
    assert.equal(s.retirement.evidenceSha256, digest(readFileSync(receipt))); assert.equal(s.pendingRetirement, undefined);
    assert.doesNotThrow(() => verifyFailedSetupRetirement(h.local, s));
    return;
  }
  if (mode === "intent-save-torn" || mode === "destroyed-save-torn") {
    // The first state save that carries the key is torn: 80 bytes, then an error.
    const key = mode === "intent-save-torn" ? '"deletionIntentAt"' : '"destroyedAt"';
    const fds = new Set(); let torn;
    hookFs(t, {
      openSync: (original) => (path, flags, ...rest) => {
        const fd = original(path, flags, ...rest);
        if (!torn && flags === "wx" && /^state\.json\..*tmp$/.test(basename(String(path)))) fds.add(fd);
        return fd;
      },
      writeFileSync: (original) => (target, data, ...rest) => {
        if (!fds.has(target)) return original(target, data, ...rest);
        fds.delete(target);
        if (torn || !String(data).includes(key)) return original(target, data, ...rest);
        torn = true; fs.writeSync(target, Buffer.from(data).subarray(0, 80));
        throw new Error("injected torn write");
      },
    });
    await assert.rejects(h.task({ run }).collect(), /injected torn write/);
    const interrupted = h.saved();
    assert.ok(torn); assert.equal(queries, 1); assert.equal(existsSync(lock), false);
    // Neither save leaves the fixed-name stage every later ordinary save would refuse on.
    assert.equal(existsSync(join(h.local, "state.json.tmp")), false);
    const stages = readdirSync(h.local).filter((name) => /^state\.json\..*tmp$/.test(name));
    assert.equal(stages.length, 1); assert.match(stages[0], mode === "intent-save-torn" ? intentStage : destroyedStage);
    const tornBytes = readFileSync(join(h.local, stages[0]));
    assert.equal(tornBytes.length, 80);
    const old = readFileSync(receipt);
    if (mode === "intent-save-torn") {
      // The previous state stays: the receipt and its digest, with no intent and no DELETE.
      assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
      assert.equal(interrupted.status, "starting"); assert.equal(interrupted.deletionIntentAt, undefined); assert.equal(interrupted.retirement, undefined);
      assert.deepEqual(interrupted.pendingRetirement, { kind: "setup-failed", evidenceSha256: digest(old) });
    } else {
      // The one DELETE was sent; the intent stays without destroyedAt.
      assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1);
      assert.equal(interrupted.status, "retired"); assert.ok(interrupted.deletionIntentAt); assert.equal(interrupted.destroyedAt, undefined);
    }
    assert.equal(await h.task({ run }).collect(), 1);
    const s = h.saved();
    assert.ok(s.destroyedAt); assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1);
    if (mode === "intent-save-torn") {
      // A fresh drain proof, with the interrupted receipt kept for archival.
      assert.equal(queries, 2);
      assert.ok(readFileSync(join(h.local, `failed-setup-host.interrupted-${digest(old)}.json`)).equals(old));
      assert.equal(s.retirement.evidenceSha256, digest(readFileSync(receipt)));
    } else {
      // Absence only: the same receipt and intent, no second query or DELETE.
      assert.equal(queries, 1); assert.ok(readFileSync(receipt).equals(old));
      assert.equal(s.deletionIntentAt, interrupted.deletionIntentAt);
    }
    // The torn stage is never read or removed; it stays for the operator.
    assert.ok(readFileSync(join(h.local, stages[0])).equals(tornBytes));
    assert.doesNotThrow(() => verifyFailedSetupRetirement(h.local, s));
    return;
  }
  if (mode === "delete-expired" || mode === "delete-in-time") {
    // Only the provider preflight moves the clock: 61 seconds passes the proof's
    // 60-second deadline from the query's start, 20 seconds does not.
    const real = Date.now; t.mock.method(Date, "now", () => real() + offset);
    stall = mode === "delete-expired" ? 61000 : 20000;
    if (mode === "delete-in-time") {
      assert.equal(await h.task({ run }).collect(), 1);
      const record = JSON.parse(readFileSync(join(h.local, "failed-setup-host.json")));
      assert.equal(record.schema, "benchmark-failed-setup-retirement/v3"); assert.ok(stalled);
      assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1); assert.equal(deleteExpiry, record.startedAtMs + 60000);
      assert.ok(h.saved().destroyedAt); assert.equal(queries, 1);
      return;
    }
    await assert.rejects(h.task({ run }).collect(), /current retirement proof expired/);
    const saved = h.saved(), old = readFileSync(receipt), oldRecord = JSON.parse(old);
    assert.ok(stalled); assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    assert.equal(oldRecord.schema, "benchmark-failed-setup-retirement/v3");
    // The intent follows the preflight, so the expired proof leaves only its receipt and digest.
    assert.equal(saved.status, "starting"); assert.equal(saved.retirement, undefined);
    assert.equal(saved.deletionIntentAt, undefined); assert.equal(saved.destroyedAt, undefined);
    assert.deepEqual(saved.pendingRetirement, { kind: "setup-failed", evidenceSha256: digest(old) }); assert.equal(existsSync(lock), false);
    // A restart keeps that receipt for archival and deletes once on its own fresh proof.
    assert.equal(await h.task({ run }).collect(), 1);
    const s = h.saved(), record = JSON.parse(readFileSync(receipt));
    assert.equal(queries, 2); assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1); assert.ok(s.destroyedAt);
    assert.ok(readFileSync(join(h.local, `failed-setup-host.interrupted-${digest(old)}.json`)).equals(old));
    assert.equal(s.retirement.evidenceSha256, digest(readFileSync(receipt))); assert.equal(s.pendingRetirement, undefined);
    assert.notEqual(record.startedAtMs, oldRecord.startedAtMs); assert.equal(deleteExpiry, record.startedAtMs + 60000);
    assert.doesNotThrow(() => verifyFailedSetupRetirement(h.local, s));
    return;
  }
  if (mode.startsWith("receipt-expired")) {
    // The clock passes the proof's 60-second deadline once, just after its receipt is written
    // and before the intent, so the receipt stays without an intent.
    const real = Date.now;
    let jumped = false;
    t.mock.method(Date, "now", () => {
      if (!jumped && existsSync(receipt)) { jumped = true; offset += 61000; }
      return real() + offset;
    });
    await assert.rejects(h.task({ run }).collect(), /retirement proof expired before deletion/);
    const interrupted = h.saved(), old = readFileSync(receipt), oldRecord = JSON.parse(old);
    assert.ok(jumped); assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
    assert.equal(oldRecord.schema, "benchmark-failed-setup-retirement/v3"); assert.ok(old.length > 4096);
    assert.equal(interrupted.retirement, undefined); assert.equal(interrupted.deletionIntentAt, undefined); assert.equal(existsSync(lock), false);
    assert.equal(oldRecord.observation.control.requests.length, interrupted.control.ledger.length);
    // The digest was saved before the receipt was published, and stays until the retirement state.
    assert.deepEqual(interrupted.pendingRetirement, { kind: "setup-failed", evidenceSha256: digest(old) });
    const kept = join(h.local, `failed-setup-host.interrupted-${digest(old)}.json`);
    if (mode === "receipt-expired") {
      // A digest belongs only to a bound, unretired setup failure with its archive preserved.
      assert.deepEqual(controllerState(structuredClone(interrupted), "r21").pendingRetirement, interrupted.pendingRetirement);
      const variants = {
        retired: (s) => Object.assign(s, { status: "retired", retirement: { ...s.pendingRetirement }, deletionIntentAt: at }),
        "retired and destroyed": (s) => Object.assign(s, { status: "retired", retirement: { ...s.pendingRetirement }, deletionIntentAt: at, destroyedAt: at }),
        "no archive": (s) => { delete s.archiveSha256; delete s.evidenceSha256; delete s.evidence; },
        "no evidence tree": (s) => { delete s.evidence; },
        preparing: (s) => { s.status = "preparing"; delete s.preBootstrapTerminal; delete s.archiveSha256; delete s.evidenceSha256; delete s.evidence; },
      };
      for (const [name, change] of Object.entries(variants)) {
        const s = structuredClone(interrupted); change(s);
        assert.throws(() => controllerState(s, "r21"), /pending retirement (?:cannot coexist|requires)/, name);
      }
    }
    // As if an earlier recovery kept the history copy, then stopped before removing the receipt.
    if (mode === "receipt-expired-kept") writeFileSync(kept, old);
    if (mode === "receipt-expired-history-torn") {
      const torn = tearWrite(t, historyName);
      await assert.rejects(h.task({ run }).collect(), /injected torn write/);
      assert.ok(torn()); assert.equal(queries, 2); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
      assert.ok(readFileSync(receipt).equals(old)); assert.deepEqual(h.saved().pendingRetirement, interrupted.pendingRetirement);
      const historyPublished = existsSync(kept);
      assert.equal(await h.task({ run }).collect(), 1);
      assert.equal(historyPublished, false, "a torn history copy was published");
      const s = h.saved();
      assert.equal(queries, 3); assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1); assert.ok(s.destroyedAt);
      assert.ok(readFileSync(kept).equals(old)); assert.equal(s.retirement.evidenceSha256, digest(readFileSync(receipt)));
      assert.ok(!readdirSync(h.local).some((name) => name.endsWith(".stage")));
      assert.doesNotThrow(() => verifyFailedSetupRetirement(h.local, s));
      return;
    }
    if (mode === "receipt-expired-edited" || mode === "receipt-expired-unrecorded") {
      let edited = old.toString("utf8");
      if (mode === "receipt-expired-edited") {
        // Only the receipt's own start moves, by one second, still inside every window the
        // verifier checks, so only the digest recorded before the receipt was written can tell.
        oldRecord.startedAtMs -= 1000;
        edited = `${JSON.stringify(oldRecord, null, 2)}\n`; writeFileSync(receipt, edited);
      } else h.change((s) => { delete s.pendingRetirement; }); // As a controller that recorded no digest left it.
      await assert.rejects(h.task({ run }).collect(), mode === "receipt-expired-edited"
        ? /interrupted retirement receipt differs from its recorded digest; preserve host/
        : /interrupted retirement receipt has no recorded digest; preserve host/);
      assert.equal(queries, 2); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
      assert.equal(readFileSync(receipt, "utf8"), edited);
      assert.equal(existsSync(join(h.local, `failed-setup-host.interrupted-${digest(edited)}.json`)), false); assert.equal(existsSync(kept), false);
      assert.equal(h.saved().retirement, undefined); assert.equal(h.saved().deletionIntentAt, undefined);
      assert.deepEqual(h.saved().pendingRetirement, mode === "receipt-expired-edited" ? interrupted.pendingRetirement : undefined);
      return;
    }
    if (mode === "receipt-expired-rebound") {
      // The prefix comes from the receipt, so it must still bind the exact ledger rows it names.
      // Its digest is recorded too, so the prefix check, not the digest, is what refuses.
      oldRecord.observation.control.requests.pop();
      const rebound = `${JSON.stringify(oldRecord, null, 2)}\n`; writeFileSync(receipt, rebound);
      h.change((s) => { s.pendingRetirement.evidenceSha256 = digest(rebound); });
      await assert.rejects(h.task({ run }).collect(), (error) => error.code === "ERR_ASSERTION" && !/recorded digest/.test(error.message));
      assert.equal(queries, 2); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
      assert.equal(readFileSync(receipt, "utf8"), rebound); assert.equal(existsSync(join(h.local, `failed-setup-host.interrupted-${digest(rebound)}.json`)), false);
      assert.equal(h.saved().retirement, undefined); assert.equal(h.saved().deletionIntentAt, undefined);
      return;
    }
    assert.equal(await h.task({ run }).collect(), 1);
    const s = h.saved(), current = readFileSync(receipt), record = JSON.parse(current);
    assert.equal(queries, 2); assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1); assert.ok(s.destroyedAt);
    assert.ok(readFileSync(kept).equals(old)); assert.equal(s.retirement.evidenceSha256, digest(current));
    assert.equal(s.pendingRetirement, undefined);
    assert.equal(record.schema, "benchmark-failed-setup-retirement/v3"); assert.notEqual(record.startedAtMs, oldRecord.startedAtMs);
    // The fresh proof, not the kept one, is the final control and carries the DELETE's deadline.
    assert.equal(record.observation.control.requests.length, s.control.ledger.length);
    assert.ok(s.control.ledger.length > interrupted.control.ledger.length); assert.equal(deleteExpiry, record.startedAtMs + 60000);
    assert.doesNotThrow(() => verifyFailedSetupRetirement(h.local, s));
    return;
  }
  assert.equal(await h.task({ run }).collect(), 1);
  const s = h.saved(), record = JSON.parse(readFileSync(join(h.local, "failed-setup-host.json")));
  assert.equal(s.status, "retired"); assert.equal(s.retirement.kind, "setup-failed"); assert.ok(s.destroyedAt);
  assert.equal(s.pendingRetirement, undefined);
  assert.ok(atPublication.length > 0);
  for (const seen of atPublication) assert.deepEqual(seen, { kind: "setup-failed", evidenceSha256: s.retirement.evidenceSha256 }, "receipt published before its digest was saved");
  assert.equal(record.schema, "benchmark-failed-setup-retirement/v3"); assert.equal(record.observation.control.drained[0].id, failed.id);
  assert.equal(s.validation, undefined); assert.equal(s.collectedAt, undefined);
  // The original failure, archive and exit stay as they were; no receipt is filled in.
  const custody = join(h.local, s.evidence, "control");
  assert.deepEqual(readFileSync(join(custody, `watch-failure-${failed.id}.json`)), failed.bytes);
  assert.equal(existsSync(join(custody, `receipt-${failed.id}.json`)), false);
  assert.equal(readFileSync(join(h.local, s.evidence, "exit-code"), "utf8"), "1\n");
  assert.equal(queries, 1); assert.equal(h.deletes, 1); assert.equal(h.inspections, 0);
  assert.equal(await h.task({ run }).collect(), 1);
  assert.equal(queries, 1); assert.equal(h.deletes, 1); assert.equal(h.creates, 1); assert.equal(h.inspections, 0);

  // Fleet verification and continuation replay the persisted v3 receipt through the shared
  // verifier, which must select the same archived watcher failure the collect path did.
  verifyFailedSetupRetirement(h.local, s);
  const root = join(h.temp, "verification"), child = join(root, s.group), local = join(child, "groups-r21");
  mkdirSync(child, { recursive: true });
  writeFileSync(join(root, "fleet-r21.json"), JSON.stringify(fleet));
  cpSync(h.local, local, { recursive: true });
  const verify = () => verifyFleet({ root, round: "r21", commit }, { inspect: () => assert.fail("no native result") });
  let report = await verify();
  assert.equal(report.groups.find(({ group }) => group === s.group)?.outcome, "setup-failed-retired");
  assert.equal(report.publishableBaseline, false);
  const continuation = join(h.temp, "continuation");
  mkdirSync(continuation);
  writeFileSync(join(continuation, "index.json"), JSON.stringify([{ archives: {}, checkout: root, commit, root, round: "r21" }]));
  const admission = await continuationAdmission(continuation, s.group);
  const [retired] = admission.subject.setupRetirements;
  const dispatchRecheck = recheckSetupRetirement(continuation, retired, admission.subject.indexedCustody);
  admission.recheck(); dispatchRecheck();

  // The archive, not the receipt, selects the drain proof: an altered or removed archived failure
  // refuses even when the evidence tree hash, receipt and state are rebound around it.
  const failure = `watch-failure-${failed.id}.json`;
  const rebind = (at) => {
    const extracted = join(at, s.evidence), receipt = join(at, "failed-setup-host.json"), record = JSON.parse(readFileSync(receipt));
    const evidenceSha256 = treeHash(extracted), bytes = JSON.stringify({ ...record, evidenceSha256 });
    const rebound = { ...s, evidenceSha256, retirement: { ...s.retirement, evidenceSha256: digest(bytes) } };
    writeFileSync(receipt, bytes); writeFileSync(join(at, "state.json"), JSON.stringify(rebound));
    return rebound;
  };
  for (const change of ["altered", "removed"]) {
    const at = join(h.temp, `negative-${change}`), path = join(at, s.evidence, "control", failure);
    cpSync(h.local, at, { recursive: true });
    if (change === "altered") writeFileSync(path, '{"helperLine":1}\n'); else unlinkSync(path);
    const rebound = rebind(at);
    assert.throws(() => verifyFailedSetupRetirement(at, rebound),
      change === "altered" ? (e) => e instanceof SetupWatcherProofMissing && /not a drainage deadline expiry/.test(e.message) : undefined, change);
  }
  writeFileSync(join(local, s.evidence, "control", failure), '{"helperLine":1}\n');
  rebind(local);
  report = await verify();
  assert.equal(report.groups.find(({ group }) => group === s.group)?.error, "group-evidence-invalid");
});

test("failed pre-registration cleanup preserves the archive and stops on missing proof, including on restart", async (t) => {
  for (const mode of ["cancelled-proof", "invalid-proof", "refused", "lost-result", "archived-watcher", "archived-watcher-receipt",
    "archived-watcher-scope", "archived-watcher-cap"]) {
    const cancelled = mode === "cancelled-proof";
    const { h, options } = configured(t);
    h.flags.hook = (bin, a) => { if (bin === "ssh" && a.at(-1).startsWith("systemctl show") && h.units === 1) h.flags.active = false; };
    await assert.rejects(h.task({}, options).launch(), /ended before common bootstrap/);
    h.flags.hook = undefined;
    const entries = metadata(), first = h.saved().control.ledger[0].request.invocation.id, watcher = mode.startsWith("archived-watcher");
    // A failure outside the settled bootstrap ledger, or beside its own receipt, never selects the drain proof.
    if (mode === "archived-watcher") entries.push({ name: "control/" }, { name: `control/watch-failure-${"f".repeat(32)}.json`, body: '{"helperLine":342}\n' });
    if (mode === "archived-watcher-receipt") entries.push({ name: "control/" }, { name: `control/watch-failure-${first}.json`, body: '{"helperLine":342}\n' },
      { name: `control/receipt-${first}.json`, body: "{}\n" });
    // Only the deadline-expiry line selects the drain proof; any other watcher failure keeps refusing.
    const line = (text) => guardianSource.split("\n").findIndex((l) => l.includes(text)) + 1;
    if (mode === "archived-watcher-scope") entries.push({ name: "control/" },
      { name: `control/watch-failure-${first}.json`, body: `{"helperLine":${line('"unowned scope participant"')}}\n` });
    if (mode === "archived-watcher-cap") entries.push({ name: "control/" },
      { name: `control/watch-failure-${first}.json`, body: `{"helperLine":${line("assert len(samples) <= 4096 and rows_count <= 65536")}}\n` });
    const bytes = archive(entries); h.setArchive(bytes);
    let queries = 0;
    const run = (bin, args, timeout, allowFail, expiry, control) => {
      if (bin !== "ssh" || !args.at(-1).includes("<<'CORTEN_FAILED_SETUP_HOST'")) return h.run(bin, args, timeout, allowFail, expiry, control);
      queries++;
      const id = control.request.invocation.id, ack = `CORTEN_CONTROL ${id} ${"a".repeat(64)}\n`;
      const status = cancelled || mode === "invalid-proof" ? 0 : 1;
      if (cancelled && queries === 1) h.flags.cancelled = true;
      return shellTransport({ repo: h.repo, spawn: () => ({ status, stdout: '{"setupFailed":false}', stderr: ack
        + (mode === "lost-result" ? "" : `CORTEN_RESULT ${id} ${status}\n`) }) })(bin, args, timeout, allowFail, expiry, control);
    };
    const refusal = watcher ? "setup-watcher-proof-missing" : "setup-host-proof-refused";
    await assert.rejects(h.task({ run }).collect(), cancelled ? /cancelled/ : mode === "lost-result" ? /remote control completion uncertain/ : { controllerStage: refusal });
    const saved = h.saved(), last = saved.control.ledger.at(-1), lock = join(h.local, "operation.lock");
    const lockHeld = existsSync(lock);
    assert.equal(queries, watcher ? 0 : 1);
    if (!watcher) {
      assert.equal(last.localTerminal, mode !== "lost-result");
      assert.equal(last.code, cancelled || mode === "invalid-proof" ? 0 : mode === "refused" ? 1 : undefined);
      assert.equal(last.setupProofRejected, mode === "invalid-proof" ? true : undefined);
    }
    assert.equal(saved.archiveSha256, digest(bytes)); assert.ok(saved.evidenceSha256);
    assert.equal(saved.status, "starting"); assert.equal(saved.retirement, undefined); assert.equal(saved.deletionIntentAt, undefined);
    const calls = h.calls.length, count = queries;
    h.flags.cancelled = false;
    const restart = await h.task({ run }).collect().then(() => undefined, (error) => error);
    assert.equal(queries, count); assert.equal(h.calls.length, calls); assert.deepEqual(h.saved(), saved);
    if (cancelled) assert.equal(restart.code, "EEXIST");
    else if (mode === "lost-result") assert.match(restart.message, /ambiguous pre-bootstrap custody/);
    else assert.equal(restart.controllerStage, refusal);
    assert.equal(lockHeld, cancelled || mode === "lost-result"); assert.equal(existsSync(lock), lockHeld);
    assert.equal(h.deletes, 0); assert.equal(h.inspections, 0);
  }
});

// Only a watcher record that cannot select the drain proof is setup-watcher-proof-missing.
// A custody read failure keeps its own error (production reports controller-collect) and
// still stops before any query or deletion.
test("a failed pre-registration custody read is not reported as a missing watcher proof, including on restart", async (t) => {
  const { h, options } = configured(t);
  h.flags.hook = (bin, a) => { if (bin === "ssh" && a.at(-1).startsWith("systemctl show") && h.units === 1) h.flags.active = false; };
  await assert.rejects(h.task({}, options).launch(), /ended before common bootstrap/);
  h.flags.hook = undefined;
  const first = h.saved().control.ledger[0].request.invocation.id;
  // A folder where the failure record belongs: the archive is valid, but there is no record to read.
  h.setArchive(archive([...metadata(), { name: "control/" }, { name: `control/watch-failure-${first}.json/` }]));
  let queries = 0;
  const run = (bin, args, ...rest) => {
    if (bin === "ssh" && args.at(-1).includes("<<'CORTEN_FAILED_SETUP_HOST'")) queries++;
    return h.run(bin, args, ...rest);
  };
  const refused = async () => {
    const error = await h.task({ run }).collect().then(() => undefined, (e) => e);
    assert.match(error?.message, /bounded regular unlinked file required/);
    assert.equal(error.controllerStage, undefined); assert.equal(controllerFailure(error), undefined);
  };
  await refused();
  const saved = h.saved(), calls = h.calls.length;
  assert.ok(saved.archiveSha256 && saved.evidenceSha256); assert.equal(saved.retirement, undefined); assert.equal(saved.deletionIntentAt, undefined);
  await refused();
  assert.equal(queries, 0); assert.equal(h.calls.length, calls); assert.deepEqual(h.saved(), saved);
  assert.equal(h.deletes, 0); assert.equal(h.inspections, 0);
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
  await assert.rejects(h.task({ inspect: async () => narrowReport }).collect(), {
    message: "native campaign validation unavailable or invalid; evidence/host preserved",
    controllerStage: "collect-native-report-refused",
  });
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

test("native replay refusal preserves a sealed exit-1 grouped archive without qualifying or deleting", async (t) => {
  const { h, options } = configured(t); await h.task({}, options).launch();
  finishSupervisedFixture(h, "failed");
  h.setArchive(archive([...metadata().map((row) => row.name === "exit-code" ? { ...row, body: "1\n" } : row),
    { name: "campaign/" }, { name: "campaign/plan.json", body: "{}" }]));
  await assert.rejects(h.task({ inspect: async () => { throw new Error("PRIVATE_NATIVE_REPLAY"); } }).collect(), {
    message: "native campaign validation unavailable or invalid; evidence/host preserved",
    controllerStage: "collect-native-replay-refused",
  });
  const saved = h.saved();
  assert.ok(saved.archiveSha256 && saved.evidenceSha256);
  assert.equal(readFileSync(join(h.local, saved.evidence, "exit-code"), "ascii"), "1\n");
  assert.equal(saved.status, "running");
  assert.equal(saved.fullGroupQualified, false);
  assert.equal(saved.validation, undefined);
  assert.equal(saved.deletionIntentAt, undefined);
  assert.equal(h.deletes, 0);
});

test("first official group waits for the bound common bootstrap marker, not native qualification", async (t) => {
  const { h, options } = configured(t); h.flags.bootstrapPending = 1;
  const saved = await h.task({}, options).launch();
  assert.equal(saved.status, "running"); assert.ok(saved.bootstrapReady.sha256); assert.ok(saved.bootstrapReady.observedAt);
  assert.equal(saved.fullGroupQualified, false); assert.equal(h.creates, 1);
  assert.equal(h.calls.filter((c) => c[0] === "ssh" && c.at(-1).startsWith("if test ! -e /bench/bootstrap-ready.json")).length, 2);
});

const bootId = "12345678-90ab-cdef-1234-567890abcdef";
function offlineFixture(t, { lost = false, group = "localized-marketplace" } = {}) {
  const h = harness(t, { active: true }), values = input();
  values.provider = { accountId, context }; values.tokens = { [group]: values.tokens[group] };
  const fleet = contract.fleetPlan(values, at, "sfo3", { stagedPlacement: true,
    single: { group, indexSha256: "1".repeat(64), checkout: h.repo, offlineHandoff: true } });
  const path = join(h.temp, "offline-fleet.json");
  writeFileSync(path, JSON.stringify(fleet));
  let seals = 0;
  const run = (bin, args, timeout, allowed, expiry, registration) => {
    assert.ok(!registration?.stream, "no workstation lease may be registered");
    if (bin === "ssh" && args.at(-1) === bootstrapReadScript + "\ncat /proc/sys/kernel/random/boot_id")
      return { status: 0, stdout: `${JSON.stringify(bootstrapMarker(h.saved()))}\n${bootId}\n` };
    if (registration?.request?.seal) { seals++; if (lost) return { status: 255, stdout: "", stderr: "" }; }
    return h.run(bin, args, timeout, allowed, expiry, registration);
  };
  const options = { collect: undefined, detach: true, commit, sshKey: "42", accountId, context, group, fleet: path };
  const launch = () => h.task({ run, checkFleetAdmission: () => [] }, options).launch();
  return { h, run, group, launch, get seals() { return seals; } };
}

test("offline launch acknowledges a handoff, not a timed result; reconnection still requires exact terminal replay", async (t) => {
  const f = offlineFixture(t), { h, run, group } = f;
  const launched = await f.launch();
  assert.equal(f.seals, 1);
  assert.deepEqual(readdirSync(h.base).filter((name) => name.startsWith(".launch-host-key-")), []);
  assert.equal(launched.status, "running");
  assert.equal(launched.validation, undefined);
  assert.equal(launched.fullGroupQualified, false);
  assert.equal(launched.control.monitor, undefined);
  assert.deepEqual(launched.control.sealed, ["bootstrap"]);
  assert.equal(launched.bootstrapReady.bootId, bootId);
  assert.match(contract.bootstrapWorkspaceScript(launched), /SSH_CONNECTION/);
  assert.ok(remoteFiles(launched)["job.sh"].includes(contract.verifySshIngress));
  assert.match(remoteFiles(launched)[launched.unit], /ExecStopPost=-\/usr\/bin\/timeout -k 5 15 \/usr\/sbin\/nft delete table inet corten_bench_native\n/);
  assert.ok(!existsSync(join(h.local, "operation.lock")));
  const collect = (inspect) => h.task({ run, inspect }).collect();
  // A live audit/preparation wait cannot start a collection ledger or download.
  const rows = launched.control.ledger.length;
  assert.equal(await collect(() => assert.fail("a live unit has no terminal replay")), 3);
  assert.equal(h.saved().control.ledger.length, rows);
  assert.equal(h.deletes, 0);
  h.flags.active = false; h.flags.expired = true; // Reconnect after systemd discarded exit metadata.
  // Even the otherwise-valid shape of older native evidence cannot qualify.
  const legacy = { ...syntheticInspection("blocked"), schema: "benchmark-isolated-group-campaign-inspection/v1",
    selection: launched.selection, groups: [] };
  await assert.rejects(collect(async () => legacy), /native campaign validation unavailable or invalid/);
  assert.ok(h.saved().archiveSha256 && h.saved().evidenceSha256); assert.equal(h.deletes, 0);
  assert.ok(h.calls.some((c) => c[0] === "ssh" && c.at(-1).includes(bootId) && c.at(-1).includes("CORTEN_IDLE")));
  // Synthetic replay seam tests only custody dispatch, never the native verifier.
  const patched = { ...legacy, offlineIngress: [{ group, phase: "timing", packets: 2, bytes: 120 }],
    offlineTerminal: { hostname: launched.name, bootId, token: launched.token,
    bootstrapSealSha256: digest(JSON.stringify(launched.control.ledger.at(-1).request.seal)) } };
  assert.equal(launched.group, group);
  h.flags.busyHost = true;
  await assert.rejects(collect(async () => patched), /terminal archive or idle-host proof unavailable/);
  assert.equal(h.deletes, 0);
  h.flags.busyHost = false;
  assert.equal(await collect(async () => patched), 1);
  assert.equal(h.deletes, 1); assert.ok(h.saved().destroyedAt);
  assert.equal(h.saved().fullGroupQualified, false);
});

test("offline code 2 audit expiry permits only bounded exact-host cleanup with sealed failure evidence", async (t) => {
  const { h, run, launch, group } = offlineFixture(t, { group: "mixed-production" });
  const launched = await launch();
  h.setArchive(archive([...metadata().map((entry) => entry.name === "exit-code" ? { ...entry, body: "2\n" } : entry),
    { name: "campaign/" }, { name: "campaign/fake.json", body: "{}" }]));
  const report = { ...syntheticInspection("blocked"), schema: "benchmark-isolated-group-campaign-inspection/v1",
    blockers: ["independent audit expired before timing"], selection: launched.selection, groups: [], offlineIngress: [],
    offlineAuditExpired: { group, subjectSha256: subject },
    offlineTerminal: { hostname: launched.name, bootId, token: launched.token,
      bootstrapSealSha256: digest(JSON.stringify(launched.control.ledger.at(-1).request.seal)) } };
  const collect = (result) => h.task({ run, inspect: async () => result }).collect();
  assert.equal(await collect(report), 3);
  assert.equal(h.deletes, 0);
  assert.equal(h.saved().archiveSha256, undefined, "running host was not read or deleted");
  h.flags.active = false; h.flags.expired = true;
  for (const tamper of [
    (r) => { delete r.offlineAuditExpired; },
    (r) => { r.offlineTerminal.bootId = "f".repeat(36); },
    (r) => { r.collectionIntegrity = "unsealed-partial"; },
    (r) => { r.status = "verified"; },
  ]) {
    const wrong = structuredClone(report); tamper(wrong);
    await assert.rejects(collect(wrong), /native campaign validation unavailable or invalid/);
    assert.equal(h.deletes, 0);
    assert.equal(h.saved().deletionIntentAt, undefined);
  }
  h.flags.hook = (bin, args) => {
    if (bin === "ssh" && args.at(-1).includes("CORTEN_IDLE") && args.at(-1).includes("\nsystemctl show")) h.flags.active = true;
  };
  await assert.rejects(collect(report), /idle archive or terminal unit changed/);
  assert.equal(h.deletes, 0); assert.equal(h.saved().deletionIntentAt, undefined);
  h.flags.hook = undefined; h.flags.active = false;
  assert.equal(await collect(report), 1);
  assert.equal(h.deletes, 1);
  const saved = h.saved();
  assert.ok(saved.archiveSha256 && saved.evidenceSha256 && saved.destroyedAt);
  assert.equal(saved.exitCode, 2); assert.equal(saved.validation.status, "blocked"); assert.equal(saved.fullGroupQualified, false);
  assert.ok(h.calls.some((c) => c[0] === "ssh" && c.at(-1).includes(bootId) && c.at(-1).includes("populated 0")));
});

test("a lost offline final acknowledgement never authorizes another launch or collection", async (t) => {
  const f = offlineFixture(t, { lost: true }), { h } = f;
  await assert.rejects(f.launch(), (error) => error.controlTreeUncertain === true);
  assert.equal(f.seals, 1); assert.equal(h.creates, 1); assert.equal(h.deletes, 0);
  const snapshots = readdirSync(h.base).filter((name) => name.startsWith(".launch-host-key-"));
  assert.equal(snapshots.length, 1);
  assert.deepEqual(readFileSync(join(h.base, snapshots[0], "known_hosts")), readFileSync(join(h.local, "known_hosts")));
  assert.deepEqual(h.saved().control.sealed, []);
  assert.ok(existsSync(join(h.local, "operation.lock")));
  assert.ok(existsSync(join(h.base, ".groups-launch.lock")));
  await assert.rejects(h.task().collect(), { code: "EEXIST" });
  await assert.rejects(f.launch());
  assert.equal(h.creates, 1);
});

test("pre-create census cannot overlap an offline handoff with another benchmark host", async (t) => {
  const f = offlineFixture(t), { h } = f;
  const peer = plan(), row = peer.jobs.find(({ group }) => group === "json-api");
  h.hosts([{ ...droplet(row, 999), ip: "192.0.2.99" }]);
  await assert.rejects(f.launch(), /foreign benchmark host blocks fleet launch/);
  assert.equal(h.creates, 0);
  assert.equal(h.saved().createIntentAt, undefined);
  const offline = h.saved().fleet;
  assert.throws(() => contract.assertFleetCensus([], offline, undefined, [state(peer, row.group)]), /requires no live peer/);
  assert.throws(() => contract.assertFleetCensus([], peer, undefined, [state(offline, f.group)]), /cannot authorize a parallel host/);
});

for (const group of ["json-api", "mixed-production"]) {
  test("offline audit uses an independently approved, separately sealed delivery: " + group, async (t) => {
    const f = offlineFixture(t, { group }), { h, run } = f;
    await f.launch();
    const path = join(h.temp, "review.json"), bytes = JSON.stringify(syntheticDelivery(group));
    writeFileSync(path, bytes);
    const before = digest(readFileSync(h.statePath));
    const options = { collect: undefined, deliverAudit: path, auditGroup: group, campaign, approveSubject: subject };
    await assert.rejects(h.task({ run, authorizeAudit: async () => ({ reservationSha256: before, deliverySha256: "0".repeat(64) }) }, options)
      .deliverAudit(), /locked audit delivery changed/);
    assert.equal(h.saved().auditIntents, undefined);
    const approved = h.task({ run, authorizeAudit: async () => ({ reservationSha256: before, deliverySha256: digest(bytes) }) }, options);
    assert.equal(await approved.deliverAudit(), 3);
    const saved = h.saved(), epoch = "audit-" + group;
    assert.deepEqual(saved.control.sealed, ["bootstrap", epoch]);
    assert.ok(saved.control.ledger.filter(({ request }) => request.epoch === epoch).some(({ request }) => request.invocation.channel === "sftp"));
    assert.equal(saved.auditIntents[group].sha256, digest(bytes));
    assert.equal(saved.validation, undefined);
    assert.equal(f.seals, 2);
    assert.equal(h.deletes, 0);
  });
}

test("dedicated startup starts once, then leaves the host's idle check free of root SSH", async (t) => {
  for (const mode of ["quiet", "busy", "cancelled-before-start", "cancelled-after-start", "install-failed"]) {
    const h = harness(t, { active: true }), group = "recoverable-live";
    const values = input(); values.provider = { accountId, context }; values.tokens = { [group]: values.tokens[group] };
    const fleet = join(h.temp, "fleet.json");
    writeFileSync(fleet, JSON.stringify(contract.fleetPlan(values, at, "sfo3", {
      stagedPlacement: true, single: { group, indexSha256: "1".repeat(64), checkout: h.repo },
    })));
    const options = { collect: undefined, detach: true, commit, sshKey: "42", accountId, context, group, fleet };
    const installSent = Promise.withResolvers(), ack = Promise.withResolvers();
    const startSent = Promise.withResolvers(), startAck = Promise.withResolvers();
    let installed = false, started = false, elapsed = 0;
    const run = async (binary, args, ...rest) => {
      if (binary === "ssh" || binary === "scp") {
        const script = args.at(-1);
        if (binary === "ssh" && script.includes("90-corten-benchmark.conf")) {
          assert.ok(script.endsWith("systemctl daemon-reload"));
          installSent.resolve();
          await ack.promise;
          const result = h.run(binary, args, ...rest);
          if (mode === "install-failed") return { ...result, status: 1 };
          installed = true;
          if (mode === "cancelled-before-start") h.flags.cancelled = true;
          return result;
        }
        if (binary === "ssh" && script.startsWith("systemctl start")) {
          assert.ok(installed, "unit started before policy installation acknowledged");
          assert.equal(started, false, "unit start retried");
          assert.equal(elapsed, 0, "fresh root login opened at the end of the drain");
          started = true;
          assert.equal(h.saved().quietBootstrap, "prelogin");
          assert.match(readFileSync(join(h.local, "job.sh"), "utf8"), /^bootstrap_stage=root-manager-drain$/m);
          if (mode === "quiet") { startSent.resolve(); await startAck.promise; }
          if (mode === "busy") h.flags.active = false;
        } else if (installed) {
          assert.ok(started && elapsed >= 135_000, "controller observed startup during the host's drain or idle check");
        }
      }
      return h.run(binary, args, ...rest);
    };
    const task = h.task({ run, checkFleetAdmission: () => [], sleep: async (ms) => {
      assert.equal(ms, 1000);
      assert.ok(installed && started);
      assert.equal(h.saved().status, "starting");
      assert.equal(h.saved().control.ledger.at(-1).localTerminal, true);
      elapsed += ms;
      if (mode === "cancelled-after-start") h.flags.cancelled = true;
    } }, options);
    const launch = task.launch();
    try {
      await Promise.race([installSent.promise, launch]);
      assert.equal(elapsed, 0, "quiet clock started before the remote install acknowledged");
      assert.equal(started, false);
    } finally { ack.resolve(); }
    if (mode === "quiet") {
      try {
        await Promise.race([startSent.promise, launch]);
        assert.equal(elapsed, 0);
        assert.equal(h.saved().control.ledger.at(-1).localTerminal, false, "start still in flight");
      } finally { startAck.resolve(); }
      await launch;
      assert.ok(h.saved().bootstrapReady);
      assert.equal(h.saved().control.monitor.phase, "closed");
      assert.match(h.saved().control.monitor.registrationSha256, /^[a-f0-9]{64}$/);
      assert.deepEqual(h.saved().control.sealed, ["bootstrap"]);
    } else {
      await assert.rejects(launch, { busy: /ended before running admission/, "cancelled-before-start": /controller cancelled/,
        "cancelled-after-start": /controller cancelled/, "install-failed": /control process failed/ }[mode]);
      assert.equal(h.saved().bootstrapReady, undefined);
      assert.equal(h.saved().control.monitor.phase, "pending");
      assert.equal(!!h.saved().preBootstrapTerminal, mode === "busy");
      if (mode === "cancelled-after-start") assert.equal(h.saved().status, "starting");
    }
    assert.equal(started, ["quiet", "busy", "cancelled-after-start"].includes(mode));
    if (!started) {
      assert.equal(h.saved().status, "preparing");
      assert.equal(elapsed, 0);
    }
    assert.equal(h.creates, 1);
    assert.equal(h.deletes, 0);
  }
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

// An invalid-monitor recovery collect holds stream-recovery.lock and never takes the
// crashed launcher's operation.lock. Its failed-setup retirement (a v2 receipt, from the
// real guardian in the in-memory kernel) is held to the lock it actually holds.
for (const mode of ["retired", "lock-replaced", "lock-replaced-at-read"]) test({
  retired: "an invalid-monitor recovery collect retires a failed setup under its stream-recovery lock with one DELETE",
  "lock-replaced": "a stream-recovery lock replaced before a failed-setup retirement refuses with no receipt, intent or DELETE",
  "lock-replaced-at-read": "a stream-recovery lock replaced during the retirement's exact host read refuses with no digest, receipt, intent or DELETE",
}[mode], async (t) => {
  const h = harness(t, { active: true, monitorHold: true });
  const kernel = spawn(process.platform === "win32" ? "python" : "python3",
    ["-I", fileURLToPath(new URL("./test-fixtures/control-session-kernel.py", import.meta.url)), "setup-fleet"],
    { timeout: 25000, killSignal: "SIGKILL", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: kernel.stdout })[Symbol.asyncIterator]();
  let stderr = ""; kernel.stderr.on("data", (part) => { stderr = (stderr + part).slice(-4096); });
  const closed = new Promise((resolve) => { kernel.on("error", (e) => resolve(String(e))); kernel.on("close", resolve); });
  t.after(async () => { kernel.stdin.end(); assert.equal(await closed, 0, stderr); });
  const recovery = join(h.local, "stream-recovery.lock");
  let token, replaced, queries = 0;
  const run = async (binary, args, timeout, allowFail, expiry, control) => {
    if (!control?.request) {
      // The first exact host read after the setup query is the retirement's own ownership read.
      if (mode === "lock-replaced-at-read" && !replaced && queries === 1 && binary === "doctl"
        && args[0] === "compute" && args[1] === "droplet" && args[2] === "get" && !existsSync(join(h.local, "failed-setup-host.json"))) {
        const bytes = readFileSync(recovery); unlinkSync(recovery); writeFileSync(recovery, bytes, { flag: "wx" }); replaced = bytes;
      }
      const result = await h.run(binary, args, timeout, allowFail, expiry, control);
      // The monitor registers, then the bootstrap seal's exact host read fails before its
      // request enters the ledger: the monitor ends invalid with no seal.
      if (result.monitor) h.flags.listError = true;
      return result;
    }
    const s = h.saved(), script = args.at(-1), request = control.request;
    // The launch chooses the reservation token; the guardian is bound to it on its first request.
    if (token === undefined) {
      token = s.token;
      kernel.stdin.write(JSON.stringify({ mode: "setup-fleet", token, source: guardianSource }) + "\n");
    }
    const pack = script === "timeout 600 /bin/bash /bench/pack.sh";
    const query = script.includes("<<'CORTEN_FAILED_SETUP_HOST'");
    if (query) {
      queries++;
      if (mode === "lock-replaced") {
        const bytes = readFileSync(recovery); unlinkSync(recovery); writeFileSync(recovery, bytes, { flag: "wx" }); replaced = bytes;
      }
    }
    const expected = query && { sequence: request.sequence, requests: s.control.ledger.slice(0, -1).map((r) => r.request),
      binding: { round: s.round, commit, token, helperSha256: guardianSha256 },
      queryArgv: ["/usr/bin/python3", "-", s.id, s.unit, JSON.stringify(Object.fromEntries(Object.entries(remoteFiles(s)).map(([k, v]) => [k, digest(v)]))), "1"] };
    const result = query ? null : await h.run(binary, args, timeout, allowFail);
    kernel.stdin.write(JSON.stringify({ request, payload: binary === "ssh" ? `set -euo pipefail\n${script}\n` : "synthetic SFTP",
      pack, code: result?.status ?? 0, ...(query ? { expected } : {}) }) + "\n");
    const line = await lines.next(); assert.equal(line.done, false, stderr);
    const reply = JSON.parse(line.value);
    if (pack) h.setArchive(archive([...metadata(), { name: "control/" },
      ...Object.entries(reply.custody).map(([k, v]) => ({ name: "control/" + k, body: Buffer.from(v, "hex") }))]));
    if (query) return { status: 0, stdout: JSON.stringify({ schema: "benchmark-failed-setup-host/v2", hostId: s.id, unit: s.unit,
      setupFailed: true, exitCode: 1, observedAtMs: Date.now(), control: reply.proof }) };
    return result;
  };
  await assert.rejects(h.launch({ run }).launch(), /bootstrap seal failed after monitor registration/);
  h.flags.listError = false; h.flags.active = false;
  const launched = h.saved();
  assert.equal(launched.control.monitor.phase, "invalid"); assert.deepEqual(launched.control.sealed, []);
  assert.ok(launched.control.ledger.every((row) => row.localTerminal && !row.request.seal));
  assert.equal(launched.preBootstrapTerminal, undefined); assert.equal(h.deletes, 0);
  // The launcher has exited and left both of its locks; its lease has expired.
  const operation = join(h.local, "operation.lock"), launch = join(h.base, ".groups-launch.lock");
  writeFileSync(operation, JSON.stringify({ ...JSON.parse(readFileSync(operation)), pid: 2147483647 }));
  writeFileSync(launch, JSON.stringify({ ...JSON.parse(readFileSync(launch)), pid: 2147483647 }));
  const operationBytes = readFileSync(operation);
  const closure = join(h.local, "monitor-local-closed.json"), close = JSON.parse(readFileSync(closure));
  close.closedAtMs = Date.now() - 30001; close.recoverAfterMs = close.closedAtMs + 30000;
  writeFileSync(closure, JSON.stringify(close));
  const deletesSent = () => h.calls.filter(([binary, ...args]) => binary === "doctl" && args[2] === "delete").length;
  const task = h.task({ run, inspect: async () => { throw new Error("no native campaign began"); } });
  if (mode === "retired") {
    assert.equal(await task.collect(), 1);
    const s = h.saved();
    assert.equal(s.status, "retired"); assert.equal(s.retirement.kind, "setup-failed"); assert.ok(s.deletionIntentAt && s.destroyedAt);
    assert.equal(s.pendingRetirement, undefined); assert.equal(s.validation, undefined); assert.equal(s.collectedAt, undefined);
    assert.equal(JSON.parse(readFileSync(join(h.local, "failed-setup-host.json"))).schema, "benchmark-failed-setup-retirement/v2");
    assert.equal(queries, 1); assert.equal(h.deletes, 1); assert.equal(deletesSent(), 1);
    // The recovery released only its own lock; the original custody stays for the operator.
    assert.ok(!existsSync(recovery)); assert.ok(readFileSync(operation).equals(operationBytes)); assert.ok(existsSync(launch));
    return;
  }
  await assert.rejects(task.collect(), (error) => /stream-recovery\.lock was replaced during this operation/.test(error.message)
    && /stream-recovery\.lock changed; preserve custody/.test(error.cause?.message));
  const s = h.saved();
  assert.ok(replaced); assert.equal(queries, 1); assert.equal(h.deletes, 0); assert.equal(deletesSent(), 0);
  assert.equal(s.status, "running"); assert.equal(s.deletionIntentAt, undefined); assert.equal(s.retirement, undefined);
  assert.equal(s.pendingRetirement, undefined); assert.ok(!existsSync(join(h.local, "failed-setup-host.json")));
  assert.ok(readFileSync(recovery).equals(replaced), "the replacement lock is kept for its owner");
  assert.ok(readFileSync(operation).equals(operationBytes));
});
