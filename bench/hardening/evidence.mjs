import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, statfsSync, openSync, readSync, writeSync, readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative, isAbsolute, posix, win32 } from "node:path";
import { validateBudget, phases } from "./plan.mjs";
import { verifyContainerCommands, requireCommandAcknowledgement } from "./lifecycle.mjs";
import { qualificationSettings, featureProfile } from "../marketplace/feature-contract.mjs";
import { edgeOffset, nginxConf } from "../fullstack/edge.mjs";
import { nativeBuildArchiveArgs } from "../mixed-production/build-context.mjs";
import { cpuSetWithin, hardeningCpuGate, hardeningGateMs, hardeningRoleCpu } from "../workloads/isolated/native-roles.mjs";

export const edgePublicOrigin = "https://localhost:8080";
export const proxyConfig = () => nginxConf([["target", { port: 8080 - edgeOffset, publicAuthority: new URL(edgePublicOrigin).host }]], 1);
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
  from = resolve(from); to = resolve(to);
  const type = (s) => !s ? "unknown" : s.isSymbolicLink() ? "symlink" : s.isFile() ? "file"
    : s.isDirectory() ? "directory" : s.isFIFO() ? "fifo" : "special";
  const reject = (reason, path = ".", stat, code) => {
    const detail = { path: path.slice(0, 64), reason, type: type(stat), nlink: stat ? String(stat.nlink) : null };
    if (code) detail.fsCode = ["ENOENT", "ELOOP", "EACCES", "EPERM", "EBUSY", "EIO", "ENOSPC", "EDQUOT", "EMFILE", "ENFILE", "EEXIST", "ENOTDIR"].includes(code) ? code : "unknown";
    throw Object.assign(new Error(`dependency snapshot rejected ${JSON.stringify(detail)}`), { code: "ERR_DEPENDENCY_SNAPSHOT" });
  };
  const io = (path, action, reason = "input-io") => {
    try { return action(); }
    catch (error) { if (error.code === "ERR_DEPENDENCY_SNAPSHOT") throw error; reject(reason, path, undefined, error.code); }
  };
  const info = (full, path) => io(path, () => lstatSync(full, { bigint: true }));
  const keys = ["dev", "ino", "mode", "uid", "gid", "size", "nlink", "mtimeNs", "ctimeNs", "birthtimeNs"];
  const same = (before, after, path, fields = keys) => {
    if (after.isSymbolicLink()) reject("linked-input", path, after);
    if (type(before) !== type(after) || fields.some((key) => before[key] !== after[key])) reject("changed-input", path, after);
  };
  const chain = (full) => {
    const paths = [];
    for (let path = full;; path = dirname(path)) { paths.unshift(path); if (path === dirname(path)) return paths; }
  };
  const directory = (full, path) => {
    const stat = info(full, path);
    if (stat.isSymbolicLink()) reject("linked-input", path, stat);
    if (!stat.isDirectory()) reject("unsupported-entry", path, stat);
    return stat;
  };
  const within = (root, path) => {
    const delta = relative(root, path).replaceAll("\\", "/");
    return !isAbsolute(delta) && delta !== ".." && !delta.startsWith("../");
  };
  if ([from, to].some((p) => p.replaceAll("\\", "/").startsWith("//")) || within(from, to) || within(to, from)) reject("unsafe-root");
  const ancestors = chain(from).map((full) => ({ full, stat: directory(full, ".") }));
  const outputAncestors = chain(dirname(to)).map((full) => ({ full, stat: directory(full, ".") }));
  const outputDirectories = new Map(), outputFiles = new Map();
  const directoryKeys = ["dev", "ino", "mode", "uid", "gid", "birthtimeNs"];
  // libuv UV_FS_O_EXLOCK (include/uv/win.h) is not in fs.constants. Windows
  // exclusive directory handles deny rename/delete sharing but allow children.
  const directoryFlags = constants.O_RDONLY | (process.platform === "win32" ? 0x10000000
    : (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  const fdPath = (fd) => `${process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"}/${fd}`;
  const outputFilesystem = (fd, path) => {
    // Native ext-family, tmpfs and overlayfs only. DrvFS/9p can resolve a
    // descriptor child through a replaced name; bookends are too late for wx.
    if (process.platform === "linux" && ![0xef53n, 0x01021994n, 0x794c7630n].includes(
      io(path, () => statfsSync(fdPath(fd), { bigint: true }), "output-io").type)) reject("unsupported-output-filesystem", path);
  };
  const outputSame = (before, after, path, fields = directoryKeys) => {
    if (type(before) !== type(after) || fields.some((key) => before[key] !== after[key])) reject("changed-output", path, after);
  };
  const guardOutput = (path = ".", complete = false) => {
    for (const { full, stat } of outputAncestors) outputSame(stat, info(full, "."), ".");
    const paths = [];
    for (let at = path;; at = posix.dirname(at)) { paths.push(at); if (at === ".") break; }
    for (const at of complete ? outputDirectories.keys() : paths) {
      const entry = outputDirectories.get(at); if (!entry) continue;
      outputSame(entry.stat, info(at === "." ? to : join(to, at), at), at, complete ? keys : directoryKeys);
      if (entry.fd !== null) outputSame(entry.stat, io(at, () => fstatSync(entry.fd, { bigint: true })), at);
    }
    if (complete) for (const [at, stat] of outputFiles) outputSame(stat, info(join(to, at), at), at, keys);
  };
  const outputDirectoryPath = (path) => {
    const fd = outputDirectories.get(path).fd; outputFilesystem(fd, path);
    return process.platform === "win32" ? path === "." ? to : join(to, path) : fdPath(fd);
  };
  const createOutputDirectory = (access, path) => {
    guardOutput(path); io(path, () => mkdirSync(access, { mode: 0o700 }), "output-io");
    const stat = directory(access, path);
    const fd = io(path, () => openSync(access, directoryFlags), "output-io");
    outputDirectories.set(path, { stat, fd });
    outputSame(stat, io(path, () => fstatSync(fd, { bigint: true })), path);
    guardOutput(path);
  };
  const closeOutputDirectory = (path) => {
    const entry = outputDirectories.get(path);
    if (entry?.fd !== null && entry?.fd !== undefined) {
      const fd = entry.fd; entry.fd = null; io(path, () => closeSync(fd), "output-io");
    }
  };
  const guard = (path, baseline) => {
    // Ancestors outside the installation may legitimately gain unrelated files.
    for (const { full, stat } of ancestors) same(stat, info(full, "."), ".", ["dev", "ino", "mode"]);
    for (let at = posix.dirname(path); baseline && at !== "."; at = posix.dirname(at))
      same(baseline.get(at), info(join(from, at), at), at);
    if (baseline) same(baseline.get("."), info(from, "."), ".");
  };
  const noFollow = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const rows = [], buffer = Buffer.alloc(1024 * 1024);
  const copyFile = (input, path, before, baseline) => {
    const fd = io(path, () => openSync(input, constants.O_RDONLY | noFollow));
    try {
      same(before, io(path, () => fstatSync(fd, { bigint: true })), path);
      guard(path, baseline); same(before, info(join(from, path), path), path);
      const target = join(outputDirectoryPath(posix.dirname(path)), posix.basename(path));
      guardOutput(path);
      const output = io(path, () => openSync(target, "wx", 0o600), "output-io");
      let bytes = 0; const hash = createHash("sha256");
      try {
        const created = io(path, () => fstatSync(output, { bigint: true }));
        if (!created.isFile() || created.nlink !== 1n) reject("changed-output", path, created);
        const guardFile = () => {
          guardOutput(path);
          outputSame(created, io(path, () => fstatSync(output, { bigint: true })), path, [...directoryKeys, "nlink"]);
          outputSame(created, info(join(to, path), path), path, [...directoryKeys, "nlink"]);
        };
        guardFile();
        for (;;) {
          const n = io(path, () => readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - bytes + 1), bytes));
          if (n === 0) break;
          bytes += n; if (BigInt(bytes) > before.size) reject("changed-input", path, before);
          hash.update(buffer.subarray(0, n));
          for (let at = 0; at < n;) {
            guardFile();
            const written = io(path, () => writeSync(output, buffer, at, n - at), "output-io");
            if (written <= 0) reject("output-io", path); at += written;
          }
        }
        guardFile(); outputFiles.set(path, io(path, () => fstatSync(output, { bigint: true })));
      } finally { io(path, () => closeSync(output), "output-io"); }
      if (BigInt(bytes) !== before.size) reject("changed-input", path, before);
      same(before, io(path, () => fstatSync(fd, { bigint: true })), path);
      same(before, info(join(from, path), path), path); guard(path, baseline);
      rows.push({ path, bytes, sha256: hash.digest("hex") });
    } finally { io(path, () => closeSync(fd)); }
  };
  const scan = (baseline, copy = false) => {
    const found = new Map(), seen = new Set(); let entries = 0, total = 0n;
    const walk = (access, path, depth) => {
      if (depth > 64) reject("depth-bound", path);
      const before = directory(access, path); found.set(path, before);
      if (baseline) {
        if (!baseline.has(path)) reject("changed-input", path, before);
        same(baseline.get(path), before, path);
      }
      // Linux traversal is anchored to owned directory descriptors. Windows
      // uses path bookends and verifies the opened file identity before reads.
      const fd = process.platform === "linux" ? io(path, () => openSync(access, constants.O_RDONLY | noFollow | constants.O_DIRECTORY)) : null;
      try {
        if (fd !== null) same(before, io(path, () => fstatSync(fd, { bigint: true })), path);
        guard(path, baseline);
        const dir = fd === null ? access : `/proc/self/fd/${fd}`;
        for (const name of io(path, () => readdirSync(dir)).sort()) {
          // Native workers use absolute JS entrypoints, never top-level .bin.
          if (path === "." && name === ".bin") continue;
          const child = path === "." ? name : `${path}/${name}`;
          if (++entries > 200000) reject("entry-bound", child);
          if (!name || name === "." || name === ".." || /[\\/:"<>|?*\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name)
            || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || seen.has(child.toLowerCase())) reject("unsafe-name", child);
          seen.add(child.toLowerCase());
          const input = join(dir, name), stat = info(input, child);
          if (stat.isSymbolicLink()) reject("linked-input", child, stat);
          if (stat.isDirectory()) {
            try {
              if (copy) createOutputDirectory(join(outputDirectoryPath(path), name), child);
              walk(input, child, depth + 1);
            } finally { if (copy) closeOutputDirectory(child); }
          } else {
            if (!stat.isFile() || stat.nlink < 1n) reject("unsupported-entry", child, stat);
            total += stat.size;
            if (stat.size < 0n || stat.size > 512n * 1024n ** 2n || total > 4n * 1024n ** 3n) reject("byte-bound", child, stat);
            found.set(child, stat);
            if (baseline) {
              if (!baseline.has(child)) reject("changed-input", child, stat);
              same(baseline.get(child), stat, child);
            }
            if (copy) copyFile(input, child, stat, baseline);
          }
        }
        same(before, info(access, path), path);
        if (fd !== null) same(before, io(path, () => fstatSync(fd, { bigint: true })), path);
        if (copy) {
          guardOutput(path);
          const entry = outputDirectories.get(path); entry.stat = io(path, () => fstatSync(entry.fd, { bigint: true }));
        }
      } finally { if (fd !== null) io(path, () => closeSync(fd)); }
    };
    walk(from, ".", 0); guard(".", baseline);
    if (baseline && (baseline.size !== found.size || [...baseline.keys()].some((path) => !found.has(path)))) reject("changed-input");
    return found;
  };
  const before = scan();
  let parent = null;
  try {
    parent = io(".", () => openSync(dirname(to), directoryFlags), "output-io");
    outputSame(outputAncestors.at(-1).stat, io(".", () => fstatSync(parent, { bigint: true })), ".");
    outputFilesystem(parent, ".");
    createOutputDirectory(process.platform === "win32" ? to : join(fdPath(parent), posix.basename(to)), ".");
    // The root now pins its ancestry on Windows. Do not retain an exclusive
    // handle on a pre-existing parent during copying or read-only sealing.
    if (process.platform === "win32") { const fd = parent; parent = null; io(".", () => closeSync(fd), "output-io"); }
    scan(before, true); scan(before); guardOutput(".", true);
    // Release Windows listing locks only after all writes are complete. Seal
    // read-only, then recheck every retained destination identity and metadata.
    closeOutputDirectory(".");
    rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    io(".", () => assert.deepEqual(savedFiles(to), rows), "changed-output"); guardOutput(".", true); return rows;
  } finally {
    for (const path of outputDirectories.keys()) closeOutputDirectory(path);
    if (parent !== null) io(".", () => closeSync(parent), "output-io");
  }
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

const recoveryPhase = "dependency-recovery";
export const usesDelayUpstream = (phase) => phase === recoveryPhase || phase === "request-timeout";
export const upstreamSourcePath = (phase) => usesDelayUpstream(phase) ? "bench/hardening/dependency-recovery-upstream.mjs" : "bench/marketplace/upstream.mjs";
export const probeSourcePath = (phase) => phase === recoveryPhase ? "bench/hardening/dependency-recovery-probe.mjs" : "bench/hardening/bounded-requests-probe.mjs";
export const phaseInputs = (phase) => [...new Set([upstreamSourcePath(phase), probeSourcePath(phase),
  ...(usesDelayUpstream(phase) ? ["bench/hardening/dependency-recovery-contract.mjs"] : []),
  ...(phase === recoveryPhase ? [] : ["bench/hardening/bounded-requests.mjs", "bench/hardening/request-capture.mjs"]),
  "bench/hardening/qualification.mjs", "bench/hardening/plan.mjs"])];

// parseArgs always writes options, but adds isolated only for --isolated.
// Missing options are not valid standalone evidence.
export function savedIsolation(options) {
  assert.ok(options && Object.getPrototypeOf(options) === Object.prototype, "native hardening options required");
  assert.equal(options.profile, "bounded", "bounded profile required in native hardening options");
  if (!Object.hasOwn(options, "isolated")) return false;
  assert.equal(options.isolated, true, "invalid native hardening isolation option");
  return true;
}

function verifyWorker(r, cell, summary, receipts, isolatedRun) {
  const step = r.intent.step, base = step.startsWith("edge-") ? "https://localhost:8080" : "http://127.0.0.1:8080";
  const upstream = `http://${summary.runId}-cell-upstream:8080`, edge = step.startsWith("edge-");
  const qualification = `/results/${edge ? "edge-" : ""}qualification.json`, node = "/repo/bench/hardening/";
  const recovery = cell.phase === recoveryPhase;
  assert.ok(phases.includes(cell.phase), "unsupported native phase");
  assert.equal(cell.key, [cell.app, cell.source, cell.mode, cell.phase].join("/"), "phase differs from the cell identity");
  const usesTrigger = usesDelayUpstream(cell.phase) && ["upstream", "probe"].includes(step);
  const sampleResources = recovery && step === "probe";
  const commands = {
    upstream: ["node", "/repo/" + upstreamSourcePath(cell.phase)], ready: ["node", "--input-type=module", "-e", readyScript],
    qualification: ["node", node + "qualification.mjs", cell.source, "direct", upstream, qualification],
    "edge-qualification": ["node", node + "qualification.mjs", cell.source, "deployed-edge", upstream, qualification],
    "native-controls": ["node", node + "native.mjs", base, cell.source, upstream, qualification, "/results/native-controls.json"],
    "edge-controls": ["node", node + "native.mjs", base, cell.source, upstream, qualification, "/results/edge-native-controls.json", "deployed-edge"],
    parity: ["node", node + "parity.mjs", base, cell.source, upstream, "/results/parity.json"],
    "edge-parity": ["node", node + "parity.mjs", base, cell.source, upstream, "/results/parity.json"],
    probe: ["node", ...(isolatedRun ? ["--import", "/repo/" + hardeningCpuGate] : []),
      "/repo/" + probeSourcePath(cell.phase), "/results/probe.json", "/results/raw.jsonl"],
    "terminal-clock": ["node", node + "clock.mjs"], "cleanup-clock": ["node", node + "clock.mjs"],
    certificate: ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "/cert/key.pem", "-out", "/cert/cert.pem", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
  };
  const info = r.created;
  if (commands[step]) assert.deepEqual(info.Config.Cmd, commands[step], "launched native worker command differs");
  else if (step === "application" || step === "proxy") {
    const image = step === "application" ? summary.builds[cell.app].image : summary.tools.edge;
    assert.deepEqual(info.Config.Cmd, image.Config.Cmd); assert.deepEqual(info.Config.Entrypoint, image.Config.Entrypoint);
  } else if (/^(application|upstream|proxy)-health$/.test(step)) {
    const role = step.split("-")[0], path = r.intent.healthPath;
    assert.ok(path === null || typeof path === "string" && path.startsWith("/"));
    assert.deepEqual(info.Config.Cmd, ["node", node + "lifecycle.mjs", role === "proxy" ? "https://localhost:8080" : "http://127.0.0.1:8080", path, String(summary.budget.recovery.requestTimeoutMs)]);
  } else assert.fail("undeclared native worker");
  const role = step === "application" ? cell.mode === "direct" ? "applicationDirect" : "applicationEdge"
    : step === "proxy" || step === "upstream" ? step : ["ready", "probe", "certificate", "terminal-clock", "cleanup-clock"].includes(step) ? "apparatus" : "qualification";
  assert.equal(r.intent.role, role);
  assert.equal(info.HostConfig.ShmSize, role === "qualification" ? 1024 ** 3 : 64 * 1024 ** 2, "native shared-memory allocation differs");
  if (sampleResources) {
    assert.equal(info.HostConfig.PidMode, "host", "native process observer must see runner-host PIDs");
    assert.equal(info.HostConfig.CgroupnsMode, "host", "native resource observer must see runner-host cgroups");
  } else if (step === "probe") {
    assert.ok(["", "private"].includes(info.HostConfig.PidMode), "bounded probe may not share the host PID namespace");
    assert.ok(["", "private"].includes(info.HostConfig.CgroupnsMode), "bounded probe may not share the host cgroup namespace");
  }
  const tool = role === "qualification" ? "checker" : step === "certificate" ? "cert" : step === "proxy" ? "edge" : "node";
  if (step !== "application") assert.equal(info.Image, summary.tools[tool].Id);
  else assert.equal(info.Image, summary.builds[cell.app].imageId);
  const image = step === "application" ? summary.builds[cell.app].image : summary.tools[tool];
  if (!["application", "proxy"].includes(step)) assert.deepEqual(info.Config.Entrypoint, image.Config.Entrypoint);
  for (const key of ["User", "WorkingDir"]) assert.equal(info.Config[key] ?? "", image.Config[key] ?? "");
  const environment = new Map((image.Config.Env ?? []).map((s) => [s.slice(0, s.indexOf("=")), s.slice(s.indexOf("=") + 1)]));
  const overrides = step === "application" ? { MARKETPLACE_SOURCE: cell.source, MARKETPLACE_FIXTURE_PATH: "/fixtures/marketplace.json",
    API_BASE: upstream, PORT: "8080", HOSTS: "fsw-target,localhost,127.0.0.1", PROFILE: qualificationSettings.nativeProfile, MAX_CONNECTIONS: String(qualificationSettings.maxConnections),
    ...(cell.mode === "deployed-edge" ? { MARKETPLACE_PUBLIC_ORIGIN: edgePublicOrigin } : {}) }
    : role === "qualification" ? { PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
      ...(cell.mode === "deployed-edge" && !["qualification", "native-controls", "parity"].includes(step)
        ? { NODE_EXTRA_CA_CERTS: "/results/cert/cert.pem", BENCH_EDGE_CERT: "/results/cert/cert.pem" } : {}) } : {};
  if (usesTrigger) overrides.RECOVERY_TRIGGER_DIR = "/recovery";
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
  if (sampleResources) required("/sys/fs/cgroup", "/sys/fs/cgroup");
  let triggerSource;
  if (usesTrigger) {
    const trigger = info.Mounts.find((m) => m.Destination === "/recovery");
    const writable = step === "probe";
    assert.ok(trigger?.Type === "bind" && trigger.RW === writable, "recovery trigger mount type or access differs");
    const name = paths.basename(trigger.Source);
    assert.match(name, /^\.recovery-[a-zA-Z0-9]{6}$/, "recovery trigger must be a private runner directory");
    triggerSource = paths.join(summary.originalFolder, name);
    assert.equal(trigger.Source, triggerSource, "recovery trigger escaped the original run directory");
    assert.deepEqual(r.terminal.Mounts.filter((m) => m.Destination === "/recovery"), [trigger], "recovery trigger mount changed during execution");
    required("/recovery", triggerSource, !writable);
  } else assert.ok(!r.terminal.Mounts?.some((m) => m.Destination === "/recovery"), "unexpected recovery trigger mount");
  const order = (a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
  assert.deepEqual(mounts.sort(order), expectedMounts.sort(order), "external, extra or writable source/tool input mount");
  // Inspect metadata cannot vouch for a different acknowledged command. Parse
  // the fixed native CLI vocabulary and compare it to the procedure, not intent.
  const args = r.creation.args.slice(9), options = new Map(), volumes = [], env = [];
  const scalar = new Set(["--network", "--network-alias", "--cpus", "--memory", "--memory-swap", "--pids-limit", "--ulimit", "--shm-size", "--cpuset-cpus"]);
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
  if (isolatedRun) {
    const cpus = hardeningRoleCpu(role);
    assert.equal(info.HostConfig.CpusetCpus, cpus, "native hardening Docker cpuset differs");
    expectedOptions.set("--cpuset-cpus", cpus);
  }
  if (sampleResources) { expectedOptions.set("--cgroupns=host", true); expectedOptions.set("--pid=host", true); }
  if (["application", "upstream", "proxy"].includes(step)) expectedOptions.set("-d", true);
  if (step === "application") expectedOptions.set("--network-alias", "fsw-target");
  const isolated = ["certificate", "terminal-clock", "cleanup-clock"].includes(step), service = ["application", "upstream", "proxy"].includes(step);
  let network = isolated ? "none" : service ? `${summary.runId}-net` : null;
  if (network === null) {
    const targetRole = step.endsWith("-health") ? step.split("-")[0]
      : edge || step === "probe" && cell.mode === "deployed-edge" ? "proxy" : "application";
    const owner = receipts.find((other) => other.intent.cell === cell.key && other.intent.step === targetRole)?.created
      ?? (cell.status !== "observed" ? r.namespace : null);
    if (!owner) missingProof("native namespace owner missing");
    const actual = options.get("--network");
    assert.ok([`container:${owner.Id}`, `container:${owner.Name.slice(1)}`].includes(actual), "acknowledged native namespace differs");
    network = actual;
  }
  expectedOptions.set("--network", network);
  assert.deepEqual([...options].sort(), [...expectedOptions].sort(), "acknowledged native limits/options differ");
  assert.deepEqual(volumes.sort(), expectedMounts.map((m) => `${m.source}:${m.target}${m.readOnly ? ":ro" : m.target === "/recovery" ? ":rw" : ""}`).sort(),
    "acknowledged native mounts differ");
  assert.deepEqual(env.sort(), Object.entries(overrides).map(([key, value]) => `${key}=${value}`).sort(), "acknowledged native environment differs");
  return triggerSource;
}

const missingProof = (message) => { throw Object.assign(new Error(message), { code: "ENOENT" }); };

export function verifyHardeningCpuScope(sample, cpus) {
  const { id, pid, startTicks, path, groups } = sample;
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(pid) && pid > 0); assert.match(startTicks, /^[1-9]\d*$/);
  assert.ok(posix.isAbsolute(path) && posix.normalize(path) === path && [id, `docker-${id}.scope`].includes(posix.basename(path)));
  assert.ok(Array.isArray(groups) && groups.length > 0);
  const paths = new Set(groups.map((g) => g.path)), pids = new Set();
  assert.equal(paths.size, groups.length); assert.ok(paths.has(path));
  for (const { path: child, files } of groups) {
    assert.ok(child === path || child.startsWith(path + "/") && posix.normalize(child) === child && paths.has(posix.dirname(child)));
    const members = files["cgroup.procs"].trim().split("\n").filter(Boolean);
    for (const member of members) {
      assert.match(member, /^[1-9]\d*$/); assert.ok(!pids.has(member)); pids.add(member);
      if (member === String(pid)) assert.equal(child, path, "container init must belong to its Docker cgroup");
    }
    const effective = files["cpuset.cpus.effective"];
    if (child === path) assert.equal(effective.trim(), cpus, "hardening actor effective cpuset differs");
    else if (members.length) assert.ok(cpuSetWithin(effective, cpus), "hardening process effective cpuset escapes its role");
  }
  assert.ok(pids.has(String(pid)), "container init missing from Linux CPU scope");
}

export function verifyHardeningCpuRoles(evidence, cell, launches, raw) {
  assert.equal(evidence.schema, "native-hardening-cpu-roles/v1");
  const roles = ["application", "upstream", ...(cell.mode === "deployed-edge" ? ["proxy"] : []), "probe"];
  const wall = Date.parse(raw.find((r) => r.type === "clock")?.wallAtStart);
  const endMs = cell.phase === recoveryPhase
    ? raw.find((r) => r.type === recoveryPhase)?.upstream.after.observedAtMs
    : raw.find((r) => r.type === "bounded-requests")?.completeAtMs;
  assert.ok(Number.isFinite(wall) && Number.isFinite(endMs) && endMs >= 0);
  const end = wall + endMs;
  assert.deepEqual(Object.keys(evidence.before).sort(), [...roles].sort());
  assert.deepEqual(Object.keys(evidence.after).sort(), [...roles].sort());
  for (const role of roles) {
    const { created, terminal, intent } = launches.find((r) => r.intent.step === role);
    const before = evidence.before[role], after = evidence.after[role];
    const start = Date.parse(terminal.State.StartedAt);
    assert.ok(before.atMs >= Math.max(start, wall - hardeningGateMs) && before.atMs <= wall
      && after.atMs >= Math.floor(end) - 1 && after.atMs <= end + hardeningGateMs, "hardening CPU samples do not bracket the probe");
    assert.ok(Number.isSafeInteger(before.atMs) && Number.isSafeInteger(after.atMs));
    for (const row of [before, after]) {
      assert.deepEqual([row.id, row.imageId, row.startedAt], [created.Id, created.Image, terminal.State.StartedAt]);
    }
    const cpus = hardeningRoleCpu(intent.role);
    verifyHardeningCpuScope(before, cpus);
    if (role === "probe") assert.ok(after.atMs <= Date.parse(terminal.State.FinishedAt), "CPU sample from after probe exit");
    else assert.equal(before.pid, created.State.Pid, "wrong service init PID");
    if (role !== "probe" && Object.hasOwn(after, "finishedAt")) {
      assert.equal(terminal.State.Status, "exited");
      assert.equal(after.finishedAt, terminal.State.FinishedAt);
      assert.ok(Date.parse(after.finishedAt) >= before.atMs && Date.parse(after.finishedAt) <= after.atMs);
    } else {
      assert.deepEqual([after.pid, after.startTicks, after.path], [before.pid, before.startTicks, before.path]);
      verifyHardeningCpuScope(after, cpus);
    }
  }
}

export function verifyOwnedReceipts(receipts, summary, folder, preflight) {
  const isolatedRun = savedIsolation(summary.options);
  assert.ok(Array.isArray(receipts)); if (!receipts.length) missingProof("missing owned container receipts");
  const ids = new Set(), launches = new Map(), resources = summary.budget.resources;
  const triggerByCell = new Map(), cellByTrigger = new Map();
  const required = preflight && ["upstream", "application", ...(preflight.failedStage === "edge-native-controls"
    ? ["proxy", "edge-qualification", "edge-controls"] : ["qualification", "native-controls"])];
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    if (preflight && (r.intent.cell !== preflight.key || !required.includes(r.intent.step))) continue;
    assert.equal(r.index, i); assert.equal(r.schema, "native-hardening-container/v2");
    assert.ok(r.intent && ["create", "run"].includes(r.intent.operation));
    const before = r.created, end = r.terminal; if (!before || !end) missingProof("missing owned container lifetime");
    const cell = summary.cells.find((c) => c.key === r.intent.cell); assert.ok(cell);
    verifyContainerCommands(r, summary.runId);
    const trigger = verifyWorker(r, cell, summary, receipts, isolatedRun);
    if (folder && r.intent.step === "proxy")
      assert.ok(readFileSync(join(folder, cell.key, "nginx.conf")).equals(Buffer.from(proxyConfig())), "saved edge configuration differs");
    if (trigger !== undefined) {
      const key = win32.isAbsolute(trigger) && !posix.isAbsolute(trigger) ? trigger.toLowerCase() : trigger;
      assert.equal(triggerByCell.get(cell.key) ?? trigger, trigger, "recovery workers do not share the same trigger directory");
      assert.equal(cellByTrigger.get(key) ?? cell.key, cell.key, "recovery cells share a trigger directory");
      triggerByCell.set(cell.key, trigger); cellByTrigger.set(key, cell.key);
    }
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
  for (const c of preflight ? [preflight] : summary.cells.filter((c) => c.status === "observed")) {
    const list = launches.get(c.key) ?? [];
    for (const name of required ?? ["upstream", "application", "ready", "qualification", "native-controls", "parity",
      "probe", "terminal-clock", "cleanup-clock",
      ...(c.mode === "deployed-edge" ? ["certificate", "proxy", "edge-qualification", "edge-parity", "edge-controls"] : [])])
      if (!list.some((r) => r.intent.step === name)) missingProof("missing charged native apparatus step");
    for (const step of new Set(list.map((r) => r.intent.step))) assert.equal(list.filter((r) => r.intent.step === step).length, step === "terminal-clock" ? 2 : 1);
    const target = (role) => list.find((r) => r.intent.step === role).created.Id;
    for (const r of list) {
      const step = r.intent.step;
      const network = ["certificate", "terminal-clock", "cleanup-clock"].includes(step) ? "none"
        : ["upstream", "application", "proxy"].includes(step) ? `${summary.runId}-net`
          : `container:${target(step.endsWith("-health") ? step.split("-")[0] : step.startsWith("edge-") || step === "probe" && c.mode === "deployed-edge" ? "proxy" : "application")}`;
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
    const archive = sourceGit(repository, nativeBuildArchiveArgs(summary.commit, app));
    assert.equal(build.contextSha256, digest(archive), "native build-context archive differs from committed inputs");
    assert.equal(digest(body(`${app}-build-context.tar`)), build.contextSha256);
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
  for (const phase of new Set(summary.cells.filter((cell) => cell.status === "observed").map((cell) => cell.phase)))
    for (const path of phaseInputs(phase))
      assert.ok(files.some((file) => file.path === path), `native hardening input is not in the committed source: ${path}`);
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
export function verifyParity(parity, source) {
  assert.equal(parity.workload, "marketplace-v2"); assert.equal(parity.source, source);
  assert.equal(parity.jsonRecords, 500); assert.equal(parity.pages, 264); assert.equal(parity.profiles.length, 12);
  const keys = parity.profiles.map((p) => { assert.equal(p.passed, true); return `${p.locale}/${p.javaScriptEnabled}/${p.mobile}`; });
  assert.equal(new Set(keys).size, 12);
  for (const locale of ["en-US", "fr-FR", "de-DE"]) for (const js of [true, false]) for (const mobile of [true, false]) assert.ok(keys.includes(`${locale}/${js}/${mobile}`));
  if (source === "api") assert.deepEqual(parity.upstream, { readsPerRequest: 1, uncachedPage: true, uncachedJson: true, jsonReserialized: true, errors: true });
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
    assert.deepEqual(nativeHostConfig(state.after.HostConfig), nativeHostConfig(actual), "native deployment configuration changed during observation");
    assert.ok(!state.events.some((event) => event.Action === "update"), "external configuration intervention invalidates apparatus");
  }
}
