import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { wireResources } from "./wire.mjs";

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
