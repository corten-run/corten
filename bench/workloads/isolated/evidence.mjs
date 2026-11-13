import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { deploymentSha256 } from "../deployments.mjs";
import { validateCollected } from "../../catalog/droplet-contract.mjs";
import { inspectCatalog } from "../../catalog/report.mjs";
import { groupDescriptor } from "../../catalog/group.mjs";
import { reader } from "../../json-api/artifacts.mjs";
import { inspectJson } from "../../json-api/report.mjs";
import { validateSummary } from "../../marketplace/report.mjs";
import { admitted } from "../../marketplace/feature-contract.mjs";
import { inspectRawSupport } from "./raw-support.mjs";

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
export function readRegular(path) {
  physical(dirname(path));
  const before = lstatSync(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, "link/special evidence file refused");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    assert.ok(same(before, fstatSync(fd)), "file replaced before read");
    const bytes = readFileSync(fd);
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
export function syncDirectory(path) {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function safeName(name) {
  assert.ok(/^[A-Za-z0-9_.-]+$/.test(name) && name !== "." && name !== ".." && !name.endsWith(".")
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name), "unsafe evidence path segment");
}
export function tree(root) {
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
    } else {
      const bytes = readRegular(path);
      entries.push({ path: key, type: "file", bytes: bytes.length, sha256: digest(bytes) });
    }
  }
  walk(root, "");
  return { entries, sha256: deploymentSha256(entries) };
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
  assert.deepEqual(tree(source), before, "source tree mutated during collection");
  assert.deepEqual(tree(destination), before, "copied evidence differs");
  return before;
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
    report = inspectJson(summary, { load: reader(root), commit });
    assert.equal(report.baseline, true, `strict JSON report incomplete: ${report.warnings.join("; ")}`);
  } else {
    validateSummary(summary);
    assert.equal(summary.split, undefined, "split evidence is not this isolated native command");
    report = rawProofBlocked(group, { outcomes: Object.fromEntries(binding.selection.apps.map((app) => [app,
      admitted(summary.apps[app]) ? "admitted-native-outcome" : "excluded-not-timed"])) }, inspectRawSupport(group, summary, root, before));
  }
  assert.deepEqual(tree(root), before, "snapshot changed during strict inspection");
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
