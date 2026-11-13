import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { wireResources } from "./wire.mjs";

export function verifyResourceBounds(r, clients, settings) {
  for (const key of ["subscriptions", "connections", "pendingTasks", "queueEvents", "queuePeak", "historyEvents", "historyPeak"]) {
    assert.ok(Number.isSafeInteger(r[key]) && r[key] >= 0, `missing native resource ${key}`);
  }
  for (const key of ["subscriptions", "connections", "pendingTasks"]) assert.ok(r[key] <= clients, `native resource ${key} exceeded reader budget`);
  assert.equal(r.queueLimit, settings.queueLimit); assert.equal(r.historyLimit, settings.historyLimit);
  assert.ok(r.queuePeak <= settings.queueLimit && r.queueEvents <= clients * r.queuePeak, "native resource queue exceeded budget/peak");
  assert.ok(r.historyEvents <= r.historyPeak && r.historyPeak <= settings.historyLimit, "native resource history exceeded budget/peak");
}

export function verifyResourceLifecycle(records, clients, settings) {
  const owned = ["subscriptions", "connections", "pendingTasks", "queueEvents"];
  let detached = false, quiescent = false, queuePeak = 0, historyPeak = 0;
  for (const [i, r] of records.entries()) {
    if (r.kind === "detach") detached = true;
    if (r.kind === "publish") for (const key of ["subscriptions", "connections", "pendingTasks"]) {
      assert.equal(records[i + 1]?.[key], clients, `native publication resource ${key} omitted a live reader`);
    }
    if (r.kind !== "resources") continue;
    verifyResourceBounds(r, clients, settings);
    assert.ok(r.queuePeak >= queuePeak && r.historyPeak >= historyPeak, "native resource peak regressed");
    queuePeak = r.queuePeak; historyPeak = r.historyPeak;
    const zero = owned.every((k) => r[k] === 0);
    assert.ok(!quiescent || zero, "native resources resurrected after post-detach zero");
    if (detached && zero) quiescent = true;
  }
}

// Acknowledgement barriers can reorder native callbacks against HTTP responses.
// Preserve each raw source's order without assuming one cross-transport clock.
export function verifyResources(records, network, wire) {
  const http = [], acks = [];
  for (const r of network.filter((r) => r.kind === "response")) {
    const path = new URL(r.url).pathname;
    if (!["/parity/resources", "/parity/publish"].includes(path)) continue;
    assert.equal(r.status, 200, "resource HTTP response failed");
    const body = JSON.parse(r.body);
    if (path === "/parity/resources") http.push(body);
    else acks.push(...(body.acks ?? [body]));
  }
  const native = wireResources(network, wire), observed = [];
  let ack = 0;
  const payload = ({ kind, at, ...r }) => r;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (["publish", "cleanup-probe"].includes(r.kind)) {
      const raw = acks[ack++], next = records[++i];
      assert.ok(raw && next?.kind === "resources", "publication resource acknowledgement missing");
      assert.equal(raw.seq, r.seq ?? r.event.seq, "resource acknowledgement sequence differs");
      assert.deepEqual(payload(next), raw.resources, "resource acknowledgement differs from raw HTTP counters");
    } else if (r.kind === "resources") observed.push(payload(r));
  }
  assert.equal(ack, acks.length, "unrecorded raw resource acknowledgement");
  assert.equal(observed.length, http.length + native.length, "raw resource observation count differs");
  let states = new Set([0]);
  for (const [k, r] of observed.entries()) {
    const next = new Set();
    for (const i of states) {
      const j = k - i;
      if (i < http.length && isDeepStrictEqual(r, http[i])) next.add(i + 1);
      if (j < native.length && isDeepStrictEqual(r, native[j])) next.add(i);
    }
    assert.ok(next.size, "recorded resource counters differ from raw HTTP/native wire observations");
    states = next;
  }
  assert.ok(states.has(http.length), "raw resource observations were not exhausted");
}
