// Optional direct HTTP/1.1 diagnostic. Never schedules a group or changes an adapter.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { Agent, get } from "node:http";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { payloads, route } from "./contract.mjs";

const arms = ["identity", "gzip", "reconnect-10"];
const maxBody = 1024 * 1024;

// One Agent per lane: no pipelining or unobservable pool-level connection rotation.
function read(base, path, agent, encoding, close, sockets) {
  return new Promise((resolve, reject) => {
    const req = get(base + path, { agent, headers: { accept: "application/json", "accept-encoding": encoding,
      connection: close ? "close" : "keep-alive" }, signal: AbortSignal.timeout(5000) }, (res) => {
      let bytes = 0; const parts = [];
      res.on("error", reject);
      res.on("data", (part) => {
        bytes += part.length;
        if (bytes > maxBody) res.destroy(new Error("oversized JSON response"));
        else parts.push(part);
      });
      res.on("end", () => resolve({ status: res.statusCode, version: res.httpVersion, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on("error", reject);
    req.on("socket", (socket) => {
      if (!sockets.has(socket)) {
        const observation = { requests: 0, closed: false };
        sockets.set(socket, observation);
        socket.once("close", () => { observation.closed = true; });
      }
      sockets.get(socket).requests++;
    });
  });
}

export async function sample({ base, cases, arm, rate, lanes, perLane, counter }) {
  assert.ok(arms.includes(arm) && cases.length > 0);
  for (const [n, max] of [[rate, 10000], [lanes, 64], [perLane, 10000]]) assert.ok(Number.isSafeInteger(n) && n > 0 && n <= max);
  assert.ok(lanes * perLane <= 100000);
  const sockets = new Map(), agents = Array.from({ length: lanes }, () => new Agent({ keepAlive: true, maxSockets: 1 }));
  const failures = Object.create(null), codings = Object.create(null), latencies = [], startLags = [];
  let dropped = 0, bodyBytes = 0, unsupported = 0;
  const encoding = arm === "gzip" ? "gzip" : "identity";
  const cpuBefore = await counter();
  const cpu = process.cpuUsage(), elu = performance.eventLoopUtilization(), start = performance.now();
  try {
    await Promise.all(agents.map(async (agent, lane) => {
      let sent = 0;
      for (let i = 0; i < perLane; i++) {
        const slot = i * lanes + lane, due = start + slot * 1000 / rate;
        const wait = due - performance.now();
        if (wait > 0) await sleep(wait);
        const issued = performance.now();
        if (issued - due >= lanes * 1000 / rate) { dropped++; continue; }
        startLags.push(Math.max(0, issued - due));
        const { path, record } = cases[slot % cases.length];
        try {
          const response = await read(base, path, agent, encoding, arm === "reconnect-10" && ++sent % 10 === 0, sockets);
          const finished = performance.now(), coding = (response.headers["content-encoding"] ?? "identity").trim().toLowerCase();
          assert.equal(response.status, 200, "not HTTP 200");
          assert.equal(response.version, "1.1", "not HTTP/1.1");
          assert.equal(response.headers["content-type"]?.split(";")[0].trim().toLowerCase(), "application/json", "not JSON");
          codings[coding] = (Object.hasOwn(codings, coding) ? codings[coding] : 0) + 1;
          assert.ok(coding === "gzip" || coding === "identity", "unrequested codec");
          const raw = coding === "gzip" ? gunzipSync(response.body, { maxOutputLength: maxBody }) : response.body;
          assert.deepEqual(JSON.parse(raw), record, "response differs from the fixture");
          if (arm === "gzip" && coding === "identity") unsupported++;
          assert.equal(coding, encoding, "wrong content encoding");
          latencies.push(finished - issued); bodyBytes += response.body.length;
        } catch (error) {
          const key = String(error.message).split("\n")[0].slice(0, 120);
          failures[key] = (failures[key] ?? 0) + 1;
        }
      }
    }));
  } finally { for (const agent of agents) agent.destroy(); }
  const ms = performance.now() - start, clientCpu = process.cpuUsage(cpu), utilization = performance.eventLoopUtilization(elu).utilization;
  const cpuAfter = await counter();
  assert.ok(Number.isSafeInteger(cpuBefore) && Number.isSafeInteger(cpuAfter) && cpuAfter >= cpuBefore, "invalid app CPU counters");
  // Wait for the client's close observations, including end-of-pass cleanup.
  for (let i = 0; i < 100 && [...sockets.values()].some((s) => !s.closed); i++) await sleep(5);
  const socketSizes = [...sockets.values()].map((s) => s.requests).sort((a, b) => a - b);
  const expected = arm === "reconnect-10" ? Array.from({ length: lanes }, () =>
    Array.from({ length: Math.ceil(perLane / 10) }, (_, i) => Math.min(10, perLane - 10 * i))).flat().sort((a, b) => a - b)
    : Array(lanes).fill(perLane);
  const closed = [...sockets.values()].filter((s) => s.closed).length;
  const connectionPattern = closed === sockets.size && socketSizes.length === expected.length && socketSizes.every((n, i) => n === expected[i]);
  const p99 = (xs) => xs.length ? xs.sort((a, b) => a - b)[Math.ceil(xs.length * 0.99) - 1] : null;
  const failed = Object.values(failures).reduce((a, b) => a + b, 0);
  const completed = latencies.length;
  const lag = p99(startLags), generatorLimited = dropped > 0 || utilization >= 0.8 || lag >= lanes * 500 / rate;
  return { arm, status: unsupported === lanes * perLane && connectionPattern ? "unsupported" : failed || dropped || !connectionPattern ? "incomplete" : "observed",
    rate, lanes, perLane, elapsedMs: ms, scheduled: lanes * perLane, completed, dropped, failed, failures, encoding, observedContentCodings: codings,
    successfulRps: completed / (ms / 1000), p99Ms: p99(latencies), generatorStartLagP99Ms: lag, generatorLimited,
    encodedBodyBytes: bodyBytes, bytesPerSuccess: completed ? bodyBytes / completed : null, cpuBefore, cpuAfter,
    appCpuUsecPerSuccess: completed ? (cpuAfter - cpuBefore) / completed : null, clientCpu, generatorEventLoopUtilization: utilization,
    opened: sockets.size, closed, requestsPerConnection: socketSizes, connectionPattern };
}

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 10000, windowsHide: true }).trim();
const inspect = (id) => JSON.parse(docker("inspect", "--type", "container", id))[0];
export function localEngine(endpoint) {
  return /^unix:\/\/\/(?!\/)/.test(endpoint) || /^npipe:\/\/\/\/\.\/pipe\/[\w.-]+$/.test(endpoint);
}
// A single sleeping observer, not a docker-exec process launch per counter read.
// POSIX shell builtins only. Each newline requests a fresh cgroup v2 sample.
function cpuObserver(container) {
  const command = 'while read -r request; do while read -r key value; do if [ "$key" = usage_usec ]; then echo "$value"; break; fi; done </sys/fs/cgroup/cpu.stat; done';
  const child = spawn("docker", ["exec", "-i", container, "sh", "-c", command], { windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout });
  const stopped = new Promise((resolve) => { child.once("error", resolve); child.once("close", resolve); });
  child.stdin.on("error", () => {}); // An exited observer is reported by stopped.
  return {
    async read() {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = once(lines, "line", { signal: controller.signal });
        child.stdin.write("\n");
        const value = await Promise.race([response, stopped]);
        assert.ok(Array.isArray(value) && /^\d+$/.test(value[0]), "app CPU observer stopped or returned an invalid counter");
        return Number(value[0]);
      } finally { clearTimeout(timer); controller.abort(); }
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 2000);
      try { await stopped; } finally { clearTimeout(timer); lines.close(); }
    },
  };
}
export function summarize(rows) {
  return Object.fromEntries(arms.map((arm) => {
    const group = rows.filter((row) => row.arm === arm);
    if (group.length !== 3 || ![1, 2, 3].every((pass) => group.some((row) => row.pass === pass))
      || group.some((row) => row.status !== "observed" || row.generatorLimited || row.warmup?.generatorLimited)) return [arm, null];
    return [arm, Object.fromEntries(["bytesPerSuccess", "appCpuUsecPerSuccess", "p99Ms", "successfulRps"].map((metric) => {
      const [min, median, max] = group.map((row) => row[metric]).sort((a, b) => a - b);
      return [metric, { min, median, max }];
    }))];
  }));
}
export async function run([container, payload, codecConfiguration, rateArg = "150", ...rest]) {
  assert.ok(/^[a-f0-9]{64}$/.test(container) && Object.hasOwn(payloads, payload) && codecConfiguration?.trim() && ["30", "75", "150"].includes(rateArg) && !rest.length,
    "usage: node bench/json-api/transport.mjs FULL_CONTAINER_ID catalog-v1|marketplace-v2 'native middleware, codec level or unknown' [30|75|150]");
  const rate = Number(rateArg);
  // A remote daemon's loopback is not this generator's loopback.
  const endpoint = (!process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST) || docker("context", "inspect", "--format", "{{.Endpoints.docker.Host}}");
  assert.ok(localEngine(endpoint), "local Docker socket or named pipe required");
  const app = inspect(container), p = payloads[payload];
  assert.ok(app.Id === container && app.State.Running && app.Config.Env.includes(p.path.toUpperCase() + "_SOURCE=fixture"), "running fixture-backed app required");
  assert.equal(app.HostConfig.CgroupnsMode, "private", "app CPU requires a private cgroup namespace");
  const ports = app.NetworkSettings.Ports["8080/tcp"];
  assert.ok(ports?.length === 1 && ports[0].HostIp === "127.0.0.1", "publish 8080 on loopback only");
  const base = "http://127.0.0.1:" + ports[0].HostPort;
  const records = p.records();
  const cases = [1, 17, 250].map((n) => {
    const id = p.first.replace(/1$/, String(n)); return { path: route({ payload }, id), record: records[id] };
  });
  const rows = [], observer = cpuObserver(container);
  try { for (let pass = 0; pass < 3; pass++) for (let i = 0; i < arms.length; i++) {
    const arm = arms[(pass + i) % arms.length];
    const options = { base, cases, arm, rate, lanes: 4, counter: () => observer.read() };
    const warmup = await sample({ ...options, perLane: 30 });
    const measured = await sample({ ...options, perLane: rate * 2 });
    if (warmup.status !== measured.status) measured.status = "incomplete";
    rows.push({ pass: pass + 1, warmup, ...measured });
  } } finally { await observer.close(); }
  const after = inspect(container);
  assert.ok(after.State.Running && after.State.StartedAt === app.State.StartedAt && after.RestartCount === app.RestartCount, "container restarted during diagnostic");
  return { schema: "json-transport-diagnostic/v1", container, image: app.Image, startedAt: app.State.StartedAt,
    cpuQuota: app.HostConfig.NanoCpus, cpuset: app.HostConfig.CpusetCpus, memoryBytes: app.HostConfig.Memory, payload, paths: cases.map((c) => c.path),
    codecConfiguration: { operatorDeclaration: codecConfiguration, independentlyVerified: false },
    comparison: "direct published application port; no external proxy; diagnostic only, not source qualification",
    ranges: summarize(rows), pairedDeltas: pairedDeltas(rows), rows };
}

// Differences within each rotated pass, never differences between independent medians.
export function pairedDeltas(rows) {
  const ranges = summarize(rows);
  return Object.fromEntries(arms.slice(1).map((arm) => {
    if (!ranges.identity || !ranges[arm]) return [arm, null];
    return [arm, rows.filter((r) => r.arm === arm).map((r) => {
      const base = rows.find((s) => s.pass === r.pass && s.arm === "identity");
      return { pass: r.pass, bodyBytesPerSuccess: r.bytesPerSuccess - base.bytesPerSuccess,
        cpuUsecPerSuccess: r.appCpuUsecPerSuccess - base.appCpuUsecPerSuccess,
        p99Ms: r.p99Ms - base.p99Ms, successfulRps: r.successfulRps - base.successfulRps };
    })];
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await run(process.argv.slice(2)), null, 2));
