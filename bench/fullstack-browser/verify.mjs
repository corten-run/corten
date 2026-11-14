// Offline, read-only replay of saved native diagnostics. Never a qualification waiver.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { alertsFromReadback, candidates, nativeFailures, parseOptions, retainedFamilies, schema, settings, sha256, validateTargets } from "./contract.mjs";
import { exportBrowserCaptures } from "./capture.mjs";
import { reconcileRequests } from "./ledger.mjs";
import { reconcileUpstream } from "./upstream.mjs";
import { classifyNoJSRequests, validatePlatformRetirement } from "./lifecycle.mjs";
import { navigationDestination, writeDestination } from "./navigation.mjs";
import { records as fixtureRecords } from "../marketplace/fixtures.mjs";
import { comparePage } from "../marketplace/check.mjs";
import { labels } from "../marketplace/records.mjs";
import { createBrowserPlan } from "../workloads/browser.mjs";
import { validateBindingArtifact } from "./binding-artifact.mjs";
import { replayActionBinding, validateBindingWindow, validateBindingClockPhase } from "./binding-window.mjs";
import { openEvidence, encoded } from "./native-evidence.mjs";
import { replaySource, replayBuildContext, replayTools } from "./native-source.mjs";
import { replayExecution } from "./native-execution.mjs";
import { replayWorkerAbsence, replayPeerApplicability, expectedNativeExitCode } from "./native-lifetimes.mjs";
import { replayResponse } from "./native-responses.mjs";

const here = dirname(fileURLToPath(import.meta.url)), repo = resolve(here, "../..");
const hash = /^[a-f0-9]{64}$/, commitId = /^[a-f0-9]{40}$/;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => typeof v === "string" && v.length > 0;
const finite = (v) => Number.isFinite(v) && v >= 0;
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const list = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");
const keys = ["subscriptions", "connections", "listeners", "timers", "pendingTasks"];
const same = (a, b, message) => need(isDeepStrictEqual(a, b), message);
const need = (ok, message) => assert.ok(ok, message);
const exactKeys = (v, names, message) => same(object(v) ? Object.keys(v).sort() : null, [...names].sort(), message);
const cleanSnapshot = sha256(JSON.stringify({ diff: "", untracked: [] }));

function localPath(value) {
  need(text(value) && !/[\x00-\x1f\x7f]/.test(value) && !/^[\\/]{2}/.test(value), "Local filesystem path required; no network/device paths");
  need(!value.split(/[\\/]/).some((p) => p === ".." || /[. ]$/.test(p) && p !== "."), "Path traversal/ambiguous path component");
  need(!value.replace(/^[A-Za-z]:[\\/]/, "").includes(":"), "No URI, drive-relative path or alternate data stream");
  need(!value.split(/[\\/]/).some((p) => /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p)), "No device path components");
  return value;
}

function savedFiles(folder, native = false) {
  localPath(folder);
  const root = resolve(repo, folder), entries = new Map();
  const identity = (s) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.nlink];
  const inspect = (path) => {
    const stat = lstatSync(path);
    need(!stat.isSymbolicLink(), "Symlink/junction evidence paths are forbidden");
    const canonical = (p) => process.platform === "win32" ? p.toLowerCase() : p;
    need(canonical(realpathSync(path)) === canonical(resolve(path)), "Reparse/aliased evidence paths are forbidden");
    need(stat.isDirectory() || stat.isFile() && stat.nlink === 1, "Evidence must be regular, singly linked files or directories");
    return stat;
  };
  const ancestors = [];
  for (let p = root;; p = dirname(p)) { ancestors.push(p); if (dirname(p) === p) break; }
  ancestors.reverse();
  const checkReparse = () => {
    if (process.platform !== "win32") return;
    // Check ancestors and each directory before enumeration, including NTFS tags
    // Node does not classify as symlinks. No saved value is interpolated as code.
    execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; $inputPaths=ConvertFrom-Json ([Console]::In.ReadToEnd()); " +
      "$drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($inputPaths.root)); if($drive.DriveType -in @([IO.DriveType]::Network,[IO.DriveType]::Unknown,[IO.DriveType]::NoRootDirectory)){throw 'Local evidence drive required'}; " +
      "function Attributes($p){$a=[IO.File]::GetAttributes($p); if(($a -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse evidence path forbidden'}; return $a}; " +
      "foreach($p in $inputPaths.ancestors){$null=Attributes $p}; $script:nodes=0; " +
      "function Walk($p,$depth){$script:nodes++; if($depth -gt 3 -or $script:nodes -gt $inputPaths.maxNodes){throw 'Evidence inventory exceeds bounds'}; " +
      "$a=Attributes $p; if(($a -band [IO.FileAttributes]::Directory) -ne 0){foreach($child in [IO.Directory]::GetFileSystemEntries($p)){Walk $child ($depth+1)}}}; Walk $inputPaths.root 0"],
    { input: JSON.stringify({ root, ancestors, maxNodes: native ? 50100 : 100 }), windowsHide: true, stdio: ["pipe", "pipe", "pipe"], timeout: 15000 });
  };
  checkReparse();
  ancestors.forEach(inspect);
  let bytes = 0;
  const walk = (path, depth = 0) => {
    need(depth <= 3 && entries.size < (native ? 50100 : 100), "Evidence tree exceeds bounded inventory");
    const stat = inspect(path), name = relative(root, path).split(sep).join("/");
    entries.set(name, { path, stat: identity(stat), directory: stat.isDirectory() });
    if (stat.isDirectory()) for (const child of readdirSync(path).sort()) { localPath(child); walk(join(path, child), depth + 1); }
    else { bytes += stat.size; need(stat.size <= 256 * 1024 * 1024 && bytes <= 1024 ** 3, "Evidence size exceeds read-only validator bounds"); }
  };
  walk(root);
  const unchanged = () => {
    for (const p of ancestors) inspect(p);
    for (const entry of entries.values()) same(identity(inspect(entry.path)), entry.stat, "Evidence changed while validating");
    checkReparse();
  };
  return { root, entries, unchanged, json(name, pretty = true) {
    const entry = entries.get(name); need(entry && !entry.directory, `Missing regular evidence file ${name}`);
    const fd = openSync(entry.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      same(identity(fstatSync(fd)), entry.stat, "Evidence file identity changed before read");
      const bytes = readFileSync(fd), value = JSON.parse(bytes.toString("utf8"));
      // Exact producer encoding also rejects duplicate JSON keys and ambiguous encodings.
      need(bytes.equals(Buffer.from(JSON.stringify(value, null, pretty ? 2 : undefined) + (pretty ? "\n" : ""))), `Noncanonical/malformed saved JSON ${name}`);
      same(identity(fstatSync(fd)), entry.stat, "Evidence changed during read"); return value;
    } finally { closeSync(fd); }
  } };
}

function counts(v) {
  exactKeys(v, keys, "Complete resource count fields required"); need(keys.every((k) => integer(v[k])), "Malformed resource counts");
}
function resource(v) {
  need(object(v) && text(v.observer) && text(v.realm) && finite(v.at) && Array.isArray(v.scopes) && Array.isArray(v.unsupported), "Malformed native resource observation");
  counts(v.unattributed);
  const scopes = new Set();
  for (const row of v.scopes) { need(text(row.scope) && !scopes.has(row.scope) && typeof row.connected === "boolean", "Malformed/duplicate native resource scope"); scopes.add(row.scope); counts(row.owned); }
}
function retired(before, after) {
  if (!before?.scope || before.scope === after.scope) return null;
  if (before.realm !== after.realm) return { scope: before.scope, owned: null, basis: "Native document realm replaced", probeAvailable: false,
    reason: "A destroyed realm cannot supply a fresh retired-DOM observation; no zero counts or successful event probe are invented" };
  const found = after.scopes.find((s) => s.scope === before.scope);
  return { scope: before.scope, owned: found?.owned ?? null, connected: found?.connected ?? null, basis: "Document-start native primitive ledger", probeAvailable: Boolean(found) };
}
function architecture(app, native) {
  if (app === "nextjs") return native.nextPage?.startsWith("/marketplace/") ? "next-pages" : "unverified-next-architecture";
  if (app === "laravel") return native.components?.length && native.form?.binding?.startsWith("wire:submit") ? "livewire" : "blade";
  if (app === "rails") return native.turbo && !native.turboDisabled ? "hotwire" : "rails-controller";
  return native.markers?.[{ "react-router": "reactRouter", "tanstack-start": "tanstack" }[app] ?? app] ? app : `unverified-${app}-architecture`;
}
function requests(rows) {
  need(Array.isArray(rows), "Raw request ledger must be an array"); const ids = new Set();
  for (const r of rows) {
    need(object(r) && text(r.id) && !ids.has(r.id), "Missing/duplicate raw request ID"); ids.add(r.id);
    need(text(r.method) && /^[A-Z]+$/.test(r.method) && typeof r.path === "string" && /^\/(?!\/)/.test(r.path)
      && !/[\\?#\s\x00-\x1f]/.test(r.path) && object(r.query) && text(r.resource) && text(r.transport), "Malformed raw native request fields");
    need(Object.entries(r.query).every(([k, v]) => ["seller", "sort", "offers"].includes(k) && typeof v === "string"), "Non-public query fields in native request ledger");
    need(typeof r.completed === "boolean" && (r.status === null || Number.isInteger(r.status) && r.status >= 100 && r.status <= 599)
      && (r.failure === null || text(r.failure)) && (r.captureError === undefined || text(r.captureError)) && typeof r.hasCsp === "boolean", "Malformed native request outcome");
    need(r.input === null || object(r.input) && Object.keys(r.input).sort().join() === "email,target_price"
      && Object.values(r.input).every((v) => v === null || typeof v === "string"), "Malformed public POST input");
    need(list(r.components) && (r.bodySha256 === null || hash.test(r.bodySha256)), "Malformed native request component/body hash");
    need(r.bytes === null || object(r.bytes) && ["encodedBody", "headers", "decodedBody"].every((k) => r.bytes[k] === null || integer(r.bytes[k])), "Malformed measured request bytes");
    if (r.completed && !r.failure && !r.captureError && !(r.status >= 300 && r.status < 400)) need(r.bytes && integer(r.bytes.decodedBody) && hash.test(r.bodySha256), "Successful native request lacks measured body/hash receipts");
  }
}

function ssrResponse(row, block) {
  const doc = row.document;
  if (doc === null || doc === undefined) { block("Independent SSR response observation unavailable"); return; }
  need(object(doc), "Malformed independent SSR response observation");
  const present = (value) => value !== null && value !== undefined;
  for (const key of ["observer", "scope"]) {
    if (present(doc[key])) need(text(doc[key]), "Malformed independent SSR parser identity");
    else block("Independent SSR parser identity unavailable");
  }
  if (present(doc.responseSha256)) need(typeof doc.responseSha256 === "string" && hash.test(doc.responseSha256), "Malformed SSR response hash");
  else block("SSR response hash unavailable");
  if (present(doc.status)) need(Number.isInteger(doc.status) && doc.status >= 100 && doc.status <= 599, "Malformed SSR response status");
  else block("SSR response status unavailable");
  let path = null, query = null;
  if (present(doc.url)) {
    need(object(doc.url) && Object.keys(doc.url).every((k) => ["path", "query"].includes(k)), "Malformed SSR response URL");
    if (present(doc.url.path)) {
      need(typeof doc.url.path === "string" && /^\/(?!\/)/.test(doc.url.path) && !/[\\?#\s\x00-\x1f\x7f]/.test(doc.url.path), "Malformed SSR response path");
      path = doc.url.path;
    } else block("SSR response path unavailable");
    if (present(doc.url.query)) {
      need(object(doc.url.query) && Object.entries(doc.url.query).every(([k, v]) => ["seller", "sort", "offers"].includes(k) && typeof v === "string"), "Malformed SSR response query");
      query = doc.url.query;
    } else block("SSR response query unavailable");
  } else block("SSR response URL unavailable");
  const documents = row.requests.filter((r) => r.method === "GET" && r.resource === "document" && !(r.status >= 300 && r.status < 400));
  if (!documents.length) { block("Native browser document response receipt unavailable for SSR binding"); return; }
  const matches = documents.filter((r) => (path === null || r.path === path) && (query === null || isDeepStrictEqual(r.query, query)));
  need(matches.length > 0, "SSR response URL contradicts native browser document request");
  // A matching hash/status cannot select a dispatch when its identity is ambiguous.
  if (matches.length !== 1) { block("SSR response has ambiguous native browser document identity"); return; }
  const native = matches[0];
  if (present(doc.status) && present(native.status)) same(doc.status, native.status, "SSR status contradicts native browser document response");
  if (present(doc.responseSha256) && present(native.bodySha256)) same(doc.responseSha256, native.bodySha256, "SSR hash contradicts native browser document response");
  if (!native.completed || native.failure || native.captureError || !present(native.bodySha256)) block("SSR native browser response body/completion proof unavailable");
}

function storeReads(e, profile, summary, app, endpoints, block, nativeProof) {
  const m = e.mutationProbes, entries = [[e.storeBefore, e.failures, "initial"]];
  for (const row of e.steps.filter((r) => r.action?.input)) entries.push([row.readback, row.failures, "write"]);
  if (m) entries.push([m.before, m.failures, "mutation baseline"], [m.otherContext?.before, m.failures, "other session initial"],
    [m.otherContext?.after, m.failures, "other session final"], ...(m.attempts ?? []).map((r) => [r.readback, m.failures, "rejection"]));
  const writes = new Set([...e.steps.flatMap((r) => [r.action?.path, r.formBefore?.action, r.formBefore?.updatePath,
    r.formBefore?.enhancement?.path, ...(r.requests ?? []).filter((q) => q.method === "POST").map((q) => q.path)]),
    ...(m?.attempts ?? []).map((r) => r.path)].filter(Boolean));
  let endpoint = endpoints.get(app) ?? (summary.options.targets === null ? "/api/alerts" : null);
  const observers = new Set(e.steps.flatMap((r) => [r.dom?.observer, r.document?.observer]).filter(Boolean));
  for (const [r, failures, phase] of entries) {
    if (r === null || r === undefined) { block(`Independent ${phase} readback unavailable`); continue; }
    need(object(r) && ["read", "failed", "unsupported"].includes(r.outcome), "Malformed independent readback outcome");
    for (const [key, expected] of [["source", profile.source], ["round", summary.options.round], ["case", profile.key]])
      if (r[key] !== undefined && r[key] !== null) same(r[key], expected, "Independent readback case/round/source identity contradicts run");
    if (r.path === null || r.path === undefined) block("Independent readback endpoint unavailable");
    else {
      need(typeof r.path === "string" && /^\/(?!\/)[^?#\\\s\x00-\x1f\x7f]+$/.test(r.path)
        && !r.path.startsWith("/marketplace/") && !writes.has(r.path), "Independent readback is not a separate native store endpoint");
      endpoint ??= r.path; same(r.path, endpoint, "Independent readback endpoint changed within native target/round"); endpoints.set(app, endpoint);
    }
    if (r.status !== null && r.status !== undefined) need(Number.isInteger(r.status) && r.status >= 100 && r.status <= 599, "Malformed independent readback HTTP status");
    if (r.outcome !== "read") {
      need(text(r.reason), "Failed/unsupported independent readback lacks a reason");
      if (r.outcome === "failed") need(e.functionalChecksPassed !== true && failures?.length > 0, "Failed independent readback hidden by functional outcome");
      block("Independent native store read failed or unsupported"); continue;
    }
    if (r.status === null || r.status === undefined) block("Independent readback HTTP status unavailable");
    else same(r.status, 200, "Successful independent readback contradicts native HTTP status");
    if (r.via === null || r.via === undefined) block("Independent readback method unavailable");
    else same(r.via, "independent-read", "Readback reused a non-independent response");
    if (r.observer === null || r.observer === undefined) block("Independent readback observer unavailable");
    else { need(text(r.observer) && !observers.has(r.observer), "Independent readback observer missing/reused"); observers.add(r.observer); }
    if (r.alerts === null || r.alerts === undefined) block("Independent readback store contents unavailable");
    else { need(Array.isArray(r.alerts), "Malformed independent readback contents"); alertsFromReadback(r.alerts); }
  }
  if (!nativeProof?.readbacks) block("Independent readback endpoint/context/source binding is not independently bundled; custom target paths are never opened");
}

function observationTiming(e, block, caseKey) {
  let latest = e.clock.startedAt, previous = e.clock.startedAt;
  const windows = [];
  const durationKeys = ["dispatchMs", "visibleChangeObservedMs", "settledObservedMs"];
  for (const row of e.steps) {
    need(finite(row.at), "Malformed native action start");
    // row.at precedes dispatch preparation; start + duration is only a lower bound.
    const start = e.clock.startedAt + row.at;
    need(finite(start) && start >= previous, "Native action starts before the previous observation finished");
    let end = start;
    if (row.timing === null || row.timing === undefined) block("Action timing receipts unavailable");
    else {
      need(object(row.timing) && Object.keys(row.timing).every((k) => durationKeys.includes(k)), "Malformed action timing shape");
      let last = 0;
      for (const key of durationKeys) {
        const value = row.timing[key];
        if (value === null || value === undefined) { block("Action timing receipts incomplete"); continue; }
        need(finite(value) && value >= last, "Malformed or backwards action duration");
        last = value; end = start + value;
        need(finite(end), "Action duration exceeds the observation clock");
      }
    }
    for (const sample of [row.resourcesAtDOM, row.resources]) if (sample !== null && sample !== undefined) {
      need(finite(sample.at) && sample.at >= end, "Resource observation predates action timing evidence");
      end = sample.at;
    }
    const probe = row.platformRetirementProbe;
    if (probe) {
      need(finite(probe.receivedAt) && finite(probe.finishedAt) && probe.receivedAt >= end && probe.finishedAt >= probe.receivedAt, "Retirement probe predates dependent action observations");
      end = probe.finishedAt;
    }
    if (row.platformRetirement) need(finite(row.platformRetirement.retiredAt) && row.platformRetirement.retiredAt >= start
      && row.platformRetirement.retiredAt <= end, "Retirement predates its action or follows its observations");
    windows.push({ start, end }); latest = Math.max(latest, end); previous = end;
  }
  const ready = e.readiness;
  if (ready === null || ready === undefined) block("Native readiness observation unavailable");
  else {
    need(object(ready) && Object.keys(ready).every((k) => ["definition", "actionableObservedMs"].includes(k)), "Malformed native readiness shape");
    if (ready.definition === null || ready.definition === undefined) block("Native readiness definition unavailable");
    else need(text(ready.definition), "Malformed native readiness definition");
    const value = ready.actionableObservedMs;
    if (value === null || value === undefined) block("Native readiness timing unavailable");
    else {
      need(finite(value) && e.steps.length > 0, "Malformed native readiness duration");
      const first = e.steps[0], settled = first.timing?.settledObservedMs;
      if (finite(settled)) need(value >= settled, "Readiness predates initial action settlement");
      const at = e.clock.startedAt + first.at + value;
      need(finite(at), "Readiness exceeds the observation clock");
      if (first.resources) need(at <= first.resources.at, "Readiness follows the initial action observation");
      if (e.steps.length > 1) need(at <= e.clock.startedAt + e.steps[1].at, "Readiness follows a later action");
      latest = Math.max(latest, at);
    }
  }
  return Math.max(latest, receiptChronology(e, windows, block, caseKey));
}

function receiptChronology(e, windows, block, caseKey) {
  const origin = e.clock.startedAt, missing = (v) => v === null || v === undefined;
  for (const row of e.steps.filter((r) => r.formBefore?.enhancement?.bindingProof)) {
    if (!validateBindingWindow(row.formBefore.enhancement, e, row, row.bindingWindow?.case))
      block("Binding observation does not match its native pre-dispatch chronology");
  }
  let latest = origin;
  const time = (v, label, required = true, application = true) => {
    if (missing(v)) { if (required) block(`Missing ${label} timestamp`); return null; }
    need(finite(v) && v >= origin, `Malformed/pre-case ${label} timestamp`);
    if (application) latest = Math.max(latest, v); return v;
  };
  const order = (a, b, label) => { if (!missing(a) && !missing(b)) need(a <= b, `${label} observations out of order`); };
  const sequence = (values, label) => { let prior = null; for (const value of values) { order(prior, value, label); if (!missing(value)) prior = value; } };
  const interval = (r, label, start = "startedAt", end = "finishedAt", application = true) => {
    if (!r) { block(`Missing ${label} receipt`); return [null, null]; }
    need(object(r), `Malformed ${label} receipt`);
    const bounds = [time(r[start], label, true, application), time(r[end], label, true, application)];
    sequence(bounds, label); return bounds;
  };
  const resources = [e.resourceBaseline, ...e.steps.flatMap((r) => [r.resourcesAtDOM, r.resources]),
    e.nativeCleanup?.before, e.nativeCleanup?.after, e.nativeCleanup?.released].filter(Boolean);
  for (const r of resources) {
    time(r.at, "resource");
    if (missing(r.scriptExecutionEnabled)) block("Resource JS configuration unavailable");
    else same(r.scriptExecutionEnabled, e.environment.js, "Resource JS configuration contradicts native profile");
  }
  const baseline = time(e.resourceBaseline?.at, "resource baseline");
  order(baseline, windows[0]?.start, "Resource baseline/action");
  if (!missing(e.cleanup?.closeMs)) need(finite(e.cleanup.closeMs), "Malformed harness context-close duration");
  const c = e.nativeCleanup;
  let cleanupEnd = windows.at(-1)?.end ?? baseline ?? origin;
  if (c) {
    const points = [c.before?.at, c.navigation?.at, c.after?.at, c.detachedAt, c.released?.at, c.probe?.at, c.probe?.afterAt];
    points.forEach((v) => time(v, "cleanup", false)); sequence([cleanupEnd, ...points], "Journey/cleanup");
    if (!c.before) block("Cleanup start receipt unavailable");
    if (c.probe) interval(c.probe, "retired DOM probe", "at", "afterAt");
    if (c.platformProbe) {
      const [start, end] = interval(c.platformProbe, "cleanup platform probe", "receivedAt");
      order(c.after?.at, start, "Cleanup/platform probe"); points.push(end);
    }
    cleanupEnd = Math.max(cleanupEnd, ...points.filter((v) => !missing(v)));
  }
  const j = e.platformLifecycle, b = j?.boundaries ?? {};
  if (j) {
    for (const key of ["startedAt", "applicationStartedAt", "terminalStartedAt", "endedAt"]) time(b[key], "lifecycle boundary");
    sequence([b.startedAt, baseline, b.applicationStartedAt, windows[0]?.start], "Pre-baseline/application lifecycle");
    sequence([b.applicationStartedAt, windows.at(-1)?.end, c?.before?.at, c?.after?.at, c?.probe?.afterAt, c?.platformProbe?.finishedAt,
      b.terminalStartedAt, b.endedAt], "Journey/terminal lifecycle");
    const journal = (saved, application) => {
      need(Array.isArray(saved.events), "Malformed lifecycle receipt array"); let prior = origin;
      for (const r of saved.events) {
        need(object(r), "Malformed lifecycle receipt");
        const received = time(r.receivedAt, "lifecycle receipt", true, application);
        order(prior, received, "Lifecycle receipt stream"); if (!missing(received)) prior = received;
        const started = time(r.startedAt, "lifecycle receipt start", false, application), finished = time(r.finishedAt, "lifecycle receipt finish", false, application);
        sequence([started, received, finished], "Lifecycle receipt");
        if (r.event === "Target.getTargets" || r.event === "native-clock-sample") {
          if (missing(started)) block("Lifecycle request start receipt unavailable");
          if (r.phase?.startsWith("initial")) order(received, b.startedAt, "Initial lifecycle inventory/clock");
          else if (r.phase?.startsWith("terminal")) order(b.terminalStartedAt, started, "Terminal lifecycle inventory/clock");
          else if (r.event === "native-clock-sample" && r.phase?.startsWith("binding-"))
            need(validateBindingClockPhase(r, e, caseKey, saved), "Unbound or inconsistent native binding-clock phase");
          else need(false, "Unknown lifecycle inventory/clock phase");
        }
        if (r.event === "unique-context-read-probe" && missing(finished)) block("Lifecycle probe completion unavailable");
        if (r.event === "domain-enabled") order(received, b.startedAt, "Pre-baseline lifecycle domain");
        if (application) { order(received, b.endedAt, "Lifecycle receipt/terminal boundary"); order(finished, b.endedAt, "Lifecycle completion/terminal boundary"); }
      }
      for (const r of saved.observationFailures ?? []) {
        const at = time(r.at, "lifecycle observer failure", true, application);
        if (application) order(at, b.endedAt, "Observer failure/terminal boundary");
      }
    };
    journal(j, true);
    for (const phase of ["initial", "terminal"]) if (!j.events.some((r) => r.event === "Target.getTargets" && r.phase === phase)) block("Lifecycle target inventory incomplete");
    for (const r of j.realms ?? []) {
      const at = time(r.observedAt, "realm association"); order(at, b.endedAt, "Realm/terminal boundary");
      const created = j.events.find((v) => v.event === "Runtime.executionContextCreated" && v.uniqueId === r.uniqueId);
      if (created) order(created.receivedAt, at, "Context/realm dependency"); else block("Realm lacks native creation receipt");
      for (const sample of resources.filter((v) => v.realm === r.realm)) order(at, sample.at, "Realm/resource dependency");
    }
    for (const doc of j.documents ?? []) {
      const at = time(doc.observedAt, "parser document");
      sequence([b.applicationStartedAt, at, b.terminalStartedAt], "Application/parser/terminal lifecycle");
      const realm = j.realms?.find((r) => r.realm === doc.realm);
      if (realm) order(realm.observedAt, at, "Realm/parser dependency"); else block("Parser realm association unavailable");
      const index = e.steps.findIndex((r) => r.dom?.observer === doc.observer);
      if (index >= 0) sequence([e.steps[index].resources?.at, at, windows[index + 1]?.start ?? c?.before?.at ?? b.terminalStartedAt], "Action/parser dependency");
      else sequence([cleanupEnd, at, b.terminalStartedAt], "Post-cleanup parser dependency");
      const [start, end] = interval(doc.identityObservation, "parser URL identity");
      sequence([at, start, end, b.terminalStartedAt], "Dependent parser URL observation");
      if (doc.identityObservation?.uniqueId !== undefined && realm) same(doc.identityObservation.uniqueId, realm.uniqueId, "Parser identity contradicts native realm");
    }
    const h = e.harnessClosedLifecycle;
    if (h) {
      journal(h, false);
      same(h.events.slice(0, j.events.length), j.events, "Post-harness lifecycle changed the native receipt prefix");
      same(h.documents, j.documents, "Post-harness parser observations changed"); same(h.realms, j.realms, "Post-harness realm associations changed");
      same(h.boundaries, j.boundaries, "Post-harness lifecycle boundaries changed");
      same(h.target, j.target, "Post-harness native target identity changed");
      same(h.observationFailures?.slice(0, j.observationFailures?.length ?? 0), j.observationFailures, "Post-harness lifecycle failure prefix changed");
      for (const r of h.events.slice(j.events.length)) order(b.endedAt, r.receivedAt, "Post-native lifecycle receipt");
      for (const r of (h.observationFailures ?? []).slice(j.observationFailures?.length ?? 0)) order(b.endedAt, r.at, "Post-native observer failure");
    } else block("Post-harness lifecycle receipt journal unavailable");
  }
  const ledger = e.upstreamLedger;
  if (ledger) {
    const [start, end] = interval(ledger.baseline, "upstream baseline");
    order(end, baseline, "Upstream/resource baseline");
    order(end, j?.events?.[0]?.receivedAt, "Upstream/native observer initialization");
    let prior = end;
    for (const p of ledger.phases ?? []) {
      const [before, ready] = interval(p.before, "upstream phase before"), [after, done] = interval(p.after, "upstream phase after");
      sequence([prior, before, ready, after, done], "Upstream phases"); prior = done ?? ready ?? prior;
      const index = e.steps.findIndex((r) => r.action.id === p.phase);
      if (index >= 0) {
        sequence([windows[index].start, before, ready, e.steps[index].resourcesAtDOM?.at ?? e.steps[index].resources?.at], "Action/upstream begin");
        order(windows[index].end, after, "Action/upstream end"); order(done, windows[index + 1]?.start ?? c?.before?.at, "Upstream/next action or cleanup");
      }
      if (p.phase === "initial-store") sequence([b.applicationStartedAt, before, ready, after, done, windows[0]?.start], "Initial store phase");
      if (p.phase === "mutation-probes") { order(windows.at(-1)?.end, before, "Journey/mutation phase"); order(done, c?.before?.at, "Mutation/cleanup phase"); }
      if (p.phase === "cleanup") {
        order(ready, c?.before?.at, "Upstream/cleanup begin"); order(cleanupEnd, after, "Cleanup/upstream end"); order(done, b.terminalStartedAt, "Cleanup/terminal phase");
        for (const doc of j?.documents ?? []) if (!e.steps.some((r) => r.dom?.observer === doc.observer)) order(done, doc.observedAt, "Cleanup upstream/terminal parser");
      }
    }
    const [terminal, done] = interval(ledger.terminal, "upstream terminal");
    sequence([prior, b.endedAt, terminal, done], "Lifecycle/upstream terminal phase");
  }
  return latest;
}

function replayCell(cell, profile, app, summary, records, block, endpoints, nativeProof = null) {
  need(object(cell) && ["not-run", "failed", "unsupported", "captured"].includes(cell.outcome) && typeof cell.qualificationPassed === "boolean", "Malformed native cell outcome");
  if (cell.evidence === null) {
    need(cell.outcome === "not-run" || cell.outcome === "failed", "Missing native evidence cannot support a positive/unsupported cell");
    need(cell.qualificationPassed === false && text(cell.reason), "Unavailable cell lacks honest outcome/reason");
    const prerequisite = nativeProof?.prerequisites.get(`${app}/${profile.key}`);
    if (prerequisite) return prerequisite;
    block("Native cell not executed or failed before observations"); return null;
  }
  const e = cell.evidence;
  need(object(e) && Array.isArray(e.steps) && e.steps.length <= profile.steps.length && list(e.failures) && list(e.gaps)
    && (e.functionalChecksPassed === undefined || typeof e.functionalChecksPassed === "boolean")
    && typeof e.domChecksPassed === "boolean", "Malformed native case evidence");
  if (e.functionalChecksPassed === undefined) block("Functional checks interrupted before aggregate observation");
  same(e.environment, { ...settings.profiles[profile.device], js: profile.js }, "Native environment differs from profile");
  need(e.clock?.origin === "node.performance.now" && finite(e.clock.startedAt), "Native observation clock missing/malformed");
  const latestObservation = observationTiming(e, block, profile.key);
  storeReads(e, profile, summary, app, endpoints, block, nativeProof);
  if (e.resourceBaseline) { resource(e.resourceBaseline); same(e.resourceBaseline.scriptExecutionEnabled, profile.js, "Baseline JS configuration differs from profile"); }
  else block("Native resource baseline missing");
  if (e.storeBefore?.outcome === "read") {
    if (e.storeBefore.alerts?.length) need(!e.functionalChecksPassed && e.failures.length > 0, "Initial nonempty store hidden by functional summary");
  } else block("Initial empty independent store proof unavailable");
  let previous = null, domPass = true, allFunctional = e.steps.length === profile.steps.length;
  const semanticFailures = [];
  for (const [index, row] of e.steps.entries()) {
    same(row.action, profile.steps[index], "Raw native action differs from current plan/order");
    need(finite(row.at) && (!index || row.at >= e.steps[index - 1].at) && list(row.failures) && list(row.lifecycleFailures) && list(row.errors), "Malformed native step timing/errors");
    requests(row.requests);
    if (index === 0 || row.document !== null && row.document !== undefined) ssrResponse(row, block);
    if (row.resourcesAtDOM && row.dom) {
      resource(row.resourcesAtDOM); same(row.resourcesAtDOM.scope, row.dom.scope, "DOM/resource native scope identity differs");
    } else block("Native resources-at-DOM binding unavailable");
    const step = row.action;
    let passed = true;
    try {
      need(row.dom?.observer && row.dom.scope && row.dom.url?.path === step.path, "Missing/wrong independently observed DOM route");
      if (step.kind === "missing") need(row.dom.page === null && text(row.dom.error), "Missing native visible error");
      else {
        let message = step.kind === "invalid-email" ? labels[profile.locale].invalid_email : step.kind === "invalid-price" ? labels[profile.locale].invalid_price : "";
        if (step.kind === "accepted-write") {
          const values = { email: step.input.email, title: records[step.itemId].title, price: new Intl.NumberFormat(profile.locale, { style: "currency", currency: "USD" }).format(1.25) };
          message = labels[profile.locale].alert_set.replace(/\{(email|title|price)\}/g, (_, key) => values[key]);
        }
        const options = { ...step.query, message };
        comparePage(row.dom.page, records[step.itemId], profile.locale, options);
        if (row.document) comparePage(row.document.page, records[step.itemId], profile.locale, options);
      }
      if (index === 0) {
        if (row.document) need(row.document.observer !== row.dom.observer && row.document.scope !== row.dom.scope, "Independent initial SSR observation reused");
        const initial = architecture(app, row.dom.native);
        if (initial.startsWith("unverified-") && !row.document?.native) block("Independent SSR architecture markers unavailable");
        else same(e.architecture, initial.startsWith("unverified-") ? architecture(app, row.document.native) : initial, "Native architecture differs from observed markers");
      }
    } catch (error) { passed = false; semanticFailures.push(error.message); }
    // A retained failure may precede semantic extraction; it cannot claim a pass.
    if (row.domPassed) need(passed, `Stored DOM pass contradicts raw observation: ${semanticFailures.at(-1)}`);
    else { need(row.failures.length > 0 || !passed, "Stored DOM failure has no retained cause"); passed = false; }
    domPass &&= passed;
    const posts = row.requests.filter((r) => r.method === "POST");
    try {
      if (step.input) {
        need(posts.length === 1 && isDeepStrictEqual(posts[0].input, step.input), "Native write/input coverage missing");
        const enhancement = profile.js ? row.formBefore?.enhancement : null;
        if (app === "nextjs" && profile.js) {
          const artifact = summary.bindingArtifacts?.[app];
          if (artifact) same(e.bindingArtifact, { sha256: artifact.sha256, imageId: artifact.imageId, sourceCommit: artifact.sourceCommit }, "Native case/code artifact identity differs");
          if (!artifact || !replayActionBinding(enhancement, artifact, e, row, profile.key)) {
            block("Next emitted-code/native-binding effect proof unavailable or inconsistent");
            need(!e.functionalChecksPassed && row.failures.length, "Stored Next native pass lacks replayable binding effects");
          }
        }
        const endpoint = profile.js && posts[0].transport === "livewire" ? row.formBefore?.updatePath : enhancement?.path ?? row.formBefore?.action;
        need(endpoint && writeDestination(posts[0], { app, architecture: e.architecture, js: profile.js, form: row.formBefore }) === endpoint, "Native write lacks independent form binding");
        if (enhancement) same(posts[0].transport, enhancement.transport, "Native enhancement transport mismatch");
        need((step.kind === "accepted-write" ? [200, 201, 202, 204, 302, 303] : [200, 302, 303, 400, 422]).includes(posts[0].status), "Unexpected native POST status");
        const accepted = profile.steps.find((s) => s.kind === "accepted-write");
        if (row.readback?.outcome === "read" && Array.isArray(row.readback.alerts)) same(row.readback.alerts, [{ item_id: step.itemId, email: accepted.input.email, target_minor: 125 }], "Native write/rejection store mismatch");
        else block("Independent store readback contents unavailable");
      } else need(!posts.length, "Unexpected native write");
      if (!step.input && (["initial", "missing", "reset", "return"].includes(step.kind) || step.kind === "navigate" || !profile.js)) need(row.requests.some((r) => r.method === "GET"
        && r.status === (step.kind === "missing" ? 404 : 200) && navigationDestination(r, { app, architecture: e.architecture, js: profile.js, form: row.formBefore }) === step.path), "Native navigation receipt missing");
      need(!row.errors.length && !row.requests.some((r) => (r.failure || !r.completed || r.status === null) && !r.intentionallyDisabledPreload), "Native request/error failure");
    } catch (error) { semanticFailures.push(error.message); need(!e.functionalChecksPassed && row.failures.length > 0, `Stored native pass contradicts raw requests: ${error.message}`); }
    if (row.resources) {
      resource(row.resources); same(row.resources.scriptExecutionEnabled, profile.js, "Resource JS configuration differs from profile");
      same(row.retired, retired(previous, row.resources), "Retirement summary differs from raw resource ledger"); previous = row.resources;
    } else block("Native step resource ledger missing");
    allFunctional &&= !row.failures.length;
  }
  same(e.domChecksPassed, e.steps.length === profile.steps.length && domPass, "DOM aggregate differs from raw steps");
  const native = nativeFailures(app, profile, e.steps);
  if (native.length) need(!e.functionalChecksPassed && e.failures.length > 0, "Native architecture failures hidden by functional flag");
  if (!e.mutationProbes) { block("Native mutation/isolation observations missing"); allFunctional = false; }
  else {
    const m = e.mutationProbes;
    need(list(m.failures) && Array.isArray(m.attempts), "Malformed mutation probe ledger");
    if (!m.failures.length) {
      same(m.attempts.map((a) => a.kind), ["cross-site-origin", "cross-site-fetch-metadata", "no-record"], "Missing/duplicate mutation rejection probes");
      for (const read of [m.otherContext?.before, m.otherContext?.after]) if (read?.outcome === "read" && Array.isArray(read.alerts)) same(read.alerts, [], "Other context starts nonempty or mutation state crossed contexts");
      const accepted = profile.steps.find((s) => s.kind === "accepted-write");
      if (m.before?.outcome === "read" && Array.isArray(m.before.alerts)) same(m.before.alerts, [{ item_id: accepted.itemId, email: accepted.input.email, target_minor: 125 }], "Mutation baseline differs from independently observed accepted store");
      for (const row of m.attempts) {
        need(!row.failure && row.method === "POST" && (row.kind === "no-record" ? [404] : [400, 403, 419, 422]).includes(row.status), "Mutation probe did not reject");
        if (row.readback?.outcome === "read" && Array.isArray(row.readback.alerts) && Array.isArray(m.before?.alerts)) same(row.readback.alerts, m.before.alerts, "Rejected mutation changed store");
      }
    }
    allFunctional &&= !m.failures.length;
  }
  if (e.functionalChecksPassed) need(allFunctional && !native.length && !semanticFailures.length, "Functional summary contradicts raw native observations");
  const c = e.nativeCleanup;
  if (c !== null && c !== undefined) need(object(c) && ["observed", "failed", "unsupported"].includes(c.outcome) && list(c.failures), "Malformed native cleanup outcome");
  if (c?.before && c.after) { resource(c.before); resource(c.after); same(c.retired, retired(c.before, c.released ?? c.after), "Cleanup retirement differs from raw ledger"); }
  if (c?.released) resource(c.released);
  if (e.cleanup?.nativePageScope !== undefined) same(e.cleanup.nativePageScope, c ?? null, "Harness/native cleanup sidecars differ");
  if (c?.outcome !== "observed" || !c?.probe || !c?.dom || e.cleanup?.contextClosed !== true) block("Native closed-scope DOM/probe cleanup proof unavailable");
  if (c?.outcome === "observed") {
    need(c.probe && c.dom && c.retired?.probeAvailable && c.retired.owned, "Claimed native cleanup lacks fresh observations");
    counts(c.probe.afterResources); counts(c.retired.owned); counts(c.probe.owned);
    need([...Object.values(c.probe.afterResources), ...Object.values(c.retired.owned), ...Object.values(c.probe.owned)].every((n) => n === 0), "Claimed cleanup retains resources");
    need(c.retired.connected === false && c.retired.scope === c.before?.scope && c.probe.scope === c.before.scope
      && Object.values(c.after.unattributed).every((n) => n === 0) && !c.after.unsupported.length, "Claimed cleanup lacks attributed native retirement");
    need(finite(c.navigation?.at) && c.before.at <= c.navigation.at && c.navigation.at <= c.after.at
      && c.after.at <= c.released?.at && c.released.at <= c.probe.at, "Cleanup observation boundaries out of order");
    need(hash.test(c.probe.beforeSha256) && c.probe.beforeSha256 === c.probe.immediateSha256 && c.probe.beforeSha256 === c.probe.afterSha256
      && finite(c.probe.at) && c.probe.afterAt - c.probe.at >= settings.observationMs, "Claimed cleanup lacks bounded unchanged-DOM evidence");
    same(c.probe.requests, [], "Cleanup probe emitted requests"); same(c.probe.errors, [], "Cleanup probe emitted errors");
  }
  const requestProof = reconcileRequests(e);
  if (e.requestLedger !== undefined) requests(e.requestLedger); else block("Final raw browser request ledger unavailable");
  if (e.requestLedgerEndedAt === null || e.requestLedgerEndedAt === undefined) block("Final browser request ledger boundary unavailable");
  else need(finite(e.requestLedgerEndedAt) && e.requestLedgerEndedAt >= latestObservation, "Final browser request boundary predates retained observations or is malformed");
  if (e.requestReconciliation !== undefined) same(e.requestReconciliation, requestProof, "Stored final request reconciliation differs from raw ledger");
  else block("Final request reconciliation not retained by producer");
  if (requestProof.outcome !== "reconciled") block(`Final request coverage unknown: ${requestProof.reasons.join("; ")}`);
  const upstream = reconcileUpstream(e.upstreamLedger, { source: profile.source, actions: profile.steps.map((s) => s.id),
    steps: profile.steps.map((action) => ({ action, requests: e.steps.find((s) => s.action.id === action.id)?.requests ?? [] })), observationMs: settings.observationMs });
  if (e.upstreamLedger !== undefined) {
    const ledger = e.upstreamLedger;
    need(ledger?.schema === "native-browser-upstream-ledger/v1" && Array.isArray(ledger.phases), "Malformed final upstream ledger");
    for (const sample of [ledger.baseline, ...ledger.phases.flatMap((p) => [p.before, p.after]), ledger.terminal].filter((s) => s !== null && s !== undefined)) {
      need(object(sample) && finite(sample.startedAt) && finite(sample.finishedAt) && sample.finishedAt >= sample.startedAt
        && (sample.error === null || text(sample.error)), "Malformed upstream sample");
      if (sample.snapshot) {
        need(sample.snapshot.schema === "native-browser-upstream-counters/v1" && text(sample.snapshot.ledger) && Array.isArray(sample.snapshot.events), "Malformed upstream snapshot");
        for (const event of sample.snapshot.events) need(text(event.request) && text(event.id) && finite(event.started) && [200, 404].includes(event.status)
          && [event.completed, event.cancelled].every((t) => t === null || finite(t) && t >= event.started) && !(event.completed !== null && event.cancelled !== null), "Malformed upstream native terminal receipt");
      }
    }
  } else block("Final upstream ledger unavailable");
  if (e.upstreamReconciliation !== undefined) same(e.upstreamReconciliation, upstream, "Stored final upstream reconciliation differs from raw receipts");
  else block("Final upstream reconciliation not retained by producer");
  if (upstream.outcome !== "reconciled") block(`Final upstream coverage unknown: ${upstream.reasons.join("; ")}`);
  else {
    for (const row of e.steps) { const { phase, ...delta } = upstream.phases.find((p) => p.phase === row.action.id); same(row.upstream, delta, "Action upstream summary differs from terminal ledger"); }
    for (const [phase, value] of [["mutation-probes", e.mutationProbes], ["cleanup", c]]) if (value?.upstream) { const { phase: name, ...delta } = upstream.phases.find((p) => p.phase === phase); same(value.upstream, delta, "Probe/cleanup upstream summary differs from terminal ledger"); }
  }
  let noJS = null, retirement = [];
  if (e.platformLifecycle) {
    const j = e.platformLifecycle;
    need(j.schema === "native-browser-platform-lifetimes/v2" && Array.isArray(j.events)
      && j.events.every((v) => object(v) && text(v.event) && finite(v.receivedAt))
      && Array.isArray(j.realms) && j.realms.every((v) => object(v) && text(v.realm)), "Malformed native platform journal");
    same(j.contextConfiguration?.javaScriptEnabled, profile.js, "Native context JS configuration differs from profile");
    retirement = e.steps.filter((s) => s.platformRetirement).map((s) => ({ action: s.action.id,
      proof: validatePlatformRetirement(j, { ...s.platformRetirement, observationMs: settings.observationMs }) }));
    if (e.platformRetirementProofs !== undefined) same(e.platformRetirementProofs, retirement, "Stored retirement proofs differ from native receipts");
    else block("Native retirement proofs unavailable");
    if (c?.before?.realm !== c?.after?.realm && c?.navigation) {
      const proof = validatePlatformRetirement(j, { realm: c.before.realm, retiredAt: c.navigation.at, observationMs: settings.observationMs });
      if (e.platformCleanupProof !== undefined) same(e.platformCleanupProof, proof, "Stored cleanup proof differs from native receipts");
      else block("Native platform cleanup proof unavailable");
      if (proof.outcome !== "proved") block("Native platform cleanup receipts remain unknown/failed");
    }
    if (!profile.js) { noJS = classifyNoJSRequests(j); if (e.noJSRequestProof !== undefined) same(e.noJSRequestProof, noJS, "Stored no-JS proof differs from native receipts"); else block("Native no-JS classification unavailable"); if (noJS.outcome !== "classified") block("Native no-JS coverage remains unknown"); }
    if (retirement.some((r) => r.proof.outcome !== "proved")) block("Native realm retirement remains unknown/failed");
    const lifetime = nativeProof?.lifetimes.get(`${app}/${profile.key}`);
    if (profile.js && !retirement.length && !e.platformCleanupProof && lifetime?.peer.status !== "verified") block("No native realm-retirement network replay boundary retained for this JS cell");
    if (lifetime?.workers.status !== "verified" && (j.coverage?.workerNetwork !== true || j.coverage?.sharedWorkerOwnership !== true)) block("Native worker-network/ownership coverage unproved; no zero inferred");
    if (lifetime?.peer.status !== "verified" && j.coverage?.serverSocketPeerClosure !== true) block("Native server-peer closure unproved");
  } else block("Native platform lifecycle journal unavailable");
  const p = e.provenance, image = summary.images[app];
  if (!p) block("Native process provenance unavailable");
  else {
    need(/^[a-f0-9]{64}$/.test(p.containerId) && p.imageId === image?.id && text(p.startedAt) && p.source === profile.source && typeof p.stillSameProcess === "boolean", "Malformed/inconsistent native container provenance");
    same(p.configuration, { cpus: 1, memoryBytes: 2 ** 30, marketplaceSource: profile.source, fixtureSha256: summary.fixtureSha256 }, "Native container configuration mismatch");
    if (!p.stillSameProcess) block("Native process continuity failed");
  }
  const qualified = !e.failures.length && !e.gaps.length && c?.outcome === "observed";
  if (qualified) need(e.functionalChecksPassed === true && e.domChecksPassed === true, "Positive native cell lacks functional/DOM proof");
  const outcome = e.failures.length ? "failed" : qualified ? "captured" : "unsupported";
  same(cell.outcome, outcome, "Cell outcome differs from native failures/gaps/cleanup");
  // Runner can downgrade a captured case when clean image labels are unavailable.
  same(cell.qualificationPassed, qualified && image?.imageSourceVerified === true, "Cell qualification flag differs from raw outcome/image");
  if (e.gaps.length || e.failures.length && (!nativeProof || !semanticFailures.length)) block("Native case retains failures or evidence gaps");
  return { requestOutcome: requestProof.outcome, upstreamOutcome: upstream.outcome, retirement: retirement.map((r) => ({ action: r.action, outcome: r.proof.outcome })), noJS: noJS?.outcome ?? null,
    ...(nativeProof ? { semanticFailures, completeActions: e.steps.length === profile.steps.length } : {}) };
}

/** folder is repo-relative or an absolute local folder, never relative to caller cwd. */
export function validateSaved(input = {}) {
  try {
    exactKeys(input, ["folder", "round", "commit"], "Exactly folder, round and commit are required");
    const folder = resolve(repo, localPath(input.folder));
    if (existsSync(join(folder, "native-evidence"))) return validateNativeV2(input);
  } catch { /* The legacy parser returns its established invalid diagnostic. */ }
  return replaySaved(input);
}

export function validateContextReceipts(contexts, terminal, execution) {
  need(Array.isArray(contexts) && contexts.length <= 1000, "Malformed native context inventory");
  const ids = new Set(); let complete = true;
  for (const c of contexts) {
    exactKeys(c, ["id", "role", "app", "case", "source", "createStartedAt", "createdAt", "closeStartedAt", "closeEventAt", "closeCompletedAt", "absentAfter"], "Unknown context receipt");
    need(text(c.id) && !ids.has(c.id), "Duplicate/missing native context identity"); ids.add(c.id);
    need(["application", "ssr-parser", "mutation-other"].includes(c.role) && candidates.includes(c.app) && ["api", "fixture"].includes(c.source), "Unknown native context role/source");
    const windows = execution.processWindows.filter((w) => w.app === c.app && w.case === c.case);
    if (windows.length !== 1) { complete = false; continue; }
    const times = [windows[0].startedAt, c.createStartedAt, c.createdAt, c.closeStartedAt, c.closeEventAt, c.closeCompletedAt, windows[0].endedAt];
    if (!times.every(finite) || !times.every((v, i) => !i || times[i - 1] <= v) || c.absentAfter !== true) complete = false;
  }
  if (!terminal) return false;
  exactKeys(terminal, ["closeStartedAt", "contextsBefore", "disconnectedAt", "closeCompletedAt", "connectedAfter"], "Unknown native browser terminal receipt");
  const times = [execution.executionWindow.startedAt, terminal.closeStartedAt, terminal.disconnectedAt, terminal.closeCompletedAt, execution.executionWindow.endedAt];
  return complete && Array.isArray(terminal.contextsBefore) && terminal.contextsBefore.length === 0 && terminal.connectedAfter === false
    && times.every(finite) && times.every((v, i) => !i || times[i - 1] <= v);
}

function readbackEntries(e) {
  const m = e.mutationProbes;
  return [[e.storeBefore, "initial-store", "application"], ...e.steps.filter((r) => r.action.input).map((r) => [r.readback, r.action.id, "application"]),
    [m?.before, "mutation-baseline", "application"], [m?.otherContext?.before, "other-initial", "mutation-other"],
    [m?.otherContext?.after, "other-final", "mutation-other"], ...(m?.attempts ?? []).map((r) => [r.readback, `rejection-${r.kind}`, "application"])];
}

export function replayLiveInputs(reader, ref, sourceReceipt) {
  const rows = reader.json(ref), expected = sourceReceipt.files;
  need(Array.isArray(rows) && rows.length === expected.length, "Incomplete executable source inventory");
  rows.forEach((r, i) => {
    exactKeys(r, ["path", "body", "canonicalSha256"], "Unknown live executable source receipt");
    same([r.path, r.canonicalSha256], [expected[i].path, expected[i].sha256], "Executable input/source identity mismatch");
    const body = reader.read(r.body), text = body.toString("utf8");
    need(sha256(body) === expected[i].sha256 || Buffer.from(text).equals(body)
      && sha256(text.replaceAll("\r\n", "\n")) === expected[i].sha256, "Executed source bytes differ from canonical source");
  });
  return rows;
}

// Only a fixed failed prerequisite with an acknowledged native command can
// explain why no journey was run. A saved reason string is never a witness.
export function replayPrerequisite(cell, app, summary, execution, buildContexts) {
  if (cell.outcome !== "failed" || cell.evidence !== null || cell.qualificationPassed !== false) return null;
  const commands = execution.commands, application = commands.filter((c) => c.role === "application" && c.app === app && c.case === cell.case);
  const builds = commands.filter((c) => c.operation === "build" && c.role === "artifact" && c.app === app && c.case === null);
  if (summary.options.build && summary.builds[app]?.passed === false && buildContexts.has(app)
    && builds.length === 1 && builds[0].code > 0 && application.length === 0)
    return { prerequisite: "native-build-rejected", command: builds[0].seq };
  const create = application.filter((c) => c.operation === "create"), start = application.filter((c) => c.operation === "start");
  if (create.length === 1 && create[0].code > 0 && create[0].id === null && start.length === 0)
    return { prerequisite: "native-create-rejected", command: create[0].seq };
  if (create.length === 1 && create[0].code === 0 && start.length === 1 && start[0].id === create[0].id && start[0].code > 0) {
    const participant = execution.participants.find((p) => p.id === create[0].id && p.role === "application" && p.app === app && p.case === cell.case);
    if (participant?.terminal?.state.Status === "created" && participant.window === null && participant.imageId === summary.images[app]?.id)
      return { prerequisite: "native-start-rejected", command: start[0].seq };
  }
  return null;
}

export function nativeAttemptCells(replayed, summary) {
  return replayed.map((c) => {
    const selected = summary.options.apps.includes(c.app) && (!summary.options.cases || summary.options.cases.includes(c.case));
    const derived = c.derived, complete = selected && c.blocked.length === 0 && Boolean(derived?.prerequisite || derived?.completeActions);
    const qualified = complete && !derived.prerequisite && summary.cells[c.app].find((r) => r.case === c.case).qualificationPassed === true;
    return { ...c, selected, attemptComplete: complete, qualificationPassed: qualified,
      disposition: !selected ? "not-selected" : !complete ? "proof-missing" : derived.prerequisite ? "observed-prerequisite-failure"
        : qualified ? "qualified" : "observed-target-failure" };
  });
}

async function validateNativeV2(input) {
  const result = { schema: "native-browser-saved-validation/v2", status: "invalid", attemptComplete: false, selectedComplete: false,
    qualificationPassed: false, cleanupComplete: false, expectedExitCode: 1, invalid: [], blocked: [], sources: null, cells: [], inventory: null, hostSubject: null,
    intrinsic: { valid: false, complete: false, passed: false, cleanupPassed: false }, readyForLoad: false };
  const block = (code) => { if (!result.blocked.includes(code)) result.blocked.push(code); };
  try {
    exactKeys(input, ["folder", "round", "commit"], "Exactly folder, round and commit are required");
    need(/^w[1-9]\d*$/.test(input.round) && commitId.test(input.commit), "Explicit native round and commit required");
    const files = savedFiles(input.folder, true), summary = files.json("summary.json"), n = summary.native, reader = openEvidence(files.root);
    need(n?.schema === "native-browser-run/v2", "Missing v2 producer envelope");
    exactKeys(n, ["schema", "source", "sourceBinding", "inputsBefore", "inputsAfter", "toolsBefore", "toolsAfter", "execution", "targets", "contexts", "browserTerminal", "manifest"], "Unknown native producer envelope field");
    same(n.manifest, reader.manifest, "Producer native manifest differs from sealed namespace");
    same(Object.keys(reader.manifest.records).sort(), ["source", "source-binding", "inputs-before", "inputs-after", "tools-before", "tools-after", "execution", "targets",
      ...Object.keys(summary.builds).filter((app) => summary.builds[app].nativeContext).map((app) => `build-${app}`)].sort(), "Unknown/missing native record roots");
    const root = (key, record) => { same(n[key], reader.manifest.records[record], `Native root binding differs: ${record}`); return reader.json(n[key]); };
    const sourceReceipt = root("source", "source"), narrow = replaySource(reader, sourceReceipt, input.commit);
    // The core binding covers imported helpers as well as browser/build roots.
    // This fixed local module is never selected by saved input. Like an isolated
    // binding, it requires the exact clean measured HEAD; no historical upgrade.
    const { captureSources } = await import("../workloads/isolated/contract.mjs");
    const binding = captureSources(input.commit); same(root("sourceBinding", "source-binding"), binding, "Canonical execution-source binding differs");
    const sources = { commit: binding.commit, files: binding.files };
    result.sources = sources;
    const sourceMap = new Map(sources.files.map((f) => [f.path, f]));
    for (const file of narrow.files) same(sourceMap.get(file.path), file, "Leaf source differs from broad immutable binding");
    root("inputsBefore", "inputs-before"); root("inputsAfter", "inputs-after");
    const before = replayLiveInputs(reader, n.inputsBefore, binding), after = replayLiveInputs(reader, n.inputsAfter, binding);
    same(before, after, "Executable source inputs changed during native execution");
    const toolsBefore = root("toolsBefore", "tools-before"), toolsAfter = root("toolsAfter", "tools-after");
    const tools = replayTools(reader, toolsBefore); same(replayTools(reader, toolsAfter), tools, "Native tools changed during execution");
    same(toolsBefore, toolsAfter, "Native installed tool/package bytes changed");
    same(tools.lockSha256, sourceMap.get("package-lock.json")?.sha256, "Native tool lock differs from immutable source");
    same(tools.browser, summary.browser?.executableSha256, "Native browser executable identity differs");
    const targets = root("targets", "targets"); validateTargets({ schema: "native-fullstack-browser-targets/v1", targets });
    same(sha256(JSON.stringify(targets)), summary.targetsSha256, "Bundled target manifest differs from run");
    const executionValue = root("execution", "execution"), execution = replayExecution(reader, n.execution);
    same([executionValue.task, executionValue.commit], [summary.task, input.commit], "Native execution identity differs");
    for (const reason of execution.blocked) block(`execution:${reason}`);
    const buildContexts = new Set();
    for (const [app, build] of Object.entries(summary.builds)) {
      if (!build.nativeContext) { block("immutable-build-context-missing"); continue; }
      same(build.nativeContext, reader.manifest.records[`build-${app}`], "Native build root differs");
      replayBuildContext(reader, reader.json(build.nativeContext), input.commit, app);
      buildContexts.add(app);
      if (build.passed) {
        const commands = execution.commands.filter((c) => c.operation === "build" && c.app === app && c.role === "artifact" && c.case === null);
        need(commands.length === 1 && commands[0].code === 0 && commands[0].id === build.originalImageId, "Successful native build lacks original image acknowledgement");
        const image = summary.images[app];
        if (!image || image.id !== build.originalImageId || image.buildContextSha256 !== reader.json(build.nativeContext).body.sha256
          || !image.imageSourceVerified) block("built-image-source-context-unbound");
      }
    }
    const contextsComplete = validateContextReceipts(n.contexts, n.browserTerminal, execution);
    if (!contextsComplete) block("native-context-terminal-incomplete");
    const proof = { files, manifest: reader.manifest, sources, tools, targets, execution, readbacks: true, responses: true, lifetimes: new Map(), prerequisites: new Map() };
    const contextIds = new Set(), readIds = new Set();
    for (const app of candidates) for (const cell of summary.cells[app]) {
      const e = cell.evidence;
      if (!e) {
        const prerequisite = replayPrerequisite(cell, app, summary, execution, buildContexts);
        if (prerequisite) proof.prerequisites.set(`${app}/${cell.case}`, prerequisite);
        continue;
      }
      if (!buildContexts.has(app) || summary.builds[app]?.passed !== true) block("immutable-image-build-proof-missing");
      const context = n.contexts.find((c) => c.id === e.context && c.role === "application" && c.app === app && c.case === cell.case);
      if (!context || contextIds.has(e.context)) { block("application-context-binding-missing"); proof.readbacks = false; } else contextIds.add(e.context);
      const windows = execution.processWindows.filter((w) => w.app === app && w.case === cell.case), j = e.platformLifecycle;
      if (windows.length !== 1 || !finite(e.clock?.timeOrigin) || !j || Math.floor(e.clock.timeOrigin + j.boundaries.startedAt) < windows[0].startedAt
        || Math.ceil(e.clock.timeOrigin + j.boundaries.endedAt) > windows[0].endedAt + 1) block("native-case-process-window-unbound");
      const workers = replayWorkerAbsence(j), peer = replayPeerApplicability(j, workers); proof.lifetimes.set(`${app}/${cell.case}`, { workers, peer });
      if (workers.status !== "verified" || peer.status !== "verified") block("native-worker-or-peer-proof-missing");
      for (const [r, phase, role] of readbackEntries(e)) {
        if (!r?.responseEvidence) { proof.readbacks = false; block("independent-readback-response-missing"); continue; }
        need(!readIds.has(r.requestId), "Reused independent native read identity"); readIds.add(r.requestId);
        const c = n.contexts.find((c) => c.id === r.context);
        need(context && c && c.role === role && c.app === app && c.case === cell.case && c.source === context.source, "Independent readback/context identity differs");
        same([r.app, r.case, r.source, r.round, r.phase, r.path], [app, cell.case, c.source, summary.options.round, phase, targets[app]?.readback?.path], "Independent readback source/phase/endpoint differs");
        need(c.createdAt <= r.startedAt && r.startedAt <= r.finishedAt && r.finishedAt <= c.closeStartedAt, "Independent read outside native context window");
        const response = replayResponse(reader, r.responseEvidence, { requestId: r.requestId, responseSha256: r.responseSha256, path: r.path, status: r.status });
        same(response.value, r.alerts, "Independent public readback differs from retained bytes");
        contextIds.add(c.id);
      }
      for (const row of e.steps) {
        const doc = row.document;
        if (doc?.responseEvidence) {
          const response = replayResponse(reader, doc.responseEvidence, { requestId: doc.requestId, responseSha256: doc.responseSha256, path: doc.url.path, status: doc.status });
          const c = n.contexts.find((c) => c.id === doc.context);
          need(c?.role === "ssr-parser" && c.app === app && c.case === cell.case && c.id !== context?.id, "Independent parser context differs");
          need(!contextIds.has(c.id), "Reused independent parser context");
          contextIds.add(c.id);
          same(response.page, doc.page, "Independent parser model differs from public transcript");
          if (!response.extractionComplete) { proof.responses = false; block("public-response-extraction-incomplete"); }
        } else if (doc) { proof.responses = false; block("public-response-projection-missing"); }
        // Live same-page updates and native error pages need their own typed
        // observation, not a claim that an earlier HTML body reproduced them.
        proof.responses = false; block("public-live-dom-projection-missing");
      }
    }
    const replayed = replaySaved(input, proof); result.inventory = replayed.inventory;
    need(replayed.outcome !== "invalid", replayed.invalid.join("; "));
    for (const reason of replayed.blocked) if (!["Native matrix contains unqualified or missing proof", "Native image build failed"].includes(reason)) block(`capture:${reason}`);
    if (n.contexts.some((c) => !contextIds.has(c.id))) block("unbound-native-context");
    result.cells = nativeAttemptCells(replayed.cells, summary);
    const selected = result.cells.filter((c) => c.selected);
    result.selectedComplete = !result.blocked.length && selected.length > 0 && selected.every((c) => c.attemptComplete);
    result.attemptComplete = result.selectedComplete && result.cells.length === candidates.length * summary.effectivePlan.cases.length && result.cells.every((c) => c.attemptComplete);
    result.cleanupComplete = contextsComplete && execution.cleanupComplete && !summary.cleanupFailures.length;
    const manifest = reader.finish(); same(manifest, n.manifest, "Native store changed during replay");
    files.unchanged();
    const outer = [...files.entries].filter(([, f]) => !f.directory).map(([path, f]) => ({ path, sha256: sha256(readFileSync(f.path)) }));
    if (!execution.blocked.length && result.cleanupComplete && execution.participants.every((p) => p.imageId && p.terminal)) result.hostSubject = {
      schema: "native-browser-host-subject/v2", executionWindow: execution.executionWindow, processWindows: execution.processWindows,
      toolIdentities: { node: tools.node, browser: tools.browser }, participants: execution.participants,
      subjectSha256: execution.subjectSha256, filesSha256: sha256(encoded(outer)) };
    if (!summary.complete || summary.failures.length) block("producer-incomplete");
    if (!result.cleanupComplete) block("apparatus-cleanup-incomplete");
    if (!result.selectedComplete) block("selected-proof-incomplete");
    if (!result.attemptComplete) block("matrix-incomplete");
    result.qualificationPassed = result.attemptComplete && !result.blocked.length && summary.qualificationPassed === true;
    result.status = result.blocked.length ? "blocked" : result.qualificationPassed ? "verified" : "failed";
    result.intrinsic = { valid: true, complete: result.attemptComplete && !result.blocked.length, passed: result.qualificationPassed, cleanupPassed: result.cleanupComplete };
    result.expectedExitCode = expectedNativeExitCode(result.qualificationPassed);
  } catch (error) { result.invalid.push(String(error.message).split("\n")[0]); }
  return result;
}

function replaySaved(input = {}, nativeProof = null) {
  const result = { schema: "native-browser-saved-validation/v1", outcome: "invalid", qualificationPassed: false, readyForLoad: false, invalid: [], blocked: [], inventory: null, cells: [] };
  const block = (reason) => { if (!result.blocked.includes(reason)) result.blocked.push(reason); };
  try {
    exactKeys(input, ["folder", "round", "commit"], "Exactly folder, round and commit are required");
    const { folder, round, commit } = input;
    need(text(round) && /^w[1-9]\d*$/.test(round) && text(commit) && commitId.test(commit), "Explicit round wN and full lowercase producer commit ID required");
    const files = nativeProof?.files ?? savedFiles(folder), summary = files.json("summary.json"), records = files.json("marketplace.json", false);
    same(summary.schema, schema, "Unknown raw summary schema"); same(summary.group, "fullstack-browser", "Wrong benchmark group");
    same(records, fixtureRecords(), "Saved numeric fixture differs from current canonical fixture");
    same(summary.fixtureSha256, sha256(JSON.stringify(records)), "Fixture hash mismatch");
    const plan = createBrowserPlan({ records }); same(summary.effectivePlan, plan, "Plan/profile inventory differs from current contract"); same(summary.settings, settings, "Saved options/settings differ from current native settings");
    const options = summary.options;
    need(object(options), "Missing run options"); exactKeys(options, ["round", "targets", "out", "apps", "cases", "build"], "Unknown/missing run option");
    const args = [round, "--out", localPath(options.out), "--apps", list(options.apps) ? options.apps.join(",") : ""];
    if (options.build === true) args.push("--build"); else need(options.build === false, "Malformed build option");
    if (options.targets !== null) args.push("--targets", localPath(options.targets));
    if (options.cases !== null) { need(list(options.cases), "Malformed selected profiles"); args.push("--cases", options.cases.join(",")); }
    same(parseOptions(args), options, "Run options do not round-trip through current parser"); same(options.round, round, "Round mismatch");
    need(options.cases === null || options.cases.every((key) => plan.cases.some((p) => p.key === key)), "Unknown selected profile");
    need(hash.test(summary.targetsSha256), "Missing/malformed target manifest hash");
    if (options.targets === null) same(summary.targetsSha256, sha256(JSON.stringify(Object.fromEntries(candidates.map((a) => [a, { image: `cb-marketplace-${a}`, readback: { path: "/api/alerts" } }])))), "Default target manifest hash mismatch");
    else if (!nativeProof?.targets) block("Custom target manifest not bundled; recorded external path is never opened");
    need(text(summary.task) && /^browser-[a-f0-9-]+$/.test(summary.task) && finite(Date.parse(summary.startedAt)) && finite(Date.parse(summary.finishedAt)) && Date.parse(summary.finishedAt) >= Date.parse(summary.startedAt), "Malformed run identity/timestamps");
    need(typeof summary.complete === "boolean" && list(summary.failures) && list(summary.cleanupFailures), "Malformed completion/failure summary");
    need(object(summary.host) && ["hostname", "platform", "release", "node"].every((k) => text(summary.host[k])) && list(summary.limits), "Malformed host/limits provenance");
    const code = summary.code;
    need(object(code) && code.commit === commit && typeof code.dirty === "boolean" && typeof code.status === "string" && code.dirty === Boolean(code.status) && hash.test(code.runnerDiffSha256), "Invalid source commit/dirty provenance");
    if (code.dirty) block("Dirty producer checkout cannot establish clean source correspondence");
    else same(code.runnerDiffSha256, sha256(""), "Clean producer has nonempty runner diff hash");
    const currentFiles = readdirSync(here).filter((p) => p.endsWith(".mjs")).sort();
    need(object(code.runnerFiles) && Object.keys(code.runnerFiles).length > 0, "Missing runner source hashes");
    for (const [name, value] of Object.entries(code.runnerFiles)) need(currentFiles.includes(name) && hash.test(value), "Unknown runner file or malformed source hash");
    if (!isDeepStrictEqual(Object.keys(code.runnerFiles).sort(), currentFiles)
      || currentFiles.some((name) => code.runnerFiles[name] !== sha256(readFileSync(join(here, name))))) block("Producer runner hashes differ from current validator sources; historical evidence is not upgraded");
    if (!nativeProof?.sources) block("Commit/source-tree authenticity is not independently bundled; no Git, replacements, grafts or remote lookup is consulted");
    same(summary.retainedFamilies, retainedFamilies.map((f) => ({ ...f, outcome: "not-run", reason: "Retained; not replaced by native browser diagnostics" })), "Retained benchmark family inventory differs");
    exactKeys(summary.cells, candidates, "Missing/extra native candidate");
    need(object(summary.images) && object(summary.builds) && Object.keys(summary.images).every((a) => candidates.includes(a)) && Object.keys(summary.builds).every((a) => candidates.includes(a)), "Unknown native image/build candidate");
    const expectedFiles = ["summary.json", "marketplace.json", "captures/manifest.json", ...candidates.map((a) => `captures/${a}.json`), ...Object.keys(summary.builds).map((a) => `build-${a}.log`),
      ...(nativeProof ? ["native-evidence/manifest.json", ...nativeProof.manifest.files.map((f) => f.path)] : [])];
    same([...files.entries].filter(([, e]) => !e.directory).map(([p]) => p).sort(), expectedFiles.sort(), "Missing/extra saved native evidence files");
    same([...files.entries].filter(([, e]) => e.directory).map(([p]) => p).sort(), nativeProof ? ["", "captures", "native-evidence", "native-evidence/blobs"] : ["", "captures"], "Unknown saved evidence directory");
    for (const [app, image] of Object.entries(summary.images)) {
      need(/^sha256:[a-f0-9]{64}$/.test(image.id) && list(image.repoDigests) && image.repoDigests.every((d) => /^[a-zA-Z0-9._/:\-]+@sha256:[a-f0-9]{64}$/.test(d))
        && finite(Date.parse(image.created)) && text(image.architecture) && image.os === "linux"
        && (image.builtCommit === null || commitId.test(image.builtCommit)) && [null, "true", "false"].includes(image.builtDirty)
        && typeof image.imageSourceVerified === "boolean", "Malformed immutable native image provenance");
      same(image.imageSourceVerified, image.builtCommit === commit && image.builtDirty === "false", "Image clean-source flag contradicts labels");
      need(hash.test(image.sourceTreeSha256), "Malformed native image source tree hash");
      const failedPrerequisites = nativeProof && options.apps.includes(app) && summary.cells[app]
        .filter((cell) => !options.cases || options.cases.includes(cell.case)).every((cell) => nativeProof.prerequisites.has(`${app}/${cell.case}`));
      if ((!image.imageSourceVerified || code.dirty) && !failedPrerequisites) block("Clean exact-image source correspondence unavailable");
    }
    if (summary.bindingArtifacts !== undefined) {
      need(object(summary.bindingArtifacts) && Object.keys(summary.bindingArtifacts).every((app) => app === "nextjs"), "Unknown emitted binding artifact candidate");
      for (const [app, artifact] of Object.entries(summary.bindingArtifacts)) {
        validateBindingArtifact(artifact);
        same(artifact.imageId, summary.images[app]?.id, "Binding artifact/image identity differs");
        same(artifact.sourceCommit, commit, "Binding artifact/source identity differs");
      }
    }
    for (const [app, build] of Object.entries(summary.builds)) {
      need(options.build && options.apps.includes(app) && build.image === `${summary.task}-${app}` && build.commit === commit && build.dirty === code.dirty && typeof build.passed === "boolean" && hash.test(build.sourceSnapshot), "Malformed native build provenance");
      localPath(build.context); localPath(build.dockerfile);
      const path = app === "corten" ? "bench/marketplace/corten/Dockerfile" : `bench/fullstack/apps/${app}/${app === "sveltekit" ? "Dockerfile.marketplace" : "Dockerfile"}`;
      const normalized = build.dockerfile.replaceAll("\\", "/"); need(normalized.endsWith("/" + path), "Native Dockerfile path mismatch");
      const root = normalized.slice(0, -path.length - 1), context = build.context.replaceAll("\\", "/");
      same(context, app === "corten" ? root : `${root}/bench/fullstack/apps/${app}`, "Native build context path mismatch");
      if (!code.dirty) same(build.sourceSnapshot, cleanSnapshot, "Clean build source snapshot mismatch");
      if (!build.passed) block("Native image build failed");
    }
    const browser = summary.browser;
    if (browser === null) block("Native browser provenance unavailable");
    else { need(browser?.engine === "chromium" && text(browser.version) && text(browser.playwright) && hash.test(browser.executableSha256), "Malformed browser provenance/hash"); localPath(browser.executable); same(browser.launch, { headless: true }, "Native browser launch options mismatch"); }
    const endpoints = new Map();
    for (const app of candidates) {
      const cells = summary.cells[app]; need(Array.isArray(cells), "Missing raw native profiles"); same(cells.map((c) => c?.case), plan.cases.map((p) => p.key), "Missing/extra/duplicate/out-of-order native profiles");
      for (const profile of plan.cases) {
        const cell = cells.find((c) => c.case === profile.key);
        if (cell.outcome !== "not-run") need(options.apps.includes(app) && (!options.cases || options.cases.includes(profile.key)), "Native evidence outside selected run options");
        const reasons = [], derived = replayCell(cell, profile, app, summary, records, (r) => { if (!reasons.includes(r)) reasons.push(r); }, endpoints, nativeProof);
        if (reasons.length) block("Native matrix contains unqualified or missing proof");
        result.cells.push({ app, case: profile.key, outcome: cell.outcome, derived, blocked: reasons });
      }
    }
    const exported = exportBrowserCaptures(summary, records);
    for (const app of candidates) same(files.json(`captures/${app}.json`), exported.captures[app], `Strict capture differs from current raw projection: ${app}`);
    same(files.json("captures/manifest.json"), exported.manifest, "Strict manifest/hash/provenance differs from raw projection");
    const functional = Object.values(exported.manifest.reports).every((r) => r.validation.functionalPassed);
    same(summary.strictCaptureExport, { manifest: "captures/manifest.json", functionalPassed: functional, readyForLoad: false }, "Strict export summary differs from current validation");
    const group = summary.complete && !code.dirty && !summary.failures.length && !summary.cleanupFailures.length && browser?.engine === "chromium" && candidates.every((app) => {
      const image = summary.images[app], report = exported.manifest.reports[app];
      return image?.imageSourceVerified === true && image.builtCommit === commit && image.builtDirty === "false" && !report.diagnostics.length && report.validation.functionalPassed
        && summary.cells[app].every((c) => c.outcome === "captured" && c.qualificationPassed && c.evidence?.functionalChecksPassed && c.evidence.domChecksPassed && !c.evidence.failures.length && !c.evidence.gaps.length
          && c.evidence.nativeCleanup?.outcome === "observed" && c.evidence.cleanup?.contextClosed === true && c.evidence.provenance?.stillSameProcess === true);
    });
    same(summary.qualificationPassed, Boolean(group), "Group qualification summary differs from current complete-matrix derivation");
    same(summary.readyForLoad, false, "Saved native diagnostics cannot claim load readiness");
    if (!summary.complete || summary.failures.length || summary.cleanupFailures.length) block("Run incomplete or retains run/cleanup failures");
    result.inventory = { candidates: candidates.length, profiles: plan.cases.length, cells: result.cells.length, captureFiles: candidates.length };
    if (!nativeProof?.execution) block("Producer lacks independently retained container-isolation/configuration and process-inspection receipts");
    if (!nativeProof?.lifetimes) block("Producer lacks an approved native closed-peer/complete worker proof contract; flags do not supply observations");
    if (!nativeProof?.tools || !nativeProof?.responses) block("Browser executable and response bodies are hashed but not bundled for independent byte rehashing; external recorded paths are never opened");
    files.unchanged(); result.outcome = "blocked";
  } catch (error) { result.invalid.push(String(error.message).split("\n")[0]); }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), options = {};
  try {
    need(args.length === 6, "Usage: node bench/fullstack-browser/verify.mjs --folder directory --round wN --commit full-sha");
    for (let i = 0; i < args.length; i += 2) { const key = args[i].slice(2); need(args[i].startsWith("--") && ["folder", "round", "commit"].includes(key) && !Object.hasOwn(options, key), "Unknown/duplicate validator option"); options[key] = args[i + 1]; }
    const report = await validateSaved(options); console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.schema === "native-browser-saved-validation/v2" ? report.expectedExitCode : report.outcome === "invalid" ? 2 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
