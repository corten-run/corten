// steady-run.mjs against a fake Docker and a fake docker stats client, like alert-probe-run.test.mjs:
// the real runner, ownedResources and k6 readers, with no daemon, k6 or app.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientLimits, coldOutput, coldOutputBytes, coldResult, combinedRunner, containerBase, eventStream, memorySampler, passRunId, readBounded, runSteady } from "./steady-run.mjs";
import { convergenceLines, eventFormat, intervalSchedule, ownerLabelKey, parseSteadyArgs, timedStartup, validateConvergence, validateSoak } from "./steady-contract.mjs";
import { steadyReport } from "./steady-report.mjs";
import { resultSchema } from "./run-contract.mjs";
import { groupApps } from "./groups.mjs";
import { apps } from "./contract.mjs";
import { k6Image } from "../load-tool.mjs";
import { runClock } from "./alert-probe-run.mjs";
import { commandOutput, commandRunner } from "../catalog/output.mjs";

const commit = "c".repeat(40);
const k6ImageId = `sha256:${"5".repeat(64)}`, upstreamImageId = `sha256:${"4".repeat(64)}`;
const appImageId = (image) => `sha256:${createHash("sha256").update(image).digest("hex")}`;
const quiet = () => {};
const pinnedEnv = { MARKETPLACE_APP_CPUS: "1", MARKETPLACE_LOAD_CPUS: "4-7", MARKETPLACE_API_CPUS: "2-3" };
// The fixture a pass copies and mounts: a file of its own, not the checkout's Git-ignored one.
const fixtureRoot = mkdtempSync(join(tmpdir(), "steady-run-fixture-"));
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
const fixtureFile = join(fixtureRoot, "marketplace.json");
writeFileSync(fixtureFile, JSON.stringify({ item_1: { id: "item_1" } }));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// window-load.js's k6 summary export: `counts` requests per window, each served, plus `graceFailed`
// requests answered with a failure during the graceful stop and `windowFailed` failures in windows.
// A fixed-rate load also exports `arrivals`, the iterations started per window. Every counter's
// rate is its count over `clockMs`, the engine clock k6 also writes beside it.
function k6Export(counts, { graceFailed = 0, windowFailed = {}, clockMs = 120_000, arrivals = null } = {}) {
  const total = counts.reduce((a, b) => a + b, 0) + graceFailed;
  const failed = graceFailed + Object.values(windowFailed).reduce((a, b) => a + b, 0);
  // The aggregate covers every request, so its maximum is at least every window's p99 below.
  const latency = { avg: 5, "p(50)": 4, "p(95)": 9, "p(99)": 20, max: 30 };
  const rate = (count) => count / (clockMs / 1000);
  const metrics = { http_reqs: { count: total, rate: rate(total) }, iterations: { count: total, rate: rate(total) }, vus_max: { value: 32, min: 32, max: 32 },
    http_req_duration: latency, iteration_duration: latency, http_req_failed: { passes: failed, fails: total - failed, value: failed / total },
    checks: { passes: 2 * total - failed, fails: failed, value: (2 * total - failed) / (2 * total) } };
  counts.forEach((n, i) => {
    metrics[`window_${i}_requests`] = { count: n, rate: rate(n) };
    metrics[`window_${i}_duration`] = { avg: 5, "p(50)": 4, "p(95)": 9, "p(99)": 20, max: 30 };
    if (windowFailed[i]) metrics[`window_${i}_failed`] = { count: windowFailed[i], rate: rate(windowFailed[i]) };
  });
  if (graceFailed) metrics.window_tail_requests = { count: graceFailed, rate: rate(graceFailed) };
  if (arrivals) arrivals.forEach((n, i) => { if (n) metrics[`window_${i}_arrivals`] = { count: n, rate: rate(n) }; });
  return { metrics, root_group: { checks: { "marketplace status 200": { passes: total - failed, fails: failed }, "marketplace content type": { passes: total, fails: 0 } } } };
}

/**
 * A Docker daemon in memory. `exportFor(appName)` gives the k6 summary for the cell whose app has
 * that name; `withhold(name)` makes that create fail after making nothing visible (its container
 * only appears once the pass is over); `lose(name)` makes it fail after the daemon made the container
 * (its acknowledgement lost); `failRemove(name)` fails every removal of that container;
 * `oomOnLoad` marks the app OOM-killed when the load ends; `restartOnLoad` restarts it in place (a
 * docker restart: the same ID and RestartCount, a new StartedAt). Its clock is the runner's
 * (`now`): the host's clock, or with `epochMs` that fixed time, which moves only when the daemon or
 * the test moves it on (`offset`). A load run moves it on by `startupMs` before the container's StartedAt and by `runMs`
 * (by default the engine clock `clockMs`, written to the clock file) before its FinishedAt.
 * `override(args, state)` answers a command first: an Error is thrown, a string returned (for docker
 * logs, the container's stdout), undefined leaves it to the daemon. A docker logs call with `file`
 * appends both of the container's streams to it (its stdout alone with `fileStderr: false`) and
 * returns nothing; `combined: false` returns its stdout alone. `probeStderr` is what each cold probe writes to stderr. It publishes container events (start, and the app's oom, die or kill when
 * the load does that to it, or `duringLoad(state)` emits) to every events client listening, as
 * `emit(id, action)`, and the load's own attach, start, die and the archive-path of each copy out of
 * it; `inspected(info, container)` may change an inspect answer. An inspect reports
 * the CPU quota (as NanoCpus), CPU pinning and memory limit the create asked for, as Docker applies
 * `--cpus`, `--cpuset-cpus` and `--memory`.
 */
function fakeDocker({ exportFor, withhold = () => false, lose = () => false, failRemove = () => false, oomOnLoad = false, restartOnLoad = false, loadMs = 0, clockMs = 120_000, runMs = clockMs, startupMs = 0, override = () => undefined,
  duringLoad = () => {}, inspected = (info) => info, probeStderr = "", epochMs = null } = {}) {
  const containers = new Map(), networks = new Map(), calls = [], late = [];
  let next = 1;
  const id = () => (next++).toString(16).padStart(64, "0");
  const labelsOf = (args) => Object.fromEntries(args.flatMap((a, i) => (a === "--label" ? [[args[i + 1].slice(0, args[i + 1].indexOf("=")), args[i + 1].slice(args[i + 1].indexOf("=") + 1)]] : [])));
  const role = (name) => (name.endsWith("-host") ? "host" : name.endsWith("-upstream") ? "upstream" : name.endsWith("-probe") ? "probe" : name.endsWith("-marker") ? "marker" : name.endsWith("-k6-version") ? "version" : name.endsWith("-k6") ? "k6" : "app");
  const matches = (labels, filter) => { const pair = filter.slice("label=".length), at = pair.indexOf("="); return labels[pair.slice(0, at)] === pair.slice(at + 1); };
  const byName = (name) => [...containers.values()].find((c) => c.name === name);
  const flag = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const bytes = (size) => (size === null ? 0 : Number(size.slice(0, -1)) * { g: 2 ** 30, m: 2 ** 20 }[size.at(-1)]);
  const info = (c) => ({ Id: c.id, Name: `/${c.name}`, Image: c.imageId, RestartCount: 0, Config: { Labels: c.labels, Env: c.args.flatMap((a, i) => (a === "-e" ? [c.args[i + 1]] : [])), Image: c.image, Cmd: null }, State: c.state,
    HostConfig: { Memory: bytes(flag(c.args, "--memory")), NanoCpus: flag(c.args, "--cpus") === null ? 0 : Number(flag(c.args, "--cpus")) * 1e9, CpuPeriod: 0, CpuQuota: 0, CpusetCpus: flag(c.args, "--cpuset-cpus") ?? "", NetworkMode: "bridge", Ulimits: null }, Mounts: [],
    NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "49153" }] } } });
  const get = (cid) => { const c = containers.get(cid); if (!c) throw new Error(`Error: No such container: ${cid}`); return c; };
  const filterOf = (args) => args[args.indexOf("--filter") + 1];
  // ids: the ID each create made, by name, including a withheld one.
  const state = { containers, networks, calls, late, ids: {}, offset: 0, startIssuedMs: null, listeners: [] };
  state.now = () => (epochMs ?? Date.now()) + state.offset;
  state.emit = (cid, action) => { const nanos = (BigInt(state.now()) * 1_000_000n).toString(); for (const listener of state.listeners) listener(cid, action, nanos); };
  state.app = () => [...containers.values()].find((c) => c.kind === "app");
  const iso = () => new Date(state.now()).toISOString();
  // A container's log, as docker logs gives it: to a file, stdout alone, or both streams.
  const logged = (stdout, stderr, options) => {
    if (options.file) { appendFileSync(options.file, options.fileStderr === false ? stdout : stdout + stderr); return ""; }
    return options.combined === false ? stdout : stdout + stderr;
  };
  state.docker = async (args, options = {}) => {
    calls.push({ args, cleanup: options.cleanup === true, file: options.file, combined: options.combined });
    const answer = override(args, state);
    if (answer instanceof Error) throw answer;
    if (typeof answer === "string") return args[0] === "logs" ? logged(answer, "", options) : answer;
    const [command, ...rest] = args;
    switch (command) {
      case "version": return "27.5.1";
      case "image": {
        assert.equal(rest[0], "inspect");
        if (rest[1] === k6Image) return JSON.stringify([{ Id: k6ImageId, Os: "linux", Architecture: "amd64", RepoDigests: [k6Image] }]);
        return JSON.stringify([{ Id: appImageId(rest[1]), Size: 1, Config: { Labels: { "run.corten.marketplace.commit": commit, "run.corten.marketplace.dirty": "false" } }, RepoDigests: [] }]);
      }
      case "create": {
        assert.equal(rest[0], "--name");
        const name = rest[1], kind = role(name), image = kind === "app" ? args.at(-1) : null;
        const c = { id: id(), name, kind, labels: labelsOf(args), args, image: image ?? "fixed", imageId: kind === "app" ? image : kind === "k6" || kind === "version" ? k6ImageId : upstreamImageId,
          state: { Running: false, OOMKilled: false, ExitCode: 0, StartedAt: "0001-01-01T00:00:00Z" } };
        state.ids[name] = c.id;
        if (withhold(name)) { late.push(c); throw new Error("Error response from daemon: context deadline exceeded"); }
        containers.set(c.id, c);
        if (lose(name)) throw new Error("Error response from daemon: lost acknowledgement");
        return c.id;
      }
      case "network": {
        if (rest[0] === "create") { const n = { id: id(), name: args.at(-1), labels: labelsOf(args) }; networks.set(n.id, n); return n.id; }
        if (rest[0] === "ls") { const f = filterOf(args); return [...networks.values()].filter((n) => (f.startsWith("id=") ? n.id === f.slice(3) : matches(n.labels, f))).map((n) => n.id).join("\n"); }
        if (rest[0] === "inspect") { const n = networks.get(rest[1]); if (!n) throw new Error("No such network"); return JSON.stringify([{ Id: n.id, Labels: n.labels }]); }
        if (rest[0] === "rm") { networks.delete(rest[1]); return rest[1]; }
        throw new Error(`unexpected docker ${args.join(" ")}`);
      }
      case "container": { assert.equal(rest[0], "inspect"); const c = get(rest[1]); return JSON.stringify([inspected(info(c), c, state)]); }
      case "ps": { const f = filterOf(args); return [...containers.values()].filter((c) => (f.startsWith("id=") ? c.id === f.slice(3) : matches(c.labels, f))).map((c) => c.id).join("\n"); }
      case "start": {
        // A marker start moves the clock on a millisecond, as Docker's own calls take time: a real
        // second start is strictly after the load's FinishedAt, and its exit strictly after that
        // start, which readEvents requires.
        if (rest[0] !== "-a") {
          const c = get(rest[0]); if (c.kind === "marker") state.offset += 1;
          c.state = { Running: c.kind !== "marker", OOMKilled: false, ExitCode: 0, StartedAt: iso() }; state.emit(c.id, "start");
          if (c.kind === "marker") { state.offset += 1; state.emit(c.id, "die"); }
          return c.id;
        }
        const c = get(rest[1]);
        if (c.kind === "host") { c.state = { Running: false, OOMKilled: false, ExitCode: 0, StartedAt: iso() }; return "6.8.0-test\nmodel name\t: Synthetic CPU\n0-7"; }
        if (c.kind === "version") { assert.deepEqual(c.args.slice(-2), [k6ImageId, "version"]); c.state = { Running: false, OOMKilled: false, ExitCode: 0, StartedAt: iso() }; return "k6 v2.4.0 (commit/0000000, go1.24, linux/amd64)"; }
        assert.equal(c.kind, "k6");
        state.startIssuedMs = state.now();
        state.emit(c.id, "attach");
        state.offset += startupMs;
        const startedAt = iso();
        state.emit(c.id, "start");
        await new Promise((resolve) => setTimeout(resolve, loadMs));
        state.offset += runMs + 5;
        c.state = { Running: false, OOMKilled: false, ExitCode: 0, StartedAt: startedAt, FinishedAt: iso() };
        state.emit(c.id, "die");
        if (oomOnLoad) for (const app of containers.values()) if (app.kind === "app") { app.state = { ...app.state, Running: false, OOMKilled: true, ExitCode: 137 }; state.emit(app.id, "oom"); state.emit(app.id, "die"); }
        if (restartOnLoad) for (const app of containers.values()) if (app.kind === "app") { app.state = { ...app.state, StartedAt: iso() }; state.emit(app.id, "restart"); }
        duringLoad(state);
        return "";
      }
      case "logs": {
        const c = get(rest[0]);
        if (c.kind !== "probe") return logged("app log\n", "", options);
        const app = byName(c.name.slice(0, -"-probe".length));
        const result = { first200At: new Date(Date.parse(app?.state.StartedAt) + 5).toISOString(), successfulRequestMs: 1.5, bytes: 10, attempts: 2, path: c.args.at(-2) };
        return logged(app?.state.Running ? `catalog-probe-ready\n${JSON.stringify(result)}\n` : "catalog-probe-ready\n", probeStderr, options);
      }
      case "wait": return "0";
      case "rm": {
        const c = get(rest[2]);
        if (failRemove(c.name)) throw new Error("Error response from daemon: removal of container is already in progress");
        containers.delete(c.id);
        return c.id;
      }
      case "cp": {
        const c = get(rest[0].slice(0, rest[0].indexOf(":")));
        state.emit(c.id, "archive-path");
        const app = [...containers.values()].find((x) => x.kind === "app");
        writeFileSync(rest[1], JSON.stringify(rest[0].endsWith("summary.json") ? exportFor(app.name, c) : { testRunDurationMs: clockMs }));
        return "";
      }
      default: throw new Error(`unexpected docker ${args.join(" ")}`);
    }
  };
  return state;
}
const git = async (args) => (args[0] === "rev-parse" ? commit : "");
const folderOf = (t) => {
  const root = mkdtempSync(join(tmpdir(), "steady-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return (name) => join(root, name);
};
// The prefix of every Docker name the test run's pass gives (containerBase); its run ID is the owner label's value.
const base = containerBase("marketplace-test-run");
const run = (fake, options, folder, extra = {}) => runSteady({ options, folder, runId: "marketplace-test-run", docker: fake.docker, git, env: {}, window: 30, clock: runClock({ now: fake.now }),
  fixture: () => "f".repeat(64), fixtureFile, upstreamReady: async () => {}, print: quiet, spawnEvents: eventsClient(fake).spawn, eventBounds: { markerMs: 200, graceMs: 5, boundMs: 50 }, ...extra });
// A fixed 150 requests/second soak's k6 export over 30 one-minute intervals, every arrival on schedule.
const soakExport = (extra = {}) => k6Export(Array(30).fill(150 * 60), { clockMs: 1_800_000, arrivals: intervalSchedule({ rate: 150, seconds: 1800, windowSeconds: 60 }), ...extra });
const flat = (n, rps = 1000, seconds = 15) => Array(n).fill(rps * seconds);
const isId = (value) => /^[0-9a-f]{64}$/.test(value);
// The raw files a failure's message and a cleanup failure's first line go to (never summary.json).
const errorsOf = (dir) => readFileSync(join(dir, "errors.log"), "utf8");
const cleanupOf = (dir) => JSON.parse(readFileSync(join(dir, "cleanup.json"), "utf8"));

test("a convergence pass starts each cell with the timed round's cold start and records what like-for-like needs", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t1", "--apps", "corten", "--sources", "fixture", "--minutes", "2", "--label", "agent.owner=codex"], apps, groupApps);
  const fake = fakeDocker({ exportFor: () => k6Export(flat(8)) });
  const s = await run(fake, options, folder("c"), { env: pinnedEnv });
  assert.equal(s.complete, true, JSON.stringify(s.failures));
  validateConvergence(s);
  assert.deepEqual(s.cells.map((c) => [c.target, c.verdict.withinTolerance, c.verdict.fromSeconds, c.failedRequests, c.requests, c.iterations]), [["page", true, 15, 0, 120_000, 120_000], ["json", true, 15, 0, 120_000, 120_000]]);
  assert.equal(s.startup, timedStartup);
  assert.equal(s.finishedCommit, commit);
  assert.deepEqual(s.cleanup, { complete: true, remaining: { containers: 0, networks: 0 }, created: 12, removed: 12, recovered: 0, failures: 0, unacknowledged: [] });
  // The host's CPU model is saved only as the SHA-256 of its text; the text is in host.txt alone.
  assert.deepEqual([s.host.kernel, s.host.cpuModelSha256, s.host.onlineCpus, s.fixtureSha256, s.tools.upstream.imageId, s.tools.k6.imageId], ["6.8.0-test", sha256("Synthetic CPU"), "0-7", "f".repeat(64), upstreamImageId, k6ImageId]);
  assert.ok(!readFileSync(join(folder("c"), "summary.json"), "utf8").includes("Synthetic CPU"));
  // The k6 version came from an owned container, created, attached and removed by ID: no docker run.
  assert.equal(s.tools.k6.version, "2.4.0");
  assert.ok(!fake.calls.some((c) => c.args[0] === "run"), "no untracked docker run");
  const version = fake.ids[`${base}-k6-version`];
  assert.ok(fake.calls.some((c) => c.args[0] === "rm" && c.args.at(-1) === version), "the version probe was removed by its ID");
  // Each target's sidecar polls that target's own path, as run.mjs coldStart does, and the app starts
  // only once the sidecar is waiting, before the load container exists.
  const creates = fake.calls.filter((c) => c.args[0] === "create").map((c) => c.args);
  const probes = creates.filter((a) => a[2].endsWith("-probe"));
  assert.deepEqual(probes.map((a) => a.at(-2)), ["/marketplace/en-US/item_1", "/api/marketplace/item_1"]);
  for (const [index, probe] of probes.entries()) {
    const at = (predicate) => fake.calls.findIndex(predicate);
    const probeStart = at((c, i) => c.args[0] === "start" && i > fake.calls.findIndex((x) => x.args === probe) && c.args[1] !== "-a");
    const k6Create = fake.calls.findIndex((c, i) => i > probeStart && c.args[0] === "create" && c.args[2].endsWith("-k6"));
    const appStart = fake.calls.findIndex((c, i) => i > probeStart && c.args[0] === "start" && c.args[1] !== "-a");
    assert.ok(probeStart >= 0 && appStart > probeStart && k6Create > appStart, `cell ${index}: probe, then app start, then load`);
  }
  // The default pass runs the timed warmup's 32 users.
  for (const a of creates.filter((x) => x[2].endsWith("-k6"))) assert.ok(a.includes("VUS=32"));
  // Every resource carries the owner label and the caller's labels; every read, start and removal is by ID.
  for (const c of fake.calls.filter((x) => x.args[0] === "create" || (x.args[0] === "network" && x.args[1] === "create"))) {
    assert.ok(c.args.includes(`${ownerLabelKey}=marketplace-test-run`) && c.args.includes("agent.owner=codex"), c.args.join(" "));
  }
  for (const c of fake.calls) {
    if (c.args[0] === "container" || c.args[0] === "logs" || c.args[0] === "wait") assert.ok(isId(c.args.at(-1)), c.args.join(" "));
    if (c.args[0] === "start") assert.ok(isId(c.args.at(-1)), c.args.join(" "));
    if (c.args[0] === "rm") assert.ok(isId(c.args.at(-1)), c.args.join(" "));
  }
  const cleanup = JSON.parse(readFileSync(join(folder("c"), "cleanup.json"), "utf8"));
  assert.equal(cleanup.complete, true); assert.deepEqual(cleanup.remaining, { containers: 0, networks: 0 });
  assert.equal(fake.containers.size, 0); assert.equal(fake.networks.size, 0);
  // A round with the same inputs is like-for-like with what the runner recorded.
  const round = { schema: resultSchema, commit, options: { warmup: 10, startupTimeout: 120 }, host: { cpu: "Synthetic CPU", release: s.host.kernel, onlineCpus: s.host.onlineCpus }, measurement: s.measurement,
    fixtureSha256: s.fixtureSha256, tools: s.tools, apps: { corten: { imageId: s.images.corten, runs: { "fixture-json": [{ warmup: { failed: 0 } }] } } } };
  // A fixture-only pass covers half of the round's cells: like-for-like for those only, said after its coverage.
  const lines = convergenceLines(round, ["corten"], s);
  assert.equal(lines[1], "Coverage: the pass has a reading for 2 of this round's 4 measured adapter, source and target cells (corten fixture page, corten fixture json); no convergence pass for: corten api page, corten api json.");
  assert.match(lines[2], /^The pass is like-for-like with this round for its 2 cells with a reading only, on every input compared for them: .* It says nothing about this round's other cells\.$/);
  // An unpinned pass records no CPU placement, so it is not like-for-like even with an unpinned round.
  const unpinned = await run(fakeDocker({ exportFor: () => k6Export(flat(8)) }), options, folder("unpinned"));
  assert.match(convergenceLines({ ...round, measurement: unpinned.measurement, tools: unpinned.tools, apps: { corten: { imageId: unpinned.images.corten, runs: round.apps.corten.runs } } }, ["corten"], unpinned)[2],
    /not like-for-like.*the app CPU pinning \(cpuset\) is not recorded on both sides \(pass: not recorded; round: not recorded\)/);
});

// RFC 1035 label: what a container name must be for another container on the network to resolve it.
const dnsLabel = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
test("every container a pass starts has a name, and is reached by a hostname, that is a valid DNS label, for the longest pass name the CLI accepts", async (t) => {
  const folder = folderOf(t);
  const longest = "r21-runtimes-".padEnd(41, "x");
  assert.throws(() => parseSteadyArgs(["convergence", `${longest}x`], apps, groupApps), /a pass name/);
  assert.equal(passRunId("soak", "w4", "0123456789"), "marketplace-soak-w4-0123456789");
  // Two runs of the same pass get different prefixes, from their run IDs' random suffixes.
  assert.notEqual(containerBase(passRunId("convergence", longest)), containerBase(passRunId("convergence", longest)));
  assert.match(containerBase(passRunId("convergence", longest)), /^mkt-[0-9a-f]{12}$/);
  for (const name of [longest, "w3"]) {
    const options = parseSteadyArgs(["convergence", name, "--apps", "tanstack-start", "--sources", "api,fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
    // The run ID as steady.mjs makes it.
    const runId = passRunId(options.kind, options.name);
    const fake = fakeDocker({ exportFor: () => k6Export(flat(8)) });
    const s = await run(fake, options, folder(name), { runId });
    assert.equal(s.complete, true, JSON.stringify(s.failures));
    // The descriptive name and run ID are what the summary keeps, and what owns every resource.
    assert.deepEqual([s.name, s.runId], [name, runId]);
    const creates = fake.calls.filter((c) => c.args[0] === "create").map((c) => c.args);
    for (const a of creates) {
      assert.ok(dnsLabel.test(a[2]), `container name ${a[2]} (${a[2].length} characters)`);
      assert.ok(a.includes(`${ownerLabelKey}=${runId}`), `${a[2]} carries the owner label`);
      // Every hostname it reaches another container by: a URL argument or env value, and the app's HOSTS.
      const hosts = a.flatMap((x) => [...x.matchAll(/http:\/\/([^:/]+):8080/g)].map((m) => m[1]));
      const allowed = a.find((x) => x.startsWith("HOSTS="))?.slice(6).split(",").filter((h) => h !== "localhost" && h !== "127.0.0.1") ?? [];
      for (const host of [...hosts, ...allowed]) {
        assert.ok(dnsLabel.test(host), `hostname ${host} (${host.length} characters)`);
        assert.ok(creates.some((b) => b[2] === host), `hostname ${host} names a container this pass made`);
      }
    }
    // The upstream, both cells' apps, probes, loads and markers, and the host and k6 version probes.
    assert.equal(creates.length, 11);
    assert.equal(new Set(creates.map((a) => a[2])).size, 7, "one name per role: the two cells reuse theirs in turn");
    assert.equal(fake.containers.size, 0); assert.equal(fake.networks.size, 0);
  }
});

test("a load whose k6 engine clock does not cover the pass gives the cell no reading", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t7", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  // A 1 ms engine clock, with counter rates consistent with it: not a complete 120 s pass.
  const short = await run(fakeDocker({ exportFor: () => k6Export(flat(8), { clockMs: 1 }), clockMs: 1 }), options, folder("1ms"));
  assert.equal(short.cells[0].verdict, null);
  assert.equal(short.cells[0].failure, "load-evidence");
  assert.match(errorsOf(folder("1ms")), /k6 engine duration truncated\/outside container window/);
  // A clock longer than the container's own run, or rates not over the engine clock, is refused too.
  const outside = fakeDocker({ exportFor: () => k6Export(flat(8), { clockMs: 130_000 }), clockMs: 130_000, runMs: 120_000 });
  assert.equal((await run(outside, options, folder("outside"))).cells[0].failure, "load-evidence");
  assert.match(errorsOf(folder("outside")), /k6 engine duration truncated\/outside container window/);
  const rates = await run(fakeDocker({ exportFor: () => k6Export(flat(8), { clockMs: 125_000 }) }), options, folder("rates"));
  assert.equal(rates.cells[0].failure, "load-evidence");
  assert.match(errorsOf(folder("rates")), /count\/rate differs from engine elapsed clock/);
  // The same pass with a consistent clock reads.
  assert.equal((await run(fakeDocker({ exportFor: () => k6Export(flat(8)) }), options, folder("ok"))).cells[0].verdict.withinTolerance, true);
});

test("a convergence cell whose app was restarted in place during the load gets no reading", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t8", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  // A docker restart: the same container ID and RestartCount 0, a new StartedAt, running again.
  const s = await run(fakeDocker({ exportFor: () => k6Export(flat(8)), restartOnLoad: true }), options, folder("restart"));
  assert.equal(s.cells[0].verdict, null);
  assert.equal(s.cells[0].failure, "instance-changed");
  assert.ok(errorsOf(folder("restart")).includes("app container stopped, restarted, was replaced or was OOM-killed during the pass: another StartedAt"));
});

test("a failure answered during k6's graceful stop, or in a window, gives the cell no verdict", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t2", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  // Every window served; three 500s completed after the last window, during the graceful stop.
  const grace = await run(fakeDocker({ exportFor: () => k6Export(flat(8), { graceFailed: 3 }) }), options, folder("grace"));
  assert.equal(grace.cells[0].verdict, null);
  assert.equal(grace.cells[0].failure, "failed-requests");
  assert.match(errorsOf(folder("grace")), /3 requests failed in k6's aggregate, which includes the graceful stop; no verdict/);
  assert.equal(grace.complete, true); validateConvergence(grace);
  const inWindow = await run(fakeDocker({ exportFor: () => k6Export(flat(8), { windowFailed: { 2: 5 } }) }), options, folder("window"));
  assert.equal(inWindow.cells[0].failure, "failed-requests");
  assert.match(errorsOf(folder("window")), /5 requests failed in the pass's windows; no verdict/);
});

test("a convergence cell whose app was OOM-killed during the load gets no verdict", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t3", "--apps", "corten", "--sources", "fixture", "--targets", "json", "--minutes", "2"], apps, groupApps);
  const s = await run(fakeDocker({ exportFor: () => k6Export(flat(8)), oomOnLoad: true }), options, folder("oom"));
  assert.equal(s.cells[0].verdict, null);
  assert.equal(s.cells[0].failure, "instance-changed");
  assert.ok(errorsOf(folder("oom")).includes("app container stopped, restarted, was replaced or was OOM-killed during the pass: not running, OOM-killed"));
});

test("a create whose ID Docker withholds is not reported clean, and no further cell is measured", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t4", "--apps", "corten,aspnet", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  // The first cell's load container: the daemon errors, and the container it made only appears
  // after the pass's final scans.
  const fake = fakeDocker({ exportFor: () => k6Export(flat(8)), withhold: (name) => name === `${base}-k6` });
  const s = await run(fake, options, folder("withheld"));
  assert.equal(s.complete, false);
  assert.equal(s.cells[0].failure, "container");
  assert.deepEqual(s.failures, [{ stage: "suite", code: "unsettled" }]);
  const errors = errorsOf(folder("withheld"));
  assert.match(errors, /context deadline exceeded/);
  assert.ok(errors.includes(`corten fixture page did not settle (the create of ${base}-k6 was not acknowledged), so no further cell is measured`), errors);
  assert.equal(s.cells.length, 1, "aspnet was not measured");
  assert.ok(!fake.calls.some((c) => c.args[0] === "create" && c.args[2] === `${base}-aspnet`));
  const cleanup = cleanupOf(folder("withheld"));
  assert.equal(cleanup.complete, false);
  assert.deepEqual(cleanup.remaining, { containers: 0, networks: 0 }, "the scans found nothing, and that is not taken as clean");
  assert.deepEqual(cleanup.unacknowledged.map((a) => [a.name, a.outcome]), [[`${base}-k6`, "unconfirmed"]]);
  assert.ok(cleanup.failures.some((f) => /cleanup is unconfirmed/.test(f.error)));
  assert.equal(s.cleanup.complete, false);
  assert.ok(s.cleanup.failures > 0);
  assert.deepEqual(s.cleanup.unacknowledged.map((a) => [a.name, a.outcome]), [[`${base}-k6`, "unconfirmed"]]);
  // The cell's own app was removed before the pass stopped.
  const corten = fake.calls.find((c) => c.args[0] === "create" && c.args[2] === `${base}-corten`);
  assert.ok(corten && !fake.containers.size);
});

test("a round given to --admitted-from that does not read is refused with a fixed message on stdout and in run.log; its text stays in errors.log", async (t) => {
  const folder = folderOf(t);
  const canary = "CANARYadm";
  // A saved round whose schema is the canary (a validator names the value it refused), text that is
  // not JSON (JSON.parse quotes the input) and a file that is not there (its error quotes the path).
  for (const [name, text] of [["schema", JSON.stringify({ schema: canary, round: canary })], ["fragment", `${canary} {"round": "${canary}`], ["missing", null]]) {
    const file = folder(`${name}-${canary}.json`);
    if (text !== null) writeFileSync(file, text);
    const options = parseSteadyArgs(["convergence", "t9", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2", "--admitted-from", file], apps, groupApps);
    const printed = [];
    const s = await run(fakeDocker({ exportFor: () => k6Export(flat(8)) }), options, folder(name), { print: (line) => printed.push(line) });
    assert.equal(s.complete, false);
    assert.deepEqual(s.failures, [{ stage: "suite", code: "admission" }]);
    assert.equal(s.admission, null);
    const refusal = "suite FAILED (admission): the round given to --admitted-from could not be read or did not validate as a timed round (the reason is in errors.log) (detail in errors.log)";
    for (const [where, out] of [["stdout", printed.join("\n")], ["run.log", readFileSync(join(folder(name), "run.log"), "utf8")]]) {
      assert.ok(!out.includes(canary), `${name}: ${where} quotes the admitting round`);
      assert.ok(out.includes(refusal), `${name}: ${where}`);
    }
    assert.ok(!readFileSync(join(folder(name), "summary.json"), "utf8").includes(canary), name);
    assert.ok(errorsOf(folder(name)).includes(canary), `${name}: errors.log keeps the detail`);
  }
});

test("a load container that cannot be removed still has its app removed, and no further cell is measured", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t5", "--apps", "corten,aspnet", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  const fake = fakeDocker({ exportFor: () => k6Export(flat(8)), failRemove: (name) => name === `${base}-k6` });
  const s = await run(fake, options, folder("stuck"));
  assert.equal(s.complete, false);
  // The cell itself measured; its teardown is what failed.
  assert.equal(s.cells[0].verdict.withinTolerance, true);
  assert.deepEqual(s.failures, [{ stage: "suite", code: "unsettled" }]);
  assert.match(errorsOf(folder("stuck")), /corten fixture page did not settle \(container [0-9a-f]{64} was not removed\), so no further cell is measured/);
  // The app's removal is attempted after the load container's failed one, before the pass stops.
  const removals = fake.calls.map((c, index) => ({ index, args: c.args })).filter((c) => c.args[0] === "rm");
  const firstK6 = removals.find((r) => r.args[3] === fake.ids[`${base}-k6`]), appRemoval = removals.find((r) => r.args[3] === fake.ids[`${base}-corten`]);
  assert.ok(firstK6 && appRemoval && appRemoval.index > firstK6.index);
  assert.ok(appRemoval.index < fake.calls.findIndex((c) => c.args[0] === "ps" && c.args.includes(`label=${ownerLabelKey}=marketplace-test-run`)), "before the teardown sweep");
  assert.ok([...fake.containers.values()].every((c) => c.name === `${base}-k6`), "only the stuck load container is left");
  assert.ok(!fake.calls.some((c) => c.args[0] === "create" && c.args[2] === `${base}-aspnet`));
  assert.ok(cleanupOf(folder("stuck")).failures.some((f) => f.resource === fake.ids[`${base}-k6`] || f.resource.includes(`${base}-k6`)));
  assert.ok(s.cleanup.failures > 0);
});

/**
 * A docker events client on the fake daemon: from the moment it is spawned it writes each event the
 * daemon publishes for a container in its filters as `id|action|nanos`, in order, unless
 * `drop(row, index)` withholds it; it closes when signalled unless `holds`. A row `late(row)`
 * picks is held back: once the client has written the marker's second start, it writes nothing for
 * `lateMs`, then the held rows and every row published meanwhile, in that order, so an event
 * from the load reaches the reader in a later chunk than that start. `rewrite(row)` gives the rows
 * written in place of a published one (by default the row itself), so a test can copy, restamp or
 * drop one; the rows written for the marker's second start all go out before that pause.
 */
function eventsClient(fake, { drop = () => false, holds = false, late = () => false, lateMs = 30, rewrite = (row) => [row] } = {}) {
  const spawned = [];
  const spawn = (binary, args) => {
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kills: [], unref() { child.unrefed = true; } });
    child.kill = (signal = "SIGTERM") => {
      child.kills.push(signal);
      if (!holds && !child.ended) { child.ended = true; child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit("close", null)); }
      return true;
    };
    const ids = args.filter((a) => a.startsWith("container=")).map((a) => a.slice("container=".length));
    let index = 0, starts = 0, pausing = false;
    const held = [], queued = [];
    const write = (row) => { if (!child.ended) child.stdout.write(`${row}\n`); };
    fake.listeners.push((id, action, nanos) => {
      const published = `${id}|${action}|${nanos}`;
      if (child.ended || !ids.includes(id) || drop(published, index++)) return;
      for (const row of rewrite(published)) {
        if (late(row)) held.push(row);
        else if (pausing) queued.push(row);
        else write(row);
      }
      // The marker is the second ID the client filters on.
      if (id === ids[1] && action === "start" && ++starts === 2 && held.length) {
        pausing = true;
        setTimeout(() => { for (const r of [...held.splice(0), ...queued.splice(0)]) write(r); pausing = false; }, lateMs);
      }
    });
    spawned.push({ binary, args, child });
    return child;
  };
  return { spawn, spawned };
}
// A docker stats client: emits `rows(args)` `delayMs` after it starts; closes when signalled unless `holds`.
function statsClient({ rows = () => [], holds = false, delayMs = 2 } = {}) {
  const spawned = [];
  const spawn = (binary, args) => {
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kills: [], unref() { child.unrefed = true; } });
    child.kill = (signal = "SIGTERM") => {
      child.kills.push(signal);
      if (!holds && !child.ended) { child.ended = true; child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit("close", null)); }
      return true;
    };
    setTimeout(() => { if (!child.ended) for (const row of rows(args)) child.stdout.write(`${JSON.stringify(row)}\n`); }, delayMs);
    spawned.push({ binary, args, child });
    return child;
  };
  return { spawn, spawned };
}

test("a soak samples its app's memory by the container's ID, on the workstation clock from the load's start", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["soak", "t6", "--apps", "corten", "--sources", "fixture", "--targets", "page"], apps, groupApps);
  // The load container takes 5 s to start after its docker start is issued.
  const fake = fakeDocker({ exportFor: () => soakExport(), clockMs: 1_800_000, startupMs: 5000, loadMs: 50 });
  // 180 samples 10 s apart on the workstation clock from the issue of the load's docker start, of
  // 100 + i MiB. From that origin the first 60 s interval holds samples 0 to 5 and the last 174 to
  // 179; from the container's StartedAt, 5 s later, they would be 1 to 6 and 175 to 179.
  let tick = 0;
  const stats = statsClient({ delayMs: 10, rows: (args) => Array.from({ length: 180 }, (_, i) => ({ ID: args.at(-1), Name: `${base}-corten`, CPUPerc: "1.00%", MemUsage: `${100 + i}MiB / 1GiB` })) });
  const s = await run(fake, options, folder("soak"), { spawnStats: stats.spawn, statsBounds: { now: () => fake.startIssuedMs + 10_000 * tick++ } });
  assert.equal(s.complete, true, JSON.stringify([s.failures, s.cells]));
  validateSoak(s);
  const [cell] = s.cells;
  assert.deepEqual([cell.memory.samples, cell.memory.startMiB, cell.memory.endMiB, cell.rate.held, cell.failedRequests, cell.restarts.restarted, cell.requests], [180, 102.5, 276.5, true, 0, false, 270_000]);
  assert.deepEqual(stats.spawned.map((x) => x.args), [["stats", "--no-trunc", "--format", "{{json .}}", fake.ids[`${base}-corten`]]]);
  assert.ok(!stats.spawned[0].args.includes(`${base}-corten`));
});

test("a soak whose app was OOM-killed keeps its stop and OOM observations when its memory cannot be read", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["soak", "t7", "--apps", "corten", "--sources", "fixture", "--targets", "page"], apps, groupApps);
  const load = () => soakExport();
  // The after-inspect says OOMKilled and not running, and the last memory sample reads 0 B.
  let tick = 0;
  const fake = fakeDocker({ exportFor: load, clockMs: 1_800_000, loadMs: 50, oomOnLoad: true });
  const zero = statsClient({ delayMs: 10, rows: (args) => Array.from({ length: 180 }, (_, i) => ({ ID: args.at(-1), Name: "x", CPUPerc: "1.00%", MemUsage: `${i === 179 ? "0B" : `${100 + i}MiB`} / 1GiB` })) });
  const s = await run(fake, options, folder("zero"), { spawnStats: zero.spawn, statsBounds: { now: () => fake.startIssuedMs + 10_000 * tick++ } });
  assert.equal(s.complete, true, JSON.stringify([s.failures, s.cells]));
  validateSoak(s);
  const [cell] = s.cells;
  assert.equal(cell.failure, undefined, "the cell keeps its observations");
  assert.deepEqual(cell.memory, { samples: 180, unavailable: "1 memory sample had no time or no positive size", startMiB: null, endMiB: null, growthMiB: null, growthPct: null });
  // Stopped and OOM-killed, not restarted: the covered stream shows no start after the exit.
  assert.deepEqual([cell.restarts.restarted, cell.restarts.runningAtEnd, cell.restarts.oomKilled], [false, false, true]);
  // A sampler that fails outright (its client holds its pipes past the bound): memory sampling
  // failed, and the same observations are still reported.
  const held = statsClient({ holds: true });
  const fake2 = fakeDocker({ exportFor: load, clockMs: 1_800_000, loadMs: 50, oomOnLoad: true });
  const s2 = await run(fake2, options, folder("held"), { spawnStats: held.spawn, statsBounds: { graceMs: 5, boundMs: 20 } });
  validateSoak(s2);
  assert.equal(s2.cells[0].memory.unavailable, "memory sampling failed");
  assert.deepEqual([s2.cells[0].restarts.runningAtEnd, s2.cells[0].restarts.oomKilled], [false, true]);
});

test("a soak cell whose k6 aggregate failures exceed every request outside its intervals is refused at capture", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["soak", "t8", "--apps", "corten", "--sources", "fixture", "--targets", "page"], apps, groupApps);
  // Three failures in k6's aggregate, none in an interval, and no request in the graceful-stop tail.
  const load = () => {
    const e = soakExport(), total = e.metrics.http_reqs.count;
    e.metrics.http_req_failed = { passes: 3, fails: total - 3, value: 3 / total };
    e.metrics.checks = { passes: 2 * total - 3, fails: 3, value: (2 * total - 3) / (2 * total) };
    e.root_group.checks["marketplace status 200"] = { passes: total - 3, fails: 3 };
    return e;
  };
  let tick = 0;
  const fake = fakeDocker({ exportFor: load, clockMs: 1_800_000, loadMs: 50 });
  const stats = statsClient({ delayMs: 10, rows: (args) => Array.from({ length: 180 }, () => ({ ID: args.at(-1), Name: "x", CPUPerc: "1.00%", MemUsage: "100MiB / 1GiB" })) });
  const s = await run(fake, options, folder("failed"), { spawnStats: stats.spawn, statsBounds: { now: () => fake.startIssuedMs + 10_000 * tick++ } });
  assert.equal(s.cells[0].failure, "load-evidence");
  assert.ok(errorsOf(folder("failed")).includes("corten fixture page: k6's aggregate failures are fewer than its windows' or more than its windows' plus the requests outside them"));
  assert.equal(s.cells[0].windows, undefined);
});

test("the memory sampler refuses names and settles at its bound when something holds its pipes", async (t) => {
  const folder = folderOf(t);
  const id = "a".repeat(64);
  assert.throws(() => memorySampler({ ids: [`${base}-corten`], file: folder("x.log"), seconds: 10, spawn: statsClient().spawn }), /immutable container IDs/);
  // A row keyed by anything but the sampled ID is an error, not a sample, and is counted, not quoted.
  const canary = "b".repeat(65);
  const named = statsClient({ rows: () => [{ ID: canary, CPUPerc: "1%", MemUsage: "1MiB / 1GiB" }, { ID: id, CPUPerc: "1%", MemUsage: `${canary} / 1GiB` }] });
  const sampler = memorySampler({ ids: [id], file: folder("named.log"), seconds: 10, spawn: named.spawn });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(sampler.stop(), (error) => {
    assert.equal(error.message, "1 docker stats row was not readable; 1 docker stats row named a container this pass does not sample");
    return true;
  });
  // A stand-in still holding the client's pipes after TERM and KILL: stop() settles at its bound.
  const held = statsClient({ rows: () => [{ ID: id, CPUPerc: "1%", MemUsage: "1MiB / 1GiB" }], holds: true });
  const stuck = memorySampler({ ids: [id], file: folder("held.log"), seconds: 10, spawn: held.spawn, graceMs: 10, boundMs: 60 });
  const started = Date.now();
  const stopped = stuck.stop();
  assert.equal(stuck.stop(), stopped, "a second stop() is the first one");
  await assert.rejects(stopped, /docker stats did not settle within 60 ms of stop; its pipes were released/);
  assert.ok(Date.now() - started < 2000);
  const { child } = held.spawned[0];
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  assert.ok(child.stdout.destroyed && child.stderr.destroyed && child.unrefed);
  assert.ok(existsSync(folder("held.log")), "what it read is kept");
  // An ordinary client that closes when signalled settles with its samples.
  const ok = statsClient({ rows: () => [{ ID: id, CPUPerc: "1%", MemUsage: "64MiB / 1GiB" }, { ID: id, CPUPerc: "2%", MemUsage: "65MiB / 1GiB" }] });
  const good = memorySampler({ ids: [id], file: folder("ok.log"), seconds: 10, spawn: ok.spawn });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const result = await good.stop();
  assert.deepEqual(result.samples[id].map((x) => x.mem), [64, 65]);
});

test("Docker's and k6's own output never reaches summary.json or cleanup.json; it stays in the raw errors.log", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t9", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  // Plausible but wrong: one hex digit too many, and a name-like token.
  const canary = "d".repeat(65), token = "leaked-canary-token";
  const saved = (dir) => readFileSync(join(dir, "summary.json"), "utf8") + readFileSync(join(dir, "cleanup.json"), "utf8");
  const clean = (dir) => { const text = saved(dir); assert.ok(!text.includes(canary) && !text.includes(token), text); };
  // A cold probe that exits 1 with untrusted output.
  const cold = fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args, state) => args[0] === "wait" ? "1" : args[0] === "logs" && args[1] === cold.ids[`${base}-corten-probe`]
    ? `catalog-probe-ready${state.calls.some((c) => c.args[0] === "wait") ? `\n${canary} ${token}` : ""}` : undefined });
  const a = await run(cold, options, folder("cold"));
  assert.equal(a.cells[0].failure, "cold-start");
  assert.ok(errorsOf(folder("cold")).includes("cold probe exited 1; its output is in cold.log"));
  clean(folder("cold"));
  // A k6 summary with a metric this load does not define, named by the canary.
  const k6 = await run(fakeDocker({ exportFor: () => { const e = k6Export(flat(8)); e.metrics[`${token}_${canary}`] = { count: 1, rate: 1 / 120 }; return e; } }), options, folder("metric"));
  assert.equal(k6.cells[0].failure, "load-evidence");
  assert.ok(errorsOf(folder("metric")).includes("the k6 summary export has 1 metric this load does not define"));
  clean(folder("metric"));
  // A removal that fails with Docker's own text after the first line: the record keeps the first line.
  const stuck = fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args, state) => args[0] === "rm" && args[3] === state.ids[`${base}-k6`] ? new Error(`docker rm -f: exit 1\n${canary} ${token}`) : undefined });
  const b = await run(stuck, options, folder("rm"));
  assert.equal(b.complete, false);
  assert.ok(cleanupOf(folder("rm")).failures.some((f) => f.error === "docker rm -f: exit 1"), JSON.stringify(cleanupOf(folder("rm")).failures));
  assert.ok(b.cleanup.failures > 0);
  clean(folder("rm"));
  assert.ok(readFileSync(join(folder("rm"), "errors.log"), "utf8").includes(canary), "the full error is kept raw");
  // An image inspect answering something that is not JSON: the JSON.parse excerpt is not saved.
  const odd = await run(fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args) => args[0] === "image" && args[2] === "cb-marketplace-corten" ? `${token} ${canary}` : undefined }), options, folder("json"));
  assert.deepEqual(odd.failures, [{ stage: "suite", code: "image" }]);
  assert.ok(errorsOf(folder("json")).includes("docker image inspect of cb-marketplace-corten is not JSON"));
  clean(folder("json"));
  assert.ok(readFileSync(join(folder("json"), "errors.log"), "utf8").includes(token));
});

test("summary.json keeps a value from Docker, the host or k6 only when it matches its saved pattern; the raw text stays in its own file", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t10", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  const token = "leaked-canary-token";
  const longCpu = `Synthetic ${"X".repeat(300)}`;
  // Docker's server version with a suffix outside its pattern, a host probe whose kernel, CPU model
  // and online CPUs carry text outside theirs, k6's version output with trailing text (the version
  // itself matches the pin), and an extra repository digest on the k6 image.
  const fake = fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args, state) => {
    if (args[0] === "version") return `27.5.1 <${token}>`;
    if (args[0] === "start" && args[1] === "-a" && args[2] === state.ids[`${base}-host`]) return `6.8.0-test ${token}\nmodel name\t: Synthetic <${token}>\n0-7;${token}`;
    if (args[0] === "start" && args[1] === "-a" && args[2] === state.ids[`${base}-k6-version`]) return `k6 v2.4.0 (commit/${token}, go1.24, linux/amd64)`;
    if (args[0] === "image" && args[2] === k6Image) return JSON.stringify([{ Id: k6ImageId, Os: "linux", Architecture: "amd64", RepoDigests: [k6Image, `example.com/${token}@sha256:${"e".repeat(64)}`] }]);
    return undefined;
  } });
  const s = await run(fake, options, folder("canary"));
  assert.equal(s.complete, true, JSON.stringify(s.failures));
  validateConvergence(s);
  // The CPU model is saved as its digest whatever its text; the text is never saved.
  assert.deepEqual([s.host.docker, s.host.kernel, s.host.cpuModelSha256, s.host.onlineCpus], [null, null, sha256(`Synthetic <${token}>`), null]);
  assert.deepEqual(s.tools.k6, { imageId: k6ImageId, version: "2.4.0" });
  const text = readFileSync(join(folder("canary"), "summary.json"), "utf8");
  assert.ok(!text.includes(token) && !text.includes("example.com"), text);
  // The raw files keep what Docker, the host and k6 said.
  assert.ok(readFileSync(join(folder("canary"), "docker-version.txt"), "utf8").includes(token));
  assert.ok(readFileSync(join(folder("canary"), "host.txt"), "utf8").includes(token));
  const k6 = readFileSync(join(folder("canary"), "k6.json"), "utf8");
  assert.ok(k6.includes(token) && k6.includes("example.com"));
  // A CPU model longer than cpuModelLimit is not recorded, and the report says so.
  const long = await run(fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args, state) =>
    args[0] === "start" && args[1] === "-a" && args[2] === state.ids[`${base}-host`] ? `6.8.0-test\nmodel name\t: ${longCpu}\n0-7` : undefined }), options, folder("long"));
  assert.deepEqual([long.host.kernel, long.host.cpuModelSha256, long.host.onlineCpus], ["6.8.0-test", null, "0-7"]);
  assert.match(steadyReport(long), /CPU model: not recorded \(online CPUs 0-7\)/);
  assert.ok(!readFileSync(join(folder("long"), "summary.json"), "utf8").includes("XXXX"));
});

test("an adapter or upstream image ID that is not a canonical Docker ID fails its step with a fixed code, and is not saved", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t11", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  const odd = `sha256:${"a".repeat(63)}g-leaked-canary`;
  const app = await run(fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args) => args[0] === "image" && args[2] === "cb-marketplace-corten"
    ? JSON.stringify([{ Id: odd, Size: 1, Config: { Labels: { "run.corten.marketplace.commit": commit, "run.corten.marketplace.dirty": "false" } }, RepoDigests: [] }]) : undefined }), options, folder("app"));
  assert.deepEqual([app.complete, app.failures, app.images], [false, [{ stage: "suite", code: "image" }], {}]);
  assert.ok(errorsOf(folder("app")).includes("an adapter image ID is not a value a pass saves"));
  assert.ok(!readFileSync(join(folder("app"), "summary.json"), "utf8").includes("leaked-canary"));
  assert.ok(readFileSync(join(folder("app"), "images.json"), "utf8").includes("leaked-canary"), "the receipt keeps it raw");
  // The upstream container reports an image that is not a canonical ID.
  const upstream = await run(fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args, state) => {
    const id = state.ids[`${base}-upstream`];
    if (args[0] === "start" && args[1] === id) state.containers.get(id).imageId = odd;
    return undefined;
  } }), options, folder("upstream"));
  assert.deepEqual([upstream.complete, upstream.failures, upstream.tools.upstream], [false, [{ stage: "suite", code: "tools" }], null]);
  assert.ok(!readFileSync(join(folder("upstream"), "summary.json"), "utf8").includes("leaked-canary"));
  // A k6 version with text in place of its patch number does not match the pin: a tools failure.
  const k6 = await run(fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args, state) =>
    args[0] === "start" && args[1] === "-a" && args[2] === state.ids[`${base}-k6-version`] ? "k6 v2.4.leaked-canary" : undefined }), options, folder("k6"));
  assert.deepEqual([k6.complete, k6.failures, k6.tools], [false, [{ stage: "suite", code: "tools" }], null]);
  assert.ok(!readFileSync(join(folder("k6"), "summary.json"), "utf8").includes("leaked-canary"));
});

test("a soak reads restarts from a live event stream only when it shows the marker's starts around the load; a stream with no app event and without them leaves the cell unconfirmed", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["soak", "t12", "--apps", "corten", "--sources", "fixture", "--targets", "page"], apps, groupApps);
  const soak = async (name, { drop, late, rewrite, spawnEvents, ...extra } = {}) => {
    let tick = 0;
    const fake = fakeDocker({ exportFor: () => soakExport(), clockMs: 1_800_000, loadMs: 50, ...extra });
    const client = eventsClient(fake, { drop, late, rewrite });
    const stats = statsClient({ delayMs: 10, rows: (args) => Array.from({ length: 180 }, () => ({ ID: args.at(-1), Name: "x", CPUPerc: "1.00%", MemUsage: "100MiB / 1GiB" })) });
    const s = await run(fake, options, folder(name), { spawnStats: stats.spawn, statsBounds: { now: () => fake.startIssuedMs + 10_000 * tick++ }, spawnEvents: spawnEvents ?? client.spawn });
    assert.equal(s.complete, true, JSON.stringify([s.failures, s.cells]));
    validateSoak(s);
    return { s, fake, client, r: s.cells[0].restarts ?? null };
  };
  // Covered and clean: the stream showed the marker's start before the load and again after the
  // app's last inspect, with no app event between. It is the live stream, never a --since replay.
  const clean = await soak("clean");
  assert.deepEqual([clean.r.eventStream, clean.r.events, clean.r.restarted], ["none-seen", [], false]);
  const app = clean.fake.ids[`${base}-corten`], marker = clean.fake.ids[`${base}-corten-marker`];
  const load = clean.fake.ids[`${base}-k6`];
  assert.deepEqual(clean.client.spawned.map((x) => x.args), [["events", "--filter", "type=container", "--filter", `container=${app}`, "--filter", `container=${marker}`, "--filter", `container=${load}`, "--format", eventFormat]]);
  // The load's own rows (attach, start, die, archive-path) are read and not kept.
  assert.ok(readFileSync(join(folder("clean"), "fixture", "corten", "page", "events.log"), "utf8").includes(`${load}|archive-path|`));
  assert.ok(!clean.fake.calls.some((c) => c.args[0] === "events"), "no retrospective docker events query");
  const at = (predicate) => clean.fake.calls.findIndex(predicate), last = (predicate) => clean.fake.calls.findLastIndex(predicate);
  const markerStarts = clean.fake.calls.flatMap((c, i) => (c.args[0] === "start" && c.args[1] === marker ? [i] : []));
  assert.equal(markerStarts.length, 2);
  assert.ok(markerStarts[0] < at((c) => c.args[0] === "start" && c.args[1] === "-a" && c.args[2] === clean.fake.ids[`${base}-k6`]), "the first marker start is before the load");
  // The app's snapshot after the load is its first inspect once k6's export has been copied out.
  const copied = last((c) => c.args[0] === "cp"), afterInspect = clean.fake.calls.findIndex((c, i) => i > copied && c.args[0] === "container" && c.args.at(-1) === app);
  assert.ok(afterInspect > copied && markerStarts[1] > afterInspect, "the second marker start is after the app's snapshot after the load");
  assert.ok(clean.fake.calls.some((c) => c.args[0] === "rm" && c.args.at(-1) === marker), "the marker is removed by its ID");
  // A kill during the load is seen. It is a signal (SIGCONT, say), not a restart: StartedAt and
  // RestartCount are unchanged and the app is still running, so it reads as a signal and Restarted: no.
  const seen = await soak("seen", { duringLoad: (state) => state.emit(state.app().id, "kill") });
  assert.deepEqual([seen.r.eventStream, seen.r.events.map((e) => e.action), seen.r.restarted, seen.r.runningAtEnd, seen.r.replaced, seen.r.restartCount], ["seen", ["kill"], false, true, false, 0]);
  assert.match(steadyReport(seen.s), /\| signal \(kill\) at \d+ s \| no \|$/m);
  // A die and then a start of the app stamped a millisecond later is a restart.
  const bounced = await soak("bounced", { duringLoad: (state) => { state.emit(state.app().id, "die"); state.offset += 1; state.emit(state.app().id, "start"); } });
  assert.deepEqual([bounced.r.events.map((e) => e.action), bounced.r.restarted], [["die", "start"], true]);
  assert.match(steadyReport(bounced.s), /\| exit \(die\) at \d+ s \| yes: start at \d+ s after an exit \|$/m);
  // Events are paired by their daemon times, not the order the stream delivered them: a start
  // delivered after a die but stamped at the same time, or earlier, is not a restart. The stream
  // bracketed the load and delivered both, so the soak reads them as observations and Restarted: no.
  // Each pair's times are fixed from one clock reading, so the same time is exactly the same.
  const stamped = (state, action, nanos) => { for (const listener of state.listeners) listener(state.app().id, action, String(nanos)); };
  const sameTime = await soak("same-time", { duringLoad: (state) => { const at = BigInt(state.now()) * 1_000_000n; stamped(state, "die", at); stamped(state, "start", at); } });
  const earlier = await soak("earlier", { duringLoad: (state) => { const at = BigInt(state.now()) * 1_000_000n; stamped(state, "die", at); stamped(state, "start", at - 5_000_000n); } });
  for (const [name, { r, s }] of [["same-time", sameTime], ["earlier", earlier]]) {
    assert.deepEqual([r.eventStream, r.events.map((e) => e.action), r.restarted, r.restartCount, r.replaced], ["seen", ["die", "start"], false, 0, false], name);
    assert.match(steadyReport(s), /\| exit \(die\) at \d+ s, start at \d+ s \| no \|$/m, name);
  }
  // An app row naming a restart-relevant event with detail after it is not that event: `restart: x`
  // is not a restart, so the whole stream is unreadable and the cell has no reading.
  const detailed = await soak("detailed", { duringLoad: (state) => state.emit(state.app().id, "restart: leaked canary") });
  assert.equal(detailed.s.cells[0].failure, "unconfirmed");
  assert.match(errorsOf(folder("detailed")), /1 docker events row is not this cell's app, load, upstream or marker, an action and a time/);
  assert.ok(!readFileSync(join(folder("detailed"), "summary.json"), "utf8").includes("canary"));
  // A kill stamped a second before the load finished, delivered in a later chunk than the marker's
  // second start: the runner reads on to the fence, the marker's exit after that start, so it is
  // still seen (stopping at that start, as the runner once did, read the stream as clean).
  const inLoad = (state) => { const nanos = String(BigInt(state.now() - 1000) * 1_000_000n); for (const listener of state.listeners) listener(state.app().id, "kill", nanos); };
  const delayed = await soak("delayed", { duringLoad: inLoad, late: (row) => row.includes("|kill|") });
  assert.deepEqual([delayed.r.eventStream, delayed.r.events.map((e) => e.action), delayed.r.restarted], ["seen", ["kill"], false]);
  const delivered = readFileSync(join(folder("delayed"), "fixture", "corten", "page", "events.log"), "utf8").split("\n");
  assert.ok(delivered.findIndex((r) => r.includes("|kill|")) > delivered.findLastIndex((r) => r.includes("|start|")), "the kill was delivered after the marker's second start");
  // Streams that look clean (no app event at all) but do not show coverage: nothing delivered, the
  // first marker start missed (listening only after the load began), or the second one missing. Each
  // leaves the cell unconfirmed, with no reading; the first two before any load starts.
  // The marker's starts: the first start row the client writes is the marker's (the app started
  // before the stream, and the load starts after the marker), so its ID is the marker's.
  const markerStart = (n) => { let starts = 0, id = null; return (row) => { const [rowId, action] = row.split("|"); if (action !== "start") return false; id ??= rowId; return rowId === id && ++starts === n; }; };
  for (const [name, drop, loads] of [["silent", () => true, false], ["late", markerStart(1), false], ["no-end", markerStart(2), true], ["no-fence", (row) => row.includes("|die|"), true]]) {
    const { s, fake } = await soak(name, { drop });
    assert.equal(s.cells[0].failure, "unconfirmed", name);
    assert.match(steadyReport(s), /\| no reading: the cell failed \(Docker's event stream for the cell could not be read, or did not show a marker container's starts before and after the load/, name);
    assert.equal(fake.calls.some((c) => loadStarted(c.args, fake)), loads, `${name}: whether the load ran`);
  }
  // The runner waits for each marker start (readEvents also refuses a saved stream without both).
  assert.match(errorsOf(folder("silent")), /docker events did not show the marker's start 1 within 200 ms/);
  assert.match(errorsOf(folder("late")), /docker events did not show the marker's start 1 within 200 ms/);
  assert.match(errorsOf(folder("no-end")), /docker events: Error: docker events did not show the marker's start 2 within 200 ms/);
  // Both marker starts but no row after the second: the stream is not read as clean.
  assert.match(errorsOf(folder("no-fence")), /docker events: Error: docker events did not show the marker's exit after its second start within 200 ms/);
  // The fence is the second start's own exit, stamped later than that start. A kill during the load,
  // delivered in a later chunk than the marker's second start and the row right after it, where that
  // row is a copy of the second start (its real exit comes after the kill) or a die stamped after the
  // load finished but before that start (with no real exit): neither is the fence, so the runner does
  // not stop there and the reader does not take it for one. Taking either for the fence stopped the
  // stream before the kill and read the soak as clean; the cell has no reading.
  const secondStart = () => markerStart(2);
  const copiedStart = () => { const second = secondStart(); return (row) => (second(row) ? [row, row] : [row]); };
  const earlyDie = () => {
    const second = secondStart();
    let after = false;
    return (row) => {
      const [id, action, nanos] = row.split("|");
      if (second(row)) { after = true; return [row, `${id}|die|${BigInt(nanos) - 1n}`]; }
      return after && action === "die" ? [] : [row];
    };
  };
  for (const [name, rewrite] of [["copied-start", copiedStart()], ["early-die", earlyDie()]]) {
    const { s } = await soak(name, { duringLoad: inLoad, late: (row) => row.includes("|kill|"), rewrite });
    assert.equal(s.cells[0].failure, "unconfirmed", name);
    assert.match(errorsOf(folder(name)), /docker events: Error: docker events showed a marker row after its second start that is not that start's exit stamped later than it/, name);
  }
  // A row that is not an action and a time makes the whole stream unavailable, and is not saved.
  const odd = await soak("malformed", { duringLoad: (state) => state.emit(state.app().id, "Leaked Canary") });
  assert.equal(odd.s.cells[0].failure, "unconfirmed");
  assert.match(errorsOf(folder("malformed")), /1 docker events row is not this cell's app, load, upstream or marker, an action and a time/);
  assert.ok(!readFileSync(join(folder("malformed"), "summary.json"), "utf8").includes("Canary"));
  // The same unreadable stream with the app OOM-killed: no reading either, whatever the inspect shows.
  const oom = await soak("oom", { oomOnLoad: true, duringLoad: (state) => state.emit(state.app().id, "Leaked Canary") });
  assert.equal(oom.s.cells[0].failure, "unconfirmed");
  // A covered stream shows the OOM and the die as events, and no start after them: no restart.
  const oomSeen = await soak("oom-seen", { oomOnLoad: true });
  assert.deepEqual([oomSeen.r.eventStream, oomSeen.r.events.map((e) => e.action), oomSeen.r.restarted], ["seen", ["oom", "die"], false]);
  // A client that cannot run at all.
  const broken = () => { const child = new EventEmitter(); Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill() { return true; } }); setImmediate(() => { child.emit("error", Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" })); child.emit("close", -2); }); return child; };
  const failed = await soak("failed", { spawnEvents: broken });
  assert.equal(failed.s.cells[0].failure, "unconfirmed");
});

test("a soak's app snapshots must be valid and running before they are compared, and keep RestartCount raw", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["soak", "t13", "--apps", "corten", "--sources", "fixture", "--targets", "page"], apps, groupApps);
  let tick = 0;
  const stats = statsClient({ delayMs: 10, rows: (args) => Array.from({ length: 180 }, () => ({ ID: args.at(-1), Name: "x", CPUPerc: "1.00%", MemUsage: "100MiB / 1GiB" })) });
  const fake = fakeDocker({ exportFor: () => soakExport(), clockMs: 1_800_000, loadMs: 50, inspected: (info, c) => (c.kind === "app" ? (({ RestartCount, ...rest }) => rest)(info) : info) });
  const s = await run(fake, options, folder("no-count"), { spawnStats: stats.spawn, statsBounds: { now: () => fake.startIssuedMs + 10_000 * tick++ } });
  assert.equal(s.cells[0].failure, "container");
  assert.match(errorsOf(folder("no-count")), /the app's instance before the load is not recorded as a container ID, a StartedAt time, a RestartCount and its running and OOM states/);
  assert.ok(!fake.calls.some((c) => c.args[0] === "create" && c.args[2] === `${base}-k6`), "no load ran");
  // A valid pass keeps RestartCount in both raw snapshots.
  tick = 0;
  const ok = fakeDocker({ exportFor: () => soakExport(), clockMs: 1_800_000, loadMs: 50 });
  const good = await run(ok, options, folder("ok"), { spawnStats: stats.spawn, statsBounds: { now: () => ok.startIssuedMs + 10_000 * tick++ } });
  assert.equal(good.complete, true, JSON.stringify(good.failures));
  for (const file of ["app-container.json", "app-container-after.json"]) assert.equal(JSON.parse(readFileSync(join(folder("ok"), "fixture", "corten", "page", file), "utf8")).restartCount, 0, file);
});

test("a convergence cell whose app snapshots lack RestartCount, or carry the same malformed StartedAt, or were not running before the load, gets no reading", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t14", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  // Only the snapshots taken after the cold start (its probe gone): before and after the load.
  const afterColdStart = (state) => state.ids[`${base}-corten-probe`] && ![...state.containers.values()].some((c) => c.kind === "probe");
  const cases = [
    ["no-count", (info) => (({ RestartCount, ...rest }) => rest)(info), "container", /the app's instance before the load is not recorded/],
    ["bad-time", (info) => ({ ...info, State: { ...info.State, StartedAt: "not-a-time" } }), "container", /the app's instance before the load is not recorded/],
    ["zero-time", (info) => ({ ...info, State: { ...info.State, StartedAt: "0001-01-01T00:00:00Z" } }), "container", /the app's instance before the load is not recorded/],
    ["not-running", (info) => ({ ...info, State: { ...info.State, Running: false } }), "cold-start", /the app was not running, or was OOM-killed, before the load/],
  ];
  for (const [name, change, code, message] of cases) {
    const s = await run(fakeDocker({ exportFor: () => k6Export(flat(8)), inspected: (info, c, state) => (c.kind === "app" && afterColdStart(state) ? change(info) : info) }), options, folder(name));
    assert.deepEqual([s.cells[0].failure, s.cells[0].verdict], [code, null], name);
    assert.match(errorsOf(folder(name)), message, name);
  }
  // A snapshot after the load that lacks RestartCount is refused too, though the one before had it.
  let inspects = 0;
  const late = await run(fakeDocker({ exportFor: () => k6Export(flat(8)), inspected: (info, c, state) => (c.kind === "app" && afterColdStart(state) && state.calls.some((x) => x.args[0] === "cp") && ++inspects ? (({ RestartCount, ...rest }) => rest)(info) : info) }), options, folder("after"));
  assert.deepEqual([late.cells[0].failure, late.cells[0].verdict], ["instance-changed", null]);
  assert.match(errorsOf(folder("after")), /the app's instance after the load is not recorded/);
});

test("the event stream settles at its bound when something holds its pipes, and waits for a marker only so long", async (t) => {
  const folder = folderOf(t);
  const app = "a".repeat(64), marker = "b".repeat(64);
  assert.throws(() => eventStream({ app: `${base}-corten`, marker, file: folder("x.log"), spawn: statsClient().spawn }), /immutable container IDs/);
  const fake = { listeners: [] };
  const held = eventsClient(fake, { holds: true });
  const stream = eventStream({ app, marker, file: folder("held.log"), spawn: held.spawn, markerMs: 20, graceMs: 10, boundMs: 60 });
  await assert.rejects(stream.marker(1), /did not show the marker's start 1 within 20 ms/);
  fake.listeners[0](marker, "start", "1");
  await stream.marker(1);
  const started = Date.now();
  const stopped = stream.stop();
  assert.equal(stream.stop(), stopped, "a second stop() is the first one");
  await assert.rejects(stopped, /docker events did not settle within 60 ms of stop; its pipes were released/);
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(held.spawned[0].child.kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(readFileSync(folder("held.log"), "utf8"), `${marker}|start|1\n`, "what it read is kept");
  // An ordinary client returns what it read.
  const plain = { listeners: [] }, ok = eventsClient(plain);
  const good = eventStream({ app, marker, file: folder("ok.log"), spawn: ok.spawn });
  plain.listeners[0](app, "kill", "2"); plain.listeners[0](marker, "start", "3");
  await good.marker(1);
  assert.equal(await good.stop(), `${app}|kill|2\n${marker}|start|3\n`);
});

test("the live watcher counts a marker start or exit only by the reader's exact action, never one with detail", async (t) => {
  const folder = folderOf(t);
  const app = "a".repeat(64), marker = "b".repeat(64);
  // Two starts with detail: neither is a start, so the watcher never sees the first.
  const detail = { listeners: [] }, client = eventsClient(detail);
  const stream = eventStream({ app, marker, file: folder("detail.log"), spawn: client.spawn, markerMs: 30, graceMs: 5, boundMs: 50 });
  detail.listeners[0](marker, "start: canary", "1"); detail.listeners[0](marker, "start: canary", "2"); detail.listeners[0](marker, "die", "3");
  await assert.rejects(stream.marker(1), /did not show the marker's start 1 within 30 ms/);
  await stream.stop();
  // Two real starts, then a die with detail: that is not the fence.
  const fenced = { listeners: [] }, other = eventsClient(fenced);
  const second = eventStream({ app, marker, file: folder("fence.log"), spawn: other.spawn, markerMs: 30, graceMs: 5, boundMs: 50 });
  fenced.listeners[0](marker, "start", "1"); fenced.listeners[0](marker, "start", "2"); fenced.listeners[0](marker, "die: canary", "3");
  await second.marker(2);
  await assert.rejects(second.fence(), /not that start's exit stamped later than it/);
  await second.stop();
});

// A client that writes each of `chunks` as it is, one per turn, from the moment it starts, and
// closes when signalled.
function rawClient(chunks) {
  const spawned = [];
  const spawn = (binary, args) => {
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kills: [], unref() { child.unrefed = true; } });
    child.kill = (signal = "SIGTERM") => {
      child.kills.push(signal);
      if (!child.ended) { child.ended = true; child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit("close", null)); }
      return true;
    };
    let index = 0;
    const next = () => { if (child.ended || index >= chunks.length) return; child.stdout.write(chunks[index++]); setImmediate(next); };
    setImmediate(next);
    spawned.push({ binary, args, child });
    return child;
  };
  return { spawn, spawned };
}
const settledTurns = () => new Promise((resolve) => setTimeout(resolve, 30));

test("a stats or events client's output past its limits makes that observation unavailable at once and stops the client through its bounded stop", async (t) => {
  const folder = folderOf(t);
  const app = "a".repeat(64), marker = "b".repeat(64);
  const row = JSON.stringify({ ID: app, Name: "x", CPUPerc: "1.00%", MemUsage: "100MiB / 1GiB" });
  // A grace long enough that the fake client's close, not KILL, follows the TERM it stopped itself with.
  const bounds = { graceMs: 1000, boundMs: 2000 };
  // stats: one unterminated row longer than a row may be, more bytes than it may write, and more rows.
  const cases = [
    ["line", ["x".repeat(5000)], { line: 1024 }, /^docker stats wrote a row longer than 1024 bytes, so its memory samples are unavailable$/],
    ["bytes", [`${row}\n`, "y".repeat(4096), "z".repeat(4096)], { bytes: 6000 }, /^docker stats wrote more than 6000 bytes, so its memory samples are unavailable$/],
    ["rows", Array(5).fill(`${row}\n`), { rows: 2 }, /^docker stats wrote more than 2 rows, so its memory samples are unavailable$/],
  ];
  for (const [name, chunks, limits, message] of cases) {
    const client = rawClient(chunks);
    const sampler = memorySampler({ ids: [app], file: folder(`${name}.log`), seconds: 5, spawn: client.spawn, ...bounds, limits: { ...clientLimits.stats, ...limits } });
    await settledTurns();
    // It stopped its client itself, before anything asked it to.
    assert.deepEqual(client.spawned[0].child.kills, ["SIGTERM"], name);
    await assert.rejects(sampler.stop(), (error) => { assert.deepEqual(error.errors.map((e) => message.test(e)), [true], `${name}: ${error.message}`); return true; });
    assert.ok(readFileSync(folder(`${name}.log`)).length <= (limits.bytes ?? 8192), `${name}: what it kept is bounded`);
  }
  // stderr past its limit is not kept.
  const noisy = rawClient([]);
  const quietSampler = memorySampler({ ids: [app], file: folder("stderr.log"), seconds: 5, spawn: noisy.spawn, ...bounds, limits: { ...clientLimits.stats, stderr: 16 } });
  noisy.spawned[0].child.stderr.write("e".repeat(1000));
  await settledTurns();
  await assert.rejects(quietSampler.stop(), /docker stats wrote to stderr/);
  assert.equal(readFileSync(folder("stderr.log.stderr"), "utf8"), `${"e".repeat(16)}\n[stderr past its first 16 bytes was not kept]\n`);
  // events: an unterminated row longer than a row may be fails the marker wait at once (not at its
  // markerMs) and the stream is unavailable.
  const events = rawClient([`${marker}|start|1\n`, "q".repeat(5000)]);
  const stream = eventStream({ app, marker, file: folder("events.log"), spawn: events.spawn, markerMs: 10_000, ...bounds, limits: { ...clientLimits.events, line: 1024 } });
  await stream.marker(1);
  const started = Date.now();
  await assert.rejects(stream.marker(2), /^Error: docker events wrote a row longer than 1024 bytes$/);
  assert.ok(Date.now() - started < 2000, "not left waiting for its markerMs");
  assert.deepEqual(events.spawned[0].child.kills, ["SIGTERM"]);
  await assert.rejects(stream.stop(), (error) => { assert.deepEqual(error.errors, ["docker events wrote a row longer than 1024 bytes, so the stream is unavailable"]); return true; });
  for (const [name, chunks, limits] of [["rows", Array(4).fill(`${marker}|start|1\n`), { rows: 3 }], ["bytes", [`${marker}|start|1\n`, "w".repeat(3000), "w".repeat(3000)], { bytes: 4000 }]]) {
    const client = rawClient(chunks);
    const s = eventStream({ app, marker, file: folder(`events-${name}.log`), spawn: client.spawn, markerMs: 10_000, ...bounds, limits: { ...clientLimits.events, ...limits } });
    await settledTurns();
    assert.deepEqual(client.spawned[0].child.kills, ["SIGTERM"], name);
    await assert.rejects(s.stop(), new RegExp(`docker events wrote more than ${limits.rows ?? limits.bytes} ${limits.rows ? "rows" : "bytes"}, so the stream is unavailable`), name);
  }
});

test("a soak whose stats or events client overflows keeps its other observations, and its owned resources are still removed", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["soak", "t16", "--apps", "corten", "--sources", "fixture", "--targets", "page"], apps, groupApps);
  const lineBound = (limits) => ({ graceMs: 5, boundMs: 50, limits: { ...limits, line: 1024 } });
  // Stats overflow: the memory samples are unavailable, the stream still covers the load.
  const stats = fakeDocker({ exportFor: () => soakExport(), clockMs: 1_800_000, loadMs: 50 });
  const s = await run(stats, options, folder("stats"), { spawnStats: rawClient(["s".repeat(5000)]).spawn, statsBounds: lineBound(clientLimits.stats) });
  assert.equal(s.complete, true, JSON.stringify([s.failures, s.cells]));
  validateSoak(s);
  const [cell] = s.cells;
  assert.deepEqual(["failure" in cell, cell.memory.unavailable, cell.restarts.eventStream, cell.restarts.restarted], [false, "memory sampling failed", "none-seen", false]);
  assert.match(errorsOf(folder("stats")), /docker stats wrote a row longer than 1024 bytes, so its memory samples are unavailable/);
  assert.ok(!readFileSync(join(folder("stats"), "summary.json"), "utf8").includes("ssss"));
  assert.equal(s.cleanup.complete, true);
  assert.equal(stats.containers.size, 0);
  // Events overflow after the marker's first start: the stream is unavailable, so the cell
  // has no reading, and what overflowed is not kept in the summary.
  const events = fakeDocker({ exportFor: () => soakExport(), clockMs: 1_800_000, loadMs: 50 });
  let overflowed = false;
  const client = eventsClient(events, { rewrite: (row) => (!overflowed && row.includes("|die|") ? (overflowed = true, [row, "e".repeat(5000)]) : [row]) });
  const e = await run(events, options, folder("events"), { spawnEvents: client.spawn, eventBounds: { markerMs: 200, ...lineBound(clientLimits.events) } });
  assert.equal(e.complete, true, JSON.stringify([e.failures, e.cells]));
  validateSoak(e);
  assert.equal(e.cells[0].failure, "unconfirmed", JSON.stringify(e.cells[0]));
  assert.match(errorsOf(folder("events")), /docker events wrote a row longer than 1024 bytes/);
  assert.ok(!readFileSync(join(folder("events"), "summary.json"), "utf8").includes("eeee"));
  assert.equal(e.cleanup.complete, true);
  assert.equal(events.containers.size, 0);
});

test("every container mounts a private copy of the verified fixture, so editing the original during a pass cannot change a later cell", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t17", "--apps", "corten,aspnet", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  const original = folder("original.json"), verified = Buffer.from(JSON.stringify({ item_1: { id: "item_1" } }));
  const suffix = ":/fixtures:ro";
  // Each create that mounts /fixtures: its name, the mount's source and the hash of the bytes it
  // would serve. Once the upstream is created, after setup, the original changes on every create.
  const pass = async (name, change) => {
    writeFileSync(original, verified);
    const mounted = [];
    const fake = fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args) => {
      const spec = args[0] === "create" ? args.find((a) => a.endsWith(suffix)) : undefined;
      if (spec) {
        const source = spec.slice(0, -suffix.length);
        mounted.push({ name: args[2], source, sha: sha256(readFileSync(join(source, "marketplace.json"))) });
        change(mounted.length);
      }
      return undefined;
    } });
    const s = await run(fake, options, folder(name), { fixtureFile: original, fixture: sha256 });
    return { s, mounted, fake };
  };
  const { s, mounted, fake } = await pass("edited", (n) => writeFileSync(original, JSON.stringify({ item_1: { id: `changed-${n}` } })));
  assert.equal(s.complete, true, JSON.stringify([s.failures, s.cells]));
  assert.equal(s.fixtureSha256, sha256(verified));
  assert.deepEqual(mounted.map((m) => m.name), [`${base}-upstream`, `${base}-corten`, `${base}-aspnet`]);
  for (const m of mounted) assert.deepEqual([m.source, m.sha], [join(folder("edited"), "mounted-fixture"), s.fixtureSha256], m.name);
  assert.notEqual(sha256(readFileSync(original)), s.fixtureSha256, "the original did change during the pass");
  assert.ok(!existsSync(join(folder("edited"), "mounted-fixture")), "the copy is removed at teardown");
  assert.equal(fake.containers.size, 0);
  // The copy itself changed during the pass: the pass is not complete.
  const copy = await pass("copy", (n) => { if (n === 2) writeFileSync(join(folder("copy"), "mounted-fixture", "marketplace.json"), "{}"); });
  assert.deepEqual([copy.s.complete, copy.s.failures], [false, [{ stage: "suite", code: "fixture" }]]);
  assert.match(errorsOf(folder("copy")), /the mounted fixture copy changed during the pass/);
  assert.ok(!existsSync(join(folder("copy"), "mounted-fixture")));
  // A missing original fails before any container.
  rmSync(original);
  const missingDocker = fakeDocker({ exportFor: () => k6Export(flat(8)) });
  const missing = await run(missingDocker, options, folder("missing"), { fixtureFile: original, fixture: undefined });
  assert.deepEqual([missing.complete, missing.failures], [false, [{ stage: "suite", code: "fixture" }]]);
  assert.match(errorsOf(folder("missing")), /the marketplace fixture is missing/);
  assert.ok(!missingDocker.calls.some((c) => c.args[0] === "create"), "no container was created");
});

// An adapter may run as another user (Gin runs as nobody) and a read-only bind keeps the copy's
// modes, so the copy is readable by anyone however private the workstation's umask is. Windows has
// no such modes, so this runs on Linux only, as the other umask cases do.
test("the mounted fixture copy is readable by another user under umask 077", { skip: process.platform === "win32" }, async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t24", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  const suffix = ":/fixtures:ro";
  const modes = [];
  const fake = fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args) => {
    const spec = args[0] === "create" ? args.find((a) => a.endsWith(suffix)) : undefined;
    if (spec) {
      const source = spec.slice(0, -suffix.length);
      modes.push([statSync(source).mode & 0o777, statSync(join(source, "marketplace.json")).mode & 0o777]);
    }
    return undefined;
  } });
  const previous = process.umask(0o077);
  let s;
  try { s = await run(fake, options, folder("private")); } finally { process.umask(previous); }
  assert.equal(s.complete, true, JSON.stringify([s.failures, s.cells]));
  assert.ok(modes.length > 0, "a container mounted the copy");
  for (const [directory, file] of modes) assert.deepEqual([directory.toString(8), file.toString(8)], ["711", "644"]);
});

test("a container log through the CLI's runner goes straight to its file with stderr as well as stdout and is never read back; every other command reaches Catalog's runner unchanged", async (t) => {
  const { command } = commandRunner({ cwd: process.cwd() });
  const script = ["-e", "process.stdout.write('out-line\\n'); process.stderr.write('err-line\\n')"];
  // Catalog's runner itself returns only stdout on success, whatever option it is given.
  assert.equal(await command(process.execPath, script, { combined: true, timeout: 20_000 }), "out-line");
  const tmp = mkdtempSync(join(tmpdir(), "steady-combined-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const runner = combinedRunner(command, process.execPath);
  const file = join(tmp, "app.log");
  assert.equal(await runner(script, { combined: true, cleanup: true, timeout: 20_000, file }), "", "nothing is read back");
  const both = readFileSync(file, "utf8");
  assert.ok(both.includes("out-line\n") && both.includes("err-line\n"), JSON.stringify(both));
  // A log several MiB long reaches its file whole and is still not returned.
  const big = join(tmp, "big.log");
  assert.equal(await runner(["-e", "process.stdout.write('x'.repeat(3 * 2 ** 20)); process.stderr.write('tail')"], { combined: true, timeout: 20_000, file: big }), "");
  assert.equal(statSync(big).size, 3 * 2 ** 20 + 4);
  // A combined log with nowhere to go is refused before anything runs.
  await assert.rejects(runner(script, { combined: true, timeout: 20_000 }), /a combined container log is written to its own file, never read back/);
  // combined: false is the container's stdout alone.
  assert.equal(await runner(script, { combined: false, timeout: 20_000 }), "out-line");
  assert.equal(await runner(script, { timeout: 20_000 }), "out-line");
  const calls = [];
  const recorded = combinedRunner(async (binary, args, options) => { calls.push([binary, args, options]); return "ok"; });
  await recorded(["ps", "-q"], { timeout: 5, cleanup: true, file: "load.log" });
  await recorded(["logs", "x"], { combined: true, timeout: 5, file: "app.log" });
  assert.deepEqual(calls, [["docker", ["ps", "-q"], { timeout: 5, cleanup: true, file: "load.log" }], ["docker", ["logs", "x"], { timeout: 5, file: "app.log", capture: false }]]);
});

test("the cold probe's readiness and result come from its stdout alone, bounded and validated; its stderr stays in cold.log", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t18", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  // A JSON diagnostic on stderr naming a first 200 a minute late: it is not the result.
  const late = JSON.stringify({ first200At: "2099-01-01T00:00:00.000Z", successfulRequestMs: 1, bytes: 1, attempts: 1, path: "/marketplace/en-US/item_1" });
  const fake = fakeDocker({ exportFor: () => k6Export(flat(8)), probeStderr: `${late}\n` });
  const s = await run(fake, options, folder("stderr"));
  assert.equal(s.complete, true, JSON.stringify([s.failures, s.cells]));
  const raw = join(folder("stderr"), "fixture", "corten", "page");
  assert.equal(JSON.parse(readFileSync(join(raw, "cold.json"), "utf8")).first200MsFromContainerStart, 5);
  assert.ok(readFileSync(join(raw, "cold.log"), "utf8").includes(late), "both streams are in cold.log");
  assert.equal(readFileSync(join(raw, "app.log"), "utf8"), "app log\n");
  // Every log is written to its own file; none is read back from the runner. The probe's stdout
  // alone goes to cold-stdout.log, which holds the probe's two lines and nothing of its stderr.
  for (const c of fake.calls.filter((x) => x.args[0] === "logs")) assert.ok(typeof c.file === "string", JSON.stringify(c));
  assert.ok(readFileSync(join(raw, "cold-stdout.log"), "utf8").startsWith("catalog-probe-ready\n{"), "the probe's stdout");
  assert.ok(!readFileSync(join(raw, "cold-stdout.log"), "utf8").includes(late), "no stderr in the stdout file");
  // A result line with an extra field, the wrong path or no attempts, or more stdout than the
  // bound, fails the cold start; the raw output is still in cold.log.
  const result = (extra) => JSON.stringify({ first200At: new Date().toISOString(), successfulRequestMs: 1, bytes: 1, attempts: 1, path: "/marketplace/en-US/item_1", ...extra });
  const cases = [["extra", result({ note: 1 })], ["path", result({ path: "/other" })], ["attempts", result({ attempts: 0 })], ["long", "x".repeat(coldOutputBytes)]];
  for (const [name, line] of cases) {
    const bad = fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args, state) => args[0] === "logs" && args[1] === state.ids[`${base}-corten-probe`]
      ? `catalog-probe-ready\n${state.calls.some((c) => c.args[0] === "wait") ? `${line}\n` : ""}` : undefined });
    const b = await run(bad, options, folder(name));
    assert.deepEqual([b.cells[0].failure, b.cells[0].verdict], ["cold-start", null], name);
    assert.ok(existsSync(join(folder(name), "fixture", "corten", "page", "cold.log")), name);
  }
  assert.match(errorsOf(folder("long")), new RegExp(`the cold probe wrote more than ${coldOutputBytes} bytes to stdout`));
  // The parser on its own.
  assert.equal(coldOutput("", "/p"), null);
  assert.equal(coldOutput("catalog-probe-ready", "/p"), true);
  assert.throws(() => coldOutput("noise", "/p"), /not its readiness line/);
  assert.throws(() => coldOutput("catalog-probe-ready\n{}\n{}", "/p"), /not one readiness line and one result line/);
  // Exactly the probe's lines: one newline after each, the last perhaps not yet, and the result
  // exactly as JSON.stringify writes it.
  const line = JSON.stringify({ first200At: "2026-11-25T00:00:00.000Z", successfulRequestMs: 1.5, bytes: 10, attempts: 2, path: "/p" });
  assert.equal(coldOutput("catalog-probe-ready\n", "/p"), true);
  assert.equal(coldOutput(`catalog-probe-ready\n${line}\n`, "/p").bytes, 10);
  assert.equal(coldOutput(`catalog-probe-ready\n${line}`, "/p").bytes, 10);
  for (const text of [`catalog-probe-ready\n${line}\n\n`, `catalog-probe-ready\n${line}   `, `catalog-probe-ready\n ${line}`, `\ncatalog-probe-ready\n${line}`, "catalog-probe-ready\n\n", "\n", `catalog-probe-ready\r\n${line}`])
    assert.throws(() => coldOutput(text, "/p"), /cold probe/, JSON.stringify(text));
});

test("the cold probe's stdout is read from its file as the probe wrote it, not as commandRunner trims or tails it", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t21", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  // Between the runner and the fake daemon, Catalog's own command output (commandOutput), as
  // commandRunner puts it there: a docker logs call's file and return value are what commandRunner
  // would give, including its trimmed stdout.
  const throughOutput = (fake) => combinedRunner(async (binary, args, opts = {}) => {
    if (args[0] !== "logs") return fake.docker(args, opts);
    const stdout = await fake.docker(args, { combined: false });
    const output = commandOutput({ file: opts.file, capture: opts.capture ?? true, fileStderr: opts.fileStderr ?? true });
    try { output.stdout(Buffer.from(stdout)); } finally { output.close(); }
    return output.result();
  });
  const probeSays = (tail) => (args, state) => {
    if (args[0] !== "logs" || args[1] !== state.ids[`${base}-corten-probe`]) return undefined;
    const app = state.app();
    if (!state.calls.some((c) => c.args[0] === "wait")) return "catalog-probe-ready\n";
    return `catalog-probe-ready\n${JSON.stringify({ first200At: new Date(Date.parse(app.state.StartedAt) + 5).toISOString(), successfulRequestMs: 1.5, bytes: 10, attempts: 2, path: "/marketplace/en-US/item_1" })}${tail}`;
  };
  // The probe's own output, one newline after each line: the cold start is read.
  const good = fakeDocker({ exportFor: () => k6Export(flat(8)), override: probeSays("\n") });
  const g = await run({ ...good, docker: throughOutput(good) }, options, folder("good"));
  assert.equal(g.complete, true, JSON.stringify([g.failures, g.cells]));
  // A valid result followed by 5,000 spaces (past the bound), by blank lines, or by padding within
  // the bound: commandRunner's trimmed stdout reads as the probe's lines, the file does not.
  for (const [name, tail] of [["spaces", " ".repeat(5000)], ["blank", "\n\n\n"], ["padding", "   \n"]]) {
    const bad = fakeDocker({ exportFor: () => k6Export(flat(8)), override: probeSays(tail) });
    const b = await run({ ...bad, docker: throughOutput(bad) }, options, folder(name));
    assert.deepEqual([b.cells[0].failure, b.cells[0].verdict], ["cold-start", null], name);
    assert.ok(!existsSync(join(folder(name), "fixture", "corten", "page", "cold.json")), name);
  }
  assert.match(errorsOf(folder("spaces")), new RegExp(`the cold probe wrote more than ${coldOutputBytes} bytes to stdout`));
  assert.match(errorsOf(folder("blank")), /the cold probe's stdout is not one readiness line and one result line/);
  assert.match(errorsOf(folder("padding")), /the cold probe's result line is not first200At/);
  // readBounded reads the bound and refuses a byte more.
  writeFileSync(join(folder("good"), "bounded"), "x".repeat(coldOutputBytes));
  assert.equal(readBounded(join(folder("good"), "bounded"), coldOutputBytes, "too long").length, coldOutputBytes);
  appendFileSync(join(folder("good"), "bounded"), "x");
  assert.throws(() => readBounded(join(folder("good"), "bounded"), coldOutputBytes, "too long"), /too long/);
});

test("a cold start with an empty first 200 fails as the timed validator fails it, even with a healthy load after it", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t22", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  const empty = fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args, state) => {
    if (args[0] !== "logs" || args[1] !== state.ids[`${base}-corten-probe`]) return undefined;
    if (!state.calls.some((c) => c.args[0] === "wait")) return "catalog-probe-ready\n";
    return `catalog-probe-ready\n${JSON.stringify({ first200At: new Date(Date.parse(state.app().state.StartedAt) + 5).toISOString(), successfulRequestMs: 1.5, bytes: 0, attempts: 2, path: "/marketplace/en-US/item_1" })}\n`;
  } });
  const s = await run(empty, options, folder("empty"));
  assert.deepEqual([s.cells[0].failure, s.cells[0].verdict], ["cold-start", null]);
  assert.ok(!existsSync(join(folder("empty"), "fixture", "corten", "page", "cold.json")));
  assert.ok(errorsOf(folder("empty")).includes("the cold probe's result is not a cold start a timed round accepts (validateColdStart); its output is in cold.log"));
  assert.ok(!empty.calls.some((c) => c.args[0] === "start" && c.args[1] === "-a" && c.args[2] === empty.ids[`${base}-k6`]), "no load runs after a refused cold start");
});

test("a cold probe that never becomes ready still leaves its log in cold.log, and a failed collection does not replace that failure", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t23", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  // A probe that writes nothing to stdout and a diagnostic to stderr; `failCollect` fails the
  // collection of its whole log. Each wait of the readiness poll moves the fake clock on a second.
  const quietProbe = (failCollect = false) => {
    const fake = fakeDocker({ exportFor: () => k6Export(flat(8)) }), docker = fake.docker;
    fake.docker = async (args, opts = {}) => {
      if (args[0] !== "logs" || args[1] !== fake.ids[`${base}-corten-probe`]) return docker(args, opts);
      fake.calls.push({ args, file: opts.file });
      // Its stdout: written to the file when one is named for stdout alone, otherwise returned.
      if (opts.file === undefined || opts.fileStderr === false) { if (opts.file !== undefined) appendFileSync(opts.file, ""); return ""; }
      if (failCollect) throw new Error("docker logs: exit 1");
      appendFileSync(opts.file, "probe diagnostic\n");
      return "";
    };
    return fake;
  };
  const fast = (fake) => runClock({ now: fake.now, sleep: async () => { fake.offset += 1000; } });
  const early = quietProbe();
  const s = await run(early, options, folder("early"), { clock: fast(early) });
  assert.deepEqual([s.cells[0].failure, s.cells[0].verdict], ["cold-start", null]);
  assert.match(errorsOf(folder("early")), /cold sidecar did not become ready/);
  assert.equal(readFileSync(join(folder("early"), "fixture", "corten", "page", "cold.log"), "utf8"), "probe diagnostic\n");
  // The probe was collected before it was removed.
  const collected = early.calls.findIndex((c) => c.args[0] === "logs" && c.file?.endsWith("cold.log"));
  const removed = early.calls.findIndex((c) => c.args[0] === "rm" && c.args.at(-1) === early.ids[`${base}-corten-probe`]);
  assert.ok(collected >= 0 && collected < removed, "cold.log is collected before the probe is removed");
  // A collection that fails: the readiness failure stands, and the collection's error is kept.
  const failing = quietProbe(true);
  const f = await run(failing, options, folder("failing"), { clock: fast(failing) });
  assert.deepEqual([f.cells[0].failure, f.cells[0].verdict], ["cold-start", null]);
  const errors = errorsOf(folder("failing"));
  assert.match(errors, /cold sidecar did not become ready/);
  assert.match(errors, /cold\.log: Error: docker logs: exit 1/);
  assert.ok(errors.indexOf("cold.log: Error") < errors.indexOf("cold sidecar did not become ready"), "the collection is tried before the failure is recorded");
});

test("the mounted fixture copy is kept while a container may still mount it, and a copy that could not be removed fails the pass", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t19", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  // A load container that cannot be removed: cleanup is unconfirmed, so the copy stays.
  const stuck = await run(fakeDocker({ exportFor: () => k6Export(flat(8)), failRemove: (name) => name === `${base}-k6` }), options, folder("stuck"));
  assert.equal(stuck.cleanup.complete, false);
  assert.equal(stuck.complete, false);
  assert.ok(existsSync(join(folder("stuck"), "mounted-fixture", "marketplace.json")), "the copy a container may still mount is kept");
  // Cleanup confirmed, but the copy's removal fails: the pass is not complete.
  const denied = await run(fakeDocker({ exportFor: () => k6Export(flat(8)) }), options, folder("denied"), {
    removeCopy: () => { throw Object.assign(new Error("EACCES: permission denied, rmdir 'mounted-fixture'"), { code: "EACCES" }); } });
  assert.equal(denied.cleanup.complete, true);
  assert.deepEqual([denied.complete, denied.failures], [false, [{ stage: "teardown", code: "error" }]]);
  assert.match(errorsOf(folder("denied")), /EACCES/);
  assert.ok(!readFileSync(join(folder("denied"), "summary.json"), "utf8").includes("EACCES"));
  // An ordinary pass removes it.
  let removed = null;
  const ok = await run(fakeDocker({ exportFor: () => k6Export(flat(8)) }), options, folder("ok"), { removeCopy: (path) => { removed = path; rmSync(path, { recursive: true, force: true }); } });
  assert.equal(ok.complete, true, JSON.stringify(ok.failures));
  assert.equal(removed, join(folder("ok"), "mounted-fixture"));
  assert.ok(!existsSync(removed));
});

// A client that writes `chunks` as rawClient does and, when signalled, writes `onTerm` to stderr
// before its pipes close.
function termNoise(chunks, onTerm) {
  const client = rawClient(chunks);
  const spawn = (binary, args) => {
    const child = client.spawn(binary, args), kill = child.kill;
    child.kill = (signal) => { if (!child.ended) child.stderr.write(onTerm); return kill(signal); };
    return child;
  };
  return { spawn, spawned: client.spawned };
}

test("stderr a stats or events client writes between its stop's TERM and its pipes closing fails that observation", async (t) => {
  const folder = folderOf(t);
  const app = "a".repeat(64), marker = "b".repeat(64);
  const row = JSON.stringify({ ID: app, Name: "x", CPUPerc: "1.00%", MemUsage: "100MiB / 1GiB" });
  const stats = termNoise([`${row}\n`], "Error response from daemon: connection reset\n");
  const sampler = memorySampler({ ids: [app], file: folder("stats.log"), seconds: 5, spawn: stats.spawn, graceMs: 1000, boundMs: 2000 });
  await settledTurns();
  await assert.rejects(sampler.stop(), /docker stats wrote to stderr \(kept in stats\.log\.stderr\)/);
  assert.equal(readFileSync(folder("stats.log.stderr"), "utf8"), "Error response from daemon: connection reset\n");
  const events = termNoise([`${marker}|start|1\n`], "error during connect\n");
  const stream = eventStream({ app, marker, file: folder("events.log"), spawn: events.spawn, graceMs: 1000, boundMs: 2000 });
  await stream.marker(1);
  await assert.rejects(stream.stop(), /docker events wrote to stderr \(kept in events\.log\.stderr\)/);
  // Without stderr, the same clients settle.
  const quietStats = rawClient([`${row}\n`]);
  const fine = memorySampler({ ids: [app], file: folder("fine.log"), seconds: 5, spawn: quietStats.spawn, graceMs: 1000, boundMs: 2000 });
  await settledTurns();
  assert.equal((await fine.stop()).samples[app].length, 1);
});

test("a client's row and line limits are counted on the bytes it wrote, blank rows and escape sequences included, and a failed stream answers no wait from its cache", async (t) => {
  const folder = folderOf(t);
  const app = "a".repeat(64), marker = "b".repeat(64);
  const row = JSON.stringify({ ID: app, Name: "x", CPUPerc: "1.00%", MemUsage: "100MiB / 1GiB" });
  const bounds = { graceMs: 1000, boundMs: 2000 };
  const cases = [
    // Blank rows count: four of them and a sample are five rows.
    ["blank", ["\n\n\n\n", `${row}\n`], { rows: 2 }, /^docker stats wrote more than 2 rows, so its memory samples are unavailable$/],
    // docker stats's screen clears count toward the row's length before they are stripped.
    ["ansi", [`${"\x1b[2J\x1b[H".repeat(150)}${row}\n`], { line: 1024 }, /^docker stats wrote a row longer than 1024 bytes, so its memory samples are unavailable$/],
    // A row's length is its bytes: 600 two-byte characters are 1,200.
    ["bytes", [`${"\u00e9".repeat(600)}\n`], { line: 1024 }, /^docker stats wrote a row longer than 1024 bytes, so its memory samples are unavailable$/],
  ];
  for (const [name, chunks, limits, message] of cases) {
    const client = rawClient(chunks);
    const sampler = memorySampler({ ids: [app], file: folder(`${name}.log`), seconds: 5, spawn: client.spawn, ...bounds, limits: { ...clientLimits.stats, ...limits } });
    await settledTurns();
    await assert.rejects(sampler.stop(), (error) => { assert.deepEqual(error.errors.map((e) => message.test(e)), [true], `${name}: ${error.message}`); return true; });
  }
  // Within the limits, the same escape sequences are stripped and the sample read.
  const plain = rawClient([`\x1b[2J\x1b[H${row}\n`]);
  const read = memorySampler({ ids: [app], file: folder("plain.log"), seconds: 5, spawn: plain.spawn, ...bounds });
  await settledTurns();
  assert.equal((await read.stop()).samples[app].length, 1);
  // events: both marker starts and the fence's die arrive, then a row past the limit. Neither the
  // marker's second start nor the fence, both seen before it, may still be answered.
  const events = rawClient([`${marker}|start|1\n${marker}|start|2\n${marker}|die|3\n`, "\u00e9".repeat(600)]);
  const stream = eventStream({ app, marker, file: folder("events.log"), spawn: events.spawn, markerMs: 10_000, ...bounds, limits: { ...clientLimits.events, line: 1024 } });
  await settledTurns();
  await assert.rejects(stream.marker(2), /^Error: docker events wrote a row longer than 1024 bytes$/);
  await assert.rejects(stream.fence(), /^Error: docker events wrote a row longer than 1024 bytes$/);
  await assert.rejects(stream.stop(), /so the stream is unavailable/);
  const blank = rawClient([`${marker}|start|1\n\n\n`]);
  const counted = eventStream({ app, marker, file: folder("events-blank.log"), spawn: blank.spawn, markerMs: 10_000, ...bounds, limits: { ...clientLimits.events, rows: 2 } });
  await settledTurns();
  await assert.rejects(counted.marker(1), /^Error: docker events wrote more than 2 rows$/);
  await assert.rejects(counted.stop(), /so the stream is unavailable/);
});

test("a load runs only against the app instance that served the cold probe: another StartedAt or RestartCount before the load refuses the cell, and no load starts", async (t) => {
  const folder = folderOf(t);
  // The app's inspect answers change only once the cold probe is removed: the cold start's own
  // inspect sees the instance that served the probe, the one before the load another.
  const coldDone = (state) => state.calls.some((x) => x.args[0] === "rm" && x.args.at(-1) === state.ids[`${base}-corten-probe`]);
  const changes = [
    ["started-at", (info) => ({ ...info, State: { ...info.State, StartedAt: new Date(Date.parse(info.State.StartedAt) + 1000).toISOString() } }), "another StartedAt"],
    ["restart-count", (info) => ({ ...info, RestartCount: 1 }), "another RestartCount"],
  ];
  const kinds = [
    ["convergence", ["convergence", "t30", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], () => k6Export(flat(8)), {}],
    ["soak", ["soak", "t31", "--apps", "corten", "--sources", "fixture", "--targets", "page"], () => soakExport(), { clockMs: 1_800_000, loadMs: 50 }],
  ];
  for (const [kind, args, exportFor, extra] of kinds) for (const [name, change, what] of changes) {
    const options = parseSteadyArgs(args, apps, groupApps), at = `${kind}-${name}`;
    const fake = fakeDocker({ exportFor, ...extra, inspected: (info, c, state) => (c.kind === "app" && coldDone(state) ? change(info) : info) });
    let tick = 0;
    const stats = statsClient({ delayMs: 10, rows: (a) => Array.from({ length: 180 }, () => ({ ID: a.at(-1), Name: "x", CPUPerc: "1.00%", MemUsage: "100MiB / 1GiB" })) });
    const s = await run(fake, options, folder(at), { spawnStats: stats.spawn, statsBounds: { now: () => fake.startIssuedMs + 10_000 * tick++ } });
    assert.equal(s.cells[0].failure, "instance-changed", `${at}: ${JSON.stringify(s.cells[0])}`);
    assert.ok(errorsOf(folder(at)).includes(`the app before the load is not the instance that served the cold probe: ${what}`), at);
    // No load started: no k6 or marker container, no load run, no memory sampler.
    assert.ok(!fake.calls.some((c) => c.args[0] === "create" && (c.args[2] === `${base}-k6` || c.args[2].endsWith("-marker"))), at);
    assert.ok(!fake.calls.some((c) => c.args[0] === "start" && c.args[1] === "-a" && c.args[2] !== fake.ids[`${base}-host`] && c.args[2] !== fake.ids[`${base}-k6-version`]), at);
    assert.equal(stats.spawned.length, 0, at);
    // The failure is the cell's: the pass is complete and reads, with no reading for that cell.
    assert.equal(s.complete, true, at);
    (kind === "convergence" ? validateConvergence : validateSoak)(s);
  }
});

test("the cold probe's output is read as its result only after it exits, with both lines ended by their newline", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t32", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  const result = (state) => JSON.stringify({ first200At: new Date(Date.parse(state.app().state.StartedAt) + 5).toISOString(), successfulRequestMs: 1.5, bytes: 10, attempts: 2, path: "/marketplace/en-US/item_1" });
  // Ready (its line ended) while the readiness poll reads it; `exited(state)` once it has exited.
  const probe = (exited) => (args, state) => (args[0] === "logs" && args[1] === state.ids[`${base}-corten-probe`]
    ? (state.calls.some((c) => c.args[0] === "wait") ? exited(state) : "catalog-probe-ready\n") : undefined);
  const good = await run(fakeDocker({ exportFor: () => k6Export(flat(8)), override: probe((state) => `catalog-probe-ready\n${result(state)}\n`) }), options, folder("good"));
  assert.equal(good.complete, true, JSON.stringify([good.failures, good.cells]));
  assert.equal(good.cells[0].verdict.withinTolerance, true);
  for (const [name, exited, message] of [
    // A result with no newline after it, read after the probe exited: not the probe's whole output.
    ["unterminated", (state) => `catalog-probe-ready\n${result(state)}`, /the cold probe exited without a newline after its result line; its output is in cold\.log/],
    // An empty final read is no result at all, whatever the readiness poll saw.
    ["empty", () => "", /the cold probe exited 0 without a result line; its output is in cold\.log/],
    ["ready-only", () => "catalog-probe-ready\n", /the cold probe exited 0 without a result line/],
    ["ready-unterminated", () => "catalog-probe-ready", /the cold probe exited 0 without a result line/],
  ]) {
    const fake = fakeDocker({ exportFor: () => k6Export(flat(8)), override: probe(exited) });
    const s = await run(fake, options, folder(name));
    assert.deepEqual([s.cells[0].failure, s.cells[0].verdict], ["cold-start", null], name);
    assert.match(errorsOf(folder(name)), message, name);
    assert.ok(!existsSync(join(folder(name), "fixture", "corten", "page", "cold.json")), name);
    assert.ok(!fake.calls.some((c) => c.args[0] === "create" && c.args[2] === `${base}-k6`), `${name}: no load after a refused cold start`);
  }
  // The final parser on its own; the readiness poll's parser still accepts a line not yet ended.
  const line = JSON.stringify({ first200At: "2026-11-25T00:00:00.000Z", successfulRequestMs: 1.5, bytes: 10, attempts: 2, path: "/p" });
  assert.equal(coldResult(`catalog-probe-ready\n${line}\n`, "/p").bytes, 10);
  assert.equal(coldOutput(`catalog-probe-ready\n${line}`, "/p").bytes, 10);
  for (const [text, message] of [["", /without a result line/], ["catalog-probe-ready", /without a result line/], ["catalog-probe-ready\n", /without a result line/],
    [`catalog-probe-ready\n${line}`, /without a newline after its result line/], [`catalog-probe-ready\n${line}\n\n`, /not one readiness line and one result line/]])
    assert.throws(() => coldResult(text, "/p"), message, JSON.stringify(text));
});

test("a host's CPU model is saved only as its digest, even in a form a pass once saved as text, and neither report prints it", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t33", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  // Letters, digits and single spaces: the form convergence v4 saved and printed as text.
  const model = "Synthetic CanaryModel 7543";
  const fake = fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args, state) =>
    (args[0] === "start" && args[1] === "-a" && args[2] === state.ids[`${base}-host`] ? `6.8.0-test\nmodel name\t: ${model}\n0-7` : undefined) });
  const s = await run(fake, options, folder("canary"), { env: pinnedEnv });
  assert.equal(s.complete, true, JSON.stringify(s.failures));
  validateConvergence(s);
  assert.equal(s.host.cpuModelSha256, sha256(model));
  assert.ok(!readFileSync(join(folder("canary"), "summary.json"), "utf8").includes("CanaryModel"), "summary.json keeps no model text");
  assert.ok(readFileSync(join(folder("canary"), "host.txt"), "utf8").includes(model), "the raw host receipt keeps it");
  // steady-report.mjs prints that it is recorded, never the text.
  const text = steadyReport(s);
  assert.ok(!text.includes("CanaryModel"), text);
  assert.match(text, /^Commit: .* CPU model: recorded as its SHA-256 only, not printed \(its text is in the raw host\.txt\) \(online CPUs 0-7\)\./m);
  // report.mjs --convergence's lines: a round on the same model matches by digest, one on another
  // differs, and neither model's text is printed.
  const round = { schema: resultSchema, commit, options: { warmup: 10, startupTimeout: 120 }, host: { cpu: model, release: s.host.kernel, onlineCpus: s.host.onlineCpus }, measurement: s.measurement,
    fixtureSha256: s.fixtureSha256, tools: s.tools, apps: { corten: { imageId: s.images.corten, runs: { "fixture-rotating-page": [{ warmup: { failed: 0 } }] } } } };
  const same = convergenceLines(round, ["corten"], s);
  assert.match(same[0], /Host CPU model: compared by its SHA-256, not printed\./);
  assert.match(same[2], /^The pass is like-for-like with this round for its 1 cell with a reading only/);
  const other = convergenceLines({ ...round, host: { ...round.host, cpu: "Synthetic OtherModel 1" } }, ["corten"], s);
  assert.match(other[2], /the host CPU differs/);
  for (const lines of [same, other]) assert.ok(!lines.join("\n").includes("CanaryModel") && !lines.join("\n").includes("OtherModel"), lines.join("\n"));
});

test("a cell runs only with the settings its summary records: image, CPU quota and pinning, memory and load settings", async (t) => {
  const folder = folderOf(t);
  const convergence = parseSteadyArgs(["convergence", "t40", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  const soak = parseSteadyArgs(["soak", "t41", "--apps", "corten", "--sources", "fixture", "--targets", "page"], apps, groupApps);
  const other = `sha256:${"e".repeat(64)}`;
  const host = (change) => (info) => ({ ...info, HostConfig: { ...info.HostConfig, ...change } });
  const env = (edit) => (info) => ({ ...info, Config: { ...info.Config, Env: edit(info.Config.Env) } });
  const set = (key, value) => env((list) => list.map((e) => (e.startsWith(`${key}=`) ? `${key}=${value}` : e)));
  // [name, the pass, the container role it changes, the change, the setting the message names]
  const cases = [
    ["app-image", convergence, "app", (info) => ({ ...info, Image: other }), "app container's image"],
    ["app-quota", convergence, "app", host({ NanoCpus: 2e9 }), "app container's CPU quota"],
    ["app-cpu-quota", convergence, "app", host({ CpuQuota: 50_000 }), "app container's CPU quota"],
    ["app-cpuset", convergence, "app", host({ CpusetCpus: "0" }), "app container's CPU pinning (cpuset)"],
    ["app-memory", convergence, "app", host({ Memory: 0 }), "app container's memory limit"],
    ["app-source", convergence, "app", set("MARKETPLACE_SOURCE", "api"), "app container's MARKETPLACE_SOURCE setting"],
    ["load-image", convergence, "k6", (info) => ({ ...info, Image: other }), "load container's image"],
    ["load-quota", convergence, "k6", host({ NanoCpus: 8e9 }), "load container's CPU quota"],
    ["load-cpuset", convergence, "k6", host({ CpusetCpus: "0-7" }), "load container's CPU pinning (cpuset)"],
    ["load-memory", convergence, "k6", host({ Memory: 2 ** 30 }), "load container's memory limit"],
    ["load-vus", convergence, "k6", set("VUS", "64"), "load container's VUS setting"],
    ["load-windows", convergence, "k6", set("WINDOWS", "9"), "load container's WINDOWS setting"],
    ["load-window-seconds", convergence, "k6", set("WINDOW_SECONDS", "10"), "load container's WINDOW_SECONDS setting"],
    ["load-target", convergence, "k6", set("TARGET", "json"), "load container's TARGET setting"],
    ["load-locale", convergence, "k6", env((list) => list.filter((e) => !e.startsWith("LOCALE="))), "load container's LOCALE setting"],
    ["load-twice", convergence, "k6", env((list) => [...list, "VUS=32"]), "load container's VUS setting"],
    ["load-rate-given", convergence, "k6", env((list) => [...list, "RATE=150"]), "load container's RATE setting"],
    ["soak-rate", soak, "k6", set("RATE", "300"), "load container's RATE setting"],
    ["soak-mode", soak, "k6", set("MODE", "closed"), "load container's MODE setting"],
  ];
  for (const [name, options, role, change, what] of cases) {
    const soakPass = options.kind === "soak";
    const fake = fakeDocker({ exportFor: soakPass ? () => soakExport() : () => k6Export(flat(8)), ...(soakPass ? { clockMs: 1_800_000, loadMs: 50 } : {}), inspected: (info, c) => (c.kind === role ? change(info) : info) });
    let tick = 0;
    const stats = statsClient({ delayMs: 10, rows: (a) => Array.from({ length: 180 }, () => ({ ID: a.at(-1), Name: "x", CPUPerc: "1.00%", MemUsage: "100MiB / 1GiB" })) });
    const s = await run(fake, options, folder(name), { env: pinnedEnv, spawnStats: stats.spawn, statsBounds: { now: () => fake.startIssuedMs + 10_000 * tick++ } });
    assert.equal(s.cells[0].failure, "settings", `${name}: ${JSON.stringify(s.cells[0])}`);
    assert.ok(errorsOf(folder(name)).includes(`the ${what} is not the one this pass records`), name);
    // Refused before the load starts: no load run.
    assert.ok(!fake.calls.some((c) => c.args[0] === "start" && c.args[1] === "-a" && c.args[2] === fake.ids[`${base}-k6`]), `${name}: no load ran`);
    assert.ok(!readFileSync(join(folder(name), "summary.json"), "utf8").includes("e".repeat(64)), name);
    // The cell's failure is the pass's record: it is complete and reads, with no reading for that cell.
    assert.equal(s.complete, true, name);
    (soakPass ? validateSoak : validateConvergence)(s);
  }
  // Settings that change only in the load's inspect after it ran are refused as well, before a reading.
  let ran = false;
  const after = fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args, state) => { if (args[0] === "start" && args[1] === "-a" && args[2] === state.ids[`${base}-k6`]) ran = true; },
    inspected: (info, c) => (c.kind === "k6" && ran ? set("VUS", "64")(info) : info) });
  const late = await run(after, convergence, folder("after"), { env: pinnedEnv });
  assert.equal(late.cells[0].failure, "settings");
  assert.ok(errorsOf(folder("after")).includes("the load container's VUS setting is not the one this pass records"));
  // The upstream's quota, pinning and memory are the pass's too: one that differs ends the pass before any cell.
  const upstream = await run(fakeDocker({ exportFor: () => k6Export(flat(8)), inspected: (info, c) => (c.kind === "upstream" ? host({ CpusetCpus: "" })(info) : info) }), convergence, folder("upstream"), { env: pinnedEnv });
  assert.deepEqual([upstream.complete, upstream.failures, upstream.cells], [false, [{ stage: "suite", code: "settings" }], []]);
  assert.ok(errorsOf(folder("upstream")).includes("the upstream container's CPU pinning (cpuset) is not the one this pass records"));
  // A pinned pass whose containers have what it records reads, and its load receipt keeps the window settings.
  const ok = await run(fakeDocker({ exportFor: () => k6Export(flat(8)) }), convergence, folder("ok"), { env: pinnedEnv });
  assert.equal(ok.complete, true, JSON.stringify(ok.failures));
  assert.equal(ok.cells[0].verdict.withinTolerance, true);
  const receipt = JSON.parse(readFileSync(join(folder("ok"), "fixture", "corten", "page", "load-container.json"), "utf8"));
  assert.deepEqual([receipt.windowEnv, receipt.nanoCpus, receipt.cpuset, receipt.memoryBytes, receipt.env.VUS], [{ requested: { WINDOWS: "8", WINDOW_SECONDS: "15" }, observed: { WINDOWS: ["8"], WINDOW_SECONDS: ["15"] } }, 4e9, "4-7", 2 * 2 ** 30, "32"]);
});

test("the app is rechecked as the instance that served the cold probe immediately before the load: a change there fails the cell, one during the load is the load's", async (t) => {
  const folder = folderOf(t);
  const kinds = [
    ["convergence", parseSteadyArgs(["convergence", "t42", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps), () => k6Export(flat(8)), {}],
    ["soak", parseSteadyArgs(["soak", "t43", "--apps", "corten", "--sources", "fixture", "--targets", "page"], apps, groupApps), () => soakExport(), { clockMs: 1_800_000, loadMs: 50 }],
  ];
  const measure = async (name, options, exportFor, extra) => {
    const fake = fakeDocker({ exportFor, ...extra });
    let tick = 0;
    const stats = statsClient({ delayMs: 10, rows: (a) => Array.from({ length: 180 }, () => ({ ID: a.at(-1), Name: "x", CPUPerc: "1.00%", MemUsage: "100MiB / 1GiB" })) });
    const s = await run(fake, options, folder(name), { spawnStats: stats.spawn, statsBounds: { now: () => fake.startIssuedMs + 10_000 * tick++ } });
    return { s, fake, loaded: fake.calls.some((c) => c.args[0] === "start" && c.args[1] === "-a" && c.args[2] === fake.ids[`${base}-k6`]) };
  };
  // A restart in place (a new StartedAt, its restart event) once the load container is created: after
  // the app's snapshot before the load and the soak's first marker start, before the load starts.
  const gap = (args, state) => {
    if (args[0] === "create" && args[2] === `${base}-k6`) {
      const app = state.app(); state.offset += 1000;
      app.state = { ...app.state, StartedAt: new Date(state.now()).toISOString() }; state.emit(app.id, "restart");
    }
  };
  for (const [kind, options, exportFor, extra] of kinds) {
    const { s, loaded } = await measure(`${kind}-gap`, options, exportFor, { ...extra, override: gap });
    assert.equal(s.cells[0].failure, "instance-changed", `${kind}: ${JSON.stringify(s.cells[0])}`);
    assert.ok(errorsOf(folder(`${kind}-gap`)).includes("the app changed after it served the cold probe and before the load started: another StartedAt"), kind);
    assert.equal(loaded, false, `${kind}: no load started`);
    assert.equal(s.complete, true, kind);
    (kind === "convergence" ? validateConvergence : validateSoak)(s);
  }
  // A restart event stamped after that recheck but before the load's StartedAt is not the load's either.
  const [, soakOptions, soakFor, soakExtra] = kinds[1];
  const stamped = await measure("soak-before-start", soakOptions, soakFor, { ...soakExtra, override: (args, state) => {
    if (args[0] === "start" && args[1] === "-a" && args[2] === state.ids[`${base}-k6`]) { state.emit(state.app().id, "restart"); state.offset += 1; }
  } });
  assert.equal(stamped.s.cells[0].failure, "instance-changed", JSON.stringify(stamped.s.cells[0]));
  assert.ok(errorsOf(folder("soak-before-start")).includes("the app had a start, restart, die, kill or OOM event stamped before the load started"));
  validateSoak(stamped.s);
  // The same restart during the load: a soak reads it as a restart; a convergence cell has no reading for it.
  const during = await measure("soak-during", soakOptions, soakFor, { ...soakExtra, restartOnLoad: true });
  assert.equal(during.s.cells[0].failure, undefined, JSON.stringify(during.s.cells[0]));
  assert.deepEqual([during.s.cells[0].restarts.restarted, during.s.cells[0].restarts.replaced, during.s.cells[0].restarts.events.map((e) => e.action)], [true, true, ["restart"]]);
  validateSoak(during.s);
  const [, convergenceOptions, convergenceFor] = kinds[0];
  const held = await measure("convergence-during", convergenceOptions, convergenceFor, { restartOnLoad: true });
  assert.equal(held.loaded, true);
  assert.equal(held.s.cells[0].failure, "instance-changed");
  assert.ok(errorsOf(folder("convergence-during")).includes("app container stopped, restarted, was replaced or was OOM-killed during the pass: another StartedAt"));
});

// A pass with a fake docker stats client, which a soak samples its app's memory through.
function sampled(fake, options, folder, extra = {}) {
  let tick = 0;
  const stats = statsClient({ delayMs: 10, rows: (a) => Array.from({ length: 180 }, () => ({ ID: a.at(-1), Name: "x", CPUPerc: "1.00%", MemUsage: "100MiB / 1GiB" })) });
  return run(fake, options, folder, { spawnStats: stats.spawn, statsBounds: { now: () => fake.startIssuedMs + 10_000 * tick++ }, ...extra });
}
const loadStarted = (args, state) => args[0] === "start" && args[1] === "-a" && args[2] === state.ids[`${base}-k6`];
const withHost = (change) => (info) => ({ ...info, HostConfig: { ...info.HostConfig, ...change } });

test("an app whose settings a docker update changes after its first check, at the launch check or during the load, fails the cell `settings` and keeps no reading", async (t) => {
  const folder = folderOf(t);
  const convergence = parseSteadyArgs(["convergence", "t44", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  const soak = parseSteadyArgs(["soak", "t45", "--apps", "corten", "--sources", "fixture", "--targets", "page"], apps, groupApps);
  // [name, the pass, when the update lands, the change, the setting the message names, whether the load ran]
  const cases = [
    // Once the load container is created: after the app's first check, seen at the launch check.
    ["launch-quota", convergence, (args) => args[0] === "create" && args[2] === `${base}-k6`, withHost({ NanoCpus: 2e9 }), "CPU quota", false],
    ["launch-memory", soak, (args) => args[0] === "create" && args[2] === `${base}-k6`, withHost({ Memory: 2 ** 31 }), "memory limit", false],
    // Once the load has started: seen in the app's inspect after it.
    ["load-cpuset", convergence, loadStarted, withHost({ CpusetCpus: "0" }), "CPU pinning (cpuset)", true],
    ["load-quota", soak, loadStarted, withHost({ NanoCpus: 2e9 }), "CPU quota", true],
  ];
  for (const [name, options, when, change, what, loads] of cases) {
    const soakPass = options.kind === "soak";
    let updated = false;
    const fake = fakeDocker({ ...(soakPass ? { exportFor: () => soakExport(), clockMs: 1_800_000, loadMs: 50 } : { exportFor: () => k6Export(flat(8)) }),
      override: (args, state) => { if (when(args, state)) updated = true; }, inspected: (info, c) => (c.kind === "app" && updated ? change(info) : info) });
    const s = await sampled(fake, options, folder(name), { env: pinnedEnv });
    assert.equal(s.cells[0].failure, "settings", `${name}: ${JSON.stringify(s.cells[0])}`);
    assert.ok(errorsOf(folder(name)).includes(`the app container's ${what} is not the one this pass records`), name);
    assert.equal(fake.calls.some((c) => loadStarted(c.args, fake)), loads, `${name}: whether the load ran`);
    assert.equal(s.complete, true, name);
    (soakPass ? validateSoak : validateConvergence)(s);
  }
});

test("an API cell's upstream is checked before the cell and after its load: settings a docker update changes fail that cell `settings`", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t46", "--apps", "corten", "--sources", "api", "--minutes", "2"], apps, groupApps);
  const raw = (name, target) => join(folder(name), "api", "corten", target);
  const measure = async (name, when) => {
    let updated = false, loads = 0;
    const fake = fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args, state) => { if (loadStarted(args, state)) loads++; if (when(args, state)) updated = true; },
      inspected: (info, c) => (c.kind === "upstream" && updated ? withHost({ CpusetCpus: "" })(info) : info) });
    const s = await run(fake, options, folder(name), { env: pinnedEnv });
    return { s, loads };
  };
  // During the first cell's load: that cell fails after its load, and the next before its app is created.
  const during = await measure("during", loadStarted);
  assert.deepEqual([during.s.cells.map((c) => [c.target, c.failure, c.verdict]), during.loads], [[["page", "settings", null], ["json", "settings", null]], 1], JSON.stringify(during.s.cells));
  assert.ok(errorsOf(folder("during")).includes("the upstream container's CPU pinning (cpuset) is not the one this pass records"));
  assert.ok(existsSync(join(raw("during", "page"), "upstream-container-after.json")), "the upstream's inspect after the load is kept raw");
  assert.equal(during.s.complete, true);
  validateConvergence(during.s);
  // Between the cells (once the first cell's app is removed): the first reads, the second fails before its app exists.
  const between = await measure("between", (args, state) => args[0] === "rm" && args.at(-1) === state.ids[`${base}-corten`]);
  assert.deepEqual([between.s.cells.map((c) => [c.target, c.failure ?? "read"]), between.loads], [[["page", "read"], ["json", "settings"]], 1], JSON.stringify(between.s.cells));
  assert.ok(!existsSync(join(raw("between", "json"), "app-container.json")), "no app was created for the refused cell");
  validateConvergence(between.s);
  // Unchanged: every API cell reads, with the upstream's inspect before the cell and after its load kept raw.
  const held = await measure("held", () => false);
  assert.equal(held.s.complete, true, JSON.stringify(held.s.failures));
  assert.deepEqual(held.s.cells.map((c) => [c.target, c.failure, c.verdict.withinTolerance]), [["page", undefined, true], ["json", undefined, true]]);
  for (const target of ["page", "json"]) for (const when of ["before", "after"]) assert.ok(existsSync(join(raw("held", target), `upstream-container-${when}.json`)), `${target} ${when}`);
  validateConvergence(held.s);
});

test("a soak's app that started again after the launch check and before the load fails the cell `instance-changed` from Docker's inspect alone, with the event stream unavailable", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["soak", "t47", "--apps", "corten", "--sources", "fixture", "--targets", "page"], apps, groupApps);
  // An events client that shows the marker's first start, so the load runs, and none of the exits
  // after it, so the stream never shows its fence: it is unavailable after the load.
  const soak = async (name, extra) => {
    const fake = fakeDocker({ exportFor: () => soakExport(), clockMs: 1_800_000, loadMs: 50, ...extra });
    return sampled(fake, options, folder(name), { spawnEvents: eventsClient(fake, { drop: (row) => row.includes("|die|") }).spawn });
  };
  // Restarted in place as the load is started (after the launch check): a new StartedAt a
  // millisecond before the load container's own, and no event to show it.
  const early = await soak("before-load", { override: (args, state) => {
    if (!loadStarted(args, state)) return;
    const app = state.app(); app.state = { ...app.state, StartedAt: new Date(state.now()).toISOString() }; state.offset += 1;
  } });
  assert.equal(early.cells[0].failure, "instance-changed", JSON.stringify(early.cells[0]));
  assert.ok(errorsOf(folder("before-load")).includes("the app started again after the launch check and before the load started"));
  assert.equal(early.complete, true);
  validateSoak(early);
  // The same restart during the load, with the stream just as unavailable: nothing places it in the
  // load rather than before it, so the cell keeps no reading.
  const during = await soak("during-load", { restartOnLoad: true });
  assert.equal(during.cells[0].failure, "unconfirmed", JSON.stringify(during.cells[0]));
  assert.ok(errorsOf(folder("during-load")).includes("the app's inspect after the load shows another StartedAt than at the launch check"));
  validateSoak(during);
});

test("a foreign full ID in a cleanup listing stays out of cleanup.json and summary.json", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t45", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  const sweep = `label=${ownerLabelKey}=marketplace-test-run`;
  // A canonical ID of a container this pass did not create, which the owner-label listing returns.
  const foreign = "e".repeat(64);
  const listed = fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args, state) => (args[0] === "ps" && args.includes(sweep)
    ? [...[...state.containers.values()].filter((c) => c.labels[ownerLabelKey] === "marketplace-test-run").map((c) => c.id), foreign].join("\n") : undefined) });
  listed.containers.set(foreign, { id: foreign, name: "someone-else", kind: "foreign", labels: { other: "owner" }, args: [], image: "x", imageId: "x", state: { Running: true } });
  const s = await run(listed, options, folder("foreign"));
  assert.ok(listed.containers.has(foreign), "the foreign container survives");
  assert.ok(!listed.calls.some((c) => c.args[0] === "rm" && c.args.includes(foreign)), "it was never removed");
  for (const file of ["cleanup.json", "summary.json"]) assert.ok(!readFileSync(join(folder("foreign"), file), "utf8").includes(foreign), `${file} names the foreign ID`);
  assert.deepEqual(s.cleanup.remaining, { containers: 1, networks: 0 }, "what survived is counted, not listed");
  assert.equal(s.cleanup.complete, false);
  assert.equal(s.complete, false);
  assert.ok(cleanupOf(folder("foreign")).failures.some((f) => f.error === "refusing unowned container; its ID is not kept"));
});

test("a failed cleanup listing whose client diagnostic echoes its filter keeps that diagnostic in errors.log only", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t46", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  const sweep = `label=${ownerLabelKey}=marketplace-test-run`;
  const canary = "listing-canary-5d1e";
  const failing = fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args) => (args[0] === "ps" && args.includes(sweep)
    ? new Error(`Error response from daemon: invalid filter '${sweep}' ${canary}`) : undefined) });
  const f = await run(failing, options, folder("failing"));
  for (const file of ["cleanup.json", "summary.json", "run.log"]) {
    const text = readFileSync(join(folder("failing"), file), "utf8");
    assert.ok(!text.includes(canary) && !text.includes("invalid filter"), `${file} keeps the listing's diagnostic`);
  }
  assert.ok(cleanupOf(folder("failing")).failures.some((x) => x.error === "a docker container listing failed; its output is not kept"), JSON.stringify(cleanupOf(folder("failing")).failures));
  assert.ok(errorsOf(folder("failing")).includes(canary), "the raw diagnostic is in errors.log");
  assert.equal(f.cleanup.remaining, null);
  assert.equal(f.cleanup.complete, false);
});
test("a create whose acknowledgement was lost counts as cleaned up only once what its label found is removed by its own ID; until then the fixture copy is kept", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t44", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  // The load container is made but its create's answer is lost, and the owner-label sweep's listing
  // leaves it out: only the lookup by its attempt label finds it.
  const omits = (args) => (args[0] === "ps" && args.includes(`label=${ownerLabelKey}=marketplace-test-run`) ? "" : undefined);
  const lost = (name) => name === `${base}-k6`;
  // The run's clock and the daemon's are one fixed time that moves only when the daemon or a sleep
  // moves it on, so the 30 ms reconciliation window's first lookup is made however long the host
  // takes between the window's start and that lookup.
  const controlled = (extra) => { const fake = fakeDocker({ epochMs: Date.parse("2026-11-25T00:00:00Z"), ...extra }); return [fake, runClock({ now: fake.now, sleep: async (ms) => { fake.offset += ms; } })]; };
  // Its removal by ID also fails: cleanup is not complete and the copy a container may mount is kept.
  const [stuck, stuckClock] = controlled({ exportFor: () => k6Export(flat(8)), lose: lost, override: omits, failRemove: lost });
  const s = await run(stuck, options, folder("stuck"), { clock: stuckClock });
  assert.equal(s.cells[0].failure, "container");
  const cleanup = cleanupOf(folder("stuck"));
  assert.deepEqual(cleanup.unacknowledged.map((a) => [a.name, a.outcome, a.found]), [[`${base}-k6`, "not removed", 1]]);
  assert.equal(cleanup.complete, false);
  assert.ok(cleanup.failures.some((f) => /not each removed or confirmed absent by its own ID/.test(f.error)));
  assert.equal(s.cleanup.complete, false);
  assert.ok(existsSync(join(folder("stuck"), "mounted-fixture", "marketplace.json")), "the copy is kept");
  assert.equal(stuck.containers.size, 1);
  // Its removal by ID succeeds: it is removed whatever the sweep listed, and only then is the copy removed.
  const [found, foundClock] = controlled({ exportFor: () => k6Export(flat(8)), lose: lost, override: omits });
  const r = await run(found, options, folder("found"), { clock: foundClock });
  const record = cleanupOf(folder("found"));
  assert.deepEqual(record.unacknowledged.map((a) => [a.name, a.outcome]), [[`${base}-k6`, "removed"]]);
  assert.ok(found.calls.some((c) => c.args[0] === "rm" && c.args.at(-1) === found.ids[`${base}-k6`]), "removed by its ID");
  assert.equal(found.containers.size, 0);
  assert.equal(r.cleanup.complete, true);
  assert.ok(!existsSync(join(folder("found"), "mounted-fixture")), "the copy is removed once nothing can mount it");
  assert.equal(r.complete, false, "a create Docker did not acknowledge still ends the pass");
});

// An events client that cannot run at all: a pass with no event stream.
const noEvents = () => { const child = new EventEmitter(); Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill() { return true; } }); setImmediate(() => { child.emit("error", Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" })); child.emit("close", -2); }); return child; };

test("a docker update during the load that is undone before the inspect after it fails the cell `settings` from Docker's event stream; with no stream the cell is unconfirmed", async (t) => {
  const folder = folderOf(t);
  const convergence = parseSteadyArgs(["convergence", "t48", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  const api = parseSteadyArgs(["convergence", "t49", "--apps", "corten", "--sources", "api", "--targets", "page", "--minutes", "2"], apps, groupApps);
  const soak = parseSteadyArgs(["soak", "t50", "--apps", "corten", "--sources", "fixture", "--targets", "page"], apps, groupApps);
  // An update of a container during the load, undone before any inspect sees it: only its update event shows it.
  const updateOf = (name) => (state) => state.emit(state.ids[name], "update");
  const cases = [
    ["app-convergence", convergence, `${base}-corten`, "app"],
    ["load-convergence", convergence, `${base}-k6`, "load"],
    ["upstream-api", api, `${base}-upstream`, "upstream"],
    ["app-soak", soak, `${base}-corten`, "app"],
  ];
  const passOf = (options, extra = {}) => fakeDocker({ ...(options.kind === "soak" ? { exportFor: () => soakExport(), clockMs: 1_800_000, loadMs: 50 } : { exportFor: () => k6Export(flat(8)) }), ...extra });
  for (const [name, options, container, role] of cases) {
    const s = await sampled(passOf(options, { duringLoad: updateOf(container) }), options, folder(name), { env: pinnedEnv });
    assert.equal(s.cells[0].failure, "settings", `${name}: ${JSON.stringify(s.cells[0])}`);
    assert.ok(errorsOf(folder(name)).includes(`Docker's event stream shows 1 update of the cell's containers (${role}) from before its launch check to after its last inspect`), name);
    assert.equal(s.complete, true, name);
    (options.kind === "soak" ? validateSoak : validateConvergence)(s);
  }
  // An update of the upstream between API cells, outside any cell's stream, is the next cell's
  // inspect's to see; with none, every API cell reads, its stream following the upstream too.
  const held = passOf(api);
  const clean = await sampled(held, api, folder("api-held"), { env: pinnedEnv });
  assert.equal(clean.cells[0].verdict.withinTolerance, true, JSON.stringify(clean.cells[0]));
  const events = JSON.parse(readFileSync(join(folder("api-held"), "api", "corten", "page", "events.json"), "utf8"));
  assert.deepEqual([events.stream, events.updates, events.upstream, events.restartedSinceLaunch], ["read", [], [], []]);
  // The same passes with no event stream: no event-stream check of the load at all, so neither
  // kind keeps a reading, and no load starts once the stream has not shown the marker's first start.
  for (const [name, options] of [["unconfirmed-convergence", convergence], ["unconfirmed-soak", soak]]) {
    const fake = passOf(options);
    const s = await sampled(fake, options, folder(name), { env: pinnedEnv, spawnEvents: noEvents });
    assert.equal(s.cells[0].failure, "unconfirmed", `${name}: ${JSON.stringify(s.cells[0])}`);
    if (options.kind === "convergence") assert.equal(s.cells[0].verdict, null);
    assert.ok(!fake.calls.some((c) => loadStarted(c.args, fake)), `${name}: no load started`);
    assert.equal(s.complete, true, name);
    (options.kind === "soak" ? validateSoak : validateConvergence)(s);
  }
  // A stream that showed the first marker start but not the fence after the load: no reading either.
  for (const [name, options] of [["unfenced-convergence", convergence], ["unfenced-soak", soak]]) {
    const fake = passOf(options);
    const s = await sampled(fake, options, folder(name), { env: pinnedEnv, spawnEvents: eventsClient(fake, { drop: (row) => row.includes("|die|") }).spawn });
    assert.equal(s.cells[0].failure, "unconfirmed", `${name}: ${JSON.stringify(s.cells[0])}`);
    assert.ok(fake.calls.some((c) => loadStarted(c.args, fake)), `${name}: the load ran`);
    assert.match(errorsOf(folder(name)), /Docker's event stream is unavailable \(docker events did not show the marker's exit after its second start within 200 ms\)/, name);
    (options.kind === "soak" ? validateSoak : validateConvergence)(s);
  }
});

test("a soak's app restarted after the launch check and again during the load is not accepted as continuous when the event stream is unavailable", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["soak", "t51", "--apps", "corten", "--sources", "fixture", "--targets", "page"], apps, groupApps);
  // A restart as the load is started (stamped a millisecond before the load container's StartedAt),
  // then another during the load, which overwrites the first StartedAt.
  const twice = { override: (args, state) => {
    if (!loadStarted(args, state)) return;
    const app = state.app(); app.state = { ...app.state, StartedAt: new Date(state.now()).toISOString() }; state.emit(app.id, "restart"); state.offset += 1;
  }, restartOnLoad: true };
  // The stream shows the marker's first start and then loses the fence after the load.
  const lost = fakeDocker({ exportFor: () => soakExport(), clockMs: 1_800_000, loadMs: 50, ...twice });
  const unavailable = await sampled(lost, options, folder("unavailable"), { spawnEvents: eventsClient(lost, { drop: (row) => row.includes("|die|") }).spawn });
  assert.equal(unavailable.cells[0].failure, "unconfirmed", JSON.stringify(unavailable.cells[0]));
  assert.match(errorsOf(folder("unavailable")), /the app's inspect after the load shows another StartedAt than at the launch check/);
  assert.equal(unavailable.complete, true);
  validateSoak(unavailable);
  // With the stream, the first restart is stamped before the load started: instance-changed.
  const read = await sampled(fakeDocker({ exportFor: () => soakExport(), clockMs: 1_800_000, loadMs: 50, ...twice }), options, folder("read"));
  assert.equal(read.cells[0].failure, "instance-changed", JSON.stringify(read.cells[0]));
  validateSoak(read);
});

test("the load receipt keeps the window settings as requested and as Docker reported them, before the load starts and after it ran", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t52", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  const nine = (info) => ({ ...info, Config: { ...info.Config, Env: info.Config.Env.map((e) => (e === "WINDOWS=8" ? "WINDOWS=9" : e)) } });
  const observedNine = { requested: { WINDOWS: "8", WINDOW_SECONDS: "15" }, observed: { WINDOWS: ["9"], WINDOW_SECONDS: ["15"] } };
  // Docker's inspect of the load before it starts reports WINDOWS=9: the cell fails `settings`, no
  // load starts, and the receipt of that inspect keeps what Docker had.
  const early = fakeDocker({ exportFor: () => k6Export(flat(8)), inspected: (info, c, state) => (c.kind === "k6" && state.startIssuedMs === null ? nine(info) : info) });
  const refused = await run(early, options, folder("nine-before"));
  assert.equal(refused.cells[0].failure, "settings");
  assert.ok(!early.calls.some((c) => loadStarted(c.args, early)), "no load started");
  const before = JSON.parse(readFileSync(join(folder("nine-before"), "fixture", "corten", "page", "load-container-before.json"), "utf8"));
  assert.deepEqual(before.windowEnv, observedNine);
  assert.equal(before.id, early.ids[`${base}-k6`]);
  // Docker's inspect of the load after it ran reports WINDOWS=9 for the 8 the pass asked for.
  const fake = fakeDocker({ exportFor: () => k6Export(flat(8)), inspected: (info, c, state) => (c.kind === "k6" && state.startIssuedMs !== null ? nine(info) : info) });
  const s = await run(fake, options, folder("nine"));
  assert.equal(s.cells[0].failure, "settings");
  assert.ok(fake.calls.some((c) => loadStarted(c.args, fake)), "the load ran");
  const receipt = JSON.parse(readFileSync(join(folder("nine"), "fixture", "corten", "page", "load-container.json"), "utf8"));
  assert.deepEqual(receipt.windowEnv, observedNine);
  // The inspect before it started matched, and its receipt is kept too.
  assert.deepEqual(JSON.parse(readFileSync(join(folder("nine"), "fixture", "corten", "page", "load-container-before.json"), "utf8")).windowEnv,
    { requested: { WINDOWS: "8", WINDOW_SECONDS: "15" }, observed: { WINDOWS: ["8"], WINDOW_SECONDS: ["15"] } });
});

test("a load whose inspect before it starts has no readable environment or host settings fails `settings` with its receipt kept, and starts no load", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t54", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  const canary = "canary-value-not-saved";
  // [name, the change to the load's inspect before it starts, the setting the message names]
  const cases = [
    ["env-null", (info) => ({ ...info, Config: { ...info.Config, Env: null } }), "environment"],
    ["env-string", (info) => ({ ...info, Config: { ...info.Config, Env: `VUS=${canary}` } }), "environment"],
    ["env-entry", (info) => ({ ...info, Config: { ...info.Config, Env: [...info.Config.Env, null, { canary }] } }), "environment"],
    // Only the owner labels left (a Config of null fails the ownership check first, `container`).
    ["config-labels-only", (info) => ({ ...info, Config: { Labels: info.Config.Labels } }), "environment"],
    ["host-null", (info) => ({ ...info, HostConfig: null }), "CPU quota"],
    ["mounts-null", (info) => ({ ...info, Mounts: null, Config: { ...info.Config, Env: null } }), "environment"],
  ];
  for (const [name, change, what] of cases) {
    const fake = fakeDocker({ exportFor: () => k6Export(flat(8)), inspected: (info, c, state) => (c.kind === "k6" && state.startIssuedMs === null ? change(info) : info) });
    const s = await run(fake, options, folder(name));
    assert.equal(s.cells[0].failure, "settings", `${name}: ${JSON.stringify(s.cells[0])}`);
    assert.ok(errorsOf(folder(name)).includes(`the load container's ${what} is not the one this pass records`), name);
    assert.ok(!fake.calls.some((c) => loadStarted(c.args, fake)), `${name}: no load started`);
    // The receipt is kept, as a fixed note with the load's ID and the window settings, never the malformed values.
    const text = readFileSync(join(folder(name), "fixture", "corten", "page", "load-container-before.json"), "utf8");
    assert.ok(!text.includes(canary), name);
    const receipt = JSON.parse(text);
    assert.equal(receipt.id, fake.ids[`${base}-k6`], name);
    assert.deepEqual(receipt.windowEnv.requested, { WINDOWS: "8", WINDOW_SECONDS: "15" }, name);
    assert.equal(s.complete, true, name);
    validateConvergence(s);
  }
});

test("the live watcher starts no load on a first marker start the reader would refuse", async (t) => {
  const folder = folderOf(t);
  const app = "a".repeat(64), marker = "b".repeat(64);
  // A start row whose time is not one, then nothing: marker(1) is never satisfied.
  for (const nanos of ["not-a-time", "0", "01"]) {
    const plain = { listeners: [] }, client = eventsClient(plain);
    const stream = eventStream({ app, marker, file: folder(`bad-${nanos}.log`), spawn: client.spawn, markerMs: 30, graceMs: 5, boundMs: 50 });
    plain.listeners[0](marker, "start", nanos);
    await assert.rejects(stream.marker(1), /did not show the marker's start 1 within 30 ms/, nanos);
    await stream.stop();
  }
  // A pass whose first marker start row has no valid time: no load starts, and the cell has no reading.
  const options = parseSteadyArgs(["convergence", "t53", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  const fake = fakeDocker({ exportFor: () => k6Export(flat(8)) });
  let rewritten = false;
  const rewrite = (row) => {
    const [id, action] = row.split("|");
    if (!rewritten && action === "start" && id === fake.ids[`${base}-corten-marker`]) { rewritten = true; return [`${id}|start|not-a-time`]; }
    return [row];
  };
  const s = await run(fake, options, folder("malformed-marker"), { spawnEvents: eventsClient(fake, { rewrite }).spawn });
  assert.ok(rewritten);
  assert.equal(s.cells[0].failure, "unconfirmed", JSON.stringify(s.cells[0]));
  assert.ok(!fake.calls.some((c) => loadStarted(c.args, fake)), "no load started");
  assert.match(errorsOf(folder("malformed-marker")), /docker events did not show the marker's start 1 within 200 ms/);
});

test("a cell whose event stream lost an update still has a reading, and its saved text and report say the stream can drop events", async (t) => {
  const folder = folderOf(t);
  const convergence = parseSteadyArgs(["convergence", "t54", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  const soak = parseSteadyArgs(["soak", "t55", "--apps", "corten", "--sources", "fixture", "--targets", "page"], apps, groupApps);
  for (const [name, options] of [["convergence", convergence], ["soak", soak]]) {
    // The app is updated during the load and undone before the inspect after it; Docker's stream,
    // with both marker starts and the fence, drops that update row as it may for a slow subscriber.
    const fake = fakeDocker({ ...(options.kind === "soak" ? { exportFor: () => soakExport(), clockMs: 1_800_000, loadMs: 50 } : { exportFor: () => k6Export(flat(8)) }),
      duringLoad: (state) => state.emit(state.ids[`${base}-corten`], "update") });
    const client = eventsClient(fake, { drop: (row) => row.includes("|update|") });
    const s = await sampled(fake, options, folder(name), { env: pinnedEnv, spawnEvents: client.spawn });
    assert.equal(s.complete, true, name);
    assert.equal(s.cells[0].failure, undefined, `${name}: ${JSON.stringify(s.cells[0])}`);
    (options.kind === "soak" ? validateSoak : validateConvergence)(s);
    const events = JSON.parse(readFileSync(join(folder(name), "fixture", "corten", "page", "events.json"), "utf8"));
    assert.deepEqual([events.stream, events.updates], ["read", []], `${name}: the update was not observed`);
    // What the reading rests on is saved with the pass, limit included, and the report prints it.
    const checks = s.measurement.containerChecks;
    assert.match(checks ?? "", /Docker can drop events for a slow subscriber without ending the stream/, name);
    assert.match(checks, /not proof that none happened/, name);
    const report = steadyReport(s);
    assert.ok(report.split("\n").includes(`Container checks (every cell has a reading): ${checks}.`), name);
    // Nothing in the report says the stream showed there was no update, or that it covered the load.
    assert.doesNotMatch(report, /with no update of those containers|so it covered the load|held through the load/, name);
    if (options.kind === "soak") assert.equal(s.cells[0].restarts.eventStream, "none-seen");
  }
});

test("an app kill delivered after the marker's second start and before the fence is teardown: the cell keeps its reading, and the saved text says only qualifying app events were checked", async (t) => {
  const folder = folderOf(t);
  const convergence = parseSteadyArgs(["convergence", "t56", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  const soak = parseSteadyArgs(["soak", "t57", "--apps", "corten", "--sources", "fixture", "--targets", "page"], apps, groupApps);
  for (const [name, options] of [["convergence", convergence], ["soak", soak]]) {
    const fake = fakeDocker(options.kind === "soak" ? { exportFor: () => soakExport(), clockMs: 1_800_000, loadMs: 50 } : { exportFor: () => k6Export(flat(8)) });
    // The app's kill, stamped a nanosecond after the marker's second start (so after the load's
    // FinishedAt) and delivered before that start's exit, the fence.
    let starts = 0, kill = null;
    const rewrite = (row) => {
      const [id, action, nanos] = row.split("|");
      if (id !== fake.ids[`${base}-corten-marker`] || action !== "start" || ++starts !== 2) return [row];
      kill = `${fake.ids[`${base}-corten`]}|kill|${BigInt(nanos) + 1n}`;
      return [row, kill];
    };
    const s = await sampled(fake, options, folder(name), { env: pinnedEnv, spawnEvents: eventsClient(fake, { rewrite }).spawn });
    assert.ok(kill !== null, name);
    assert.equal(s.complete, true, name);
    assert.equal(s.cells[0].failure, undefined, `${name}: ${JSON.stringify(s.cells[0])}`);
    (options.kind === "soak" ? validateSoak : validateConvergence)(s);
    if (options.kind === "convergence") assert.equal(s.cells[0].verdict.withinTolerance, true, name);
    else assert.equal(s.cells[0].restarts.eventStream, "none-seen", name);
    // The stream delivered the kill and events.log keeps it; the reader left it out as teardown.
    const raw = join(folder(name), "fixture", "corten", "page");
    assert.ok(readFileSync(join(raw, "events.log"), "utf8").split("\n").includes(kill), `${name}: events.log keeps the kill`);
    assert.deepEqual(JSON.parse(readFileSync(join(raw, "events.json"), "utf8")).events, [], `${name}: the kill is not read`);
    // So the saved text claims only that no qualifying app event was observed, never that the
    // stream delivered none, and says what qualifies as the reader does.
    const checks = s.measurement.containerChecks;
    assert.doesNotMatch(checks, /delivered no update of them and no start, restart, die, kill or OOM of the upstream \(nor, for a convergence cell, of the app\)/, name);
    assert.match(checks, /for a convergence cell, no qualifying start, restart, die, kill or OOM of the app: one delivered before the marker's second start or stamped at or before the load finished; a later one is teardown, is not read and stays in events\.log/, name);
    assert.ok(steadyReport(s).split("\n").includes(`Container checks (every cell has a reading): ${checks}.`), name);
  }
});