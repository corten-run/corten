import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as contract from "./cloud-contract.mjs";
import { host as catalogHost } from "../catalog/droplet-contract.mjs";
import { groupNames, selectedApps } from "./registry.mjs";
import { accountId, archive, campaign, commit, context, harness, metadata, subject, syntheticDelivery, syntheticInspection, syntheticPlacement } from "./cloud-fixtures.mjs";
import { campaignOutcome, controllerState, parseDropletArgs } from "./cloud-options.mjs";
import { bootstrapMarker, bootstrapReadScript, remoteFiles } from "./cloud-remote.mjs";
import { digest } from "./cloud-local.mjs";
import { guardianSource, guardianSha256 } from "./cloud-control-runtime.mjs";
import { shellTransport } from "./cloud-transport.mjs";

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

test("failed pre-registration cleanup preserves the archive and stops on missing proof, including on restart", async (t) => {
  for (const mode of ["cancelled-proof", "invalid-proof", "refused", "lost-result", "archived-watcher"]) {
    const cancelled = mode === "cancelled-proof";
    const { h, options } = configured(t);
    h.flags.hook = (bin, a) => { if (bin === "ssh" && a.at(-1).startsWith("systemctl show") && h.units === 1) h.flags.active = false; };
    await assert.rejects(h.task({}, options).launch(), /ended before common bootstrap/);
    h.flags.hook = undefined;
    const entries = metadata(), first = h.saved().control.ledger[0].request.invocation.id;
    if (mode === "archived-watcher") entries.push({ name: "control/" }, { name: `control/watch-failure-${first}.json`, body: '{"helperLine":342}\n' });
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
    const refusal = mode === "archived-watcher" ? "setup-watcher-proof-missing" : "setup-host-proof-refused";
    await assert.rejects(h.task({ run }).collect(), cancelled ? /cancelled/ : mode === "lost-result" ? /remote control completion uncertain/ : { controllerStage: refusal });
    const saved = h.saved(), last = saved.control.ledger.at(-1), lock = join(h.local, "operation.lock");
    const lockHeld = existsSync(lock);
    assert.equal(queries, mode === "archived-watcher" ? 0 : 1);
    if (mode !== "archived-watcher") {
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
