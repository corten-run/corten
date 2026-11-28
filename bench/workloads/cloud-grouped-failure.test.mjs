import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { accountId, archive, commit, context, harness, metadata, syntheticInspection, syntheticPlacement, userId } from "./cloud-fixtures.mjs";
import { fleetPlan, reservation, tags } from "./cloud-contract.mjs";
import { controlRequest, guardianSha256 } from "./cloud-control-runtime.mjs";
import { digest, extractArchive, treeHash } from "./cloud-local.mjs";
import { productionMain, productionPlan } from "./cloud-production.mjs";
import { remoteFiles } from "./cloud-remote.mjs";
import { verifyFailedExitOneCustody, verifyFailedNativeRetirement } from "./cloud-retirement.mjs";
import { shellTransport } from "./cloud-transport.mjs";
import { deploymentSha256 } from "./deployments.mjs";
import { fleetChildOptions, readFleet, readGroup, verifyFleet } from "./fleet-verify.mjs";
import { continuationAdmission, inspectContinuation } from "./group-continuation.mjs";
import { registration } from "./test-fixtures/control-stream-fixture.mjs";
import { streamLimits } from "./isolated/control-stream.mjs";
import { processRecordKey } from "./isolated/host-lifetime.mjs";

const round = "r37", campaign = "r37-0123456789abcdef";
const retiredPid = 2147483647;
const retainedOperation = JSON.stringify({ pid: retiredPid, at: "2026-11-21T00:00:00.000Z" });
const retainedLaunch = JSON.stringify({ pid: retiredPid, round });
const establishedKey = "synthetic established host key\n";
const canonical = (value) => JSON.stringify(value, (_, v) => v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);

function fixture(t, group, flags = {}) {
  const json = group === "json-api", { preplan, handoff, exitOne } = flags;
  const closed = json || handoff || exitOne, phase = closed ? "closed" : "invalid";
  const single = preplan || handoff || exitOne;
  const measured = exitOne ? "7c13920f87b6baa6c7f967027d2eff9358201e4c" : commit;
  const measuredRound = exitOne ? "r78" : round, campaignId = exitOne ? "r78-0123456789abcdef" : campaign;
  const fleetGroup = single ? join(exitOne ? group : `${group}--${measuredRound}`, group) : flags.fleetLayout ? group : undefined;
  const h = harness(t, { ...flags, round: measuredRound, fleetGroup });
  if (fleetGroup) mkdirSync(h.base, { recursive: true });
  h.seed();
  const root = dirname(h.base);
  const region = json ? "blr1" : "sfo3";
  const child = fleetPlan({ round: measuredRound, commit: measured, token: "a".repeat(16), sshKey: "42", provider: { accountId, context },
    tokens: single ? { [group]: "1".repeat(16) } : Object.fromEntries(h.saved().selection.groups.map(({ group }, index) => [group, String(index).padStart(16, "0")])) },
  "2026-11-21T00:00:00.000Z", "sfo3", { stagedPlacement: !flags.fleetLayout || single,
    ...(single ? { single: { group, indexSha256: exitOne ? digest("[]") : "b".repeat(64), checkout: h.repo } } : {}) });
  if (exitOne) writeFileSync(join(dirname(root), "index.json"), "[]");
  if (fleetGroup) writeFileSync(join(root, `fleet-${measuredRound}.json`), JSON.stringify(child));
  const token = child.jobs.find((j) => j.group === group).token;
  const saved = { ...h.saved(), ...reservation({ round: measuredRound, commit: measured, token, group, fleet: child,
    ...(!fleetGroup ? { remainingPlacement: { region, intentSha256: "a".repeat(64) } } : {}) }), provider: child.provider, status: "running",
    ...(!flags.legacyKey ? { launchHostKeySha256: digest(establishedKey) } : {}),
    ...(exitOne ? { bootstrapReady: { observedAt: "2026-11-21T00:00:00.000Z", sha256: digest("started") } } : {}) };
  const binding = { round: measuredRound, commit: measured, token, helperSha256: guardianSha256 };
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
  h.hosts([{ ...h.host(), name: saved.name, tags: [...tags, saved.tag], size_slug: saved.host.size, region: { slug: saved.host.region } }]);
  const put = (name, value) => writeFileSync(join(h.local, name), JSON.stringify(value));
  put("monitor-registration.json", reg);
  const closedAtMs = Date.now() - 2 * streamLimits.leaseMs - 1000;
  put("monitor-local-closed.json", { binding, id: reg.id, code: closed ? 0 : 255, signal: null, remoteDrained: false,
    closedAtMs, recoverAfterMs: closedAtMs + 2 * streamLimits.leaseMs });
  const seal = exitOne ? JSON.stringify({ schema: "benchmark-control-stream-seal/v1", registration: reg,
    lease: { id: reg.id, host: reg.host, expiresMonoNs: "4000000" }, sealedMonoNs: "2000000",
    observations: [{ sequence: 1, monoNs: "1500000", registrationSha256: digest(JSON.stringify(reg)) }] }) : "synthetic seal";
  put(closed ? "monitor-terminal.json" : "monitor-invalid.json", { binding, id: reg.id, ...(closed
    ? { localClosed: true, remoteDrained: false, nativeTerminal: true, campaign: campaignId, sealSha256: digest(seal) }
    : { publicationRevoked: true, remoteTerminal: false }) });
  if (!closed) {
    writeFileSync(join(h.local, "operation.lock"), retainedOperation);
    writeFileSync(join(h.base, ".groups-launch.lock"), flags.foreignLock ? "{}" : retainedLaunch);
  }
  const sibling = join(h.base, "sibling.lock"); writeFileSync(sibling, "sibling stays locked");
  writeFileSync(join(h.local, "known_hosts"), flags.replaceKey ? "synthetic replacement\n" : establishedKey);

  const mainRoot = json ? "bench/json-api/results/j75" : exitOne ? "bench/client-heavy/work/w78"
    : handoff ? `bench/marketplace/results/${round}` : "bench/fullstack-browser/work/w37";
  const outputRoots = json ? ["bench/json-api/results/j74", mainRoot] : [mainRoot];
  const plan = { schema: "benchmark-isolated-group-campaign/v1", round: measuredRound, commit: measured, order: [group],
    bindings: [{ campaignMode: json ? "dedicated-blr1" : "dedicated", request: { group, round: json ? "j75" : exitOne ? "w78" : handoff ? round : "w37", commit: measured },
      validation: { artifactRoot: mainRoot },
      ...(exitOne ? { preparation: { fixtures: [] }, execution: { invocation: {
        executable: "node", argv: ["bench/client-heavy/run.mjs", "--out", mainRoot], cwd: "repository-root", shell: false } } } : {}) }] };
  plan.campaignSha256 = deploymentSha256(plan);
  const nativePayload = "preserved raw failure output\n";
  const nativeEntries = [{ path: "", type: "directory" },
    ...(flags.emptyNative ? [] : [{ path: "failure.txt", type: "file", bytes: nativePayload.length, sha256: digest(nativePayload) }])];
  const nativeManifestSha256 = deploymentSha256(nativeEntries);
  const attempt = { schema: "benchmark-isolated-campaign-reservation/v1", id: campaignId, commit: measured, campaignSha256: plan.campaignSha256 };
  const status = { schema: "benchmark-isolated-campaign-status/v1", state: closed ? "finished" : "preserved-uncertain", round: measuredRound,
    campaign: campaignId, campaignSha256: plan.campaignSha256, controllerReady: false, isolation: "unverified", executionVersion: 5,
    outcomes: [{ group, outcome: flags.lateSealFailure ? "native-validated" : json || exitOne ? "failed" : "preserved-uncertain",
      ...(exitOne ? { nativeManifestSha256 } : {}) }],
    uncollectedNativeRoots: json || flags.lateSealFailure || exitOne && !flags.pending ? [] : [{ group, phase: "timing", artifactRoot: flags.foreignPath ?? mainRoot }],
    ...(exitOne ? { nextGroup: null } : {}) };
  const result = { status, wholeHostTerminal: "parent-must-observe", deletionAuthorized: false }, prefix = `campaign/${campaignId}/`;
  const entries = [{ name: "campaign/" }, ...(preplan ? [] : [{ name: "campaign/.host-attempt.json", body: JSON.stringify(attempt) },
    { name: prefix }, { name: prefix + "plan.json", body: JSON.stringify(plan) },
    { name: prefix + "campaign-result.json", body: JSON.stringify(result) },
    ...(closed ? [{ name: prefix + "control-stream-seal.json", body: seal }] : [])])];
  const wrapperFiles = metadata().map((e) => e.name === "exit-code" ? { ...e, body: exitOne ? `${flags.rawExit ?? 1}\n` : "2\n" } : e);
  if (exitOne) {
    const phaseDir = "00-client-heavy-timing/", phaseBinding = { group, phase: "timing", artifactRoot: flags.foreignPath ?? mainRoot };
    const bootstrap = JSON.stringify({ binding, apparatus: reg });
    const exit = { terminal: true, code: 1, signal: null, success: false, cancelled: false, forced: false, error: null };
    const parent = "/system.slice/" + saved.unit, path = parent + "/native-0-" + "f".repeat(16);
    const ancestors = [parent, "/system.slice", "/"].map(path => ({ path }));
    const process = { stat: "2000 (node) S " + [...Array(18).fill("0"), "1234"].join(" "), cgroup: `0::${path}\n` };
    const processKey = processRecordKey(process);
    const host = {
      "binding.json": { schema: "benchmark-isolated-host-lifetime/v1", campaign: campaignId, group, round: "w78", commit: measured,
        bindingSha256: deploymentSha256(plan.bindings[0]), invocation: plan.bindings[0].execution.invocation, bootId: reg.host.bootId,
        parent, path, command: 0, leaderPid: 2000, leaderIdentity: { pid: 2000, startTicks: "1234", comm: "node" }, ancestors },
      "terminal.json": { terminal: true, attached: true, empty: true, command: exit, bootId: reg.host.bootId, ancestors, samples: 3 },
      "samples.jsonl": [false, true, false].map((live, at) => ({ at, processes: live ? [processKey] : [],
        groups: [{ path, files: { "cgroup.procs": live ? "2000\n" : "", "cgroup.events": live ? "populated 1\n" : "populated 0\n" } }] })),
      [`processes/${processKey}.json`]: process,
    };
    flags.editHost?.(host);
    const inventory = (root) => entries.filter(({ name }) => name.startsWith(root))
      .map(({ name, body }) => ({ path: name.slice(root.length).replace(/\/$/, ""), type: name.endsWith("/") ? "directory" : "file",
        ...(body === undefined ? {} : { bytes: Buffer.byteLength(body), sha256: digest(body) }) }))
      .sort((a, b) => {
        const left = a.path.split("/"), right = b.path.split("/");
        for (let i = 0; i < Math.min(left.length, right.length); i++)
          if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
        return left.length - right.length;
      });
    entries.push(
      { name: prefix + "control-bootstrap.json", body: bootstrap },
        { name: prefix + phaseDir }, { name: prefix + phaseDir + "native/" },
        ...(flags.emptyNative ? [] : [{ name: prefix + phaseDir + "native/failure.txt", body: nativePayload }]),
      { name: prefix + phaseDir + "native-manifest.json", body: JSON.stringify({ entries: nativeEntries, sha256: nativeManifestSha256 }) },
      { name: prefix + phaseDir + "command-0.log", body: "observed exit\n" },
      { name: prefix + phaseDir + "command-0-host/" },
      { name: prefix + phaseDir + "command-0-host/processes/" },
      ...Object.entries(host).map(([name, value]) => ({ name: prefix + phaseDir + "command-0-host/" + name,
        body: name.endsWith(".jsonl") ? value.map(row => JSON.stringify(row) + "\n").join("") : JSON.stringify(value) })),
      { name: prefix + "control-stream-drain.json", body: JSON.stringify({ schema: "benchmark-control-stream-drain/v1", id: reg.id,
        registrationSha256: digest(JSON.stringify(reg)), host: reg.host, identitiesAbsent: true, monoNs: "2500000",
        listener: reg.listener, scopes: [{ path: "/user.slice/session-1.scope", exists: false, members: [], events: null }] }) });
    const journal = [["authorized", {}], ["control-admitted", { epoch: "bootstrap", path: "control-bootstrap.json", sha256: digest(bootstrap), binding }],
      ["started", {}], ["native-output-reserved", phaseBinding],
      ["command-intent", { group, invocation: plan.bindings[0].execution.invocation }], ["command-started", { pid: 2000 }],
      ["command-exited", { ...exit,
        hostManifestSha256: deploymentSha256(inventory(prefix + phaseDir + "command-0-host/")) }],
      ["phase-sealed", { ...phaseBinding, nativeManifestSha256, phaseManifestSha256: deploymentSha256(inventory(prefix + phaseDir)) }],
      ["group-finished", { group, outcome: status.outcomes[0].outcome, nativeManifestSha256 }],
      ["stream-sealed", { path: "control-stream-seal.json", sha256: digest(seal), binding }], ["finished", { status }]];
    flags.editJournal?.(journal);
    entries.push(
      ...journal.map(([kind, detail], sequence) => ({ name: prefix + `${String(sequence).padStart(5, "0")}-${kind}.json`,
        body: JSON.stringify({ schema: "benchmark-isolated-campaign-event/v1", kind, sequence,
          campaign: campaignId, round: measuredRound, campaignSha256: plan.campaignSha256,
          status: kind === "finished" ? status : { ...status, state: "active", nextGroup: sequence < 8 ? group : null,
            outcomes: sequence < 8 ? [] : status.outcomes, uncollectedNativeRoots: sequence >= 3 && sequence <= 7 ? [phaseBinding] : [] },
          ...detail }) })));
    const records = inventory(prefix);
    if (!flags.noManifest) entries.push({ name: prefix + "collection-manifest.json",
      body: JSON.stringify({ ...result, manifest: { entries: records, sha256: deploymentSha256(records) } }) });
    entries.push({ name: "control/" }, { name: "control/stream-terminal.json", body: "{}" });
  }
  if (preplan || exitOne && !flags.noNativeExitLog) {
    const line = remoteFiles(saved)["job.sh"].split("\n").lastIndexOf("bootstrap_stage=native-entry") + 2;
    wrapperFiles[0].body += `benchmark job failed: stage=native-entry line=${line} exit=${exitOne ? 1 : 2}\n`;
  }
  // Process-observation filenames are longer than the fixture tar's name field.
  const members = entries.flatMap((entry) => entry.name.length <= 100 ? [entry] : [
    { name: "././@LongLink", type: "L", body: entry.name + "\0" }, { ...entry, name: "long-name-member" },
  ]);
  const wrapper = archive([...wrapperFiles, ...members]); h.setArchive(wrapper);
  const copy = join(h.temp, "fixture-copy");
  for (const { name, body } of entries) {
    if (name.endsWith("/")) mkdirSync(join(copy, name), { recursive: true });
    else writeFileSync(join(copy, name), body);
  }
  const native = join(copy, "native"); mkdirSync(native);
  writeFileSync(join(native, "failure.txt"), nativePayload);
  const roots = [{ path: "/bench/campaign", present: true, treeSha256: treeHash(join(copy, "campaign")), nodes: entries.length, bytes: 100 },
    ...outputRoots.map((name, index) => index ? { path: `/bench/repo/${name}`, present: false }
      : { path: `/bench/repo/${name}`, present: true, treeSha256: treeHash(native), nodes: 2, bytes: nativePayload.length }),
    ...(exitOne ? [{ path: "/bench/control", present: true, treeSha256: treeHash(join(copy, "control")), nodes: 2, bytes: 2 }] : []),
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
    if (exitOne && binary === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return { status: 0, stdout: measured };
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
      if (exitOne) {
        assert.ok(script.includes("v['ExecMainStatus'] == '1'"));
        assert.ok(script.includes("small('/bench/exit-code', 16) == b'1\\n'"));
        assert.ok(!script.includes("tarfile.open") && !script.includes("pack.sh;"));
        flags.checkProbe?.(script);
        if (flags.activeProof && probes === 2) return { status: 1, stdout: "" };
        const observed = { schema: "benchmark-failed-native-host/v1", custody: true, historicalAccountingQualified: false,
          hostId: saved.id, unit: saved.unit, roots: structuredClone(roots), metadataSha256,
          snapshotSha256: digest(snapshot), archiveSha256: digest(wrapper), observedAtMs: Date.now(),
          wrapper: { runLog: digest(wrapperFiles[0].body), host: digest(wrapperFiles[1].body) } };
        flags.alterProof?.(observed, probes);
        observed.snapshotSha256 = deploymentSha256({ roots: observed.roots, metadataSha256: observed.metadataSha256 });
        return { status: 0, stdout: JSON.stringify(observed) };
      }
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
  return { h, root, sibling, wrapper, custody, roots, run, measured, measuredRound, get probes() { return probes; }, get downloads() { return custodyDownloads; },
    get deleteExpiry() { return deleteExpiry; }, task: (deps = {}, options) => h.task({ run,
      inspect: () => assert.fail("native replay must not decide custody"), ...deps }, options) };
}

function singleFixture(t, flags, group) {
  const f = fixture(t, group, flags);
  const { measured: commit, measuredRound: round } = f;
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
  const f = flags.exitOne ? singleFixture(t, flags, "client-heavy")
    : singleFixture(t, { ...flags, handoff: true, lateSealFailure: true }, "localized-marketplace");
  const { measured: commit, measuredRound: round } = f;
  if (flags.exitOne) {
    if (flags.collectFirst) {
      let attempts = 0;
      await assert.rejects(f.task({ inspect: () => { attempts++; throw new Error("synthetic offline replay unavailable"); } }).collect(),
        /native campaign validation unavailable or invalid/);
      assert.equal(attempts, 1);
    } else await f.preserveWrapper();
  } else assert.equal(await f.task().collect(), 3);
  const { h, repairCommit } = f, args = [round, "--state-dir", h.base, "--retire-failed-native"];
  const launched = [], knobs = {};
  let approval;
  const deps = { repo: h.repo, sleep: async () => {}, inspect: () => assert.fail("handoff retirement cannot validate native timing"),
    interrupted() {
      if (knobs.afterIntent && h.saved().deletionIntentAt) {
        const hook = knobs.afterIntent; delete knobs.afterIntent; hook();
      }
      return false;
    },
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
      if (f.probes === (flags.exitOne ? 2 : 3)) {
        knobs.expire?.();
        knobs.finalFence?.();
      }
      return { ...result, stderr: `CORTEN_CONTROL ${id} ${"a".repeat(64)}\nCORTEN_RESULT ${id} ${result.status}\n` };
    },
    providerFactory: ({ createMode }) => Object.assign((argv, timeout, allowFail, expiry) => {
      assert.equal(createMode, null); launched.push(["provider", ...argv]);
      if (knobs.beforeFinalPending && argv[2] === "get" && f.probes === 2) knobs.beforeFinalPending();
      if (knobs.beforeIntent && argv[2] === "get" && f.probes === (flags.exitOne ? 2 : 3) && !h.saved().deletionIntentAt) knobs.beforeIntent();
      if (knobs.dispatchAccount && argv[0] === "account" && h.saved().deletionIntentAt) knobs.dispatchAccount();
      if (argv[0] === "account" && f.probes === 2) knobs.finalAccount?.();
      if (knobs.exactRead && argv[2] === "get" && h.saved().deletionIntentAt) knobs.exactRead();
      if (knobs.failExactRead && argv[2] === "get")
        return { status: 1, providerDiagnostic: { code: "get-http", httpStatus: 500 } };
      if (argv[2] === "delete") {
        assert.ok(Number.isSafeInteger(expiry) && Date.now() < expiry && expiry - Date.now() <= 60000);
        assert.ok(existsSync(join(h.local, "failed-native-host.json")));
        if (knobs.unsent) return { status: 1, stdout: "", stderr: "", deleteNotDispatched: true };
      }
      const result = f.run("doctl", argv, timeout, allowFail, expiry);
      if (argv[2] === "delete") knobs.afterDelete?.();
      return result;
    }, { close: async () => { knobs.close?.(); } }),
  };
  return { f, launched, knobs, deps,
    async preview() { assert.equal(await productionMain([...args, "--print-approval"], deps), 3); return approval; },
    retire: (approved) => productionMain([...args, "--approve-reviewed-merged-ready", approved.approvalSha256], deps) };
}

const probeCodeTest = `
import ast, contextlib, hashlib, sys
from types import SimpleNamespace
source = sys.stdin.read()
compile(source, 'retirement probe', 'exec')
method = next(node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == 'accounted_work')
def opened(path, flags):
    assert path == '/bench/repo/bench/client-heavy/work' and flags == 3
    return 42
def scan(fd):
    assert fd == 42
    return contextlib.nullcontext(entries)
os = SimpleNamespace(O_RDONLY=1, O_DIRECTORY=2, scandir=scan, close=lambda fd: None)
c = {'roots': ['/bench/campaign', '/bench/repo/bench/client-heavy/work/w78']}
exec(compile(ast.Module(body=[method], type_ignores=[]), 'work proof', 'exec'))
def entry(name, directory=True):
    def is_dir(*, follow_symlinks):
        assert follow_symlinks is False
        return directory
    return SimpleNamespace(name=name, is_dir=is_dir)
for entries, valid in [([], True), ([entry('w78')], True), ([entry('w78', False)], False),
        ([entry('w78'), entry('w78.compiler')], False), ([entry('.compiler-owner-leftover')], False)]:
    try:
        accounted_work()
    except AssertionError:
        assert not valid
    else:
        assert valid
first = source.index('# Read-only: this route')
last = source.index('# Both the captured paths', first)
archive = compile(source[first:last], 'archive proof', 'exec')
c.update(captureSha256='snapshot', fence={}, bounds={'compressed': 16}, archiveSha256=hashlib.sha256(b'original').hexdigest())
snapshot_sha = 'snapshot'
inventories = [[{'kind': 'f', 'metadata': [0, 0, 0, 1, 8]}]]
def consume(path, row, write):
    assert path == '/bench/results.tgz' and row is inventories[-1][0]
    write(payload)
for payload in [b'original', b'modified']:
    try:
        exec(archive)
    except AssertionError:
        assert payload == b'modified'
    else:
        assert payload == b'original'
`;

test("exit-one custody derives the old native digest without extra payload reads", async (t) => {
  const f = singleFixture(t, { exitOne: true }, "client-heavy");
  await f.preserveWrapper();
  const { h } = f, state = h.saved(), extracted = join(h.local, state.evidence);
  const campaignRoot = join(extracted, "campaign"), controlRoot = join(extracted, "control");
  const nativeRoot = join(campaignRoot, `${state.round}-0123456789abcdef`, "00-client-heavy-timing", "native");
  const path = join(nativeRoot, "failure.txt"), size = lstatSync(path).size;
  const expected = [treeHash(campaignRoot), treeHash(nativeRoot), treeHash(controlRoot)];
  for (const { pin, drift } of [{ pin: false }, { pin: true }, { pin: false, drift: true }]) {
    let member, bytes = 0, closes = 0;
    const { openSync, readSync, closeSync } = fs;
    const open = t.mock.method(fs, "openSync", function (file, ...args) {
      const fd = openSync(file, ...args);
      if (file === path) member = fd;
      return fd;
    });
    const read = t.mock.method(fs, "readSync", function (fd, ...args) {
      const count = readSync(fd, ...args);
      if (fd === member) bytes += count;
      return count;
    });
    const close = t.mock.method(fs, "closeSync", function (fd) {
      const watched = fd === member;
      const result = closeSync(fd);
      if (watched) {
        member = undefined;
        // Mark a change immediately after the independent manifest member read.
        if (++closes === 2 && drift) utimesSync(path, 946684800, 946684800);
      }
      return result;
    });
    syncBuiltinESMExports();
    const started = performance.now();
    let proof;
    try {
      const verify = () => verifyFailedExitOneCustody(h.local, state, { pin });
      if (drift) assert.throws(verify, /local handoff custody changed: extraction/);
      else { proof = verify(); proof.assertCustody(); }
    } finally {
      for (const mock of [open, read, close]) mock.mock.restore();
      syncBuiltinESMExports();
    }
    t.diagnostic(`pin=${pin} drift=${!!drift} native member=${size} B; read=${bytes} B in ${(performance.now() - started).toFixed(1)} ms`);
    if (proof) {
      assert.deepEqual([proof.hashes.campaign, proof.hashes.native, proof.hashes.control], expected);
      assert.equal(proof.hashes.empty, false);
    }
    // One pass for the wrapper and another for the separate collection manifest.
    assert.equal(bytes, 2 * size);
  }
});

test("exit-one custody retains the empty native directory digest", async (t) => {
  const f = singleFixture(t, { exitOne: true, emptyNative: true }, "client-heavy");
  await f.preserveWrapper();
  const { h } = f, state = h.saved();
  const { hashes, assertCustody } = verifyFailedExitOneCustody(h.local, state, { pin: true });
  assert.equal(hashes.native, digest("d\0\0"));
  assert.equal(hashes.empty, true);
  assertCustody();
});

test("bound exit one needs new approval, and continuation waits for exact absence", async (t) => {
  const python = process.platform === "win32" ? "python" : "python3";
  const available = spawnSync(python, ["--version"], { timeout: 3000, windowsHide: true }).status === 0;
  if (!available) t.diagnostic("Python unavailable; generated probe source checks skipped");
  const checkProbe = available ? (script) => {
    const program = script.split("\n").slice(1, -1).join("\n");
    const r = spawnSync(python, ["-I", "-c", probeCodeTest], { input: program, encoding: "utf8", timeout: 5000, windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
  } : undefined;
  const { f, preview, retire, knobs, launched } = await handoffFixture(t, { exitOne: true, collectFirst: true, deleteLost: true, checkProbe });
  const { h } = f, input = { repo: h.repo, inspect: () => assert.fail("retirement cannot replay native timing") };
  const continuation = dirname(f.root);
  const admit = () => continuationAdmission(continuation, "client-heavy", input);
  const report = () => verifyFleet({ root: f.root, round: f.measuredRound, commit: f.measured }, input);
  const original = readFileSync(h.statePath), extract = join(h.local, h.saved().evidence), originalTree = treeHash(extract);
  assert.equal(h.saved().validation, undefined);
  assert.equal(h.saved().deletionIntentAt, undefined);
  assert.deepEqual(readFileSync(join(h.local, "results.tgz")), f.wrapper);
  await assert.rejects(admit(), /requires confirmed absence/);
  const p = await preview();
  assert.equal(p.recovery.policy, "r78-client-heavy-sealed-exit-one-retirement-only");
  assert.equal(p.recovery.intent.launch, digest(readFileSync(f.intentPath)));
  assert.equal(p.reservationSha256, digest(original));
  assert.deepEqual(launched, []);
  await assert.rejects(retire(p), /acknowledgement lost/);
  assert.equal(h.saved().status, "retired");
  assert.equal(h.saved().destroyedAt, undefined);
  assert.equal((await report()).groups[0].outcome, "cleanup-pending");
  await assert.rejects(admit(), /requires confirmed absence/);
  await assert.rejects(retire(p), /explicit operator-approved exact action required/);
  const before = launched.length;
  knobs.failExactRead = true;
  await assert.rejects(retire(await preview()), /exact host observation failed/);
  assert.equal(h.saved().destroyedAt, undefined);
  knobs.failExactRead = false;
  assert.equal(await retire(await preview()), 1);
  assert.ok(launched.slice(before).every((row) => row[0] === "provider" && row.includes("get")));
  const saved = h.saved(), receipt = verifyFailedNativeRetirement(h.local, saved);
  assert.equal(receipt.schema, "benchmark-failed-native-retirement/v3");
  assert.equal(receipt.reservationSha256, digest(original));
  assert.equal(receipt.observation.proof.archiveSha256, saved.archiveSha256);
  assert.equal(saved.fullGroupQualified, false);
  assert.ok(saved.destroyedAt && ["validation", "exitCode", "collectedAt", "evidenceOutcome"].every(k => saved[k] === undefined));
  assert.equal(h.deletes, 1); assert.equal(h.creates, 0);
  assert.equal(f.probes, 2); assert.equal(f.downloads, 0);
  assert.deepEqual(readFileSync(join(h.local, "results.tgz")), f.wrapper);
  assert.equal(treeHash(extract), originalTree);
  assert.deepEqual(readFileSync(join(h.local, "failed-native-reservation.json")), original);
  assert.equal((await report()).groups[0].outcome, "native-failed-retired");
  const retry = await admit();
  assert.equal(retry.rows.find(r => r.group === "client-heavy").retryable, true);
  const mixed = await continuationAdmission(continuation, "mixed-production", input);
  assert.equal(mixed.subject.exitOneRetirements.length, 1);
  assert.deepEqual(mixed.subject.exitOneRetirements, retry.subject.exitOneRetirements);
  const after = await inspectContinuation(continuation, input);
  assert.ok(after.report.eligibleToRun.includes("client-heavy"));
  assert.equal(after.report.publishableBaseline, false);
});

test("exit-one preview refuses unsafe saved scopes before provider access", async (t) => {
  for (const [name, flags, refusal] of [
    ["successful raw exit", { rawExit: 0 }, /failed-native-capture/], ["unknown raw exit", { rawExit: 3 }, /failed-native-capture/],
    ["native validated", { lateSealFailure: true }, /intrinsically failed/], ["pending root", { pending: true }, /pending native output/],
    ["unaccounted journal root", { foreignPath: "bench/client-heavy/work/foreign" }, /exit-one command journal/],
    ["incomplete campaign", { noManifest: true }, /collection-manifest/],
    ["wrong registered host", { foreignHostname: true }, /registered host differs/],
    ["unbound known hosts", { legacyKey: true }, /no launch-established host key/],
    ["unbound native exit", { noNativeExitLog: true }, /source-bound final native-entry failure/],
  ]) await t.test(name, async (t) => {
    const { f, preview, launched } = await handoffFixture(t, { exitOne: true, ...flags });
    await assert.rejects(preview(), refusal);
    assert.deepEqual(launched, []);
    assert.equal(f.h.deletes, 0); assert.equal(f.h.creates, 0);
  });
  for (const lock of ["operation.lock", "stream-recovery.lock", "audit-delivery.lock", "create-recheck.lock", "../.groups-launch.lock",
    "../../.fleet-operation.lock", "../../../.continuation-operation.lock"]) await t.test(lock, async (t) => {
    const { f, preview, launched } = await handoffFixture(t, { exitOne: true });
    writeFileSync(join(f.h.local, lock), "foreign-live-or-retained\n");
    await assert.rejects(preview(), /competing or retained custody/);
    assert.deepEqual(launched, []);
  });
});

test("exit-one rejects a rehashed incomplete or contradictory command journal before access", async (t) => {
  for (const [kind, edit] of [
    ["no authorization or start", (rows) => rows.splice(0, 3)],
    ["no command exit", (rows) => rows.splice(6, 1)],
    ["wrong invocation", (rows) => { rows[4][1].invocation = { command: "wrong" }; }],
    ["wrong starting PID", (rows) => { rows[5][1].pid++; }],
    ["unobserved exit", (rows) => { rows[6][1].terminal = false; }],
    ["contradictory exit", (rows) => { rows[6][1].success = true; }],
    ["clean exit contradicts sealed command observation", (rows) => { Object.assign(rows[6][1], { code: 0, success: true }); }],
  ]) await t.test(kind, async (t) => {
    const { f, preview, launched } = await handoffFixture(t, { exitOne: true, editJournal: edit });
    await assert.rejects(preview(), /exit-one command journal/);
    assert.deepEqual(launched, []);
    assert.equal(f.h.deletes, 0);
  });
});

test("exit-one refuses rehashed missing or contradictory host lifetime observations before access", async (t) => {
  for (const [kind, editHost] of [
    ["no binding", host => { delete host["binding.json"]; }],
    ["no samples", host => { delete host["samples.jsonl"]; }],
    ["unrelated boot", host => { host["terminal.json"].bootId = "f".repeat(36); }],
    ["missing leader start identity", host => { delete host["binding.json"].leaderIdentity; }],
    ["wrong leader start ticks", host => { host["binding.json"].leaderIdentity.startTicks = "9999"; }],
    ["no observed leader", host => { host["samples.jsonl"][1].groups[0].files["cgroup.procs"] = "2001\n"; }],
    ["leader record outside the command", host => {
      const [key] = host["samples.jsonl"][1].processes;
      const record = host[`processes/${key}.json`]; delete host[`processes/${key}.json`];
      record.cgroup = "0::/other\n";
      const changed = processRecordKey(record);
      host["samples.jsonl"][1].processes[0] = changed; host[`processes/${changed}.json`] = record;
    }],
    ["non-leader record under a stale identity key", host => {
      const sample = host["samples.jsonl"][1], path = host["binding.json"].path;
      const stat = (ticks) => "2001 (node) S " + [...Array(18).fill("0"), ticks].join(" ");
      const record = { stat: stat("2345"), cgroup: `0::${path}\n` };
      const key = processRecordKey(record);
      sample.groups[0].files["cgroup.procs"] += "2001\n"; sample.processes.push(key);
      host[`processes/${key}.json`] = { ...record, stat: stat("4321") };
    }],
    ["unrelated sample cgroup", host => { host["samples.jsonl"][1].groups[0].path += "-other"; }],
    ["leader listed in two cgroups", host => {
      const sample = host["samples.jsonl"][1], duplicate = structuredClone(sample.groups[0]);
      duplicate.path += "/other"; sample.groups.push(duplicate);
    }],
    ["malformed reference after a valid leader", host => {
      host["samples.jsonl"][1].processes.push("../terminal");
    }],
  ]) await t.test(kind, async (t) => {
    const { f, preview, launched } = await handoffFixture(t, { exitOne: true, editHost });
    await assert.rejects(preview(), /exit-one command journal/);
    assert.deepEqual(launched, []);
    assert.equal(f.h.deletes, 0);
  });
});

test("exit-one accepts repeated references to the same process across samples", async (t) => {
  const { preview, launched } = await handoffFixture(t, { exitOne: true, editHost(host) {
    const samples = host["samples.jsonl"];
    samples.splice(2, 0, { ...structuredClone(samples[1]), at: 2 });
    samples[3].at = 3;
    host["terminal.json"].samples = 4;
  } });
  assert.equal((await preview()).recovery.operation, "observe-terminal-and-retire");
  assert.deepEqual(launched, []);
});

test("exit-one retains the operation lock when custody changes after DELETE dispatch", async (t) => {
  for (const mode of ["exact 404", "GET throws", "DELETE throws", "absence-only collect"]) await t.test(mode, async (t) => {
    const { f, preview, retire, knobs, launched } = await handoffFixture(t,
      { exitOne: true, deleteLost: mode === "absence-only collect" });
    const { h } = f;
    if (mode === "absence-only collect") await assert.rejects(retire(await preview()), /acknowledgement lost/);
    const approved = await preview(), before = launched.length;
    let ownedLock;
    const drift = () => {
      ownedLock = readFileSync(join(h.local, "operation.lock"));
      appendFileSync(join(h.local, "results.tgz"), "drift");
      if (mode.endsWith("throws")) throw new Error("synthetic provider call threw");
    };
    if (mode === "DELETE throws") knobs.afterDelete = drift;
    else knobs.exactRead = drift;
    await assert.rejects(retire(approved), /local exit-one custody changed|synthetic provider call threw/);
    assert.equal(h.deletes, 1);
    assert.ok(h.saved().deletionIntentAt);
    assert.equal(h.saved().destroyedAt, undefined);
    assert.deepEqual(readFileSync(join(h.local, "operation.lock")), ownedLock);
    if (mode === "absence-only collect")
      assert.ok(launched.slice(before).every((row) => row[0] === "provider" && row.includes("get")));
  });
});

test("exit-one retains custody when evidence changes during provider close", async (t) => {
  for (const mode of ["normal DELETE", "absence-only", "uncertain DELETE", "unsent DELETE"]) await t.test(mode, async (t) => {
    const { f, preview, retire, knobs, launched } = await handoffFixture(t,
      { exitOne: true, deleteLost: mode === "uncertain DELETE" || mode === "absence-only" });
    const { h } = f, lock = join(h.local, "operation.lock");
    if (mode === "absence-only") await assert.rejects(retire(await preview()), /acknowledgement lost/);
    const approved = await preview(), before = launched.length;
    if (mode === "unsent DELETE") knobs.unsent = true;
    let held, destroyedAtDuringClose;
    knobs.close = () => {
      delete knobs.close;
      held = readFileSync(lock);
      const saved = h.saved();
      destroyedAtDuringClose = saved.destroyedAt;
      const path = mode === "absence-only" ? join(saved.evidence, "run.log")
        : mode === "uncertain DELETE" ? "failed-native-host.json" : "results.tgz";
      appendFileSync(join(h.local, path), "close-time drift");
    };
    await assert.rejects(retire(approved), mode === "uncertain DELETE" ? /exit-one receipt replaced/ : /custody changed/);
    assert.ok(held);
    assert.equal(destroyedAtDuringClose, undefined);
    assert.equal(h.saved().destroyedAt, undefined);
    assert.equal(h.deletes, mode === "unsent DELETE" ? 0 : 1);
    assert.equal(!!h.saved().deletionIntentAt, mode !== "unsent DELETE");
    assert.deepEqual(readFileSync(lock), held);
    if (mode === "absence-only")
      assert.ok(launched.slice(before).every(row => row[0] === "provider" && row.includes("get")));
    await assert.rejects(preview(), /competing or retained custody/);
  });
});

test("exit-one preflight expiry and positively unsent DELETE require a fresh approval and fence", async (t) => {
  for (const mode of ["preflight expiry", "dispatch-boundary expiry", "worker unsent"]) await t.test(mode, async (t) => {
    const { f, preview, retire, knobs } = await handoffFixture(t, { exitOne: true });
    const { h } = f, first = await preview(), now = Date.now;
    if (mode === "preflight expiry") {
      let count = 0;
      knobs.finalAccount = () => { if (++count === 3) Date.now = () => now() + 60000; };
    } else if (mode === "dispatch-boundary expiry") knobs.afterIntent = () => { Date.now = () => now() + 60000; };
    else knobs.unsent = true;
    try { await assert.rejects(retire(first), mode === "preflight expiry" ? /retirement proof expired/ : /DELETE not dispatched/); }
    finally { Date.now = now; knobs.finalAccount = undefined; knobs.unsent = false; }
    assert.equal(f.probes, 2);
    assert.equal(h.deletes, 0);
    assert.equal(h.saved().status, "running");
    assert.equal(h.saved().deletionIntentAt, undefined);
    assert.equal(existsSync(join(h.local, "failed-native-host.json")), false);
    assert.equal(existsSync(join(h.local, "failed-native-reservation.json")), false);
    const history = readdirSync(h.local).filter((name) => name.startsWith("failed-native-unsent-"));
    assert.equal(history.length, mode === "preflight expiry" ? 0 : 2);
    if (history.length) {
      const name = history.find((name) => /^failed-native-unsent-[a-f0-9]{64}\.json$/.test(name));
      const bytes = readFileSync(join(h.local, name)), hash = digest(bytes);
      assert.equal(name, "failed-native-unsent-" + hash + ".json");
      assert.equal(digest(readFileSync(join(h.local, "failed-native-unsent-reservation-" + hash + ".json"))),
        JSON.parse(bytes).reservationSha256);
    }
    const next = await preview();
    assert.equal(next.recovery.operation, "observe-terminal-and-retire");
    assert.notEqual(next.approvalSha256, first.approvalSha256);
    await assert.rejects(retire(first), /explicit operator-approved exact action required/);
    assert.equal(await retire(next), 1);
    assert.equal(f.probes, 4);
    assert.equal(h.deletes, 1);
    assert.deepEqual(readFileSync(join(h.local, "results.tgz")), f.wrapper);
    assert.equal(verifyFailedNativeRetirement(h.local, h.saved()).schema, "benchmark-failed-native-retirement/v3");
  });
});

test("a torn exit-one withdrawal of a positively unsent DELETE leaves its own stage, keeps the intent and the lock, and refuses", async (t) => {
  const { f, preview, retire, knobs } = await handoffFixture(t, { exitOne: true });
  const { h } = f, lock = join(h.local, "operation.lock");
  knobs.unsent = true;
  // The first exclusive state stage written after the intent's (the withdrawal's) is torn.
  const fds = new Set(); let intentWritten = false, torn = false;
  t.mock.method(fs, "openSync", ((original) => (file, flags, ...rest) => {
    const fd = original(file, flags, ...rest);
    if (!torn && flags === "wx" && /^state\.json\..*tmp$/.test(basename(String(file)))) fds.add(fd);
    return fd;
  })(fs.openSync));
  t.mock.method(fs, "writeFileSync", ((original) => (target, data, ...rest) => {
    if (!fds.has(target)) return original(target, data, ...rest);
    fds.delete(target);
    if (String(data).includes('"deletionIntentAt"')) intentWritten = true;
    else if (intentWritten && !torn) { torn = true; fs.writeSync(target, Buffer.from(data).subarray(0, 80)); throw new Error("injected torn write"); }
    return original(target, data, ...rest);
  })(fs.writeFileSync));
  syncBuiltinESMExports();
  t.after(() => { fs.openSync.mock?.restore(); fs.writeFileSync.mock?.restore(); syncBuiltinESMExports(); });
  await assert.rejects(retire(await preview()), /injected torn write/);
  fs.openSync.mock.restore(); fs.writeFileSync.mock.restore(); syncBuiltinESMExports(); knobs.unsent = false;
  assert.ok(torn); assert.equal(h.deletes, 0);
  // The intent stays, and the withdrawal's custody (the lock) is preserved: fail closed.
  const saved = h.saved();
  assert.equal(saved.status, "retired"); assert.ok(saved.deletionIntentAt); assert.ok(existsSync(lock));
  assert.equal(existsSync(join(h.local, "state.json.tmp")), false);
  const stages = readdirSync(h.local).filter((name) => /^state\.json\..*tmp$/.test(name));
  assert.equal(stages.length, 1); assert.match(stages[0], /^state\.json\.delete-unsent-[a-f0-9]{32}\.tmp$/);
  const tornBytes = readFileSync(join(h.local, stages[0]));
  assert.equal(tornBytes.length, 80);
  await assert.rejects(preview(), /competing or retained custody/);
  assert.equal(h.deletes, 0); assert.deepEqual(h.saved(), saved);
  assert.ok(readFileSync(join(h.local, stages[0])).equals(tornBytes));
});

test("the production child refuses changed exit-one custody after the successor fleet intent", async (t) => {
  for (const changed of ["receipt", "retained lock", "receipt after child intent", "archive after child intent", "extraction after child intent",
    "missing binding", "none"]) await t.test(changed, async (t) => {
    const { f, preview, retire, deps } = await handoffFixture(t, { exitOne: true });
    assert.equal(await retire(await preview()), 1);
    const { h, repairCommit } = f, continuation = dirname(f.root), group = "client-heavy", round = "r79";
    const admitted = await continuationAdmission(continuation, group, { repo: h.repo, inspect: deps.inspect });
    const root = join(continuation, "client-heavy--r79");
    mkdirSync(join(root, group), { recursive: true });
    const manifest = fleetPlan({ round, commit: repairCommit, token: "b".repeat(16), sshKey: "42", provider: { accountId, context },
      tokens: { [group]: "2".repeat(16) } }, "2026-11-21T00:00:00.000Z", "sfo3", { stagedPlacement: true,
      single: { group, indexSha256: admitted.indexSha256, checkout: h.repo } });
    writeFileSync(join(root, "fleet-r79.json"), JSON.stringify(manifest));
    const fleet = readFleet(root, round), options = fleetChildOptions(fleet, group, "detach");
    const integrations = { compiler: () => true, roleCheck: async () => [] };
    const plan = await productionPlan(options, { ...integrations, repo: h.repo, run: async (bin, args) => deps.spawn(bin, args) });
    if (changed === "missing binding") delete admitted.subject.exitOneRetirements;
    const subject = { ...f.intent.subject, controllerCommit: repairCommit, stateRoot: root, requestedRoot: root, round,
      manifestSha256: fleet.manifestSha256, fleet: manifest, continuation: admitted.subject,
      jobs: [{ group, outcome: "planned", missing: [], options, subject: plan.subject, approvalSha256: plan.approvalSha256 }] };
    const approvalSha256 = digest(JSON.stringify(subject));
    writeFileSync(join(root, "launch-intent.json"), JSON.stringify({ ...f.intent, subject, approvalSha256 }));
    writeFileSync(join(root, ".fleet-operation.lock"), JSON.stringify({ pid: process.pid, approvalSha256 }));
    writeFileSync(join(continuation, ".continuation-operation.lock"), JSON.stringify({ pid: process.pid, group }));
    let creates = 0, afterCatalog = 0;
    const statePath = join(options.stateDir, "groups-r79", "state.json");
    let changedAfterIntent = false;
    function interrupted() {
      if (changed.endsWith("after child intent") && !changedAfterIntent && existsSync(statePath)
          && JSON.parse(readFileSync(statePath)).createIntentAt) {
        changedAfterIntent = true;
        const path = changed.startsWith("receipt") ? "failed-native-host.json"
          : changed.startsWith("archive") ? "results.tgz" : join(h.saved().evidence, "run.log");
        appendFileSync(join(h.local, path), "\n");
      }
      return false;
    }
    const calls = [];
    const providerFactory = () => Object.assign((argv) => {
      calls.push(argv);
      if (argv[0] === "account") {
        if (afterCatalog && ++afterCatalog === 3) {
          if (changed === "receipt") appendFileSync(join(h.local, "failed-native-host.json"), "\n");
          if (changed === "retained lock") writeFileSync(join(h.local, "audit-delivery.lock"), "retained");
        }
        return { status: 0, stdout: JSON.stringify({ uuid: userId, droplet_limit: 20 }) };
      }
      if (argv[2] === "list") return { status: 0, stdout: "[]" };
      if (argv[1] === "placement") { afterCatalog = 1; return { status: 0, stdout: JSON.stringify(syntheticPlacement()) }; }
      assert.equal(argv[2], "create");
      creates++; throw new Error("synthetic POST reached");
    }, { close: async () => {} });
    await assert.rejects(productionMain([round, "--state-dir", options.stateDir, "--detach", "--commit", repairCommit,
      "--ssh-key", "42", "--account-id", accountId, "--context", context, "--group", group, "--fleet", fleet.path,
      "--approve-reviewed-merged-ready", plan.approvalSha256], { ...deps, ...integrations, interrupted, providerFactory }),
    changed === "none" ? /synthetic POST reached/ : /exit-one retirement.*(?:changed or holds custody|not bound)/);
    assert.ok(afterCatalog >= 3, JSON.stringify(calls));
    assert.equal(creates, Number(changed === "none"));
    assert.equal(changedAfterIntent, changed.endsWith("after child intent"));
    const state = JSON.parse(readFileSync(statePath));
    assert.equal(!!state.createIntentAt, changed === "none" || changed.endsWith("after child intent"));
  });
});

test("exit-one retirement refuses foreign allocation, remote drift and local replacement", async (t) => {
  for (const [name, flags, error] of [
    ["archive digest", { alterProof: (p) => { p.archiveSha256 = digest("foreign"); } }, /original remote archive differs/],
    ["control root", { alterProof: (p) => { p.roots[2].treeSha256 = digest("foreign"); } }, /live control root differs/],
    ["unpreserved output", { alterProof: (p) => { p.roots[1] = { path: p.roots[1].path, present: false }; } }, /unpreserved live native output/],
    ["fresh fence metadata", { alterProof: (p, probe) => { if (probe === 2) p.metadataSha256 = digest("changed"); } }, /proof changed/],
    ["active unit", { activeProof: true }, /control process failed/],
    ["wrong provider account", { accountId: "different-account" }, /provider account identity changed/],
    ["foreign exact allocation", {}, /owned droplet|ownership tag/],
    ["distinct extraction from the same bound archive", {}, /archive|extraction/],
  ]) await t.test(name, async (t) => {
    const { f, preview, retire } = await handoffFixture(t, { exitOne: true, ...flags });
    const { h } = f, extract = join(h.local, h.saved().evidence);
    if (name === "foreign exact allocation") h.hosts([{ ...h.host(), name: h.saved().name, tags: ["foreign"] }]);
    if (name === "distinct extraction from the same bound archive") {
      const path = join(extract, "run.log"), changed = readFileSync(path);
      changed[0] ^= 1; writeFileSync(path, changed);
      h.change(s => { s.evidenceSha256 = treeHash(extract); });
    }
    await assert.rejects(retire(await preview()), error);
    assert.equal(h.saved().deletionIntentAt, undefined);
    assert.equal(h.deletes, 0); assert.equal(h.creates, 0);
  });
  const { f, preview, retire, knobs, launched } = await handoffFixture(t, { exitOne: true });
  const { h } = f, approved = await preview();
  let held;
  knobs.afterIntent = () => {
    held = readFileSync(join(h.local, "operation.lock"));
    appendFileSync(join(h.local, h.saved().evidence, "run.log"), "late change");
  };
  await assert.rejects(retire(approved), /extraction/);
  assert.ok(h.saved().deletionIntentAt && !h.saved().destroyedAt);
  assert.equal(h.deletes, 0); assert.equal(h.creates, 0);
  assert.deepEqual(readFileSync(join(h.local, "operation.lock")), held);
  const calls = launched.length;
  await assert.rejects(preview(), /competing or retained custody/);
  assert.equal(launched.length, calls);
});

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
  assert.ok(!existsSync(join(h.local, "operation.lock")));
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

test("handoff refuses to overwrite unexpected state at final SSH acknowledgement", async (t) => {
  for (const kind of ["bad-json", "byte-drift", "missing", "unreadable", "same-byte replacement"]) await t.test(kind, async (t) => {
    const { f, knobs, preview, retire } = await handoffFixture(t);
    const { h } = f, path = h.statePath, approved = await preview();
    const moved = join(h.temp, "prior-pending-state");
    let expected, changedInode;
    knobs.finalFence = () => {
      const pending = readFileSync(path);
      assert.equal(JSON.parse(pending).control.ledger.at(-1).localTerminal, false);
      if (kind === "bad-json") writeFileSync(path, expected = Buffer.from("{"));
      else if (kind === "byte-drift") {
        expected = Buffer.concat([pending, Buffer.from("\n")]);
        appendFileSync(path, "\n");
      }
      else {
        renameSync(path, moved);
        if (kind === "unreadable") mkdirSync(path);
        if (kind === "same-byte replacement") {
          writeFileSync(path, expected = pending, { flag: "wx" });
          changedInode = lstatSync(path, { bigint: true }).ino;
          assert.notEqual(changedInode, lstatSync(moved, { bigint: true }).ino);
        }
      }
    };
    const error = await retire(approved).catch(e => e);
    assert.equal(f.probes, 3);
    assert.equal(h.deletes, 0);
    if (kind === "missing") assert.ok(!existsSync(path));
    else if (kind === "unreadable") assert.ok(lstatSync(path).isDirectory());
    else assert.deepEqual(readFileSync(path), expected);
    if (changedInode !== undefined) assert.equal(lstatSync(path, { bigint: true }).ino, changedInode);
    assert.ok(!existsSync(`${path}.tmp`), "must refuse before staging the acknowledgement");
    assert.ok(!existsSync(join(h.local, "failed-native-host.json")));
    assert.ok(existsSync(join(h.local, "operation.lock")), "keep custody of the unacknowledged command");
    assert.match(error?.message ?? "", /handoff reservation changed or unreadable/);
  });
});

test("handoff refuses state drift before writing the final SSH pending row", async (t) => {
  const { f, knobs, preview, retire } = await handoffFixture(t);
  const { h } = f, path = h.statePath, approved = await preview();
  let expected;
  knobs.beforeFinalPending = () => {
    delete knobs.beforeFinalPending;
    const settled = readFileSync(path);
    assert.equal(JSON.parse(settled).control.ledger.at(-1).localTerminal, true);
    expected = Buffer.concat([settled, Buffer.from("\n")]);
    appendFileSync(path, "\n");
  };
  const error = await retire(approved).catch(e => e);
  assert.deepEqual({ probes: f.probes, deletes: h.deletes }, { probes: 2, deletes: 0 });
  assert.deepEqual(readFileSync(path), expected);
  assert.ok(!existsSync(`${path}.tmp`));
  assert.ok(!existsSync(join(h.local, "failed-native-host.json")));
  assert.ok(existsSync(join(h.local, "operation.lock")));
  assert.match(error?.message ?? "", /handoff reservation changed or unreadable/);
});

test("handoff refuses a same-byte state replacement at intent, dispatch or absence settlement", async (t) => {
  for (const phase of ["intent", "dispatch", "acknowledged DELETE", "lost-ack retry"]) await t.test(phase, async (t) => {
    const lost = phase === "lost-ack retry";
    const { f, knobs, preview, retire } = await handoffFixture(t, { deleteLost: lost });
    const { h } = f, path = h.statePath, moved = join(h.temp, "prior-state");
    const beforeIntent = phase === "intent", beforeDispatch = phase === "dispatch";
    if (lost) await assert.rejects(retire(await preview()), /acknowledgement lost/);
    const approved = await preview();
    let expected, inode;
    const hook = beforeIntent ? "beforeIntent" : beforeDispatch ? "dispatchAccount" : "exactRead";
    const replace = () => {
      expected = readFileSync(path);
      renameSync(path, moved);
      writeFileSync(path, expected, { flag: "wx" });
      inode = lstatSync(path, { bigint: true }).ino;
      assert.notEqual(inode, lstatSync(moved, { bigint: true }).ino);
    };
    knobs[hook] = () => {
      delete knobs[hook];
      // Cross the account-return checkpoint and change the file after the
      // preliminary dispatch check, just before production worker dispatch.
      if (beforeDispatch) setImmediate(() => setImmediate(() => setImmediate(replace)));
      else replace();
    };
    const error = await retire(approved).catch(e => e);
    assert.equal(f.probes, 3);
    assert.equal(h.deletes, beforeIntent || beforeDispatch ? 0 : 1);
    assert.equal(h.saved().destroyedAt, undefined);
    assert.equal(!!h.saved().deletionIntentAt, !beforeIntent);
    assert.deepEqual(readFileSync(path), expected);
    assert.equal(lstatSync(path, { bigint: true }).ino, inode);
    assert.ok(!existsSync(`${path}.tmp`));
    assert.ok(existsSync(join(h.local, "operation.lock")));
    assert.match(error?.message ?? "", /handoff reservation changed or unreadable/);
  });
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
    } else {
      assert.equal(await retire(approved), 1);
      assert.ok(!existsSync(join(h.local, "operation.lock")));
    }
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

test("handoff teardown retains custody when settled state becomes unavailable", async (t) => {
  for (const deleteLost of [false, true]) await t.test(deleteLost ? "absence reconciliation" : "first retirement", async (t) => {
    const { f, knobs, preview, retire } = await handoffFixture(t, { deleteLost });
    const { h } = f, saved = join(h.temp, "settled-state.json");
    if (deleteLost) await assert.rejects(retire(await preview()), /acknowledgement lost/);
    const approved = await preview();
    let settled = false;
    knobs.close = () => {
      delete knobs.close;
      assert.ok(h.saved().destroyedAt);
      settled = true;
      renameSync(h.statePath, saved);
    };
    await assert.rejects(retire(approved), /handoff reservation changed or unreadable; preserve custody/);
    assert.ok(settled);
    assert.ok(existsSync(join(h.local, "operation.lock")));
    assert.ok(!existsSync(h.statePath));
    assert.ok(existsSync(saved));
    assert.equal(h.deletes, 1);
  });
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
