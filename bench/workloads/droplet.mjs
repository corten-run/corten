// Reviewed all-nine lifecycle. Production transport is composed only by the gated CLI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertFleetCensus, ownedDroplet, reservation, tags, terminalUnit, validateFleet } from "./cloud-contract.mjs";
import { bootstrapMarker, bootstrapReadScript, remoteFiles } from "./cloud-remote.mjs";
import { archiveMembers, digest, durable, durableCopy, extractArchive, fileHash, physical, regular, resolveStateRoot, syncDirectory, treeHash } from "./cloud-local.mjs";
import { campaignOutcome, controllerState, full, providerAccount, providerFailure, validateOptions } from "./cloud-options.mjs";
import { auditDelivery, auditProtocol, auditScript } from "./cloud-audit.mjs";
import { inspectCampaign } from "./cloud-validation.mjs";
import { setupEvidence, terminalSetupScript, unusedEvidence, unusedHostScript } from "./cloud-retirement.mjs";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function command(binary, args, timeout = 60000, allowFail = false) {
  assert.equal(binary, "git", "provisional controller: real cloud transport disabled until full readiness/review");
  const r = spawnSync(binary, args, { cwd: checkout, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout, maxBuffer: 16 * 1024 ** 2,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" } });
  if (!allowFail && (r.error || r.status !== 0)) throw new Error(`${binary}: ${r.error?.code ?? r.status}`);
  return r;
}
const outside = (root, path) => { const r = relative(root, path); return isAbsolute(r) || r === ".." || r.startsWith(`..${sep}`); };
export function controller(input, { run = command, repo = checkout, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  inspect, interrupted = () => false, settle = async () => {}, mergedHead = "origin/main", now = () => Date.now() } = {}) {
  const options = validateOptions(input); repo = realpathSync(repo);
  if (mergedHead !== "origin/main") full(mergedHead, /[a-f0-9]{40}/, "exact observed main commit required");
  const fleet = options.group === undefined ? undefined : validateFleet(JSON.parse(regular(options.fleet, 1024 * 1024)));
  if (fleet) {
    assert.equal(fleet.round, options.round); assert.equal(fleet.commit, options.commit); assert.equal(fleet.sshKey, options.sshKey);
    assert.deepEqual(fleet.provider, { accountId: options.accountId, context: options.context });
  }
  const requested = resolve(options.stateDir), physicalRequest = resolveStateRoot(requested);
  assert.ok(outside(repo, physicalRequest) && outside(physicalRequest, repo), "state and checkout must be disjoint");
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const base = realpathSync(requested); physical(base);
  const local = join(base, `groups-${options.round}`), statePath = join(local, "state.json"), archive = join(local, "results.tgz");
  let state, preserveOperationLock = false;
  const boundary = (path = local) => { physical(base); physical(path); assert.equal(dirname(path), base, "reservation left root"); };
  const check = () => { assert.ok(!interrupted(), "controller cancelled; preserve reservation/host"); boundary(); };
  const read = (path = local, round = options.round) => { boundary(path); return controllerState(JSON.parse(regular(join(path, "state.json"), 1024 * 1024)), round); };
  const save = () => {
    check(); controllerState(state, options.round);
    durable(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(`${statePath}.tmp`, statePath); syncDirectory(local);
  };
  async function execute(binary, args, timeout = 60000, allowFail = false) {
    const invoke = async (argv, permittedFailure = false) => {
      check();
      let r;
      try { r = await run(binary, argv, timeout, permittedFailure); }
      catch (error) { if (error.controlTreeUncertain || error.controlUncertain) preserveOperationLock = true; throw error; }
      if (r.controlTreeUncertain || r.controlUncertain) { preserveOperationLock = true; throw new Error("control uncertain; preserve locks"); }
      check();
      if (!permittedFailure) assert.ok(!r.error && r.status === 0, "control process failed; host preserved");
      return r;
    };
    if (binary !== "doctl") return invoke(args, allowFail);
    const scoped = (argv) => [...argv, "--context", state.provider.context];
    const account = async () => {
      const value = JSON.parse((await invoke(scoped(["account", "get", "--output", "json"]))).stdout);
      assert.equal(providerAccount(value), state.provider.accountId, "provider account identity changed; preserve uncertainty");
    };
    await account();
    const result = await invoke(scoped(args), allowFail);
    await account(); // A changed context cannot supply absence/deletion authority.
    return result;
  }
  const list = async () => { const d = JSON.parse((await execute("doctl", ["compute", "droplet", "list", "--output", "json"])).stdout); assert.ok(Array.isArray(d)); return d; };
  const exactHost = async () => {
    const result = await execute("doctl", ["compute", "droplet", "get", state.id, "--output", "json"], 60000, true);
    if (result.status === 1 && providerFailure(result)?.code === "get-http" && providerFailure(result)?.httpStatus === 404) return undefined;
    assert.equal(result.status, 0, "exact host observation failed; preserve state");
    const rows = JSON.parse(result.stdout);
    assert.ok(Array.isArray(rows) && rows.length === 1 && String(rows[0]?.id) === state.id, "exact host identity differs");
    return rows[0];
  };
  const own = async () => {
    const found = state.id ? await exactHost() : undefined;
    const d = ownedDroplet(state.id ? found ? [found] : [] : await list(), state), ips = d.networks?.v4?.filter((n) => n.type === "public");
    assert.equal(ips?.length, 1, "ambiguous public host address");
    if (state.ip) assert.equal(ips[0].ip_address, state.ip);
    return d;
  };
  const bind = (d) => {
    assert.ok(!state.id || state.id === String(d.id), "host ID changed");
    state.id = String(d.id); state.ip = d.networks.v4.find((n) => n.type === "public").ip_address;
    state.status = state.status === "creating" ? "preparing" : state.status; save();
  };
  const sshOptions = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${join(local, "known_hosts").replaceAll("\\", "/")}`,
    "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2"];
  const transport = async (binary, args, timeout, allowFail) => {
    await own(); assert.ok(state.id && state.ip, "bound host required");
    if (existsSync(join(local, "known_hosts"))) regular(join(local, "known_hosts"), 1024 * 1024);
    return execute(binary, [...sshOptions, ...args], timeout, allowFail);
  };
  const ssh = (script, timeout = 60000, allowFail = false) => transport("ssh", [`root@${state.ip}`, script], timeout, allowFail);
  const scp = (from, to) => transport("scp", ["-q", from, to], 15 * 60000);
  const unit = async () => terminalUnit((await ssh(`systemctl show ${state.unit} --property=Id --property=LoadState --property=FragmentPath --property=ActiveState --property=Restart --property=MainPID --property=ExecMainCode --property=ExecMainStartTimestamp`)).stdout, state);
  async function commonBootstrap() {
    const deadline = now() + 45 * 60000; let previous = deadline - 45 * 60000;
    const remaining = () => {
      const current = now();
      assert.ok(Number.isFinite(current) && Number.isFinite(deadline) && current >= previous && current < deadline, "common bootstrap observation expired; preserve running host");
      previous = current; check(); return deadline - current;
    };
    for (;;) {
      remaining();
      assert.equal(await unit(), false, "first group ended before common bootstrap admission; collect its evidence");
      const result = await ssh(bootstrapReadScript, Math.min(30000, remaining()), true);
      remaining();
      if (result.status === 0 && !result.error) {
        assert.ok(Buffer.byteLength(result.stdout) <= 1024, "bounded bootstrap marker required");
        assert.deepEqual(JSON.parse(result.stdout), bootstrapMarker(state), "common bootstrap identity differs");
        state.bootstrapReady = { sha256: digest(result.stdout), observedAt: new Date().toISOString() }; save(); return;
      }
      assert.equal(result.status, 3, "common bootstrap marker observation failed");
      await sleep(Math.min(30000, remaining()));
    }
  }
  async function locked(fn) {
    boundary(); const lock = join(local, "operation.lock");
    durable(lock, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
    preserveOperationLock = false;
    try { state = read(); check(); return await fn(); }
    finally {
      try { await settle(); }
      catch (error) {
        preserveOperationLock = true;
        const diagnostic = providerFailure(error);
        throw Object.assign(new Error("control teardown uncertain; preserve locks/state/evidence/host"), { controlTreeUncertain: true, controlUncertain: true },
          diagnostic ? { providerDiagnostic: diagnostic } : {});
      }
      finally { if (!preserveOperationLock) { unlinkSync(lock); syncDirectory(local); } }
    }
  }
  const verifyArchive = () => {
    assert.equal(fileHash(archive), state.archiveSha256, "archive changed; preserve host");
  };
  async function validateEvidence() {
    state.fullGroupQualified = false;
    const extracted = join(local, state.evidence); physical(extracted);
    assert.equal(treeHash(extracted), state.evidenceSha256, "evidence changed; preserve host");
    const markerBytes = regular(join(extracted, "exit-code"), 16);
    assert.ok(markerBytes.every((b) => b < 128), "invalid exit marker bytes");
    const marker = markerBytes.toString("ascii");
    full(marker, /(?:0|[1-9]\d{0,2})\n/, "invalid exit marker");
    const exitCode = Number(marker.trim()); assert.ok(exitCode <= 255);
    let report;
    let outcome;
    try {
      report = await inspectCampaign(Object.freeze({ folder: join(extracted, "campaign"), round: state.round, commit: state.commit }), {
        inspect, interrupted, preserveLock: () => { preserveOperationLock = true; },
      });
      check();
      outcome = campaignOutcome(report, state, exitCode);
    } catch { throw new Error("native campaign validation unavailable or invalid; evidence/host preserved"); }
    // Never retain/print native assertion messages: they may contain private raw values.
    assert.equal(treeHash(extracted), state.evidenceSha256, "validator mutated evidence"); verifyArchive();
    Object.assign(state, outcome, { exitCode, validation: { status: report.status, campaign: report.campaign, collectionIntegrity: report.collectionIntegrity } });
  }
  const deletedCode = () => state.validation.status === "verified" && state.exitCode === 0 ? 0 : 1; // Intrinsic evidence only, never readiness.
  const setupExit = () => {
    verifyArchive(); const extracted = join(local, state.evidence); physical(extracted);
    assert.equal(treeHash(extracted), state.evidenceSha256, "failed setup archive extraction changed");
    const campaign = join(extracted, "campaign");
    if (existsSync(campaign)) { physical(campaign); assert.deepEqual(readdirSync(campaign), [], "native data cannot use setup retirement"); }
    const marker = regular(join(extracted, "exit-code"), 16).toString("utf8");
    full(marker, /[1-9]\d{0,2}\n/, "nonzero setup exit required");
    const exit = Number(marker.trim()); assert.ok(exit <= 255); return exit;
  };
  const retirementFile = (kind) => kind === "setup-failed" ? "failed-setup-host.json" : "unused-host.json";
  const verifyRetirementRecord = (bytes, kind) => {
    const setup = kind === "setup-failed";
    const record = JSON.parse(bytes), raw = JSON.stringify(record.observation);
    const expected = setup ? setupEvidence(raw, state, terminalSetupScript(state, setupExit()), setupExit(), record.startedAtMs, record.finishedAtMs)
      : unusedEvidence(raw, state, unusedHostScript(state), record.startedAtMs, record.finishedAtMs);
    assert.deepEqual(record, expected, "retirement evidence differs");
  };
  const verifyRetirement = () => {
    const bytes = regular(join(local, retirementFile(state.retirement.kind)), 4096);
    assert.equal(digest(bytes), state.retirement.evidenceSha256, "retirement evidence changed");
    verifyRetirementRecord(bytes, state.retirement.kind);
  };
  const retire = async (kind, evidence, finishedAtMs) => {
    await own(); check();
    assert.ok(Date.now() >= finishedAtMs && Date.now() - finishedAtMs <= 60000, "retirement proof expired before deletion");
    const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
    const path = join(local, retirementFile(kind));
    if (existsSync(path)) {
      // A crash between receipt and state writes is recoverable. Preserve the
      // exact old record, but only this operation's fresh probe authorizes intent.
      assert.ok(!state.deletionIntentAt && !state.retirement, "existing retirement intent cannot be repeated");
      const prior = regular(path, 4096), hash = digest(prior); verifyRetirementRecord(prior, kind);
      const retained = join(local, `${retirementFile(kind).slice(0, -5)}.interrupted-${hash}.json`);
      if (existsSync(retained)) assert.equal(digest(regular(retained, 4096)), hash, "interrupted retirement history differs");
      else durable(retained, prior);
      assert.equal(digest(regular(path, 4096)), hash, "interrupted retirement receipt changed");
      unlinkSync(path); syncDirectory(local);
    }
    durable(path, bytes);
    Object.assign(state, { status: "retired", retirement: { kind, evidenceSha256: digest(bytes) }, deletionIntentAt: new Date().toISOString() }); save();
    verifyRetirement();
    await execute("doctl", ["compute", "droplet", "delete", state.id, "--force"], 120000);
    assert.equal(await exactHost(), undefined, "deletion not confirmed; preserve intent without another DELETE");
    state.destroyedAt = new Date().toISOString(); save(); return 1;
  };
  const retireUnused = async () => {
    assert.equal(state.status, "preparing", "only a never-started allocation can be retired as unused");
    const script = unusedHostScript(state), startedAtMs = Date.now();
    const raw = (await ssh(script, 30000)).stdout, finishedAtMs = Date.now();
    const evidence = unusedEvidence(raw, state, script, startedAtMs, finishedAtMs);
    return retire("unused", evidence, finishedAtMs);
  };
  const retireFailedSetup = async () => {
    assert.ok(["starting", "running"].includes(state.status) && !preserveOperationLock && !state.bootstrapReady, "uncertain or native-started work cannot use setup retirement");
    const exit = setupExit(), script = terminalSetupScript(state, exit), startedAtMs = Date.now();
    const raw = (await ssh(script, 30000)).stdout, finishedAtMs = Date.now();
    const evidence = setupEvidence(raw, state, script, exit, startedAtMs, finishedAtMs);
    return retire("setup-failed", evidence, finishedAtMs);
  };
  return {
    get state() { return state ? structuredClone(state) : undefined; }, local,
    async launch() {
      assert.ok(options.detach, "detach options required");
      const launchLock = join(base, ".groups-launch.lock");
      durable(launchLock, `${JSON.stringify({ pid: process.pid, round: options.round })}\n`);
      try {
        assert.ok(!existsSync(local), "round already reserved; never relaunch");
        for (const entry of readdirSync(base)) if (entry.startsWith("groups-")) {
          const match = /^groups-(r[1-9]\d{0,8})$/.exec(entry); assert.ok(match, "unknown reservation");
          assert.ok(read(join(base, entry), match[1]).destroyedAt, "unresolved reservation blocks launch");
        }
        mkdirSync(local, { mode: 0o700 }); syncDirectory(base);
        state = { ...reservation({ round: options.round, commit: options.commit,
          token: fleet ? fleet.jobs.find((row) => row.group === options.group).token : randomBytes(8).toString("hex"),
          ...(fleet ? { group: options.group, fleet } : {}) }),
          provider: { accountId: options.accountId, context: options.context }, fullGroupQualified: false };
        durable(statePath, `${JSON.stringify(state, null, 2)}\n`);
        return await locked(async () => {
          assert.equal(realpathSync((await execute("git", ["rev-parse", "--show-toplevel"])).stdout.trim()), repo);
          assert.equal((await execute("git", ["rev-parse", "HEAD"])).stdout.trim(), state.commit, "measured HEAD differs");
          assert.equal((await execute("git", ["status", "--porcelain", "--untracked-files=all"])).stdout.trim(), "", "clean committed source required");
          await execute("git", ["merge-base", "--is-ancestor", state.commit, mergedHead]);
          for (const path of ["bench/workloads/droplet.mjs", "bench/workloads/cloud-contract.mjs", "bench/workloads/isolated/campaign-entry.mjs", "bench/workloads/isolated/campaign-verify.mjs"])
            await execute("git", ["cat-file", "-e", `${state.commit}:${path}`]);
          const existing = await list();
          if (fleet) assertFleetCensus(existing, fleet);
          else assert.ok(!existing.some((d) => d.name?.startsWith("corten-bench-groups-") || d.tags?.includes(tags[0])), "benchmark host already exists");
          assert.ok(!existing.some((d) => d.name === state.name || d.tags?.includes(state.tag)), "this host already exists; never adopt/relaunch");
          const account = JSON.parse((await execute("doctl", ["account", "get", "--output", "json"])).stdout);
          assert.equal(providerAccount(account), state.provider.accountId, "provider account identity changed; preserve uncertainty");
          const limit = (Array.isArray(account) ? account[0] : account)?.droplet_limit;
          assert.ok(Number.isSafeInteger(limit) && existing.length < limit, "account capacity unavailable");
          if (fleet) {
            const present = existing.filter((d) => fleet.jobs.some((row) => row.name === d.name)).length;
            assert.ok(existing.length + fleet.jobs.length - present <= limit, "account capacity cannot cover the reserved fleet");
          }
          state.status = "creating"; state.createIntentAt = new Date().toISOString(); save();
          const created = await execute("doctl", ["compute", "droplet", "create", state.name, "--size", state.host.size, "--region", state.host.region, "--image", state.host.image,
            "--ssh-keys", options.sshKey, "--tag-names", [...tags, state.tag].join(","), "--wait", "--output", "json"], 10 * 60000, true);
          // Lost acknowledgement permits only identity reconciliation, never another create.
          try { bind(await own()); }
          catch (error) {
            const diagnostic = providerFailure(created);
            if (diagnostic && !providerFailure(error)) error.providerDiagnostic = diagnostic;
            throw error;
          }
          if (created.error || created.status !== 0) {
            const diagnostic = providerFailure(created);
            throw Object.assign(new Error("create completion was not proved; allocation retained for recovery"), diagnostic ? { providerDiagnostic: diagnostic } : {});
          }
          let ready = false;
          for (let i = 0; i < 40; i++) {
            if ((await ssh("true", 30000, true)).status === 0) { ready = true; break; }
            if (i < 39) { check(); await sleep(10000); }
          }
          assert.ok(ready, "SSH unavailable; never relaunch");
          await ssh("mkdir -m 700 /bench && touch /bench/run.log");
          for (const [name, content] of Object.entries(remoteFiles(state))) {
            durable(join(local, name), content); await scp(join(local, name), `root@${state.ip}:/bench/${name}`);
            await ssh(`printf '%s  %s\\n' '${digest(content)}' '/bench/${name}' | sha256sum --check --status`);
          }
          await ssh(`bash -n /bench/job.sh && bash -n /bench/pack.sh && install -m 644 /bench/${state.unit} /etc/systemd/system/${state.unit} && systemd-analyze verify /etc/systemd/system/${state.unit} && systemctl daemon-reload`);
          state.status = "starting"; save(); await ssh(`systemctl start ${state.unit}`);
          await unit(); state.status = "running"; save();
          if (state.group !== undefined && state.group === state.fleet.jobs[0].group) await commonBootstrap();
          return structuredClone(state);
        });
      } finally { if (!preserveOperationLock) { unlinkSync(launchLock); syncDirectory(base); } }
    },
    async collect() {
      assert.ok(options.collect, "collect options required");
      return locked(async () => {
        if (state.status === "retired") {
          verifyRetirement();
          assert.equal(await exactHost(), undefined, "delete outcome uncertain; no automatic repeated deletion");
          state.destroyedAt ??= new Date().toISOString(); save(); return 1;
        }
        if (state.deletionIntentAt) {
          verifyArchive(); await validateEvidence();
          if (await exactHost() === undefined) {
            state.destroyedAt ??= new Date().toISOString(); save(); return deletedCode();
          }
          assert.ok(!state.destroyedAt, "deleted host still listed; preserve identity");
          assert.fail("delete outcome uncertain; no automatic repeated deletion");
        }
        assert.ok(state.createIntentAt, "no create intent; reservation requires operator inspection");
        bind(await own());
        if (state.status === "preparing") return retireUnused();
        if (!await unit()) return 3; // Exactly one look, never waits for a live campaign.
        if (!state.archiveSha256) {
          assert.ok(!existsSync(archive) && !existsSync(`${archive}.download`), "unrecorded download/archive retained; inspect before retry");
          await ssh("timeout 600 /bin/bash /bench/pack.sh", 11 * 60000);
          const hashLine = (await ssh("sha256sum /bench/results.tgz")).stdout;
          full(hashLine, /[a-f0-9]{64}  \/bench\/results\.tgz\n/, "invalid remote archive hash");
          const hash = hashLine.slice(0, 64), download = `${archive}.download`;
          // Reserve the destination before SCP, so a crash cannot make it look retryable.
          durable(download, ""); await scp(`root@${state.ip}:/bench/results.tgz`, download);
          // Re-write through a synced exclusive file; never replace unexplained evidence.
          durableCopy(download, `${archive}.synced`, hash); renameSync(`${archive}.synced`, archive); syncDirectory(local);
          state.archiveSha256 = hash; save();
        }
        verifyArchive(); await archiveMembers(archive, state.archiveSha256); check();
        if (!state.evidence) {
          const extracted = mkdtempSync(join(local, "evidence-"));
          (state.extractionAttempts ??= []).push(basename(extracted)); save();
          const hash = await extractArchive(archive, extracted, state.archiveSha256); check();
          state.evidence = basename(extracted); state.evidenceSha256 = hash; save();
        }
        try { await validateEvidence(); }
        catch (error) {
          // No native report can exist before entry. Only a separate fresh,
          // terminal pre-entry proof permits failed-setup cleanup, never success.
          try { setupExit(); } catch { throw error; }
          return retireFailedSetup();
        }
        state.collectedAt ??= new Date().toISOString(); state.status = "collected"; save();
        verifyArchive(); await validateEvidence();
        assert.ok(await unit(), "unit became active; preserve host"); await own(); check();
        state.deletionIntentAt = new Date().toISOString(); save();
        await execute("doctl", ["compute", "droplet", "delete", state.id, "--force"], 120000);
        assert.equal(await exactHost(), undefined, "deletion not confirmed; host state uncertain");
        verifyArchive(); await validateEvidence(); state.destroyedAt = new Date().toISOString(); save(); return deletedCode();
      });
    },
    async deliverAudit() {
      assert.ok(options.deliverAudit, "audit delivery options required");
      return locked(async () => {
        assert.ok(state.id && state.ip && !state.deletionIntentAt && !state.collectedAt && ["starting", "running"].includes(state.status), "live owned campaign required");
        const { group, prefix } = auditProtocol(options.auditGroup);
        if (state.group !== undefined) assert.equal(group, state.group, "audit delivery belongs to a different group host");
        assert.ok(!state.auditIntents?.[group] && !(group === "json-api" && state.auditIntent), "audit delivery already attempted; inspect, never repeat");
        const bytes = regular(resolve(options.deliverAudit), 16 * 1024 ** 2), intent = auditDelivery(bytes, options);
        assert.equal(await unit(), false, "terminal campaign cannot accept delivery");
        assert.equal((await ssh(auditScript(state, intent))).stdout.trim(), intent.subjectSha256);
        durable(join(local, `${prefix}-audit-delivery.json`), bytes);
        (state.auditIntents ??= {})[group] = intent; save();
        const stage = `/bench/cloud-${prefix}-audit-${state.token}.json`;
        await ssh(`test ! -e ${stage} && test ! -L ${stage} && install -m 600 /dev/null ${stage}`);
        await scp(join(local, `${prefix}-audit-delivery.json`), `root@${state.ip}:${stage}`);
        assert.equal(await unit(), false, "campaign ended during audit transfer");
        assert.equal((await ssh(auditScript(state, intent, true))).stdout.trim(), intent.subjectSha256);
        return 3;
      });
    },
  };
}

// Never print exception messages/stacks or provider output: assertions may echo raw evidence.
export function publicError(error) {
  const diagnostic = providerFailure(error);
  return "Controller stopped; retained state/evidence requires inspection. Host/deletion state may be uncertain. Never relaunch."
    + (diagnostic ? ` Provider failure: ${diagnostic.code}${diagnostic.httpStatus === undefined ? "" : ` (HTTP ${diagnostic.httpStatus})`}.` : "");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  import("./cloud-production.mjs").then((native) => native.productionCli(process.argv.slice(2)))
    .then((code) => { process.exitCode = code; }, (error) => { console.error(publicError(error)); process.exitCode = 2; });
}
