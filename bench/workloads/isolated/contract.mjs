// Offline binding only. The only subprocesses here are fixed, read-only Git queries.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { contractSha256, definition, groupNames, nativeArtifactRoot, registrySchema, retainedFamilies, selectedApps } from "../registry.mjs";
import { runnerFor } from "../run.mjs";
import { deploymentSha256 } from "../deployments.mjs";
import { coverage } from "../evidence.mjs";
import { evaluateLatestStable, latestStableSources } from "../latest-stable.mjs";
import { cpuSettings, parseArgs as catalogOptions } from "../../catalog/contract.mjs";
import { parseArgs as jsonOptions } from "../../json-api/contract.mjs";
import { placementCpus, placementEnv } from "../../json-api/placement.mjs";
import { parseArgs as marketplaceOptions } from "../../marketplace/run-contract.mjs";
import { nightly } from "../../marketplace/droplet-contract.mjs";
import { parseArgs as mixedOptions } from "../../mixed-production/run.mjs";
import { djangoAsgi, mixedDeploymentArgs, springWebflux } from "../../mixed-production/source-audit.mjs";
import { browserContainers, browserCpus, parseOptions as browserOptions, settings as browserSettings } from "../../fullstack-browser/contract.mjs";
import { createClientWorkload } from "../client.mjs";
import { inventory, portFor, scenarios, settingsFor, workloadFor } from "../../live/native.mjs";
import { fanoutProfile } from "../../live/fanout.mjs";
import { apps as hardeningApps, appSourcePath, budgets, parseArgs as hardeningOptions } from "../../hardening/plan.mjs";
import { clientActorCpus, hardeningActorCpus, liveActorCpus, liveApplication, liveGroup } from "./native-roles.mjs";
import { catalogFleetPlacement, fleetCatalogSlugs, host, jsonFleetPlacementFor, providerCreateHost, portableEvidenceSegment } from "../cloud-contract.mjs";

export const schema = "benchmark-isolated-contract/v1";
export const alternateCampaignPlacements = Object.freeze(fleetCatalogSlugs.regions
  .filter((region) => region !== host.region).map((region) => `dedicated-${region}`));
const root = fileURLToPath(new URL("../../../", import.meta.url));
// New native v2 exposes a pure parser. Older committed runners retain their exact
// reviewed source pin; a missing/invalid dependency inside a present parser fails.
const clientParser = existsSync(new URL("../../client-heavy/contract.mjs", import.meta.url))
  ? await import("../../client-heavy/contract.mjs") : null;
export const clientComparisonRecipe = clientParser?.comparisonProfile;
const git = (args, input) => execFileSync("git", args, { cwd: root, input, windowsHide: true,
  env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
  maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
const loadedCommit = git(["rev-parse", "HEAD"]).toString().trim();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const freeze = (value) => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const clone = (value) => structuredClone(value);
const exact = (value, keys, at) => {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype, `${at}: plain object required`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${at}: missing or unexpected fields`);
};

// These two runners do not export dependency-free option parsers. Their snapshots
// below cannot silently survive a change to their actual default/CLI implementation.
const snapshotPins = freeze({
  ...(!clientParser ? { "bench/client-heavy/run.mjs": "71fc21c81f109b4ae43eb6585c675fe3e9eb49fa526de57ab20e8d4f48edbb8e" } : {}),
  // Native live CLI/defaults are unchanged by the bound Docker teardown gate.
  "bench/live/parity.mjs": "f26375c75b652abc6745ef0a213bac6962786a744481e0d4dc926c68944f53d6",
});
const clientSourceRoots = Object.freeze([...(clientParser?.sourceRoots ?? [])]);
export const sourceRoots = Object.freeze([...new Set(["Cargo.toml", "Cargo.lock", "package.json", "package-lock.json", ".dockerignore", ".gitignore",
  "rust-toolchain.toml", "rust-toolchain", "README.md", "CONTRIBUTING.md", "AGENTS.md", "docs", "bench", "crates", "scripts", "examples/card-market", ...clientSourceRoots])]);
// Native client v2 snapshots every tracked input under its exported roots,
// including historical browser/results files. Those bytes are inputs, not the
// current untracked output. Keep the ordinary result exclusion elsewhere.
const isSource = (path) => clientSourceRoots.some((root) => path === root || path.startsWith(`${root}/`))
  || !path.split("/").some((part) => ["results", "evidence", "work", "node_modules", "target"].includes(part));
export const sharedSourceSha256 = (files) => deploymentSha256(files.filter(({ path }) => isSource(path)));

/** Hash committed Git bytes, not platform-dependent CRLF checkouts. No network or writes. */
export function captureSources(commit, group) {
  const selectors = ["BENCH_APPS", "BENCH_TIER", "BENCH_EDGE", "PROFILE"].filter((key) => process.env[key]);
  assert.equal(selectors.length, 0, `unset legacy selection/profile overrides before binding: ${selectors.join(", ")}`);
  assert.match(commit ?? "", /^[a-f0-9]{40}$/, "full measured commit required");
  assert.equal(git(["rev-parse", "HEAD"]).toString().trim(), commit, "measured commit must be current HEAD");
  assert.equal(commit, loadedCommit, "HEAD changed since module load; reload the contract module");
  const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]).toString();
  assert.equal(status, "", "binding requires a clean committed checkout, including untracked files");
  const entries = git(["ls-tree", "-r", "-z", commit, "--", ...sourceRoots]).toString().split("\0").filter(Boolean)
    .map((row) => {
      const [meta, path] = row.split("\t");
      const [mode, type, blob] = meta.split(" ");
      assert.ok(path && !/[\r\n\\:]/.test(path), "unsafe source path");
      return { mode, type, blob, path };
    }).filter(({ path }) => isSource(path) || group === "hardening" && hardeningApps.some((app) => appSourcePath(app, path)));
  for (const entry of entries) assert.ok(["100644", "100755"].includes(entry.mode) && entry.type === "blob", "source links/submodules are not supported");
  const paths = entries.map((e) => e.path);
  assert.ok(paths.includes("bench/workloads/isolated/contract.mjs"), "isolated contract must itself be committed");
  for (const group of groupNames) assert.ok(paths.includes(runnerFor(group).entry), `missing native runner ${group}`);
  const bytes = git(["cat-file", "--batch"], entries.map((e) => `${e.blob}\n`).join(""));
  let offset = 0;
  const files = entries.map((entry) => {
    const end = bytes.indexOf(10, offset);
    assert.ok(end >= offset, "missing source object header");
    const [blob, type, sizeText] = bytes.subarray(offset, end).toString().split(" ");
    const size = Number(sizeText);
    assert.ok(blob === entry.blob && type === "blob" && Number.isSafeInteger(size) && size >= 0, "source object differs");
    offset = end + 1;
    const body = bytes.subarray(offset, offset + size);
    assert.ok(body.length === size && bytes[offset + size] === 10, "truncated source object");
    offset += size + 1;
    return { path: entry.path, mode: entry.mode, sha256: sha256(body) };
  });
  assert.equal(offset, bytes.length, "extra source bytes");
  for (const [path, hash] of Object.entries(snapshotPins)) assert.equal(files.find((f) => f.path === path)?.sha256, hash,
    `${path}: native option snapshot changed; review/update its adapter, never infer defaults`);
  assert.equal(git(["rev-parse", "HEAD"]).toString().trim(), commit, "HEAD changed while hashing sources");
  assert.equal(git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]).toString(), "", "checkout changed while hashing sources");
  return freeze({ commit, files, sha256: deploymentSha256(files), byteConvention: "committed Git blob bytes (before checkout conversion)" });
}

export const recipes = freeze({
  "native-defaults": [...groupNames],
  "marketplace-short-window": ["localized-marketplace"],
  "mixed-measure": ["mixed-production"],
  "mixed-production-measure": ["mixed-production"],
  [djangoAsgi.recipe]: ["mixed-production"],
  [springWebflux.recipe]: ["mixed-production"],
  "native-feed-measure": ["live-delivery", "recoverable-live"],
  ...(clientComparisonRecipe ? { [clientComparisonRecipe]: ["client-heavy"] } : {}),
});
function request(value) {
  exact(value, ["group", "round", "commit", "recipe"], "request");
  definition(value.group);
  assert.match(value.commit ?? "", /^[a-f0-9]{40}$/, "full measured commit required");
  assert.equal(typeof value.recipe, "string", "recipe must be a string");
  assert.ok(Object.hasOwn(recipes, value.recipe) && recipes[value.recipe].includes(value.group), "recipe is not supported for this group");
  const pattern = value.group === "catalog-page" ? /^c[1-9]\d*$/ : value.group === "json-api" ? /^j[1-9]\d*$/
    : value.group === "localized-marketplace" ? /^[rw][1-9]\d*$/
      : ["mixed-production", "fullstack-browser", "hardening"].includes(value.group) ? /^w[1-9]\d*$/
      : /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
  assert.match(value.round ?? "", pattern, "unsupported or unsafe native round");
  assert.ok(value.round.length <= 64, "round too long");
  assert.ok(!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value.round), "reserved artifact directory name");
  assert.ok(value.group !== "catalog-page" || value.round !== "c1", "historical c1 is reserved");
  // A round is an identity only; this module never allocates or reserves it.
  return clone(value);
}
const selection = (group) => ({ registry: registrySchema, group, contractSha256: contractSha256(group),
  definition: clone(definition(group)), apps: selectedApps(group), retainedFamilies: clone(retainedFamilies) });

function subjectFor(r, sources, campaignMode) {
  assert.ok(campaignMode === "dedicated" || campaignMode === "legacy"
    || alternateCampaignPlacements.includes(campaignMode) && r.group !== "catalog-page"
    || campaignMode === catalogFleetPlacement.loadLayout && r.group === "catalog-page"
    || jsonFleetPlacementFor(r.group, campaignMode), "unknown campaign placement");
  const inputs = Object.fromEntries(Object.entries(latestStableSources).filter(([key]) => key === "policy" || r.group === "client-heavy").map(([key, path]) => {
    const bytes = git(["show", `${r.commit}:${path}`]);
    assert.equal(sources.files.find((file) => file.path === path)?.sha256, sha256(bytes), `${path}: latest-stable source differs`);
    return [key, bytes];
  }));
  return { schema, request: r, selection: selection(r.group), sourceSha256: sources.sha256,
    latestStable: evaluateLatestStable({ group: r.group, ...inputs }),
    campaignMode, host: { ...providerCreateHost(campaignMode), allocation: "not-created", isolation: "unverified" } };
}
export function reviewSubject(value, campaignMode = "legacy") {
  const r = request(value), sources = captureSources(r.commit, r.group);
  return deploymentSha256(subjectFor(r, sources, campaignMode));
}
function reviewDeclaration(review, subjectSha256) {
  if (review === null) return { state: "unknown", declaration: null };
  exact(review, ["schema", "subjectSha256", "reviewer", "decision"], "review declaration");
  assert.equal(review.schema, "benchmark-isolated-review/v1");
  assert.equal(review.subjectSha256, subjectSha256, "review belongs to another source/selection/recipe/round");
  assert.equal(review.decision, "approved", "review does not approve this exact recipe");
  assert.match(review.reviewer ?? "", /^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,127}$/, "named reviewer required");
  return { state: "declared-not-authenticated", declaration: clone(review) };
}

const mixedMeasurement = (recipe) => ["mixed-measure", "mixed-production-measure", djangoAsgi.recipe, springWebflux.recipe].includes(recipe);

// Pure native command and option derivation, not source or execution admission.
export function nativeExecution(group, round, recipe, reviewId) {
  const available = Object.fromEntries(selectedApps(group).map((app) => [app, {}]));
  const { entry, selection: flags } = runnerFor(group);
  const base = [round, ...flags], args = [...base], changes = [];
  let defaults, effective, settings = null;
  const artifactRoot = nativeArtifactRoot(group, round);
  if (["catalog-page", "json-api", "localized-marketplace"].includes(group)) {
    const parse = group === "catalog-page" ? catalogOptions : group === "json-api" ? jsonOptions : marketplaceOptions;
    defaults = parse(base, available); args.push("--build");
    if (recipe === "marketplace-short-window") {
      for (const [key, value] of Object.entries(nightly)) args.push(`--${key}`, String(value));
      changes.push({ reason: "explicit existing short-window profile; not native 60/30 defaults", options: clone(nightly) });
    }
    effective = parse(args, available);
  } else if (group === "mixed-production") {
    defaults = mixedOptions(base); args.push("--build");
    if (mixedMeasurement(recipe)) {
      const profile = recipe === "mixed-measure" ? "defaults" : "matched";
      args.push("--measure");
      if (profile === "matched") args.push("--profile", profile);
      args.push(...mixedDeploymentArgs(recipe));
    }
    effective = mixedOptions(args);
    if (effective.measure) {
      const { measure, profile, djangoDeployment, springDeployment } = effective;
      changes.push({ measure, profile, ...(djangoDeployment && { djangoDeployment }), ...(springDeployment && { springDeployment }) });
    }
    defaults.apps = [...selectedApps(group)]; effective.apps = [...selectedApps(group)];
  } else if (group === "fullstack-browser") {
    defaults = { targets: null, out: null, apps: selectedApps(group), cases: null, build: false };
    args.push("--build", "--out", artifactRoot, "--isolated");
    effective = browserOptions(args); settings = clone(browserSettings);
  } else if (group === "client-heavy") {
    if (clientParser) {
      const parsed = clientParser.options(base), d = parsed.invocation.defaults;
      defaults = { rows: d.rows, large: d.large, append: d.append, cards: d.cards, seed: d.seed, cleanupMs: d["cleanup-ms"],
        observationMs: d["observation-ms"], timeoutMs: d["timeout-ms"], cargo: d.cargo };
      args.push("--out", artifactRoot);
      if (recipe === clientComparisonRecipe) args.push("--profile", clientComparisonRecipe);
      const actual = clientParser.options(args), value = actual.invocation.effective;
      effective = { rows: value.rows, large: value.large, append: value.append, cards: value.cards, seed: value.seed,
        cleanupMs: value["cleanup-ms"], observationMs: value["observation-ms"], timeoutMs: value["timeout-ms"], cargo: actual.cargo, out: artifactRoot };
      if (actual.measurementOrder) {
        Object.assign(effective, { profile: value.profile, measurementOrder: actual.measurementOrder });
        changes.push({ profile: value.profile });
      }
      settings = actual.workload;
    } else {
    defaults = { rows: 14, large: 110, append: 7, cards: 24, seed: 7, cleanupMs: 2000, observationMs: 100, timeoutMs: 30000, cargo: "cargo" };
    args.push("--out", artifactRoot);
    effective = { ...defaults, out: artifactRoot };
    settings = createClientWorkload({ seed: defaults.seed, rowCount: defaults.rows, largeRowCount: defaults.large,
      appendCount: defaults.append, dashboardCount: defaults.cards });
    }
  } else if (["live-delivery", "recoverable-live"].includes(group)) {
    defaults = { apps: selectedApps(group), build: false, profile: "bounded", measure: false };
    args.push("--build", "--isolated");
    effective = { ...defaults, build: true, isolated: true };
    if (recipe === "native-feed-measure") {
      args.push("--profile", "native-feed", "--measure"); effective.profile = "native-feed"; effective.measure = true;
      changes.push({ profile: "native-feed", measure: true, reason: "explicit profile for every candidate, not a per-app fallback" });
    }
    settings = { inventory: inventory(group, effective.profile), workload: workloadFor(effective.profile),
      scenarios: scenarios(group), settings: scenarios(group).map((s) => settingsFor(group, s, effective.profile)),
      measurement: effective.measure ? clone(fanoutProfile) : null };
  } else {
    defaults = { round, profile: "bounded", review: null, build: false, verify: {}, out: artifactRoot, nodeModules: "node_modules" };
    args.push("--build", "--review", reviewId, "--isolated");
    effective = hardeningOptions(args); settings = budgets(effective.profile);
  }
  return { invocation: { executable: "node", argv: [entry, ...args], cwd: "repository-root", shell: false },
    nativeDefaults: defaults, effectiveOptions: effective, requestedOverrides: changes, settings,
    operationalOptions: { freshBuild: true, artifactRoot, freshDirectoryRequired: true,
      note: "Build/output/review-reference options are explicit preparation, not timing-default changes" } };
}

function resources(group, recipe, campaignMode) {
  if (group === "fullstack-browser") return { ...browserContainers, browserCpus, requestedCpuEnv: null, state: "unknown",
    requiredEvidence: "effective command cgroup cpuset for the browser and driver; Docker and kernel CPU/memory receipts for application and upstream" };
  if (group === "mixed-production") return { functional: { app: { cpu: 1, memoryBytes: 2 ** 30 },
    upstream: { cpu: 2, memoryBytes: 512 * 2 ** 20 }, capture: { cpu: 2, memoryBytes: 2 ** 30 }, pinning: "not available in functional capture" },
    measurement: mixedMeasurement(recipe) ? { cpu: cpuSettings({ CATALOG_APP_CPUS: "1", CATALOG_API_CPUS: "2-3", CATALOG_LOAD_CPUS: "4-7" }),
      memoryBytes: { app: 2 ** 30, upstream: 512 * 2 ** 20, qualificationWorker: 2 ** 30, load: 2 ** 31 }, loadSharedMemoryBytes: 512 * 2 ** 20 } : null,
    requestedCpuEnv: mixedMeasurement(recipe) ? { MIXED_PRODUCTION_APP_CPUS: "1", MIXED_PRODUCTION_API_CPUS: "2-3", MIXED_PRODUCTION_LOAD_CPUS: "4-7" } : null,
    state: "unknown", requiredEvidence: "separate functional and measured participants, actual runtime limits/cpusets, calibration/headroom and quiet-host observations" };
  const prefix = { "catalog-page": "CATALOG", "json-api": "JSON_API", "localized-marketplace": "MARKETPLACE", "mixed-production": "MIXED_PRODUCTION" }[group];
  if (prefix) {
    const wide = campaignMode === catalogFleetPlacement.loadLayout, json = jsonFleetPlacementFor(group, campaignMode);
    const env = wide ? { ...catalogFleetPlacement.cpuEnv, CATALOG_LOAD_LAYOUT: campaignMode }
      : json ? placementEnv(json)
      : Object.fromEntries(Object.entries({ APP: "1", API: "2-3", LOAD: "4-7" }).map(([role, value]) => [`${prefix}_${role}_CPUS`, value]));
    return { nativeCpuDefaults: cpuSettings({}), requestedCpuEnv: env,
      expectedCpus: wide ? cpuSettings(env, campaignMode)
        : json ? placementCpus(env) : cpuSettings({ CATALOG_APP_CPUS: "1", CATALOG_API_CPUS: "2-3", CATALOG_LOAD_CPUS: "4-7" }),
      memoryBytes: { app: 2 ** 30, upstream: 512 * 2 ** 20, load: 2 ** 31 },
      hostProcesses: "unisolated driver; JSON functional checker also runs on host", state: "unknown",
      requiredEvidence: "actual per-role container quotas/cpusets/memory, tool identities, host topology and quiet-host/headroom observations" };
  }
  if (group === "hardening") return { budget: budgets().resources, actorCpus: clone(hardeningActorCpus), requestedCpuEnv: null, state: "unknown",
    requiredEvidence: "effective CPU sets for ordinary bounded service and recovery participants; connection-flood resistance not measured" };
  if (liveGroup(group)) return { app: liveApplication, upstream: null, actorCpus: liveActorCpus, requestedCpuEnv: null, state: "unknown",
    requiredEvidence: "actual application Docker and kernel limits; same-window application and Chromium/driver CPU placement" };
  assert.equal(group, "client-heavy");
  return { app: null, upstream: null, actorCpus: clientActorCpus, requestedCpuEnv: null, state: "unknown",
    requiredEvidence: "delegated command and observed browser/compiler/loopback server descendants; no additional quota or memory cap" };
}
function preparation(group) {
  const fixtures = ["catalog-page", "json-api", "localized-marketplace"].includes(group)
    ? (group === "json-api" ? ["catalog", "marketplace"] : [group === "catalog-page" ? "catalog" : "marketplace"]) : [];
  return { dependencies: ["Node 26", "Docker with cgroup v2", "root npm ci", "native Dockerfile toolchains and sufficient disk",
    ...(["fullstack-browser", "client-heavy", "live-delivery", "recoverable-live"].includes(group)
      ? ["matching Playwright Chromium and its host system dependencies"] : []),
    ...(group === "client-heavy" ? ["bench/browser npm ci", "Cargo-compatible Rust toolchain and native linker"] : []),
    ...(group === "fullstack-browser" ? ["bench npm ci (the binding parser's classic TypeScript compiler)", "local digest-pinned Node 26 image from bench/fullstack-browser/run.mjs; free loopback port 8080 for native SvelteKit origin"] : [])],
    fixtures: fixtures.map((name) => ({ executable: "node", argv: [`bench/${name}/fixtures.mjs`] })),
    environment: { refuseNonempty: ["BENCH_APPS", "BENCH_TIER", "BENCH_EDGE", "PROFILE"],
      toolIdentity: "record resolved native/tool image IDs, dependency locks and browser executable/version; tags alone are insufficient" } };
}
function validation(group, rootPath) {
  const runner = group === "catalog-page" ? { executable: "node", argv: ["bench/catalog/report.mjs", `${rootPath}/summary.json`, "--require-complete"], commitOption: "--commit" }
    : group === "json-api" ? { executable: "node", argv: ["bench/json-api/report.mjs", `${rootPath}/summary.json`, "--require-complete"], commitOption: "--commit" }
      : group === "localized-marketplace" ? { executable: "node", argv: ["bench/marketplace/report.mjs", `${rootPath}/summary.json`], commitOption: null }
        : ["live-delivery", "recoverable-live"].includes(group) ? { executable: "node", argv: ["bench/live/verify.mjs", rootPath], commitOption: null }
          : group === "hardening" ? { executable: "node", argv: ["bench/hardening/verify.mjs", rootPath], commitOption: null } : null;
  const required = group === "client-heavy" ? ["result.json", "native/build.json"]
    : ["live-delivery", "recoverable-live"].includes(group) ? ["plan.json", "coverage.json"] : ["summary.json"];
  const gates = {
    "catalog-page": ["both-source page and JSON/browser gates or replayed fail-fast record violation with no timing", "immutable-image/raw-artifact provenance; recomputed page aggregates required for comparisons"],
    "json-api": [`all ${selectedApps("json-api").length * definition("json-api").cases.length} functional attempts`, "independent exact-image native-source/serialization audits", "cold/load/raw-runtime evidence and timing schedule after parity; no timing after a replayed functional violation"],
    "localized-marketplace": ["exact-image production qualification", "both-source complete browser/content profiles", "complete selected-candidate ledger, including unqualified/stopped outcomes"],
    "mixed-production": ["all native writes/readbacks/cancellation/deadline captures", "full-inventory production qualification", "calibration, headroom, complete equal-plan windows and raw metrics"],
    "fullstack-browser": ["all 240 native source/locale/device/JS cells", "native form/readback/architecture/lifecycle evidence", "owner fix for summary qualification aggregation; no destroyed-realm cleanup waiver"],
    "client-heavy": ["six fresh native builds including Corten generator", "actual DOM/network/resource qualification", "separate measured journey passes its oracle and cleanup"],
    "live-delivery": ["all eight registered native ports", "normal and held-consumer overflow browser journeys", "requested measured fan-out levels; complete coverage and owned cleanup"],
    "recoverable-live": ["all seven registered native ports", "six native recovery/fault journeys", "requested measured fan-out levels; complete coverage and owned cleanup"],
    hardening: ["both-source direct and TLS-edge production/browser gates", "all native scenario cells with matching replayable evidence", "charged process topology, terminal state, source observations and owned cleanup"],
  }[group];
  return { artifactRoot: rootPath, required, entireTreeRequired: true, validator: runner,
    validatorState: runner ? "native-validator-not-run" : "blocked-missing-standalone-validator",
    requirements: gates.map((requirement) => ({ requirement, state: "unknown" })),
    outcomePolicy: "retain failed/unsupported/not-run cells and target outcomes; unavailable measurements are never numeric zero; exit zero/complete flags alone cannot establish readiness" };
}

function build(r, sources, review, campaignMode) {
  const subject = subjectFor(r, sources, campaignMode), subjectSha256 = deploymentSha256(subject);
  const declaredReview = reviewDeclaration(review, subjectSha256);
  const execution = nativeExecution(r.group, r.round, r.recipe, subjectSha256);
  const checks = validation(r.group, execution.operationalOptions.artifactRoot);
  if (checks.validator?.commitOption) checks.validator.argv.push(checks.validator.commitOption, r.commit);
  const body = { ...subject, subjectSha256, sources, review: declaredReview, execution,
    preparation: preparation(r.group), resources: resources(r.group, r.recipe, campaignMode), validation: checks,
    coverage: coverage(r.group), status: { binding: "verified-offline", nativeEvidence: "unknown", ready: false, executionAuthorized: false,
      blockers: ["offline binding has not executed a native worker or collected evidence", "merged-source and independent parity/deployment review not established",
        "fresh host, actual runtime configuration, isolation and cleanup evidence not observed",
        ...(declaredReview.state === "unknown" ? ["exact-recipe review declaration missing"] : ["review declaration is not authenticated independent review evidence"]),
        ...(checks.validator === null ? ["standalone complete native evidence validator not integrated"] : []),
        ...(["live-delivery", "recoverable-live"].includes(r.group)
          ? inventory(r.group, execution.effectiveOptions.profile).flatMap((p) => p.implementation !== "implemented"
            ? [`missing native registration: ${p.app}`] : !portFor(p.app, execution.effectiveOptions.profile)
              ? [`native port incompatible with selected profile: ${p.app}`] : []) : []),
        ...(r.group === "json-api" ? ["independent exact-image audit staging/receipt handoff not integrated"] : [])] } };
  return freeze({ ...body, bindingSha256: deploymentSha256(body) });
}

/** Accept no commands, flags, filters, images, environment or output-path overrides. */
export function bindExecution(value, campaignMode = "legacy") {
  exact(value, ["group", "round", "commit", "recipe", "review"], "binding request");
  const { review, ...input } = value, r = request(input);
  return build(r, captureSources(r.commit, r.group), review, campaignMode);
}

/** Recompute from live committed source; a self-consistent caller hash is not trusted. */
export function validateBinding(binding) {
  assert.equal(binding?.schema, schema, "wrong isolated contract schema");
  const r = request(binding.request), sources = captureSources(r.commit, r.group);
  const expected = build(r, sources, binding.review?.declaration, binding.campaignMode);
  assert.ok(isDeepStrictEqual(binding, expected), "binding differs from native source, selection, recipe or strict validation state");
  return freeze({ bindingSha256: expected.bindingSha256, binding: "verified-offline", ready: false, executionAuthorized: false });
}

/** Namespace check only, not file existence, integrity, type or native validation. */
export function validateArtifactPaths(binding, paths) {
  validateBinding(binding);
  assert.ok(Array.isArray(paths) && paths.length > 0, "artifact file paths required");
  const prefix = `${binding.validation.artifactRoot}/`, seen = new Set();
  for (const path of paths) {
    assert.equal(typeof path, "string", "artifact path must be text");
    assert.ok(path.startsWith(prefix), "artifact outside exact native round root");
    for (const part of path.split("/")) assert.ok(portableEvidenceSegment(part), "unsafe artifact segment");
    const key = path.toLowerCase(); assert.ok(!seen.has(key), "duplicate/case-colliding artifact"); seen.add(key);
  }
  for (const file of binding.validation.required) assert.ok(paths.includes(prefix + file), `missing required native artifact ${file}`);
  return freeze({ namespace: "verified", nativeEvidence: "unknown", ready: false });
}
