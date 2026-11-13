// Retained Docker/k6 observations. This is evidence replay, not image attestation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const evidenceVersion = "marketplace-raw/v2";
export const ownerLabel = "run.corten.marketplace";
export const nodeImage = "node:24-bookworm-slim";
export const k6Image = "grafana/k6@sha256:3e4186aea62e11a45560bfc51e19eeafe82fc07ce069c78aff44b7ff893d9a5e";
export const upstreamInterpretation = "single-process upstream; a busy API may be the throughput limit, not the app";
const environment = ["MARKETPLACE_SOURCE", "MARKETPLACE_FIXTURE_PATH", "API_BASE", "PORT", "HOSTS", "PROFILE", "MAX_CONNECTIONS", "LOCALE", "BASE", "TARGET", "DURATION", "MODE", "RATE", "VUS"];

// Keep only the benchmark's explicit controls, never arbitrary image environment values.
export function containerReceipt(i) {
  return { id: i.Id, name: i.Name.replace(/^\//, ""), imageId: i.Image, image: i.Config.Image,
    env: Object.fromEntries(i.Config.Env.map((s) => [s.slice(0, s.indexOf("=")), s.slice(s.indexOf("=") + 1)]).filter(([k]) => environment.includes(k))),
    cmd: i.Config.Cmd, entrypoint: i.Config.Entrypoint, owner: i.Config.Labels?.[ownerLabel], state: i.State,
    memoryBytes: i.HostConfig.Memory, nanoCpus: i.HostConfig.NanoCpus, cpuPeriod: i.HostConfig.CpuPeriod, cpuQuota: i.HostConfig.CpuQuota,
    cpuset: i.HostConfig.CpusetCpus, network: i.HostConfig.NetworkMode, ulimits: i.HostConfig.Ulimits,
    mounts: i.Mounts.map((m) => ({ type: m.Type, name: m.Name, source: m.Source, destination: m.Destination, readOnly: !m.RW })) };
}
export function imageReceipt(i) {
  return { id: i.Id, bytes: i.Size, labels: Object.fromEntries(Object.entries(i.Config.Labels ?? {}).filter(([k]) => k.startsWith("run.corten.marketplace."))),
    cmd: i.Config.Cmd, entrypoint: i.Config.Entrypoint, repoDigests: i.RepoDigests ?? [] };
}
// An absent local object is a failure, never an invitation to fetch. Ignore inherited Git
// redirection/replacement/configuration variables, and bound both output and elapsed time.
export function sourceTree(commit) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" });
  const text = execFileSync("git", ["-c", "protocol.allow=never", "cat-file", "commit", commit],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), env, encoding: "utf8", timeout: 10000, maxBuffer: 4 * 2 ** 20, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const tree = /^tree ([a-f0-9]{40})\n/.exec(text)?.[1];
  assert.ok(tree, "local source commit has no tree");
  return tree;
}
export function loadEnvironment(s, profile, phase, name) {
  return { ...(profile.target === "page" ? { LOCALE: profile.locale } : {}), BASE: `http://${name}:8080`, TARGET: profile.target,
    DURATION: `${phase === "warmup" ? s.options.warmup : s.options.duration}s`, MODE: phase === "fixed" ? "fixed" : "closed",
    RATE: String(s.options.rate), VUS: String(phase === "sat256" ? 256 : phase === "warmup" ? 32 : 64) };
}
