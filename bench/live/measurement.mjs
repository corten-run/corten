import assert from "node:assert/strict";
import { verifyIdentity } from "./admission.mjs";

export const inspectFormat = '{"id":{{json .Id}},"image":{{json .Image}},"pid":{{.State.Pid}},"startedAt":{{json .State.StartedAt}},"ports":{{json .NetworkSettings.Ports}}}';
export const kernelCommand = (id, phase) => `echo INTERVAL ${id} ${phase}; cat /sys/fs/cgroup/cpu.stat; echo MEMORY; cat /sys/fs/cgroup/memory.current; cat /sys/fs/cgroup/memory.peak`;
const finite = (v) => assert.ok(Number.isFinite(v) && v >= 0, "measurement clock binding missing");

export function verifyMeasurementBindings(a) {
  assert.equal(a.schema, "native-live-fanout/v2", "measurement binding unavailable in historical capture; fresh native capture required");
  verifyIdentity(a.provenance);
  const p = a.provenance, host = a.host, interval = a.interval;
  finite(host?.timeOrigin);
  assert.match(interval?.id ?? "", /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, "kernel interval identity missing");
  assert.equal(interval.clients, a.clients, "kernel interval fan-out differs");
  const instances = [];
  for (const phase of ["before", "after"]) {
    const k = a.kernel[phase], r = k.receipt, instance = r?.instance;
    assert.deepEqual(r?.request, { program: "docker", args: ["exec", p.containerId, "sh", "-c", kernelCommand(interval.id, phase)] }, "kernel source/interval binding differs");
    assert.equal(r.status, 0); assert.equal(r.stdout, k.raw, "kernel raw receipt differs");
    assert.ok(k.raw.startsWith(`INTERVAL ${interval.id} ${phase}\n`), "kernel native interval marker differs");
    assert.deepEqual(instance?.request, { program: "docker", args: ["inspect", "--format", inspectFormat, p.containerId] }, "kernel instance receipt differs");
    assert.equal(instance.status, 0);
    const observed = JSON.parse(instance.stdout); instances.push(observed);
    assert.equal(observed.id, p.containerId); assert.equal(observed.image, p.imageId, "kernel source image differs");
    assert.ok(p.processInventory.split(/\r?\n/).slice(1).some((line) => Number(line.trim().split(/\s+/)[0]) === observed.pid), "kernel source process differs");
    const endpoint = new URL(host.base);
    assert.equal(endpoint.origin, `http://127.0.0.1:${observed.ports["8080/tcp"][0].HostPort}`, "resource endpoint differs from native instance");
    for (const v of [r.startedAt, r.finishedAt, instance.startedAt, instance.finishedAt]) finite(v);
    assert.ok(instance.startedAt <= instance.finishedAt && instance.finishedAt <= r.startedAt && r.startedAt <= r.finishedAt, "kernel receipt clock order differs");
  }
  assert.deepEqual(instances[0], instances[1], "kernel native instance restarted during interval");
  assert.equal(interval.startedAt, a.kernel.before.receipt.startedAt);
  assert.equal(interval.finishedAt, a.kernel.after.receipt.finishedAt);
  assert.ok(a.kernel.before.receipt.finishedAt <= a.schedule[0].startedAt
    && a.kernel.after.receipt.startedAt >= a.schedule.at(-1).finishedAt, "kernel interval does not cover native publications");
  assert.ok(host.timeOrigin + interval.startedAt >= Date.parse(instances[0].startedAt), "kernel source was not running during interval");
  const contexts = new Set(), targets = new Set(), streams = new Set();
  for (const b of a.browsers) {
    const identity = b.identity, target = identity?.receipt?.targetInfo;
    assert.ok(target?.targetId && target.browserContextId, "native reader identity receipt missing");
    assert.equal(identity.targetId, target.targetId); assert.equal(identity.contextId, target.browserContextId);
    assert.ok(!contexts.has(identity.contextId) && !targets.has(identity.targetId), "duplicate native reader identity");
    contexts.add(identity.contextId); targets.add(identity.targetId);
    const ids = new Set(b.network.filter((r) => ["native-sse", "native-websocket-created"].includes(r.kind)).map((r) => r.requestId));
    assert.ok(ids.size, "native reader transport identity missing");
    for (const id of ids) { assert.ok(id && !streams.has(id), "duplicate native reader transport identity"); streams.add(id); }
  }
  assert.ok(Array.isArray(host.requests) && host.requests.length >= 4, "raw host request receipts missing");
  let configured = 0;
  for (const [i, r] of host.requests.entries()) {
    finite(r.startedAt); finite(r.finishedAt);
    assert.ok(r.startedAt <= r.finishedAt && (!i || r.startedAt >= host.requests[i - 1].finishedAt), "raw host receipt clock order differs");
    assert.equal(r.status, 200);
    if (r.phase === "configure") {
      configured++;
      assert.equal(i, 0);
      assert.deepEqual(r.request, { method: "POST", url: `${host.base}/parity/configure`, body: JSON.stringify({
        initial: a.workload.initial, queueLimit: a.settings.queueLimit, historyLimit: a.settings.historyLimit }) }, "raw host configuration request differs");
      assert.deepEqual(JSON.parse(r.body), a.configuration, "raw host configuration response differs");
      assert.equal(a.configuration.framework, a.app); assert.equal(a.configuration.configured, true);
    } else {
      assert.ok(["attach-poll", "delivered", "released"].includes(r.phase), "unrecognized host resource receipt");
      assert.deepEqual(r.request, { method: "GET", url: `${host.base}/parity/resources` }, "raw host resource request differs");
      const resources = JSON.parse(r.body);
      for (const key of ["subscriptions", "connections", "pendingTasks", "queueEvents", "queuePeak", "historyEvents", "historyPeak"]) {
        assert.ok(Number.isSafeInteger(resources[key]) && resources[key] >= 0, "raw host resource counter missing");
      }
      assert.equal(resources.queueLimit, a.settings.queueLimit); assert.equal(resources.historyLimit, a.settings.historyLimit);
      assert.ok(resources.queuePeak <= a.settings.queueLimit && resources.queueEvents <= a.clients * a.settings.queueLimit
        && resources.historyEvents <= a.settings.historyLimit && resources.historyPeak <= a.settings.historyLimit, "raw host resource budget exceeded");
    }
  }
  assert.equal(configured, 1, "raw host configuration receipt missing");
  for (const phase of ["attached", "delivered", "released"]) {
    const index = a.resourceObservations?.[phase], r = host.requests?.[index];
    assert.ok(Number.isSafeInteger(index) && r, "raw host resource receipt missing");
    assert.deepEqual(r.request, { method: "GET", url: `${host.base}/parity/resources` }, "raw host resource source differs");
    assert.equal(r.phase, phase === "attached" ? "attach-poll" : phase);
    assert.equal(r.status, 200); finite(r.startedAt); finite(r.finishedAt);
    assert.ok(r.startedAt <= r.finishedAt, "resource receipt clock regressed");
    assert.deepEqual(JSON.parse(r.body), a.resources[phase], "raw host resource counters differ");
    if (phase === "attached") assert.ok(r.finishedAt <= interval.startedAt, "resource attachment receipt is outside interval");
    if (phase === "delivered") assert.ok(r.startedAt >= interval.finishedAt, "resource delivery receipt is outside interval");
    if (phase === "released") for (const b of a.browsers) assert.ok(host.timeOrigin + r.startedAt >= b.timeOrigin + b.records.at(-1).at, "resource cleanup receipt predates browser cleanup");
  }
  const publisher = a.browsers[0], publications = publisher.records.filter((r) => r.kind === "publish");
  for (const [i, r] of a.schedule.entries()) {
    finite(r.finishedAt);
    assert.ok(r.finishedAt >= r.startedAt, "publication clock binding regressed");
    const browserStarted = publisher.timeOrigin + publications[i].startedAt - host.timeOrigin;
    assert.ok(browserStarted >= r.startedAt - 2 && browserStarted <= r.finishedAt + 2, "publication clock binding differs from actual browser start");
    assert.ok(browserStarted - r.scheduledAt <= a.profile.maxScheduleLagMs, "browser missed offered cadence");
  }
}
