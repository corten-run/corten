import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { accountId, archive, context, harness, metadata } from "./cloud-fixtures.mjs";
import { tags } from "./cloud-contract.mjs";
import { groupNames } from "./registry.mjs";
import { digest, treeHash } from "./cloud-local.mjs";
import { parseDropletArgs } from "./cloud-options.mjs";
import { bootstrapMarker } from "./cloud-remote.mjs";
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
const dbeAttempt = { commit: "dbe1a34c753ee8ef4ac9927484dc3930d36f6e37", round: "r21", group: "catalog-page",
  id: "620052965", token: "39fa09440f45df00", name: "corten-bench-groups-r21-39fa09440f45df00",
  tag: "corten-bench-groups-run-39fa09440f45df00", unit: "corten-bench-groups-r21-39fa09440f45df00.service" };
const leanAttempt = { commit: "2a4ceb043747b92c753becc2bbcc5def655fc53d", round: "r21", group: "catalog-page",
  id: "620157651", token: "e38164eb06fc2043", name: "corten-bench-groups-r21-e38164eb06fc2043",
  tag: "corten-bench-groups-run-e38164eb06fc2043", unit: "corten-bench-groups-r21-e38164eb06fc2043.service" };
const canonical = (value) => JSON.stringify(value, (key, v) => v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);
const fileTree = (bytes) => digest(Buffer.concat([Buffer.from(`f\0\0${bytes.length}\0`), bytes]));

async function recoveryHarness(t, flags = {}, group = "catalog-page", measuredCommit = retirement.failedNativeCommit) {
  const exactAttempt = [dbeAttempt, leanAttempt].find((attempt) => attempt.commit === measuredCommit);
  if (exactAttempt) Object.assign(flags, { hostId: exactAttempt.id, token: exactAttempt.token });
  const h = harness(t, flags); h.seed();
  // Bind this fake host to the original pre-placement wire format and roster.
  const captured = JSON.parse(readFileSync(new URL("./test-fixtures/grouped-sfo2-reservation.json", import.meta.url)));
  const { fleetSha256, ...body } = captured.fleet;
  const { token, name, tag, unit } = h.saved();
  body.commit = measuredCommit; body.provider = { accountId, context };
  Object.assign(body.jobs.find((row) => row.group === group), { token, name, tag });
  const fleet = { ...body, fleetSha256: digest(JSON.stringify(body)) };
  const bound = { ...captured, commit: measuredCommit, token, name, tag, unit, fleet, group,
    selection: { schema: fleet.selection.schema, groups: fleet.selection.groups.filter((row) => row.group === group) } };
  h.change((s) => Object.assign(s, bound, { status: "running" }));
  if (exactAttempt) h.change((s) => {
    s.bootstrapReady = { sha256: digest(`${JSON.stringify(bootstrapMarker(s))}\n`), observedAt: "2026-11-16T12:00:00.000Z" };
  });
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
  if (exactAttempt)
    writeFileSync(join(native, "failed-load.json"), '{"exitCode":99,"timeouts":6,"targets":[]}\n');
  const nativeBytes = readFileSync(join(native, "do-not-run.mjs")).length
    + (exactAttempt ? readFileSync(join(native, "failed-load.json")).length : 0);
  const roots = retirement.failedNativeRoots(old).map((path, index) => index > 1 || flags.absentRoot && index === 1 ? { path, present: false }
    : { path, present: true, treeSha256: treeHash(index === 0 ? join(h.local, old.evidence, "campaign") : native),
      nodes: index === 0 ? 5 : exactAttempt ? 3 : 2, bytes: index === 0 ? 100 : nativeBytes });
  for (const name of ["run.log", "host.txt", "exit-code", "results.tgz"]) {
    const bytes = name === "results.tgz" ? originalArchive : readFileSync(join(h.local, old.evidence, name));
    roots.push({ path: `/bench/${name}`, present: true, treeSha256: fileTree(bytes), nodes: 1, bytes: bytes.length });
  }
  const metadataBytes = "[]", metadataSha256 = digest(metadataBytes), snapshot = canonical({ roots, metadataSha256 });
  const custodyEntries = [...entries.filter((e) => !e.name.startsWith("campaign")), { name: "campaign/" },
    { name: "campaign/custody-metadata.json", body: metadataBytes }, { name: "campaign/custody-files.json", body: "{}" },
    { name: "campaign/custody-snapshot.json", body: snapshot },
    ...entries.filter((e) => e.name.startsWith("campaign")).map((e) => ({ ...e, name: e.name.replace(/^campaign/, "campaign/root-0") }))];
  if (roots[1].present) {
    custodyEntries.push({ name: "campaign/root-1/" }, { name: "campaign/root-1/do-not-run.mjs", body: readFileSync(join(native, "do-not-run.mjs")) });
    if (exactAttempt)
      custodyEntries.push({ name: "campaign/root-1/failed-load.json", body: readFileSync(join(native, "failed-load.json")) });
  }
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
      return { status: 0, stdout: JSON.stringify(flags.nativeProof ? flags.nativeProof(observation) : observation) };
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

test("failed-native retirement rejects exact-identity provider rows in the wrong region", async (t) => {
  const r = await recoveryHarness(t), s = r.h.saved();
  assert.equal(s.host.region, "sfo2");
  r.h.hosts([{ ...r.h.host(), name: s.name, tags: [...tags, s.tag], region: { slug: "sfo3" } }]);
  const start = r.h.calls.length;
  await assert.rejects(r.task().retireFailedNative());
  assert.ok(r.h.calls.length > start);
  assert.ok(!r.h.calls.slice(start).some(([binary]) => binary === "ssh" || binary === "scp"));
  assert.equal(r.probes, 0); assert.equal(r.h.deletes, 0);
  assert.deepEqual(readFileSync(r.h.statePath), r.originalState);
});

test("uncertain worker settlement after failed retirement keeps the operation lock and never retries deletion", async (t) => {
  const r = await recoveryHarness(t, { unsettled: true });
  await assert.rejects(r.task().retireFailedNative(), (error) => error.controlTreeUncertain === true);
  assert.equal(r.h.deletes, 1); assert.ok(r.h.saved().destroyedAt);
  assert.ok(existsSync(join(r.h.local, "operation.lock")));
  await assert.rejects(r.task().retireFailedNative()); assert.equal(r.h.deletes, 1);
});

test("failed-native proof expiry includes delayed delivery of the final SSH observation", async (t) => {
  const r = await recoveryHarness(t), realNow = Date.now;
  let offset = 0, observed;
  const run = async (binary, args, ...rest) => {
    const result = await r.run(binary, args, ...rest);
    if (binary === "ssh" && args.at(-1).includes("CORTEN_FAILED_NATIVE_HOST") && r.probes === 3) {
      observed = JSON.parse(result.stdout).observedAtMs;
      await Promise.resolve(); offset = 61001;
    }
    return result;
  };
  Date.now = () => realNow() + offset;
  try {
    await assert.rejects(r.task({ run }).retireFailedNative(), /proof expired/);
    assert.ok(Date.now() - observed > 60000);
    assert.equal(r.h.deletes, 0);
    assert.deepEqual(readFileSync(r.h.statePath), r.originalState);
    assert.ok(existsSync(join(r.h.local, "failed-native-capture.json")));
    assert.ok(!existsSync(join(r.h.local, "operation.lock")));
  } finally { Date.now = realNow; }
});

test("failed-native proof expiry survives the last asynchronous account preflight", async (t) => {
  const flags = {}, r = await recoveryHarness(t, flags), realNow = Date.now;
  let offset = 0, accounts = 0;
  const delayedRun = async (binary, args, ...rest) => {
    const result = await r.run(binary, args, ...rest);
    if (r.probes === 3 && binary === "doctl" && args[0] === "account" && ++accounts === 3) {
      await Promise.resolve(); offset = 61001;
    }
    return result;
  };
  Date.now = () => realNow() + offset;
  try {
    await assert.rejects(r.task({ run: delayedRun }).retireFailedNative(), /proof expired/);
    assert.equal(r.h.deletes, 0);
    assert.ok(r.h.saved().deletionIntentAt, "durable intent cannot be silently retried even when dispatch is refused");
    await assert.rejects(r.task().retireFailedNative(), /no automatic repeated deletion/);
    assert.equal(r.h.deletes, 0);
  } finally { Date.now = realNow; }
});

test("interrupted receipt rehash spends no final proof window and recovery still enforces expiry", async (t) => {
  for (const expire of [false, true]) {
    const flags = {}, r = await recoveryHarness(t, flags), originalOpen = fs.openSync;
    // Crash after receipt durability but before even opening the state-intent
    // temporary file (its own fresh deletion-intent stage). No DELETE or durable
    // intent exists to retry or clear.
    fs.openSync = (...args) => {
      if (typeof args[0] === "string" && args[0].startsWith(`${r.h.statePath}.deletion-intent-`) && args[0].endsWith(".tmp"))
        throw new Error("synthetic pre-intent interruption");
      return originalOpen(...args);
    };
    syncBuiltinESMExports();
    try { await assert.rejects(r.task().retireFailedNative(), /synthetic pre-intent interruption/); }
    finally { fs.openSync = originalOpen; syncBuiltinESMExports(); }
    assert.equal(r.h.deletes, 0); assert.deepEqual(readFileSync(r.h.statePath), r.originalState);
    const receiptPath = join(r.h.local, "failed-native-host.json"), receipt = readFileSync(receiptPath);
    const realNow = Date.now;
    let offset = 0, receiptProbe, accounts = 0;
    fs.openSync = (...args) => {
      if (args[0] === receiptPath && receiptProbe === undefined) { receiptProbe = r.probes; offset += 61001; }
      return originalOpen(...args);
    };
    syncBuiltinESMExports(); Date.now = () => realNow() + offset;
    const delayedRun = async (binary, args, ...rest) => {
      const result = await r.run(binary, args, ...rest);
      if (expire && r.probes === 5 && binary === "doctl" && args[0] === "account" && ++accounts === 3) {
        await Promise.resolve(); offset += 61001;
      }
      return result;
    };
    try {
      if (expire) await assert.rejects(r.task({ run: delayedRun }).retireFailedNative(), /proof expired/);
      else assert.equal(await r.task({ run: delayedRun }).retireFailedNative(), 1);
      assert.equal(receiptProbe, 4, "expensive interrupted receipt verification must precede final fence (probe 5)");
      assert.equal(r.h.deletes, expire ? 0 : 1);
      assert.deepEqual(readFileSync(join(r.h.local, `failed-native-host.interrupted-${digest(receipt)}.json`)), receipt);
    } finally { Date.now = realNow; fs.openSync = originalOpen; syncBuiltinESMExports(); }
  }
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

test("failed-native retirement confirms delayed exact-ID absence and keeps the result failed", async (t) => {
  const r = await recoveryHarness(t, { deleteUnconfirmed: true }); let observations = 0;
  r.h.flags.hook = (binary, args) => {
    if (binary === "doctl" && args[2] === "get" && r.h.deletes && ++observations === 3) r.h.hosts([]);
  };
  assert.equal(await r.task().retireFailedNative(), 1);
  assert.equal(observations, 3); assert.equal(r.h.deletes, 1); assert.ok(r.h.saved().destroyedAt);
  assert.equal(r.h.saved().fullGroupQualified, false);
  assert.equal(await r.task().retireFailedNative(), 1); assert.equal(r.h.deletes, 1);
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
  for (const measuredCommit of [retirement.failedNativeCommit, dbeAttempt.commit, leanAttempt.commit]) for (const mode of ["valid", "changed", "unmerged", "unsettled"]) {
    const r = await recoveryHarness(t, {}, "catalog-page", measuredCommit), output = [], calls = [];
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
      providerFactory: ({ createMode }) => Object.assign((argv, timeout, allowFail, deleteProofExpiresAtMs) => {
        assert.equal(createMode, null);
        if (argv[2] === "delete") assert.ok(Number.isSafeInteger(deleteProofExpiresAtMs)
          && Date.now() < deleteProofExpiresAtMs && deleteProofExpiresAtMs - Date.now() <= 60000);
        calls.push(["provider", ...argv]); return r.run("doctl", argv, timeout, allowFail);
      }, { close: async () => { closed++; if (mode === "unsettled") throw new Error("synthetic provider close uncertain"); } }) };
    if (mode === "unsettled") {
      // A source-plan rejection still settles the same worker, with no operation.
      await assert.rejects(productionMain([...args, "--print-approval"], deps));
      assert.ok(closed); assert.equal(r.h.deletes, 0); continue;
    }
    assert.equal(await productionMain([...args, "--print-approval"], deps), 3);
    assert.equal(output[0].recovery.measuredCommit, measuredCommit);
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
  assert.equal(plan.subject.recovery.policy, "r21-9f-failed-native-custody-only-no-qualification");
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

test("dbe retirement rejects other sources, groups, rounds and host attempts", () => {
  for (const change of [{ commit: "a".repeat(40) }, ...groupNames.filter((group) => group !== "catalog-page").map((group) => ({ group })), { group: undefined }, { round: "r22" },
    { id: "620052966" }, { id: undefined }, { token: "0".repeat(16) }, { name: "foreign" }, { tag: "foreign" }, { unit: "foreign.service" }])
    assert.throws(() => retirement.failedNativeRoots({ ...dbeAttempt, ...change }));
});

test("lean catalog retirement admits only its exact owned identity and existing custody roots", () => {
  assert.equal(retirement.failedNativePolicy(leanAttempt), "r21-2a-exact-lean-catalog-custody-only-no-qualification");
  assert.deepEqual(retirement.failedNativeRoots(leanAttempt), ["/bench/campaign", "/bench/repo/bench/catalog/results/c21"]);
  for (const [key, value] of Object.entries(leanAttempt)) {
    for (const changed of [undefined, value === "catalog-page" ? "json-api" : "foreign"])
      assert.throws(() => retirement.failedNativeRoots({ ...leanAttempt, [key]: changed }), key);
  }
  for (const other of [dbeAttempt, { ...leanAttempt, id: "620157652" }, { ...leanAttempt, token: dbeAttempt.token }])
    assert.throws(() => retirement.failedNativePolicy({ ...leanAttempt, ...other, commit: leanAttempt.commit }));
});

test("lean catalog retirement retains raw failure bytes and cannot authorize a baseline or repeated DELETE", async (t) => {
  const r = await recoveryHarness(t, {}, "catalog-page", leanAttempt.commit);
  assert.equal(await r.task({ inspect: () => assert.fail("native execution forbidden") }).retireFailedNative(), 1);
  const saved = r.h.saved(), receipt = retirement.verifyFailedNativeRetirement(r.h.local, saved);
  assert.equal(saved.commit, leanAttempt.commit); assert.equal(saved.fullGroupQualified, false);
  assert.equal(saved.status, "retired"); assert.equal(saved.retirement.kind, "native-failed"); assert.ok(saved.destroyedAt);
  for (const key of ["validation", "exitCode", "collectedAt", "evidenceOutcome"]) assert.equal(saved[key], undefined);
  assert.deepEqual(readFileSync(join(r.h.local, "failed-native-reservation.json")), r.originalState);
  assert.deepEqual(readFileSync(join(r.h.local, "failed-native-results.tgz")), r.custodyArchive);
  assert.equal(saved.archiveSha256, r.old.archiveSha256); assert.equal(saved.evidenceSha256, r.old.evidenceSha256);
  assert.equal(treeHash(join(r.h.local, saved.evidence)), r.oldTree);
  assert.equal(readFileSync(join(r.h.local, receipt.capture.evidence, "campaign/root-1/failed-load.json"), "utf8"),
    '{"exitCode":99,"timeouts":6,"targets":[]}\n');
  assert.equal(r.h.deletes, 1); assert.equal(r.probes, 3); assert.equal(r.settlements, 1);
  assert.equal(await r.task().retireFailedNative(), 1); assert.equal(r.h.deletes, 1); assert.equal(r.probes, 3);
  assert.ok(!r.calls.some(([binary, ...args]) => binary === "ssh" && /systemctl (?:start|stop|restart)/.test(args.at(-1))));
});

test("lean catalog retirement preserves its archive, terminal and ownership refusal gates", async (t) => {
  for (const mode of ["probeError", "badFinal", "badFence", "badDownload", "staleProbe", "account", "unsettled"]) {
    const flags = { [mode]: true }, r = await recoveryHarness(t, flags, "catalog-page", leanAttempt.commit);
    if (mode === "account") flags.accountId = "foreign-account";
    await assert.rejects(r.task({ inspect: () => assert.fail("native execution forbidden") }).retireFailedNative(), undefined, mode);
    assert.equal(r.h.deletes, mode === "unsettled" ? 1 : 0, mode);
    assert.equal(r.h.saved().fullGroupQualified, false, mode);
    assert.equal(treeHash(join(r.h.local, r.old.evidence)), r.oldTree, mode);
  }
});

test("lean catalog custody preserves an explicitly absent native root without fabricating qualification", async (t) => {
  const r = await recoveryHarness(t, { absentRoot: true }, "catalog-page", leanAttempt.commit);
  assert.equal(await r.task().retireFailedNative(), 1);
  const saved = r.h.saved(), receipt = retirement.verifyFailedNativeRetirement(r.h.local, saved);
  assert.equal(receipt.capture.observation.roots[1].present, false);
  assert.equal(saved.fullGroupQualified, false); assert.equal(saved.validation, undefined);
  assert.equal(r.h.deletes, 1);
});

test("lean catalog retirement approval binds exact source, reservation and preserved archive without collect override", async (t) => {
  const r = await recoveryHarness(t, {}, "catalog-page", leanAttempt.commit);
  const options = { round: "r21", stateDir: r.h.base, retireFailedNative: true };
  const plan = await productionPlan(options, { repo: r.h.repo, run: localGit(r) });
  assert.equal(plan.subject.recovery.measuredCommit, leanAttempt.commit);
  assert.equal(plan.subject.recovery.policy, "r21-2a-exact-lean-catalog-custody-only-no-qualification");
  assert.equal(plan.subject.reservationSha256, digest(r.originalState));
  assert.equal(plan.subject.recovery.archiveSha256, r.old.archiveSha256);
  assert.equal(plan.subject.recovery.evidenceSha256, r.old.evidenceSha256);
  assert.equal(r.calls.length, 0);
  await assert.rejects(productionPlan({ round: "r21", stateDir: r.h.base, collect: true }, { repo: r.h.repo, run: localGit(r) }), /measured integrated/);
  r.h.change((s) => { s.archiveSha256 = "a".repeat(64); });
  assert.notEqual((await productionPlan(options, { repo: r.h.repo, run: localGit(r) })).approvalSha256, plan.approvalSha256);
});

test("dbe retirement admits only the exact catalog attempt's existing custody roots", () => {
  assert.ok(JSON.stringify(retirement.failedNativeRoots(dbeAttempt)) === JSON.stringify([
    "/bench/campaign", "/bench/repo/bench/catalog/results/c21"]));
});

test("dbe retirement retains failed and incomplete native bytes without execution or qualification", async (t) => {
  const r = await recoveryHarness(t, {}, "catalog-page", dbeAttempt.commit);
  assert.equal(await r.task({ inspect: () => assert.fail("native validation forbidden") }).retireFailedNative(), 1);
  const saved = r.h.saved(), receipt = retirement.verifyFailedNativeRetirement(r.h.local, saved);
  assert.equal(saved.commit, dbeAttempt.commit); assert.equal(saved.fullGroupQualified, false);
  assert.equal(saved.status, "retired"); assert.equal(saved.retirement.kind, "native-failed"); assert.ok(saved.destroyedAt);
  for (const key of ["validation", "exitCode", "collectedAt", "evidenceOutcome"]) assert.equal(saved[key], undefined);
  assert.equal(digest(readFileSync(join(r.h.local, "failed-native-reservation.json"))), digest(r.originalState));
  assert.equal(digest(readFileSync(join(r.h.local, "failed-native-results.tgz"))), digest(r.custodyArchive));
  assert.equal(saved.archiveSha256, r.old.archiveSha256); assert.equal(saved.evidenceSha256, r.old.evidenceSha256);
  assert.equal(treeHash(join(r.h.local, saved.evidence)), r.oldTree);
  assert.equal(readFileSync(join(r.h.local, receipt.capture.evidence, "campaign/root-1/failed-load.json"), "utf8"),
    '{"exitCode":99,"timeouts":6,"targets":[]}\n');
  assert.equal(r.h.deletes, 1); assert.equal(r.probes, 3);
  assert.equal(await r.task().retireFailedNative(), 1); assert.equal(r.h.deletes, 1); assert.equal(r.probes, 3);
  assert.ok(!r.calls.some(([binary, ...args]) => binary === "ssh" && /systemctl (?:start|stop|restart)/.test(args.at(-1))));
});

test("dbe retirement refuses partial, ambiguous, running and foreign-host custody observations", async (t) => {
  const proofs = [() => ({ custody: true }), (proof) => [proof, proof],
    () => ({ schema: "benchmark-failed-native-host/v1", custody: false }),
    (proof) => ({ ...proof, hostId: "620052966" }), (proof) => ({ ...proof, unit: "foreign.service" }),
    (proof) => ({ ...proof, roots: proof.roots.slice(1) })];
  for (const nativeProof of proofs) {
    const r = await recoveryHarness(t, { nativeProof }, "catalog-page", dbeAttempt.commit);
    await assert.rejects(r.task().retireFailedNative());
    assert.equal(r.h.deletes, 0); assert.equal(r.h.saved().deletionIntentAt, undefined);
  }
});

test("dbe retirement keeps archive, extraction, identity and final-fence refusal gates", async (t) => {
  for (const mode of ["missing-archive", "old-archive", "old-tree", "missing-extraction", "partial-state", "badDownload", "badFinal", "badFence", "final-custody", "account", "provider-host"]) {
    const flags = { [mode]: true }, r = await recoveryHarness(t, flags, "catalog-page", dbeAttempt.commit);
    if (mode === "missing-archive") r.h.change((s) => { delete s.archiveSha256; });
    if (mode === "old-archive") writeFileSync(join(r.h.local, "results.tgz"), "changed");
    if (mode === "old-tree") writeFileSync(join(r.h.local, r.old.evidence, "run.log"), "changed");
    if (mode === "missing-extraction") r.h.change((s) => { delete s.evidence; });
    if (mode === "partial-state") r.h.change((s) => { delete s.ip; });
    if (mode === "final-custody") flags.finalHook = () => writeFileSync(join(r.h.local, "failed-native-results.tgz"), "changed");
    if (mode === "account") flags.accountId = "foreign-account";
    if (mode === "provider-host") r.h.hosts([{ id: Number(dbeAttempt.id), name: "foreign-host" }]);
    await assert.rejects(r.task().retireFailedNative(), undefined, mode);
    assert.equal(r.h.deletes, 0, mode); assert.equal(r.h.saved().deletionIntentAt, undefined, mode);
  }
});

test("dbe retirement requires original failure and a terminal campaign even with resealed local fixtures", async (t) => {
  for (const mode of ["success", "running", "wrong-source", "wrong-group", "wrong-round", "ambiguous-campaign"]) {
    const r = await recoveryHarness(t, {}, "catalog-page", dbeAttempt.commit), extracted = join(r.h.local, r.old.evidence);
    const dir = join(extracted, "campaign", campaign), planPath = join(dir, "plan.json"), resultPath = join(dir, "campaign-result.json");
    const plan = JSON.parse(readFileSync(planPath)), result = JSON.parse(readFileSync(resultPath));
    if (mode === "success") writeFileSync(join(extracted, "exit-code"), "0\n");
    if (mode === "running") result.status.state = "active";
    if (mode === "wrong-source") plan.commit = "a".repeat(40);
    if (mode === "wrong-group") plan.order = ["json-api"];
    if (mode === "wrong-round") plan.round = "r22";
    if (mode === "ambiguous-campaign") mkdirSync(join(extracted, "campaign/r21-0000000000000000"));
    writeFileSync(planPath, JSON.stringify(plan)); writeFileSync(resultPath, JSON.stringify(result));
    r.h.change((s) => { s.evidenceSha256 = treeHash(extracted); });
    await assert.rejects(r.task().retireFailedNative(), undefined, mode);
    assert.equal(r.h.deletes, 0, mode); assert.equal(r.probes, 0, mode);
  }
});

test("dbe retirement uncertain deletion never permits a second DELETE", async (t) => {
  for (const mode of ["deleteUnconfirmed", "deleteLost", "deleteError", "deleteRejected"]) {
    const r = await recoveryHarness(t, { [mode]: true }, "catalog-page", dbeAttempt.commit);
    await assert.rejects(r.task().retireFailedNative()); assert.equal(r.h.deletes, 1, mode);
    if (["deleteUnconfirmed", "deleteError"].includes(mode)) await assert.rejects(r.task().retireFailedNative());
    r.h.hosts([]); assert.equal(await r.task().retireFailedNative(), 1);
    assert.equal(r.h.deletes, 1, mode); assert.equal(r.h.saved().fullGroupQualified, false);
  }
});

test("dbe retirement approval is source-, reservation- and archive-bound with no ordinary collection override", async (t) => {
  const r = await recoveryHarness(t, {}, "catalog-page", dbeAttempt.commit);
  const options = { round: "r21", stateDir: r.h.base, retireFailedNative: true };
  const plan = await productionPlan(options, { repo: r.h.repo, run: localGit(r) });
  assert.equal(plan.subject.recovery.measuredCommit, dbeAttempt.commit);
  assert.equal(plan.subject.recovery.policy, "r21-dbe-exact-catalog-attempt-custody-only-no-qualification");
  assert.equal(plan.subject.reservationSha256, digest(r.originalState));
  assert.equal(plan.subject.recovery.archiveSha256, r.old.archiveSha256);
  assert.equal(plan.subject.recovery.evidenceSha256, r.old.evidenceSha256);
  assert.equal(r.calls.length, 0, "approval preview must not contact provider or host");
  await assert.rejects(productionPlan({ round: "r21", stateDir: r.h.base, collect: true }, { repo: r.h.repo, run: localGit(r) }), /measured integrated/);
  for (const change of [{ archiveSha256: "a".repeat(64) }, { id: "620052966" }]) {
    r.h.change((s) => Object.assign(s, change));
    if (change.id) await assert.rejects(productionPlan(options, { repo: r.h.repo, run: localGit(r) }));
    else assert.notEqual((await productionPlan(options, { repo: r.h.repo, run: localGit(r) })).approvalSha256, plan.approvalSha256);
  }
});

const python = process.platform === "win32" ? "python" : "python3";
const pythonAvailable = spawnSync(python, ["--version"], { encoding: "utf8", timeout: 3000, windowsHide: true }).status === 0;
test("dbe retirement emitted unit gate rejects active, restartable, live-PID, partial and ambiguous units", { skip: !pythonAvailable }, async (t) => {
  const r = await recoveryHarness(t, {}, "catalog-page", dbeAttempt.commit), script = retirement.failedNativeScript(r.old);
  // Execute the emitted systemd checks only, with synthetic command output.
  // No systemd, metadata, filesystem custody or cloud operations run here.
  const start = script.indexOf("    properties = "), end = script.indexOf("    assert json.loads(command(['cloud-init'");
  assert.ok(start > 0 && end > start);
  const fixture = `import json, sys
c = json.load(sys.stdin)
unit = c['unit']
rows = dict(Id=unit, LoadState='loaded', FragmentPath='/etc/systemd/system/' + unit,
    ActiveState='inactive', Restart='no', MainPID='0', Job='', ExecMainCode='1', ExecMainStatus='2', ExecMainStartTimestamp='started')
rows.update(c['changes'])
lines = [k + '=' + v for k, v in rows.items()]
if c['mode'] == 'partial': lines.pop()
if c['mode'] == 'ambiguous': lines[-1] = lines[0]
def command(args):
    return '\\n'.join(lines) if args[1] == 'show' else c.get('jobs', '')
def observe():
${script.slice(start, end)}
try:
    observe()
    print('accepted')
except AssertionError:
    print('refused')
`;
  for (const [mode, changes, jobs] of [["inactive", {}], ["failed", { ActiveState: "failed" }], ["active", { ActiveState: "active" }],
    ["restart", { Restart: "always" }], ["pid", { MainPID: "1" }], ["job", { Job: "1" }], ["jobs", {}, "pending"],
    ["partial", {}], ["ambiguous", {}], ["foreign", { Id: "foreign.service" }], ["success", { ExecMainStatus: "0" }]]) {
    const output = spawnSync(python, ["-c", fixture], { input: JSON.stringify({ unit: r.old.unit, mode, changes, jobs }),
      encoding: "utf8", timeout: 3000, maxBuffer: 16384, windowsHide: true });
    assert.equal(output.status, 0, mode); assert.equal(output.stderr, "", mode);
    assert.equal(output.stdout.trim(), ["inactive", "failed"].includes(mode) ? "accepted" : "refused", mode);
  }
});
