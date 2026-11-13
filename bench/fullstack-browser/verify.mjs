// Offline, read-only replay of saved native diagnostics. Never a qualification waiver.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { alertsFromReadback, candidates, nativeFailures, parseOptions, retainedFamilies, schema, settings, sha256 } from "./contract.mjs";
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
import { replayBindingProof } from "./bindings.mjs";

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

function savedFiles(folder) {
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
      "function Walk($p,$depth){$script:nodes++; if($depth -gt 3 -or $script:nodes -gt 100){throw 'Evidence inventory exceeds bounds'}; " +
      "$a=Attributes $p; if(($a -band [IO.FileAttributes]::Directory) -ne 0){foreach($child in [IO.Directory]::GetFileSystemEntries($p)){Walk $child ($depth+1)}}}; Walk $inputPaths.root 0"],
    { input: JSON.stringify({ root, ancestors }), windowsHide: true, stdio: ["pipe", "pipe", "pipe"], timeout: 15000 });
  };
  checkReparse();
  ancestors.forEach(inspect);
  let bytes = 0;
  const walk = (path, depth = 0) => {
    need(depth <= 3 && entries.size < 100, "Evidence tree exceeds bounded inventory");
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

function storeReads(e, profile, summary, app, endpoints, block) {
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
  block("Independent readback endpoint/context/source binding is not independently bundled; custom target paths are never opened");
}

function observationTiming(e, block) {
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
  return Math.max(latest, receiptChronology(e, windows, block));
}

function receiptChronology(e, windows, block) {
  const origin = e.clock.startedAt, missing = (v) => v === null || v === undefined;
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

function replayCell(cell, profile, app, summary, records, block, endpoints) {
  need(object(cell) && ["not-run", "failed", "unsupported", "captured"].includes(cell.outcome) && typeof cell.qualificationPassed === "boolean", "Malformed native cell outcome");
  if (cell.evidence === null) {
    need(cell.outcome === "not-run" || cell.outcome === "failed", "Missing native evidence cannot support a positive/unsupported cell");
    need(cell.qualificationPassed === false && text(cell.reason), "Unavailable cell lacks honest outcome/reason");
    block("Native cell not executed or failed before observations"); return null;
  }
  const e = cell.evidence;
  need(object(e) && Array.isArray(e.steps) && e.steps.length <= profile.steps.length && list(e.failures) && list(e.gaps)
    && (e.functionalChecksPassed === undefined || typeof e.functionalChecksPassed === "boolean")
    && typeof e.domChecksPassed === "boolean", "Malformed native case evidence");
  if (e.functionalChecksPassed === undefined) block("Functional checks interrupted before aggregate observation");
  same(e.environment, { ...settings.profiles[profile.device], js: profile.js }, "Native environment differs from profile");
  need(e.clock?.origin === "node.performance.now" && finite(e.clock.startedAt), "Native observation clock missing/malformed");
  const latestObservation = observationTiming(e, block);
  storeReads(e, profile, summary, app, endpoints, block);
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
          if (!artifact || !replayBindingProof(enhancement, artifact)) {
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
    if (profile.js && !retirement.length && !e.platformCleanupProof) block("No native realm-retirement network replay boundary retained for this JS cell");
    if (j.coverage?.workerNetwork !== true || j.coverage?.sharedWorkerOwnership !== true) block("Native worker-network/ownership coverage unproved; no zero inferred");
    if (j.coverage?.serverSocketPeerClosure !== true) block("Native server-peer closure unproved");
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
  if (e.failures.length || e.gaps.length) block("Native case retains failures or evidence gaps");
  return { requestOutcome: requestProof.outcome, upstreamOutcome: upstream.outcome, retirement: retirement.map((r) => ({ action: r.action, outcome: r.proof.outcome })), noJS: noJS?.outcome ?? null };
}

/** folder is repo-relative or an absolute local folder, never relative to caller cwd. */
export function validateSaved(input = {}) {
  const result = { schema: "native-browser-saved-validation/v1", outcome: "invalid", qualificationPassed: false, readyForLoad: false, invalid: [], blocked: [], inventory: null, cells: [] };
  const block = (reason) => { if (!result.blocked.includes(reason)) result.blocked.push(reason); };
  try {
    exactKeys(input, ["folder", "round", "commit"], "Exactly folder, round and commit are required");
    const { folder, round, commit } = input;
    need(text(round) && /^w[1-9]\d*$/.test(round) && text(commit) && commitId.test(commit), "Explicit round wN and full lowercase producer commit ID required");
    const files = savedFiles(folder), summary = files.json("summary.json"), records = files.json("marketplace.json", false);
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
    else block("Custom target manifest not bundled; recorded external path is never opened");
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
    block("Commit/source-tree authenticity is not independently bundled; no Git, replacements, grafts or remote lookup is consulted");
    same(summary.retainedFamilies, retainedFamilies.map((f) => ({ ...f, outcome: "not-run", reason: "Retained; not replaced by native browser diagnostics" })), "Retained benchmark family inventory differs");
    exactKeys(summary.cells, candidates, "Missing/extra native candidate");
    need(object(summary.images) && object(summary.builds) && Object.keys(summary.images).every((a) => candidates.includes(a)) && Object.keys(summary.builds).every((a) => candidates.includes(a)), "Unknown native image/build candidate");
    const expectedFiles = ["summary.json", "marketplace.json", "captures/manifest.json", ...candidates.map((a) => `captures/${a}.json`), ...Object.keys(summary.builds).map((a) => `build-${a}.log`)];
    same([...files.entries].filter(([, e]) => !e.directory).map(([p]) => p).sort(), expectedFiles.sort(), "Missing/extra saved native evidence files");
    same([...files.entries].filter(([, e]) => e.directory).map(([p]) => p).sort(), ["", "captures"], "Unknown saved evidence directory");
    for (const [app, image] of Object.entries(summary.images)) {
      need(/^sha256:[a-f0-9]{64}$/.test(image.id) && list(image.repoDigests) && image.repoDigests.every((d) => /^[a-zA-Z0-9._/:\-]+@sha256:[a-f0-9]{64}$/.test(d))
        && finite(Date.parse(image.created)) && text(image.architecture) && image.os === "linux"
        && (image.builtCommit === null || commitId.test(image.builtCommit)) && [null, "true", "false"].includes(image.builtDirty)
        && typeof image.imageSourceVerified === "boolean", "Malformed immutable native image provenance");
      same(image.imageSourceVerified, image.builtCommit === commit && image.builtDirty === "false", "Image clean-source flag contradicts labels");
      need(hash.test(image.sourceTreeSha256), "Malformed native image source tree hash");
      if (!image.imageSourceVerified || code.dirty) block("Clean exact-image source correspondence unavailable");
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
        const reasons = [], derived = replayCell(cell, profile, app, summary, records, (r) => { if (!reasons.includes(r)) reasons.push(r); }, endpoints);
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
    block("Producer lacks independently retained container-isolation/configuration and process-inspection receipts");
    block("Producer lacks an approved native closed-peer/complete worker proof contract; flags do not supply observations");
    block("Browser executable and response bodies are hashed but not bundled for independent byte rehashing; external recorded paths are never opened");
    files.unchanged(); result.outcome = "blocked";
  } catch (error) { result.invalid.push(String(error.message).split("\n")[0]); }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), options = {};
  try {
    need(args.length === 6, "Usage: node bench/fullstack-browser/verify.mjs --folder directory --round wN --commit full-sha");
    for (let i = 0; i < args.length; i += 2) { const key = args[i].slice(2); need(args[i].startsWith("--") && ["folder", "round", "commit"].includes(key) && !Object.hasOwn(options, key), "Unknown/duplicate validator option"); options[key] = args[i + 1]; }
    const report = validateSaved(options); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.outcome === "invalid" ? 2 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
