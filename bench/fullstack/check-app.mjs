// Checks one app against the reference before it joins a round: starts both with the fixture
// (items in memory, so the home page is Corten's cards, which a round's item-API source never
// shows), compares the app's pages' visible text and outline (parity.mjs) and how they look
// (look.mjs), the JSON route's body with the reference's, and the 404s. It replaces the running
// fsw-<reference> and fsw-<app> containers (from their cb-* images, so build cb-corten from this
// tree first) and removes those it started when it ends, failed or not, unless given keep. An app
// that serves only the JSON (`pages: false`) is checked on the JSON of every fixture item instead.
// Usage: node check-app.mjs <app> [reference=corten] [keep]
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apps, network, readyPath, runArgs } from "./apps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [name, reference = "corten", keep] = process.argv.slice(2);
const app = apps[name];
if (!app) throw new Error(`unknown app ${name}`);
const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!apps[reference]) throw new Error(`unknown reference ${reference}`);
if (keep !== undefined && keep !== "keep") throw new Error(`the third argument is keep, not ${keep}`);
docker("network", "create", network);
/** The containers this run started; only these are removed. */
const started = [];
// Synchronous, so it runs on every way out: the last check, a thrown error, an app that never
// answers, or Ctrl+C (made an exit below, since a signal ends Node without one).
process.on("exit", () => { if (!keep) for (const n of started) docker("rm", "-f", `fsw-${n}`); });
// (A signal waits while parity.mjs or look.mjs runs, which blocks; Ctrl+C reaches them too.)
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
for (const n of [reference, name]) {
  docker("rm", "-f", `fsw-${n}`);
  const run = docker(...runArgs(n, apps[n], "fixture", join(here, "fixtures")));
  if (run.status !== 0) throw new Error(run.stderr);
  started.push(n);
}
const base = `http://localhost:${app.port}`;
for (const n of [reference, name]) {
  const started = Date.now();
  let ready = false;
  while (!ready && Date.now() - started < 120_000) {
    try { ready = (await fetch(`http://localhost:${apps[n].port}${readyPath(apps[n])}`)).ok; } catch {}
    if (!ready) await sleep(250);
  }
  if (!ready) {
    console.log(docker("logs", "--tail", "40", `fsw-${n}`).stderr);
    throw new Error(`${n} did not answer in 120 s`);
  }
  console.log(`${n} ready after ${Date.now() - started} ms`);
}
const failures = [];
const check = (label, ok, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`); if (!ok) failures.push(label); };
// Key order is not part of the JSON's meaning (Elixir maps, for one, do not keep it).
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const pages = app.pages !== false;
const parity = !pages ? null : spawnSync("node", [join(here, "parity.mjs"), `${reference},${name}`, reference], { encoding: "utf8" });
/** The last lines a child printed, or its error when it printed nothing (it crashed). */
const tail = (/** @type {{ stdout: string, stderr: string }} */ r) => (r.stdout.trim() || r.stderr.trim()).split("\n").slice(-3).join(" | ").slice(0, 900);
if (parity) check("pages have the reference's visible text and outline", parity.status === 0, tail(parity));
const look = !pages ? null : spawnSync("node", [join(here, "look.mjs"), `${reference},${name}`, reference], { encoding: "utf8" });
// look.mjs's own retries are JSON lines with retry; steady()'s are plain lines starting "retry ".
if (look) {
  const retries = look.stdout.split("\n").filter((l) => /^retry |"retry"/.test(l)).length;
  check("pages look like the reference's", look.status === 0, [retries ? `${retries} ${retries === 1 ? "load" : "loads"} needed a second try` : "", tail(look)].filter(Boolean).join(" | "));
}
const showAll = !pages ? null : spawnSync("node", [join(here, "show-all.mjs"), name], { encoding: "utf8" });
if (showAll) check('"Show all" shows every offer, with a script and without', showAll.status === 0, tail(showAll));
const refBase = `http://localhost:${apps[reference].port}`;
for (const id of ["item_5", "item_17", "item_12345"]) {
  const [a, b] = await Promise.all([fetch(`${refBase}/api/items/${id}`), fetch(`${base}/api/items/${id}`)]);
  const [ja, jb] = [await a.json(), await b.json()];
  const same = JSON.stringify(canonical(ja)) === JSON.stringify(canonical(jb));
  check(`JSON for ${id} matches`, b.ok && (b.headers.get("content-type") ?? "").includes("application/json") && same, `${b.status} ${b.headers.get("content-type")}, ${(await (await fetch(`${base}/api/items/${id}`)).arrayBuffer()).byteLength} bytes`);
}
if (!pages) {
  // Every fixture item, since the JSON is all such an app serves.
  const ids = Object.keys(JSON.parse(readFileSync(join(here, "fixtures", "items.json"), "utf8")));
  // Byte for byte, so escaping and number formatting count, except that .NET writes a whole
  // number in a double as 9 where Corten writes 9.0 (the same value).
  const whole = (/** @type {string} */ text) => text.replace(/("price_value":-?\d+)\.0([,}])/g, "$1$2");
  const differ = [];
  for (const id of ids) {
    const [a, b] = await Promise.all([fetch(`${refBase}/api/items/${id}`), fetch(`${base}/api/items/${id}`)]);
    if (a.status !== b.status || whole(await a.text()) !== await b.text()) differ.push(id);
  }
  check(`JSON for all ${ids.length} fixture items has the reference's bytes (whole numbers aside)`, differ.length === 0, differ.slice(0, 5).join(", "));
  const missing = await fetch(`${base}/api/items/does-not-exist`);
  check("unknown item JSON is a problem+json 404", missing.status === 404 && (missing.headers.get("content-type") ?? "").startsWith("application/problem+json"));
} else {
  check("unknown item page is 404", (await fetch(`${base}/items/does-not-exist`)).status === 404);
  check("unknown item JSON is 404", (await fetch(`${base}/api/items/does-not-exist`)).status === 404);
  check("home page links item_5", (await (await fetch(`${base}/`)).text()).includes('href="/items/item_5"'));
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
