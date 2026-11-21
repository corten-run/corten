import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { accountId, archive, commit, context, harness, metadata } from "./cloud-fixtures.mjs";
import { fleetPlan, reservation, tags } from "./cloud-contract.mjs";
import { controlRequest, guardianSha256 } from "./cloud-control-runtime.mjs";
import { digest, treeHash } from "./cloud-local.mjs";
import { verifyFailedNativeRetirement } from "./cloud-retirement.mjs";
import { deploymentSha256 } from "./deployments.mjs";
import { readFleet, readGroup, verifyFleet } from "./fleet-verify.mjs";
import { registration } from "./test-fixtures/control-stream-fixture.mjs";
import { streamLimits } from "./isolated/control-stream.mjs";

const round = "r37", campaign = "r37-0123456789abcdef";
const retiredPid = 2147483647;
const retainedOperation = JSON.stringify({ pid: retiredPid, at: "2026-11-21T00:00:00.000Z" });
const retainedLaunch = JSON.stringify({ pid: retiredPid, round });
const establishedKey = "synthetic established host key\n";
const canonical = (value) => JSON.stringify(value, (_, v) => v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);

function fixture(t, group, flags = {}) {
  const json = group === "json-api", phase = json ? "closed" : "invalid";
  const h = harness(t, { ...flags, round, ...(flags.fleetLayout ? { fleetGroup: group } : {}) });
  if (flags.fleetLayout) mkdirSync(h.base);
  h.seed();
  const root = dirname(h.base);
  const region = json ? "blr1" : "sfo3";
  const child = fleetPlan({ round, commit, token: "a".repeat(16), sshKey: "42", provider: { accountId, context },
    tokens: Object.fromEntries(h.saved().selection.groups.map(({ group }, index) => [group, String(index).padStart(16, "0")])) },
  "2026-11-21T00:00:00.000Z", "sfo3", { stagedPlacement: !flags.fleetLayout });
  if (flags.fleetLayout) writeFileSync(join(root, `fleet-${round}.json`), JSON.stringify(child));
  const token = child.jobs.find((j) => j.group === group).token;
  const saved = { ...h.saved(), ...reservation({ round, commit, token, group, fleet: child,
    ...(!flags.fleetLayout ? { remainingPlacement: { region, intentSha256: "a".repeat(64) } } : {}) }), provider: child.provider, status: "running",
    ...(!flags.legacyKey ? { launchHostKeySha256: digest(establishedKey) } : {}) };
  const binding = { round, commit, token, helperSha256: guardianSha256 };
  const reg = { ...structuredClone(registration), binding, host: { ...registration.host, hostname: saved.name } };
  const boot = { schema: "benchmark-control-ledger/v1", helperSha256: guardianSha256, ledger: [], sealed: ["bootstrap"] };
  saved.control = { ...boot, monitor: { schema: "benchmark-supervised-control/v1", phase, id: reg.id,
    registrationSha256: digest(JSON.stringify(reg)) } };
  const intent = controlRequest(saved, "ssh", [`root@${saved.ip}`, `systemctl start ${saved.unit}`], 60000, "bootstrap");
  saved.control.ledger.push({ request: intent, localTerminal: true, code: 0 });
  const sealControl = controlRequest(saved, "ssh", [`root@${saved.ip}`, ":"], 60000, "bootstrap", [intent.invocation]);
  saved.control.ledger.push({ request: sealControl, localTerminal: true, code: 0 });
  h.change((s) => Object.assign(s, saved));
  h.hosts([{ ...h.host(), name: saved.name, tags: [...tags, saved.tag], region: { slug: saved.host.region } }]);
  const put = (name, value) => writeFileSync(join(h.local, name), JSON.stringify(value));
  put("monitor-registration.json", reg);
  const closedAtMs = Date.now() - 2 * streamLimits.leaseMs - 1000;
  put("monitor-local-closed.json", { binding, id: reg.id, code: json ? 0 : 255, signal: null, remoteDrained: false,
    closedAtMs, recoverAfterMs: closedAtMs + 2 * streamLimits.leaseMs });
  put(json ? "monitor-terminal.json" : "monitor-invalid.json", { binding, id: reg.id, ...(json
    ? { localClosed: true, remoteDrained: false, nativeTerminal: true, campaign, sealSha256: digest("synthetic seal") }
    : { publicationRevoked: true, remoteTerminal: false }) });
  if (!json) {
    writeFileSync(join(h.local, "operation.lock"), retainedOperation);
    writeFileSync(join(h.base, ".groups-launch.lock"), flags.foreignLock ? "{}" : retainedLaunch);
  }
  const sibling = join(h.base, "sibling.lock"); writeFileSync(sibling, "sibling stays locked");
  writeFileSync(join(h.local, "known_hosts"), flags.replaceKey ? "synthetic replacement\n" : establishedKey);

  const mainRoot = json ? "bench/json-api/results/j75" : "bench/fullstack-browser/work/w37";
  const outputRoots = json ? ["bench/json-api/results/j74", mainRoot] : [mainRoot];
  const plan = { schema: "benchmark-isolated-group-campaign/v1", round, commit, order: [group],
    bindings: [{ campaignMode: json ? "dedicated-blr1" : "dedicated", request: { group, round: json ? "j75" : "w37", commit },
      validation: { artifactRoot: mainRoot } }] };
  plan.campaignSha256 = deploymentSha256(plan);
  const attempt = { schema: "benchmark-isolated-campaign-reservation/v1", id: campaign, commit, campaignSha256: plan.campaignSha256 };
  const status = { schema: "benchmark-isolated-campaign-status/v1", state: json ? "finished" : "preserved-uncertain", round,
    campaign, campaignSha256: plan.campaignSha256, controllerReady: false, isolation: "unverified", executionVersion: 5,
    outcomes: [{ group, outcome: flags.lateSealFailure ? "native-validated" : json ? "failed" : "preserved-uncertain" }],
    uncollectedNativeRoots: json || flags.lateSealFailure ? [] : [{ group, phase: "timing", artifactRoot: flags.foreignPath ?? mainRoot }] };
  const entries = [{ name: "campaign/" }, { name: "campaign/.host-attempt.json", body: JSON.stringify(attempt) },
    { name: `campaign/${campaign}/` }, { name: `campaign/${campaign}/plan.json`, body: JSON.stringify(plan) },
    { name: `campaign/${campaign}/campaign-result.json`, body: JSON.stringify({ status, wholeHostTerminal: "parent-must-observe", deletionAuthorized: false }) },
    ...(json ? [{ name: `campaign/${campaign}/control-stream-seal.json`, body: "synthetic seal" }] : [])];
  const wrapperFiles = metadata().map((e) => e.name === "exit-code" ? { ...e, body: "2\n" } : e);
  const wrapper = archive([...wrapperFiles, ...entries]); h.setArchive(wrapper);
  const copy = join(h.temp, "fixture-copy");
  for (const { name, body } of entries) {
    if (name.endsWith("/")) mkdirSync(join(copy, name), { recursive: true });
    else writeFileSync(join(copy, name), body);
  }
  const native = join(copy, "native"); mkdirSync(native);
  const nativePayload = "preserved raw failure output\n";
  writeFileSync(join(native, "failure.txt"), nativePayload);
  const roots = [{ path: "/bench/campaign", present: true, treeSha256: treeHash(join(copy, "campaign")), nodes: entries.length, bytes: 100 },
    ...outputRoots.map((name, index) => index ? { path: `/bench/repo/${name}`, present: false }
      : { path: `/bench/repo/${name}`, present: true, treeSha256: treeHash(native), nodes: 2, bytes: nativePayload.length }),
    ...[...wrapperFiles, { name: "results.tgz", body: wrapper }].map(({ name, body }) => {
      const bytes = Buffer.from(body);
      return { path: `/bench/${name}`, present: true, nodes: 1, bytes: bytes.length,
        treeSha256: digest(Buffer.concat([Buffer.from(`f\0\0${bytes.length}\0`), bytes])) };
    })];
  const meta = "[]", metadataSha256 = digest(meta), snapshot = canonical({ roots, metadataSha256 });
  const custody = archive([...wrapperFiles, { name: "campaign/" }, { name: "campaign/custody-metadata.json", body: meta },
    { name: "campaign/custody-files.json", body: "{}" }, { name: "campaign/custody-snapshot.json", body: snapshot },
    ...entries.map((e) => ({ ...e, name: e.name.replace(/^campaign/, "campaign/root-0") })),
    { name: "campaign/root-1/" }, { name: "campaign/root-1/failure.txt", body: nativePayload }]);
  let probes = 0, custodyDownloads = 0, deleteExpiry;
  const run = (binary, args, ...rest) => {
    const script = args.at(-1);
    if (binary === "ssh" && script.includes("pack.sh") && !script.includes("CORTEN_FAILED_NATIVE_HOST")) {
      assert.equal(phase, "closed", "an invalid monitor must never repack the wrapper");
      assert.ok(script.includes("grep -qx '[01]'"), "absent raw-2 wrappers must not be synthesized");
    }
    if (binary === "ssh" && script.includes("CORTEN_FAILED_NATIVE_HOST")) {
      probes++;
      assert.ok(args.includes("StrictHostKeyChecking=yes"));
      assert.ok(outputRoots.every((root) => script.includes(`/bench/repo/${root}`)));
      assert.ok(script.includes(reg.host.bootId));
      if (flags.busyFence && probes === 3) return { status: 1, stdout: "" };
      return { status: 0, stdout: JSON.stringify({ schema: "benchmark-failed-native-host/v1", custody: true,
        historicalAccountingQualified: false, hostId: saved.id, unit: saved.unit, roots, metadataSha256,
        snapshotSha256: digest(snapshot), archiveSha256: digest(custody), observedAtMs: Date.now() }) };
    }
    if (binary === "scp" && args.at(-2).endsWith(":/bench/failed-native-custody.tgz")) {
      custodyDownloads++;
      writeFileSync(script, flags.corruptCustody ? "bad download" : custody);
      return { status: 0, stdout: "" };
    }
    if (binary === "doctl" && args[2] === "delete") deleteExpiry = rest[2];
    return h.run(binary, args, ...rest);
  };
  return { h, root, sibling, wrapper, custody, roots, get probes() { return probes; }, get downloads() { return custodyDownloads; },
    get deleteExpiry() { return deleteExpiry; }, task: () => h.task({ run, inspect: () => assert.fail("native replay must not decide custody") }) };
}

for (const group of ["fullstack-browser", "json-api"]) {
  test(`ordinary collection retires ${group} only after wrapper and complete failed native custody`, async (t) => {
    const f = fixture(t, group);
    assert.equal(await f.task().collect(), 1);
    const s = f.h.saved();
    assert.equal(s.status, "retired"); assert.equal(s.retirement.kind, "native-failed"); assert.ok(s.destroyedAt);
    assert.equal(s.fullGroupQualified, false);
    for (const key of ["validation", "exitCode", "collectedAt", "evidenceOutcome"]) assert.equal(s[key], undefined);
    assert.deepEqual(readFileSync(join(f.h.local, "results.tgz")), f.wrapper);
    assert.deepEqual(readFileSync(join(f.h.local, "failed-native-results.tgz")), f.custody);
    const proof = verifyFailedNativeRetirement(f.h.local, s);
    assert.deepEqual(proof.capture.observation.roots, f.roots);
    assert.ok(f.deleteExpiry > Date.now());
    assert.equal(f.probes, 3); assert.equal(f.downloads, 1); assert.equal(f.h.deletes, 1);
    assert.equal(await f.task().collect(), 1);
    assert.equal(f.probes, 3); assert.equal(f.h.deletes, 1);
    assert.equal(readFileSync(f.sibling, "utf8"), "sibling stays locked");
    if (group === "fullstack-browser") {
      assert.equal(readFileSync(join(f.h.local, "operation.lock"), "utf8"), retainedOperation);
      assert.equal(readFileSync(join(f.h.base, ".groups-launch.lock"), "utf8"), retainedLaunch);
    }
  });
}

test("live unit, foreign native output, corrupt custody and failed final fence refuse deletion", async (t) => {
  const active = fixture(t, "fullstack-browser", { active: true });
  assert.equal(await active.task().collect(), 3);
  assert.ok(!existsSync(join(active.h.local, "results.tgz"))); assert.equal(active.probes, 0);
  const foreign = fixture(t, "fullstack-browser", { foreignLock: true });
  await assert.rejects(foreign.task().collect(), /retained launch lock differs/);
  assert.deepEqual(foreign.h.calls, []);
  for (const [flags, probes, error] of [[{ foreignPath: "bench/json-api/results/j12" }, 0, /unaccounted pending native output/],
    [{ corruptCustody: true }, 1, /digest|hash/], [{ busyFence: true }, 3, /control process failed; host preserved/]]) {
    const f = fixture(t, "fullstack-browser", flags);
    await assert.rejects(f.task().collect(), error);
    assert.equal(f.probes, probes);
    assert.equal(f.h.deletes, 0); assert.equal(f.h.saved().deletionIntentAt, undefined);
    assert.ok(existsSync(join(f.h.local, "results.tgz")));
  }
});

test("uncertain delete reconciles by exact ID without another delete or SSH", async (t) => {
  const f = fixture(t, "json-api", { deleteLost: true, deleteUnconfirmed: true });
  await assert.rejects(f.task().collect(), /acknowledgement lost/);
  assert.equal(f.h.saved().retirement.kind, "native-failed"); assert.equal(f.h.saved().destroyedAt, undefined);
  const start = f.h.calls.length;
  await assert.rejects(f.task().collect(), /deletion not confirmed/);
  assert.equal(f.h.saved().destroyedAt, undefined); assert.equal(f.h.deletes, 1);
  f.h.hosts([]); // An exact authenticated 404, not a second DELETE, settles this fixture.
  assert.equal(await f.task().collect(), 1);
  assert.equal(f.h.deletes, 1); assert.equal(f.probes, 3);
  const calls = f.h.calls.slice(start);
  assert.ok(calls.some(([bin, a, b, c, id]) => bin === "doctl" && a === "compute" && b === "droplet" && c === "get" && id === "123"));
  assert.ok(calls.every(([bin]) => bin === "doctl"));
});

test("an old or replaced key cannot authorize failed custody or DELETE", async (t) => {
  for (const [flags, reason] of [[{ replaceKey: true }, /saved host key differs from launch/],
    [{ legacyKey: true }, /no launch-established host key/]]) {
    const f = fixture(t, "fullstack-browser", flags), state = readFileSync(f.h.statePath);
    await assert.rejects(f.task().collect(), reason);
    assert.deepEqual(readFileSync(f.h.statePath), state);
    assert.deepEqual(f.h.calls, []);
    assert.equal(f.probes, 0); assert.equal(f.h.deletes, 0);
  }
});

test("a late stream-seal failure retains native-validated data as custody only", async (t) => {
  const f = fixture(t, "fullstack-browser", { lateSealFailure: true });
  assert.equal(await f.task().collect(), 3);
  assert.equal(await f.task().collect(), 3);
  assert.deepEqual(readFileSync(join(f.h.local, "results.tgz")), f.wrapper);
  assert.deepEqual(readFileSync(join(f.h.local, "failed-native-results.tgz")), f.custody);
  assert.ok(existsSync(join(f.h.local, "failed-native-capture.json")));
  assert.ok(!existsSync(join(f.h.local, "failed-native-host.json")));
  assert.equal(f.probes, 1); assert.equal(f.downloads, 1); assert.equal(f.h.deletes, 0);
  const s = f.h.saved();
  assert.equal(s.status, "running"); assert.equal(s.fullGroupQualified, false);
  for (const key of ["retirement", "deletionIntentAt", "validation", "exitCode", "collectedAt", "evidenceOutcome"])
    assert.equal(s[key], undefined);
});

test("fleet verification reads retired custody behind settled root and child locks, not live owners or collectors", async (t) => {
  const group = "fullstack-browser", f = fixture(t, group, { fleetLayout: true, deleteLost: true });
  const batchLock = join(f.root, ".fleet-operation.lock");
  const batchOwner = (pid) => `${JSON.stringify({ pid, approvalSha256: "5".repeat(64) }, null, 2)}\n`;
  writeFileSync(batchLock, batchOwner(retiredPid));
  const verify = async () => {
    const before = treeHash(f.root);
    const report = await verifyFleet({ root: f.root, round, commit }, { inspect: () => assert.fail("retirement must not replay native data") });
    assert.equal(treeHash(f.root), before);
    assert.equal(report.publishableBaseline, false); assert.equal(report.status, "incomplete");
    assert.equal(report.error, undefined);
    assert.equal(report.fleetLock, "retained");
    assert.equal(readGroup(readFleet(f.root, round), group).outcome, "busy", "mutating fleet paths still see retained locks");
    return report.groups.find(row => row.group === group).outcome;
  };
  await assert.rejects(f.task().collect(), /acknowledgement lost/);
  assert.equal(await verify(), "cleanup-pending");
  const recovery = join(f.h.local, "stream-recovery.lock");
  writeFileSync(recovery, JSON.stringify({ pid: process.pid }));
  assert.equal(await verify(), "busy");
  unlinkSync(recovery);
  assert.equal(await f.task().collect(), 1);
  assert.equal(await verify(), "native-failed-retired");
  const op = join(f.h.local, "operation.lock"), launch = join(f.h.base, ".groups-launch.lock");
  assert.equal(readFileSync(op, "utf8"), retainedOperation);
  assert.equal(readFileSync(launch, "utf8"), retainedLaunch);
  const owner = JSON.stringify({ ...JSON.parse(retainedOperation), pid: process.pid });
  writeFileSync(op, owner);
  writeFileSync(launch, JSON.stringify({ pid: process.pid, round }));
  assert.equal(await verify(), "busy");
  assert.equal(readFileSync(op, "utf8"), owner);
  writeFileSync(op, retainedOperation);
  writeFileSync(launch, retainedLaunch);

  writeFileSync(batchLock, batchOwner(process.pid));
  const live = await verifyFleet({ root: f.root, round, commit }, { inspect: () => assert.fail("live fleet must not replay") });
  assert.equal(live.fleetLock, "busy"); assert.equal(live.error, "fleet-operation-busy");
  assert.deepEqual(live.groups, []);
  assert.equal(readFileSync(batchLock, "utf8"), batchOwner(process.pid));

  writeFileSync(batchLock, batchOwner(retiredPid));
  writeFileSync(join(f.h.local, "failed-native-results.tgz"), "changed custody");
  assert.equal(await verify(), "error", "a retained root lock cannot vouch for changed custody");
  assert.equal(readFileSync(batchLock, "utf8"), batchOwner(retiredPid));
  assert.equal(f.h.deletes, 1);
});
