// Intrinsic saved-evidence replay, not operator approval or host-deletion authority.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { verify } from "../../../hardening/verify.mjs";
import { budgets, matrix, parseArgs, registryDigest } from "../../../hardening/plan.mjs";
import { selectedApps } from "../../registry.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => assert.ok(isDeepStrictEqual(a, b));
const missing = (code) => Object.assign(new Error(code), { code: "ENOENT" });

// The native verifier follows manifests. Check the entire physical tree first,
// including unreferenced files, and seal it again after synchronous replay.
function saved(folder) {
  assert.ok(typeof folder === "string" && folder.length && !folder.replaceAll("\\", "/").startsWith("//"));
  const root = resolve(folder);
  for (let p = root;; p = dirname(p)) {
    const s = lstatSync(p); assert.ok(s.isDirectory() && !s.isSymbolicLink());
    if (p === dirname(p)) break;
  }
  const scan = () => {
    const files = new Map(), names = new Set(); let bytes = 0, entries = 0;
    const walk = (path = "", depth = 0) => {
      assert.ok(depth <= 64);
      for (const name of readdirSync(join(root, path)).sort()) {
        assert.ok(++entries <= 100000 && !/[\\:"<>|?*\x00-\x1f\x7f]/.test(name)
          && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name));
        const key = path ? `${path}/${name}` : name, stat = lstatSync(join(root, key));
        assert.ok(!names.has(key.toLowerCase()) && !stat.isSymbolicLink()); names.add(key.toLowerCase());
        if (stat.isDirectory()) walk(key, depth + 1);
        else {
          assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 256 * 1024 ** 2);
          bytes += stat.size; assert.ok(bytes <= 1024 ** 3);
          const body = readFileSync(join(root, key)), after = lstatSync(join(root, key));
          same([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink],
            [after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs, after.nlink]);
          files.set(key, { hash: hash(body), size: body.length, ino: stat.ino, mtime: stat.mtimeMs, ctime: stat.ctimeMs });
        }
      }
    };
    walk(); return files;
  };
  const seal = scan();
  return { root, read(path) {
    assert.ok(path.split("/").every((p) => p && p !== "." && p !== "..") && !/[\\:]/.test(path));
    if (!seal.has(path)) throw missing("native-artifact-missing");
    const body = readFileSync(join(root, path)); same(hash(body), seal.get(path).hash);
    assert.ok(body.length <= 32 * 1024 ** 2); return JSON.parse(body);
  }, finish() { same(scan(), seal); } };
}

function bindingOptions(binding) {
  const { request, selection, execution, sources, resources } = binding;
  same(request.group, "hardening"); same(request.recipe, "native-defaults");
  assert.match(request.round, /^w[1-9]\d*$/); assert.match(request.commit, /^[a-f0-9]{40}$/);
  same(selection.group, request.group); same(selection.apps, selectedApps(request.group));
  same(selection.contractSha256, registryDigest); same(sources.commit, request.commit);
  assert.match(binding.subjectSha256, /^[a-f0-9]{64}$/);
  const argv = [request.round, "--build", "--review", binding.subjectSha256];
  same(execution.invocation, { executable: "node", argv: ["bench/hardening/run.mjs", ...argv], cwd: "repository-root", shell: false });
  const options = parseArgs(argv);
  same(execution.effectiveOptions, options); same(execution.settings, budgets(options.profile));
  same(resources.budget, execution.settings.resources);
  assert.ok(Array.isArray(sources.files) && sources.files.length > 0);
  const paths = new Set();
  for (const f of sources.files) { assert.ok(!paths.has(f.path)); paths.add(f.path); assert.match(f.sha256, /^[a-f0-9]{64}$/); }
  for (const path of ["Cargo.toml", "Cargo.lock", "package.json", "package-lock.json", "bench/hardening/run.mjs", "bench/hardening/verify.mjs"])
    assert.ok(paths.has(path));
  return options;
}

function sourceHash(binding, app) {
  const roots = app === "corten" ? ["bench/marketplace/corten/", "crates/", "Cargo.toml", "Cargo.lock"] : [`bench/fullstack/apps/${app}/`];
  const files = binding.sources.files.filter((f) => roots.some((p) => p.endsWith("/") ? f.path.startsWith(p) : f.path === p))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!files.some((f) => f.path.endsWith("/Dockerfile"))) throw missing("native-build-inputs-missing");
  return hash(JSON.stringify(files.map((f) => [f.path, f.sha256])));
}

export async function inspectSaved(binding, folder) {
  const result = { status: "blocked", attemptComplete: false, cleanupComplete: false, resources: "blocked",
    outcomes: selectedApps("hardening").map((app) => ({ app, outcome: "not-run" })), blockers: [] };
  const block = (code) => { if (!result.blockers.includes(code)) result.blockers.push(code); };
  let fs, phase = "binding", failed = false;
  try {
    const options = bindingOptions(binding); phase = "tree"; fs = saved(folder);
    phase = "summary";
    const summary = fs.read("summary.json");
    same(summary.schema, "native-hardening-run/v1"); same(summary.registryDigest, registryDigest);
    same(summary.commit, binding.request.commit); same(summary.options, options); same(summary.budget, binding.execution.settings);
    // Old, otherwise consistent captures are incomplete proof, not a current run.
    if (summary.semanticReceiptsVersion !== 2 || summary.lifecycleVersion !== 4
      || summary.nativeControlsVersion !== 1 || summary.deploymentQualificationVersion !== 1) {
      block("hardening-current-semantic-lifecycle-receipts-required"); return result;
    }
    const expected = matrix();
    same(summary.cells.map(({ key, app, source, mode, phase }) => ({ key, app, source, mode, phase })),
      expected.map(({ key, app, source, mode, phase }) => ({ key, app, source, mode, phase })));
    assert.ok(Array.isArray(summary.failures) && Array.isArray(summary.cleanupFailures));
    for (const c of summary.cells) assert.ok(["observed", "invalid", "not-run"].includes(c.status));
    same(summary.complete, summary.cells.every((c) => c.status !== "not-run"));
    // verify() constructs filenames from process IDs. Refuse foreign IDs before
    // calling it, not after it has already followed a saved deployment path.
    for (const c of summary.cells.filter((c) => c.status === "observed")) {
      const deployment = fs.read(`${c.key}/deployment.json`);
      for (const p of deployment.processes) assert.ok(["application", "upstream", "proxy"].includes(p.role) && p.id === p.role);
    }
    phase = "native";
    const native = verify(fs.root);
    assert.ok(native && native.schema === summary.schema && typeof native.groupReady === "boolean");
    same(native.observed, summary.cells.filter((c) => c.status === "observed").length);
    same(native.notRun, summary.cells.filter((c) => c.status === "not-run").length);
    same(native.groupReady, summary.groupReady);
    result.attemptComplete = summary.complete && native.observed === expected.length;
    const proof = native.proof;
    let clean = summary.cleanupFailures.length === 0 && Number.isFinite(Date.parse(summary.finishedAt)) && proof?.cleanupComplete === true;
    let resources = native.observed === expected.length && proof?.resources === "verified" && proof?.sources === "verified";
    if (proof) {
      same(proof.schema, "native-hardening-saved-proof/v1");
      assert.ok(["verified", "blocked"].includes(proof.resources) && ["verified", "blocked"].includes(proof.sources));
      assert.equal(typeof proof.cleanupComplete, "boolean"); assert.ok(Array.isArray(proof.blockers));
      if (proof.sources === "verified") {
        const actual = new Map(proof.sourceFiles.map((f) => [f.path, f.sha256]));
        assert.equal(actual.size, proof.sourceFiles.length);
        for (const f of binding.sources.files) same(actual.get(f.path), f.sha256);
      } else block("hardening-native-build-tool-input-closure-incomplete");
      if (proof.blockers.length) block("hardening-native-saved-execution-proof-incomplete");
    } else block("hardening-native-saved-execution-proof-incomplete");
    phase = "resources";
    for (const c of summary.cells) {
      if (c.status !== "observed") { clean = false; resources = false; continue; }
      const settings = fs.read(`${c.key}/settings.json`), deployment = fs.read(`${c.key}/deployment.json`);
      same([settings.case, settings.phase, settings.nativeSource, settings.review], [c.mode, c.phase, c.source, options.review]);
      same(JSON.parse(settings.effectiveBudgets), binding.execution.settings);
      same(deployment.totalBudget, binding.execution.settings.resources);
      const roles = ["application", "upstream", ...(c.mode === "deployed-edge" ? ["proxy"] : [])].sort();
      same(deployment.processes.map((p) => p.role).sort(), roles);
      same(settings.deployment, { mode: c.mode, countAllProcesses: true,
        processes: deployment.processes.map(({ containerId, ...p }) => p) });
      assert.equal(new Set(deployment.processes.map((p) => p.containerId)).size, roles.length);
      same(Object.keys(deployment.network.Containers).sort(), deployment.processes.map((p) => p.containerId).sort());
      for (const p of deployment.processes) {
        assert.ok(Number.isSafeInteger(p.count) && p.count > 0); assert.match(p.containerId, /^[a-f0-9]{64}$/);
        const before = fs.read(`${c.key}/${p.id}-before.json`), life = fs.read(`${c.key}/${p.id}-lifecycle.json`);
        same(before.info.Id, p.containerId); same(before.info, life.before);
        same(before.top.trimEnd().split("\n").length - 1, p.count);
        const limit = summary.budget.resources[p.role === "application" ? c.mode === "direct" ? "applicationDirect" : "applicationEdge" : p.role];
        const actual = before.info.HostConfig;
        same([actual.NanoCpus, actual.Memory, actual.MemorySwap], [limit.cpu * 1e9, limit.memory, limit.memory]);
        same({ ...life.after.HostConfig, OomKillDisable: life.after.HostConfig.OomKillDisable ?? false },
          { ...actual, OomKillDisable: actual.OomKillDisable ?? false });
        if (p.role === "application") {
          const labels = before.info.Config.Labels;
          same(labels["run.corten.marketplace.commit"], binding.request.commit);
          same(labels["run.corten.marketplace.dirty"], "false");
          same(labels["run.corten.hardening.source"], sourceHash(binding, c.app));
        } else {
          same(before.info.Image, summary.tools[p.role === "upstream" ? "node" : "edge"].Id);
        }
      }
      const cleanup = fs.read(`${c.key}/cleanup.json`);
      assert.equal(typeof cleanup.complete, "boolean");
      if (!cleanup.complete || cleanup.containers.length || cleanup.volumes.length || cleanup.commandClients !== 0 || cleanup.failures.length) clean = false;
    }
    for (const name of ["node", "checker", "edge", "cert"]) assert.match(summary.tools?.[name]?.Id ?? "", /^sha256:[a-f0-9]{64}$/);
    result.resources = resources ? "verified" : "blocked"; result.cleanupComplete = clean;
    if (!resources) block("hardening-actual-full-process-resource-proof-incomplete");
    if (!clean) block("hardening-terminal-cleanup-proof-incomplete");
    result.outcomes = result.outcomes.map(({ app }) => {
      const cells = summary.cells.filter((c) => c.app === app);
      const failure = cells.some((c) => c.failureKind === "target-functional-failure" || c.targetOutcome?.classification === "target-capacity-failure");
      failed ||= failure;
      return { app, outcome: failure ? "failed" : cells.some((c) => c.status !== "observed") ? "not-run"
        : cells.some((c) => c.nativeAssessment?.productionQualified === false || c.edgeAssessment?.productionQualified === false) ? "unsupported" : "passed" };
    });
    if (!native.groupReady) block("hardening-native-group-not-ready");
    if (summary.failures.length) block("hardening-native-failures-retained");
    result.status = failed && result.attemptComplete && resources && clean && summary.failures.length === 0 ? "failed" : result.blockers.length ? "blocked" : "verified";
  } catch (error) {
    const absent = error?.code === "ENOENT";
    result.status = absent ? "blocked" : "invalid";
    if (!absent && phase === "resources") result.resources = "invalid";
    block(absent ? "hardening-native-proof-missing" : "hardening-evidence-contradiction");
  } finally {
    if (fs) try { fs.finish(); } catch { result.status = "invalid"; result.resources = "invalid"; result.cleanupComplete = false; block("hardening-saved-tree-changed"); }
  }
  return result;
}
