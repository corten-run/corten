// Provisional all-nine controller. Tests inject a fake process boundary; the production
// cloud transport is deliberately disabled pending native readiness and independent review.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ownedDroplet, remoteFiles, reservation, tags, terminalUnit } from "./cloud-contract.mjs";
import { archiveMembers, digest, durable, extractArchive, physical, regular, syncDirectory, treeHash } from "./cloud-local.mjs";
import { campaignOutcome, controllerState, full, parseDropletArgs, validateOptions } from "./cloud-options.mjs";
import { auditDelivery, auditScript } from "./cloud-audit.mjs";
import { inspectCampaign } from "./cloud-validation.mjs";

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
  inspect, interrupted = () => false } = {}) {
  const options = validateOptions(input); repo = realpathSync(repo);
  const requested = resolve(options.stateDir); let parent = requested;
  while (!existsSync(parent)) parent = dirname(parent);
  const physicalRequest = resolve(realpathSync(parent), relative(parent, requested));
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
  function execute(binary, args, timeout = 60000, allowFail = false) {
    check(); const r = run(binary, args, timeout, allowFail);
    if (!allowFail) assert.ok(!r.error && r.status === 0, "control process failed; host preserved");
    return r;
  }
  const list = () => { const d = JSON.parse(execute("doctl", ["compute", "droplet", "list", "--output", "json"]).stdout); assert.ok(Array.isArray(d)); return d; };
  const own = () => {
    const d = ownedDroplet(list(), state), ips = d.networks?.v4?.filter((n) => n.type === "public");
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
  const transport = (binary, args, timeout, allowFail) => {
    own(); assert.ok(state.id && state.ip, "bound host required");
    if (existsSync(join(local, "known_hosts"))) regular(join(local, "known_hosts"), 1024 * 1024);
    return execute(binary, [...sshOptions, ...args], timeout, allowFail);
  };
  const ssh = (script, timeout = 60000, allowFail = false) => transport("ssh", [`root@${state.ip}`, script], timeout, allowFail);
  const scp = (from, to) => transport("scp", ["-q", from, to], 15 * 60000);
  const unit = () => terminalUnit(ssh(`systemctl show ${state.unit} --property=Id --property=LoadState --property=FragmentPath --property=ActiveState --property=Restart --property=MainPID --property=ExecMainCode --property=ExecMainStartTimestamp`).stdout, state);
  async function locked(fn) {
    boundary(); const lock = join(local, "operation.lock");
    durable(lock, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
    preserveOperationLock = false;
    try { state = read(); check(); return await fn(); }
    finally { if (!preserveOperationLock) { unlinkSync(lock); syncDirectory(local); } }
  }
  const verifyArchive = () => {
    const bytes = regular(archive); assert.equal(digest(bytes), state.archiveSha256, "archive changed; preserve host"); return bytes;
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
  const deletedCode = () => 1; // Exit zero is reserved for a future reviewed, fully valid contract.
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
        state = { ...reservation({ round: options.round, commit: options.commit, token: randomBytes(8).toString("hex") }), fullGroupQualified: false };
        durable(statePath, `${JSON.stringify(state, null, 2)}\n`);
        return await locked(async () => {
          assert.equal(realpathSync(execute("git", ["rev-parse", "--show-toplevel"]).stdout.trim()), repo);
          assert.equal(execute("git", ["rev-parse", "HEAD"]).stdout.trim(), state.commit, "measured HEAD differs");
          assert.equal(execute("git", ["status", "--porcelain", "--untracked-files=all"]).stdout.trim(), "", "clean committed source required");
          execute("git", ["merge-base", "--is-ancestor", state.commit, "origin/main"]);
          for (const path of ["bench/workloads/droplet.mjs", "bench/workloads/cloud-contract.mjs", "bench/workloads/isolated/campaign-entry.mjs", "bench/workloads/isolated/campaign-verify.mjs"])
            execute("git", ["cat-file", "-e", `${state.commit}:${path}`]);
          const existing = list();
          assert.ok(!existing.some((d) => d.name?.startsWith("corten-bench-groups-") || d.tags?.includes(tags[0])), "benchmark host already exists");
          const account = JSON.parse(execute("doctl", ["account", "get", "--output", "json"]).stdout);
          const limit = (Array.isArray(account) ? account[0] : account)?.droplet_limit;
          assert.ok(Number.isSafeInteger(limit) && existing.length < limit, "account capacity unavailable");
          state.status = "creating"; state.createIntentAt = new Date().toISOString(); save();
          execute("doctl", ["compute", "droplet", "create", state.name, "--size", state.host.size, "--region", state.host.region, "--image", state.host.image,
            "--ssh-keys", options.sshKey, "--tag-names", [...tags, state.tag].join(","), "--wait", "--output", "json"], 10 * 60000, true);
          bind(own()); // Lost acknowledgement permits only identity reconciliation, never another create.
          let ready = false;
          for (let i = 0; i < 40; i++) {
            if (ssh("true", 30000, true).status === 0) { ready = true; break; }
            if (i < 39) { check(); await sleep(10000); }
          }
          assert.ok(ready, "SSH unavailable; never relaunch");
          ssh("mkdir -m 700 /bench && touch /bench/run.log");
          for (const [name, content] of Object.entries(remoteFiles(state))) {
            durable(join(local, name), content); scp(join(local, name), `root@${state.ip}:/bench/${name}`);
          }
          ssh(`bash -n /bench/job.sh && bash -n /bench/pack.sh && install -m 644 /bench/${state.unit} /etc/systemd/system/${state.unit} && systemd-analyze verify /etc/systemd/system/${state.unit} && systemctl daemon-reload`);
          state.status = "starting"; save(); ssh(`systemctl start ${state.unit}`);
          unit(); state.status = "running"; save(); return structuredClone(state);
        });
      } finally { unlinkSync(launchLock); syncDirectory(base); }
    },
    async collect() {
      assert.ok(options.collect, "collect options required");
      return locked(async () => {
        if (state.deletionIntentAt) {
          verifyArchive(); await validateEvidence();
          if (!list().some((d) => String(d.id) === state.id)) {
            state.destroyedAt ??= new Date().toISOString(); save(); return deletedCode();
          }
          assert.ok(!state.destroyedAt, "deleted host still listed; preserve identity");
          assert.fail("delete outcome uncertain; no automatic repeated deletion");
        }
        assert.ok(state.createIntentAt, "no create intent; reservation requires operator inspection");
        bind(own());
        if (!unit()) return 3; // Exactly one look, never waits for a live campaign.
        if (!state.archiveSha256) {
          assert.ok(!existsSync(archive) && !existsSync(`${archive}.download`), "unrecorded download/archive retained; inspect before retry");
          ssh("timeout 600 /bin/bash /bench/pack.sh", 11 * 60000);
          const hashLine = ssh("sha256sum /bench/results.tgz").stdout;
          full(hashLine, /[a-f0-9]{64}  \/bench\/results\.tgz\n/, "invalid remote archive hash");
          const hash = hashLine.slice(0, 64), download = `${archive}.download`;
          // Reserve the destination before SCP, so a crash cannot make it look retryable.
          durable(download, ""); scp(`root@${state.ip}:/bench/results.tgz`, download);
          const bytes = regular(download); assert.equal(digest(bytes), hash, "download hash differs");
          // Re-write through a synced exclusive file; never replace unexplained evidence.
          durable(`${archive}.synced`, bytes); renameSync(`${archive}.synced`, archive); syncDirectory(local);
          state.archiveSha256 = hash; save();
        }
        const bytes = verifyArchive(); archiveMembers(bytes);
        if (!state.evidence) {
          const extracted = mkdtempSync(join(local, "evidence-"));
          (state.extractionAttempts ??= []).push(basename(extracted)); save();
          const hash = extractArchive(bytes, extracted);
          state.evidence = basename(extracted); state.evidenceSha256 = hash; save();
        }
        await validateEvidence(); state.collectedAt ??= new Date().toISOString(); state.status = "collected"; save();
        verifyArchive(); await validateEvidence();
        assert.ok(unit(), "unit became active; preserve host"); own(); check();
        state.deletionIntentAt = new Date().toISOString(); save();
        execute("doctl", ["compute", "droplet", "delete", state.id, "--force"], 120000);
        assert.ok(!list().some((d) => String(d.id) === state.id), "deletion not confirmed; host state uncertain");
        verifyArchive(); await validateEvidence(); state.destroyedAt = new Date().toISOString(); save(); return deletedCode();
      });
    },
    async deliverAudit() {
      assert.ok(options.deliverAudit, "audit delivery options required");
      return locked(async () => {
        assert.ok(state.id && state.ip && !state.deletionIntentAt && !state.collectedAt && ["starting", "running"].includes(state.status), "live owned campaign required");
        assert.ok(!state.auditIntent, "audit delivery already attempted; inspect, never repeat");
        const bytes = regular(resolve(options.deliverAudit), 16 * 1024 ** 2), intent = auditDelivery(bytes, options);
        assert.equal(unit(), false, "terminal campaign cannot accept delivery");
        assert.equal(ssh(auditScript(state, intent)).stdout.trim(), intent.subjectSha256);
        durable(join(local, "json-audit-delivery.json"), bytes);
        state.auditIntent = intent; save();
        const stage = `/bench/cloud-audit-${state.token}.json`;
        ssh(`test ! -e ${stage} && test ! -L ${stage} && install -m 600 /dev/null ${stage}`);
        scp(join(local, "json-audit-delivery.json"), `root@${state.ip}:${stage}`);
        assert.equal(unit(), false, "campaign ended during audit transfer");
        assert.equal(ssh(auditScript(state, intent, true)).stdout.trim(), intent.subjectSha256);
        return 3;
      });
    },
  };
}

// Never print exception messages/stacks or provider output: assertions may echo raw evidence.
export function publicError() { return "Controller stopped; retained state/evidence requires inspection. Host/deletion state may be uncertain. Never relaunch."; }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    parseDropletArgs(process.argv.slice(2));
    assert.fail("provisional controller: production cloud transport disabled");
  } catch { console.error(publicError()); process.exitCode = 2; }
}
