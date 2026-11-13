import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { browserJourney, verifyArtifact } from "./parity.mjs";
import { verifyFanout } from "./fanout.mjs";
import { settingsFor, workloadFor } from "./native.mjs";
import { validateLiveCapture } from "../workloads/live.mjs";
import { verifyRound } from "./verify.mjs";

const load = async (path) => JSON.parse(gunzipSync(await readFile(new URL(path, import.meta.url))));
const verify = (a) => verifyArtifact(a, { app: a.app, group: a.group, scenario: a.scenario });
const recovery = "../recoverable-live/evidence/native-feed-aspnet/aspnet-";
async function measured() {
  const a = await load("./evidence/review-v2-express/express-fanout-4.json.gz");
  return { a, expected: { app: a.app, group: a.group, provenance: a.provenance, qualification: a.qualification, settings: a.settings } };
}

for (const scenario of ["normal", "disconnect", "missed-updates", "gap"]) test(`reject duplicated single negative control in historical Corten ${scenario}`, async () => {
  const a = await load(`../recoverable-live/evidence/native-recovery-timing-limit/corten-${scenario}.json.gz`);
  a.controls = Array.from({ length: 4 }, () => structuredClone(a.controls[0]));
  assert.throws(() => verify(a), /negative native publication control/);
});

test("source identity cannot be the hash of an empty inventory", async () => {
  const a = await load("./evidence/native-fanout/express-normal.json.gz");
  a.provenance.sourceHashes = {};
  a.provenance.sourceSha256 = a.provenance.imageSourceSha256 = createHash("sha256").update("{}").digest("hex");
  for (const k of ["containerId", "processTopology", "processInventory"]) delete a.provenance[k];
  assert.throws(() => verify(a), /identity|provenance/);
});

test("disconnect cannot be relabeled as the three-write missed-updates scenario", async () => {
  const a = await load(recovery + "disconnect.json.gz");
  a.scenario = a.settings.scenario = "missed-updates";
  a.summary = validateLiveCapture(a.workload, a.capture, a.settings);
  assert.throws(() => verify(a), /scenario/);
});

test("expired native resume cannot be relabeled accepted", async () => {
  const a = await load(recovery + "expired-cursor.json.gz");
  a.capture.records.find((r) => r.kind === "resume").status = "accepted";
  a.scenario = a.settings.scenario = "missed-updates";
  a.summary = validateLiveCapture(a.workload, a.capture, a.settings);
  assert.throws(() => verify(a), /scenario/);
});

test("newPage rejection closes the context rather than leaving its deadline alive", async () => {
  let closed = 0;
  const context = { newPage: async () => { throw new Error("newPage rejected"); }, close: async () => { closed++; } };
  await assert.rejects(browserJourney({ newContext: async () => context }, "http://local", workloadFor(), settingsFor("live-delivery", "normal")), /newPage rejected/);
  assert.equal(closed, 1);
});

test("four copies of one reader cannot qualify 240 effects", async () => {
  const { a, expected } = await measured();
  a.browsers = Array.from({ length: 4 }, () => structuredClone(a.browsers[0]));
  delete a.summary;
  assert.throws(() => verifyFanout(a, expected), /reader|binding/);
});

test("an unrelated regular host schedule cannot qualify browser publication cadence", async () => {
  const { a, expected } = await measured();
  a.schedule = a.schedule.map((r, i) => ({ seq: r.seq, scheduledAt: 50 + i * 50, startedAt: 50 + i * 50 }));
  assert.throws(() => verifyFanout(a, expected), /clock|binding|interval/);
});

test("cleanup is bounded from detach, not just observed eventually", async () => {
  const { a, expected } = await measured();
  for (const b of a.browsers) {
    const detach = b.records.find((r) => r.kind === "detach");
    for (const r of b.records) if (r.at > detach.at) r.at += 30000;
  }
  assert.throws(() => verifyFanout(a, expected), /cleanup|binding/);
});

test("another application's kernel interval cannot qualify Express CPU", async () => {
  const { a, expected } = await measured();
  const other = await load("./evidence/native-feed-peers/aspnet-fanout-4.json.gz");
  a.kernel = other.kernel; delete a.summary;
  assert.throws(() => verifyFanout(a, expected), /kernel|binding/);
});

test("attached counters cannot substitute for a delivered raw HTTP resource receipt", async () => {
  const { a, expected } = await measured();
  a.resources.delivered = structuredClone(a.resources.attached);
  assert.throws(() => verifyFanout(a, expected), /resource|binding/);
});

test("legacy kernel/resource captures cannot qualify by copying the v2 schema", async () => {
  const a = await load("./evidence/native-fanout/express-fanout-4.json.gz");
  const expected = { app: a.app, group: a.group, provenance: a.provenance, qualification: a.qualification, settings: a.settings };
  assert.throws(() => verifyFanout(a, expected), /historical capture/);
  a.schema = "native-live-fanout/v2";
  assert.throws(() => verifyFanout(a, expected), /binding/);
});

for (const field of ["containerId", "processTopology", "processInventory"]) test(`native ${field} provenance is mandatory`, async () => {
  const a = await load("./evidence/native-fanout/express-normal.json.gz");
  delete a.provenance[field];
  assert.throws(() => verify(a), /identity|provenance/);
});

for (const change of ["not-run", "remove-manifest-reference", "failed-scenario-bytes"]) test(`coverage flags cannot hide retained artifacts: ${change}`, async () => {
  const root = resolve(tmpdir()), dir = await mkdtemp(join(root, "live-admission-test-"));
  try {
    const source = change === "failed-scenario-bytes" ? "../recoverable-live/evidence/native-recovery-timing-limit/" : "./evidence/native-fanout/";
    await cp(new URL(source, import.meta.url), dir, { recursive: true });
    const coverageFile = join(dir, "coverage.json"), ledger = JSON.parse(await readFile(coverageFile, "utf8"));
    const cell = ledger.cells.find((c) => c.app === (change === "failed-scenario-bytes" ? "corten" : "aspnet"));
    if (change === "not-run") cell.measurement = "not-run";
    if (change === "remove-manifest-reference") { cell.measurement = "not-run"; delete cell.measurementArtifact; }
    if (change === "failed-scenario-bytes") await writeFile(join(dir, "corten-normal.json.gz"), "corrupt retained capture");
    await writeFile(coverageFile, JSON.stringify(ledger));
    await assert.rejects(verifyRound(dir), /artifact bytes changed|measurement.*(flag|hidden)/);
  } finally {
    assert.ok(dir.startsWith(root + sep) && dir.includes("live-admission-test-"));
    await rm(dir, { recursive: true, force: true });
  }
});

test("unavailable native profiles still inspect retained failed-round captures", async () => {
  const round = await verifyRound(new URL("../recoverable-live/evidence/native-recovery-timing-limit/", import.meta.url));
  assert.equal(round.inspected.length, 6);
  assert.equal(round.unqualified.filter((r) => r.scenario).length, 4);
  assert.deepEqual(round.passed, []);
});

test("CDP initialization rejection closes its context", async () => {
  let closed = 0;
  const context = { newPage: async () => ({ setDefaultTimeout() {}, evaluate: async () => [], content: async () => "" }), close: async () => { closed++; },
    newCDPSession: async () => { throw new Error("CDP rejected"); } };
  await assert.rejects(browserJourney({ newContext: async () => context }, "http://local", workloadFor(), settingsFor("live-delivery", "normal")), /CDP rejected/);
  assert.equal(closed, 1);
});

for (const [name, mutate, pattern] of [
  ["duplicated context receipt", (a) => { a.browsers[1].identity = structuredClone(a.browsers[0].identity); }, /duplicate.*reader/],
  ["invented target identity", (a) => { a.browsers[1].identity.targetId = "invented"; }, undefined],
  ["borrowed native connection", (a) => {
    const id = a.browsers[0].network.find((r) => r.kind === "native-sse").requestId;
    for (const r of a.browsers[1].network) if (r.kind === "native-sse") r.requestId = id;
  }, /duplicate.*transport/],
  ["substituted raw resource response", (a) => {
    const r = a.host.requests[a.resourceObservations.released], body = JSON.parse(r.body);
    body.pendingTasks = 1; r.body = JSON.stringify(body);
  }, /raw host resource counters/],
  ["borrowed attachment receipt", (a) => { a.resourceObservations.delivered = a.resourceObservations.attached; }, undefined],
  ["invented native source image", (a) => {
    const r = a.kernel.after.receipt.instance, instance = JSON.parse(r.stdout); instance.image = "sha256:" + "0".repeat(64); r.stdout = JSON.stringify(instance);
  }, /source image/],
  ["kernel receipt outside publication interval", (a) => { a.kernel.after.receipt.startedAt = a.schedule.at(-1).startedAt - 1000; }, /clock|interval/],
  ["browser publication outside host RPC", (a) => { a.browsers[0].records.find((r) => r.kind === "publish").startedAt -= 1000; }, /clock binding/],
  ["negative host RPC duration", (a) => { a.schedule[0].finishedAt = a.schedule[0].startedAt - 1; }, /clock binding/],
  ["invented configure response", (a) => { a.configuration.version = "invented"; }, /configuration response/],
]) test(`v2 measurement rejects ${name}`, async () => {
  const { a, expected } = await measured(); mutate(a); delete a.summary;
  assert.throws(() => verifyFanout(a, expected), pattern);
});

test("same native instance's different fan-out interval cannot lend kernel counters", async () => {
  const { a, expected } = await measured();
  const other = await load("./evidence/review-v2-express/express-fanout-1.json.gz");
  a.kernel = other.kernel; delete a.summary;
  assert.throws(() => verifyFanout(a, expected), /kernel.*(binding|interval)/);
});
