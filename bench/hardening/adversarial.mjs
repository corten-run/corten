// Mutate a real retained native observation in memory. Never writes manufactured captures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assemble, artifacts, verifyArtifacts, digest } from "./evidence.mjs";
const folder = resolve(process.argv[2]);
const read = (name) => JSON.parse(readFileSync(join(folder, name), "utf8"));
verifyArtifacts(folder, read("manifest.json"));
const settings = read("settings.json"), deployment = read("deployment.json"), lifecycle = {};
for (const p of deployment.processes) lifecycle[p.id] = read(`${p.id}-lifecycle.json`);
const input = { settings, raw: readFileSync(join(folder, "raw.jsonl"), "utf8").trim().split("\n").map(JSON.parse), parity: read("parity.json"),
  source: read("qualification.json").source, cleanup: read("cleanup.json"), provenance: deployment.provenance, lifecycle };
assert.deepEqual(assemble(input), read("capture.json"));
const mutations = {
  "dropped attack": (v) => v.raw.splice(v.raw.findIndex((r) => r.type === "attack"), 1),
  "dropped legitimate request": (v) => v.raw.splice(v.raw.findIndex((r) => r.type === "legitimate"), 1),
  "late attack": (v) => v.raw.find((r) => r.type === "attack").startedAtMs += 2000,
  "incomplete native parity": (v) => v.parity.profiles.pop(),
  "broken injector": (v) => v.raw.find((r) => r.type === "probe-cleanup").errors.push("EMFILE"),
  "stalled host": (v) => v.raw.find((r) => r.type === "probe-cleanup").eventLoopMaxMs = 10000,
  "corrupt control": (v) => v.raw.find((r) => r.type === "control-before").observations[0].bytes++,
  "failed cleanup": (v) => v.cleanup.complete = false,
  "leaked native process": (v) => v.cleanup.containers.push("unreaped"),
  "wrong cleanup boot": (v) => v.cleanup.nativeClock.bootId = "another-boot",
  "invented CPU": (v) => Object.values(v.raw.find((r) => r.type === "resources").samples)[0].cpuSeconds++,
  "lost process sample": (v) => delete v.raw.find((r) => r.type === "resources").samples.application,
  "restarted target": (v) => v.lifecycle.application.after.State.StartedAt = new Date().toISOString(),
  "external target kill": (v) => v.lifecycle.application.events.push({ Action: "kill" }),
  "undeclared actual CPU": (v) => { v.lifecycle.application.before.HostConfig.NanoCpus *= 2; v.lifecycle.application.after.HostConfig.NanoCpus *= 2; },
  "undeclared actual memory": (v) => { v.lifecycle.application.before.HostConfig.Memory *= 2; v.lifecycle.application.after.HostConfig.Memory *= 2; },
  "undeclared swap": (v) => { v.lifecycle.application.before.HostConfig.MemorySwap *= 2; v.lifecycle.application.after.HostConfig.MemorySwap *= 2; },
  "weakened native task limit": (v) => { v.lifecycle.application.before.HostConfig.PidsLimit = 4096; v.lifecycle.application.after.HostConfig.PidsLimit = 4096; },
  "external configuration update": (v) => v.lifecycle.application.events.push({ Action: "update" }),
  "changed reviewed schedule": (v) => { const b = JSON.parse(v.settings.effectiveBudgets); b.attack.scheduledAtMs.pop(); v.settings.effectiveBudgets = JSON.stringify(b); },
};
if (input.raw.some((r) => r.type === "resources" && r.collectedAtMs !== undefined)) {
  mutations["resource collection outside window"] = (v) => v.raw.find((r) => r.type === "resources").collectedAtMs += 30000;
  mutations["namespace-hidden native PID"] = (v) => Object.values(v.raw.find((r) => r.type === "resources").samples)[0].procs = ["0"];
}
if (settings.nativeSource === "api") {
  mutations["missing timed API receipt"] = (v) => v.raw.splice(v.raw.findIndex((r) => r.type === "upstream-control-after"), 1);
  mutations["invalid timed API counters with matching hash"] = (v) => {
    const response = v.raw.find((r) => r.type === "upstream-control-after").response;
    const body = JSON.parse(response.body); body.requests.item_1 = -1;
    response.body = JSON.stringify(body); response.bytes = Buffer.byteLength(response.body); response.sha256 = digest(response.body);
  };
}
for (const [name, mutate] of Object.entries(mutations)) {
  const value = structuredClone(input); mutate(value); assert.throws(() => assemble(value), undefined, `accepted ${name}`); console.log(`rejected ${name}`);
}
assert.equal(artifacts(folder).length, read("manifest.json").length);
console.log(`rejected ${Object.keys(mutations).length} adversarial mutations of real native evidence`);
