// Detached nightly launcher. A durable reservation and unique tag survive ambiguous creates.
// Collection downloads and hashes even partial evidence before deleting only a terminal owned host.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nightly, ownedDroplet, parseDropletArgs, remoteFiles, safeArchive, terminalUnit, validateState } from "./droplet-contract.mjs";
import { validateSummary } from "./report.mjs";

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
        tag: `corten-marketplace-run-${randomBytes(8).toString("hex")}`, unit: `corten-marketplace-${options.round}.service`, startedAt: new Date().toISOString(), options: nightly };
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
        if (state.destroyedAt) {
          assert.ok(!list().some((d) => String(d.id) === state.id), "previously deleted droplet still present");
          assert.equal(createHash("sha256").update(readFileSync(state.resultArchive)).digest("hex"), state.archiveSha256);
          console.log(`already collected ${state.round}: ${state.status}; ${state.resultFolder}`);
          return state.complete ? 0 : 1;
        }
        const d = own();
        state.id = String(d.id); state.ip = d.networks.v4.find((n) => n.type === "public")?.ip_address; save(); validateState(state, options.round);
        if (!terminalUnit(unit())) {
          console.log(`round ${state.round} is still running\n${ssh("tail -n 8 /bench/run.log").stdout}`);
          return 3;
        }
        if (!state.collectedAt) {
          ssh("/bin/bash /bench/pack.sh", 10 * 60000);
          const hash = ssh("sha256sum /bench/results.tgz").stdout.trim().split(/\s+/)[0]; assert.match(hash, /^[a-f0-9]{64}$/);
          const archive = join(local, "results.tgz");
          scp(`root@${state.ip}:/bench/results.tgz`, `${archive}.download`);
          assert.equal(createHash("sha256").update(readFileSync(`${archive}.download`)).digest("hex"), hash, "download hash mismatch; droplet preserved");
          renameSync(`${archive}.download`, archive);
          safeArchive(run("tar", ["-tzf", archive]).stdout, run("tar", ["-tvzf", archive]).stdout, state.round);
          const extracted = join(local, "evidence");
          mkdirSync(extracted); run("tar", ["-xzf", archive, "-C", extracted], 5 * 60000);
          const source = join(extracted, "repo", "bench", "marketplace", "results", state.round);
          const destination = join(repo, "bench", "marketplace", "results", state.round);
          assert.ok(!existsSync(destination), "result directory already exists; preserve both copies for inspection");
          if (existsSync(source)) cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
          state.exitCode = Number(readFileSync(join(extracted, "exit-code"), "utf8").trim());
          state.complete = false;
          try {
            assert.equal(state.exitCode, 0, "remote job failed");
            const s = validateSummary(JSON.parse(readFileSync(join(destination, "summary.json"), "utf8")));
            assert.equal(s.round, state.round); assert.equal(s.commit, state.commit);
            for (const [key, value] of Object.entries(nightly)) assert.equal(s.options[key], value, `unexpected ${key}`);
            state.complete = true;
          } catch (e) { state.validationError = e.message; }
          Object.assign(state, { resultArchive: archive, archiveSha256: hash, resultFolder: destination, evidenceFolder: extracted,
            collectedAt: new Date().toISOString(), status: state.complete ? "done" : "failed" }); save();
        }
        // Repeat identity + terminal checks after the download, including cleanup retries.
        assert.equal(createHash("sha256").update(readFileSync(state.resultArchive)).digest("hex"), state.archiveSha256);
        own(); assert.ok(terminalUnit(unit()), "unit became active; refusing deletion");
        run("doctl", ["compute", "droplet", "delete", state.id, "--force"], 120000);
        assert.ok(!list().some((item) => String(item.id) === state.id), "droplet deletion not confirmed");
        state.destroyedAt = new Date().toISOString(); save();
        console.log(`${state.complete ? "all done" : `partial results (the round did not finish): ${state.validationError}`}\nresults in ${state.resultFolder}\ndroplet ${state.id} deletion confirmed`);
        return state.complete ? 0 : 1;
      } finally { unlinkSync(lock); }
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseDropletArgs(process.argv.slice(2));
    if (options.plan) {
      const s = { workload: "marketplace-v2", round: options.round, name: `corten-marketplace-${options.round}`, unit: `corten-marketplace-${options.round}.service`, tag: `corten-marketplace-run-${"0".repeat(16)}`, commit: "0".repeat(40), options: nightly };
      console.log(JSON.stringify({ options, measurements: nightly, files: remoteFiles(s) }, null, 2));
    } else {
      const task = controller(options);
      if (options.collect) process.exitCode = await task.collect(); else await task.launch();
    }
  } catch (e) { console.error(e.stack); process.exitCode = 2; }
}
