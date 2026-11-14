// Harness unit tests, not application captures or evidence of native parity.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { candidates, emptyCells, parseOptions, publicURL, publicInput, publishPort, transportOf, validateTargets, nativeFailures, alertsFromReadback } from "./contract.mjs";
import { createBrowserPlan } from "../workloads/browser.mjs";
import { records } from "../marketplace/fixtures.mjs";
import { createUpstream, upstreamDelta } from "./upstream.mjs";
import { observeNetwork, architecture, classifyDisabledPreloads } from "./observe.mjs";
import { readStore, waitForSemanticChange } from "./journey.mjs";
import { imageEvidence, captureLiveInputs } from "./run.mjs";
import { replayLiveInputs, replayPrerequisite, nativeAttemptCells, validateContextReceipts, validateCaseParticipant } from "./verify.mjs";
import { sha256 } from "./contract.mjs";
import { nativeBuildArgs } from "./build.mjs";
import { navigationDestination, normalizeSvelteKitCase } from "./navigation.mjs";
import { missingAction } from "./probes.mjs";
import { discoverReactEndpoint } from "./bindings.mjs";

// Explicit local Docker/Chromium integration, separate from portable units.
// A witnessed failed prerequisite is a complete selected attempt, not a pass
// for a marketplace app or for the still-incomplete registry matrix.
test("native caller v2 replays actual failed-start cleanup and rejects missing browser terminal receipts", { skip: !process.env.NATIVE_CALLER_IMAGE, timeout: 180000 }, async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path"), { tmpdir } = await import("node:os"), { randomUUID } = await import("node:crypto");
  const { chromium } = await import("@playwright/test");
  const { command, OwnedDocker } = await import("./run.mjs"), { validateSaved } = await import("./verify.mjs");
  const { EvidenceStore } = await import("./native-evidence.mjs");
  const { captureSource, captureTools } = await import("./native-source.mjs");
  const { ExecutionLedger } = await import("./native-execution.mjs");
  const { captureSources } = await import("../workloads/isolated/contract.mjs");
  const { schema, settings, retainedFamilies } = await import("./contract.mjs");
  const { exportBrowserCaptures } = await import("./capture.mjs");
  const commit = await command("git", ["rev-parse", "HEAD"]), source = captureSources(commit);
  const folder = mkdtempSync(join(tmpdir(), "browser-native-caller-")), task = `browser-${randomUUID().slice(0, 12)}`;
  const startedAt = Date.now(), store = new EvidenceStore(folder), ledger = new ExecutionLedger(store, { task, commit, startedAt }), owned = new OwnedDocker(task, ledger);
  let browser, cleaned = false;
  try {
    const app = "nextjs", profile = plan.cases[0], fixture = records(), image = JSON.parse(await command("docker", ["image", "inspect", process.env.NATIVE_CALLER_IMAGE]))[0];
    const targets = { [app]: { image: image.Id, readback: { path: "/api/alerts" } } };
    const native = { schema: "native-browser-run/v2", source: store.record("source", captureSource(store, commit)), sourceBinding: store.record("source-binding", source),
      inputsBefore: store.record("inputs-before", captureLiveInputs(store, source)), inputsAfter: null, toolsBefore: null, toolsAfter: null,
      execution: null, targets: store.record("targets", targets), contexts: [], browserTerminal: null, manifest: null };
    const summary = { schema, group: "fullstack-browser", startedAt: new Date(startedAt).toISOString(), task, effectivePlan: plan, settings,
      code: { commit, dirty: false, status: "", runnerFiles: Object.fromEntries((await import("node:fs")).readdirSync(new URL("./", import.meta.url)).filter((p) => p.endsWith(".mjs")).sort()
        .map((p) => [p, sha256(readFileSync(new URL(p, import.meta.url)))])), runnerDiffSha256: sha256("") },
      fixtureSha256: sha256(JSON.stringify(fixture)), targetsSha256: sha256(JSON.stringify(targets)),
      host: { hostname: "native-caller-apparatus", platform: process.platform, release: "native-control", node: process.version },
      options: { round: "w1", targets: "targets.json", out: folder, apps: [app], cases: [profile.key], build: false },
      images: { [app]: { ...imageEvidence(image, commit), sourceTreeSha256: sha256(await command("git", ["ls-tree", "-r", "HEAD", "--", "bench/fullstack/apps/nextjs"])) } },
      builds: {}, bindingArtifacts: {}, browser: null, cells: emptyCells(plan), complete: true, qualificationPassed: false, readyForLoad: false, limits: ["Actual prerequisite/cleanup apparatus, not app qualification"],
      retainedFamilies: retainedFamilies.map((f) => ({ ...f, outcome: "not-run", reason: "Retained; not replaced by native browser diagnostics" })), failures: [], cleanupFailures: [], native };
    owned.record({ event: "created", kind: "image", id: image.Id, owned: false });
    await assert.rejects(owned.start(task, ["--cpus", "1", "--memory", "1g", "--entrypoint", "/native-caller-missing-command"], image.Id, [], { role: "application", app, case: profile.key }));
    assert.equal(owned.containers.size, 1, "Failed start must retain original ID for cleanup");
    Object.assign(summary.cells[app].find((c) => c.case === profile.key), { outcome: "failed", reason: "Native start was rejected", qualificationPassed: false });
    browser = await chromium.launch({ headless: true });
    const executable = chromium.executablePath();
    native.toolsBefore = store.record("tools-before", captureTools(store, { browserExecutable: executable }));
    summary.browser = { engine: "chromium", version: browser.version(), playwright: JSON.parse(readFileSync(new URL("node_modules/@playwright/test/package.json", new URL("../../", import.meta.url)))).version,
      executable, executableSha256: sha256(readFileSync(executable)), launch: { headless: true } };
    native.browserTerminal = { closeStartedAt: Date.now(), contextsBefore: [], disconnectedAt: null, closeCompletedAt: null, connectedAfter: null };
    browser.on("disconnected", () => { native.browserTerminal.disconnectedAt = Date.now(); });
    await browser.close(); native.browserTerminal.closeCompletedAt = Date.now(); native.browserTerminal.connectedAfter = browser.isConnected(); browser = null;
    summary.cleanupFailures.push(...await owned.cleanup());
    assert.deepEqual(summary.cleanupFailures, []);
    cleaned = true;
    native.inputsAfter = store.record("inputs-after", captureLiveInputs(store, source));
    native.toolsAfter = store.record("tools-after", captureTools(store, { browserExecutable: executable }));
    native.execution = ledger.finish({ endedAt: Date.now() }); native.manifest = store.seal();
    const save = () => {
      const exported = exportBrowserCaptures(summary, fixture);
      mkdirSync(join(folder, "captures"), { recursive: true });
      for (const [name, capture] of Object.entries(exported.captures)) writeFileSync(join(folder, `captures/${name}.json`), JSON.stringify(capture, null, 2) + "\n");
      writeFileSync(join(folder, "captures/manifest.json"), JSON.stringify(exported.manifest, null, 2) + "\n");
      summary.strictCaptureExport = { manifest: "captures/manifest.json", functionalPassed: false, readyForLoad: false };
      summary.finishedAt = new Date().toISOString(); writeFileSync(join(folder, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
      writeFileSync(join(folder, "marketplace.json"), JSON.stringify(fixture));
    };
    save(); const result = await validateSaved({ folder, round: "w1", commit });
    assert.deepEqual(result.invalid, []); assert.equal(result.selectedComplete, true, JSON.stringify(result));
    assert.equal(result.cleanupComplete, true); assert.equal(result.attemptComplete, false); assert.equal(result.qualificationPassed, false); assert.equal(result.expectedExitCode, 1);
    assert.deepEqual(result.blocked, ["matrix-incomplete"]); assert.ok(result.hostSubject?.participants.some((p) => p.role === "application" && p.window === null));
    const terminal = native.browserTerminal; native.browserTerminal = { ...terminal, disconnectedAt: null }; save();
    const missing = await validateSaved({ folder, round: "w1", commit });
    assert.equal(missing.selectedComplete, false); assert.equal(missing.cleanupComplete, false); assert.equal(missing.hostSubject, null);
    native.browserTerminal = terminal; save();
    t.diagnostic(JSON.stringify({ selectedComplete: result.selectedComplete, qualificationPassed: result.qualificationPassed, blocked: result.blocked, files: native.manifest.files.length,
      missingTerminalBlocked: missing.blocked }));
  } finally {
    if (browser) await browser.close();
    if (!cleaned) { const errors = await owned.cleanup(); assert.deepEqual(errors, []); }
    rmSync(folder, { recursive: true });
  }
});

const req = (options = {}) => ({ method: () => "GET", headers: () => ({}), isNavigationRequest: () => false,
  url: () => "http://127.0.0.1/marketplace/en-US/item_2", resourceType: () => "fetch", postData: () => "", ...options });
const plan = createBrowserPlan({ records: records() });

test("native prerequisite dispositions require exact bounded command and terminal witnesses", () => {
  const app = "nextjs", key = plan.cases[0].key, id = "a".repeat(64);
  const cell = { case: key, outcome: "failed", qualificationPassed: false, evidence: null, reason: "not authority" };
  const summary = { options: { build: true }, builds: { [app]: { passed: false } }, images: { [app]: { id: "sha256:" + "b".repeat(64) } } };
  const build = { seq: 0, operation: "build", role: "artifact", app, case: null, id: null, code: 1 };
  const execution = { commands: [build], participants: [] };
  assert.deepEqual(replayPrerequisite(cell, app, summary, execution, new Set([app])), { prerequisite: "native-build-rejected", command: 0 });
  for (const changed of [{ ...build, code: 0 }, { ...build, app: "nuxt" }, { ...build, role: "application" }, { ...build, case: key }])
    assert.equal(replayPrerequisite(cell, app, summary, { ...execution, commands: [changed] }, new Set([app])), null);
  assert.equal(replayPrerequisite(cell, app, summary, execution, new Set()), null);
  assert.equal(replayPrerequisite({ ...cell, outcome: "unsupported" }, app, summary, execution, new Set([app])), null);
  const create = { seq: 1, operation: "create", role: "application", app, case: key, id: null, code: 1 };
  assert.equal(replayPrerequisite(cell, app, summary, { ...execution, commands: [create] }, new Set()).prerequisite, "native-create-rejected");
  const start = { ...create, seq: 2, operation: "start", id }, participant = { id, role: "application", app, case: key, imageId: summary.images[app].id, window: null, terminal: { state: { Status: "created" } } };
  const failedStart = { commands: [{ ...create, code: 0, id }, start], participants: [participant] };
  assert.equal(replayPrerequisite(cell, app, summary, failedStart, new Set()).prerequisite, "native-start-rejected");
  for (const changed of [{ ...failedStart, commands: failedStart.commands.slice(1) }, { ...failedStart, commands: [...failedStart.commands, start] },
    { ...failedStart, participants: [] }, { ...failedStart, participants: [{ ...participant, window: { startedAt: 1, endedAt: 2 } }] },
    { ...failedStart, participants: [{ ...participant, terminal: null }] }])
    assert.equal(replayPrerequisite(cell, app, summary, changed, new Set()), null);
});

test("native selected completeness never substitutes for whole matrix or missing proof", () => {
  const app = "nextjs", key = plan.cases[0].key;
  const summary = { options: { apps: [app], cases: [key] }, cells: { [app]: [{ case: key, qualificationPassed: false }] } };
  const row = { app, case: key, outcome: "failed", blocked: [], derived: { prerequisite: "native-start-rejected", command: 2 } };
  assert.deepEqual(nativeAttemptCells([row], summary)[0], { ...row, selected: true, attemptComplete: true, qualificationPassed: false, disposition: "observed-prerequisite-failure" });
  for (const changed of [{ ...row, derived: null }, { ...row, blocked: ["missing-proof"] }])
    assert.equal(nativeAttemptCells([changed], summary)[0].disposition, "proof-missing");
  assert.equal(nativeAttemptCells([{ ...row, app: "nuxt" }], summary)[0].disposition, "not-selected");
});

test("native context terminal observations require unique context and actual close chronology", () => {
  const execution = { executionWindow: { startedAt: 1, endedAt: 20 }, processWindows: [{ app: "nextjs", case: plan.cases[0].key, startedAt: 2, endedAt: 15 }] };
  const context = { id: "own-context", role: "application", app: "nextjs", case: plan.cases[0].key, source: "fixture", createStartedAt: 3, createdAt: 4,
    closeStartedAt: 10, closeEventAt: 11, closeCompletedAt: 12, absentAfter: true };
  const terminal = { closeStartedAt: 16, disconnectedAt: 17, closeCompletedAt: 18, connectedAfter: false, contextsBefore: [] };
  assert.equal(validateContextReceipts([context], terminal, execution), true);
  assert.throws(() => validateContextReceipts([context, context], terminal, execution));
  for (const changed of [{ ...context, absentAfter: false }, { ...context, closeEventAt: null }, { ...context, createdAt: 1 }, { ...context, closeCompletedAt: 16 }])
    assert.equal(validateContextReceipts([changed], terminal, execution), false);
  assert.equal(validateContextReceipts([context], { ...terminal, contextsBefore: [context.id] }, execution), false);
});

test("native journey identity must match its original execution participant and process window", () => {
  const app = "nextjs", key = plan.cases[0].key;
  const p = { containerId: "a".repeat(64), imageId: "sha256:" + "b".repeat(64), startedAt: "native-start", stillSameProcess: true };
  const participant = { id: p.containerId, imageId: p.imageId, role: "application", app, case: key, window: { startedAt: 1, endedAt: 10 },
    terminal: { state: { Running: true, StartedAt: p.startedAt }, restartCount: 0 } };
  const execution = { participants: [participant], processWindows: [{ app, case: key, startedAt: 2, endedAt: 9 }] };
  assert.equal(validateCaseParticipant(app, key, { provenance: p }, execution), true);
  for (const changed of [{ ...p, containerId: "c".repeat(64) }, { ...p, imageId: "sha256:" + "c".repeat(64) }, { ...p, startedAt: "transplanted" }])
    assert.throws(() => validateCaseParticipant(app, key, { provenance: changed }, execution));
  assert.equal(validateCaseParticipant(app, key, { provenance: p }, { ...execution, participants: [] }), false);
  assert.equal(validateCaseParticipant(app, key, { provenance: p }, { ...execution, participants: [{ ...participant, terminal: null }] }), false);
  for (const changed of [{ ...execution, participants: [participant, participant] },
    { ...execution, processWindows: [{ app, case: key, startedAt: 0, endedAt: 9 }] },
    { ...execution, participants: [{ ...participant, terminal: { ...participant.terminal, restartCount: 1 } }] }])
    assert.throws(() => validateCaseParticipant(app, key, { provenance: p }, changed));
});
test("native caller retains all bound inputs including imported helpers and non-module files", () => {
  const paths = ["bench/mixed-production/immutable-git.mjs", "bench/workloads/isolated/evidence.mjs", "scripts/steady.mjs", "README.md"];
  const files = paths.map((path) => ({ path, sha256: sha256(readFileSync(new URL(`../../${path}`, import.meta.url))) }));
  const bodies = new Map(), store = { blob(body) {
    const ref = { path: `native-evidence/blobs/${sha256(body)}`, bytes: body.length, sha256: sha256(body) };
    bodies.set(ref.path, Buffer.from(body)); return ref;
  } };
  const rows = captureLiveInputs(store, { files }), reader = { json: () => rows, read: (ref) => bodies.get(ref.path) };
  assert.deepEqual(rows.map((r) => r.path), paths, "Imported/non-.mjs sources must not disappear behind runnerFiles");
  assert.deepEqual(replayLiveInputs(reader, null, { files }), rows);
  for (const mutate of [
    (r) => r.pop(), (r) => r.reverse(), (r) => { r[0].canonicalSha256 = "0".repeat(64); },
    (r) => { r[0].body = store.blob(Buffer.from("substituted helper")); }, (r) => { r[0].extra = true; },
  ]) {
    const changed = structuredClone(rows); mutate(changed);
    assert.throws(() => replayLiveInputs({ ...reader, json: () => changed }, null, { files }));
  }
  const normalized = files.map((f) => ({ ...f, sha256: sha256(bodies.get(rows.find((r) => r.path === f.path).body.path).toString("utf8").replaceAll("\r\n", "\n")) }));
  const crlf = rows.map((r) => ({ ...r, canonicalSha256: normalized.find((f) => f.path === r.path).sha256,
    body: store.blob(Buffer.from(bodies.get(r.body.path).toString("utf8").replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"))) }));
  assert.deepEqual(replayLiveInputs({ ...reader, json: () => crlf }, null, { files: normalized }), crlf);
});
test("React endpoint syntax controls are independent and fail closed", () => {
  const handlerSource = 'async e=>{e.preventDefault();await fetch("/api/marketplace/"+encodeURIComponent(r.id)+"?locale="+l,{method:"POST",body:"safe"});}';
  const observed = { handlerSource, componentSource: `function M({record:r,locale:l}){const submit=${handlerSource};return null}`,
    recordId: "item_2", locale: "fr-FR", action: "http://local/marketplace/fr-FR/item_2", base: "http://local/marketplace/fr-FR/item_2", basis: "mounted-react-onSubmit-and-owning-fiber-props" };
  const result = discoverReactEndpoint([observed]);
  assert.equal(result.path, "/api/marketplace/item_2"); assert.equal(result.locale, "fr-FR"); assert.equal(result.handlerSha256.length, 64);
  for (const source of [handlerSource.replace("POST", "GET"), handlerSource.replace('body:"safe"', 'body:e'), handlerSource.replace("r.id", '"item_1"'),
    handlerSource.replace("/api/marketplace/", "https://attacker.invalid/api/marketplace/"),
    'e=>fetch(unknown(r.id),{method:"POST"})', 'e=>{const r={id:"item_2"};fetch("/api/marketplace/"+r.id+"?locale="+l,{method:"POST"});}']) {
    assert.equal(discoverReactEndpoint([{ ...observed, handlerSource: source, componentSource: `function M({record:r,locale:l}){const submit=${source};return null}` }]), null);
  }
  assert.equal(discoverReactEndpoint([{ ...observed, action: "http://local/marketplace/en-US/item_2" }]), null);
  assert.equal(discoverReactEndpoint([{ ...observed, componentSource: "function M({record:r,locale:l}){return null}" }]), null);
  const nativeCatch = handlerSource.replace('e.preventDefault();await', 'e.preventDefault();try{await').replace(';}', ';}catch(r){console.error(r)}}');
  assert.equal(discoverReactEndpoint([{ ...observed, handlerSource: nativeCatch, componentSource: `function M({record:r,locale:l}){const submit=${nativeCatch};return null}` }]).path, "/api/marketplace/item_2");
});
test("Livewire public input uses independently captured named field models and component identity", () => {
  const request = req({ method: () => "POST", headers: () => ({ "x-livewire": "", "content-type": "application/json" }),
    postData: () => JSON.stringify({ components: [{ snapshot: JSON.stringify({ memo: { id: "actual" }, data: { email: "before@example.test", target: "0", token: "SECRET" } }), updates: { email: "native@example.test", target: "1,25" } }] }) });
  const form = { component: "actual", models: { email: "email", target_price: "target" } };
  assert.deepEqual(publicInput(request, form), { input: { email: "native@example.test", target_price: "1,25" }, components: ["actual"] });
  assert.equal(publicInput(request).input.target_price, null);
  assert.deepEqual(publicInput(request, { ...form, component: "different" }).input, { email: null, target_price: null });
  assert.ok(!JSON.stringify(publicInput(request, form)).includes("SECRET"));
});
test("SvelteKit native data normalization requires successful physical framework payload and transport", () => {
  const request = { id: "observed", method: "GET", path: "/marketplace/fr-FR/item_2/__data.json", status: 200, transport: "router", input: null, components: [],
    resource: "fetch", type: "application/json", nativeData: { framework: "sveltekit", type: "data", nodes: [null, "data"] } };
  const env = { app: "sveltekit", architecture: "sveltekit", js: true };
  assert.equal(navigationDestination(request, env), "/marketplace/fr-FR/item_2");
  for (const change of [{ status: 404 }, { failure: "aborted" }, { transport: "document" }, { resource: "script" }, { type: "text/html" }, { nativeData: null }, { nativeData: { framework: "sveltekit", type: "redirect", nodes: ["data"] } }]) {
    assert.equal(navigationDestination({ ...request, ...change }, env), request.path);
  }
  assert.equal(navigationDestination(request, { ...env, js: false }), request.path);
  assert.equal(navigationDestination(request, { ...env, app: "nextjs" }), request.path);
  const raw = { architecture: "sveltekit", environment: { js: true }, steps: [{ requests: [request] }] };
  const normalized = normalizeSvelteKitCase(structuredClone(raw));
  assert.equal(normalized.steps[0].requests[0].path, "/marketplace/fr-FR/item_2");
  assert.equal(raw.steps[0].requests[0].path, "/marketplace/fr-FR/item_2/__data.json");
  assert.deepEqual(Object.keys(normalized.steps[0].requests[0]).sort(), ["id", "method", "path", "status", "transport", "input", "components"].sort());
  assert.equal(missingAction("/api/marketplace/item_2", "item_2"), "/api/marketplace/item_missing");
  assert.equal(missingAction("/marketplace/fr-FR/item_1", "item_1"), "/marketplace/fr-FR/item_missing");
  assert.throws(() => missingAction("/unrelated/item_2", "item_2"));
});
test("semantic observer preserves document replacement and does not swallow other errors", async () => {
  const transitions = []; let samples = 0;
  await waitForSemanticChange({ evaluate: async () => {
    if (samples++ === 0) throw new Error("Execution context was destroyed, most likely because of a navigation");
    return "new native document";
  } }, "old native document", transitions);
  assert.equal(samples, 2); assert.equal(transitions.length, 1);
  assert.match(transitions[0].error, /Execution context was destroyed/);
  await assert.rejects(waitForSemanticChange({ evaluate: async () => { throw new Error("actual observer failure"); } }, "before"), /actual observer failure/);
});
test("full registry matrix and retained contenders, independent of selected targets", () => {
  const cells = emptyCells(plan);
  assert.equal(candidates.length, 10); assert.equal(plan.cases.length, 24);
  assert.equal(Object.values(cells).flat().length, 240);
  for (const app of ["laravel", "rails", "react-router", "leptos"]) assert.equal(cells[app].length, 24);
  assert.ok(Object.values(cells).flat().every((v) => v.outcome === "not-run" && v.evidence === null && v.qualificationPassed === false));
});
test("explicit round/options fail closed without dropping candidates", () => {
  const options = parseOptions(["w1", "--targets", "targets.json", "--out", "work/w1", "--apps", "nextjs,laravel"]);
  assert.equal(options.round, "w1"); assert.deepEqual(options.apps, ["nextjs", "laravel"]);
  assert.equal(parseOptions(["w2", "--build", "--out", "work/w2"]).build, true);
  for (const args of [["r20"], [], ["w1", "--targets", "a", "--targets", "b"], ["w1", "--targets", "a", "--out", "b", "--apps", "phoenix"]]) assert.throws(() => parseOptions(args));
});
test("build workflow uses all approved native Dockerfiles and honest source labels", () => {
  for (const app of candidates) {
    const build = nativeBuildArgs({ app, repo: "/checkout", task: "browser-abcd", commit: "commit", dirty: true, snapshot: "digest" });
    assert.equal(build.tag, `browser-abcd-${app}`);
    assert.ok(build.args.includes("agent.owner=codex"));
    assert.ok(build.args.includes("run.corten.browser.dirty=true"));
    if (app === "corten") assert.equal(build.context, "/checkout");
    if (app === "sveltekit") assert.match(build.dockerfile, /Dockerfile.marketplace$/);
    assert.ok(!build.args.includes("PROFILE=matched"), "do not silently substitute architecture/profile");
  }
  assert.equal(publishPort("sveltekit"), "127.0.0.1:8080:8080");
  assert.equal(publishPort("nextjs"), "127.0.0.1::8080");
});
test("target manifest cannot substitute endpoints or arbitrary environment", () => {
  const manifest = { schema: "native-fullstack-browser-targets/v1", targets: { nextjs: { image: "cb-marketplace-nextjs" } } };
  assert.equal(validateTargets(manifest).nextjs.image, "cb-marketplace-nextjs");
  for (const readback of [{ path: "//remote/store" }, { path: "/marketplace/en-US/item_1" }, { path: "/store?token=secret" }]) assert.throws(() => validateTargets({ ...manifest, targets: { nextjs: { ...manifest.targets.nextjs, readback } } }));
  assert.throws(() => validateTargets({ ...manifest, targets: { nextjs: { ...manifest.targets.nextjs, environment: {} } } }));
});
test("public ledger strips tokens, request headers, and unknown query fields", () => {
  assert.deepEqual(publicURL("http://local/marketplace/en-US/item_1?seller=Alice&token=SECRET&sort=desc"), { path: "/marketplace/en-US/item_1", query: { seller: "Alice", sort: "desc" } });
  const r = req({ method: () => "POST", headers: () => ({ "content-type": "application/x-www-form-urlencoded", cookie: "SECRET" }), postData: () => "email=a%40b.test&target_price=1.25&_token=SECRET" });
  assert.deepEqual(publicInput(r), { input: { email: "a@b.test", target_price: "1.25" }, components: [] });
  assert.ok(!JSON.stringify(publicInput(r)).includes("SECRET"));
});
test("native transport uses observed request signals, never the framework label", () => {
  assert.equal(transportOf(req({ isNavigationRequest: () => true })), "document");
  assert.equal(transportOf(req({ headers: () => ({ "x-livewire": "" }) })), "livewire");
  assert.equal(transportOf(req({ headers: () => ({ "x-turbo-request-id": "abc" }) })), "turbo");
  assert.equal(transportOf(req({ url: () => "http://local/_next/data/build/marketplace/en-US/item_2.json" })), "router");
  const input = publicInput(req({ method: () => "POST", headers: () => ({ "x-livewire": "", "content-type": "application/json" }),
    postData: () => JSON.stringify({ components: [{ snapshot: JSON.stringify({ memo: { id: "component-a" }, data: { email: "a@b.test", target_price: "1.25", token: "SECRET" } }), updates: { target_price: "0" } }] }) }));
  assert.deepEqual(input, { input: { email: "a@b.test", target_price: "0" }, components: ["component-a"] });
});
test("Blade and controller substitutions cannot qualify Livewire/Hotwire", () => {
  const steps = [{ dom: { native: { components: [], form: { binding: null }, turbo: false } }, action: { kind: "initial" }, requests: [] },
    { action: { kind: "accepted-write", input: {} }, requests: [{ method: "POST", transport: "document", components: [] }] }];
  assert.match(nativeFailures("laravel", { js: true }, steps).join(" "), /Blade is not Livewire/);
  assert.match(nativeFailures("rails", { js: true }, steps).join(" "), /controller document fallback/);
  assert.equal(architecture("laravel", steps[0].dom.native), "blade");
  assert.equal(architecture("rails", steps[0].dom.native), "rails-controller");
  steps[0].dom.native.turbo = true; steps[0].dom.native.turboDisabled = true;
  assert.equal(architecture("rails", steps[0].dom.native), "rails-controller");
  steps[1].requests.push({ method: "POST", transport: "turbo", path: "/unrelated", status: 200 });
  assert.match(nativeFailures("rails", { js: true }, steps).join(" "), /controller document fallback/);
});
test("source commit is not guessed from an image tag or current checkout", () => {
  const image = { Id: "sha256:immutable", RepoDigests: [], Config: { Labels: {} } };
  assert.equal(imageEvidence(image, "commit").imageSourceVerified, false);
  assert.equal(imageEvidence(image, "commit").builtCommit, null);
  image.Config.Labels = { "run.corten.marketplace.commit": "commit", "run.corten.marketplace.dirty": "false" };
  assert.equal(imageEvidence(image, "commit").imageSourceVerified, true);
  assert.equal(imageEvidence(image, "different").imageSourceVerified, false);
});
test("network observer saves measured encoded/decoded bytes and sanitized native inputs", async () => {
  const page = new EventEmitter(), ledger = observeNetwork(page);
  const response = { status: () => 200, headers: () => ({ "content-type": "text/html", "content-encoding": "gzip", "set-cookie": "SECRET" }), body: async () => Buffer.from("actual response") };
  const r = req({ method: () => "POST", isNavigationRequest: () => true,
    headers: () => ({ "content-type": "application/x-www-form-urlencoded" }), postData: () => "email=a%40b.test&target_price=1.25&csrf=SECRET",
    response: async () => response, sizes: async () => ({ responseBodySize: 12, responseHeadersSize: 80 }) });
  response.request = () => r;
  page.emit("request", r); page.emit("response", response); page.emit("requestfinished", r); await ledger.drain();
  assert.deepEqual(ledger.rows[0].bytes, { encodedBody: 12, headers: 80, decodedBody: 15 });
  assert.equal(ledger.rows[0].status, 200); assert.deepEqual(ledger.failures, []);
  assert.ok(!JSON.stringify(ledger.rows).includes("SECRET"));
});
test("uses existing strict no-JS preload classification, retaining CSP/request evidence", () => {
  const rows = [{ path: "/page", resource: "document", hasCsp: false }, { path: "/entry.js", resource: "script", failure: "csp", status: null }];
  const dom = { native: { hasMetaCsp: false, preloads: [{ path: "/entry.js", rel: "modulepreload", as: "" }] } };
  classifyDisabledPreloads(rows, dom, false); assert.equal(rows[1].intentionallyDisabledPreload, true);
  assert.equal(rows[1].failure, "csp"); assert.equal(rows[1].status, null);
  classifyDisabledPreloads(rows, dom, true); assert.equal(rows[1].intentionallyDisabledPreload, false);
  rows[0].hasCsp = true;
  classifyDisabledPreloads(rows, dom, false); assert.equal(rows[1].intentionallyDisabledPreload, false);
});
test("multipart native input is parsed without exposing hidden tokens", async () => {
  const page = new EventEmitter(), ledger = observeNetwork(page);
  const f = new FormData(); f.set("email", "a@b.test"); f.set("target_price", "1,25"); f.set("csrf", "SECRET");
  const wire = new Request("http://local/", { method: "POST", body: f }); const body = Buffer.from(await wire.arrayBuffer());
  page.emit("request", req({ method: () => "POST", headers: () => ({ "content-type": wire.headers.get("content-type") }), postDataBuffer: () => body }));
  await ledger.drain(); assert.deepEqual(ledger.rows[0].input, { email: "a@b.test", target_price: "1,25" });
  assert.ok(!JSON.stringify(ledger.rows).includes("SECRET"));
});
async function listening(server, work) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try { return await work(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}
test("independent upstream counts actual completed reads including 404s", async () => {
  await listening(createUpstream({ item_1: { id: "item_1", numeric: 125 } }), async (base) => {
    const counters = async () => (await fetch(base + "/__browser/counters")).json(); const before = await counters();
    assert.deepEqual(await (await fetch(base + "/marketplace/records/item_1")).json(), { id: "item_1", numeric: 125 });
    assert.equal((await fetch(base + "/marketplace/records/item_missing")).status, 404);
    const delta = upstreamDelta(before, await counters()); assert.equal(delta.started, 2); assert.equal(delta.completed, 2); assert.equal(delta.pending, 0);
  });
});
test("readback reads an independent store and refuses message-shaped success", async () => {
  let store = [];
  const server = createServer((_, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ alerts: store })); });
  const api = { get: async (url) => { const r = await fetch(url); return { status: () => r.status, headers: () => Object.fromEntries(r.headers), json: () => r.json() }; } };
  await listening(server, async (base) => {
    assert.deepEqual((await readStore(base, { path: "/store" }, api)).alerts, []);
    store = [{ item_id: "item_2", email: "a@b.test", target_minor: 125 }];
    assert.deepEqual((await readStore(base, { path: "/store" }, api)).alerts, store);
  });
  assert.equal((await readStore("http://127.0.0.1", null)).outcome, "unsupported");
  assert.throws(() => alertsFromReadback({ message: "Alert set" }));
  assert.deepEqual(alertsFromReadback(store), store);
  await assert.rejects(readStore("http://127.0.0.1", { path: "/store" }), /cookie jar/);
  assert.throws(() => alertsFromReadback({ alerts: [{ item_id: "item_2", email: "a@b.test", target_minor: 125, csrf: "SECRET" }] }));
});
