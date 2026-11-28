import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { deploymentSha256 } from "../deployments.mjs";
import { contractSha256, definition } from "../registry.mjs";
import { validateCollected } from "../../catalog/droplet-contract.mjs";
import { inspectCatalog } from "../../catalog/report.mjs";
import { groupDescriptor } from "../../catalog/group.mjs";
import { reader } from "../../json-api/artifacts.mjs";
import { inspectBoundJson } from "../../json-api/report.mjs";
import { producerSourceNames } from "../../json-api/production.mjs";
import { scheduledProducerMarker, scheduledProducerSchema } from "../../json-api/contract.mjs";
import { timedSummarySchema } from "../../json-api/timed-outcomes.mjs";
import { validateSummary } from "../../marketplace/report.mjs";
import { admitted, boundedFeatureProfile } from "../../marketplace/feature-contract.mjs";
import { inspectRawSupport } from "./raw-support.mjs";
import { portableEvidenceSegment } from "../cloud-contract.mjs";

export const supportedGroups = Object.freeze(["catalog-page", "json-api", "localized-marketplace"]);
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
export function physical(path, directory = true) {
  path = resolve(path);
  let current = path;
  while (true) {
    const stat = lstatSync(current);
    assert.ok(!stat.isSymbolicLink(), "symlink/junction boundary refused");
    if (current === path) assert.ok(directory ? stat.isDirectory() : stat.isFile(), "wrong physical file type");
    if (dirname(current) === current) break;
    current = dirname(current);
  }
  assert.equal(realpathSync(path), path, "physical boundary changed");
  return path;
}
const same = (a, b) => ["dev", "ino", "size", "mtimeMs", "ctimeMs", "nlink"].every((k) => a[k] === b[k]);
export function readRegular(path) { return readEvidenceFile(path, false); }
function readEvidenceFile(path, sync) {
  physical(dirname(path));
  const before = lstatSync(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, "link/special evidence file refused");
  // Windows requires write access for FlushFileBuffers even though we only read.
  const access = sync && process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY;
  const fd = openSync(path, access | (constants.O_NOFOLLOW ?? 0));
  try {
    assert.ok(same(before, fstatSync(fd)), "file replaced before read");
    const bytes = readFileSync(fd);
    if (sync) fsyncSync(fd);
    assert.ok(same(before, fstatSync(fd)) && same(before, lstatSync(path)), "file mutated while reading");
    physical(dirname(path));
    return bytes;
  } finally { closeSync(fd); }
}
export function durable(path, bytes) {
  physical(dirname(path));
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}
export function publishDurable(path, bytes) {
  const staged = `${path}.pending`;
  durable(staged, bytes);
  const identity = lstatSync(staged);
  assert.equal(lstatSync(path, { throwIfNoEntry: false }), undefined, "evidence publication already exists");
  try {
    renameSync(staged, path); syncDirectory(dirname(path));
  } catch (error) {
    // Withdraw only this publication if directory sync did not complete.
    try {
      const current = lstatSync(path, { throwIfNoEntry: false });
      if (current?.dev === identity.dev && current.ino === identity.ino && !lstatSync(staged, { throwIfNoEntry: false })) {
        renameSync(path, staged); syncDirectory(dirname(path));
      }
    } catch { /* Leave unproven evidence in place. */ }
    throw error;
  }
}
export function syncDirectory(path) {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function safeName(name) {
  assert.ok(portableEvidenceSegment(name), "unsafe evidence path segment");
}
export function tree(root) { return inventory(root, false); }
function inventory(root, sync) {
  physical(root);
  const entries = [], seen = new Set();
  function walk(path, key) {
    const stat = lstatSync(path);
    assert.ok(!stat.isSymbolicLink(), "evidence link refused");
    if (stat.isDirectory()) {
      physical(path); entries.push({ path: key, type: "directory" });
      for (const name of readdirSync(path).sort()) {
        safeName(name);
        const next = key ? `${key}/${name}` : name, folded = next.toLowerCase();
        assert.ok(!seen.has(folded), "case-colliding evidence paths"); seen.add(folded);
        walk(join(path, name), next);
      }
      if (sync) syncDirectory(path);
    } else {
      const bytes = readEvidenceFile(path, sync);
      entries.push({ path: key, type: "file", bytes: bytes.length, sha256: digest(bytes) });
    }
  }
  walk(root, "");
  return { entries, sha256: deploymentSha256(entries) };
}

// Called only for a fresh, owned output after verified terminal command lifetime.
// On a different filesystem, rename fails and leaves the source for custody.
export function transferEvidence(source, destination) {
  assert.ok(!inside(source, destination) && !inside(destination, source), "source/destination overlap");
  physical(dirname(destination));
  assert.equal(lstatSync(destination, { throwIfNoEntry: false }), undefined, "native evidence destination already exists");
  const before = inventory(source, true);
  renameSync(source, destination);
  syncDirectory(dirname(destination)); syncDirectory(dirname(source));
  assert.ok(isDeepStrictEqual(tree(destination), before), "transferred evidence differs");
  return before;
}

// JSON image observations are appended only after the safely collected prepare
// phase; they have their own exact audit-subject commitment. Everything else in
// the phase (host observations, logs and native bytes) is sealed before a halt.
export function phaseSnapshot(root, jsonPreparation = false) {
  const snapshot = tree(root), entries = snapshot.entries.filter((e) => !(jsonPreparation && e.path === "images.json"));
  return { entries, sha256: deploymentSha256(entries) };
}

/** Destination is exclusively created. Never extracts an archive or removes either tree. */
export function copyEvidence(source, destination) {
  const before = tree(source);
  physical(dirname(destination));
  assert.ok(!inside(source, destination) && !inside(destination, source), "source/destination overlap");
  mkdirSync(destination, { mode: 0o700 }); syncDirectory(dirname(destination));
  for (const entry of before.entries.slice(1)) {
    const target = join(destination, ...entry.path.split("/"));
    if (entry.type === "directory") mkdirSync(target, { mode: 0o700 });
    else {
      const bytes = readRegular(join(source, ...entry.path.split("/")));
      assert.equal(digest(bytes), entry.sha256, "source evidence mutated during collection");
      durable(target, bytes);
    }
  }
  for (const entry of before.entries.filter((e) => e.type === "directory").reverse())
    syncDirectory(join(destination, ...entry.path.split("/").filter(Boolean)));
  assert.ok(isDeepStrictEqual(tree(source), before), "source tree mutated during collection");
  assert.ok(isDeepStrictEqual(tree(destination), before), "copied evidence differs");
  return before;
}

export function verifyJsonProducer(binding, summary) {
  assert.ok(summary.schema === timedSummarySchema, "current JSON campaign requires v2 evidence");
  const names = producerSourceNames(summary.producer?.schema);
  assert.ok(isDeepStrictEqual(Object.keys(summary.producer.sources).sort(), [...names].sort()), "JSON producer inventory differs");
  assert.ok(binding.sources?.commit === binding.request.commit, "JSON producer commit differs");
  const files = binding.sources.files;
  assert.ok(Array.isArray(files), "JSON bound sources missing");
  const sources = new Map(files.map((row) => [row.path, row.sha256]));
  assert.equal(sources.size, files.length, "duplicate bound source");
  if (sources.has(scheduledProducerMarker)) assert.ok(summary.producer.schema === scheduledProducerSchema,
    "JSON producer cannot downgrade the bound load-resource capture");
  for (const name of names) {
    const path = `bench/json-api/${name}`;
    assert.ok(sources.has(path), "JSON producer missing from bound commit");
    const sha256 = summary.producer.sources[name];
    assert.ok(typeof sha256 === "string" && /^[a-f0-9]{64}$/.test(sha256), `invalid JSON producer digest: ${name}`);
    assert.ok(sha256 === sources.get(path), `JSON producer differs from bound commit: ${name}`);
  }
}

// The native reader can replay both matrices. The selected group, not the
// archive, decides which one this request requires. Neither waives qualification.
export function checkMarketplaceContract(binding, summary) {
  const group = "localized-marketplace", selected = binding.selection.contractSha256;
  const perLocale = "e7196bc53d5d9a48543dacdfa245c672d5dda68c514f43339779de58f022c9eb";
  assert.ok(selected === perLocale || selected === contractSha256(group), "unknown marketplace group contract");
  assert.equal(summary.schema, selected === perLocale ? "marketplace-results/v5" : definition(group).nativeResultSchema,
    "native marketplace result schema differs from the selected group contract");
  assert.equal(summary.measurement.featureProfile, boundedFeatureProfile, "current group requires bounded qualification");
}

/** Native APIs are independent gates; a process exit or complete flag is insufficient. */
export function inspectEvidence(binding, root) {
  assert.ok(supportedGroups.includes(binding.request.group), "native validator not integrated");
  const before = tree(root); // Check every file, not just references the reporter happens to follow.
  const summary = JSON.parse(readRegular(join(root, "summary.json")));
  const { group, round, commit } = binding.request;
  assert.equal(summary.round, round); assert.equal(summary.commit, commit);
  assert.deepEqual(summary.options, binding.execution.effectiveOptions, "native effective options differ from bound command");
  assert.deepEqual(summary.measurement?.cpus, binding.resources.expectedCpus, "actual CPU configuration differs from binding");
  let report;
  if (group === "catalog-page") {
    // Reuse the catalog controller's provenance/options/CPU + strict report gate.
    const diagnosticNativeReport = validateCollected(summary, { round, commit, group: groupDescriptor(group),
      options: binding.execution.effectiveOptions, cpus: binding.resources.expectedCpus }, inspectCatalog);
    report = rawProofBlocked(group, diagnosticNativeReport, inspectRawSupport(group, summary, root, before));
  } else if (group === "json-api") {
    // The opt-in c-16 binding requests JSON_API_LOAD_LAYOUT; a default binding requests none and its result records none.
    assert.equal(summary.measurement?.loadLayout, binding.resources.requestedCpuEnv?.JSON_API_LOAD_LAYOUT, "JSON API load layout differs from binding");
    report = inspectBoundJson(summary, { load: reader(root), commit, verifyBoundProducer: (value) => verifyJsonProducer(binding, value) });
    assert.equal(report.attemptComplete, true, "strict JSON native attempt incomplete");
  } else {
    validateSummary(summary);
    checkMarketplaceContract(binding, summary);
    assert.equal(summary.split, undefined, "split evidence is not this isolated native command");
    report = rawProofBlocked(group, { outcomes: Object.fromEntries(binding.selection.apps.map((app) => [app,
      admitted(summary.apps[app]) ? "admitted-native-outcome" : "excluded-not-timed"])) }, inspectRawSupport(group, summary, root, before));
  }
  assert.ok(isDeepStrictEqual(tree(root), before), "snapshot changed during strict inspection");
  return report;
}

function rawProofBlocked(group, diagnosticNativeReport, rawSupport) {
  // These native APIs consume summaries, not the required raw tree. Even a complete
  // file inventory or matching copy hash cannot supply the missing replay/provenance.
  // A separately reviewed native complete validator is required before enabling a pass.
  return { qualification: "blocked", diagnosticNativeReport, rawSupport, rawCompleteness: "not-established",
    blockers: [`${group}: complete native raw-artifact replay is not integrated`,
      "raw checks/qualification, cold/load observations, CPU/stat counters, runtime/source/image binding and terminal cleanup must support every selected aggregate/outcome",
      "summary flags, matching aggregate fields, reporter exit zero and a hash of only present files cannot qualify native evidence"] };
}
