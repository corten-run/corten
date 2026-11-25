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
// before or after the daemon acts, to model a failed command or a lost acknowledgement, or leave the
// daemon acting only when the test calls docker.land(): "late" times out, "late-error" answers with a
// daemon error as if the upstream response was lost after the create was dispatched. Each command
// takes 10 ms of the fake clock; a fault may spend more.
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
    if (outcome === "late" || outcome === "late-error") {
      late.push(() => act(args, docker.results));
      if (outcome === "late-error") throw Object.assign(new Error(`docker ${args[0]} ${args[1]}: exit 1\nError response from daemon: Bad Gateway`), { status: 1 });
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
  assert.deepEqual(outcome.cleanup.remaining, { containers: 0, networks: 0 });
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

test("a name collision with a foreign container is refused and the foreign container is never touched", async (t) => {
  const docker = fakeDocker();
  const foreign = { id: randomBytes(32).toString("hex"), name: "alert-probe-test-fixture", labels: { other: "owner" }, args: [] };
  docker.containers.set(foreign.id, foreign);
  const outcome = await probeRun(t, docker);
  assert.equal(outcome.passed, false);
  assert.match(outcome.errors.join("\n"), /fixture: [^]*Error response from daemon: Conflict[^]*already in use/);
  // An error from the daemon is not proof the create had no effect: it is looked for by its own
  // label, which the foreign container does not carry, and its cleanup stays unconfirmed.
  assert.deepEqual(outcome.cleanup.unacknowledged.map((e) => [e.kind, e.name, e.outcome]), [["container", "alert-probe-test-fixture", "unconfirmed"]]);
  assert.ok(docker.containers.has(foreign.id), "the foreign container survives");
  assert.ok(!docker.calls.some(({ args }) => args.includes(foreign.id)), "the run never inspected, logged or removed it");
  assert.equal(outcome.cleanup.complete, false);
  assert.deepEqual(outcome.cleanup.remaining, { containers: 0, networks: 0 }, "nothing this run acknowledged remains");
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
  assert.deepEqual(retried.cleanup.remaining, { containers: 0, networks: 0 });
  assert.equal(flaky.containers.size + flaky.networks.size, 0);
  // Always fails: it stays, and so does the network it is attached to; both are reported.
  const stuck = fakeDocker({ faults: {
    rm: (args, { containers }) => containers.get(args[3])?.name === "alert-probe-test-api" ? new Error("docker rm: exit 1\ndevice or resource busy") : "run",
    "network rm": (_, { containers }) => [...containers.values()].some((c) => c.name === "alert-probe-test-api") ? new Error("network has active endpoints") : "run",
  } });
  const failed = await probeRun(t, stuck);
  assert.equal(failed.passed, false);
  assert.equal(failed.cleanup.complete, false);
  assert.deepEqual(failed.cleanup.remaining, { containers: 1, networks: 1 });
  assert.ok(failed.cleanup.failures.some((f) => /survived teardown/.test(f.error)));
  assert.equal(stuck.containers.size, 1);
  assert.equal(stuck.networks.size, 1);
  assert.match(failed.errors.join("\n"), /teardown failed/);
  checkCalls(stuck);
});

test("only an empty lookup by ID is absence: another full ID leaves the removal unconfirmed and fails the teardown", async () => {
  for (const kind of ["container", "network"]) {
    const docker = fakeDocker(), other = randomBytes(32).toString("hex");
    let target = null;
    // A daemon that answers the lookup by the target's own ID with another valid ID.
    const lying = Object.assign(async (args, opts) => (target && args.includes(`id=${target}`) ? other : docker(args, opts)), { time: docker.time });
    const owned = ownedResources({ docker: lying, runId: "alert-probe-test", window: 50, clock: runClock({ now: () => docker.time.t, sleep: async (ms) => { docker.time.t += ms; } }) });
    target = kind === "network" ? await owned.network("alert-probe-test-net") : await owned.container(["app"], "alert-probe-test-app");
    assert.equal(await owned.remove(target), false, kind);
    assert.ok(owned.has(target), `${kind}: still pending`);
    assert.ok((kind === "network" ? docker.networks : docker.containers).has(target), `${kind}: nothing was removed`);
    assert.ok(!docker.calls.some(({ args }) => args.includes("rm")), `${kind}: no removal was sent`);
    assert.deepEqual(owned.record.removed, []);
    assert.equal(owned.record.failures[0].error, `a docker ${kind} lookup by ID ${target} returned another object; its removal is unconfirmed`);
    assert.ok(!JSON.stringify(owned.record).includes(other), "the other ID is not kept");
    const record = await owned.teardown();
    assert.equal(record.complete, false, `${kind}: the teardown fails`);
  }
  // Positive: a resource already gone answers the lookup with nothing, and that is absence.
  const docker = fakeDocker();
  const owned = ownedResources({ docker, runId: "alert-probe-test", window: 50, clock: runClock({ now: () => docker.time.t, sleep: async (ms) => { docker.time.t += ms; } }) });
  const id = await owned.container(["app"], "alert-probe-test-app");
  docker.containers.delete(id);
  assert.equal(await owned.remove(id), true);
  assert.deepEqual(owned.record.removed.map((e) => e.id), [id]);
  assert.deepEqual(owned.record.failures, []);
  assert.equal((await owned.teardown()).complete, true);
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
  // It looked for the attempt's own label across the window (its last quarter second kept for the
  // final lookup), and never by name.
  const looks = docker.calls.filter(({ args }) => args.includes(`label=${attempt.label}`));
  assert.ok(looks.length > 1 && looks.at(-1).at - looks[0].at >= 1700, "the window is searched, not a single scan");
  for (const { at, timeout } of looks) assert.ok(at + timeout <= looks[0].at + 2000, "each lookup ends inside the window");
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

test("a create answered with a daemon error is not acknowledged: what it makes late is still accounted for", async (t) => {
  // The daemon made the network but its answer was lost upstream and came back as an HTTP error;
  // the network becomes visible only after teardown has looked.
  const after = fakeDocker({ faults: { "network create": () => "late-error" } });
  const unseen = await probeRun(t, after);
  assert.equal(unseen.passed, false);
  assert.match(unseen.errors.join("\n"), /Error response from daemon: Bad Gateway/);
  assert.equal(unseen.cleanup.complete, false, "a daemon error does not prove the create had no effect");
  assert.deepEqual(unseen.cleanup.unacknowledged.map((e) => [e.kind, e.name, e.outcome]), [["network", "alert-probe-test-net", "unconfirmed"]]);
  assert.ok(after.calls.some(({ args }) => args.includes(`label=${unseen.cleanup.unacknowledged[0].label}`)), "it was looked for by its own label");
  after.land();
  assert.equal(after.networks.size, 1, "the network does land later, as the receipt warned");
  // Visible within the window: found by its label and removed by ID.
  let looks = 0;
  const within = fakeDocker({ faults: {
    "network create": () => "late-error",
    "network ls": (args, { land }) => { if (args.some((arg) => arg.startsWith(`label=${attemptKey}=`)) && ++looks === 2) land(); },
  } });
  const found = await probeRun(t, within);
  assert.equal(found.passed, false);
  assert.deepEqual(found.cleanup.unacknowledged.map((e) => [e.kind, e.outcome]), [["network", "removed"]]);
  assert.equal(found.cleanup.complete, true);
  assert.equal(within.networks.size, 0);
  checkCalls(within);
});

test("a refused create leaves a foreign resource with its name alone", async (t) => {
  const docker = fakeDocker();
  docker.networks.set("f".repeat(64), { id: "f".repeat(64), name: "alert-probe-test-net", labels: {} });
  const outcome = await probeRun(t, docker);
  assert.equal(outcome.passed, false);
  assert.deepEqual(outcome.cleanup.unacknowledged.map((e) => [e.kind, e.outcome]), [["network", "unconfirmed"]]);
  assert.equal(outcome.cleanup.complete, false);
  assert.ok(docker.networks.has("f".repeat(64)), "the foreign network survives");
  assert.ok(!docker.calls.some(({ args }) => args.includes("f".repeat(64))), "the run never inspected or removed it");
});

test("each label lookup ends inside the reconcile window, and the receipt's window is the one searched", async (t) => {
  // Every lookup for the attempt's label hangs until its own deadline.
  const docker = fakeDocker({ faults: {
    "network create": () => "late",
    "network ls": (args, _, opts, time) => {
      if (!args.some((arg) => arg.startsWith(`label=${attemptKey}=`))) return "run";
      time.t += opts.timeout;
      return new Error(`docker network ls: timeout after ${opts.timeout} ms`);
    },
  } });
  const outcome = await probeRun(t, docker, { window: 2000 });
  const looks = docker.calls.filter(({ args }) => args.some((arg) => arg.startsWith(`label=${attemptKey}=`)));
  assert.ok(looks.length >= 1);
  const start = looks[0].at, end = start + 2000;
  for (const { at, timeout } of looks) assert.ok(at + timeout <= end, `a lookup at ${at} ms with ${timeout} ms could outlast the window ending at ${end} ms`);
  // Teardown goes on to its owner-label sweep as soon as the window is over.
  const sweep = docker.calls.find(({ args, at }) => at > start && args[0] === "ps" && args.includes(`label=${ownerKey}=alert-probe-test`));
  assert.ok(sweep && sweep.at <= end + 10, `the sweep started at ${sweep?.at} ms, after the ${end} ms window end`);
  assert.equal(outcome.cleanup.complete, false);
  assert.ok(outcome.cleanup.failures.some((f) => /in 2000 ms/.test(f.error)));
  checkCalls(docker);
});

test("a failed label lookup is kept, and the owner-label sweep still removes containers before networks", async (t) => {
  // The upstream is made but its acknowledgement is lost; the one lookup for its attempt label fails.
  const docker = fakeDocker({ faults: {
    create: (args) => args[2] === "alert-probe-test-upstream" ? "lose" : "run",
    ps: (args) => args.some((arg) => arg.startsWith(`label=${attemptKey}=`)) ? new Error("docker ps: exit 1\nCannot connect to the Docker daemon") : "run",
  } });
  const outcome = await probeRun(t, docker);
  assert.equal(outcome.passed, false);
  assert.ok(outcome.cleanup.failures.some((f) => f.resource === `unacknowledged creates labelled ${attemptKey}` && f.error === "a docker container listing failed; its output is not kept"), "the lookup failure is kept");
  assert.ok(!JSON.stringify(outcome.cleanup).includes("Cannot connect"), "its client's diagnostic is not");
  assert.deepEqual(outcome.cleanup.recovered.map((e) => e.kind), ["container"], "the owner-label sweep found the container");
  assert.deepEqual(outcome.cleanup.remaining, { containers: 0, networks: 0 });
  assert.equal(docker.containers.size + docker.networks.size, 0);
  assert.equal(docker.calls.filter(({ args }) => args[0] === "network" && args[1] === "rm").length, 1, "the network was removed once, after its container");
  assert.equal(outcome.cleanup.complete, false, "the attempt's own lookup failed, so its cleanup is not confirmed");
  checkCalls(docker);
});

test("a cleanup listing with a noncanonical ID is refused before anything in it is inspected, and nothing of it is kept", async () => {
  // Plausible canaries: one hex digit short or long of an ID, an uppercase ID, and a name-like token.
  for (const odd of ["e".repeat(63), "e".repeat(65), "E".repeat(64), "marketplace-canary-7f3a"]) {
    const docker = fakeDocker();
    // The owner-label sweep's listing also returns an entry that is not a full 64-hex ID.
    const listing = Object.assign(async (args, opts) => {
      const out = await docker(args, opts);
      return args[0] === "ps" && args.includes(`label=${ownerKey}=alert-probe-test`) ? [out, odd].filter(Boolean).join("\n") : out;
    }, { calls: docker.calls });
    const owned = ownedResources({ docker: listing, runId: "alert-probe-test" });
    const network = await owned.network("alert-probe-test-net");
    await owned.container(["--network", network, "img"], "alert-probe-test-app");
    const record = await owned.teardown();
    assert.ok(!docker.calls.some(({ args }) => args.includes(odd)), `nothing was inspected or removed as ${odd}`);
    assert.ok(record.failures.some((f) => f.error === "a docker container listing returned 1 entry that is not a full container or network ID; nothing in it is inspected or removed"), JSON.stringify(record.failures));
    // Neither the entry nor the filter that produced it reaches the record (cleanup.json) or an error.
    const saved = JSON.stringify(record);
    assert.ok(!saved.includes(odd) && !saved.toLowerCase().includes(odd.toLowerCase().slice(0, 40)), "the record does not echo the listing entry");
    assert.ok(!record.failures.some((f) => f.error.includes(`label=${ownerKey}`)), "the record does not echo the listing filter");
    assert.equal(record.complete, false);
    // What the run created was still removed by its own ID.
    assert.equal(docker.containers.size + docker.networks.size, 0);
    checkCalls(docker);
  }
  // The same run with an ordinary listing completes.
  const docker = fakeDocker(), owned = ownedResources({ docker, runId: "alert-probe-test" });
  await owned.container(["--network", await owned.network("alert-probe-test-net"), "img"], "alert-probe-test-app");
  assert.equal((await owned.teardown()).complete, true);
});

test("a foreign full ID in an owner-label listing is never removed, and neither the cleanup record nor its errors name it", async () => {
  const docker = fakeDocker();
  // A canonical 64-hex ID of a container this run did not create, which the sweep's listing returns.
  const foreign = randomBytes(32).toString("hex");
  docker.containers.set(foreign, { id: foreign, name: "someone-else", labels: { other: "owner" }, args: [] });
  const sweep = `label=${ownerKey}=alert-probe-test`;
  const listing = Object.assign(async (args, opts) => {
    const out = await docker(args, opts);
    return args[0] === "ps" && args.includes(sweep) ? [out, foreign].filter(Boolean).join("\n") : out;
  }, { calls: docker.calls, time: docker.time });
  const owned = ownedResources({ docker: listing, runId: "alert-probe-test" });
  const network = await owned.network("alert-probe-test-net");
  const app = await owned.container(["--network", network, "img"], "alert-probe-test-app");
  const record = await owned.teardown();
  assert.ok(docker.containers.has(foreign), "the foreign container survives");
  assert.ok(!docker.calls.some(({ args }) => args[0] === "rm" && args.includes(foreign)), "it was never removed");
  assert.equal(record.complete, false);
  assert.ok(!JSON.stringify(record).includes(foreign), `the record names the foreign ID: ${JSON.stringify(record)}`);
  assert.deepEqual(record.remaining, { containers: 1, networks: 0 }, "what survived is counted, not listed");
  assert.ok(record.failures.some((f) => f.error === "refusing unowned container; its ID is not kept"), JSON.stringify(record.failures));
  assert.ok(record.failures.some((f) => f.error === "owned resources survived teardown: 1 container and 0 networks"), JSON.stringify(record.failures));
  // What the run created is still removed, and named, by its own ID.
  assert.deepEqual(record.removed.map((e) => e.id).sort(), [network, app].sort());
  assert.equal(docker.containers.size + docker.networks.size, 1);
  checkCalls(docker);
});

test("a failed listing keeps a fixed message, never the client's diagnostic or the filter it echoes", async () => {
  const canary = "listing-canary-5d1e";
  const sweep = `label=${ownerKey}=alert-probe-test`;
  // Both owner-label listings fail with a diagnostic that echoes their filter and a canary.
  const docker = fakeDocker({ faults: {
    ps: (args) => args.includes(sweep) ? Object.assign(new Error(`docker ps -a: exit 1\nError response from daemon: invalid filter '${sweep}' ${canary}`), { status: 1 }) : "run",
    "network ls": (args) => args.includes(sweep) ? Object.assign(new Error(`docker network ls: exit 1\nError response from daemon: invalid filter '${sweep}' ${canary}`), { status: 1 }) : "run",
  } });
  const owned = ownedResources({ docker, runId: "alert-probe-test" });
  await owned.container(["--network", await owned.network("alert-probe-test-net"), "img"], "alert-probe-test-app");
  const record = await owned.teardown();
  const saved = JSON.stringify(record);
  assert.ok(!saved.includes(canary), `the record keeps the client's diagnostic: ${saved}`);
  assert.ok(!saved.includes("label=") && !saved.includes("Error response"), `the record keeps the echoed filter: ${saved}`);
  assert.ok(record.failures.some((f) => f.error === "a docker container listing failed (exit 1); its output is not kept"), JSON.stringify(record.failures));
  assert.ok(record.failures.some((f) => f.error === "a docker network listing failed (exit 1); its output is not kept"), JSON.stringify(record.failures));
  assert.equal(record.remaining, null, "nothing could be counted");
  assert.equal(record.complete, false);
  // What the run created was still removed by its own ID.
  assert.equal(docker.containers.size + docker.networks.size, 0);
  checkCalls(docker);
});
test("an answer from Docker that is not the confirmation expected is refused with a fixed message that does not quote it", async () => {
  const canary = "f".repeat(65);
  // Each case changes one answer: an rm that confirms something else, an inspect naming another
  // object, and an inspect that is not JSON.
  const cases = [
    [(args) => args[0] === "rm" ? canary : undefined, /^docker rm did not confirm [0-9a-f]{64}$/],
    [(args) => args[0] === "container" && args[1] === "inspect" ? JSON.stringify([{ Id: canary, Config: { Labels: {} } }]) : undefined, /^container [0-9a-f]{64}: inspect returned a different object$/],
    [(args) => args[0] === "container" && args[1] === "inspect" ? `${canary} {` : undefined, /^docker container inspect returned output that is not JSON$/],
  ];
  for (const [answer, expected] of cases) {
    const docker = fakeDocker();
    let created = false;
    const lying = Object.assign(async (args, opts) => {
      const out = await docker(args, opts);
      return created ? (answer(args) ?? out) : out;
    }, { calls: docker.calls });
    const owned = ownedResources({ docker: lying, runId: "alert-probe-test" });
    await owned.container(["img"], "alert-probe-test-app");
    created = true;
    const record = await owned.teardown();
    assert.equal(record.complete, false);
    assert.ok(record.failures.some((f) => expected.test(f.error)), JSON.stringify(record.failures));
    assert.ok(!JSON.stringify(record).includes(canary), "the record does not quote Docker's answer");
  }
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
  // Keys outside the owner key's dot-delimited namespace are ordinary, even with the same literal prefix.
  const outside = [`${ownerKey}suffix=x`, `${ownerKey}-other=y`];
  const outcome = await probeRun(t, docker, { labels: ["--label", "ci.run=123", "--label", "ci.job=parity", ...outside.flatMap((label) => ["--label", label])] });
  assert.equal(outcome.passed, true, outcome.errors.join("\n"));
  const creates = docker.calls.filter(({ args }) => args[0] === "create" || args.slice(0, 2).join(" ") === "network create");
  assert.equal(creates.length, 6);
  for (const { args } of creates) {
    const labels = args.flatMap((arg, i) => (args[i - 1] === "--label" ? [arg] : []));
    assert.deepEqual(labels.filter((label) => label.startsWith(`${ownerKey}=`)), [`${ownerKey}=alert-probe-test`]);
    for (const label of ["ci.run=123", "ci.job=parity", ...outside]) assert.ok(labels.includes(label), label);
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

test("what an attempt's label found is removed, or confirmed absent, by its own ID even when the owner-label sweep leaves it out", async () => {
  for (const kind of ["container", "network"]) {
    for (const removable of [true, false]) {
      const at = `${kind} ${removable ? "removed" : "stuck"}`;
      // The create's answer is lost after the daemon made it, and the owner-label sweep's listing omits it.
      const docker = fakeDocker({ faults: {
        [kind === "network" ? "network create" : "create"]: () => "lose",
        ...(removable ? {} : { [kind === "network" ? "network rm" : "rm"]: () => new Error("Error response from daemon: device or resource busy") }),
      } });
      const sweep = `label=${ownerKey}=alert-probe-test`;
      const omitting = Object.assign(async (args, opts) => ((args[0] === "ps" || args[1] === "ls") && args.includes(sweep) ? "" : docker(args, opts)), { time: docker.time });
      const owned = ownedResources({ docker: omitting, runId: "alert-probe-test", window: 50, clock: runClock({ now: () => docker.time.t, sleep: async (ms) => { docker.time.t += ms; } }) });
      await assert.rejects(kind === "network" ? owned.network("alert-probe-test-net") : owned.container(["app"], "alert-probe-test-app"), /lost acknowledgement/);
      const [made] = (kind === "network" ? docker.networks : docker.containers).keys();
      const record = await owned.teardown();
      const [attempt] = record.unacknowledged;
      assert.equal(attempt.found, 1, at);
      // Every removal and lookup of it is by its own ID.
      assert.ok(docker.calls.some(({ args }) => args.includes(`id=${made}`)), `${at}: looked up by its ID`);
      if (removable) {
        assert.equal(attempt.outcome, "removed", at);
        assert.deepEqual(record.recovered.map((e) => e.id), [made], at);
        assert.equal(record.complete, true, at);
        assert.equal(docker.containers.size + docker.networks.size, 0, at);
      } else {
        assert.equal(attempt.outcome, "not removed", at);
        assert.equal(record.complete, false, `${at}: a found ID neither removed nor confirmed absent leaves cleanup incomplete`);
        assert.ok(record.failures.some((f) => f.resource.includes(attempt.label) && /not each removed or confirmed absent by its own ID/.test(f.error)), at);
      }
    }
  }
  // Already gone when teardown looks it up by its ID: that is confirmed absence, and complete.
  const docker = fakeDocker({ faults: { create: () => "lose" } });
  const sweep = `label=${ownerKey}=alert-probe-test`;
  let made = null;
  const vanishing = Object.assign(async (args, opts) => {
    if (args[0] === "ps" && args.includes(sweep)) { if (made) docker.containers.delete(made); return ""; }
    return docker(args, opts);
  }, { time: docker.time });
  const owned = ownedResources({ docker: vanishing, runId: "alert-probe-test", window: 50, clock: runClock({ now: () => docker.time.t, sleep: async (ms) => { docker.time.t += ms; } }) });
  await assert.rejects(owned.container(["app"], "alert-probe-test-app"), /lost acknowledgement/);
  [made] = docker.containers.keys();
  const record = await owned.teardown();
  assert.deepEqual([record.unacknowledged[0].outcome, record.complete], ["removed", true]);
  assert.ok(!docker.calls.some(({ args }) => args[0] === "rm"), "nothing to remove");
});

// A network an attempt's label found is removed by its ID even when the owner-label listing of
// networks fails, as a container is; the failed listing still leaves cleanup incomplete.
test("a network an attempt's own label found is removed by its ID even when the owner-label listing of networks fails", async () => {
  const docker = fakeDocker({ faults: { "network create": () => "lose" } });
  const sweep = `label=${ownerKey}=alert-probe-test`;
  const failing = Object.assign(async (args, opts) => {
    if (args[0] === "network" && args[1] === "ls" && args.includes(sweep)) { docker.time.t += 10; throw new Error("docker network ls: exit 1\nError response from daemon: Bad Gateway"); }
    return docker(args, opts);
  }, { time: docker.time });
  const owned = ownedResources({ docker: failing, runId: "alert-probe-test", window: 50, clock: runClock({ now: () => docker.time.t, sleep: async (ms) => { docker.time.t += ms; } }) });
  await assert.rejects(owned.network("alert-probe-test-net"), /lost acknowledgement/);
  const [made] = docker.networks.keys();
  const record = await owned.teardown();
  const [attempt] = record.unacknowledged;
  assert.deepEqual([attempt.found, attempt.outcome], [1, "removed"]);
  assert.deepEqual(record.recovered.map((e) => e.id), [made]);
  assert.equal(docker.networks.size, 0, "the network its label found is removed");
  assert.ok(docker.calls.some(({ args }) => args.includes(`id=${made}`)), "looked up by its own ID");
  assert.equal(record.complete, false, "the failed listing is still a teardown failure");
  assert.ok(record.failures.some((f) => f.resource === `networks labelled ${record.ownerLabel}`), JSON.stringify(record.failures));
});
