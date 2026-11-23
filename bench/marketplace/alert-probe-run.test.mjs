import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ownedResources, ownerKey, runAlertProbe } from "./alert-probe-run.mjs";
import { probeAlerts } from "./alert-probe.mjs";
import { records } from "./fixtures.mjs";

// An in-memory Docker daemon for the probe runner's ownership and teardown. faults[command] may throw
// before or after the daemon acts, to model a failed command or a lost acknowledgement.
function fakeDocker({ faults = {} } = {}) {
  const containers = new Map(), networks = new Map(), calls = [];
  const id = () => randomBytes(32).toString("hex");
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
      if ([...networks.values()].some((n) => n.name === name)) throw new Error(`network with name ${name} already exists`);
      const n = { id: id(), name, labels: labelsOf(args) }; networks.set(n.id, n); return n.id;
    }
    if (a === "network" && b === "ls") return filter(networks, args[args.indexOf("--filter") + 1]);
    if (a === "network" && b === "inspect") {
      const n = networks.get(args[2]); if (!n) throw new Error(`network ${args[2]} not found`);
      return JSON.stringify([{ Id: n.id, Name: n.name, Labels: n.labels }]);
    }
    if (a === "network" && b === "rm") { assert.ok(networks.delete(args[2]), `no network ${args[2]}`); return args[2]; }
    if (a === "create") {
      const name = args[2];
      if ([...containers.values()].some((c) => c.name === name)) throw new Error(`Conflict. The container name "/${name}" is already in use`);
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
    calls.push({ args, timeout: opts.timeout });
    const fault = faults[args[0] === "network" || args[0] === "container" ? `${args[0]} ${args[1]}` : args[0]];
    const outcome = fault?.(args, docker.state) ?? "run";
    if (outcome instanceof Error) throw outcome;
    const output = act(args, docker.results);
    if (outcome === "lose") throw new Error(`docker ${args[0]}: lost acknowledgement`);
    return output;
  };
  return Object.assign(docker, { containers, networks, calls, state: { containers, networks } });
}

async function probeRun(t, docker, runId = "alert-probe-test") {
  const results = mkdtempSync(join(tmpdir(), "alert-probe-run-"));
  t.after(() => rmSync(results, { recursive: true, force: true }));
  docker.results = results;
  const errors = [];
  const outcome = await runAlertProbe({ image: "app", iterations: 2, results, budget: 60, runId, docker, ready: async () => {}, log: () => {}, error: (m) => errors.push(m) });
  assert.deepEqual(JSON.parse(readFileSync(join(results, "cleanup.json"), "utf8")), outcome.cleanup, "the cleanup receipt is saved");
  return { ...outcome, errors, results };
}
const hex = /^[0-9a-f]{64}$/;
// Every command that targets an existing resource uses its ID, never a name, and every command is bounded.
function checkCalls(docker) {
  for (const { args, timeout } of docker.calls) {
    assert.ok(Number.isFinite(timeout) && timeout > 0, `unbounded docker ${args.join(" ")}`);
    if (["rm", "logs", "start"].includes(args[0]) || ["network rm", "network inspect", "container inspect"].includes(args.slice(0, 2).join(" ")))
      assert.match(args.at(-1), hex, `docker ${args.join(" ")} must target an ID`);
  }
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
  assert.match(outcome.errors.join("\n"), /fixture: .*already in use/);
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
    assert.equal(outcome.cleanup.complete, true);
    assert.equal(docker.containers.size + docker.networks.size, 0);
    checkCalls(docker);
  }
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
