// rust-analyzer's own latency for each Rust app, over LSP, as an editor drives it:
//   node rust-analyzer.mjs <round> [apps=the Rust apps] [runs=5]
// build.mjs measures `cargo check`, what the editor runs for its diagnostics on save; this
// measures the language server itself, with that check turned off (`checkOnSave: false`), so
// every number is rust-analyzer's own analysis, proc macros (the apps' markup) expanded. Each app
// runs in a container of its toolchain with its source copied in and its dependencies fetched,
// pinned to BENCH_BUILD_CPUS (otherwise the host's first four) with build.mjs's memory cap. This
// script is the client, over the container's stdio.
// 1. Ready, cold: from `initialize` until the server is first quiescent
//    (`experimental/serverStatus`): the workspace loaded, build scripts and proc macros built
//    (`cargo check` of them, so the dependencies compile), and its caches primed. Then ready
//    again from a new server in the same container, with those builds kept (warm).
// 2. On the warm server, with the file the page's edit is in open, `runs` times: the item page's edit made
//    (the button's title, numbered by run), then a completion asked for at once at the recipe's
//    point inside the markup (`ra` in builds.mjs), timed to its answer, and whether the answer
//    offers the expected field; then the field's name made unknown there (`nope_` typed before
//    it) and the time the server takes to answer the editor's request for the file's errors
//    (`textDocument/diagnostic`: this server pushes only syntax errors, and gives type errors
//    when asked), with whether it has the error, and the same once the text is back. An unknown
//    field is one of rust-analyzer's experimental diagnostics, off unless an editor turns them on
//    (`rust-analyzer.diagnostics.experimental.enable`); this turns them on.
// 3. The server's peak memory (VmHWM) at the end.
// A step with no answer in two minutes records null and its reason. Results merge into
// results/<round>/rust-analyzer.json.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contextOf, median, recipes, runChange, sourceDockerfile } from "./builds.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const rustApps = Object.keys(recipes).filter((n) => recipes[n].ra);
const [round = "r1", appsArg = rustApps.join(","), runsArg = "5"] = process.argv.slice(2);
const runs = Number(runsArg);
if (!Number.isInteger(runs) || runs < 1) throw new Error("runs is a whole number, 1 or more");
const apps = appsArg.split(",");
for (const name of apps) if (!recipes[name]?.ra) throw new Error(`${name} has no completion point (ra) in builds.mjs`);
const hour = 3_600_000;
const limit = 120_000;
const docker = (/** @type {string[]} */ args, /** @type {string=} */ input) => spawnSync("docker", args, { encoding: "utf8", maxBuffer: 256 * 2 ** 20, timeout: hour, input });
const must = (/** @type {string[]} */ args, /** @type {string=} */ input) => {
  const r = docker(args, input);
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(" ")}: ${(r.stdout + r.stderr || r.error?.message || "").trim().slice(-3000)}`);
  return r.stdout;
};
const hostCores = Number(docker(["info", "--format", "{{.NCPU}}"]).stdout.trim());
const cores = process.env.BENCH_BUILD_CPUS ?? `0-${Math.min(4, hostCores || 4) - 1}`;
const hostMemory = Number(docker(["info", "--format", "{{.MemTotal}}"]).stdout.trim());
const memoryCap = Math.min(12 * 2 ** 30, (hostMemory || 16 * 2 ** 30) - 2 * 2 ** 30);
const outFile = join(here, "results", round, "rust-analyzer.json");
/** @type {Record<string, any>} */
const out = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};
const save = () => { mkdirSync(dirname(outFile), { recursive: true }); writeFileSync(outFile, JSON.stringify(out, null, 1)); };

/** A UTF-16 position of `offset` in `text`, as LSP counts by default. */
const position = (/** @type {string} */ text, /** @type {number} */ offset) => {
  const before = text.slice(0, offset);
  const line = before.split("\n").length - 1;
  return { line, character: offset - (before.lastIndexOf("\n") + 1) };
};

/** A language server over a process's stdio: requests, notifications, and waits on what it sends. */
class Server {
  /** @param {import("node:child_process").ChildProcessWithoutNullStreams} child */
  constructor(child) {
    this.child = child;
    this.id = 0;
    /** @type {Map<number, (msg: any) => void>} */
    this.pending = new Map();
    /** @type {((msg: any) => void)[]} */
    this.listeners = [];
    // A server that exits leaves its requests to time out, not this process to crash.
    child.stdin.on("error", () => {});
    let buffer = Buffer.alloc(0);
    child.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString("ascii"))?.[1]);
        if (buffer.length < end + 4 + length) return;
        const msg = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString("utf8"));
        buffer = buffer.subarray(end + 4 + length);
        this.receive(msg);
      }
    });
  }
  /** @param {any} msg */
  receive(msg) {
    if (msg.id !== undefined && msg.method) {
      // A request from the server (progress tokens, registrations): accepted with no result.
      this.write({ jsonrpc: "2.0", id: msg.id, result: null });
      return;
    }
    if (msg.id !== undefined) { this.pending.get(msg.id)?.(msg); this.pending.delete(msg.id); return; }
    for (const listen of [...this.listeners]) listen(msg);
  }
  /** @param {any} msg */
  write(msg) {
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
  }
  /** @param {string} method @param {any} params @returns {Promise<any>} */
  request(method, params) {
    const id = ++this.id;
    return this.within(new Promise((resolve, reject) => {
      this.pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
      this.write({ jsonrpc: "2.0", id, method, params });
    }), method);
  }
  /** @param {string} method @param {any} params */
  notify(method, params) { this.write({ jsonrpc: "2.0", method, params }); }
  /** The first notification `pick` accepts, from now on. @param {(msg: any) => boolean} pick @param {string} what */
  until(pick, what) {
    return this.within(new Promise((resolve) => {
      const listen = (/** @type {any} */ msg) => { if (pick(msg)) { this.listeners = this.listeners.filter((l) => l !== listen); resolve(msg); } };
      this.listeners.push(listen);
    }), what);
  }
  /** @template T @param {Promise<T>} p @param {string} what @returns {Promise<T>} */
  within(p, what) {
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer to ${what} in ${limit / 1000} s`)), limit * (what === "ready" ? 15 : 1)); })]).finally(() => clearTimeout(timer));
  }
}

/** Starts rust-analyzer in `container` and waits until it is first quiescent; returns it and the time. */
async function start(/** @type {string} */ container, /** @type {string} */ root, /** @type {string[]} */ features) {
  const child = spawn("docker", ["exec", "-i", "-w", root, container, "rust-analyzer"], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const server = new Server(child);
  let busy = false;
  const ready = server.until((m) => {
    if (m.method !== "experimental/serverStatus") return false;
    if (!m.params.quiescent) busy = true;
    return busy && m.params.quiescent;
  }, "ready");
  const began = performance.now();
  await server.request("initialize", {
    processId: null,
    rootUri: `file://${root}`,
    workspaceFolders: [{ uri: `file://${root}`, name: "app" }],
    capabilities: {
      window: { workDoneProgress: true },
      textDocument: { diagnostic: { dynamicRegistration: false }, completion: { completionItem: { snippetSupport: false } }, synchronization: { didSave: true } },
      experimental: { serverStatusNotification: true },
    },
    // Type errors (an unknown field among them) are among rust-analyzer's experimental diagnostics,
    // which an editor turns on; without them the server reports none of the probe's error.
    initializationOptions: { checkOnSave: false, cargo: { features }, procMacro: { enable: true }, cachePriming: { enable: true }, diagnostics: { experimental: { enable: true } } },
  });
  server.notify("initialized", {});
  const status = await ready;
  return { server, child, readyMs: Math.round(performance.now() - began), health: status.params.health };
}

async function stop(/** @type {Server} */ server, /** @type {import("node:child_process").ChildProcess} */ child) {
  try { await server.request("shutdown", null); server.notify("exit", null); } catch {}
  await new Promise((resolve) => { child.once("exit", resolve); setTimeout(() => { child.kill(); resolve(null); }, 10_000); });
}

for (const name of apps) {
  const r = recipes[name];
  const ra = /** @type {NonNullable<typeof r.ra>} */ (r.ra);
  const image = `bb-ra-${name}`;
  const container = `bb-ra-${name}`;
  /** @type {Record<string, any>} */
  const entry = { cores, memoryCap, measuredAt: new Date().toISOString(), complete: false };
  out[name] = entry;
  const keep = (/** @type {string} */ key, /** @type {unknown} */ value) => { entry[key] = value; save(); return value; };
  docker(["rm", "-f", container]);
  try {
    if (r.stage) must(["build", "-q", "--target", "tools", "-t", r.tools, join(repo, r.stage)]);
    must(["build", "-q", "-t", image, "-f", "-", join(repo, contextOf(name))], sourceDockerfile(name));
    must(["run", "-d", "--name", container, "--cpuset-cpus", cores, "--memory", String(memoryCap), image, "sleep", "infinity"]);
    // Untimed: the dependencies' sources, and the server with the standard library's.
    must(["exec", container, "sh", "-c", `${r.deps} && rustup component add rust-analyzer rust-src`]);
    keep("version", must(["exec", container, "rust-analyzer", "--version"]).trim());
    const cold = await start(container, r.workdir, ra.features ?? []);
    keep("readyCold", { ms: cold.readyMs, health: cold.health });
    console.log(name, "ready cold", cold.readyMs, cold.health);
    await stop(cold.server, cold.child);
    const warm = await start(container, r.workdir, ra.features ?? []);
    keep("readyWarm", { ms: warm.readyMs, health: warm.health });
    console.log(name, "ready warm", warm.readyMs, warm.health);
    const { server } = warm;
    const uri = `file://${r.workdir}/${r.edit}`;
    const original = readFileSync(join(repo, contextOf(name), r.edit), "utf8");
    const literal = ra.at.replace("|", "");
    let version = 1;
    server.notify("textDocument/didOpen", { textDocument: { uri, languageId: "rust", version, text: original } });
    const change = (/** @type {string} */ text) => { version += 1; server.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] }); };
    /** The file's errors as the server has them now, asked for as an editor asks (pull diagnostics), and how long that took. */
    const errors = async () => {
      const began = performance.now();
      const report = await server.request("textDocument/diagnostic", { textDocument: { uri } });
      const found = (report?.items ?? []).filter((/** @type {any} */ d) => d.severity === 1);
      return { ms: Math.round(performance.now() - began), n: found.length, kind: report?.kind, messages: found.map((/** @type {any} */ d) => `${d.code}: ${d.message}`) };
    };
    /** @type {any[]} */
    const probes = [];
    for (let run = 1; run <= runs; run += 1) {
      /** @type {Record<string, any>} */
      const probe = { run };
      // The page's edit, then a completion at once.
      const { from, to } = runChange(name, run);
      const edited = original.replace(from, to);
      change(edited);
      const at = edited.indexOf(literal) + ra.at.indexOf("|");
      try {
        const began = performance.now();
        const result = await server.request("textDocument/completion", { textDocument: { uri }, position: position(edited, at) });
        probe.completionMs = Math.round(performance.now() - began);
        const items = Array.isArray(result) ? result : result?.items ?? [];
        probe.items = items.length;
        probe.offered = items.some((/** @type {any} */ i) => (i.filterText ?? i.label).replace(/\(.*$/, "") === ra.expect);
      } catch (e) { probe.completionMs = null; probe.completionError = e instanceof Error ? e.message : String(e); }
      // The field's name made unknown, then put back; each followed at once by the editor's request
      // for the file's errors, so the time is the server's analysis of the changed text.
      try {
        const baseline = (await errors()).n;
        change(edited.slice(0, at) + "nope_" + edited.slice(at));
        const shown = await errors();
        probe.errorMs = shown.ms;
        probe.errorShown = shown.n > baseline;
        if (!probe.errorShown) probe.errorsSeen = { baseline, kind: shown.kind, messages: shown.messages };
        change(edited);
        const cleared = await errors();
        probe.clearedMs = cleared.ms;
        probe.cleared = cleared.n === baseline;
      } catch (e) { probe.diagnosticsError = e instanceof Error ? e.message : String(e); }
      probes.push(probe);
      console.log(name, JSON.stringify(probe));
      const med = (/** @type {string} */ k) => { const xs = probes.map((p) => p[k]).filter((x) => typeof x === "number"); return xs.length ? median(xs) : null; };
      keep("probes", { completionMs: med("completionMs"), errorMs: med("errorMs"), clearedMs: med("clearedMs"), offered: probes.filter((p) => p.offered).length, errorShown: probes.filter((p) => p.errorShown).length, runs: probes });
    }
    const hwm = docker(["exec", container, "sh", "-c", "for p in /proc/[0-9]*; do if [ \"$(cat $p/comm 2>/dev/null)\" = rust-analyzer ]; then grep VmHWM $p/status; fi; done"]).stdout;
    const kb = Math.max(0, ...[...hwm.matchAll(/VmHWM:\s+(\d+)/g)].map((m) => Number(m[1])));
    keep("peakMiB", Math.round(kb / 1024));
    await stop(server, warm.child);
    keep("complete", true);
  } catch (e) {
    keep("error", e instanceof Error ? e.message : String(e));
    console.log(`${name} failed: ${entry.error}`);
  } finally {
    docker(["rm", "-f", container]);
    docker(["rmi", "-f", image]);
  }
}
