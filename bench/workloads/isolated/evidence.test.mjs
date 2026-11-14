import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { copyEvidence, digest, durable, inside, inspectEvidence, readRegular, tree } from "./evidence.mjs";
import { catalogResult } from "./test-fixtures/catalog.mjs";
import { groupDescriptor } from "../../catalog/group.mjs";
import { cpuSettings, parseArgs } from "../../catalog/contract.mjs";
import { result as jsonResult } from "../../json-api/test-fixtures.mjs";
import { marketplaceResult } from "./test-fixtures/marketplace.mjs";
import { parseArgs as marketplaceOptions } from "../../marketplace/run-contract.mjs";
import { selectedApps } from "../registry.mjs";
import { qualification } from "../../marketplace/feature-contract.mjs";
import { qualificationProbes } from "../../marketplace/qualification-fixture.mjs";
import { matchesWorkingSource } from "./worker.mjs";

function temporary(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "isolated-evidence-"));
  t.after(() => { assert.ok(inside(resolve(tmpdir()), resolve(root))); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
test("source attestation permits only byte-preserving CRLF conversion, never UTF-8 replacement", () => {
  assert.equal(matchesWorkingSource(Buffer.from("text\r\n"), digest("text\n")), true);
  assert.equal(matchesWorkingSource(Buffer.from([0xff, 13, 10]), digest(Buffer.from([0xff, 10]))), true);
  assert.equal(matchesWorkingSource(Buffer.from([0xff, 13, 10]), digest("\uFFFD\n")), false);
  assert.equal(matchesWorkingSource(Buffer.from([0, 13, 10]), digest(Buffer.from([0, 10]))), false);
  assert.equal(matchesWorkingSource(Buffer.from("text\nchanged"), digest("text\n")), false);
});
test("collection retains the entire tree, empty directories and raw failure bytes without overwrites", (t) => {
  const root = temporary(t), source = join(root, "source"), target = join(root, "copy");
  fs.mkdirSync(join(source, "raw", "empty"), { recursive: true });
  fs.writeFileSync(join(source, "summary.json"), '{"complete":false}');
  fs.writeFileSync(join(source, "raw", "failure.log"), Buffer.from([0, 1, 2, 255]));
  const manifest = copyEvidence(source, target);
  assert.deepEqual(tree(source), manifest); assert.deepEqual(tree(target), manifest);
  assert.ok(manifest.entries.some((e) => e.path === "raw/empty" && e.type === "directory"));
  assert.throws(() => copyEvidence(source, target), /EEXIST/);
  assert.throws(() => durable(join(target, "summary.json"), "success"), /EEXIST/);
  assert.equal(readRegular(join(source, "summary.json")).toString(), '{"complete":false}');
});

test("collection preserves native repository, vendor and scoped package names exactly", (t) => {
  const root = temporary(t), source = join(root, "source"), target = join(root, "copy");
  const paths = [
    "build-source/crates/corten/src/assets/unsafe/50%.css",
    "build-source/bench/fullstack/apps/nextjs/pages/marketplace/[locale]/[id].tsx",
    "build-source/bench/fullstack/apps/tanstack-start/src/routes/api.marketplace.$id.ts",
    "vendor/wasi-0.11.1+wasi-snapshot-preview1/Cargo.toml",
    "node_modules/@scope/package/package.json",
    "src/routes/+page.svelte",
  ];
  for (const [index, path] of paths.entries()) {
    fs.mkdirSync(dirname(join(source, path)), { recursive: true });
    fs.writeFileSync(join(source, path), Buffer.from([index, 0, 255]));
  }
  const manifest = copyEvidence(source, target);
  assert.deepEqual(tree(source), manifest); assert.deepEqual(tree(target), manifest);
  for (const [index, path] of paths.entries()) {
    assert.ok(manifest.entries.some((entry) => entry.path === path && entry.type === "file"));
    assert.deepEqual(readRegular(join(target, path)), Buffer.from([index, 0, 255]));
  }
});
test("links, junctions, hardlinks, case collisions and unsafe names fail closed", (t) => {
  const root = temporary(t), outside = join(root, "outside"); fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, "secret"), "do not copy");
  for (const mode of ["directory-link", "file-link", "hardlink", "collision", "unsafe"]) {
    const source = join(root, mode); fs.mkdirSync(source);
    if (mode === "directory-link") fs.symlinkSync(outside, join(source, "escape"), process.platform === "win32" ? "junction" : "dir");
    if (mode === "file-link") {
      // Junction coverage is unconditional on Windows without developer-mode symlink rights.
      if (process.platform === "win32") continue;
      fs.symlinkSync(join(outside, "secret"), join(source, "escape"));
    }
    if (mode === "hardlink") fs.linkSync(join(outside, "secret"), join(source, "escape"));
    if (mode === "collision") {
      if (process.platform === "win32") continue; // Windows cannot represent both names.
      fs.writeFileSync(join(source, "a"), "1"); fs.writeFileSync(join(source, "A"), "2");
    }
    if (mode === "unsafe") fs.writeFileSync(join(source, "space name"), "bad");
    assert.throws(() => copyEvidence(source, join(root, `${mode}-copy`)), /link|boundary|colliding|unsafe/);
    assert.equal(fs.readFileSync(join(outside, "secret"), "utf8"), "do not copy");
  }
  const source = join(root, "plain"); fs.mkdirSync(source);
  assert.throws(() => copyEvidence(source, join(source, "child")), /overlap/);
});
test("mutation during a copy cannot receive a manifest; partial copy and originals are preserved", (t) => {
  const root = temporary(t), source = join(root, "source"), file = join(source, "raw.log");
  fs.mkdirSync(source); fs.writeFileSync(file, "before");
  const original = fs.readFileSync; let reads = 0;
  const mock = t.mock.method(fs, "readFileSync", (...args) => {
    const bytes = original(...args);
    if (++reads === 2) fs.writeFileSync(file, "mutated content");
    return bytes;
  });
  syncBuiltinESMExports();
  try { assert.throws(() => copyEvidence(source, join(root, "copy")), /mutat/); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(fs.readFileSync(file, "utf8"), "mutated content");
  assert.ok(fs.existsSync(join(root, "copy")));
});
function catalogBinding() {
  const group = groupDescriptor("catalog-page");
  return { request: { group: group.group, round: "c2", commit: "a".repeat(40) }, selection: { apps: group.apps },
    execution: { effectiveOptions: parseArgs(["c2", "--group", group.group, "--build"], Object.fromEntries(group.apps.map((a) => [a, {}]))) },
    resources: { expectedCpus: cpuSettings({ CATALOG_APP_CPUS: "1", CATALOG_API_CPUS: "2-3", CATALOG_LOAD_CPUS: "4-7" }) } };
}
test("catalog reuses strict native/controller gates including exact options, source identity and CPU placement", (t) => {
  const root = temporary(t), b = catalogBinding(), s = catalogResult(b), file = join(root, "summary.json");
  fs.writeFileSync(file, JSON.stringify(s));
  const report = inspectEvidence(b, root);
  assert.equal(report.diagnosticNativeReport.baseline, true);
  assert.equal(report.qualification, "blocked"); assert.equal(report.rawCompleteness, "not-established");
  assert.equal(report.rawSupport.state, "missing-native-artifacts");
  assert.equal(report.rawSupport.required.length, 946, "derive all seven apps, both sources and all three passes from native capture layout");
  assert.equal(report.rawSupport.missing.length, 946);
  for (const path of ["fixture/corten/qualification.json", "api/gin/checks.json", "api/gin/p3-page/sat256.json",
    "api/gin/p3-page/sat256-cpu.json", "api/gin/p3-page/sat256-stats.log.json", "api/gin/p3-page/cold.log"])
    assert.ok(report.rawSupport.required.includes(path), path);
  // Even unrelated corrupt files alongside a summary cannot turn it into raw proof.
  fs.mkdirSync(join(root, "fixture")); fs.writeFileSync(join(root, "fixture", "bogus-raw.json"), "NOT JSON; wrong source/image/metrics");
  assert.equal(inspectEvidence(b, root).qualification, "blocked");
  for (const change of [(v) => { v.commit = "b".repeat(40); }, (v) => { v.commitAfter = "b".repeat(40); },
    (v) => { v.options.duration = 1; }, (v) => { v.measurement.cpus.app.cpuset = "0"; },
    (v) => { v.cleanupFailures.push({ error: "owned container still exists" }); }, (v) => { delete v.apps.gin; },
    (v) => { delete v.apps.corten.checks.api; }, (v) => { v.apps.corten.imageId = "a tag"; }]) {
    const bad = structuredClone(s); change(bad); fs.writeFileSync(file, JSON.stringify(bad)); assert.throws(() => inspectEvidence(b, root));
  }
});
test("JSON validator uses its actual hash-bound raw reader and cannot accept receipt strings or missing audits", (t) => {
  const root = temporary(t), fixture = jsonResult(), s = fixture.summary;
  const b = { request: { group: "json-api", round: s.round, commit: s.commit }, execution: { effectiveOptions: s.options }, resources: { expectedCpus: s.measurement.cpus } };
  for (const [path, value] of fixture.artifacts) {
    const target = join(root, path); fs.mkdirSync(dirname(target), { recursive: true }); fs.writeFileSync(target, value);
  }
  const file = join(root, "summary.json"); fs.writeFileSync(file, JSON.stringify(s));
  assert.equal(inspectEvidence(b, root).baseline, true);
  const key = s.group.cases[0].key;
  const raw = join(root, s.apps.corten.checks[key].raw.path), bytes = fs.readFileSync(raw);
  fs.writeFileSync(raw, "{}"); assert.throws(() => inspectEvidence(b, root), /strict JSON native attempt incomplete/); fs.writeFileSync(raw, bytes);
  const bad = structuredClone(s); bad.apps.corten.checks[key].native = "approved-by-caller";
  fs.writeFileSync(file, JSON.stringify(bad)); assert.throws(() => inspectEvidence(b, root), /strict JSON native attempt incomplete/);
  assert.notEqual(digest(bytes), digest("{}"));
});
test("marketplace uses its native schema, exact configuration and full excluded-candidate ledger", (t) => {
  const root = temporary(t), apps = selectedApps("localized-marketplace");
  const b = { request: { group: "localized-marketplace", round: "w2", commit: "a".repeat(40) }, selection: { apps },
    execution: { effectiveOptions: marketplaceOptions(["w2", "--group", "localized-marketplace", "--build"], Object.fromEntries(apps.map((a) => [a, {}]))) },
    resources: { expectedCpus: catalogBinding().resources.expectedCpus } };
  const s = marketplaceResult(b), path = join(root, "summary.json");
  fs.writeFileSync(path, JSON.stringify(s));
  assert.equal(inspectEvidence(b, root).qualification, "blocked");
  assert.equal(inspectEvidence(b, root).rawCompleteness, "not-established");
  const support = inspectEvidence(b, root).rawSupport;
  for (const path of ["fixture/nextjs/qualification.json", "api/corten/checks.json", "api/corten/p3-neutral-json/sat256.json",
    "api/corten/p3-neutral-json/sat256-cpu.json", "api/corten/p3-neutral-json/sat256-stats.log.json"])
    assert.ok(support.required.includes(path), path);
  const excluded = structuredClone(s), probes = qualificationProbes(); delete probes.page.headers["content-security-policy"];
  excluded.apps.nextjs.qualification.api = qualification(probes, "api"); excluded.apps.nextjs.runs = {}; excluded.apps.nextjs.phases = {};
  fs.writeFileSync(path, JSON.stringify(excluded)); assert.equal(inspectEvidence(b, root).diagnosticNativeReport.outcomes.nextjs, "excluded-not-timed");
  for (const change of [(v) => { v.finishedCommit = "b".repeat(40); }, (v) => { v.options.duration = 1; },
    (v) => { v.apps.corten.builtDirty = true; }, (v) => { delete v.apps.nextjs; }, (v) => { v.cleanupFailures.push("busy"); }]) {
    const bad = structuredClone(s); change(bad); fs.writeFileSync(path, JSON.stringify(bad)); assert.throws(() => inspectEvidence(b, root));
  }
});

test("present native raw artifacts must agree even when other required files are missing", (t) => {
  const root = temporary(t), b = catalogBinding(), s = catalogResult(b);
  fs.writeFileSync(join(root, "summary.json"), JSON.stringify(s));
  const directory = join(root, "fixture", "corten", "p1-page"); fs.mkdirSync(directory, { recursive: true });
  const path = join(directory, "cold.json");
  fs.writeFileSync(path, JSON.stringify({ ...s.apps.corten.runs["fixture-page"][0].cold, bytes: 1 }));
  assert.throws(() => inspectEvidence(b, root), /cold.json: native raw support contradicts summary/);
  fs.writeFileSync(path, JSON.stringify(s.apps.corten.runs["fixture-page"][0].cold));
  assert.equal(inspectEvidence(b, root).qualification, "blocked", "matching one file cannot establish complete raw proof");
  fs.writeFileSync(join(directory, "fixed.json"), "not JSON");
  assert.throws(() => inspectEvidence(b, root), /fixed.json: native raw support contradicts summary/);
});

test("snapshot inspection rejects hardlinked summaries before parsing or invoking native validation", (t) => {
  const root = temporary(t), source = join(root, "native"), external = join(root, "external.json");
  fs.mkdirSync(source); fs.writeFileSync(external, "not even JSON"); fs.linkSync(external, join(source, "summary.json"));
  assert.throws(() => inspectEvidence(catalogBinding(), source), /link\/special evidence file refused/);
  assert.equal(fs.readFileSync(external, "utf8"), "not even JSON");
});
