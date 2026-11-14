// Offline byte/invariant verification. This is not trusted execution admission.
import { createHash } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { win32, posix } from "node:path";
import { selectedApps, definition } from "../workloads/registry.mjs";
import { options, sourceRoots, buildOptions, documentMarkup } from "./contract.mjs";
import { snapshot, committed } from "./verify.mjs";
import { need, keys, finite, digest, span, diagnostic, closure, replayV2 } from "./replay-v2.mjs";
import { depInputs, compilerSourcePath, compilerWorkingDirectory, cargoMetadata } from "./compiler.mjs";
import { npmClosure, compilerGraph, vendorConfiguration } from "./build-replay.mjs";
import { installLayout } from "./install-layout.mjs";
import { launchOptions } from "./launch.mjs";

const apps = selectedApps("client-heavy"), hash = (b) => createHash("sha256").update(b).digest("hex");
const encode = (v) => JSON.stringify(v, null, 2) + "\n";
const inventory = (v) => need(v && same(Object.keys(v).sort(), [...apps].sort()), "incomplete-six-app-inventory");
const safe = (p) => need(typeof p === "string" && p.length > 0 && p.length <= 1024 && p.split("/").every((s) => s && s !== "." && s !== "..")
  && !/[\\:\x00-\x1f]/.test(p), "unsafe-logical-path");
const names = (v) => need(Array.isArray(v) && v.every((s) => typeof s === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s))
  && same([...new Set(v)].sort(), v), "invalid-configuration-name-union");
function toolIdentity(identity, name) {
  keys(identity, ["version", "requestedExecutable", "executablePath", "executable"], name === "browser" ? ["launch"] : []);
  if (identity.launch !== undefined) {
    keys(identity.launch, ["method", "headless", "args", "pid"]);
    need(identity.launch.method === "launchServer" && identity.launch.headless === launchOptions.headless && same(identity.launch.args, launchOptions.args)
      && Number.isSafeInteger(identity.launch.pid) && identity.launch.pid > 0, "invalid-browser-launch-observation");
  }
  need([identity.version, identity.requestedExecutable, identity.executablePath].every((s) => typeof s === "string" && s.length > 0), "invalid-tool-identity");
  const ref = identity.executable;
  keys(ref, ["bytes", "sha256", "blob"]);
  need(digest(ref.sha256) && ref.blob === `evidence/blobs/${ref.sha256}` && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0
    && ref.bytes <= (name === "browser" ? 512 : 128) * 1024 ** 2, "invalid-blob-reference");
}
export const artifactProfile = Object.freeze({ versionedVendorPaths: true, blobTotalBytes: 1024 ** 3,
  oversized: Object.freeze({ fileBytes: 512 * 1024 ** 2, accepts: (path, bytes, files) => {
    const raw = files.get("evidence/browser.json");
    if (!raw) return false;
    const identity = JSON.parse(raw.toString()); toolIdentity(identity, "browser");
    return path === identity.executable.blob && bytes === identity.executable.bytes;
  } }),
  limits: Object.freeze({ files: 80000, depth: 32, fileBytes: 128 * 1024 ** 2, totalBytes: 2 * 1024 ** 3 }),
  directory: (p) => p === "evidence" || p.startsWith("evidence/") || p === "native" || apps.some((app) => p === `native/${app}`) });

export async function validateV2(request) {
  const report = { schema: "client-heavy-saved-verification/v2", group: "client-heavy", round: request.round, commit: request.commit,
    status: "invalid", valid: false, diagnosticsPassed: false, intrinsic: { valid: false, complete: false, passed: false, cleanupPassed: false },
    authentication: "external-required", ready: false, readyForLoad: false, rankingEligible: false, isolation: "unknown",
    selectedApps: [...apps], errors: [], blockers: [], cells: {}, files: [], subjectSha256: null, sources: null };
  const check = async (at, fn) => {
    try { return await fn(); }
    catch (error) { report.errors.push({ at, reason: /^[a-z][a-z0-9-]+$/.test(error.message ?? "") || error.message?.startsWith("client contract:")
      ? error.message : "missing-unreadable-or-malformed-evidence" }); return undefined; }
  };
  const block = (reason) => report.blockers.push(reason);
  const files = await check("artifacts", () => snapshot(request.folder, artifactProfile));
  if (!files) return report;
  report.files = [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) }));
  const json = (path) => { need(files.has(path), "missing-required-file"); return JSON.parse(files.get(path).toString()); };
  const blob = (ref, fileBytes = 128 * 1024 ** 2) => {
    keys(ref, ["bytes", "sha256", "blob"]);
    need(digest(ref.sha256) && ref.blob === `evidence/blobs/${ref.sha256}` && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 && ref.bytes <= fileBytes,
      "invalid-blob-reference");
    const bytes = files.get(ref.blob);
    need(bytes && bytes.length === ref.bytes && hash(bytes) === ref.sha256, "missing-or-mismatched-blob"); return bytes;
  };
  const entries = (values) => {
    need(Array.isArray(values), "missing-input-inventory"); const result = new Map(), seen = new Set();
    for (const entry of values) {
      keys(entry, ["path", "bytes", "sha256", "blob"]); safe(entry.path);
      need(!seen.has(entry.path.toLowerCase()), "duplicate-input-path"); seen.add(entry.path.toLowerCase());
      const { path, ...ref } = entry; blob(ref); result.set(path, ref);
    }
    return result;
  };
  const subject = await check("review-subject.json", () => {
    const { subjectSha256, ...value } = json("review-subject.json");
    keys(value, ["schema", "group", "round", "commit", "files"]);
    need(value.schema === "client-heavy-review-subject/v1" && value.group === "client-heavy" && value.round === request.round
      && value.commit === request.commit && subjectSha256 === hash(encode(value)), "wrong-review-subject");
    need(same(value.files, report.files.filter((f) => f.path !== "review-subject.json")), "subject-ledger-differs-from-bytes");
    report.subjectSha256 = subjectSha256; return value;
  });
  const output = await check("result.json", () => {
    const o = json("result.json");
    keys(o, ["schema", "group", "round", "effectiveWorkload", "settings", "timeoutMs", "provenance", "selectedApps", "definition",
      "builds", "cells", "passed", "readyForLoad", "collection", "terminal", "cleanupFailures"], ["failure"]);
    need(o.schema === "client-heavy-native/v2" && o.group === "client-heavy" && o.round === request.round
      && o.provenance.commit === request.commit, "wrong-run-identity");
    need(same(o.selectedApps, apps) && same(o.definition, definition("client-heavy")), "incomplete-or-changed-registry-inventory");
    inventory(o.cells); inventory(o.builds);
    need(typeof o.passed === "boolean" && o.readyForLoad === false, "invalid-summary-readiness");
    keys(o.collection, ["accounting", "proof", "blockers", "isolation", "rankingEligible", "reviewSubject"]);
    need(o.collection.accounting === "complete" && o.collection.proof === "blocked" && o.collection.isolation === "unknown"
      && o.collection.rankingEligible === false && o.collection.reviewSubject === "review-subject.json"
      && Array.isArray(o.collection.blockers) && o.collection.blockers.every((b) => typeof b === "string"), "invalid-collection-claims");
    need(same(json("native/build.json"), o.builds) && same(json("native/workload.json"), o.effectiveWorkload), "raw-manifest-differs-from-summary");
    if (o.failure !== undefined) { keys(o.failure, ["reason", "name", "diagnosticSha256"]); diagnostic({ name: o.failure.name, diagnosticSha256: o.failure.diagnosticSha256 });
      need(["runner-failed", "native-runner-interrupted"].includes(o.failure.reason), "invalid-runner-failure"); }
    return o;
  });
  if (!output) return report;
  const plan = await check("plan.json", () => {
    const p = json("plan.json");
    keys(p, ["schema", "round", "commit", "invocation", "workload", "settings", "timeoutMs", "selectedApps", "definition", "sourceBefore",
      "root", "platform", "nodeClock", "inheritedConfigurationNames"]);
    need(p.schema === "client-heavy-plan/v1" && p.round === request.round && p.commit === request.commit && typeof p.root === "string"
      && ["win32", "linux", "darwin"].includes(p.platform), "invalid-plan-identity");
    const parsed = options(p.invocation.argv, p.root, p.platform);
    need(same(p.invocation, parsed.invocation) && same(p.workload, parsed.workload) && same(p.settings, parsed.settings)
      && p.timeoutMs === parsed.timeoutMs && parsed.round === request.round, "plan-differs-from-fixed-invocation");
    need(same(p.workload, output.effectiveWorkload) && same(p.settings, output.settings) && p.timeoutMs === output.timeoutMs
      && same(p.selectedApps, apps) && same(p.definition, definition("client-heavy")) && p.sourceBefore === "evidence/source-before.json", "summary-differs-from-plan");
    keys(p.nodeClock, ["clock", "timeOrigin"]); need(p.nodeClock.clock === "node-performance" && finite(p.nodeClock.timeOrigin), "invalid-node-clock");
    names(p.inheritedConfigurationNames);
    Object.assign(report, { effectiveWorkload: p.workload, settings: p.settings, timeoutMs: p.timeoutMs, invocation: p.invocation });
    return p;
  });
  if (!plan) return report;
  const origins = plan.nodeClock.timeOrigin;
  let lastContextEnd = 0, lastBuildEnd = 0;
  const pathApi = plan.platform === "win32" ? win32 : posix;
  const relativeOutput = pathApi.relative(plan.root, plan.invocation.effective.out).replaceAll("\\", "/");
  await check("provenance", () => {
    const p = output.provenance;
    keys(p, ["commit", "sourceBefore", "sourceAfter", "node", "platform", "release", "cpu", "logicalCpus", "browser",
      "browserInstances", "rendererProcessLimit", "concurrentPages", "passes", "note"]);
    need(p.commit === request.commit && p.sourceBefore === "evidence/source-before.json" && p.sourceAfter === "evidence/source-after.json"
      && p.platform === plan.platform && [p.node, p.platform, p.release, p.cpu, p.note].every((s) => typeof s === "string" && s.length > 0)
      && Number.isSafeInteger(p.logicalCpus) && p.logicalCpus > 0 && (p.browser === null || typeof p.browser === "string")
      && p.browserInstances === 1 && p.rendererProcessLimit === 1 && p.concurrentPages === 1 && p.passes === 2, "invalid-provenance-topology");
  });
  const toolReceipts = new Map(), configuration = new Set(plan.inheritedConfigurationNames);
  const tool = async (label, required = false) => {
    const path = `evidence/${label}.json`;
    if (!files.has(path)) { if (required) block(`missing-${label}`); return null; }
    return check(path, () => {
      const t = json(path); keys(t, ["command", "args", "configurationNames", "startedAt", "endedAt", "status", "signal", "failure", "stdout", "stderr"]); span(t);
      need(t.command === plan.invocation.effective.cargo && Array.isArray(t.args) && t.args.every((a) => typeof a === "string")
        && (t.status === null || Number.isSafeInteger(t.status)) && (t.signal === null || typeof t.signal === "string"), "invalid-tool-receipt");
      const config = `${relativeOutput}/evidence/cargo-vendor.toml`, manifest = "bench/browser/gen/Cargo.toml";
      const expected = {
        "cargo-version": ["--version", "--verbose"],
        "cargo-vendor": ["vendor", "--versioned-dirs", "--manifest-path", manifest, `${relativeOutput}/evidence/cargo-vendor`],
        "cargo-metadata": ["metadata", "--locked", "--offline", "--format-version", "1", "--config", config, "--manifest-path", manifest],
        "cargo-run": ["run", "--locked", "--offline", "--release", "--verbose", "--message-format=json", "--target-dir", `${relativeOutput}.compiler`,
          "--config", config, "--manifest-path", manifest, "--bin", "client", "--", `${relativeOutput}/native/workload.json`, `${relativeOutput}/native/corten`],
      }[label];
      need(same(t.args, expected), "tool-invocation-differs-from-fixed-plan");
      names(t.configurationNames); t.configurationNames.forEach((n) => configuration.add(n));
      if (t.failure !== null) diagnostic(t.failure);
      blob(t.stdout); blob(t.stderr); toolReceipts.set(label, t); return t;
    });
  };
  for (const label of ["cargo-version", "cargo-vendor", "cargo-metadata", "cargo-run"]) await tool(label, label === "cargo-version");
  await check("cargo-identity", () => {
    const version = toolReceipts.get("cargo-version");
    if (!version || version.status !== 0 || version.failure !== null || version.signal !== null) { block("cargo-version-unavailable"); return; }
    need(/^cargo \d+\.\d+\.\d+/m.test(blob(version.stdout).toString()), "invalid-cargo-version-output");
  });
  await check("evidence/configuration-after.json", () => {
    const after = json("evidence/configuration-after.json"); keys(after, ["names"]); names(after.names); after.names.forEach((n) => configuration.add(n));
  });
  report.configurationNames = [...configuration].sort();
  let sourceMap = new Map(), nodeDependencies = new Map(), browserDependencies = new Map(), cargoDependencies = new Map();
  const snapshotTimes = new Map(), dependencyComplete = new Map();
  const pair = async (label, source = false) => {
    const snapshots = [];
    for (const stage of ["before", "after"]) {
      const path = `evidence/${label}-${stage}.json`;
      if (!files.has(path)) { block(`missing-${label}-${stage}`); continue; }
      const s = await check(path, () => {
        const v = json(path); span(v);
        keys(v, source ? ["schema", "stage", "startedAt", "endedAt", "commit", "status", "diff", "entries", "unavailable"]
          : ["schema", "label", "stage", "entries", "unavailable", "startedAt", "endedAt"], source ? [] : ["layout"]);
        need(v.schema === (source ? "client-heavy-source/v1" : "client-heavy-dependency-bytes/v1") && v.stage === stage
          && (source ? v.commit === request.commit : v.label === label) && Array.isArray(v.unavailable), "invalid-source-or-dependency-snapshot");
        if (v.unavailable.length) block(`${label}-${stage}-incomplete`);
        const map = entries(v.entries);
        if (v.layout !== undefined) {
          need(["node-dependencies", "browser-dependencies"].includes(label), "unexpected-install-layout");
          if (!v.unavailable.length) installLayout(v.layout, map, blob);
        }
        snapshotTimes.set(`${label}-${stage}`, v);
        if (source) {
          if (blob(v.status).length || blob(v.diff).length) block(`dirty-source-${stage}`);
        }
        return { value: v, map };
      });
      if (s) snapshots.push(s);
    }
    if (snapshots.length === 2) {
      need(same(snapshots[0].value.entries, snapshots[1].value.entries), "input-bytes-changed-during-run");
      need(same(snapshots[0].value.layout, snapshots[1].value.layout), "install-layout-changed-during-run");
    }
    dependencyComplete.set(label, snapshots.length === 2 && snapshots.every((s) => s.value.unavailable.length === 0));
    return snapshots[0]?.map ?? new Map();
  };
  sourceMap = await check("source-closure", () => pair("source", true)) ?? sourceMap;
  nodeDependencies = await check("node-dependencies", () => pair("node-dependencies")) ?? nodeDependencies;
  browserDependencies = await check("browser-dependencies", () => pair("browser-dependencies")) ?? browserDependencies;
  if (output.builds.corten.outcome === "built" || files.has("evidence/cargo-dependencies-before.json")) cargoDependencies = await check("cargo-dependencies", () => pair("cargo-dependencies")) ?? cargoDependencies;
  await check("commit-source-inventory", () => {
    const sources = committed(request.commit, sourceRoots);
    for (const [path, bytes] of sources) {
      const ref = sourceMap.get(path);
      if (!ref) { block(`missing-source:${path}`); continue; }
      const saved = blob(ref), text = bytes.toString();
      need(saved.equals(bytes) || (!text.includes("\r") && Buffer.from(text).equals(bytes) && saved.equals(Buffer.from(text.replaceAll("\n", "\r\n")))), "source-bytes-differ-from-exact-commit");
    }
    for (const path of sourceMap.keys()) if (!sources.has(path)) block(`uncommitted-source:${path}`);
    report.sources = { files: [...sourceMap].map(([path, ref]) => ({ path, bytes: ref.bytes, sha256: ref.sha256 })) };
  });
  const sourceRef = (path) => sourceMap.get(path) ?? (path.startsWith("node_modules/") ? nodeDependencies.get(path.slice(13))
    : path.startsWith("bench/browser/node_modules/") ? browserDependencies.get(path.slice(27)) : null);
  for (const [label, deps, path] of [["node", nodeDependencies, "package-lock.json"], ["browser", browserDependencies, "bench/browser/package-lock.json"]])
    if (apps.some((a) => output.builds[a].outcome === "built")) await check(`${label}:locked-dependencies`, () => npmClosure(deps, JSON.parse(blob(sourceMap.get(path))), blob, dependencyComplete.get(`${label}-dependencies`) === true));
  const allBuildEnd = await check("build-clock-inventory", () => Math.max(0, ...apps.map((app) => output.builds[app].outcome === "built" ? json(`native/${app}/build-receipt.json`).endedAt : 0))) ?? 0;
  for (const name of ["node", "browser"]) await check(`evidence/${name}.json`, () => {
    if (!files.has(`evidence/${name}.json`)) { if (name !== "browser" || output.provenance.browser !== null) block(`missing-${name}-identity`); return; }
    const identity = json(`evidence/${name}.json`);
    toolIdentity(identity, name);
    blob(identity.executable, name === "browser" ? 512 * 1024 ** 2 : 128 * 1024 ** 2);
    report.toolIdentities ??= {}; report.toolIdentities[name] = identity.executable.sha256;
    need(identity.version === output.provenance[name === "node" ? "node" : "browser"], "tool-version-differs-from-provenance");
  });
  for (const app of apps) {
    report.cells[app] = { outcome: output.cells[app]?.outcome ?? null, reason: output.cells[app]?.reason ?? null,
      replayPassed: false, qualification: null, measurement: null, build: null };
    await check(`${app}:build`, () => {
      const b = output.builds[app], cell = report.cells[app];
      if (b.outcome === "not-run") { keys(b, ["outcome", "reason"]); need(b.reason === "runner-failed-before-build", "invalid-unrun-build"); cell.build = { outcome: b.outcome, bytes: null }; return; }
      if (b.outcome === "failed") {
        keys(b, ["outcome", "reason", "diagnosticSha256"]);
        need(b.reason === "native-build-failed" && digest(b.diagnosticSha256) && files.has(`native/${app}/failure.log`)
          && hash(files.get(`native/${app}/failure.log`)) === b.diagnosticSha256, "wrong-build-failure-receipt");
        cell.build = { outcome: b.outcome, bytes: null }; return;
      }
      keys(b, ["outcome", "inputs", "bundleSha256", "bytes", "artifacts"]); need(b.outcome === "built", "invalid-build-outcome");
      const receipt = json(`native/${app}/build-receipt.json`), opts = json(`native/${app}/build-options.json`), meta = json(`native/${app}/metafile.json`);
      keys(receipt, ["schema", "app", "startedAt", "endedAt", "esbuild", "optionsSha256", "metafileSha256", "rawBundle", "footer", "inputs", "artifacts"]); span(receipt);
      need(receipt.startedAt >= lastBuildEnd, "overlapping-native-builds"); lastBuildEnd = receipt.endedAt;
      need(receipt.schema === "client-heavy-build-receipt/v1" && receipt.app === app && receipt.optionsSha256 === hash(files.get(`native/${app}/build-options.json`))
        && receipt.metafileSha256 === hash(files.get(`native/${app}/metafile.json`)) && same(receipt.artifacts, b.artifacts), "build-receipt-differs-from-raw");
      keys(receipt.esbuild, ["version", "entry"]); need(typeof receipt.esbuild.version === "string"
        && receipt.esbuild.entry.sha256 === browserDependencies.get("esbuild/lib/main.js")?.sha256
        && JSON.parse(blob(browserDependencies.get("esbuild/package.json"))).version === receipt.esbuild.version, "invalid-esbuild-identity"); blob(receipt.esbuild.entry);
      const inputs = entries(receipt.inputs);
      need(same(b.inputs, [...inputs].map(([path, ref]) => ({ path, sha256: ref.sha256 }))) && same([...inputs.keys()].sort(), Object.keys(meta.inputs).sort()), "metafile-input-inventory-differs");
      for (const [path, ref] of inputs) need(sourceRef(path)?.sha256 === ref.sha256, "build-input-not-bound-to-source-closure");
      if (["vue", "svelte"].includes(app)) need(inputs.has(`bench/client-heavy/apps/${app}.${app === "vue" ? "vue" : "svelte"}`), "missing-native-component-input");
      if (app !== "corten") need([...inputs.keys()].some((p) => p.startsWith("bench/browser/node_modules/")), "missing-native-framework-input");
      const entry = app === "corten" ? "bench/browser/gen/src/bin/client.js" : `bench/client-heavy/apps/${app}.${["react", "solid"].includes(app) ? "jsx" : app === "remix" ? "tsx" : "js"}`;
      need(inputs.has(entry) && inputs.has("bench/client-heavy/apps/input.js") && same(opts, buildOptions(app, plan.root, plan.platform)), "build-options-differ-from-native-contract");
      const bundle = app === "corten" ? "client.js" : "app.js", code = files.get(`native/${app}/${bundle}`);
      const outputs = Object.values(meta.outputs);
      need(outputs.length === 1 && outputs[0].bytes === receipt.rawBundle.bytes && outputs[0].entryPoint === entry
        && Object.hasOwn(outputs[0].inputs, entry) && Object.entries(outputs[0].inputs).every(([p, v]) => Object.hasOwn(meta.inputs, p)
          && Number.isSafeInteger(v.bytesInOutput) && v.bytesInOutput >= 0)
        && Array.isArray(outputs[0].imports) && outputs[0].imports.every((i) => i.external === true && opts.external.includes(i.path)), "metafile-output-differs-from-build");
      need(code && code.equals(Buffer.concat([blob(receipt.rawBundle), Buffer.from("\n"), blob(receipt.footer)]))
        && code.length === b.bytes && hash(code) === b.bundleSha256, "bundle-differs-from-build-bytes");
      need(same(Object.keys(b.artifacts).sort(), ["index.html", bundle, ...(app === "corten" ? ["runtime.js", "views.js"] : [])].sort()), "incomplete-build-artifacts");
      for (const [name, sha] of Object.entries(b.artifacts)) { safe(name); need(files.has(`native/${app}/${name}`) && hash(files.get(`native/${app}/${name}`)) === sha, "artifact-hash-mismatch"); }
      if (app === "corten") {
        for (const name of ["screen.html", "client.footer.js", "views.d.ts", "build.log"]) need(files.has(`native/corten/${name}`), "missing-generator-output");
        need(hash(files.get("native/corten/runtime.js")) === sourceMap.get("crates/corten/js/dist/corten.js")?.sha256, "wrong-corten-runtime");
        need(blob(receipt.footer).equals(files.get("native/corten/client.footer.js")), "footer-differs-from-generator-output");
      } else need(blob(receipt.footer).length === 0, "unexpected-app-footer");
      need(files.get(`native/${app}/index.html`).equals(Buffer.from(documentMarkup(app, plan.workload, files.get("native/corten/screen.html")?.toString() ?? ""))), "document-differs-from-generated-fixture");
      cell.build = { outcome: "built", bytes: code.length, sha256: hash(code), integrity: "matched-not-authenticated" };
    });
    await check(`${app}:cell`, async () => {
      const c = output.cells[app]; keys(c, ["outcome", "qualification", "measurement", "readyForMeasurement"], ["reason"]);
      need(["passed", "failed", "unsupported", "not-run"].includes(c.outcome) && (c.reason === undefined || typeof c.reason === "string" && c.reason.trim()), "invalid-cell-outcome");
      need(same(json(`${app}.json`), c), "raw-app-differs-from-summary");
      for (const phase of ["qualification", "measurement"]) if (c[phase] !== null) report.cells[app][phase] = await check(`${app}:${phase}`, () =>
        replayV2(c[phase], app, phase, plan.workload, plan.settings, plan.timeoutMs, origins)) ?? null;
      for (const phase of ["qualification", "measurement"]) if (c[phase]?.lifecycle.contextCreatedAt !== null && c[phase] !== null) {
        const life = c[phase].lifecycle;
        need(life.contextCreatedAt >= Math.max(lastContextEnd, allBuildEnd), "context-before-build-or-previous-close");
        lastContextEnd = life.close.endedAt;
      }
      for (const phase of ["qualification", "measurement"]) if (c[phase] !== null) await check(`${app}:${phase}:requests`, () => {
        const pass = c[phase], replayed = report.cells[app][phase];
        need(Array.isArray(pass.requests), "missing-http-request-ledger");
        const paths = new Set(); let started = -1, bytes = 0;
        for (const [i, r] of pass.requests.entries()) {
          keys(r, ["id", "path", "method", "resourceType", "startedAt", "endedAt", "status", "body", "failure"]); span(r);
          need(r.id === i && typeof r.path === "string" && typeof r.method === "string" && typeof r.resourceType === "string"
            && r.startedAt >= started && (r.status === null || Number.isSafeInteger(r.status) && r.status >= 100 && r.status <= 599), "invalid-http-request"); started = r.startedAt;
          need(pass.lifecycle.contextCreatedAt !== null && r.startedAt >= pass.lifecycle.contextCreatedAt
            && r.endedAt <= pass.lifecycle.close.endedAt + 1, "http-clock-outside-context");
          if (r.failure !== null) diagnostic(r.failure);
          if (r.body !== null) { keys(r.body, ["bytes", "sha256"]); need(Number.isSafeInteger(r.body.bytes) && r.body.bytes >= 0 && digest(r.body.sha256), "invalid-http-body"); bytes += r.body.bytes; }
          if (replayed?.passed) {
            const records = pass.capture.records;
            need(origins + r.startedAt <= pass.timing.timeOrigin + records[0].at + 1, "unexpected-native-journey-http");
            const path = r.path.endsWith("/") ? `${r.path}index.html` : r.path;
            need(path.startsWith(`/${app}/`) && !path.includes("..") && r.method === "GET" && r.status === 200 && r.failure === null
              && r.body !== null && files.has(`native${path}`) && hash(files.get(`native${path}`)) === r.body.sha256
              && files.get(`native${path}`).length === r.body.bytes, "request-body-differs-from-native-artifact"); paths.add(path);
          }
        }
        if (replayed?.passed) {
          for (const name of Object.keys(output.builds[app].artifacts)) need(paths.has(`/${app}/${name}`), "missing-native-artifact-request");
          replayed.requests = { count: pass.requests.length, bytes, paths: [...paths].sort() };
        } else if (replayed) replayed.requests = null;
      });
      const q = report.cells[app].qualification, m = report.cells[app].measurement;
      need(q?.passed === true || c.measurement === null, "measurement-before-qualification");
      need(q?.passed !== true || c.measurement !== null || (output.failure && typeof c.reason === "string"), "missing-measurement-attempt-receipt");
      const passed = q?.passed === true && m?.passed === true;
      need(c.readyForMeasurement === passed && (c.outcome === "passed") === passed, "cell-flags-differ-from-raw-replay");
      if (q?.oracle.functionalPassed || m?.oracle.functionalPassed) need(output.builds[app].outcome === "built", "passing-capture-without-build");
      if (c.qualification === null) need(c.measurement === null && !!c.reason && c.outcome !== "passed", "unavailable-cell-needs-reason");
      else need(c.outcome === (passed ? "passed" : (q?.passed ? m?.oracle.outcome : q?.oracle.outcome) === "unsupported" ? "unsupported" : "failed"), "cell-outcome-differs-from-replay");
      report.cells[app].replayPassed = passed;
    });
  }
  if (output.builds.corten.outcome === "built") await check("compiler-input-closure", () => {
    const c = json("evidence/compiler-inputs.json");
    keys(c, ["schema", "metadata", "toolchain", "artifacts", "depfiles", "inputs", "unavailable"], ["compilerRoot"]);
    need(c.schema === "client-heavy-compiler-inputs/v1" && c.metadata === "evidence/cargo-metadata.json" && Array.isArray(c.unavailable), "invalid-compiler-inputs");
    if (c.unavailable.length) { block("compiler-input-closure-incomplete"); return; }
    need(blob(c.toolchain).length > 0, "missing-rust-toolchain-identity");
    const run = toolReceipts.get("cargo-run"), metadata = toolReceipts.get("cargo-metadata"), vendor = toolReceipts.get("cargo-vendor");
    need(run?.status === 0 && metadata?.status === 0 && vendor?.status === 0, "missing-successful-compiler-tools");
    const messages = blob(run.stdout).toString().split(/\r?\n/).filter((s) => s.startsWith("{")).map((s) => JSON.parse(s));
    const observedMetadata = cargoMetadata(blob(metadata.stdout));
    need(run.failure === null && run.signal === null && metadata.failure === null && metadata.signal === null
      && vendor.failure === null && vendor.signal === null && vendor.endedAt <= metadata.startedAt && metadata.endedAt <= run.startedAt,
      "contradictory-compiler-tool-receipts");
    const build = json("native/corten/build-receipt.json");
    need(vendor.startedAt >= build.startedAt && run.endedAt <= build.endedAt, "compiler-tools-outside-native-build-interval");
    need(files.get("evidence/cargo-vendor.toml")?.toString() === vendorConfiguration, "wrong-cargo-source-replacement");
    const initial = json("evidence/cargo-lock-invocation.json"), before = blob(json("evidence/cargo-lock-before.json")), after = blob(json("evidence/cargo-lock-after.json"));
    need(before.length > 0 && before.equals(after) && ["absent", "present"].includes(initial.state)
      && (initial.state !== "present" || before.equals(blob(initial.file))), "cargo-lock-receipts-differ");
    need(files.get("native/corten/build.log")?.equals(Buffer.concat([blob(run.stdout), blob(run.stderr)])), "compiler-log-differs-from-tool-output");
    need(same(messages.filter((m) => m.reason === "compiler-artifact"), c.artifacts) && c.artifacts.length > 0
      && c.artifacts.every((m) => m.fresh === false), "compiler-artifacts-not-fresh-or-mismatched");
    need(c.depfiles.length > 0 && c.inputs.length > 0 && typeof c.compilerRoot === "string", "empty-compiler-closure");
    const union = new Set();
    for (const d of c.depfiles) {
      keys(d, ["path", "bytes", "sha256", "blob", "inputs"]); safe(d.path);
      const { path, inputs, ...ref } = d;
      need(same(depInputs(blob(ref).toString()), inputs), "dep-info-union-differs-from-bytes"); inputs.forEach((p) => union.add(p));
    }
    need(same([...union].sort(), c.inputs.map((i) => i.path).sort()) && new Set(c.inputs.map((i) => i.path)).size === c.inputs.length, "compiler-input-union-incomplete");
    for (const i of c.inputs) {
      keys(i, ["path", "sourcePath", "bytes", "sha256", "blob"]); safe(i.sourcePath);
      const { path, sourcePath, ...ref } = i; blob(ref);
      need(compilerSourcePath(c.compilerRoot, path.replaceAll("\\", "/"), compilerWorkingDirectory(observedMetadata)) === sourcePath, "compiler-input-path-differs");
      const expected = sourceRef(sourcePath) ?? (sourcePath.includes("/evidence/cargo-vendor/")
        ? cargoDependencies.get(sourcePath.split("/evidence/cargo-vendor/")[1]) : null);
      if (expected) need(expected.sha256 === ref.sha256, "compiler-input-differs-from-source");
      else need(sourcePath.startsWith(`${relativeOutput}.compiler/`), "unbound-compiler-input");
    }
    need(c.inputs.some((i) => i.sourcePath === "bench/browser/gen/src/bin/client.rs")
      && c.inputs.some((i) => i.sourcePath.startsWith("crates/corten/")), "missing-generator-or-corten-inputs");
    compilerGraph(c, observedMetadata, messages, blob, sourceRef, cargoDependencies, relativeOutput);
  });
  await check("artifact-inventory", () => {
    const allowed = new Set(["result.json", "plan.json", "review-subject.json", "native/build.json", "native/workload.json", ...apps.map((a) => `${a}.json`),
      ...["source-before", "source-after", "node-dependencies-before", "node-dependencies-after", "browser-dependencies-before", "browser-dependencies-after",
        "cargo-dependencies-before", "cargo-dependencies-after", "node", "browser", "cargo-version", "cargo-vendor", "cargo-metadata", "cargo-run", "compiler-inputs",
        "cargo-lock-invocation", "cargo-lock-before", "cargo-lock-after", "configuration-after"].map((p) => `evidence/${p}.json`), "evidence/cargo-vendor.toml"]);
    for (const app of apps) for (const name of ["index.html", "build-options.json", "metafile.json", "build-receipt.json", "failure.log",
      ...(app === "corten" ? ["client.js", "runtime.js", "views.js", "screen.html", "client.footer.js", "views.d.ts", "build.log"] : ["app.js"])]) allowed.add(`native/${app}/${name}`);
    for (const [path, bytes] of files) {
      if (path.startsWith("evidence/blobs/")) need(path === `evidence/blobs/${hash(bytes)}`, "wrong-content-addressed-blob");
      else if (path.startsWith("evidence/cargo-vendor/")) need(cargoDependencies.get(path.slice("evidence/cargo-vendor/".length))?.sha256 === hash(bytes), "vendor-file-outside-dependency-closure");
      else need(allowed.has(path), "unexpected-artifact-file");
    }
    for (const [path, ref] of cargoDependencies) need(files.has(`evidence/cargo-vendor/${path}`)
      && hash(files.get(`evidence/cargo-vendor/${path}`)) === ref.sha256, "missing-vendored-file");
  });
  await check("terminal", () => {
    const t = output.terminal; keys(t, ["clock", "timeOrigin", "signals", "resources"]);
    need(t.clock === "node-performance" && t.timeOrigin === origins && Array.isArray(t.signals) && t.resources.length === 2, "invalid-terminal-receipt");
    let at = -1;
    for (const signal of t.signals) { keys(signal, ["signal", "at", "aborted"]); need(["SIGINT", "SIGTERM"].includes(signal.signal)
      && finite(signal.at) && signal.at >= at && signal.aborted === true, "invalid-interruption-observation"); at = signal.at; }
    const failures = [];
    let closed = true;
    for (const [i, name] of ["browser", "server"].entries()) {
      const r = t.resources[i];
      if (r.state === "not-created") { keys(r, ["resource", "state"]); need(r.resource === name, "wrong-terminal-resource");
        need(output.provenance.browser === null, "launched-browser-without-terminal-resource");
        need(!apps.some((a) => output.cells[a].qualification !== null), "capture-without-terminal-resource"); }
      else { closed = closure(r, name) && closed;
        need(r.startedAt >= lastContextEnd && (i === 0 || t.resources[0].state === "not-created" || r.startedAt >= t.resources[0].endedAt), "terminal-before-context-or-browser-close");
        if (r.failure) failures.push({ resource: name, ...r.failure }); }
    }
    need(Array.isArray(output.cleanupFailures), "invalid-cleanup-failure-ledger");
    const ledger = output.cleanupFailures.filter((f) => f.resource !== "browser-interrupt");
    const seen = new Set();
    for (const f of output.cleanupFailures) { keys(f, ["resource", "name", "diagnosticSha256"]);
      need(["browser", "server", "browser-interrupt"].includes(f.resource) && !seen.has(f.resource), "invalid-cleanup-resource"); seen.add(f.resource);
      need(f.resource !== "browser-interrupt" || t.signals.length > 0, "interrupt-cleanup-without-signal");
      diagnostic({ name: f.name, diagnosticSha256: f.diagnosticSha256 }); }
    need(same(ledger, failures), "cleanup-failures-differ-from-receipts");
    if (t.signals.length) need(output.failure?.reason === "native-runner-interrupted", "signal-without-interrupted-outcome");
    if (output.failure?.reason === "native-runner-interrupted") need(t.signals.length > 0, "interrupted-outcome-without-signal");
    report.intrinsic.cleanupPassed = closed && !t.signals.length && !output.cleanupFailures.length;
  });
  await check("summary-claims", () => {
    const passed = apps.every((a) => report.cells[a].replayPassed) && report.intrinsic.cleanupPassed && !output.failure;
    need(output.passed === passed, "summary-passed-differs-from-replay"); report.intrinsic.passed = passed;
  });
  await check("source-observation-order", () => {
    const terminalEnd = Math.max(lastContextEnd, ...output.terminal.resources.filter((r) => r.state !== "not-created").map((r) => r.endedAt));
    const firstTool = Math.min(...[...toolReceipts.values()].map((r) => r.startedAt));
    for (const label of ["source", "node-dependencies", "browser-dependencies"]) {
      const before = snapshotTimes.get(`${label}-before`), after = snapshotTimes.get(`${label}-after`);
      const firstUse = label === "source" ? firstTool : toolReceipts.get("cargo-vendor")?.startedAt
        ?? Math.min(...apps.filter((a) => output.builds[a].outcome === "built").map((a) => json(`native/${a}/build-receipt.json`).startedAt));
      if (before && after) need(before.endedAt <= firstUse && before.endedAt <= after.startedAt
        && after.startedAt >= terminalEnd, "source-snapshot-outside-attempt-boundary");
    }
    const run = toolReceipts.get("cargo-run"), before = snapshotTimes.get("cargo-dependencies-before"), after = snapshotTimes.get("cargo-dependencies-after");
    if (run && before && after) need(before.endedAt <= run.startedAt && after.startedAt >= run.endedAt, "cargo-snapshot-outside-build-boundary");
    report.executionWindow = { clock: "unix-ms", startedAt: origins + (snapshotTimes.get("source-before")?.startedAt ?? 0),
      endedAt: origins + Math.max(terminalEnd, ...[...snapshotTimes.values()].map((s) => s.endedAt)) };
    report.processWindows = [...(run ? [{ kind: "compiler", startedAt: origins + run.startedAt, endedAt: origins + run.endedAt }] : []),
      ...apps.flatMap((app) => ["qualification", "measurement"].flatMap((phase) => {
        const life = output.cells[app][phase]?.lifecycle;
        return life?.contextCreatedAt !== null && life?.close ? [{ kind: "browser", app, phase,
          startedAt: origins + life.contextCreatedAt, endedAt: origins + life.close.startedAt }] : [];
      }))];
  });
  report.diagnosticsPassed = report.errors.length === 0;
  report.valid = report.diagnosticsPassed;
  report.intrinsic.valid = report.valid;
  report.intrinsic.complete = report.valid && subject !== undefined && report.blockers.length === 0;
  report.status = !report.valid ? "invalid" : !report.intrinsic.complete ? "blocked" : report.intrinsic.passed ? "verified" : "failed";
  return report;
}
