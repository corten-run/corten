import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { attemptKey, ownedResources, ownerKey, runAlertProbe, runClock, teardownReserve } from "./alert-probe-run.mjs";
import { probeAlerts } from "./alert-probe.mjs";
import { records } from "./fixtures.mjs";

// An in-memory Docker daemon for the probe runner's ownership and teardown. faults[command] may throw
// before or after the daemon acts, to model a failed command or a lost acknowledgement, or ("late")
// time out with the daemon acting only when the test calls docker.land(). Each command takes 10 ms
// of the fake clock; a fault may spend more.
function fakeDocker({ faults = {} } = {}) {
  const containers = new Map(), networks = new Map(), calls = [], late = [], time = { t: 0 };
  const id = () => randomBytes(32).toString("hex");
  const refused = (message) => Object.assign(new Error(`docker: exit 1\nError response from daemon: ${message}`), { status: 1 });
  const labelsOf = (args) => Object.fromEntries(args.flatMap((arg, i) => (args[i - 1] === "--label" ? [arg.split(/=(.*)/s).slice(0, 2)] : [])));
  const filter = (items, spec) => {
    const [key, ...rest] = spec.split("="), value = rest.join("=");
    return [...items.values()].filter((item) => key === "id" ? item.id.startsWith(value)
      : key === "label" ? item.labels[value.split("=")[0]] === value.split("=").slice(1).join("=") : false).map((item) => item.id).join("\n");
  };
  const act = (args, results) => {
    const [a, b] = args;
    if (a === "image" || a === "pull") return "";
    if (a === "network" && b === "create") {
      const name = args.at(-1);
      if ([...networks.values()].some((n) => n.name === name)) throw refused(`network with name ${name} already exists`);
      const n = { id: id(), name, labels: labelsOf(args) }; networks.set(n.id, n); return n.id;
    }
    if (a === "network" && b === "ls") return filter(networks, args[args.indexOf("--filter") + 1]);
    if (a === "network" && b === "inspect") {
      const n = networks.get(args[2]); if (!n) throw new Error(`network ${args[2]} not found`);
      return JSON.stringify([{ Id: n.id, Name: n.name, Labels: n.labels }]);
    }
    if (a === "network" && b === "rm") {
      // Docker refuses to remove a network a container is still attached to.
      if ([...containers.values()].some((c) => c.args[c.args.indexOf("--network") + 1] === args[2])) throw refused(`error while removing network: network ${args[2]} has active endpoints`);
      assert.ok(networks.delete(args[2]), `no network ${args[2]}`); return args[2];
    }
    if (a === "create") {
      const name = args[2];
      if ([...containers.values()].some((c) => c.name === name)) throw refused(`Conflict. The container name "/${name}" is already in use`);
      const c = { id: id(), name, labels: labelsOf(args), args, running: false }; containers.set(c.id, c); return c.id;
    }
    if (a === "container" && b === "inspect") {
      const c = containers.get(args[2]); if (!c) throw new Error(`No such container: ${args[2]}`);
      return JSON.stringify([{ Id: c.id, Name: `/${c.name}`, Config: { Labels: c.labels }, NetworkSettings: { Ports: { "8080/tcp": [{ HostPort: "1" }] } } }]);
    }
    if (a === "start" && b === "-a") {
      const c = containers.get(args[2]);
      const script = c.args.indexOf("/repo/bench/marketplace/alert-probe.mjs"), source = c.args[script + 2];
      writeFileSync(join(results, `${source}.json`), JSON.stringify({ passed: true, cases: [{ email: "x", price: "1", passed: 1, failed: 0, ms: { submitted: null } }] }));
      return "";
    }
    if (a === "start") { containers.get(b).running = true; return b; }
    if (a === "logs") return `log of ${containers.get(b).name}`;
    if (a === "ps") return filter(containers, args[args.indexOf("--filter") + 1]);
    if (a === "rm") { assert.ok(containers.delete(args[3]), `no container ${args[3]}`); return args[3]; }
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
  const docker = async (args, opts = {}) => {
    calls.push({ args, timeout: opts.timeout, at: time.t });
    time.t += 10;
    const fault = faults[args[0] === "network" || args[0] === "container" ? `${args[0]} ${args[1]}` : args[0]];
    const outcome = fault?.(args, docker.state, opts, time) ?? "run";
    if (outcome instanceof Error) throw outcome;
    if (outcome === "late") {
      late.push(() => act(args, docker.results));
      time.t += opts.timeout;
      throw new Error(`docker ${args[0]} ${args[1]}: timeout after ${opts.timeout} ms`);
    }
    const output = act(args, docker.results);
    if (outcome === "lose") throw new Error(`docker ${args[0]}: lost acknowledgement`);
    return output;
  };
  // The daemon completes the late creates now.
  const land = () => { for (const create of late.splice(0)) create(); };
  return Object.assign(docker, { containers, networks, calls, time, land, state: { containers, networks, land } });
}

async function probeRun(t, docker, { runId = "alert-probe-test", total = Infinity, budget = 60, window = 2000, labels = [] } = {}) {
  const results = mkdtempSync(join(tmpdir(), "alert-probe-run-"));
  t.after(() => rmSync(results, { recursive: true, force: true }));
  docker.results = results;
  const errors = [];
  const clock = runClock({ total, now: () => docker.time.t, sleep: async (ms) => { docker.time.t += ms; } });
  const readyCalls = [];
  const ready = async (url, timeout) => { readyCalls.push({ url, timeout, at: docker.time.t }); };
  const outcome = await runAlertProbe({ image: "app", iterations: 2, results, budget, labels, runId, docker, ready, clock, window, log: () => {}, error: (m) => errors.push(m) });
  assert.deepEqual(JSON.parse(readFileSync(join(results, "cleanup.json"), "utf8")), outcome.cleanup, "the cleanup receipt is saved");
  return { ...outcome, errors, results, clock, readyCalls };
}
const hex = /^[0-9a-f]{64}$/;
// Every command that targets an existing resource uses its ID, never a name, and every command is
// bounded, within the run's deadline when it has one.
function checkCalls(docker, clock) {
  for (const { args, timeout } of docker.calls) {
    assert.ok(Number.isFinite(timeout) && timeout > 0, `unbounded docker ${args.join(" ")}`);
    if (["rm", "logs", "start"].includes(args[0]) || ["network rm", "network inspect", "container inspect"].includes(args.slice(0, 2).join(" ")))
      assert.match(args.at(-1), hex, `docker ${args.join(" ")} must target an ID`);
    if (args[0] === "create") assert.match(args[args.indexOf("--network") + 1], /^(?:container:)?[0-9a-f]{64}$/, `docker ${args.join(" ")} must join a network by ID`);
  }
  if (clock) for (const { args, timeout, at } of docker.calls) assert.ok(at + timeout <= clock.end, `docker ${args.join(" ")} could outlast the run deadline`);
}

test("alert probe runner removes what it created, each by ID after confirming its owner label", async (t) => {
  const docker = fakeDocker();
  const outcome = await probeRun(t, docker);
  assert.equal(outcome.passed, true, outcome.errors.join("\n"));
  assert.equal(outcome.cleanup.complete, true);
  assert.deepEqual(outcome.cleanup.created.map((e) => [e.kind, e.name]), [["network", "alert-probe-test-net"], ["container", "alert-probe-test-upstream"],
    ["container", "alert-probe-test-fixture"], ["container", "alert-probe-test-fixture-probe"], ["container", "alert-probe-test-api"], ["container", "alert-probe-test-api-probe"]]);
  assert.equal(outcome.cleanup.removed.length, 6);
  assert.deepEqual(outcome.cleanup.remaining, { containers: [], networks: [] });
  assert.equal(docker.containers.size + docker.networks.size, 0);
  for (const c of outcome.cleanup.created) assert.match(c.id, hex);
  // The app and the upstream join the network by the ID its create returned.
  const network = outcome.cleanup.created[0].id;
  assert.deepEqual(docker.calls.filter(({ args }) => args[0] === "create" && !args.includes("/repo/bench/marketplace/alert-probe.mjs"))
    .map(({ args }) => args[args.indexOf("--network") + 1]), [network, network, network]);
  assert.deepEqual(outcome.cleanup.unacknowledged, []);
  // Each probe gets its budget, so a stalled app still leaves diagnostics within the step's deadline.
  assert.ok(docker.calls.some(({ args }) => args[0] === "create" && args.includes("/repo/bench/marketplace/alert-probe.mjs") && args.at(-1) === "60"));
  assert.match(readFileSync(join(outcome.results, "fixture-app.log"), "utf8"), /log of alert-probe-test-fixture/);
  checkCalls(docker);
});

test("a name collision with a foreign container is refused and the foreign container is not removed", async (t) => {
  const docker = fakeDocker();
  const foreign = { id: randomBytes(32).toString("hex"), name: "alert-probe-test-fixture", labels: { other: "owner" }, args: [] };
  docker.containers.set(foreign.id, foreign);
  const outcome = await probeRun(t, docker);
  assert.equal(outcome.passed, false);
  assert.match(outcome.errors.join("\n"), /fixture: [^]*Error response from daemon: Conflict[^]*already in use/);
  assert.deepEqual(outcome.cleanup.unacknowledged, [], "the daemon's refusal acknowledges the create");
  assert.ok(docker.containers.has(foreign.id), "the foreign container survives");
  assert.ok(!docker.calls.some(({ args }) => args.includes(foreign.id)), "the run never inspected, logged or removed it");
  assert.equal(outcome.cleanup.complete, true, "nothing this run created remains");
  assert.ok(!outcome.cleanup.created.some((e) => e.name === foreign.name));
  // Asked directly to remove the foreign ID, the owner check refuses and the refusal fails teardown.
  const owned = ownedResources({ docker, runId: "alert-probe-test" });
  assert.equal(await owned.remove(foreign.id), false);
  assert.ok(docker.containers.has(foreign.id));
  assert.match(owned.record.failures[0].error, /refusing unowned container/);
  checkCalls(docker);
});

test("a failed removal stays pending, is retried and fails the teardown", async (t) => {
  // Fails once: the retry removes it, but the failed attempt is still a teardown failure.
  let once = true;
  const flaky = fakeDocker({ faults: { rm: (args, { containers }) => containers.get(args[3])?.name === "alert-probe-test-api" && once && !(once = false) ? new Error("docker rm: exit 1\ndevice or resource busy") : "run" } });
  const retried = await probeRun(t, flaky);
  assert.equal(retried.passed, false);
  assert.equal(retried.cleanup.complete, false);
  assert.match(retried.cleanup.failures[0].resource, /^container alert-probe-test-api [0-9a-f]{64}$/);
  assert.deepEqual(retried.cleanup.remaining, { containers: [], networks: [] });
  assert.equal(flaky.containers.size + flaky.networks.size, 0);
  // Always fails: it stays, and so does the network it is attached to; both are reported.
  const stuck = fakeDocker({ faults: {
    rm: (args, { containers }) => containers.get(args[3])?.name === "alert-probe-test-api" ? new Error("docker rm: exit 1\ndevice or resource busy") : "run",
    "network rm": (_, { containers }) => [...containers.values()].some((c) => c.name === "alert-probe-test-api") ? new Error("network has active endpoints") : "run",
  } });
  const failed = await probeRun(t, stuck);
  assert.equal(failed.passed, false);
  assert.equal(failed.cleanup.complete, false);
  assert.equal(failed.cleanup.remaining.containers.length, 1);
  assert.equal(failed.cleanup.remaining.networks.length, 1);
  assert.ok(failed.cleanup.failures.some((f) => /survived teardown/.test(f.error)));
  assert.equal(stuck.containers.size, 1);
  assert.equal(stuck.networks.size, 1);
  assert.match(failed.errors.join("\n"), /teardown failed/);
  checkCalls(stuck);
});

test("a resource Docker made before its create failed is recovered by its owner label", async (t) => {
  for (const [faults, registered, recovered] of [
    [{ "network create": () => "lose" }, [], ["network"]],
    [{ create: (args) => args[2] === "alert-probe-test-upstream" ? "lose" : "run" }, ["network"], ["container"]],
  ]) {
    const docker = fakeDocker({ faults });
    const outcome = await probeRun(t, docker);
    assert.equal(outcome.passed, false);
    assert.match(outcome.errors.join("\n"), /lost acknowledgement/);
    assert.deepEqual(outcome.cleanup.created.map((e) => e.kind), registered, "nothing is registered without an acknowledged ID");
    assert.deepEqual(outcome.cleanup.recovered.map((e) => e.kind), recovered);
    assert.deepEqual(outcome.cleanup.unacknowledged.map((e) => [e.kind, e.outcome]), [[recovered[0], "removed"]]);
    assert.equal(outcome.cleanup.complete, true);
    assert.equal(docker.containers.size + docker.networks.size, 0);
    checkCalls(docker);
  }
});

test("a create whose acknowledgement never came is not proven cleaned up by an empty label scan", async (t) => {
  // The daemon makes the network only after teardown has looked: the run must say so and fail.
  const docker = fakeDocker({ faults: { "network create": () => "late" } });
  const outcome = await probeRun(t, docker);
  assert.equal(outcome.passed, false);
  assert.equal(outcome.cleanup.complete, false, "an unacknowledged create is not cleaned up until it is found and removed");
  const [attempt] = outcome.cleanup.unacknowledged;
  assert.deepEqual([attempt.kind, attempt.name, attempt.outcome], ["network", "alert-probe-test-net", "unconfirmed"]);
  assert.match(attempt.label, new RegExp(`^${attemptKey.replaceAll(".", "\\.")}=alert-probe-test-\\d+$`));
  assert.ok(outcome.cleanup.failures.some((f) => f.resource.includes(attempt.label) && /cleanup is unconfirmed/.test(f.error)));
  assert.match(outcome.errors.join("\n"), /teardown failed/);
  // It looked for the attempt's own label for the whole window, and never by name.
  const looks = docker.calls.filter(({ args }) => args.includes(`label=${attempt.label}`));
  assert.ok(looks.length > 1 && looks.at(-1).at - looks[0].at >= 1900, "the window is searched, not a single scan");
  docker.land();
  assert.equal(docker.networks.size, 1, "the network does land later, as the receipt warned");
  checkCalls(docker);
});

test("a late create that lands within the window is found by its own label and removed by ID", async (t) => {
  let looks = 0;
  const docker = fakeDocker({ faults: {
    "network create": () => "late",
    "network ls": (args, { land }) => { if (args.some((arg) => arg.startsWith(`label=${attemptKey}=`)) && ++looks === 2) land(); },
  } });
  const outcome = await probeRun(t, docker);
  assert.equal(outcome.passed, false, "the failed create still fails the run");
  assert.deepEqual(outcome.cleanup.unacknowledged.map((e) => [e.kind, e.outcome]), [["network", "removed"]]);
  assert.deepEqual(outcome.cleanup.recovered.map((e) => e.kind), ["network"]);
  assert.equal(outcome.cleanup.complete, true);
  assert.equal(docker.networks.size, 0);
  checkCalls(docker);
});

test("a refused create is acknowledged: nothing is left to look for", async (t) => {
  const docker = fakeDocker();
  docker.networks.set("f".repeat(64), { id: "f".repeat(64), name: "alert-probe-test-net", labels: {} });
  const outcome = await probeRun(t, docker);
  assert.equal(outcome.passed, false);
  assert.deepEqual(outcome.cleanup.unacknowledged, []);
  assert.equal(outcome.cleanup.complete, true);
  assert.ok(docker.networks.has("f".repeat(64)), "the foreign network survives");
});

test("caller labels cannot set the owner or attempt key, and are refused before any Docker command", async (t) => {
  for (const key of [ownerKey, attemptKey, `${ownerKey}.other`]) {
    const docker = fakeDocker();
    await assert.rejects(probeRun(t, docker, { labels: ["--label", `${key}=someone-else`] }), /reserved for the probe's ownership labels/);
    assert.throws(() => ownedResources({ docker, runId: "r", labels: ["--label", `${key}=x`] }), /reserved/);
    assert.deepEqual(docker.calls, [], `no Docker command for ${key}`);
  }
  for (const labels of [["--name", "x=y"], ["--label"], ["--label", "no value"]]) assert.throws(() => ownedResources({ docker: fakeDocker(), runId: "r", labels }), /KEY=VALUE pairs/);
  // The command line refuses it before it creates the results directory or runs Docker.
  const results = join(mkdtempSync(join(tmpdir(), "alert-probe-cli-")), "results");
  t.after(() => rmSync(join(results, ".."), { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL("./alert-probe-run.mjs", import.meta.url)), "app", "1", results, "--label", `${ownerKey}=x`],
    { encoding: "utf8", env: { ...env, PATH: join(results, "..") } });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /reserved for the probe's ownership labels/);
  assert.ok(!existsSync(results));
});

test("ordinary caller labels go on every resource after one owner label", async (t) => {
  const docker = fakeDocker();
  const outcome = await probeRun(t, docker, { labels: ["--label", "ci.run=123", "--label", "ci.job=parity"] });
  assert.equal(outcome.passed, true, outcome.errors.join("\n"));
  const creates = docker.calls.filter(({ args }) => args[0] === "create" || args.slice(0, 2).join(" ") === "network create");
  assert.equal(creates.length, 6);
  for (const { args } of creates) {
    const labels = args.flatMap((arg, i) => (args[i - 1] === "--label" ? [arg] : []));
    assert.deepEqual(labels.filter((label) => label.startsWith(`${ownerKey}=`)), [`${ownerKey}=alert-probe-test`]);
    assert.ok(labels.includes("ci.run=123") && labels.includes("ci.job=parity"));
  }
  assert.equal(docker.containers.size + docker.networks.size, 0);
  checkCalls(docker);
});

test("a run that spends its deadline starts no more work and still tears down and writes its receipt", async (t) => {
  // Every probe hangs until its attach deadline. With the CI settings (240 s budget, 840 s deadline)
  // the api probe gets what the fixture probe left; with a tighter deadline it is never started.
  for (const [budget, total, apiStarted, removed] of [[240, 840, true, 6], [60, 300, false, 4]]) {
    const docker = fakeDocker({ faults: { start: (args, _, opts, time) => {
      if (args[1] !== "-a") return "run";
      time.t += opts.timeout;
      return new Error(`docker start -a: timeout after ${opts.timeout} ms`);
    } } });
    const outcome = await probeRun(t, docker, { total, budget });
    const errors = outcome.errors.join("\n");
    assert.equal(outcome.passed, false);
    assert.match(errors, /fixture: .*probe wrote no result: docker start -a: timeout/);
    if (!apiStarted) assert.match(errors, /api: .*the run deadline leaves no probe budget/);
    assert.equal(docker.calls.some(({ args }) => args[0] === "create" && args[2] === "alert-probe-test-api"), apiStarted);
    assert.equal(outcome.cleanup.complete, true, JSON.stringify(outcome.cleanup.failures));
    assert.equal(outcome.cleanup.removed.length, removed);
    assert.equal(docker.containers.size + docker.networks.size, 0);
    assert.match(readFileSync(join(outcome.results, "fixture-app.log"), "utf8"), /log of alert-probe-test-fixture/);
    // No work could run into the cleanup reserve, and everything, cleanup included, ended inside the deadline.
    const workEnd = outcome.clock.end - teardownReserve * 1000;
    const attaches = docker.calls.filter(({ args }) => args[0] === "start" && args[1] === "-a");
    assert.equal(attaches.length, apiStarted ? 2 : 1);
    for (const { at, timeout } of [...attaches, ...outcome.readyCalls]) assert.ok(at + timeout <= workEnd);
    assert.ok(attaches.at(-1).at + attaches.at(-1).timeout > workEnd - 1000, "the last probe ran to the edge of the work window");
    assert.ok(docker.time.t <= outcome.clock.end);
    checkCalls(docker, outcome.clock);
  }
});

test("the run deadline must leave its cleanup reserve", () => {
  assert.throws(() => runClock({ total: teardownReserve }), /must exceed/);
  const clock = runClock({ total: teardownReserve + 1, now: () => 0 });
  assert.deepEqual([clock.work(), clock.cleanup()], [1000, (teardownReserve + 1) * 1000]);
});

test("a stalled app log read is bounded and its removal still happens", async (t) => {
  const docker = fakeDocker({ faults: { logs: (_, __) => new Error("docker logs: timeout after 30000 ms") } });
  const outcome = await probeRun(t, docker);
  assert.equal(outcome.passed, true, "a missing diagnostic log does not change the probe's outcome");
  assert.match(readFileSync(join(outcome.results, "api-app.log"), "utf8"), /app log unavailable: docker logs: timeout/);
  assert.equal(docker.containers.size + docker.networks.size, 0);
  assert.ok(docker.calls.filter(({ args }) => args[0] === "logs").every(({ timeout }) => timeout <= 30000));
  checkCalls(docker);
});

test("the owner label is this run's", () => {
  const owned = ownedResources({ docker: async () => "", runId: "r" });
  assert.equal(owned.record.ownerLabel, `${ownerKey}=r`);
});

test("a probe past its budget stops between cases and does not pass", async () => {
  let contexts = 0;
  const browser = { newContext: async () => { contexts++; return { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, newPage: async () => ({ on() {} }), close: async () => {} }; } };
  const result = await probeAlerts({ base: "http://127.0.0.1:1", source: "fixture", catalog: records(), browser, iterations: 10, deadline: Date.now() - 1 });
  assert.deepEqual(result.stopped, { iteration: 0, reason: "budget exhausted" });
  assert.equal(result.passed, false);
  assert.equal(contexts, 1);
  assert.ok(result.cases.every((entry) => entry.passed === 0 && entry.failed === 0));
});
