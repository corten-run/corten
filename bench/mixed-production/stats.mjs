import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { memoryMiB, summarizeSamples } from "../catalog/stats.mjs";
import { sha256 } from "./capture.mjs";

// Preserve the catalog sampler's actual receipt clocks and summary convention,
// while retaining the host Docker client's OS close event for this native run.
export function sampleStats(names, file, seconds) {
  const receipt = { schema: "mixed-native-stats-client/v1", names, startedUnixMs: Date.now(), pid: null,
    spawnedUnixMs: null, stopRequestedUnixMs: null, closedUnixMs: null, exitCode: null, signal: null, rawSha256: null, failures: [] };
  const save = () => writeFileSync(`${file}.process.json`, JSON.stringify(receipt));
  save();
  const child = spawn("docker", ["stats", "--format", "{{json .}}", ...names], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const samples = Object.fromEntries(names.map((name) => [name, []])); let raw = "", buffer = "", stopping = false, closed = false;
  const failed = (code) => { if (!receipt.failures.includes(code)) receipt.failures.push(code); save(); };
  const ready = new Promise((resolve, reject) => {
    child.once("spawn", () => { receipt.pid = child.pid; receipt.spawnedUnixMs = Date.now(); save(); resolve(); });
    child.once("error", () => reject(Error("native stats client could not start")));
  });
  child.stdout.on("data", (chunk) => {
    const data = chunk.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""); raw += data; buffer += data;
    if (Buffer.byteLength(raw) > 32 * 1024 ** 2) { failed("stats-output-bound-exceeded"); child.kill(); return; }
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (!line) continue;
      try { const row = JSON.parse(line); if (!Object.hasOwn(samples, row.Name)) throw Error("unexpected participant");
        samples[row.Name].push({ t: Date.now(), cpu: parseFloat(row.CPUPerc), mem: memoryMiB(row.MemUsage.split("/")[0]) });
      } catch { failed("stats-row-invalid"); }
    }
  });
  child.stderr.on("data", () => { if (!stopping) failed("stats-client-stderr"); }); child.on("error", () => failed("stats-client-error"));
  const done = new Promise((resolve) => child.once("close", (code, signal) => {
    closed = true; receipt.closedUnixMs = Date.now(); receipt.exitCode = code; receipt.signal = signal;
    if (!stopping) failed("stats-client-closed-early"); save(); resolve();
  }));
  const timer = setTimeout(() => { failed("stats-client-deadline-exceeded"); child.kill(); }, seconds * 1000);
  let stopped;
  return { ready, stop() {
    return stopped ??= (async () => {
      stopping = true; receipt.stopRequestedUnixMs = Date.now(); clearTimeout(timer); save(); if (!closed) child.kill();
      const kill = setTimeout(() => child.kill("SIGKILL"), 2000); await done; clearTimeout(kill);
      writeFileSync(file, raw); receipt.rawSha256 = sha256(raw); save();
      if (buffer.trim()) failed("stats-truncated-row");
      if (receipt.failures.length) throw Error("native stats client failed");
      const summary = Object.fromEntries(names.map((name) => [name, summarizeSamples(samples[name])]));
      writeFileSync(`${file}.json`, JSON.stringify({ summary, samples }, null, 2)); return summary;
    })();
  } };
}

export function replayStatsClient(receipt, names, rawSha256, window) {
  if (!receipt || Object.keys(receipt).sort().join() !== "closedUnixMs,exitCode,failures,names,pid,rawSha256,schema,signal,spawnedUnixMs,startedUnixMs,stopRequestedUnixMs"
    || receipt.schema !== "mixed-native-stats-client/v1" || !Array.isArray(receipt.names) || receipt.names.length !== new Set(receipt.names).size
    || JSON.stringify(receipt.names.toSorted()) !== JSON.stringify(names.toSorted())
    || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0 || receipt.rawSha256 !== rawSha256
    || !Array.isArray(receipt.failures) || receipt.failures.length) throw Error("native stats client evidence invalid");
  const times = [receipt.startedUnixMs, receipt.spawnedUnixMs, receipt.stopRequestedUnixMs, receipt.closedUnixMs];
  if (!times.every((n, i) => Number.isSafeInteger(n) && n >= 0 && (!i || n >= times[i - 1]))
    || receipt.spawnedUnixMs > window.startedUnixMs || receipt.stopRequestedUnixMs < window.finishedUnixMs
    || !(Number.isInteger(receipt.exitCode) && receipt.signal === null || receipt.exitCode === null && ["SIGTERM", "SIGKILL"].includes(receipt.signal))) throw Error("native stats client lifetime invalid");
}
