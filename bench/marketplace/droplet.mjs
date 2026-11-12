// Detached nightly launcher. A durable reservation and unique tag survive ambiguous creates.
// Collection downloads and hashes even partial evidence before deleting only a terminal owned host.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { leftoverDroplets, nightly, ownedDroplet, parseDropletArgs, remoteFiles, safeArchive, splitExit, splitPlan, terminalUnit, validatePlan, validateState } from "./droplet-contract.mjs";
import { validateSummary } from "./report.mjs";
import { partName } from "./run-contract.mjs";
import { mergeParts } from "./split.mjs";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function command(binary, args, timeout = 60000, allowFail = false) {
  const result = spawnSync(binary, args, { cwd: checkout, encoding: "utf8", windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], timeout, maxBuffer: 16 * 1024 * 1024 });
  if ((result.error || result.status !== 0) && !allowFail) throw new Error(`${binary}: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  return result;
}
// The launcher's durable state lives outside the measured checkout.
function controlDir(stateDir, repo) {
  const local = resolve(stateDir);
  const rel = relative(repo, local);
  assert.ok(isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`), "launcher state must live outside the measured checkout");
  mkdirSync(local, { recursive: true });
  return local;
}
const benchTagged = (droplets) => droplets.some((d) => d.tags?.some((t) => ["corten-bench", "corten-marketplace"].includes(t)));
/**
 * One droplet's launcher: the whole round, or with options.part one droplet's part of a split
 * round (#816), whose checkout checks and measured commit (options.commit) the split launcher
 * made once for every droplet.
 */
export function controller(options, { run = command, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), repo = checkout, interrupted = () => null } = {}) {
  const local = controlDir(options.stateDir, repo);
  const part = options.part ?? null;
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
  // Reserve, then create the droplet; start() provisions it and starts its round.
  async function create() {
    assert.equal(state, null, "launch already reserved; never create a second droplet for this round");
    const commit = part ? options.commit : run("git", ["rev-parse", "HEAD"]).stdout.trim();
    assert.match(commit, /^[a-f0-9]{40}$/);
    if (!part) {
      assert.equal(run("git", ["status", "--porcelain"]).stdout.trim(), "", "launch requires clean measured commit");
      assert.ok(!benchTagged(list()), "a nightly benchmark droplet already exists; do not overlap nightly rounds");
    }
    const name = `corten-marketplace-${partName(options.round, part)}`;
    state = { workload: "marketplace-v2", round: options.round, commit, status: "creating", name,
      tag: `corten-marketplace-run-${randomBytes(8).toString("hex")}`, unit: `${name}.service`, startedAt: new Date().toISOString(), options: nightly, ...(part ? { part } : {}) };
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", { flag: "wx" });
    const created = run("doctl", ["compute", "droplet", "create", state.name, "--size", "c-8", "--region", "sfo2", "--image", "ubuntu-24-04-x64", "--ssh-keys", options.sshKey,
      "--tag-names", `corten-bench,corten-marketplace,${state.tag}`, "--wait", "--output", "json"], 10 * 60000, true);
    let d;
    try { d = own(); } catch (e) { throw new Error(`create exit ${created.status}: ${created.stderr}; ${e.message}; do not relaunch`); }
    state.id = String(d.id); state.ip = d.networks.v4.find((n) => n.type === "public")?.ip_address;
    state.hourlyPrice = d.size.price_hourly; state.status = "preparing"; save(); validateState(state, options.round);
    assert.ok(state.ip, "new droplet has no public IP; preserve reservation");
    console.log(`droplet ${state.id} at ${state.ip}; provisioning on the droplet`);
  }
  async function start() {
    assert.equal(state?.status, "preparing", "start needs a created droplet that has not started its round");
    let answered = false;
    for (let i = 0; i < 40; i++) {
      const signal = interrupted();
      if (signal) throw new Error(`${signal} received while waiting for SSH; droplet preserved, its round not started`);
      if (ssh("true", 30000, true).status === 0) { answered = true; break; }
      await sleep(10000);
    }
    assert.ok(answered, "SSH did not become ready; droplet preserved, do not relaunch");
    ssh("mkdir -p /bench; touch /bench/run.log");
    for (const [name, content] of Object.entries(remoteFiles(state))) {
      writeFileSync(join(local, name), content); scp(join(local, name), `root@${state.ip}:/bench/${name}`);
    }
    ssh(`bash -n /bench/job.sh && bash -n /bench/pack.sh && install -m 644 /bench/${state.unit} /etc/systemd/system/${state.unit} && systemd-analyze verify /etc/systemd/system/${state.unit} && systemctl daemon-reload`);
    // From here the round may be running, whatever happens next, so collect must look at it.
    state.status = "starting"; save();
    ssh(`systemctl start ${state.unit}`);
    const output = unit();
    assert.ok(!terminalUnit(output), "job ended during launch; collect evidence, do not relaunch");
    state.status = "running"; save();
    console.log(`running round ${state.round} on the droplet by itself, commit ${state.commit}`);
    return state;
  }
  return {
    create, start,
    get state() { return state; },
    sshOptions,
    async launch() { await create(); return start(); },
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
          safeArchive(run("tar", ["-tzf", archive]).stdout, run("tar", ["-tvzf", archive]).stdout, state.round, state.part ?? null);
          const extracted = mkdtempSync(join(local, "evidence-"));
          (state.extractionAttempts ??= []).push(extracted); save();
          run("tar", ["-xzf", archive, "-C", extracted], 5 * 60000);
          const source = join(extracted, "repo", "bench", "marketplace", "results", state.round, ...(state.part ? [`d${state.part.index}`] : []));
          state.exitCode = Number(readFileSync(join(extracted, "exit-code"), "utf8").trim());
          state.complete = false;
          try {
            assert.equal(state.exitCode, 0, "remote job failed");
            const s = validateSummary(JSON.parse(readFileSync(join(source, "summary.json"), "utf8")));
            assert.equal(s.round, state.round); assert.equal(s.commit, state.commit);
            assert.deepEqual(s.options.part ?? null, state.part ?? null, "the summary is not this droplet's part");
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

/**
 * A round split across droplets started together (#816). The state directory holds split.json,
 * the plan written once before any droplet (the measured commit, decided here for every droplet,
 * and each droplet's apps), and d<k>/ with each droplet's launcher state, known_hosts and
 * evidence. launch() checks the checkout, existing droplets and the account's droplet limit once,
 * creates every droplet, then starts each one's round, so the rounds start together. collect()
 * collects each droplet on its own, deleting each one that finished, and merges the round into
 * round/<round>/ only once every droplet has finished.
 * @param {object} options parseDropletArgs's, with droplets to launch
 * @param {object} [deps] as controller takes them, plus interrupted() naming a received signal
 */
export function splitController(options, deps = {}) {
  const { run = command, repo = checkout, interrupted = () => null } = deps;
  const local = controlDir(options.stateDir, repo);
  assert.ok(!existsSync(join(local, "state.json")), "this state directory holds a one-droplet round; use another for a split round");
  const planPath = join(local, "split.json");
  let plan = existsSync(planPath) ? validatePlan(JSON.parse(readFileSync(planPath, "utf8")), options.round) : null;
  const partDir = (k) => join(local, `d${k}`);
  const list = () => JSON.parse(run("doctl", ["compute", "droplet", "list", "--output", "json"]).stdout);
  const task = (p) => controller({ round: options.round, stateDir: partDir(p.index), sshKey: options.sshKey, part: { index: p.index, of: plan.droplets }, commit: plan.commit }, deps);
  const stateOf = (p) => {
    const file = join(partDir(p.index), "state.json");
    return existsSync(file) ? validateState(JSON.parse(readFileSync(file, "utf8")), options.round) : null;
  };
  const name = (p) => `${options.round}-d${p.index}`;
  const collectCommand = `node bench/marketplace/droplet.mjs ${options.round} --state-dir "${local}" --collect`;
  const stop = (p, s) => `ssh -o "UserKnownHostsFile=${join(partDir(p.index), "known_hosts").replaceAll("\\", "/")}" root@${s.ip} systemctl stop ${s.unit}`;
  // What a stopped launch leaves on each droplet, said plainly, with the command for each.
  function stranded() {
    const lines = [`The launch of ${options.round} stopped, so the round cannot finish as planned.`];
    for (const p of plan.parts) {
      const s = stateOf(p);
      if (!s) lines.push(`${name(p)}: not created.`);
      else if (s.status === "running") lines.push(`${name(p)}: droplet ${s.id} keeps running its round until it is stopped. Stop it: ${stop(p, s)}`);
      else if (s.status === "starting") lines.push(`${name(p)}: droplet ${s.id} may have started its round; if it did, it keeps running until it is stopped. Stop it: ${stop(p, s)}`);
      else if (s.id) lines.push(`${name(p)}: droplet ${s.id} was created but its round did not start; it is billed until deleted: doctl compute droplet delete ${s.id} --force`);
      else lines.push(`${name(p)}: its create may have succeeded; look for a droplet named ${s.name} tagged ${s.tag} before deleting anything.`);
    }
    lines.push(`Then collect the started droplets' partial evidence and delete them: ${collectCommand}`);
    return lines.join("\n");
  }
  // The merged round from every droplet's validated part, written once into round/<round>/.
  function merge(states) {
    const parts = plan.parts.map((p, i) => {
      const file = join(states[i].resultFolder, "summary.json");
      assert.ok(existsSync(file), `${name(p)} has no summary.json in ${states[i].resultFolder}`);
      const s = validateSummary(JSON.parse(readFileSync(file, "utf8")));
      assert.equal(s.commit, plan.commit, `${name(p)} measured ${s.commit}, not the planned ${plan.commit}`);
      return s;
    });
    const merged = validateSummary(mergeParts(options.round, parts));
    const folder = join(local, "round", options.round);
    if (existsSync(folder)) {
      assert.deepEqual(JSON.parse(readFileSync(join(folder, "summary.json"), "utf8")), merged, `${folder} holds a different merge; preserve it`);
      return folder;
    }
    const temp = mkdtempSync(join(local, "merge-"));
    plan.parts.forEach((p, i) => cpSync(states[i].resultFolder, join(temp, `d${p.index}`), { recursive: true }));
    writeFileSync(join(temp, "split.json"), JSON.stringify(plan, null, 2) + "\n");
    writeFileSync(join(temp, "summary.json"), JSON.stringify(merged, null, 2) + "\n");
    mkdirSync(dirname(folder), { recursive: true }); renameSync(temp, folder);
    return folder;
  }
  return {
    get plan() { return plan; },
    async launch() {
      if (plan) throw new Error(`${options.round} is already planned in ${planPath} at commit ${plan.commit}; never launch a split round twice: collect it (${collectCommand})`);
      const commit = run("git", ["rev-parse", "HEAD"]).stdout.trim();
      assert.match(commit, /^[a-f0-9]{40}$/);
      assert.equal(run("git", ["status", "--porcelain"]).stdout.trim(), "", "launch requires clean measured commit");
      const results = join(repo, "bench", "marketplace", "results", options.round);
      assert.ok(!existsSync(results), `${results} exists; never reuse a result folder`);
      for (let k = 1; k <= options.droplets; k++) assert.ok(!existsSync(partDir(k)), `${partDir(k)} exists; use a new state directory for ${options.round}`);
      const droplets = list();
      assert.ok(!benchTagged(droplets), "a nightly benchmark droplet already exists; do not overlap nightly rounds");
      const account = JSON.parse(run("doctl", ["account", "get", "--output", "json"]).stdout);
      const limit = (Array.isArray(account) ? account[0] : account)?.droplet_limit;
      assert.ok(Number.isSafeInteger(limit) && limit > 0, "doctl account get gave no droplet_limit");
      assert.ok(droplets.length + options.droplets <= limit, `the account's droplet limit is ${limit} and ${droplets.length} droplets exist: no room for ${options.droplets} more`);
      plan = splitPlan(options.round, options.droplets, commit);
      writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
      console.log(`split ${options.round} across ${plan.droplets} droplets, commit ${commit}`);
      for (const p of plan.parts) console.log(`${name(p)}: ${p.apps.join(", ")}`);
      const tasks = plan.parts.map(task);
      try {
        // Every droplet is created before any round starts, so the rounds start together.
        for (const step of ["create", "start"]) for (const [i, t] of tasks.entries()) {
          const signal = interrupted();
          if (signal) throw new Error(`${signal} received`);
          console.log(`${name(plan.parts[i])}: ${step}`);
          await t[step]();
        }
      } catch (e) {
        let left;
        try { left = stranded(); } catch (s) { left = `What each droplet is left doing is unknown: ${s.message}. Collect the round: ${collectCommand}`; }
        // Saved too, so a closed stdout or stderr cannot lose what each droplet is left doing.
        const saved = join(local, "launch-stopped.txt");
        try { writeFileSync(saved, `${e.message}\n${left}\n`); left += `\nThis is also saved in ${saved}.`; } catch { /* the error still says it */ }
        throw new Error(`${e.message}\n${left}`, { cause: e });
      }
      console.log(`running ${options.round} on ${plan.droplets} droplets, each by itself; collect with: ${collectCommand}`);
      return plan;
    },
    async collect() {
      assert.ok(plan, `no split plan in ${planPath}`);
      const codes = [], neverStarted = new Set();
      for (const p of plan.parts) {
        const s = stateOf(p), signal = interrupted();
        console.log(`== ${name(p)} ==`);
        if (signal) { console.error(`${signal} received: ${name(p)} not collected`); codes.push(2); continue; }
        if (!s) { console.log(`${name(p)} was never created: the launch stopped before it`); codes.push("missing"); continue; }
        const ours = (d) => s.id ? String(d.id) === s.id : d.name === s.name && d.tags?.includes(s.tag);
        // creating or preparing: the launch stopped before systemctl start (starting is saved just
        // before it, and the unit has no [Install], so nothing else starts it): it never started.
        if (["creating", "preparing"].includes(s.status)) {
          neverStarted.add(p.index);
          const found = list().filter(ours);
          for (const d of found) console.error(`${name(p)}: droplet ${d.id} was created but never started its round (its launch stopped before systemctl start); nothing to collect. Delete it: doctl compute droplet delete ${d.id} --force`);
          if (!found.length) console.log(`${name(p)} never started its round and has no droplet`);
          codes.push(found.length ? 2 : "missing"); continue;
        }
        if (s.status === "starting" && !list().some(ours)) {
          console.log(`${name(p)} may have started its round, but its droplet is gone; nothing to collect`); codes.push("missing"); continue;
        }
        // Its controller collects it, and refuses a missing or unloaded unit.
        try { codes.push(await task(p).collect()); }
        catch (e) { console.error(`${name(p)}: collection error; its droplet and evidence are preserved: ${e.message}`); codes.push(2); }
      }
      const states = plan.parts.map(stateOf);
      const leftovers = leftoverDroplets(list(), plan, states);
      for (const d of leftovers) console.error(`leftover droplet ${d.id} (${d.name}) belongs to no live part of ${options.round}; check it is not another run's, then delete it: doctl compute droplet delete ${d.id} --force`);
      let code = splitExit(codes, leftovers.length);
      const which = (...want) => plan.parts.filter((_, i) => want.includes(codes[i])).map(name).join(", ");
      // A part that never started, is partial or is missing means the round cannot merge, so the
      // droplets still running only cost money: say how to stop each, whatever the exit code.
      const doomed = plan.parts.filter((p, i) => neverStarted.has(p.index) || [1, "missing"].includes(codes[i])).map(name);
      const stops = plan.parts.flatMap((p, i) => codes[i] === 3 ? [stop(p, states[i])] : []);
      if (doomed.length && stops.length) console.log(`${options.round} cannot merge: ${doomed.join(", ")} will not complete it. Stop each running droplet so it stops billing:\n${stops.join("\n")}\nThen run ${collectCommand} again: it collects their partial evidence and deletes them.`);
      if (code === 0) {
        try { console.log(`all done: ${options.round} merged from ${plan.droplets} droplets into ${merge(states)}; every droplet's deletion is confirmed`); }
        catch (e) { console.error(`partial: every droplet finished and was deleted, but they do not merge into one round: ${e.message}`); code = 1; }
      } else if (code === 3) {
        if (!doomed.length) console.log(`${options.round} is not finished: ${which(3)} still running. Finished droplets are collected and deleted; run ${collectCommand} again later.`);
      } else if (code === 1) console.log(`${options.round} is partial: ${which(1, "missing")} did not finish its part. Every droplet's deletion is confirmed; there is no merged round.`);
      else console.error(`collection error${which(2) ? ` on ${which(2)}` : ""}${leftovers.length ? `, ${leftovers.length} leftover droplet(s)` : ""}: droplets that still exist are preserved and still billed. Fix the error and run ${collectCommand} again; never relaunch ${options.round}.`);
      return code;
    },
  };
}
// What a split launch would do (#816), without git, doctl or ssh: the split and every command.
export function splitDryRun(options) {
  const plan = splitPlan(options.round, options.droplets, "0".repeat(40), "not written: plan mode");
  const base = { workload: "marketplace-v2", round: options.round, tag: `corten-marketplace-run-${"0".repeat(16)}`, commit: plan.commit, options: nightly };
  const states = plan.parts.map((p) => ({ ...base, name: p.name, unit: `${p.name}.service`, part: { index: p.index, of: plan.droplets } }));
  return { options, measurements: nightly, plan,
    commands: ["git rev-parse HEAD", "git status --porcelain", "doctl compute droplet list --output json", "doctl account get --output json",
      `write ${join(resolve(options.stateDir), "split.json")}`,
      ...states.map((s) => `doctl compute droplet create ${s.name} --size c-8 --region sfo2 --image ubuntu-24-04-x64 --ssh-keys ${options.sshKey} --tag-names corten-bench,corten-marketplace,<run tag> --wait --output json`),
      ...states.map((s) => `ssh root@<${s.name} ip>: upload job.sh, pack.sh and ${s.unit}; systemctl start ${s.unit}`)],
    files: Object.fromEntries(states.map((s) => [`d${s.part.index}`, remoteFiles(s)])) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseDropletArgs(process.argv.slice(2));
    const split = !options.plan && (options.droplets !== undefined || existsSync(join(resolve(options.stateDir), "split.json")));
    if (options.plan && options.droplets) console.log(JSON.stringify(splitDryRun(options), null, 2));
    else if (options.plan) {
      const s = { workload: "marketplace-v2", round: options.round, name: `corten-marketplace-${options.round}`, unit: `corten-marketplace-${options.round}.service`, tag: `corten-marketplace-run-${"0".repeat(16)}`, commit: "0".repeat(40), options: nightly };
      console.log(JSON.stringify({ options, measurements: nightly, files: remoteFiles(s) }, null, 2));
    } else if (split) {
      // The split launcher alone knows every droplet: a closed stdout or stderr must not kill it
      // mid-launch (a stopped launch also saves what each droplet is left doing in the state
      // directory), and Ctrl-C, SIGTERM or Ctrl-Break stops it between steps. SIGHUP keeps its
      // default, so nohup still works.
      for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
      let signal = null;
      for (const name of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(name, () => { signal ??= name; });
      const task = splitController(options, { interrupted: () => signal });
      if (options.collect) process.exitCode = await task.collect(); else await task.launch();
    } else {
      const task = controller(options);
      if (options.collect) process.exitCode = await task.collect(); else await task.launch();
    }
  } catch (e) { console.error(e.stack); process.exitCode = 2; }
}
