import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { selectedApps } from "../workloads/registry.mjs";
import { inventory, nativePorts, portFor, recordedInventory, scenarios, settingsFor, workloadFor } from "./native.mjs";
import { wireEvents, wireSnapshots } from "./wire.mjs";
import { fanoutProfile, verifyFanout } from "./fanout.mjs";
import { select, runRound, verifyArtifact } from "./parity.mjs";
import { verifyRound } from "./verify.mjs";

const delivery = new URL("./evidence/native-delivery/", import.meta.url);
const recovery = new URL("../recoverable-live/evidence/native-recovery/", import.meta.url);
const fanout = new URL("./evidence/native-fanout/", import.meta.url);
const artifact = async (name = "express-normal", base = delivery) => JSON.parse(gunzipSync(await readFile(new URL(`${name}.json.gz`, base))));
const verify = (a) => verifyArtifact(a, { app: a.app, group: a.group, scenario: a.scenario });
async function measured() {
  const a = await artifact("express-fanout-4", fanout), normal = await artifact("express-normal", fanout);
  const qualification = JSON.parse(await readFile(new URL("express-artifacts.json", fanout), "utf8")).files;
  return { a, expected: { app: "express", group: "live-delivery", provenance: normal.provenance,
    qualification, settings: normal.settings } };
}

test("native inventory preserves every registry member and never borrows historical transport parity", () => {
  for (const group of ["live-delivery", "recoverable-live"]) {
    assert.deepEqual(inventory(group).map((r) => r.app), selectedApps(group));
    assert.deepEqual(select(group), selectedApps(group));
    for (const missing of inventory(group).filter((r) => !nativePorts[r.app])) {
      assert.equal(missing.implementation, "not-implemented"); assert.match(missing.reason, /transport-only code is not parity/);
    }
  }
  assert.throws(() => select("recoverable-live", "express"), /unselected/);
  for (const apps of ["", "express,express", "none", "express,", "all"]) assert.throws(() => select("live-delivery", apps));
});

test("entry imports have no historical load side effects; explicit round is mandatory", async () => {
  assert.equal(typeof (await import("./run.mjs")).run, "function");
  assert.equal(typeof (await import("../recoverable-live/run.mjs")).run, "function");
  for (const args of [[], ["../escape"], ["."], ["round", "--typo"], {}]) {
    await assert.rejects(runRound("live-delivery", args));
  }
});

test("native Feed limits require an explicit equal-work alternative, never a hidden default", () => {
  assert.equal(workloadFor().eventCount, 24);
  assert.equal(settingsFor("live-delivery", "slow-reader").queueLimit, 2);
  assert.equal(portFor("corten"), undefined);
  assert.match(inventory("live-delivery").find((r) => r.app === "corten").reason, /explicit --profile native-feed/);
  assert.equal(workloadFor("native-feed").eventCount, 1044);
  assert.equal(settingsFor("live-delivery", "slow-reader", "native-feed").queueLimit, 1024);
  assert.equal(settingsFor("recoverable-live", "expired-cursor", "native-feed").historyLimit, 1025);
  assert.equal(portFor("corten", "native-feed").wire, "corten-feed");
  assert.throws(() => workloadFor("typo"), /unknown live profile/);
});

test("recorded missing implementations remain missing after native ports are added", () => {
  const beforeCorten = inventory("live-delivery", "bounded", 1);
  assert.equal(beforeCorten.find((r) => r.app === "corten").implementation, "not-implemented");
  assert.equal(inventory("live-delivery").find((r) => r.app === "corten").implementation, "implemented");
  assert.deepEqual(recordedInventory("live-delivery", beforeCorten, "bounded", 2), beforeCorten);
  assert.throws(() => recordedInventory("live-delivery", beforeCorten.slice(1), "bounded", 2), /lost a candidate/);
});

test("Corten binding checks actual native keyed operations, not just event metadata", () => {
  const event = workloadFor().events[0];
  const data = { seq: event.seq, changes: [{ op: "upsert", id: event.key, value: event.row }], event };
  const raw = [{ kind: "native-sse", eventName: "patch", data: JSON.stringify(data) }];
  assert.deepEqual(wireEvents(raw, "corten-feed"), [event]);
  data.changes[0].value = { ...event.row, quantity: 999 };
  raw[0].data = JSON.stringify(data);
  assert.throws(() => wireEvents(raw, "corten-feed"), /native keyed patch/);
  assert.throws(() => wireEvents(raw, "unreviewed"), /unregistered/);
  assert.deepEqual(wireSnapshots([{ kind: "response", status: 200, url: "http://local/parity/snapshot",
    body: JSON.stringify({ epoch: "native", seq: 0, rows: [event.row] }) }], "corten-feed"),
  [{ through: 0, rows: [event.row], work: { reads: 1, rows: 1 } }]);
});

test("actual native browser artifacts revalidate, including all recovery fault paths", async () => {
  for (const app of ["express", "aspnet", "gin"]) for (const scenario of scenarios("live-delivery")) verify(await artifact(`${app}-${scenario}`));
  for (const scenario of scenarios("recoverable-live")) verify(await artifact(`aspnet-${scenario}`, recovery));
  const a = await verifyRound(delivery), b = await verifyRound(recovery);
  assert.deepEqual(a.passed, ["aspnet", "express", "gin"]);
  assert.deepEqual(b.passed, ["aspnet"]);
  assert.equal(a.readyForLoad, false); assert.equal(b.readyForLoad, false);
});

test("actual qualified native fan-out retains CPU/memory, visible latency and honest failed candidates", async () => {
  const round = await verifyRound(fanout);
  assert.equal(round.readyForLoad, false);
  const ledger = JSON.parse(await readFile(new URL("coverage.json", fanout), "utf8"));
  assert.equal(ledger.cells.find((r) => r.app === "express").measurement, "complete");
  assert.equal(ledger.cells.find((r) => r.app === "aspnet").measurement, "failed");
  assert.equal(ledger.cells.find((r) => r.app === "gin").parity, "failed");
  const { a, expected } = await measured();
  assert.equal(verifyFanout(a, expected).deliveredEffects, 240);
  assert.ok(a.summary.serverCpuUs > 0 && a.summary.serverMemoryCurrentBytes > 0 && a.summary.visibleLatencyP95Ms > 0);
  assert.deepEqual(a.profile, fanoutProfile);
});

test("fresh Gin native delivery and all measured fan-out levels revalidate independently of its earlier build timeout", async () => {
  const directory = new URL("./evidence/native-fanout-gin/", import.meta.url);
  const round = await verifyRound(directory);
  assert.deepEqual(round.passed, ["gin"]);
  assert.equal(round.readyForLoad, false);
  const ledger = JSON.parse(await readFile(new URL("coverage.json", directory), "utf8"));
  assert.equal(ledger.cells.find((r) => r.app === "gin").measurement, "complete");
});

for (const [name, mutate] of [
  ["lost fan-out browser", (a) => a.browsers.pop()],
  ["wrong qualification", (a) => a.qualification.pop()],
  ["wrong native image", (a) => { a.provenance.imageId = "wrong"; }],
  ["forged CPU counter", (a) => { a.kernel.after.cpuUsageUs++; }],
  ["forged memory peak", (a) => { a.kernel.after.memoryPeakBytes++; }],
  ["missing visible frames", (a) => { a.browsers[0].frames = []; }],
  ["publisher missed offered rate", (a) => { a.schedule[0].startedAt += 1000; }],
  ["publisher offered cadence changed", (a) => { a.schedule[1].scheduledAt++; }],
  ["missing raw fan-out acknowledgement", (a) => { a.browsers[0].network = a.browsers[0].network.filter((r) => r.kind !== "response" || !r.url.endsWith("/parity/publish")); }],
  ["missing raw fan-out publication", (a) => { a.browsers[0].network = a.browsers[0].network.filter((r) => r.kind !== "request" || !r.url.endsWith("/parity/publish")); }],
  ["impossible visible version", (a) => { a.browsers[0].frames[0].through = 10000; }],
  ["duplicate effect", (a) => { a.browsers[0].records.find((r) => r.kind === "event").effectCount++; }],
  ["native wire removed", (a) => { a.browsers[0].network = []; }],
  ["lost reader cleanup", (a) => { a.resources.released.subscriptions = 1; }],
  ["fabricated aggregate", (a) => { a.summary.deliveredEffects++; }],
  ["larger unreviewed latency budget", (a) => { a.settings.cleanupObservationMs = 1; }],
]) test(`rejects actual native fan-out mutated with ${name}`, async () => {
  const { a, expected } = await measured(); mutate(a); assert.throws(() => verifyFanout(a, expected));
});

const mutations = [
  ["altered DOM row", (a) => { a.capture.records.find((r) => r.kind === "event").state[0].priceCents++; }],
  ["duplicate application effect count", (a) => { a.capture.records.find((r) => r.kind === "event" && r.disposition === "duplicate").effectCount++; }],
  ["missing final delivery", (a) => { a.capture.records = a.capture.records.filter((r) => r.kind !== "event" || r.event.seq !== 24); }],
  ["unbounded queue peak", (a) => { a.capture.records.find((r) => r.kind === "resources").queuePeak = 3; }],
  ["leaked native writer task", (a) => { a.capture.records.filter((r) => r.kind === "resources").at(-1).pendingTasks = 1; }],
  ["short cleanup observation", (a) => { a.settings.cleanupObservationMs = 1; }],
  ["forged aggregate", (a) => { a.summary.appliedEffects--; }],
  ["missing native transport", (a) => { a.network = a.network.filter((r) => r.kind !== "native-sse"); }],
  ["wire differs from application event", (a) => { a.network.find((r) => r.kind === "native-sse" && r.eventName === "update").data = "{}"; }],
  ["missing publication HTTP acknowledgement", (a) => { a.network = a.network.filter((r) => r.kind !== "response" || !r.url.endsWith("/parity/publish")); }],
  ["wrong raw snapshot", (a) => { a.network.find((r) => r.kind === "response" && r.url.endsWith("/parity/snapshot")).body = "{}"; }],
  ["borrowed image", (a) => { a.provenance.imageId = "latest"; }],
  ["unreviewed CPU budget", (a) => { a.provenance.container.nanoCpus *= 2; }],
  ["unimplemented native app label", (a) => { a.app = "phoenix"; }],
  ["changed native source binding", (a) => { a.provenance.imageSourceSha256 = "0".repeat(64); }],
  ["changed fixture", (a) => { a.workload.seed++; }],
  ["cross-group capture", (a) => { a.capture.contract = "recoverable-live/v1"; }],
];
for (const [name, mutate] of mutations) test(`rejects real capture mutated with ${name}`, async () => {
  const a = await artifact(); mutate(a); assert.throws(() => verify(a));
});

test("slow-reader labels cannot replace observed native queue saturation", async () => {
  const a = await artifact("express-slow-reader");
  for (const r of a.capture.records) if (r.kind === "resources") r.queueEvents = 0;
  assert.throws(() => verify(a), /saturation/);
});

test("expired cursors must perform an actual authoritative snapshot and account its work", async () => {
  const a = await artifact("aspnet-expired-cursor", recovery);
  a.capture.records.filter((r) => r.kind === "snapshot").at(-1).work.reads = 0;
  assert.throws(() => verify(a), /snapshot work/);
});

for (const mutation of ["drop-candidate", "invent-native-port", "alter-artifact-hash", "claim-load-ready", "change-saved-plan", "change-source-diff"]) {
  test(`round ledger rejects ${mutation}`, async () => {
    const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, "live-evidence-test-"));
    try {
      await cp(delivery, directory, { recursive: true });
      const ledgerFile = join(directory, "coverage.json"), ledger = JSON.parse(await readFile(ledgerFile, "utf8"));
      if (mutation === "drop-candidate") ledger.cells = ledger.cells.filter((c) => c.app !== "phoenix");
      if (mutation === "invent-native-port") { const c = ledger.cells.find((c) => c.app === "phoenix"); c.implementation = "implemented"; c.parity = "passed"; }
      if (mutation === "claim-load-ready") ledger.readyForLoad = true;
      await writeFile(ledgerFile, JSON.stringify(ledger));
      if (mutation === "alter-artifact-hash") {
        const file = join(directory, "express-artifacts.json"), manifest = JSON.parse(await readFile(file, "utf8"));
        manifest.files[0].sha256 = "0".repeat(64); await writeFile(file, JSON.stringify(manifest));
      }
      if (mutation === "change-saved-plan") {
        const file = join(directory, "plan.json"), plan = JSON.parse(await readFile(file, "utf8"));
        plan.apps.pop(); await writeFile(file, JSON.stringify(plan));
      }
      if (mutation === "change-source-diff") await writeFile(join(directory, "source.diff.gz"), "corrupt");
      await assert.rejects(verifyRound(directory));
    } finally {
      assert.ok(resolve(directory).startsWith(parent + sep) && directory.includes("live-evidence-test-"));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
