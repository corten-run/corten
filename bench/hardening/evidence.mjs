import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative, isAbsolute, posix, win32 } from "node:path";
import { hardeningCaptureSchema, hardeningContract, validateHardeningOutcome } from "../workloads/hardening.mjs";
import { validateBudget } from "./plan.mjs";
import { validateControl } from "./probe.mjs";
import { assessTimedSource } from "./native.mjs";
import { records } from "../marketplace/fixtures.mjs";
import { validateLegitimate, validateAttack } from "./receipts.mjs";
import { terminalRecovery, verifyContainerCommands, requireCommandAcknowledgement } from "./lifecycle.mjs";
import { qualificationSettings, featureProfile } from "../marketplace/feature-contract.mjs";

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const savedProofVersion = 2;
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function sourceGit(root, args, input) {
  return execFileSync("git", ["--no-replace-objects", "--no-lazy-fetch", "-c", "protocol.allow=never", ...args], {
    cwd: root, input, windowsHide: true, timeout: 60000, maxBuffer: 512 * 1024 ** 2, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
  });
}
export function committedInputs(root, commit) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  const rows = sourceGit(root, ["ls-tree", "-rz", "--full-tree", commit]).toString().split("\0").filter(Boolean).map((row) => {
    const tab = row.indexOf("\t"), meta = row.slice(0, tab), path = row.slice(tab + 1), [mode, type, oid] = meta.split(" ");
    assert.ok(["100644", "100755"].includes(mode) && type === "blob", "source links/submodules cannot close native inputs");
    assert.ok(path && !/[\\:\x00-\x1f]/.test(path) && path.split("/").every((p) => p && p !== "." && p !== ".."));
    return { path, mode, oid };
  });
  const batch = sourceGit(root, ["cat-file", "--batch"], rows.map((r) => `${r.oid}\n`).join("")); let at = 0;
  const files = rows.map(({ path, mode, oid }) => {
    const end = batch.indexOf(10, at); assert.ok(end >= at);
    const [actual, kind, length] = batch.subarray(at, end).toString().split(" "), size = Number(length);
    assert.ok(actual === oid && kind === "blob" && Number.isSafeInteger(size) && size >= 0); at = end + 1;
    const body = batch.subarray(at, at + size); assert.ok(body.length === size && batch[at + size] === 10); at += size + 1;
    return { path, mode, sha256: digest(body) };
  });
  assert.equal(at, batch.length); return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
// Include every byte, including captures and nested manifests. Only this one
// run-wide seal is excluded. Never follow links, devices or directory escapes.
export function savedFiles(root, excluded = []) {
  root = resolve(root); assert.ok(!root.replaceAll("\\", "/").startsWith("//"));
  for (let path = root;; path = dirname(path)) {
    const stat = lstatSync(path); assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    if (path === dirname(path)) break;
  }
  const files = [], seen = new Set(); let total = 0, entries = 0;
  const walk = (dir, prefix = "", depth = 0) => {
    assert.ok(depth <= 64);
    for (const name of readdirSync(dir).sort()) {
      assert.ok(++entries <= 200000 && !/[\\:"<>|?*\x00-\x1f\x7f]/.test(name) && !/[. ]$/.test(name)
        && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name));
      const path = prefix + name, full = join(dir, name), before = lstatSync(full);
      assert.ok(!seen.has(path.toLowerCase()) && !before.isSymbolicLink()); seen.add(path.toLowerCase());
      if (before.isDirectory()) walk(full, path + "/", depth + 1);
      else {
        assert.ok(before.isFile() && before.nlink === 1 && before.size <= 512 * 1024 ** 2);
        total += before.size; assert.ok(total <= 4 * 1024 ** 3);
        if (excluded.includes(path)) continue;
        const body = readFileSync(full), after = lstatSync(full);
        for (const k of ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"]) assert.equal(before[k], after[k]);
        files.push({ path, bytes: body.length, sha256: digest(body) });
      }
    }
  };
  walk(root); return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export function snapshotDependencies(from, to) {
  mkdirSync(to);
  const copy = (source, target, top = false) => {
    for (const name of readdirSync(source).sort()) {
      // These executable links are not used: all native workers call Node and
      // absolute JS entrypoints, never npm/npx or node_modules/.bin commands.
      if (top && name === ".bin") continue;
      const input = join(source, name), output = join(target, name), stat = lstatSync(input);
      assert.ok(!stat.isSymbolicLink(), "linked installed dependency input");
      if (stat.isDirectory()) { mkdirSync(output); copy(input, output); }
      else {
        assert.ok(stat.isFile() && stat.nlink === 1); const body = readFileSync(input);
        writeFileSync(output, body, { flag: "wx" }); assert.equal(digest(readFileSync(input)), digest(body), "dependency changed during snapshot");
      }
    }
  };
  copy(from, to, true); return savedFiles(to);
}

export async function buildNativeImage(docker, { context, runId, commit, source, tag, files, log }) {
  assert.equal(digest(context.input), context.sha256);
  const labels = ["--label", `run.corten.hardening=${runId}`, "--label", "agent.owner=codex", "--label", `agent.task=${runId}`];
  const args = ["build", ...labels, "--label", `run.corten.marketplace.commit=${commit}`, "--label", "run.corten.marketplace.dirty=false",
    "--label", `run.corten.marketplace.profile=${featureProfile}`, "--label", `run.corten.hardening.source=${source}`,
    "--label", `run.corten.hardening.context=${context.sha256}`, "--build-arg", `PROFILE=${qualificationSettings.nativeProfile}`,
    "-t", tag, "-f", context.dockerfile, "-"];
  const command = { args, inputSha256: context.sha256, inputBytes: context.input.length, startedAt: new Date().toISOString() };
  await docker(args, { input: context.input, settleOnInterrupt: true, timeout: 20 * 60 * 1000, file: log, receipt: command });
  Object.assign(command, { exitCode: 0, timedOut: false, interrupted: false, finishedAt: new Date().toISOString() });
  const image = JSON.parse(await docker(["image", "inspect", tag]))[0];
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  return { contextSha256: context.sha256, files, imageId: image.Id, image, command };
}
export function verifyContainerLimit(info, limit) {
  const c = info.HostConfig; assert.ok(c);
  assert.deepEqual([c.NanoCpus, c.Memory, c.MemorySwap, c.PidsLimit], [limit.cpu * 1e9, limit.memory, limit.memory, 512]);
  assert.deepEqual(c.Ulimits, [{ Name: "nofile", Hard: 65536, Soft: 65536 }]);
  assert.equal(c.RestartPolicy.Name, "no"); assert.equal(c.Privileged, false); assert.deepEqual(c.PortBindings, {});
  assert.notEqual(c.OomKillDisable, true, "native workload must remain subject to its OOM limit");
}

// Docker represents the default OOM-killer setting as false before a create is
// started and null after it exits. Both mean enabled; true is never equivalent.
export const nativeHostConfig = (value) => ({ ...value, OomKillDisable: value.OomKillDisable ?? false });

export const readyScript = 'const end=Date.now()+45000; while(true){try{const r=await fetch("http://127.0.0.1:8080/marketplace/en-US/item_1",{signal:AbortSignal.timeout(1000)});await r.arrayBuffer();if(r.status===200)break;}catch{}if(Date.now()>end)throw Error("native startup timeout");await new Promise(r=>setTimeout(r,100));}';

function verifyWorker(r, cell, summary, receipts, folder) {
  const step = r.intent.step, base = step.startsWith("edge-") ? "https://localhost:8080" : "http://127.0.0.1:8080";
  const upstream = `http://${summary.runId}-cell-upstream:8080`, edge = step.startsWith("edge-");
  const qualification = `/results/${edge ? "edge-" : ""}qualification.json`, node = "/repo/bench/hardening/";
  const commands = {
    upstream: ["node", "/repo/bench/marketplace/upstream.mjs"], ready: ["node", "--input-type=module", "-e", readyScript],
    qualification: ["node", "/repo/bench/marketplace/qualify.mjs", base, cell.source, upstream, qualification],
    "edge-qualification": ["node", node + "tls-qualification.mjs", base, cell.source, upstream, qualification],
    "native-controls": ["node", node + "native.mjs", base, cell.source, upstream, qualification, "/results/native-controls.json"],
    "edge-controls": ["node", node + "native.mjs", base, cell.source, upstream, qualification, "/results/edge-native-controls.json", "deployed-edge"],
    parity: ["node", node + "parity.mjs", base, cell.source, upstream, "/results/parity.json"],
    "edge-parity": ["node", node + "parity.mjs", base, cell.source, upstream, "/results/parity.json"],
    probe: ["node", node + "probe.mjs", "/results/probe.json", "/results/raw.jsonl"],
    "terminal-clock": ["node", node + "clock.mjs"], "cleanup-clock": ["node", node + "clock.mjs"],
    certificate: ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "/cert/key.pem", "-out", "/cert/cert.pem", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
  };
  const info = r.created;
  if (commands[step]) assert.deepEqual(info.Config.Cmd, commands[step], "launched native worker command differs");
  else if (step === "application" || step === "proxy") {
    const image = step === "application" ? summary.builds[cell.app].image : summary.tools.edge;
    assert.deepEqual(info.Config.Cmd, image.Config.Cmd); assert.deepEqual(info.Config.Entrypoint, image.Config.Entrypoint);
  } else if (step === "form") {
    assert.equal(info.Config.Cmd.length, 4); assert.deepEqual(info.Config.Cmd.slice(0, 2), ["node", node + "form.mjs"]);
    assert.equal(info.Config.Cmd[3], "/results/form.json");
    const target = JSON.parse(info.Config.Cmd[2]);
    assert.deepEqual(target, { host: "127.0.0.1", port: 8080, authority: "localhost:8080",
      origin: `${cell.mode === "direct" ? "http" : "https"}://localhost:8080`, tls: cell.mode !== "direct",
      ...(cell.mode === "deployed-edge" ? { caPem: readFileSync(join(folder, cell.key, "cert/cert.pem"), "utf8") } : {}) });
  } else if (/^(application|upstream|proxy)-health$/.test(step)) {
    const role = step.split("-")[0], path = r.intent.healthPath;
    assert.ok(path === null || typeof path === "string" && path.startsWith("/"));
    assert.deepEqual(info.Config.Cmd, ["node", node + "lifecycle.mjs", role === "proxy" ? "https://localhost:8080" : "http://127.0.0.1:8080", path, String(summary.budget.recovery.requestTimeoutMs)]);
  } else assert.fail("undeclared native worker");
  const role = step === "application" ? cell.mode === "direct" ? "applicationDirect" : "applicationEdge"
    : step === "proxy" || step === "upstream" ? step : ["ready", "probe", "certificate", "terminal-clock", "cleanup-clock"].includes(step) ? "apparatus" : "qualification";
  assert.equal(r.intent.role, role);
  assert.equal(info.HostConfig.ShmSize, role === "qualification" ? 1024 ** 3 : 64 * 1024 ** 2, "native shared-memory allocation differs");
  if (step === "probe") {
    assert.equal(info.HostConfig.PidMode, "host", "native process observer must see runner-host PIDs");
    assert.equal(info.HostConfig.CgroupnsMode, "host", "native resource observer must see runner-host cgroups");
  }
  const tool = role === "qualification" ? "checker" : step === "certificate" ? "cert" : step === "proxy" ? "edge" : "node";
  if (step !== "application") assert.equal(info.Image, summary.tools[tool].Id);
  else assert.equal(info.Image, summary.builds[cell.app].imageId);
  const image = step === "application" ? summary.builds[cell.app].image : summary.tools[tool];
  if (!["application", "proxy"].includes(step)) assert.deepEqual(info.Config.Entrypoint, image.Config.Entrypoint);
  for (const key of ["User", "WorkingDir"]) assert.equal(info.Config[key] ?? "", image.Config[key] ?? "");
  const environment = new Map((image.Config.Env ?? []).map((s) => [s.slice(0, s.indexOf("=")), s.slice(s.indexOf("=") + 1)]));
  const overrides = step === "application" ? { MARKETPLACE_SOURCE: cell.source, MARKETPLACE_FIXTURE_PATH: "/fixtures/marketplace.json",
    API_BASE: upstream, PORT: "8080", HOSTS: "fsw-target,localhost,127.0.0.1", PROFILE: qualificationSettings.nativeProfile, MAX_CONNECTIONS: String(qualificationSettings.maxConnections) }
    : role === "qualification" ? { PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
      ...(cell.mode === "deployed-edge" && !["qualification", "native-controls", "parity"].includes(step)
        ? { NODE_EXTRA_CA_CERTS: "/results/cert/cert.pem", BENCH_EDGE_CERT: "/results/cert/cert.pem" } : {}) } : {};
  for (const [key, value] of Object.entries(overrides)) environment.set(key, value);
  assert.deepEqual([...(info.Config.Env ?? [])].sort(), [...environment].map(([key, value]) => `${key}=${value}`).sort(), "unbound native worker environment");
  assert.equal(r.intent.operation, ["application", "upstream", "proxy"].includes(step) ? "run" : "create");
  const paths = /^[A-Za-z]:[\\/]/.test(summary.originalFolder) ? win32 : posix;
  assert.ok(paths.isAbsolute(summary.originalFolder) && !summary.originalFolder.replaceAll("\\", "/").startsWith("//"));
  const source = paths.join(summary.originalFolder, "corten-build-context"), out = paths.join(summary.originalFolder, cell.key);
  const mounts = info.Mounts.map((m) => ({ source: m.Source, target: m.Destination, readOnly: !m.RW }));
  const expectedMounts = [];
  const required = (target, source, readOnly = true) => expectedMounts.push({ source, target, readOnly });
  if (["upstream", "probe", "terminal-clock", "cleanup-clock"].includes(step)) required("/repo", source);
  if (role === "qualification") {
    for (const path of ["bench", "scripts", "package.json"]) required(`/repo/${path}`, paths.join(source, path));
    required("/repo/node_modules", paths.join(summary.originalFolder, "dependencies")); required("/results", out, false);
  }
  if (["application", "upstream"].includes(step) || role === "qualification") required("/fixtures", paths.join(summary.originalFolder, "fixtures"));
  if (step === "probe") required("/results", out, false);
  if (step === "certificate" || step === "proxy") required("/cert", paths.join(out, "cert"), step === "proxy");
  if (step === "proxy") required("/etc/nginx/nginx.conf", paths.join(out, "nginx.conf"));
  if (step === "probe") required("/sys/fs/cgroup", "/sys/fs/cgroup");
  const order = (a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
  assert.deepEqual(mounts.sort(order), expectedMounts.sort(order), "external, extra or writable source/tool input mount");
  // Inspect metadata cannot vouch for a different acknowledged command. Parse
  // the fixed native CLI vocabulary and compare it to the procedure, not intent.
  const args = r.creation.args.slice(9), options = new Map(), volumes = [], env = [];
  const scalar = new Set(["--network", "--network-alias", "--cpus", "--memory", "--memory-swap", "--pids-limit", "--ulimit", "--shm-size"]);
  let index = 0;
  while (typeof args[index] === "string" && args[index].startsWith("-")) {
    const flag = args[index++];
    if (flag === "-v" || flag === "-e" || scalar.has(flag)) {
      assert.equal(typeof args[index], "string", "native launch option value missing");
      const value = args[index++];
      if (flag === "-v") volumes.push(value);
      else if (flag === "-e") env.push(value);
      else { assert.ok(!options.has(flag), "duplicate native launch option"); options.set(flag, value); }
    } else {
      assert.ok(["-d", "--cgroupns=host", "--pid=host"].includes(flag), "undeclared native launch option");
      assert.ok(!options.has(flag)); options.set(flag, true);
    }
  }
  assert.equal(args[index++], image.Id, "acknowledged native launch image differs");
  assert.deepEqual(args.slice(index), ["application", "proxy"].includes(step) ? [] : info.Config.Cmd, "acknowledged native launch command differs");
  const limit = summary.budget.resources[role], expectedOptions = new Map([
    ["--cpus", String(limit.cpu)], ["--memory", String(limit.memory)], ["--memory-swap", String(limit.memory)],
    ["--pids-limit", "512"], ["--ulimit", "nofile=65536:65536"],
  ]);
  if (role === "qualification") expectedOptions.set("--shm-size", "1g");
  if (step === "probe") { expectedOptions.set("--cgroupns=host", true); expectedOptions.set("--pid=host", true); }
  if (["application", "upstream", "proxy"].includes(step)) expectedOptions.set("-d", true);
  if (step === "application") expectedOptions.set("--network-alias", "fsw-target");
  const isolated = ["certificate", "terminal-clock", "cleanup-clock"].includes(step), service = ["application", "upstream", "proxy"].includes(step);
  let network = isolated ? "none" : service ? `${summary.runId}-net` : null;
  if (network === null) {
    const targetRole = step.endsWith("-health") ? step.split("-")[0]
      : edge || ["form", "probe"].includes(step) && cell.mode === "deployed-edge" ? "proxy" : "application";
    const owner = receipts.find((other) => other.intent.cell === cell.key && other.intent.step === targetRole)?.created
      ?? (cell.status !== "observed" ? r.namespace : null);
    if (!owner) missingProof("native namespace owner missing");
    const actual = options.get("--network");
    assert.ok([`container:${owner.Id}`, `container:${owner.Name.slice(1)}`].includes(actual), "acknowledged native namespace differs");
    network = actual;
  }
  expectedOptions.set("--network", network);
  assert.deepEqual([...options].sort(), [...expectedOptions].sort(), "acknowledged native limits/options differ");
  assert.deepEqual(volumes.sort(), expectedMounts.map((m) => `${m.source}:${m.target}${m.readOnly ? ":ro" : ""}`).sort(), "acknowledged native mounts differ");
  assert.deepEqual(env.sort(), Object.entries(overrides).map(([key, value]) => `${key}=${value}`).sort(), "acknowledged native environment differs");
}

const missingProof = (message) => { throw Object.assign(new Error(message), { code: "ENOENT" }); };
export function verifyOwnedReceipts(receipts, summary, folder) {
  assert.ok(Array.isArray(receipts)); if (!receipts.length) missingProof("missing owned container receipts");
  const ids = new Set(), launches = new Map(), resources = summary.budget.resources;
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i]; assert.equal(r.index, i); assert.equal(r.schema, "native-hardening-container/v2");
    assert.ok(r.intent && ["create", "run"].includes(r.intent.operation));
    const before = r.created, end = r.terminal; if (!before || !end) missingProof("missing owned container lifetime");
    const cell = summary.cells.find((c) => c.key === r.intent.cell); assert.ok(cell);
    verifyContainerCommands(r, summary.runId);
    verifyWorker(r, cell, summary, receipts, folder);
    assert.match(before.Id, /^[a-f0-9]{64}$/); assert.ok(!ids.has(before.Id)); ids.add(before.Id);
    assert.equal(before.Config.Labels?.["run.corten.hardening"], summary.runId);
    assert.equal(before.Config.Labels?.["agent.owner"], "codex"); assert.equal(before.Config.Labels?.["agent.task"], summary.runId);
    assert.equal(end.Id, before.Id); assert.equal(end.Image, before.Image); assert.equal(end.RestartCount, 0);
    assert.deepEqual(nativeHostConfig(end.HostConfig), nativeHostConfig(before.HostConfig));
    const config = { ...before.Config };
    if (end.Config.Hostname !== config.Hostname) {
      // Docker fills the joined namespace hostname on start. Bind this one
      // transition to the independently inspected original namespace owner.
      if (!r.namespace) missingProof("joined namespace identity observation missing");
      assert.equal(before.HostConfig.NetworkMode, `container:${r.namespace.Id}`);
      assert.equal(config.Hostname, before.Id.slice(0, 12));
      assert.equal(end.Config.Hostname, r.namespace.Config.Hostname);
      config.Hostname = r.namespace.Config.Hostname;
    }
    assert.deepEqual(end.Config, config);
    if (!r.removed) missingProof("owned container removal unacknowledged"); assert.ok(Number.isFinite(Date.parse(r.removedAt)));
    const suffix = r.intent.step === "application" ? "app" : r.intent.step === "proxy" ? "edge" : r.intent.step;
    assert.equal(before.Name, `/${r.intent.step === "ready" ? `${summary.runId}-ready` : `${summary.runId}-cell-${suffix}`}`);
    assert.equal(r.intent.name, before.Name.slice(1));
    assert.ok(Date.parse(r.removedAt) >= Date.parse(summary.startedAt) && Date.parse(r.removedAt) <= Date.parse(summary.finishedAt));
    let role = r.intent.role;
    assert.ok(["applicationDirect", "applicationEdge", "upstream", "proxy", "qualification", "apparatus"].includes(role));
    verifyContainerLimit(before, resources[role]);
    if (!["applicationDirect", "applicationEdge", "proxy"].includes(role)) {
      const tool = role === "qualification" ? "checker" : r.intent.tool;
      assert.ok(["node", "checker", "cert"].includes(tool)); assert.equal(before.Image, summary.tools[tool].Id);
    }
    let acceptedTargetExit = false;
    if (r.intent.step.endsWith("-health") && r.start?.exitCode !== 0 && folder) {
      const role = r.intent.step.split("-")[0], life = JSON.parse(readFileSync(join(folder, cell.key, `${role}-lifecycle.json`)));
      const state = life.after.State;
      acceptedTargetExit = (["application", "proxy"].includes(role) || role === "upstream" && cell.source === "api")
        && life.health.unavailable === "not-running" && typeof life.health.observerError === "string"
        && !state.Running && state.Status === "exited" && !state.Error && !state.Dead
        && Number.isInteger(state.ExitCode) && Date.parse(state.FinishedAt) >= Date.parse(life.before.State.StartedAt)
        && life.after.Id === life.before.Id && state.StartedAt === life.before.State.StartedAt;
      assert.ok(acceptedTargetExit, "health worker failure is not an independently retained critical target exit");
      assert.equal(r.intent.healthPath, life.health.path);
    }
    if (r.intent.operation === "create" && !acceptedTargetExit) {
      if (!r.start) missingProof("missing apparatus start acknowledgement");
      assert.ok(r.start && r.start.exitCode === 0 && r.start.timedOut === false && r.start.interrupted === false,
        "apparatus start did not finish successfully");
      assert.equal(end.State.Running, false); assert.equal(end.State.ExitCode, 0);
      assert.equal(end.State.OOMKilled, false); assert.ok(Date.parse(end.State.FinishedAt) >= Date.parse(end.State.StartedAt));
      assert.ok(Date.parse(r.start.finishedAt) >= Date.parse(r.start.startedAt) && Date.parse(r.removedAt) >= Date.parse(r.start.finishedAt));
    }
    if (!acceptedTargetExit) {
      assert.equal(end.State.Error, ""); assert.equal(end.State.Dead, false); assert.equal(end.State.Restarting, false);
      assert.ok(Number.isFinite(Date.parse(end.State.StartedAt)) && Date.parse(end.State.StartedAt) > 0);
    }
    if (r.intent.cell) {
      const list = launches.get(r.intent.cell) ?? []; list.push(r); launches.set(r.intent.cell, list);
    }
  }
  for (const c of summary.cells.filter((c) => c.status === "observed")) {
    const list = launches.get(c.key) ?? [];
    for (const name of ["upstream", "application", "ready", "qualification", "native-controls", "parity", "form", "probe", "terminal-clock", "cleanup-clock",
      ...(c.mode === "deployed-edge" ? ["certificate", "proxy", "edge-qualification", "edge-parity", "edge-controls"] : [])])
      if (!list.some((r) => r.intent.step === name)) missingProof("missing charged native apparatus step");
    for (const step of new Set(list.map((r) => r.intent.step))) assert.equal(list.filter((r) => r.intent.step === step).length, step === "terminal-clock" ? 2 : 1);
    const target = (role) => list.find((r) => r.intent.step === role).created.Id;
    for (const r of list) {
      const step = r.intent.step;
      const network = ["certificate", "terminal-clock", "cleanup-clock"].includes(step) ? "none"
        : ["upstream", "application", "proxy"].includes(step) ? `${summary.runId}-net`
          : `container:${target(step.endsWith("-health") ? step.split("-")[0] : step.startsWith("edge-") || ["form", "probe"].includes(step) && c.mode === "deployed-edge" ? "proxy" : "application")}`;
      assert.equal(r.created.HostConfig.NetworkMode, network, "native worker namespace differs");
    }
  }
  return launches;
}

export function verifyRunInputs(folder, summary) {
  const input = JSON.parse(readFileSync(join(folder, "inputs.json"), "utf8"));
  assert.equal(input.schema, "native-hardening-inputs/v1"); assert.equal(input.commit, summary.commit);
  const files = committedInputs(repository, summary.commit); assert.deepEqual(input.files, files);
  const contextFiles = (app) => files.filter((f) => app === "corten" || f.path.startsWith(`bench/fullstack/apps/${app}/`));
  const body = (file) => readFileSync(join(folder, file));
  for (const [app, build] of Object.entries(summary.builds ?? {})) {
    assert.match(app, /^[a-z][a-z0-9-]*$/); assert.ok(summary.cells.some((c) => c.app === app));
    const prefix = app === "corten" ? "" : `bench/fullstack/apps/${app}/`, expected = contextFiles(app);
    const archive = sourceGit(repository, ["archive", "--format=tar", `${summary.commit}${prefix ? `:${prefix.slice(0, -1)}` : ""}`]);
    assert.equal(build.contextSha256, digest(archive)); assert.equal(digest(body(`${app}-build-context.tar`)), build.contextSha256);
    const actual = savedFiles(join(folder, `${app}-build-context`)).map(({ path, sha256 }) => ({ path: prefix + path, sha256 }));
    assert.deepEqual(actual, expected.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    assert.deepEqual(build.files, expected);
    assert.match(build.imageId, /^sha256:[a-f0-9]{64}$/); assert.equal(build.image.Id, build.imageId);
    assert.equal(build.image.Config.Labels["run.corten.hardening.context"], build.contextSha256);
    assert.equal(build.image.Config.Labels["run.corten.marketplace.commit"], summary.commit);
    const receipt = requireCommandAcknowledgement(build.command, ["timedOut", "interrupted", "inputSha256", "inputBytes"]);
    assert.equal(receipt.exitCode, 0); assert.equal(receipt.timedOut, false); assert.equal(receipt.interrupted, false);
    assert.equal(receipt.inputSha256, build.contextSha256); assert.equal(receipt.inputBytes, archive.length);
    assert.ok(Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt));
    const dockerfile = app === "corten" ? "bench/marketplace/corten/Dockerfile" : "Dockerfile";
    const labels = build.image.Config.Labels, expectedSource = digest(JSON.stringify(files.filter((f) => app === "corten"
      ? ["Cargo.toml", "Cargo.lock"].includes(f.path) || f.path.startsWith("crates/") || f.path.startsWith("bench/marketplace/corten/")
      : f.path.startsWith(prefix)).map((f) => [f.path, f.sha256])));
    assert.equal(labels["run.corten.hardening.source"], expectedSource);
    assert.deepEqual(receipt.args, ["build", "--label", `run.corten.hardening=${summary.runId}`, "--label", "agent.owner=codex", "--label", `agent.task=${summary.runId}`,
      "--label", `run.corten.marketplace.commit=${summary.commit}`, "--label", "run.corten.marketplace.dirty=false", "--label", `run.corten.marketplace.profile=${featureProfile}`,
      "--label", `run.corten.hardening.source=${expectedSource}`, "--label", `run.corten.hardening.context=${build.contextSha256}`,
      "--build-arg", `PROFILE=${qualificationSettings.nativeProfile}`, "-t", `${summary.runId}-${app}`, "-f", dockerfile, "-"]);
  }
  // The root context is also the immutable mounted harness/input snapshot.
  if (!summary.builds?.corten) missingProof("full source/harness build closure missing");
  assert.deepEqual(savedFiles(join(folder, "dependencies")), input.dependencies);
  const lock = JSON.parse(body("corten-build-context/package-lock.json"));
  for (const name of ["@playwright/test", "playwright", "playwright-core"]) {
    const pkg = JSON.parse(body(`dependencies/${name}/package.json`));
    assert.equal(pkg.version, lock.packages[`node_modules/${name}`].version);
  }
  for (const cell of summary.cells.filter((c) => c.status === "observed")) if (!summary.builds[cell.app]) missingProof("native image build input closure missing");
  return input;
}
export function artifacts(folder) {
  const entries = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name); assert.ok(!lstatSync(path).isSymbolicLink(), "artifact symlinks forbidden");
      if (entry.isDirectory()) walk(path);
      else if (!["manifest.json", "capture.json"].includes(entry.name)) {
        const bytes = readFileSync(path); entries.push({ path: relative(folder, path).replaceAll("\\", "/"), bytes: bytes.length, sha256: digest(bytes) });
      }
    }
  };
  walk(folder); return entries.sort((a, b) => a.path.localeCompare(b.path));
}
export function verifyArtifacts(folder, manifest) {
  assert.ok(Array.isArray(manifest) && manifest.length > 0);
  for (const row of manifest) {
    assert.ok(typeof row.path === "string" && !isAbsolute(row.path));
    const rel = relative(resolve(folder), resolve(folder, row.path));
    assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel), "artifact escaped result directory");
  }
  assert.deepEqual(artifacts(folder), manifest, "raw artifact missing, added or modified");
}
const unavailable = (reason) => ({ status: "unavailable", reason });
const percentile = (values, share) => values[Math.min(values.length - 1, Math.ceil(values.length * share) - 1)];

export function verifyParity(parity, source) {
  assert.equal(parity.workload, "marketplace-v2"); assert.equal(parity.source, source);
  assert.equal(parity.jsonRecords, 500); assert.equal(parity.pages, 264); assert.equal(parity.profiles.length, 12);
  const keys = parity.profiles.map((p) => { assert.equal(p.passed, true); return `${p.locale}/${p.javaScriptEnabled}/${p.mobile}`; });
  assert.equal(new Set(keys).size, 12);
  for (const locale of ["en-US", "fr-FR", "de-DE"]) for (const js of [true, false]) for (const mobile of [true, false]) assert.ok(keys.includes(`${locale}/${js}/${mobile}`));
  if (source === "api") assert.deepEqual(parity.upstream, { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true });
}

export function defensiveRejection(phase, row) {
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(row.responsePrefix)?.[1]);
  if (phase === "oversized-requests") return row.variant === "body-size" ? status === 413 : [414, 431].includes(status);
  if (["slow-headers", "slow-bodies", "idle-connections"].includes(phase)) return status === 408 || phase === "slow-bodies" && status === 413;
  return phase === "connection-pressure" && status === 429;
}

export function verifyNativeLimits(settings, lifecycle) {
  const b = validateBudget(JSON.parse(settings.effectiveBudgets)), edge = settings.case === "deployed-edge";
  assert.deepEqual(settings.deployment.processes.map((p) => p.role).sort(), ["application", "upstream", ...(edge ? ["proxy"] : [])].sort(), "native deployment roles were dropped or added outside the exact budget");
  for (const p of settings.deployment.processes) {
    const state = lifecycle[p.id]; assert.ok(state?.before?.HostConfig && state?.after?.HostConfig, "missing actual native limits");
    const limit = p.role === "application" ? b.resources[edge ? "applicationEdge" : "applicationDirect"] : b.resources[p.role];
    const actual = state.before.HostConfig;
    assert.equal(actual.NanoCpus, limit.cpu * 1e9, `${p.id}: actual CPU quota differs from declared budget`);
    assert.equal(actual.Memory, limit.memory, `${p.id}: actual memory limit differs from declared budget`);
    assert.equal(actual.MemorySwap, limit.memory, `${p.id}: undeclared swap allowance`);
    assert.equal(actual.PidsLimit, 512, `${p.id}: actual task limit differs`);
    assert.deepEqual(actual.Ulimits, [{ Name: "nofile", Hard: 65536, Soft: 65536 }], `${p.id}: actual FD limit differs`);
    assert.equal(actual.RestartPolicy.Name, "no", "automatic restart cannot manufacture recovery");
    assert.equal(actual.Privileged, false); assert.deepEqual(actual.PortBindings, {}, "native verification must not publish ports");
    assert.deepEqual(nativeHostConfig(state.after.HostConfig), nativeHostConfig(actual), "native deployment configuration changed during injection");
    assert.ok(!state.events.some((event) => event.Action === "update"), "external configuration intervention invalidates apparatus");
  }
}

export function assemble({ settings, raw, parity, source, cleanup, provenance, lifecycle }) {
  const b = validateBudget(JSON.parse(settings.effectiveBudgets)); verifyParity(parity, source);
  verifyNativeLimits(settings, lifecycle);
  const expected = records().item_1;
  for (const row of raw.filter((r) => r.type === "legitimate")) validateLegitimate(row, expected, b.recovery.requestTimeoutMs);
  if (settings.nativeSource === "api") { assert.equal(source, "api"); assessTimedSource(raw); }
  const one = (type) => { const rows = raw.filter((r) => r.type === type); assert.equal(rows.length, 1, `missing/duplicate ${type}`); return rows[0]; };
  for (const type of ["control-before", "control-after"]) {
    const control = one(type); validateControl(control); assert.equal(control.phase, settings.phase);
  }
  const reaped = one("probe-cleanup");
  assert.equal(reaped.connections, 0); assert.equal(reaped.tasks, 0); assert.deepEqual(reaped.errors, []); assert.deepEqual(reaped.failures, []);
  assert.ok(reaped.eventLoopMaxMs <= b.timing.maxStartLagMs, "injector event loop stalled");
  assert.equal(cleanup.complete, true); assert.equal(cleanup.containers.length, 0); assert.equal(cleanup.volumes.length, 0);
  assert.equal(cleanup.commandClients, 0);
  const clock = one("clock");
  assert.equal(cleanup.nativeClock?.bootId, clock.bootId, "cleanup and injector clocks are not from the same kernel boot");
  assert.match(clock.monotonicNs, /^\d+$/); assert.match(cleanup.nativeClock.monotonicNs, /^\d+$/);
  const cleanupAtMs = Number(BigInt(cleanup.nativeClock.monotonicNs) - BigInt(clock.monotonicNs)) / 1e6;
  assert.ok(cleanupAtMs >= reaped.atMs, "cleanup clock preceded injector cleanup");
  if (Object.values(lifecycle).some((p) => p.observation)) {
    const complete = one("probe-complete");
    assert.ok(Number.isFinite(complete.atMs) && complete.atMs >= Math.max(reaped.atMs, b.legitimate.after.endMs));
    assert.ok(raw.indexOf(complete) > raw.indexOf(one("control-after")), "terminal boundary preceded final receiving controls");
    const minimum = BigInt(clock.monotonicNs) + BigInt(Math.ceil(complete.atMs * 1e6));
    for (const p of Object.values(lifecycle)) {
      const window = p.observation; assert.ok(window, "missing terminal observation interval");
      for (const bound of [window.start, window.end]) {
        assert.equal(bound.bootId, clock.bootId, "terminal observation and injector clocks differ");
        assert.match(bound.monotonicNs, /^\d+$/);
      }
      assert.ok(BigInt(window.start.monotonicNs) >= minimum && BigInt(window.end.monotonicNs) >= BigInt(window.start.monotonicNs)
        && BigInt(window.end.monotonicNs) <= BigInt(cleanup.nativeClock.monotonicNs), "terminal observation interval escaped post-probe/pre-cleanup bounds");
    }
  }
  const attack = raw.filter((r) => r.type === "attack").sort((a, c) => a.index - c.index);
  assert.deepEqual(attack.map((r) => r.index), b.attack.scheduledAtMs.map((_, i) => i), "attack attempt indices incomplete");
  assert.ok(Array.isArray(settings.emissionPlan) && settings.emissionPlan.length === attack.length, "missing exact native emission plan; historical evidence cannot establish current semantic qualification");
  for (const row of attack) validateAttack(row, settings.emissionPlan[row.index], b);
  assert.ok(attack.every((r) => r.phase === settings.phase && r.endedAtMs >= r.startedAtMs));
  assert.ok(attack.reduce((n, r) => n + r.bytesQueued, 0) <= b.attack.maxWireBytes, "injector wire budget exceeded");
  if (settings.phase === "oversized-requests") for (const variant of ["header-count", "header-size", "body-size"]) assert.ok(attack.some((r) => r.variant === variant));
  const legitimate = {}, resources = {};
  for (const [window, w] of Object.entries(b.legitimate)) {
    const boundary = (name) => { const rows = raw.filter((r) => r.type === "window" && r.window === window && r.boundary === name); assert.equal(rows.length, 1); return rows[0].atMs; };
    const startMs = boundary("startMs"), endMs = boundary("endMs");
    const rows = raw.filter((r) => r.type === "legitimate" && r.window === window).sort((a, c) => a.index - c.index);
    assert.deepEqual(rows.map((r) => r.index), w.scheduledAtMs.map((_, i) => i), "legitimate attempt indices incomplete");
    const paths = ["/marketplace/en-US/item_1", "/marketplace/fr-FR/item_1", "/marketplace/de-DE/item_1", "/api/marketplace/item_1"];
    for (const row of rows) {
      assert.equal(row.path, paths[row.index % paths.length], "scheduled native request path was substituted");
      if (row.bodyComplete) assert.ok(row.endedAtMs <= endMs, "completed response escaped its observation window");
    }
    const times = rows.filter((r) => r.ok).map((r) => r.latencyMs).sort((a, c) => a - c);
    legitimate[window] = { startMs, endMs, counts: { sent: rows.length, ok: times.length, errors: rows.length - times.length },
      startedAtMs: rows.map((r) => r.startedAtMs), latency: times.length ? { p50Ms: percentile(times, 0.5), p99Ms: percentile(times, 0.99), maxMs: times.at(-1) } : unavailable("no successful legitimate requests"), evidence: `raw.jsonl#legitimate/${window}` };
    const samples = raw.filter((r) => r.type === "resources" && r.window === window); assert.equal(samples.length, 1);
    const sample = samples[0];
    if (sample.collectedAtMs !== undefined) assert.ok(sample.atMs >= startMs && sample.collectedAtMs >= sample.atMs && sample.collectedAtMs <= endMs, "resource collection escaped observation window");
    assert.deepEqual(Object.keys(sample.samples).sort(), settings.deployment.processes.map((p) => p.id).sort());
    resources[window] = settings.deployment.processes.map((p) => {
      const s = sample.samples[p.id], state = lifecycle[p.id]; assert.ok(state, "missing lifecycle evidence");
      const sampleWall = Date.parse(clock.wallAtStart) + (sample.collectedAtMs ?? sample.atMs);
      assert.equal(state.before.State.Running, true); assert.equal(state.after.Id, state.before.Id); assert.equal(state.after.State.StartedAt, state.before.State.StartedAt, "target restarted");
      assert.ok(!state.after.State.Error, "Docker lifecycle failure");
      assert.ok(!state.events.some((e) => ["kill", "stop", "start", "restart", "pause", "unpause", "destroy"].includes(e.Action)), "external lifecycle intervention invalidates apparatus");
      if (s.unavailable) assert.ok(state.after.State.Running === false && Date.parse(state.after.State.FinishedAt) <= sampleWall, "unexplained missing resource evidence");
      const running = s.unavailable ? false : s.running;
      if (!s.unavailable) {
        if (s.startedNs !== undefined) {
          const began = Number(BigInt(s.startedNs) - BigInt(clock.monotonicNs)) / 1e6, ended = Number(BigInt(s.endedNs) - BigInt(clock.monotonicNs)) / 1e6;
          assert.ok(began >= sample.atMs && ended >= began && ended <= sample.collectedAtMs, "resource counter timestamp differs from collection interval");
          assert.ok(s.procs.every((pid) => /^[1-9]\d*$/.test(pid)), "native PID inventory hidden by observer namespace");
        }
        assert.equal(s.cpuSeconds, Number(/^usage_usec (\d+)$/m.exec(s.cpu)?.[1]) / 1e6, "CPU differs from raw cgroup counter");
        assert.equal(s.memoryBytes, Number(s.memory), "memory differs from raw cgroup counter");
        assert.equal(s.running, s.procs.length > 0, "running differs from process inventory");
        assert.equal(s.oomKilled, Number(/^oom_kill (\d+)$/m.exec(s.events)?.[1]) > 0, "OOM differs from raw cgroup events");
      }
      const oomKilled = !running && (s.unavailable ? state.after.State.OOMKilled : s.oomKilled);
      return { id: p.id, count: p.count, observedProcessCount: s.procs?.length ?? unavailable("container exited before sample"), atMs: s.unavailable ? sample.collectedAtMs ?? sample.atMs : sample.atMs, running, oomKilled,
        cpuSeconds: s.cpuSeconds ?? unavailable(s.unavailable), memoryBytes: s.memoryBytes ?? unavailable(s.unavailable), evidence: `raw.jsonl#resources/${window}/${p.id}` };
    });
  }
  const established = attack.filter((r) => r.established), closed = established.filter((r) => r.targetClosedAtMs !== null);
  const after = raw.filter((r) => r.type === "legitimate" && r.window === "after");
  const recoveryStart = Math.max(b.legitimate.during.endMs, legitimate.during.endMs), recovered = after.filter((r) => r.ok && r.startedAtMs >= recoveryStart).sort((a, c) => a.endedAtMs - c.endedAtMs)[0];
  const terminal = terminalRecovery(recovered, settings.deployment.processes, resources.after, lifecycle, source, settings.terminalHealthPaths);
  const rejected = established.filter((r) => defensiveRejection(settings.phase, r));
  const missing = ["slow-headers", "slow-bodies", "idle-connections"].includes(settings.phase) && established.length > 0 && closed.length === 0;
  // Closing a slow reader is not proof it reached write backpressure. No generic cap/timeout attribution.
  const protection = rejected.length ? "observed" : missing ? "missing" : "inconclusive";
  const capture = { schema: hardeningCaptureSchema, contract: hardeningContract, case: settings.case, phase: settings.phase,
    deployment: settings.deployment, effectiveBudgets: settings.effectiveBudgets, provenance,
    parity: { status: "passed", contract: "marketplace-v2/native-browser-and-content", evidence: "parity.json" },
    apparatus: { injector: { healthy: true, scheduled: b.attack.scheduledAtMs.length, attempted: attack.length, errors: 0, dropped: 0, evidence: "raw.jsonl#attack" },
      host: { healthy: true, evidence: "raw.jsonl#probe-cleanup" }, controls: { attackValid: true, legitimateValid: true, evidence: "raw.jsonl#control-before,control-after" },
      artifacts: { complete: true, evidence: "manifest.json" }, cleanup: { complete: true, atMs: cleanupAtMs,
        connections: 0, processes: 0, tasks: 0, evidence: "cleanup.json" } },
    attack: { attempted: attack.length, established: established.length, failed: attack.length - established.length, closed: closed.length, held: established.length - closed.length,
      startedAtMs: attack.map((r) => r.startedAtMs), evidence: "raw.jsonl#attack" }, legitimate, resources,
    recovery: { attempted: true, startMs: recoveryStart, endMs: terminal.disposition === "recovered" ? recovered.endedAtMs : legitimate.after.endMs,
      ...terminal, evidence: "raw.jsonl#legitimate/after and service-critical native lifecycle after snapshots" },
    defense: { protection, reason: rejected.length ? "native HTTP rejection observed; see exact statuses and incomplete sends" : missing ? "connections retained to the declared release; no closure protection observed within this profile" : "bounded observations do not identify a protection mechanism",
      attribution: [{ layer: "unknown", mechanism: "raw closure/rejection/unread-queue evidence only; no inferred server/proxy mechanism", evidence: "raw.jsonl#attack" }] } };
  return validateHardeningOutcome(capture, settings);
}

export function targetOutcome(capture, assessment, sourceObservation) {
  const service = Object.fromEntries(Object.entries(capture.legitimate).map(([key, value]) => [key, value.counts]));
  return { classification: Object.values(service).some((counts) => counts.errors > 0) || capture.recovery.disposition !== "recovered"
    ? "target-capacity-failure" : "service-preserved", service, recovery: capture.recovery.disposition,
    measurement: capture.measurement, numericComparisonQualified: capture.measurement === "complete" && capture.recovery.disposition === "recovered"
      && Object.values(service).every((counts) => counts.errors === 0) && assessment?.productionQualified === true
      && (!sourceObservation || sourceObservation.state === "observed") };
}
