import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

// Same docker-stats measurement and steady-window convention as fullstack/sample-stats.mjs.
// Kept here because that utility is a CLI with process-level signal/exit side effects.
export function memoryMiB(value) {
  const m = /^\s*([\d.]+)\s*(B|[KMGT]i?B)\s*$/.exec(value);
  if (!m) throw new Error(`invalid docker memory value ${value}`);
  const units = { B: 1 / 2 ** 20, KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024, TiB: 2 ** 20, TB: 2 ** 20 };
  return Number(m[1]) * units[m[2]];
}
export const steadySampleWindow = (count) => [Math.floor(count * 0.15), Math.ceil(count * 0.95)];
export const statsPipeReleaseMessage = "docker stats client pipes did not close within the stop grace";
export function summarizeSamples(samples) {
  if (!samples.length) throw new Error("docker stats produced no samples");
  for (const s of samples) if (!Number.isFinite(s.mem) || !Number.isFinite(s.cpu)) throw new Error("invalid docker stats sample");
  const steady = samples.slice(...steadySampleWindow(samples.length));
  const avg = (key) => steady.reduce((sum, s) => sum + s[key], 0) / steady.length;
  return { samples: samples.length, cpuAvgPct: avg("cpu"), cpuMaxPct: Math.max(...samples.map((s) => s.cpu)), memAvgMiB: avg("mem"), memMaxMiB: Math.max(...samples.map((s) => s.mem)) };
}
export function sampleStats(names, file, seconds, { termGraceMs = 2000, pipeGraceMs = 5000 } = {}) {
  const child = spawn("docker", ["stats", "--format", "{{json .}}", ...names], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const samples = Object.fromEntries(names.map((n) => [n, []]));
  // Each error with when it happened: the marketplace runner tells one after an app's container
  // stopped from one before it (#1128). stop() throws them joined, as it always has.
  const errors = [];
  const failed = (message, kind) => errors.push({ message, at: new Date().toISOString(), kind });
  let buffer = "";
  let raw = "";
  let stopping = false;
  child.stdout.on("data", (chunk) => {
    const data = chunk.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    raw += data;
    buffer += data;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      try {
        const s = JSON.parse(line);
        if (!samples[s.Name]) throw new Error(`unexpected stats container ${s.Name}`);
        samples[s.Name].push({ t: Date.now(), cpu: parseFloat(s.CPUPerc), mem: memoryMiB(s.MemUsage.split("/")[0]) });
      } catch (e) { failed(e.message); }
    }
  });
  child.stderr.on("data", (chunk) => { if (!stopping) failed(chunk.toString()); });
  child.on("error", (error) => failed(error.message));
  let closed = false, exited = false, settle, escalation, release;
  const done = new Promise((resolve) => { settle = resolve; });
  child.once("exit", () => { exited = true; });
  child.once("close", (code) => {
    closed = true;
    clearTimeout(escalation); clearTimeout(release);
    if (!stopping) failed(`docker stats stopped early: ${code}`);
    settle();
  });
  const signal = (name) => {
    if (closed || exited) return;
    try { child.kill(name); } catch (error) { failed(error.message); }
  };
  const terminate = () => {
    if (closed || release !== undefined) return;
    escalation = setTimeout(() => signal("SIGKILL"), termGraceMs);
    release = setTimeout(() => {
      // An exited CLI can be reaped while descendants still hold its pipes.
      // Retain any captured bytes but never summarize truncated evidence.
      failed(statsPipeReleaseMessage, "pipe-release-timeout");
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      settle();
    }, pipeGraceMs);
    signal("SIGTERM");
  };
  const timer = setTimeout(() => { failed("stats sampler exceeded its deadline"); terminate(); }, seconds * 1000);
  return {
    async stop() {
      stopping = true;
      clearTimeout(timer);
      terminate();
      await done;
      writeFileSync(file, raw);
      if (buffer.length) failed("stats ended with an incomplete JSON record");
      if (errors.length) throw Object.assign(new Error(errors.map((e) => e.message).join("; ")), { errors });
      const summary = Object.fromEntries(names.map((name) => [name, summarizeSamples(samples[name])]));
      writeFileSync(`${file}.json`, JSON.stringify({ summary, samples }, null, 2));
      return summary;
    },
  };
}
