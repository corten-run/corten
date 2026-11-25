// Runs alert-probe.mjs against one marketplace image in both sources, laid out like the gate
// (run.mjs): an owned network and upstream, the app on one CPU, and the probe in the checker's
// Playwright image sharing only the app's network namespace.
// usage: node alert-probe-run.mjs IMAGE [ITERATIONS] [RESULTS_DIR] [--budget SECONDS] [--deadline SECONDS] [--label KEY=VALUE ...]
// --budget bounds each source's probe: it stops between cases once spent and still writes its diagnostics.
// --deadline bounds the whole run, like the CI step's timeout around it: no new work starts in its
// last `teardownReserve` seconds, which are kept for the app logs, removal and cleanup.json.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nodeImage } from "./raw-contract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
export const ownerKey = "run.corten.marketplace.alert-probe";
// Each create also carries a label of its own, so a create whose acknowledgement never came back can
// be found as itself however late Docker makes it.
export const attemptKey = `${ownerKey}.create`;
const commandTimeout = 30_000;
// The last part of the run deadline, in seconds, in which no new work starts.
export const teardownReserve = 120;
// How long teardown looks for what an unacknowledged create made before calling its cleanup unconfirmed.
export const reconcileWindow = 10_000;
// The end of that window, in ms, kept for its last lookup.
const lastLook = 250;
// The probe's own budget leaves this long for its browser, its result and the container's exit.
const attachMargin = 120;

// Every docker command has a deadline. A timed-out client may leave its container running; teardown
// removes that container by ID, so the client is all the deadline needs to stop.
// combined: return stderr after stdout, for a container log, which Docker splits across both.
export const docker = async (args, { timeout = commandTimeout, combined = false } = {}) => {
  const run = spawnSync("docker", args, { encoding: "utf8", timeout, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 64 * 2 ** 20 });
  const what = `docker ${args.slice(0, 2).join(" ")}`;
  if (run.error) throw new Error(`${what}: ${run.error.code === "ETIMEDOUT" ? `timeout after ${timeout} ms` : run.error.message}`);
  if (run.status !== 0) throw Object.assign(new Error(`${what}: exit ${run.status}\n${(run.stderr || run.stdout).slice(-4096)}`), { status: run.status });
  return combined ? run.stdout + run.stderr : run.stdout.trim();
};
const ids = (text) => text.split("\n").map((line) => line.trim()).filter(Boolean);
const brief = (error) => String(error?.message ?? error).slice(0, 2048);
// Docker's JSON answer, or a fixed error that says what was expected and nothing of what came back:
// a malformed answer is untrusted and must not reach a saved record (a JSON.parse message quotes it).
export function dockerJson(text, what) {
  try { return JSON.parse(text); } catch { throw new Error(`${what} returned output that is not JSON`); }
}
// A check on an answer from Docker that fails with only its own message: strict assert.equal would
// append Docker's answer (`'...' !== '<id>'`), which the record's bounded message would then keep.
const same = (actual, expected, message) => { if (actual !== expected) throw new Error(message); };

// Labels from the caller go on every resource. Docker keeps a key's last value, so a caller label
// with the owner key or a key in its dot-delimited namespace (`${ownerKey}.*`, which holds the
// attempt key) would take the resource out of this run's ownership checks and label scans; it is
// refused before any Docker command. Other keys, even with the same literal prefix, are ordinary.
// `key` is the owner key of the resources they go on (steady-run.mjs passes its own).
export function callerLabels(labels, key = ownerKey) {
  assert.ok(Array.isArray(labels) && labels.length % 2 === 0, "labels are --label KEY=VALUE pairs");
  for (let i = 0; i < labels.length; i += 2) {
    const label = /^([\w.-]+)=[\w.:/-]*$/.exec(labels[i + 1] ?? "")?.[1];
    assert.ok(labels[i] === "--label" && label, `labels are --label KEY=VALUE pairs, not ${labels[i]} ${labels[i + 1]}`);
    assert.ok(label !== key && !label.startsWith(`${key}.`), `--label ${label} is reserved for the ${key === ownerKey ? "probe's " : ""}ownership labels`);
  }
  return labels;
}

// One deadline for the whole run, in seconds, like the step timeout around it. Work may start only
// until `reserve` seconds before the end; the rest is for the app logs, removal and the receipt.
export function runClock({ total = Infinity, reserve = teardownReserve, now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  assert.ok(total === Infinity || (Number.isFinite(total) && total > reserve), `the run deadline must exceed its ${reserve} s cleanup reserve`);
  const end = now() + total * 1000;
  return { now, sleep, end, work: () => end - reserve * 1000 - now(), cleanup: () => end - now() };
}

// The owned-resource pattern of bench/catalog/run.mjs and bench/marketplace/run.mjs, keyed by ID:
// a resource is registered only by the immutable ID its create returned, and every inspect, log
// read and removal goes through that ID after confirming this run's owner label. A name is never
// proof of ownership. A removal that fails, or an owner that cannot be confirmed, stays pending,
// is retried once at teardown and fails the teardown. A create that did not return an ID was not
// acknowledged, whatever its error: an error from the daemon can follow a create it already made.
// It is looked for at teardown by its attempt label within a bounded window; each ID that lookup
// finds is removed, or confirmed absent, by that ID itself after confirming its owner label, whatever
// the owner-label sweep lists (a listing that leaves a found ID out proves nothing about it), and an
// ID neither removed nor confirmed absent fails the teardown. If nothing appears its cleanup is
// reported unconfirmed and fails the teardown, since Docker may still make it.
// `owner` is the owner label key; each create's attempt label is `${owner}.create`. Cleanup-phase
// commands are sent with `cleanup: true`, so a runner that refuses new work after an interrupt
// (bench/catalog/output.mjs commandRunner) still runs them; the probe's own docker ignores it.
// `describe` turns an error into the text the record keeps; the probe keeps a bounded message, and
// steady-run.mjs keeps only the first line it composes, with the rest in its raw errors.log.
// The record is published (the probe's cleanup.json is a CI artifact, and a pass copies its counts
// into summary.json), so it names an ID only once this run has it from its own create or has
// confirmed the run's owner label on it. An ID a listing returned is untrusted until then: a failure
// on it, a listing's own failure and what survived teardown are recorded as fixed messages and counts.
export function ownedResources({ docker, runId, labels = [], timeout = commandTimeout, clock = runClock(), window = reconcileWindow, owner: key = ownerKey, describe = brief }) {
  const attempt = `${key}.create`;
  const owner = ["--label", `${key}=${runId}`], extra = callerLabels(labels, key);
  const pending = new Map();
  let attempts = 0;
  const record = { runId, ownerLabel: `${key}=${runId}`, created: [], removed: [], recovered: [], unacknowledged: [], failures: [], remaining: null };
  const fail = (resource, error) => record.failures.push({ resource, error: describe(error) });
  // IDs the record may name: returned by this run's own create, or confirmed to carry its owner label.
  const known = new Set();
  // IDs removed, or confirmed absent, by their own ID, whether or not the record may name them.
  const gone = new Set();
  // What each unacknowledged create's own label found, kept here: the record keeps only how many.
  const found = new Map();
  // An error whose message is fixed and names no ID, filter or Docker output (`unnamed`), so it may
  // be recorded against an ID the record does not name.
  const fixed = (message, unnamed = message) => Object.assign(new Error(message), { unnamed });
  // Every command is bounded by its own timeout and by its phase's share of the run deadline: work
  // stops at the reserve, cleanup at the end. A command with no time left is not sent.
  const within = (left, phase = {}) => async (args, options = {}) => {
    const remaining = Math.floor(left());
    if (remaining <= 0) throw Object.assign(new Error(`docker ${args.slice(0, 2).join(" ")}: not sent, the run deadline is spent`), { sent: false });
    return docker(args, { ...options, ...phase, timeout: Math.min(options.timeout ?? timeout, remaining) });
  };
  const work = within(clock.work), clean = within(clock.cleanup, { cleanup: true });
  const confirm = (kind, info, id) => {
    if (info?.Id !== id) throw fixed(`${kind} ${id}: inspect returned a different object`, `${kind}: inspect returned a different object; its ID is not kept`);
    if ((kind === "container" ? info.Config?.Labels : info.Labels)?.[key] !== runId) throw fixed(`refusing unowned ${kind} ${id}`, `refusing unowned ${kind}; its ID is not kept`);
    known.add(id);
    return info;
  };
  const inspect = async (call, id) => confirm("container", dockerJson(await call(["container", "inspect", id]), "docker container inspect")[0], id);
  // A listing is used only if every ID in it is a full 64-hex Docker ID: a short, prefixed or
  // otherwise noncanonical entry could name another object, so the whole listing is refused
  // before anything in it is inspected or removed, and the caller keeps the failure. The refusal
  // names only the kind of listing and how many entries were refused: the entries and the filter
  // are left out, since an answer that is not an ID is untrusted and the record is published. A
  // listing that fails is recorded the same way, by its kind and exit status alone: its client's
  // diagnostic can echo the filter and the daemon's answer (steady-run.mjs keeps it in errors.log).
  const list = async (kind, filter, call = clean) => {
    let text;
    try {
      text = await call(kind === "network" ? ["network", "ls", "--no-trunc", "--filter", filter, "--format", "{{.ID}}"]
        : ["ps", "-a", "--no-trunc", "--filter", filter, "--format", "{{.ID}}"]);
    } catch (error) {
      const why = error?.sent === false ? "was not sent, the run deadline is spent" : `failed${Number.isSafeInteger(error?.status) ? ` (exit ${error.status})` : ""}`;
      throw Object.assign(fixed(`a docker ${kind} listing ${why}; its output is not kept`), error?.sent === false ? { sent: false } : {});
    }
    const listed = ids(text);
    const odd = listed.filter((id) => !/^[0-9a-f]{64}$/.test(id)).length;
    if (odd) throw fixed(`a docker ${kind} listing returned ${odd} ${odd === 1 ? "entry" : "entries"} that ${odd === 1 ? "is" : "are"} not a full container or network ID; nothing in it is inspected or removed`);
    return listed;
  };
  // A create is acknowledged only by the ID it returns. Without one (an error, even from the daemon,
  // a deadline, a lost connection) Docker may have made the resource or may still make it, even
  // after teardown has looked, so the attempt is kept for teardown to account for. Only a create
  // that was never sent is left out.
  async function create(kind, command, name) {
    const label = `${attempt}=${runId}-${++attempts}`;
    let id;
    try { id = await work(command([...owner, "--label", label, ...extra])); } catch (error) {
      if (error.sent !== false) record.unacknowledged.push({ kind, name, label, error: describe(error) });
      throw error;
    }
    if (!/^[0-9a-f]{64}$/.test(id)) {
      // What came back instead is not kept: it is untrusted, and this record is published.
      record.unacknowledged.push({ kind, name, label, error: `docker ${kind} create returned no full ID` });
      assert.fail(`docker ${kind} create ${name} returned no ID`);
    }
    known.add(id); pending.set(id, { kind, id, name }); record.created.push({ kind, id, name, label });
    return id;
  }
  // Whether `id` still exists, from a lookup by that ID (as bench/fullstack/idle-close.mjs present):
  // only an empty answer is absence, and exactly that ID is presence. Any other answer (another
  // full ID, or several) leaves the removal unconfirmed, a teardown failure; the message names the
  // ID that was asked for, already validated, and never the one returned (nor that one, where the
  // record may not name it).
  const present = async (kind, id) => {
    const listed = await list(kind, `id=${id}`);
    if (!listed.length) return false;
    if (listed.length !== 1 || listed[0] !== id) throw fixed(`a docker ${kind} lookup by ID ${id} returned another object; its removal is unconfirmed`, `a docker ${kind} lookup by ID returned another object; its removal is unconfirmed and its ID is not kept`);
    return true;
  };
  // Removes, or confirms absent, the resource with this ID. A failure is recorded against the ID only
  // if the record may name it; otherwise against what kind of resource a listing returned, with the
  // error's fixed message (or, for any other error, a fixed one), and a resource confirmed absent
  // without its owner label confirmed is counted without its ID.
  async function remove(id, { recovered = false } = {}) {
    const entry = pending.get(id) ?? { kind: "container", id, name: null };
    const named = () => known.has(id);
    try {
      if (entry.kind === "network") {
        if (await present("network", id)) {
          confirm("network", dockerJson(await clean(["network", "inspect", id]), "docker network inspect")[0], id);
          same(await clean(["network", "rm", id]), id, `docker network rm did not confirm ${id}`);
        }
      } else if (await present("container", id)) {
        await inspect(clean, id);
        same(await clean(["rm", "-f", "-v", id]), id, `docker rm did not confirm ${id}`);
      }
      pending.delete(id); gone.add(id);
      (recovered ? record.recovered : record.removed).push(named() ? entry : { kind: entry.kind, id: null, name: entry.name });
      return true;
    } catch (error) {
      if (named()) fail(`${entry.kind} ${entry.name ?? "unregistered"} ${id}`, error);
      else record.failures.push({ resource: `${entry.kind} a listing returned, its owner label not confirmed`, error: error?.unnamed ?? `its owner label could not be confirmed, so it was not removed; its ID is not kept` });
      return false;
    }
  }
  return {
    record,
    // Any other command of the run's work phase, bounded like the rest.
    docker: work,
    network: (name) => create("network", (labels) => ["network", "create", ...labels, name], name),
    container: (args, name) => create("container", (labels) => ["create", "--name", name, ...labels, ...args], name),
    inspect: (id) => inspect(work, id),
    async start(id) { await inspect(work, id); same(await work(["start", id]), id, `docker start did not confirm ${id}`); },
    // Start and attach; the container's own exit status is the command's.
    async attach(id, deadline) { await inspect(work, id); return work(["start", "-a", id], { timeout: deadline }); },
    // `options` reach the caller's runner (steady-run.mjs gives a file, or asks for stdout alone).
    async logs(id, options = {}) { await inspect(clean, id); return clean(["logs", id], { combined: true, ...options }); },
    remove,
    has: (id) => pending.has(id),
    async teardown() {
      // Containers before networks: Docker will not remove a network that still has one attached.
      const pendingOf = (kind) => [...pending.values()].filter((entry) => entry.kind === kind).map((entry) => entry.id).reverse();
      for (const id of pendingOf("container")) await remove(id);
      const label = `label=${key}=${runId}`;
      const searched = Math.max(0, Math.min(window, Math.floor(clock.cleanup())));
      // An unacknowledged create may still be under way in the daemon: look for each by its own
      // label until it appears or the window ends, so what it made is removed below with the rest.
      // Each lookup is cut to the time left in the window, whose last quarter second is kept for the
      // final lookup. A failed lookup ends the search and is kept; the owner-label sweep below does
      // not depend on it.
      const end = clock.now() + searched;
      const look = within(() => Math.min(clock.cleanup(), end - clock.now()), { cleanup: true });
      try {
        const missing = () => record.unacknowledged.filter((attempt) => !found.has(attempt));
        const open = () => end - clock.now() >= 1;
        while (missing().length && open()) {
          for (const attempt of missing()) {
            if (!open()) break;
            const listed = await list(attempt.kind, `label=${attempt.label}`, look);
            if (listed.length) { found.set(attempt, listed); attempt.found = listed.length; }
          }
          const last = end - Math.min(lastLook, searched / 2);
          if (!missing().length || clock.now() >= last) break;
          await clock.sleep(Math.min(500, last - clock.now()));
        }
      } catch (error) { fail(`unacknowledged creates labelled ${attempt}`, error); }
      // Each ID an attempt's own label found and not yet removed: removed, or confirmed absent, by
      // that ID (remove looks it up by ID first), never left to the owner-label sweep's listing.
      const settleFound = async (kind) => {
        for (const attempt of record.unacknowledged) if (attempt.kind === kind) for (const id of found.get(attempt) ?? []) {
          if (gone.has(id)) continue;
          if (!pending.has(id)) pending.set(id, { kind, id, name: null });
          await remove(id, { recovered: true });
        }
      };
      try {
        for (const id of await list("container", label)) await remove(id, { recovered: !pending.has(id) });
      } catch (error) { fail(`containers labelled ${record.ownerLabel}`, error); }
      await settleFound("container");
      for (const id of pendingOf("network")) await remove(id);
      try {
        for (const id of await list("network", label)) {
          if (!pending.has(id)) pending.set(id, { kind: "network", id, name: null });
          await remove(id, { recovered: !record.created.some((entry) => entry.id === id) });
        }
      } catch (error) { fail(`networks labelled ${record.ownerLabel}`, error); }
      // As for containers: a failed owner-label listing does not keep a network an attempt's own
      // label found from being removed, or confirmed absent, by its ID.
      await settleFound("network");
      // What survived is counted, not listed: an ID in this listing is not confirmed as the run's.
      try {
        const remaining = { containers: (await list("container", label)).length, networks: (await list("network", label)).length };
        record.remaining = remaining;
        const count = (n, kind) => `${n} ${kind}${n === 1 ? "" : "s"}`;
        if (remaining.containers || remaining.networks) throw new Error(`owned resources survived teardown: ${count(remaining.containers, "container")} and ${count(remaining.networks, "network")}`);
      } catch (error) { fail(`resources labelled ${record.ownerLabel}`, error); }
      // An empty scan does not prove an unacknowledged create will never land; only finding and
      // removing what it made does. Found but not each removed or confirmed absent by its ID: not complete.
      for (const attempt of record.unacknowledged) {
        const ids = found.get(attempt);
        attempt.outcome = !ids ? "unconfirmed" : ids.every((id) => gone.has(id)) ? "removed" : "not removed";
        if (attempt.outcome === "not removed") fail(`${attempt.kind} ${attempt.name} (${attempt.label})`, "what its create made was found by its label but not each removed or confirmed absent by its own ID");
        if (!ids) fail(`${attempt.kind} ${attempt.name} (${attempt.label})`, `its create was not acknowledged and nothing with that label was found in ${searched} ms; Docker may still make it, so its cleanup is unconfirmed`);
      }
      record.complete = record.failures.length === 0;
      return record;
    },
  };
}

async function waitReady(url, timeout = 60_000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline; await new Promise((r) => setTimeout(r, 100))) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); await response.arrayBuffer(); if (response.status === 200) return; } catch {}
  }
  throw new Error(`${url} not ready in ${timeout / 1000}s`);
}

export async function runAlertProbe({ image, iterations = 50, results, budget = 3600, deadline = Infinity, labels = [], runId = `alert-probe-${randomBytes(5).toString("hex")}`,
  docker: run = docker, ready = waitReady, clock = runClock({ total: deadline }), window = reconcileWindow, log = console.log, error: report = console.error }) {
  callerLabels(labels);
  mkdirSync(results, { recursive: true });
  // A run that dies early must not leave an earlier run's files to be read as its own.
  for (const file of ["fixture.json", "api.json", "fixture-app.log", "api-app.log", "cleanup.json"]) rmSync(join(results, file), { force: true });
  const owned = ownedResources({ docker: run, runId, labels, clock, window });
  const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).devDependencies["@playwright/test"];
  const checker = `mcr.microsoft.com/playwright:v${version}-noble`;
  const fixtures = join(here, "fixtures");
  const port = async (id) => (await owned.inspect(id)).NetworkSettings.Ports["8080/tcp"][0].HostPort;
  const readyWithin = (url) => {
    const left = Math.floor(clock.work());
    if (left <= 0) throw new Error(`${url}: not checked, the run deadline is spent`);
    return ready(url, Math.min(60_000, left));
  };
  // The probe's own budget, cut to what the run deadline leaves after its margin; none means no probe.
  const probeBudget = (source) => {
    const seconds = Math.min(budget, Math.floor(clock.work() / 1000) - attachMargin);
    if (seconds < 1) throw new Error(`${source}: not probed, the run deadline leaves no probe budget`);
    return seconds;
  };
  let passed = true, cleanup;
  try {
    try { await owned.docker(["image", "inspect", checker]); } catch { await owned.docker(["pull", checker], { timeout: 10 * 60_000 }); }
    const upstreamName = `${runId}-upstream`;
    // Both attachments use the network's ID, so a network that later takes its name is never joined.
    const network = await owned.network(`${runId}-net`);
    const upstream = await owned.container(["--network", network, "--cpus", "2", "--memory", "512m", "-p", "127.0.0.1::8080",
      "-v", `${join(repo, "bench")}:/bench:ro`, "-v", `${fixtures}:/fixtures:ro`, nodeImage, "node", "/bench/marketplace/upstream.mjs"], upstreamName);
    await owned.start(upstream);
    await readyWithin(`http://127.0.0.1:${await port(upstream)}/health`);
    for (const source of ["fixture", "api"]) {
      const name = `${runId}-${source}`;
      let app, probe;
      try {
        probeBudget(source);
        app = await owned.container(["--network", network, "--cpus", "1", "--memory", "1g", "-p", "127.0.0.1::8080",
          "-v", `${fixtures}:/fixtures:ro`, "-e", `MARKETPLACE_SOURCE=${source}`, "-e", "MARKETPLACE_FIXTURE_PATH=/fixtures/marketplace.json",
          "-e", `API_BASE=http://${upstreamName}:8080`, "-e", "PORT=8080", "-e", `HOSTS=${name},localhost,127.0.0.1`, image], name);
        await owned.start(app);
        await readyWithin(`http://127.0.0.1:${await port(app)}/marketplace/en-US/item_1`);
        const seconds = probeBudget(source);
        probe = await owned.container(["--network", `container:${app}`, "--cpus", "4", "--memory", "2g", "--shm-size", "1g",
          "-v", `${repo}:/repo:ro`, "-v", `${resolve(results)}:/results`, "-e", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright", checker,
          "node", "/repo/bench/marketplace/alert-probe.mjs", "http://127.0.0.1:8080", source, String(iterations), `/results/${source}.json`, String(seconds)], `${name}-probe`);
        // The probe stops itself at its budget; this deadline, cut to the run's, only covers a probe that cannot.
        let exit = null;
        try { await owned.attach(probe, (seconds + attachMargin) * 1000); } catch (e) { exit = e; }
        const output = join(results, `${source}.json`);
        if (!existsSync(output)) throw new Error(`probe wrote no result${exit ? `: ${exit.message}` : ""}`);
        const result = JSON.parse(readFileSync(output, "utf8"));
        log(`${source}: ${result.cases.map((c) => `${JSON.stringify(c.email)}/${JSON.stringify(c.price)} passed ${c.passed} failed ${c.failed} submit ms ${JSON.stringify(c.ms.submitted)}`).join("; ")}${result.stopped ? `; stopped ${JSON.stringify(result.stopped)}` : ""}`);
        if (exit || !result.passed) {
          passed = false;
          report(`${source} probe failed${exit ? ` (${exit.message.split("\n", 1)[0]})` : ""}; diagnostics in ${output}`);
        }
      } catch (e) {
        passed = false;
        report(`${source}: ${e.stack ?? e}`);
      } finally {
        // The app log is the server's side of any stalled submission, read only from the owned ID.
        if (app) {
          let text;
          try { text = await owned.logs(app); } catch (e) { text = `app log unavailable: ${e.message}`; report(`${source}: ${text}`); }
          writeFileSync(join(results, `${source}-app.log`), text.slice(-16384));
        }
        if (probe) await owned.remove(probe);
        if (app) await owned.remove(app);
      }
    }
  } catch (e) {
    passed = false;
    report(e.stack ?? String(e));
  } finally {
    cleanup = await owned.teardown();
    writeFileSync(join(results, "cleanup.json"), JSON.stringify(cleanup, null, 2));
    if (!cleanup.complete) report(`teardown failed: ${JSON.stringify(cleanup.failures)}`);
  }
  return { passed: passed && cleanup.complete, probesPassed: passed, cleanup };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), labels = [];
  const seconds = (option, fallback) => {
    const at = args.indexOf(option);
    if (at === -1) return fallback;
    assert.match(args[at + 1] ?? "", /^[1-9]\d*$/, `${option} needs SECONDS`);
    return Number(args.splice(at, 2)[1]);
  };
  for (let i = args.indexOf("--label"); i !== -1; i = args.indexOf("--label")) {
    labels.push("--label", args[i + 1]); args.splice(i, 2);
  }
  // Refused here too, before the results directory or Docker is touched.
  callerLabels(labels);
  const budget = seconds("--budget", 3600), deadline = seconds("--deadline", Infinity);
  const [image, iterations = "50", results = join(here, "results", "alert-probe")] = args;
  assert.ok(image && /^[1-9]\d*$/.test(iterations), "usage: node alert-probe-run.mjs IMAGE [ITERATIONS] [RESULTS_DIR] [--budget SECONDS] [--deadline SECONDS] [--label KEY=VALUE ...]");
  const { passed, probesPassed, cleanup } = await runAlertProbe({ image, iterations: Number(iterations), results, budget, deadline, labels });
  if (!passed) {
    console.error(`script-free alert probe ${probesPassed ? "passed but teardown failed" : "failed"}; cleanup ${cleanup.complete ? "complete" : "INCOMPLETE"}`);
    process.exitCode = 1;
  }
}
