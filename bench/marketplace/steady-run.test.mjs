// steady-run.mjs against a fake Docker and a fake docker stats client, like alert-probe-run.test.mjs:
// the real runner, ownedResources and k6 readers, with no daemon, k6 or app.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventStream, memorySampler, runSteady } from "./steady-run.mjs";
import { convergenceLines, eventFormat, intervalSchedule, ownerLabelKey, parseSteadyArgs, timedStartup, validateConvergence, validateSoak } from "./steady-contract.mjs";
import { steadyReport } from "./steady-report.mjs";
import { resultSchema } from "./run-contract.mjs";
import { groupApps } from "./groups.mjs";
import { apps } from "./contract.mjs";
import { k6Image } from "../load-tool.mjs";
import { runClock } from "./alert-probe-run.mjs";

const commit = "c".repeat(40);
const k6ImageId = `sha256:${"5".repeat(64)}`, upstreamImageId = `sha256:${"4".repeat(64)}`;
const appImageId = (image) => `sha256:${createHash("sha256").update(image).digest("hex")}`;
const quiet = () => {};
const pinnedEnv = { MARKETPLACE_APP_CPUS: "1", MARKETPLACE_LOAD_CPUS: "4-7", MARKETPLACE_API_CPUS: "2-3" };

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
 * only appears once the pass is over); `failRemove(name)` fails every removal of that container;
 * `oomOnLoad` marks the app OOM-killed when the load ends; `restartOnLoad` restarts it in place (a
 * docker restart: the same ID and RestartCount, a new StartedAt). Its clock is the runner's
 * (`now`): a load run moves it on by `startupMs` before the container's StartedAt and by `runMs`
 * (by default the engine clock `clockMs`, written to the clock file) before its FinishedAt.
 * `override(args, state)` answers a command first: an Error is thrown, a string returned, undefined
 * leaves it to the daemon. It publishes container events (start, and the app's oom, die or kill when
 * the load does that to it, or `duringLoad(state)` emits) to every events client listening, as
 * `emit(id, action)`; `inspected(info, container)` may change an inspect answer.
 */
function fakeDocker({ exportFor, withhold = () => false, failRemove = () => false, oomOnLoad = false, restartOnLoad = false, loadMs = 0, clockMs = 120_000, runMs = clockMs, startupMs = 0, override = () => undefined,
  duringLoad = () => {}, inspected = (info) => info } = {}) {
  const containers = new Map(), networks = new Map(), calls = [], late = [];
  let next = 1;
  const id = () => (next++).toString(16).padStart(64, "0");
  const labelsOf = (args) => Object.fromEntries(args.flatMap((a, i) => (a === "--label" ? [[args[i + 1].slice(0, args[i + 1].indexOf("=")), args[i + 1].slice(args[i + 1].indexOf("=") + 1)]] : [])));
  const role = (name) => (name.endsWith("-host") ? "host" : name.endsWith("-upstream") ? "upstream" : name.endsWith("-probe") ? "probe" : name.endsWith("-marker") ? "marker" : name.endsWith("-k6-version") ? "version" : name.endsWith("-k6") ? "k6" : "app");
  const matches = (labels, filter) => { const pair = filter.slice("label=".length), at = pair.indexOf("="); return labels[pair.slice(0, at)] === pair.slice(at + 1); };
  const byName = (name) => [...containers.values()].find((c) => c.name === name);
  const info = (c) => ({ Id: c.id, Name: `/${c.name}`, Image: c.imageId, RestartCount: 0, Config: { Labels: c.labels, Env: c.args.flatMap((a, i) => (a === "-e" ? [c.args[i + 1]] : [])), Image: c.image, Cmd: null }, State: c.state,
    HostConfig: { Memory: 0, NanoCpus: 0, CpuPeriod: 0, CpuQuota: 0, CpusetCpus: "", NetworkMode: "bridge", Ulimits: null }, Mounts: [],
    NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "49153" }] } } });
  const get = (cid) => { const c = containers.get(cid); if (!c) throw new Error(`Error: No such container: ${cid}`); return c; };
  const filterOf = (args) => args[args.indexOf("--filter") + 1];
  // ids: the ID each create made, by name, including a withheld one.
  const state = { containers, networks, calls, late, ids: {}, offset: 0, startIssuedMs: null, listeners: [] };
  state.now = () => Date.now() + state.offset;
  state.emit = (cid, action) => { const nanos = (BigInt(state.now()) * 1_000_000n).toString(); for (const listener of state.listeners) listener(cid, action, nanos); };
  state.app = () => [...containers.values()].find((c) => c.kind === "app");
  const iso = () => new Date(state.now()).toISOString();
  state.docker = async (args, options = {}) => {
    calls.push({ args, cleanup: options.cleanup === true });
    const answer = override(args, state);
    if (answer instanceof Error) throw answer;
    if (typeof answer === "string") return answer;
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
        if (rest[0] !== "-a") { const c = get(rest[0]); c.state = { Running: c.kind !== "marker", OOMKilled: false, ExitCode: 0, StartedAt: iso() }; state.emit(c.id, "start"); if (c.kind === "marker") state.emit(c.id, "die"); return c.id; }
        const c = get(rest[1]);
        if (c.kind === "host") { c.state = { Running: false, OOMKilled: false, ExitCode: 0, StartedAt: iso() }; return "6.8.0-test\nmodel name\t: Synthetic CPU\n0-7"; }
        if (c.kind === "version") { assert.deepEqual(c.args.slice(-2), [k6ImageId, "version"]); c.state = { Running: false, OOMKilled: false, ExitCode: 0, StartedAt: iso() }; return "k6 v2.4.0 (commit/0000000, go1.24, linux/amd64)"; }
        assert.equal(c.kind, "k6");
        state.startIssuedMs = state.now();
        state.offset += startupMs;
        const startedAt = iso();
        await new Promise((resolve) => setTimeout(resolve, loadMs));
        state.offset += runMs + 5;
        c.state = { Running: false, OOMKilled: false, ExitCode: 0, StartedAt: startedAt, FinishedAt: iso() };
        if (oomOnLoad) for (const app of containers.values()) if (app.kind === "app") { app.state = { ...app.state, Running: false, OOMKilled: true, ExitCode: 137 }; state.emit(app.id, "oom"); state.emit(app.id, "die"); }
        if (restartOnLoad) for (const app of containers.values()) if (app.kind === "app") { app.state = { ...app.state, StartedAt: iso() }; state.emit(app.id, "restart"); }
        duringLoad(state);
        return "";
      }
      case "logs": {
        const c = get(rest[0]);
        if (c.kind !== "probe") return "app log";
        const app = byName(c.name.slice(0, -"-probe".length));
        return app?.state.Running ? `catalog-probe-ready\n${JSON.stringify({ first200At: new Date(Date.parse(app.state.StartedAt) + 5).toISOString() })}` : "catalog-probe-ready";
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
const run = (fake, options, folder, extra = {}) => runSteady({ options, folder, runId: "marketplace-test-run", docker: fake.docker, git, env: {}, window: 30, clock: runClock({ now: fake.now }),
  fixture: () => "f".repeat(64), upstreamReady: async () => {}, print: quiet, spawnEvents: eventsClient(fake).spawn, eventBounds: { markerMs: 200, graceMs: 5, boundMs: 50 }, ...extra });
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
  assert.deepEqual(s.cleanup, { complete: true, remaining: { containers: [], networks: [] }, created: 10, removed: 10, recovered: 0, failures: 0, unacknowledged: [] });
  assert.deepEqual([s.host.kernel, s.host.cpu, s.host.onlineCpus, s.fixtureSha256, s.tools.upstream.imageId, s.tools.k6.imageId], ["6.8.0-test", "Synthetic CPU", "0-7", "f".repeat(64), upstreamImageId, k6ImageId]);
  // The k6 version came from an owned container, created, attached and removed by ID: no docker run.
  assert.equal(s.tools.k6.version, "2.4.0");
  assert.ok(!fake.calls.some((c) => c.args[0] === "run"), "no untracked docker run");
  const version = fake.ids["marketplace-test-run-k6-version"];
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
  assert.equal(cleanup.complete, true); assert.deepEqual(cleanup.remaining, { containers: [], networks: [] });
  assert.equal(fake.containers.size, 0); assert.equal(fake.networks.size, 0);
  // A round with the same inputs is like-for-like with what the runner recorded.
  const round = { schema: resultSchema, commit, options: { warmup: 10, startupTimeout: 120 }, host: { cpu: s.host.cpu, release: s.host.kernel, onlineCpus: s.host.onlineCpus }, measurement: s.measurement,
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
  const fake = fakeDocker({ exportFor: () => k6Export(flat(8)), withhold: (name) => name === "marketplace-test-run-k6" });
  const s = await run(fake, options, folder("withheld"));
  assert.equal(s.complete, false);
  assert.equal(s.cells[0].failure, "container");
  assert.deepEqual(s.failures, [{ stage: "suite", code: "unsettled" }]);
  const errors = errorsOf(folder("withheld"));
  assert.match(errors, /context deadline exceeded/);
  assert.match(errors, /corten fixture page did not settle \(the create of marketplace-test-run-k6 was not acknowledged\), so no further cell is measured/);
  assert.equal(s.cells.length, 1, "aspnet was not measured");
  assert.ok(!fake.calls.some((c) => c.args[0] === "create" && c.args[2] === "marketplace-test-run-aspnet"));
  const cleanup = cleanupOf(folder("withheld"));
  assert.equal(cleanup.complete, false);
  assert.deepEqual(cleanup.remaining, { containers: [], networks: [] }, "the scans found nothing, and that is not taken as clean");
  assert.deepEqual(cleanup.unacknowledged.map((a) => [a.name, a.outcome]), [["marketplace-test-run-k6", "unconfirmed"]]);
  assert.ok(cleanup.failures.some((f) => /cleanup is unconfirmed/.test(f.error)));
  assert.equal(s.cleanup.complete, false);
  assert.ok(s.cleanup.failures > 0);
  assert.deepEqual(s.cleanup.unacknowledged.map((a) => [a.name, a.outcome]), [["marketplace-test-run-k6", "unconfirmed"]]);
  // The cell's own app was removed before the pass stopped.
  const corten = fake.calls.find((c) => c.args[0] === "create" && c.args[2] === "marketplace-test-run-corten");
  assert.ok(corten && !fake.containers.size);
});

test("a load container that cannot be removed still has its app removed, and no further cell is measured", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t5", "--apps", "corten,aspnet", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  const fake = fakeDocker({ exportFor: () => k6Export(flat(8)), failRemove: (name) => name === "marketplace-test-run-k6" });
  const s = await run(fake, options, folder("stuck"));
  assert.equal(s.complete, false);
  // The cell itself measured; its teardown is what failed.
  assert.equal(s.cells[0].verdict.withinTolerance, true);
  assert.deepEqual(s.failures, [{ stage: "suite", code: "unsettled" }]);
  assert.match(errorsOf(folder("stuck")), /corten fixture page did not settle \(container [0-9a-f]{64} was not removed\), so no further cell is measured/);
  // The app's removal is attempted after the load container's failed one, before the pass stops.
  const removals = fake.calls.map((c, index) => ({ index, args: c.args })).filter((c) => c.args[0] === "rm");
  const firstK6 = removals.find((r) => r.args[3] === fake.ids["marketplace-test-run-k6"]), appRemoval = removals.find((r) => r.args[3] === fake.ids["marketplace-test-run-corten"]);
  assert.ok(firstK6 && appRemoval && appRemoval.index > firstK6.index);
  assert.ok(appRemoval.index < fake.calls.findIndex((c) => c.args[0] === "ps" && c.args.includes(`label=${ownerLabelKey}=marketplace-test-run`)), "before the teardown sweep");
  assert.ok([...fake.containers.values()].every((c) => c.name === "marketplace-test-run-k6"), "only the stuck load container is left");
  assert.ok(!fake.calls.some((c) => c.args[0] === "create" && c.args[2] === "marketplace-test-run-aspnet"));
  assert.ok(cleanupOf(folder("stuck")).failures.some((f) => f.resource === fake.ids["marketplace-test-run-k6"] || /marketplace-test-run-k6/.test(f.resource)));
  assert.ok(s.cleanup.failures > 0);
});

/**
 * A docker events client on the fake daemon: from the moment it is spawned it writes each event the
 * daemon publishes for a container in its filters as `id|action|nanos`, in order, unless
 * `drop(row, index)` withholds it; it closes when signalled unless `holds`.
 */
function eventsClient(fake, { drop = () => false, holds = false } = {}) {
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
    let index = 0;
    fake.listeners.push((id, action, nanos) => {
      const row = `${id}|${action}|${nanos}`;
      if (!child.ended && ids.includes(id) && !drop(row, index++)) child.stdout.write(`${row}\n`);
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
  const stats = statsClient({ delayMs: 10, rows: (args) => Array.from({ length: 180 }, (_, i) => ({ ID: args.at(-1), Name: "marketplace-test-run-corten", CPUPerc: "1.00%", MemUsage: `${100 + i}MiB / 1GiB` })) });
  const s = await run(fake, options, folder("soak"), { spawnStats: stats.spawn, statsBounds: { now: () => fake.startIssuedMs + 10_000 * tick++ } });
  assert.equal(s.complete, true, JSON.stringify([s.failures, s.cells]));
  validateSoak(s);
  const [cell] = s.cells;
  assert.deepEqual([cell.memory.samples, cell.memory.startMiB, cell.memory.endMiB, cell.rate.held, cell.failedRequests, cell.restarts.restarted, cell.requests], [180, 102.5, 276.5, true, 0, false, 270_000]);
  assert.deepEqual(stats.spawned.map((x) => x.args), [["stats", "--no-trunc", "--format", "{{json .}}", fake.ids["marketplace-test-run-corten"]]]);
  assert.ok(!stats.spawned[0].args.includes("marketplace-test-run-corten"));
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
  assert.deepEqual([cell.restarts.restarted, cell.restarts.runningAtEnd, cell.restarts.oomKilled], [true, false, true]);
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
  assert.throws(() => memorySampler({ ids: ["marketplace-test-run-corten"], file: folder("x.log"), seconds: 10, spawn: statsClient().spawn }), /immutable container IDs/);
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
  const cold = fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args) => args[0] === "wait" ? "1" : args[0] === "logs" && args[1] === cold.ids["marketplace-test-run-corten-probe"] ? `catalog-probe-ready\n${canary} ${token}` : undefined });
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
  const stuck = fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args, state) => args[0] === "rm" && args[3] === state.ids["marketplace-test-run-k6"] ? new Error(`docker rm -f: exit 1\n${canary} ${token}`) : undefined });
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
  const longCpu = `Synthetic ${"X".repeat(96)}`;
  // Docker's server version with a suffix outside its pattern, a host probe whose kernel, CPU model
  // and online CPUs carry text outside theirs, k6's version output with trailing text (the version
  // itself matches the pin), and an extra repository digest on the k6 image.
  const fake = fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args, state) => {
    if (args[0] === "version") return `27.5.1 <${token}>`;
    if (args[0] === "start" && args[1] === "-a" && args[2] === state.ids["marketplace-test-run-host"]) return `6.8.0-test ${token}\nmodel name\t: Synthetic <${token}>\n0-7;${token}`;
    if (args[0] === "start" && args[1] === "-a" && args[2] === state.ids["marketplace-test-run-k6-version"]) return `k6 v2.4.0 (commit/${token}, go1.24, linux/amd64)`;
    if (args[0] === "image" && args[2] === k6Image) return JSON.stringify([{ Id: k6ImageId, Os: "linux", Architecture: "amd64", RepoDigests: [k6Image, `example.com/${token}@sha256:${"e".repeat(64)}`] }]);
    return undefined;
  } });
  const s = await run(fake, options, folder("canary"));
  assert.equal(s.complete, true, JSON.stringify(s.failures));
  validateConvergence(s);
  assert.deepEqual([s.host.docker, s.host.kernel, s.host.cpu, s.host.onlineCpus], [null, null, null, null]);
  assert.deepEqual(s.tools.k6, { imageId: k6ImageId, version: "2.4.0" });
  const text = readFileSync(join(folder("canary"), "summary.json"), "utf8");
  assert.ok(!text.includes(token) && !text.includes("example.com"), text);
  // The raw files keep what Docker, the host and k6 said.
  assert.ok(readFileSync(join(folder("canary"), "docker-version.txt"), "utf8").includes(token));
  assert.ok(readFileSync(join(folder("canary"), "host.txt"), "utf8").includes(token));
  const k6 = readFileSync(join(folder("canary"), "k6.json"), "utf8");
  assert.ok(k6.includes(token) && k6.includes("example.com"));
  // A CPU model longer than its pattern allows is not recorded either, and the report says so.
  const long = await run(fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args, state) =>
    args[0] === "start" && args[1] === "-a" && args[2] === state.ids["marketplace-test-run-host"] ? `6.8.0-test\nmodel name\t: ${longCpu}\n0-7` : undefined }), options, folder("long"));
  assert.deepEqual([long.host.kernel, long.host.cpu, long.host.onlineCpus], ["6.8.0-test", null, "0-7"]);
  assert.match(steadyReport(long), /CPU: not recorded \(online CPUs 0-7\)/);
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
    const id = state.ids["marketplace-test-run-upstream"];
    if (args[0] === "start" && args[1] === id) state.containers.get(id).imageId = odd;
    return undefined;
  } }), options, folder("upstream"));
  assert.deepEqual([upstream.complete, upstream.failures, upstream.tools.upstream], [false, [{ stage: "suite", code: "tools" }], null]);
  assert.ok(!readFileSync(join(folder("upstream"), "summary.json"), "utf8").includes("leaked-canary"));
  // A k6 version with text in place of its patch number does not match the pin: a tools failure.
  const k6 = await run(fakeDocker({ exportFor: () => k6Export(flat(8)), override: (args, state) =>
    args[0] === "start" && args[1] === "-a" && args[2] === state.ids["marketplace-test-run-k6-version"] ? "k6 v2.4.leaked-canary" : undefined }), options, folder("k6"));
  assert.deepEqual([k6.complete, k6.failures, k6.tools], [false, [{ stage: "suite", code: "tools" }], null]);
  assert.ok(!readFileSync(join(folder("k6"), "summary.json"), "utf8").includes("leaked-canary"));
});

test("a soak reads restarts from a live event stream only when it shows it covered the load; a clean-looking stream without that is not a no", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["soak", "t12", "--apps", "corten", "--sources", "fixture", "--targets", "page"], apps, groupApps);
  const soak = async (name, { drop, spawnEvents, ...extra } = {}) => {
    let tick = 0;
    const fake = fakeDocker({ exportFor: () => soakExport(), clockMs: 1_800_000, loadMs: 50, ...extra });
    const client = eventsClient(fake, { drop });
    const stats = statsClient({ delayMs: 10, rows: (args) => Array.from({ length: 180 }, () => ({ ID: args.at(-1), Name: "x", CPUPerc: "1.00%", MemUsage: "100MiB / 1GiB" })) });
    const s = await run(fake, options, folder(name), { spawnStats: stats.spawn, statsBounds: { now: () => fake.startIssuedMs + 10_000 * tick++ }, spawnEvents: spawnEvents ?? client.spawn });
    assert.equal(s.complete, true, JSON.stringify([s.failures, s.cells]));
    validateSoak(s);
    return { s, fake, client, r: s.cells[0].restarts };
  };
  // Covered and clean: the stream showed the marker's start before the load and again after the
  // app's last inspect, with no app event between. It is the live stream, never a --since replay.
  const clean = await soak("clean");
  assert.deepEqual([clean.r.eventStream, clean.r.events, clean.r.restarted], ["clean", [], false]);
  const app = clean.fake.ids["marketplace-test-run-corten"], marker = clean.fake.ids["marketplace-test-run-corten-marker"];
  assert.deepEqual(clean.client.spawned.map((x) => x.args), [["events", "--filter", "type=container", "--filter", `container=${app}`, "--filter", `container=${marker}`, "--format", eventFormat]]);
  assert.ok(!clean.fake.calls.some((c) => c.args[0] === "events"), "no retrospective docker events query");
  const at = (predicate) => clean.fake.calls.findIndex(predicate), last = (predicate) => clean.fake.calls.findLastIndex(predicate);
  const markerStarts = clean.fake.calls.flatMap((c, i) => (c.args[0] === "start" && c.args[1] === marker ? [i] : []));
  assert.equal(markerStarts.length, 2);
  assert.ok(markerStarts[0] < at((c) => c.args[0] === "start" && c.args[1] === "-a" && c.args[2] === clean.fake.ids["marketplace-test-run-k6"]), "the first marker start is before the load");
  // The app's snapshot after the load is its first inspect once k6's export has been copied out.
  const copied = last((c) => c.args[0] === "cp"), afterInspect = clean.fake.calls.findIndex((c, i) => i > copied && c.args[0] === "container" && c.args.at(-1) === app);
  assert.ok(afterInspect > copied && markerStarts[1] > afterInspect, "the second marker start is after the app's snapshot after the load");
  assert.ok(clean.fake.calls.some((c) => c.args[0] === "rm" && c.args.at(-1) === marker), "the marker is removed by its ID");
  // A kill during the load is seen.
  const seen = await soak("seen", { duringLoad: (state) => state.emit(state.app().id, "kill") });
  assert.deepEqual([seen.r.eventStream, seen.r.events.map((e) => e.action), seen.r.restarted], ["seen", ["kill"], true]);
  // Streams that look clean (no app event at all) but do not show coverage: nothing delivered, the
  // first marker start missed (listening only after the load began), or the second one missing.
  const nth = (n) => { let starts = 0; return (row) => row.includes("|start|") && ++starts === n; };
  for (const [name, drop] of [["silent", () => true], ["late", nth(1)], ["no-end", nth(2)]]) {
    const { s, r } = await soak(name, { drop });
    assert.deepEqual([r.eventStream, r.events, r.restarted], ["unavailable", [], null], name);
    assert.match(steadyReport(s), /\| not established: the event stream was unavailable or did not cover the load, and nothing else showed a restart \|$/m, name);
    assert.equal(s.cells[0].memory.startMiB, 100, "memory is still read");
  }
  // The runner waits for each marker start (readEvents also refuses a saved stream without both).
  assert.match(errorsOf(folder("silent")), /docker events: Error: docker events did not show the marker's start 1 within 200 ms/);
  assert.match(errorsOf(folder("late")), /docker events: Error: docker events did not show the marker's start 1 within 200 ms/);
  assert.match(errorsOf(folder("no-end")), /docker events: Error: docker events did not show the marker's start 2 within 200 ms/);
  // A row that is not an action and a time makes the whole stream unavailable, and is not saved.
  const odd = await soak("malformed", { duringLoad: (state) => state.emit(state.app().id, "Leaked Canary") });
  assert.deepEqual([odd.r.eventStream, odd.r.restarted], ["unavailable", null]);
  assert.match(errorsOf(folder("malformed")), /1 docker events row is not this soak's app or marker, an action and a time/);
  assert.ok(!readFileSync(join(folder("malformed"), "summary.json"), "utf8").includes("Canary"));
  // The same unreadable stream with the app OOM-killed: the OOM and stop observations still make it a restart.
  const oom = await soak("oom", { oomOnLoad: true, duringLoad: (state) => state.emit(state.app().id, "Leaked Canary") });
  assert.deepEqual([oom.r.eventStream, oom.r.restarted, oom.r.oomKilled, oom.r.runningAtEnd], ["unavailable", true, true, false]);
  // A covered stream shows the OOM and the die as events.
  const oomSeen = await soak("oom-seen", { oomOnLoad: true });
  assert.deepEqual([oomSeen.r.eventStream, oomSeen.r.events.map((e) => e.action), oomSeen.r.restarted], ["seen", ["oom", "die"], true]);
  // A client that cannot run at all.
  const broken = () => { const child = new EventEmitter(); Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill() { return true; } }); setImmediate(() => { child.emit("error", Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" })); child.emit("close", -2); }); return child; };
  const failed = await soak("failed", { spawnEvents: broken });
  assert.deepEqual([failed.r.eventStream, failed.r.restarted], ["unavailable", null]);
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
  assert.ok(!fake.calls.some((c) => c.args[0] === "create" && c.args[2] === "marketplace-test-run-k6"), "no load ran");
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
  const afterColdStart = (state) => state.ids["marketplace-test-run-corten-probe"] && ![...state.containers.values()].some((c) => c.kind === "probe");
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
  assert.throws(() => eventStream({ app: "marketplace-test-run-corten", marker, file: folder("x.log"), spawn: statsClient().spawn }), /immutable container IDs/);
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