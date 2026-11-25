// catalog/verify.mjs: what the plan checks on the catalog's host before any pair, each of which
// stops the run. It gives itself the run's environment (BENCH_APP_CPUS=1 BENCH_LOAD_CPUS=4-7):
//   node /m/hc/catalog/verify.mjs
//   1. perf counts count.mjs's five events at 100% on CPU 1 over an idle second.
//   2. The request: k6, with the script's ssr-load.js and its BASE, sends one request of each
//      target to a listening socket it reaches as fsw-corten:8080 (capture.mjs in a container of
//      that name on the bench network); the bytes are saved, and whether Host is the first
//      header line is recorded.
//   3. The answers: each image is started as count.mjs starts it (runArgs of its apps.mjs, the
//      image under the name the script expects) and asked for each of the 500 items at both
//      paths with the header lines k6 sent. The base is started twice and asked twice on each
//      start; the head once. Every status is 200. Two askings of one start must agree in the
//      status line, every header but Date, and the body. Two starts must agree in the same, but
//      for the value of a weak ETag, which is then masked at that path; any other difference
//      stops the run. Then the base's and the head's answers are compared the same way.
// DRYRUN=1: the base's image stands in for the head's, so only the base is started.
// Writes catalog-state/verify[-dry]/: requests, records and verify.txt; ends VERIFY-OK.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { parse } from "../ask.mjs";

const P = "/m/hc", T = `${P}/tree-head`, F = `${T}/bench/fullstack`, S = `${P}/catalog-state`;
const DRY = process.env.DRYRUN === "1";
const out = join(S, DRY ? "verify-dry" : "verify");
// The run's environment, as the pairs have it; apps.mjs reads it when it is loaded.
process.env.BENCH_APP_CPUS ??= "1";
process.env.BENCH_LOAD_CPUS ??= "4-7";
if (process.env.BENCH_APP_CPUS !== "1" || process.env.BENCH_LOAD_CPUS !== "4-7") { console.error("verify.mjs: BENCH_APP_CPUS is 1 and BENCH_LOAD_CPUS 4-7, as the pairs have them"); process.exit(2); }
for (const v of ["BENCH_TIER", "BENCH_APPS", "BENCH_NETWORK", "BENCH_API_CONTAINER"]) if (process.env[v]) { console.error(`verify.mjs: ${v} is set; the pairs run without it`); process.exit(2); }
if (existsSync(join(S, "armed"))) { console.error("verify.mjs: a run is going on"); process.exit(1); }
const { apps, k6Net, k6User, loadCpus, network, runArgs } = await import(`${F}/apps.mjs`);
const { k6Image } = await import(`${F}/load-tool.mjs`);
const NODE = "node:26.13.1-trixie-slim@sha256:615a27817f7b9508f0de73eb1cc8fc8894ab122bee56c1a7a568b72cd1032067"; // bench/fullstack/droplet.mjs's
const EVENTS = ["instructions:u", "instructions:k", "cycles:u", "cycles:k", "L1-icache-load-misses:u"];
const lines = [];
const say = (s) => { console.log(s); lines.push(s); writeFileSync(join(out, "verify.txt"), lines.join("\n") + "\n"); };
const stop = (why) => { say(`VERIFY-FAILED: ${why}`); docker("rm", "-f", "fsw-corten"); process.exit(1); };
const docker = (...args) => spawnSync("docker", args, { encoding: "utf8", maxBuffer: 1 << 26 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "requests"), { recursive: true });
const image = (side) => (DRY ? "cb-corten-base" : `cb-corten-${side}`);
const idOf = (name) => docker("image", "inspect", "-f", "{{.Id}}", name).stdout.trim();
for (const side of ["base", "head"]) if (!idOf(image(side))) stop(`no image ${image(side)}: build it first`);
if (!DRY && idOf("cb-corten-base") === idOf("cb-corten-head")) stop("the two sides are one image");
say(`${DRY ? "DRYRUN (the base's image stands in for the head's; nothing here is read): " : ""}base ${idOf(image("base"))}, head ${idOf(image("head"))}`);

// 1. perf, as count.mjs counts: on the app's CPU.
{
  const r = spawnSync("perf", ["stat", "-C", "1", "-x", ",", "-e", EVENTS.join(","), "--", "sleep", "1"], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  writeFileSync(join(out, "perf-idle.txt"), r.stderr);
  for (const e of EVENTS) {
    const row = r.stderr.split("\n").map((l) => l.split(",")).find((c) => c[2] === e || c[2] === e.replace(/:u$/, ""));
    if (r.status !== 0 || !row || !/^\d+$/.test(row[0]) || Number(row[4]) !== 100) stop(`perf does not count ${e} at 100% on CPU 1 over an idle second: ${row ? row.join(",") : r.stderr.trim().split("\n")[0]}`);
  }
  say(`1. perf counts ${EVENTS.join(", ")} at 100% on CPU 1 over an idle second`);
}

// 2. The request k6 sends, off a listening socket named as the app is.
const sent = {};
{
  docker("rm", "-f", "fsw-corten");
  const run = docker("run", "-d", "--name", "fsw-corten", "--network", network, "-v", `${P}/catalog:/c:ro`, "-v", `${join(out, "requests")}:/out`, NODE, "node", "/c/capture.mjs", "8080", "/out");
  if (run.status !== 0) stop(`the listening socket did not start: ${run.stderr.trim().split("\n")[0]}`);
  await sleep(1500);
  let n = 0;
  for (const target of ["page", "json"]) {
    const k6 = docker("run", "--rm", "--network", network, ...k6Net, ...loadCpus, ...k6User, "-v", `${F}:/bench`, "-e", "BASE=http://fsw-corten:8080", "-e", `TARGET=${target}`,
      "-e", "MODE=iterations", "-e", "VUS=1", "-e", "ITERATIONS=1", k6Image, "run", "--quiet", "/bench/ssr-load.js");
    if (k6.status !== 0) stop(`k6 did not run for ${target}: ${k6.stderr.trim().split("\n").pop()}`);
    const file = join(out, "requests", `request-${++n}.bin`);
    if (!existsSync(file)) stop(`k6 sent no request for ${target}`);
    const text = readFileSync(file).toString("latin1");
    const [requestLine, ...headers] = text.split("\r\n").filter(Boolean);
    const at = headers.findIndex((h) => /^host:/i.test(h));
    const m = /^GET (\/(?:api\/)?items\/item_)(\d+) HTTP\/1\.1$/.exec(requestLine);
    if (!m || (target === "json") !== m[1].startsWith("/api/")) stop(`${target}: the request line is ${JSON.stringify(requestLine)}`);
    if (headers[at] !== "Host: fsw-corten:8080") stop(`${target}: the Host line is ${JSON.stringify(headers[at])}, not "Host: fsw-corten:8080"`);
    if (!headers.includes("Accept-Encoding: identity")) stop(`${target}: no "Accept-Encoding: identity" line among ${JSON.stringify(headers)}`);
    sent[target] = { prefix: m[1], headers, hostFirst: at === 0 };
    say(`2. ${target}: k6 sends ${JSON.stringify(requestLine)} with ${headers.length} header lines, ${JSON.stringify(headers)}; Host is line ${at + 1} of ${headers.length}${at === 0 ? " (first)" : " (NOT first: the plan's paragraph on what the requests run of the change is to be corrected before any pair)"}`);
  }
  docker("rm", "-f", "fsw-corten");
}

// 3. The answers.
const PATHS = [];
for (const target of ["page", "json"]) for (let n = 1; n <= 500; n++) PATHS.push({ target, path: `${sent[target].prefix}${n}` });
/** One answer to raw request bytes on a kept connection: { head, body }. */
function client(port) {
  let sock = null, buf = Buffer.alloc(0), waiting = null, ended = false;
  const open = () => new Promise((resolve, reject) => {
    ended = false; buf = Buffer.alloc(0);
    sock = connect(port, "127.0.0.1", resolve);
    sock.on("data", (d) => { buf = Buffer.concat([buf, d]); waiting?.(); });
    sock.on("end", () => { ended = true; waiting?.(); });
    sock.on("error", (e) => { ended = true; waiting?.(e); reject(e); });
  });
  return {
    async ask(bytes) {
      if (!sock || ended || sock.destroyed) await open();
      sock.write(bytes);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const a = parse(buf, ended);
        if (a) {
          // What is left belongs to no request: one answer a request, in order.
          const used = buf.indexOf("\r\n\r\n") + 4;
          const text = a.head.toString("latin1");
          const chunked = /^transfer-encoding:.*chunked\s*$/im.test(text);
          buf = chunked ? Buffer.alloc(0) : buf.subarray(used + a.body.length);
          if (/^connection:\s*close\s*$/im.test(text)) { sock.destroy(); sock = null; }
          return a;
        }
        if (ended) throw new Error("the connection ended before a whole answer");
        if (Date.now() > deadline) throw new Error("no whole answer in 10 s");
        await new Promise((r) => { waiting = () => { waiting = null; r(); }; setTimeout(r, 200); });
      }
    },
    close() { sock?.destroy(); },
  };
}
async function start(side) {
  docker("rm", "-f", "fsw-corten");
  const tag = docker("tag", image(side), "cb-corten");
  if (tag.status !== 0) stop(`docker tag ${image(side)} cb-corten: ${tag.stderr.trim()}`);
  const run = docker(...runArgs("corten", apps.corten, "fixture", join(F, "fixtures")));
  if (run.status !== 0) stop(`${side} did not start: ${run.stderr.trim().split("\n")[0]}`);
  const started = Date.now();
  for (let i = 0; i < 2400; i++) {
    try { if ((await fetch(`http://localhost:${apps.corten.port}/items/item_1`)).ok) return Date.now() - started; } catch {}
    await sleep(25);
  }
  stop(`${side} never answered /items/item_1 on localhost:${apps.corten.port} within a minute: ${docker("logs", "--tail", "5", "fsw-corten").stderr.trim()}`);
}
async function asking(label) {
  const c = client(apps.corten.port), answers = new Map();
  for (const { target, path } of PATHS) {
    const bytes = Buffer.from([`GET ${path} HTTP/1.1`, ...sent[target].headers, "", ""].join("\r\n"), "latin1");
    let a;
    try { a = await c.ask(bytes); } catch (e) { stop(`${label}: ${path}: ${e.message}`); }
    const [status, ...headers] = a.head.toString("latin1").split("\r\n").filter(Boolean);
    if (!/^HTTP\/1\.1 200 /.test(status)) stop(`${label}: ${path} answered ${JSON.stringify(status)}, not 200`);
    answers.set(path, { status, headers: headers.filter((h) => !/^date:/i.test(h)), body: a.body });
  }
  c.close();
  writeFileSync(join(out, `answers-${label}.json`), JSON.stringify([...answers].map(([path, a]) => ({ path, status: a.status, headers: a.headers, bytes: a.body.length, sha256: createHash("sha256").update(a.body).digest("hex") })), null, 1));
  return answers;
}
const WEAK = /^etag: W\/"[^"]*"$/i;
const masked = new Set();
/** Why two askings differ, or null. With `mask`, a weak ETag that differs is masked at its path (between two starts of the base) or already masked (base against head). */
function differ(a, b, how) {
  for (const { path } of PATHS) {
    const x = a.get(path), y = b.get(path);
    if (x.status !== y.status) return `${path}: status lines ${JSON.stringify(x.status)} and ${JSON.stringify(y.status)}`;
    if (!x.body.equals(y.body)) return `${path}: bodies differ (${x.body.length} and ${y.body.length} bytes)`;
    if (x.headers.length !== y.headers.length) return `${path}: ${x.headers.length} and ${y.headers.length} header lines`;
    for (let i = 0; i < x.headers.length; i++) {
      if (x.headers[i] === y.headers[i]) continue;
      const weak = WEAK.test(x.headers[i]) && WEAK.test(y.headers[i]);
      if (how === "starts" && weak) { masked.add(path); continue; }
      if (how === "sides" && weak && masked.has(path)) continue;
      return `${path}: header lines ${JSON.stringify(x.headers[i])} and ${JSON.stringify(y.headers[i])}`;
    }
  }
  return null;
}
const base = [];
for (const s of [1, 2]) {
  const ms = await start("base");
  const a = await asking(`base-start${s}-a`), b = await asking(`base-start${s}-b`);
  docker("rm", "-f", "fsw-corten");
  const why = differ(a, b, "requests");
  if (why) stop(`two askings of one start of the base differ: ${why}. The plan declares no mask for it: a new plan`);
  say(`3. base, start ${s} (answered after ${ms} ms): ${PATHS.length} answers, every status 200; asked twice, the same status line, headers but Date and body each time`);
  base.push(a);
}
{
  const why = differ(base[0], base[1], "starts");
  if (why) stop(`two starts of the base differ: ${why}. The plan masks only a weak ETag's value: a new plan`);
  const by = (t) => [...masked].filter((p) => p.startsWith("/api/") === (t === "json")).length;
  say(`3. the base's two starts: the same status line, headers but Date and body at every path${masked.size ? `, but for a weak ETag's value at ${masked.size} paths (${by("page")} of the page's, ${by("json")} of the JSON's), which is masked there` : "; no header value differs, so nothing is masked"}`);
  writeFileSync(join(out, "masked.json"), JSON.stringify([...masked]));
  const one = (p) => base[0].get(p);
  for (const t of ["page", "json"]) {
    const p = `${sent[t].prefix}1`, a = one(p);
    writeFileSync(join(out, `sample-${t}.headers`), [a.status, ...a.headers].join("\n") + "\n");
    writeFileSync(join(out, `sample-${t}.body`), a.body);
    const sizes = PATHS.filter((x) => x.target === t).map((x) => one(x.path).body.length);
    say(`3. ${t}: ${p} answers ${JSON.stringify(a.status)} with ${a.headers.length} header lines but Date; bodies from ${Math.min(...sizes)} to ${Math.max(...sizes)} bytes`);
  }
}
{
  const ms = await start("head");
  const h = await asking("head-start1-a");
  docker("rm", "-f", "fsw-corten");
  const why = differ(base[0], h, "sides");
  if (why) stop(`the answers differ between the base and the head: ${why}`);
  say(`3. ${DRY ? "the base's image standing in for the head" : "head"} (answered after ${ms} ms): ${PATHS.length} answers, every status 200, each the base's: status line, headers but Date${masked.size ? " and the masked ETag values" : ""}, and body byte for byte`);
}
writeFileSync(join(out, "images.txt"), `base ${idOf(image("base"))}\nhead ${idOf(image("head"))}\n`);
say(DRY ? "VERIFY-OK (DRYRUN)" : "VERIFY-OK");
