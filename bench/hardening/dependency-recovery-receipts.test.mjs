import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import test from "node:test";
import { qualificationSettings } from "../marketplace/feature-contract.mjs";
import { readyScript, upstreamSourcePath, verifyOwnedReceipts } from "./evidence.mjs";
import { budgets, parseArgs } from "./plan.mjs";

const runId = "hardening-recovery-proof", stamp = "2026-11-18T00:00:00Z", handling = "dependency-recovery";
const id = (n) => n.toString(16).padStart(64, "0");
const image = (n) => ({ Id: "sha256:" + id(n), Config: { Cmd: ["/server"], Entrypoint: null, Env: [] } });
const labels = { "run.corten.hardening": runId, "agent.owner": "codex", "agent.task": runId };
const node = "/repo/bench/hardening/", base = "http://127.0.0.1:8080", upstream = "http://" + runId + "-cell-upstream:8080";
const qualification = "/results/qualification.json";
const formCommand = ["node", node + "form.mjs", JSON.stringify({ host: "127.0.0.1", port: 8080, authority: "localhost:8080",
  origin: "http://localhost:8080", tls: false }), "/results/form.json"];
const command = (args, stdout = "") => ({ args, stdout, exitCode: 0, timedOut: false, interrupted: false, startedAt: stamp, finishedAt: stamp });
function acknowledge(r) {
  r.creation = command([r.intent.operation, "--name", r.intent.name, ...Object.entries(labels).flatMap(([k, v]) => ["--label", k + "=" + v]),
    ...r.intent.args.slice(1)], r.created.Id);
}

function fixture({ paths = posix, originalFolder = "/native/results/w1", phase = handling, withForm = false, source = "api", triggerName = ".recovery-a1B2c3", offset = 0 } = {}) {
  const cell = { key: "corten/" + source + "/direct/" + phase, app: "corten", source, phase, mode: "direct", status: "observed" };
  const summary = { runId, startedAt: stamp, finishedAt: stamp, originalFolder, options: parseArgs(["w1", "--review", "receipt-fixture"]),
    budget: budgets(), cells: [cell],
    tools: { node: image(1), checker: image(2) }, builds: { corten: { imageId: image(3).Id, image: image(3) } } };
  const harness = paths.join(originalFolder, "corten-build-context"), triggerSource = paths.join(originalFolder, triggerName);
  const delayed = phase !== "request-limit";
  const commands = [
    ["upstream", "upstream", ["node", delayed ? node + "dependency-recovery-upstream.mjs" : "/repo/bench/marketplace/upstream.mjs"]],
    ["application", "applicationDirect", ["/server"]],
    ["ready", "apparatus", ["node", "--input-type=module", "-e", readyScript]],
    ["qualification", "qualification", ["node", node + "qualification.mjs", source, "direct", upstream, qualification]],
    ["native-controls", "qualification", ["node", node + "native.mjs", base, source, upstream, qualification, "/results/native-controls.json"]],
    ["parity", "qualification", ["node", node + "parity.mjs", base, source, upstream, "/results/parity.json"]],
    ...(withForm ? [["form", "qualification", formCommand]] : []),
    ["probe", "apparatus", ["node", node + (phase === handling ? "dependency-recovery-probe.mjs" : "bounded-requests-probe.mjs"), "/results/probe.json", "/results/raw.jsonl"]],
    ...["terminal-clock", "terminal-clock", "cleanup-clock"].map(step => [step, "apparatus", ["node", node + "clock.mjs"]]),
  ];
  const entries = commands.map(([step, role, Cmd], i) => {
    const tool = role === "qualification" ? "checker" : "node", limit = summary.budget.resources[role];
    const name = step === "ready" ? runId + "-ready" : runId + "-cell-" + (step === "application" ? "app" : step);
    const service = ["application", "upstream"].includes(step), network = service ? runId + "-net"
      : step.endsWith("-clock") ? "none" : "container:" + id(offset + 21);
    const operation = service ? "run" : "create", mounts = [], out = paths.join(originalFolder, cell.key);
    const mount = (Destination, Source, RW = false) => mounts.push({ Type: "bind", Destination, Source, RW });
    const usesTrigger = delayed && ["upstream", "probe"].includes(step);
    const sampled = phase === handling && step === "probe";
    if (["upstream", "probe"].includes(step) || step.endsWith("-clock")) mount("/repo", harness);
    if (service || role === "qualification") mount("/fixtures", paths.join(originalFolder, "fixtures"));
    if (role === "qualification") {
      for (const p of ["bench", "scripts", "package.json"]) mount("/repo/" + p, paths.join(harness, p));
      mount("/repo/node_modules", paths.join(originalFolder, "dependencies"));
    }
    if (role === "qualification" || step === "probe") mount("/results", out, true);
    if (sampled) mount("/sys/fs/cgroup", "/sys/fs/cgroup");
    if (usesTrigger) mount("/recovery", triggerSource, step === "probe");
    const env = step === "application" ? Object.entries({ MARKETPLACE_SOURCE: source, MARKETPLACE_FIXTURE_PATH: "/fixtures/marketplace.json",
      API_BASE: upstream, PORT: "8080", HOSTS: "fsw-target,localhost,127.0.0.1", PROFILE: qualificationSettings.nativeProfile,
      MAX_CONNECTIONS: String(qualificationSettings.maxConnections) }).map(([k, v]) => k + "=" + v)
      : role === "qualification" ? ["PLAYWRIGHT_BROWSERS_PATH=/ms-playwright"] : usesTrigger ? ["RECOVERY_TRIGGER_DIR=/recovery"] : [];
    const Id = id(offset + i + 20), Image = step === "application" ? image(3).Id : summary.tools[tool].Id;
    const created = { Id, Name: "/" + name, Image, RestartCount: 0, Config: { Cmd, Entrypoint: null, Env: env, Labels: labels }, Mounts: mounts,
      HostConfig: { NanoCpus: limit.cpu * 1e9, Memory: limit.memory, MemorySwap: limit.memory, PidsLimit: 512, Ulimits: [{ Name: "nofile", Hard: 65536, Soft: 65536 }],
        ShmSize: role === "qualification" ? 1024 ** 3 : 64 * 1024 ** 2, RestartPolicy: { Name: "no" }, Privileged: false, PortBindings: {}, NetworkMode: network,
        PidMode: sampled ? "host" : "", CgroupnsMode: sampled ? "host" : "private" },
      State: { Running: false, ExitCode: 0, OOMKilled: false, Error: "", Dead: false, Restarting: false, StartedAt: stamp, FinishedAt: stamp } };
    const args = [operation, ...(service ? ["-d"] : []), "--network", network, ...(step === "application" ? ["--network-alias", "fsw-target"] : []),
      "--cpus", String(limit.cpu), "--memory", String(limit.memory), "--memory-swap", String(limit.memory), "--pids-limit", "512", "--ulimit", "nofile=65536:65536",
      ...(role === "qualification" ? ["--shm-size", "1g"] : []), ...(sampled ? ["--cgroupns=host", "--pid=host"] : []),
      ...mounts.flatMap(m => ["-v", m.Source + ":" + m.Destination + (!m.RW ? ":ro" : m.Destination === "/recovery" ? ":rw" : "")]),
      ...env.flatMap(value => ["-e", value]), Image, ...(step === "application" ? [] : Cmd)];
    const r = { schema: "native-hardening-container/v2", index: offset + i, intent: { cell: cell.key, name, step, role, tool, operation, args },
      created, terminal: structuredClone(created), removed: true, removedAt: stamp,
      removal: command(["rm", "-f", "-v", Id], Id), absence: command(["ps", "-aq", "--no-trunc", "--filter", "id=" + Id]),
      ...(service ? {} : { start: command(["start", "-a", Id]) }) };
    acknowledge(r); return r;
  });
  return { summary, entries, worker: (step) => entries.find(r => r.intent.step === step) };
}

test("recovery provenance names the two exact entry points and replays without a form worker", () => {
  assert.equal(upstreamSourcePath(handling), "bench/hardening/dependency-recovery-upstream.mjs");
  assert.equal(upstreamSourcePath("request-timeout"), upstreamSourcePath(handling));
  assert.equal(upstreamSourcePath("request-limit"), "bench/marketplace/upstream.mjs");
  for (const options of [{}, { phase: "request-timeout" }, { phase: "request-limit" },
    { paths: win32, originalFolder: "D:\\native results\\w1", source: "fixture" }]) {
    const { entries, summary } = fixture(options);
    assert.equal(verifyOwnedReceipts(entries, summary).get(summary.cells[0].key).length, 10);
  }
});

test("bounded probes cannot claim host resource access, change phase, or use a legacy form worker", () => {
  const limit = fixture({ phase: "request-limit" });
  const worker = limit.worker("probe");
  worker.intent.args.splice(1, 0, "--pid=host");
  acknowledge(worker);
  assert.throws(() => verifyOwnedReceipts(limit.entries, limit.summary), /limits\/options differ/);
  const recovery = fixture();
  recovery.summary.cells[0].phase = "request-limit";
  assert.throws(() => verifyOwnedReceipts(recovery.entries, recovery.summary), /phase differs from the cell identity/);
  recovery.summary.cells[0].key = limit.summary.cells[0].key;
  for (const row of recovery.entries) row.intent.cell = recovery.summary.cells[0].key;
  assert.throws(() => verifyOwnedReceipts(recovery.entries, recovery.summary), /worker command differs/);
  const other = fixture(), app = other.worker("application");
  app.terminal.Mounts.push({ Type: "bind", Destination: "/recovery", Source: "/native/results/w1/.recovery-a1B2c3", RW: true });
  assert.throws(() => verifyOwnedReceipts(other.entries, other.summary), /unexpected recovery trigger mount/);
  const extra = fixture({ withForm: true });
  assert.throws(() => verifyOwnedReceipts(extra.entries, extra.summary), /undeclared native worker/);
});

const triggerMount = (r, change) => {
  for (const info of [r.created, r.terminal]) change(info.Mounts.find(m => m.Destination === "/recovery"));
};
test("recovery verifies the trigger on both receipts and keeps existing controls", () => {
  for (const [step, change, message] of [
    ["upstream", r => triggerMount(r, m => { m.RW = true; }), /mount type or access differs/],
    ["probe", r => triggerMount(r, m => { m.Type = "volume"; }), /mount type or access differs/],
    ["probe", r => triggerMount(r, m => { m.Source = "/external/.recovery-a1B2c3"; }), /escaped the original run/],
    ["probe", r => { r.terminal.Mounts.find(m => m.Destination === "/recovery").RW = false; }, /mount changed during execution/],
    ["probe", r => { r.intent.args[r.intent.args.findIndex(v => v.endsWith(":/recovery:rw"))] = "/native/results/w1/.recovery-a1B2c3:/recovery"; }, /acknowledged native mounts differ/],
    ["probe", r => {
      triggerMount(r, m => { m.Source = "/native/results/w1/.recovery-other1"; });
      r.intent.args[r.intent.args.findIndex(v => v.endsWith(":/recovery:rw"))] = "/native/results/w1/.recovery-other1:/recovery:rw";
    }, /do not share the same trigger directory/],
    ["upstream", r => { r.intent.args[r.intent.args.indexOf("-e") + 1] = "RECOVERY_TRIGGER_DIR=/other"; }, /acknowledged native environment differs/],
    ["probe", r => { r.intent.args[r.intent.args.indexOf("--network") + 1] = "host"; }, /acknowledged native namespace differs/],
    ["probe", r => { r.intent.args[r.intent.args.indexOf("--cpus") + 1] = "99"; }, /acknowledged native limits/],
    ["upstream", r => { r.removal.args[3] = r.intent.name; }, /Expected values/],
  ]) {
    const { entries, summary, worker } = fixture(), row = worker(step);
    change(row); acknowledge(row);
    assert.throws(() => verifyOwnedReceipts(entries, summary), message);
  }
});

test("different recovery cells cannot reuse the same trigger directory", () => {
  const first = fixture(), second = fixture({ source: "fixture", offset: first.entries.length });
  first.summary.cells.push(...second.summary.cells);
  assert.throws(() => verifyOwnedReceipts([...first.entries, ...second.entries], first.summary), /cells share a trigger directory/);
});
