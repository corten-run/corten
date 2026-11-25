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
import { memorySampler, runSteady } from "./steady-run.mjs";
import { convergenceLines, ownerLabelKey, parseSteadyArgs, timedStartup, validateConvergence, validateSoak } from "./steady-contract.mjs";
import { resultSchema } from "./run-contract.mjs";
import { groupApps } from "./groups.mjs";
import { apps } from "./contract.mjs";
import { k6Image } from "../load-tool.mjs";

const commit = "c".repeat(40);
const k6ImageId = `sha256:${"5".repeat(64)}`, upstreamImageId = `sha256:${"4".repeat(64)}`;
const appImageId = (image) => `sha256:${createHash("sha256").update(image).digest("hex")}`;
const quiet = () => {};

// window-load.js's k6 summary export: `counts` requests per window, each served, plus `graceFailed`
// requests answered with a failure during the graceful stop and `windowFailed` failures in windows.
function k6Export(counts, { graceFailed = 0, windowFailed = {} } = {}) {
  const total = counts.reduce((a, b) => a + b, 0) + graceFailed;
  const failed = graceFailed + Object.values(windowFailed).reduce((a, b) => a + b, 0);
  const latency = { avg: 1, "p(50)": 1, "p(95)": 1, "p(99)": 1, max: 1 };
  const metrics = { http_reqs: { count: total, rate: total / 120 }, iterations: { count: total, rate: 1 }, vus_max: { value: 32, min: 32, max: 32 },
    http_req_duration: latency, iteration_duration: latency, http_req_failed: { passes: failed, fails: total - failed, value: failed / total },
    checks: { passes: 2 * total - failed, fails: failed, value: (2 * total - failed) / (2 * total) } };
  counts.forEach((n, i) => {
    metrics[`window_${i}_requests`] = { count: n, rate: 1 };
    metrics[`window_${i}_duration`] = { avg: 5, "p(50)": 4, "p(95)": 9, "p(99)": 20, max: 30 };
    if (windowFailed[i]) metrics[`window_${i}_failed`] = { count: windowFailed[i], rate: 1 };
  });
  if (graceFailed) metrics.window_tail_requests = { count: graceFailed, rate: 1 };
  return { metrics, root_group: { checks: { "marketplace status 200": { passes: total - failed, fails: failed }, "marketplace content type": { passes: total, fails: 0 } } } };
}

/**
 * A Docker daemon in memory. `exportFor(appName)` gives the k6 summary for the cell whose app has
 * that name; `withhold(name)` makes that create fail after making nothing visible (its container
 * only appears once the pass is over); `failRemove(name)` fails every removal of that container;
 * `oomOnLoad` marks the app OOM-killed when the load ends.
 */
function fakeDocker({ exportFor, withhold = () => false, failRemove = () => false, oomOnLoad = false, loadMs = 0 } = {}) {
  const containers = new Map(), networks = new Map(), calls = [], late = [];
  let next = 1;
  const id = () => (next++).toString(16).padStart(64, "0");
  const labelsOf = (args) => Object.fromEntries(args.flatMap((a, i) => (a === "--label" ? [[args[i + 1].slice(0, args[i + 1].indexOf("=")), args[i + 1].slice(args[i + 1].indexOf("=") + 1)]] : [])));
  const role = (name) => (name.endsWith("-host") ? "host" : name.endsWith("-upstream") ? "upstream" : name.endsWith("-probe") ? "probe" : name.endsWith("-k6") ? "k6" : "app");
  const matches = (labels, filter) => { const pair = filter.slice("label=".length), at = pair.indexOf("="); return labels[pair.slice(0, at)] === pair.slice(at + 1); };
  const byName = (name) => [...containers.values()].find((c) => c.name === name);
  const info = (c) => ({ Id: c.id, Name: `/${c.name}`, Image: c.imageId, RestartCount: 0, Config: { Labels: c.labels, Env: [], Image: c.image, Cmd: null }, State: c.state,
    HostConfig: { Memory: 0, NanoCpus: 0, CpuPeriod: 0, CpuQuota: 0, CpusetCpus: "", NetworkMode: "bridge", Ulimits: null }, Mounts: [],
    NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "49153" }] } } });
  const get = (cid) => { const c = containers.get(cid); if (!c) throw new Error(`Error: No such container: ${cid}`); return c; };
  const filterOf = (args) => args[args.indexOf("--filter") + 1];
  // ids: the ID each create made, by name, including a withheld one.
  const state = { containers, networks, calls, late, ids: {}, k6StartedMs: null };
  state.docker = async (args, options = {}) => {
    calls.push({ args, cleanup: options.cleanup === true });
    const [command, ...rest] = args;
    switch (command) {
      case "version": return "27.5.1";
      case "image": {
        assert.equal(rest[0], "inspect");
        if (rest[1] === k6Image) return JSON.stringify([{ Id: k6ImageId, Os: "linux", Architecture: "amd64", RepoDigests: [k6Image] }]);
        return JSON.stringify([{ Id: appImageId(rest[1]), Size: 1, Config: { Labels: { "run.corten.marketplace.commit": commit, "run.corten.marketplace.dirty": "false" } }, RepoDigests: [] }]);
      }
      case "run": return "k6 v2.4.0 (commit/0000000, go1.24, linux/amd64)";
      case "create": {
        assert.equal(rest[0], "--name");
        const name = rest[1], kind = role(name), image = kind === "app" ? args.at(-1) : null;
        const c = { id: id(), name, kind, labels: labelsOf(args), args, image: image ?? "fixed", imageId: kind === "app" ? image : kind === "k6" ? k6ImageId : upstreamImageId,
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
      case "container": assert.equal(rest[0], "inspect"); return JSON.stringify([info(get(rest[1]))]);
      case "ps": { const f = filterOf(args); return [...containers.values()].filter((c) => (f.startsWith("id=") ? c.id === f.slice(3) : matches(c.labels, f))).map((c) => c.id).join("\n"); }
      case "start": {
        if (rest[0] !== "-a") { const c = get(rest[0]); c.state = { Running: true, OOMKilled: false, ExitCode: 0, StartedAt: new Date().toISOString() }; return c.id; }
        const c = get(rest[1]);
        const startedAt = new Date().toISOString();
        if (c.kind === "host") { c.state = { Running: false, OOMKilled: false, ExitCode: 0, StartedAt: startedAt }; return "6.8.0-test\nmodel name\t: Synthetic CPU\n0-7"; }
        assert.equal(c.kind, "k6");
        state.k6StartedMs = Date.parse(startedAt);
        await new Promise((resolve) => setTimeout(resolve, loadMs));
        c.state = { Running: false, OOMKilled: false, ExitCode: 0, StartedAt: startedAt, FinishedAt: new Date().toISOString() };
        if (oomOnLoad) for (const app of containers.values()) if (app.kind === "app") app.state = { ...app.state, Running: false, OOMKilled: true, ExitCode: 137 };
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
        writeFileSync(rest[1], JSON.stringify(rest[0].endsWith("summary.json") ? exportFor(app.name, c) : { testRunDurationMs: 120_000 }));
        return "";
      }
      case "events": return "";
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
const run = (fake, options, folder, extra = {}) => runSteady({ options, folder, runId: "marketplace-test-run", docker: fake.docker, git, env: {}, window: 30,
  fixture: () => "f".repeat(64), upstreamReady: async () => {}, print: quiet, ...extra });
const flat = (n, rps = 1000, seconds = 15) => Array(n).fill(rps * seconds);
const isId = (value) => /^[0-9a-f]{64}$/.test(value);

test("a convergence pass starts each cell with the timed round's cold start and records what like-for-like needs", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t1", "--apps", "corten", "--sources", "fixture", "--minutes", "2", "--label", "agent.owner=codex"], apps, groupApps);
  const fake = fakeDocker({ exportFor: () => k6Export(flat(8)) });
  const s = await run(fake, options, folder("c"));
  assert.equal(s.complete, true, JSON.stringify(s.failures));
  validateConvergence(s);
  assert.deepEqual(s.cells.map((c) => [c.target, c.verdict.flattened, c.verdict.window, c.failedRequests]), [["page", true, 0, 0], ["json", true, 0, 0]]);
  assert.equal(s.startup, timedStartup);
  assert.deepEqual([s.host.kernel, s.host.cpu, s.host.onlineCpus, s.fixtureSha256, s.tools.upstream.imageId, s.tools.k6.imageId], ["6.8.0-test", "Synthetic CPU", "0-7", "f".repeat(64), upstreamImageId, k6ImageId]);
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
  for (const c of fake.calls.filter((x) => ["create", "run"].includes(x.args[0]) || (x.args[0] === "network" && x.args[1] === "create"))) {
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
  const round = { schema: resultSchema, commit, options: { warmup: 10 }, host: { cpu: s.host.cpu, release: s.host.kernel, onlineCpus: s.host.onlineCpus }, measurement: s.measurement,
    fixtureSha256: s.fixtureSha256, tools: s.tools, apps: { corten: { imageId: s.images.corten } } };
  assert.match(convergenceLines(round, ["corten"], s)[1], /^The pass is like-for-like with this round/);
});

test("a failure answered during k6's graceful stop, or in a window, gives the cell no verdict", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t2", "--apps", "corten", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  // Every window served; three 500s completed after the last window, during the graceful stop.
  const grace = await run(fakeDocker({ exportFor: () => k6Export(flat(8), { graceFailed: 3 }) }), options, folder("grace"));
  assert.equal(grace.cells[0].verdict, null);
  assert.match(grace.cells[0].failure, /3 requests failed in k6's aggregate, which includes the graceful stop; no verdict/);
  assert.equal(grace.complete, true); validateConvergence(grace);
  const inWindow = await run(fakeDocker({ exportFor: () => k6Export(flat(8), { windowFailed: { 2: 5 } }) }), options, folder("window"));
  assert.match(inWindow.cells[0].failure, /5 requests failed in the pass's windows; no verdict/);
});

test("a convergence cell whose app was OOM-killed during the load gets no verdict", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t3", "--apps", "corten", "--sources", "fixture", "--targets", "json", "--minutes", "2"], apps, groupApps);
  const s = await run(fakeDocker({ exportFor: () => k6Export(flat(8)), oomOnLoad: true }), options, folder("oom"));
  assert.equal(s.cells[0].verdict, null);
  assert.match(s.cells[0].failure, /stopped, restarted or was OOM-killed.*"oomKilled":true/);
});

test("a create whose ID Docker withholds is not reported clean, and no further cell is measured", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["convergence", "t4", "--apps", "corten,aspnet", "--sources", "fixture", "--targets", "page", "--minutes", "2"], apps, groupApps);
  // The first cell's load container: the daemon errors, and the container it made only appears
  // after the pass's final scans.
  const fake = fakeDocker({ exportFor: () => k6Export(flat(8)), withhold: (name) => name === "marketplace-test-run-k6" });
  const s = await run(fake, options, folder("withheld"));
  assert.equal(s.complete, false);
  assert.match(s.cells[0].failure, /context deadline exceeded/);
  assert.match(s.failures[0].error, /corten fixture page did not settle \(the create of marketplace-test-run-k6 was not acknowledged\), so no further cell is measured/);
  assert.equal(s.cells.length, 1, "aspnet was not measured");
  assert.ok(!fake.calls.some((c) => c.args[0] === "create" && c.args[2] === "marketplace-test-run-aspnet"));
  const cleanup = JSON.parse(readFileSync(join(folder("withheld"), "cleanup.json"), "utf8"));
  assert.equal(cleanup.complete, false);
  assert.deepEqual(cleanup.remaining, { containers: [], networks: [] }, "the scans found nothing, and that is not taken as clean");
  assert.deepEqual(cleanup.unacknowledged.map((a) => [a.name, a.outcome]), [["marketplace-test-run-k6", "unconfirmed"]]);
  assert.ok(s.cleanupFailures.some((f) => /cleanup is unconfirmed/.test(f.error)));
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
  assert.equal(s.cells[0].verdict.flattened, true);
  assert.match(s.failures[0].error, /corten fixture page did not settle \(container [0-9a-f]{64} was not removed\), so no further cell is measured/);
  // The app's removal is attempted after the load container's failed one, before the pass stops.
  const removals = fake.calls.map((c, index) => ({ index, args: c.args })).filter((c) => c.args[0] === "rm");
  const firstK6 = removals.find((r) => r.args[3] === fake.ids["marketplace-test-run-k6"]), appRemoval = removals.find((r) => r.args[3] === fake.ids["marketplace-test-run-corten"]);
  assert.ok(firstK6 && appRemoval && appRemoval.index > firstK6.index);
  assert.ok(appRemoval.index < fake.calls.findIndex((c) => c.args[0] === "ps" && c.args.includes(`label=${ownerLabelKey}=marketplace-test-run`)), "before the teardown sweep");
  assert.ok([...fake.containers.values()].every((c) => c.name === "marketplace-test-run-k6"), "only the stuck load container is left");
  assert.ok(!fake.calls.some((c) => c.args[0] === "create" && c.args[2] === "marketplace-test-run-aspnet"));
  assert.ok(s.cleanupFailures.some((f) => /marketplace-test-run-k6/.test(f.resource)));
});

// A docker stats client: emits `rows(args)` shortly after it starts; closes when signalled unless `holds`.
function statsClient({ rows = () => [], holds = false } = {}) {
  const spawned = [];
  const spawn = (binary, args) => {
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kills: [], unref() { child.unrefed = true; } });
    child.kill = (signal = "SIGTERM") => {
      child.kills.push(signal);
      if (!holds && !child.ended) { child.ended = true; child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit("close", null)); }
      return true;
    };
    setTimeout(() => { if (!child.ended) for (const row of rows(args)) child.stdout.write(`${JSON.stringify(row)}\n`); }, 2);
    spawned.push({ binary, args, child });
    return child;
  };
  return { spawn, spawned };
}

test("a soak samples its app's memory by the container's ID", async (t) => {
  const folder = folderOf(t);
  const options = parseSteadyArgs(["soak", "t6", "--apps", "corten", "--sources", "fixture", "--targets", "page"], apps, groupApps);
  const fake = fakeDocker({ exportFor: () => k6Export(Array(30).fill(150 * 60)), loadMs: 30 });
  // 180 samples 10 s apart from the load's start, by the k6 engine's clock: 100 MiB, then 120 MiB from 15 min.
  let tick = 0;
  const stats = statsClient({ rows: (args) => Array.from({ length: 180 }, (_, i) => ({ ID: args.at(-1), Name: "marketplace-test-run-corten", CPUPerc: "1.00%", MemUsage: `${i < 90 ? 100 : 120}MiB / 1GiB` })) });
  const s = await run(fake, options, folder("soak"), { spawnStats: stats.spawn, statsBounds: { now: () => fake.k6StartedMs + 10_000 * tick++ } });
  assert.equal(s.complete, true, JSON.stringify([s.failures, s.cells]));
  validateSoak(s);
  const [cell] = s.cells;
  assert.deepEqual([cell.memory.samples, cell.memory.startMiB, cell.memory.endMiB, cell.rate.met, cell.failedRequests, cell.restarts.restarted], [180, 100, 120, true, 0, false]);
  assert.deepEqual(stats.spawned.map((x) => x.args), [["stats", "--no-trunc", "--format", "{{json .}}", fake.ids["marketplace-test-run-corten"]]]);
  assert.ok(!stats.spawned[0].args.includes("marketplace-test-run-corten"));
});

test("the memory sampler refuses names and settles at its bound when something holds its pipes", async (t) => {
  const folder = folderOf(t);
  const id = "a".repeat(64);
  assert.throws(() => memorySampler({ ids: ["marketplace-test-run-corten"], file: folder("x.log"), seconds: 10, spawn: statsClient().spawn }), /immutable container IDs/);
  // A row keyed by anything but the sampled ID is an error, not a sample.
  const named = statsClient({ rows: () => [{ ID: "marketplace-test-run-corten", CPUPerc: "1%", MemUsage: "1MiB / 1GiB" }] });
  const sampler = memorySampler({ ids: [id], file: folder("named.log"), seconds: 10, spawn: named.spawn });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(sampler.stop(), /unexpected stats container marketplace-test-run-corten/);
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
