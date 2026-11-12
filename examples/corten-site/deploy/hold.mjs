// Measures what the site holds: the memory it has idle and with a number of live streams open,
// and the pages it serves a second while they are held. It talks to the app itself over HTTP,
// with no proxy between, and reads the memory from the page's own JSON, with the CPU and memory
// the server last read as in use: its machine's, or of the limits its container is held to. A
// browser asks for its stream compressed, and each compressed stream holds a coder's memory:
// name a coding (zstd or gzip) to hold the streams as a browser does, or none to hold them as
// they are.
// Usage: node examples/corten-site/deploy/hold.mjs http://localhost:18488 [streams] [seconds] [coding]
import http from "node:http";

const base = new URL(process.argv[2] ?? "");
const streams = Number(process.argv[3] ?? 1000);
const seconds = Number(process.argv[4] ?? 10);
const coding = process.argv[5] ?? "";
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const wait = (/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms));

/**
 * One request, read to its end.
 * @param {string} path @param {Record<string, string>} [headers]
 * @returns {Promise<{ status: number, size: number, ms: number, text: string }>}
 */
const get = (path, headers = {}) =>
  new Promise((resolve, reject) => {
    const began = performance.now();
    const req = http.get({ host: base.hostname, port: base.port, path, headers, agent }, (res) => {
      /** @type {Buffer[]} */
      const parts = [];
      res.on("data", (part) => parts.push(part));
      res.on("end", () => {
        const body = Buffer.concat(parts);
        resolve({ status: res.statusCode ?? 0, size: body.length, ms: performance.now() - began, text: body.toString() });
      });
    });
    req.on("error", reject);
  });

/** The server's own readings, from the page's JSON. */
const server = async () => JSON.parse((await get("/", { accept: "application/json" })).text).data.server;
const mib = (/** @type {number} */ bytes) => (bytes / 1048576).toFixed(1);
/** What is in use by the server's last reading, of its machine or of its container's limits; nothing where the system does not count. */
const using = (/** @type {{ machine_cpu_used_percent: number | null, machine_memory_used_bytes: number }} */ read) =>
  read.machine_cpu_used_percent === null ? "" : `; in use by its reading: ${read.machine_cpu_used_percent}% of the CPU and ${mib(read.machine_memory_used_bytes)} MiB`;

const idle = await server();
console.log(`idle: ${mib(idle.memory_held_bytes)} MiB held, of ${mib(idle.machine_memory_bytes)} MiB on ${idle.machine_cpus} CPU`);

// The streams, each on a connection of its own, as each open page's is.
let open = 0;
let coded = 0;
let readings = 0;
/** @type {http.ClientRequest[]} */
const held = [];
for (let n = 0; n < streams; n += 1) {
  const headers = coding ? { "accept-encoding": coding } : {};
  const req = http.get({ host: base.hostname, port: base.port, path: "/live/works", headers, agent: false }, (res) => {
    if (res.statusCode === 200) open += 1;
    const compressed = coding !== "" && res.headers["content-encoding"] === coding;
    if (compressed) coded += 1;
    // A compressed reading cannot be told from its bytes, and arrives as one piece.
    res.on("data", (part) => (readings += compressed ? 1 : String(part).split("event: patch").length - 1));
    res.on("error", () => {});
  });
  req.on("error", () => {});
  held.push(req);
  if (n % 100 === 99) await wait(100);
}
await wait(5000);
const before = readings;
await wait(5000);
const holding = await server();
console.log(
  `${open} of ${streams} streams open${coding ? `, ${coded} of them sent as ${coding}` : ""}: ${mib(holding.memory_held_bytes)} MiB held, ${holding.pages_following} following by the server's count, ${((readings - before) / 5).toFixed(0)} readings a second delivered${using(holding)}`,
);

// Pages while the streams are held, 16 asked for at a time.
let pages = 0;
let size = 0;
/** @type {number[]} */
const times = [];
const until = performance.now() + seconds * 1000;
await Promise.all(
  Array.from({ length: 16 }, async () => {
    while (performance.now() < until) {
      const page = await get("/");
      if (page.status !== 200) continue;
      pages += 1;
      size = page.size;
      times.push(page.ms);
    }
  }),
);
times.sort((a, b) => a - b);
const after = await server();
console.log(
  `with them held: ${(pages / seconds).toFixed(0)} pages a second (${size} bytes each, uncompressed), median ${(times[times.length >> 1] ?? 0).toFixed(1)} ms, 99th percentile ${(times[Math.floor(times.length * 0.99)] ?? 0).toFixed(1)} ms`,
);
// Asked as the last pages are answered, so the reading is of a second they were served in.
console.log(`after: ${mib(after.memory_held_bytes)} MiB held, the last page rendered in ${after.last_render_micros} µs${using(after)}`);
for (const req of held) req.destroy();
agent.destroy();
