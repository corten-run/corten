import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { verifyArtifact } from "./parity.mjs";
import { verifyRound } from "./verify.mjs";
import { verifyFanout } from "./fanout.mjs";

const retained = new URL("./evidence/native-fanout/", import.meta.url);
const artifact = async (name, base = retained) => JSON.parse(gunzipSync(await readFile(new URL(`${name}.json.gz`, base))));
const verify = (a) => verifyArtifact(a, { app: a.app, group: a.group, scenario: a.scenario });
async function measured() {
  const a = await artifact("express-fanout-4"), normal = await artifact("express-normal");
  const qualification = JSON.parse(await readFile(new URL("express-artifacts.json", retained), "utf8")).files;
  return { a, expected: { app: "express", group: "live-delivery", provenance: normal.provenance, qualification, settings: normal.settings } };
}

async function rejectMixedProvenance(mutate) {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, "live-review-test-"));
  try {
    await cp(retained, directory, { recursive: true });
    const slow = await artifact("express-slow-reader");
    await mutate(slow.provenance);
    verify(slow); // Valid on its own does not qualify the other instance's measurements.
    const bytes = gzipSync(JSON.stringify(slow)), manifestFile = join(directory, "express-artifacts.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.files[1].sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(directory, manifest.files[1].file), bytes);
    await writeFile(manifestFile, JSON.stringify(manifest));
    const measurementsFile = join(directory, "express-measurements.json");
    const measurements = JSON.parse(await readFile(measurementsFile, "utf8"));
    for (const file of measurements.files) {
      const measured = await artifact(file.file.replace(".json.gz", ""));
      measured.qualification = manifest.files;
      const bytes = gzipSync(JSON.stringify(measured));
      await writeFile(join(directory, file.file), bytes);
      file.sha256 = createHash("sha256").update(bytes).digest("hex");
    }
    await writeFile(measurementsFile, JSON.stringify(measurements));
    await assert.rejects(verifyRound(directory), /qualification.*provenance/);
  } finally {
    assert.ok(directory.startsWith(parent + sep) && directory.includes("live-review-test-"));
    await rm(directory, { recursive: true, force: true });
  }
}

test("review: reject a qualification scenario borrowed from another retained build and instance", async () => {
  await rejectMixedProvenance(async (p) => {
    const older = await artifact("express-slow-reader", new URL("./evidence/native-delivery/", import.meta.url));
    for (const field of ["sourceHashes", "sourceSha256", "imageSourceSha256", "imageId", "containerId"]) p[field] = older.provenance[field];
  });
});

for (const field of ["containerId", "topology", "processInventory"]) test(`review: qualification binds full ${field} provenance`, async () => {
  await rejectMixedProvenance((p) => { p[field] = "another native instance"; });
});

test("review: raw HTTP baseline and released resource leaks cannot borrow the trace's zero counters", async () => {
  const a = await artifact("express-normal");
  let changed = 0;
  for (const r of a.network.filter((r) => r.kind === "response" && new URL(r.url).pathname === "/parity/resources")) {
    const body = JSON.parse(r.body);
    if (body.subscriptions === 0) {
      body.subscriptions = body.connections = body.pendingTasks = 1; r.body = JSON.stringify(body); changed++;
    }
  }
  assert.equal(changed, 3);
  assert.throws(() => verify(a), /resource/);
});

test("review: fan-out must observe quiescence after the cleanup acknowledgement, not detach", async () => {
  const { a, expected } = await measured(), publisher = a.browsers[0];
  const probe = publisher.records.find((r) => r.kind === "cleanup-probe");
  const before = publisher.timeOrigin + probe.at;
  const end = Math.max(...a.browsers.map((b) => b.timeOrigin + b.records.at(-1).at));
  for (const b of a.browsers) for (const r of b.records) if (b.timeOrigin + r.at >= before) r.at = end - b.timeOrigin;
  assert.throws(() => verifyFanout(a, expected), /cleanup.*acknowledgement/);
});

for (const [name, change] of [
  ["raw publication resource counter", (a) => {
    const r = a.network.find((r) => r.kind === "response" && r.url.endsWith("/parity/publish"));
    const body = JSON.parse(r.body); body.resources.pendingTasks++; r.body = JSON.stringify(body);
  }],
  ["raw native ready counter", (a) => {
    const r = a.network.find((r) => r.kind === "native-sse" && r.eventName === "ready");
    const body = JSON.parse(r.data); body.resources.pendingTasks++; r.data = JSON.stringify(body);
  }],
  ["raw native saturation peak", (a) => {
    const r = a.network.find((r) => r.kind === "native-sse" && r.eventName === "overflow");
    const body = JSON.parse(r.data); body.resources.queuePeak--; r.data = JSON.stringify(body);
  }],
  ["extra unrecorded raw resource response", (a) => {
    a.network.push(structuredClone(a.network.find((r) => r.kind === "response" && r.url.endsWith("/parity/resources"))));
  }],
  ["raw resource buffer inventory", (a) => {
    const r = a.network.find((r) => r.kind === "response" && r.url.endsWith("/parity/resources"));
    const body = JSON.parse(r.body); body.hiddenBuffer = 1; r.body = JSON.stringify(body);
  }],
]) test(`review: bind ${name} to the resource trace`, async () => {
  const a = await artifact("express-slow-reader"); change(a);
  assert.throws(() => verify(a), /resource/);
});

test("review: bind every native-feed batch saturation acknowledgement", async () => {
  const a = await artifact("corten-slow-reader", new URL("./evidence/native-feed-corten/", import.meta.url));
  const r = a.network.find((r) => r.kind === "response" && r.body?.includes('"acks":'));
  const body = JSON.parse(r.body); body.acks.find((r) => r.resources.queuePeak > 0).resources.queuePeak = 0;
  r.body = JSON.stringify(body);
  assert.throws(() => verify(a), /resource/);
});

for (const reader of [0, 1, 2, 3]) test(`review: reader ${reader} needs its own post-acknowledgement observation`, async () => {
  const { a, expected } = await measured(), b = a.browsers[reader];
  const publisher = a.browsers[0], probe = publisher.records.find((r) => r.kind === "cleanup-probe");
  const end = publisher.timeOrigin + probe.at + 149;
  for (const r of b.records) if (b.timeOrigin + r.at > end) r.at = end - b.timeOrigin;
  assert.throws(() => verifyFanout(a, expected), /cleanup.*acknowledgement/);
});

test("review: late final state cannot substitute for a late raw zero-resource observation", async () => {
  const { a, expected } = await measured(), publisher = a.browsers[0];
  const probe = publisher.records.find((r) => r.kind === "cleanup-probe");
  const b = a.browsers[3], before = publisher.timeOrigin + probe.at;
  for (const r of b.records) if (b.timeOrigin + r.at > before && r.kind !== "state") r.at = before - b.timeOrigin;
  assert.throws(() => verifyFanout(a, expected), /cleanup.*acknowledgement/);
});

test("review: measured reader resources cannot borrow an application zero over a raw leak", async () => {
  const { a, expected } = await measured();
  const r = a.browsers[3].network.filter((r) => r.kind === "response" && r.url.endsWith("/parity/resources")).at(-1);
  const body = JSON.parse(r.body); body.pendingTasks = 1; r.body = JSON.stringify(body);
  assert.throws(() => verifyFanout(a, expected), /resource/);
});

for (const scenario of ["normal", "disconnect", "missed-updates", "gap"]) test(`review: retain unqualified old Corten ${scenario} capture without upgrading controls`, async () => {
  const a = await artifact(`corten-${scenario}`, new URL("../recoverable-live/evidence/native-recovery-timing-limit/", import.meta.url));
  assert.equal(a.schema, "native-live-evidence/v1");
  assert.throws(() => verify(a), /negative native publication control missing/);
});
