import assert from "node:assert/strict";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { accountId, archive, commit, context, harness, metadata, syntheticInspection } from "./cloud-fixtures.mjs";
import { fleetPlan, reservation, tags } from "./cloud-contract.mjs";
import { controlRequest, guardianSha256 } from "./cloud-control-runtime.mjs";
import { digest, extractArchive, treeHash } from "./cloud-local.mjs";
import { productionMain, productionPlan } from "./cloud-production.mjs";
import { remoteFiles } from "./cloud-remote.mjs";
import { verifyFailedNativeRetirement } from "./cloud-retirement.mjs";
import { shellTransport } from "./cloud-transport.mjs";
import { deploymentSha256 } from "./deployments.mjs";
import { fleetChildOptions, readFleet, readGroup, verifyFleet } from "./fleet-verify.mjs";
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
  const json = group === "json-api", { preplan, handoff } = flags;
  const closed = json || handoff, phase = closed ? "closed" : "invalid";
  const single = preplan || handoff;
  const fleetGroup = single ? join(`${group}--${round}`, group) : flags.fleetLayout ? group : undefined;
  const h = harness(t, { ...flags, round, fleetGroup });
  if (fleetGroup) mkdirSync(h.base, { recursive: true });
  h.seed();
  const root = dirname(h.base);
  const region = json ? "blr1" : "sfo3";
  const child = fleetPlan({ round, commit, token: "a".repeat(16), sshKey: "42", provider: { accountId, context },
    tokens: single ? { [group]: "1".repeat(16) } : Object.fromEntries(h.saved().selection.groups.map(({ group }, index) => [group, String(index).padStart(16, "0")])) },
  "2026-11-21T00:00:00.000Z", "sfo3", { stagedPlacement: !flags.fleetLayout || single,
    ...(single ? { single: { group, indexSha256: "b".repeat(64), checkout: h.repo } } : {}) });
  if (fleetGroup) writeFileSync(join(root, `fleet-${round}.json`), JSON.stringify(child));
  const token = child.jobs.find((j) => j.group === group).token;
  const saved = { ...h.saved(), ...reservation({ round, commit, token, group, fleet: child,
    ...(!fleetGroup ? { remainingPlacement: { region, intentSha256: "a".repeat(64) } } : {}) }), provider: child.provider, status: "running",
    ...(!flags.legacyKey ? { launchHostKeySha256: digest(establishedKey) } : {}) };
  const binding = { round, commit, token, helperSha256: guardianSha256 };
  const reg = { ...structuredClone(registration), binding,
    host: { ...registration.host, hostname: flags.foreignHostname ? "different-host" : saved.name } };
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
  put("monitor-local-closed.json", { binding, id: reg.id, code: closed ? 0 : 255, signal: null, remoteDrained: false,
    closedAtMs, recoverAfterMs: closedAtMs + 2 * streamLimits.leaseMs });
  put(closed ? "monitor-terminal.json" : "monitor-invalid.json", { binding, id: reg.id, ...(closed
    ? { localClosed: true, remoteDrained: false, nativeTerminal: true, campaign, sealSha256: digest("synthetic seal") }
    : { publicationRevoked: true, remoteTerminal: false }) });
  if (!closed) {
    writeFileSync(join(h.local, "operation.lock"), retainedOperation);
    writeFileSync(join(h.base, ".groups-launch.lock"), flags.foreignLock ? "{}" : retainedLaunch);
  }
  const sibling = join(h.base, "sibling.lock"); writeFileSync(sibling, "sibling stays locked");
  writeFileSync(join(h.local, "known_hosts"), flags.replaceKey ? "synthetic replacement\n" : establishedKey);

  const mainRoot = json ? "bench/json-api/results/j75" : handoff ? `bench/marketplace/results/${round}` : "bench/fullstack-browser/work/w37";
  const outputRoots = json ? ["bench/json-api/results/j74", mainRoot] : [mainRoot];
  const plan = { schema: "benchmark-isolated-group-campaign/v1", round, commit, order: [group],
    bindings: [{ campaignMode: json ? "dedicated-blr1" : "dedicated", request: { group, round: json ? "j75" : handoff ? round : "w37", commit },
      validation: { artifactRoot: mainRoot } }] };
  plan.campaignSha256 = deploymentSha256(plan);
  const attempt = { schema: "benchmark-isolated-campaign-reservation/v1", id: campaign, commit, campaignSha256: plan.campaignSha256 };
  const status = { schema: "benchmark-isolated-campaign-status/v1", state: closed ? "finished" : "preserved-uncertain", round,
    campaign, campaignSha256: plan.campaignSha256, controllerReady: false, isolation: "unverified", executionVersion: 5,
    outcomes: [{ group, outcome: flags.lateSealFailure ? "native-validated" : json ? "failed" : "preserved-uncertain" }],
    uncollectedNativeRoots: json || flags.lateSealFailure ? [] : [{ group, phase: "timing", artifactRoot: flags.foreignPath ?? mainRoot }] };
  const entries = [{ name: "campaign/" }, ...(preplan ? [] : [{ name: "campaign/.host-attempt.json", body: JSON.stringify(attempt) },
    { name: `campaign/${campaign}/` }, { name: `campaign/${campaign}/plan.json`, body: JSON.stringify(plan) },
    { name: `campaign/${campaign}/campaign-result.json`, body: JSON.stringify({ status, wholeHostTerminal: "parent-must-observe", deletionAuthorized: false }) },
    ...(closed ? [{ name: `campaign/${campaign}/control-stream-seal.json`, body: "synthetic seal" }] : [])])];
  const wrapperFiles = metadata().map((e) => e.name === "exit-code" ? { ...e, body: "2\n" } : e);
  if (preplan) {
    const line = remoteFiles(saved)["job.sh"].split("\n").lastIndexOf("bootstrap_stage=native-entry") + 2;
    wrapperFiles[0].body += `benchmark job failed: stage=native-entry line=${line} exit=2\n`;
  }
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
    if (preplan && ["ssh", "scp"].includes(binary)) {
      assert.ok(existsSync(join(h.local, "stream-recovery.lock")));
      assert.ok(binary === "ssh" ? script.includes("CORTEN_FAILED_NATIVE_HOST") : args.at(-2).endsWith(":/bench/failed-native-custody.tgz"));
    }
    if (binary === "ssh" && script.includes("pack.sh") && !script.includes("CORTEN_FAILED_NATIVE_HOST")) {
      assert.equal(phase, "closed", "an invalid monitor must never repack the wrapper");
      assert.ok(script.includes("grep -qx '[01]'"), "absent raw-2 wrappers must not be synthesized");
    }
    if (binary === "ssh" && script.includes("CORTEN_FAILED_NATIVE_HOST")) {
      probes++;
      assert.ok(args.includes("StrictHostKeyChecking=yes"));
      assert.ok(outputRoots.every((root) => script.includes(`/bench/repo/${root}`)));
      assert.ok(script.includes(reg.host.bootId));
      if (flags.refuseFirstProbe && probes === 1) {
        const id = rest[3].request.invocation.id;
        return shellTransport({ repo: h.repo, spawn: () => ({ status: 1, stdout: "",
          stderr: `CORTEN_CONTROL ${id} ${"a".repeat(64)}\nCORTEN_RESULT ${id} 1\n` }) })(binary, args, ...rest);
      }
      if (flags.busyFence && probes === 3) return { status: 1, stdout: "" };
      return { status: 0, stdout: JSON.stringify({ schema: "benchmark-failed-native-host/v1", custody: true,
        historicalAccountingQualified: false, hostId: saved.id, unit: saved.unit, roots,
        metadataSha256: flags.rehashDrift && probes === 2 ? digest("synthetic changed inventory") : metadataSha256,
        snapshotSha256: digest(snapshot), archiveSha256: digest(custody), observedAtMs: Date.now() }) };
    }
    if (binary === "scp" && args.at(-2).endsWith(":/bench/failed-native-custody.tgz")) {
      custodyDownloads++;
      writeFileSync(script, flags.corruptCustody ? "bad download" : custody);
      return { status: 0, stdout: "" };
    }
    if (binary === "doctl" && args[2] === "delete") {
      deleteExpiry = rest[2];
      if (flags.uncertainDelete) {
        try { return h.run(binary, args, ...rest); }
        catch (error) { throw Object.assign(error, { controlUncertain: true }); }
      }
    }
    return h.run(binary, args, ...rest);
  };
  return { h, root, sibling, wrapper, custody, roots, run, get probes() { return probes; }, get downloads() { return custodyDownloads; },
    get deleteExpiry() { return deleteExpiry; }, task: (deps = {}, options) => h.task({ run,
      inspect: () => assert.fail("native replay must not decide custody"), ...deps }, options) };
}

function singleFixture(t, flags, group) {
  const f = fixture(t, group, flags);
  const { h, root, wrapper } = f, options = { round, stateDir: h.base, retireFailedNative: true };
  const fleet = readFleet(root, round), child = fleetChildOptions(fleet, group, "detach");
  const job = { action: "detach", stateRoot: child.stateDir, controllerCommit: commit, options: child, fleetSha256: fleet.manifestSha256 };
  const subject = { schema: "benchmark-group-fleet-staged-approval/v1", action: "detach", controllerCommit: commit,
    stateRoot: root, requestedRoot: root, round, manifestSha256: fleet.manifestSha256, fleet: fleet.manifest, records: {},
    admission: { mode: "first-group-only", firstGroup: group, gate: "collected-verified-deleted", nativeReadiness: false },
    jobs: [{ group, outcome: "planned", missing: [], options: child, subject: job, approvalSha256: digest(JSON.stringify(job)) }] };
  const intentPath = join(root, "launch-intent.json"), intent = { schema: "benchmark-group-fleet-staged-launch-intent/v1", subject,
    approvalSha256: digest(JSON.stringify(subject)) };
  writeFileSync(intentPath, JSON.stringify(intent));
  // A synthetic earlier download has already preserved the original wrapper and extraction.
  const archivePath = join(h.local, "results.tgz"), evidence = "evidence-preplan", extracted = join(h.local, evidence);
  const preserveWrapper = async () => {
    const archiveSha256 = digest(wrapper);
    writeFileSync(archivePath, wrapper, { flag: "wx" }); mkdirSync(extracted);
    const evidenceSha256 = await extractArchive(archivePath, extracted, archiveSha256);
    h.change(s => Object.assign(s, { archiveSha256, evidenceSha256, evidence, extractionAttempts: [evidence] }));
  };
  const repairCommit = "c".repeat(40);
  const preview = (changedRegistry = false) => productionPlan(options, { repo: h.repo, async run(binary, args) {
    assert.equal(binary, "git", "preview must be local");
    let stdout = "";
    if (args[0] === "rev-parse") stdout = args[1] === "HEAD" ? repairCommit : h.repo;
    else if (args[0] === "show") {
      const [source, path] = args[1].split(":");
      assert.ok([commit, repairCommit].includes(source));
      stdout = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
      if (changedRegistry && source === commit && path.endsWith("/registry.mjs")) stdout += "\n// changed measured registry\n";
    } else if (args[0] === "merge-base") assert.deepEqual(args, ["merge-base", "--is-ancestor", commit, repairCommit]);
    else assert.ok(["cat-file", "status"].includes(args[0]));
    return { status: 0, stdout };
  } });
  const retire = (approved, change = {}) => f.task({ recoveryApproval: { controllerCommit: approved.subject.controllerCommit,
    reservationSha256: approved.subject.reservationSha256, ...approved.subject.recovery, ...change },
    async authorizeAudit() {
      assert.ok(existsSync(join(h.local, "stream-recovery.lock")));
      const current = await preview();
      assert.equal(current.approvalSha256, approved.approvalSha256, "locked action changed after approval");
      return current.subject;
    } }, { ...options, collect: undefined }).retireFailedNative();
  return { ...f, get probes() { return f.probes; }, get downloads() { return f.downloads; }, get deleteExpiry() { return f.deleteExpiry; },
    intent, intentPath, preview, preserveWrapper, retire, repairCommit };
}

const preplanFixture = (t, flags) => singleFixture(t, { ...flags, preplan: true }, "fullstack-browser");

async function handoffFixture(t, flags = {}) {
  const f = singleFixture(t, { ...flags, handoff: true, lateSealFailure: true }, "localized-marketplace");
  assert.equal(await f.task().collect(), 3);
  const { h, repairCommit } = f, args = [round, "--state-dir", h.base, "--retire-failed-native"];
  const launched = [], knobs = {};
  let approval;
  const deps = { repo: h.repo, sleep: async () => {}, inspect: () => assert.fail("handoff retirement cannot validate native timing"),
    write: (line) => { approval = JSON.parse(line); },
    spawn(binary, argv, options) {
      if (binary === "git") {
        const [verb, name, subject] = argv;
        if (verb === "rev-parse") return { status: 0, stdout: name === "HEAD" ? repairCommit : h.repo };
        if (verb === "ls-remote") return { status: 0, stdout: `${repairCommit}\trefs/heads/main\n` };
        if (verb === "merge-base" && subject === repairCommit && knobs.unmerged) return { status: 1, stdout: "" };
        if (verb === "show") {
          const [source, file] = name.split(":");
          assert.ok([commit, repairCommit].includes(source));
          let stdout = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
          if (source === commit && file.endsWith("/registry.mjs") && knobs.sourceDrift) stdout += "\n// changed measured registry\n";
          if (source === repairCommit && knobs.lockedDrift && existsSync(join(h.local, "operation.lock"))) {
            knobs.lockedDrift = false;
            writeFileSync(f.intentPath, readFileSync(f.intentPath, "utf8") + "\n");
          }
          return { status: 0, stdout };
        }
        assert.ok(["cat-file", "merge-base", "status", "fetch"].includes(verb));
        return { status: 0, stdout: "" };
      }
      launched.push([binary]);
      assert.equal(binary, "ssh", "handoff recovery must not transfer or repack");
      assert.ok(existsSync(join(h.local, "operation.lock")));
      const request = h.saved().control.ledger.at(-1).request, id = request.invocation.id;
      const parts = [...argv];
      parts[parts.length - 1] = options.input.slice(JSON.stringify(request).length)
        .replace(/^set -euo pipefail\n/, "").replace(/\n$/, "");
      const result = f.run(binary, parts, options.timeout);
      if (f.probes === 3) {
        knobs.expire?.();
        knobs.finalFence?.();
      }
      return { ...result, stderr: `CORTEN_CONTROL ${id} ${"a".repeat(64)}\nCORTEN_RESULT ${id} ${result.status}\n` };
    },
    providerFactory: ({ createMode }) => Object.assign((argv, timeout, allowFail, expiry) => {
      assert.equal(createMode, null); launched.push(["provider", ...argv]);
      if (argv[0] === "account" && h.saved().deletionIntentAt) knobs.dispatchAccount?.();
      if (argv[2] === "get" && h.saved().deletionIntentAt) knobs.exactRead?.();
      if (knobs.failExactRead && argv[2] === "get")
        return { status: 1, providerDiagnostic: { code: "get-http", httpStatus: 500 } };
      if (argv[2] === "delete") {
        assert.ok(Number.isSafeInteger(expiry) && Date.now() < expiry && expiry - Date.now() <= 60000);
        assert.ok(existsSync(join(h.local, "failed-native-host.json")));
      }
      return f.run("doctl", argv, timeout, allowFail, expiry);
    }, { close: async () => { knobs.close?.(); } }),
  };
  return { f, launched, knobs,
    async preview() { assert.equal(await productionMain([...args, "--print-approval"], deps), 3); return approval; },
    retire: (approved) => productionMain([...args, "--approve-reviewed-merged-ready", approved.approvalSha256], deps) };
}

test("approved handoff retirement reuses an exact ordinary capture and reconciles only exact absence", async (t) => {
  const { f, preview, retire, knobs, launched } = await handoffFixture(t, { deleteLost: true });
  const { h } = f, held = ["results.tgz", "failed-native-results.tgz", "failed-native-reservation.json", "failed-native-capture.json"]
    .map(name => [join(h.local, name), readFileSync(join(h.local, name))]);
  assert.equal(f.probes, 1); assert.equal(f.downloads, 1); assert.equal(h.deletes, 0);
  const p = await preview();
  assert.equal(p.controllerCommit, f.repairCommit);
  assert.equal(p.recovery.captureControllerCommit, commit);
  assert.equal(p.recovery.captureSha256, digest(held.at(-1)[1]));
  assert.deepEqual(p.recovery.provider, { accountId, context });
  assert.equal(p.recovery.hostId, h.saved().id);
  assert.deepEqual(launched, []);
  await assert.rejects(retire(p), /acknowledgement lost/);
  const saved = h.saved(), receipt = verifyFailedNativeRetirement(h.local, saved);
  assert.equal(receipt.handoff.controllerCommit, f.repairCommit);
  assert.equal(receipt.handoff.captureSha256, p.recovery.captureSha256);
  assert.equal(receipt.handoff.launchIntentSha256, p.recovery.intent.launch);
  assert.equal(receipt.capture.controllerCommit, commit);
  assert.equal(saved.status, "retired"); assert.equal(saved.destroyedAt, undefined);
  assert.equal(saved.fullGroupQualified, false);
  assert.ok(["validation", "exitCode", "collectedAt", "evidenceOutcome"].every(k => saved[k] === undefined));
  assert.equal(f.probes, 3); assert.equal(f.downloads, 1); assert.equal(h.deletes, 1);
  for (const [path, bytes] of held) assert.deepEqual(readFileSync(path), bytes);
  const calls = launched.length;
  knobs.failExactRead = true;
  await assert.rejects(retire(await preview()), /exact host observation failed/);
  assert.equal(h.saved().destroyedAt, undefined);
  knobs.failExactRead = false;
  assert.equal(await retire(await preview()), 1);
  const reconciliation = launched.slice(calls);
  assert.ok(reconciliation.some(([, a, b, c, id]) => a === "compute" && b === "droplet" && c === "get" && id === saved.id));
  assert.ok(reconciliation.every(([binary, a, b, c]) => binary === "provider" && (a === "account" && b === "get" || a === "compute" && b === "droplet" && c === "get")));
  assert.ok(h.saved().destroyedAt); assert.equal(h.deletes, 1); assert.equal(f.probes, 3);
  const fleet = await verifyFleet({ root: f.root, round, commit },
    { inspect: () => assert.fail("handoff retirement is not a benchmark result") });
  assert.equal(fleet.error, undefined);
  assert.equal(fleet.groups[0].outcome, "native-failed-retired"); assert.equal(fleet.publishableBaseline, false);
  const receiptPath = join(h.local, "failed-native-host.json"), bytes = readFileSync(receiptPath), finalState = h.saved();
  for (const tamper of [proof => { proof.capture.scriptSha256 = "e".repeat(64); },
    proof => { proof.rehash.scriptSha256 = "e".repeat(64); }, proof => { proof.scriptSha256 = "e".repeat(64); }]) {
    const proof = JSON.parse(bytes); tamper(proof);
    const changed = JSON.stringify(proof);
    writeFileSync(receiptPath, changed);
    assert.throws(() => verifyFailedNativeRetirement(h.local, { ...finalState,
      retirement: { ...finalState.retirement, evidenceSha256: digest(changed) } }), /capture|script/);
  }
  writeFileSync(receiptPath, bytes);
  writeFileSync(f.intentPath, readFileSync(f.intentPath, "utf8") + "\n");
  assert.throws(() => verifyFailedNativeRetirement(h.local, finalState), /handoff launch intent changed/);
});

test("handoff approval refuses missing, mismatched or mutated capture evidence before host access", async (t) => {
  const { f, preview, retire, launched } = await handoffFixture(t);
  const { h } = f, approval = await preview();
  for (const [name, error] of [
    ["failed-native-reservation.json", /failed-native-reservation/],
    ["failed-native-capture.json", /failed-native-capture/],
  ]) {
    const path = join(h.local, name), bytes = readFileSync(path);
    unlinkSync(path);
    await assert.rejects(preview(), error);
    writeFileSync(path, bytes);
  }
  const path = join(h.local, "failed-native-capture.json"), bytes = readFileSync(path);
  for (const [key, value, error] of [
    ["controllerCommit", f.repairCommit, /capture must come from the measured controller/],
    ["scriptSha256", "e".repeat(64), /original handoff capture script changed/],
  ]) {
    writeFileSync(path, JSON.stringify({ ...JSON.parse(bytes), [key]: value }));
    await assert.rejects(preview(), error);
  }
  writeFileSync(path, Buffer.concat([bytes, Buffer.from("\n")]));
  await assert.rejects(retire(approval), /operator-approved exact action/);
  writeFileSync(path, bytes);
  for (const [name, error] of [["results.tgz", /original failed archive changed/],
    ["failed-native-results.tgz", /custody archive changed/]]) {
    const archivePath = join(h.local, name), original = readFileSync(archivePath);
    unlinkSync(archivePath);
    await assert.rejects(retire(approval), { code: "ENOENT" });
    writeFileSync(archivePath, "synthetic tamper");
    await assert.rejects(retire(approval), error);
    writeFileSync(archivePath, original);
  }
  assert.deepEqual(launched, []);
  assert.equal(h.saved().deletionIntentAt, undefined); assert.equal(f.probes, 1); assert.equal(f.downloads, 1);
});

test("handoff refuses retained locks, foreclosure, unmerged source and locked approval drift", async (t) => {
  const { f, knobs, preview, retire, launched } = await handoffFixture(t);
  const { h } = f, approval = await preview();
  for (const path of [join(h.local, "operation.lock"), join(h.local, "stream-recovery.lock"), join(h.local, "audit-delivery.lock"),
    join(h.base, ".groups-launch.lock"), join(f.root, ".fleet-operation.lock"),
    join(dirname(f.root), ".continuation-operation.lock")]) {
    writeFileSync(path, retainedOperation);
    await assert.rejects(retire(approval), /competing or retained custody/);
    assert.equal(readFileSync(path, "utf8"), retainedOperation);
    unlinkSync(path);
  }
  for (const name of ["monitor-invalid.json", "state.json.revoked-dead.tmp", "failed-native-host.json"]) {
    const path = join(h.local, name);
    writeFileSync(path, "{}");
    await assert.rejects(preview(), /foreclosed|unsettled/);
    unlinkSync(path);
  }
  knobs.sourceDrift = true;
  await assert.rejects(retire(approval), /measured group layout or remote job differs/);
  knobs.sourceDrift = false; knobs.unmerged = true;
  await assert.rejects(retire(approval), /control process failed/);
  knobs.unmerged = false; knobs.lockedDrift = true;
  await assert.rejects(retire(approval), /locked action changed after approval/);
  assert.deepEqual(launched, []);
  assert.equal(h.saved().deletionIntentAt, undefined); assert.equal(h.deletes, 0);
});

test("handoff refuses changed remote custody, a busy guest, or an expired final proof without DELETE", async (t) => {
  const changed = await handoffFixture(t, { rehashDrift: true });
  await assert.rejects(changed.retire(await changed.preview()), /predelete custody differs/);
  assert.equal(changed.f.probes, 2); assert.equal(changed.f.h.deletes, 0);
  assert.equal(changed.f.h.saved().deletionIntentAt, undefined);
  const busy = await handoffFixture(t, { busyFence: true });
  await assert.rejects(busy.retire(await busy.preview()), /control process failed/);
  assert.equal(busy.f.probes, 3); assert.equal(busy.f.h.deletes, 0);
  assert.equal(busy.f.h.saved().deletionIntentAt, undefined);
  const expiry = await handoffFixture(t);
  const approved = await expiry.preview(), realNow = Date.now;
  let offset = 0;
  const clock = t.mock.method(Date, "now", () => realNow() + offset);
  expiry.knobs.expire = () => { offset = 60001; };
  try { await assert.rejects(expiry.retire(approved), /current retirement proof expired/); }
  finally { clock.mock.restore(); }
  assert.equal(expiry.f.probes, 3); assert.equal(expiry.f.h.deletes, 0);
  assert.equal(expiry.f.h.saved().deletionIntentAt, undefined);
});

test("handoff refuses a byte-only capture change during the final fence before intent", async (t) => {
  const { f, knobs, preview, retire } = await handoffFixture(t);
  const { h } = f, path = join(h.local, "failed-native-capture.json"), approved = await preview();
  const changed = Buffer.concat([readFileSync(path), Buffer.from("\n")]);
  knobs.finalFence = () => appendFileSync(path, "\n");
  const error = await retire(approved).catch(e => e);
  assert.equal(h.deletes, 0);
  assert.equal(h.saved().deletionIntentAt, undefined);
  assert.ok(!existsSync(join(h.local, "failed-native-host.json")));
  assert.deepEqual(readFileSync(path), changed);
  assert.equal(f.probes, 3);
  assert.match(error?.message ?? "", /approved original handoff capture changed/);
});

test("handoff refuses a same-byte operation lock replacement during the final fence and preserves it", async (t) => {
  const { f, knobs, preview, retire } = await handoffFixture(t);
  const { h } = f, path = join(h.local, "operation.lock"), moved = join(h.temp, "moved-operation-lock"), approved = await preview();
  let replacement;
  knobs.finalFence = () => {
    renameSync(path, moved);
    writeFileSync(path, readFileSync(moved), { flag: "wx" });
    replacement = lstatSync(path, { bigint: true });
    assert.notEqual(replacement.ino, lstatSync(moved, { bigint: true }).ino);
  };
  const error = await retire(approved).catch(e => e);
  assert.deepEqual({ deletes: h.deletes, intent: !!h.saved().deletionIntentAt, replacementKept: existsSync(path) },
    { deletes: 0, intent: false, replacementKept: true });
  assert.ok(!existsSync(join(h.local, "failed-native-host.json")));
  assert.equal(lstatSync(path, { bigint: true }).ino, replacement.ino);
  assert.deepEqual(readFileSync(path), readFileSync(moved));
  assert.equal(f.probes, 3);
  assert.match(error?.message ?? "", /handoff operation lock changed/);
});

test("handoff refuses capture drift across the last production dispatch checkpoint", async (t) => {
  const { f, knobs, preview, retire } = await handoffFixture(t);
  const { h } = f, path = join(h.local, "failed-native-capture.json"), approved = await preview();
  knobs.dispatchAccount = () => {
    delete knobs.dispatchAccount;
    // The account-return checkpoint crosses two turns. Mutate in the next
    // turn, after the controller's local check but before worker dispatch.
    setImmediate(() => setImmediate(() => setImmediate(() => appendFileSync(path, "\n"))));
  };
  await assert.rejects(retire(approved), /approved original handoff capture changed/);
  assert.equal(h.deletes, 0);
  assert.ok(h.saved().deletionIntentAt, "the already written intent is retained");
  assert.equal(h.saved().destroyedAt, undefined);
  assert.equal(f.probes, 3);
});

test("handoff refuses a custody archive append during the final account check", async (t) => {
  const { f, knobs, preview, retire } = await handoffFixture(t);
  const { h } = f, path = join(h.local, "failed-native-results.tgz"), approved = await preview();
  knobs.dispatchAccount = () => {
    delete knobs.dispatchAccount;
    appendFileSync(path, "x");
  };
  const error = await retire(approved).catch(e => e);
  assert.deepEqual({ deletes: h.deletes, destroyed: !!h.saved().destroyedAt }, { deletes: 0, destroyed: false });
  assert.ok(h.saved().deletionIntentAt);
  assert.match(error?.message ?? "", /local handoff custody changed/);
});

test("handoff refuses same-length writes, same-byte replacements and metadata drift in verified local custody", async (t) => {
  const flip = (path) => {
    const bytes = readFileSync(path);
    bytes[0] ^= 1;
    writeFileSync(path, bytes);
    assert.equal(lstatSync(path).size, bytes.length);
  };
  for (const kind of ["custody archive same length", "custody archive replacement", "original archive metadata", "reservation preimage replacement",
    "original extraction same length", "custody extraction same length"]) await t.test(kind, async (t) => {
    const { f, knobs, preview, retire } = await handoffFixture(t);
    const { h } = f, approved = await preview();
    const capture = JSON.parse(readFileSync(join(h.local, "failed-native-capture.json")));
    const change = () => {
      if (kind === "custody archive same length") {
        flip(join(h.local, "failed-native-results.tgz"));
      } else if (kind === "original archive metadata") {
        const path = join(h.local, "results.tgz"), mtime = lstatSync(path).mtimeMs;
        utimesSync(path, new Date(), new Date(mtime - 120000));
      } else if (kind === "original extraction same length") {
        flip(join(h.local, h.saved().evidence, "campaign", campaign, "plan.json"));
      } else if (kind === "custody extraction same length") {
        flip(join(h.local, capture.evidence, "campaign", "root-1", "failure.txt"));
      } else {
        const path = join(h.local, kind === "custody archive replacement" ? "failed-native-results.tgz" : "failed-native-reservation.json");
        const moved = join(h.temp, "replaced-evidence");
        renameSync(path, moved);
        writeFileSync(path, readFileSync(moved), { flag: "wx" });
        assert.notEqual(lstatSync(path, { bigint: true }).ino, lstatSync(moved, { bigint: true }).ino);
      }
    };
    if (kind === "original extraction same length") knobs.finalFence = change;
    else {
      knobs.dispatchAccount = () => {
        delete knobs.dispatchAccount;
        // Change after the controller's preliminary dispatch check.
        setImmediate(() => setImmediate(() => setImmediate(change)));
      };
    }
    await assert.rejects(retire(approved), /local handoff custody changed/);
    assert.equal(h.deletes, 0);
    assert.equal(h.saved().destroyedAt, undefined);
    assert.equal(!!h.saved().deletionIntentAt, kind !== "original extraction same length");
    assert.equal(existsSync(join(h.local, "failed-native-host.json")), kind !== "original extraction same length");
  });
});

test("handoff lost-ack retry refuses a capture append during exact absence", async (t) => {
  const { f, knobs, preview, retire } = await handoffFixture(t, { deleteLost: true });
  const { h } = f, path = join(h.local, "failed-native-capture.json");
  await assert.rejects(retire(await preview()), /acknowledgement lost/);
  const approved = await preview();
  knobs.exactRead = () => {
    delete knobs.exactRead;
    appendFileSync(path, "\n");
  };
  const error = await retire(approved).catch(e => e);
  assert.deepEqual({ deletes: h.deletes, destroyed: !!h.saved().destroyedAt }, { deletes: 1, destroyed: false });
  assert.match(error?.message ?? "", /approved original handoff capture changed/);
});

test("handoff acknowledged DELETE records exact absence only with the receipt and custody intact", async (t) => {
  for (const change of [undefined, "failed-native-host.json", "failed-native-results.tgz"]) await t.test(change ?? "intact", async (t) => {
    const { f, knobs, preview, retire } = await handoffFixture(t);
    const { h } = f, approved = await preview();
    if (change) {
      knobs.exactRead = () => {
        delete knobs.exactRead;
        appendFileSync(join(h.local, change), "\n");
      };
      await assert.rejects(retire(approved), /failed-native retirement receipt changed|local handoff custody changed/);
    } else assert.equal(await retire(approved), 1);
    assert.equal(!!h.saved().destroyedAt, change === undefined);
    assert.equal(h.deletes, 1);
    assert.equal(f.probes, 3);
    assert.equal(f.downloads, 1);
  });
});

test("handoff teardown preserves a lock replaced during provider settlement", async (t) => {
  const { f, knobs, preview, retire } = await handoffFixture(t, { busyFence: true });
  const { h } = f, path = join(h.local, "operation.lock"), moved = join(h.temp, "settling-operation-lock"), approved = await preview();
  const replacement = "synthetic replacement lock\n";
  knobs.close = () => {
    delete knobs.close;
    renameSync(path, moved);
    writeFileSync(path, replacement, { flag: "wx" });
  };
  await assert.rejects(retire(approved), /handoff operation lock changed/);
  assert.equal(h.deletes, 0);
  assert.equal(h.saved().deletionIntentAt, undefined);
  assert.equal(readFileSync(path, "utf8"), replacement);
  assert.ok(existsSync(moved));
});

test("preplan preview binds preserved wrapper, measured registry and consumed single-child intent", async (t) => {
  const f = await preplanFixture(t);
  await assert.rejects(f.preview());
  await f.preserveWrapper();
  const plan = await f.preview(), { recovery, reservationSha256 } = plan.subject;
  assert.deepEqual(plan.missing, []);
  assert.equal(recovery.policy, "grouped-preplan-failure-custody-only");
  assert.equal(reservationSha256, digest(readFileSync(f.h.statePath)));
  assert.equal(recovery.preservedReservationSha256, reservationSha256);
  assert.equal(recovery.archiveSha256, digest(f.wrapper));
  assert.equal(recovery.intent.launch, digest(readFileSync(f.intentPath)));
  await assert.rejects(f.preview(true), /measured group layout or remote job differs/);
  writeFileSync(f.intentPath, JSON.stringify({ ...f.intent, approvalSha256: "0".repeat(64) }));
  await assert.rejects(f.preview(), /fleet-intent-changed/);
  writeFileSync(f.intentPath, JSON.stringify(f.intent) + "\n");
  await assert.rejects(f.retire(plan), /locked action changed after approval/);
  assert.deepEqual(f.h.calls, []);
});

test("explicit preplan retirement preserves the preimage and reconciles a lost delete acknowledgement by exact GET only", async (t) => {
  const f = await preplanFixture(t, { deleteLost: true });
  await f.preserveWrapper();
  const plan = await f.preview(), preimage = readFileSync(f.h.statePath);
  await assert.rejects(f.retire(plan, { bootId: "foreign-boot" }), /locked recovery approval changed/);
  const preserved = join(f.h.local, "failed-native-reservation.json");
  const unbound = Buffer.concat([preimage, Buffer.from("\n")]);
  writeFileSync(preserved, unbound, { flag: "wx" });
  await assert.rejects(f.retire(plan), /locked action changed after approval/);
  await assert.rejects(f.retire(await f.preview()), /settled first custody probe refusal/);
  assert.deepEqual(readFileSync(preserved), unbound);
  unlinkSync(preserved);
  assert.deepEqual(f.h.calls, []);
  await assert.rejects(f.retire(plan), /acknowledgement lost/);
  const s = f.h.saved(), proof = verifyFailedNativeRetirement(f.h.local, s);
  assert.equal(proof.capture.scope, "grouped-preplan");
  assert.equal(proof.capture.controllerCommit, plan.subject.controllerCommit);
  assert.equal(proof.capture.reservationSha256, digest(preimage));
  assert.deepEqual(readFileSync(preserved), preimage);
  assert.deepEqual(readFileSync(join(f.h.local, "results.tgz")), f.wrapper);
  assert.deepEqual(readFileSync(join(f.h.local, "failed-native-results.tgz")), f.custody);
  assert.equal(s.status, "retired"); assert.equal(s.destroyedAt, undefined);
  assert.equal(s.fullGroupQualified, false);
  assert.equal(f.probes, 3); assert.equal(f.downloads, 1); assert.equal(f.h.deletes, 1);
  const calls = f.h.calls.length;
  assert.equal(await f.retire(await f.preview()), 1);
  const getOnly = f.h.calls.slice(calls);
  assert.ok(getOnly.some(([binary, area, name, action, id]) => binary === "doctl" && area === "compute" && name === "droplet" && action === "get" && id === s.id));
  assert.ok(getOnly.every(([binary, area, name, action]) => binary === "doctl" && (area === "account" && name === "get" || area === "compute" && name === "droplet" && action === "get")));
  assert.ok(f.h.saved().destroyedAt); assert.equal(f.h.deletes, 1);
  assert.equal(readFileSync(join(f.h.local, "operation.lock"), "utf8"), retainedOperation);
  assert.equal(readFileSync(join(f.h.base, ".groups-launch.lock"), "utf8"), retainedLaunch);
  assert.ok(!existsSync(join(f.h.local, "stream-recovery.lock")));
});

test("explicit preplan recovery preserves a live original owner or an uncertain provider lock", async (t) => {
  const f = await preplanFixture(t, { deleteLost: true, uncertainDelete: true });
  await f.preserveWrapper();
  const operation = join(f.h.local, "operation.lock"), launch = join(f.h.base, ".groups-launch.lock");
  writeFileSync(operation, JSON.stringify({ ...JSON.parse(retainedOperation), pid: process.pid }));
  writeFileSync(launch, JSON.stringify({ pid: process.pid, round }));
  await assert.rejects(f.preview(), /original monitor owner is still live or uncertain/);
  assert.deepEqual(f.h.calls, []);
  writeFileSync(operation, retainedOperation); writeFileSync(launch, retainedLaunch);
  await assert.rejects(f.retire(await f.preview()), { controlUncertain: true });
  assert.equal(f.h.saved().status, "retired");
  assert.equal(f.h.saved().destroyedAt, undefined);
  const lock = join(f.h.local, "stream-recovery.lock"), lockBytes = readFileSync(lock), calls = f.h.calls.length;
  await assert.rejects(f.retire(await f.preview()), { code: "EEXIST" });
  assert.equal(f.h.calls.length, calls);
  assert.equal(f.h.deletes, 1);
  assert.deepEqual(readFileSync(lock), lockBytes);
});

test("preplan retirement can reapprove a settled first-probe refusal without adopting partial custody", async (t) => {
  const f = await preplanFixture(t, { refuseFirstProbe: true });
  await f.preserveWrapper();
  const prior = readFileSync(f.h.statePath), initial = await f.preview();
  const original = join(f.h.local, "failed-native-reservation.json"), capture = join(f.h.local, "failed-native-capture.json");
  await assert.rejects(f.retire(initial), /preplan custody probe refused/);
  const refused = readFileSync(f.h.statePath), last = f.h.saved().control.ledger.at(-1);
  assert.equal(last.localTerminal, true); assert.equal(last.code, 1);
  assert.deepEqual(readFileSync(original), prior);
  assert.ok(!existsSync(capture));
  assert.equal(f.probes, 1); assert.equal(f.downloads, 0); assert.equal(f.h.deletes, 0);
  await assert.rejects(f.retire(initial), /locked action changed after approval/);
  const retry = await f.preview();
  assert.notEqual(retry.approvalSha256, initial.approvalSha256);
  assert.equal(retry.subject.reservationSha256, digest(refused));
  assert.equal(retry.subject.recovery.preservedReservationSha256, digest(prior));

  f.h.change(s => {
    const start = s.control.ledger[0].request.invocation;
    start.deadlineMs++;
    s.control.ledger[1].request.seal[0].sha256 = digest(JSON.stringify(start));
  });
  await assert.rejects(f.retire(await f.preview()), /original measured reservation changed/);
  for (const alter of [row => { row.request.invocation.requestSha256 = "e".repeat(64); }, row => { row.code = 0; }]) {
    writeFileSync(f.h.statePath, refused);
    f.h.change(s => alter(s.control.ledger.at(-1)));
    await assert.rejects(f.retire(await f.preview()), /settled first custody probe refusal/);
  }
  writeFileSync(f.h.statePath, refused);
  const partial = join(f.h.local, "failed-native-results.tgz.synced");
  writeFileSync(partial, "unexplained partial capture", { flag: "wx" });
  await assert.rejects(f.retire(retry), /unrecorded custody retained/);
  assert.equal(readFileSync(partial, "utf8"), "unexplained partial capture");
  unlinkSync(partial);
  assert.equal(f.probes, 1); assert.equal(f.downloads, 0); assert.equal(f.h.deletes, 0);
  assert.equal(await f.retire(retry), 1);
  assert.deepEqual(readFileSync(original), prior);
  assert.equal(JSON.parse(readFileSync(capture)).launchIntentSha256, retry.subject.recovery.intent.launch);
  assert.equal(f.probes, 4); assert.equal(f.downloads, 1); assert.equal(f.h.deletes, 1);
});

for (const group of ["fullstack-browser", "json-api"]) {
  test(`ordinary collection retires ${group} only after wrapper and complete failed native custody`, async (t) => {
    const f = fixture(t, group);
    const abandoned = join(f.h.local, "state.json.tmp");
    if (group === "fullstack-browser") writeFileSync(abandoned, "abandoned pre-revocation state", { flag: "wx" });
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
      assert.equal(readFileSync(abandoned, "utf8"), "abandoned pre-revocation state");
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

test("an old or replaced key or a foreign registration cannot authorize failed custody or DELETE", async (t) => {
  for (const [flags, reason] of [[{ replaceKey: true }, /saved host key differs from launch/],
    [{ legacyKey: true }, /no launch-established host key/], [{ foreignHostname: true }, /registered host differs/]]) {
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

test("fleet readback revisits failed retirement after replaying a later sibling", async (t) => {
  const group = "fullstack-browser", sibling = "client-heavy", f = fixture(t, group, { fleetLayout: true, deleteLost: true });
  const batchLock = join(f.root, ".fleet-operation.lock");
  const batchOwner = JSON.stringify({ pid: retiredPid, approvalSha256: "5".repeat(64) });
  writeFileSync(batchLock, batchOwner);
  const { manifest: fleet } = readFleet(f.root, round), { token } = fleet.jobs.find((job) => job.group === sibling);
  assert.ok(fleet.jobs.findIndex((job) => job.group === group) < fleet.jobs.findIndex((job) => job.group === sibling));
  const at = "2026-11-21T00:00:00.000Z", local = join(f.root, sibling, `groups-${round}`), evidence = "evidence-Synthetic";
  const state = reservation({ round, commit, token, group: sibling, fleet }, at);
  const report = syntheticInspection("verified");
  Object.assign(report, { schema: "benchmark-isolated-group-campaign-inspection/v1", round,
    campaign: `${round}-${token}`, selection: state.selection, groups: report.groups.filter((row) => row.group === sibling) });
  const extracted = join(local, evidence), folder = join(extracted, "campaign");
  mkdirSync(join(folder, report.campaign), { recursive: true });
  const attempt = JSON.stringify({ id: report.campaign, commit, campaignSha256: report.campaignSha256 });
  report.reservationSha256 = digest(attempt);
  writeFileSync(join(folder, ".host-attempt.json"), attempt);
  writeFileSync(join(folder, report.campaign, "plan.json"), JSON.stringify({ round, commit,
    campaignSha256: report.campaignSha256, sourceSha256: report.sourceSha256 }));
  writeFileSync(join(extracted, "exit-code"), "0\n");
  writeFileSync(join(extracted, "host.txt"), "synthetic sibling");
  const raw = archive([{ name: "campaign/" }]); writeFileSync(join(local, "results.tgz"), raw);
  writeFileSync(join(local, "state.json"), JSON.stringify({ ...state, provider: fleet.provider, fullGroupQualified: false, status: "collected",
    id: "800", ip: "192.0.2.80", createIntentAt: at, collectedAt: at, destroyedAt: at, deletionIntentAt: at,
    exitCode: 0, evidence, extractionAttempts: [evidence], archiveSha256: digest(raw), evidenceSha256: treeHash(extracted),
    evidenceOutcome: "validated", validation: { status: "verified", campaign: report.campaign, collectionIntegrity: "manifest-verified" } }));

  const verify = async (change) => {
    let replays = 0;
    const result = await verifyFleet({ root: f.root, round, commit }, { inspect: async (input) => {
      assert.equal(input.folder, folder); replays++; change(); return report;
    } });
    assert.equal(replays, 1);
    assert.equal(result.groups.find((row) => row.group === sibling)?.outcome, "verified");
    assert.equal(result.status, "incomplete"); assert.equal(result.fleetLock, "retained"); assert.equal(result.error, undefined);
    assert.equal(readFileSync(batchLock, "utf8"), batchOwner);
    assert.equal(readFileSync(join(f.h.local, "operation.lock"), "utf8"), retainedOperation);
    assert.equal(readFileSync(join(f.h.base, ".groups-launch.lock"), "utf8"), retainedLaunch);
    return result.groups.find((row) => row.group === group);
  };
  await assert.rejects(f.task().collect(), /acknowledgement lost/);
  const receipt = join(f.h.local, "failed-native-host.json"), bytes = readFileSync(receipt);
  assert.deepEqual(await verify(() => writeFileSync(receipt, "changed receipt")),
    { group, outcome: "uncertain", error: "group-retirement-changed" });
  assert.equal(readFileSync(receipt, "utf8"), "changed receipt");
  writeFileSync(receipt, bytes);
  assert.equal(await f.task().collect(), 1);
  const recovery = join(f.h.local, "stream-recovery.lock"), owner = JSON.stringify({ pid: process.pid });
  assert.deepEqual(await verify(() => writeFileSync(recovery, owner, { flag: "wx" })), { group, outcome: "busy" });
  assert.equal(readFileSync(recovery, "utf8"), owner);
  assert.equal(f.h.deletes, 1);
});
