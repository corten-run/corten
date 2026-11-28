// Retained Docker/k6 observations. This is evidence replay, not image attestation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { locales } from "./contract.mjs";

export const evidenceVersion = "marketplace-raw/v3";
export const maxStatsSamples = 1000;
export const ownerLabel = "run.corten.marketplace";
export const nodeImage = "node:26.13.1-trixie-slim@sha256:615a27817f7b9508f0de73eb1cc8fc8894ab122bee56c1a7a568b72cd1032067";
export { k6Image } from "../load-tool.mjs";
export const upstreamInterpretation = "single-process upstream; a busy API may be the throughput limit, not the app";
const environment = ["MARKETPLACE_SOURCE", "MARKETPLACE_FIXTURE_PATH", "API_BASE", "PORT", "HOSTS", "PROFILE", "MAX_CONNECTIONS", "LOCALE", "BASE", "TARGET", "DURATION", "MODE", "RATE", "VUS"];

// Keep only the benchmark's explicit controls, never arbitrary image environment values.
export function containerReceipt(i) {
  return { id: i.Id, name: i.Name.replace(/^\//, ""), imageId: i.Image, image: i.Config.Image,
    env: Object.fromEntries(i.Config.Env.map((s) => [s.slice(0, s.indexOf("=")), s.slice(s.indexOf("=") + 1)]).filter(([k]) => environment.includes(k))),
    cmd: i.Config.Cmd ?? null, entrypoint: i.Config.Entrypoint ?? null, owner: i.Config.Labels?.[ownerLabel], state: i.State,
    memoryBytes: i.HostConfig.Memory, nanoCpus: i.HostConfig.NanoCpus, cpuPeriod: i.HostConfig.CpuPeriod, cpuQuota: i.HostConfig.CpuQuota,
    cpuset: i.HostConfig.CpusetCpus, network: i.HostConfig.NetworkMode, ulimits: i.HostConfig.Ulimits,
    mounts: i.Mounts.map((m) => ({ type: m.Type, name: m.Name, source: m.Source, destination: m.Destination, readOnly: !m.RW })) };
}
export function imageReceipt(i) {
  assert.ok(i?.Config && typeof i.Config === "object" && !Array.isArray(i.Config), "image configuration missing");
  return { id: i.Id, bytes: i.Size, labels: Object.fromEntries(Object.entries(i.Config.Labels ?? {}).filter(([k]) => k.startsWith("run.corten.marketplace."))),
    cmd: i.Config.Cmd ?? null, entrypoint: i.Config.Entrypoint ?? null, repoDigests: i.RepoDigests ?? [] };
}
// An absent local object is a failure, never an invitation to fetch. Ignore inherited Git
// redirection/replacement/configuration variables, and bound both output and elapsed time.
function gitObject(args, maxBuffer) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" });
  return execFileSync("git", ["-c", "protocol.allow=never", ...args],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), env, encoding: "utf8", timeout: 10000, maxBuffer, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}
export function sourceTree(commit) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  const text = gitObject(["cat-file", "commit", commit], 4 * 2 ** 20);
  const tree = /^tree ([a-f0-9]{40})\n/.exec(text)?.[1];
  assert.ok(tree, "local source commit has no tree");
  return tree;
}

// run.mjs takes its schema from this export. Read the measured tree's literal,
// not a saved copy or the working tree; never execute the committed module.
export function producerSchema(tree) {
  assert.match(tree, /^[a-f0-9]{40}$/);
  const limit = 64 * 1024;
  const entry = gitObject(["ls-tree", "-lz", tree, "--", "bench/marketplace/run-contract.mjs"], 1024);
  const blob = /^100(?:644|755) blob ([a-f0-9]{40}) +([0-9]+)\tbench\/marketplace\/run-contract\.mjs\0$/.exec(entry);
  assert.ok(blob && Number(blob[2]) > 0 && Number(blob[2]) <= limit, "measured producer schema source absent, nonregular or oversized");
  const source = gitObject(["cat-file", "blob", blob[1]], limit);
  assert.equal(Buffer.byteLength(source), Number(blob[2]), "measured producer schema source size differs");
  const declarations = source.split(/^[ \t]*export\s+const\s+resultSchema\b/m);
  const literal = declarations.length === 2 && /^\s*=\s*(["'])(marketplace-results\/v[56])\1\s*;/.exec(declarations[1]);
  assert.ok(literal, "unrecognized or ambiguous measured producer schema");
  return literal[2];
}
export function loadEnvironment(s, profile, phase, name) {
  return { ...(profile.target === "page" ? { LOCALE: profile.locale } : {}), BASE: `http://${name}:8080`, TARGET: profile.target,
    DURATION: `${phase === "warmup" ? s.options.warmup : s.options.duration}s`, MODE: phase === "fixed" ? "fixed" : "closed",
    RATE: String(s.options.rate), VUS: String(phase === "sat256" ? 256 : phase === "warmup" ? 32 : 64) };
}

// Called after the engine clock, native counter rates, request/check coverage
// and schema-specific profile have been checked. These counters mark selections
// before the GET, not successes: a 503, timeout or app stop is not a missing locale.
export function validateLocaleCounters(profile, metrics, elapsedMs, seconds, env) {
  const names = locales.map((locale) => `marketplace_locale_${locale.replace("-", "_")}`);
  const rotating = profile.target === "page" && profile.locale === "rotating";
  for (const name of Object.keys(metrics).filter((n) => n.startsWith("marketplace_locale_"))) {
    assert.ok(rotating && names.includes(name), `unexpected locale counter ${name}`);
  }
  if (!rotating) return;
  const metric = (name) => metrics[name]?.values ?? metrics[name];
  const counts = names.map((name) => {
    if (!Object.hasOwn(metrics, name)) return 0; // k6 may omit an unsampled Counter
    const count = metric(name)?.count;
    assert.ok(Number.isSafeInteger(count) && count >= 0 && (!Object.hasOwn(metrics[name], "type") || metrics[name].type === "counter"), `invalid locale counter ${name}`);
    return count;
  });
  const selected = counts.reduce((a, b) => a + b, 0);
  const requests = metric("http_reqs").count, completed = metric("iterations").count;
  assert.ok(Number.isSafeInteger(selected) && selected >= requests, "locale selections do not cover HTTP requests");
  // Single local scenario, sequential iterationInTest starting at zero. Each
  // observed occurrence requires at least this many starts in the round robin.
  const starts = Math.max(...counts.map((n, i) => n ? (n - 1) * names.length + i + 1 : 0));
  // A normal graceful drain finishes every selection. At the actual 10s
  // gracefulStop cutoff, a VU can be interrupted before adding its Counter or
  // before HTTP emits its sample. Dropped arrival slots never start an iteration.
  const atCutoff = elapsedMs >= (seconds + 10) * 1000 - 1e-6;
  if (!atCutoff) {
    assert.equal(selected, requests, "locale selections differ from HTTP requests");
    assert.equal(starts, selected, "locale selections differ from the native rotation");
  } else {
    assert.ok(Number.isSafeInteger(starts) && starts - completed <= metric("vus_max").max, "interrupted locale rotation exceeds active VUs");
    if (env.MODE === "fixed") {
      const slots = Math.floor(Math.ceil(elapsedMs * 1e6 + 1) / Math.floor(1e9 / Number(env.RATE))) + 1;
      assert.ok(starts + (metric("dropped_iterations")?.count ?? 0) <= slots, "locale selections exceed arrival slots");
    }
  }
}
