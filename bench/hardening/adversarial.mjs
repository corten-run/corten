// Mutate a real retained native observation in memory. Never writes manufactured captures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assemble, artifacts, verifyArtifacts, digest, targetOutcome } from "./evidence.mjs";
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
  "successful HTTP 503": (v) => v.raw.find((r) => r.type === "legitimate" && r.ok).status = 503,
  "successful reset": (v) => v.raw.find((r) => r.type === "legitimate" && r.ok).error = "ECONNRESET",
  "successful timeout": (v) => v.raw.find((r) => r.type === "legitimate" && r.ok).timedOut = true,
  "successful partial body": (v) => v.raw.find((r) => r.type === "legitimate" && r.ok).bodyComplete = false,
  "invented response hash": (v) => v.raw.find((r) => r.type === "legitimate" && r.ok).bodySha256 = "a".repeat(64),
  "established attack without emitted work": (v) => { const r = v.raw.find((r) => r.type === "attack" && r.established); r.bytesQueued = 0; r.writes = 0; r.drips = 0; r.dripAtMs = []; },
  "substituted attack request": (v) => v.raw.find((r) => r.type === "attack").firstSha256 = "a".repeat(64),
  "wrong numeric record with matching byte receipt": (v) => {
    const row = v.raw.find((r) => r.type === "legitimate" && r.ok && r.path.startsWith("/api/"));
    const record = JSON.parse(Buffer.from(row.bodyBase64, "base64")); record.title = "not the requested native record";
    const body = Buffer.from(JSON.stringify(record)); row.bodyBase64 = body.toString("base64"); row.bodyBytes = body.length; row.bodySha256 = digest(body);
  },
};
if (["slow-headers", "slow-bodies"].includes(settings.phase)) mutations["retained slow connection without trickles"] = (v) => {
  const row = v.raw.find((r) => r.type === "attack" && r.established); row.drips = 0; row.dripAtMs = []; row.writes = 1; row.bytesQueued = row.firstBytes;
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
  mutations["zero timed API reads despite successful native service"] = (v) => {
    const response = v.raw.find((r) => r.type === "upstream-control-after").response;
    response.body = JSON.stringify({ status: 200, requests: {}, answers: {} }); response.bytes = Buffer.byteLength(response.body); response.sha256 = digest(response.body);
  };
}
const terminalExit = structuredClone(input), state = terminalExit.lifecycle.application.after.State;
state.Running = false; state.ExitCode = 137; state.OOMKilled = true;
state.FinishedAt = new Date(Date.parse(terminalExit.raw.find((r) => r.type === "clock").wallAtStart) + JSON.parse(settings.effectiveBudgets).legitimate.after.endMs - 100).toISOString();
const terminalCapture = assemble(terminalExit);
assert.notEqual(terminalCapture.recovery.disposition, "recovered");
assert.equal(targetOutcome(terminalCapture, { productionQualified: true }, { state: "observed" }).numericComparisonQualified, false);
console.log("retained late terminal exit as target-capacity-failure, not an invented stopped midpoint sample");
for (const [name, mutate] of Object.entries(mutations)) {
  const value = structuredClone(input); mutate(value); assert.throws(() => assemble(value), undefined, `accepted ${name}`); console.log(`rejected ${name}`);
}
assert.equal(artifacts(folder).length, read("manifest.json").length);
console.log(`rejected ${Object.keys(mutations).length} adversarial mutations of real native evidence`);
