// Explicit catalog-page only. No imports of nightly launch/state/cleanup code.
// Launch: cN --group catalog-page --detach --commit SHA --ssh-key ID --state-dir OUTSIDE_CHECKOUT
// Collect: cN --group catalog-page --collect --state-dir SAME_DIRECTORY
// Exit: 0 complete+deleted, 1 partial+deleted, 2 error/preserved, 3 running/preserved.
// A process killed while holding operation.lock or .catalog-page-launch.lock needs manual
// exact-process inspection before removing that lock. Unresolved reservations block other
// rounds in the same state root. Never relaunch a reserved round, even if create timed out.
// Interrupted downloads and unrecorded archives are retained: inspect/move them aside before
// retry. Missing/unstarted units require operator inspection/repair, never automatic deletion.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, fsyncSync, openSync, closeSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectCatalog, renderCatalog } from "./report.mjs";
import { ownedDroplet, parseDropletArgs, remoteFiles, reservation, roundName, safeArchive, tags, terminalUnit, validateCollected, validateState } from "./droplet-contract.mjs";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function command(binary, args, timeout = 60000, allowFail = false) {
  const r = spawnSync(binary, args, { cwd: checkout, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout, maxBuffer: 16 * 1024 * 1024 });
  if (!allowFail && (r.error || r.status !== 0)) throw new Error(`${binary}: ${r.error?.message ?? r.stderr}`);
  return r;
}
function writeDurable(path, data, exclusive = false) {
  const fd = openSync(path, exclusive ? "wx" : "w");
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path) {
  if (process.platform === "win32") return; // Windows cannot open a directory for fsync.
  const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function syncFile(path) {
  const fd = openSync(path, "r+"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function evidenceHash(root) {
  const hash = createHash("sha256");
  function visit(path, key) {
    const stat = lstatSync(path); assert.ok(!stat.isSymbolicLink(), "evidence contains a link");
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name), `${key}/${name}`);
    else { assert.ok(stat.isFile(), "evidence contains special file"); hash.update(`${key}\0${stat.size}\0`); hash.update(readFileSync(path)); }
  }
  visit(root, ""); return hash.digest("hex");
}
const outside = (root, path) => { const r = relative(root, path); return isAbsolute(r) || r === ".." || r.startsWith(`..${sep}`); };
export function controller(options, { run = command, repo = checkout, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), inspect = inspectCatalog } = {}) {
  assert.equal(options.group, "catalog-page"); roundName(options.round);
  repo = realpathSync(repo);
  // Resolve existing symlinked parents BEFORE creating any control state.
  const requested = resolve(options.stateDir);
  let parent = requested;
  while (!existsSync(parent)) parent = dirname(parent);
  assert.ok(outside(repo, resolve(realpathSync(parent), relative(parent, requested))), "state directory must be outside checkout (including symlinks)");
  mkdirSync(requested, { recursive: true });
  const base = realpathSync(requested);
  assert.ok(outside(repo, base) && outside(base, repo), "state/checkout must be disjoint");
  const local = join(base, `catalog-page-${options.round}`), statePath = join(local, "state.json");
  const roundBoundary = (path) => {
    const stat = lstatSync(path);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "physical round boundary is a symlink or not a directory");
    const physical = realpathSync(path);
    assert.equal(physical, path, "physical round boundary changed");
    assert.ok(dirname(physical) === base && outside(repo, physical), "physical round boundary leaves state root or enters checkout");
  };
  const read = () => {
    roundBoundary(local);
    assert.ok(lstatSync(statePath).isFile() && !lstatSync(statePath).isSymbolicLink(), "state is not a regular file");
    return validateState(JSON.parse(readFileSync(statePath, "utf8")), options.round);
  };
  let state;
  const save = () => { validateState(state, options.round); writeDurable(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`); renameSync(`${statePath}.tmp`, statePath); syncDirectory(local); };
  const list = () => { const d = JSON.parse(run("doctl", ["compute", "droplet", "list", "--output", "json"]).stdout); assert.ok(Array.isArray(d)); return d; };
  const own = () => ownedDroplet(list(), state);
  const sshOptions = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${join(local, "known_hosts").replaceAll("\\", "/")}`,
    "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2"];
  const ssh = (script, timeout = 60000, allowFail = false) => run("ssh", [...sshOptions, `root@${state.ip}`, script], timeout, allowFail);
  const scp = (from, to) => run("scp", ["-q", ...sshOptions, from, to], 15 * 60000);
  const unit = () => terminalUnit(ssh(`systemctl show ${state.unit} --property=Id --property=LoadState --property=FragmentPath --property=ActiveState --property=Restart --property=MainPID --property=ExecMainCode --property=ExecMainStartTimestamp`).stdout, state);
  const bind = (d) => {
    state.id = String(d.id);
    const ip = d.networks?.v4?.filter((n) => n.type === "public"); assert.equal(ip?.length, 1, "ambiguous/missing public address");
    if (state.ip) assert.equal(state.ip, ip[0].ip_address, "host address changed");
    state.ip = ip[0].ip_address; save();
  };
  async function locked(fn) {
    // This MUST precede even opening the lock: local may be a junction into the checkout.
    roundBoundary(local);
    const lock = join(local, "operation.lock");
    writeDurable(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), true);
    try { state = read(); return await fn(); } finally { unlinkSync(lock); }
  }
  const archive = join(local, "results.tgz");
  function verifyArchive() {
    assert.ok(lstatSync(archive).isFile() && !lstatSync(archive).isSymbolicLink());
    assert.equal(createHash("sha256").update(readFileSync(archive)).digest("hex"), state.archiveSha256, "archive hash mismatch; host preserved");
  }
  function validateEvidence() {
    const extracted = join(local, state.evidence), source = join(extracted, "repo", "bench", "catalog", "results", state.round);
    assert.equal(evidenceHash(extracted), state.evidenceSha256, "extracted evidence changed; preserve host");
    state.complete = false; delete state.validationError;
    let report;
    try {
      const exit = readFileSync(join(extracted, "exit-code"), "utf8").trim(); assert.match(exit, /^(?:0|[1-9]\d{0,2})$/, "invalid exit code");
      state.exitCode = Number(exit); assert.equal(state.exitCode, 0, "remote job failed");
      const summary = JSON.parse(readFileSync(join(source, "summary.json"), "utf8"));
      report = validateCollected(summary, state, inspect);
      state.complete = true;
    } catch (e) {
      if (!(e instanceof assert.AssertionError || e instanceof SyntaxError || e.code === "ENOENT")) throw e;
      state.validationError = e.message;
    }
    if (report) writeDurable(join(local, "validated-report.md"), renderCatalog(report));
    save();
  }
  return {
    get state() { return state; }, local,
    async launch() {
      assert.match(options.commit ?? "", /^[a-f0-9]{40}$/); assert.match(options.sshKey ?? "", /^[1-9]\d*$/);
      const launchLock = join(base, ".catalog-page-launch.lock");
      writeDurable(launchLock, JSON.stringify({ pid: process.pid, round: options.round, at: new Date().toISOString() }), true);
      try {
      assert.ok(!existsSync(local), "round already reserved; never relaunch");
      // Serialize the entire preflight/create/reconciliation against other launch processes.
      // An ambiguous create may not be listed yet: durable reservations, not just the current
      // cloud list, must prevent a second round after the first process has stopped.
      for (const entry of readdirSync(base, { withFileTypes: true })) if (entry.name.startsWith("catalog-page-")) {
        const match = /^catalog-page-(c[1-9]\d*)$/.exec(entry.name);
        assert.ok(match, `unrecognized catalog reservation ${entry.name}`);
        const path = join(base, entry.name); roundBoundary(path);
        const file = join(path, "state.json");
        assert.ok(existsSync(file), `${match[1]}: unresolved catalog reservation without state`);
        assert.ok(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), "reservation state is not a regular file");
        const previous = validateState(JSON.parse(readFileSync(file, "utf8")), match[1]);
        assert.ok(previous.destroyedAt, `${previous.round}: unresolved catalog reservation; collect/inspect before another launch`);
      }
      // mkdir is the exclusive round reservation. Even an interrupted preflight cannot relaunch.
      mkdirSync(local);
      const token = randomBytes(8).toString("hex");
      state = reservation(options.round, options.commit, token);
      writeDurable(statePath, `${JSON.stringify(state, null, 2)}\n`, true);
      syncDirectory(local); syncDirectory(base);
      return await locked(async () => {
        assert.equal(realpathSync(run("git", ["rev-parse", "--show-toplevel"]).stdout.trim()), repo, "not the measured repository root");
        assert.equal(run("git", ["rev-parse", "HEAD"]).stdout.trim(), state.commit, "measured SHA must be HEAD");
        assert.equal(run("git", ["status", "--porcelain", "--untracked-files=all"]).stdout.trim(), "", "launch requires clean committed source");
        run("git", ["merge-base", "--is-ancestor", state.commit, "origin/main"]);
        for (const path of ["bench/catalog/droplet.mjs", "bench/catalog/droplet-contract.mjs", "bench/catalog/run.mjs", "bench/catalog/report.mjs", "bench/catalog/group.mjs", "bench/workloads/registry.mjs"])
          run("git", ["cat-file", "-e", `${state.commit}:${path}`]);
        assert.ok(!existsSync(join(repo, "bench", "catalog", "results", state.round)), "result round already exists");
        const existing = list();
        assert.ok(!existing.some((d) => d.name?.startsWith("corten-catalog-page-") || d.tags?.includes("corten-catalog-page")), "catalog-page host already exists");
        const account = JSON.parse(run("doctl", ["account", "get", "--output", "json"]).stdout);
        const limit = (Array.isArray(account) ? account[0] : account)?.droplet_limit;
        assert.ok(Number.isSafeInteger(limit) && existing.length < limit, "missing/exhausted droplet limit");
        // This intent is durable BEFORE the only create call. Timeout is never retried.
        state.createIntentAt = new Date().toISOString(); save();
        run("doctl", ["compute", "droplet", "create", state.name, "--size", state.host.size, "--region", state.host.region, "--image", state.host.image,
          "--ssh-keys", options.sshKey, "--tag-names", [...tags, state.tag].join(","), "--wait", "--output", "json"], 10 * 60000, true);
        bind(own()); state.status = "preparing"; save();
        let ready = false;
        for (let i = 0; i < 40; i++) { if (ssh("true", 30000, true).status === 0) { ready = true; break; } await sleep(10000); }
        assert.ok(ready, "SSH unavailable; preserve host, never relaunch");
        ssh("mkdir -p /bench && touch /bench/run.log");
        for (const [name, content] of Object.entries(remoteFiles(state))) {
          writeFileSync(join(local, name), content); scp(join(local, name), `root@${state.ip}:/bench/${name}`);
        }
        own();
        ssh(`bash -n /bench/job.sh && bash -n /bench/pack.sh && install -m 644 /bench/${state.unit} /etc/systemd/system/${state.unit} && systemd-analyze verify /etc/systemd/system/${state.unit} && systemctl daemon-reload`);
        state.status = "starting"; save();
        ssh(`systemctl start ${state.unit}`);
        // A fast failure is collectable, never restarted.
        unit(); state.status = "running"; save(); return state;
      });
      } finally { unlinkSync(launchLock); }
    },
    async collect() {
      return locked(async () => {
        const confirmDeleted = () => { verifyArchive(); validateEvidence(); state.destroyedAt ??= new Date().toISOString(); save(); return state.complete ? 0 : 1; };
        if (state.destroyedAt || state.deletionIntentAt) {
          verifyArchive();
          if (!list().some((d) => String(d.id) === state.id)) return confirmDeleted();
          assert.ok(!state.destroyedAt, "deleted identity is still listed; preserve host");
        }
        bind(own());
        if (!unit()) return 3;
        if (!state.archiveSha256) {
          ssh("timeout 600 /bin/bash /bench/pack.sh", 11 * 60000);
          const hash = ssh("sha256sum /bench/results.tgz").stdout.trim().split(/\s+/)[0]; assert.match(hash, /^[a-f0-9]{64}$/);
          const download = `${archive}.download`;
          assert.ok(!existsSync(download), "previous download retained; inspect and move it aside before retry");
          scp(`root@${state.ip}:/bench/results.tgz`, download);
          assert.equal(createHash("sha256").update(readFileSync(download)).digest("hex"), hash, "download hash mismatch; host preserved");
          assert.ok(!existsSync(archive), "unrecorded archive exists; inspect before retry");
          syncFile(download); renameSync(download, archive); state.archiveSha256 = hash; save();
        }
        verifyArchive();
        if (!state.evidence) {
          safeArchive(run("tar", ["-tzf", archive]).stdout, run("tar", ["-tvzf", archive]).stdout, state.round);
          const extracted = mkdtempSync(join(local, "evidence-"));
          (state.extractionAttempts ??= []).push(basename(extracted)); save();
          run("tar", ["-xzf", archive, "--no-same-owner", "--no-same-permissions", "-C", extracted], 5 * 60000);
          state.evidence = basename(extracted); state.evidenceSha256 = evidenceHash(extracted); save();
        }
        validateEvidence(); state.collectedAt ??= new Date().toISOString(); state.status = "collected"; save();
        // Transport/path/extraction errors preserve the host. Validly downloaded failed jobs
        // are partial evidence, not baselines, and can be deleted after repeated safety checks.
        verifyArchive(); own(); assert.ok(unit(), "unit became active; no deletion");
        state.deletionIntentAt ??= new Date().toISOString(); save();
        run("doctl", ["compute", "droplet", "delete", state.id, "--force"], 120000);
        assert.ok(!list().some((d) => String(d.id) === state.id), "deletion not confirmed; retry collect");
        return confirmDeleted();
      });
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseDropletArgs(process.argv.slice(2)), task = controller(options);
    if (options.collect) process.exitCode = await task.collect(); else await task.launch();
    console.log(JSON.stringify(task.state, null, 2));
  } catch (e) { console.error(`${e.stack}\nReservation/owned host preserved on uncertainty. Never relaunch; inspect durable state and retry collection.`); process.exitCode = 2; }
}
