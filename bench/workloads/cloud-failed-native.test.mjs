import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { accountId, archive, context, harness, metadata } from "./cloud-fixtures.mjs";
import { fleetPlan, reservation } from "./cloud-contract.mjs";
import { groupNames } from "./registry.mjs";
import { digest, treeHash } from "./cloud-local.mjs";
import { parseDropletArgs } from "./cloud-options.mjs";
import { productionMain, productionPlan } from "./cloud-production.mjs";
import { verifyFleet } from "./fleet-verify.mjs";
import * as retirement from "./cloud-retirement.mjs";

test("failed-native retirement is a deliberate exclusive action, not a collect override", () => {
  const args = ["r21", "--state-dir", process.cwd(), "--retire-failed-native"];
  assert.equal(parseDropletArgs(args).retireFailedNative, true);
  for (const extra of [["--collect"], ["--detach"], ["--commit", "a".repeat(40)], ["--group", "catalog-page"]])
    assert.throws(() => parseDropletArgs([...args, ...extra]));
});

const repairCommit = "c".repeat(40), campaign = "r21-abcdef0123456789";
const canonical = (value) => JSON.stringify(value, (key, v) => v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
const fileTree = (bytes) => digest(Buffer.concat([Buffer.from(`f\0\0${bytes.length}\0`), bytes]));

async function recoveryHarness(t, flags = {}, group = "catalog-page") {
  const h = harness(t, flags); h.seed();
  const tokens = Object.fromEntries(groupNames.map((g, i) => [g, g === group ? h.saved().token : (i + 1).toString(16).padStart(16, "0")]));
  const fleet = fleetPlan({ round: "r21", commit: retirement.failedNativeCommit, token: "f".repeat(16), tokens, provider: { accountId, context }, sshKey: "42" });
  const bound = reservation({ round: "r21", commit: fleet.commit, token: tokens[group], group, fleet });
  h.change((s) => Object.assign(s, bound, { status: "running" }));
  const root = retirement.failedNativeRoots(h.saved())[1].slice("/bench/repo/".length);
  const pending = group === "hardening" ? [] : [{ group, phase: group === "json-api" ? "prepare" : "timing", artifactRoot: root }];
  const plan = { schema: "benchmark-isolated-group-campaign/v1", commit: fleet.commit, round: "r21", order: [group],
    bindings: [{ request: { group }, validation: { artifactRoot: root } }], campaignSha256: "d".repeat(64) };
  const result = { status: { campaign, round: "r21", campaignSha256: plan.campaignSha256,
    state: pending.length ? "preserved-uncertain" : "finished", uncollectedNativeRoots: pending } };
  const entries = [...metadata().map((e) => e.name === "exit-code" ? { ...e, body: "2\n" } : e), { name: "campaign/" },
    { name: "campaign/.host-attempt.json", body: "{}" }, { name: `campaign/${campaign}/` },
    { name: `campaign/${campaign}/plan.json`, body: JSON.stringify(plan) }, { name: `campaign/${campaign}/campaign-result.json`, body: JSON.stringify(result) }];
  const originalArchive = archive(entries); h.setArchive(originalArchive);
  // Reproduce ordinary collection refusal without inventing native success.
  await assert.rejects(h.task({ inspect: () => { throw new Error("synthetic invalid native evidence"); } }).collect());
  assert.equal(h.deletes, 0); assert.equal(h.saved().status, "running");
  const originalState = readFileSync(h.statePath), old = h.saved(), oldTree = treeHash(join(h.local, old.evidence));
  const native = join(h.temp, "native"); mkdirSync(native);
  writeFileSync(join(native, "do-not-run.mjs"), "throw new Error('evidence must not execute');\n");
  const roots = retirement.failedNativeRoots(old).map((path, index) => index > 1 || flags.absentRoot && index === 1 ? { path, present: false }
    : { path, present: true, treeSha256: treeHash(index === 0 ? join(h.local, old.evidence, "campaign") : native), nodes: index === 0 ? 5 : 2,
      bytes: index === 0 ? 100 : readFileSync(join(native, "do-not-run.mjs")).length });
  for (const name of ["run.log", "host.txt", "exit-code", "results.tgz"]) {
    const bytes = name === "results.tgz" ? originalArchive : readFileSync(join(h.local, old.evidence, name));
    roots.push({ path: `/bench/${name}`, present: true, treeSha256: fileTree(bytes), nodes: 1, bytes: bytes.length });
  }
  const metadataBytes = "[]", metadataSha256 = digest(metadataBytes), snapshot = canonical({ roots, metadataSha256 });
  const custodyEntries = [...entries.filter((e) => !e.name.startsWith("campaign")), { name: "campaign/" },
    { name: "campaign/custody-metadata.json", body: metadataBytes }, { name: "campaign/custody-files.json", body: "{}" },
    { name: "campaign/custody-snapshot.json", body: snapshot },
    ...entries.filter((e) => e.name.startsWith("campaign")).map((e) => ({ ...e, name: e.name.replace(/^campaign/, "campaign/root-0") }))];
  if (roots[1].present) custodyEntries.push({ name: "campaign/root-1/" }, { name: "campaign/root-1/do-not-run.mjs", body: readFileSync(join(native, "do-not-run.mjs")) });
  const custodyArchive = archive(custodyEntries);
  let probes = 0, settlements = 0;
  const calls = [];
  const run = (binary, args, timeout, allowFail) => {
    calls.push([binary, ...args]);
    if (binary === "ssh" && args.at(-1).includes("CORTEN_FAILED_NATIVE_HOST")) {
      probes++;
      if (flags.probeError) throw new Error("synthetic terminal proof failed");
      if (flags.uncertainProbe) throw Object.assign(new Error("synthetic uncertain probe"), { controlTreeUncertain: true });
      if (flags.finalHook && probes === 2) flags.finalHook();
      const observation = { schema: "benchmark-failed-native-host/v1", hostId: old.id, unit: old.unit, custody: true,
        historicalAccountingQualified: false, roots, metadataSha256, snapshotSha256: digest(snapshot),
        archiveSha256: digest(custodyArchive), observedAtMs: Date.now() };
      if (flags.badFinal && probes === 2) observation.snapshotSha256 = "f".repeat(64);
      if (flags.badFence && probes === 3) observation.metadataSha256 = "f".repeat(64);
      if (flags.staleProbe) observation.observedAtMs -= 600000;
      return { status: 0, stdout: JSON.stringify(observation) };
    }
    if (binary === "scp" && args.at(-2).endsWith(":/bench/failed-native-custody.tgz")) {
      writeFileSync(args.at(-1), flags.badDownload ? "corrupt" : custodyArchive);
      return { status: 0, stdout: "" };
    }
    return h.run(binary, args, timeout, allowFail);
  };
  const approval = () => ({ controllerCommit: repairCommit, reservationSha256: digest(readFileSync(h.statePath)) });
  const task = (deps = {}) => h.task({ run, recoveryApproval: approval(), settle: async () => {
    assert.ok(existsSync(join(h.local, "operation.lock")), "worker settlement must precede unlock");
    settlements++;
    if (flags.unsettled) throw new Error("synthetic worker close uncertain");
  }, ...deps }, { collect: undefined, retireFailedNative: true });
  return { h, calls, run, task, approval, fleet, old, originalState, oldTree, custodyArchive,
    get probes() { return probes; }, get settlements() { return settlements; } };
}

test("explicit failed-native retirement preserves old failure and every custody byte without native execution", async (t) => {
  for (const group of groupNames.filter((g) => g !== "mixed-production")) {
    const r = await recoveryHarness(t, {}, group);
    assert.equal(await r.task({ inspect: () => assert.fail("native execution forbidden") }).retireFailedNative(), 1);
    const s = r.h.saved();
    assert.equal(s.commit, retirement.failedNativeCommit); assert.equal(s.retirement.kind, "native-failed");
    assert.equal(s.status, "retired"); assert.equal(s.fullGroupQualified, false); assert.ok(s.destroyedAt);
    for (const key of ["validation", "collectedAt", "exitCode", "evidenceOutcome"]) assert.equal(s[key], undefined);
    assert.equal(s.archiveSha256, r.old.archiveSha256); assert.equal(s.evidenceSha256, r.old.evidenceSha256);
    assert.equal(treeHash(join(r.h.local, s.evidence)), r.oldTree);
    assert.deepEqual(readFileSync(join(r.h.local, "failed-native-reservation.json")), r.originalState);
    assert.deepEqual(readFileSync(join(r.h.local, "failed-native-results.tgz")), r.custodyArchive);
    retirement.verifyFailedNativeRetirement(r.h.local, s);
    assert.equal(r.h.deletes, 1); assert.equal(r.probes, 3); assert.equal(r.settlements, 1);
    assert.equal(await r.task().retireFailedNative(), 1); assert.equal(r.h.deletes, 1); assert.equal(r.probes, 3);
    assert.ok(!existsSync(join(r.h.local, "operation.lock")));
    assert.ok(!r.calls.some(([b, ...args]) => b === "ssh" && args.at(-1).includes("systemctl start")));
  }
});

test("uncertain worker settlement after failed retirement keeps the operation lock and never retries deletion", async (t) => {
  const r = await recoveryHarness(t, { unsettled: true });
  await assert.rejects(r.task().retireFailedNative(), (error) => error.controlTreeUncertain === true);
  assert.equal(r.h.deletes, 1); assert.ok(r.h.saved().destroyedAt);
  assert.ok(existsSync(join(r.h.local, "operation.lock")));
  await assert.rejects(r.task().retireFailedNative()); assert.equal(r.h.deletes, 1);
});

test("explicit absent output is retained as absence, never a completed native result", async (t) => {
  const r = await recoveryHarness(t, { absentRoot: true });
  assert.equal(await r.task().retireFailedNative(), 1);
  const record = retirement.verifyFailedNativeRetirement(r.h.local, r.h.saved());
  assert.deepEqual(record.capture.observation.roots[1], { path: "/bench/repo/bench/catalog/results/c21", present: false });
  assert.equal(r.h.saved().validation, undefined);
});

test("missing custody, stale/uncertain proof, changed evidence, identity and unsettled control never authorize DELETE", async (t) => {
  for (const mode of ["probeError", "uncertainProbe", "badDownload", "badFinal", "badFence", "staleProbe", "old-tree", "final-custody", "account", "unsettled"]) {
    const flags = { [mode]: true }, r = await recoveryHarness(t, flags);
    if (mode === "old-tree") writeFileSync(join(r.h.local, r.old.evidence, "run.log"), "mutated");
    if (mode === "account") flags.accountId = "foreign-account";
    if (mode === "final-custody") flags.finalHook = () => writeFileSync(join(r.h.local, "failed-native-results.tgz"), "mutated");
    // Settlement is a pre-unlock requirement, not permission for an unobserved
    // provider request. Simulate it at the first remote operation as well.
    if (mode === "unsettled") flags.uncertainProbe = true;
    await assert.rejects(r.task().retireFailedNative(), undefined, mode);
    assert.equal(r.h.deletes, 0, mode); assert.equal(r.h.saved().deletionIntentAt, undefined, mode);
    assert.equal(existsSync(join(r.h.local, "operation.lock")), ["uncertainProbe", "unsettled"].includes(mode), mode);
  }
});

test("failed-native uncertain DELETE outcomes permit absence reconciliation only, never another DELETE", async (t) => {
  for (const mode of ["deleteUnconfirmed", "deleteLost", "deleteError", "deleteRejected"]) {
    const r = await recoveryHarness(t, { [mode]: true });
    await assert.rejects(r.task().retireFailedNative()); assert.equal(r.h.deletes, 1, mode);
    if (["deleteLost", "deleteRejected"].includes(mode)) assert.equal(await r.task().retireFailedNative(), 1);
    else {
      await assert.rejects(r.task().retireFailedNative()); assert.equal(r.h.deletes, 1, mode);
      r.h.hosts([]); assert.equal(await r.task().retireFailedNative(), 1);
    }
    assert.equal(r.h.deletes, 1, mode);
  }
});

test("fleet inspection reports failed retirement without replay or qualification and rejects changed custody", async (t) => {
  const r = await recoveryHarness(t); await r.task().retireFailedNative();
  const root = join(r.h.temp, "fleet"); mkdirSync(root);
  writeFileSync(join(root, "fleet-r21.json"), JSON.stringify(r.fleet));
  const groupRoot = join(root, "catalog-page"); mkdirSync(groupRoot);
  cpSync(r.h.local, join(groupRoot, "groups-r21"), { recursive: true });
  const inspect = () => assert.fail("failed retirement must not execute native evidence");
  const report = await verifyFleet({ root, round: "r21", commit: retirement.failedNativeCommit }, { inspect });
  assert.equal(report.groups[0].outcome, "native-failed-retired"); assert.equal(report.status, "incomplete");
  assert.equal(report.nativeReadiness, false); assert.equal(report.publishableBaseline, false);
  writeFileSync(join(groupRoot, "groups-r21", "failed-native-results.tgz"), "changed");
  const bad = await verifyFleet({ root, round: "r21", commit: retirement.failedNativeCommit }, { inspect });
  assert.equal(bad.groups[0].error, "group-evidence-invalid");
});

test("operator-gated production recovery rechecks merged source and exact locked reservation before any provider operation", async (t) => {
  for (const mode of ["valid", "changed", "unmerged", "unsettled"]) {
    const r = await recoveryHarness(t), output = [], calls = [];
    let closed = 0;
    const args = ["r21", "--state-dir", r.h.base, "--retire-failed-native"];
    const spawn = (binary, argv, options) => {
      calls.push([binary, ...argv]);
      if (binary === "git") {
        if (argv[0] === "ls-remote") return { status: 0, stdout: `${repairCommit}\trefs/heads/main\n` };
        if (argv[0] === "merge-base" && mode === "unmerged" && argv[2] === repairCommit) return { status: 1, stdout: "" };
        return localGit(r)(binary, argv);
      }
      const copy = [...argv];
      if (binary === "ssh") copy[copy.length - 1] = options.input.replace(/^set -euo pipefail\n/, "").replace(/\n$/, "");
      return r.run(binary, copy, options.timeout);
    };
    const deps = { repo: r.h.repo, spawn, write: (s) => output.push(JSON.parse(s)),
      providerFactory: () => Object.assign((argv, timeout, allowFail) => {
        calls.push(["provider", ...argv]); return r.run("doctl", argv, timeout, allowFail);
      }, { close: async () => { closed++; if (mode === "unsettled") throw new Error("synthetic provider close uncertain"); } }) };
    if (mode === "unsettled") {
      // A source-plan rejection still settles the same worker, with no operation.
      await assert.rejects(productionMain([...args, "--print-approval"], deps));
      assert.ok(closed); assert.equal(r.h.deletes, 0); continue;
    }
    assert.equal(await productionMain([...args, "--print-approval"], deps), 3);
    assert.equal(output[0].recovery.measuredCommit, retirement.failedNativeCommit);
    assert.equal(output[0].controllerCommit, repairCommit);
    assert.ok(calls.every(([binary]) => binary === "git")); calls.length = 0;
    const approved = [...args, "--approve-reviewed-merged-ready", output[0].approvalSha256];
    if (mode === "changed") r.h.change((s) => { s.createdAt = "2026-11-14T00:00:00.000Z"; });
    if (mode === "valid") {
      assert.equal(await productionMain(approved, deps), 1); assert.equal(r.h.deletes, 1);
      assert.ok(calls.some(([b, ...a]) => b === "git" && a[0] === "merge-base" && a[2] === repairCommit));
    } else {
      await assert.rejects(productionMain(approved, deps)); assert.equal(r.h.deletes, 0);
      assert.ok(calls.every(([binary]) => binary === "git"));
    }
    assert.ok(closed >= 2);
  }
});

test("a captured failed campaign can resume only with intact custody and a new current proof", async (t) => {
  const flags = { badFinal: true }, r = await recoveryHarness(t, flags);
  await assert.rejects(r.task().retireFailedNative()); assert.equal(r.h.deletes, 0);
  assert.ok(existsSync(join(r.h.local, "failed-native-capture.json")));
  flags.badFinal = false;
  assert.equal(await r.task().retireFailedNative(), 1); assert.equal(r.probes, 4); assert.equal(r.h.deletes, 1);
});

function localGit(r, head = repairCommit) {
  return (binary, args) => {
    assert.equal(binary, "git");
    const stdout = args[0] === "rev-parse" ? args[1] === "HEAD" ? head : r.h.repo
      : args[0] === "show" ? readFileSync(resolve(args[1].slice(41)), "utf8").replaceAll("\r\n", "\n") : "";
    return { status: 0, stdout };
  };
}

test("approval binds old measured reservation and new repair source; ordinary source gate remains exact", async (t) => {
  const r = await recoveryHarness(t), options = { round: "r21", stateDir: r.h.base, retireFailedNative: true };
  const plan = await productionPlan(options, { repo: r.h.repo, run: localGit(r) });
  assert.equal(plan.subject.controllerCommit, repairCommit); assert.equal(plan.subject.recovery.measuredCommit, retirement.failedNativeCommit);
  assert.equal(plan.subject.reservationSha256, digest(r.originalState));
  assert.equal(plan.subject.recovery.archiveSha256, r.old.archiveSha256);
  const other = await productionPlan(options, { repo: r.h.repo, run: localGit(r, "d".repeat(40)) });
  assert.notEqual(other.approvalSha256, plan.approvalSha256);
  await assert.rejects(productionPlan({ round: "r21", stateDir: r.h.base, collect: true }, { repo: r.h.repo, run: localGit(r) }), /measured integrated/);
  r.h.change((s) => { s.commit = "a".repeat(40); });
  await assert.rejects(productionPlan(options, { repo: r.h.repo, run: localGit(r) }));
});

test("failed-native recovery supports only the measured migration source and its fixed output roots", () => {
  const state = { round: "r21", commit: "9f3d35884c67d90524f978d173fabeb3a17bc970", group: "json-api" };
  assert.deepEqual(retirement.failedNativeRoots(state), ["/bench/campaign", "/bench/repo/bench/json-api/results/j42", "/bench/repo/bench/json-api/results/j43"]);
  for (const change of [{ commit: "a".repeat(40) }, { round: "r22" }, { group: "mixed-production" }, { group: undefined }])
    assert.throws(() => retirement.failedNativeRoots({ ...state, ...change }));
});
