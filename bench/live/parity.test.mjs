import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { selectedApps } from "../workloads/registry.mjs";
import { inventory, nativePorts, scenarios } from "./native.mjs";
import { select, runRound, verifyArtifact } from "./parity.mjs";
import { verifyRound } from "./verify.mjs";

const delivery = new URL("./evidence/native-delivery/", import.meta.url);
const recovery = new URL("../recoverable-live/evidence/native-recovery/", import.meta.url);
const artifact = async (name = "express-normal", base = delivery) => JSON.parse(gunzipSync(await readFile(new URL(`${name}.json.gz`, base))));
const verify = (a) => verifyArtifact(a, { app: a.app, group: a.group, scenario: a.scenario });

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

test("actual native browser artifacts revalidate, including all recovery fault paths", async () => {
  for (const app of ["express", "aspnet", "gin"]) for (const scenario of scenarios("live-delivery")) verify(await artifact(`${app}-${scenario}`));
  for (const scenario of scenarios("recoverable-live")) verify(await artifact(`aspnet-${scenario}`, recovery));
  const a = await verifyRound(delivery), b = await verifyRound(recovery);
  assert.deepEqual(a.passed, ["aspnet", "express", "gin"]);
  assert.deepEqual(b.passed, ["aspnet"]);
  assert.equal(a.readyForLoad, false); assert.equal(b.readyForLoad, false);
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
