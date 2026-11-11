// Runs the whole comparison on a fresh DigitalOcean droplet with dedicated CPUs, then destroys it.
// A dedicated host keeps other work off the cores, pins each piece to its own cores, and exposes
// hardware counters for `count.mjs`. Needs `doctl` (authenticated), `ssh`, `scp` and `tar`.
// Usage (from the repository root or anywhere):
//   node bench/fullstack/droplet.mjs <round> --ssh-key <DO key id> [--size c-8 (c-16 for --tier matched)] [--region sfo2]
//   node bench/fullstack/droplet.mjs <round> --host <ip> [--keep]   (reuse a droplet)
//   --detach: start the round and leave: it runs on the droplet by itself; collect it later.
//   --collect: look at the round once: download its results and destroy the droplet if it has
//     ended (exit 0 when it finished, 1 when it stopped short), or show where it is (exit 3).
//   --attach: wait for a round already started and download it (then destroy its droplet).
//   --from <step>: start run-all.mjs at that step and keep the droplet's earlier results.
//   --stall <minutes>: how long a droplet may not answer before it is power-cycled (default 15).
//   --suite live: run bench/live (run.mjs, then summarize.mjs) instead; results in bench/live/results.
//   --apps <a,b,..>: a full-stack round of only these apps (BENCH_APPS on the droplet), to measure a
//     few against each other without the hours all of them take (r14's eighteen: 6.3 from cold
//     start to the summary); only their images are built.
//   --passes <n>: each load phase n times (BENCH_PASSES on the droplet), the apps taking turns, so
//     the tables give each number's median and range and say which differences are within noise
//     (passes.mjs); about n times the load phases' hours, so mostly with --apps. One unless set.
//   --tier matched: a full-stack round of the matched tier (BENCH_TIER on the droplet): its apps,
//     each with the production profile (README, "The matched tier"), reached through the edge
//     (edge.mjs) on cores 4-9 of its own, so on a c-16 or larger (a round on fewer than 16 vCPUs
//     stops before it starts). Its own round name, as the tier runs on its own cadence; the
//     defaults tier unless set.
//   --edge off: a matched round without the edge (BENCH_EDGE=off on the droplet), to compare the
//     same apps reached directly; its summary says so (edge: "off").
//   --suite harden: the hardening step alone (harden.mjs: slow clients, oversized requests and
//     connection floods) for every app of the tier, or those --apps names; results in
//     bench/fullstack/results/<round>/hardening.json. It runs on its own cadence, not every round,
//     and needs no edge, so a matched one runs on the defaults tier's droplet size.
//   --suite browser: only the browser pass of this comparison (run-all.mjs from "browser": parity,
//     bytes, browser timing), then bench/browser's run-all.mjs; results in both results folders.
// Results land in bench/fullstack/results/<round>/; a finished full-stack round's raw output is
// then packed into raw.tar.xz there (pack.mjs). A droplet this creates is destroyed once its
// round has ended (finished or stopped short, after the download) or when it fails before the round
// starts, unless --keep; a droplet passed with --host never is.
// The round does not need this machine once it has started: it runs on the droplet under a systemd
// unit, corten-bench-<round>. A full-stack round runs run-all.mjs --unattended, which gives every
// call a time limit, and the droplet's kernel reboots it when it locks up (r8's did, #466): the
// unit starts again at boot and the round goes on from the step after the one it was in, which is
// marked skipped (in the build step, it goes on with the app after the one that was building). A
// droplet that stops answering for --stall minutes while this waits or collects is power-cycled,
// which does the same.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allApps, buildArgs } from "./apps.mjs";
import { ARCHIVE, pack } from "./pack.mjs";
import { live } from "../live/apps.mjs";
import { passesOf } from "./passes.mjs";
import { hoursFor, quote, roundNameError, steps, unit } from "./round.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const args = process.argv.slice(2);
const round = args[0];
const flag = (/** @type {string} */ name, /** @type {string=} */ fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
if (!round || round.startsWith("--")) throw new Error("usage: node droplet.mjs <round> (--ssh-key <id> | --host <ip> | --collect | --attach)");
// The round goes into droplet and unit names, paths and shell commands unquoted.
if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(round)) throw new Error("the round is letters, digits, - and _ (r10)");
const suite = flag("suite", "fullstack") ?? "fullstack";
// An m<n> round is the matched tier's, so --collect and --attach need no --tier for it.
const tier = flag("tier") ?? (/^m\d+$/.test(round) ? "matched" : "defaults");
if (tier !== "defaults" && tier !== "matched") throw new Error("--tier is defaults or matched");
const edgeOff = flag("edge") === "off";
if (flag("edge") !== undefined && !edgeOff) throw new Error("--edge is off or not given");
if (edgeOff && (tier !== "matched" || suite !== "fullstack")) throw new Error("--edge off is for a matched full-stack round, whose apps are otherwise reached through the edge");
// The matched tier's edge takes six cores the defaults tier gives k6, so its full-stack droplet is
// larger; the hardening step reaches each app directly.
const edged = tier === "matched" && suite === "fullstack";
const size = edged ? "c-16" : "c-8";
if (tier !== "defaults" && suite !== "fullstack" && suite !== "harden") throw new Error(flag("tier") ? "--tier is for a full-stack or hardening round" : `${round} is a matched-tier round's name (m<n>), and that tier is a full-stack or hardening round's: name this one otherwise`);
// A hardening round of the matched tier is not an r<n> round, nor the defaults' an m<n> one.
if (suite === "harden" && roundNameError(round, tier)) throw new Error(/** @type {string} */ (roundNameError(round, tier)));
if (suite === "fullstack" && roundNameError(round, tier, { full: true })) throw new Error(/** @type {string} */ (roundNameError(round, tier, { full: true })));
// The tier's apps, whatever BENCH_TIER says here: the droplet's run reads it from the round's env.
const apps = tier === "matched" ? Object.fromEntries(Object.entries(allApps).filter(([, app]) => /** @type {{ matched?: boolean }} */ (app).matched)) : allApps;
const only = flag("apps")?.split(",").map((n) => n.trim()).filter(Boolean);
for (const app of only ?? []) if (!(app in apps)) throw new Error(`--apps names ${app}, which is not an app${tier === "matched" ? " of the matched tier" : ""}`);
if (only && !only.includes("corten")) throw new Error("--apps must include corten, the reference");
if (only && suite !== "fullstack" && suite !== "harden") throw new Error("--apps is for a full-stack or hardening round");
if (args.includes("--passes") && !/^\d+$/.test(flag("passes") ?? "")) throw new Error("--passes takes a count: 1, 3 or 5");
// A round going on from a step takes the passes its earlier results were run with (launch).
let passes = passesOf(flag("passes"));
if (passes > 1 && suite !== "fullstack") throw new Error("--passes is for a full-stack round");
// The names go into the round's script unquoted.
if (only?.some((app) => !/^[a-z0-9-]+$/.test(app))) throw new Error("an app name is lowercase letters, digits and -");
if (!["fullstack", "live", "browser", "harden"].includes(suite)) throw new Error("--suite is fullstack, live, browser or harden");
const suiteDir = `/bench/bench/${suite === "live" ? "live" : "fullstack"}`;
const name = `corten-bench-${suite === "fullstack" ? "" : `${suite}-`}${round}`;
const unitName = `corten-bench-${round}`;
const collect = args.includes("--collect");
const attach = args.includes("--attach");
const detach = args.includes("--detach");
const keep = args.includes("--keep") || Boolean(flag("host"));
// The last line of a finished run: bench/browser's run-all.mjs prints its own after fullstack's.
const doneMarker = suite === "browser" ? /browser suite (done|finished)/ : /all done/;
const minute = 60_000;
const stallFlag = Number(flag("stall", "15"));
if (!Number.isFinite(stallFlag) || stallFlag <= 0) throw new Error("--stall is a number of minutes");
const stall = stallFlag * minute;
// stdin is never inherited: started from a hidden console, Windows' ssh sometimes keeps waiting on
// that console after the remote command has finished (the r7, r8 and r9 runs each hung for hours
// in one such call; in a test 2 of 6 calls hung with stdin inherited and none of 30 with it
// ignored). Every call also has a time limit, so a hang becomes an error or a retry.
/** @param {string} cmd @param {string[]} cmdArgs @param {{ quiet?: boolean, allowFail?: boolean, timeout?: number }} [options] */
const run = (cmd, cmdArgs, { quiet, allowFail, timeout = 2 * minute, ...options } = {}) => {
  const out = quiet ? "pipe" : "inherit";
  const r = spawnSync(cmd, cmdArgs, { encoding: "utf8", stdio: ["ignore", out, out], timeout, ...options });
  const failure = /** @type {any} */ (r.error)?.code === "ETIMEDOUT" ? `no answer within ${timeout / 1000} s`
    : r.error ? r.error.message
    : r.status !== 0 ? (r.stderr || `exit ${r.status}`) : null;
  if (failure && !allowFail) throw new Error(`${cmd} ${cmdArgs.join(" ")} failed: ${failure}`);
  return failure ? { ...r, status: r.status || 1 } : r;
};
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
// Windows' antivirus can hold a file it just saw written for a moment: a temporary file that cannot
// be removed is left behind rather than failing the round.
const remove = (/** @type {string} */ file) => { try { rmSync(file, { force: true, maxRetries: 10, retryDelay: 500 }); } catch (e) { console.log(`could not remove ${file}: ${/** @type {any} */ (e).code}`); } };
// Only for work that can run again safely: up to `times` attempts, a minute apart.
const retry = async (/** @type {number} */ times, /** @type {() => unknown} */ work) => {
  for (let attempt = 1; ; attempt += 1) {
    try { return work(); } catch (e) {
      if (attempt >= times) throw e;
      console.log(`retrying (${attempt} of ${times - 1}): ${String(/** @type {any} */ (e).message).split("\n")[0]}`);
      await sleep(minute);
    }
  }
};

let host = flag("host");
/** @type {string | null} */
let dropletId = null;
/** @type {string | null} */
let runTag = null;
// Whether this run may destroy the droplet when it stops: before the round starts, and once it has
// ended. A round that is running is never destroyed from here (it goes on by itself).
let mayDestroy = true;
// The corten-bench droplets as [id, name, ip]. Throws when DigitalOcean cannot list them, so no
// decision about which droplet is ours is made from an empty list.
const tagged = () => run("doctl", ["compute", "droplet", "list", "--tag-name", "corten-bench", "--format", "ID,Name,PublicIPv4", "--no-header"], { quiet: true, timeout: minute })
  .stdout.split("\n").map((l) => l.trim().split(/\s+/)).filter(([id]) => id);
const destroy = () => {
  if (dropletId && !keep && mayDestroy) {
    console.log(`destroying droplet ${dropletId}`);
    // Three tries a minute apart (synchronous: this also runs on SIGINT).
    let deleted = false;
    for (let i = 0; i < 3 && !deleted; i += 1) {
      if (i) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, minute);
      deleted = run("doctl", ["compute", "droplet", "delete", dropletId, "--force"], { allowFail: true, timeout: minute }).status === 0;
    }
    if (!deleted) console.log(`could not delete droplet ${dropletId}: delete it with doctl compute droplet delete ${dropletId} --force`);
    else dropletId = null;
  }
  // The run's own tag, once its droplet is gone (best effort: an empty tag costs nothing).
  if (runTag && !dropletId && !keep) {
    run("doctl", ["compute", "tag", "delete", runTag, "--force"], { quiet: true, allowFail: true, timeout: minute });
    runTag = null;
  }
};
const leftRunning = () => host && console.log(`droplet ${host} is left as it is (a round there goes on by itself): collect it with node bench/fullstack/droplet.mjs ${round} --collect${suite === "fullstack" ? "" : ` --suite ${suite}`}${flag("host") ? ` --host ${host}` : ""}`);
process.on("SIGINT", () => {
  if (!mayDestroy) leftRunning();
  destroy();
  process.exit(130);
});

// Cores: 0 the system and Docker, 1 the app under test, 2-3 the item API (fullstack only), in
// the matched tier 4-9 the edge (edge.mjs), the rest the load; with items in memory the item API is idle, so the load also gets 2-3. Builds,
// which run after the rest, get 1-4: the four vCPUs of a standard CI runner; Corten's and axum +
// Maud's clean build runs again on two vCPUs (1-2) and on all of them, nothing else running then.
// On a c-16 (the matched tier) all of them is sixteen, not a c-8's eight, so that build's time is
// not comparable with a defaults round's; the four- and two-vCPU builds are.
// A droplet's vCPUs are hyperthreads, so all of them may add sibling threads rather than cores.
// The tree goes up without .git, so the commit it is (and whether it differs from it) is said here,
// for conform.mjs's record of what the round's images were built from.
const treeCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout?.trim() || "unknown";
const treeDirty = (spawnSync("git", ["status", "--porcelain", "--", ".", ":!bench/fullstack/results"], { cwd: repo, encoding: "utf8" }).stdout ?? "").trim() !== "";
const imagesFrom = treeCommit + (treeDirty ? "-dirty" : "");
const envFor = (/** @type {number} */ passes) => suite === "live"
  ? "BENCH_APP_CPUS=1 BENCH_LOAD_CPUS=2-$(($(nproc)-1)) BENCH_LIVE_WORKERS=$(($(nproc)-2))"
  : `BENCH_APP_CPUS=1 BENCH_BUILD_CPUS=1-4 BENCH_BUILD_SCALE=1-2,0-$(($(nproc)-1)) BENCH_API_CONTAINER=item-api ${edged ? "BENCH_EDGE_CPUS=4-9 BENCH_LOAD_CPUS=10-$(($(nproc)-1)) BENCH_FIXTURE_LOAD_CPUS=2-3,10-$(($(nproc)-1))" : "BENCH_LOAD_CPUS=4-$(($(nproc)-1)) BENCH_FIXTURE_LOAD_CPUS=2-$(($(nproc)-1))"} CONFORM_IMAGES_FROM=${imagesFrom}${only ? ` BENCH_APPS=${only.join(",")}` : ""}${passes > 1 ? ` BENCH_PASSES=${passes}` : ""}${tier === "matched" ? " BENCH_TIER=matched" : ""}${edgeOff ? " BENCH_EDGE=off" : ""}`;
// BatchMode: never wait at a prompt. A connection that goes silent is dropped after two minutes.
const sshOptions = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4"];
const ssh = (/** @type {string} */ script, /** @type {{ quiet?: boolean, allowFail?: boolean, timeout?: number }=} */ options) => run("ssh", [...sshOptions, `root@${host}`, script], options);
const scp = (/** @type {string} */ from, /** @type {string} */ to) => run("scp", ["-q", ...sshOptions, from, to], { timeout: 15 * minute });
// Runs `script` on the droplet for at most `limit` minutes there, one such script at a time: a
// retry after a dropped connection waits for the attempt it replaces (or its time limit) rather
// than running beside it (two apt or docker builds at once).
const remote = (/** @type {string} */ script, /** @type {number} */ limit, /** @type {{ quiet?: boolean }=} */ options) => ssh(
  `flock -w ${limit * 60} /tmp/droplet.lock timeout -k 30 ${limit * 60} bash -c ${quote(script)}`,
  { timeout: (2 * limit + 2) * minute, ...options },
);
const answers = async (/** @type {number} */ tries) => {
  for (let i = 0; i < tries; i += 1) {
    if (ssh("true", { quiet: true, allowFail: true, timeout: 30_000 }).status === 0) return true;
    await sleep(5000);
  }
  return false;
};
// Text files written on the droplet without quoting them through two shells.
const write = (/** @type {string} */ path, /** @type {string} */ text) => `echo ${Buffer.from(text).toString("base64")} | base64 -d > ${path}`;

const log = `${suiteDir}/results-${round}.log`;
// host.txt: the CPU model and the rest, since droplets of one size are not all the same machine.
const hostInfo = "(lscpu; lscpu -e; free -m; uname -r; docker --version; node --version; npx playwright --version)";
const download = async (/** @type {string} */ remoteDir, /** @type {string} */ localName, /** @type {string} */ label) => {
  const local = join(here, "..", localName, "results");
  mkdirSync(local, { recursive: true });
  await retry(3, () => remote(`cd ${remoteDir} && mkdir -p results/${round} && (cp ${log} results/${round}/run.log 2>/dev/null || true) && ${hostInfo} > results/${round}/host.txt 2>&1; tar -czf /tmp/results.tgz -C results ${round}`, 5));
  await retry(3, () => scp(`root@${host}:/tmp/results.tgz`, join(local, ".results.tgz")));
  run("tar", ["-xzf", join(local, ".results.tgz"), "-C", local], { timeout: 5 * minute });
  remove(join(local, ".results.tgz"));
  console.log(`${label} in ${join(local, round)}`);
};
const downloadAll = async (/** @type {string} */ label) => {
  await download(suiteDir, suite === "live" ? "live" : "fullstack", label);
  if (suite === "browser") await download("/bench/bench/browser", "browser", label);
};

// Creates the droplet, provisions it, uploads this working tree, builds the images and starts the
// round under its unit.
const launch = async () => {
  if (!host) {
    const key = flag("ssh-key");
    if (!key) throw new Error("--ssh-key <DigitalOcean key id> is required to create a droplet");
    // A tag only this run's droplet has: after a failed create, a droplet carrying it is certainly
    // this run's, whatever else was created meanwhile.
    runTag = `corten-bench-run-${Date.now().toString(36)}-${process.pid}`;
    // A droplet already named so (a --keep run's, or a round still running) is never reused or,
    // below, mistaken for this one.
    if (tagged().some(([, n]) => n === name)) throw new Error(`a corten-bench droplet named ${name} already exists: collect or delete it, or pick another round`);
    // The round script refuses fewer than 16 vCPUs too; refusing here costs no droplet. A slug whose
    // count this cannot read (not c-N, c2-N or ..-Nvcpu-..) is left to that check.
    const slug = flag("size", size) ?? size;
    const vcpus = Number(/^c2?-(\d+)$/.exec(slug)?.[1] ?? /-(\d+)vcpu-/.exec(slug)?.[1] ?? NaN);
    if (edged && vcpus < 16) throw new Error(`--size ${slug} has ${vcpus} vCPUs: the matched tier needs 16 (the edge on 4-9, k6 on 10 and up)`);
    const created = run("doctl", ["compute", "droplet", "create", name, "--size", slug, "--region", flag("region", "sfo2") ?? "sfo2",
      "--image", "ubuntu-24-04-x64", "--ssh-keys", key, "--tag-names", `corten-bench,${runTag}`, "--wait", "--format", "ID,PublicIPv4", "--no-header"], { quiet: true, allowFail: true, timeout: 10 * minute });
    if (created.status !== 0) {
      // The droplet may exist even though the call failed or timed out: find it so it is deleted.
      const ours = run("doctl", ["compute", "droplet", "list", "--tag-name", runTag, "--format", "ID", "--no-header"], { quiet: true, allowFail: true, timeout: minute });
      const ids = ours.status === 0 ? ours.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
      if (ids.length === 1) dropletId = ids[0];
      else if (ours.status !== 0) console.log(`check for a droplet left by this run: doctl compute droplet list --tag-name ${runTag}`);
      throw new Error(`could not create droplet ${name}: ${String(created.error?.message ?? created.stderr).trim()}`);
    }
    [dropletId, host] = created.stdout.trim().split(/\s+/);
    // --wait can return before the droplet has its public address (seen on 2026-10-31).
    for (let i = 0; i < 30 && !host; i += 1) {
      await sleep(10_000);
      host = run("doctl", ["compute", "droplet", "get", String(dropletId), "--format", "PublicIPv4", "--no-header"], { quiet: true, allowFail: true, timeout: minute }).stdout?.trim();
    }
    if (!host) throw new Error(`droplet ${dropletId} has no public address after five minutes`);
    console.log(`droplet ${dropletId} at ${host}`);
    await answers(30);
  }

  console.log("provisioning");
  await retry(2, () => remote([
    "cloud-init status --wait >/dev/null",
    // No package updates during the round: r8's droplet installed a new kernel while it ran
    // (#466), so a power cycle came back on a kernel `perf` was not installed for, and an apt run
    // takes CPU and memory from what is being measured. Then wait for an apt run already started
    // (both services are oneshot: a unit ordered after them starts when they finish).
    "(systemctl disable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true)",
    "timeout 900 systemd-run --quiet --property=After=apt-daily.service --property=After=apt-daily-upgrade.service --wait /bin/true",
    // A droplet that locks up restarts itself: a CPU stuck in the kernel (r8's soft lockup) or an
    // RCU stall panics the kernel, which reboots ten seconds later; and where the kernel has the
    // software watchdog, a droplet whose systemd runs nothing for five minutes is rebooted.
    write("/etc/sysctl.d/90-corten-bench.conf", "kernel.softlockup_panic = 1\nkernel.panic_on_rcu_stall = 1\nkernel.panic = 10\n"),
    "sysctl -q -p /etc/sysctl.d/90-corten-bench.conf",
    `(modprobe softdog && ${write("/etc/modules-load.d/corten-bench.conf", "softdog\n")} && mkdir -p /etc/systemd/system.conf.d && ${write("/etc/systemd/system.conf.d/corten-bench.conf", "[Manager]\nRuntimeWatchdogSec=5min\n")} && systemctl daemon-reexec || echo "no software watchdog")`,
    "command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh >/dev/null",
    "command -v node >/dev/null || (curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null && apt-get install -y -qq nodejs >/dev/null)",
    "command -v perf >/dev/null || apt-get install -y -qq linux-tools-common linux-tools-$(uname -r) >/dev/null",
    // bench/browser renders its Corten pages with a small Rust program (gen/).
    ...(suite === "browser"
      ? ["command -v cc >/dev/null || apt-get install -y -qq build-essential >/dev/null", "command -v cargo >/dev/null || (curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null)"]
      : []),
  ].join(" && "), 30));

  console.log("uploading the working tree");
  const tarball = join(here, "results", ".upload.tgz");
  mkdirSync(dirname(tarball), { recursive: true });
  run("tar", ["-czf", tarball, "--exclude=target", "--exclude=node_modules", "--exclude=./bench/fullstack/results", "--exclude=./bench/live/results", "--exclude=./bench/browser/results", "--exclude=./bench/browser/out", "--exclude=./.git", "-C", repo, "."], { timeout: 5 * minute });
  const from = flag("from");
  // Going on from a step keeps the earlier results, so the passes are theirs (run-ssr.mjs wrote
  // them): a relaunch that forgets --passes runs as many, and one that names another count stops.
  if (from && suite === "fullstack") {
    const kept = ssh(`cat ${suiteDir}/results/${round}/fixture/passes.json 2>/dev/null || true`, { quiet: true, allowFail: true }).stdout?.trim();
    const earlier = kept ? passesOf(String(JSON.parse(kept).passes)) : null;
    if (earlier !== null && args.includes("--passes") && earlier !== passes) throw new Error(`round ${round}'s results were run with ${earlier} passes, not ${passes}: start the round again, or go on with --passes ${earlier}`);
    if (earlier !== null) passes = earlier;
  }
  const env = envFor(passes);
  // A round of this name already running there (a reused droplet) stops first.
  await retry(3, () => remote(`systemctl stop ${unitName} 2>/dev/null; ${from ? "mkdir -p /bench" : "rm -rf /bench && mkdir -p /bench"}`, 2));
  await retry(3, () => scp(tarball, `root@${host}:/bench/src.tgz`));
  remove(tarball);

  console.log("building the images");
  const fullstackImages = (/** @type {string[]} */ names) => names.filter((app) => app !== "corten").map((app) => `docker ${buildArgs(app, tier).join(" ")}`);
  await retry(2, () => remote(suite === "live"
    ? [
      "cd /bench && tar -xzf src.tgz",
      "docker build -q -f bench/live/apps/corten/Dockerfile -t cb-live-corten .",
      ...fullstackImages(Object.keys(live)),
      "docker network create rustbench >/dev/null 2>&1 || true",
    ].join(" && ")
    : [
      "cd /bench && tar -xzf src.tgz && npm ci --silent && npx playwright install --with-deps chromium >/dev/null",
      ...(suite === "browser" ? ["(cd bench/browser && npm ci --silent)"] : []),
      "docker build -q -f examples/card-market/Dockerfile -t cb-corten .",
      ...fullstackImages(only ?? Object.keys(apps)),
      "docker network create rustbench >/dev/null 2>&1 || true",
      // The browser suite's run-all.mjs runs attended and expects the item API (fullstack's
      // unattended run-all.mjs starts it itself).
      ...(suite === "browser" ? ["(docker rm -f item-api >/dev/null 2>&1; docker run -d --name item-api --network rustbench --cpuset-cpus 2-3 -v /bench/bench/fullstack:/b:ro node:24-bookworm-slim node /b/item-api/server.mjs /b/fixtures/items.json >/dev/null)"] : []),
    ].join(" && "), 90));

  // The round, as a script its unit runs. Only a full-stack round starts again at boot.
  const command = {
    live: `node run.mjs ${round}; node summarize.mjs ${round}; echo all done`,
    browser: `. "$HOME/.cargo/env"; node run-all.mjs ${round} 10 browser; cd /bench/bench/browser && node run-all.mjs ${round}`,
    fullstack: `exec node run-all.mjs ${round} 10 ${from ?? steps[0]} --unattended`,
    // Each app's phases run against a freshly started app; the step needs no load generator.
    harden: `node harden.mjs ${only ? only.join(",") : "all"} ${round} && echo all done`,
  }[suite];
  const script = `/bench/round-${round}.sh`;
  await retry(3, () => remote([
    // The matched tier's edge has cores 4-9, so its round needs 16 vCPUs, or k6 gets too few.
    write(script, `cd ${suiteDir}\n${edged ? 'if [ "$(nproc)" -lt 16 ]; then echo "round failed: the matched tier needs 16 vCPUs (the edge on 4-9, k6 on 10 and up), this host has $(nproc)"; exit 1; fi\n' : ""}export ${env}\n${command}\n`),
    // The full comparison's calls have their own limits and its builds a budget (round.mjs: they
    // fit in hoursFor(passes) together); the unit's limit is a backstop. live and browser take about an hour.
    write(`/etc/systemd/system/${unitName}.service`, unit({ description: `corten benchmark round ${round} (${suite})`, script, log, atBoot: suite === "fullstack", hours: suite === "fullstack" ? hoursFor(passes) : suite === "harden" ? 5 : 3 })),
    // A new round starts a new log and progress file; one going on from a step keeps the log.
    `rm -f ${suiteDir}/results-${round}.progress`,
    from ? `touch ${log}` : `: > ${log}`,
    "systemctl daemon-reload",
    suite === "fullstack" ? `systemctl enable --quiet ${unitName}` : "true",
  ].join(" && "), 2));
  // Starting a unit that has started does nothing, so this can be tried again.
  mayDestroy = false;
  await retry(3, () => ssh(`systemctl start ${unitName} && systemctl is-active --quiet ${unitName}`));
  console.log(`running round ${round} on the droplet by itself (${{ live: "about an hour", browser: "about an hour", harden: `about eight minutes an app, for ${(only ?? Object.keys(apps)).length} (estimated: six phases of 45 to 90 seconds each and each app's start, from two apps locally)`, fullstack: passes > 1 ? `about ${Math.round(((only?.length ?? Object.keys(apps).length) * (25 + 16 * (passes - 1))) / 6) / 10} hours with ${passes} passes of each load phase (estimated: about twenty-five minutes an app for the first pass, its build included, and about sixteen for each pass after, its four sets of load phases; the unit stops at ${hoursFor(passes)})` : only || tier === "matched" ? `about twenty-five minutes an app, its build included, for ${(only ?? Object.keys(apps)).length} (estimated: r14's eighteen apps averaged 21, and aot1's three, one without pages, took 42 minutes with no build step)` : "about six and a half hours, the builds included (r14's eighteen apps took 6.3 from cold start to the summary)" }[suite]})`);
};

// Finds the droplet of a round started earlier, by its name.
const find = () => {
  if (host) return;
  const ours = tagged().filter(([, n]) => n === name);
  if (ours.length !== 1) throw new Error(ours.length ? `${ours.length} corten-bench droplets are named ${name}` : `no corten-bench droplet is named ${name}`);
  [[dropletId, , host]] = ours;
  const tags = run("doctl", ["compute", "droplet", "get", String(dropletId), "--format", "Tags", "--no-header"], { quiet: true, allowFail: true, timeout: minute }).stdout ?? "";
  runTag = tags.split(/[\s,]+/).find((t) => t.startsWith("corten-bench-run-")) ?? null;
  console.log(`droplet ${dropletId} at ${host}`);
};

// Waits for the round to end ("finished" or "stopped"), or with `once` (--collect), returns
// "running" as soon as it knows the round is going on. A droplet that does not answer for `stall`
// (and is not cut off from here: DigitalOcean answers) is power-cycled, at most twice; a full-stack
// round goes on by itself after that. --collect waits that long too, and gives up (leaving the
// droplet) only when DigitalOcean cannot be reached either.
const watch = async (/** @type {boolean} */ once) => {
  let shown = 0;
  let silentSince = /** @type {number | null} */ (null);
  let silentPolls = 0;
  let cycles = 0;
  let stopped = 0;
  for (let poll = 0; ; poll += 1) {
    if (poll) await sleep(minute);
    // The first line: seconds since boot and the unit's state; then the log.
    const r = ssh(`echo "$(cut -d. -f1 /proc/uptime) $(systemctl show -p ActiveState --value ${unitName})"; cat ${log} 2>/dev/null; true`, { quiet: true, allowFail: true });
    if (r.status === 0) {
      silentSince = null;
      silentPolls = 0;
      const [first, ...rest] = r.stdout.split("\n");
      const [uptime, unitState] = first.trim().split(" ");
      const text = rest.join("\n");
      const lines = text.split("\n").filter((l) => /^\d{4}-|step failed|step \S+ skipped|all done|round failed|browser suite|^\|/.test(l));
      for (const l of lines.slice(once ? Math.max(shown, lines.length - 8) : shown)) console.log(l);
      shown = lines.length;
      if (doneMarker.test(text)) return "finished";
      // The unit is not running and the round did not finish. A full-stack round's droplet that
      // restarted less than five minutes ago may not have started the unit again yet, and the unit
      // may be between states, so this has to hold for three polls.
      const inactive = unitState === "inactive" || unitState === "failed";
      stopped = inactive && (suite !== "fullstack" || Number(uptime) > 300) ? stopped + 1 : 0;
      if (stopped >= 3 || (stopped && /round failed/.test(text))) return "stopped";
      if (once && !stopped) return "running";
      continue;
    }
    silentSince ??= Date.now();
    silentPolls += 1;
    if (Date.now() - silentSince < stall || silentPolls < 3) continue;
    // A network problem here looks the same as a hung droplet: only a droplet that DigitalOcean
    // can be reached past is restarted.
    if (run("doctl", ["account", "get"], { quiet: true, allowFail: true, timeout: minute }).status !== 0) {
      if (once || Date.now() - silentSince > 4 * 60 * minute) throw new Error(`neither the droplet at ${host} nor DigitalOcean answers from here`);
      console.log("neither the droplet nor DigitalOcean answers from here: waiting for the network");
      continue;
    }
    const why = `it has not answered for ${Math.round((Date.now() - silentSince) / minute)} minutes`;
    if (suite !== "fullstack" || cycles >= 2) throw new Error(`the droplet at ${host} is stuck: ${why}`);
    const id = dropletId ?? tagged().find(([, , ip]) => ip === host)?.[0];
    if (!id) throw new Error(`the droplet at ${host} is stuck (${why}) and no corten-bench droplet has that address to power-cycle`);
    cycles += 1;
    console.log(`the droplet is stuck, ${why}: power-cycling droplet ${id}; the round goes on from the next step (or the next app's build)`);
    run("doctl", ["compute", "droplet-action", "power-cycle", id, "--wait"], { quiet: true, allowFail: true, timeout: 10 * minute });
    silentSince = null;
    silentPolls = 0;
    if (once && (await answers(60))) return "running";
  }
};

try {
  if (collect || attach) {
    mayDestroy = false;
    find();
  } else {
    await launch();
    if (detach) {
      leftRunning();
      process.exit(0);
    }
  }
  const state = await watch(collect);
  if (state === "running") {
    console.log(`round ${round} is still running`);
    leftRunning();
    process.exitCode = 3;
  } else {
    // The droplet goes only once its results are here: a download that fails leaves it for the
    // next --collect.
    if (state === "finished") {
      console.log("downloading the results");
      await downloadAll("results");
      // A finished round keeps its summaries as files and its raw output in one archive (pack.mjs).
      // A failure there leaves the files as downloaded and the droplet's fate as it was.
      // harden.mjs prints the marker only when every phase ran and its file was written; a download
      // without the file is not a finished hardening round.
      if (suite === "harden" && !existsSync(join(here, "results", round, "hardening.json"))) {
        console.log(`results/${round}/hardening.json did not come down with the round`);
        process.exitCode = 1;
      }
      if (suite === "fullstack") {
        try {
          // A round collected before was packed: the download brought every file again, so its
          // archive goes before they are packed anew.
          rmSync(join(here, "results", round, ARCHIVE), { force: true });
          console.log(`${round}: ${pack(join(here, "results", round))} raw files in ${ARCHIVE}`);
        } catch (e) {
          console.log(`could not pack the raw results (${String(/** @type {any} */ (e).message).split("\n")[0]}): node bench/fullstack/pack.mjs ${round}`);
          process.exitCode = 1;
        }
        // Whether Corten's numbers have drifted across the full rounds (trend.mjs; "DRIFT" lines
        // name what has), written to the round's trend.json. Only a full round (r<n>) has one.
        // A trend that could not be made (a baseline missing, a commit not in this clone) fails the
        // collect, as a pack that could not be made does, so automation keyed on the exit sees it.
        if (/^r\d+$/.test(round) && run("node", [join(here, "trend.mjs"), round], { allowFail: true, timeout: minute }).status !== 0) {
          console.log(`could not write the trend: node bench/fullstack/trend.mjs ${round}`);
          process.exitCode = 1;
        }
      }
    } else {
      // A round that stopped short keeps what it measured.
      console.log("the round stopped before it finished; downloading what it has");
      await downloadAll("partial results (the round did not finish)");
      process.exitCode = 1;
    }
    mayDestroy = true;
  }
} catch (e) {
  // A run that waits for its round (not --collect, which leaves the droplet for the next look) and
  // cannot go on keeps what the round measured, then destroys the droplet as it would at the end.
  // If the download fails too, the droplet stays for a --collect.
  if (!collect && !mayDestroy) {
    console.log(`the round could not go on (${String(/** @type {any} */ (e).message).split("\n")[0]}); downloading what it has`);
    try {
      await downloadAll("partial results (the round did not finish)");
      mayDestroy = true;
    } catch (d) {
      console.log(`could not download them: ${String(/** @type {any} */ (d).message).split("\n")[0]}`);
    }
  }
  if (!mayDestroy) leftRunning();
  throw e;
} finally {
  destroy();
}
