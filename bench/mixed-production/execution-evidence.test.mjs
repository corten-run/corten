import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { createExecutionEvidence, replayExecution } from "./execution-evidence.mjs";
import { immutableGit } from "./immutable-git.mjs";
import { mountSourceHash } from "./execution-inputs.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const image = `sha256:${"a".repeat(64)}`, id = "b".repeat(64), netId = "c".repeat(64);
const summary = () => ({ round: "w999", runId: "mixed-w999-abcdef01", inventory: ["corten"],
  options: { passes: 1, profile: "defaults" }, provenance: { nativeSource: { commit: "d".repeat(40) } },
  tools: { nodeImage: image, browserImage: image }, apps: { corten: { image: { id: image } } },
  executionMounts: { source: mountSourceHash("/source"), dependencies: mountSourceHash("/dependencies"), output: mountSourceHash("/output") } });
const imageInfo = { Id: image, Config: { Cmd: ["node"], Entrypoint: ["docker-entrypoint.sh"] } };
function participant(s) {
  return { Id: id, Name: `/${s.runId}-corten-fixture`, Image: image, RestartCount: 0,
    Config: { ...imageInfo.Config, Env: ["PROFILE=", "MARKETPLACE_SOURCE=fixture", "MIXED_CONTROL_TOKEN=secret-canary", "DATABASE_URL=secret-canary"],
      Labels: { "run.corten.mixed-production": s.runId, "agent.owner": "codex", "agent.task": s.runId } },
    State: { Status: "running", Running: true, Paused: false, Restarting: false, OOMKilled: false, Dead: false,
      Pid: 123, ExitCode: 0, StartedAt: "2026-11-13T00:00:00Z", FinishedAt: "0001-01-01T00:00:00Z" },
    HostConfig: { NanoCpus: 1e9, Memory: 2 ** 30, CpusetCpus: "", CpuQuota: 0, CpuPeriod: 0, MemorySwap: 2 ** 31,
      ShmSize: 64 * 2 ** 20, PidsLimit: null, NetworkMode: `${s.runId}-net` }, Mounts: [{ Type: "bind", Source: "/output", Destination: "/fixtures", RW: false }] };
}
async function temporary(fn) {
  const root = tmpdir(), folder = mkdtempSync(join(root, "mixed-execution-"));
  try { return await fn(folder); } finally {
    const rel = relative(root, folder); assert.ok(rel && !isAbsolute(rel) && !rel.startsWith("..")); rmSync(folder, { recursive: true });
  }
}
const read = (folder, path) => JSON.parse(readFileSync(join(folder, path), "utf8"));
function replay(folder, s) {
  const manifest = read(folder, "execution/manifest.json");
  return replayExecution({ manifest, summary: s, read(ref, path) {
    assert.equal(ref.path, path); const bytes = readFileSync(join(folder, path)); assert.equal(hash(bytes), ref.sha256); return JSON.parse(bytes);
  } });
}
async function vector(folder, change = () => {}, options = {}) {
  const s = summary(), p = participant(s); change(p); let present = false, network = true;
  const docker = async (args) => {
    if (args[0] === "inspect") return JSON.stringify([p]);
    if (args[0] === "image" && args[1] === "inspect") return JSON.stringify([imageInfo]);
    if (args[0] === "ps") {
      if (options.queryFailure) throw new Error("secret-canary");
      return args.some((arg) => arg.startsWith("label=")) ? "" : present ? id : "";
    }
    if (args[0] === "rm") { present = false; return id; }
    if (args[0] === "network" && args[1] === "inspect") return JSON.stringify([{ Id: netId, Name: `${s.runId}-net`, Labels: { "run.corten.mixed-production": s.runId } }]);
    if (args[0] === "network" && args[1] === "rm") { network = false; return netId; }
    if (args[0] === "network" && args[1] === "ls") return args.some((arg) => arg.startsWith("id=")) && network ? netId : "";
    if (["image", "volume"].includes(args[0]) && args[1] === "ls") return "";
    assert.fail(`unexpected synthetic Docker operation: ${args[0]} ${args[1]}`);
  };
  const collector = createExecutionEvidence({ folder, summary: s, docker });
  await collector.networkCreated(`${s.runId}-net`, netId);
  if (options.queryFailure) await assert.rejects(collector.create(p.Name.slice(1), async () => { present = true; return id; }));
  else {
    await collector.create(p.Name.slice(1), async () => { present = true; return id; });
    await collector.remove(p.Name.slice(1));
  }
  await collector.removeNetwork(`${s.runId}-net`); await collector.removeImage(`${s.runId}-unbuilt`); await collector.seal();
  return s;
}
function mutate(folder, kind, fn) {
  const manifest = read(folder, "execution/manifest.json"); let count = 0;
  for (const ref of manifest.events) {
    const value = read(folder, ref.path); if (value.kind !== kind) continue;
    fn(value); const body = JSON.stringify(value); writeFileSync(join(folder, ref.path), body); ref.sha256 = hash(body); count++;
  }
  assert.ok(count); writeFileSync(join(folder, "execution/manifest.json"), JSON.stringify(manifest));
}

function rewriteEvents(folder, change) {
  const manifest = read(folder, "execution/manifest.json"), events = manifest.events.map((ref) => read(folder, ref.path));
  change(events);
  manifest.events = events.map((event, sequence) => {
    event.sequence = sequence; event.startedUnixMs = sequence; event.receivedUnixMs = sequence;
    const path = `execution/events/${String(sequence).padStart(5, "0")}.json`, body = JSON.stringify(event);
    writeFileSync(join(folder, path), body); return { path, sha256: hash(body) };
  });
  writeFileSync(join(folder, "execution/manifest.json"), JSON.stringify(manifest));
}

test("terminal lifecycle cannot be repeated or reordered to erase an OOM failure", async (t) => {
  for (const mode of ["terminal-after-absence", "aliased-terminal-after-absence", "failed-aliased-terminal-after-absence", "duplicate-terminal", "duplicate-remove", "duplicate-absence", "remove-before-terminal", "absence-before-remove", "created-after-terminal"]) {
    await t.test(mode, () => temporary(async (folder) => {
      const s = await vector(folder);
      s.timing = { cpus: { app: { quota: 1, cpuset: "" } } };
      mutate(folder, "participant-terminal", (e) => Object.assign(e.data.state,
        { Status: "exited", Running: false, Pid: 0, OOMKilled: true, ExitCode: 137 }));
      assert.equal(replay(folder, s).participants[0].state.ExitCode, 137);
      rewriteEvents(folder, (events) => {
        const at = (kind) => events.findIndex((e) => e.kind === kind);
        if (mode.endsWith("terminal-after-absence")) {
          const healthy = structuredClone(events[at("participant-created")]); healthy.kind = "participant-terminal";
          const extra = [];
          if (mode.includes("aliased")) {
            healthy.subject = `${s.runId}-q-corten-fixture`;
            const create = structuredClone(events[at("container-create")]); create.subject = healthy.subject; extra.push(create);
            if (mode.startsWith("failed-")) { create.data = null; create.failure = "docker-create-failed"; }
          }
          events.splice(at("container-absence") + 1, 0, ...extra, healthy);
        } else if (mode.startsWith("duplicate-")) {
          const kind = { terminal: "participant-terminal", remove: "container-remove", absence: "container-absence" }[mode.slice(10)];
          events.splice(at(kind) + 1, 0, structuredClone(events[at(kind)]));
        } else {
          const [first, second] = mode === "remove-before-terminal" ? ["participant-terminal", "container-remove"]
            : mode === "absence-before-remove" ? ["container-remove", "container-absence"] : ["participant-created", "participant-terminal"];
          const a = at(first), b = at(second); [events[a], events[b]] = [events[b], events[a]];
        }
      });
      assert.throws(() => replay(folder, s));
    }));
  }
});

test("cleanup retains original create acknowledgement ID across same-name replacement", () => temporary(async (folder) => {
  const s = summary(), original = participant(s), name = original.Name.slice(1), replacement = "e".repeat(64), removed = [];
  let replaced = false;
  const docker = async (args) => {
    if (args[0] === "image") return JSON.stringify([imageInfo]);
    if (args[0] === "inspect") {
      const p = structuredClone(original);
      if (replaced && args.at(-1) === name) p.Id = replacement;
      else if (replaced) p.Name = `/${name}-renamed`;
      return JSON.stringify([p]);
    }
    if (args[0] === "ps") return args.some((a) => a.startsWith("name=")) ? replaced ? replacement : id : "";
    if (args[0] === "rm") { removed.push(args.at(-1)); return args.at(-1); }
    assert.fail("unexpected cleanup model command");
  };
  const collector = createExecutionEvidence({ folder, summary: s, docker });
  await collector.create(name, async () => id); replaced = true;
  await collector.remove(name);
  assert.deepEqual(removed, [id]);
  const before = readFileSync(join(folder, "execution/manifest.json"), "utf8");
  await collector.remove(name); assert.deepEqual(removed, [id]);
  assert.equal(readFileSync(join(folder, "execution/manifest.json"), "utf8"), before);
  const manifest = read(folder, "execution/manifest.json"), terminal = manifest.events.map((ref) => read(folder, ref.path)).find((e) => e.kind === "participant-terminal");
  assert.equal(terminal.data.id, id); assert.equal(terminal.data.name, `${name}-renamed`);
}));

test("cleanup never substitutes a same-name ID for a missing create acknowledgement", () => temporary(async (folder) => {
  const s = summary(), name = participant(s).Name.slice(1), calls = [];
  const collector = createExecutionEvidence({ folder, summary: s, docker: async (args) => {
    calls.push(args); if (args[0] === "ps") return id;
    assert.fail("no name-based inspection or removal without original acknowledgement");
  } });
  await assert.rejects(collector.create(name, async () => { throw Error("synthetic-private-canary"); }));
  await assert.rejects(collector.remove(name), /without original create ID/);
  assert.ok(calls.every((args) => args[0] === "ps"));
  for (const ref of read(folder, "execution/manifest.json").events)
    assert.equal(readFileSync(join(folder, ref.path), "utf8").includes("synthetic-private-canary"), false);
}));

test("network cleanup never re-resolves a reused name or substitutes another ID", () => temporary(async (folder) => {
  const s = summary(), name = `${s.runId}-net`, replacement = "e".repeat(64), removed = [];
  let replaced = false;
  const collector = createExecutionEvidence({ folder, summary: s, docker: async (args) => {
    if (args[1] === "inspect") {
      if (replaced && args.at(-1) === netId) throw Error("original network absent");
      return JSON.stringify([{ Id: replaced ? replacement : netId, Name: name, Labels: { "run.corten.mixed-production": s.runId } }]);
    }
    if (args[1] === "rm") { removed.push(args.at(-1)); return args.at(-1); }
    if (args[1] === "ls") return "";
    assert.fail("unexpected network model command");
  } });
  await collector.networkCreated(name, netId); replaced = true;
  await assert.rejects(collector.removeNetwork(name)); assert.deepEqual(removed, []);
}));

test("actual Docker network replacement survives rejected original-ID cleanup", { skip: process.env.MIXED_EXECUTION_OS_PROBE !== "1" }, async () => {
  const root = process.env.MIXED_EXECUTION_OS_OUTPUT; assert.ok(root && isAbsolute(root));
  const folder = join(root, "network-replacement"), s = summary(); s.runId = `mixed-w999-${randomBytes(4).toString("hex")}`;
  const docker = async (args) => {
    const r = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 1024 ** 2 });
    assert.equal(r.status, 0, "local Docker network control failed"); return r.stdout.trim();
  };
  const collector = createExecutionEvidence({ folder, summary: s, docker }), name = `${s.runId}-net`;
  const labels = ["--label", "agent.owner=codex", "--label", `agent.task=${s.runId}`, "--label", `run.corten.mixed-production=${s.runId}`];
  const created = [];
  try {
    const originalId = await docker(["network", "create", ...labels, name]); created.push(originalId);
    await collector.networkCreated(name, originalId); await docker(["network", "rm", originalId]);
    const replacementId = await docker(["network", "create", ...labels, name]); created.push(replacementId);
    await assert.rejects(collector.removeNetwork(name));
    assert.equal(JSON.parse(await docker(["network", "inspect", replacementId]))[0].Id, replacementId);
    await docker(["network", "rm", replacementId]); await collector.seal();
    const result = replay(folder, s); assert.equal(result.cleanupComplete, false);
    writeFileSync(join(folder, "observer-replay.json"), JSON.stringify({ scope: "OS negative network identity control only", originalId, replacementId, result }, null, 2));
  } finally {
    for (const id of created) if (await docker(["network", "ls", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"])) await docker(["network", "rm", id]);
  }
});

test("execution saved replay derives actual limits and terminal absence without mutating files", () => temporary(async (folder) => {
  const s = await vector(folder), paths = readdirSync(join(folder, "execution/events")).map((name) => `execution/events/${name}`);
  const before = paths.map((path) => hash(readFileSync(join(folder, path))));
  const result = replay(folder, s);
  assert.equal(result.resources, "verified"); assert.equal(result.cleanupComplete, true); assert.deepEqual(result.blockers, []);
  assert.equal(result.participants[0].limits.NanoCpus, 1e9);
  assert.deepEqual(paths.map((path) => hash(readFileSync(join(folder, path)))), before);
  for (const path of paths) assert.doesNotMatch(readFileSync(join(folder, path), "utf8"), /secret-canary|DATABASE_URL|MIXED_CONTROL_TOKEN/);
}));

test("execution contradictions reject recomputed receipt hashes", async (t) => {
  for (const [name, change] of Object.entries({ quota: (p) => p.limits.NanoCpus = 0, memory: (p) => p.limits.Memory = 0,
    image: (p) => p.imageId = `sha256:${"e".repeat(64)}`, command: (p) => p.commandSha256 = "f".repeat(64),
    network: (p) => p.networkMode = "host", source: (p) => p.env = [["PROFILE", ""], ["MARKETPLACE_SOURCE", "api"]],
    malformedState: (p) => p.state.Running = 42, incoherentState: (p) => p.state.ExitCode = 137,
    maskedContradiction: (p) => { p.restartCount = null; p.limits.Memory = 0; }, extra: (p) => p.cleanupComplete = true }))
    await t.test(name, () => temporary(async (folder) => { const s = await vector(folder); mutate(folder, "participant-created", (e) => change(e.data)); assert.throws(() => replay(folder, s)); }));
});

test("execution derives each native stage/role command and limit without trusting requested caps", () => temporary(async (folder) => {
  const s = summary(), values = new Map(); let next = 1;
  s.timing = { cpus: { app: { quota: 1, cpuset: "0" }, api: { quota: 2, cpuset: "1-2" }, load: { quota: 4, cpuset: "3-6" } } };
  const docker = async (args) => {
    if (args[0] === "inspect") return JSON.stringify([[...values.values()].find((p) => p.Id === args.at(-1))]);
    if (args[0] === "image" && args[1] === "inspect") return JSON.stringify([imageInfo]);
    if (args[0] === "network" && args[1] === "inspect") return JSON.stringify([{ Id: netId, Name: `${s.runId}-net`, Labels: { "run.corten.mixed-production": s.runId } }]);
    if (args[0] === "network" && args[1] === "rm") return netId;
    if (args[0] === "rm") { const entry = [...values].find(([, p]) => p.Id === args.at(-1)); values.delete(entry[0]); return args.at(-1); }
    if (args[0] === "ps" && args.some((a) => a.startsWith("name="))) {
      const filter = args.find((a) => a.startsWith("name=")), name = filter.slice(7, -1); return values.get(name)?.Id ?? "";
    }
    if (["ps", "network", "image", "volume"].includes(args[0])) return "";
    assert.fail("unexpected stage fixture command");
  };
  const collector = createExecutionEvidence({ folder, summary: s, docker }); await collector.networkCreated(`${s.runId}-net`, netId);
  for (const stage of ["functional", "qualification", "calibration", "steady"]) {
    const functional = stage === "functional", qualification = stage === "qualification", pass = stage === "steady" ? 1 : 0;
    const base = functional ? `${s.runId}-corten-fixture` : qualification ? `${s.runId}-q-corten-fixture` : `${s.runId}-${stage}-${pass}-corten-fixture`;
    let parent;
    const names = [];
    for (const role of ["app", "upstream", "worker"]) {
      const p = participant(s), name = base + (role === "app" ? "" : role === "upstream" ? functional ? "-upstream" : "-up" : functional ? "-capture" : "-worker");
      p.Id = (next++).toString(16).padStart(64, "0"); p.Name = `/${name}`;
      if (role === "app") parent = p.Id;
      const policy = s.timing.cpus[role === "app" ? "app" : role === "upstream" ? "api" : "load"];
      p.HostConfig.NanoCpus = (functional ? role === "app" ? 1 : 2 : policy.quota) * 1e9;
      p.HostConfig.CpusetCpus = functional ? "" : policy.cpuset;
      p.HostConfig.Memory = role === "upstream" ? 512 * 2 ** 20 : role === "worker" && !functional && !qualification ? 2 ** 31 : 2 ** 30;
      p.HostConfig.NetworkMode = role === "worker" ? `container:${parent}` : `${s.runId}-net`;
      if (role !== "app") p.Mounts = [["/source", "/src", false], ["/dependencies", "/src/node_modules", false], ["/output", "/out", true]]
        .map(([Source, Destination, RW]) => ({ Type: "bind", Source, Destination, RW }));
      if (role === "worker" && !qualification) p.HostConfig.ShmSize = 512 * 2 ** 20;
      if (role === "upstream") p.Config.Cmd = ["node", functional ? "bench/mixed-production/upstream.mjs" : qualification ? "bench/marketplace/upstream.mjs" : "bench/mixed-production/load-upstream.mjs"];
      if (role === "worker") p.Config.Cmd = ["node", `bench/mixed-production/${functional ? "worker" : qualification ? "qualify-worker" : "load-worker"}.mjs`,
        functional ? "/out/corten/fixture/settings.json" : `/out/measurement/corten/fixture/${qualification ? "qualification" : `${stage}-${pass}`}/settings.json`];
      await collector.create(name, async () => { values.set(name, p); return p.Id; }); names.push(name);
    }
    for (const name of names.reverse()) await collector.remove(name);
  }
  const cpu = participant(s), reader = `${s.runId}-measurement-cpu`;
  cpu.Id = "e".repeat(64); cpu.Name = `/${reader}`; cpu.Config.Cmd = ["node", "-e", "setInterval(() => {}, 1000)"];
  cpu.HostConfig.NanoCpus = 1e9; cpu.HostConfig.Memory = 128 * 2 ** 20; cpu.HostConfig.NetworkMode = "none";
  cpu.Mounts = [["/source", "/src", false], ["/dependencies", "/src/node_modules", false], ["/output", "/out", true], ["/sys/fs/cgroup", "/sys/fs/cgroup", false]]
    .map(([Source, Destination, RW]) => ({ Type: "bind", Source, Destination, RW }));
  await collector.create(reader, async () => { values.set(reader, cpu); return cpu.Id; }); await collector.remove(reader);
  await collector.removeNetwork(`${s.runId}-net`); await collector.seal();
  const result = replay(folder, s); assert.equal(result.resources, "verified"); assert.equal(result.cleanupComplete, true); assert.equal(result.participants.length, 13);
}));

test("execution missing facts block and genuine unhealthy terminal state is retained", async (t) => {
  await t.test("missing quota", () => temporary(async (folder) => {
    const s = await vector(folder, (p) => delete p.HostConfig.NanoCpus), result = replay(folder, s);
    assert.equal(result.resources, "blocked"); assert.equal(result.cleanupComplete, false);
    assert.ok(result.blockers.includes("native-participant-inspection-incomplete"));
  }));
  await t.test("exit 137 and restart", () => temporary(async (folder) => {
    const s = await vector(folder, (p) => { p.State.Status = "exited"; p.State.Running = false; p.State.Pid = 0; p.State.ExitCode = 137; p.RestartCount = 1; });
    const result = replay(folder, s); assert.equal(result.resources, "verified"); assert.equal(result.cleanupComplete, true);
    assert.equal(result.participants[0].state.ExitCode, 137);
  }));
  await t.test("no finalization", () => temporary(async (folder) => {
    const s = await vector(folder), manifest = read(folder, "execution/manifest.json"); manifest.finalizedUnixMs = null;
    writeFileSync(join(folder, "execution/manifest.json"), JSON.stringify(manifest)); assert.equal(replay(folder, s).cleanupComplete, false);
  }));
  await t.test("failed query", () => temporary(async (folder) => {
    const s = await vector(folder, () => {}, { queryFailure: true }); const result = replay(folder, s);
    assert.equal(result.cleanupComplete, false); assert.equal(result.resources, "blocked");
    assert.doesNotMatch(JSON.stringify(read(folder, "execution/manifest.json")), /secret-canary/);
  }));
  await t.test("missing initial inspection", () => temporary(async (folder) => {
    const s = await vector(folder);
    mutate(folder, "participant-created", (e) => { e.data = null; e.failure = "docker-inspect-failed"; });
    const result = replay(folder, s); assert.equal(result.resources, "blocked"); assert.equal(result.cleanupComplete, false);
    assert.ok(result.blockers.includes("native-participant-initial-inspection-missing"));
  }));
});

test("execution unknown failed variants, duplicate references and mutated files are invalid", async (t) => {
  for (const mode of ["unknown", "duplicate", "mutation"]) await t.test(mode, () => temporary(async (folder) => {
    const s = await vector(folder);
    if (mode === "unknown") mutate(folder, "container-create", (e) => { e.kind = "unrecognized"; e.data = null; e.failure = "docker-query-failed"; });
    if (mode === "mutation") writeFileSync(join(folder, "execution/events/00000.json"), "{}");
    if (mode === "duplicate") {
      const manifest = read(folder, "execution/manifest.json"); manifest.events[1] = manifest.events[0]; writeFileSync(join(folder, "execution/manifest.json"), JSON.stringify(manifest));
    }
    assert.throws(() => replay(folder, s));
  }));
});

test("producer immutable Git ignores blob replacements in a local isolated repository", () => temporary(async (folder) => {
  const git = (args, input) => {
    const answer = spawnSync("git", args, { cwd: folder, input, windowsHide: true, encoding: "utf8" }); assert.equal(answer.status, 0, answer.stderr); return answer.stdout.trim();
  };
  git(["init", "--quiet"]); const original = git(["hash-object", "-w", "--stdin"], "original-source\n"), replacement = git(["hash-object", "-w", "--stdin"], "hostile-source\n");
  git(["replace", original, replacement]); assert.equal(git(["cat-file", "blob", original]), "hostile-source");
  assert.equal(immutableGit(folder, ["cat-file", "blob", original]).toString(), "original-source\n");
  git(["config", "remote.origin.promisor", "true"]); git(["config", "remote.origin.partialclonefilter", "blob:none"]);
  git(["config", "remote.origin.url", "https://must-not-contact.invalid/repository"]);
  const before = readdirSync(join(folder, ".git/objects"));
  assert.throws(() => immutableGit(folder, ["cat-file", "blob", "f".repeat(40)]), /immutable local Git/);
  assert.deepEqual(readdirSync(join(folder, ".git/objects")), before);
}));

// Opt-in, bounded OS observer check, not native framework parity or qualification.
test("execution actual Docker limits and cleanup receipts", { skip: process.env.MIXED_EXECUTION_OS_PROBE !== "1" }, async () => {
  const folder = process.env.MIXED_EXECUTION_OS_OUTPUT; assert.ok(folder && isAbsolute(folder));
  const docker = async (args) => {
    const result = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 1024 ** 2 });
    assert.equal(result.status, 0, "local Docker observer command failed"); return result.stdout.trim();
  };
  const s = summary(); s.runId = `mixed-w999-${randomBytes(4).toString("hex")}`;
  s.executionMounts.output = mountSourceHash(folder);
  s.provenance.nativeSource.commit = immutableGit(process.cwd(), ["rev-parse", "HEAD"]).toString().trim();
  const actualImage = JSON.parse(await docker(["image", "inspect", "node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1"]))[0].Id;
  s.tools.nodeImage = actualImage; s.tools.browserImage = actualImage; s.apps.corten.image.id = actualImage;
  const collector = createExecutionEvidence({ folder, summary: s, docker }), name = `${s.runId}-corten-fixture`, network = `${s.runId}-net`;
  const labels = ["--label", "agent.owner=codex", "--label", `agent.task=${s.runId}`, "--label", `run.corten.mixed-production=${s.runId}`];
  let madeNetwork = false, attempted = false, replacementId;
  try {
    const actualNet = await docker(["network", "create", ...labels, network]); madeNetwork = true; await collector.networkCreated(network, actualNet);
    attempted = true;
    const originalId = await collector.create(name, () => docker(["create", "--name", name, ...labels, "--network", network, "--cpus", "1", "--memory", "1g",
      "-v", `${folder}:/fixtures:ro`, "-e", "MARKETPLACE_SOURCE=fixture", "-e", "PROFILE=", "-e", "MIXED_CONTROL_TOKEN=not-a-real-credential", actualImage]));
    await docker(["start", "-a", originalId]);
    await docker(["rename", originalId, `${name}-renamed`]);
    replacementId = await docker(["create", "--name", name, ...labels, "--network", network, actualImage]);
    const terminal = await collector.remove(name); attempted = false;
    assert.equal(terminal.id, originalId); assert.equal(terminal.name, `${name}-renamed`);
    assert.equal(await docker(["ps", "-a", "--no-trunc", "--filter", `id=${originalId}`, "--format", "{{.ID}}"]), "");
    assert.equal(await docker(["ps", "-a", "--no-trunc", "--filter", `id=${replacementId}`, "--format", "{{.ID}}"]), replacementId);
    const replacementControl = { originalId, replacementId, terminalName: terminal.name };
    assert.equal(await docker(["rm", "-f", "-v", replacementId]), replacementId); replacementId = null;
    await collector.removeNetwork(network); madeNetwork = false; await collector.seal();
    const result = replay(folder, s); assert.equal(result.resources, "verified"); assert.equal(result.cleanupComplete, true);
    writeFileSync(join(folder, "observer-replay.json"), JSON.stringify({ scope: "OS observer only, no native framework or benchmark admission",
      repositoryHead: s.provenance.nativeSource.commit, collectorFiles: read(folder, "execution/manifest.json").producerFiles, replacementControl, result }, null, 2));
  } finally {
    if (replacementId) await docker(["rm", "-f", "-v", replacementId]);
    if (attempted) await collector.remove(name); if (madeNetwork) await collector.removeNetwork(network);
  }
});
