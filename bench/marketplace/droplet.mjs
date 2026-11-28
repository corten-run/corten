// Detached nightly launcher. A durable reservation and unique tag survive ambiguous creates.
// Collection downloads and hashes even partial evidence before deleting only a terminal owned host.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setImmediate as yieldToSignals } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { durable, syncDirectory } from "../workloads/cloud-local.mjs";
import { providerAccount, providerIdentity } from "../workloads/cloud-options.mjs";
import { providerTransport } from "../workloads/cloud-provider.mjs";
import { leftoverDroplets, nightly, ownedDroplet, parseDropletArgs, remoteFiles, safeArchive, splitExit, splitPlan, terminalUnit, validatePlan, validateState } from "./droplet-contract.mjs";
import { validateSummary } from "./report.mjs";
import { groupApps, scheduledGroup } from "./groups.mjs";
import { partName, splitApps } from "./run-contract.mjs";
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
const hasDeletionRecord = (state) => ["deletionTarget", "deletionIntentAt", "destroyedAt"].some((key) => Object.hasOwn(state, key));
const beforeStart = (state) => ["creating", "preparing"].includes(state.status);
function openCollection(context, { providerFactory = providerTransport, repo, interrupted }) {
  assert.match(context ?? "", /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, "collection requires an explicit saved doctl --context");
  const run = providerFactory({ repo, interrupted });
  const call = (args, timeout = 10000, allowFail = false) => run([...args, "--context", context], timeout, allowFail);
  const json = (result) => {
    assert.equal(result?.status, 0, "provider read did not succeed");
    try { return JSON.parse(result.stdout); } catch { throw new Error("provider returned invalid JSON"); }
  };
  const account = async (timeout) => providerAccount(json(await call(["account", "get", "--output", "json"], timeout)));
  const confirmedAbsent = new Set();
  return {
    confirmedAbsent,
    async list() { return json(await call(["compute", "droplet", "list", "--output", "json"])); },
    async observe(id, expected, budget = () => 10000) {
      assert.ok(/^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)), "exact droplet ID required; absence unconfirmed");
      const scope = await account(budget());
      assert.ok(expected === undefined || scope === expected, "provider account changed; absence unconfirmed");
      const result = await call(["compute", "droplet", "get", id, "--output", "json"], budget(), true);
      let droplet;
      if (!(result?.status === 1 && result.providerDiagnostic?.code === "get-http" && result.providerDiagnostic.httpStatus === 404)) {
        const rows = json(result);
        assert.ok(Array.isArray(rows) && rows.length === 1 && rows[0]?.id === Number(id), "provider GET did not return the exact ID");
        droplet = rows[0];
      }
      assert.ok(await account(budget()) === scope, "provider account changed; absence unconfirmed");
      budget();
      if (droplet) confirmedAbsent.delete(id);
      else {
        assert.ok(expected !== undefined, `droplet ${id} absence unconfirmed: no saved account binding for this ID`);
        confirmedAbsent.add(id);
      }
      return { droplet, account: scope };
    },
    async delete(id) {
      const result = await call(["compute", "droplet", "delete", id, "--force"], 30000, true);
      assert.equal(result?.status, 0, "provider did not acknowledge DELETE");
    },
    close: run.close,
  };
}
function publishWindowsIntent(directory) {
  const root = process.env.SystemRoot;
  assert.ok(root && isAbsolute(root), "Windows system PowerShell is unavailable");
  const result = spawnSync(join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-File", fileURLToPath(new URL("publish-delete-intent.ps1", import.meta.url)), directory],
    { windowsHide: true, shell: false, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000, maxBuffer: 16384 });
  assert.ok(!result.error && result.status === 0 && result.stdout.trim() === "intent committed",
    `Windows intent publication not confirmed: ${result.error?.code ?? (result.stderr?.trim() || "missing write-through receipt")}`);
}
function saveDeletionIntent(path, state, sync = syncDirectory) {
  const directory = dirname(path), temp = `${path}.delete-intent.tmp`;
  const bytes = `${JSON.stringify(state, null, 2)}\n`;
  if (process.platform !== "win32") sync(directory); // Prove directory fsync is supported.
  durable(temp, bytes);
  if (process.platform === "win32") publishWindowsIntent(directory);
  else { renameSync(temp, path); sync(directory); }
  assert.ok(!existsSync(temp) && readFileSync(path, "utf8") === bytes, "published intent does not match the staged bytes");
}
function preflightIntent(local, publish) {
  try {
    const probe = mkdtempSync(join(local, ".intent-probe-")), path = join(probe, "state.json");
    try {
      writeFileSync(path, "{}\n", { flag: "wx" }); // Exercise replacement on the reservation's filesystem.
      publish(path, { probe: "marketplace-delete-intent" });
    } finally {
      for (const file of [path, `${path}.delete-intent.tmp`]) if (existsSync(file)) unlinkSync(file);
      rmdirSync(probe);
    }
  } catch (cause) {
    throw new Error(`durable publisher preflight failed; no droplet created. Restore supported local storage and publisher access before launch: ${cause.message}`, { cause });
  }
}
/**
 * One droplet's launcher: the whole round, or with options.part one droplet's part of a split
 * round (#816), whose checkout checks and measured commit (options.commit) the split launcher
 * made once for every droplet.
 */
export function controller(options, { run = command, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), repo = checkout,
  interrupted = () => null, now = () => performance.now(), providerFactory, syncIntentDirectory, publishIntent = saveDeletionIntent } = {}) {
  const local = controlDir(options.stateDir, repo);
  const part = options.part ?? null;
  const statePath = join(local, "state.json");
  let state = existsSync(statePath) ? validateState(JSON.parse(readFileSync(statePath, "utf8")), options.round) : null;
  const save = () => {
    writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2) + "\n");
    renameSync(`${statePath}.tmp`, statePath);
  };
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
      preflightIntent(local, publishIntent);
      assert.ok(!benchTagged(list()), "a nightly benchmark droplet already exists; do not overlap nightly rounds");
    }
    const name = `corten-marketplace-${partName(options.round, part)}`, group = options.group ?? scheduledGroup(options.round);
    state = { workload: "marketplace-v2", round: options.round, commit, status: "creating", name,
      tag: `corten-marketplace-run-${randomBytes(8).toString("hex")}`, unit: `${name}.service`, startedAt: new Date().toISOString(), options: nightly, ...(part ? { part } : {}),
      // A part reserves its share of the group's candidates; a whole round the whole group.
      group, apps: part ? splitApps(group, part.of)[part.index - 1] : groupApps(group) };
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
    async collect(sharedCollection) {
      assert.ok(state, "missing launch reservation");
      const lock = join(local, "collect.lock");
      writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx" });
      let collection = sharedCollection, failed = false;
      try {
        // A controller constructed before a prior collector saved intent must not use its old state.
        state = validateState(JSON.parse(readFileSync(statePath, "utf8")), options.round);
        const verifyArchive = () => assert.equal(createHash("sha256").update(readFileSync(state.resultArchive)).digest("hex"),
          state.archiveSha256, "saved archive hash mismatch; refusing deletion or confirmation");
        const checkInterrupted = () => {
          const signal = interrupted();
          assert.ok(!signal, `${signal} received; preserve state and evidence`);
        };
        const session = () => collection ??= openCollection(options.context, { repo, interrupted, providerFactory });
        const deleted = () => {
          verifyArchive();
          if (!state.destroyedAt) { state.destroyedAt = new Date().toISOString(); save(); }
          console.log(`${state.complete ? "all done" : `partial results (the round did not finish): ${state.validationError}`}\nresults in ${state.resultFolder}\ndroplet ${state.id} deletion confirmed`);
          return state.complete ? 0 : 1;
        };
        const reconcile = async (disposition) => {
          const target = state.deletionTarget;
          assert.ok(state.collectedAt && state.deletionIntentAt && /^[1-9]\d*$/.test(state.id ?? "")
            && Number.isSafeInteger(Number(state.id)) && target?.id === state.id && target.account && target.context,
          "deletion record has no bound ID/account/context or collected archive; preserve state for operator review, never repeat DELETE");
          providerIdentity({ accountId: target.account, context: target.context });
          assert.ok(options.context === target.context, "collection context differs from saved deletion intent");
          if (Object.hasOwn(state, "collectionTarget")) assert.deepEqual(target, state.collectionTarget, "saved deletion and collection bindings differ");
          verifyArchive();
          const pending = `droplet ${target.id} deletion not confirmed (${disposition}); preserve state and evidence, retry --collect for read-only confirmation`;
          const deadline = now() + 120000;
          const budget = (max = 10000) => {
            checkInterrupted();
            const ms = Math.floor(deadline - now());
            assert.ok(ms > 0, "two-minute confirmation deadline elapsed");
            return Math.min(ms, max);
          };
          for (;;) {
            let droplet, wait;
            try {
              ({ droplet } = await session().observe(target.id, target.account, budget));
              wait = budget(3000);
            } catch (cause) { throw new Error(`${pending}: ${cause.message}`, { cause }); }
            // Tags can disappear during removal. While the exact ID is present we know only
            // that its absence is unconfirmed, not that another delete is allowed.
            if (!droplet) return deleted();
            await sleep(wait);
          }
        };
        if (hasDeletionRecord(state)) return await reconcile("saved intent, no DELETE attempted");
        checkInterrupted();
        const neverStarted = part && beforeStart(state), target = state.collectionTarget;
        if (Object.hasOwn(state, "collectionTarget")) {
          assert.ok(target?.id && target.id === state.id, "saved collection binding differs from the exact ID");
          providerIdentity({ accountId: target.account, context: target.context });
          assert.ok(options.context === target.context, "collection context differs from saved account binding");
        }
        let id = state.id;
        if (!id) {
          // A lost create acknowledgement can be discovered by unique tag, never disproved by a list.
          const rows = (await session().list()).filter((d) => d.name === state.name && d.tags?.includes(state.tag));
          assert.ok(rows.length, "no exact droplet ID found for this reservation; absence unconfirmed");
          id = String(ownedDroplet(rows, state).id);
        }
        const { droplet, account } = await session().observe(id, target?.account);
        if (!droplet) {
          assert.ok(part && (neverStarted || state.status === "starting"),
            `droplet ${id} is absent in the saved account, but this reservation has no deletion receipt`);
          console.log(`${partName(state.round, part)} ${neverStarted ? "never started its round" : "may have started its round"}, but its exact droplet ${id} is absent in the saved account; nothing to collect`);
          return "missing";
        }
        const d = ownedDroplet([droplet], { ...state, id });
        const binding = { id, account, context: options.context };
        if (neverStarted) {
          Object.assign(state, { id, collectionTarget: binding }); save();
          console.error(`${partName(state.round, part)}: droplet ${id} was created but never started its round (its launch stopped before systemctl start); nothing to collect. Delete it: doctl compute droplet delete ${id} --force --context ${options.context}`);
          return 2;
        }
        const ip = d.networks.v4.find((n) => n.type === "public")?.ip_address;
        assert.ok(ip && (!state.ip || state.ip === ip), "owned droplet's public IP differs from reservation or is missing");
        Object.assign(state, { id, ip, collectionTarget: binding }); validateState(state, options.round); save();
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
            assert.equal(s.options.group ?? "full", state.group ?? "full", "collected group differs from reservation");
            assert.deepEqual(s.options.apps, state.apps ?? groupApps(), "collected adapters differ from reservation");
            for (const [key, value] of Object.entries(nightly)) assert.equal(s.options[key], value, `unexpected ${key}`);
            state.complete = true;
          } catch (e) { state.validationError = e.message; }
          // Keep collection independent of Git imports: no partial copy can poison a retry.
          Object.assign(state, { resultFolder: existsSync(source) ? source : extracted, evidenceFolder: extracted,
            collectedAt: new Date().toISOString(), status: state.complete ? "done" : "failed" }); save();
        }
        // Only a fresh intent permits DELETE. Recheck identity and terminal state after custody.
        verifyArchive();
        const currentHost = (await session().observe(id, account)).droplet;
        assert.ok(currentHost, "owned droplet disappeared before DELETE; no deletion receipt");
        const current = ownedDroplet([currentHost], state);
        assert.equal(current.networks.v4.find((n) => n.type === "public")?.ip_address, state.ip, "owned droplet's public IP changed; refusing deletion");
        assert.ok(terminalUnit(unit()), "unit became active; refusing deletion");
        await yieldToSignals();
        checkInterrupted();
        Object.assign(state, { deletionIntentAt: new Date().toISOString(), deletionTarget: binding });
        try { publishIntent(statePath, state, syncIntentDirectory); }
        catch (cause) {
          throw new Error(`durable intent not confirmed for droplet ${id}; no DELETE sent by this invocation. Preserve state and evidence for operator review: ${cause.message}`, { cause });
        }
        let disposition = "DELETE acknowledgement unavailable";
        try {
          await session().delete(state.id);
          disposition = "DELETE acknowledged";
        } catch { /* An unsuccessful response cannot establish whether the request took effect. */ }
        return await reconcile(disposition);
      } catch (error) { failed = true; throw error; }
      finally {
        try { if (!sharedCollection) await collection?.close(); }
        catch (error) { if (!failed) throw error; }
        finally { unlinkSync(lock); }
      }
    },
  };
}

/**
 * Whether process pid is running: false only when the system says no such process exists, so a
 * process we may not signal counts as running.
 * @param {number} pid
 */
export function processRuns(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
}
/**
 * The split launcher's signals: Ctrl-C, SIGTERM and Ctrl-Break stop a launch between steps (the
 * returned function names the first received). A hangup is ignored, so the launch carries on
 * when its terminal closes; Node resets an inherited SIGHUP ignore, so nohup alone does not.
 */
export function launcherSignals() {
  let signal = null;
  for (const name of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(name, () => { signal ??= name; });
  process.on("SIGHUP", () => {});
  return () => signal;
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
  const { run = command, repo = checkout, interrupted = () => null, publishIntent = saveDeletionIntent } = deps;
  const local = controlDir(options.stateDir, repo);
  assert.ok(!existsSync(join(local, "state.json")), "this state directory holds a one-droplet round; use another for a split round");
  const planPath = join(local, "split.json");
  let plan = existsSync(planPath) ? validatePlan(JSON.parse(readFileSync(planPath, "utf8")), options.round) : null;
  const partDir = (k) => join(local, `d${k}`);
  const list = () => JSON.parse(run("doctl", ["compute", "droplet", "list", "--output", "json"]).stdout);
  const task = (p) => controller({ round: options.round, stateDir: partDir(p.index), sshKey: options.sshKey, context: options.context,
    part: { index: p.index, of: plan.droplets }, group: plan.group, commit: plan.commit }, deps);
  const stateOf = (p) => {
    const file = join(partDir(p.index), "state.json");
    return existsSync(file) ? validateState(JSON.parse(readFileSync(file, "utf8")), options.round) : null;
  };
  const name = (p) => `${options.round}-d${p.index}`;
  const collectCommand = `node bench/marketplace/droplet.mjs ${options.round} --state-dir "${local}" --collect --context ${options.context ?? "<saved-context>"}`;
  // A launch holds launch.lock with its pid until it ends, by any path, so collect can tell a
  // stopped launch from a live one.
  const lockPath = join(local, "launch.lock");
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
  async function launchLocked() {
    if (plan) throw new Error(`${options.round} is already planned in ${planPath} at commit ${plan.commit}; never launch a split round twice: collect it (${collectCommand})`);
    const commit = run("git", ["rev-parse", "HEAD"]).stdout.trim();
    assert.match(commit, /^[a-f0-9]{40}$/);
    assert.equal(run("git", ["status", "--porcelain"]).stdout.trim(), "", "launch requires clean measured commit");
    const results = join(repo, "bench", "marketplace", "results", options.round);
    assert.ok(!existsSync(results), `${results} exists; never reuse a result folder`);
    for (let k = 1; k <= options.droplets; k++) assert.ok(!existsSync(partDir(k)), `${partDir(k)} exists; use a new state directory for ${options.round}`);
    preflightIntent(local, publishIntent);
    const droplets = list();
    assert.ok(!benchTagged(droplets), "a nightly benchmark droplet already exists; do not overlap nightly rounds");
    const account = JSON.parse(run("doctl", ["account", "get", "--output", "json"]).stdout);
    const limit = (Array.isArray(account) ? account[0] : account)?.droplet_limit;
    assert.ok(Number.isSafeInteger(limit) && limit > 0, "doctl account get gave no droplet_limit");
    assert.ok(droplets.length + options.droplets <= limit, `the account's droplet limit is ${limit} and ${droplets.length} droplets exist: no room for ${options.droplets} more`);
    plan = splitPlan(options.round, options.group ?? scheduledGroup(options.round), options.droplets, commit);
    writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
    console.log(`split ${options.round} (group ${plan.group}) across ${plan.droplets} droplets, commit ${commit}`);
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
  }
  async function collectUnlocked(collection) {
    const codes = [], neverStarted = new Set();
    for (const p of plan.parts) {
      const s = stateOf(p), signal = interrupted();
      console.log(`== ${name(p)} ==`);
      if (signal) { console.error(`${signal} received: ${name(p)} not collected`); codes.push(2); continue; }
      if (!s) { console.log(`${name(p)} was never created: the launch stopped before it`); codes.push("missing"); continue; }
      if (beforeStart(s)) neverStarted.add(p.index);
      try {
        // The same exact-ID checks apply to every reserved part, including interrupted launches.
        codes.push(await task(p).collect(collection));
      } catch (e) { console.error(`${name(p)}: collection error; its droplet and evidence are preserved: ${e.message}`); codes.push(2); }
    }
    const states = plan.parts.map(stateOf);
    let leftovers = [], unlisted = 0;
    try {
      // The list can detect extra IDs, but cannot make or overturn an exact-ID absence decision.
      const rows = (await collection.list()).filter((d) => !collection.confirmedAbsent.has(String(d.id)));
      leftovers = leftoverDroplets(rows, plan, states);
    } catch (e) { unlisted = 1; console.error(`the droplet list failed, so leftover droplets are unknown: ${e.message}`); }
    for (const d of leftovers) {
      if (states.some((s) => s?.id === String(d.id) && hasDeletionRecord(s))) {
        console.error(`droplet ${d.id} is still listed despite a saved deletion record; reconcile read-only, do not repeat DELETE`);
      } else console.error(`leftover droplet ${d.id} (${d.name}) belongs to no live part of ${options.round}; check exact identity and ownership before any action`);
    }
    let code = splitExit(codes, leftovers.length + unlisted);
    const which = (...want) => plan.parts.filter((_, i) => want.includes(codes[i])).map(name).join(", ");
    // A part that never started, is partial or is missing means the round cannot merge, so the
    // droplets still running only cost money: say how to stop each, whatever the exit code.
    const doomed = plan.parts.filter((p, i) => neverStarted.has(p.index) || [1, "missing"].includes(codes[i])).map(name);
    const stops = plan.parts.flatMap((p, i) => codes[i] === 3 ? [stop(p, states[i])] : []);
    if (doomed.length && stops.length) console.log(`${options.round} cannot merge: ${doomed.join(", ")} will not complete it. Stop each running droplet so it stops billing:\n${stops.join("\n")}\nThen run ${collectCommand} again: it collects their partial evidence and deletes them.`);
    if (code === 0) {
      try { console.log(`all done: ${options.round} merged from ${plan.droplets} droplets into ${merge(states)}; every droplet's deletion is confirmed`); }
      catch (e) { console.error(`partial: every droplet finished and was deleted, but they do not merge into one round: ${e.message}\n${options.round} cannot be merged: follow the exit 1 steps in bench/marketplace/nightly.md (State And Collection); the next round takes a new number, never relaunch ${options.round}.`); code = 1; }
    } else if (code === 3) {
      if (!doomed.length) console.log(`${options.round} is not finished: ${which(3)} still running. Finished droplets are collected and deleted; run ${collectCommand} again later.`);
    } else if (code === 1) console.log(`${options.round} is partial: ${which(1, "missing")} did not finish its part.${collection.confirmedAbsent.size
      ? ` Exact IDs confirmed absent: ${[...collection.confirmedAbsent].join(", ")}.` : ""} There is no merged round.`);
    else console.error(`collection error${which(2) ? ` on ${which(2)}` : ""}${leftovers.length ? `, ${leftovers.length} leftover droplet(s)` : ""}: droplets that still exist are preserved and still billed. Fix the error and run ${collectCommand} again; never relaunch ${options.round}.`);
    return code;
  }
  return {
    get plan() { return plan; },
    async launch() {
      try { writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx" }); }
      catch (e) { throw new Error(e.code === "EEXIST" ? `${lockPath} exists: another launch of ${options.round} holds it, or one ended without removing it; never launch twice` : e.message); }
      try { return await launchLocked(); } finally { unlinkSync(lockPath); }
    },
    async collect() {
      assert.ok(plan, `no split plan in ${planPath}`);
      if (existsSync(lockPath)) {
        const lock = JSON.parse(readFileSync(lockPath, "utf8"));
        // A live launch may be seconds from systemctl start: what it leaves is not known yet.
        assert.ok(!processRuns(lock.pid), `the launch of ${options.round} (pid ${lock.pid}, ${lockPath}) is still running: collect after it ends. If pid ${lock.pid} is not that launch, check the exact process, then remove the lock by hand`);
        // Its process is gone, so the launch was killed before it could remove the lock.
        console.log(`${lockPath} is stale: pid ${lock.pid} is not running, so its launch was killed; removing the lock and collecting the stopped launch`);
        unlinkSync(lockPath);
      }
      const collection = openCollection(options.context, { ...deps, repo, interrupted });
      let failed = false;
      try { return await collectUnlocked(collection); }
      catch (error) { failed = true; throw error; }
      finally { try { await collection.close(); } catch (error) { if (!failed) throw error; } }
    },
  };
}
// What a split launch would do (#816), without git, doctl or ssh: the split and every command.
export function splitDryRun(options) {
  const plan = splitPlan(options.round, options.group ?? scheduledGroup(options.round), options.droplets, "0".repeat(40), "not written: plan mode");
  const base = { workload: "marketplace-v2", round: options.round, tag: `corten-marketplace-run-${"0".repeat(16)}`, commit: plan.commit, options: nightly };
  const states = plan.parts.map((p) => ({ ...base, name: p.name, unit: `${p.name}.service`, part: { index: p.index, of: plan.droplets }, group: plan.group, apps: p.apps }));
  return { options, measurements: nightly, plan,
    commands: ["git rev-parse HEAD", "git status --porcelain", "preflight durable delete intent publisher on the state filesystem",
      "doctl compute droplet list --output json", "doctl account get --output json",
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
      const s = { workload: "marketplace-v2", round: options.round, name: `corten-marketplace-${options.round}`, unit: `corten-marketplace-${options.round}.service`, tag: `corten-marketplace-run-${"0".repeat(16)}`, commit: "0".repeat(40), options: nightly, group: options.group, apps: groupApps(options.group) };
      console.log(JSON.stringify({ options, measurements: nightly, files: remoteFiles(s) }, null, 2));
    } else if (split) {
      // The split launcher alone knows every droplet: a closed stdout or stderr or a hangup must
      // not kill it mid-launch (a stopped launch also saves what each droplet is left doing in the
      // state directory), and Ctrl-C, SIGTERM or Ctrl-Break stops it between steps.
      for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
      const task = splitController(options, { interrupted: launcherSignals() });
      if (options.collect) process.exitCode = await task.collect(); else await task.launch();
    } else {
      const task = controller(options, options.collect ? { interrupted: launcherSignals() } : {});
      if (options.collect) process.exitCode = await task.collect(); else await task.launch();
    }
  } catch (e) { console.error(e.stack); process.exitCode = 2; }
}
