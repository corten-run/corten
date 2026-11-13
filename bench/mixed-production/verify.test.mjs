import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { records as fixtureRecords } from "../marketplace/fixtures.mjs";
import { expectedPage, labels } from "../marketplace/records.mjs";
import { createPlan } from "../workloads/mixed.mjs";
import { contractSha256, definition, retainedFamilies, selectedApps } from "../workloads/registry.mjs";
import { cpuSettings } from "../catalog/contract.mjs";
import { summarizeSamples } from "../catalog/stats.mjs";
import { qualification as qualifyProbes } from "../marketplace/feature-contract.mjs";
import { qualificationProbes } from "../marketplace/qualification-fixture.mjs";
import { captureSource, checkCell, combine, expectedOutcome, oracle, sha256, unsent } from "./capture.mjs";
import { loadCycle } from "./load-capture.mjs";
import { calibrationPolicy, deriveWindow, observedCpuCeiling } from "./metrics.mjs";
import { resourceCoveragePolicy, mergeResourceSamples } from "./resources.mjs";
import { reconcileLedger, upstreamManifest, upstreamPhase } from "./upstream-ledger.mjs";
import { parseArgs } from "./run.mjs";
import { validateSaved } from "./verify.mjs";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import { nativeTransport } from "./native.mjs";
import { createExecutionEvidence } from "./execution-evidence.mjs";
import { finalizeExecutionInputs, prepareExecutionInputs } from "./execution-inputs.mjs";
import { sourceAuditIdentity, verifySourceAudit } from "./source-audit.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const git = (args, input) => {
  const r = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "core.eol=lf", ...args], { cwd: repo, input, maxBuffer: 256 * 1024 ** 2, windowsHide: true });
  assert.equal(r.status, 0); return r.stdout;
};
const commit = git(["rev-parse", "HEAD"]).toString().trim(), inventory = selectedApps("mixed-production");
const records = fixtureRecords(), plan = createPlan({ seed: 42, clients: 2, repetitions: 1, records });
let folder, summary, functional, tracked;
const save = (path, data) => { const full = join(folder, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, Buffer.isBuffer(data) ? data : JSON.stringify(data)); };
const read = (path) => JSON.parse(readFileSync(join(folder, path), "utf8"));
const ref = (path) => ({ path, sha256: sha256(readFileSync(join(folder, path))) });

// Synthetic transport vectors ONLY. They test replay/file handling, never native parity.
function transport(source, { redirects = false } = {}) {
  const states = new Map(), modes = new Map();
  const stage = (evidence, stage, response) => evidence.stages.push({ stage, ...response, elapsedMs: 0.1,
    decodedBodyBytes: 2, decodedBodySha256: sha256("{}"), headers: {} });
  return {
    injector: {
      async begin(id, mode, delayMs, path) { modes.set(id, { mode, path }); },
      async read(id) {
        const { mode } = modes.get(id), request = plan.requests.find((r) => r.id === id);
        const cancelled = source === "api" && ["cancel", "deadline"].includes(mode);
        return { requests: source === "api" ? 1 : 0, completed: source === "api" && !cancelled ? 1 : 0, cancelled: cancelled ? 1 : 0,
          pending: 0, mode, events: source === "api" ? [{ path: `/marketplace/records/${request.itemId}` }] : [] };
      },
    },
    transport: {
      async discover(request, evidence) {
        stage(evidence, "form-discovery", { status: 200, contentType: "text/html", contentEncoding: "identity", error: null });
        return { client: request.client, source, locale: request.locale, itemId: request.itemId, method: "POST", action: request.formPage,
          contentType: "application/x-www-form-urlencoded", fields: ["email", "target_price"], transport: {} };
      },
      async readState(request, evidence, name) {
        stage(evidence, `state-${name}`, { status: 200, contentType: "application/json", contentEncoding: "identity", error: null });
        return structuredClone(states.get(request.client) ?? []);
      },
      async send(request, binding, evidence) {
        if (request.category === "accepted-write") states.set(request.client, [...(states.get(request.client) ?? []), { item_id: request.itemId, email: request.input.email, target_minor: request.targetMinor }]);
        const outcome = expectedOutcome(request), response = { status: outcome === "deadline" ? 503 : outcome === "cancelled" ? 0 : 200,
          error: outcome === "cancelled" ? "cancelled" : null, contentType: outcome === "cancelled" ? null : request.accept,
          contentEncoding: outcome === "cancelled" ? null : "identity" };
        if (redirects && request.method === "POST") response.status = 303;
        stage(evidence, "primary", response);
        if (response.status === 303) stage(evidence, "native-redirect", { ...response, status: 200 });
        return { ...response, body: Buffer.from(JSON.stringify(records[request.itemId])) };
      },
      async snapshot(response, request, evidence) {
        const record = records[request.itemId], message = request.category === "rejected-write" ? labels[request.locale][request.variant]
          : request.category === "accepted-write" ? labels[request.locale].alert_set.replace("{email}", request.input.email).replace("{title}", record.title)
            .replace("{price}", new Intl.NumberFormat(request.locale, { style: "currency", currency: "USD" }).format(request.targetMinor / 100)) : "";
        evidence.redactedNativeDOM = "<!DOCTYPE html><html><body>synthetic verifier vector</body></html>";
        return expectedPage(record, request.locale, { ...request.query, message });
      },
    },
  };
}

async function setup() {
  if (folder) return;
  folder = mkdtempSync(join(tmpdir(), "mixed-saved-verifier-"));
  const entries = git(["ls-tree", "-rz", commit]).toString().split("\0").filter(Boolean).map((line) => {
    const m = /^\d+ blob (\w+)\t(.+)$/.exec(line); assert.ok(m); return { oid: m[1], path: m[2] };
  });
  const batch = git(["cat-file", "--batch"], entries.map((e) => e.oid).join("\n") + "\n"); let offset = 0;
  tracked = Object.fromEntries(entries.map((e) => {
    const end = batch.indexOf(10, offset), size = Number(batch.subarray(offset, end).toString().split(" ")[2]); offset = end + 1;
    const body = batch.subarray(offset, offset + size); offset += size + 1; return [e.path, body];
  }));
  const options = parseArgs(["w91", "--build", "--measure", "--passes", "3", "--duration", "1", "--warmup", "1", "--calibration", "1"]); options.apps = inventory;
  summary = { schema: "mixed-native-run/v1", group: "mixed-production", inventory, definition: definition("mixed-production"), retainedFamilies,
    contractSha256: contractSha256("mixed-production"), round: "w91", runId: "mixed-w91-12345678", options, complete: true, functionalPassed: true,
    readyForLoad: false, timingBlocked: true, timing: null, failures: [], cleanupFailures: [], apps: {},
    tools: { nodeImage: `sha256:${"b".repeat(64)}`, browserImage: `sha256:${"c".repeat(64)}` },
    provenance: { commit, dirty: "", nativeSource: { kind: "git-archive", commit, dirty: false, tree: git(["rev-parse", `${commit}^{tree}`]).toString().trim() } } };
  const hashes = (names, prefix = "") => Object.fromEntries(names.map((p) => [p, sha256(tracked[prefix + p])]));
  summary.provenance.harnessFiles = hashes(["build-context.mjs", "capture.mjs", "native.mjs", "snapshot.mjs", "source-audit.mjs", "upstream.mjs", "worker.mjs", "run.mjs"], "bench/mixed-production/");
  summary.provenance.sharedFiles = hashes(["bench/workloads/mixed.mjs", "bench/workloads/registry.mjs", "bench/json-api/contract.mjs", "bench/marketplace/check.mjs", "bench/marketplace/records.mjs", "bench/marketplace/labels.json"]);
  summary.provenance.measurementHarnessFiles = hashes(["measure.mjs", "metrics.mjs", "load-capture.mjs", "load-worker.mjs", "load-upstream.mjs", "upstream-ledger.mjs", "resources.mjs", "source-audit.mjs", "qualify-worker.mjs"], "bench/mixed-production/");
  save("plan.json", plan); save("marketplace.json", records); summary.provenance.fixtureSha256 = ref("marketplace.json").sha256;
  const archive = git(["archive", "--format=tar", commit]); save("build-source.tar", archive); summary.provenance.nativeSource.archiveSha256 = sha256(archive);
  for (const [path, body] of Object.entries(tracked)) save(`build-source/${path}`, body);
  functional = {};
  for (const source of ["fixture", "api"]) {
    const saved = {}, result = await captureSource({ ...transport(source), plan, records, app: "corten", source, settings: options,
      save: async (request, value) => { saved[request.id] = structuredClone(value); } });
    assert.ok(result.cells.every((c) => c.passed), JSON.stringify(result.cells.filter((c) => !c.passed)));
    functional[source] = { result, saved };
  }
  for (const app of inventory) {
    const prefix = `bench/fullstack/apps/${app}`, paths = Object.keys(tracked).filter((p) => app === "corten" || p.startsWith(prefix + "/")).sort();
    const context = app === "corten" ? archive : git(["archive", "--format=tar", `${commit}:${prefix}`]); save(`${app}-build-context.tar`, context);
    for (const path of paths) save(`${app}-build-context/${app === "corten" ? path : path.slice(prefix.length + 1)}`, tracked[path]);
    const entry = summary.apps[app] = { selected: true, contextArchiveSha256: sha256(context), buildInputs: paths.map((path) => ({ path, sha256: sha256(tracked[path]) })),
      image: { id: `sha256:${"a".repeat(64)}`, buildCommit: commit, buildDirty: "false", profile: options.profile, contextArchiveSha256: sha256(context) }, sources: {}, cells: [] };
    const parts = [];
    for (const source of ["fixture", "api"]) {
      const result = structuredClone(functional[source].result); result.capture.app = app; parts.push({ source, capture: result.capture });
      save(`${app}/${source}/capture.json`, result);
      for (const [id, value] of Object.entries(functional[source].saved)) save(`${app}/${source}/${id}.json`, value);
      save(`${app}/${source}/settings.json`, { plan, records, app, source, settings: options, folder: `/out/${app}/${source}`, base: "http://127.0.0.1:8080",
        upstream: `http://${summary.runId}-${app}-${source}-upstream:8080`, readbackPath: "/api/alerts" });
      entry.sources[source] = { complete: true, capture: `${app}/${source}/capture.json`,
        container: { imageId: entry.image.id, startedAt: "2026-01-01T00:00:00.000Z", running: true, exitCode: 0, oomKilled: false } };
      entry.cells.push(...result.cells.map((c) => ({ ...c, source })));
    }
    entry.cells.sort((a, b) => Number(a.requestId.slice(8)) - Number(b.requestId.slice(8)));
    const capture = combine(plan, app, parts); entry.oracle = oracle(plan, capture, records); save(`${app}-capture.json`, capture);
  }
  save("summary.json", summary);
}

after(() => {
  if (!folder) return;
  const rel = relative(resolve(tmpdir()), resolve(folder));
  assert.ok(rel.startsWith("mixed-saved-verifier-") && !rel.includes("/") && !rel.includes("\\"));
  rmSync(folder, { recursive: true });
});

const verify = () => validateSaved({ folder, round: "w91", commit });
async function changed(path, mutate, check) {
  const old = readFileSync(join(folder, path));
  try { const value = JSON.parse(old); mutate(value); save(path, value); await check(await verify()); }
  finally { writeFileSync(join(folder, path), old); }
}
const failed = (result) => { assert.equal(result.verdict, "failed", JSON.stringify(result.issues)); assert.equal(result.comparisonEligible, false); };

// This vector uses actual local HTTP failures and locked cached tooling. Docker
// lifecycle and independent-audit inputs are explicitly synthetic unit vectors,
// never receipts offered to a collector as framework or independent audit proof.
test("complete native HTTP failure evidence admits a gated negative attempt, never a ranking", {
  skip: process.env.MIXED_NATIVE_CLOSURE_TESTS !== "1",
}, async () => {
  await setup();
  const previousFolder = folder;
  folder = mkdtempSync(join(tmpdir(), "mixed-saved-verifier-"));
  const { cpSync } = await import("node:fs"); cpSync(previousFolder, folder, { recursive: true });
  const s = read("summary.json"); s.functionalPassed = false; s.sourceAudits = {};
  s.tools.playwright = JSON.parse(tracked["package-lock.json"]).packages["node_modules/@playwright/test"].version;
  const server = createServer((_req, res) => { res.writeHead(500, { "content-type": "text/html", "set-cookie": "session=credential-canary" }); res.end("native unavailable"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const actual = {};
    for (const source of ["fixture", "api"]) {
      const driver = await nativeTransport({ browser, base: `http://127.0.0.1:${server.address().port}`, settings: s.options });
      const saved = {}, modes = new Map();
      try {
        const result = await captureSource({ plan, records, app: "corten", source, transport: driver, settings: s.options,
          injector: { async begin(id, mode) { modes.set(id, mode); }, async read(id) {
            return { requests: 0, completed: 0, cancelled: 0, pending: 0, events: [], mode: modes.get(id) };
          } }, save: async (request, value) => { saved[request.id] = structuredClone(value); } });
        actual[source] = { result, saved };
      } finally { await driver.close(); }
    }
    for (const app of inventory) {
      const entry = s.apps[app], parts = []; entry.cells = [];
      for (const source of ["fixture", "api"]) {
        entry.sources[source].container.restartCount = 0;
        const result = structuredClone(actual[source].result); result.capture.app = app; parts.push({ source, capture: result.capture });
        save(`${app}/${source}/capture.json`, result);
        for (const [id, value] of Object.entries(actual[source].saved)) save(`${app}/${source}/${id}.json`, value);
        entry.cells.push(...result.cells.map((c) => ({ ...c, source })));
      }
      entry.cells.sort((a, b) => Number(a.requestId.slice(8)) - Number(b.requestId.slice(8)));
      const capture = combine(plan, app, parts); entry.oracle = oracle(plan, capture, records); save(`${app}-capture.json`, capture);
      const paths = entry.buildInputs.map((f) => f.path), identity = sourceAuditIdentity(s, app);
      const receipt = { schema: "json-api-native-audit/v1", identity, auditor: "synthetic-unit-vector-not-independent-review", auditedAt: "2026-11-12T00:00:00Z",
        traceContext: { requestScoped: true, delayedWorkRetainsTrace: true, noAmbientCurrentOperation: true }, findings: [],
        verified: { typedCompleteRecord: true, nativeSerialization: true, noOutputCache: true, noJsonPassthrough: true, fixtureParsedAtStartup: true, requestTimeFetchParse: true, upstreamErrors: true }, sourceFiles: entry.buildInputs };
      const verified = verifySourceAudit(receipt, identity, { files: Object.fromEntries(paths.map((p) => [p, tracked[p]])), sourceFiles: entry.buildInputs }, entry.image);
      const path = `source-audits/${app}.json`; save(path, { ...verified, receipt }); s.sourceAudits[app] = { eligible: true, failure: null, artifact: ref(path) };
    }
    mkdirSync(join(folder, "execution"));
    s.executionInputs = prepareExecutionInputs({ folder, buildRoot: join(folder, "build-source"), repo, commit,
      harnessPaths: Object.keys(tracked).filter((p) => /\.(?:mjs|cjs|js|json)$/.test(p)) });
    finalizeExecutionInputs({ folder, repo }); s.executionMounts = read("execution/inputs.json").mounts;
    const active = new Map(), netId = "f".repeat(64);
    const docker = async (args) => {
      if (args[0] === "inspect") return JSON.stringify([[...active.values()].find((p) => p.Id === args.at(-1))]);
      if (args[0] === "image" && args[1] === "inspect") return JSON.stringify([{ Id: args.at(-1), Config: { Cmd: ["node"], Entrypoint: null } }]);
      if (args[0] === "network" && args[1] === "inspect") return JSON.stringify([{ Id: netId, Name: `${s.runId}-net`, Labels: { "run.corten.mixed-production": s.runId } }]);
      if (args[0] === "network" && args[1] === "rm") return netId;
      if (args[0] === "ps" && args.some((a) => a.startsWith("name="))) return active.get(args.find((a) => a.startsWith("name=")).slice(7, -1))?.Id ?? "";
      if (args[0] === "rm") { const item = [...active].find(([, p]) => p.Id === args.at(-1)); active.delete(item[0]); return args.at(-1); }
      if (["ps", "network", "image", "volume"].includes(args[0])) return "";
      assert.fail("unexpected synthetic lifecycle operation");
    };
    const collector = createExecutionEvidence({ folder, summary: s, docker }); await collector.networkCreated(`${s.runId}-net`, netId); let next = 1;
    for (const app of inventory) for (const source of ["fixture", "api"]) {
      const base = `${s.runId}-${app}-${source}`, ids = Array.from({ length: 3 }, () => (next++).toString(16).padStart(64, "0"));
      for (const [index, name] of [base, `${base}-upstream`, `${base}-capture`].entries()) {
        const imageId = index === 0 ? s.apps[app].image.id : index === 1 ? s.tools.nodeImage : s.tools.browserImage;
        const sourceRoot = join(folder, "build-source"), dependencies = join(folder, "execution/dependencies");
        const value = { Id: ids[index], Name: `/${name}`, Image: imageId, RestartCount: 0,
          Config: { Cmd: index === 0 ? ["node"] : index === 1 ? ["node", "bench/mixed-production/upstream.mjs"] : ["node", "bench/mixed-production/worker.mjs", `/out/${app}/${source}/settings.json`], Entrypoint: null,
            Env: [`MARKETPLACE_SOURCE=${source}`, "PROFILE="], Labels: { "run.corten.mixed-production": s.runId, "agent.owner": "codex", "agent.task": s.runId } },
          State: { Status: "running", Running: true, Paused: false, Restarting: false, OOMKilled: false, Dead: false, Pid: 123, ExitCode: 0,
            StartedAt: "2026-01-01T00:00:00.000Z", FinishedAt: "0001-01-01T00:00:00Z" },
          HostConfig: { NanoCpus: index === 0 ? 1e9 : 2e9, CpusetCpus: "", Memory: index === 1 ? 512 * 2 ** 20 : 2 ** 30,
            CpuQuota: 0, CpuPeriod: 0, MemorySwap: 2 ** 31, ShmSize: index === 2 ? 512 * 2 ** 20 : 64 * 2 ** 20, PidsLimit: null, NetworkMode: index === 2 ? `container:${ids[0]}` : `${s.runId}-net` },
          Mounts: (index === 0 ? [[folder, "/fixtures", false]] : [[sourceRoot, "/src", false], [dependencies, "/src/node_modules", false], [folder, "/out", true]])
            .map(([Source, Destination, RW]) => ({ Type: "bind", Source, Destination, RW })) };
        await collector.create(name, async () => { active.set(name, value); return value.Id; });
      }
      const captureWorker = active.get(`${base}-capture`);
      Object.assign(captureWorker.State, { Status: "exited", Running: false, Pid: 0, FinishedAt: "2026-01-01T00:01:00.000Z" });
      for (const name of [`${base}-capture`, base, `${base}-upstream`]) await collector.remove(name);
    }
    await collector.removeNetwork(`${s.runId}-net`); await collector.seal(); save("summary.json", s);
    const before = sha256(readFileSync(join(folder, "summary.json"))), result = await verify();
    assert.equal(result.verdict, "verified", JSON.stringify(result.issues)); assert.equal(result.attemptComplete, true);
    assert.deepEqual(result.dispositions, { functional: "recorded-failed", qualification: "gated-not-run", calibration: "gated-not-run", steady: "gated-not-run", gate: "native-functional" });
    assert.deepEqual([result.proof.resources, result.proof.sources, result.proof.cleanupComplete, result.proof.blockers], ["verified", "verified", true, []]);
    assert.equal(result.functionalPassed, false); assert.equal(result.comparisonEligible, false);
    assert.equal(Object.values(result.apps).reduce((n, a) => n + a.cells.length, 0), 477);
    assert.ok(Object.values(result.apps).every((app) => ["fixture", "api"].every((source) => app.execution[source].healthy)));
    assert.equal(sha256(readFileSync(join(folder, "summary.json"))), before);
    await changed("summary.json", (v) => { v.functionalPassed = true; }, failed);
    await changed("summary.json", (v) => { delete v.sourceAudits.corten; }, (r) => {
      assert.equal(r.verdict, "blocked"); assert.equal(r.attemptComplete, false); assert.equal(r.comparisonEligible, false);
    });
    const dependency = read("execution/inputs.json").packages[0].files[0].path;
    const bytes = readFileSync(join(folder, dependency));
    try { save(dependency, Buffer.from("mutated mounted executable")); failed(await verify()); } finally { writeFileSync(join(folder, dependency), bytes); }
    assert.doesNotMatch(JSON.stringify(actual), /credential-canary|set-cookie/);
  } finally {
    await browser.close(); await new Promise((resolve) => server.close(resolve));
    const abandoned = folder; folder = previousFolder;
    const rel = relative(resolve(tmpdir()), resolve(abandoned)); assert.ok(rel.startsWith("mixed-saved-verifier-") && !/[\\/]/.test(rel)); rmSync(abandoned, { recursive: true });
  }
});

test("complete real-file functional vectors replay without mutating saved bytes", async () => {
  await setup();
  const before = sha256(readFileSync(join(folder, "summary.json"))), result = await verify();
  assert.equal(result.verdict, "blocked", JSON.stringify(result.issues)); assert.equal(result.functionalPassed, false); assert.equal(result.complete, true);
  assert.equal(Object.keys(result.apps).length, 9); assert.ok(Object.values(result.apps).every((a) => a.cells.length === 53 && a.oracle.valid));
  assert.ok(result.issues.some((i) => i.code === "v1-response-normalization-not-proven"));
  assert.deepEqual([result.proof.schema, result.proof.resources, result.proof.sources, result.proof.cleanupComplete],
    ["mixed-native-saved-proof/v1", "blocked", "blocked", false]);
  assert.ok(result.proof.blockers.includes("native-execution-evidence-not-retained"));
  assert.equal(result.comparisonEligible, false); assert.equal(sha256(readFileSync(join(folder, "summary.json"))), before);
});

test("filtered JSON source absent from a normalized saved row stays blocked with its original outcome", async () => {
  await setup();
  const request = plan.requests.find((r) => r.category === "json" && r.source === "fixture"), path = `corten/fixture/${request.id}.json`;
  await changed(path, (value) => {
    value.evidence.responseSchema = "mixed-native-response-source/v1";
    const primary = value.evidence.stages.find((s) => s.stage === "primary"), body = JSON.stringify(value.row.record);
    primary.decodedBodyBytes = Buffer.byteLength(body); primary.decodedBodySha256 = sha256(body);
  }, (result) => {
    assert.equal(result.verdict, "blocked"); assert.equal(result.comparisonEligible, false);
    const cell = result.apps.corten.cells.find((c) => c.requestId === request.id);
    assert.equal(cell.outcome, "completed"); assert.equal(cell.status, 200); assert.equal(cell.passed, false);
    assert.ok(result.issues.some((i) => i.kind === "blocked" && i.code === "native-response-source-missing-or-filter-blocked" && i.at === path));
    assert.equal(result.issues.some((i) => i.kind === "failed" && i.at === path), false);
  });
});

test("execution proof composes read-only, requires full participant coverage and clears on any invalid gate", async () => {
  await setup(); const original = readFileSync(join(folder, "summary.json")), s = read("summary.json");
  const { createExecutionEvidence } = await import("./execution-evidence.mjs");
  const active = new Map(), netId = "f".repeat(64), base = `${s.runId}-corten-fixture`, names = [base, `${base}-upstream`, `${base}-capture`];
  const { mountSourceHash } = await import("./execution-inputs.mjs");
  s.executionMounts = { source: mountSourceHash("/source"), dependencies: mountSourceHash("/dependencies"), output: mountSourceHash("/output") };
  const image = (id) => ({ Id: id, Config: { Cmd: ["node"], Entrypoint: null } });
  const docker = async (args) => {
    if (args[0] === "inspect") return JSON.stringify([[...active.values()].find((p) => p.Id === args.at(-1))]);
    if (args[0] === "image" && args[1] === "inspect") return JSON.stringify([image(args.at(-1))]);
    if (args[0] === "network" && args[1] === "inspect") return JSON.stringify([{ Id: netId, Name: `${s.runId}-net`, Labels: { "run.corten.mixed-production": s.runId } }]);
    if (args[0] === "network" && args[1] === "rm") return netId;
    if (args[0] === "ps" && args.some((a) => a.startsWith("name="))) return active.get(args.find((a) => a.startsWith("name=")).slice(7, -1))?.Id ?? "";
    if (args[0] === "rm") { const item = [...active].find(([, p]) => p.Id === args.at(-1)); active.delete(item[0]); return args.at(-1); }
    if (["ps", "network", "image", "volume"].includes(args[0])) return "";
    assert.fail("unexpected synthetic execution operation");
  };
  try {
    const collector = createExecutionEvidence({ folder, summary: s, docker }); await collector.networkCreated(`${s.runId}-net`, netId);
    const appId = "1".repeat(64);
    for (const [index, name] of names.entries()) {
      const id = String(index + 1).repeat(64), imageId = index === 0 ? s.apps.corten.image.id : index === 1 ? s.tools.nodeImage : s.tools.browserImage;
      const cmd = index === 0 ? ["node"] : index === 1 ? ["node", "bench/mixed-production/upstream.mjs"]
        : ["node", "bench/mixed-production/worker.mjs", "/out/corten/fixture/settings.json"];
      const value = { Id: id, Name: `/${name}`, Image: imageId, RestartCount: 0,
        Config: { Cmd: cmd, Entrypoint: null, Env: ["PROFILE=", "MARKETPLACE_SOURCE=fixture"],
          Labels: { "run.corten.mixed-production": s.runId, "agent.owner": "codex", "agent.task": s.runId } },
        State: { Status: "running", Running: true, Paused: false, Restarting: false, OOMKilled: false, Dead: false,
          Pid: 123, ExitCode: 0, StartedAt: "2026-11-13T00:00:00Z", FinishedAt: "0001-01-01T00:00:00Z" },
        HostConfig: { NanoCpus: index === 0 ? 1e9 : 2e9, CpusetCpus: "", Memory: index === 1 ? 512 * 2 ** 20 : 2 ** 30,
          CpuQuota: 0, CpuPeriod: 0, MemorySwap: 2 ** 31, ShmSize: index === 2 ? 512 * 2 ** 20 : 64 * 2 ** 20, PidsLimit: null,
          NetworkMode: index === 2 ? `container:${appId}` : `${s.runId}-net` },
        Mounts: (index === 0 ? [["/output", "/fixtures", false]] : [["/source", "/src", false], ["/dependencies", "/src/node_modules", false], ["/output", "/out", true]])
          .map(([Source, Destination, RW]) => ({ Type: "bind", Source, Destination, RW })) };
      await collector.create(name, async () => { active.set(name, value); return id; });
    }
    for (const name of [...names].reverse()) await collector.remove(name);
    await collector.removeNetwork(`${s.runId}-net`); await collector.seal(); save("summary.json", s);
    const before = sha256(readFileSync(join(folder, "execution/manifest.json"))), result = await verify();
    assert.equal(result.verdict, "blocked", JSON.stringify(result.issues)); assert.equal(result.proof.cleanupComplete, true);
    assert.equal(result.proof.resources, "blocked"); assert.equal(result.proof.sources, "blocked"); assert.equal(result.comparisonEligible, false);
    assert.ok(result.proof.blockers.includes("functional-process-limits-not-retained"));
    assert.ok(result.proof.blockers.includes("native-execution-input-snapshot-not-retained"));
    assert.equal(sha256(readFileSync(join(folder, "execution/manifest.json"))), before);
    const request = plan.requests.find((r) => functional[r.source].saved[r.id].row.page), path = `corten/${request.source}/${request.id}.json`;
    await changed(path, (v) => { v.evidence.stages.find((p) => p.stage === "primary").decodedBodySha256 = "0".repeat(64); }, (r) => {
      failed(r); assert.equal(r.proof.cleanupComplete, false); assert.equal(r.proof.resources, "blocked");
    });
  } finally {
    writeFileSync(join(folder, "summary.json"), original);
    const execution = resolve(folder, "execution"); assert.equal(dirname(execution), resolve(folder)); rmSync(execution, { recursive: true });
  }
});

test("commit, dirty state, source inventory, profile, plan and aggregate booleans cannot assert proof", async () => {
  await setup();
  for (const mutate of [
    (s) => { s.provenance.commit = "0".repeat(40); }, (s) => { s.provenance.dirty = " M app"; },
    (s) => { s.apps.corten.buildInputs.pop(); }, (s) => { s.apps.corten.image.profile = "matched"; },
    (s) => { s.inventory.pop(); }, (s) => { s.options.apps.pop(); }, (s) => { s.contractSha256 = "a".repeat(64); },
    (s) => { s.apps.corten.sources.api.capture = "../outside.json"; },
  ]) await changed("summary.json", mutate, failed);
  await changed("plan.json", (p) => { p.requests[0].path = "/easier"; }, failed);
});

test("raw mutation and missing primary artifacts cannot hide behind normalized captures or summary passed", async () => {
  await setup();
  const request = plan.requests.find((r) => r.source === "fixture"), path = `corten/fixture/${request.id}.json`;
  await changed(path, (v) => { v.row.status = 500; v.row.outcome = "PRIVATE-UNTRUSTED-OUTCOME"; }, (result) => {
    failed(result); assert.ok(!JSON.stringify(result).includes("PRIVATE-UNTRUSTED-OUTCOME"));
  });
  await changed(path, (v) => { v.row.page = null; }, failed);
  const old = readFileSync(join(folder, path));
  try {
    rmSync(join(folder, path)); const result = await verify(); failed(result);
    assert.equal(result.apps.corten.cells.find((c) => c.requestId === request.id).outcome, "not-run");
    assert.ok(result.issues.some((i) => i.code === "raw-request-artifact-missing"));
  } finally { writeFileSync(join(folder, path), old); }
});

test("unsupported native writes remain visible with their reason and cannot qualify a partial group", async () => {
  await setup();
  const request = plan.requests.find((r) => r.source === "fixture" && r.method === "POST"), path = `corten/fixture/${request.id}.json`;
  await changed(path, (v) => { v.row = unsent(request, "unsupported"); v.evidence.stages = []; v.evidence.gaps = ["native-form-unavailable"]; }, (result) => {
    failed(result); const cell = result.apps.corten.cells.find((c) => c.requestId === request.id);
    assert.equal(cell.outcome, "unsupported"); assert.ok(cell.reasons.includes("native-form-unavailable")); assert.equal(cell.passed, false);
  });
});

test("duplicate JSON keys, path escapes, symbolic and hard links are rejected without following them", async () => {
  await setup();
  const path = join(folder, "summary.json"), old = readFileSync(path);
  try { writeFileSync(path, '{"schema":"first",' + old.toString().slice(1)); failed(await verify()); }
  finally { writeFileSync(path, old); }
  const outside = mkdtempSync(join(tmpdir(), "mixed-verifier-outside-")), secret = join(outside, "do-not-read.json"); writeFileSync(secret, "private outside vector");
  try {
    const linked = join(folder, "linked"); symlinkSync(outside, linked, "junction");
    try { failed(await verify()); } finally { rmSync(linked); }
    linkSync(secret, join(folder, "hard.json"));
    try { failed(await verify()); } finally { rmSync(join(folder, "hard.json")); }
    assert.equal(readFileSync(secret, "utf8"), "private outside vector");
    await changed("summary.json", (s) => { s.apps.corten.buildInputs[0].path = "../../outside"; }, failed);
  } finally {
    assert.ok(relative(resolve(tmpdir()), outside).startsWith("mixed-verifier-outside-")); rmSync(outside, { recursive: true });
  }
});

test("a retained tar link is rejected even when its forged summary/image hashes agree", async () => {
  await setup();
  const path = "aspnet-build-context.tar", old = readFileSync(join(folder, path)), oldSummary = readFileSync(join(folder, "summary.json"));
  try {
    const tar = Buffer.from(old); let offset = 0;
    while (![0, 48].includes(tar[offset + 156])) {
      const length = parseInt(tar.subarray(offset + 124, offset + 136).toString().replaceAll("\0", "").trim(), 8);
      offset += 512 + Math.ceil(length / 512) * 512; assert.ok(offset + 512 <= tar.length);
    }
    const header = tar.subarray(offset, offset + 512); header[156] = 50; header.fill(0, 157, 257); header.write("../../outside", 157);
    header.fill(32, 148, 156); const checksum = [...header].reduce((sum, b) => sum + b, 0).toString(8).padStart(6, "0"); header.write(checksum + "\0 ", 148);
    save(path, tar); const s = read("summary.json"), hash = sha256(tar); s.apps.aspnet.contextArchiveSha256 = hash; s.apps.aspnet.image.contextArchiveSha256 = hash; save("summary.json", s);
    const result = await verify(); failed(result); assert.ok(result.issues.some((i) => i.at === "aspnet/source"));
  } finally { writeFileSync(join(folder, path), old); writeFileSync(join(folder, "summary.json"), oldSummary); }
});

async function addWindow({ redirects = false } = {}) {
  const app = "corten", source = "fixture", stage = "steady", pass = 1, dir = `measurement/${app}/${source}/${stage}-${pass}`;
  const cpus = cpuSettings({ CATALOG_APP_CPUS: "0", CATALOG_LOAD_CPUS: "1-4", CATALOG_API_CPUS: "5-6" });
  const timing = summary.timing = { schema: "mixed-native-measurement/v1", nativeProfile: summary.options.profile, planSha256: plan.sha256,
    cpus, calibrationPolicy, resourceCoveragePolicy, qualified: false, calibrated: false, complete: false, comparisonEligible: false, timingBlocked: true,
    sourceAudits: Object.fromEntries(inventory.map((a) => [a, { eligible: false, failure: "missing-or-invalid-independent-native-source-audit" }])),
    cells: Object.fromEntries(inventory.map((a) => [a, Object.fromEntries(["fixture", "api"].map((s) => [s, {
      qualification: null, calibration: null, passes: [1, 2, 3].map((pass) => ({ pass, outcome: "not-run", metrics: null })),
    }]))])) };
  const warmups = [], captures = [], requestArtifacts = [], warmupCaptures = [], cycleCaptures = [];
  for (const phase of ["warmup", "cycle"]) {
    let clock = 0;
    for (let i = 0; i < (phase === "warmup" ? 1 : 3); i++) {
      const observations = [];
      const captured = await loadCycle({ ...transport(source, { redirects }), app, source, plan, records, settings: summary.options,
        now: () => ++clock, save: async (request, value) => {
          if (!value.incomplete) { const path = `${dir}/${phase}_${i}/${request.id}.json`; save(path, value); observations.push(structuredClone(value)); if (phase === "cycle") requestArtifacts.push(ref(path)); }
        } });
      const path = `${dir}/${phase}_${i}/capture.json`; save(path, captured);
      (phase === "warmup" ? warmupCaptures : cycleCaptures).push(ref(path));
      (phase === "warmup" ? warmups : captures).push({ ...captured, observations });
    }
  }
  // The worker writes operations concurrently; the runner references artifacts in plan order.
  requestArtifacts.sort((a, b) => {
    const ap = /cycle_(\d+)\/request_(\d+)/.exec(a.path), bp = /cycle_(\d+)\/request_(\d+)/.exec(b.path); return Number(ap[1]) - Number(bp[1]) || Number(ap[2]) - Number(bp[2]);
  });
  const window = { schema: "mixed-native-window/v1", app, source, seconds: 1, elapsedMs: 1100, startedUnixMs: 100000, finishedUnixMs: 101100,
    complete: true, failure: null, orphans: [], eventLoopLagP99Ms: 1, warmup: { passed: true, cycles: 1, elapsedMs: 1000 },
    cycles: captures.map((c, cycle) => ({ cycle, passed: c.passed, operations: c.operations, oracle: c.oracle })) };
  const startupObservation = { id: "startup", path: "/marketplace/records/item_1", mode: "normal", requests: 0, completed: 0, cancelled: 0, pending: 0, events: [] };
  const manifest = upstreamManifest(plan, source, startupObservation, [...warmups.map((c, i) => upstreamPhase("warmup", i, c.capture, source)), ...captures.map((c, i) => upstreamPhase("cycle", i, c.capture, source))]);
  const ledger = { schema: "mixed-native-upstream-ledger/v1", sealed: true, sealedUnixMs: 101101, snapshotUnixMs: 101602, wireIdentity: "w3c-trace-id", orphans: [],
    operations: manifest.map((m, i) => ({ id: m.id, path: m.path, mode: m.mode, traceId: (i + 1).toString(16).padStart(32, "0"), requests: 0, completed: 0, cancelled: 0, pending: 0, events: [] })) };
  const admission = { nativePausedUnixMs: 101102, settleMs: 500 }, reconciliation = reconcileLedger(ledger, manifest); assert.ok(reconciliation.valid, JSON.stringify({ failed: reconciliation.cells.find((c) => !c.passed), row: captures[0].capture.results[0].upstream, op: ledger.operations[2] })); window.upstreamReconciliation = reconciliation;
  const participantsBefore = {}, participantsAfter = {}, names = {}, samples = {}, statsSamples = {}, statsSummary = {}, boundaries = {};
  for (const [index, role] of ["app", "upstream", "load"].entries()) {
    names[role] = `${summary.runId}-${stage}-${pass}-${app}-${source}${role === "app" ? "" : role === "upstream" ? "-up" : "-worker"}`;
    const cpu = cpus[role === "upstream" ? "api" : role],
      startedAt = new Date(window.startedUnixMs - summary.options.warmup * 1000 - 1000).toISOString(), id = String(index + 1).repeat(64);
    const p = participantsBefore[role] = { role, id, imageId: role === "app" ? summary.apps[app].image.id : role === "upstream" ? summary.tools.nodeImage : summary.tools.browserImage,
      startedAt, state: { StartedAt: startedAt, Running: true, OOMKilled: false, Paused: false, ExitCode: 0 },
      config: { env: role === "app" ? [`MARKETPLACE_SOURCE=${source}`, "PROFILE="] : [], memory: role === "upstream" ? 512 * 1024 ** 2 : role === "load" ? 2 * 1024 ** 3 : 1024 ** 3, nanoCpus: cpu.quota * 1e9,
        cpuset: cpu.cpuset, networkMode: role === "load" ? `container:${"1".repeat(64)}` : "private-network" } };
    participantsAfter[role] = structuredClone(p); if (role === "app") participantsAfter[role].state.Paused = true;
    statsSamples[names[role]] = [100000, 100500, 101000, 101500].map((t) => ({ t, cpu: 10, mem: 64 })); statsSummary[names[role]] = summarizeSamples(statsSamples[names[role]]);
  }
  for (const [side, t] of [["before", 99999], ["after", 101501]]) {
    const raw = Object.values(names).map((Name) => JSON.stringify({ Name, CPUPerc: "10%", MemUsage: "64MiB / 1GiB" })).join("\n");
    const receipt = { startedUnixMs: t - 1, receivedUnixMs: t, raw }; save(`${dir}/resource-${side}.json`, receipt);
    boundaries[side] = { ...receipt, samples: Object.fromEntries(Object.values(names).map((n) => [n, [{ t, cpu: 10, mem: 64 }]])) };
  }
  for (const role of Object.keys(names)) samples[role] = mergeResourceSamples(boundaries.before.samples[names[role]], statsSamples[names[role]], boundaries.after.samples[names[role]]);
  const raw = { schema: "mixed-native-window-receipt/v1", app, source, stage, pass, planSha256: plan.sha256, imageId: summary.apps[app].image.id, nativeProfile: summary.options.profile,
    hostElapsedMs: 1600,
    window, participantsBefore, participantsAfter, counters: Object.fromEntries(Object.keys(names).map((role) => [role, { before: 0, after: role === "app" ? 100000 : 20000 }])),
    samples, startupObservation, finalUpstreamLedger: ledger, admission, upstreamReconciliation: reconciliation, resourceBoundaries: boundaries,
    requestArtifacts, warmupCaptures, cycleCaptures };
  save(`${dir}/window.json`, window); save(`${dir}/warmup.json`, window.warmup); save(`${dir}/upstream-ledger.json`, ledger);
  save(`${dir}/final-upstream-ledger.json`, { admission, ledger }); save(`${dir}/resource-boundaries.json`, boundaries);
  save(`${dir}/stats.log.json`, { samples: statsSamples, summary: statsSummary });
  save(`${dir}/stats.log`, Buffer.from(Object.values(names).flatMap((Name) => statsSamples[Name].map(() => JSON.stringify({ Name, CPUPerc: "10%", MemUsage: "64MiB / 1GiB" }))).join("\n") + "\n"));
  save(`${dir}/settings.json`, { plan, records, app, source, settings: summary.options, seconds: 1, warmup: 1, tailSeconds: summary.options.tailSeconds,
    maxCycles: summary.options.maxCycles, folder: `/out/${dir}`, startupObservation, base: "http://127.0.0.1:8080",
    upstream: `http://${summary.runId}-${stage}-${pass}-${app}-${source}-up:8080`, readbackPath: "/api/alerts" });
  save(`${dir}/receipt.json`, raw);
  const metrics = deriveWindow({ ...raw, captures, warmups, plan, records, quotas: Object.fromEntries(Object.entries(cpus).map(([r, c]) => [r === "api" ? "upstream" : r, observedCpuCeiling(c)])) });
  timing.cells.corten.fixture.passes[0] = { pass: 1, outcome: "measured", artifact: ref(`${dir}/receipt.json`), metrics, stats: statsSummary };
  const actualProbes = qualificationProbes(source), q = qualifyProbes(actualProbes, source);
  const qualification = { schema: "mixed-native-qualification/v1", app, source, imageId: summary.apps[app].image.id, nativeProfile: summary.options.profile,
    profile: q.profile, eligible: q.eligible, failure: null, cells: q.cells, missing: q.missing,
    probes: Object.fromEntries(Object.entries(actualProbes).map(([key, value]) => [key, { sha256: sha256(JSON.stringify(value)),
      ...(value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)
        .filter(([k]) => ["status", "ms", "bodyLength", "closedMs", "timedOutMs", "timedOut", "error"].includes(k))) : {}) }])),
    rawProbeSha256: sha256(JSON.stringify(actualProbes)) };
  save(`measurement/${app}/${source}/qualification/qualification.json`, qualification);
  timing.cells.corten.fixture.qualification = { eligible: true, failure: null, missing: [], artifact: ref(`measurement/${app}/${source}/qualification/qualification.json`) };
  save("summary.json", summary); return dir;
}

test("saved windows rederive metrics and retain v1 proof blockers despite asserted qualification", async () => {
  await setup();
  const old = readFileSync(join(folder, "summary.json")), dir = await addWindow();
  try {
    const result = await verify(); assert.equal(result.verdict, "blocked", JSON.stringify(result.issues));
    assert.equal(result.measurement.cells.corten.fixture.passes[0].primaryAttempts, 66);
    assert.ok(result.issues.some((i) => i.code === "v1-qualification-raw-probes-not-retained"));
    assert.ok(result.issues.some((i) => i.code === "independent-native-source-audit-missing"));
    assert.equal(result.comparisonEligible, false);
    await changed("summary.json", (s) => { s.timing.cells.corten.fixture.passes[0].metrics.primaryAttempts++; }, failed);
    await changed("summary.json", (s) => { s.timing.cells.corten.fixture.aggregate = { primaryHttpP99Ms: { median: 0, min: 0, max: 0 } }; }, failed);
    for (const mutate of [
      (r) => { r.counters.app.after = -1; }, (r) => { r.samples.load[1].t = -1; },
      (r) => { r.finalUpstreamLedger.operations.pop(); }, (r) => { r.participantsAfter.app.id = "f".repeat(64); },
      (r) => { r.requestArtifacts[0].path = "../outside.json"; }, (r) => { r.requestArtifacts.push(r.requestArtifacts[0]); },
      (r) => { r.cycleCaptures[0].sha256 = "0".repeat(64); },
    ]) {
      const receiptPath = `${dir}/receipt.json`, receipt = readFileSync(join(folder, receiptPath)), savedSummary = readFileSync(join(folder, "summary.json"));
      try { const r = JSON.parse(receipt); mutate(r); save(receiptPath, r); const s = read("summary.json"); s.timing.cells.corten.fixture.passes[0].artifact = ref(receiptPath); save("summary.json", s); failed(await verify()); }
      finally { writeFileSync(join(folder, receiptPath), receipt); writeFileSync(join(folder, "summary.json"), savedSummary); }
    }
    await changed(`${dir}/cycle_0/${plan.requests.find((r) => r.source === "fixture").id}.json`, (v) => { v.operation.primaryMs = 900; }, failed);
  } finally {
    writeFileSync(join(folder, "summary.json"), old); summary.timing = null;
    const target = resolve(folder, "measurement"); assert.equal(dirname(target), resolve(folder)); rmSync(target, { recursive: true });
  }
});

test("CLI has fixed read-only arguments and machine-readable failed verdict", async () => {
  await setup();
  const cli = join(repo, "bench/mixed-production/verify.mjs");
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: "utf8", windowsHide: true });
  assert.equal(run(["--folder", folder, "--round", "w91", "--commit", commit, "--write"]).status, 1);
  const result = run(["--folder", join(folder, "missing"), "--round", "w91", "--commit", commit]);
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).verdict, "failed");
  assert.equal(run(["--round", "w91", "--folder", folder, "--commit", commit]).status, 1);
});

const probeChild = (code, env = {}) => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: repo, encoding: "utf8", windowsHide: true,
    timeout: 60000, maxBuffer: 4 * 1024 ** 2, env: { ...process.env, ...env } });
  assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
};

test("review mixed-slash UNC is rejected before any lstat", () => {
  const result = probeChild(`import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    let calls=0; fs.lstatSync=()=>{calls++;throw Error('must not touch network path')}; syncBuiltinESMExports();
    const {validateSaved}=await import(${JSON.stringify(new URL("./verify.mjs", import.meta.url).href)});
    const results=[]; for (const folder of ${JSON.stringify(["/\\host\\share", "\\/host/share", "//host/share", "\\\\host\\share", "\\\\?\\UNC\\host\\share"])}) {
      calls=0; const result=await validateSaved({folder,round:'w91',commit:${JSON.stringify(commit)}}); results.push({calls,verdict:result.verdict});
    } console.log(JSON.stringify(results));`);
  assert.deepEqual(result, Array.from({ length: 5 }, () => ({ calls: 0, verdict: "failed" })));
});

test("review invalid API and CLI identities never echo canaries", async () => {
  for (const [round, identity] of [["PRIVATE-ROUND-CANARY", commit], ["w91", "PRIVATE-COMMIT-CANARY"], [{ secret: "PRIVATE-ROUND-CANARY" }, commit]]) {
    const result = await validateSaved({ folder: "unused", round, commit: identity });
    assert.equal(result.verdict, "failed"); assert.doesNotMatch(JSON.stringify(result), /PRIVATE-/);
  }
  const child = spawnSync(process.execPath, [join(repo, "bench/mixed-production/verify.mjs"), "--folder", "unused", "--round", "PRIVATE-ROUND-CANARY", "--commit", "PRIVATE-COMMIT-CANARY"], { encoding: "utf8", windowsHide: true });
  assert.equal(child.status, 1); assert.doesNotMatch(child.stdout + child.stderr, /PRIVATE-/);
});

function localGit(cwd, args, input) {
  const result = spawnSync("git", args, { cwd, input, encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function smallRound(dir, identity) {
  mkdirSync(dir);
  const options = parseArgs(["w91"]); options.apps = inventory;
  const s = { schema: "mixed-native-run/v1", group: "mixed-production", round: "w91", runId: "mixed-w91-12345678", inventory,
    apps: Object.fromEntries(inventory.map((app) => [app, {}])), options, definition: definition("mixed-production"), retainedFamilies,
    contractSha256: contractSha256("mixed-production"), provenance: { commit: identity, dirty: "", fixtureSha256: sha256(JSON.stringify(records)), nativeSource: { commit: identity, dirty: false } } };
  for (const [name, data] of [["summary", s], ["marketplace", records], ["plan", plan]]) writeFileSync(join(dir, `${name}.json`), JSON.stringify(data));
}
function objectInventory(dir) {
  const files = [];
  const walk = (path) => { for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name); if (entry.isDirectory()) walk(full); else files.push([relative(dir, full), sha256(readFileSync(full))]);
  } };
  walk(dir); return files.sort((a, b) => a[0].localeCompare(b[0]));
}
test("review immutable Git ignores replacements and never lazy-fetches or writes trace files", async (t) => {
  for (const kind of ["replacement", "promisor"]) await t.test(kind, () => {
    const root = mkdtempSync(join(tmpdir(), "mixed-offline-git-")), source = join(root, "source"); mkdirSync(source);
    try {
      localGit(source, ["init", "--template="]);
      writeFileSync(join(source, "source.txt"), "original immutable bytes\n"); localGit(source, ["add", "source.txt"]);
      localGit(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"]);
      const identity = localGit(source, ["rev-parse", "HEAD"]), oid = localGit(source, ["rev-parse", "HEAD:source.txt"]);
      let cwd = source;
      if (kind === "replacement") {
        const replacement = localGit(source, ["hash-object", "-w", "--stdin"], "replacement-canary\n");
        localGit(source, ["replace", oid, replacement]);
      } else {
        cwd = join(root, "partial"); localGit(root, ["clone", "--no-hardlinks", "--no-checkout", source, cwd]);
        localGit(cwd, ["config", "remote.origin.promisor", "true"]);
        localGit(cwd, ["config", "remote.origin.partialclonefilter", "blob:none"]);
        const target = join(cwd, ".git", "objects", oid.slice(0, 2), oid.slice(2));
        assert.ok(relative(root, target).startsWith("partial")); rmSync(target);
      }
      const saved = join(root, "saved"), objects = join(cwd, ".git", "objects"), trace = join(root, "trace.json"); smallRound(saved, identity);
      const before = objectInventory(objects);
      const result = probeChild(`import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
        const real=cp.spawnSync; let replaced=false, gitCalls=0;
        cp.spawnSync=(name,args,options)=>{ const result=real(name,args,name==='git'?{...options,cwd:${JSON.stringify(cwd)}}:options);
          if(name==='git'){gitCalls++;if(args.includes('cat-file'))replaced=result.stdout?.includes(Buffer.from('replacement-canary'))??false;} return result;};
        syncBuiltinESMExports(); const {validateSaved}=await import(${JSON.stringify(new URL("./verify.mjs", import.meta.url).href)});
        const result=await validateSaved({folder:${JSON.stringify(saved)},round:'w91',commit:${JSON.stringify(identity)}});
        console.log(JSON.stringify({replaced,gitCalls,verdict:result.verdict}));`, { GIT_TRACE2_EVENT: trace });
      assert.ok(result.gitCalls >= 3, "probe must reach the actual cat-file read");
      assert.equal(result.replaced, false, "replacement bytes must never be read as the original object");
      assert.deepEqual(objectInventory(objects), before, "saved verification must not fetch/write missing Git objects");
      assert.equal(readdirSync(root).includes("trace.json"), false, "inherited Git tracing must not write a file");
    } finally {
      const rel = relative(resolve(tmpdir()), resolve(root)); assert.ok(rel.startsWith("mixed-offline-git-") && !/[\\/]/.test(rel)); rmSync(root, { recursive: true });
    }
  });
});

test("review response proof and executed identities cannot inherit normalized positive flags", async (t) => {
  await setup();
  const originals = new Map(), preserve = (path) => { if (!originals.has(path)) originals.set(path, readFileSync(join(folder, path))); };
  const page = plan.requests.find((r) => r.source === "fixture" && r.category === "page");
  try {
    for (const [app, mutate] of [
      ["corten", (v) => { v.evidence.redactedNativeDOM = "<!DOCTYPE html>"; }],
      ["aspnet", (v) => { v.evidence.redactedNativeDOM = "<!DOCTYPE html><html><body>wrong page</body></html>"; }],
      ["express", (v) => { const p = v.evidence.stages.find((s) => s.stage === "primary"); p.decodedBodyBytes = 0; p.decodedBodySha256 = "0".repeat(64); }],
      ["fastapi", (v) => { const p = v.evidence.stages.find((s) => s.stage === "primary"); p.decodedBodyBytes = 0; p.decodedBodySha256 = sha256(Buffer.alloc(0)); }],
      ["topcoat", (v) => { delete v.evidence.redactedNativeDOM; }],
    ]) {
      const path = `${app}/fixture/${page.id}.json`; preserve(path); const v = read(path); mutate(v); save(path, v);
    }
    preserve("summary.json"); const s = read("summary.json");
    s.apps.django.sources.fixture.container.imageId = `sha256:${"f".repeat(64)}`;
    delete s.apps.gin.sources.fixture.container;
    s.apps.spring.sources.fixture.container.running = false; s.apps.spring.sources.fixture.container.exitCode = 137;
    save("summary.json", s);
    const result = await verify(), passed = Object.fromEntries(["corten", "aspnet", "express", "django", "gin", "spring", "fastapi", "topcoat"].map((app) =>
      [app, result.apps[app].cells.find((c) => c.requestId === page.id).passed]));
    t.diagnostic(JSON.stringify({ functionalPassed: result.functionalPassed, passed }));
    assert.equal(result.functionalPassed, false); assert.ok(Object.values(passed).every((p) => p === false));
    assert.ok(result.issues.some((i) => i.kind === "failed" && i.at === "django/fixture/execution"));
    assert.ok(result.issues.some((i) => i.kind === "failed" && i.at === "spring/fixture/execution"));
    assert.ok(result.issues.some((i) => i.kind === "blocked" && i.code === "functional-executed-container-not-retained"));
  } finally { for (const [path, body] of originals) writeFileSync(join(folder, path), body); }
});

test("review malformed qualifications are invalid rather than unsupported proof", async (t) => {
  await setup(); const old = readFileSync(join(folder, "summary.json")); await addWindow();
  try {
    const original = read("measurement/corten/fixture/qualification/qualification.json"), s = read("summary.json");
    for (const [app, mutate] of [["corten", (q) => { q.probes = 42; }], ["express", (q) => { q.rawProbeSha256 = "invalid-hash"; }], ["django", (q) => { q.cells = { unrecognized: "passed" }; }]]) {
      const q = structuredClone(original); q.app = app; mutate(q);
      const path = `measurement/${app}/fixture/qualification/qualification.json`; save(path, q);
      s.timing.cells[app].fixture.qualification = { eligible: q.eligible, failure: q.failure, missing: q.missing, artifact: ref(path) };
    }
    save("summary.json", s); const result = await verify();
    const invalid = ["corten", "express", "django"].map((app) => result.issues.some((i) => i.kind === "failed" && i.at === `${app}/fixture/qualification`));
    t.diagnostic(JSON.stringify({ invalid })); assert.ok(result.measurement, "must reach measurement replay"); assert.deepEqual(invalid, [true, true, true]);
  } finally {
    writeFileSync(join(folder, "summary.json"), old); summary.timing = null;
    const target = resolve(folder, "measurement"); assert.equal(dirname(target), resolve(folder)); rmSync(target, { recursive: true });
  }
});

test("review window HTTP counts and host elapsed time must match physical stage facts", async (t) => {
  await setup(); const old = readFileSync(join(folder, "summary.json")), dir = await addWindow();
  try {
    const baseline = await verify();
    assert.equal(baseline.verdict, "blocked"); assert.equal(baseline.measurement?.cells.corten.fixture.passes[0]?.nativeHttpResponses, 174);
    const paths = ["summary.json", `${dir}/receipt.json`, `${dir}/window.json`], saved = new Map(paths.map((path) => [path, readFileSync(join(folder, path))]));
    await t.test("HTTP count", async () => { try {
      const receipt = read(`${dir}/receipt.json`), s = read("summary.json"), window = read(`${dir}/window.json`);
      for (const [index, cycle] of window.cycles.entries()) {
        for (const operation of cycle.operations) operation.nativeHttpResponses = 999999;
        const capturePath = `${dir}/cycle_${index}/capture.json`; saved.set(capturePath, readFileSync(join(folder, capturePath)));
        const capture = read(capturePath); for (const operation of capture.operations) operation.nativeHttpResponses = 999999;
        save(capturePath, capture); receipt.cycleCaptures[index] = ref(capturePath);
        for (const request of plan.requests.filter((r) => r.source === "fixture")) {
          const requestPath = `${dir}/cycle_${index}/${request.id}.json`; saved.set(requestPath, readFileSync(join(folder, requestPath)));
          const actual = read(requestPath); actual.operation.nativeHttpResponses = 999999; save(requestPath, actual);
          receipt.requestArtifacts.find((r) => r.path === requestPath).sha256 = ref(requestPath).sha256;
        }
      }
      receipt.window = window;
      save(`${dir}/window.json`, window); save(`${dir}/receipt.json`, receipt);
      const slot = s.timing.cells.corten.fixture.passes[0]; slot.artifact = ref(`${dir}/receipt.json`); slot.metrics.nativeHttpResponses = 65999934; save("summary.json", s);
      const count = await verify(); t.diagnostic(JSON.stringify({ acceptedCount: count.measurement?.cells.corten.fixture.passes[0]?.nativeHttpResponses }));
      assert.ok(count.issues.some((i) => i.kind === "failed" && i.at === "corten/fixture/steady-1")); failed(count);
    } finally { for (const [path, body] of saved) writeFileSync(join(folder, path), body); } });
    await t.test("negative host elapsed", async () => { const receipt = read(`${dir}/receipt.json`); receipt.hostElapsedMs = -1; save(`${dir}/receipt.json`, receipt);
    const s = read("summary.json"); s.timing.cells.corten.fixture.passes[0].artifact = ref(`${dir}/receipt.json`); save("summary.json", s);
    const result = await verify(); assert.ok(result.issues.some((i) => i.kind === "failed" && i.at === "corten/fixture/steady-1")); failed(result); });
  } finally {
    writeFileSync(join(folder, "summary.json"), old); summary.timing = null;
    const target = resolve(folder, "measurement"); assert.equal(dirname(target), resolve(folder)); rmSync(target, { recursive: true });
  }
});

async function withSavedFiles(paths, fn) {
  const saved = new Map(paths.map((path) => [path, readFileSync(join(folder, path))]));
  try { await fn(); }
  finally { for (const [path, body] of saved) writeFileSync(join(folder, path), body); }
}

async function withWindow(fn, options) {
  await setup();
  const old = readFileSync(join(folder, "summary.json"));
  try { await fn(await addWindow(options)); }
  finally {
    writeFileSync(join(folder, "summary.json"), old); summary = JSON.parse(old);
    const target = resolve(folder, "measurement"); assert.equal(dirname(target), resolve(folder)); rmSync(target, { recursive: true });
  }
}

test("semantic qualification slots distinguish malformed present outcomes from absent and recorded failures", async () => {
  await withWindow(async () => {
    const s = read("summary.json"), malformed = [42, [], "malformed", {}, { eligible: "yes" }, { eligible: false, failure: "arbitrary-failure" }];
    malformed.forEach((slot, index) => { s.timing.cells[inventory[index]].fixture.qualification = slot; });
    s.timing.cells[inventory[6]].fixture.qualification = { eligible: false, failure: "native-qualification-execution-failed" };
    delete s.timing.cells[inventory[7]].fixture.qualification;
    s.timing.cells[inventory[8]].fixture.qualification = null;
    save("summary.json", s);
    const result = await verify(); failed(result);
    malformed.forEach((slot, index) => {
      const app = inventory[index];
      assert.equal(result.measurement.cells[app].fixture.outcomes.qualification, "invalid-outcome", JSON.stringify(slot));
      assert.ok(result.issues.some((i) => i.kind === "failed" && i.at === `${app}/fixture/qualification`));
      assert.ok(!result.issues.some((i) => i.at === `${app}/fixture` && i.code === "qualification-not-run"));
    });
    assert.equal(result.measurement.cells[inventory[6]].fixture.outcomes.qualification, "reported-failed");
    assert.ok(result.issues.some((i) => i.kind === "blocked" && i.at === `${inventory[6]}/fixture` && i.code === "qualification-reported-failed"));
    for (const app of inventory.slice(7)) {
      assert.equal(result.measurement.cells[app].fixture.outcomes.qualification, "not-run");
      assert.ok(result.issues.some((i) => i.kind === "blocked" && i.at === `${app}/fixture` && i.code === "qualification-not-run"));
      assert.ok(!result.issues.some((i) => i.kind === "failed" && i.at === `${app}/fixture/qualification`));
    }
    assert.equal(result.measurement.qualified, false);
  });
});

test("semantic hash-only qualification facts require exclusive native variants and integer lengths", async () => {
  await withWindow(async () => {
    const s = read("summary.json"), original = read("measurement/corten/fixture/qualification/qualification.json"), hash = "a".repeat(64);
    const malformed = [
      ["page", { sha256: hash, timedOut: true, error: "ECONNRESET", ms: 1 }],
      ["page", { sha256: hash, status: 200, ms: 1, bodyLength: 0.5 }],
      ["slow", { sha256: hash, timedOut: true, ms: 1, bodyLength: 0 }],
      ["page", { sha256: hash, timedOut: false, ms: 1 }],
      ["page", { sha256: hash, status: 200, closedMs: 1 }],
      ["unfinishedHead", { sha256: hash, closedMs: 1, timedOutMs: 2 }],
      ["unfinishedHead", { sha256: hash, closedMs: 0.5 }],
      ["unfinishedHead", { sha256: hash, closedMs: 1, error: "ECONNRESET" }],
    ];
    for (const [index, [key, probe]] of malformed.entries()) {
      const app = inventory[index], q = structuredClone(original), path = `measurement/${app}/fixture/qualification/qualification.json`;
      q.app = app; q.probes = { [key]: probe }; save(path, q);
      s.timing.cells[app].fixture.qualification = { eligible: q.eligible, missing: q.missing, failure: q.failure, artifact: ref(path) };
    }
    // Well-shaped retained native variants still lack original replayable probes.
    const app = inventory[8], q = structuredClone(original), path = `measurement/${app}/fixture/qualification/qualification.json`;
    q.app = app; q.probes = { page: { sha256: hash, status: 200, ms: 1, bodyLength: 2 }, bigHead: { sha256: hash, error: "ECONNRESET", ms: 1 },
      slow: { sha256: hash, timedOut: true, ms: 1 }, unfinishedHead: { sha256: hash, closedMs: 1 },
      cap: { sha256: hash }, liveness: { sha256: hash }, form: { sha256: hash } };
    save(path, q); s.timing.cells[app].fixture.qualification = { eligible: q.eligible, missing: q.missing, failure: q.failure, artifact: ref(path) };
    save("summary.json", s);
    const result = await verify(); failed(result);
    for (const index of malformed.keys()) assert.ok(result.issues.some((i) => i.kind === "failed" && i.at === `${inventory[index]}/fixture/qualification`), JSON.stringify(malformed[index]));
    assert.ok(!result.issues.some((i) => i.kind === "failed" && i.at === `${app}/fixture/qualification`));
    assert.ok(result.issues.some((i) => i.kind === "blocked" && i.code === "v1-qualification-raw-probes-not-retained" && i.at === `${app}/fixture`));
    assert.equal(result.measurement.cells[app].fixture.qualification, null); assert.equal(result.measurement.qualified, false);
  });
});

test("semantic window participants must predate observation and have a coherent running exit state", async (t) => {
  await withWindow(async (dir) => {
    const path = `${dir}/receipt.json`;
    for (const [name, mutate] of [
      ["started after window", (r) => {
        for (const side of ["participantsBefore", "participantsAfter"]) for (const p of Object.values(r[side]))
          p.startedAt = p.state.StartedAt = new Date(r.window.finishedUnixMs + 1).toISOString();
      }],
      ["running with exit 137", (r) => { for (const side of ["participantsBefore", "participantsAfter"]) r[side].app.state.ExitCode = 137; }],
    ]) await t.test(name, async () => withSavedFiles(["summary.json", path], async () => {
      const r = read(path), s = read("summary.json"); mutate(r); save(path, r);
      s.timing.cells.corten.fixture.passes[0].artifact = ref(path); save("summary.json", s);
      const result = await verify(); failed(result);
      assert.ok(result.issues.some((i) => i.kind === "failed" && i.at === "corten/fixture/steady-1"));
      assert.equal(result.measurement.cells.corten.fixture.passes[0], null);
    }));
    await t.test("missing exit proof stays blocked, not invented", async () => withSavedFiles(["summary.json", path], async () => {
      const r = read(path), s = read("summary.json"); delete r.participantsBefore.app.state.ExitCode; save(path, r);
      s.timing.cells.corten.fixture.passes[0].artifact = ref(path); save("summary.json", s);
      const result = await verify(); assert.equal(result.verdict, "blocked", JSON.stringify(result.issues));
      assert.ok(result.issues.some((i) => i.code === "participant-exit-proof-not-retained"));
      assert.equal(result.measurement.cells.corten.fixture.passes[0].primaryAttempts, 66); assert.equal(result.comparisonEligible, false);
    }));
  });
});

test("semantic primary latency must fit its clock span even when all saved copies and metrics agree", async () => {
  await withWindow(async (dir) => {
    const path = `${dir}/receipt.json`, receipt = read(path), window = read(`${dir}/window.json`);
    for (const [index, cycle] of window.cycles.entries()) {
      const capturePath = `${dir}/cycle_${index}/capture.json`, capture = read(capturePath);
      for (const operation of cycle.operations) {
        operation.primaryStartedMs = operation.finishedMs; operation.primaryMs = operation.journeyMs;
        assert.ok(operation.primaryMs > 0);
        const rawPath = `${dir}/cycle_${index}/${operation.requestId}.json`, actual = read(rawPath);
        actual.operation.primaryStartedMs = operation.primaryStartedMs; actual.operation.primaryMs = operation.primaryMs;
        actual.evidence.stages.find((s) => s.stage === "primary").elapsedMs = operation.primaryMs; save(rawPath, actual);
        receipt.requestArtifacts.find((r) => r.path === rawPath).sha256 = ref(rawPath).sha256;
        const copied = capture.operations.find((o) => o.requestId === operation.requestId);
        copied.primaryStartedMs = operation.primaryStartedMs; copied.primaryMs = operation.primaryMs;
      }
      save(capturePath, capture); receipt.cycleCaptures[index] = ref(capturePath);
    }
    receipt.window = window; save(`${dir}/window.json`, window); save(path, receipt);
    const captures = receipt.cycleCaptures.map(({ path }, index) => ({ ...read(path), observations: plan.requests.filter((r) => r.source === "fixture")
      .map((r) => read(`${dir}/cycle_${index}/${r.id}.json`)) })), warmups = receipt.warmupCaptures.map(({ path }) => read(path));
    const s = read("summary.json"), slot = s.timing.cells.corten.fixture.passes[0]; slot.artifact = ref(path);
    // Keep the unchanged derivation and every dependent summary self-consistent;
    // only the verifier's independent physical clock check can reject this input.
    slot.metrics = deriveWindow({ ...receipt, captures, warmups, plan, records,
      quotas: Object.fromEntries(Object.entries(s.timing.cpus).map(([role, cpu]) => [role === "api" ? "upstream" : role, observedCpuCeiling(cpu)])) });
    assert.equal(slot.metrics.eligible, true); assert.ok(slot.metrics.primaryHttpLatency.p99Ms > 0); save("summary.json", s);
    const result = await verify(); failed(result);
    assert.ok(result.issues.some((i) => i.kind === "failed" && i.at === "corten/fixture/steady-1"));
    assert.equal(result.measurement.cells.corten.fixture.passes[0], null);
  });
});

test("semantic genuine unsent drops remain oracle-valid recorded failures, not invalid evidence", async () => {
  await setup();
  const request = plan.requests.find((r) => r.source === "fixture" && r.method === "GET"),
    path = `corten/fixture/${request.id}.json`, capturePath = "corten/fixture/capture.json", combinedPath = "corten-capture.json";
  await withSavedFiles(["summary.json", path, capturePath, combinedPath], async () => {
    const actual = read(path), source = read(capturePath), combined = read(combinedPath), s = read("summary.json");
    actual.row = unsent(request, "dropped"); actual.evidence = { requestId: request.id, source: request.source, gaps: [], stages: [] };
    source.capture.results[request.index] = actual.row; actual.check = checkCell(plan, source.capture, records, request); save(path, actual);
    assert.deepEqual(actual.check, { passed: false, error: null });
    Object.assign(source.cells.find((c) => c.requestId === request.id), { outcome: "dropped", status: 0, passed: false, error: null, gaps: [] }); save(capturePath, source);
    combined.results[request.index] = actual.row; save(combinedPath, combined); s.apps.corten.oracle = oracle(plan, combined, records);
    assert.equal(s.apps.corten.oracle.valid, true); assert.equal(s.apps.corten.oracle.result.functionalPassed, false);
    Object.assign(s.apps.corten.cells.find((c) => c.requestId === request.id), { outcome: "dropped", status: 0, passed: false, error: null, gaps: [] });
    s.functionalPassed = false; save("summary.json", s);
    const before = objectInventory(folder), result = await verify(); assert.deepEqual(objectInventory(folder), before);
    assert.equal(result.verdict, "blocked", JSON.stringify(result.issues)); assert.equal(result.functionalPassed, false); assert.equal(result.comparisonEligible, false);
    const cell = result.apps.corten.cells.find((c) => c.requestId === request.id);
    assert.equal(cell.outcome, "dropped"); assert.equal(cell.passed, false); assert.ok(cell.reasons.includes("native-outcome-not-successful"));
    assert.ok(!cell.reasons.includes("raw-request-evidence-invalid"));
  });
});

test("closure replay dependencies are commit-bound, including a changed executable stats helper", async (t) => {
  await setup();
  const probe = (mutate) => probeChild(`
    import fs from 'node:fs'; import {registerHooks,syncBuiltinESMExports} from 'node:module';
    import {fileURLToPath} from 'node:url'; import {resolve,relative} from 'node:path';
    const root=${JSON.stringify(repo)}, stats=${JSON.stringify(join(repo, "bench/catalog/stats.mjs"))}, loaded=new Set(), reads=new Set();
    let verifying=false; const real=fs.readFileSync, original=real(stats,'utf8'), changed=original.replace('cpuMaxPct: Math.max(...samples.map((s) => s.cpu))','cpuMaxPct: 123456');
    if(changed===original)throw Error('mutation not installed');
    fs.readFileSync=(path,...args)=>{const p=path instanceof URL?fileURLToPath(path):String(path); if(verifying)reads.add(resolve(p));
      if(${mutate} && resolve(p)===stats)return typeof real(path,...args)==='string'?changed:Buffer.from(changed);
      return real(path,...args);};syncBuiltinESMExports();
    registerHooks({load(url,ctx,next){if(url.startsWith('file:'))loaded.add(fileURLToPath(url));
      const result=next(url,ctx);if(${mutate} && url===${JSON.stringify(new URL("../catalog/stats.mjs", import.meta.url).href)})return {...result,source:changed};return result;}});
    const {validateSaved}=await import(${JSON.stringify(new URL("./verify.mjs", import.meta.url).href)});
    verifying=true;const result=await validateSaved({folder:${JSON.stringify(folder)},round:'w91',commit:${JSON.stringify(commit)}});verifying=false;
    const {summarizeSamples}=await import(${JSON.stringify(new URL("../catalog/stats.mjs", import.meta.url).href)});
    const missing=[...loaded].filter(p=>p!==${JSON.stringify(join(repo, "bench/mixed-production/verify.mjs"))}&&!reads.has(resolve(p))).map(p=>relative(root,p));
    console.log(JSON.stringify({verdict:result.verdict,missing,sourceFailure:result.issues.some(i=>i.kind==='failed'&&i.at==='replay-source'),
      measurement:result.measurement,cpuMaxPct:summarizeSamples([{cpu:10,mem:64}]).cpuMaxPct}));
  `);
  await t.test("all loaded replay modules are checked", () => {
    const result = probe(false); assert.equal(result.verdict, "blocked"); assert.deepEqual(result.missing, []); assert.equal(result.cpuMaxPct, 10);
  });
  await t.test("changed stats bytes fail before replay", () => {
    const result = probe(true); assert.equal(result.cpuMaxPct, 123456); assert.equal(result.sourceFailure, true);
    assert.equal(result.verdict, "failed"); assert.equal(result.measurement, null);
  });
});

function rewriteWindowClocks(dir, mutate) {
  const path = `${dir}/receipt.json`, receipt = read(path), window = read(`${dir}/window.json`);
  for (const [index, cycle] of window.cycles.entries()) {
    mutate(cycle.operations, index);
    const cp = `${dir}/cycle_${index}/capture.json`, captured = read(cp);
    for (const op of cycle.operations) {
      const p = `${dir}/cycle_${index}/${op.requestId}.json`, actual = read(p);
      for (const key of ["startedMs", "primaryStartedMs", "finishedMs"]) actual.operation[key] = op[key];
      save(p, actual); receipt.requestArtifacts.find((ref) => ref.path === p).sha256 = ref(p).sha256;
      Object.assign(captured.operations.find((r) => r.requestId === op.requestId), op);
    }
    save(cp, captured); receipt.cycleCaptures[index] = ref(cp);
  }
  receipt.window = window; save(`${dir}/window.json`, window); save(path, receipt);
  const s = read("summary.json"), slot = s.timing.cells.corten.fixture.passes[0]; slot.artifact = ref(path);
  const captures = receipt.cycleCaptures.map(({ path }, index) => ({ ...read(path), observations: plan.requests.filter((r) => r.source === "fixture")
    .map((r) => read(`${dir}/cycle_${index}/${r.id}.json`)) }));
  slot.metrics = deriveWindow({ ...receipt, captures, warmups: receipt.warmupCaptures.map(({ path }) => read(path)), plan, records,
    quotas: Object.fromEntries(Object.entries(s.timing.cpus).map(([role, cpu]) => [role === "api" ? "upstream" : role, observedCpuCeiling(cpu)])) });
  assert.equal(slot.metrics.primaryAttempts, 66); assert.equal(slot.metrics.eligible, true); save("summary.json", s);
}

test("serial window cycles and each native client must preserve monotonic operation chronology", async (t) => {
  await withWindow(async (dir) => {
    const original = new Map(objectInventory(folder).filter(([path]) => path.startsWith(dir + "/") || path === "summary.json")
      .map(([path]) => [path, readFileSync(join(folder, path))]));
    for (const [name, mutate] of [
      ["cycles cannot reuse the same clock interval", (ops) => {
        const offset = Math.min(...ops.map((o) => o.startedMs)) - 1;
        for (const op of ops) for (const key of ["startedMs", "primaryStartedMs", "finishedMs"]) op[key] -= offset;
      }],
      ["a client's next request cannot start before its previous request ends", (ops, index) => {
        if (index !== 0) return;
        const requests = plan.requests.filter((r) => r.source === "fixture" && r.client === 0),
          first = ops.find((o) => o.requestId === requests[0].id), second = ops.find((o) => o.requestId === requests[1].id);
        const offset = second.startedMs - first.startedMs;
        for (const key of ["startedMs", "primaryStartedMs", "finishedMs"]) second[key] -= offset;
      }],
    ]) await t.test(name, async () => {
      try {
        rewriteWindowClocks(dir, mutate); const result = await verify(); failed(result);
        assert.ok(result.issues.some((i) => i.kind === "failed" && i.at === "corten/fixture/steady-1"));
        assert.equal(result.measurement.cells.corten.fixture.passes[0], null);
      } finally { for (const [path, body] of original) writeFileSync(join(folder, path), body); }
    });
  });
});

test("qualification execution facts reject contradictions while absent native proof stays blocked", async () => {
  await withWindow(async (dir) => {
    const s = read("summary.json"), original = read("measurement/corten/fixture/qualification/qualification.json"),
      receipt = read(`${dir}/receipt.json`), participants = { app: receipt.participantsBefore.app, upstream: receipt.participantsBefore.upstream };
    const variants = [
      (p) => { p.app.imageId = `sha256:${"f".repeat(64)}`; },
      (p) => { p.app.state.Running = false; p.app.state.ExitCode = 137; },
      (p) => { p.upstream = 42; },
      (p) => { p.upstream.id = p.app.id; },
      (p) => { p.app.config.env = ["MARKETPLACE_SOURCE=api", "PROFILE="]; },
      (p) => { delete p.app.state.ExitCode; },
      () => {},
    ];
    for (const [index, mutate] of variants.entries()) {
      const app = inventory[index], q = structuredClone(original), path = `measurement/${app}/fixture/qualification/qualification.json`, p = structuredClone(participants);
      mutate(p); q.app = app; save(path, q);
      s.timing.cells[app].fixture.qualification = { eligible: true, failure: null, missing: [], artifact: ref(path), ...(index === 6 ? {} : { participants: p }) };
    }
    save("summary.json", s); const result = await verify(); failed(result);
    for (const app of inventory.slice(0, 5)) assert.ok(result.issues.some((i) => i.kind === "failed" && i.at === `${app}/fixture/qualification`), app);
    for (const app of inventory.slice(5, 7)) {
      assert.ok(!result.issues.some((i) => i.kind === "failed" && i.at === `${app}/fixture/qualification`));
      assert.ok(result.issues.some((i) => i.kind === "blocked" && i.code === "qualification-participant-proof-not-retained" && i.at === `${app}/fixture`));
      assert.equal(result.measurement.cells[app].fixture.qualification, null);
    }
    assert.equal(result.measurement.qualified, false); assert.equal(result.comparisonEligible, false);
  });
});

test("closed window slots reject malformed present outcomes before artifact-less handling", async () => {
  await withWindow(async () => {
    const s = read("summary.json"), malformed = [
      { outcome: "PRIVATE-UNKNOWN-WINDOW", metrics: null },
      { outcome: "measured", metrics: { eligible: true } },
      { outcome: "failed", metrics: { eligible: true } },
      { outcome: "not-run", metrics: null, artifact: { path: "untrusted", sha256: "a".repeat(64) } },
      42, [], {},
    ];
    for (const [index, slot] of malformed.entries()) {
      s.timing.cells[inventory[index]].fixture.calibration = slot;
      s.timing.cells[inventory[index]].api.passes[0] = slot && typeof slot === "object" && !Array.isArray(slot) ? { ...slot, pass: 1 } : slot;
    }
    s.timing.cells[inventory[7]].fixture.calibration = { outcome: "failed", metrics: null };
    save("summary.json", s); const result = await verify(); failed(result);
    for (const app of inventory.slice(0, malformed.length)) for (const at of [`${app}/fixture/calibration-0`, `${app}/api/steady-1`])
      assert.ok(result.issues.some((i) => i.kind === "failed" && i.at === at), at);
    assert.ok(result.issues.some((i) => i.kind === "blocked" && i.code === "calibration-failed" && i.at === `${inventory[7]}/fixture/0`));
    assert.equal(result.measurement.cells[inventory[7]].fixture.outcomes.calibration, "failed");
    assert.ok(!JSON.stringify(result).includes("PRIVATE-UNKNOWN-WINDOW")); assert.equal(result.comparisonEligible, false);
  });
});

test("transaction qualification reconciliation cannot publish a derived success from a failed gate", async () => {
  await withWindow(async (dir) => {
    const s = read("summary.json"), receipt = read(`${dir}/receipt.json`);
    for (const app of inventory) for (const source of ["fixture", "api"]) {
      const probes = qualificationProbes(source), q = qualifyProbes(probes, source),
        path = `measurement/${app}/${source}/qualification/qualification.json`;
      assert.equal(q.eligible, true);
      save(path, { schema: "mixed-native-qualification/v1", app, source, imageId: s.apps[app].image.id,
        nativeProfile: s.options.profile, profile: q.profile, cells: q.cells, missing: q.missing, eligible: q.eligible,
        failure: null, probes, rawProbeSha256: sha256(JSON.stringify(probes)) });
      const participants = { app: structuredClone(receipt.participantsBefore.app), upstream: structuredClone(receipt.participantsBefore.upstream) };
      participants.app.imageId = s.apps[app].image.id;
      participants.app.config.env = [`MARKETPLACE_SOURCE=${source}`, `PROFILE=${s.options.profile === "matched" ? "matched" : ""}`];
      s.timing.cells[app][source].qualification = { eligible: false, failure: "native-production-qualification-failed", missing: [], artifact: ref(path), participants };
    }
    save("summary.json", s);
    const result = await verify(); assert.equal(result.verdict, "failed");
    assert.equal(result.issues.filter((i) => i.kind === "failed" && i.at.endsWith("/qualification")).length, inventory.length * 2);
    assert.equal(result.measurement.qualified, false, "failed reconciliation must not qualify the group");
    for (const app of inventory) for (const source of ["fixture", "api"]) {
      const cell = result.measurement.cells[app][source];
      assert.equal(cell.qualification, null); assert.equal(cell.outcomes.qualification, "invalid-outcome");
    }
    assert.equal(result.comparisonEligible, false);

    // The same original probes may be published only after all retained copies
    // agree. This synthetic control still cannot remove native v1 proof blockers.
    for (const app of inventory) for (const source of ["fixture", "api"])
      Object.assign(s.timing.cells[app][source].qualification, { eligible: true, failure: null });
    s.timing.qualified = true; save("summary.json", s);
    const control = await verify(); assert.equal(control.verdict, "blocked"); assert.equal(control.measurement.qualified, true);
    assert.ok(!control.issues.some((i) => i.kind === "failed" && i.at.endsWith("/qualification")));
    for (const app of inventory) for (const source of ["fixture", "api"]) {
      assert.equal(control.measurement.cells[app][source].qualification.eligible, true);
      assert.equal(control.measurement.cells[app][source].outcomes.qualification, "reported-eligible");
    }
    assert.equal(control.comparisonEligible, false);
  });
});

test("lifetimes every retained HTTP stage must fit its monotonic operation lifetime", async (t) => {
  await withWindow(async (dir) => {
    const request = plan.requests.find((r) => r.source === "fixture" && r.method === "POST"), receiptPath = `${dir}/receipt.json`;
    await t.test("coherent redirect, discovery and readback clocks remain replayable but blocked", async () => {
      const actual = read(`${dir}/cycle_0/${request.id}.json`), result = await verify();
      assert.equal(actual.row.status, 303); assert.ok(actual.evidence.stages.some((s) => s.stage === "native-redirect"));
      assert.equal(result.verdict, "blocked"); assert.equal(result.measurement.cells.corten.fixture.passes[0].eligible, true);
      assert.equal(result.comparisonEligible, false);
    });
    const variants = [
      ...["form-discovery", "state-before", "native-redirect", "state-after", "state-readback"].map((stage) =>
        [stage, "cycle", (actual) => { actual.evidence.stages.find((s) => s.stage === stage).elapsedMs = 100000; }]),
      ["serial preparation total cannot exceed its pre-primary span", "cycle", (actual) => {
        const { startedMs, primaryStartedMs, finishedMs } = actual.operation, stages = actual.evidence.stages,
          index = stages.findIndex((s) => s.stage === "primary"), before = stages.slice(0, index), after = stages.slice(index),
          span = primaryStartedMs - startedMs, spare = finishedMs - primaryStartedMs - after.reduce((n, s) => n + s.elapsedMs, 0);
        assert.equal(before.length, 2); assert.ok(span > 0 && spare > 0);
        for (const step of before) step.elapsedMs = (span + Math.min(span, spare) / 2) / before.length;
        assert.ok(before.every((s) => s.elapsedMs <= span));
        assert.ok(stages.reduce((n, s) => n + s.elapsedMs, 0) < actual.operation.journeyMs);
      }],
      ["serial primary/redirect/readback total cannot exceed its post-primary span", "cycle", (actual) => {
        const { startedMs, primaryStartedMs, finishedMs, primaryMs } = actual.operation, stages = actual.evidence.stages,
          index = stages.findIndex((s) => s.stage === "primary"), before = stages.slice(0, index), after = stages.slice(index + 1),
          span = finishedMs - primaryStartedMs, spare = primaryStartedMs - startedMs - before.reduce((n, s) => n + s.elapsedMs, 0);
        assert.equal(after.length, 3); assert.ok(span > primaryMs && spare > 0);
        for (const step of after) step.elapsedMs = (span + Math.min(span, spare) / 2 - primaryMs) / after.length;
        assert.ok(after.every((s) => s.elapsedMs <= span));
        assert.ok(stages.reduce((n, s) => n + s.elapsedMs, 0) < actual.operation.journeyMs);
      }],
      ["warmup HTTP steps obey the same lifetime gate", "warmup", (actual) => {
        actual.evidence.stages.find((s) => s.stage === "state-readback").elapsedMs = 100000;
      }],
    ];
    for (const [name, phase, mutate] of variants) {
      const path = `${dir}/${phase}_0/${request.id}.json`;
      await t.test(name, async () => withSavedFiles(["summary.json", receiptPath, path], async () => {
        const actual = read(path), receipt = read(receiptPath); mutate(actual); save(path, actual);
        const artifact = receipt.requestArtifacts.find((r) => r.path === path);
        if (phase === "cycle") { assert.ok(artifact); artifact.sha256 = ref(path).sha256; } else assert.equal(artifact, undefined);
        save(receiptPath, receipt);
        const s = read("summary.json"); s.timing.cells.corten.fixture.passes[0].artifact = ref(receiptPath); save("summary.json", s);
        const result = await verify(); assert.equal(result.verdict, "failed", "contradictory HTTP work must be invalid, not merely blocked");
        assert.ok(result.issues.some((i) => i.kind === "failed" && i.at === "corten/fixture/steady-1"));
        assert.equal(result.measurement.cells.corten.fixture.passes[0], null);
        assert.equal(result.measurement.cells.corten.fixture.outcomes.passes[0], "invalid-outcome");
        assert.equal(result.comparisonEligible, false);
      }));
    }
    await t.test("phase lifetime is a numeric monotonic duration, not a coercible string", async () => {
      const windowPath = `${dir}/window.json`, warmupPath = `${dir}/warmup.json`;
      await withSavedFiles(["summary.json", receiptPath, windowPath, warmupPath], async () => {
        const window = read(windowPath), receipt = read(receiptPath), s = read("summary.json");
        window.warmup.elapsedMs = String(window.warmup.elapsedMs); receipt.window = window;
        save(windowPath, window); save(warmupPath, window.warmup); save(receiptPath, receipt);
        s.timing.cells.corten.fixture.passes[0].artifact = ref(receiptPath); save("summary.json", s);
        const result = await verify(); assert.equal(result.verdict, "failed");
        assert.ok(result.issues.some((i) => i.kind === "failed" && i.at === "corten/fixture/steady-1"));
        assert.equal(result.measurement.cells.corten.fixture.passes[0], null);
      });
    });
  }, { redirects: true });
});
