import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { budgets, parseArgs } from "./plan.mjs";
import { nginxConf, edgeOffset } from "../fullstack/edge.mjs";
import { qualificationSettings } from "../marketplace/feature-contract.mjs";
import { committedInputs, sourceGit, savedFiles, snapshotDependencies, verifyOwnedReceipts, verifyRunInputs, readyScript, buildNativeImage, digest, savedProofVersion, verifyNativeLimits, phaseInputs, proxyConfig } from "./evidence.mjs";
import { ownedCleanupObservation, verifyOwnedCleanup, ownedContainerRecorder } from "./lifecycle.mjs";
import { verifyFailedControl, verifySavedProof } from "./verify.mjs";
import { assessNative } from "./native.mjs";
import { livePaths } from "../fullstack/conformance.mjs";
import { boundedQualification } from "./qualification.mjs";
import { qualificationProbes } from "../marketplace/qualification-fixture.mjs";
import { nativeBuildContext } from "../mixed-production/build-context.mjs";
import { hardeningCpuGate, hardeningRoleCpu } from "../workloads/isolated/native-roles.mjs";

// Docker-shaped replay vectors test the apparatus, not a native benchmark run.
const root = mkdtempSync(join(tmpdir(), "hardening-proof-"));
after(() => rmSync(root, { recursive: true, force: true }));
const stamp = "2026-11-13T12:00:00Z", runId = "hardening-test", budget = budgets();
const id = (n) => n.toString(16).padStart(64, "0");
const image = (n) => ({ Id: `sha256:${id(n)}`, Config: { Cmd: ["/server"], Entrypoint: null, Env: [], User: "", WorkingDir: "" } });

test("the Hardening edge preserves the approved public Host without changing the default edge", () => {
  assert.match(proxyConfig(), /if \(\$http_host != "localhost:8080"\) \{ return 421; \}/);
  assert.match(proxyConfig(), /proxy_set_header Host \$http_host;/);
  for (const name of ["Forwarded", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Forwarded-Port"])
    assert.ok(proxyConfig().includes(`proxy_set_header ${name} "";`));
  assert.doesNotMatch(proxyConfig(), /proxy_set_header Origin/);
  const defaultConfig = nginxConf([["target", { port: 8080 - edgeOffset }]], 1);
  assert.doesNotMatch(defaultConfig, /\$http_host|Forwarded/);
  assert.match(defaultConfig, /proxy_set_header Host fsw-target:8080;/);
});

const acknowledgeCreation = (r) => {
  r.creation.args = [r.intent.operation, "--name", r.intent.name,
    "--label", `run.corten.hardening=${runId}`, "--label", "agent.owner=codex", "--label", `agent.task=${runId}`, ...r.intent.args.slice(1)];
};

function fixture(mode = "direct", isolated = false) {
  const cell = { key: `corten/fixture/${mode}/request-limit`, app: "corten", source: "fixture", phase: "request-limit", mode, status: "observed" };
  const options = parseArgs(["w1", "--review", "proof-fixture", ...(isolated ? ["--isolated"] : [])]);
  const summary = { runId, startedAt: stamp, finishedAt: stamp, originalFolder: root, options, budget, cleanupFailures: [], cells: [cell],
    tools: { node: image(1), checker: image(2), cert: image(3), edge: image(4) }, builds: { corten: { imageId: image(5).Id, image: image(5) } } };
  const node = "/repo/bench/hardening/", upstream = `http://${runId}-cell-upstream:8080`, base = "http://127.0.0.1:8080";
  const commands = [
    ["upstream", ["node", "/repo/bench/marketplace/upstream.mjs"], "upstream"],
    ["application", ["/server"], mode === "direct" ? "applicationDirect" : "applicationEdge"], ["ready", ["node", "--input-type=module", "-e", readyScript], "apparatus"],
    ["qualification", ["node", node + "qualification.mjs", "fixture", "direct", upstream, "/results/qualification.json"], "qualification"],
    ["native-controls", ["node", node + "native.mjs", base, "fixture", upstream, "/results/qualification.json", "/results/native-controls.json"], "qualification"],
    ["parity", ["node", node + "parity.mjs", base, "fixture", upstream, "/results/parity.json"], "qualification"],
    ["probe", ["node", ...(isolated ? ["--import", "/repo/" + hardeningCpuGate] : []),
      node + "bounded-requests-probe.mjs", "/results/probe.json", "/results/raw.jsonl"], "apparatus"],
    ...["terminal-clock", "terminal-clock", "cleanup-clock"].map((step) => [step, ["node", node + "clock.mjs"], "apparatus"]),
    ...(mode === "direct" ? [] : [
      ["proxy", ["/server"], "proxy"],
      ["edge-qualification", ["node", node + "qualification.mjs", "fixture", mode, upstream, "/results/edge-qualification.json"], "qualification"],
      ["edge-controls", ["node", node + "native.mjs", "https://localhost:8080", "fixture", upstream, "/results/edge-qualification.json", "/results/edge-native-controls.json", mode], "qualification"],
    ]),
  ];
  const receipts = commands.map(([step, Cmd, role], index) => {
    const tool = role === "qualification" ? "checker" : step === "proxy" ? "edge" : "node", limit = budget.resources[role];
    const suffix = step === "application" ? "app" : step === "proxy" ? "edge" : step, name = step === "ready" ? `${runId}-ready` : `${runId}-cell-${suffix}`;
    const mounts = [], mount = (Destination, Source, RW = false) => mounts.push({ Destination, Source, RW });
    if (["upstream", "probe", "terminal-clock", "cleanup-clock"].includes(step)) mount("/repo", join(root, "corten-build-context"));
    if (role === "qualification") {
      for (const p of ["bench", "scripts", "package.json"]) mount(`/repo/${p}`, join(root, "corten-build-context", p));
      mount("/repo/node_modules", join(root, "dependencies")); mount("/results", join(root, cell.key), true);
    }
    if (["application", "upstream"].includes(step) || role === "qualification") mount("/fixtures", join(root, "fixtures"));
    if (step === "probe") mount("/results", join(root, cell.key), true);
    if (step === "proxy") {
      mount("/etc/nginx/nginx.conf", join(root, cell.key, "nginx.conf")); mount("/cert", join(root, cell.key, "cert"));
    }
    const Env = step === "application" ? Object.entries({ MARKETPLACE_SOURCE: "fixture", MARKETPLACE_FIXTURE_PATH: "/fixtures/marketplace.json", API_BASE: upstream,
      PORT: "8080", HOSTS: "fsw-target,localhost,127.0.0.1", PROFILE: qualificationSettings.nativeProfile, MAX_CONNECTIONS: String(qualificationSettings.maxConnections),
      ...(mode === "deployed-edge" ? { MARKETPLACE_PUBLIC_ORIGIN: "https://localhost:8080" } : {}) }).map(([k, v]) => `${k}=${v}`)
      : role === "qualification" ? ["PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
        ...(step.startsWith("edge-") ? ["NODE_EXTRA_CA_CERTS=/results/cert/cert.pem", "BENCH_EDGE_CERT=/results/cert/cert.pem"] : [])] : [];
    const created = { Id: id(index + 20), Name: "/" + name, Image: step === "application" ? summary.builds.corten.imageId : summary.tools[tool].Id,
      RestartCount: 0, Config: { Cmd, Entrypoint: null, Env, User: "", WorkingDir: "", Labels: { "run.corten.hardening": runId, "agent.owner": "codex", "agent.task": runId } }, Mounts: mounts,
      HostConfig: { NanoCpus: limit.cpu * 1e9, Memory: limit.memory, MemorySwap: limit.memory, PidsLimit: 512, Ulimits: [{ Name: "nofile", Hard: 65536, Soft: 65536 }],
        ...(isolated ? { CpusetCpus: hardeningRoleCpu(role) } : {}),
        ShmSize: role === "qualification" ? 1024 ** 3 : 64 * 1024 ** 2,
        RestartPolicy: { Name: "no" }, Privileged: false, PortBindings: {}, NetworkMode: ["upstream", "application", "proxy"].includes(step) ? runId + "-net"
          : ["terminal-clock", "cleanup-clock"].includes(step) ? "none" : `container:${id(20 + commands.findIndex(([s]) => s === (step.startsWith("edge-") ? "proxy" : "application")))}`,
        PidMode: "", CgroupnsMode: "private" },
      State: { Running: false, ExitCode: 0, OOMKilled: false, Error: "", Dead: false, Restarting: false, StartedAt: stamp, FinishedAt: stamp } };
    const command = (args, stdout) => ({ args, stdout, exitCode: 0, timedOut: false, interrupted: false, startedAt: stamp, finishedAt: stamp });
    const operation = ["upstream", "application", "proxy"].includes(step) ? "run" : "create";
    const args = [operation, ...(operation === "run" ? ["-d"] : []), "--network", created.HostConfig.NetworkMode,
      ...(step === "application" ? ["--network-alias", "fsw-target"] : []),
      "--cpus", String(limit.cpu), "--memory", String(limit.memory), "--memory-swap", String(limit.memory), "--pids-limit", "512", "--ulimit", "nofile=65536:65536",
      ...(isolated ? ["--cpuset-cpus", hardeningRoleCpu(role)] : []),
      ...(role === "qualification" ? ["--shm-size", "1g"] : []),
      ...mounts.flatMap((m) => ["-v", `${m.Source}:${m.Destination}${m.RW ? "" : ":ro"}`]), ...Env.flatMap((e) => ["-e", e]), created.Image,
      ...(operation === "run" && step !== "upstream" ? [] : Cmd)];
    const r = { schema: "native-hardening-container/v2", index, intent: { cell: cell.key, name, step, role, tool, operation, args },
      created, terminal: structuredClone(created), removed: true, removedAt: stamp,
      creation: command(["create"], created.Id), removal: command(["rm", "-f", "-v", created.Id], created.Id),
      absence: command(["ps", "-aq", "--no-trunc", "--filter", `id=${created.Id}`], ""), start: command(["start", "-a", created.Id], "") };
    acknowledgeCreation(r); return r;
  });
  return { summary, receipts };
}

test("complete actual-configuration vectors replay every charged native step", () => {
  const { summary, receipts } = fixture(); assert.equal(verifyOwnedReceipts(receipts, summary).get(summary.cells[0].key).length, 10);
  // A target exit remains compatible with complete apparatus receipts.
  receipts[1].terminal.State.ExitCode = 137; receipts[1].terminal.State.OOMKilled = true;
  assert.doesNotThrow(() => verifyOwnedReceipts(receipts, summary));
});

test("replay binds the exact public origin to the edge app, never to the direct app", () => {
  for (const mode of ["deployed-edge", "direct"]) {
    const { summary, receipts } = fixture(mode), app = receipts.find((r) => r.intent.step === "application");
    const preflight = { ...summary.cells[0], failedStage: mode === "deployed-edge" ? "edge-native-controls" : "native-controls" };
    assert.doesNotThrow(() => verifyOwnedReceipts(receipts, summary, undefined, preflight));
    const unexpected = "MARKETPLACE_PUBLIC_ORIGIN=https://other.invalid:8080";
    const i = app.created.Config.Env.findIndex((s) => s.startsWith("MARKETPLACE_PUBLIC_ORIGIN="));
    if (i < 0) app.created.Config.Env.push(unexpected);
    else app.created.Config.Env[i] = unexpected;
    assert.throws(() => verifyOwnedReceipts(receipts, summary, undefined, preflight), /unbound native worker environment/);
  }
});

test("owned receipts require declared options and enforce isolated launch CPU proof", () => {
  const { summary, receipts } = fixture("direct", true);
  assert.equal(verifyOwnedReceipts(receipts, summary).get(summary.cells[0].key).length, 10);
  assert.throws(() => verifyOwnedReceipts(receipts, { ...summary, options: undefined }), /native hardening options required/);
  assert.throws(() => verifyOwnedReceipts(fixture().receipts, { ...summary, options: {} }), /bounded profile required/);
  assert.throws(() => verifyOwnedReceipts(receipts, { ...summary, options: { ...summary.options, isolated: false } }),
    /invalid native hardening isolation option/);
  assert.throws(() => verifyOwnedReceipts(fixture().receipts, summary), /Docker cpuset differs/);
  const probe = receipts.find((r) => r.intent.step === "probe");
  probe.created.Config.Cmd.splice(1, 2); probe.terminal.Config.Cmd.splice(1, 2);
  probe.intent.args.splice(probe.intent.args.indexOf("--import"), 2); acknowledgeCreation(probe);
  assert.throws(() => verifyOwnedReceipts(receipts, summary), /launched native worker command differs/);
});

for (const mode of ["direct", "deployed-edge"]) for (const discovery of [false, true])
test(`ordinary ${mode} preflight failure (${discovery ? "discovery" : "allowed host"}) requires the matching owned launch`, () => {
  const { receipts, summary } = fixture(mode), cell = summary.cells[0], edge = mode === "deployed-edge";
  const probes = qualificationProbes(), keys = ["page", "json", "pageBr", "jsonBr", "jsonGzip", "ownPost", "crossSite",
    "page404", "json404", "json405", "head", "badHost", "live", "liveness"];
  const base = edge ? "https://localhost:8080" : "http://127.0.0.1:8080", prefix = edge ? "edge-" : "";
  const p = Object.fromEntries(keys.map(k => [k, probes[k]]));
  delete p.live;
  p.liveness = livePaths.map((path, i) => ({ ...probes.live, path, status: discovery && i === 0 ? 503 : 404, url: base + path, method: "GET", host: new URL(base).host }));
  const q = boundedQualification(p, cell.source);
  const dir = join(root, "preflight"), out = join(dir, cell.key); mkdirSync(out, { recursive: true });
  const qualification = join(out, prefix + "qualification.json"), capture = join(out, prefix + "native-controls.json");
  writeFileSync(qualification, JSON.stringify(q));
  // Run the actual control CLI (including stdout and its separate raw output);
  // only the fixture read and HTTP transport are replaced.
  const preload = `import fs from "node:fs"; import http from "node:http"; import https from "node:https";
    import { EventEmitter } from "node:events"; import { syncBuiltinESMExports } from "node:module";
    const read = fs.readFileSync; fs.readFileSync = (p, ...args) => p === "/fixtures/marketplace.json" ? '{"item_1":{}}' : read(p, ...args);
    http.request = https.request = (url, options, receive) => {
      const req = new EventEmitter();
      req.end = () => { const res = Object.assign(new EventEmitter(), { headers: {}, statusCode: options.headers.host === "unrecognized.invalid" ? 403
        : ${!discovery} && url.pathname === "/marketplace/en-US/item_1" ? 503 : 200 });
        receive(res); res.emit("end"); req.emit("close"); }; return req;
    }; syncBuiltinESMExports();`;
  const stdout = execFileSync(process.execPath, ["--import", "data:text/javascript;base64," + Buffer.from(preload).toString("base64"),
    fileURLToPath(new URL("native.mjs", import.meta.url)), base, cell.source, `http://${runId}-cell-upstream:8080`, qualification, capture, mode],
    { cwd: out, encoding: "utf8" }).trim();
  const raw = JSON.parse(readFileSync(capture)), assessment = assessNative(raw, q, mode);
  assert.deepEqual(assessment.targetFunctionalFailures, [discovery ? { control: "liveness-discovery", path: livePaths[0], status: 503 }
    : { control: "allowed-host", status: 503 }]);
  Object.assign(cell, { status: "invalid", failedStage: prefix + "native-controls", failureKind: "target-functional-failure",
    [edge ? "edgeAssessment" : "nativeAssessment"]: assessment });
  writeFileSync(join(out, "failure.json"), JSON.stringify({ stage: cell.failedStage, kind: cell.failureKind }));
  const config = join(out, "nginx.conf"), expectedConfig = proxyConfig();
  if (edge) writeFileSync(config, expectedConfig);
  const paths = new Set(savedFiles(dir).map(f => f.path)), launches = edge ? receipts : receipts.slice(0, 5), control = launches.at(-1);
  control.start.stdout = stdout;
  const replay = (list) => verifyFailedControl(dir, cell, paths, summary, list);
  assert.equal(replay(launches), true);
  if (edge) {
    rmSync(config); assert.equal(replay(launches), false);
    writeFileSync(config, "# different deployment"); assert.throws(() => replay(launches), /edge configuration/);
    writeFileSync(config, expectedConfig);
  }
  assert.equal(replay([]), false);
  assert.equal(replay(launches.slice(0, -1)), false);
  delete raw.host.allowed.host; writeFileSync(capture, JSON.stringify(raw));
  assert.equal(replay(launches), false);
  raw.host.allowed.host = new URL(base).host; writeFileSync(capture, JSON.stringify(raw));
  const row = p.liveness[0], url = row.url;
  delete row.url; writeFileSync(qualification, JSON.stringify(boundedQualification(p, cell.source)));
  assert.equal(replay(launches), false);
  row.url = (edge ? "http://127.0.0.1:8080" : "https://localhost:8080") + row.path;
  writeFileSync(qualification, JSON.stringify(boundedQualification(p, cell.source)));
  assert.throws(() => replay(launches), /request url differs/);
  row.url = url; writeFileSync(qualification, JSON.stringify(q));
  control.start.stdout = "{}"; assert.throws(() => replay(launches), /owned control output/);
  control.start.stdout = JSON.stringify(assessment);
  control.created.HostConfig.NetworkMode = control.terminal.HostConfig.NetworkMode = "container:" + launches[0].created.Id;
  assert.throws(() => replay(launches), /namespace differs/);
});

for (const [name, mutate] of [
  ["image and command", (r) => r.intent.args = ["create", "alpine", "true"]],
  ["CPU quota", (r) => r.intent.args[r.intent.args.indexOf("--cpus") + 1] = "99"],
  ["namespace", (r) => r.intent.args[r.intent.args.indexOf("--network") + 1] = "host"],
  ["input mount", (r) => r.intent.args[r.intent.args.indexOf("-v") + 1] = "/unbound:/repo:ro"],
  ["extra launch option", (r) => r.intent.args.splice(1, 0, "--privileged")],
]) test(`canonical launch rejects coherently rewritten ${name} with unchanged inspect receipts`, () => {
  const { summary, receipts } = fixture(), r = receipts.find((r) => r.intent.step === "probe");
  mutate(r); acknowledgeCreation(r); assert.throws(() => verifyOwnedReceipts(receipts, summary));
});

test("apparatus start acknowledgement fields distinguish incomplete proof from explicit failure", () => {
  const { summary, receipts } = fixture(), index = receipts.findIndex((r) => r.intent.step === "probe");
  for (const field of ["args", "stdout", "exitCode", "timedOut", "interrupted", "startedAt", "finishedAt"]) {
    const changed = structuredClone(receipts); delete changed[index].start[field];
    assert.throws(() => verifyOwnedReceipts(changed, summary), (e) => e.code === "ENOENT", field);
  }
  for (const patch of [{ exitCode: 1 }, { timedOut: true }, { interrupted: true }, { args: ["start", "-a", id(999)] }]) {
    const changed = structuredClone(receipts); Object.assign(changed[index].start, patch);
    assert.throws(() => verifyOwnedReceipts(changed, summary), (e) => e.code === "ERR_ASSERTION");
  }
});
test("Docker's empty default user/workdir match omitted image fields, not different settings", () => {
  const { summary, receipts } = fixture();
  delete summary.tools.node.Config.User; delete summary.tools.node.Config.WorkingDir;
  assert.doesNotThrow(() => verifyOwnedReceipts(receipts, summary));
  receipts[2].created.Config.User = "unexpected"; assert.throws(() => verifyOwnedReceipts(receipts, summary));
});

for (const [step, key] of [["application", "Entrypoint"], ["application", "Cmd"], ["proxy", "Entrypoint"], ["proxy", "Cmd"], ["ready", "Entrypoint"]])
test(`Docker's omitted image ${key} replays as null for ${step}, not a different value`, () => {
  const { summary, receipts } = fixture(step === "proxy" ? "deployed-edge" : "direct");
  const { created, terminal } = receipts.find((r) => r.intent.step === step);
  const config = step === "application" ? summary.builds.corten.image.Config
    : summary.tools[step === "proxy" ? "edge" : "node"].Config;
  const preflight = step === "proxy" ? { ...summary.cells[0], failedStage: "edge-native-controls" } : undefined;
  const replay = () => verifyOwnedReceipts(receipts, summary, undefined, preflight);
  const setActual = (value) => { created.Config[key] = terminal.Config[key] = value; };
  const omitActual = () => { delete created.Config[key]; delete terminal.Config[key]; };
  const refuse = () => assert.throws(replay, { code: "ERR_ASSERTION", operator: "deepStrictEqual" });
  const command = ["/server", "--serve"];
  if (key === "Cmd") created.Config.Entrypoint = terminal.Config.Entrypoint = config.Entrypoint = ["/server"];

  config[key] = null; setActual(null);
  assert.doesNotThrow(replay);
  delete config[key];
  assert.doesNotThrow(replay);
  for (const value of [[], command]) { setActual(value); refuse(); }
  omitActual(); refuse();
  config[key] = []; setActual(null); refuse();

  config[key] = command;
  for (const r of receipts) if (r.created.Image === created.Image)
    r.created.Config[key] = r.terminal.Config[key] = [...command];
  assert.doesNotThrow(replay);
  for (const value of [null, ["/server", "--other"]]) { setActual(value); refuse(); }
  omitActual(); refuse();
});

test("deployment replay accepts Docker's enabled OOM default transition, not changed limits", () => {
  const { summary, receipts } = fixture();
  const processes = [{ id: "application", role: "application" }, { id: "upstream", role: "upstream" }];
  const settings = { case: "direct", effectiveBudgets: JSON.stringify(summary.budget), deployment: { processes } };
  const lifecycle = Object.fromEntries(processes.map((p) => {
    const info = structuredClone(receipts.find((r) => r.intent.step === p.id).created);
    info.HostConfig.OomKillDisable = false;
    const after = structuredClone(info); after.HostConfig.OomKillDisable = null;
    return [p.id, { before: info, after, events: [] }];
  }));
  assert.doesNotThrow(() => verifyNativeLimits(settings, lifecycle));
  lifecycle.application.after.HostConfig.Memory++;
  assert.throws(() => verifyNativeLimits(settings, lifecycle));
});

test("Docker's null/false OOM-enabled representation is equivalent, disabling it is not", () => {
  const { summary, receipts } = fixture();
  receipts[2].created.HostConfig.OomKillDisable = false; receipts[2].terminal.HostConfig.OomKillDisable = null;
  assert.doesNotThrow(() => verifyOwnedReceipts(receipts, summary));
  receipts[2].created.HostConfig.OomKillDisable = true; receipts[2].terminal.HostConfig.OomKillDisable = true;
  assert.throws(() => verifyOwnedReceipts(receipts, summary));
});
test("a joined namespace hostname must bind its independently inspected owner", () => {
  const { summary, receipts } = fixture(), r = receipts[2], owner = receipts[1].created;
  r.created.Config.Hostname = r.created.Id.slice(0, 12); r.terminal.Config.Hostname = "target-host";
  r.namespace = structuredClone(owner); r.namespace.Config.Hostname = "target-host";
  assert.doesNotThrow(() => verifyOwnedReceipts(receipts, summary));
  r.namespace.Id = id(999); assert.throws(() => verifyOwnedReceipts(receipts, summary));
});
test("saved Linux mount identity replays independently of the verifier host path flavor", () => {
  const { summary, receipts } = fixture(); summary.originalFolder = "/native/results/w17";
  for (const r of receipts) for (const info of [r.created, r.terminal]) for (const mount of info.Mounts)
    if (mount.Source.startsWith(root)) mount.Source = summary.originalFolder + mount.Source.slice(root.length).replaceAll("\\", "/");
  for (const r of receipts) {
    r.intent.args = r.intent.args.map((arg) => typeof arg === "string" && arg.startsWith(root)
      ? summary.originalFolder + arg.slice(root.length).replaceAll("\\", "/") : arg);
    acknowledgeCreation(r);
  }
  assert.doesNotThrow(() => verifyOwnedReceipts(receipts, summary));
});

test("a failed health launcher preserves only a separately retained critical target exit", async () => {
  const { summary, receipts } = fixture(), health = structuredClone(receipts[3]), target = receipts[1].created;
  health.index = receipts.length; health.intent.step = "application-health"; health.intent.name = `${runId}-cell-application-health`; health.intent.healthPath = "/health";
  for (const info of [health.created, health.terminal]) {
    info.Id = id(99); info.Name = "/" + health.intent.name;
    info.Config.Cmd = ["node", "/repo/bench/hardening/lifecycle.mjs", "http://127.0.0.1:8080", "/health", "600"];
  }
  health.creation.stdout = id(99); health.removal.args[3] = id(99); health.removal.stdout = id(99);
  health.intent.args = [...health.intent.args.slice(0, health.intent.args.indexOf(health.created.Image) + 1), ...health.created.Config.Cmd]; acknowledgeCreation(health);
  health.absence.args[4] = `id=${id(99)}`; health.start.args[2] = id(99);
  const recorderFolder = join(root, "failed-health-recorder"); mkdirSync(recorderFolder);
  const recorder = ownedContainerRecorder({ folder: recorderFolder, runId, cell: () => summary.cells[0], tools: () => summary.tools,
    command: async (args) => {
      if (args[0] === "create") return health.created.Id;
      if (args[0] === "inspect") {
        assert.ok([health.created.Id, target.Id].includes(args[1]));
        return JSON.stringify([args[1] === health.created.Id ? health.created : target]);
      }
      assert.deepEqual(args, ["start", "-a", health.created.Id]);
      throw Object.assign(new Error("namespace target exited"), { code: 128, stdout: Buffer.alloc(0), stderr: Buffer.from("observed namespace failure") });
    } });
  await recorder.owned(health.intent.name, health.intent.args);
  await assert.rejects(recorder.docker(["start", "-a", health.intent.name]), (error) => error.code === 128);
  health.start = recorder.records[0].start;
  summary.startedAt = new Date(Math.min(Date.parse(summary.startedAt), Date.parse(health.start.startedAt))).toISOString();
  health.removedAt = summary.finishedAt = new Date(Math.max(Date.parse(summary.finishedAt), Date.now())).toISOString();
  health.terminal.State.Error = "namespace target exited"; receipts.push(health);
  const path = join(root, summary.cells[0].key); mkdirSync(path, { recursive: true });
  const life = { before: target, after: structuredClone(target), health: { path: "/health", response: null, unavailable: "not-running", observerError: "namespace exited" } };
  Object.assign(life.after.State, { Running: false, Status: "exited", ExitCode: 137 });
  writeFileSync(join(path, "application-lifecycle.json"), JSON.stringify(life));
  assert.doesNotThrow(() => verifyOwnedReceipts(receipts, summary, root));
  assert.equal(health.start.stdout, ""); assert.equal(health.start.stderr, "observed namespace failure");
  life.after.State.Running = true; writeFileSync(join(path, "application-lifecycle.json"), JSON.stringify(life));
  assert.throws(() => verifyOwnedReceipts(receipts, summary, root));
});

for (const [name, mutate] of [
  ["unbounded apparatus CPU", (r) => r[2].created.HostConfig.NanoCpus = 0],
  ["apparatus OOM", (r) => r[2].terminal.State.OOMKilled = true],
  ["wrong qualification shared memory", (r) => r[3].created.HostConfig.ShmSize = 64 * 1024 ** 2],
  ["unacknowledged client exit", (r) => r[2].start.exitCode = null],
  ["wrong tool image", (r) => r[2].created.Image = image(42).Id],
  ["injected command", (r) => r[2].created.Config.Cmd.push("unexpected")],
  ["injected environment", (r) => r[2].created.Config.Env.push("NODE_OPTIONS=--import=/tmp/injected.mjs")],
  ["writable source", (r) => r[0].created.Mounts[0].RW = true],
  ["extra input mount", (r) => r[0].created.Mounts.push({ Source: root, Destination: "/extra", RW: false })],
  ["wrong namespace", (r) => r[2].created.HostConfig.NetworkMode = "host"],
  ["missing qualification", (r) => { r.splice(3, 1); r.forEach((r, i) => r.index = i); }],
  ["missing removal", (r) => r[0].removed = false],
  ["unacknowledged removal", (r) => r[0].removal.exitCode = null],
  ["removal by mutable name", (r) => r[0].removal.args[3] = r[0].intent.name],
  ["original ID still present", (r) => r[0].absence.stdout = r[0].created.Id],
  ["reused container ID", (r) => r[1].created.Id = r[0].created.Id],
]) test(`resource replay rejects ${name} despite unchanged requested budgets`, () => {
  const { summary, receipts } = fixture(); mutate(receipts); assert.throws(() => verifyOwnedReceipts(receipts, summary));
});

test("finalizer records acknowledged command response vectors and replays without Docker", async () => {
  const { summary } = fixture(), calls = [];
  const receipt = await ownedCleanupObservation(async (args, opts) => { calls.push(args); assert.equal(opts.cleanup, true); return ""; }, runId, 0, 0);
  summary.startedAt = "2000-01-01T00:00:00Z"; summary.finishedAt = "2100-01-01T00:00:00Z";
  assert.equal(calls.length, 4); assert.equal(verifyOwnedCleanup(receipt, summary), true);
  receipt.inventories[0].stdout = id(88); assert.equal(verifyOwnedCleanup(receipt, summary), false);
  receipt.inventories[0].stdout = ""; summary.daemonOutcomeUnknown = true; assert.equal(verifyOwnedCleanup(receipt, summary), false);
  await assert.rejects(ownedCleanupObservation(async () => { throw Error("daemon unavailable"); }, runId, 0, 0));
});

test("cleanup cannot be inferred from empty failure lists or zero client intent", () => {
  const { summary } = fixture(); assert.throws(() => verifyOwnedCleanup({ commandClients: 0, activeContainers: 0 }, summary));
});

test("historical source/apparatus/finalizer proof is blocked, not backfilled", () => {
  const dir = join(root, "historical"); mkdirSync(dir);
  const proof = verifySavedProof(dir, {}); assert.equal(proof.resources, "blocked"); assert.equal(proof.sources, "blocked"); assert.equal(proof.cleanupComplete, false);
  assert.ok(proof.blockers.includes("historical-capture-missing-execution-proof"));
  assert.deepEqual(verifySavedProof(dir, { savedProofVersion: 1 }), proof);
});

test("saved closure includes nested captures/manifests and rejects hardlinks", () => {
  const dir = join(root, "seal"); mkdirSync(join(dir, "cell"), { recursive: true });
  writeFileSync(join(dir, "cell/capture.json"), "{}"); writeFileSync(join(dir, "cell/manifest.json"), "[]");
  assert.deepEqual(savedFiles(dir).map((f) => f.path), ["cell/capture.json", "cell/manifest.json"]);
  linkSync(join(dir, "cell/capture.json"), join(dir, "linked")); assert.throws(() => savedFiles(dir));
  rmSync(join(dir, "linked"));
});

test("dependency snapshot preserves actual bytes, excludes unused bin launchers and detects later edits", () => {
  const from = join(root, "installed"), to = join(root, "dependencies-copy"); mkdirSync(join(from, ".bin"), { recursive: true });
  writeFileSync(join(from, "worker.mjs"), "export const worker = 1;\n"); writeFileSync(join(from, ".bin/unused"), "unused");
  const original = snapshotDependencies(from, to); assert.deepEqual(original.map((f) => f.path), ["worker.mjs"]);
  writeFileSync(join(to, "worker.mjs"), "changed"); assert.notDeepEqual(savedFiles(to), original);
});

test("Git archive build and harness inputs replay committed bytes read-only, including root context files", async (t) => {
  const repository = fileURLToPath(new URL("../../", import.meta.url)), dir = join(root, "source"); mkdirSync(dir);
  const commit = sourceGit(repository, ["rev-parse", "HEAD"]).toString().trim(), files = committedInputs(repository, commit);
  const io = { command: async (binary, args) => execFileSync(binary, args, { cwd: repository, windowsHide: true,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] }) };
  const context = await nativeBuildContext(io, dir, commit, "corten", files.map(({ path, sha256 }) => ({ path, sha256 })));
  const lock = JSON.parse(readFileSync(join(dir, "corten-build-context/package-lock.json")));
  for (const name of ["@playwright/test", "playwright", "playwright-core"]) {
    const path = join(dir, "dependencies", name, "package.json"); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: lock.packages[`node_modules/${name}`].version }));
  }
  const input = { schema: "native-hardening-inputs/v1", commit, files, dependencies: savedFiles(join(dir, "dependencies")) };
  writeFileSync(join(dir, "inputs.json"), JSON.stringify(input));
  const source = digest(JSON.stringify(files.filter((f) => ["Cargo.toml", "Cargo.lock"].includes(f.path) || f.path.startsWith("crates/") || f.path.startsWith("bench/marketplace/corten/")).map((f) => [f.path, f.sha256])));
  const buildImage = image(1); buildImage.Config.Labels = { "run.corten.hardening.context": context.sha256, "run.corten.marketplace.commit": commit, "run.corten.hardening.source": source };
  const build = await buildNativeImage(async (args) => args[0] === "build" ? "" : JSON.stringify([buildImage]), { context, runId, commit, source, tag: `${runId}-corten`, files });
  const summary = { commit, runId, cells: [{ app: "corten", phase: "request-limit", status: "observed" }], builds: { corten: build } };
  if (phaseInputs("request-limit").some((path) => !files.some((file) => file.path === path))) {
    assert.throws(() => verifyRunInputs(dir, summary), /native hardening input is not in the committed source/);
    return t.skip("the current Git commit predates the v3 sources; positive replay requires a committed v3 checkout");
  }
  const before = savedFiles(dir); assert.deepEqual(verifyRunInputs(dir, summary), input); assert.deepEqual(savedFiles(dir), before);
  await t.test("non-Corten Git context replays only the producer's exact archive bytes", async () => {
    const app = "aspnet", prefix = `bench/fullstack/apps/${app}`;
    const appFiles = files.filter((f) => f.path.startsWith(prefix + "/"));
    const appContext = await nativeBuildContext(io, dir, commit, app, appFiles.map(({ path, sha256 }) => ({ path, sha256 })));
    const appSource = digest(JSON.stringify(appFiles.map((f) => [f.path, f.sha256])));
    const receipt = (context) => {
      const appImage = image(2);
      appImage.Config.Labels = { "run.corten.hardening.context": context.sha256, "run.corten.marketplace.commit": commit,
        "run.corten.hardening.source": appSource };
      return buildNativeImage(async (args) => args[0] === "build" ? "" : JSON.stringify([appImage]),
        { context, runId, commit, source: appSource, tag: `${runId}-${app}`, files: appFiles });
    };
    const attempt = { ...summary, cells: [...summary.cells, { app, phase: "dependency-recovery", status: "observed" }],
      builds: { ...summary.builds, [app]: await receipt(appContext) } };
    assert.deepEqual(verifyRunInputs(dir, attempt), input);
    const archive = join(dir, `${app}-build-context.tar`);
    try {
      // Same committed files, but a different tar timestamp and matching saved receipt.
      const input = sourceGit(repository, ["archive", "--format=tar", "--mtime=2001-01-01T00:00:00Z", `${commit}:${prefix}`]);
      const sha256 = digest(input); assert.notEqual(sha256, appContext.sha256);
      writeFileSync(archive, input);
      attempt.builds[app] = await receipt({ ...appContext, input, sha256 });
      assert.throws(() => verifyRunInputs(dir, attempt), /native build-context archive differs from committed inputs/);
    } finally { rmSync(archive); rmSync(join(dir, `${app}-build-context`), { recursive: true }); }
  });
  assert.ok(files.some((f) => f.path === ".dockerignore"));
  const full = fixture(); Object.assign(full.summary, { commit, savedProofVersion, startedAt: "2000-01-01T00:00:00Z", finishedAt: "2100-01-01T00:00:00Z", builds: summary.builds });
  // Use the same retained application image identity as the actual-config vector.
  summary.builds.corten.imageId = full.receipts[1].created.Image; summary.builds.corten.image.Id = summary.builds.corten.imageId;
  const cell = full.summary.cells[0], out = join(dir, cell.key); mkdirSync(out, { recursive: true });
  const network = { Id: id(90), Name: `${runId}-net`, Containers: {}, Labels: {
    "run.corten.hardening": runId, "agent.owner": "codex", "agent.task": runId } };
  const processes = ["upstream", "application"].map((role) => {
    const r = full.receipts.find((r) => r.intent.step === role);
    writeFileSync(join(out, role + "-before.json"), JSON.stringify({ info: r.created }));
    writeFileSync(join(out, role + "-lifecycle.json"), JSON.stringify({ after: r.terminal, health: { response: null } }));
    return { id: role, role, containerId: r.created.Id };
  });
  writeFileSync(join(out, "deployment.json"), JSON.stringify({ processes, network }));
  mkdirSync(join(dir, "owned-containers"));
  const ownedFiles = full.receipts.map((r, i) => {
    const file = `${String(i).padStart(8, "0")}.json`; writeFileSync(join(dir, "owned-containers", file), JSON.stringify(r)); return file;
  });
  writeFileSync(join(dir, "owned-containers.json"), JSON.stringify({ schema: "native-hardening-owned-containers/v1", files: ownedFiles }));
  const finalizer = await ownedCleanupObservation(async () => "", runId, 0, 0);
  writeFileSync(join(dir, "final-cleanup.json"), JSON.stringify(finalizer));
  full.summary.ownedNetworks = [network.Name]; full.summary.ownedImages = [`${runId}-corten`];
  const command = (args, stdout) => ({ args, stdout, exitCode: 0, startedAt: stamp, finishedAt: stamp });
  const resourceCleanup = [
    { schema: "native-hardening-resource-cleanup/v1", kind: "network", name: network.Name, commands: [
      command(["network", "ls", "--no-trunc", "--filter", `name=${network.Name}`, "-q"], network.Id),
      command(["network", "inspect", network.Id], JSON.stringify([network])), command(["network", "rm", network.Id], network.Id)] },
    { schema: "native-hardening-resource-cleanup/v1", kind: "image", name: `${runId}-corten`, commands: [
      command(["image", "ls", "-q", "--no-trunc", `${runId}-corten`], build.imageId),
      command(["image", "inspect", build.imageId], JSON.stringify([{ Id: build.imageId, RepoTags: [`${runId}-corten:latest`], Config: { Labels: network.Labels } }])),
      command(["image", "rm", build.imageId], `Deleted: ${build.imageId}`)] },
  ];
  writeFileSync(join(dir, "resource-cleanup.json"), JSON.stringify(resourceCleanup));
  writeFileSync(join(dir, "run-manifest.json"), JSON.stringify(savedFiles(dir)));
  const sealed = savedFiles(dir), proof = verifySavedProof(dir, full.summary);
  assert.equal(proof.sources, "verified"); assert.equal(proof.resources, "verified"); assert.equal(proof.cleanupComplete, true); assert.deepEqual(proof.blockers, []);
  assert.equal(proof.cpuRoles, undefined, "standalone receipts do not prove CPU isolation");
  assert.deepEqual(savedFiles(dir), sealed);
  const reseal = () => writeFileSync(join(dir, "run-manifest.json"), JSON.stringify(savedFiles(dir).filter((f) => f.path !== "run-manifest.json")));
  for (const kind of ["image", "network"]) await t.test(`sealed proof blocks a known-used ${kind} disappearing before owned removal`, () => {
    const changed = structuredClone(resourceCleanup), r = changed.find((r) => r.kind === kind);
    r.commands = [{ ...r.commands[0], stdout: "" }]; writeFileSync(join(dir, "resource-cleanup.json"), JSON.stringify(changed)); reseal();
    try {
      const result = verifySavedProof(dir, full.summary);
      assert.equal(result.cleanupComplete, false); assert.ok(result.blockers.length);
    } finally { writeFileSync(join(dir, "resource-cleanup.json"), JSON.stringify(resourceCleanup)); reseal(); }
  });
  for (const [label, mutate] of [
    ["unrelated creation command", (r) => r.creation.args = ["not-a-docker-create-command"]],
    ["coherently substituted creation intent and acknowledgement", (r) => { r.intent.args = ["create", "alpine", "true"]; acknowledgeCreation(r); }],
    ["bounded probe gaining host PID access", (r) => {
      r.created.HostConfig.PidMode = "host"; r.terminal.HostConfig.PidMode = "host";
      r.intent.args.splice(1, 0, "--pid=host"); acknowledgeCreation(r);
    }],
    ["bounded probe gaining host cgroup access", (r) => {
      r.created.HostConfig.CgroupnsMode = "host"; r.terminal.HostConfig.CgroupnsMode = "host";
      r.intent.args.splice(1, 0, "--cgroupns=host"); acknowledgeCreation(r);
    }],
  ]) await t.test(`sealed proof rejects ${label}`, () => {
    const r = structuredClone(full.receipts.find((r) => r.intent.step === "probe")), path = join(dir, "owned-containers", ownedFiles[r.index]);
    mutate(r); writeFileSync(path, JSON.stringify(r)); reseal();
    try { assert.throws(() => verifySavedProof(dir, full.summary)); }
    finally { writeFileSync(path, JSON.stringify(full.receipts[r.index])); reseal(); }
  });
  for (const key of ["creation", "removal", "absence"]) await t.test(`sealed proof blocks a missing ${key} acknowledgement`, () => {
    const r = structuredClone(full.receipts[7]), path = join(dir, "owned-containers", ownedFiles[r.index]);
    delete r[key]; writeFileSync(path, JSON.stringify(r)); reseal();
    try {
      const result = verifySavedProof(dir, full.summary);
      assert.equal(result.resources, "blocked"); assert.equal(result.cleanupComplete, false); assert.ok(result.blockers.length);
    } finally { writeFileSync(path, JSON.stringify(full.receipts[r.index])); reseal(); }
  });
  await t.test("sealed partial build retains cleanup without claiming source closure", () => {
    const partial = structuredClone(full.summary); partial.builds = {}; partial.cells[0].status = "not-run";
    const result = verifySavedProof(dir, partial);
    assert.equal(result.sources, "blocked"); assert.equal(result.resources, "blocked"); assert.equal(result.cleanupComplete, true);
  });
  const probe = full.receipts.find((r) => r.intent.step === "probe");
  for (const [label, relative, mutate] of [
    ["probe start exitCode", `owned-containers/${ownedFiles[probe.index]}`, (value) => delete value.start.exitCode],
    ["build timedOut", "@summary", (value) => delete value.builds.corten.command.timedOut],
    ["image removal exitCode", "resource-cleanup.json", (value) => delete value[1].commands[2].exitCode],
  ]) await t.test(`sealed proof blocks missing ${label} but rejects explicit failure`, () => {
    const original = relative === "@summary" ? full.summary : JSON.parse(readFileSync(join(dir, relative)));
    const value = structuredClone(original); mutate(value);
    if (relative !== "@summary") { writeFileSync(join(dir, relative), JSON.stringify(value)); reseal(); }
    try {
      const result = verifySavedProof(dir, relative === "@summary" ? value : full.summary);
      assert.ok(result.blockers.length); assert.ok(result.resources !== "verified" || result.sources !== "verified" || result.cleanupComplete === false);
      if (relative === "@summary") value.builds.corten.command.timedOut = true;
      else {
        if (relative.startsWith("owned-containers")) value.start.exitCode = 1;
        else value[1].commands[2].exitCode = 1;
        writeFileSync(join(dir, relative), JSON.stringify(value)); reseal();
      }
      assert.throws(() => verifySavedProof(dir, relative === "@summary" ? value : full.summary), (e) => e.code === "ERR_ASSERTION");
    } finally {
      if (relative !== "@summary") { writeFileSync(join(dir, relative), JSON.stringify(original)); reseal(); }
    }
  });
  // This is proof-layer replay only; verify(folder) still requires the complete
  // canonical 108-cell ledger and independent bounded request/parity replay first.
  writeFileSync(join(dir, "corten-build-context/.dockerignore"), "changed"); assert.throws(() => verifyRunInputs(dir, summary));
  assert.throws(() => verifySavedProof(dir, full.summary), /run-wide saved byte closure differs/);
});
