// Saved evidence only. Never imports the runner, starts participants or writes artifacts.
import assert from "node:assert/strict";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createPlan, outcomes } from "../workloads/mixed.mjs";
import { contractSha256, definition, retainedFamilies, selectedApps } from "../workloads/registry.mjs";
import { records as fixtureRecords } from "../marketplace/fixtures.mjs";
import { cpuSettings } from "../catalog/contract.mjs";
import { memoryMiB, summarizeSamples } from "../catalog/stats.mjs";
import { spread } from "../fullstack/passes.mjs";
import { featureProfile, qualification, sourceFeatures, validateProbes } from "../marketplace/feature-contract.mjs";
import { checkCell, combine, emptyCapture, expectedOutcome, oracle, sha256, upstreamEvidence } from "./capture.mjs";
import { calibrationPolicy, deriveWindow, observedCpuCeiling } from "./metrics.mjs";
import { resourceCoveragePolicy, mergeResourceSamples } from "./resources.mjs";
import { reconcileLedger, upstreamManifest, upstreamPhase } from "./upstream-ledger.mjs";
import { buildInputPaths, sourceAuditIdentity, verifySourceAudit } from "./source-audit.mjs";
import { replayResponseEvidence } from "./response-evidence.mjs";
import { replayExecutionInputs } from "./execution-inputs.mjs";
import { replayQualificationEvidence } from "./qualification-evidence.mjs";
import { replayCpuBoundary } from "./producer-evidence.mjs";
import { replayStatsClient } from "./stats.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sources = ["fixture", "api"], roles = ["app", "upstream", "load"];
const gaps = new Set(["native-form-unavailable", "independent-alert-readback-unavailable", "native-body-extraction-failed",
  "capture-failed-after-primary-start", "preparation-or-injector-failed", "native-preparation-failed"]);
const windowOutcome = (slot) => slot == null ? "not-run" : ["not-run", "failed", "measured", "calibration-or-window-rejected"].includes(slot.outcome) ? slot.outcome : "invalid-outcome";
export const limits = Object.freeze({ files: 100000, bytes: 1024 ** 3, fileBytes: 256 * 1024 ** 2,
  jsonBytes: 32 * 1024 ** 2, depth: 64, gitTimeoutMs: 60000 });
const equal = (a, b) => assert.ok(isDeepStrictEqual(a, b), "saved evidence differs");
const keys = (value, expected) => equal(Object.keys(value).sort(), [...expected].sort());
// Audited local executable closure of this verifier's replay imports. The loader
// regression checks this list through actual reads during validation, not imports.
const replayFiles = [
  "bench/catalog/contract.mjs", "bench/catalog/fixtures.mjs", "bench/catalog/group.mjs", "bench/catalog/stats.mjs",
  "bench/fullstack/conformance.mjs", "bench/fullstack/inventory.mjs", "bench/fullstack/passes.mjs", "bench/json-api/contract.mjs",
  "bench/load-tool.mjs",
  "bench/marketplace/contract.mjs", "bench/marketplace/feature-contract.mjs", "bench/marketplace/fixtures.mjs", "bench/marketplace/records.mjs",
  "bench/mixed-production/capture.mjs", "bench/mixed-production/load-capture.mjs", "bench/mixed-production/metrics.mjs",
  "bench/mixed-production/resources.mjs", "bench/mixed-production/source-audit.mjs", "bench/mixed-production/upstream-ledger.mjs",
  "bench/workloads/mixed.mjs", "bench/workloads/registry.mjs",
  "bench/mixed-production/response-evidence.mjs", "bench/mixed-production/snapshot.mjs",
  "bench/mixed-production/execution-inputs.mjs",
  "bench/mixed-production/execution-evidence.mjs",
  "bench/mixed-production/qualification-evidence.mjs", "bench/mixed-production/producer-evidence.mjs",
  "bench/mixed-production/stats.mjs",
];

function safePath(path) {
  assert.ok(typeof path === "string" && path.length > 0 && path.length <= 1024 && !/[\\:"<>|?*\x00-\x1f\x7f]/.test(path));
  for (const part of path.split("/")) assert.ok(part && part !== "." && part !== ".." && !/[. ]$/.test(part)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part), "unsafe artifact path");
  return path;
}

// JSON.parse silently accepts duplicate object keys. Reject them before parsing, including
// escaped spellings of the same key, without interpreting any saved code.
function json(text) {
  let at = 0;
  const space = () => { while (/[\t\n\r ]/.test(text[at] ?? "x")) at++; };
  const string = () => {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === "\\") at++;
      else if (c === '"') return JSON.parse(text.slice(start, at));
    }
    throw new Error("unterminated JSON string");
  };
  const value = (depth) => {
    assert.ok(depth <= limits.depth, "JSON depth exceeded"); space();
    if (text[at] === '"') { string(); return; }
    if (text[at] === "{" || text[at] === "[") {
      const object = text[at++] === "{", end = object ? "}" : "]", seen = new Set(); space();
      if (text[at] === end) { at++; return; }
      while (at < text.length) {
        if (object) {
          space(); assert.equal(text[at], '"'); const key = string();
          assert.ok(!seen.has(key), "duplicate JSON key"); seen.add(key); space(); assert.equal(text[at++], ":");
        }
        value(depth + 1); space();
        if (text[at] === end) { at++; return; }
        assert.equal(text[at++], ",");
      }
      throw new Error("unterminated JSON container");
    }
    const token = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
    assert.ok(token, "invalid JSON token"); at += token[0].length;
  };
  value(0); space(); assert.equal(at, text.length);
  return JSON.parse(text);
}

function savedFolder(folder) {
  assert.ok(typeof folder === "string" && folder.length && !/[\x00-\x1f\x7f]/.test(folder)
    && !folder.replaceAll("\\", "/").startsWith("//"), "local folder required");
  const root = resolve(folder);
  assert.ok(!root.replaceAll("\\", "/").startsWith("//"), "local folder required");
  for (let path = root;; path = dirname(path)) {
    assert.ok(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), "linked folder ancestor");
    if (path === parse(path).root) break;
  }
  const scan = () => {
    const files = new Map(), names = new Set(); let bytes = 0, entries = 0;
    const visit = (relative = "", depth = 0) => {
      assert.ok(depth <= limits.depth);
      for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
        assert.ok(++entries <= limits.files, "artifact count exceeded");
        const path = safePath(relative ? `${relative}/${entry.name}` : entry.name), folded = path.toLowerCase();
        assert.ok(!names.has(folded), "duplicate artifact path"); names.add(folded);
        const full = join(root, path), stat = lstatSync(full);
        assert.ok(!stat.isSymbolicLink(), "linked artifact");
        if (stat.isDirectory()) { visit(path, depth + 1); continue; }
        assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= limits.fileBytes, "unsafe/oversized artifact");
        bytes += stat.size; assert.ok(bytes <= limits.bytes, "artifact bytes exceeded");
        const fd = openSync(full, "r"), hash = createHash("sha256"), buffer = Buffer.alloc(65536);
        try {
          const opened = fstatSync(fd); equal([opened.dev, opened.ino, opened.size], [stat.dev, stat.ino, stat.size]);
          let length, total = 0;
          while ((length = readSync(fd, buffer, 0, buffer.length, null))) {
            total += length; assert.ok(total <= stat.size, "artifact grew during read"); hash.update(buffer.subarray(0, length));
          }
          const after = fstatSync(fd); equal([after.size, after.mtimeMs, after.ctimeMs], [stat.size, stat.mtimeMs, stat.ctimeMs]);
        } finally { closeSync(fd); }
        files.set(path, { sha256: hash.digest("hex"), size: stat.size, ino: stat.ino, dev: stat.dev, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
      }
    };
    visit(); return files;
  };
  const original = scan();
  const body = (path) => {
    safePath(path); const item = original.get(path); assert.ok(item, "artifact missing");
    const data = readFileSync(join(root, path)); assert.equal(sha256(data), item.sha256, "artifact changed"); return data;
  };
  const read = (path) => { assert.ok(original.get(path)?.size <= limits.jsonBytes, "JSON missing/oversized"); return json(body(path).toString("utf8")); };
  const artifact = (ref, expected) => {
    equal(ref?.path, expected); assert.match(ref?.sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(original.get(safePath(expected))?.sha256, ref.sha256, "artifact digest differs"); return read(expected);
  };
  return { read, body, artifact, has: (path) => original.has(safePath(path)),
    digest: (path) => { assert.ok(original.has(safePath(path)), "artifact missing"); return original.get(path).sha256; },
    finish: () => equal(scan(), original), files: original };
}

function git(args, input) {
  // Never inherit trace destinations, alternate repositories, config injection or
  // replacement refs. Missing promisor objects must stay missing, not fetch/write.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" });
  const result = spawnSync("git", ["--no-lazy-fetch", "--no-replace-objects", "-c", "protocol.allow=never",
    "-c", "core.autocrlf=false", "-c", "core.eol=lf", ...args], {
    cwd: repo, input, windowsHide: true, timeout: limits.gitTimeoutMs, maxBuffer: limits.fileBytes, encoding: null,
    env,
  });
  assert.ok(!result.error && result.status === 0, "local Git evidence unavailable"); return result.stdout;
}

function committedFiles(commit) {
  equal(git(["rev-parse", "--verify", `${commit}^{commit}`]).toString().trim(), commit);
  const entries = git(["ls-tree", "-r", "-z", commit]).toString("utf8").split("\0").filter(Boolean).map((line) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
    assert.ok(match, "linked/submodule source unsupported"); safePath(match[3]); return { oid: match[2], path: match[3] };
  });
  assert.ok(entries.length && entries.length <= limits.files);
  const batch = git(["cat-file", "--batch"], entries.map((e) => e.oid).join("\n") + "\n");
  let offset = 0;
  return Object.fromEntries(entries.map((entry) => {
    const end = batch.indexOf(10, offset), header = batch.subarray(offset, end).toString().split(" ");
    equal(header.slice(0, 2), [entry.oid, "blob"]); const length = Number(header[2]);
    assert.ok(Number.isSafeInteger(length) && length >= 0 && length <= limits.fileBytes); offset = end + 1;
    const body = batch.subarray(offset, offset + length); assert.equal(body.length, length); offset += length + 1;
    assert.equal(createHash("sha1").update(`blob ${length}\0`).update(body).digest("hex"), entry.oid, "Git blob content does not match immutable object ID");
    return [entry.path, body];
  }));
}

// Subtree Git archives use the collection time, not the commit time. Check the
// retained standard tar bytes instead of pretending a fresh archive is identical.
function archiveFiles(body, expected) {
  const seen = new Set(), directories = new Set(); let offset = 0, extended = {};
  const string = (b) => b.subarray(0, b.includes(0) ? b.indexOf(0) : b.length).toString("utf8");
  const octal = (b) => { const v = string(b).trim(); assert.match(v, /^[0-7]+$/); const n = parseInt(v, 8); assert.ok(Number.isSafeInteger(n)); return n; };
  const pax = (data) => {
    const fields = {}; let at = 0;
    while (at < data.length) {
      const space = data.indexOf(32, at); assert.ok(space > at);
      const text = data.subarray(at, space).toString(); assert.match(text, /^[1-9]\d*$/); const size = Number(text);
      assert.ok(Number.isSafeInteger(size) && size > space - at + 2 && at + size <= data.length && data[at + size - 1] === 10);
      const row = data.subarray(space + 1, at + size - 1).toString("utf8"), eq = row.indexOf("="); assert.ok(eq > 0);
      const key = row.slice(0, eq); assert.ok(!Object.hasOwn(fields, key) && ["path", "comment", "mtime", "atime", "ctime"].includes(key));
      fields[key] = row.slice(eq + 1); at += size;
    }
    return fields;
  };
  assert.ok(body.length % 512 === 0);
  while (offset + 1024 <= body.length) {
    const header = body.subarray(offset, offset + 512); offset += 512;
    if (header.every((b) => b === 0)) {
      assert.ok(body.subarray(offset).every((b) => b === 0)); equal([...seen].sort(), Object.keys(expected).sort()); return;
    }
    assert.equal(string(header.subarray(257, 263)), "ustar");
    const checksum = [...header].reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0); equal(octal(header.subarray(148, 156)), checksum);
    const length = octal(header.subarray(124, 136)); assert.ok(length <= limits.fileBytes && offset + length <= body.length);
    const data = body.subarray(offset, offset + length); offset += Math.ceil(length / 512) * 512;
    const type = header[156], name = string(header.subarray(0, 100)), prefix = string(header.subarray(345, 500));
    if (type === 103 || type === 120) {
      const fields = pax(data);
      if (type === 103) { assert.ok(!Object.hasOwn(fields, "path")); } else { assert.equal(Object.keys(extended).length, 0); extended = fields; }
      continue;
    }
    const path = extended.path ?? (prefix ? `${prefix}/${name}` : name); extended = {};
    assert.equal(string(header.subarray(157, 257)), "", "archive link rejected");
    if (type === 53) {
      assert.ok(path.endsWith("/")); const dir = safePath(path.slice(0, -1));
      assert.ok(length === 0 && !directories.has(dir) && Object.keys(expected).some((p) => p.startsWith(dir + "/"))); directories.add(dir);
    } else {
      assert.ok(type === 0 || type === 48, "archive link/special file rejected"); safePath(path);
      assert.ok(Object.hasOwn(expected, path) && !seen.has(path), "unexpected/duplicate archive entry"); seen.add(path);
      equal(sha256(data), sha256(expected[path]));
    }
  }
  throw new Error("archive terminator missing");
}

function nativeObservation(value, request, missing = () => {}, readSource) {
  assert.ok(outcomes.includes(value.row.outcome));
  equal(value.row.request, request); equal([value.evidence.requestId, value.evidence.source], [request.id, request.source]);
  assert.ok(Array.isArray(value.evidence.gaps) && value.evidence.gaps.every((v) => gaps.has(v)));
  const stages = value.evidence.stages; assert.ok(Array.isArray(stages));
  for (const stage of stages) {
    assert.ok(["form-discovery", "primary", "native-redirect", "state-before", "state-after", "state-readback"].includes(stage.stage)
      && Number.isFinite(stage.elapsedMs) && stage.elapsedMs >= 0);
    assert.ok(Number.isInteger(stage.status) && stage.status >= 0 && stage.status <= 599);
    if (stage.decodedBodyBytes === undefined || stage.decodedBodySha256 === undefined) missing("native-response-body-proof-missing");
    if (stage.decodedBodyBytes !== undefined) assert.ok(Number.isSafeInteger(stage.decodedBodyBytes) && stage.decodedBodyBytes >= 0);
    if (stage.decodedBodySha256 !== undefined) {
      assert.match(stage.decodedBodySha256, /^(?!0{64}$)[a-f0-9]{64}$/);
      if (stage.decodedBodyBytes === 0) equal(stage.decodedBodySha256, sha256(Buffer.alloc(0)));
      if (stage.decodedBodyBytes > 0) assert.notEqual(stage.decodedBodySha256, sha256(Buffer.alloc(0)));
    }
  }
  const primaries = stages.filter((s) => s.stage === "primary");
  assert.ok(primaries.length <= 1);
  const unsent = ["dropped", "not-run", "unsupported"].includes(value.row.outcome);
  if (!unsent) {
    assert.equal(primaries.length, 1, "actual primary receipt required");
    const p = primaries[0];
    equal([p.status, p.contentType, p.contentEncoding, p.error], [value.row.status, value.row.contentType, value.row.contentEncoding, value.row.error]);
    equal(upstreamEvidence(value.evidence.upstream, request), value.row.upstream);
  } else {
    assert.equal(primaries.length, 0, "attempted operation relabeled unsent");
    equal(value.row.status, 0);
    for (const key of ["error", "contentType", "contentEncoding", "upstream", "page", "record", "form", "state"]) equal(value.row[key], null);
  }
  if (value.row.state) for (const stage of ["state-before", "state-after", "state-readback"]) {
    const observed = stages.filter((s) => s.stage === stage);
    assert.equal(observed.length, 1); equal([observed[0].status, observed[0].contentType], [200, "application/json"]);
    if (observed[0].decodedBodyBytes !== undefined) assert.ok(observed[0].decodedBodyBytes > 0, "state from empty response");
  }
  if (value.row.page) {
    const dom = value.evidence.redactedNativeDOM;
    if (dom === undefined) missing("native-dom-proof-missing");
    else assert.ok(typeof dom === "string" && dom.startsWith("<!DOCTYPE html>") && /<html(?:\s|>)/i.test(dom)
      && /<body(?:\s|>)/i.test(dom), "invalid native DOM receipt");
    const visible = stages.filter((s) => ["primary", "native-redirect"].includes(s.stage)).at(-1);
    assert.ok(visible && visible.contentType === "text/html");
    if (visible.decodedBodyBytes !== undefined) assert.ok(visible.decodedBodyBytes > 0, "page from empty response");
  }
  if (value.row.record && primaries[0]?.decodedBodyBytes !== undefined) assert.ok(primaries[0].decodedBodyBytes > 0, "record from empty response");
  if (value.evidence.responseSchema === undefined) {
    if (value.row.page || value.row.record || value.row.state) missing("v1-response-normalization-not-proven");
  } else {
    equal(value.evidence.responseSchema, "mixed-native-response-source/v1");
    if (!replayResponseEvidence(value, request, readSource)) missing("native-response-source-missing-or-filter-blocked");
  }
  if (value.operation !== undefined) {
    const op = value.operation;
    equal([op.requestId, op.category, op.locale, op.variant, op.client, op.outcome, op.status],
      [request.id, request.category, request.locale, request.variant, request.client, value.row.outcome, value.row.status]);
    assert.ok([op.startedMs, op.finishedMs, op.journeyMs].every((n) => Number.isFinite(n) && n >= 0));
    assert.ok(op.finishedMs >= op.startedMs && Math.abs(op.finishedMs - op.startedMs - op.journeyMs) < 0.01);
    if (unsent) equal([op.primaryStartedMs, op.primaryMs], [null, null]);
    else {
      assert.ok(Number.isFinite(op.primaryStartedMs) && Number.isFinite(op.primaryMs) && op.primaryMs >= 0
        && op.primaryStartedMs >= op.startedMs && op.primaryStartedMs <= op.finishedMs);
      // All three clocks come from the same monotonic worker clock. Allow only
      // floating-point subtraction roundoff, not elapsed work in a zero span.
      const span = op.finishedMs - op.primaryStartedMs;
      const roundoff = Number.EPSILON * Math.max(1, op.finishedMs, op.primaryStartedMs) * 4;
      assert.ok((op.primaryMs === 0 || span > 0) && op.primaryMs <= span + roundoff, "primary latency exceeds its clock span");
      equal(op.primaryMs, primaries[0].elapsedMs);
    }
    // The native transport awaits every HTTP step serially within an operation.
    // Retained durations must fit real clock spans; do not invent step timestamps.
    const fits = (steps, start, end) => {
      const elapsed = steps.reduce((total, step) => total + step.elapsedMs, 0), span = end - start;
      const roundoff = Number.EPSILON * Math.max(1, start, end) * (steps.length + 4);
      assert.ok((elapsed === 0 || span > 0) && elapsed <= span + roundoff, "HTTP work exceeds its monotonic lifetime");
    };
    fits(stages, op.startedMs, op.finishedMs);
    if (!unsent) {
      const primary = stages.indexOf(primaries[0]), before = stages.slice(0, primary), after = stages.slice(primary);
      assert.ok(before.every((s) => ["form-discovery", "state-before"].includes(s.stage))
        && after.slice(1).every((s) => ["native-redirect", "state-after", "state-readback"].includes(s.stage)), "HTTP step crosses primary boundary");
      fits(before, op.startedMs, op.primaryStartedMs); fits(after, op.primaryStartedMs, op.finishedMs);
    }
    equal(op.nativeHttpResponses, stages.filter((s) => s.status > 0).length);
  }
  return value;
}

function participants(raw, summary, app, source, cpus, missing = () => {}) {
  const ids = new Set();
  for (const role of roles) {
    const before = raw.participantsBefore[role], after = raw.participantsAfter[role], cpu = cpus[role === "upstream" ? "api" : role];
    assert.match(before.id, /^[a-f0-9]{64}$/); assert.ok(!ids.has(before.id)); ids.add(before.id);
    const image = role === "app" ? summary.apps[app].image.id : role === "upstream" ? summary.tools.nodeImage : summary.tools.browserImage;
    for (const [p, paused] of [[before, false], [after, role === "app"]]) {
      equal([p.role, p.imageId], [role, image]); equal([p.state.Running, p.state.OOMKilled, p.state.Paused], [true, false, paused]);
      assert.ok(Number.isSafeInteger(raw.window.startedUnixMs) && typeof p.startedAt === "string"
        && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(p.startedAt) && Number.isFinite(Date.parse(p.startedAt))
        && Date.parse(p.startedAt) <= raw.window.startedUnixMs && p.startedAt === p.state.StartedAt, "participant started after observation began");
      if (p.state.ExitCode === undefined) missing("participant-exit-proof-not-retained");
      else equal(p.state.ExitCode, 0);
      equal([p.config.nanoCpus, p.config.cpuset], [cpu.quota * 1e9, cpu.cpuset ?? ""]);
      equal(p.config.memory, role === "upstream" ? 512 * 1024 ** 2 : role === "load" ? 2 * 1024 ** 3 : 1024 ** 3);
      assert.ok(Array.isArray(p.config.env) && p.config.env.every((e) => typeof e === "string"));
      assert.equal(new Set(p.config.env.map((e) => e.split("=", 1)[0])).size, p.config.env.length);
      assert.ok(!p.config.env.some((e) => e.startsWith("MIXED_CONTROL_TOKEN=")));
    }
    equal([after.id, after.startedAt, after.config], [before.id, before.startedAt, before.config]);
    if (role === "app") {
      assert.ok(before.config.env.includes(`MARKETPLACE_SOURCE=${source}`));
      assert.ok(before.config.env.includes(`PROFILE=${summary.options.profile === "matched" ? "matched" : ""}`));
    }
  }
  keys(raw.participantsBefore, roles); keys(raw.participantsAfter, roles);
  equal(raw.participantsBefore.load.config.networkMode, `container:${raw.participantsBefore.app.id}`);
}

function qualificationOutcome(slot) {
  if (slot === null || slot === undefined) return "not-run";
  assert.ok(typeof slot === "object" && !Array.isArray(slot));
  assert.equal(typeof slot.eligible, "boolean");
  if (slot.artifact === undefined) {
    keys(slot, ["eligible", "failure"]);
    equal([slot.eligible, slot.failure], [false, "native-qualification-execution-failed"]);
  } else {
    assert.ok(slot.artifact && typeof slot.artifact === "object" && !Array.isArray(slot.artifact));
    keys(slot.artifact, ["path", "sha256"]); safePath(slot.artifact.path);
    assert.match(slot.artifact.sha256, /^[a-f0-9]{64}$/);
    assert.ok(slot.failure === null || slot.failure === "native-production-qualification-failed");
    if (slot.failure !== null) equal(slot.eligible, false);
    assert.ok(Array.isArray(slot.missing) && new Set(slot.missing).size === slot.missing.length && slot.missing.every((k) => typeof k === "string"));
    if (slot.eligible) equal(slot.missing, []);
    assert.ok(Object.keys(slot).every((k) => ["eligible", "failure", "missing", "artifact", "participants", "readiness"].includes(k)));
  }
  return slot.eligible ? "reported-eligible" : "reported-failed";
}

function qualificationParticipants(value, summary, app, source, cpus, missing) {
  if (value === undefined) { missing(); return; }
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.ok(Object.keys(value).every((role) => ["app", "upstream"].includes(role)));
  const ids = new Set(), fact = (actual, expected) => actual === undefined ? missing() : equal(actual, expected);
  for (const role of ["app", "upstream"]) {
    const p = value[role], cpu = cpus[role === "app" ? "app" : "api"];
    if (p === undefined) { missing(); continue; }
    assert.ok(p && typeof p === "object" && !Array.isArray(p));
    fact(p.role, role); fact(p.imageId, role === "app" ? summary.apps[app].image.id : summary.tools.nodeImage);
    if (p.id === undefined) missing();
    else { assert.match(p.id, /^[a-f0-9]{64}$/); assert.ok(!ids.has(p.id)); ids.add(p.id); }
    for (const stamp of [p.startedAt, p.state?.StartedAt]) {
      if (stamp === undefined) missing();
      else assert.ok(typeof stamp === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(stamp) && Number.isFinite(Date.parse(stamp)));
    }
    if (p.startedAt !== undefined && p.state?.StartedAt !== undefined) equal(p.startedAt, p.state.StartedAt);
    if (p.state === undefined) missing();
    else {
      assert.ok(p.state && typeof p.state === "object" && !Array.isArray(p.state));
      for (const [key, expected] of [["Running", true], ["Paused", false], ["OOMKilled", false], ["ExitCode", 0]]) fact(p.state[key], expected);
      if (p.state.Status !== undefined) equal(p.state.Status, "running");
      if (p.state.Dead !== undefined) equal(p.state.Dead, false);
      if (p.state.Error !== undefined) equal(p.state.Error, "");
    }
    if (p.restartCount !== undefined) equal(p.restartCount, 0);
    if (p.config === undefined) { missing(); continue; }
    assert.ok(p.config && typeof p.config === "object" && !Array.isArray(p.config));
    fact(p.config.nanoCpus, cpu.quota * 1e9); fact(p.config.cpuset, cpu.cpuset ?? "");
    fact(p.config.memory, role === "app" ? 1024 ** 3 : 512 * 1024 ** 2);
    if (p.config.env === undefined) missing();
    else {
      assert.ok(Array.isArray(p.config.env) && p.config.env.every((e) => typeof e === "string"));
      assert.equal(new Set(p.config.env.map((e) => e.split("=", 1)[0])).size, p.config.env.length);
      assert.ok(!p.config.env.some((e) => e.startsWith("MIXED_CONTROL_TOKEN=")));
      if (role === "app") {
        assert.ok(p.config.env.includes(`MARKETPLACE_SOURCE=${source}`));
        assert.ok(p.config.env.includes(`PROFILE=${summary.options.profile === "matched" ? "matched" : ""}`));
      }
    }
  }
}

function validateWindowSlot(slot, stage, pass) {
  if (slot === null || slot === undefined) return;
  assert.ok(typeof slot === "object" && !Array.isArray(slot));
  const passKeys = stage === "steady" ? ["pass"] : [];
  if (stage === "steady") equal(slot.pass, pass);
  if (["not-run", "failed"].includes(slot.outcome)) {
    keys(slot, [...passKeys, "outcome", "metrics"]); equal(slot.metrics, null);
  } else {
    assert.ok(["measured", "calibration-or-window-rejected"].includes(slot.outcome));
    keys(slot, [...passKeys, "outcome", "metrics", "stats", "artifact"]);
    assert.ok(slot.artifact && typeof slot.artifact === "object" && !Array.isArray(slot.artifact));
    keys(slot.artifact, ["path", "sha256"]); safePath(slot.artifact.path); assert.match(slot.artifact.sha256, /^[a-f0-9]{64}$/);
    assert.ok(slot.metrics && typeof slot.metrics === "object" && !Array.isArray(slot.metrics));
    equal(slot.metrics.eligible, slot.outcome === "measured");
    assert.ok(slot.stats && typeof slot.stats === "object" && !Array.isArray(slot.stats));
  }
}

function validateQualificationReceipt(raw, source) {
  assert.equal(typeof raw.eligible, "boolean");
  assert.ok(raw.failure === null || raw.failure === "native-production-qualification-failed");
  if (raw.failure !== null) equal(raw.eligible, false);
  const features = sourceFeatures(source), expected = features.map((f) => f.key);
  if (raw.profile !== undefined) equal(raw.profile, featureProfile);
  if (raw.cells !== undefined) {
    assert.ok(raw.cells && typeof raw.cells === "object" && !Array.isArray(raw.cells)); keys(raw.cells, expected); equal(raw.profile, featureProfile);
    for (const cell of Object.values(raw.cells)) assert.ok(typeof cell === "string" && cell.length <= 4096);
    const missing = features.filter((f) => !f.meets(raw.cells[f.key])).map((f) => f.key);
    equal(raw.missing, missing); equal(raw.eligible, raw.failure === null && missing.length === 0);
  }
  if (raw.missing !== undefined) assert.ok(Array.isArray(raw.missing) && new Set(raw.missing).size === raw.missing.length
    && raw.missing.every((key) => expected.includes(key)));
  if (raw.rawProbeSha256 !== undefined) assert.match(raw.rawProbeSha256, /^(?!0{64}$)[a-f0-9]{64}$/);
  if (raw.probes === undefined) return;
  assert.ok(raw.probes && typeof raw.probes === "object" && !Array.isArray(raw.probes));
  const hashed = Object.values(raw.probes).some((probe) => probe?.sha256 !== undefined);
  const allowed = new Set(["page", "json", "pageBr", "jsonBr", "jsonGzip", "page404", "json404", "json405", "head", "badHost", "bigHead",
    "form", "ownPost", "crossSite", "bigBody", "afterBig", "liveness", "live", "page500", "json500", "slow", "afterUpstream", "unfinishedHead", "cap", "afterConnections"]);
  for (const [key, probe] of Object.entries(raw.probes)) {
    assert.ok(allowed.has(key), "unrecognized native qualification probe");
    if (hashed) assert.ok(probe?.sha256 !== undefined, "mixed raw/hash-only qualification probes");
    if (key === "form" && typeof probe === "string") { equal(probe, "no native POST form"); continue; }
    assert.ok(probe && typeof probe === "object", "invalid native qualification probe");
    if (probe.sha256 !== undefined) {
      assert.ok(!Array.isArray(probe));
      assert.match(probe.sha256, /^(?!0{64}$)[a-f0-9]{64}$/);
      assert.ok(Object.keys(probe).every((k) => ["sha256", "status", "ms", "bodyLength", "closedMs", "timedOutMs", "timedOut", "error"].includes(k)));
      for (const name of ["ms", "bodyLength", "closedMs", "timedOutMs"]) if (probe[name] !== undefined) {
        assert.ok(Number.isFinite(probe[name]) && probe[name] >= 0);
        if (name !== "ms") assert.ok(Number.isSafeInteger(probe[name]));
      }
      if (probe.status !== undefined) assert.ok(Number.isInteger(probe.status) && probe.status >= 100 && probe.status <= 599);
      if (probe.timedOut !== undefined) equal(probe.timedOut, true);
      if (probe.error !== undefined) assert.ok(typeof probe.error === "string" && probe.error.length > 0);
      const facts = Object.keys(probe).filter((k) => k !== "sha256");
      if (key === "form" || key === "liveness") equal(facts, []);
      else if (key === "cap") assert.ok(facts.every((k) => k === "error"));
      else if (key === "unfinishedHead") {
        assert.ok(facts.length <= 1 && facts.every((k) => ["closedMs", "timedOutMs", "error"].includes(k)), "exclusive unfinished-head variant required");
      } else {
        assert.ok(probe.closedMs === undefined && probe.timedOutMs === undefined);
        const response = probe.status !== undefined, timeout = probe.timedOut !== undefined, error = probe.error !== undefined;
        assert.ok(Number(response) + Number(timeout) + Number(error) <= 1, "exclusive HTTP response/failure variant required");
        if (timeout || error) equal(probe.bodyLength, undefined);
        // Hash-only or incomplete retained facts remain unavailable proof, never
        // qualification. Present facts still cannot contradict one another.
      }
    }
  }
}

function windowReplay(fs, ref, summary, plan, records, cpus, app, source, stage, pass, missing, executionProof, bindParticipant) {
  const dir = `measurement/${app}/${source}/${stage}-${pass}`, raw = fs.artifact(ref, `${dir}/receipt.json`);
  equal([raw.schema, raw.app, raw.source, raw.stage, raw.pass, raw.planSha256, raw.imageId, raw.nativeProfile],
    ["mixed-native-window-receipt/v1", app, source, stage, pass, plan.sha256, summary.apps[app].image.id, summary.options.profile]);
  const window = fs.read(`${dir}/window.json`); equal(raw.window, window);
  if (raw.hostElapsedMs === undefined) missing("host-elapsed-proof-not-retained", `${dir}/receipt.json`);
  else assert.ok(Number.isFinite(raw.hostElapsedMs) && raw.hostElapsedMs >= window.elapsedMs && raw.hostElapsedMs >= 0, "invalid native host elapsed time");
  equal([window.app, window.source, window.seconds], [app, source, stage === "steady" ? summary.options.duration : summary.options.calibration]);
  assert.ok(window.cycles.length <= summary.options.maxCycles && window.warmup.cycles <= summary.options.maxCycles);
  equal(fs.read(`${dir}/warmup.json`), window.warmup);
  assert.ok(window.warmup.elapsedMs >= summary.options.warmup * 1000);
  const settings = fs.read(`${dir}/settings.json`);
  equal([settings.plan, settings.records, settings.app, settings.source, settings.settings, settings.seconds, settings.warmup, settings.tailSeconds, settings.maxCycles, settings.folder],
    [plan, records, app, source, summary.options, window.seconds, summary.options.warmup, summary.options.tailSeconds, summary.options.maxCycles, `/out/${dir}`]);
  equal(settings.startupObservation, raw.startupObservation);
  equal(settings.base, "http://127.0.0.1:8080");
  equal(settings.upstream, `http://${summary.runId}-${stage}-${pass}-${app}-${source}-up:8080`);
  assert.match(settings.readbackPath, /^\/(?!\/)[^?#\\\s]+$/);
  if (!summary.options.readbacks) equal(settings.readbackPath, "/api/alerts");
  equal(fs.read(`${dir}/final-upstream-ledger.json`), { admission: raw.admission, ledger: raw.finalUpstreamLedger });
  participants(raw, summary, app, source, cpus, (code) => missing(code, `${dir}/receipt.json`));
  if (summary.executionInputs) {
    for (const role of roles) {
      if (!executionProof) missing("native-window-lifecycle-binding-missing", dir);
      else if (!bindParticipant(executionProof.participants, { stage, pass, app, source, role }, raw.participantsBefore[role]))
        missing("native-window-terminal-health-not-proven", dir);
    }
    for (const phase of ["before", "after"]) {
      const boundary = fs.read(`${dir}/cpu-${phase}.json`), values = replayCpuBoundary(boundary, raw.participantsBefore, phase);
      assert.ok(phase === "before" ? boundary.receivedUnixMs <= raw.window.startedUnixMs : boundary.startedUnixMs >= raw.window.finishedUnixMs);
      for (const role of roles) {
        equal(values[role], raw.counters[role][phase]);
        const participant = fs.read(`${dir}/participant-${phase}-${role}.json`), observed = raw[phase === "before" ? "participantsBefore" : "participantsAfter"][role];
        equal([participant.schema, participant.role, participant.id, participant.imageId, participant.startedAt, participant.restartCount, participant.running, participant.oomKilled, participant.paused],
          ["mixed-native-participant-boundary/v1", role, observed.id, observed.imageId, observed.startedAt, 0, observed.state.Running, observed.state.OOMKilled, observed.state.Paused]);
      }
    }
  }
  const selected = plan.requests.filter((r) => r.source === source), expectedArtifacts = [];
  const phases = (phase, count, refs) => {
    assert.equal(refs.length, count);
    return Array.from({ length: count }, (_, index) => {
      const sub = `${dir}/${phase}_${index}`, saved = fs.artifact(refs[index], `${sub}/capture.json`), rebuilt = emptyCapture(plan, app);
      const observations = selected.map((request) => {
        const path = `${sub}/${request.id}.json`, value = nativeObservation(fs.read(path), request, (code) => missing(code, path), fs.artifact);
        assert.equal(value.incomplete, false); rebuilt.results[request.index] = value.row;
        if (phase === "cycle") expectedArtifacts.push({ path, sha256: sha256(fs.body(path)) }); return value;
      });
      equal(saved.capture, rebuilt);
      equal(saved.oracle, oracle(plan, rebuilt, records));
      assert.ok(saved.oracle.valid && saved.passed && observations.every((o) => o.evidence.gaps.length === 0));
      return { ...saved, observations };
    });
  };
  const warmups = phases("warmup", window.warmup.cycles, raw.warmupCaptures), captures = phases("cycle", window.cycles.length, raw.cycleCaptures);
  // Each phase has one monotonic epoch. The native worker awaits every complete
  // cycle, and loadCycle awaits each client's preceding request within a cycle.
  for (const [list, elapsed] of [[warmups, window.warmup.elapsedMs], [captures, window.elapsedMs]]) {
    assert.ok(Number.isFinite(elapsed) && elapsed >= 0, "invalid phase lifetime");
    let previousCycleEnd = 0;
    for (const capture of list) {
      const ops = new Map(capture.observations.map((o) => [o.row.request.id, o.operation]));
      const clients = new Map(); let cycleEnd = previousCycleEnd;
      for (const request of selected) {
        const op = ops.get(request.id); assert.ok(op, "operation clock receipt missing");
        assert.ok(op.startedMs >= previousCycleEnd && op.finishedMs <= elapsed, "serial cycle clocks overlap or escape their phase");
        assert.ok(op.startedMs >= (clients.get(request.client) ?? 0), "client requests overlap or reverse native order");
        clients.set(request.client, op.finishedMs); cycleEnd = Math.max(cycleEnd, op.finishedMs);
      }
      previousCycleEnd = cycleEnd;
    }
  }
  equal(raw.requestArtifacts, expectedArtifacts);
  const manifest = upstreamManifest(plan, source, raw.startupObservation,
    [...warmups.map((c, i) => upstreamPhase("warmup", i, c.capture, source)), ...captures.map((c, i) => upstreamPhase("cycle", i, c.capture, source))]);
  equal(raw.upstreamReconciliation, reconcileLedger(raw.finalUpstreamLedger, manifest));
  const workerLedger = fs.read(`${dir}/upstream-ledger.json`);
  equal(window.upstreamReconciliation, reconcileLedger(workerLedger, manifest)); assert.ok(window.upstreamReconciliation.valid);
  const boundaries = fs.read(`${dir}/resource-boundaries.json`); equal(boundaries, raw.resourceBoundaries);
  const stream = fs.read(`${dir}/stats.log.json`), names = Object.keys(stream.samples); assert.equal(names.length, 3);
  if (summary.executionInputs) replayStatsClient(fs.read(`${dir}/stats.log.process.json`), names, fs.digest(`${dir}/stats.log`), window);
  const rows = fs.body(`${dir}/stats.log`).toString("utf8").trim().split(/\r?\n/).filter(Boolean).map(json);
  const sampled = {}, stats = {};
  for (const role of roles) {
    const name = names.find((n) => n === `${summary.runId}-${stage}-${pass}-${app}-${source}${role === "app" ? "" : role === "upstream" ? "-up" : "-worker"}`);
    assert.ok(name);
    const actual = rows.filter((r) => r.Name === name).map((r) => ({ cpu: parseFloat(r.CPUPerc), mem: memoryMiB(r.MemUsage.split("/")[0]) }));
    equal(actual, stream.samples[name].map(({ cpu, mem }) => ({ cpu, mem })));
    stats[name] = summarizeSamples(stream.samples[name]);
    const parsed = [];
    for (const side of ["before", "after"]) {
      const boundary = boundaries[side]; equal(fs.read(`${dir}/resource-${side}.json`), { startedUnixMs: boundary.startedUnixMs, receivedUnixMs: boundary.receivedUnixMs, raw: boundary.raw });
      assert.ok(Number.isSafeInteger(boundary.startedUnixMs) && boundary.receivedUnixMs >= boundary.startedUnixMs);
      const data = boundary.raw.trim().split(/\r?\n/).map(json); equal(data.map((r) => r.Name).sort(), [...names].sort());
      const expected = Object.fromEntries(data.map((r) => [r.Name, [{ t: boundary.receivedUnixMs, cpu: parseFloat(r.CPUPerc), mem: memoryMiB(r.MemUsage.split("/")[0]) }]]));
      equal(boundary.samples, expected); parsed.push(expected[name]);
    }
    sampled[role] = mergeResourceSamples(parsed[0], stream.samples[name], parsed[1]);
  }
  assert.ok(rows.every((r) => names.includes(r.Name))); equal(stream.summary, stats); equal(raw.samples, sampled);
  const metrics = deriveWindow({ ...raw, captures, warmups, plan, records,
    quotas: Object.fromEntries(Object.entries(cpus).map(([role, cpu]) => [role === "api" ? "upstream" : role, observedCpuCeiling(cpu)])) });
  return { metrics, stats };
}

/** Read-only verifier. commit is the full native source AND harness commit, never a ref. */
export async function validateSaved({ folder, round, commit } = {}) {
  const result = { schema: "mixed-native-saved-verification/v1", verdict: "blocked", round: null, commit: null, complete: false,
    functionalPassed: false, comparisonEligible: false, attemptComplete: false, dispositions: null, issues: [], apps: {}, measurement: null, limits,
    proof: { schema: "mixed-native-saved-proof/v1", resources: "blocked", sources: "blocked", sourceFiles: [], cleanupComplete: false, blockers: [] } };
  const issue = (kind, code, at) => result.issues.push({ kind, code, at });
  const attempt = (at, fn) => { try { return fn(); } catch { issue("failed", "invalid-or-missing-evidence", at); return undefined; } };
  let fs, executionProof, inputFiles, bindParticipant, workerCompleted, nativeSourceProof = true, measureRequested = false, functionalGateRejected = false, completeComparison = false, functionalHealthPassed = true;
  let checkpoint = "arguments";
  try {
    assert.ok(typeof round === "string" && round.length <= 32 && /^w[1-9]\d*$/.test(round));
    assert.ok(typeof commit === "string" && /^[a-f0-9]{40}$/.test(commit));
    result.round = round; result.commit = commit;
    fs = savedFolder(folder);
    checkpoint = "identity";
    const summary = fs.read("summary.json"), records = fs.read("marketplace.json"), plan = fs.read("plan.json"), inventory = selectedApps("mixed-production");
    equal([summary.schema, summary.group, summary.round], ["mixed-native-run/v1", "mixed-production", round]);
    equal(summary.inventory, inventory); keys(summary.apps, inventory); equal(summary.definition, definition("mixed-production"));
    equal(summary.contractSha256, contractSha256("mixed-production")); equal(summary.retainedFamilies, retainedFamilies);
    const options = summary.options;
    measureRequested = options.measure;
    checkpoint = "configuration";
    keys(options, ["round", "apps", "images", "readbacks", "nativeAudits", "build", "buildRef", "seed", "clients", "repetitions", "measure", "profile", "passes", "duration", "warmup", "calibration", "tailSeconds", "maxCycles", "requestTimeoutMs", "completeDelayMs", "slowDelayMs", "cancelAfterMs", "cleanupMs", "startupTimeoutMs"]);
    equal(options.round, round); assert.ok(["matched", "defaults"].includes(options.profile));
    assert.ok(typeof options.build === "boolean" && typeof options.measure === "boolean");
    assert.match(summary.runId, new RegExp(`^mixed-${round}-[a-f0-9]{8}$`));
    for (const key of ["requestTimeoutMs", "completeDelayMs", "slowDelayMs", "cancelAfterMs", "cleanupMs", "startupTimeoutMs"])
      assert.ok(Number.isSafeInteger(options[key]) && options[key] >= 1 && options[key] <= (key === "cleanupMs" ? 10000 : 120000));
    assert.ok(options.slowDelayMs > options.cancelAfterMs && options.completeDelayMs < options.requestTimeoutMs);
    assert.ok(Number.isSafeInteger(options.clients) && options.clients >= 1 && options.clients <= 32);
    assert.ok(Number.isSafeInteger(options.repetitions) && options.repetitions >= 1 && options.repetitions <= 10);
    assert.ok(Array.isArray(options.apps) && new Set(options.apps).size === options.apps.length && options.apps.every((a) => inventory.includes(a)));
    for (const [key, max] of [["passes", 5], ["duration", 300], ["warmup", 120], ["calibration", 120], ["maxCycles", 128], ["tailSeconds", 120]])
      assert.ok(Number.isSafeInteger(options[key]) && options[key] >= 1 && options[key] <= max);
    checkpoint = "fixture-plan";
    equal(records, fixtureRecords()); equal(sha256(fs.body("marketplace.json")), summary.provenance.fixtureSha256);
    equal(plan, createPlan({ seed: options.seed, clients: options.clients, repetitions: options.repetitions, records }));
    equal(summary.provenance.commit, commit); equal(summary.provenance.dirty, "");
    equal(summary.provenance.nativeSource.commit, commit); equal(summary.provenance.nativeSource.dirty, false);
    checkpoint = "committed-source";
    const tracked = committedFiles(commit), here = "bench/mixed-production/";
    checkpoint = "replay-source";
    for (const path of replayFiles) {
      assert.ok(Buffer.isBuffer(tracked[path]), "replay dependency missing from commit");
      equal(sha256(readFileSync(join(repo, path), "utf8").replaceAll("\r\n", "\n")), sha256(tracked[path].toString("utf8").replaceAll("\r\n", "\n")));
    }
    checkpoint = "harness-source";
    for (const field of ["harnessFiles", "sharedFiles", ...(summary.timing ? ["measurementHarnessFiles"] : [])]) {
      const expected = field === "harnessFiles" ? ["build-context.mjs", "capture.mjs", "native.mjs", "snapshot.mjs", "source-audit.mjs", "upstream.mjs", "worker.mjs", "run.mjs"]
        : field === "measurementHarnessFiles" ? ["measure.mjs", "metrics.mjs", "load-capture.mjs", "load-worker.mjs", "load-upstream.mjs", "upstream-ledger.mjs", "resources.mjs", "source-audit.mjs", "qualify-worker.mjs"]
          : ["bench/workloads/mixed.mjs", "bench/workloads/registry.mjs", "bench/json-api/contract.mjs", "bench/marketplace/check.mjs", "bench/marketplace/records.mjs", "bench/marketplace/labels.json"];
      keys(summary.provenance[field], expected);
      for (const file of expected) {
        const path = field === "sharedFiles" ? file : here + file;
        const lf = tracked[path], crlf = Buffer.from(lf.toString("utf8").replace(/\r?\n/g, "\r\n"));
        assert.ok([sha256(lf), sha256(crlf)].includes(summary.provenance[field][file]));
        equal(sha256(readFileSync(join(repo, path), "utf8").replaceAll("\r\n", "\n")), sha256(lf.toString("utf8").replaceAll("\r\n", "\n")));
      }
    }
    if (options.build) {
      checkpoint = "source-archive";
      equal(summary.provenance.nativeSource.kind, "git-archive");
      equal(summary.provenance.nativeSource.tree, git(["rev-parse", `${commit}^{tree}`]).toString().trim());
      const archive = sha256(git(["archive", "--format=tar", commit]));
      equal(summary.provenance.nativeSource.archiveSha256, archive); equal(fs.digest("build-source.tar"), archive);
      equal([...fs.files.keys()].filter((p) => p.startsWith("build-source/")).map((p) => p.slice(13)).sort(), Object.keys(tracked).sort());
      for (const [path, body] of Object.entries(tracked)) equal(fs.digest(`build-source/${path}`), sha256(body));
    } else issue("blocked", "fresh-native-build-not-proven", "provenance");
    if (summary.executionEvidence !== undefined) {
      checkpoint = "native-execution-source";
      const manifest = fs.artifact(summary.executionEvidence, "execution/manifest.json");
      const files = ["bench/mixed-production/execution-evidence.mjs", "bench/mixed-production/execution-inputs.mjs", "bench/mixed-production/immutable-git.mjs"];
      keys(manifest.producerFiles, files);
      for (const path of files) {
        assert.ok(Buffer.isBuffer(tracked[path]), "execution producer absent from requested commit");
        const lf = tracked[path], crlf = Buffer.from(lf.toString("utf8").replace(/\r?\n/g, "\r\n"));
        assert.ok([sha256(lf), sha256(crlf)].includes(manifest.producerFiles[path]));
        equal(readFileSync(join(repo, path), "utf8").replaceAll("\r\n", "\n"), lf.toString("utf8").replaceAll("\r\n", "\n"));
      }
      // Import only after checking the complete built-in-only replay module.
      const { replayExecution, bindExecutionParticipant, executionWorkerCompleted } = await import("./execution-evidence.mjs");
      bindParticipant = bindExecutionParticipant; workerCompleted = executionWorkerCompleted;
      executionProof = attempt("native-execution", () => replayExecution({ manifest, summary, read: fs.artifact }));
      if (executionProof) {
        for (const code of executionProof.blockers) issue("blocked", code, "execution");
        attempt("native-execution-coverage", () => {
          const actual = new Map(executionProof.participants.map((p) => [p.name, p]));
          assert.equal(actual.size, executionProof.participants.length);
          for (const app of inventory) for (const source of sources) {
            if (!summary.apps[app].sources[source]?.complete) continue;
            const base = `${summary.runId}-${app}-${source}`;
            for (const name of [base, `${base}-upstream`, `${base}-capture`]) {
              if (!actual.has(name)) issue("blocked", "functional-process-limits-not-retained", `${app}/${source}`);
            }
            if (summary.executionInputs && actual.has(`${base}-capture`) && actual.has(`${base}-upstream`)) {
              if (!workerCompleted(executionProof.participants, { stage: "functional", pass: null, app, source, role: "capture" }, 0))
                issue("blocked", "native-functional-worker-not-completed", `${app}/${source}`);
              const upstream = actual.get(`${base}-upstream`);
              if (!bindParticipant(executionProof.participants, { stage: "functional", pass: null, app, source, role: "upstream" },
                { id: upstream.id, imageId: upstream.imageId, startedAt: upstream.state.StartedAt })) issue("blocked", "native-functional-injector-unhealthy", `${app}/${source}`);
            }
            const cell = summary.timing?.cells?.[app]?.[source], bases = [];
            if (cell?.qualification?.artifact) bases.push(`${summary.runId}-q-${app}-${source}`);
            if (cell?.calibration?.artifact) bases.push(`${summary.runId}-calibration-0-${app}-${source}`);
            for (const slot of cell?.passes ?? []) if (slot?.artifact) bases.push(`${summary.runId}-steady-${slot.pass}-${app}-${source}`);
            for (const stage of bases) for (const name of [stage, `${stage}-up`, `${stage}-worker`])
              if (!actual.has(name)) issue("blocked", "measurement-process-limits-not-retained", `${app}/${source}`);
            if ((cell?.calibration?.artifact || cell?.passes?.some((p) => p?.artifact)) && !actual.has(`${summary.runId}-measurement-cpu`))
              issue("blocked", "measurement-process-limits-not-retained", "cpu-reader");
          }
        });
      }
      if (summary.executionInputs) inputFiles = attempt("native-execution-inputs", () => {
        const receipt = fs.artifact(summary.executionInputs, "execution/inputs.json"); equal(receipt.mounts, summary.executionMounts);
        return replayExecutionInputs({ receipt, fs, tracked, commit });
      });
      else issue("blocked", "native-execution-input-snapshot-not-retained", "execution");
    } else issue("blocked", "native-execution-evidence-not-retained", "execution");
    if (summary.executionInputs) {
      const lock = JSON.parse(tracked["package-lock.json"]);
      equal(summary.tools.playwright, lock.packages["node_modules/@playwright/test"].version);
      if (summary.sourceAudits !== undefined) keys(summary.sourceAudits, Object.keys(summary.sourceAudits).filter((app) => inventory.includes(app)));
    }
    checkpoint = "functional";
    let functionalProof = true;
    const missingProof = (code, at) => { functionalProof = false; issue("blocked", code, at); };
    if (options.images || options.readbacks) issue("blocked", "external-configuration-map-not-retained", "configuration");
    for (const app of inventory) {
      const entry = summary.apps[app], output = result.apps[app] = { cells: [], oracle: null, sourceAudit: null, execution: {} };
      equal(entry.selected, options.apps.includes(app));
      attempt(`${app}/source`, () => {
        const prefix = buildInputPaths(app)[0], paths = Object.keys(tracked).filter((p) => prefix === "." || p.startsWith(prefix + "/")).sort();
        const sourceFiles = paths.map((path) => ({ path, sha256: sha256(tracked[path]) }));
        equal(entry.buildInputs, sourceFiles);
        const image = entry.image; assert.match(image.id, /^sha256:[a-f0-9]{64}$/);
        equal([image.buildCommit, image.buildDirty, image.profile], [commit, "false", options.profile]);
        if (options.build) {
          const hash = fs.digest(`${app}-build-context.tar`);
          equal([entry.contextArchiveSha256, image.contextArchiveSha256, fs.digest(`${app}-build-context.tar`)], [hash, hash, hash]);
          archiveFiles(fs.body(`${app}-build-context.tar`), Object.fromEntries(paths.map((p) => [app === "corten" ? p : p.slice(prefix.length + 1), tracked[p]])));
          equal([...fs.files.keys()].filter((p) => p.startsWith(`${app}-build-context/`)).map((p) => p.slice(`${app}-build-context/`.length)).sort(),
            paths.map((p) => app === "corten" ? p : p.slice(prefix.length + 1)).sort());
          for (const path of paths) {
            equal(fs.digest(`build-source/${path}`), sha256(tracked[path]));
            equal(fs.digest(`${app}-build-context/${app === "corten" ? path : path.slice(prefix.length + 1)}`), sha256(tracked[path]));
          }
        }
        const audit = summary.sourceAudits?.[app] ?? summary.timing?.sourceAudits?.[app];
        if (summary.sourceAudits?.[app] !== undefined) {
          if (audit?.artifact) { keys(audit, ["eligible", "artifact", "failure"]); equal([audit.eligible, audit.failure], [true, null]); }
          else { keys(audit, ["eligible", "failure"]); equal([audit.eligible, audit.failure], [false, "missing-or-invalid-independent-native-source-audit"]); }
        }
        if (audit?.artifact) {
          const saved = fs.artifact(audit.artifact, summary.sourceAudits ? `source-audits/${app}.json` : `measurement/${app}-source-audit.json`);
          const verified = verifySourceAudit(saved.receipt, sourceAuditIdentity(summary, app), { files: Object.fromEntries(paths.map((p) => [p, tracked[p]])), sourceFiles }, image);
          equal(saved, { ...verified, receipt: saved.receipt }); output.sourceAudit = verified;
          equal(audit.eligible, true);
          if (summary.sourceAudits && summary.timing?.sourceAudits?.[app]?.artifact)
            equal(fs.artifact(summary.timing.sourceAudits[app].artifact, `measurement/${app}-source-audit.json`), saved);
        } else if (summary.timing || summary.executionInputs) issue("blocked", "independent-native-source-audit-missing", app);
      });
      const parts = [], checks = new Map();
      keys(entry.sources, Object.keys(entry.sources).filter((s) => sources.includes(s)));
      for (const source of sources) {
        const capture = emptyCapture(plan, app), selected = plan.requests.filter((r) => r.source === source);
        let executionProven = false;
        if (!entry.sources[source]?.container) missingProof("functional-executed-container-not-retained", `${app}/${source}`);
        else executionProven = attempt(`${app}/${source}/execution`, () => {
          const container = entry.sources[source].container;
          assert.ok(container && typeof container === "object" && !Array.isArray(container));
          if (summary.executionInputs && executionProof) {
            const observed = executionProof.participants.find((p) => p.name === `${summary.runId}-${app}-${source}`);
            if (!observed) { missingProof("functional-executed-container-not-retained", `${app}/${source}`); return false; }
            equal([container.imageId, container.startedAt, container.running, container.exitCode, container.oomKilled],
              [observed.imageId, observed.state.StartedAt, observed.state.Running, observed.state.ExitCode, observed.state.OOMKilled]);
            if (container.restartCount === undefined) { missingProof("functional-restart-proof-not-retained", `${app}/${source}`); return false; }
            equal(container.restartCount, observed.restartCount);
            const healthy = observed.state.Running && observed.state.ExitCode === 0 && !observed.state.OOMKilled && observed.restartCount === 0
              && !observed.state.Paused && !observed.state.Restarting && !observed.state.Dead;
            output.execution[source] = { id: observed.id, imageId: observed.imageId, restartCount: observed.restartCount, state: observed.state, healthy };
            if (!healthy) functionalHealthPassed = false;
            return true;
          }
          let complete = true;
          for (const [key, expected] of [["imageId", entry.image.id], ["running", true], ["exitCode", 0], ["oomKilled", false]]) {
            if (container[key] === undefined) complete = false; else equal(container[key], expected);
          }
          if (container.startedAt === undefined) complete = false;
          else assert.ok(typeof container.startedAt === "string" && Number.isFinite(Date.parse(container.startedAt)));
          if (!complete) missingProof("functional-executed-container-not-retained", `${app}/${source}`);
          return complete;
        }) === true;
        attempt(`${app}/${source}/request-inventory`, () => {
          const actual = [...fs.files.keys()].filter((p) => p.startsWith(`${app}/${source}/request_`) && p.endsWith(".json"));
          equal(actual.sort(), selected.map((r) => `${app}/${source}/${r.id}.json`).filter((p) => fs.has(p)).sort());
        });
        for (const request of selected) {
          const path = `${app}/${source}/${request.id}.json`;
          const cell = { requestId: request.id, source, outcome: "not-run", status: 0, passed: false, reasons: [] };
          output.cells.push(cell);
          if (!fs.has(path)) { cell.reasons.push("raw-request-artifact-missing"); issue("blocked", "raw-request-artifact-missing", path); continue; }
          const raw = attempt(path, () => fs.read(path));
          if (raw?.evidence?.responseSchema !== "mixed-native-response-source/v1") nativeSourceProof = false;
          if (["not-run", "dropped"].includes(raw?.row?.outcome) || !raw?.evidence?.stages?.length
            || raw?.evidence?.gaps?.some((gap) => ["preparation-or-injector-failed", "capture-failed-after-primary-start"].includes(gap))) nativeSourceProof = false;
          if (raw?.row?.request?.id === request.id) Object.assign(cell, { outcome: outcomes.includes(raw.row.outcome) ? raw.row.outcome : "invalid-outcome",
            status: Number.isInteger(raw.row.status) && raw.row.status >= 0 && raw.row.status <= 599 ? raw.row.status : 0 });
          const proofReasons = [];
          const observed = raw && attempt(path, () => nativeObservation(raw, request, (code) => {
            proofReasons.push(code); missingProof(code, path);
          }, fs.artifact));
          if (observed) { capture.results[request.index] = observed.row; Object.assign(cell, { outcome: observed.row.outcome, status: observed.row.status, reasons: [...observed.evidence.gaps] }); }
          else cell.reasons.push("raw-request-evidence-invalid");
          cell.reasons.push(...proofReasons);
          if (!executionProven) cell.reasons.push("functional-execution-not-proven");
          if (output.execution[source]?.healthy === false) cell.reasons.push("native-functional-participant-unhealthy");
        }
        parts.push({ source, capture });
        const sourceOracle = oracle(plan, capture, records);
        const allPassed = sourceOracle.valid && selected.every((r) => capture.results[r.index].outcome === expectedOutcome(r));
        // The full source oracle already checked every successful row and its state
        // transitions. Isolated checks are needed only to explain a failing source.
        for (const request of selected) checks.set(request.id, allPassed ? { passed: true, error: null } : checkCell(plan, capture, records, request));
        attempt(`${app}/${source}/capture`, () => {
          const saved = fs.read(`${app}/${source}/capture.json`); equal(saved.capture, capture);
          equal(entry.sources[source].capture, `${app}/${source}/capture.json`); equal(entry.sources[source].complete, true);
          const settings = fs.read(`${app}/${source}/settings.json`);
          equal([settings.plan, settings.records, settings.app, settings.source, settings.settings, settings.folder, settings.base],
            [plan, records, app, source, options, `/out/${app}/${source}`, "http://127.0.0.1:8080"]);
          equal(settings.upstream, `http://${summary.runId}-${app}-${source}-upstream:8080`);
          assert.match(settings.readbackPath, /^\/(?!\/)[^?#\\\s]+$/);
          if (!options.readbacks) equal(settings.readbackPath, "/api/alerts");
          equal(saved.cells, selected.map((request) => {
            const value = fs.read(`${app}/${source}/${request.id}.json`), checked = checks.get(request.id);
            equal(value.check, checked);
            return { requestId: request.id, category: request.category, locale: request.locale, variant: request.variant,
              outcome: value.row.outcome, status: value.row.status, passed: checked.passed, error: checked.error, gaps: value.evidence.gaps };
          }));
        });
      }
      const capture = combine(plan, app, parts), checked = oracle(plan, capture, records); output.oracle = checked;
      for (const cell of output.cells) {
        const check = checks.get(cell.requestId);
        cell.passed = check.passed && cell.reasons.length === 0;
        if (!cell.passed && !cell.reasons.length) cell.reasons.push(check.error ?? "native-outcome-not-successful");
      }
      attempt(`${app}/combined`, () => { equal(fs.read(`${app}-capture.json`), capture); equal(entry.oracle, checked);
        const expectedCells = plan.requests.map((request) => {
          const value = fs.read(`${app}/${request.source}/${request.id}.json`), check = checks.get(request.id);
          return { requestId: request.id, category: request.category, source: request.source, locale: request.locale, variant: request.variant,
            outcome: value.row.outcome, status: value.row.status, passed: check.passed, error: check.error, gaps: value.evidence.gaps };
        }); equal(entry.cells, expectedCells);
      });
    }
    result.complete = inventory.every((app) => sources.every((s) => summary.apps[app].sources[s]?.complete === true))
      && Object.values(result.apps).every((a) => a.cells.every((c) => !c.reasons.includes("raw-request-artifact-missing")));
    const normalizedFunctionalPassed = functionalHealthPassed && result.complete && options.apps.length === inventory.length
      && Object.values(result.apps).every((a) => a.oracle?.valid && a.oracle.result.functionalPassed);
    result.functionalPassed = functionalHealthPassed && functionalProof && result.complete && options.apps.length === inventory.length
      && Object.values(result.apps).every((a) => a.oracle?.valid && a.oracle.result.functionalPassed && a.cells.every((c) => c.passed));
    attempt("functional-summary", () => { equal(summary.complete, result.complete); equal(summary.functionalPassed, normalizedFunctionalPassed); });
    functionalGateRejected = result.complete && nativeSourceProof && functionalProof && !normalizedFunctionalPassed;
    if (!result.functionalPassed) issue("blocked", "complete-native-functional-gate-not-passed", "functional");
    if (summary.timing) {
      checkpoint = "measurement";
      const timing = summary.timing, derived = result.measurement = { qualified: false, calibrated: false, complete: false, comparisonEligible: false, cells: {} };
      if (summary.executionInputs) attempt("measurement/producer-provenance", () => {
        const provenance = fs.read("measurement/producer-provenance.json");
        keys(provenance, ["schema", "commit", "files"]); equal([provenance.schema, provenance.commit], ["mixed-native-producer-evidence/v1", commit]);
        const files = ["bench/mixed-production/producer-evidence.mjs", "bench/mixed-production/qualification-evidence.mjs",
          "bench/catalog/cgroup.mjs", "bench/marketplace/qualify.mjs", "bench/marketplace/feature-contract.mjs",
          "bench/fullstack/conformance.mjs", "bench/fullstack/conform-probe.mjs", "bench/fullstack/conform-hold.mjs"];
        keys(provenance.files, files);
        for (const path of files) assert.ok([sha256(tracked[path]), sha256(Buffer.from(tracked[path].toString("utf8").replace(/\r?\n/g, "\r\n")))].includes(provenance.files[path]));
      });
      equal([timing.schema, timing.nativeProfile, timing.planSha256], ["mixed-native-measurement/v1", options.profile, plan.sha256]);
      assert.ok(options.measure && options.build && options.clients >= 2);
      equal(timing.calibrationPolicy, calibrationPolicy); equal(timing.resourceCoveragePolicy, resourceCoveragePolicy);
      const cpus = cpuSettings(Object.fromEntries(["app", "load", "api"].map((r) => [`CATALOG_${r.toUpperCase()}_CPUS`, timing.cpus[r].cpuset ?? undefined])));
      equal(timing.cpus, cpus); keys(timing.cells, inventory); keys(timing.sourceAudits, inventory);
      for (const app of inventory) {
        keys(timing.cells[app], sources); derived.cells[app] = {};
        for (const source of sources) {
          const saved = timing.cells[app][source], cell = derived.cells[app][source] = { qualification: null, calibration: null, passes: [], aggregate: null,
            outcomes: { qualification: "invalid-outcome",
              calibration: windowOutcome(saved.calibration), passes: saved.passes?.map(windowOutcome) ?? [] } };
          const qualificationState = attempt(`${app}/${source}/qualification`, () => {
            const outcome = qualificationOutcome(saved.qualification);
            if (outcome === "not-run" || saved.qualification.artifact === undefined) {
              issue("blocked", outcome === "not-run" ? "qualification-not-run" : "qualification-reported-failed", `${app}/${source}`);
              return { outcome, qualification: null };
            }
            qualificationParticipants(saved.qualification.participants, summary, app, source, cpus,
              () => issue("blocked", "qualification-participant-proof-not-retained", `${app}/${source}`));
            if (summary.executionInputs) for (const role of ["app", "upstream"]) {
              const p = saved.qualification.participants[role], sidecar = fs.read(`measurement/${app}/${source}/qualification/participant-qualification-${role}.json`);
              equal([sidecar.schema, sidecar.role, sidecar.id, sidecar.imageId, sidecar.startedAt, sidecar.restartCount, sidecar.running, sidecar.oomKilled, sidecar.paused],
                ["mixed-native-participant-boundary/v1", role, p.id, p.imageId, p.startedAt, 0, true, false, false]);
              if (!executionProof) issue("blocked", "native-qualification-lifecycle-binding-missing", `${app}/${source}`);
              else if (!bindParticipant(executionProof.participants, { stage: "qualification", pass: null, app, source, role }, p))
                issue("blocked", "native-qualification-terminal-health-not-proven", `${app}/${source}`);
            }
            let replayed = null;
            const raw = fs.artifact(saved.qualification.artifact, `measurement/${app}/${source}/qualification/qualification.json`);
            equal([raw.schema, raw.app, raw.source, raw.imageId, raw.nativeProfile], ["mixed-native-qualification/v1", app, source, summary.apps[app].image.id, options.profile]);
            // v1 explicitly stores sanitized probes, not the contract's original probes.
            // Even a self-consistent positive cell or hash cannot substitute for them.
            validateQualificationReceipt(raw, source);
            if (summary.executionInputs && fs.has(`measurement/${app}/${source}/qualification/qualification-evidence.json`)) {
              replayed = replayQualificationEvidence(fs.read(`measurement/${app}/${source}/qualification/qualification-evidence.json`), raw,
                { app, source, imageId: summary.apps[app].image.id, nativeProfile: options.profile });
            } else if (Object.values(raw.probes ?? {}).some((p) => p?.sha256 !== undefined)) {
              issue("blocked", "v1-qualification-raw-probes-not-retained", `${app}/${source}`);
            } else if (raw.probes && Object.keys(raw.probes).length) {
              validateProbes(raw.probes, source); const q = qualification(raw.probes, source);
              equal([raw.profile, raw.cells, raw.missing, raw.eligible], [q.profile, q.cells, q.missing, q.eligible]);
              equal(raw.rawProbeSha256, sha256(JSON.stringify(raw.probes)));
              replayed = { profile: q.profile, source: q.source, missing: q.missing, eligible: q.eligible };
            } else issue("blocked", "v1-qualification-raw-probes-not-retained", `${app}/${source}`);
            equal([saved.qualification.eligible, saved.qualification.missing, saved.qualification.failure], [raw.eligible, raw.missing ?? [], raw.failure]);
            if (summary.executionInputs && executionProof && !workerCompleted(executionProof.participants,
              { stage: "qualification", pass: null, app, source, role: "qualificationWorker" }, raw.eligible ? 0 : 1))
              issue("blocked", "native-qualification-worker-not-completed", `${app}/${source}`);
            return { outcome, qualification: replayed };
          });
          if (qualificationState) {
            cell.qualification = qualificationState.qualification;
            cell.outcomes.qualification = qualificationState.outcome;
          }
          const replay = (slot, stage, pass) => {
            const metrics = attempt(`${app}/${source}/${stage}-${pass}`, () => {
              validateWindowSlot(slot, stage, pass);
              if (!slot?.artifact) { issue("blocked", `${stage}-${windowOutcome(slot)}`, `${app}/${source}/${pass}`); return null; }
              const replayed = windowReplay(fs, slot.artifact, summary, plan, records, cpus, app, source, stage, pass,
                (code, at) => issue("blocked", code, at), executionProof, bindParticipant);
              equal(slot.metrics, replayed.metrics); equal(slot.stats, replayed.stats);
              equal(slot.outcome, replayed.metrics.eligible ? "measured" : "calibration-or-window-rejected");
              return replayed.metrics;
            });
            if (metrics === undefined) {
              if (stage === "calibration") cell.outcomes.calibration = "invalid-outcome";
              else cell.outcomes.passes[pass - 1] = "invalid-outcome";
            }
            return metrics ?? null;
          };
          cell.calibration = replay(saved.calibration, "calibration", 0);
          attempt(`${app}/${source}/pass-inventory`, () => assert.equal(saved.passes?.length, options.passes));
          for (let pass = 1; pass <= options.passes; pass++) {
            const slot = saved.passes?.[pass - 1];
            attempt(`${app}/${source}/pass-${pass}`, () => equal(slot?.pass, pass));
            cell.passes.push(replay(slot, "steady", pass));
          }
        }
      }
      const cells = Object.values(derived.cells).flatMap(Object.values);
      derived.qualified = cells.every((c) => c.qualification?.eligible);
      derived.calibrated = cells.every((c) => c.calibration?.eligible);
      derived.complete = cells.every((c) => c.passes.every((p) => p?.eligible));
      completeComparison = derived.complete && options.passes >= 3 && Object.values(cpus).every((c) => c.cpuset !== null);
      const qualificationRejected = summary.executionInputs && cells.every((c) => c.qualification !== null) && !derived.qualified;
      const calibrationRejected = summary.executionInputs && derived.qualified && cells.every((c) => c.calibration !== null) && !derived.calibrated;
      const gated = qualificationRejected ? ["calibration-not-run", "steady-not-run"] : calibrationRejected ? ["steady-not-run"] : [];
      if (gated.length) {
        assert.ok(cells.every((c) => (!qualificationRejected || c.calibration === null && c.outcomes.calibration === "not-run")
          && c.passes.every((p) => p === null) && c.outcomes.passes.every((p) => p === "not-run")), "work executed after a rejecting native gate");
        result.issues = result.issues.filter((i) => !gated.includes(i.code));
      }
      if (derived.complete) for (const app of inventory) for (const source of sources) {
        const cell = derived.cells[app][source]; cell.aggregate = {
          achievedOperationsPerSecond: spread(cell.passes.map((m) => m.achievedPrimaryOperationsPerSecond)),
          primaryHttpP99Ms: spread(cell.passes.map((m) => m.primaryHttpLatency.p99Ms)),
          cpuUsecPerOperation: spread(cell.passes.map((m) => m.resources.app.cpuUsecPerPrimaryOperation)),
          peakMemoryMiB: spread(cell.passes.map((m) => m.resources.app.memMaxMiB)),
        }; attempt(`${app}/${source}/aggregate`, () => equal(timing.cells[app][source].aggregate, cell.aggregate));
      }
      else for (const app of inventory) for (const source of sources)
        attempt(`${app}/${source}/partial-aggregate`, () => equal(timing.cells[app][source].aggregate, undefined));
      attempt("measurement-summary", () => {
        if (cells.every((c) => c.qualification !== null)) equal(timing.qualified, derived.qualified);
        equal(timing.calibrated, derived.calibrated); equal(timing.complete, derived.complete); equal(timing.timingBlocked, !derived.complete);
        equal(summary.readyForLoad, timing.qualified && derived.calibrated); equal(summary.timingBlocked, !derived.complete);
        equal(timing.comparisonEligible, derived.complete && options.passes >= 3 && Object.values(cpus).every((c) => c.cpuset !== null));
      });
      // The collector does not retain the cgroup reader's raw ID-keyed response or
      // RestartCount. Scalars and selected inspect fields cannot prove those facts.
      if (!summary.executionInputs) issue("blocked", "v1-original-cgroup-and-restart-receipts-not-retained", "measurement");
      if (!derived.qualified) issue("blocked", cells.every((c) => c.qualification !== null) ? "complete-native-qualification-gate-not-passed" : "production-qualification-not-replayable", "measurement");
      if (calibrationRejected) issue("blocked", "complete-native-calibration-gate-not-passed", "measurement");
      if (summary.executionInputs && derived.qualified && derived.calibrated && !derived.complete && cells.every((c) => c.passes.every((p) => p !== null)))
        issue("blocked", "complete-native-steady-gate-not-passed", "measurement");
    } else {
      attempt("unmeasured-summary", () => equal([summary.readyForLoad, summary.timingBlocked], [false, true]));
      if (!(functionalGateRejected && options.measure)) issue("blocked", options.measure ? "measurement-not-run" : "functional-only-no-performance-claim", "measurement");
    }
    assert.ok(Array.isArray(summary.failures) && Array.isArray(summary.cleanupFailures));
    if (summary.failures.length || summary.cleanupFailures.length) issue("blocked", "runner-or-cleanup-failures-retained", "summary");
  } catch { issue("failed", "invalid-or-missing-evidence", checkpoint); }
  if (fs) attempt("saved-folder-unchanged", () => fs.finish());
  result.verdict = result.issues.some((i) => i.kind === "failed") ? "failed" : result.issues.length ? "blocked" : "verified";
  if (executionProof && result.verdict !== "failed") {
    result.proof.cleanupComplete = executionProof.cleanupComplete;
    result.proof.resources = result.issues.some((i) => ["functional-process-limits-not-retained", "measurement-process-limits-not-retained"].includes(i.code)) ? "blocked" : executionProof.resources;
  }
  if (inputFiles && executionProof && result.verdict !== "failed" && Object.values(result.apps).length === selectedApps("mixed-production").length
    && Object.values(result.apps).every((app) => app.sourceAudit !== null)) {
    result.proof.sources = "verified";
    result.proof.sourceFiles = [...inputFiles, ...Object.values(result.apps).flatMap((app) => app.sourceAudit.sourceFiles)]
      .filter((file, index, all) => all.findIndex((other) => other.path === file.path) === index).sort((a, b) => a.path.localeCompare(b.path, "en"));
  }
  result.proof.blockers = [...new Set(result.issues.map((i) => i.code))];
  const sourceClosed = result.proof.sources === "verified" && result.proof.resources === "verified" && result.proof.cleanupComplete && nativeSourceProof && result.complete;
  const targetGateCodes = ["complete-native-functional-gate-not-passed", "complete-native-qualification-gate-not-passed", "complete-native-calibration-gate-not-passed", "complete-native-steady-gate-not-passed"];
  const proofIssues = result.issues.filter((i) => !targetGateCodes.includes(i.code));
  if (sourceClosed && proofIssues.length === 0 && measureRequested) {
    if (functionalGateRejected && result.measurement === null) {
      result.attemptComplete = true;
      result.dispositions = { functional: "recorded-failed", qualification: "gated-not-run", calibration: "gated-not-run", steady: "gated-not-run", gate: "native-functional" };
    } else if (result.functionalPassed && result.measurement) {
      const cells = Object.values(result.measurement.cells).flatMap(Object.values);
      if (cells.every((c) => c.qualification !== null) && !result.measurement.qualified
        && cells.every((c) => c.calibration === null && c.outcomes.calibration === "not-run" && c.passes.every((p) => p === null) && c.outcomes.passes.every((p) => p === "not-run"))) {
        result.attemptComplete = true;
        result.dispositions = { functional: "passed", qualification: "recorded-failed", calibration: "gated-not-run", steady: "gated-not-run", gate: "native-qualification" };
      } else if (result.functionalPassed && result.measurement.qualified && result.measurement.calibrated && result.measurement.complete) {
        result.attemptComplete = true; result.dispositions = { functional: "passed", qualification: "passed", calibration: "passed", steady: "passed", gate: null };
      } else if (result.measurement.qualified && !result.measurement.calibrated && cells.every((c) => c.calibration !== null && c.passes.every((p) => p === null))) {
        result.attemptComplete = true; result.dispositions = { functional: "passed", qualification: "passed", calibration: "recorded-failed", steady: "gated-not-run", gate: "native-calibration" };
      } else if (result.measurement.qualified && result.measurement.calibrated && cells.every((c) => c.passes.every((p) => p !== null))) {
        result.attemptComplete = true; result.dispositions = { functional: "passed", qualification: "passed", calibration: "passed", steady: "recorded-failed", gate: "native-steady" };
      }
    }
  }
  if (result.attemptComplete && result.verdict === "blocked" && proofIssues.length === 0) {
    result.verdict = "verified"; result.proof.blockers = [];
    for (const issue of result.issues) issue.kind = "target-failed";
  }
  if (result.verdict === "verified" && result.attemptComplete && result.dispositions?.gate === null && result.measurement?.complete) {
    result.comparisonEligible = completeComparison;
  }
  if (result.verdict !== "verified") result.comparisonEligible = false;
  if (result.measurement) result.measurement.comparisonEligible = result.comparisonEligible;
  return result;
}

export async function cli(args) {
  try {
    assert.equal(args.length, 6); equal([args[0], args[2], args[4]], ["--folder", "--round", "--commit"]);
    const result = await validateSaved({ folder: args[1], round: args[3], commit: args[5] });
    process.stdout.write(JSON.stringify(result) + "\n"); return result.verdict === "verified" ? 0 : result.verdict === "blocked" ? 2 : 1;
  } catch { process.stderr.write("usage: verify.mjs --folder <local-folder> --round wN --commit <40-lowercase-hex>\n"); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await cli(process.argv.slice(2));
