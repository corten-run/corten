// Exactly two request processes. Only administration crosses IPC, never a record read.
import assert from "node:assert/strict";
import cluster from "node:cluster";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const timeoutMs = 5000;
const roles = ["coordinator", "worker-1", "worker-2"];
function identity(role) {
  const native = process.platform === "linux";
  const raw = native ? readFileSync("/proc/self/stat", "utf8") : null;
  const stat = native ? raw.slice(raw.lastIndexOf(")") + 2).split(" ") : null;
  return { role, pid: process.pid, start: native ? stat[19] : randomUUID(),
    boot: native ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() : "portable-test",
    cgroup: native ? readFileSync("/proc/self/cgroup", "utf8").trim() : "portable-test", native };
}
function recorder(id) {
  let samples = null, timer, deadline;
  const sample = () => {
    if (samples.length >= 700) throw new Error("worker observation bound exceeded");
    const beginNs = process.hrtime.bigint().toString(), cpu = process.cpuUsage();
    samples.push({ beginNs, endNs: process.hrtime.bigint().toString(), cpuUsec: cpu.user + cpu.system, wallMs: Date.now() });
  };
  const record = (command) => {
    if (command.op === "begin") {
      assert.equal(samples, null, "observation already active");
      assert.ok(Number.isInteger(command.seconds) && command.seconds >= 1 && command.seconds <= 300);
      samples = []; sample(); timer = setInterval(sample, 500);
      deadline = setTimeout(() => { throw new Error("worker observation deadline"); }, (command.seconds + 25) * 1000);
      return { identity: id };
    }
    if (command.op === "end") {
      assert.ok(samples, "observation not active"); clearInterval(timer); clearTimeout(deadline);
      // Merge a short tail into the preceding interval, rather than infer a peak from a few microseconds.
      if (samples.length > 1 && process.hrtime.bigint() - BigInt(samples.at(-1).beginNs) < 250000000n) samples.pop();
      sample();
      const result = { identity: id, samples }; samples = null; return result;
    }
    throw new Error("unknown worker observation command");
  };
  record.stop = () => { clearInterval(timer); clearTimeout(deadline); };
  return record;
}

export async function startWorkers(catalogServer) {
  if (cluster.isPrimary) return coordinator();
  const id = identity(`worker-${process.env.CATALOG_WORKER_SLOT}`), observe = recorder(id);
  let ready = false, frozen = false, epoch = 0, serial = 0;
  const queue = [], pending = new Map();
  const fatal = () => process.exit(1);
  const admin = {
    ready: () => ready,
    dispatch(req, res, handle) {
      if (!frozen) return handle(req, res);
      if (queue.length >= 1024) return fatal();
      queue.push(() => handle(req, res));
    },
    async control(req, send, observation = false) {
      if (!["GET", "POST"].includes(req.method)) return send(405, '{}');
      if (observation && req.method !== "POST") return send(405, '{}');
      let control;
      try {
        if (req.method === "POST") {
          let body = "";
          for await (const part of req) { body += part; if (body.length > 1024 * 1024) throw new Error("control body too large"); }
          control = JSON.parse(body);
          if (![200, 503].includes(control.status ?? 200)) throw new Error("invalid control");
          if (observation && !["begin", "end"].includes(control.observation)) throw new Error("invalid observation");
        }
      } catch { return send(400, '{}'); }
      if (pending.size >= 32) return fatal();
      const token = ++serial, timer = setTimeout(fatal, timeoutMs);
      pending.set(token, (result) => { clearTimeout(timer); send(200, JSON.stringify(result)); });
      process.send({ type: "admin", token, control, observation });
    },
  };
  const server = catalogServer(JSON.parse(readFileSync(process.env.CATALOG_FIXTURE_PATH ?? "/fixtures/catalog.json", "utf8")), admin);
  process.on("message", (m) => {
    try {
      if (m.type === "result") { const done = pending.get(m.token); assert.ok(done); pending.delete(m.token); done(m.result); return; }
      if (m.type === "ready") { ready = true; return; }
      if (m.type === "stop") { observe.stop(); server.close(() => process.disconnect()); server.closeAllConnections(); return; }
      let result;
      if (m.op === "freeze") { assert.equal(frozen, false); frozen = true; result = { ...server.catalogState(), epoch, identity: id }; }
      else if (m.op === "apply") { assert.ok(frozen); assert.equal(m.epoch, epoch + 1); server.catalogApply(m.control); epoch = m.epoch; result = { ...server.catalogState(), epoch, identity: id }; }
      else if (m.op === "resume") { assert.ok(frozen); frozen = false; result = { epoch, identity: id }; }
      else result = observe(m);
      process.send({ type: "ack", seq: m.seq, result });
      if (m.op === "resume") while (queue.length) queue.shift()();
    } catch { fatal(); }
  });
  process.on("disconnect", () => { observe.stop(); server.close(); server.closeAllConnections(); process.exit(pending.size ? 1 : 0); });
  server.on("error", fatal);
  server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () => process.send({ type: "listening", identity: id }));
}

function coordinator() {
  cluster.schedulingPolicy = cluster.SCHED_RR;
  const id = identity(roles[0]), observe = recorder(id), workers = [], identities = [], awaiting = new Map();
  let seq = 0, epoch = 0, ready = false, stopping = false, busy = 0, tail = Promise.resolve();
  const stop = (code) => {
    if (stopping) return;
    stopping = true; process.exitCode = code; clearTimeout(startup); observe.stop();
    for (const pending of awaiting.values()) clearTimeout(pending.timer);
    for (const w of workers) { if (code) w.kill(); else if (w.isConnected()) w.send({ type: "stop" }); }
    const force = setTimeout(() => { for (const w of workers) if (!w.isDead()) w.kill("SIGKILL"); }, 2000);
    force.unref();
  };
  const fatal = () => stop(1);
  const barrier = (command) => Promise.all(workers.map((w) => new Promise((resolve, reject) => {
    const key = ++seq, timer = setTimeout(() => { awaiting.delete(key); reject(new Error("worker acknowledgement deadline")); }, timeoutMs);
    awaiting.set(key, { worker: w, timer, done: (value) => { clearTimeout(timer); resolve(value); } });
    w.send({ ...command, seq: key });
  })));
  const startup = setTimeout(fatal, timeoutMs);
  for (let slot = 1; slot <= 2; slot++) {
    const w = cluster.fork({ CATALOG_WORKER_SLOT: String(slot) }); workers.push(w);
    w.on("error", fatal);
    w.on("disconnect", () => { if (!stopping) fatal(); });
    w.on("exit", () => { if (!stopping) fatal(); });
    w.on("message", (m) => {
      if (stopping) return;
      try {
        if (m.type === "listening") {
          assert.equal(m.identity.role, roles[slot]); assert.equal(m.identity.pid, w.process.pid); assert.equal(identities[slot], undefined);
          identities[slot] = m.identity;
          if (identities.filter(Boolean).length === 2) {
            ready = true; clearTimeout(startup);
            for (const child of workers) child.send({ type: "ready" });
            process.send?.({ type: "catalog-ready", identities: [id, ...identities.filter(Boolean)] });
          }
          return;
        }
        if (m.type === "ack") {
          const pending = awaiting.get(m.seq); assert.equal(pending?.worker, w); awaiting.delete(m.seq); pending.done(m.result); return;
        }
        assert.equal(m.type, "admin"); assert.ok(ready); assert.ok(++busy <= 32);
        tail = tail.then(async () => {
          let result;
          const op = m.observation ? m.control?.observation : undefined;
          if (op) {
            assert.ok(["begin", "end"].includes(op));
            const command = { op, seconds: m.control.seconds };
            result = { processes: [observe(command), ...await barrier(command)] };
          } else {
            let snapshots = await barrier({ op: "freeze" });
            if (m.control !== undefined) snapshots = await barrier({ op: "apply", epoch: ++epoch, control: m.control });
            assert.ok(snapshots.every((s) => s.epoch === epoch));
            assert.ok(snapshots.every((s) => s.status === snapshots[0].status && s.configuration === snapshots[0].configuration));
            const requests = {};
            for (const snapshot of snapshots) for (const [key, value] of Object.entries(snapshot.requests)) requests[key] = (requests[key] ?? 0) + value;
            result = { requests, status: snapshots[0].status, configuration: snapshots[0].configuration, epoch, workers: snapshots, coordinator: id };
            const resumed = await barrier({ op: "resume" }); assert.ok(resumed.every((s) => s.epoch === epoch));
          }
          w.send({ type: "result", token: m.token, result }); busy--;
        }).catch(fatal);
      } catch { fatal(); }
    });
  }
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { clearTimeout(startup); stop(0); });
}
