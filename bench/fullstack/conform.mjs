// Conformance: what each bench app does around its page and JSON, as written, observed rather than
// claimed (bench/fullstack/README.md, "Feature matrix"). parity.mjs, look.mjs and check-app.mjs
// check that the apps send the same output; this checks the work around it, so a table never
// compares an app that sends security headers, checks the host and keeps a deadline with one that
// does none of it without saying so. For each app it starts the app twice, from its cb-* image:
// 1. On an item API that serves the fixture (fsw-items, item-api/server.mjs): the headers on a page and on the JSON, an ETag and a
//    conditional GET, compression when asked, the error formats of a 404 and a 405, HEAD, an
//    unknown Host, a 64 KiB request header, a liveness and a readiness endpoint (the first of
//    conformance.mjs's paths that answers 200), and the page's price-alert form (found in the
//    page, posted where and as the page's form posts): from the page itself at normal size (the
//    control: a refusal below counts only when the app took this one), from another site (no
//    cookies, its Origin, its hidden fields as given), and from the page itself with a 3 MiB
//    first field, then the page again (a refusal counts only if the app still serves); the page and
//    the JSON of an item the item API answers as `null` (a read that fails: its 5xx and format);
//    and how many lines the app logs for each of 20 JSON requests. The page
//    and the posts are sent as a browser at the bench's port sends them (Host localhost:<port>, a
//    navigation's Accept), and the page's own posts carry its cookies and its Origin
//    (http://localhost:<port>, which SvelteKit's app is configured to expect). A form
//    its framework's script sends instead of the browser (Livewire, LiveView) is not probed.
// 2. On an item API that accepts connections and never answers (fsw-stall): how long a page (for
//    an app without pages, the JSON) takes to answer and with what, and what the readiness
//    endpoint says while the items cannot be read.
// Every probe is a plain HTTP/1.1 request (node:http, no decompression) on its own connection,
// given up after a total time, sent by conform-probe.mjs from a container on the bench network
// (fsw-probe) to fsw-<app>:8080 with Host: localhost (the page and its form posts: localhost:<port>). Nothing goes through a published port: on
// 2026-11-04 Docker Desktop's port proxy lost answers sent while a request's body was still
// arriving (Corten's 413 to a 3 MiB form, intermittently), and its WSL relay held the usual
// ports of removed containers without forwarding them. It replaces the fsw-<app> containers it
// starts and removes them, fsw-items, fsw-probe and fsw-stall, however it ends. Every app reads
// its items from fsw-items rather than from memory: Laravel cannot hold the fixture in PHP's
// default memory_limit (caveat 7), and the HTTP source is the same for every app.
// Usage: node conform.mjs [apps=all] [out=<round>]
// Writes results/<out>/conformance.json (each app's probes and row, the images and the commit)
// when given out, and prints the matrix. run-all.mjs runs it as a round's conform step, so a
// round's matrix is taken from the same images as its tables (the commit they were built from is
// results/<out>/commit.txt when the round has one, or CONFORM_IMAGES_FROM).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allApps as all, network, runArgs } from "./apps.mjs";
import { brokenItem, features, format, formBody, formOf, livePaths, logLinesOf, readyPaths, rowOf } from "./conformance.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [appsArg, out] = process.argv.slice(2);
const names = appsArg && appsArg !== "all" ? appsArg.split(",") : Object.keys(all);
for (const n of names) if (!(n in all)) throw new Error("unknown app " + n);
const docker = (/** @type {string[]} */ ...args) => spawnSync("docker", args, { encoding: "utf8" });
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One request from fsw-probe to the app's container, given up after timeoutMs in all.
 * @param {string} name the app
 * @param {{ method?: string, path: string, headers?: Record<string, string>, body?: string, timeoutMs?: number, keepBody?: boolean }} r
 * @returns {import("./conformance.mjs").Probe}
 */
const probe = (name, { method = "GET", path, headers = {}, body, timeoutMs = 10_000, keepBody = false }) => {
  const input = JSON.stringify({ host: "fsw-" + name, port: 8080, method, path, headers: { host: "localhost", ...headers }, body, timeoutMs, keepBody });
  const run = spawnSync("docker", ["exec", "-i", "fsw-probe", "node", "/b/conform-probe.mjs"], { input, encoding: "utf8", timeout: timeoutMs + 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) return { error: "probe failed: " + (run.stderr || run.error?.message || "").trim().slice(0, 200), ms: 0 };
  /** @type {any} */
  let a;
  try {
    a = JSON.parse(run.stdout);
  } catch {
    return { error: "probe answered no JSON: " + run.stdout.slice(0, 200), ms: 0 };
  }
  return a.body === undefined ? a : { ...a, body: Buffer.from(a.body, "base64") };
};

/** Waits until the app answers anything at all on a path that needs no items, up to two minutes. */
const up = async (/** @type {string} */ name) => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (probe(name, { path: "/conform-missing-page", timeoutMs: 2000 }).status) return true;
    await sleep(250);
  }
  return false;
};

/**
 * Starts the app's container, unpublished (fsw-probe reaches it on the network), reading items
 * from fsw-items, or from fsw-stall for the stall run. Returns the error, if any.
 */
const start = (/** @type {string} */ name, /** @type {"items" | "stall"} */ mode) => {
  docker("rm", "-f", "fsw-" + name);
  const args = runArgs(name, all[/** @type {keyof typeof all} */ (name)], "api", join(here, "fixtures"));
  const publish = args.indexOf("-p");
  if (publish < 0) throw new Error("runArgs no longer publishes a port");
  args.splice(publish, 2);
  const i = args.findIndex((a) => a.startsWith("API_BASE="));
  if (i < 0) throw new Error("runArgs no longer sets API_BASE");
  args[i] = "API_BASE=http://fsw-" + mode + ":8080";
  const run = docker(...args);
  return run.status === 0 ? null : run.stderr.trim();
};

/** The first path that answers 200, probed as stored. */
const firstOk = (/** @type {string} */ name, /** @type {string[]} */ paths) => {
  for (const path of paths) {
    const r = probe(name, { path });
    if (r.status === 200) return { ...r, path };
  }
  return null;
};

/** The lines the app's container has logged so far, stdout and stderr, or null when unreadable. */
const logLines = (/** @type {string} */ name) => {
  const run = spawnSync("docker", ["logs", "fsw-" + name], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return run.status === 0 ? (run.stdout + run.stderr).split("\n").filter((l) => l.trim()).length : null;
};

/** Cookies a browser would send back, from an answer's Set-Cookie. */
const cookiesOf = (/** @type {import("./conformance.mjs").Probe | null} */ p) =>
  [p?.headers?.["set-cookie"] ?? []].flat().map((c) => String(c).split(";")[0]).join("; ");

const started = new Set(["stall", "items", "probe"]);
process.on("exit", () => { for (const n of started) docker("rm", "-f", "fsw-" + n); });
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.on(/** @type {NodeJS.Signals} */ (signal), () => process.exit(/** @type {number} */ (code)));
docker("network", "create", network);
docker("rm", "-f", "fsw-stall");
// Accepts every connection and never writes a byte: an item API that hangs.
const stall = docker("run", "-d", "--name", "fsw-stall", "--network", network, "node:24-alpine", "node", "-e", "require('net').createServer(() => {}).listen(8080)");
if (stall.status !== 0) throw new Error("fsw-stall: " + stall.stderr);
docker("rm", "-f", "fsw-items");
// The fixture's items and one more, `brokenItem`, which the item API answers as `null`: a read
// every app fails to make an item of, so its answer shows the app's error format for a 5xx.
const withBroken = `const f = require("fs"); const items = JSON.parse(f.readFileSync("/b/fixtures/items.json", "utf8")); items[${JSON.stringify(brokenItem)}] = null; f.writeFileSync("/tmp/items.json", JSON.stringify(items));`;
const items = docker("run", "-d", "--name", "fsw-items", "--network", network, "-v", here + ":/b:ro", "node:24-bookworm-slim", "sh", "-c", 'node -e "$0" && exec node /b/item-api/server.mjs /tmp/items.json', withBroken);
if (items.status !== 0) throw new Error("fsw-items: " + items.stderr);
docker("rm", "-f", "fsw-probe");
const prober = docker("run", "-d", "--name", "fsw-probe", "--network", network, "-v", here + ":/b:ro", "node:24-alpine", "sleep", "infinity");
if (prober.status !== 0) throw new Error("fsw-probe: " + prober.stderr);

/** Drops the page bodies before a probe is stored. */
const stored = (/** @type {Record<string, any>} */ probes) => Object.fromEntries(Object.entries(probes).map(([k, v]) => [k, v && typeof v === "object" && "ms" in v ? (({ body, ...rest }) => rest)(v) : v]));

/** @type {Record<string, any>} */
const results = {};
for (const name of names) {
  const app = all[/** @type {keyof typeof all} */ (name)];
  const pages = app.pages !== false;
  started.add(name);
  const failed = start(name, "items");
  if (failed || !(await up(name))) {
    results[name] = { error: failed ?? "did not answer in 120 s" };
    console.error(name + ": " + results[name].error);
    docker("rm", "-f", "fsw-" + name);
    started.delete(name);
    continue;
  }
  // Let a JIT or a lazy first route settle, so no probe reads a cold start as behavior.
  for (const path of [pages ? "/items/item_5" : null, "/api/items/item_5"].filter(Boolean)) for (let i = 0; i < 3; i++) probe(name, { path: /** @type {string} */ (path), timeoutMs: 30_000 });
  // A browser's navigation: the Accept it sends, and the Host at the bench's port (the page whose
  // cookies and form are used is read at the same address the form is then posted to).
  const host = "localhost:" + app.port;
  const navigate = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
  /** @type {Record<string, any>} */
  const o = { pages };
  o.page = pages ? probe(name, { path: "/items/item_5", headers: { ...navigate, host }, keepBody: true }) : null;
  o.pageBr = pages ? probe(name, { path: "/items/item_5", headers: { "accept-encoding": "br, gzip" } }) : null;
  // Corten tags only a compressed page (the bytes a 304 saves), so the tag is read from that answer first.
  const etag = o.pageBr?.headers?.etag ?? o.page?.headers?.etag;
  o.pageAgain = pages && etag ? probe(name, { path: "/items/item_5", headers: { "accept-encoding": "br, gzip", "if-none-match": String(etag) } }) : null;
  o.json = probe(name, { path: "/api/items/item_5" });
  o.jsonBr = probe(name, { path: "/api/items/item_5", headers: { "accept-encoding": "br, gzip" } });
  o.jsonGzip = probe(name, { path: "/api/items/item_5", headers: { "accept-encoding": "gzip" } });
  o.head = probe(name, { method: "HEAD", path: "/api/items/item_5" });
  o.json404 = probe(name, { path: "/api/items/does-not-exist" });
  o.json405 = probe(name, { method: "DELETE", path: "/api/items/item_5" });
  o.page404 = pages ? probe(name, { path: "/items/does-not-exist" }) : null;
  o.page500 = pages ? probe(name, { path: "/items/" + brokenItem, headers: navigate, timeoutMs: 45_000 }) : null;
  o.json500 = probe(name, { path: "/api/items/" + brokenItem, timeoutMs: 45_000 });
  o.badHost = probe(name, { path: "/api/items/item_5", headers: { host: "attacker.example" } });
  o.bigHead = probe(name, { path: "/api/items/item_5", headers: { "x-padding": "x".repeat(64 * 1024) } });
  if (pages) {
    const form = o.page?.body ? formOf(o.page.body.toString("utf8"), "/items/item_5") : null;
    if (!o.page?.status) o.form = "n/a: the page did not answer";
    else if (!form) o.form = "n/a: no form that posts";
    else if ("script" in form) o.form = "n/a: " + form.script + " (sent by its script)";
    else {
      o.formPath = form.path;
      const normal = formBody(form);
      const cookie = cookiesOf(o.page);
      const own = { ...navigate, host, origin: "http://" + host, "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", ...(cookie ? { cookie } : {}) };
      o.ownPost = probe(name, { method: "POST", path: form.path, headers: { "content-type": normal.type, ...own }, body: normal.body });
      o.crossSite = probe(name, { method: "POST", path: form.path, headers: { "content-type": normal.type, ...navigate, host, origin: "https://attacker.example", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }, body: normal.body });
      const big = formBody(form, "a".repeat(3 * 1024 * 1024));
      o.bigBody = probe(name, { method: "POST", path: form.path, headers: { "content-type": big.type, ...own }, body: big.body, timeoutMs: 30_000 });
      // Still serving after it: a refusal, not a crash.
      o.afterBig = probe(name, { path: "/items/item_5", headers: { ...navigate, host } });
    }
  }
  // What it logs for a request: the lines its container wrote over 20 JSON requests, after the
  // probes above have settled (a line written late is counted on the next app's run, not here).
  await sleep(1000);
  const linesBefore = logLines(name);
  for (let i = 0; i < 20; i++) probe(name, { path: "/api/items/item_5" });
  await sleep(1000);
  o.logLines = logLinesOf(linesBefore, logLines(name), 20);
  o.live = firstOk(name, livePaths);
  const ready = firstOk(name, readyPaths);
  o.readyPath = ready?.path ?? null;
  docker("rm", "-f", "fsw-" + name);
  const stallFailed = start(name, "stall");
  const stalledUp = !stallFailed && (await up(name));
  const notStarted = { didNotStart: true, error: stallFailed ?? "no answer in 120 s", ms: 0 };
  o.slow = stalledUp ? probe(name, { path: pages ? "/items/item_5" : "/api/items/item_5", timeoutMs: 45_000 }) : notStarted;
  o.readyDown = !o.readyPath ? null : stalledUp ? probe(name, { path: o.readyPath, timeoutMs: 45_000 }) : notStarted;
  docker("rm", "-f", "fsw-" + name);
  started.delete(name);
  const probes = stored(o);
  results[name] = { image: docker("image", "inspect", "--format", "{{.Id}}", app.image).stdout.trim(), probes, row: rowOf(probes) };
  console.error(name + " done");
}

const header = ["app", ...features.map((f) => f.label)];
const lines = ["| " + header.join(" | ") + " |", "|" + header.map(() => "---").join("|") + "|"];
for (const [name, r] of Object.entries(results)) lines.push("| " + [name, ...features.map((f) => String(r.row?.[f.key] ?? r.error ?? "?"))].join(" | ") + " |");
console.log(lines.join("\n"));
if (out) {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: here, encoding: "utf8" }).stdout.trim();
  // Whether bench/fullstack's code differed from that commit (results/ aside), so a round is never
  // credited to a commit that could not have produced it.
  const dirty = spawnSync("git", ["status", "--porcelain", "--", ".", ":!results"], { cwd: here, encoding: "utf8" }).stdout.trim() !== "";
  mkdirSync(join(here, "results", out), { recursive: true });
  // The commit the images were built from, when the caller says (round.mjs and build.mjs do not tag it on the image).
  const commitFile = join(here, "results", out, "commit.txt");
  const imagesFrom = process.env.CONFORM_IMAGES_FROM ?? (existsSync(commitFile) ? readFileSync(commitFile, "utf8").trim() : null);
  writeFileSync(join(here, "results", out, "conformance.json"), JSON.stringify({ format, commit, dirty, imagesFrom, date: new Date().toISOString(), apps: names, results }, null, 2) + "\n");
}
