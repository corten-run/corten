// Instructions and allocations a request costs the probe, counted by callgrind over a keep-alive
// HTTP/1.1 connection. Needs Linux with valgrind, taskset and libjemalloc.so.2 (README.md).
//
// Usage: node count.mjs <probe binary> [--cases get,post,...] [--depth 1] [--reps 3] [--cpu 0] [--port 8080]
//          instructions a request, each case's median, least and most of `reps` counts
//        node count.mjs <probe binary> --allocations [--cases ...] [--depth 1] [--cpu 0] [--port 8080]
//          allocations and frees a request
//        node count.mjs <probe binary> --answers <directory> [--cases ...] [--cpu 0] [--port 8080]
//          each case's answer as sent, its Date and ETag masked, to compare two builds' bytes
//
// A count is two runs of the probe under callgrind, one answering 240 requests and one 1,240, on
// one connection, each request written after the answer before it (or `--depth` at a time): the
// difference over 1,000 leaves out startup, the connection and shutdown. `--allocations` profiles
// one run's 1,000 requests after 240 that are not recorded.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { allocatorCalls } from "./allocations.mjs";
import { send, sent, start } from "./probe.mjs";
import { cases, median, named } from "./requests.mjs";

const FEW = 240;
const MANY = 1240;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cases: { type: "string", default: Object.keys(cases).join(",") },
    depth: { type: "string", default: "1" },
    reps: { type: "string", default: "3" },
    cpu: { type: "string", default: "0" },
    port: { type: "string", default: "8080" },
    allocations: { type: "boolean", default: false },
    answers: { type: "string" },
  },
});
const [binary] = positionals;
if (!binary || positionals.length !== 1) throw new Error("usage: node count.mjs <probe binary> [--cases a,b] [--depth 1] [--reps 3] [--cpu 0] [--port 8080] [--allocations | --answers <directory>]");
const whole = (/** @type {string} */ name, /** @type {string} */ text) => {
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`--${name} takes a whole number above 0, not ${JSON.stringify(text)}`);
  return Number(text);
};
const names = named(values.cases);
const depth = whole("depth", values.depth);
const reps = whole("reps", values.reps);
const port = whole("port", values.port);
const cpu = values.cpu;
const configuration = (/** @type {string} */ name) => /** @type {typeof cases[string]} */ (cases[name]).configuration;

const scratch = mkdtempSync(join(tmpdir(), "request-cost-"));
try {
  if (values.answers !== undefined) await answers(values.answers);
  else if (values.allocations) await allocations();
  else await instructions();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

/** Instructions the probe runs from start to stop when it answers `count` requests of a case. */
async function run(/** @type {string} */ name, /** @type {number} */ count) {
  const probe = await start(binary, configuration(name), { cpu, port, callgrind: { out: join(scratch, "count.callgrind") } });
  try {
    await send(name, port, count, depth);
  } catch (error) {
    await probe.stop().catch(() => {});
    throw error;
  }
  return probe.stop();
}

async function instructions() {
  const row = (/** @type {(string | number)[]} */ [name, ...numbers]) => String(name).padEnd(14) + numbers.slice(0, 3).map((n) => String(n).padStart(10)).join("") + "  " + numbers.slice(3).join(" ");
  console.log(row(["case", "median", "least", "most", "counts"]));
  const requests = sent(MANY, depth) - sent(FEW, depth);
  for (const name of names) {
    const counts = [];
    for (let rep = 0; rep < reps; rep += 1) {
      const few = await run(name, FEW);
      const many = await run(name, MANY);
      counts.push(Math.round((many - few) / requests));
    }
    console.log(row([name, median(counts), Math.min(...counts), Math.max(...counts), ...counts]));
  }
}

async function allocations() {
  const requests = sent(1000, depth);
  console.log("case".padEnd(14) + "allocations".padStart(12) + "frees".padStart(10) + "  calls");
  for (const name of names) {
    const out = join(scratch, "profile.callgrind");
    const probe = await start(binary, configuration(name), {
      cpu,
      port,
      callgrind: { out, options: ["--instr-atstart=no", "--compress-strings=no", "--compress-pos=no"] },
    });
    try {
      await send(name, port, FEW, depth);
      execFileSync("callgrind_control", ["-i", "on", String(probe.pid)], { stdio: "ignore" });
      await send(name, port, 1000, depth);
      execFileSync("callgrind_control", ["-i", "off", String(probe.pid)], { stdio: "ignore" });
    } catch (error) {
      await probe.stop().catch(() => {});
      throw error;
    }
    await probe.stop();
    const found = allocatorCalls(readFileSync(out, "latin1"));
    const each = (/** @type {number} */ count) => (count / requests).toFixed(2);
    const calls = Object.entries(found.calls).sort().map(([call, count]) => `${call}=${each(count)}`).join(" ");
    console.log(name.padEnd(14) + each(found.allocations).padStart(12) + each(found.frees).padStart(10) + "  " + calls);
  }
}

async function answers(/** @type {string} */ directory) {
  mkdirSync(directory, { recursive: true });
  for (const name of names) {
    const probe = await start(binary, configuration(name), { cpu, port });
    try {
      writeFileSync(join(directory, `${name}.http`), await send(name, port, 3));
    } finally {
      await probe.stop();
    }
  }
}
