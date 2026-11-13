import assert from "node:assert/strict";
import { nativePorts } from "./native.mjs";

const bindings = new Map();
for (const port of Object.values(nativePorts)) if (port.wireModule) {
  const binding = await import(new URL(port.wireModule, import.meta.url));
  assert.equal(typeof binding.wireEvents, "function");
  assert.equal(typeof binding.wireSnapshots, "function");
  bindings.set(port.wire, binding);
}

// Raw native bindings only. These never produce application state/effects.
export function wireEvents(network, wire = "event-sse") {
  if (bindings.has(wire)) return bindings.get(wire).wireEvents(network);
  assert.ok(["event-sse", "corten-feed"].includes(wire), "unregistered native wire binding");
  const eventName = wire === "corten-feed" ? "patch" : "update";
  return network.filter((r) => r.kind === "native-sse" && r.eventName === eventName).map((r) => {
    const data = JSON.parse(r.data);
    if (wire !== "corten-feed") return data;
    const event = data.event;
    assert.equal(data.seq, event.seq, "native patch sequence differs from application event");
    assert.deepEqual(data.changes, [event.op === "remove" ? { op: "remove", id: event.key }
      : { op: "upsert", id: event.key, value: event.row }], "native keyed patch differs from application event");
    return event;
  });
}

export function wireSnapshots(network, wire = "event-sse") {
  if (bindings.has(wire)) return bindings.get(wire).wireSnapshots(network);
  assert.ok(["event-sse", "corten-feed"].includes(wire), "unregistered native wire binding");
  return network.filter((r) => r.kind === "response" && new URL(r.url).pathname === "/parity/snapshot").map((r) => {
    assert.equal(r.status, 200); const data = JSON.parse(r.body);
    if (wire !== "corten-feed") return data;
    assert.equal(typeof data.epoch, "string");
    return { through: data.seq, rows: data.rows, work: { reads: 1, rows: data.rows.length } };
  });
}
