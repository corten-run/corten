// Read-only v1 diagnostics. Saved JavaScript, commands and build receipts are never executed.
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, readFile } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual as same } from "node:util";
import { definition, selectedApps } from "../workloads/registry.mjs";
import { createClientWorkload, validateClientCapture } from "../workloads/client.mjs";

export const schema = "client-heavy-saved-verification/v1";
const root = fileURLToPath(new URL("../../", import.meta.url));
const apps = selectedApps("client-heavy");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const need = (ok, reason) => { if (!ok) throw new Error(reason); };
const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const bounded = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const keys = (v, required, optional = []) => need(object(v) && required.every((k) => Object.hasOwn(v, k))
  && Object.keys(v).every((k) => [...required, ...optional].includes(k)), "missing-or-unexpected-fields");
const pins = {
  "bench/client-heavy/run.mjs": "71fc21c81f109b4ae43eb6585c675fe3e9eb49fa526de57ab20e8d4f48edbb8e",
  "bench/client-heavy/build.mjs": "0e7393d86a534b3085d3b62fc9bff60ce47cfcae0bee1c724345dd2f913a342b",
};
const sourcePaths = ["bench/client-heavy/run.mjs", "bench/client-heavy/build.mjs", "bench/client-heavy/observer.mjs",
  "bench/workloads/client.mjs", "bench/workloads/registry.mjs", "bench/browser/package-lock.json", "package-lock.json",
  "bench/browser/gen/Cargo.toml", "bench/browser/gen/src/bin/client.rs"];
const limits = { files: 4096, fileBytes: 64 * 1024 ** 2, totalBytes: 512 * 1024 ** 2, depth: 20 };
const blockersV1 = [
  "v1-no-saved-source-bound-invocation-plan-or-cargo-tool-identity",
  "v1-no-complete-saved-source-dependency-and-generator-byte-snapshot",
  "v1-no-independent-fresh-build-source-to-bundle-proof",
  "v1-no-raw-mount-or-operation-start-clocks-for-timing-recomputation",
  "v1-no-positive-terminal-browser-server-close-and-interruption-receipt",
  "v1-no-native-capture-authentication-or-qualified-isolation-evidence",
];
// Git objects are immutable. Keep only one bounded object set, never a saved or
// caller-supplied oracle. Current local runner/oracle bytes are still checked.
let cachedCommit, cachedSources;

function safePath(path) {
  need(typeof path === "string" && path.length > 0 && path.length <= 512, "unsafe-path");
  for (const part of path.split("/")) need(/^[A-Za-z0-9_@.-]+$/.test(part) && part !== "." && part !== ".." && !part.endsWith(".")
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part), "unsafe-path");
  return path;
}
// A tracked CSS security fixture contains '%'. These names are only looked up
// in the committed object map, never decoded or used to read host paths.
const safeSourcePath = (path) => { need(typeof path === "string", "unsafe-path"); safePath(path.replaceAll("%", "_")); };

async function ancestors(folder) {
  need(typeof folder === "string" && folder.length > 0 && !/[\x00-\x1f]/.test(folder)
    && !/^(?:[\\/]{2}|[A-Za-z]:[^\\/])/.test(folder), "unsafe-folder");
  need(!folder.replace(/^[A-Za-z]:[\\/]/, "").includes(":"), "unsafe-folder");
  const parts = folder.replaceAll("\\", "/").split("/").filter(Boolean);
  need(parts.every((p) => p !== "." && p !== ".." && !p.endsWith(".") && !p.endsWith(" ")
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)), "unsafe-folder");
  const absolute = resolve(folder), base = parse(absolute).root;
  let path = base;
  for (const part of absolute.slice(base.length).split(sep).filter(Boolean)) {
    path = join(path, part);
    const stat = await lstat(path);
    need(stat.isDirectory() && !stat.isSymbolicLink(), "linked-or-nondirectory-ancestor");
  }
  return absolute;
}

async function snapshot(folder) {
  const base = await ancestors(folder), files = new Map(), seen = new Set(), identities = new Set();
  let total = 0, entries = 0;
  const walk = async (prefix, depth) => {
    need(depth <= limits.depth, "artifact-depth-limit");
    for (const name of (await readdir(join(base, prefix))).sort()) {
      need(++entries <= limits.files, "artifact-count-limit");
      const path = safePath(prefix ? `${prefix}/${name}` : name), key = path.toLowerCase();
      need(!seen.has(key), "duplicate-or-case-colliding-file"); seen.add(key);
      const absolute = join(base, path), before = await lstat(absolute, { bigint: true });
      need(!before.isSymbolicLink(), "linked-artifact");
      need(await realpath(absolute) === absolute, "artifact-path-alias");
      if (before.isDirectory()) {
        need(path === "native" || apps.some((app) => path === `native/${app}`), "unexpected-artifact-directory");
        await walk(path, depth + 1); continue;
      }
      need(before.isFile() && before.nlink === 1n, "nonregular-or-hardlinked-artifact");
      const identity = `${before.dev}:${before.ino}`;
      need(!identities.has(identity), "duplicate-file-identity"); identities.add(identity);
      need(before.size <= BigInt(limits.fileBytes) && (total += Number(before.size)) <= limits.totalBytes, "artifact-byte-limit");
      const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat({ bigint: true });
        need(stat.isFile() && stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size
          && stat.nlink === 1n, "artifact-changed-during-read");
        const bytes = Buffer.alloc(Number(stat.size));
        let offset = 0;
        while (offset < bytes.length) {
          const chunk = await handle.read(bytes, offset, bytes.length - offset, offset);
          need(chunk.bytesRead > 0, "artifact-truncated-during-read"); offset += chunk.bytesRead;
        }
        const after = await handle.stat({ bigint: true }), pathAfter = await lstat(absolute, { bigint: true });
        need(after.size === stat.size && after.mtimeNs === stat.mtimeNs && after.ctimeNs === stat.ctimeNs
          && !pathAfter.isSymbolicLink() && pathAfter.ino === stat.ino && pathAfter.dev === stat.dev
          && await realpath(absolute) === absolute,
        "artifact-changed-during-read");
        files.set(path, bytes);
      } finally { await handle.close(); }
    }
  };
  await walk("", 0);
  return files;
}

// Fixed local Git object queries only: no network, checkout, filters, hooks or saved commands.
function committed(commit) {
  if (cachedCommit === commit) return cachedSources;
  const git = (args, input) => execFileSync("git", args, { cwd: root, input, windowsHide: true,
    maxBuffer: limits.totalBytes, stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
  need(git(["rev-parse", `${commit}^{commit}`]).toString().trim() === commit, "unknown-commit");
  const entries = git(["ls-tree", "-r", "-z", commit, "--", "crates", "bench/client-heavy", "bench/browser/gen",
    "bench/workloads/client.mjs", "bench/workloads/registry.mjs", "bench/browser/package-lock.json", "package-lock.json"])
    .toString().split("\0").filter(Boolean).map((line) => {
      const [meta, path] = line.split("\t"), [mode, type, blob] = meta.split(" ");
      safeSourcePath(path); need(["100644", "100755"].includes(mode) && type === "blob", "linked-commit-source");
      return { path, blob };
    });
  const bytes = git(["cat-file", "--batch"], entries.map((e) => `${e.blob}\n`).join("")), sources = new Map();
  let offset = 0;
  for (const entry of entries) {
    const end = bytes.indexOf(10, offset);
    need(end >= offset, "missing-git-object");
    const [blob, type, sizeText] = bytes.subarray(offset, end).toString().split(" "), size = Number(sizeText);
    need(blob === entry.blob && type === "blob" && bounded(size, 0, limits.fileBytes), "invalid-git-object");
    offset = end + 1;
    need(offset + size < bytes.length && bytes[offset + size] === 10, "truncated-git-object");
    sources.set(entry.path, bytes.subarray(offset, offset + size)); offset += size + 1;
  }
  need(offset === bytes.length, "extra-git-object-bytes");
  cachedCommit = commit; cachedSources = sources;
  return sources;
}

function matchesSource(bytes, sha) {
  if (!bytes || !digest(sha)) return false;
  if (hash(bytes) === sha) return true;
  // v1 hashes checkout bytes without recording the EOL convention. This is a
  // compatibility diagnostic, not source/build authentication or qualification.
  const text = bytes.toString("utf8");
  return !text.includes("\r") && Buffer.from(text).equals(bytes) && hash(text.replaceAll("\n", "\r\n")) === sha;
}

function replay(pass, app, phase, workload, settings, timeoutMs) {
  keys(pass, ["capture", "oracle", "readyMs", "actions", "failure"], ["resourceDetails"]);
  need(pass.capture?.app === app, "wrong-pass-app");
  const oracle = validateClientCapture(workload, pass.capture, settings);
  need(same(pass.oracle, oracle), "saved-oracle-differs-from-raw-replay");
  if (oracle.functionalPassed !== true) {
    need(pass.readyMs === null && pass.actions === null, "unavailable-pass-has-timings");
    if (pass.capture.outcome === "failed") {
      keys(pass.failure, ["phase", "diagnostic", "diagnosticSha256", "records", "errors"]);
      need(typeof pass.failure.phase === "string" && digest(pass.failure.diagnosticSha256)
        && typeof pass.failure.diagnostic === "string" && Array.isArray(pass.failure.records)
        && Array.isArray(pass.failure.errors), "invalid-failed-pass");
    } else need(pass.failure === null, "unavailable-pass-has-invented-failure");
    return { oracle, derived: null, timings: null };
  }
  need(pass.failure === null, "captured-pass-has-failure");
  need(Array.isArray(pass.resourceDetails), "missing-native-resource-details");
  for (const detail of pass.resourceDetails) {
    keys(detail, ["type", "target", "connected", "pageOwned", "property"]);
    need(typeof detail.type === "string" && typeof detail.target === "string"
      && [null, true, false].includes(detail.connected) && typeof detail.pageOwned === "boolean"
      && typeof detail.property === "boolean", "invalid-native-resource-detail");
  }
  need(Number.isFinite(pass.readyMs) && pass.readyMs >= 0 && pass.readyMs <= timeoutMs, "invalid-ready-timing");
  const records = pass.capture.records, operations = records.filter((r) => r.kind === "operation");
  need(same(records.map((r) => r.kind), ["resources", "initial", "resources", ...workload.operations.map(() => "operation"),
    "detach", "resources", "cleanup-probe", "resources", "state"]), "wrong-native-observation-sequence");
  const initial = records.findIndex((r) => r.kind === "initial"), active = records[initial + 1];
  need(active?.kind === "resources" && active.owned.subscriptions > 0, "missing-real-active-subscription");
  if (phase === "qualification") need(pass.actions === null, "qualification-has-action-timings");
  else {
    need(Array.isArray(pass.actions) && pass.actions.length === operations.length, "incomplete-measured-actions");
    for (const [i, action] of pass.actions.entries()) {
      keys(action, ["operation", "kind", "elapsedMs"]);
      need(action.operation === workload.operations[i].id && action.kind === workload.operations[i].kind
        && Number.isFinite(action.elapsedMs) && action.elapsedMs >= 0 && action.elapsedMs <= timeoutMs, "invalid-measured-action");
      need(action.elapsedMs <= operations[i].at - records[records.indexOf(operations[i]) - 1].at + 0.01,
        "action-longer-than-observation-interval");
    }
  }
  const detach = records.find((r) => r.kind === "detach"), probe = records.find((r) => r.kind === "cleanup-probe");
  const released = records.find((r) => r.kind === "resources" && r.at > detach.at && Object.values(r.owned).every((n) => n === 0));
  need(records.at(-1).at - records[0].at <= timeoutMs, "capture-exceeds-journey-bound");
  return { oracle, derived: { observedOperations: operations.length, captureDurationMs: records.at(-1).at - records[0].at,
    releaseAfterDetachMs: released.at - detach.at, postProbeObservationMs: records.at(-1).at - probe.at },
  // No timing starts were saved. Neither readyMs nor elapsedMs can be recomputed.
  timings: null };
}

/** Diagnose one saved native/v1 tree. `valid` never means a self-consistent receipt.
 * No injection hooks, native execution, builds, network, file writes or ranking promotion.
 */
export async function validateSaved(request) {
  const report = { schema, group: "client-heavy", round: null, commit: null, status: "invalid", valid: false,
    diagnosticsPassed: false, ready: false, readyForLoad: false, rankingEligible: false, isolation: "unknown",
    errors: [], blockers: [...blockersV1], cells: {}, files: [] };
  const check = async (at, fn) => {
    try { return await fn(); }
    catch (error) {
      const reason = error.message?.startsWith("client contract:") ? error.message
        : /^[a-z][a-z0-9-]+$/.test(error.message ?? "") ? error.message : "missing-unreadable-or-malformed-evidence";
      report.errors.push({ at, reason }); return undefined;
    }
  };
  const accepted = await check("request", () => {
    keys(request, ["folder", "round", "commit"]);
    need(typeof request.round === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(request.round), "unsafe-round");
    safePath(request.round);
    need(typeof request.commit === "string" && /^[a-f0-9]{40}$/.test(request.commit), "full-commit-required");
    report.round = request.round; report.commit = request.commit; return true;
  });
  if (!accepted) return report;
  const files = await check("artifacts", () => snapshot(request.folder));
  if (!files) return report;
  report.files = [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) }));
  const json = (path) => { need(files.has(path), "missing-required-file"); return JSON.parse(files.get(path).toString("utf8")); };
  const output = await check("result.json", () => {
    const value = json("result.json");
    keys(value, ["schema", "group", "round", "effectiveWorkload", "settings", "timeoutMs", "provenance", "selectedApps",
      "definition", "builds", "cells", "passed", "readyForLoad"], ["failure", "cleanupFailures"]);
    need(value.schema === "client-heavy-native/v1" && value.group === "client-heavy" && value.round === request.round, "wrong-run-identity");
    need(same(value.selectedApps, apps) && same(value.definition, definition("client-heavy")), "incomplete-or-changed-registry-inventory");
    need(object(value.cells) && same(Object.keys(value.cells).sort(), [...apps].sort()), "incomplete-cell-inventory");
    need(typeof value.passed === "boolean" && value.readyForLoad === false, "invalid-summary-readiness");
    const w = value.effectiveWorkload;
    need(object(w) && same(w, createClientWorkload({ seed: w.seed, rowCount: w.rowCount, largeRowCount: w.largeRowCount,
      appendCount: w.appendCount, dashboardCount: w.dashboardCount })), "wrong-workload-plan");
    keys(value.settings, ["maxCleanupMs", "cleanupObservationMs"]);
    need(Object.values(value.settings).every((v) => bounded(v, 1, 120000)) && bounded(value.timeoutMs, 1, 120000)
      && value.timeoutMs > value.settings.maxCleanupMs + value.settings.cleanupObservationMs, "invalid-run-options");
    if (Object.hasOwn(value, "cleanupFailures")) {
      need(Array.isArray(value.cleanupFailures), "invalid-cleanup-failures");
      const seen = new Set();
      for (const f of value.cleanupFailures) {
        keys(f, ["resource", "name", "diagnosticSha256"]);
        need(["browser-interrupt", "browser", "server"].includes(f.resource) && !seen.has(f.resource)
          && typeof f.name === "string" && digest(f.diagnosticSha256), "invalid-cleanup-failure"); seen.add(f.resource);
      }
    } else report.blockers.push("missing-cleanup-failure-ledger");
    if (value.cleanupFailures?.length) report.blockers.push("recorded-terminal-cleanup-failure");
    if (value.failure) {
      keys(value.failure, ["reason", "name", "diagnosticSha256"]);
      need(["runner-failed", "native-runner-interrupted"].includes(value.failure.reason)
        && typeof value.failure.name === "string" && digest(value.failure.diagnosticSha256), "invalid-runner-failure");
      report.blockers.push(value.failure.reason);
    }
    return value;
  });
  if (!output) return report;
  const sources = await check("commit", () => committed(request.commit));
  await check("provenance", async () => {
    const p = output.provenance;
    keys(p, ["commit", "dirty", "sources", "diffSha256", "node", "platform", "release", "cpu", "logicalCpus", "browser",
      "browserInstances", "rendererProcessLimit", "concurrentPages", "passes", "note"]);
    need(p.commit === request.commit && typeof p.dirty === "boolean" && digest(p.diffSha256), "wrong-source-provenance");
    need(object(p.sources), "missing-source-digests");
    const names = Object.keys(p.sources), expected = [...sourcePaths, ...(sources ? [...sources.keys()].filter((path) => path.startsWith("crates/")) : [])].sort();
    for (const path of names) { safeSourcePath(path); need(digest(p.sources[path]), "invalid-source-digest"); }
    need(new Set(names.map((p) => p.toLowerCase())).size === names.length, "duplicate-source-path");
    if (sources) {
      need(same([...names].sort(), expected), "incomplete-source-provenance-inventory");
      for (const path of names) if (!matchesSource(sources.get(path), p.sources[path])) {
        if (p.dirty) report.blockers.push(`dirty-source-not-bound-to-commit:${path}`);
        else need(false, "source-digest-differs-from-exact-commit");
      }
      for (const [path, pin] of Object.entries(pins)) {
        need(hash((await readFile(new URL(`../../${path}`, import.meta.url), "utf8")).replaceAll("\r\n", "\n")) === pin,
          "native-runner-snapshot-changed-requires-verifier-review");
        if (hash(sources.get(path) ?? "") !== pin) report.blockers.push(`unreviewed-native-runner-at-commit:${path}`);
      }
      for (const path of ["bench/workloads/client.mjs", "bench/workloads/registry.mjs", "bench/client-heavy/observer.mjs"]) {
        const local = await readFile(new URL(`../../${path}`, import.meta.url));
        if (!matchesSource(sources.get(path), hash(local))) report.blockers.push(`current-oracle-observer-differs-from-saved-commit:${path}`);
      }
    }
    need([p.node, p.platform, p.release, p.cpu, p.note].every((v) => typeof v === "string" && v.length > 0)
      && bounded(p.logicalCpus, 1, 65536) && (p.browser === null || typeof p.browser === "string")
      && p.browserInstances === 1 && p.rendererProcessLimit === 1 && p.concurrentPages === 1 && p.passes === 2, "invalid-native-topology");
    if (p.dirty) report.blockers.push("dirty-source-without-saved-diff-bytes");
    else need(p.diffSha256 === hash(""), "clean-source-with-nonempty-diff");
  });
  let builds;
  if (output.builds === null) report.blockers.push("native-builds-not-saved");
  else builds = await check("native/build.json", () => {
    const value = json("native/build.json");
    need(same(value, output.builds), "raw-builds-differ-from-summary");
    need(object(value) && same(Object.keys(value).sort(), [...apps].sort()), "incomplete-build-inventory");
    need(same(json("native/workload.json"), output.effectiveWorkload), "native-workload-differs-from-plan");
    return value;
  });
  const allowed = new Set(["result.json", "native/build.json", "native/workload.json", ...apps.map((app) => `${app}.json`)]);
  for (const app of apps) {
    const names = app === "corten" ? ["index.html", "client.js", "runtime.js", "views.js", "screen.html", "client.footer.js", "views.d.ts", "build.log", "failure.log"]
      : ["index.html", "app.js", "failure.log"];
    names.forEach((name) => allowed.add(`native/${app}/${name}`));
    const cell = output.cells[app];
    report.cells[app] = { outcome: cell?.outcome ?? null, reason: cell?.reason ?? null,
      replayPassed: null, qualification: null, measurement: null, build: null };
    if (builds) await check(`${app}:build`, () => {
      const build = builds[app];
      need(object(build), "missing-native-build");
      if (build.outcome !== "built") {
        keys(build, ["outcome", "reason", "diagnosticSha256"]);
        need(build.outcome === "failed" && build.reason === "native-build-failed" && digest(build.diagnosticSha256), "invalid-failed-build");
        need(files.has(`native/${app}/failure.log`) && hash(files.get(`native/${app}/failure.log`)) === build.diagnosticSha256,
          "missing-or-mismatched-native-failure-log");
        report.blockers.push(`native-build-failed:${app}`); report.cells[app].build = { outcome: "failed", bytes: null }; return;
      }
      keys(build, ["outcome", "inputs", "bundleSha256", "bytes", "artifacts"]);
      const bundle = app === "corten" ? "client.js" : "app.js", required = ["index.html", bundle, ...(app === "corten" ? ["runtime.js", "views.js"] : [])];
      need(object(build.artifacts) && same(Object.keys(build.artifacts).sort(), required.sort()), "incomplete-build-artifacts");
      for (const [name, sha] of Object.entries(build.artifacts)) {
        safePath(name); need(digest(sha) && files.has(`native/${app}/${name}`)
          && hash(files.get(`native/${app}/${name}`)) === sha, "native-artifact-hash-mismatch");
      }
      const bytes = files.get(`native/${app}/${bundle}`);
      need(build.bundleSha256 === hash(bytes) && build.bytes === bytes.length, "bundle-metrics-differ-from-bytes");
      need(Array.isArray(build.inputs) && build.inputs.length > 0 && build.inputs.length <= limits.files, "missing-or-unbounded-build-inputs");
      const seen = new Set();
      for (const input of build.inputs) {
        keys(input, ["path", "sha256"]); safeSourcePath(input.path);
        need(digest(input.sha256) && !seen.has(input.path.toLowerCase()), "duplicate-or-invalid-build-input"); seen.add(input.path.toLowerCase());
        if (sources?.has(input.path)) need(matchesSource(sources.get(input.path), input.sha256), "build-input-differs-from-exact-source");
        else need(input.path.startsWith("bench/browser/node_modules/"), "unbound-build-input");
      }
      const entry = app === "corten" ? "bench/browser/gen/src/bin/client.js"
        : `bench/client-heavy/apps/${app}.${["react", "solid"].includes(app) ? "jsx" : app === "remix" ? "tsx" : "js"}`;
      need(seen.has(entry) && seen.has("bench/client-heavy/apps/input.js"), "missing-native-entry-input");
      if (["vue", "svelte"].includes(app)) need(seen.has(`bench/client-heavy/apps/${app}.${app === "vue" ? "vue" : "svelte"}`), "missing-native-component-input");
      if (app !== "corten") need([...seen].some((path) => path.startsWith("bench/browser/node_modules/")), "missing-native-framework-input");
      if (app === "corten") {
        for (const name of ["screen.html", "client.footer.js", "views.d.ts", "build.log"]) need(files.has(`native/corten/${name}`), "missing-native-generator-output");
        if (sources) need(matchesSource(sources.get("crates/corten/js/dist/corten.js"), hash(files.get("native/corten/runtime.js"))), "wrong-native-runtime");
      }
      report.cells[app].build = { outcome: "built", bytes: bytes.length, sha256: hash(bytes), integrity: "matched-not-authenticated" };
    });
    await check(`${app}:cell`, async () => {
      need(object(cell) && ["passed", "failed", "unsupported", "not-run"].includes(cell.outcome), "invalid-cell-outcome");
      keys(cell, ["outcome", "qualification", "measurement", "readyForMeasurement"], ["reason"]);
      if (files.has(`${app}.json`)) need(same(json(`${app}.json`), cell), "raw-app-differs-from-summary");
      else if (cell.outcome === "not-run") report.blockers.push(`missing-unrun-app-file:${app}`);
      else need(false, "missing-raw-app-file");
      // Replay each supplied pass, even when the other pass or the gate is bad.
      const q = cell.qualification === null ? null : await check(`${app}:qualification`, () =>
        replay(cell.qualification, app, "qualification", output.effectiveWorkload, output.settings, output.timeoutMs));
      const m = cell.measurement === null ? null : await check(`${app}:measurement`, () =>
        replay(cell.measurement, app, "measurement", output.effectiveWorkload, output.settings, output.timeoutMs));
      report.cells[app].qualification = q ?? null; report.cells[app].measurement = m ?? null;
      if (cell.qualification === null) {
        need(cell.outcome !== "passed" && cell.measurement === null && cell.readyForMeasurement === false
          && typeof cell.reason === "string" && cell.reason.trim().length > 0, "unavailable-cell-needs-reason-and-no-measurement");
        report.blockers.push(`unavailable-cell:${app}`); return;
      }
      need(q?.oracle.functionalPassed === true || cell.measurement === null, "measurement-before-qualification");
      const passed = q?.oracle.functionalPassed === true && m?.oracle.functionalPassed === true;
      need(cell.readyForMeasurement === passed && (cell.outcome === "passed") === passed, "cell-flags-differ-from-raw-replay");
      if (passed) need(builds?.[app]?.outcome === "built", "passing-cell-without-native-build");
      report.cells[app].replayPassed = passed;
      if (!passed) report.blockers.push(`unqualified-cell:${app}`);
    });
  }
  await check("artifact-inventory", () => { for (const path of files.keys()) need(allowed.has(path), "unexpected-artifact-file"); });
  await check("summary-claims", () => {
    const expected = apps.every((app) => report.cells[app].replayPassed === true)
      && !output.failure && !(output.cleanupFailures?.length);
    need(output.passed === expected, "summary-passed-differs-from-replayed-evidence");
  });
  report.diagnosticsPassed = report.errors.length === 0;
  report.status = report.diagnosticsPassed ? "blocked" : "invalid";
  report.blockers = [...new Set(report.blockers)];
  return report;
}

export function cliOptions(args) {
  need(Array.isArray(args) && args.length === 5 && args[1] === "--round" && args[3] === "--commit", "usage-folder--round-round--commit-full-sha");
  return { folder: args[0], round: args[2], commit: args[4] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await validateSaved(cliOptions(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === "invalid" ? 1 : 2;
  } catch { console.error("Usage: node bench/client-heavy/verify.mjs <folder> --round <round> --commit <full-sha>"); process.exitCode = 1; }
}
