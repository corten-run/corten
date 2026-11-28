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
export const statsInfrastructure = Object.freeze({
  deadline: "stats sampler exceeded its deadline",
  "pipe-release-timeout": "docker stats client pipes did not close within the stop grace",
  "shutdown-signal": "docker stats client signal failed",
  "client-process": "docker stats client process failed",
  "client-stderr": "docker stats client wrote to stderr",
});
function displayedMemory(value) {
  const m = /^\s*(\d+(?:\.(\d+))?)\s*(B|[KMGT]i?B)\s*$/.exec(value);
  if (!m) throw new Error("invalid Docker memory display");
  const quantity = Number(m[1]);
  if (!Number.isFinite(quantity)) throw new Error("non-finite Docker memory quantity");
  // Docker BytesSize uses %.4g: omitted trailing zeroes do not reduce precision.
  const magnitude = Math.floor(Math.log10(quantity || 1));
  const mib = memoryMiB(value), rounding = memoryMiB(`1${m[3]}`) * 10 ** (magnitude - 3) / 2;
  if (!Number.isFinite(mib) || !Number.isFinite(rounding)) throw new Error("non-finite Docker memory conversion");
  return { mib, rounding };
}
export function parseStatsSample(line) {
  let row;
  // The raw log keeps the row; JSON.parse's error can quote it.
  try { row = JSON.parse(line); }
  catch { throw new Error("invalid Docker stats sample JSON"); }
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("invalid Docker stats sample record");
  const { Name: name, CPUPerc: cpuDisplay, MemUsage } = row;
  if (typeof name !== "string") throw new Error("invalid Docker stats container name");
  if (typeof cpuDisplay !== "string" || !/^\d+(?:\.\d+)?%$/.test(cpuDisplay)) throw new Error("invalid Docker CPU display");
  const cpu = Number(cpuDisplay.slice(0, -1));
  if (!Number.isFinite(cpu)) throw new Error("non-finite Docker CPU display");
  const memory = typeof MemUsage === "string" ? MemUsage.split("/") : [];
  if (memory.length !== 2) throw new Error("memory display missing its limit");
  const usage = displayedMemory(memory[0]), limit = displayedMemory(memory[1]);
  return { name, cpu, mem: usage.mib, usage, limit };
}
export function summarizeSamples(samples) {
  if (!samples.length) throw new Error("docker stats produced no samples");
  for (const s of samples) if (!Number.isFinite(s.mem) || !Number.isFinite(s.cpu)) throw new Error("invalid docker stats sample");
  const steady = samples.slice(...steadySampleWindow(samples.length));
  const avg = (key) => steady.reduce((sum, s) => sum + s[key], 0) / steady.length;
  return { samples: samples.length, cpuAvgPct: avg("cpu"), cpuMaxPct: Math.max(...samples.map((s) => s.cpu)), memAvgMiB: avg("mem"), memMaxMiB: Math.max(...samples.map((s) => s.mem)) };
}
export function sampleStats(names, file, seconds, { termGraceMs = 2000, pipeGraceMs = 5000 } = {}) {
  const child = spawn("docker", ["stats", "--format", "{{json .}}", ...names], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  // Docker can return 0 on POSIX SIGTERM, indistinguishable from an unsolicited exit.
  // Hang up the local CLI there; Windows reports its forced termination as SIGTERM.
  const stopSignal = process.platform === "win32" ? "SIGTERM" : "SIGHUP";
  const samples = Object.fromEntries(names.map((n) => [n, []]));
  // Retain the failure kind and observation time, not the Docker client's stderr text.
  const errors = [];
  const record = (kind, message) => errors.push({ message, at: new Date().toISOString(), kind });
  const observed = (message) => record("stats", message);
  const infrastructure = (kind) => record(kind, statsInfrastructure[kind]);
  let buffer = "";
  let raw = "";
  let stderrSeen = false, stopSent = false, forced = false;
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
        const { name, cpu, mem } = parseStatsSample(line);
        if (!Object.hasOwn(samples, name)) throw new Error("unexpected stats container");
        samples[name].push({ t: Date.now(), cpu, mem });
      } catch (e) { observed(e.message); }
    }
  });
  child.stderr.on("data", (chunk) => {
    if (!stderrSeen && chunk.length) {
      stderrSeen = true;
      infrastructure("client-stderr");
    }
  });
  child.on("error", (error) => infrastructure(error.syscall === "kill" ? "shutdown-signal" : "client-process"));
  let closed = false, exited = false, settle, escalation, release;
  const done = new Promise((resolve) => { settle = resolve; });
  child.once("exit", () => { exited = true; });
  child.once("close", (code, signal) => {
    closed = true;
    clearTimeout(escalation); clearTimeout(release);
    // Require the expected shutdown signature, not just kill() and closed pipes.
    // A matching status cannot tell who sent the signal before the child was reaped.
    // The evidence readers separately check that the samples cover the required window.
    if (!stopSent || forced || code !== null || signal !== stopSignal) infrastructure("client-process");
    settle();
  });
  const signal = (name) => {
    if (closed || exited) return;
    try {
      if (child.kill(name)) {
        if (name === stopSignal) stopSent = true;
        else forced = true;
      }
    } catch { infrastructure("shutdown-signal"); }
  };
  const terminate = () => {
    if (closed || release !== undefined) return;
    escalation = setTimeout(() => signal("SIGKILL"), termGraceMs);
    release = setTimeout(() => {
      // An exited CLI can be reaped while descendants still hold its pipes.
      // Retain any captured bytes but never summarize truncated evidence.
      infrastructure("pipe-release-timeout");
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      settle();
    }, pipeGraceMs);
    signal(stopSignal);
  };
  const timer = setTimeout(() => { infrastructure("deadline"); terminate(); }, seconds * 1000);
  return {
    async stop() {
      clearTimeout(timer);
      terminate();
      await done;
      // Keep every raw row, including any row rejected by the parser.
      writeFileSync(file, raw);
      if (buffer.length) observed("stats ended with an incomplete JSON record");
      if (errors.length) throw Object.assign(new Error(errors.map((e) => e.message).join("; ")), { errors });
      const summary = Object.fromEntries(names.map((name) => [name, summarizeSamples(samples[name])]));
      writeFileSync(`${file}.json`, JSON.stringify({ summary, samples }, null, 2));
      return summary;
    },
  };
}
