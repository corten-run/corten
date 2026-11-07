// Server rendering under load, one app at a time on one CPU and 1 GiB.
// Usage: node run-ssr.mjs <round> <api|fixture> [fixedRate=150] [apps=all] [page|json] [passes=1]
//   api:     every request fetches the item from the item API, like production.
//   fixture: items come from memory (fixtures/items.json), so only the web framework is measured.
//   page:    the item page (default); json: the same item from the app's GET /api/items/{id}.
//            JSON results are named <app>-json-<phase>.
//   passes:  each app's phases this many times, the apps taking turns (every app's first pass,
//            then every app's second), so a slow drift of the machine falls on every app alike.
//            Pass 1's files are named as a one-pass round's; pass 2 on add -p<pass> (passes.mjs).
// Item pages from the item API end with the mixed phase (#813, mixed-load.js): the fixed rate as a
// mix of pages, JSON, the home page and the page's form posted, some items answered late.
import { spawn, spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allApps, apiContainer, apps as catalog, k6Net, k6User, loadCores, loadCpusFor, network, runArgs, tier, tierApps, viaEdge } from "./apps.mjs";
import { edgeBase, edgeContainer, edgeCores, edgeImage, reachApp, startEdge, stopEdge } from "./edge.mjs";
import { roundNameError } from "./round.mjs";
import { cpuUsec } from "./cpu-time.mjs";
import { passFile, passesOf } from "./passes.mjs";
import { formEnv, mixedSeconds, slowShare, tailSeconds } from "./mixed.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [round = "r1", source = "api", fixedRate = "150", appsArg = Object.keys(catalog).join(","), target = "page", passesArg] = process.argv.slice(2);
const passes = passesOf(passesArg);
// The matched tier's numbers never go into an r<n> round, nor the defaults' into an m<n> one.
if (roundNameError(round, tier)) throw new Error(/** @type {string} */ (roundNameError(round, tier)));
const results = join(here, "results", round, source);
mkdirSync(results, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });
const log = (msg) => console.log(new Date().toISOString(), msg);

/**
 * Runs one k6 phase; the CPU time k6 used, in microseconds, or null. k6 reads it from its own
 * cgroup as it ends, so a phase whose app is not busy can say whether k6 was (ssr.mjs).
 * @param {string} name @param {string} base @param {Record<string, string>} envs
 * @param {string} [script] the k6 script: ssr-load.js, or mixed-load.js for the mixed phase
 */
function k6(name, base, envs, script = "ssr-load.js") {
  const args = ["run", "--rm", "--network", network, ...k6Net, ...loadCpusFor(source), ...k6User, "-v", `${here}:/bench`, "-e", `BASE=${base}`, "-e", `TARGET=${target}`];
  for (const [k, v] of Object.entries(envs)) args.push("-e", `${k}=${v}`);
  const run = `k6 run --quiet --summary-export /bench/results/${round}/${source}/${name}.json /bench/${script}; s=$?; echo "k6 $(grep usage_usec /sys/fs/cgroup/cpu.stat)"; exit $s`;
  args.push("--entrypoint", "sh", "grafana/k6:latest", "-c", run);
  const r = docker(...args);
  writeFileSync(join(results, `${name}.log`), (r.stdout ?? "") + (r.stderr ?? ""));
  // One failed phase is reported and the run goes on to the next, so it does not cost the apps after it.
  if (!existsSync(join(results, `${name}.json`))) log(`k6 wrote no summary for ${name}; see ${name}.log`);
  const used = /^k6 usage_usec (\d+)$/m.exec(r.stdout ?? "");
  return used ? Number(used[1]) : null;
}

/**
 * A post's status, or why it got none: over TLS to the edge, whose certificate is made for the run.
 * @param {string} url @param {Record<string, string>} headers @param {string} body
 * @returns {Promise<number | string>}
 */
const postStatus = (url, headers, body) => new Promise((done) => {
  const send = url.startsWith("https:") ? httpsRequest : httpRequest;
  const req = send(url, { method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, rejectUnauthorized: false, timeout: 30_000 }, (res) => {
    res.resume();
    done(res.statusCode ?? "no status");
  });
  req.on("timeout", () => req.destroy(new Error("no answer in 30 s")));
  req.on("error", (err) => done(String(err)));
  req.end(body);
});

/**
 * The mixed phase's env (mixed-load.js), from the item page read just before it, directly: the
 * form and its cookies, and the rate. One post is sent first as k6 sends them (through the edge
 * in the matched tier) and its status kept in `-form.json` beside the form, so a post the harness
 * built wrong is seen before its answers are read as the app's. Directly, k6 names the app as
 * conform.mjs's own post does; through the edge, which names it by its container, the post's
 * origin is that name's.
 * @param {string} name @param {{ port: number }} app @param {string} file the phase's files' name
 */
async function mixedEnv(name, app, file) {
  const at = `http://localhost:${app.port}`;
  let html = null;
  let cookie = "";
  try {
    const r = await fetch(`${at}/items/item_1`, { headers: { accept: "text/html" } });
    if (r.ok) html = await r.text();
    cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  } catch {}
  const own = viaEdge ? { origin: `http://fsw-${name}:8080` } : { host: `localhost:${app.port}`, origin: at };
  const form = formEnv(html, cookie, own);
  /** @type {Record<string, unknown>} */
  let record = { ...form };
  if ("env" in form) {
    const e = form.env;
    // The edge as the host reaches it, or the app directly, named as k6 names it (FORM_HOST).
    const to = viaEdge ? edgeBase(app, "outside") : at;
    const headers = { "content-type": e.FORM_TYPE, accept: "text/html", origin: e.ORIGIN, "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", ...(e.FORM_COOKIE ? { cookie: e.FORM_COOKIE } : {}), ...(e.FORM_HOST ? { host: e.FORM_HOST } : {}) };
    record = { path: e.FORM_PATH, type: e.FORM_TYPE, check: await postStatus(`${to}${e.FORM_PATH}`, headers, e.FORM_BODY) };
  }
  writeFileSync(join(results, `${file}-form.json`), JSON.stringify(record, null, 1));
  return { RATE: fixedRate, DURATION: `${mixedSeconds}s`, TAIL: `${tailSeconds}s`, SLOW_SHARE: String(slowShare), ...("env" in form ? form.env : {}) };
}

const names = appsArg.split(",");
for (const name of names) if (!catalog[name]) throw new Error(`unknown app ${name}`);
// The passes asked for, which summarize.mjs reads each one of (a pass with no files shows as
// missing). An earlier attempt's files for these apps go first, so a pass this one does not reach
// is missing rather than another boot's.
// The count is the folder's, every app's: a run of some apps with another count (a rerun by hand
// that forgot it) would change what every other app's numbers are read from, so it stops.
const earlierPasses = existsSync(join(results, "passes.json")) ? JSON.parse(readFileSync(join(results, "passes.json"), "utf8")).passes : null;
if (earlierPasses !== null && earlierPasses !== passes) throw new Error(`${results} was run with ${earlierPasses} passes, not ${passes}: pass ${earlierPasses} as the last argument, or start the round again`);
writeFileSync(join(results, "passes.json"), JSON.stringify({ passes }));
// The matched tier's apps are reached through the edge, started once for every app of the tier.
if (viaEdge) {
  const failed = await startEdge(Object.entries(tierApps), network);
  if (failed) throw new Error(failed);
  process.on("exit", stopEdge);
  // What the edge had, so the summary can say which phases it may have bounded (ssr.mjs).
  writeFileSync(join(results, "edge.json"), JSON.stringify({ image: edgeImage, cores: edgeCores() }));
}
const earlier = new RegExp(`^(${names.join("|")})${target === "json" ? "-json" : ""}-(startup|warmup|fixed|sat64|sat256|mixed)(-p\\d+)?(-stats|-cpu|-form)?\\.(json|log)$`);
for (const file of readdirSync(results)) if (earlier.test(file)) rmSync(join(results, file));
for (let pass = 1; pass <= passes; pass += 1) for (const name of names) {
  const app = catalog[name];
  // A JSON-only app has no page to measure.
  if (target === "page" && app.pages === false) continue;
  const file = target === "json" ? `${name}-json` : name;
  /** A file of this pass: pass 1's as a one-pass round names it. @param {string} what */
  const named = (what) => passFile(`${file}-${what}`, pass);
  if (passes > 1) log(`pass ${pass} of ${passes}`);
  // Every app's, not only those BENCH_APPS names: a container left from another run shares the CPUs.
  for (const other of Object.keys(allApps)) docker("rm", "-f", `fsw-${other}`);
  await sleep(3000);
  const started = Date.now();
  const run = docker(...runArgs(name, app, source, join(here, "fixtures")));
  if (run.status !== 0) throw new Error(`${name}: ${run.stderr}`);
  const path = target === "json" ? "/api/items/item_1" : "/items/item_1";
  let ready = null;
  for (let i = 0; i < 2400 && ready === null; i += 1) {
    try {
      const r = await fetch(`http://localhost:${app.port}${path}`);
      if (r.ok) ready = Date.now() - started;
    } catch {}
    if (ready === null) await sleep(25);
  }
  // An app that cannot serve in one CPU and 1 GiB with its usual settings fails the run; it is
  // reported, not tuned, and the next app goes on.
  if (ready === null) {
    const logs = docker("logs", "--tail", "20", `fsw-${name}`);
    const failed = `never answered ${path} within a minute`;
    writeFileSync(join(results, `${named("startup")}.json`), JSON.stringify({ failed, logs: (logs.stdout + logs.stderr).trim().split("\n") }, null, 1));
    log(`${file} ${source} failed: ${failed}`);
    docker("rm", "-f", `fsw-${name}`);
    continue;
  }
  // Through the edge, the app's first request is the edge's too: it must reach the app first.
  const unreachable = viaEdge ? await reachApp(app, path) : null;
  if (unreachable) {
    writeFileSync(join(results, `${named("startup")}.json`), JSON.stringify({ failed: unreachable }, null, 1));
    log(`${file} ${source} failed: ${unreachable}`);
    docker("rm", "-f", `fsw-${name}`);
    continue;
  }
  await sleep(5000);
  const idle = docker("stats", "--no-stream", "--format", "{{.MemUsage}}", `fsw-${name}`).stdout.trim();
  writeFileSync(join(results, `${named("startup")}.json`), JSON.stringify({ firstOkMsFromDockerRun: ready, idleMem: idle }, null, 1));
  const base = viaEdge ? edgeBase(app, "inside") : `http://fsw-${name}:8080`;
  log(`${file} ${source} warmup`);
  // 30 s: long enough for the JVM's and .NET's tiered JITs to settle, the same for every app.
  k6(named("warmup"), base, { MODE: "closed", VUS: "32", DURATION: "30s" });
  /** @type {[string, Record<string, string> | (() => Promise<Record<string, string>>), string?, number?][]} */
  const loads = [
    ["fixed", { MODE: "open", RATE: fixedRate, DURATION: "60s" }],
    ["sat64", { MODE: "closed", VUS: "64", DURATION: "60s" }],
    ["sat256", { MODE: "closed", VUS: "256", DURATION: "60s" }],
  ];
  // The mixed phase needs the item API, for the items it answers late, and the item page, for its
  // form; it is sampled until its last late answers are in.
  if (source === "api" && target === "page") loads.push(["mixed", () => mixedEnv(name, app, named("mixed")), "mixed-load.js", mixedSeconds + tailSeconds + 2]);
  for (const [phase, given, script, seconds = 62] of loads) {
    const envs = typeof given === "function" ? await given() : given;
    log(`${file} ${source} ${phase}`);
    const sampled = [`fsw-${name}`, ...(source === "api" ? [apiContainer] : []), ...(viaEdge ? [edgeContainer] : [])];
    // CPU time each container used during the phase, from its cgroup's counter: what requests per
    // CPU-second divides by. Null where the counter could not be read. Read before the sampler
    // starts, since under Docker Desktop a read takes a few seconds.
    const before = sampled.map(cpuUsec);
    const s = spawn("node", [join(here, "sample-stats.mjs"), join(results, `${named(phase)}-stats.json`), String(seconds), ...sampled], { stdio: "ignore", windowsHide: true });
    const k6Usec = k6(named(phase), base, envs, script);
    const after = sampled.map(cpuUsec);
    const counted = Object.fromEntries(sampled.map((c, i) => [c, before[i] !== null && after[i] !== null ? { usec: after[i] - before[i] } : null]));
    // k6's own, beside the containers': what the load generator used, with the cores it had.
    writeFileSync(join(results, `${named(phase)}-cpu.json`), JSON.stringify({ ...counted, k6: k6Usec === null ? null : { usec: k6Usec, cores: loadCores(source) } }, null, 1));
    await new Promise((r) => (s.exitCode !== null ? r() : s.on("exit", r)));
  }
  docker("rm", "-f", `fsw-${name}`);
}
log("done");
