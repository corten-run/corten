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
export function summarizeSamples(samples) {
  if (!samples.length) throw new Error("docker stats produced no samples");
  for (const s of samples) if (!Number.isFinite(s.mem) || !Number.isFinite(s.cpu)) throw new Error("invalid docker stats sample");
  const steady = samples.slice(Math.floor(samples.length * 0.15), Math.ceil(samples.length * 0.95));
  const avg = (key) => steady.reduce((sum, s) => sum + s[key], 0) / steady.length;
  return { samples: samples.length, cpuAvgPct: avg("cpu"), cpuMaxPct: Math.max(...samples.map((s) => s.cpu)), memAvgMiB: avg("mem"), memMaxMiB: Math.max(...samples.map((s) => s.mem)) };
}
export function sampleStats(names, file, seconds) {
  const child = spawn("docker", ["stats", "--format", "{{json .}}", ...names], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const samples = Object.fromEntries(names.map((n) => [n, []]));
  const errors = [];
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
      } catch (e) { errors.push(e.message); }
    }
  });
  child.stderr.on("data", (chunk) => { if (!stopping) errors.push(chunk.toString()); });
  child.on("error", (error) => errors.push(error.message));
  let closed = false;
  const done = new Promise((resolve) => child.on("close", (code) => { closed = true; if (!stopping) errors.push(`docker stats stopped early: ${code}`); resolve(); }));
  const timer = setTimeout(() => { errors.push("stats sampler exceeded its deadline"); child.kill(); }, seconds * 1000);
  return {
    async stop() {
      stopping = true;
      clearTimeout(timer);
      if (!closed) child.kill();
      const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
      await done;
      clearTimeout(kill);
      writeFileSync(file, raw);
      if (errors.length) throw new Error(errors.join("; "));
      const summary = Object.fromEntries(names.map((name) => [name, summarizeSamples(samples[name])]));
      writeFileSync(`${file}.json`, JSON.stringify({ summary, samples }, null, 2));
      return summary;
    },
  };
}
