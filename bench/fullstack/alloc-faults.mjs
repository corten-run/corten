// CPU time and minor page faults a request, by image and Accept-Encoding (docs/design.md#choice-jemalloc-image):
//   node alloc-faults.mjs <out-dir> <image> [image ...]
// Each image runs alone (--cpus 1 --memory 1g, items in memory from fixtures/items.json) on the bench
// network. A probe container sends 500 item pages to warm it, then REQUESTS (3,000 unless set) more
// from 8 connections, for each of identity, a browser's encodings and brotli alone (ENCODINGS,
// comma-separated names, for some); the server's /proc/1/stat is read before and after, so a
// request's minor faults (minflt) and CPU time (utime + stime, in the kernel's 10 ms ticks) are
// the difference over the requests (ticks assumed 100 a second, Linux's USER_HZ). A figure is an
// average over everything the server did in that window, so it repeats to about 0.1 a request;
// CPU time is coarse and moves with whatever else the machine runs. ROUNDS (3 unless set) repeats
// every image and encoding in turn. Writes <out-dir>/summary.json (each image's id and allocator
// environment, and every row) after each row; a request that is not answered 200 stops it.
// Inside the probe it is run as: node alloc-faults.mjs --load <base> <encoding> <requests>
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { network } from "./apps.mjs";

if (process.argv[2] === "--load") {
  const [base, encoding, count] = process.argv.slice(3);
  let left = Number(count), failed = 0;
  const worker = async () => {
    while (left-- > 0) {
      const r = await fetch(`${base}/items/item_${1 + (left % 20)}`, { headers: { "accept-encoding": encoding, host: "localhost" } });
      await r.arrayBuffer();
      if (r.status !== 200) failed++;
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  process.stdout.write(String(failed));
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const [out, ...images] = process.argv.slice(2);
if (!out || images.length === 0) throw new Error("usage: node alloc-faults.mjs <out-dir> <image> [image ...]");
const whole = (/** @type {string} */ name, /** @type {number} */ fallback) => {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} is a whole number above zero`);
  return n;
};
const requests = whole("REQUESTS", 3000), rounds = whole("ROUNDS", 3);
/** @type {Record<string, string>} */
const encodings = { identity: "identity", browser: "gzip, deflate, br, zstd", br: "br" };
if (process.env.ENCODINGS) {
  const wanted = process.env.ENCODINGS.split(",");
  for (const name of Object.keys(encodings)) if (!wanted.includes(name)) delete encodings[name];
  if (Object.keys(encodings).length !== wanted.length) throw new Error("ENCODINGS names one of identity, browser, br");
}
const dir = join(here, out);
mkdirSync(dir, { recursive: true });
const docker = (/** @type {string[]} */ ...args) => spawnSync("docker", args, { encoding: "utf8" });
const sleep = (/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms));
const app = "faults-app";
/** The server's minor faults and CPU ticks so far. */
const stat = () => {
  const r = docker("exec", app, "cat", "/proc/1/stat");
  if (r.status !== 0) throw new Error("stat: " + r.stderr);
  // The command name, in parentheses, may hold spaces; the fields after it are fixed.
  const f = r.stdout.slice(r.stdout.lastIndexOf(")") + 2).split(" ");
  return { minflt: Number(f[7]), ticks: Number(f[11]) + Number(f[12]) };
};
const load = (/** @type {string} */ encoding, /** @type {number} */ n) => {
  const r = docker("run", "--rm", "--network", network, "-v", here + ":/b:ro", "node:24-alpine", "node", "/b/alloc-faults.mjs", "--load", `http://${app}:8080`, encoding, String(n));
  if (r.status !== 0) throw new Error("load: " + r.stderr);
  return Number(r.stdout);
};

/** Each image's id and the allocator settings in its environment. */
const described = Object.fromEntries(images.map((image) => {
  const r = docker("image", "inspect", "--format", "{{json .}}", image);
  if (r.status !== 0) throw new Error("image: " + r.stderr);
  const info = JSON.parse(r.stdout);
  const env = /** @type {string[]} */ (info.Config.Env ?? []).filter((e) => /^(LD_PRELOAD|MALLOC_CONF|GLIBC_TUNABLES)=/.test(e));
  return [image, { id: info.Id, env }];
}));
/** @type {{ round: number, image: string, enc: string, faults: number, cpuMicros: number, failed: number }[]} */
const rows = [];
const save = () => writeFileSync(join(dir, "summary.json"), JSON.stringify({ requests, rounds, images: described, rows }, null, 1));
try {
  for (let round = 1; round <= rounds; round++) {
    for (const image of images) {
      for (const [enc, encoding] of Object.entries(encodings)) {
        docker("rm", "-f", app);
        const run = docker("run", "-d", "--name", app, "--network", network, "--cpus", "1", "--memory", "1g", "-v", `${join(here, "fixtures")}:/fixtures:ro`, "-e", "ITEM_SOURCE=fixture", "-e", "FIXTURE_PATH=/fixtures/items.json", "-e", "PORT=8080", "-e", `HOSTS=${app}`, image);
        if (run.status !== 0) throw new Error(run.stderr);
        await sleep(6000);
        load(encoding, 500);
        const before = stat();
        const failed = load(encoding, requests);
        const after = stat();
        const row = { round, image, enc, faults: +((after.minflt - before.minflt) / requests).toFixed(1), cpuMicros: Math.round(((after.ticks - before.ticks) * 10000) / requests), failed };
        rows.push(row);
        save();
        console.log(JSON.stringify(row));
        if (failed > 0) throw new Error(`${image} ${enc}: ${failed} requests not answered 200`);
      }
    }
  }
} finally {
  docker("rm", "-f", app);
}
