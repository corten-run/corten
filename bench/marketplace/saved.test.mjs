import assert from "node:assert/strict";
import test from "node:test";
import { summaryFixture, writeSavedFixture } from "./saved-fixture.mjs";
import { report, validateSummary } from "./report.mjs";
import { validateSaved } from "./validate.mjs";
import { containerReceipt, evidenceVersion, imageReceipt, nodeImage, producerSchema, sourceTree } from "./raw-contract.mjs";
import childProcess, { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { passPlan, resultSchema, stageAggregate, timedProfiles, v5Schema } from "./run-contract.mjs";
import { boundedFeatureProfile, featureProfile } from "./feature-contract.mjs";
import { sampleStats, summarizeSamples } from "../catalog/stats.mjs";

const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const invalid = (fn) => assert.throws(fn, (e) => e.code === "MARKETPLACE_EVIDENCE_INVALID");
function temporary(t) {
  const folder = mkdtempSync(join(tmpdir(), "marketplace-raw-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

// Real Git reads even on a depth-one checkout. Only redirect their working
// directory; no objects are added to the checkout.
function measuredSource(t, schema, declaration = "  export\tconst resultSchema  =\n 'marketplace-results/v5' ;\n") {
  if (schema === resultSchema) return { commit, tree: sourceTree(commit) };
  const repo = temporary(t), exec = childProcess.execFileSync;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const git = (args, input) => exec("git", args, { cwd: repo, env, input, encoding: "utf8", windowsHide: true }).trim();
  git(["init", "-q", "--bare", "--object-format=sha1"]);
  const blob = git(["hash-object", "-w", "--stdin"], declaration);
  const app = git(["mktree"], `100644 blob ${blob}\trun-contract.mjs\n`);
  const bench = git(["mktree"], `040000 tree ${app}\tmarketplace\n`);
  const tree = git(["mktree"], `040000 tree ${bench}\tbench\n`);
  const who = "fixture <fixture@example.invalid> 1 +0000";
  const measured = git(["hash-object", "-t", "commit", "-w", "--stdin"], `tree ${tree}\nauthor ${who}\ncommitter ${who}\n\nSynthetic per-locale source\n`);
  const redirect = t.mock.method(childProcess, "execFileSync", (file, args, options) => {
    assert.equal(file, "git"); return exec(file, args, { ...options, cwd: repo });
  });
  syncBuiltinESMExports();
  t.after(() => { redirect.mock.restore(); syncBuiltinESMExports(); });
  return { commit: measured, tree };
}

test("a summary-only native round passes the read-only summary reader", () => {
  assert.equal(validateSummary(summaryFixture("a".repeat(40))).complete, true);
});

test("marketplace Docker projections retain omitted optional defaults as null without replacing commands", () => {
  for (const command of [{ Entrypoint: ["k6"] }, { Entrypoint: ["k6"], Cmd: null }, { Cmd: ["node"] }, { Entrypoint: null, Cmd: ["node"] }]) {
    const image = { Config: command }, container = { Name: "/synthetic", Config: { ...command, Env: [] }, HostConfig: {}, Mounts: [] };
    for (const receipt of [imageReceipt(image), containerReceipt(container)]) {
      const saved = JSON.parse(JSON.stringify(receipt));
      assert.equal(Object.hasOwn(saved, "cmd"), true); assert.equal(Object.hasOwn(saved, "entrypoint"), true);
      assert.deepEqual(saved.cmd, command.Cmd ?? null); assert.deepEqual(saved.entrypoint, command.Entrypoint ?? null);
    }
  }
  assert.throws(() => imageReceipt({}));
  assert.throws(() => containerReceipt({ Name: "/synthetic" }));
  for (const Cmd of ["node", ["node\0evil"], [1]]) {
    assert.deepEqual(imageReceipt({ Config: { Cmd } }).cmd, Cmd, "malformed values must not normalize to an empty default");
  }
});

test("marketplace checker image Config must be an object before optional defaults reach replay", async (t) => {
  const folder = temporary(t), args = { folder, round: "r17", commit };
  writeSavedFixture(folder, commit, sourceTree(commit));
  assert.ok(validateSaved(args));
  const path = join(folder, "tools.json"), tools = JSON.parse(readFileSync(path)), original = tools.checker;
  const projectAndReplay = (Config) => {
    tools.checker = imageReceipt({ Id: original.id, Size: original.bytes, RepoDigests: original.repoDigests, Config });
    writeFileSync(path, JSON.stringify(tools));
    assert.ok(validateSaved(args));
  };
  for (const Config of [{}, { Entrypoint: null, Cmd: null }]) projectAndReplay(Config);
  for (const Config of [undefined, null, [], "malformed", false, true, 0, 42]) {
    await t.test(`reject ${JSON.stringify(Config) ?? "missing"}`, () => {
      assert.throws(() => projectAndReplay(Config), /image configuration missing/);
    });
  }
});

test("native saved validation rejects summary-only, historical and malformed proof as invalid", (t) => {
  const folder = temporary(t), args = { folder, round: "r17", commit };
  writeFileSync(join(folder, "summary.json"), JSON.stringify(summaryFixture(commit)));
  invalid(() => validateSaved(args));
  writeFileSync(join(folder, "summary.json"), JSON.stringify({ ...summaryFixture(commit), evidenceVersion })); invalid(() => validateSaved(args));
  writeFileSync(join(folder, "summary.json"), JSON.stringify({ ...summaryFixture(commit), evidenceVersion: "marketplace-raw/v1" })); invalid(() => validateSaved(args));
  writeFileSync(join(folder, "summary.json"), "{"); invalid(() => validateSaved(args));
  unlinkSync(join(folder, "summary.json")); invalid(() => validateSaved(args));
});

test("complete native fixture replays every raw profile, pass, phase, gate and cleanup", (t) => {
  const folder = temporary(t), args = { folder, round: "r17", commit };
  const expected = writeSavedFixture(folder, commit, sourceTree(commit));
  assert.equal(expected.measurement.featureProfile, boundedFeatureProfile);
  assert.equal(JSON.parse(readFileSync(join(folder, "fixture/corten/check-container.json"))).memoryBytes, 2 * 2 ** 30, "native browser gate uses 2 GiB, not the app's 1 GiB");
  const hashes = () => Object.fromEntries(readdirSync(folder, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => {
    const path = join(d.parentPath, d.name); return [path, createHash("sha256").update(readFileSync(path)).digest("hex")];
  }));
  const before = hashes();
  assert.deepEqual(validateSaved(args), expected);
  const command = spawnSync(process.execPath, ["bench/marketplace/validate.mjs", folder, "r17", commit], { encoding: "utf8", timeout: 30000 });
  assert.equal(command.status, 0, command.stderr); assert.match(command.stdout, /raw saved evidence valid/);
  assert.deepEqual(hashes(), before, "saved validation must not write evidence");
});

test("saved evidence replays from a checkout of its measured commit, never against another checkout's image pin", (t) => {
  const folder = temporary(t), args = { folder, round: "r17", commit };
  writeSavedFixture(folder, commit, sourceTree(commit));
  assert.ok(validateSaved(args), "the measuring checkout replays its own evidence");
  // The same evidence as a checkout still pinned to the Debian 12 upstream image wrote it.
  const earlier = "node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1";
  let rewritten = 0;
  for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true })) if (entry.isFile() && entry.name.endsWith(".json")) {
    const path = join(entry.parentPath, entry.name), text = readFileSync(path, "utf8");
    if (text.includes(nodeImage)) { writeFileSync(path, text.replaceAll(nodeImage, earlier)); rewritten++; }
  }
  assert.ok(rewritten >= 3, "summary, upstream and CPU sidecar receipts carry the image");
  assert.throws(() => validateSaved(args), (e) => e.code === "MARKETPLACE_EVIDENCE_INVALID"
    && e.message.includes(`retained image is not this checkout's pin ${nodeImage}; validate from a checkout of the measured commit ${commit}`)
    && !e.message.includes(earlier));
});

test("native replay admits the producer's decimal sum overshoot, not an inconsistent mean", async (t) => {
  const folder = temporary(t), args = { folder, round: "r17", commit };
  const s = writeSavedFixture(folder, commit, sourceTree(commit));
  const app = s.apps.corten, key = "api-neutral-json", runs = app.runs[key];
  const phase = runs[0].phases.sat64;
  const log = join(folder, "api/corten/p1-neutral-json/sat64-stats.log");
  const fixture = JSON.parse(readFileSync(`${log}.json`)).samples;
  const names = Object.keys(fixture), upstream = names.find((name) => name.endsWith("-upstream"));
  const container = names.find((name) => name !== upstream), start = fixture[upstream][0].t;
  for (const [name, mem] of [[container, 102.9], [upstream, 100.9]]) {
    fixture[name] = Array.from({ length: 31 }, (_, i) => ({ t: start + i * 350, cpu: 100, mem }));
  }
  const rows = names.flatMap((Name) => fixture[Name].map((p) => ({ ...p, Name }))).sort((a, b) => a.t - b.t);
  const fake = new EventEmitter();
  fake.stdout = new PassThrough(); fake.stderr = new PassThrough();
  fake.kill = () => { setImmediate(() => fake.emit("close", 0)); return true; };
  const spawn = t.mock.method(childProcess, "spawn", () => fake);
  let now = start;
  const clock = t.mock.method(Date, "now", () => now);
  syncBuiltinESMExports();
  let stats;
  try {
    const sampler = sampleStats(names, log, 10);
    for (const { Name, t, cpu, mem } of rows) {
      now = t;
      fake.stdout.write(JSON.stringify({ Name, CPUPerc: `${cpu}%`, MemUsage: `${mem}MiB / ${Name === upstream ? "512MiB" : "1GiB"}` }) + "\n");
    }
    stats = await sampler.stop();
  } finally {
    spawn.mock.restore(); clock.mock.restore(); syncBuiltinESMExports();
  }
  assert.equal(stats[upstream].memAvgMiB, 100.90000000000003);
  assert.equal(stats[upstream].memMaxMiB, 100.9);
  assert.equal(stats[container].memAvgMiB, 102.90000000000006);
  assert.equal(stats[container].memMaxMiB, 102.9);
  const saved = JSON.parse(readFileSync(`${log}.json`));
  const writeSummary = () => writeFileSync(join(folder, "summary.json"), JSON.stringify(s));
  const write = (avg) => {
    saved.summary[upstream] = { ...stats[upstream], memAvgMiB: avg };
    Object.assign(phase.upstream, saved.summary[upstream]);
    writeFileSync(`${log}.json`, JSON.stringify(saved));
    writeSummary();
  };
  Object.assign(phase.upstream, stats[upstream]);
  Object.assign(phase, stats[container]);
  const setAppMean = (mean) => {
    phase.memAvgMiB = mean;
    app.phases[key].sat64 = stageAggregate(runs, "sat64", 3);
  };
  setAppMean(stats[container].memAvgMiB);
  writeSummary();
  assert.deepEqual(validateSaved(args), s);
  assert.match(report(s), /Marketplace v2 r17/);
  setAppMean(102.90000000000003);
  validateSummary(s);
  // The adjacent sums round to .03 and .06, skipping .05 despite the peak bound.
  setAppMean(102.90000000000005);
  assert.throws(() => validateSummary(s), /missing\/invalid measurement/);
  setAppMean(stats[container].memAvgMiB);
  const constantHistory = (count) => summarizeSamples(Array(count).fill({ cpu: 100, mem: 100.8 }));
  const atLimit = constantHistory(1000), overLimit = constantHistory(1001);
  for (const v of [atLimit, overLimit]) assert.ok(v.memAvgMiB > v.memMaxMiB);
  Object.assign(phase.upstream, atLimit);
  validateSummary(s);
  Object.assign(phase.upstream, overLimit);
  assert.throws(() => validateSummary(s), /missing\/invalid measurement/);
  Object.assign(phase.upstream, stats[upstream]);

  // Even when both saved summaries agree and the number is within the rounding
  // envelope, the exact mean still has to agree with the raw Docker samples.
  write(100.90000000000002);
  validateSummary(s);
  assert.throws(() => validateSaved(args), /stats aggregate differs from raw history/);

  for (const bad of [100.90000000000005, 101, 0, -1, Infinity, NaN, undefined]) {
    write(bad);
    assert.throws(() => validateSummary(s), /missing\/invalid measurement/);
    invalid(() => validateSaved(args));
  }
});

test("v6 cannot claim historical qualification even with matching raw receipts", (t) => {
  const folder = temporary(t), args = { folder, round: "r17", commit };
  const summary = writeSavedFixture(folder, commit, sourceTree(commit), { historical: true });
  assert.throws(() => validateSummary(summary), /bounded qualification/);
  assert.throws(() => validateSaved(args), /bounded qualification/);
});

for (const historical of [true, false]) test(`native historical=${historical} qualification replays but raw receipts cannot mix`, (t) => {
  const schema = historical ? v5Schema : resultSchema;
  const measured = measuredSource(t, schema);
  const folder = temporary(t), args = { folder, round: "r17", commit: measured.commit };
  const expected = writeSavedFixture(folder, measured.commit, measured.tree, { historical, schema });
  assert.equal(expected.measurement.featureProfile, historical ? featureProfile : boundedFeatureProfile);
  assert.deepEqual(validateSaved(args), expected);
  const other = summaryFixture(commit, { historical: !historical });
  const raw = join(folder, "api/corten/qualification.json"), imagesPath = join(folder, "images.json");
  const saved = readFileSync(raw);
  writeFileSync(raw, JSON.stringify(other.apps.corten.qualification.api));
  invalid(() => validateSaved(args));
  writeFileSync(raw, saved);
  const images = JSON.parse(readFileSync(imagesPath));
  images.corten.labels["run.corten.marketplace.profile"] = other.measurement.featureProfile;
  writeFileSync(imagesPath, JSON.stringify(images));
  invalid(() => validateSaved(args));
});

test("native replay requires the retained executable identity and raw version probe", (t) => {
  const folder = temporary(t), args = { folder, round: "r17", commit };
  const expected = writeSavedFixture(folder, commit, sourceTree(commit));
  for (const field of ["platform", "version", "versionOutput", "repoDigests"]) {
    const changed = structuredClone(expected); delete changed.tools.k6[field];
    writeFileSync(join(folder, "summary.json"), JSON.stringify(changed));
    invalid(() => validateSaved(args));
  }
  writeFileSync(join(folder, "summary.json"), JSON.stringify(expected));
  const tools = JSON.parse(readFileSync(join(folder, "tools.json")));
  tools.k6.versionOutput = "k6 v2.4.0 (a different retained probe)";
  writeFileSync(join(folder, "tools.json"), JSON.stringify(tools));
  invalid(() => validateSaved(args));
  writeFileSync(join(folder, "summary.json"), JSON.stringify({ ...expected, evidenceVersion: "marketplace-raw/v2" }));
  invalid(() => validateSaved(args));
});

for (const schema of [v5Schema, resultSchema]) test(`native ${schema} binds page attempts, neutral JSON and cold path to the schema`, (t) => {
  const { commit: measured, tree } = measuredSource(t, schema);
  const folder = temporary(t), args = { folder, round: "r17", commit: measured };
  const s = writeSavedFixture(folder, measured, tree, { schema });
  assert.deepEqual(validateSaved(args), s);
  const rotating = schema === resultSchema, locale = rotating ? "rotating" : "en-US";
  const page = `fixture/corten/p1-${locale}-page`, json = "api/corten/p1-neutral-json";
  const probe = (path, edit, expected) => {
    const file = join(folder, path), saved = readFileSync(file), v = JSON.parse(saved);
    try { edit(v); writeFileSync(file, JSON.stringify(v)); assert.throws(() => validateSaved(args), expected); }
    finally { writeFileSync(file, saved); }
  };
  probe("summary.json", (v) => { v.schema = rotating ? v5Schema : resultSchema; }, /profile matrix/);
  probe(`${json}/fixed-receipt.json`, (v) => { v.load.env.LOCALE = "en-US"; }, /LOCALE/);
  probe(`${json}/fixed.json`, (v) => { v.metrics.marketplace_locale_en_US = { count: 0, rate: 0 }; }, /unexpected locale counter/);
  probe(`${page}/fixed-receipt.json`, (v) => { v.load.env.LOCALE = rotating ? "en-US" : "rotating"; }, /LOCALE/);
  const wrongCold = "/marketplace/fr-FR/item_1";
  probe("summary.json", (v) => { v.apps.corten.runs[`fixture-${locale}-page`][0].cold.path = wrongCold; }, /item_1/);
  probe(`${page}/probe-container.json`, (v) => { v.cmd[3] = wrongCold; }, /item_1/);
  if (!rotating) {
    probe(`${page}/fixed.json`, (v) => { v.metrics.marketplace_locale_en_US = v.metrics.http_reqs; }, /unexpected locale counter/);
    return;
  }
  for (const [phase, edit, error] of [
    ["warmup", (m) => { delete m.marketplace_locale_fr_FR; }, /cover HTTP/],
    ["fixed", (m) => { m.marketplace_locale_en_US = m.http_reqs; m.marketplace_locale_fr_FR = m.marketplace_locale_de_DE = { rate: 0, count: 0 }; }, /rotation/],
    ["sat64", (m) => { m.marketplace_locale_de_DE.rate = 0; }, /engine elapsed clock/],
    ["sat256", (m) => { m.marketplace_locale_it_IT = { count: 0, rate: 0 }; }, /unexpected locale counter/],
  ]) probe(`${page}/${phase}.json`, (v) => edit(v.metrics), error);
});

for (const schema of [v5Schema, resultSchema]) test(`coherent raw evidence cannot change the ${schema} producer at the same commit and tree`, (t) => {
  const { commit: measured, tree } = measuredSource(t, schema), wrongSchema = schema === v5Schema ? resultSchema : v5Schema;
  const folder = temporary(t);
  const s = writeSavedFixture(folder, measured, tree, { schema: wrongSchema });
  validateSummary(s); // Not just a relabeled summary: all reports and raw phases agree.
  assert.equal(sourceTree(measured), tree);
  assert.throws(() => validateSaved({ folder, round: "r17", commit: measured }), /measured producer schema/);
});

for (const [label, declaration] of [
  ["ambiguous", `export const resultSchema = "${v5Schema}";\nexport const resultSchema = "${resultSchema}";`],
  ["computed", `export const resultSchema = "${v5Schema}" + suffix;`],
  ["oversized", " ".repeat(65536) + `export const resultSchema = "${v5Schema}";`],
]) test(`reject ${label} measured schema contract`, (t) => {
  const { tree } = measuredSource(t, v5Schema, declaration);
  assert.throws(() => producerSchema(tree), /measured producer schema/);
});

test("hostile saved edits fail replay, even when the summary remains internally plausible", (t) => {
  const folder = temporary(t), args = { folder, round: "r17", commit };
  writeSavedFixture(folder, commit, sourceTree(commit));
  const base = "fixture/corten/p1-rotating-page", api = "api/corten/p1-neutral-json";
  const change = (path, mutate) => {
    const full = join(folder, path), saved = readFileSync(full);
    try { const value = JSON.parse(saved); mutate(value); writeFileSync(full, JSON.stringify(value)); invalid(() => validateSaved(args)); }
    finally { writeFileSync(full, saved); }
  };
  for (const path of ["source.json", "images.json", "tools.json", "cleanup.json", "fixture.json", "fixture/corten/checks.json", "api/corten/qualification.json", `${base}/cold.log`, `${base}/fixed.json`, `${base}/fixed-clock.json`, `${base}/fixed-cpu.json`, `${base}/fixed-stats.log`, `${base}/fixed-stats.log.json`, `${base}/fixed-receipt.json`]) {
    const full = join(folder, path), saved = readFileSync(full);
    try { unlinkSync(full); invalid(() => validateSaved(args)); writeFileSync(full, saved); truncateSync(full, 1); invalid(() => validateSaved(args)); }
    finally { writeFileSync(full, saved); }
  }
  change(`${base}/fixed-cpu.json`, (v) => { v[Object.keys(v)[0]].usec++; });
  change(`${base}/fixed-stats.log.json`, (v) => { v.samples[Object.keys(v.samples)[0]][0].cpu++; });
  change(`${base}/fixed-stats.log.json`, (v) => { v.summary[Object.keys(v.summary)[0]].cpuAvgPct++; });
  change(`${base}/fixed-receipt.json`, (v) => { v.after[Object.keys(v.after)[0]]++; });
  change(`${base}/fixed-receipt.json`, (v) => { v.app.imageId = `sha256:${"c".repeat(64)}`; });
  change(`${base}/fixed-receipt.json`, (v) => { v.app.env.MARKETPLACE_SOURCE = "api"; });
  change(`${base}/fixed-receipt.json`, (v) => { v.app.cpuset = "4-7"; });
  change(`${base}/fixed-receipt.json`, (v) => { v.app.memoryBytes--; });
  change(`${base}/fixed-receipt.json`, (v) => { v.load.env.RATE = "1"; });
  change(`${base}/fixed-receipt.json`, (v) => { v.load.entrypoint = ["/bin/sh", "-c", "sleep 15"]; });
  change(`${base}/fixed-receipt.json`, (v) => { v.load.mounts.push({ type: "bind", source: "/different/load.js", destination: "/bench/marketplace/load.js", readOnly: true }); });
  change("fixture/corten/check-container.json", (v) => { v.mounts.find((m) => m.destination === "/repo").source = "/unrelated-checkout"; });
  change("fixture/corten/check-container.json", (v) => { v.mounts.find((m) => m.destination === "/results").source = "/unrelated-results"; });
  change("fixture/corten/check-container.json", (v) => { v.entrypoint = ["/bin/sh", "-c", "true"]; });
  change("fixture/corten/check-container.json", (v) => { v.memoryBytes = 2 ** 30; });
  change("fixture/corten/check-container.json", (v) => { v.mounts.push({ type: "bind", source: "/other/check.mjs", destination: "/repo/bench/marketplace/check.mjs", readOnly: true }); });
  change("tools.json", (v) => { v.k6.entrypoint = ["/bin/sh"]; });
  for (const missing of [undefined, null, [], "node", ["node\0evil"]]) {
    change(`${base}/fixed-receipt.json`, (v) => { v.load.cmd = missing; });
    change("fixture/corten/check-container.json", (v) => { v.cmd = missing; });
    change(`${base}/fixed-receipt.json`, (v) => { v.app.cmd = missing; });
  }
  change(`${base}/fixed-clock.json`, (v) => { v.testRunDurationMs = 0.0015; });
  change(`${base}/fixed-receipt.json`, (v) => { v.load.state.FinishedAt = v.load.state.StartedAt; });
  change(`${base}/fixed-receipt.json`, (v) => { v.cpu.state.StartedAt = "2026-01-01T00:01:00Z"; });
  change(`${api}/fixed-receipt.json`, (v) => { v.upstreamReads.after.answers[503] = 1; });
  change(`${api}/fixed-receipt.json`, (v) => { v.upstreamReads.after = v.upstreamReads.before; });
  change("images.json", (v) => { v.corten.labels["run.corten.marketplace.commit"] = "c".repeat(40); });
  change("source.json", (v) => { v.tree = "c".repeat(40); });
  change("summary.json", (v) => { v.host.cpu = "edited host"; });
  change("summary.json", (v) => { v.options.build = "true"; });
  change("summary.json", (v) => { v.apps.corten.phases["fixture-rotating-page"].fixed.rps.median++; });
  change("summary.json", (v) => { v.apps.corten.runs["fixture-rotating-page"][0].phases.fixed.cpuUsec++; });
  change("summary.json", (v) => {
    const a = v.apps.corten, runs = a.runs["fixture-rotating-page"], p = runs[0].phases.fixed;
    p.cpuUsec *= 2; p.perCpuSecond = p.requests / (p.cpuUsec / 1e6); a.phases["fixture-rotating-page"].fixed = stageAggregate(runs, "fixed", 3);
    validateSummary(v); // Self-consistent edited summary still disagrees with retained counters.
  });
  change("summary.json", (v) => { delete v.apps.corten.runs["api-neutral-json"]; });
  change("fixture/corten/checks.json", (v) => { v.profiles.pop(); });
  change("api/corten/qualification.json", (v) => { v.probes.page.ms++; });
  change("fixture/corten/check-container.json", (v) => { v.state.FinishedAt = "2026-01-01T01:01:00Z"; });
  change("cleanup.json", (v) => { v.removed.pop(); });
  change("cleanup.json", (v) => { v.remaining.containers = "still-running"; });
  change(`${base}/cold.json`, (v) => { v.first200MsFromContainerStart++; });
  invalid(() => validateSaved({ ...args, round: "r18" })); invalid(() => validateSaved({ ...args, commit: "c".repeat(40) }));
  assert.equal(validateSaved(args).complete, true);
});

test("stopped profiles replay actual phase/sidecar/event evidence, never invented numeric passes", (t) => {
  const folder = temporary(t), args = { folder, round: "r17", commit };
  const s = writeSavedFixture(folder, commit, sourceTree(commit));
  const a = s.apps.corten, runs = a.runs["api-neutral-json"], run = runs[2], base = "api/corten/p3-neutral-json";
  const volume = { kind: "volume", id: "e".repeat(64), name: "e".repeat(64) };
  // Synthetic image-declared anonymous volume: every snapshot and cleanup must retain it.
  for (const file of ["cold-container.json", ...["warmup", "fixed", "sat64", "sat256"].map((p) => `${p}-receipt.json`)]) {
    const path = join(folder, base, file), v = JSON.parse(readFileSync(path, "utf8"));
    (v.app ?? v).mounts.push({ type: "volume", name: volume.name, source: "/synthetic/volume", destination: "/data", readOnly: false });
    writeFileSync(path, JSON.stringify(v));
  }
  const cleanupPath = join(folder, "cleanup.json"), cleanup = JSON.parse(readFileSync(cleanupPath, "utf8"));
  cleanup.created.push(volume); cleanup.removed.push(volume); writeFileSync(cleanupPath, JSON.stringify(cleanup));
  const path = join(folder, base, "sat64-receipt.json"), raw = JSON.parse(readFileSync(path, "utf8"));
  raw.app.state = { ...raw.app.state, Running: false, OOMKilled: true, ExitCode: 137, FinishedAt: new Date(Date.parse(raw.seen.phaseStart) + 5000).toISOString() };
  raw.seen.app = raw.app.state; raw.after = {};
  raw.seen.sidecars = [raw.cpu, raw.upstream].map((c) => ({ name: c.name, startedAt: c.state.StartedAt, state: c.state }));
  raw.seen.events = [{ action: "oom", ms: Date.parse(raw.app.state.FinishedAt) }];
  run.complete = false; run.stopped = { pass: 3, phase: "sat64", exitCode: 137, oomKilled: true };
  delete run.phases.sat64; delete run.phases.sat256;
  for (const p of ["fixed", "sat64", "sat256"]) a.phases["api-neutral-json"][p] = stageAggregate(runs, p, 3);
  writeFileSync(path, JSON.stringify(raw)); writeFileSync(join(folder, base, "sat64-cpu.json"), "{}");
  writeFileSync(join(folder, "summary.json"), JSON.stringify(s));
  assert.equal(validateSaved(args).complete, true);
  const original = readFileSync(path);
  for (const mutate of [
    (v) => { v.load.state.OOMKilled = true; v.load.state.ExitCode = 137; },
    (v) => { v.load.state.ExitCode = 1; },
    (v) => { v.load.state.Running = true; },
    (v) => { v.load.state.StartedAt = "2025-01-01T00:00:00.000Z"; v.load.state.FinishedAt = "2025-01-01T00:00:00.001Z"; },
    (v) => { v.app.state.FinishedAt = new Date(Date.parse(v.seen.phaseStart) + 1).toISOString(); v.seen.app = v.app.state; v.seen.events[0].ms = Date.parse(v.app.state.FinishedAt); },
  ]) {
    const v = JSON.parse(original); mutate(v); writeFileSync(path, JSON.stringify(v)); invalid(() => validateSaved(args));
    writeFileSync(path, original);
  }
  cleanup.removed.pop(); writeFileSync(cleanupPath, JSON.stringify(cleanup)); invalid(() => validateSaved(args));
  cleanup.removed.push(volume); writeFileSync(cleanupPath, JSON.stringify(cleanup));
  raw.upstreamReads.after.answers[503] = 1; writeFileSync(path, JSON.stringify(raw)); invalid(() => validateSaved(args));
  delete raw.upstreamReads.after.answers[503]; raw.seen.events = [{ action: "kill", ms: Date.parse(raw.app.state.FinishedAt) }];
  writeFileSync(path, JSON.stringify(raw)); invalid(() => validateSaved(args));
});

test("source lookup ignores inherited Git redirects/config and never admits an absent local object", () => {
  const expected = sourceTree(commit);
  const edits = { GIT_DIR: "does-not-exist", GIT_WORK_TREE: "does-not-exist", GIT_REPLACE_REF_BASE: "refs/hostile/", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "true" };
  const before = Object.fromEntries(Object.keys(edits).map((k) => [k, process.env[k]]));
  try { Object.assign(process.env, edits); assert.equal(sourceTree(commit), expected); assert.throws(() => sourceTree("f".repeat(40))); }
  finally { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

test("native run windows follow the serial rotated pass plan and cannot overlap", (t) => {
  const folder = temporary(t), args = { folder, round: "r17", commit };
  const s = writeSavedFixture(folder, commit, sourceTree(commit));
  const plan = [...passPlan(s.options.passes, s.options.apps, timedProfiles, () => [])];
  const runs = plan.map(({ app, profile, pass }) => s.apps[app].runs[profile.key].find((r) => r.pass === pass));
  assert.equal(new Set(runs.map((r) => r.startedAt)).size, runs.length, "fixture must model distinct serial runs");
  for (let i = 1; i < runs.length; i++) assert.ok(Date.parse(runs[i].startedAt) >= Date.parse(runs[i - 1].finishedAt));
  runs[1].startedAt = runs[0].startedAt;
  writeFileSync(join(folder, "summary.json"), JSON.stringify(s)); invalid(() => validateSaved(args));
});

test("coherent summary aggregates cannot hide a k6 count/rate/elapsed contradiction", (t) => {
  const folder = temporary(t), args = { folder, round: "r17", commit };
  const s = writeSavedFixture(folder, commit, sourceTree(commit));
  const path = join(folder, "fixture/corten/p1-rotating-page/fixed.json"), raw = JSON.parse(readFileSync(path));
  raw.metrics.http_reqs.rate = 1e9; writeFileSync(path, JSON.stringify(raw));
  const a = s.apps.corten, runs = a.runs["fixture-rotating-page"];
  runs[0].phases.fixed.rps = 1e9; a.phases["fixture-rotating-page"].fixed = stageAggregate(runs, "fixed", 3);
  validateSummary(s); writeFileSync(join(folder, "summary.json"), JSON.stringify(s)); invalid(() => validateSaved(args));
});

test("safe entry rejects UNC, links, hardlinks, oversized files and deep trees", (t) => {
  for (const folder of ["\\\\server\\share", "//server/share", "\\\\?\\C:\\proof", "https://example.com/proof", "C:\\proof:stream"]) invalid(() => validateSaved({ folder, round: "r17", commit }));
  const root = temporary(t), folder = join(root, "evidence"); mkdirSync(folder);
  const outside = join(root, "outside.json"); writeFileSync(outside, "{}");
  linkSync(outside, join(folder, "summary.json")); invalid(() => validateSaved({ folder, round: "r17", commit })); unlinkSync(join(folder, "summary.json"));
  // Junction creation works without Windows symlink privilege.
  symlinkSync(folder, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  invalid(() => validateSaved({ folder: join(root, "linked"), round: "r17", commit }));
  symlinkSync(root, join(folder, "escape"), process.platform === "win32" ? "junction" : "dir");
  invalid(() => validateSaved({ folder, round: "r17", commit })); unlinkSync(join(folder, "escape"));
  writeFileSync(join(folder, "summary.json"), "{}"); truncateSync(join(folder, "summary.json"), 32 * 2 ** 20 + 1);
  invalid(() => validateSaved({ folder, round: "r17", commit }));
  const deep = join(folder, ...Array(10).fill("deep")); mkdirSync(deep, { recursive: true }); invalid(() => validateSaved({ folder, round: "r17", commit }));
});
