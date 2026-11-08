// Memory floods of unfinished request heads leave behind, by allocator (docs/design.md#choice-jemalloc-image):
//   node flood-memory.mjs <out-dir> <image> [runs] [floods]
// The image is an app built with the template's jemalloc lines (card-market's Dockerfile has them).
// Each variant runs that one image with only the allocator changed by its environment: jemalloc
// with no settings, with its background thread (MALLOC_CONF), and with that and a 64 KiB thread
// cache (the template's); glibc's allocator (LD_PRELOAD empty); glibc's with two arenas or one and
// its trim threshold held at its default (glibc otherwise raises it); and two arenas with a 16 KiB
// mmap threshold. FLOOD_VARIANTS (names, comma-separated) runs only those. For each variant and run
// (3 unless given) the app starts on its own (--cpus 1 --memory 1g), takes a few requests, and
// then `floods` times (8 unless given) 4,000 connections each send a 30 KiB request head without
// its blank line, hold it 12 s and close; a probe container on the same network sends them. Memory
// is the app's cgroup: memory.current and memory.stat's anon, read at rest before the first flood,
// a second before the end of each hold, 5 s after each close, and 35 s after the last. Nothing
// else asks the app anything between floods, so an allocator that returns memory only while it is
// used (jemalloc without its background thread) is seen at its worst.
// Writes <out-dir>/flood-memory.json (every sample) after each run, and prints a line per run and
// a summary.
// Inside the probe it is run as: node flood-memory.mjs --flood <host> <port> <count> <bytes> <holdMs>
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sleep = (/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms));

if (process.argv[2] === "--flood") {
  const [host, port, count, bytes, holdMs] = process.argv.slice(3);
  const head = `GET /api/items/item_5 HTTP/1.1\r\nhost: localhost\r\nx-wait: ${"a".repeat(Number(bytes) - 64)}`;
  /** @type {import("node:net").Socket[]} */
  const sockets = [];
  let closedByServer = 0;
  const one = () => new Promise((done) => {
    const socket = connect({ host, port: Number(port) });
    socket.on("error", () => {});
    socket.on("close", () => { closedByServer++; });
    socket.once("connect", () => { socket.write(head); sockets.push(socket); done(null); });
    socket.once("error", () => done(null));
  });
  // In batches of 200, so the listen queue is not what refuses them.
  for (let i = 0; i < Number(count); i += 200) await Promise.all(Array.from({ length: Math.min(200, Number(count) - i) }, one));
  const opened = sockets.length;
  process.stdout.write("opened\n");
  await sleep(Number(holdMs));
  const before = closedByServer;
  for (const s of sockets) { s.removeAllListeners("close"); s.destroy(); }
  process.stdout.write(JSON.stringify({ opened, closedByServer: before }) + "\n");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const [out = "results/flood-memory", image, runsArg = "3", floodsArg = "8"] = process.argv.slice(2);
if (!image) throw new Error("usage: node flood-memory.mjs <out-dir> <image> [runs] [floods]");
const runs = Number(runsArg), floods = Number(floodsArg);
if (!Number.isInteger(runs) || runs < 1 || !Number.isInteger(floods) || floods < 1) throw new Error("runs and floods are whole numbers above zero");
const dir = join(here, out);
mkdirSync(dir, { recursive: true });
const docker = (/** @type {string[]} */ ...args) => spawnSync("docker", args, { encoding: "utf8", maxBuffer: 1 << 24 });
const net = "flood-memory";
const app = "flood-app", probe = "flood-probe";
const fixtures = join(here, "..", "..", "examples", "card-market", "fixtures");
/** @type {Record<string, string[]>} */
const variants = {
  jemalloc: ["-e", "MALLOC_CONF="],
  "jemalloc-bg": ["-e", "MALLOC_CONF=background_thread:true"],
  "jemalloc-tuned": ["-e", "MALLOC_CONF=background_thread:true,tcache_max:65536"], // the template's
  glibc: ["-e", "LD_PRELOAD="],
  "glibc-arena2": ["-e", "LD_PRELOAD=", "-e", "GLIBC_TUNABLES=glibc.malloc.arena_max=2:glibc.malloc.trim_threshold=131072"],
  "glibc-arena1": ["-e", "LD_PRELOAD=", "-e", "GLIBC_TUNABLES=glibc.malloc.arena_max=1:glibc.malloc.trim_threshold=131072"],
  "glibc-mmap": ["-e", "LD_PRELOAD=", "-e", "GLIBC_TUNABLES=glibc.malloc.arena_max=2:glibc.malloc.trim_threshold=131072:glibc.malloc.mmap_threshold=16384"],
};
if (process.env.FLOOD_VARIANTS) {
  const wanted = process.env.FLOOD_VARIANTS.split(",");
  for (const name of Object.keys(variants)) if (!wanted.includes(name)) delete variants[name];
  if (Object.keys(variants).length !== wanted.length) throw new Error("unknown variant in FLOOD_VARIANTS");
}

/** The app's cgroup memory in MiB: memory.current, and memory.stat's anon and file. */
const memory = () => {
  const r = docker("exec", app, "sh", "-c", "cat /sys/fs/cgroup/memory.current; grep -E '^(anon|file) ' /sys/fs/cgroup/memory.stat");
  if (r.status !== 0) throw new Error("memory: " + r.stderr);
  const [current, ...stats] = r.stdout.trim().split("\n");
  const mib = (/** @type {string} */ n) => +(Number(n) / 1048576).toFixed(1);
  const stat = Object.fromEntries(stats.map((l) => l.split(" ")));
  return { current: mib(current), anon: mib(stat.anon), file: mib(stat.file) };
};

/**
 * One flood from the probe: its result, with the app's memory sampled once, a second before the
 * hold ends (so a peak is that sample, not the highest the memory reached).
 */
const flood = (/** @type {number} */ holdMs) => new Promise((done, fail) => {
  const child = spawn("docker", ["exec", probe, "node", "/b/flood-memory.mjs", "--flood", app, "8080", "4000", "30720", String(holdMs)]);
  let text = "";
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {object | null} */
  let held = null;
  /** @type {unknown} */
  let sampleError = null;
  child.stdout.on("data", (c) => {
    text += c;
    if (timer === undefined && text.includes("opened\n")) {
      timer = setTimeout(() => { try { held = memory(); } catch (e) { sampleError = e; } }, holdMs - 1000);
    }
  });
  child.on("exit", (code) => {
    clearTimeout(timer);
    if (code !== 0) return fail(new Error("flood exited " + code));
    if (sampleError) return fail(sampleError);
    if (held === null) return fail(new Error("the flood ended before its memory was sampled"));
    done({ ...JSON.parse(text.split("\n").filter(Boolean).at(-1) ?? "{}"), held });
  });
});

const image_id = docker("image", "inspect", "--format", "{{.Id}}", image).stdout.trim();
/** @type {{ variant: string, run: number, rest: any, floods: any[], end: any }[]} */
const results = [];
/** Writes what has been measured so far, so a run that fails later keeps the earlier ones. */
const save = () => writeFileSync(join(dir, "flood-memory.json"), JSON.stringify({ image, image_id, runs, floods, variants, results }, null, 1));

docker("network", "create", net);
docker("rm", "-f", probe);
try {
  const started = docker("run", "-d", "--name", probe, "--network", net, "--ulimit", "nofile=65536:65536", "-v", here + ":/b:ro", "node:24-alpine", "sleep", "infinity");
  if (started.status !== 0) throw new Error("probe: " + started.stderr);
  for (let run = 1; run <= runs; run++) {
    for (const [variant, env] of Object.entries(variants)) {
      docker("rm", "-f", app);
      const r = docker("run", "-d", "--name", app, "--network", net, "--cpus", "1", "--memory", "1g", "-v", fixtures + ":/fixtures:ro", "-e", "ITEM_SOURCE=fixture", "-e", "FIXTURE_PATH=/fixtures/smoke.json", "-e", "PORT=8080", "-e", `HOSTS=${app}`, ...env, image);
      if (r.status !== 0) throw new Error("app: " + r.stderr);
      await sleep(3000);
      for (let i = 0; i < 20; i++) docker("exec", probe, "wget", "-q", "-O", "/dev/null", "--header", "host: localhost", `http://${app}:8080/api/items/item_5`);
      await sleep(2000);
      const rest = memory();
      const each = [];
      for (let f = 1; f <= floods; f++) {
        const result = /** @type {{ held: object }} */ (await flood(12000));
        await sleep(5000);
        each.push({ flood: f, ...result, after: memory() });
      }
      await sleep(30000);
      const end = memory();
      results.push({ variant, run, rest, floods: each, end });
      save();
      console.log(JSON.stringify({ variant, run, rest: rest.current, held: each.map((e) => e.held.current), after: each.map((e) => e.after.current), end: end.current, endAnon: end.anon, opened: each.map((e) => e.opened) }));
    }
  }
} finally {
  docker("rm", "-f", app, probe);
  docker("network", "rm", net);
}

const median = (/** @type {number[]} */ xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const range = (/** @type {number[]} */ xs) => `${median(xs)} (${Math.min(...xs)} to ${Math.max(...xs)})`;
for (const variant of Object.keys(variants)) {
  const mine = results.filter((x) => x.variant === variant);
  const end = (/** @type {"current" | "anon"} */ k) => mine.map((x) => x.end[k]);
  const peak = (/** @type {"current" | "anon"} */ k) => mine.map((x) => Math.max(...x.floods.map((e) => e.held[k])));
  console.log(`${variant}, MiB, median (range): 35 s after the last flood memory.current ${range(end("current"))}, anon ${range(end("anon"))}; sampled 1 s before a hold ended, highest ${range(peak("current"))}, anon ${range(peak("anon"))}`);
}
