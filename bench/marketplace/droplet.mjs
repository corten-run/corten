// Detached nightly launcher. A durable reservation and unique tag survive ambiguous creates.
// Collection downloads and hashes even partial evidence before deleting only a terminal owned host.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nightly, ownedDroplet, parseDropletArgs, remoteFiles, safeArchive, terminalUnit, validateState } from "./droplet-contract.mjs";
import { validateSummary } from "./report.mjs";
import { groupApps, scheduledGroup } from "./groups.mjs";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function command(binary, args, timeout = 60000, allowFail = false) {
  const result = spawnSync(binary, args, { cwd: checkout, encoding: "utf8", windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], timeout, maxBuffer: 16 * 1024 * 1024 });
  if ((result.error || result.status !== 0) && !allowFail) throw new Error(`${binary}: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  return result;
}
export function controller(options, { run = command, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), repo = checkout } = {}) {
  const local = resolve(options.stateDir);
  const rel = relative(repo, local);
  assert.ok(isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`), "launcher state must live outside the measured checkout");
  mkdirSync(local, { recursive: true });
  const statePath = join(local, "state.json");
  let state = existsSync(statePath) ? validateState(JSON.parse(readFileSync(statePath, "utf8")), options.round) : null;
  const save = () => { writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2) + "\n"); renameSync(`${statePath}.tmp`, statePath); };
  const list = () => JSON.parse(run("doctl", ["compute", "droplet", "list", "--output", "json"]).stdout);
  const own = () => ownedDroplet(list(), state);
  const sshOptions = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${join(local, "known_hosts").replaceAll("\\", "/")}`,
    "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2"];
  const ssh = (script, timeout = 60000, allowFail = false) => run("ssh", [...sshOptions, `root@${state.ip}`, script], timeout, allowFail);
  const scp = (from, to) => run("scp", ["-q", ...sshOptions, from, to], 15 * 60000);
  const unit = () => ssh(`systemctl show ${state.unit} --property=LoadState --property=ActiveState --property=Restart`).stdout;
  return {
    async launch() {
      assert.equal(state, null, "launch already reserved; never create a second droplet for this round");
      const commit = run("git", ["rev-parse", "HEAD"]).stdout.trim();
      assert.match(commit, /^[a-f0-9]{40}$/);
      assert.equal(run("git", ["status", "--porcelain"]).stdout.trim(), "", "launch requires clean measured commit");
      assert.ok(!list().some((d) => d.tags?.some((t) => ["corten-bench", "corten-marketplace"].includes(t))), "a nightly benchmark droplet already exists; do not overlap nightly rounds");
      state = { workload: "marketplace-v2", round: options.round, commit, status: "creating", name: `corten-marketplace-${options.round}`,
        tag: `corten-marketplace-run-${randomBytes(8).toString("hex")}`, unit: `corten-marketplace-${options.round}.service`, startedAt: new Date().toISOString(), options: nightly,
        group: options.group ?? scheduledGroup(options.round), apps: groupApps(options.group ?? scheduledGroup(options.round)) };
      writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", { flag: "wx" });
      const created = run("doctl", ["compute", "droplet", "create", state.name, "--size", "c-8", "--region", "sfo2", "--image", "ubuntu-24-04-x64", "--ssh-keys", options.sshKey,
        "--tag-names", `corten-bench,corten-marketplace,${state.tag}`, "--wait", "--output", "json"], 10 * 60000, true);
      let d;
      try { d = own(); } catch (e) { throw new Error(`create exit ${created.status}: ${created.stderr}; ${e.message}; do not relaunch`); }
      state.id = String(d.id); state.ip = d.networks.v4.find((n) => n.type === "public")?.ip_address;
      state.hourlyPrice = d.size.price_hourly; state.status = "preparing"; save(); validateState(state, options.round);
      assert.ok(state.ip, "new droplet has no public IP; preserve reservation");
      console.log(`droplet ${state.id} at ${state.ip}; provisioning on the droplet`);
      let answered = false;
      for (let i = 0; i < 40; i++) { if (ssh("true", 30000, true).status === 0) { answered = true; break; } await sleep(10000); }
      assert.ok(answered, "SSH did not become ready; droplet preserved, do not relaunch");
      ssh("mkdir -p /bench; touch /bench/run.log");
      for (const [name, content] of Object.entries(remoteFiles(state))) {
        writeFileSync(join(local, name), content); scp(join(local, name), `root@${state.ip}:/bench/${name}`);
      }
      ssh(`bash -n /bench/job.sh && bash -n /bench/pack.sh && install -m 644 /bench/${state.unit} /etc/systemd/system/${state.unit} && systemd-analyze verify /etc/systemd/system/${state.unit} && systemctl daemon-reload && systemctl start ${state.unit}`);
      const output = unit();
      assert.ok(!terminalUnit(output), "job ended during launch; collect evidence, do not relaunch");
      state.status = "running"; save();
      console.log(`running round ${state.round} on the droplet by itself, commit ${state.commit}`);
      return state;
    },
    async collect() {
      assert.ok(state, "missing launch reservation");
      const lock = join(local, "collect.lock");
      writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx" });
      try {
        const verifyArchive = () => assert.equal(createHash("sha256").update(readFileSync(state.resultArchive)).digest("hex"), state.archiveSha256);
        const deleted = () => {
          verifyArchive();
          state.destroyedAt ??= new Date().toISOString(); save();
          console.log(`${state.complete ? "all done" : `partial results (the round did not finish): ${state.validationError}`}\nresults in ${state.resultFolder}\ndroplet ${state.id} deletion confirmed`);
          return state.complete ? 0 : 1;
        };
        if (state.destroyedAt) {
          assert.ok(!list().some((d) => String(d.id) === state.id), "previously deleted droplet still present");
          return deleted();
        }
        if (state.deletionIntentAt && state.collectedAt && !list().some((d) => String(d.id) === state.id)) {
          // A delete may succeed even when its acknowledgement or the next list is lost.
          // The intent was saved only after owned-terminal checks and verified collection.
          return deleted();
        }
        const d = own();
        state.id = String(d.id); state.ip = d.networks.v4.find((n) => n.type === "public")?.ip_address; save(); validateState(state, options.round);
        if (!terminalUnit(unit())) {
          console.log(`round ${state.round} is still running\n${ssh("tail -n 8 /bench/run.log").stdout}`);
          return 3;
        }
        if (!state.collectedAt) {
          if (!state.resultArchive) {
            ssh("/bin/bash /bench/pack.sh", 10 * 60000);
            const hash = ssh("sha256sum /bench/results.tgz").stdout.trim().split(/\s+/)[0]; assert.match(hash, /^[a-f0-9]{64}$/);
            const archive = join(local, "results.tgz");
            scp(`root@${state.ip}:/bench/results.tgz`, `${archive}.download`);
            assert.equal(createHash("sha256").update(readFileSync(`${archive}.download`)).digest("hex"), hash, "download hash mismatch; droplet preserved");
            renameSync(`${archive}.download`, archive);
            Object.assign(state, { resultArchive: archive, archiveSha256: hash }); save();
          }
          verifyArchive();
          const archive = state.resultArchive;
          safeArchive(run("tar", ["-tzf", archive]).stdout, run("tar", ["-tvzf", archive]).stdout, state.round);
          const extracted = mkdtempSync(join(local, "evidence-"));
          (state.extractionAttempts ??= []).push(extracted); save();
          run("tar", ["-xzf", archive, "-C", extracted], 5 * 60000);
          const source = join(extracted, "repo", "bench", "marketplace", "results", state.round);
          state.exitCode = Number(readFileSync(join(extracted, "exit-code"), "utf8").trim());
          state.complete = false;
          try {
            assert.equal(state.exitCode, 0, "remote job failed");
            const s = validateSummary(JSON.parse(readFileSync(join(source, "summary.json"), "utf8")));
            assert.equal(s.round, state.round); assert.equal(s.commit, state.commit);
            assert.equal(s.options.group ?? "full", state.group ?? "full", "collected group differs from reservation");
            assert.deepEqual(s.options.apps, state.apps ?? groupApps(), "collected adapters differ from reservation");
            for (const [key, value] of Object.entries(nightly)) assert.equal(s.options[key], value, `unexpected ${key}`);
            state.complete = true;
          } catch (e) { state.validationError = e.message; }
          // Keep collection independent of Git imports: no partial copy can poison a retry.
          Object.assign(state, { resultFolder: existsSync(source) ? source : extracted, evidenceFolder: extracted,
            collectedAt: new Date().toISOString(), status: state.complete ? "done" : "failed" }); save();
        }
        // Repeat identity + terminal checks after the download, including cleanup retries.
        verifyArchive();
        own(); assert.ok(terminalUnit(unit()), "unit became active; refusing deletion");
        state.deletionIntentAt ??= new Date().toISOString(); save();
        run("doctl", ["compute", "droplet", "delete", state.id, "--force"], 120000);
        assert.ok(!list().some((item) => String(item.id) === state.id), "droplet deletion not confirmed");
        return deleted();
      } finally { unlinkSync(lock); }
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseDropletArgs(process.argv.slice(2));
    if (options.plan) {
      const s = { workload: "marketplace-v2", round: options.round, name: `corten-marketplace-${options.round}`, unit: `corten-marketplace-${options.round}.service`, tag: `corten-marketplace-run-${"0".repeat(16)}`, commit: "0".repeat(40), options: nightly, group: options.group, apps: groupApps(options.group) };
      console.log(JSON.stringify({ options, measurements: nightly, files: remoteFiles(s) }, null, 2));
    } else {
      const task = controller(options);
      if (options.collect) process.exitCode = await task.collect(); else await task.launch();
    }
  } catch (e) { console.error(e.stack); process.exitCode = 2; }
}
