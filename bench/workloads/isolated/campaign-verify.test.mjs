import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { mock, test } from "node:test";
import * as contracts from "./campaign-contract.mjs";
import * as evidence from "./evidence.mjs";
import { groupNames, selectedApps } from "../registry.mjs";
import { deploymentSha256 } from "../deployments.mjs";
import * as audit from "./test-fixtures/campaign-audit.mjs";
import { catalogResult } from "./test-fixtures/catalog.mjs";
import { cpuSettings, parseArgs as catalogOptions } from "../../catalog/contract.mjs";
import { groupDescriptor } from "../../catalog/group.mjs";

const temporary = mkdtempSync(join(os.tmpdir(), "isolated-campaign-replay-"));
const round = "r77", commit = "a".repeat(40), id = `${round}-0123456789abcdef`, sentinel = "SYNTHETIC_PRIVATE_SENTINEL";
const plan = { round, commit, campaignSha256: "fixed-unit-plan", order: [...groupNames], bindings: groupNames.map((group) => ({
  request: { group }, sources: { files: [audit.sourceFile] }, preparation: { fixtures: [{ executable: "node", argv: ["bench/catalog/fixtures.mjs"] }] },
  execution: { invocation: { executable: "node", argv: [`bench/${group}/run.mjs`, round] } },
  validation: { artifactRoot: `bench/${group}/results/${round}` },
})) };
const catalog = plan.bindings[0], catalogGroup = groupDescriptor("catalog-page");
let expectedPlan = plan;
Object.assign(catalog.request, { round: "c77", commit }); catalog.selection = { apps: catalogGroup.apps };
catalog.execution.effectiveOptions = catalogOptions(["c77", "--group", "catalog-page", "--build"], Object.fromEntries(catalogGroup.apps.map((a) => [a, {}])));
catalog.resources = { expectedCpus: cpuSettings({ CATALOG_APP_CPUS: "1", CATALOG_API_CPUS: "2-3", CATALOG_LOAD_CPUS: "4-7" }) };
function jsonPhase(p, phase) {
  const binding = structuredClone(p.bindings[1]);
  binding.execution.invocation.argv.push(...(phase === "prepare" ? ["--build", "--check-only"] : ["--receipts", `/bench/campaign/${id}/json-native-audits.json`]));
  binding.validation.artifactRoot += `-${phase}`; return binding;
}
mock.module("./campaign-contract.mjs", { namedExports: { ...contracts, jsonPhase,
  validateCampaign(value) { assert.deepEqual(value, expectedPlan); },
} });
let nativeMode = "blocked";
mock.module("./evidence.mjs", { namedExports: { ...evidence, inspectEvidence(binding, native) {
  if (nativeMode === "throw") assert.equal(sentinel, "expected-native-schema");
  if (nativeMode === "catalog" && binding.request.group === "catalog-page") return evidence.inspectEvidence(binding, native);
  return { qualification: "blocked", warnings: [sentinel], diagnosticNativeReport: { warnings: [sentinel], baseline: false } };
} } });
mock.module("./json-staging.mjs", { namedExports: { ...audit,
  validateTimingAudit(...args) {
    if (nativeMode === "timing-audit-mismatch") throw new Error(sentinel);
    return audit.validateTimingAudit(...args);
  }, inspectPreparation() {
  if (nativeMode === "parse") throw new SyntaxError(`invalid JSON ${sentinel}`);
  return { report: { baseline: false, warnings: [sentinel] } };
} } });
const { validateCampaign } = await import("./campaign-verify.mjs");

function journal() {
  const rows = [{ kind: "authorized" }, { kind: "started" }];
  for (const [index, group] of plan.order.entries()) {
    if (evidence.supportedGroups.includes(group)) {
      for (const phase of group === "json-api" ? ["prepare", "timing"] : ["timing"]) {
        const binding = group === "json-api" ? jsonPhase(plan, phase) : plan.bindings[index];
        rows.push({ kind: "native-output-reserved", group, phase, artifactRoot: binding.validation.artifactRoot });
        for (const invocation of [...binding.preparation.fixtures, binding.execution.invocation]) {
          const code = phase === "prepare" && invocation === binding.execution.invocation ? 1 : 0;
          rows.push({ kind: "command-intent", group, invocation }, { kind: "command-started", pid: 100 },
            { kind: "command-exited", terminal: true, code, signal: null, success: code === 0, cancelled: false, forced: false, error: null });
        }
        if (phase === "prepare") rows.push({ kind: "review-needed" }, { kind: "audit-staged" });
      }
    }
    rows.push({ kind: "group-finished", group, outcome: evidence.supportedGroups.includes(group) ? "blocked" : "not-run" });
  }
  rows.push({ kind: "finished" }); return rows;
}
let serial = 0;
function archive({ change = () => {}, partial = false, schema, omitNative = false, sealPhases = true } = {}) {
  const folder = join(temporary, String(serial++)), directory = join(folder, id); mkdirSync(directory, { recursive: true });
  const save = (path, value) => writeFileSync(join(folder, path), JSON.stringify(value));
  const status = { schema: "benchmark-isolated-campaign-status/v1", campaign: id, round, campaignSha256: plan.campaignSha256,
    state: partial ? "preserved-uncertain" : "finished", controllerReady: false, isolation: "unverified",
    outcomes: plan.order.map((group) => ({ group, outcome: evidence.supportedGroups.includes(group) ? "blocked" : "not-run" })), uncollectedNativeRoots: [] };
  let rows = journal(); change(rows, status);
  save(".host-attempt.json", { schema: schema ?? "benchmark-isolated-campaign-reservation/v1", id, commit, campaignSha256: plan.campaignSha256 });
  save(`${id}/plan.json`, plan);
  let phase, command = 0;
  const manifests = new Map();
  // Populate seals before saving journal status snapshots, as the live API does.
  for (const row of rows.filter((r) => r.kind === "native-output-reserved")) {
    const key = `${String(plan.order.indexOf(row.group)).padStart(2, "0")}-${row.group}-${row.phase}`;
    mkdirSync(join(directory, key), { recursive: true });
    const start = rows.indexOf(row), next = rows.findIndex((r, i) => i > start && r.kind === "native-output-reserved");
    const phaseRows = rows.slice(start + 1, next < 0 ? rows.length : next);
    const intents = phaseRows.filter((r) => r.kind === "command-intent").length, exits = phaseRows.filter((r) => r.kind === "command-exited").length;
    if (!omitNative && intents > 0 && intents === exits) {
      const native = join(directory, key, "native"); mkdirSync(native);
      writeFileSync(join(native, "summary.json"), nativeMode === "catalog" && row.group === "catalog-page" ? JSON.stringify(catalogResult(catalog)) : "{}");
      writeFileSync(join(native, "raw.log"), "original bytes\n");
      const manifest = evidence.tree(native); manifests.set(key, manifest); save(`${id}/${key}/native-manifest.json`, manifest);
    }
  }
  const review = rows.find((r) => r.kind === "review-needed");
  if (review && !omitNative) {
    const sources = audit.snapshotSources(null, null, join(directory, "audit-sources")), images = [{ imageId: "synthetic" }];
    const subject = audit.auditSubject(plan, {}, manifests.get("01-json-api-prepare"), sources, images);
    review.subjectSha256 = subject.subjectSha256; review.nativeExit = 1; review.qualification = "blocked";
    status.auditSubjectSha256 = subject.subjectSha256;
    save(`${id}/json-audit-subject.json`, subject); save(`${id}/01-json-api-prepare/images.json`, images);
    const staged = rows.find((r) => r.kind === "audit-staged");
    if (staged) {
      const delivery = audit.auditDelivery(subject.subjectSha256);
      save(`${id}/json-audit-delivery-retained.json`, delivery); save(`${id}/json-native-audits.json`, delivery.bundle);
      staged.subject = { action: "stage-json-audit", campaignSha256: plan.campaignSha256, auditSubjectSha256: subject.subjectSha256,
        deliverySha256: evidence.digest(`${JSON.stringify(delivery, null, 2)}\n`), review: delivery.review };
    }
  } else status.auditSubjectSha256 = null;
  for (const row of rows.filter((r) => r.kind === "group-finished" && evidence.supportedGroups.includes(r.group))) {
    const phase = row.phase === "prepare" ? "prepare" : "timing", field = phase === "prepare" ? "manifest" : "nativeManifestSha256";
    const seal = manifests.get(`${String(plan.order.indexOf(row.group)).padStart(2, "0")}-${row.group}-${phase}`)?.sha256;
    row[field] = seal; status.outcomes[plan.order.indexOf(row.group)][field] = seal;
  }
  if (sealPhases) {
    let reserved;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].kind === "native-output-reserved") reserved = rows[i];
      if (rows[i].kind !== "command-exited" || rows[i + 1]?.kind === "command-intent") continue;
      const key = `${String(plan.order.indexOf(reserved.group)).padStart(2, "0")}-${reserved.group}-${reserved.phase}`, manifest = manifests.get(key);
      if (manifest) rows.splice(++i, 0, { kind: "phase-sealed", group: reserved.group, phase: reserved.phase,
        artifactRoot: reserved.artifactRoot, nativeManifestSha256: manifest.sha256 });
    }
  }
  save(`${id}/campaign-result.json`, { status, deletionAuthorized: false, wholeHostTerminal: "parent-must-observe" });
  for (const [sequence, row] of rows.entries()) {
    if (row.kind === "native-output-reserved") {
      phase = `${String(plan.order.indexOf(row.group)).padStart(2, "0")}-${row.group}-${row.phase}`;
    }
    if (row.kind === "command-intent") writeFileSync(join(directory, phase, `command-${command++}.log`), "fake native output\n");
    save(`${id}/${String(sequence).padStart(5, "0")}-${row.kind}.json`, { ...row, schema: "benchmark-isolated-campaign-event/v1", sequence,
      campaign: id, round, campaignSha256: plan.campaignSha256, status });
  }
  save(`${id}/collection-manifest.json`, { status, manifest: evidence.tree(directory) });
  return { folder, round, commit };
}

function mutate(request, path, update, raw = false) {
  const file = join(request.folder, id, path);
  writeFileSync(file, raw ? update : JSON.stringify(update(JSON.parse(readFileSync(file)))));
}
function rehash(request) {
  const directory = join(request.folder, id), manifest = evidence.tree(directory);
  const entries = manifest.entries.filter((e) => e.path !== "collection-manifest.json");
  mutate(request, "collection-manifest.json", (saved) => ({ ...saved, manifest: { entries, sha256: deploymentSha256(entries) } }));
}
function mutateEvent(request, kind, update) {
  const path = evidence.tree(join(request.folder, id)).entries.find((e) => e.path.endsWith(`-${kind}.json`)).path;
  mutate(request, path, update);
}
test("saved group scope comes only from the rebound plan; foreign, missing, edited or downgraded groups are invalid", async () => {
  const legacy = await validateCampaign(archive()); assert.equal(legacy.schema, "benchmark-isolated-campaign-inspection/v1");
  function stoppedGroup(group, changePlan = () => {}, changeStatus = () => {}) {
    expectedPlan = { ...plan, schema: contracts.groupCampaignSchema, order: [group], bindings: plan.bindings.filter((b) => b.request.group === group)
      .map((b) => ({ ...b, selection: { apps: selectedApps(group), contractSha256: "synthetic-contract" } })) };
    const folder = join(temporary, String(serial++)), directory = join(folder, id); mkdirSync(directory, { recursive: true });
    const save = (path, value) => writeFileSync(join(folder, path), JSON.stringify(value));
    const status = { schema: "benchmark-isolated-campaign-status/v1", campaign: id, round, campaignSha256: plan.campaignSha256,
      executionVersion: 3, state: "preserved-uncertain", controllerReady: false, isolation: "unverified",
      outcomes: [{ group, outcome: "not-run" }], uncollectedNativeRoots: [] };
    changeStatus(status);
    const savedPlan = structuredClone(expectedPlan); changePlan(savedPlan);
    save(".host-attempt.json", { schema: "benchmark-isolated-campaign-reservation/v1", id, commit, campaignSha256: plan.campaignSha256 });
    save(`${id}/plan.json`, savedPlan);
    save(`${id}/campaign-result.json`, { status, deletionAuthorized: false, wholeHostTerminal: "parent-must-observe" });
    for (const [sequence, kind] of ["authorized", "started", "halted"].entries()) save(`${id}/${String(sequence).padStart(5, "0")}-${kind}.json`, {
      schema: "benchmark-isolated-campaign-event/v1", sequence, kind, campaign: id, round, campaignSha256: plan.campaignSha256, status,
    });
    save(`${id}/collection-manifest.json`, { status, manifest: evidence.tree(directory) });
    return { folder, round, commit };
  }
  try {
    for (const group of groupNames) {
      const request = stoppedGroup(group), before = evidence.tree(request.folder), result = await validateCampaign(request);
      assert.equal(result.status, "blocked", JSON.stringify(result));
      assert.equal(result.schema, "benchmark-isolated-group-campaign-inspection/v1");
      assert.deepEqual(Object.keys(result).sort(), Object.keys(legacy).sort(), "no new top-level group field");
      assert.deepEqual(result.selection.groups.map((r) => r.group), [group]); assert.deepEqual(result.groups, []);
      assert.equal(result.qualified, false); assert.equal(result.deletionAuthorized, false);
      assert.deepEqual(evidence.tree(request.folder), before);
    }
    for (const change of [
      (p) => { p.schema = "benchmark-isolated-campaign/v1"; },
      (p) => { p.order = ["foreign"]; }, (p) => { p.order = []; },
      (p) => { p.bindings = []; }, (p) => { p.bindings[0].selection.apps.pop(); },
      (p) => { p.bindings[0].execution.invocation.argv.push("--apps", "corten"); },
      (p) => { p.bindings[0].execution.effectiveOptions.duration = 1; },
    ]) assert.equal((await validateCampaign(stoppedGroup("catalog-page", change))).status, "invalid");
    for (const change of [
      (s) => { s.outcomes = []; }, (s) => { s.outcomes[0].group = "json-api"; },
      (s) => { s.outcomes.push({ group: "json-api", outcome: "not-run" }); },
      (s) => { s.executionVersion = 2; }, (s) => { delete s.executionVersion; },
    ]) assert.equal((await validateCampaign(stoppedGroup("catalog-page", undefined, change))).status, "invalid");
  } finally { expectedPlan = plan; }
  assert.equal((await validateCampaign(archive())).schema, "benchmark-isolated-campaign-inspection/v1");
});
test("adjacent and collection rehashes cannot replace journal-bound native bytes", async () => {
  for (const phase of ["00-catalog-page-timing", "01-json-api-prepare", "01-json-api-timing", "02-localized-marketplace-timing"]) {
    const request = archive(); appendFileSync(join(request.folder, id, phase, "native", "raw.log"), "REPLACED NATIVE BYTES\n");
    mutate(request, `${phase}/native-manifest.json`, () => evidence.tree(join(request.folder, id, phase, "native"))); rehash(request);
    assert.equal((await validateCampaign(request)).status, "invalid", phase);
  }
});
test("the real strict catalog inspector cannot excuse broken journal seals", async () => {
  nativeMode = "catalog";
  try {
    const request = archive(), positive = (await validateCampaign(request));
    assert.equal(positive.status, "blocked", JSON.stringify(positive)); assert.equal(positive.qualified, false);
    assert.equal(evidence.inspectEvidence(catalog, join(request.folder, id, "00-catalog-page-timing/native")).diagnosticNativeReport.baseline, true,
      "real legacy aggregate replay passed, raw qualification still blocked");
    assert.equal(positive.diagnostics[0].report.baseline, false);
    appendFileSync(join(request.folder, id, "00-catalog-page-timing/native/raw.log"), "REPLACED NATIVE BYTES\n");
    mutate(request, "00-catalog-page-timing/native-manifest.json", () => evidence.tree(join(request.folder, id, "00-catalog-page-timing/native"))); rehash(request);
    assert.equal((await validateCampaign(request)).status, "invalid");
  } finally { nativeMode = "blocked"; }
});
test("retained JSON subject, delivery, staged bundle and source snapshot must replay their commitments", async () => {
  const mutations = [
    (r) => mutate(r, "json-audit-subject.json", () => null),
    (r) => mutate(r, "json-audit-delivery-retained.json", "invalid JSON", true),
    (r) => mutate(r, "json-native-audits.json", "invalid JSON", true),
    (r) => mutate(r, "json-native-audits.json", (v) => ({ ...v, receipts: ["different"] })),
    (r) => mutate(r, `audit-sources/blobs/${audit.sourceFile.sha256}`, "changed source", true),
    (r) => mutate(r, "01-json-api-prepare/images.json", () => [{ imageId: "different" }]),
    (r) => mutate(r, "json-audit-subject.json", (v) => ({ ...v, commit: "b".repeat(40) })),
    (r) => mutate(r, "json-audit-delivery-retained.json", (v) => ({ ...v, review: { ...v.review, reviewer: "different" } })),
    (r) => mutate(r, "json-audit-subject.json", (v) => {
      const { subjectSha256, ...body } = v; body.commit = "b".repeat(40); return { ...body, subjectSha256: deploymentSha256(body) };
    }),
    (r) => mutateEvent(r, "review-needed", (v) => ({ ...v, subjectSha256: "b".repeat(64) })),
    (r) => mutateEvent(r, "audit-staged", (v) => ({ ...v, subject: { ...v.subject, deliverySha256: "b".repeat(64) } })),
    (r) => mutateEvent(r, "audit-staged", (v) => ({ ...v, subject: { ...v.subject, review: { ...v.subject.review, reviewer: "different" } } })),
    (r) => mutateEvent(r, "started", (v) => ({ ...v, status: { ...v.status, auditSubjectSha256: "b".repeat(64) } })),
    (r) => mutateEvent(r, "audit-staged", (v) => ({ ...v, status: { ...v.status, auditSubjectSha256: null } })),
    (r) => mutate(r, "json-audit-delivery.json", "invalid inbox JSON", true),
  ];
  for (const change of mutations) { const request = archive(); change(request); rehash(request); assert.equal((await validateCampaign(request)).status, "invalid"); }
});
test("all repeated native seals are checked, not just the adjacent manifest", async () => {
  for (const change of [
    (r) => mutateEvent(r, "group-finished", (v) => ({ ...v, nativeManifestSha256: "b".repeat(64) })),
    (r) => mutateEvent(r, "started", (v) => { v.status.outcomes[0].nativeManifestSha256 = "b".repeat(64); return v; }),
    (r) => mutateEvent(r, "group-finished", (v) => { delete v.nativeManifestSha256; return v; }),
  ]) { const request = archive(); change(request); rehash(request); assert.equal((await validateCampaign(request)).status, "invalid"); }
});
test("failed JSON preparation retains its distinct manifest seal without inventing audit acceptance", async () => {
  const request = archive({ change(rows, status) {
    const start = rows.findIndex((r) => r.kind === "review-needed"), end = rows.findIndex((r) => r.kind === "group-finished" && r.group === "json-api");
    rows.splice(start, end - start); const outcome = rows.find((r) => r.kind === "group-finished" && r.group === "json-api");
    outcome.outcome = "failed"; outcome.phase = "prepare"; Object.assign(status.outcomes[1], { outcome: "failed", phase: "prepare" });
  } });
  assert.equal((await validateCampaign(request)).status, "failed");
  appendFileSync(join(request.folder, id, "01-json-api-prepare/native/raw.log"), "REPLACED NATIVE BYTES\n");
  mutate(request, "01-json-api-prepare/native-manifest.json", () => evidence.tree(join(request.folder, id, "01-json-api-prepare/native"))); rehash(request);
  assert.equal((await validateCampaign(request)).status, "invalid");
});

test("complete fixed command lifecycles remain blocked, never qualified", async () => {
  const result = (await validateCampaign(archive())); assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.equal(result.collectionIntegrity, "manifest-verified"); assert.equal(result.qualified, false);
});
test("historical completed phase commitments remain readable, but an uncommitted halted snapshot is invalid", async () => {
  assert.equal((await validateCampaign(archive({ sealPhases: false }))).status, "blocked");
  assert.equal((await validateCampaign(archive({ partial: true, sealPhases: false, change(rows, status) {
    rows.splice(9); rows.push({ kind: "halted" });
    status.outcomes = plan.order.map((group, i) => ({ group, outcome: i === 0 ? "preserved-uncertain" : "not-run" }));
  } }))).status, "invalid");
});
test("rehashed finished journal cannot omit command start/exit or mandatory native work", async () => {
  const mutations = [
    (rows) => rows.splice(0, rows.length - 1), // no authorization, commands or native trees
    (rows) => rows.splice(4, rows.length - 5), // reserved + one intent + finished: review reproduction
    (rows) => rows.splice(rows.findIndex((r) => r.kind === "command-started"), 1),
    (rows) => rows.splice(rows.findIndex((r) => r.kind === "command-exited"), 1),
    (rows) => { const start = rows.findIndex((r) => r.kind === "command-started"); [rows[start], rows[start + 1]] = [rows[start + 1], rows[start]]; },
    (rows) => { const exit = rows.findIndex((r) => r.kind === "command-exited"); rows.splice(exit, 0, structuredClone(rows[exit])); },
    (rows) => { const start = rows.findIndex((r) => r.kind === "command-started"); rows.splice(start, 0, structuredClone(rows[start])); },
    (rows) => rows.splice(6, 3), // successful fixture cannot substitute for the native invocation
    (rows) => { const a = rows.findIndex((r) => r.kind === "group-finished"); rows.splice(a, 0, { kind: "group-finished", group: "json-api", outcome: "blocked" }); },
    (rows) => rows.splice(rows.findIndex((r) => r.kind === "audit-staged"), 1),
    (rows) => { rows[8] = { ...rows[8], code: 9, success: false }; }, // blocked cannot conceal failure
    (rows) => { rows[8] = { ...rows[8], success: false, cancelled: true }; }, // cancellation cannot continue
    (rows) => { rows[3].invocation = { ...rows[3].invocation, argv: ["arbitrary-command"] }; },
  ];
  for (const change of mutations) assert.equal((await validateCampaign(archive({ change }))).status, "invalid");
  assert.equal((await validateCampaign(archive({ omitNative: true }))).status, "invalid");
});
test("matching saved qualification flags cannot substitute for actual native replay", async () => {
  const request = archive({ change(rows, status) {
    rows.find((r) => r.kind === "group-finished").outcome = "native-validated"; status.outcomes[0].outcome = "native-validated";
  } });
  assert.equal((await validateCampaign(request)).status, "invalid");
});
test("phase seals bind the exact phase and cannot be forged from an unfinished command prefix", async () => {
  for (const change of [
    (v) => ({ ...v, group: "json-api" }),
    (v) => ({ ...v, phase: "prepare" }),
    (v) => ({ ...v, artifactRoot: "foreign-root" }),
    (v) => ({ ...v, nativeManifestSha256: "b".repeat(64) }),
    (v) => ({ ...v, nativeManifestSha256: [v.nativeManifestSha256] }),
  ]) {
    const request = archive(); mutateEvent(request, "phase-sealed", change); rehash(request);
    assert.equal((await validateCampaign(request)).status, "invalid");
  }
  const request = archive({ partial: true, change(rows, status) {
    rows.splice(5); rows.push({ kind: "phase-sealed", group: "catalog-page", phase: "timing",
      artifactRoot: plan.bindings[0].validation.artifactRoot, nativeManifestSha256: "b".repeat(64) }, { kind: "halted" });
    status.outcomes = plan.order.map((group, i) => ({ group, outcome: i === 0 ? "preserved-uncertain" : "not-run" }));
    status.uncollectedNativeRoots = [{ group: "catalog-page", phase: "timing", artifactRoot: plan.bindings[0].validation.artifactRoot }];
  } });
  assert.equal((await validateCampaign(request)).status, "invalid");
});
test("a real failed terminal prefix is retained, not rejected or promoted", async () => {
  const request = archive({ partial: true, change(rows, status) {
    rows.splice(9); rows[8] = { ...rows[8], code: 9, success: false }; rows.push({ kind: "halted" });
    status.outcomes = plan.order.map((group, i) => ({ group, outcome: i === 0 ? "failed" : "not-run" }));
  } });
  const result = (await validateCampaign(request)); assert.equal(result.status, "failed", JSON.stringify(result)); assert.equal(result.qualified, false);
});
test("a synchronous spawn failure may retain an explicit failed prefix without a start", async () => {
  const request = archive({ partial: true, change(rows, status) {
    rows.splice(6); rows.splice(4, 1); rows[4] = { ...rows[4], code: null, success: false, error: "spawn-failed" }; rows.push({ kind: "halted" });
    status.outcomes = plan.order.map((group, i) => ({ group, outcome: i === 0 ? "failed" : "not-run" }));
  } });
  const result = (await validateCampaign(request)); assert.equal(result.status, "failed", JSON.stringify(result)); assert.equal(result.qualified, false);
});
test("an interrupted open command is preserved only as incomplete partial lifecycle", async () => {
  const request = archive({ partial: true, change(rows, status) {
    rows.splice(5); rows.push({ kind: "halted" });
    status.outcomes = plan.order.map((group, i) => ({ group, outcome: i === 0 ? "preserved-uncertain" : "not-run" }));
    status.uncollectedNativeRoots = [{ group: "catalog-page", phase: "timing", artifactRoot: plan.bindings[0].validation.artifactRoot }];
  } });
  const result = (await validateCampaign(request)); assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.equal(result.collectionIntegrity, "unsealed-partial"); assert.equal(result.qualified, false); assert.equal(result.deletionAuthorized, false);
});
test("outer assertion and JSON parse diagnostics never echo archive data", async () => {
  for (const malformed of [false, true]) {
    const request = archive({ schema: sentinel });
    if (malformed) writeFileSync(join(request.folder, ".host-attempt.json"), `{"schema":"${sentinel}`);
    const result = (await validateCampaign(request)); assert.equal(result.status, "invalid");
    assert.ok(!JSON.stringify(result).includes(sentinel)); assert.equal(result.error, "saved-campaign-invalid");
  }
});
test("native assertion, parse and returned warning diagnostics never echo archive data", async () => {
  for (nativeMode of ["throw", "parse", "blocked"]) {
    const request = nativeMode !== "blocked" ? archive({ partial: true, change(rows, status) {
      rows.splice(nativeMode === "parse" ? rows.findIndex((r) => r.kind === "review-needed") : 9); rows.push({ kind: "halted" });
      status.outcomes = plan.order.map((group, i) => ({ group, outcome: i === (nativeMode === "parse" ? 1 : 0) ? "failed" : i === 0 ? "blocked" : "not-run" }));
    } }) : archive();
    const result = (await validateCampaign(request)); assert.equal(result.status, nativeMode !== "blocked" ? "failed" : "blocked", JSON.stringify(result));
    if (nativeMode !== "blocked") assert.ok(result.diagnostics.some((d) => d.report.error === "native-evidence-invalid-or-incomplete"));
    assert.ok(!JSON.stringify(result).includes(sentinel));
  }
});
test("saved timing replay cannot bypass the accepted-audit binding gate or expose its raw error", async () => {
  const request = archive(); assert.equal((await validateCampaign(request)).status, "blocked");
  nativeMode = "timing-audit-mismatch";
  try {
    const result = (await validateCampaign(request)); assert.equal(result.status, "invalid");
    assert.ok(!JSON.stringify(result).includes(sentinel));
  } finally { nativeMode = "blocked"; }
});
test.after(() => { assert.ok(evidence.inside(resolve(os.tmpdir()), resolve(temporary))); rmSync(temporary, { recursive: true, force: true }); });
