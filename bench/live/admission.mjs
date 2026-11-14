import assert from "node:assert/strict";

export function negativeRequests(workload, profile) {
  const first = workload.events[0];
  return [{ event: { ...first, seq: 10000 } }, ...(profile === "native-feed" ? [
    { event: first, events: [first] },
    { events: [first, { ...workload.events[1], seq: 10000 }] }, { events: [] },
  ] : [])];
}

export function verifyIdentity(p) {
  const hashes = (value) => {
    assert.ok(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length,
      "nonempty native source identity required");
    for (const [key, v] of Object.entries(value)) {
      assert.ok(key.length && !key.split(/[\\/]/).includes(".."), "invalid native source identity path");
      if (typeof v === "object") hashes(v);
      else assert.match(v, /^[a-f0-9]{64}$/, "invalid native source identity digest");
    }
  };
  hashes(p.sourceHashes);
  assert.match(p.containerId ?? "", /^[a-f0-9]{64}$/, "native container identity required");
  assert.ok(typeof p.processTopology === "string" && p.processTopology.trim(), "native topology provenance required");
  assert.match(p.processInventory ?? "", /^PID\s+PPID\s+COMMAND\r?\n\s*\d+\s+\d+\s+\S+/,
    "native process inventory provenance required");
}

export function verifyScenario(records, settings, ready) {
  assert.deepEqual(ready[0], { from: 0, status: "accepted" }, "scenario initial native cursor acknowledgement differs");
  const resumes = records.filter((r) => r.kind === "resume");
  let i = 1;
  for (const r of resumes) {
    while (i < ready.length && (ready[i].from !== r.from || ready[i].status !== r.status)) i++;
    assert.ok(i < ready.length, "scenario resume differs from raw native cursor acknowledgement");
    i++;
  }
  if (!["disconnect", "missed-updates", "expired-cursor"].includes(settings.scenario)) return;
  assert.equal(records.filter((r) => r.kind === "disconnect" && r.reason === "forced").length, 1, "scenario forced disconnect count differs");
  const disconnected = records.findIndex((r) => r.kind === "disconnect");
  const attached = records.findIndex((r, i) => i > disconnected && r.kind === "attach");
  assert.ok(disconnected >= 0 && attached > disconnected, "scenario missing reconnect window");
  const missed = records.slice(disconnected + 1, attached).filter((r) => r.kind === "publish");
  const count = settings.scenario === "disconnect" ? 1 : settings.scenario === "missed-updates" ? 3 : settings.historyLimit + 2;
  assert.deepEqual(missed.map((r) => r.seq), Array.from({ length: count }, (_, i) => i + 2), "scenario missed native publication work differs");
  assert.equal(resumes[0]?.status, settings.scenario === "expired-cursor" ? "expired" : "accepted", "scenario cursor outcome differs");
}
