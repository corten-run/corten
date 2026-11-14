import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { mock, test } from "node:test";
import { result, failedResult } from "../../json-api/test-fixtures.mjs";
import { descriptor } from "../../json-api/contract.mjs";
import { auditSubject, imageProof, inspectPreparation, snapshotSources, validateAuditDelivery, validateTimingAudit } from "./json-staging.mjs";
import { digest, inside, inspectEvidence, tree } from "./evidence.mjs";
import { inspectNative } from "./native-replay.mjs";
import { composePhase } from "./composition.mjs";

const temporary = mkdtempSync(join(os.tmpdir(), "isolated-json-stage-test-"));
const native = join(temporary, "native"), source = join(temporary, "sources"); mkdirSync(native); mkdirSync(source);
const fixture = result(), s = fixture.summary;
// Synthetic independent image observations for the saved-audit equality controls.
const images = descriptor().apps.flatMap((app) => descriptor().payloads.map((payload) => {
  const saved = s.apps[app].images[payload];
  return { app, payload, imageId: saved.imageId, labels: saved.labels,
    config: { entrypoint: saved.execution.Entrypoint, cmd: saved.execution.Cmd } };
}));
for (const tool of ["node", "k6"]) images.push({ tool, imageId: s.tools[tool].imageId,
  config: { entrypoint: s.toolExecutions[tool].Entrypoint, cmd: s.toolExecutions[tool].Cmd } });
const receipts = descriptor().apps.flatMap((app) => descriptor().cases.map((p) => fixture.load(s.apps[app].checks[p.key].native).receipt));
for (const app of descriptor().apps) for (const p of descriptor().cases) {
  const { files } = fixture.load(s.apps[app].checks[p.key].native);
  for (const [path, body] of Object.entries(files)) { mkdirSync(dirname(join(source, path)), { recursive: true }); writeFileSync(join(source, path), body); }
  delete s.apps[app].checks[p.key].native;
  s.apps[app].checks[p.key].nativeSourceVerified = false; s.apps[app].checks[p.key].nativeSerializationVerified = false;
  s.apps[app].runs[p.key] = []; s.apps[app].aggregates[p.key] = {};
}
s.options.build = true; s.options.checkOnly = true; s.complete = false; s.checksPassed = false;
s.failures = descriptor().apps.flatMap((app) => descriptor().cases.map((p) => ({ app, key: p.key, stage: "JSON qualification",
  error: "exactly one independently audited native receipt required" })));
const refs = [...Object.values(s.fixtures), ...Object.values(s.apps).flatMap((a) => Object.values(a.checks).map((c) => c.raw))];
for (const ref of refs) writeFileSync(join(native, ref.path), fixture.artifacts.get(ref.path));
const save = () => writeFileSync(join(native, "summary.json"), JSON.stringify(s)); save();
const binding = { request: { round: s.round, commit: s.commit }, execution: { effectiveOptions: structuredClone(s.options) }, resources: { expectedCpus: s.measurement.cpus } };
let subject;
const sealedSources = join(temporary, "sealed-sources");
const sourceFiles = [...new Map(receipts.flatMap((r) => r.sourceFiles).map((f) => [f.path, f])).values()];
test("actual native raw functional replay can stage only an honestly blocked check-only build", () => {
  const prepared = inspectPreparation(binding, native);
  assert.equal(prepared.report.baseline, false); assert.equal(s.options.build, true); assert.equal(s.options.checkOnly, true);
  const manifest = snapshotSources({ sources: { files: sourceFiles } }, source, sealedSources);
  subject = auditSubject({ campaignSha256: "campaign", commit: s.commit, sourceSha256: "sources" }, prepared, tree(native), manifest, images);
  assert.equal(subject.qualified, false); assert.equal(subject.identities.length, 36);
  for (const mutate of [(x) => x.cleanupFailures.push({ resource: "leaked" }), (x) => x.failures.pop(),
    (x) => { x.apps.corten.checks[descriptor().cases[0].key].nativeSourceVerified = true; }, (x) => { x.dirtyAfter = true; }]) {
    const original = structuredClone(s); mutate(s); save(); assert.throws(() => inspectPreparation(binding, native));
    for (const key of Object.keys(s)) delete s[key]; Object.assign(s, original); save();
  }
});

test("replayed negative preparation can await the same independent image/source audit without approving itself", () => {
  const f = failedResult(), summary = f.summary, folder = join(temporary, "negative-preparation"); mkdirSync(folder);
  summary.options.build = true; summary.options.checkOnly = true;
  for (const entry of Object.values(summary.apps)) for (const checked of Object.values(entry.checks)) {
    delete checked.native; checked.nativeSourceVerified = false; checked.nativeSerializationVerified = false;
  }
  summary.failures = structuredClone(s.failures);
  for (const [path, bytes] of f.artifacts) writeFileSync(join(folder, path), bytes);
  const save = () => writeFileSync(join(folder, "summary.json"), JSON.stringify(summary)); save();
  const b = { ...binding, execution: { effectiveOptions: summary.options } };
  const prepared = inspectPreparation(b, folder);
  assert.equal(prepared.report.baseline, false); assert.equal(prepared.report.attemptComplete, false);
  assert.equal(prepared.report.apps.corten[descriptor().cases[0].key].functionalComplete, true);
  assert.equal(prepared.report.apps.corten[descriptor().cases[0].key].functional, false);
  const target = auditSubject({ campaignSha256: "campaign", commit: summary.commit, sourceSha256: "sources" }, prepared, tree(folder),
    { files: sourceFiles }, []);
  assert.equal(target.qualified, false); assert.equal(target.identities.length, 36);
  delete summary.cleanup; save(); assert.throws(() => inspectPreparation(b, folder), "missing cleanup must not stage");
});
test("exact current built image identity is required, not generic source presence", () => {
  const inspect = mock.method(childProcess, "execFileSync", (binary, args, options) => {
    assert.equal(binary, "docker"); assert.deepEqual(args.slice(0, 2), ["image", "inspect"]); assert.equal(options.env.GIT_NO_REPLACE_OBJECTS, "1");
    const saved = images.find((i) => i.imageId === args[2]);
    return JSON.stringify([{ Id: saved.imageId, Config: { Labels: saved.labels, Entrypoint: saved.config.entrypoint,
      Cmd: saved.config.cmd, Env: ["SECRET=not-retained"] }, RootFS: { Layers: [] } }]);
  });
  syncBuiltinESMExports();
  try {
    const images = imageProof(s); assert.equal(images.length, 20); assert.ok(!JSON.stringify(images).includes("SECRET"));
    for (const [owner, key] of [[s.apps.express.images[descriptor().payloads[0]], "execution"], [s.toolExecutions, "node"], [s.toolExecutions, "k6"]]) {
      const before = owner[key];
      owner[key] = { ...before, Cmd: ["/unreviewed/node", "--eval", "process.exit(1)"] };
      assert.throws(() => imageProof(s), "same image ID cannot excuse changed saved execution");
      owner[key] = before;
    }
    inspect.mock.mockImplementation(() => '[{"Id":"sha256:wrong"}]'); assert.throws(() => imageProof(s));
  } finally { inspect.mock.restore(); syncBuiltinESMExports(); }
});

test("all timed native audits must equal the accepted receipts and sealed source bytes, not merely pass their own report", () => {
  const timed = result(), summary = timed.summary, folder = join(temporary, "timing"); mkdirSync(folder);
  for (const [path, bytes] of timed.artifacts) writeFileSync(join(folder, path), bytes);
  const save = () => writeFileSync(join(folder, "summary.json"), JSON.stringify(summary)); save();
  const timingBinding = { request: { group: "json-api", round: summary.round, commit: summary.commit },
    execution: { effectiveOptions: summary.options }, resources: { expectedCpus: summary.measurement.cpus } };
  const bundle = { schema: "json-api-native-audits/v1", receipts };
  assert.equal(inspectEvidence(timingBinding, folder).baseline, true);
  assert.equal(validateTimingAudit(timingBinding, folder, subject, bundle, sealedSources).complete, true);
  const first = descriptor().apps[0], last = descriptor().apps.at(-1), profile = descriptor().cases.at(-1);
  for (const app of [first, last]) {
    const checked = summary.apps[app].checks[profile.key], reference = structuredClone(checked.native);
    const original = timed.artifacts.get(reference.path), native = JSON.parse(original);
    const source = native.receipt.sourceFiles[0]; native.files[source.path] += "\nchanged independently audited timing source";
    source.sha256 = digest(native.files[source.path]);
    const changed = JSON.stringify(native); writeFileSync(join(folder, reference.path), changed); checked.native.sha256 = digest(changed); save();
    assert.equal(inspectEvidence(timingBinding, folder).baseline, true, "independent native receipt validity is insufficient");
    assert.throws(() => validateTimingAudit(timingBinding, folder, subject, bundle, sealedSources));
    writeFileSync(join(folder, reference.path), original); checked.native = reference; save();
  }
  // Even the exact accepted receipt cannot excuse changed embedded source bytes.
  const checked = summary.apps[first].checks[profile.key], original = timed.artifacts.get(checked.native.path), native = JSON.parse(original);
  native.files[native.receipt.sourceFiles[0].path] += "changed source";
  const bytes = JSON.stringify(native); writeFileSync(join(folder, checked.native.path), bytes); checked.native.sha256 = digest(bytes); save();
  assert.throws(() => validateTimingAudit(timingBinding, folder, subject, bundle, sealedSources));
  delete checked.native; save();
  assert.equal(validateTimingAudit(timingBinding, folder, subject, bundle, sealedSources).complete, false, "missing failed cells are not fabricated or promoted");
});
test("consistent negative runtime/image rewrites still differ from independently inspected accepted images", () => {
  for (const role of ["app", "upstream"]) {
    const f = failedResult("express"), summary = f.summary, folder = join(temporary, `execution-${role}`); mkdirSync(folder);
    const b = { request: { group: "json-api", round: summary.round, commit: summary.commit },
      execution: { effectiveOptions: summary.options }, resources: { expectedCpus: summary.measurement.cpus } };
    const bundle = { schema: "json-api-native-audits/v1", receipts };
    const save = () => {
      for (const [path, bytes] of f.artifacts) writeFileSync(join(folder, path), bytes);
      writeFileSync(join(folder, "summary.json"), JSON.stringify(summary));
    };
    save(); assert.equal(validateTimingAudit(b, folder, subject, bundle, sealedSources).complete, true);
    const payload = descriptor().payloads[0];
    const execution = role === "app" ? summary.apps.express.images[payload].execution : summary.toolExecutions.node;
    if (role === "app") execution.Cmd = ["/unreviewed/node", "--eval", "process.exit(1)"];
    else execution.Entrypoint = ["/unreviewed/node"];
    for (const [app, entry] of Object.entries(summary.apps)) for (const profile of descriptor().cases) {
      if (role === "app" && (app !== "express" || profile.payload !== payload)) continue;
      const checked = entry.checks[profile.key], raw = f.load(checked.raw);
      const cfg = (role === "app" ? raw.runtime : raw.participants.upstream).configuration;
      if (role === "app") cfg.command = execution.Cmd;
      cfg.entrypoint = execution.Entrypoint;
      const argv = [...(cfg.entrypoint ?? []), ...(cfg.command ?? [])]; cfg.path = argv[0]; cfg.args = argv.slice(1);
      checked.raw = f.put(raw);
    }
    save();
    const native = inspectEvidence(b, folder);
    assert.equal(native.attemptComplete, true, "intrinsic consistency alone is insufficient for accepted execution binding");
    assert.equal(native.baseline, false);
    assert.throws(() => validateTimingAudit(b, folder, subject, bundle, sealedSources), /timing execution differs/);
  }
});

test("k6 execution rewrites cannot pass the actual accepted-audit and core bridge", async () => {
  const f = result(), summary = f.summary, folder = join(temporary, "k6-execution"); mkdirSync(folder);
  const b = { request: { group: "json-api", round: summary.round, commit: summary.commit }, selection: { apps: descriptor().apps },
    preparation: { fixtures: [] }, execution: { effectiveOptions: summary.options }, resources: { expectedCpus: summary.measurement.cpus } };
  const bundle = { schema: "json-api-native-audits/v1", receipts };
  const save = () => { for (const [path, bytes] of f.artifacts) writeFileSync(join(folder, path), bytes);
    writeFileSync(join(folder, "summary.json"), JSON.stringify(summary)); };
  const compose = (native, audit) => composePhase(b, native, { cleanupComplete: true, resources: "verified" },
    [{ terminal: true, code: 0, error: null, cancelled: false, forced: false, success: true }], audit);
  save();
  assert.equal(inspectEvidence(b, folder).baseline, true);
  const original = await inspectNative(b, folder); assert.equal(original.status, "verified");
  assert.equal(compose(original, validateTimingAudit(b, folder, subject, bundle, sealedSources).complete).outcome, "native-validated");
  summary.toolExecutions.k6.Entrypoint = ["/unreviewed/k6"];
  for (const entry of Object.values(summary.apps)) for (const runs of Object.values(entry.runs)) for (const run of runs) {
    for (const phase of [run.warmup, ...Object.values(run.phases)]) {
      const raw = f.load(phase.raw), cfg = raw.participants.load.configuration;
      cfg.entrypoint = summary.toolExecutions.k6.Entrypoint; cfg.path = cfg.entrypoint[0]; cfg.args = [...cfg.command];
      phase.raw = f.put(raw);
    }
  }
  save();
  assert.equal(inspectEvidence(b, folder).baseline, true, "self-consistent raw replay alone cannot anchor image configuration");
  const changed = await inspectNative(b, folder); assert.equal(changed.status, "verified");
  let audited = false;
  try { audited = validateTimingAudit(b, folder, subject, bundle, sealedSources).complete; }
  catch (error) { assert.match(error.message, /timing execution differs from independently inspected image/); }
  assert.equal(audited, false, "unchanged accepted image proof must reject a consistently rewritten k6 entrypoint");
  assert.notEqual(compose(changed, audited).outcome, "native-validated");
});

test("independent review data must match all 36 actual subjects and sealed source bytes", () => {
  const delivery = { schema: "benchmark-json-audit-delivery/v1", subjectSha256: subject.subjectSha256,
    review: { reviewer: "independent-human", reviewedAt: "2026-11-12T12:00:00Z", subjectSha256: subject.subjectSha256, findings: [], decision: "approved" },
    bundle: { schema: "json-api-native-audits/v1", receipts } };
  assert.equal(validateAuditDelivery(delivery, subject, sealedSources).bundle.receipts.length, 36);
  for (const mutate of [(d) => { d.subjectSha256 = "stale"; }, (d) => { d.operatorAuthorized = true; },
    (d) => d.bundle.receipts.pop(), (d) => { d.bundle.receipts[1] = d.bundle.receipts[0]; },
    (d) => { d.bundle.receipts[0].identity.imageId = "sha256:wrong"; },
    (d) => { d.bundle.receipts[0].sourceFiles[0].path = "../escape"; }, (d) => { d.review.findings = ["unresolved"]; }]) {
    const bad = structuredClone(delivery); mutate(bad); assert.throws(() => validateAuditDelivery(bad, subject, sealedSources));
  }
  writeFileSync(join(sealedSources, "blobs", receipts[0].sourceFiles[0].sha256), "changed"); assert.throws(() => validateAuditDelivery(delivery, subject, sealedSources));
});
test("native route source names stay exact in data, safely content-addressed in archives", () => {
  const path = "bench/native/[id]/+page.server.ts", body = "export const test = true;\r\n";
  mkdirSync(dirname(join(source, path)), { recursive: true }); writeFileSync(join(source, path), body);
  const canonical = body.replaceAll("\r\n", "\n"), sha256 = digest(canonical);
  const manifest = snapshotSources({ sources: { files: [{ path, sha256 }] } }, source, join(temporary, "routes"));
  assert.equal(manifest.files[0].path, path); assert.equal(manifest.files[0].storedAs, `blobs/${sha256}`);
  assert.equal(manifest.snapshot.entries.filter((e) => e.type === "file").length, 1);
});
test.after(() => { assert.ok(inside(resolve(os.tmpdir()), resolve(temporary))); rmSync(temporary, { recursive: true, force: true }); });
