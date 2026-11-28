// Provider identity and transport boundaries only. This module cannot launch or qualify a run.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { cpuEnv as catalogCpuEnv, host as catalogHost } from "../catalog/droplet-contract.mjs";
import { contractSha256, groupNames, registrySchema, selectedApps } from "./registry.mjs";

const legacyHost = Object.freeze({ ...catalogHost, region: "sfo2" });
export const host = Object.freeze({ ...catalogHost, region: "sfo3" });
export const catalogFleetPlacement = Object.freeze({
  host: Object.freeze({ ...legacyHost, size: "c-16" }),
  loadLayout: "c16-generator-v1",
  cpuEnv: Object.freeze({ ...catalogCpuEnv, CATALOG_LOAD_CPUS: "4-15" }),
});
// Only these placements can be saved in an independent json-api fleet.
const jsonPlacement = (logicalCpus, loadQuota, loadPins) => Object.freeze({
  host: Object.freeze({ ...legacyHost, size: `c-${logicalCpus}` }),
  loadLayout: `json-c${logicalCpus}-generator-v1`,
  logicalCpus, loadQuota,
  cpuEnv: Object.freeze({ JSON_API_APP_CPUS: "1", JSON_API_API_CPUS: "2-3", JSON_API_LOAD_CPUS: loadPins }),
});
export const jsonFleetPlacement = jsonPlacement(16, 12, "4-15");
const jsonPlacements = [jsonFleetPlacement, jsonPlacement(32, 20, "4-23")];
export const jsonFleetPlacementFor = (group, loadLayout) => group === "json-api"
  ? jsonPlacements.find((placement) => placement.loadLayout === loadLayout) : undefined;
const historicalFleetSchema = "benchmark-group-fleet/v1", uniformFleetSchema = "benchmark-group-fleet/v2",
  pinnedFleetSchema = "benchmark-group-fleet/v3", launchFleetSchema = "benchmark-group-fleet/v4";
const stagedFleetSchema = "benchmark-group-fleet/v5";
export const alternateFleetMode = "dedicated-sfo2";
const pinnedFleetRegions = Object.freeze([host.region, legacyHost.region]);
const fleetRegions = Object.freeze([...pinnedFleetRegions, "lon1", "blr1"]);
export const fleetCatalogSlugs = Object.freeze({
  sizes: Object.freeze([...new Set([host.size, catalogFleetPlacement.host.size, ...jsonPlacements.map((p) => p.host.size)])]),
  regions: fleetRegions,
});
export const fleetCatalogCommand = Object.freeze(["compute", "placement", "catalog", "--output", "json"]);
export const stagedFleet = (fleet) => fleet?.schema === stagedFleetSchema;
// These runners either use Chromium in a container or do not use a browser.
export const canSkipHostChromium = (group) =>
  ["catalog-page", "json-api", "localized-marketplace", "mixed-production", "hardening"].includes(group);
const createMode = (region) => region === host.region ? "dedicated" : `dedicated-${region}`;
export function fleetCreateMode(group, fleet, remainingRegion) {
  if (group === "catalog-page") return catalogFleetPlacement.loadLayout;
  const json = jsonFleetPlacementFor(group, fleet?.single?.loadLayout);
  if (json) return json.loadLayout;
  return createMode(stagedFleet(fleet) && !fleet.single ? fleetHost(remainingRegion).region : fleet.host.region);
}
export function providerCreateHost(mode) {
  if (mode === "legacy" || mode === alternateFleetMode) return legacyHost;
  if (mode === "dedicated") return host;
  if (mode === catalogFleetPlacement.loadLayout) return catalogFleetPlacement.host;
  const json = jsonFleetPlacementFor("json-api", mode);
  if (json) return json.host;
  if (mode === "dedicated-lon1" || mode === "dedicated-blr1") return fleetHost(mode.slice("dedicated-".length));
  assert.equal(mode, null, "unknown provider create mode");
}
export const tags = Object.freeze(["corten-bench", "corten-bench-groups"]);
// The native upstream image each fresh host pulls. Reservations saved before Debian 13 (no
// trixieUpstream marker) regenerate the job bytes they uploaded, with the Debian 12 image.
export const upstreamImages = Object.freeze({
  bookworm: "node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1",
  trixie: "node:26.13.1-trixie-slim@sha256:615a27817f7b9508f0de73eb1cc8fc8894ab122bee56c1a7a568b72cd1032067",
});
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const full = (value, pattern, name) => {
  assert.equal(typeof value, "string", `${name} must be a string`);
  const match = pattern.exec(value);
  assert.ok(match && match[0] === value, `invalid ${name}`);
  return value;
};
const date = (value) => {
  full(value, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/, "timestamp");
  assert.equal(new Date(value).toISOString(), value, "invalid timestamp");
};
export const roundName = (value) => full(value, /r[1-9]\d{0,8}/, "campaign round");
export function selection() {
  return { schema: registrySchema, groups: groupNames.map((group) => ({
    group, contractSha256: contractSha256(group), apps: selectedApps(group),
  })) };
}
const exact = (value, fields) => {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype, "plain object required");
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort(), "unexpected or missing fields");
};
// Exact ordered rosters written by the pre-placement controllers. These pins
// decode saved state only; the controller's separate recovery policies
// still decide which measured sources and host attempts may be acted on.
const historicalSelections = new Set([
  "d9c74b1fee3f6d5c71cee7405b24db73da1ffbef8f0d00c66924ebf7b475a251", // Retained r21 fleets.
  "57bf46a0e3e03d8a48bdcca952b522c148d91a7892c74e6bfbe2e860b927e19a", // 19defc76, immediately before placement.
]);
// The standalone all-group host also used the pre-rotation registry. It is
// readable for collection, not an additional fleet roster or a launch input.
const historicalHostSelections = new Set([...historicalSelections,
  "dbf01bfc107ae1bec0861900558613fe120c32ab2957b03e9e65f019739c6871", // 83b3b8772, per-locale marketplace timing.
]);
const historicalSelection = (selected, allowed = historicalSelections) => selected && allowed.has(digest(selected));
function buildFleet(input, createdAt, schema, placement, selected, single) {
  exact(input, ["round", "commit", "token", "tokens", "provider", "sshKey"]);
  const { round, commit, token, tokens, provider, sshKey } = input;
  roundName(round); assert.ok(Number(round.slice(1)) >= 17, "official campaigns start at r17");
  full(commit, /[a-f0-9]{40}/, "measured commit"); full(token, /[a-f0-9]{16}/, "fleet token");
  const names = selected.groups.map(({ group }) => group);
  exact(tokens, names); exact(provider, ["accountId", "context"]);
  full(provider.accountId, /(?:user|team):[A-Za-z0-9][A-Za-z0-9-]{0,127}/, "scoped stable account UUID required");
  full(provider.context, /[A-Za-z0-9][A-Za-z0-9_.-]{0,127}/, "explicit saved doctl context required");
  full(sshKey, /[1-9]\d*/, "SSH key ID required"); date(createdAt);
  const jobs = names.map((group) => {
    const ownership = full(tokens[group], /[a-f0-9]{16}/, "ownership token");
    const wide = [pinnedFleetSchema, launchFleetSchema, stagedFleetSchema].includes(schema) && group === "catalog-page";
    const json = schema === stagedFleetSchema && jsonFleetPlacementFor(group, single?.loadLayout);
    return { group, token: ownership, name: `corten-bench-groups-${round}-${ownership}`,
      tag: `corten-bench-groups-run-${ownership}`, ...(wide ? {
        host: { ...catalogFleetPlacement.host }, loadLayout: catalogFleetPlacement.loadLayout,
      } : json ? { host: { ...json.host }, loadLayout: json.loadLayout } : {}) };
  });
  assert.equal(new Set([token, ...jobs.map((row) => row.token)]).size, jobs.length + 1, "unique fleet/host tokens required");
  const body = { schema, round, commit, token, createdAt,
    provider: { ...provider }, sshKey, host: { ...placement }, selection: selected, jobs, ...(single ? { single } : {}) };
  return { ...body, fleetSha256: digest(body) };
}
function fleetHost(region, regions = fleetRegions) {
  assert.ok(regions.includes(region), "unsupported fleet region");
  return { ...host, region };
}
function fleetSelection(single) {
  const current = selection();
  if (!single) return current;
  exact(single, ["group", "indexSha256", "checkout", ...["offlineHandoff", "loadLayout", "replacesQuarantineSha256"].filter((key) => single[key] !== undefined)]);
  if (single.offlineHandoff !== undefined) assert.equal(single.offlineHandoff, true, "offline handoff marker");
  assert.ok(groupNames.includes(single.group), "unknown independent group");
  if (single.loadLayout !== undefined) assert.ok(jsonFleetPlacementFor(single.group, single.loadLayout), "unknown independent group load layout");
  if (single.replacesQuarantineSha256 !== undefined) full(single.replacesQuarantineSha256, /[a-f0-9]{64}/, "create quarantine replacement digest");
  full(single.indexSha256, /[a-f0-9]{64}/, "continuation index digest");
  full(single.checkout, /[^\r\n\0]{1,4096}/, "measured checkout");
  return { ...current, groups: current.groups.filter(({ group }) => group === single.group) };
}
export function fleetPlan(input, createdAt = new Date().toISOString(), region = host.region, { stagedPlacement = false, single } = {}) {
  assert.ok(!single || stagedPlacement);
  return buildFleet(input, createdAt, stagedPlacement ? stagedFleetSchema : launchFleetSchema,
    fleetHost(region, stagedPlacement ? fleetRegions : pinnedFleetRegions), fleetSelection(single), single);
}
export function validateFleet(plan, { priorSelection = false } = {}) {
  assert.ok(plan && Array.isArray(plan.jobs), "complete fleet plan required");
  assert.ok([historicalFleetSchema, uniformFleetSchema, pinnedFleetSchema, launchFleetSchema, stagedFleetSchema].includes(plan.schema), "unknown fleet schema");
  const historical = plan.schema === historicalFleetSchema;
  if (historical) assert.ok(historicalSelection(plan.selection), "historical fleet selection differs");
  if (Object.hasOwn(plan, "single")) assert.ok(stagedFleet(plan) && plan.single);
  const current = fleetSelection(plan.single);
  if (priorSelection && !historical) {
    const stored = plan.selection;
    exact(stored, ["schema", "groups"]); assert.equal(stored.schema, registrySchema);
    assert.ok(Array.isArray(stored.groups) && stored.groups.length > 0 && stored.groups.length <= 32);
    for (const row of stored.groups) {
      exact(row, ["group", "contractSha256", "apps"]);
      full(row.group, /[a-z][a-z0-9-]{0,63}/, "retained group"); full(row.contractSha256, /[a-f0-9]{64}/, "retained group contract");
      assert.ok(Array.isArray(row.apps) && row.apps.length > 0 && row.apps.length <= 64 && row.apps.every((app) => typeof app === "string"));
      assert.equal(new Set(row.apps).size, row.apps.length);
    }
    assert.equal(new Set(stored.groups.map(({ group }) => group)).size, stored.groups.length);
    if (plan.single) assert.deepEqual(stored.groups.map(({ group }) => group), [plan.single.group]);
  }
  const expected = buildFleet({ round: plan.round, commit: plan.commit, token: plan.token,
    tokens: Object.fromEntries(plan.jobs.map((row) => [row.group, row.token])), provider: plan.provider, sshKey: plan.sshKey },
    plan.createdAt, plan.schema, historical ? legacyHost : stagedFleet(plan) ? fleetHost(plan.host?.region)
      : plan.schema === launchFleetSchema ? fleetHost(plan.host?.region, pinnedFleetRegions) : host,
    historical || priorSelection ? plan.selection : current, plan.single);
  assert.deepEqual(plan, expected, "fleet differs from complete fixed registry and owned hosts");
  return plan;
}
export function validateLaunchFleet(plan) {
  assert.ok(stagedFleet(plan) || plan?.schema === launchFleetSchema, "historical fleet cannot authorize launch");
  return validateFleet(plan);
}
export function requireStagedFleet(plan) {
  assert.ok(stagedFleet(plan), "historical fleet cannot authorize launch");
  return validateFleet(plan);
}
// Only derive placement from a validated fleet, never from free-form launch options.
const jobHost = (fleet, job, region) => job.host ?? (stagedFleet(fleet) && !fleet.single ? fleetHost(region) : fleet.host);
export const savedLoadLayout = (s) => s.fleet?.jobs.find((job) => job.group === s.group)?.loadLayout;
export function savedPlacement(s) {
  if (s.fleet?.schema !== launchFleetSchema && !stagedFleet(s.fleet)) return;
  const mode = fleetCreateMode(s.group, s.fleet, s.remainingPlacement?.region);
  if (!["dedicated", catalogFleetPlacement.loadLayout].includes(mode) && !jsonFleetPlacementFor(s.group, mode)) return mode;
}
function reservationRegion(fleet, job, placement) {
  if (!stagedFleet(fleet) || job.host || fleet.single) {
    assert.equal(placement, undefined, "only a v5 remaining host has a placement binding");
    return;
  }
  exact(placement, ["region", "intentSha256"]);
  full(placement.intentSha256, /[a-f0-9]{64}/, "remaining placement intent");
  return fleetHost(placement.region).region;
}

// Keep the wider catalog job fixed, and use one common region for all other jobs.
// Both directional listings must agree for each candidate pair.
export function fleetRegion(catalog, reservedRegion, { remainingOnly = false, staged = false, group, loadLayout } = {}) {
  const listed = (kind, slug, membership, optional) => {
    assert.ok(Array.isArray(catalog?.[kind]), "invalid fleet catalog listing");
    const rows = catalog[kind].filter((row) => row?.slug === slug);
    if (optional && rows.length === 0) return;
    const members = rows[0]?.[membership];
    assert.ok(rows.length === 1 && typeof rows[0].available === "boolean"
      && Array.isArray(members) && members.every((value) => typeof value === "string")
      && new Set(members).size === members.length, `missing or invalid fleet catalog entry: ${slug}`);
    return rows[0];
  };
  const available = ({ size, region }) => {
    // A staged c-8 candidate may be absent from a complete listing, but
    // neither direction may claim that the absent side offers the pair.
    const optional = staged && size === host.size;
    const s = listed("sizes", size, "regions", optional), r = listed("regions", region, "sizes", optional);
    const inSize = s?.regions.includes(region) ?? false, inRegion = r?.sizes.includes(size) ?? false;
    assert.ok(inSize === inRegion, `fleet catalog listings disagree: ${size}/${region}`);
    return inSize && s.available && r.available;
  };
  if (loadLayout !== undefined) {
    const json = jsonFleetPlacementFor(group, loadLayout);
    assert.ok(staged && json, "unknown independent group load layout");
    assert.ok(available(json.host), `fleet placement not advertised: ${json.host.size}/${json.host.region}`);
    return host.region; // The single job carries its own placement.
  }
  if (group === "catalog-page") {
    assert.ok(available(catalogFleetPlacement.host), "fleet placement not advertised: c-16/sfo2");
    return host.region; // The fixed catalog job carries its own c-16 placement.
  }
  if (remainingOnly || group !== undefined) assert.ok(staged || reservedRegion !== undefined, "remaining placement must already be reserved");
  else assert.ok(available(catalogFleetPlacement.host), "fleet placement not advertised: c-16/sfo2");
  const regions = staged ? fleetRegions : pinnedFleetRegions;
  const options = (reservedRegion === undefined ? regions : [reservedRegion]).filter((region) => available(fleetHost(region, regions)));
  assert.ok(options.length > 0, reservedRegion === undefined ? "no supported c-8 fleet placement advertised"
    : `reserved fleet placement not advertised: c-8/${reservedRegion}`);
  return options[0];
}
export function assertFleetCensus(droplets, plan, remainingRegion, peers = []) {
  validateLaunchFleet(plan); assert.ok(Array.isArray(droplets));
  if (plan.single?.offlineHandoff) assert.deepEqual(peers, [], "offline handoff requires no live peer");
  const peerRows = new Set(peers.map((s) => {
    assert.ok(!s.fleet.single?.offlineHandoff, "offline handoff cannot authorize a parallel host");
    assert.ok(plan.single && s.fleet.single?.indexSha256 === plan.single.indexSha256
      && s.group !== plan.single.group && s.provider.accountId === plan.provider.accountId,
      "peer belongs to a different reservation or account");
    const d = ownedDroplet(droplets, s, { priorSelection: true });
    assert.equal(d.networks.v4.filter((n) => n.type === "public").length, 1, "ambiguous peer public address");
    return d;
  }));
  assert.equal(peerRows.size, peers.length, "duplicate peer host identity");
  const names = new Set(), ids = new Set();
  for (const d of droplets) {
    if (!d.name?.startsWith("corten-bench-groups-") && !d.tags?.includes(tags[0])) continue;
    const job = plan.jobs.find((row) => row.name === d.name);
    assert.ok(job || peerRows.has(d), "foreign benchmark host blocks fleet launch");
    full(String(d.id), /[1-9]\d*/, "droplet ID");
    assert.ok(!names.has(d.name) && !ids.has(String(d.id)), "duplicate fleet host identity");
    names.add(d.name); ids.add(String(d.id));
    if (!job) continue; // Already bound to its exact owned state above.
    for (const tag of [...tags, job.tag]) assert.ok(d.tags?.includes(tag), "fleet ownership tag differs");
    const placement = jobHost(plan, job, remainingRegion);
    assert.equal(d.size_slug ?? d.size?.slug, placement.size); assert.equal(d.region?.slug, placement.region);
  }
  return true;
}
export function reservation(input, createdAt = new Date().toISOString()) {
  const { round, commit, token, group, fleet, remainingPlacement } = input;
  exact(input, group === undefined ? ["round", "commit", "token"] : ["round", "commit", "token", "group", "fleet",
    ...(remainingPlacement === undefined ? [] : ["remainingPlacement"])]);
  roundName(round);
  full(commit, /[a-f0-9]{40}/, "measured commit");
  full(token, /[a-f0-9]{16}/, "ownership token");
  const name = `corten-bench-groups-${round}-${token}`;
  let placement = legacyHost;
  if (group !== undefined) {
    validateLaunchFleet(fleet); assert.equal(fleet.round, round); assert.equal(fleet.commit, commit);
    const job = fleet.jobs.find((row) => row.group === group);
    assert.equal(job?.token, token, "host not reserved in fleet");
    placement = jobHost(fleet, job, reservationRegion(fleet, job, remainingPlacement));
  }
  return validateState({ schema: group === undefined ? "benchmark-group-host/v1" : "benchmark-dedicated-group-host/v1", round, commit, token, name,
    tag: `corten-bench-groups-run-${token}`, unit: `${name}.service`, host: { ...placement },
    selection: fleet === undefined ? selection() : structuredClone(groupSelection(fleet, group)),
    ...(group === undefined ? {} : { group, fleet: structuredClone(fleet) }),
    ...(remainingPlacement === undefined ? {} : { remainingPlacement: { ...remainingPlacement } }),
    createdAt, status: "reserved" }, round);
}
function groupSelection(fleet, group) {
  return { schema: fleet.selection.schema, groups: fleet.selection.groups.filter((row) => row.group === group) };
}
export function validateState(s, round, options) {
  assert.ok(s && typeof s === "object" && !Array.isArray(s), "host state required");
  const dedicated = s.schema === "benchmark-dedicated-group-host/v1";
  assert.ok(dedicated || s.schema === "benchmark-group-host/v1");
  assert.equal(s.round, roundName(round));
  full(s.commit, /[a-f0-9]{40}/, "measured commit");
  full(s.token, /[a-f0-9]{16}/, "ownership token");
  assert.equal(s.name, `corten-bench-groups-${round}-${s.token}`);
  assert.equal(s.tag, `corten-bench-groups-run-${s.token}`);
  assert.equal(s.unit, `${s.name}.service`);
  if (dedicated) {
    validateFleet(s.fleet, options); assert.equal(s.fleet.round, round); assert.equal(s.fleet.commit, s.commit);
    const job = s.fleet.jobs.find((row) => row.group === s.group);
    assert.equal(job?.token, s.token, "host not reserved in fleet");
    assert.deepEqual(s.host, jobHost(s.fleet, job, reservationRegion(s.fleet, job, s.remainingPlacement)));
    assert.deepEqual(s.selection, groupSelection(s.fleet, s.group), "complete native group required");
  } else {
    assert.deepEqual(s.host, legacyHost);
    assert.ok(!Object.hasOwn(s, "group") && !Object.hasOwn(s, "fleet") && !Object.hasOwn(s, "remainingPlacement"), "legacy host cannot select a group");
    if (!historicalSelection(s.selection, historicalHostSelections))
      assert.deepEqual(s.selection, selection(), "complete current registry selection differs");
  }
  // Hosts launched since the bench package existed install it. Absent means the original job bytes.
  if (s.benchPackage !== undefined) assert.equal(s.benchPackage, true, "bench package marker");
  if (s.gitSource !== undefined) assert.equal(s.gitSource, true, "Git source marker");
  if (s.trixieUpstream !== undefined) assert.equal(s.trixieUpstream, true, "Debian 13 upstream image marker");
  if (s.skipHostChromium !== undefined)
    assert.ok(s.skipHostChromium === true && dedicated && canSkipHostChromium(s.group), "host Chromium skip marker");
  // Saved reservations without this marker must regenerate the original job.
  if (s.quietBootstrap !== undefined)
    assert.ok([true, "after-start", "prelogin"].includes(s.quietBootstrap) && dedicated
      && (s.control?.monitor || s.fleet.single?.offlineHandoff), "quiet bootstrap requires a registered group");
  if (s.fleet?.single?.offlineHandoff && (s.control || s.status !== "reserved"))
    assert.ok(s.control && !s.control.monitor && s.quietBootstrap === "prelogin",
    "offline handoff requires the prelogin policy and no monitor");
  date(s.createdAt);
  assert.ok(["reserved", "creating", "preparing", "starting", "running", "collected", "retired"].includes(s.status));
  if (["preparing", "starting", "running", "collected", "retired"].includes(s.status)) assert.ok(s.id && s.ip, "owned host identity missing");
  if (s.id !== undefined) full(s.id, /[1-9]\d*/, "droplet ID");
  if (s.ip !== undefined) assert.equal(isIP(s.ip), 4, "public IPv4 required");
  for (const key of ["archiveSha256", "evidenceSha256"]) if (s[key] !== undefined) full(s[key], /[a-f0-9]{64}/, key);
  for (const key of ["createIntentAt", "collectedAt", "deletionIntentAt", "destroyedAt"]) if (s[key] !== undefined) date(s[key]);
  if (s.control !== undefined) {
    exact(s.control, ["schema", "helperSha256", "ledger", "sealed", ...(s.control.monitor === undefined ? [] : ["monitor"])]);
    if (s.control.monitor !== undefined) {
      const m = s.control.monitor;
      exact(m, ["schema", "id", "phase", ...(m.registrationSha256 === undefined ? [] : ["registrationSha256"])]);
      assert.equal(m.schema, "benchmark-supervised-control/v1"); full(m.id, /[a-f0-9]{32}/, "monitor identity");
      assert.ok(["pending", "live", "closed", "invalid"].includes(m.phase));
      if (m.phase === "live" || m.phase === "closed") assert.ok(m.registrationSha256);
      if (m.registrationSha256 !== undefined) full(m.registrationSha256, /[a-f0-9]{64}/, "monitor registration digest");
    }
    assert.equal(s.control.schema, "benchmark-control-ledger/v1");
    full(s.control.helperSha256, /[a-f0-9]{64}/, "control source");
    assert.ok(Array.isArray(s.control.ledger) && s.control.ledger.length <= 4096);
    assert.ok(Array.isArray(s.control.sealed) && new Set(s.control.sealed).size === s.control.sealed.length);
    assert.ok(s.control.sealed.every((e) => ["bootstrap", "audit-json-api", "audit-mixed-production"].includes(e)));
    const ids = new Set();
    for (const [sequence, row] of s.control.ledger.entries()) {
      exact(row, ["request", "localTerminal", ...(row.localTerminal ? ["code"] : []),
        ...(row.setupProofRejected === undefined ? [] : ["setupProofRejected"])]);
      const request = row.request, invocation = request.invocation;
      exact(request, ["invocation", "helperSha256", "epoch", "sequence", ...(request.seal === undefined ? [] : ["seal"])]);
      exact(invocation, ["schema", "round", "commit", "token", "id", "channel", "purpose", "requestSha256", "deadlineMs"]);
      assert.equal(invocation.schema, "benchmark-control-invocation/v1");
      assert.ok(["ssh", "sftp"].includes(invocation.channel));
      assert.ok(["bootstrap", "audit-json-api", "audit-mixed-production", "collection"].includes(request.epoch));
      assert.equal(invocation.purpose, request.epoch.startsWith("audit-") ? "audit" : request.epoch);
      full(invocation.requestSha256, /[a-f0-9]{64}/, "control request digest");
      assert.ok(Number.isSafeInteger(invocation.deadlineMs) && invocation.deadlineMs > 0 && invocation.deadlineMs <= 900000);
      assert.equal(request.sequence, sequence); assert.equal(request.helperSha256, s.control.helperSha256);
      for (const key of ["round", "commit", "token"]) assert.equal(invocation[key], s[key]);
      full(invocation.id, /[a-f0-9]{32}/, "control invocation"); assert.ok(!ids.has(invocation.id)); ids.add(invocation.id);
      assert.equal(typeof row.localTerminal, "boolean");
      if (row.localTerminal) assert.ok(Number.isInteger(row.code) && row.code >= 0 && row.code <= 255);
      if (row.setupProofRejected !== undefined) assert.ok(row.setupProofRejected === true && row.localTerminal && row.code === 0
        && s.preBootstrapTerminal && s.status === "starting" && s.evidence && sequence === s.control.ledger.length - 1
        && request.epoch === "collection" && invocation.channel === "ssh", "invalid setup proof rejection");
      if (request.seal !== undefined) {
        assert.notEqual(request.epoch, "collection"); assert.equal(invocation.channel, "ssh");
        const expected = s.control.ledger.slice(0, sequence + 1).filter((r) => r.request.epoch === request.epoch)
          .map((r) => ({ id: r.request.invocation.id, sha256: createHash("sha256").update(JSON.stringify(r.request.invocation)).digest("hex") }));
        assert.deepEqual(request.seal, expected, "incomplete controller epoch seal");
      }
    }
    for (const epoch of s.control.sealed) {
      const rows = s.control.ledger.filter((r) => r.request.epoch === epoch);
      assert.ok(rows.length && rows.every((r) => r.localTerminal) && rows.at(-1).request.seal, "sealed epoch lacks terminal final control");
    }
  }
  if (s.extractionAttempts !== undefined) {
    assert.ok(Array.isArray(s.extractionAttempts));
    for (const path of s.extractionAttempts) full(path, /evidence-[A-Za-z0-9]+/, "extraction directory");
    assert.equal(new Set(s.extractionAttempts).size, s.extractionAttempts.length);
  }
  if (s.evidence !== undefined) assert.ok(s.extractionAttempts?.includes(s.evidence), "unrecorded extraction");
  if (s.deletionIntentAt || s.destroyedAt || s.status === "retired" || s.retirement !== undefined) {
    if (s.retirement !== undefined) assert.equal(s.status, "retired");
    if (s.status === "retired") {
      exact(s.retirement, ["kind", "evidenceSha256"]);
      assert.ok(["unused", "setup-failed", "native-failed"].includes(s.retirement.kind));
      full(s.retirement.evidenceSha256, /[a-f0-9]{64}/, "retirement evidence hash");
      assert.ok(s.deletionIntentAt, "retirement requires deletion intent");
    } else {
      assert.equal(s.status, "collected");
      assert.ok(s.collectedAt && s.archiveSha256 && s.evidenceSha256 && s.evidence, "deletion requires preserved evidence");
      assert.ok(["validated", "failed", "blocked"].includes(s.evidenceOutcome), "terminal evidence outcome required");
    }
  }
  return s;
}
export function ownedDroplet(droplets, s, options) {
  validateState(s, s.round, options);
  assert.ok(Array.isArray(droplets));
  // An ownership tag is an exact member of a well-formed tag array (non-empty strings),
  // never a substring of a string or a member beside malformed entries.
  const tagged = (d, tag) => Array.isArray(d.tags) && d.tags.every((t) => typeof t === "string" && t.length > 0) && d.tags.includes(tag);
  const matches = droplets.filter((d) => s.id ? String(d.id) === s.id : d.name === s.name && d.tags?.includes(s.tag));
  assert.equal(matches.length, 1, "owned droplet missing or ambiguous; preserve reservation");
  const d = matches[0];
  full(String(d.id), /[1-9]\d*/, "droplet ID");
  assert.equal(d.name, s.name);
  for (const tag of [...tags, s.tag]) assert.ok(tagged(d, tag), `missing ownership tag ${tag}`);
  assert.equal(d.size_slug ?? d.size?.slug, s.host.size);
  assert.equal(d.region?.slug, s.host.region);
  if (s.ip) assert.equal(d.networks?.v4?.filter((n) => n.type === "public").find((n) => n.ip_address === s.ip)?.ip_address, s.ip,
    "owned host public IP differs");
  return d;
}
export function unitProperties(output, s) {
  validateState(s, s.round);
  const fields = {};
  for (const line of output.trimEnd().split(/\r?\n/)) {
    const match = /^([A-Za-z]+)=(.*)$/.exec(line);
    assert.ok(match && !Object.hasOwn(fields, match[1]), "invalid or duplicate unit property");
    fields[match[1]] = match[2];
  }
  assert.equal(fields.Id, s.unit);
  assert.equal(fields.LoadState, "loaded", "unit missing; preserve host");
  assert.equal(fields.FragmentPath, `/etc/systemd/system/${s.unit}`);
  assert.equal(fields.Restart, "no", "unit restart policy differs");
  return fields;
}
export function terminalUnit(output, s) {
  const fields = unitProperties(output, s);
  if (!["inactive", "failed"].includes(fields.ActiveState)) return false;
  assert.equal(fields.MainPID, "0", "unit still has a process");
  full(fields.ExecMainCode, /[12]/, "terminal exit type");
  assert.ok(fields.ExecMainStartTimestamp && fields.ExecMainStartTimestamp !== "n/a", "unit never started");
  return true;
}
export const archivePathLimits = Object.freeze({ nodes: 1100000, nameBytes: 32 * 1024 ** 2, memberBytes: 64 * 1024 ** 2 });

// A compact trie, not one retained JS string/map per full path or implicit prefix.
// Each node is 12 bytes; the fixed hash table is 16 MiB and the name arena 32 MiB.
// Limits may only be lowered by local tests, never raised by evidence or the CLI.
export function archivePaths(bounds = {}) {
  const limits = { ...archivePathLimits, ...bounds };
  for (const key of Object.keys(limits)) assert.ok(Object.hasOwn(archivePathLimits, key)
    && Number.isSafeInteger(limits[key]) && limits[key] >= 1 && limits[key] <= archivePathLimits[key], "archive index bound");
  const nodes = Buffer.alloc(limits.nodes * 12), names = Buffer.alloc(limits.nameBytes), slots = new Uint32Array(2 ** 22);
  const seed = randomBytes(32), parentBytes = Buffer.alloc(4);
  let count = 1, used = 0, memberBytes = 0, pathBytes = 0, entries = 0;
  const chargePath = (bytes) => { pathBytes += bytes; assert.ok(pathBytes <= limits.memberBytes, "archive index physical path budget"); };
  const child = (parent, part, length) => {
    parentBytes.writeUInt32LE(parent);
    let slot = createHash("sha256").update(seed).update(parentBytes).update(part.toLowerCase(), "ascii").digest().readUInt32LE() & (slots.length - 1);
    while (slots[slot]) {
      const id = slots[slot], at = id * 12, offset = nodes.readUInt32LE(at + 4), length = nodes.readUInt16LE(at + 8);
      if (nodes.readUInt32LE(at) === parent && length === part.length) {
        const saved = names.toString("ascii", offset, offset + length);
        if (saved.toLowerCase() === part.toLowerCase()) {
          assert.equal(saved, part, "archive path casing differs"); return id;
        }
      }
      slot = (slot + 1) & (slots.length - 1);
    }
    assert.ok(count < limits.nodes, "evidence tree limit");
    assert.ok(used + part.length + 1 <= limits.nameBytes, "archive index name budget");
    chargePath(length);
    const id = count++, at = id * 12;
    nodes.writeUInt32LE(parent, at); nodes.writeUInt32LE(used, at + 4); nodes.writeUInt16LE(part.length, at + 8);
    names.write(part, used, part.length, "ascii"); used += part.length + 1; slots[slot] = id; return id;
  };
  const required = new Set(["run.log", "host.txt", "exit-code"]);
  return {
    add(name, directory) {
      assert.equal(typeof name, "string"); assert.equal(typeof directory, "boolean");
      assert.ok(++entries <= limits.nodes, "archive entry limit");
      assert.ok(name.length <= 4096, "archive member size limit");
      memberBytes += name.length; assert.ok(memberBytes <= limits.memberBytes, "archive index member budget");
      assert.equal(directory, name.endsWith("/"), "archive path/type mismatch");
      const path = name.replace(/\/$/, ""), parts = path.split("/");
      assert.ok(parts.length <= 64 && parts.every((p) => p.length <= 255 && portableEvidenceSegment(p)), "unsafe archive path/component");
      assert.ok(path === "campaign" || path.startsWith("campaign/") || path === "control" || path.startsWith("control/") || ["run.log", "host.txt", "exit-code"].includes(path), "foreign archive member");
      if (["campaign", "control"].includes(path)) assert.ok(directory, "evidence root must be a directory");
      if (!path.includes("/") && !["campaign", "control"].includes(path)) assert.ok(!directory, "metadata must be a regular file");
      let id = 0, length = 0;
      for (const part of parts) {
        const at = id * 12 + 10;
        assert.ok(!(nodes[at] & 4), "archive file used as parent");
        if (id && !(nodes[at] & 3)) chargePath(1); // An implicit directory's trailing slash.
        nodes[at] |= 1;
        length += part.length + (length ? 1 : 0); id = child(id, part, length);
      }
      const at = id * 12 + 10;
      assert.ok(!(nodes[at] & 6), "duplicate archive path");
      assert.ok(directory || !(nodes[at] & 1), "archive parent replaces existing child");
      if (directory && !(nodes[at] & 1)) chargePath(1);
      nodes[at] |= directory ? 2 : 4;
      if (!directory) required.delete(path);
    },
    finish() { assert.equal(required.size, 0, "missing required archive metadata"); return { entries, nodes: count, nameBytes: used, memberBytes, pathBytes }; },
  };
}

export function safeArchive(entries, verbose) {
  assert.equal(typeof entries, "string"); assert.equal(typeof verbose, "string");
  assert.ok(entries.length <= 16 * 1024 ** 2 && verbose.length <= 32 * 1024 ** 2, "archive listing size limit");
  // Remove only one listing terminator, never whitespace belonging to a filename.
  const lines = (value) => value.replace(/\r?\n$/, "").split(/\r?\n/);
  const names = lines(entries), types = lines(verbose);
  assert.ok(names.length <= 100000, "archive entry limit");
  assert.equal(names.length, types.length, "archive listings differ");
  const paths = archivePaths();
  for (let i = 0; i < names.length; i++) {
    assert.ok(/^[d-]/.test(types[i]), "archive link or special file");
    paths.add(names[i], types[i][0] === "d");
  }
  paths.finish();
}

// Native source snapshots include route brackets, npm scopes, Cargo versions
// and the literal-percent asset fixture. Never decode or normalize these names.
export function portableEvidenceSegment(name) {
  return typeof name === "string" && /^[A-Za-z0-9_.@$%+\[\]-]+$/.test(name)
    && name !== "." && name !== ".." && !name.endsWith(".")
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

// Shared with the local kernel fixture. Older systemd ignores DelegateSubgroup;
// only this unit's sole wrapper PID may establish the equivalent leaf layout.
export function supervisorBootstrap(unit) {
  full(unit, /corten-bench-groups-r[1-9]\d{0,8}-[a-f0-9]{16}\.service/, "owned unit");
  return `IFS= read -r scope < /proc/self/cgroup
case "$scope" in
  0::*/${unit}/supervisor) parent="/sys/fs/cgroup\${scope#0::}"; parent="\${parent%/supervisor}" ;;
  0::*/${unit})
    parent="/sys/fs/cgroup\${scope#0::}"
    while IFS= read -r member; do test "$member" = "$$"; done < "$parent/cgroup.procs"
    mkdir "$parent/supervisor"
    printf '%s' "$$" > "$parent/supervisor/cgroup.procs"
    ;;
  *) exit 2 ;;
esac
test -d "$parent" && test ! -L "$parent" && test ! -L "$parent/supervisor"
while IFS= read -r member; do test -z "$member"; done < "$parent/cgroup.procs"
IFS= read -r controllers < "$parent/cgroup.controllers"
for controller in cpu cpuset memory pids; do
  case " $controllers " in *" $controller "*) ;; *) exit 2 ;; esac
done
printf '%s' '+cpu +cpuset +memory +pids' > "$parent/cgroup.subtree_control"
IFS= read -r controllers < "$parent/cgroup.subtree_control"
for controller in cpu cpuset memory pids; do
  case " $controllers " in *" $controller "*) ;; *) exit 2 ;; esac
done
while IFS= read -r member; do test "$member" = "$$"; done < "$parent/supervisor/cgroup.procs"
`;
}

// The unit does not inherit SSH_CONNECTION. Only the guarded workspace SSH
// captures its peer, in a private file on this boot.
const sshIngressOwner = "/run/corten-bench-ssh-owner";
const sshIngressSnapshot = "/run/corten-bench-ssh-ingress.nft";
const nft = "timeout -k 5 15 /usr/sbin/nft";
const listSshIngress = `${nft} --numeric --stateless --handle list table inet corten_bench_ssh`;

export const captureSshOwner = String.raw`(umask 077; /usr/bin/python3 -I -c '
import ipaddress, os
peer, source_port, local, port = os.environ["SSH_CONNECTION"].split()
assert source_port.isascii() and source_port.isdecimal() and 0 < int(source_port) <= 65535
assert port == "22"
ipaddress.IPv4Address(local)
peer = str(ipaddress.IPv4Address(peer))
with open("${sshIngressOwner}", "x", encoding="ascii") as owner:
    owner.write(peer + "\n")
')`;
const workspace = "mkdir -m 700 /bench && touch /bench/run.log";
const dedicatedWorkspace = `${workspace} && ${captureSshOwner}`;
const dedicatedWorkspaceSha256 = createHash("sha256").update(`set -euo pipefail\n${dedicatedWorkspace}\n`).digest("hex");

// Replay uses the exact recorded workspace request, not the date or version
// of the inspecting controller. Historical uploaded job bytes stay the same.
export function bootstrapWorkspaceScript(s, { launch = false } = {}) {
  const row = s.control?.ledger[1];
  return s.group && (s.control?.monitor || s.fleet?.single?.offlineHandoff) && (launch || (row?.localTerminal === true && row.code === 0
    && row.request.sequence === 1 && row.request.epoch === "bootstrap" && !row.request.seal
    && row.request.invocation.channel === "ssh" && row.request.invocation.deadlineMs === 60000
    && row.request.invocation.requestSha256 === dedicatedWorkspaceSha256))
    ? dedicatedWorkspace : workspace;
}

export const installSshIngress = String.raw`test ! -e '${sshIngressSnapshot}'
test ! -L '${sshIngressSnapshot}'
peer=$(/usr/bin/python3 -I -c '
import ipaddress, os, stat
fd = os.open("${sshIngressOwner}", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
with os.fdopen(fd, "rb") as owner:
    info = os.fstat(owner.fileno())
    assert stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600
    assert info.st_uid == 0 and info.st_nlink == 1 and 8 <= info.st_size <= 16
    raw = owner.read(17)
peer = str(ipaddress.IPv4Address(raw.decode("ascii").removesuffix("\n")))
assert raw == (peer + "\n").encode("ascii")
print(peer)
')
# Noble's nftables package neither enables nor starts nftables.service.
if ! test -x /usr/sbin/nft; then
  DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 timeout -k 5 90 apt-get \
    -o DPkg::Lock::Timeout=30 -o Acquire::Retries=0 install -y -qq --no-install-recommends --no-upgrade --no-remove nftables
fi
test -x /usr/sbin/nft
# One atomic transaction. Do not replace an existing table or accept past other filters.
${nft} -f - <<CORTEN_SSH_INGRESS
create table inet corten_bench_ssh
add chain inet corten_bench_ssh input { type filter hook input priority filter; policy accept; }
add rule inet corten_bench_ssh input tcp dport 22 ip saddr $peer return
add rule inet corten_bench_ssh input tcp dport 22 drop
CORTEN_SSH_INGRESS
(umask 077; set -C; ${listSshIngress} > '${sshIngressSnapshot}')
test -s '${sshIngressSnapshot}'`;

export const verifySshIngress = String.raw`test -f '${sshIngressSnapshot}'
test ! -L '${sshIngressSnapshot}'
test -s '${sshIngressSnapshot}'
${listSshIngress} | cmp -s -- '${sshIngressSnapshot}' -`;

export const rootManagerDrainSeconds = 120;
export const rootManagerCheckSeconds = 15;

const rootManagerDropIn = "/run/systemd/system/user@0.service.d/90-corten-benchmark.conf";
// Fixed create body, never caller-supplied cloud-init. Before the guardian
// exists, the condition checks the drop-in itself. /run is private to this boot.
export const preloginUserData = `#cloud-config
bootcmd:
  - |
    set -eu
    umask 077
    d=/run/systemd/system/user@0.service.d
    test ! -L "$d"
    mkdir -p -- "$d"
    dropin=${rootManagerDropIn}
    test ! -e "$dropin" && test ! -L "$dropin" || exit 1
    ( set -C; printf '%s\\n' '[Unit]' 'ConditionPathExists=!${rootManagerDropIn}' > "$dropin" )
    systemctl daemon-reload
`;
const rootManagerBinding = (s) => s.group && s.control && (s.control.monitor || s.fleet?.single?.offlineHandoff)
  ? `/run/corten-bench-control-${s.token}/binding.json` : null;
const rootManagerPolicy = (marker, prelogin = false) => `test -f '${marker}'
test ! -L '${marker}'
dropin=${rootManagerDropIn}
test ! -L /run/systemd/system/user@0.service.d
${prelogin ? `test -f "$dropin" && test ! -L "$dropin" || exit 1
test "$(stat -c '%u:%g:%a:%h' -- "$dropin")" = 0:0:600:1
cmp -s -- "$dropin" <(printf '%s\\n' '[Unit]' 'ConditionPathExists=!${rootManagerDropIn}')
test ! -e "$dropin.next" && test ! -L "$dropin.next" || exit 1
( umask 077; set -C; printf '%s\\n' '[Unit]' 'ConditionPathExists=!${marker}' > "$dropin.next" )
mv -T -- "$dropin.next" "$dropin"` : `mkdir -p -- /run/systemd/system/user@0.service.d
test ! -e "$dropin"
test ! -L "$dropin"
( set -C; printf '%s\\n' '[Unit]' 'ConditionPathExists=!${marker}' > "$dropin" )`}
`;
const observeRootManager = `    echo "root-manager: querying ActiveState" >&2
    state=$(systemctl show user@0.service --property=ActiveState --value)
    case "$state" in
      active|activating|deactivating|reloading|inactive|failed) ;;
      *) echo "root-manager: unexpected ActiveState" >&2; exit 1 ;;
    esac
    echo "root-manager: ActiveState=$state; querying MainPID" >&2
    main_pid=$(systemctl show user@0.service --property=MainPID --value)
    [[ "$main_pid" =~ ^[0-9]{1,10}$ ]] || { echo "root-manager: invalid MainPID" >&2; exit 1; }
    echo "root-manager: ActiveState=$state MainPID=$main_pid" >&2`;

export function installBenchmarkUnit(s) {
  const install = `bash -n /bench/job.sh && bash -n /bench/pack.sh && install -m 644 /bench/${s.unit} /etc/systemd/system/${s.unit} && systemd-analyze verify /etc/systemd/system/${s.unit}`;
  const binding = rootManagerBinding(s);
  assert.ok(!s.quietBootstrap || binding, "quiet bootstrap requires a guardian binding");
  return s.quietBootstrap
    ? `${install} || exit 1\n${rootManagerPolicy(binding, s.quietBootstrap === "prelogin")}systemctl daemon-reload`
    : `${install} && systemctl daemon-reload`;
}

// Fixed source-bound entry point. No caller-provided command or adapter filtering.
// Only file reconstruction for destroyed native failures accepts these exact
// former single-group rosters. Reservation, launch and live custody stay strict.
const retiredRosterDigests = Object.freeze({
  "localized-marketplace": "b374b8f7bb9600efb0f06abc30dd08bbbaf97ef8fafb7e3858e83fd5d32570a8", // r27/r41
  "json-api": "18f956a01ac4e7fca9c50366d2f3117088b520804b408d553ba69e5298b957ce", // r67/r99/r105
});
export function validateRemoteFileState(s) {
  const group = s.fleet?.single?.group;
  const priorSelection = s.status === "retired" && s.destroyedAt && s.retirement?.kind === "native-failed"
    && s.schema === "benchmark-dedicated-group-host/v1" && Object.hasOwn(retiredRosterDigests, group)
    && s.fleet.selection && digest(s.fleet.selection) === retiredRosterDigests[group];
  return validateState(s, s.round, { priorSelection });
}

// Embed the exact CI verifier in job.sh: a fresh guest has no checkout, and the
// pinned controller/worker must not load a new, unbound runtime input.
// git-source.test.mjs checks it against scripts/benchmark-evidence-git.sh.
const sourceGitInstall = String.raw`bootstrap_stage=git-install
timeout -k 10 900 apt-get -o Acquire::Retries=5 install -y -qq --no-install-recommends gpgv libcurl4-gnutls-dev libexpat1-dev libpcre2-dev libssl-dev perl pkg-config xz-utils zlib1g-dev
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
(
  git_build=$(mktemp -d /tmp/corten-git-build.XXXXXXXXXX)
  trap 'code=$?; timeout -k 5 60 rm -rf -- "$git_build" || exit 1; exit "$code"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  cd "$git_build"
  timeout -k 10 420 /bin/sh <<'CORTEN_GIT_VERIFY'
#!/bin/sh
# Run in an empty build directory. Git signs the .tar, not the .tar.xz.
set -eu
base=https://www.kernel.org/pub/software/scm/git/git-2.56.1.tar
get() { curl --proto '=https' --proto-redir '=https' -fsSL --retry 3 --max-time 90 "$1" -o "$2"; }
get "$base.xz" git.tar.xz
echo 'f0b0bf89264b9bd2e1c640363e7529643989da76281600473c50745cd34a607f  git.tar.xz' | sha256sum -c -
get "$base.sign" git.tar.sign
get https://github.com/gitster.gpg release-key.asc
export GNUPGHOME="$PWD/gnupg"
mkdir -m 700 "$GNUPGHOME"
gpg --batch --dearmor -o release-key.gpg release-key.asc
xz -dc git.tar.xz > git.tar
gpgv --status-fd 1 --keyring "$PWD/release-key.gpg" git.tar.sign git.tar > signer
verified=$(awk '$1=="[GNUPG:]" && $2=="VALIDSIG"{print $3, $NF}' signer)
test "$verified" = \
  'E1F036B1FEE7221FC778ECEFB0B5E88696AFE6CB 96E07AF25771955980DAD10020D04E5A713660A7'
CORTEN_GIT_VERIFY
  timeout -k 10 120 tar -xf git.tar
  timeout -k 10 900 make -C git-2.56.1 -j2 prefix=/usr/local INSTALL_STRIP=-s INSTALL_SYMLINKS=1 \
    NO_RUST=1 NO_GETTEXT=1 NO_TCLTK=1 NO_GITWEB=1 USE_LIBPCRE2=1 install
  timeout -k 5 60 /bin/bash -euo pipefail <<'CORTEN_GIT_CHECK'
test "$(command -v git)" = /usr/local/bin/git
test -x "$(git --exec-path)/git-remote-https"
version=$(git --no-replace-objects --no-lazy-fetch --version)
test "$version" = 'git version 2.56.1'
unset GIT_NO_REPLACE_OBJECTS GIT_NO_LAZY_FETCH
git init -q source
printf evidence > source/blob
git -C source add blob
git -C source -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm fixture
git -C source config uploadpack.allowFilter true
git clone -q --no-local --no-checkout --filter=blob:none "$PWD/source" replay
git -C replay config protocol.file.allow always
oid=$(git -C source rev-parse HEAD:blob)
if git --no-replace-objects --no-lazy-fetch -C replay cat-file blob "$oid" >/dev/null 2>&1; then exit 1; fi
test "$(git --no-replace-objects -C replay cat-file blob "$oid")" = evidence
test "$(git --no-replace-objects --no-lazy-fetch -C replay cat-file blob "$oid")" = evidence
replacement=$(printf replaced | git -C source hash-object -w --stdin)
git -C source replace "$oid" "$replacement"
test "$(git -C source cat-file blob "$oid")" = replaced
test "$(git --no-replace-objects -C source cat-file blob "$oid")" = evidence
{
  printf '%s\n' "$version" 'git-source-url=https://www.kernel.org/pub/software/scm/git/git-2.56.1.tar.xz'
  printf 'git-source-sha256='; sha256sum git.tar.xz | cut -d ' ' -f 1
  printf 'git-source-signer='; awk '$1=="[GNUPG:]" && $2=="VALIDSIG"{print $3, $NF}' signer
} >> /bench/host.txt
CORTEN_GIT_CHECK
)
`;

export function remoteFiles(s) {
  validateRemoteFileState(s);
  const loadLayout = savedLoadLayout(s);
  const placement = savedPlacement(s);
  const sshIngress = bootstrapWorkspaceScript(s) === dedicatedWorkspace;
  // Dedicated group runners are system services. Their root SSH sessions need
  // logind scopes, not a user service manager. Leave any existing session alone.
  const marker = rootManagerBinding(s);
  const prelogin = s.quietBootstrap === "prelogin", afterStart = prelogin || s.quietBootstrap === "after-start";
  // Type=exec acknowledges this unit after exec. Anchor the host deadline to
  // that event, not to how long metadata collection or scheduling happened to take.
  const drain = afterStart ? `bootstrap_stage=root-manager-drain
sample_manager() {
  echo "root-manager: $1" >&2
  timeout 5 systemctl show user@0.service --all --property=ActiveState,MainPID,ActiveEnterTimestampMonotonic
}
start_us=$(timeout 5 systemctl show ${s.unit} --property=ExecMainStartTimestampMonotonic --value)
[[ "$start_us" =~ ^[1-9][0-9]{0,19}$ ]] || { echo "root-manager: missing unit start time" >&2; exit 1; }
sample_manager before-drain
python3 -I -c 'import sys,time
start = int(sys.argv[1])
elapsed = time.monotonic_ns() // 1000 - start
if elapsed < 0: sys.exit("invalid unit start time")
time.sleep(max(0, ${rootManagerDrainSeconds} - elapsed / 1000000))' "$start_us"
sample_manager after-drain
` : "";
  const checkWindow = afterStart ? `python3 -I -c 'import sys,time
elapsed = time.monotonic_ns() // 1000 - int(sys.argv[1])
if not ${rootManagerDrainSeconds * 1_000_000} <= elapsed < ${(rootManagerDrainSeconds + rootManagerCheckSeconds) * 1_000_000}:
    sys.exit("root-manager: idle proof outside post-start quiet window")' "$start_us"
` : "";
  const loginPolicy = marker ? `bootstrap_stage=root-manager-policy
${rootManagerPolicy(marker)}systemctl daemon-reload
` : "";
  const waitForIdleUserManager = marker ? `bootstrap_stage=root-manager-idle
timeout ${rootManagerDrainSeconds} bash -ec '
  while :; do
${observeRootManager}
    case "$state" in
      inactive) test "$main_pid" = 0; break ;;
      failed) exit 1 ;;
      *) sleep 1 ;;
    esac
  done'
` : "";
  const requireIdleUserManager = (stage) => `bootstrap_stage=${stage}
timeout ${rootManagerCheckSeconds} bash -e -o pipefail -c '
    test -f "$1" && test ! -L "$1" || exit 1
    test -f "$2" && test ! -L "$2" || exit 1
    cmp -s -- "$2" <(printf "%s\\n" "[Unit]" "$3")
    # The condition must be mandatory (not a trigger), negated and in the loaded unit.
    busctl --json=short get-property org.freedesktop.systemd1 /org/freedesktop/systemd1/unit/user_400_2eservice org.freedesktop.systemd1.Unit Conditions |
      python3 -I -c "
import json, sys
reply = json.load(sys.stdin)
expected = [\\"ConditionPathExists\\", False, True, sys.argv[1]]
sys.exit(not (reply[\\"type\\"] == \\"a(sbbsi)\\" and any(row[:4] == expected for row in reply[\\"data\\"])))
" "\${3#ConditionPathExists=!}" ||
      { echo "root-manager: effective binding condition missing" >&2; exit 1; }
${observeRootManager}
${prelogin ? `    busctl --json=short call org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager ListSessions |
      python3 -I -c "
import json, os, sys, time
raw = sys.stdin.buffer.read(8193)
assert len(raw) <= 8192
reply = json.loads(raw)
assert reply[\\"type\\"] == \\"a(susso)\\"
sessions, = reply[\\"data\\"]
assert isinstance(sessions, list) and all(len(s) == 5 and type(s[1]) is int for s in sessions)
count = sum(s[1] == 0 for s in sessions)
linger = os.path.exists(\\"/var/lib/systemd/linger/root\\")
print(f\\"root-manager: monotonic-us={time.monotonic_ns() // 1000} root-sessions={count} linger-file={int(linger)}\\", file=sys.stderr)
${stage === "root-manager-idle" ? 'if count: sys.exit(\\"root-manager: root session before provisioning\\")' : "# The registered monitor may now have a session."}"
` : ""}    test "$state" = inactive && test "$main_pid" = 0
' root-manager '${marker}' '${rootManagerDropIn}' 'ConditionPathExists=!${marker}'
`;
  const pack = `#!/bin/bash
set -euo pipefail
cd /bench
test -f exit-code
files=(run.log host.txt exit-code)
test ! -d campaign || files+=(campaign)
tar -czf results.tgz.tmp "\${files[@]}"
mv results.tgz.tmp results.tgz
`;
  const job = `#!/bin/bash
set -Eeuo pipefail
exec >>/bench/run.log 2>&1
{ date -u --iso-8601=seconds; uname -a; lscpu; free -m; df -h /; } > /bench/host.txt
finish() { code=$?; trap - EXIT; printf '%s\\n' "$code" > /bench/exit-code; timeout 600 /bin/bash /bench/pack.sh || true; exit "$code"; }
trap finish EXIT
bootstrap_stage=supervisor
bootstrap_error() { local code=$?; trap - ERR; printf 'benchmark job failed: stage=%s line=%s exit=%s\\n' "$bootstrap_stage" "$1" "$code" >&2; return "$code"; }
trap 'bootstrap_error "$LINENO"' ERR
${supervisorBootstrap(s.unit)}
${drain}${s.quietBootstrap ? requireIdleUserManager("root-manager-idle") : ""}${checkWindow}bootstrap_stage=cloud-init
timeout 900 cloud-init status --wait
${s.quietBootstrap ? "" : loginPolicy}# Fresh disposable hosts only: prevent timer and D-Bus firmware activation before baseline.
bootstrap_stage=firmware-mask
systemctl mask --runtime --now fwupd.service fwupd-refresh.service fwupd-refresh.timer
bootstrap_stage=package-services
${sshIngress ? "timeout -k 5 30 " : ""}systemctl disable --now apt-daily.timer apt-daily-upgrade.timer${sshIngress ? "" : " || true"}
timeout 900 systemd-run --quiet --property=After=apt-daily.service --property=After=apt-daily-upgrade.service --wait /bin/true
export DEBIAN_FRONTEND=noninteractive
bootstrap_stage=package-prerequisites
timeout 900 apt-get update -qq
timeout 900 apt-get install -y -qq gnupg curl ca-certificates build-essential
${sshIngress ? `bootstrap_stage=ssh-ingress-install
${installSshIngress}
` : ""}${s.gitSource ? sourceGitInstall : `# https://git-scm.com/install/linux: Ubuntu's upstream stable Git PPA.
# Distribution Git may lack --no-lazy-fetch; never weaken immutable native queries.
bootstrap_stage=git-install
# Use the signed PPA directly; add-apt-repository's metadata API can truncate reads.
install -d -m 0755 /etc/apt/keyrings
timeout 60 curl --proto '=https' --tlsv1.2 --fail --silent --show-error --max-time 60 'https://keyserver.ubuntu.com/pks/lookup?op=get&search=0xF911AB184317630C59970973E363C90F8F1B6217' -o /tmp/corten-git-ppa.asc
gpg --batch --show-keys --with-colons /tmp/corten-git-ppa.asc > /tmp/corten-git-ppa.keys
git_primary_fingerprints=$(awk -F: '$1 == "pub" { primary=1; next } primary && $1 == "fpr" { print $10; primary=0 }' /tmp/corten-git-ppa.keys)
test "$git_primary_fingerprints" = F911AB184317630C59970973E363C90F8F1B6217
install -m 0644 /tmp/corten-git-ppa.asc /etc/apt/keyrings/corten-git-ppa.asc
install -m 0644 /dev/null /etc/apt/sources.list.d/corten-git-ppa.list
printf '%s\\n' 'deb [signed-by=/etc/apt/keyrings/corten-git-ppa.asc] https://ppa.launchpadcontent.net/git-core/ppa/ubuntu noble main' > /etc/apt/sources.list.d/corten-git-ppa.list
rm /tmp/corten-git-ppa.keys /tmp/corten-git-ppa.asc
timeout 900 apt-get update -qq
timeout 900 apt-get install -y -qq git
timeout 30 git --no-replace-objects --no-lazy-fetch --version >> /bench/host.txt
`}bootstrap_stage=docker-install
timeout 900 bash -o pipefail -c 'curl -fsSL https://get.docker.com | sh'
bootstrap_stage=node-install
timeout 900 bash -o pipefail -c 'curl -fsSL https://deb.nodesource.com/setup_26.x | bash -'
timeout 900 apt-get install -y -qq nodejs
node -e 'if (process.versions.node.split(".")[0] !== "26") process.exit(1)'
systemctl enable --now docker
export GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1
bootstrap_stage=source-checkout
timeout 600 git clone --quiet https://github.com/corten-run/corten.git /bench/repo
cd /bench/repo
git checkout --detach ${s.commit}
test "$(git rev-parse HEAD)" = ${s.commit}
test -z "$(git status --porcelain --untracked-files=all)"
bootstrap_stage=host-capacity
test "$(nproc)" -ge ${jsonFleetPlacementFor(s.group, loadLayout)?.logicalCpus ?? (loadLayout ? 16 : 8)}
bootstrap_stage=root-dependencies
timeout 900 npm ci --no-audit --no-fund
${s.benchPackage ? `bootstrap_stage=bench-dependencies
timeout 900 npm --prefix bench ci --no-audit --no-fund
` : ""}bootstrap_stage=browser-dependencies
timeout 900 npm --prefix bench/browser ci --no-audit --no-fund
${s.skipHostChromium ? "" : `bootstrap_stage=browser-install
timeout 900 npx --no-install playwright install --with-deps chromium
`}bootstrap_stage=upstream-image
timeout 900 docker pull ${s.trixieUpstream ? upstreamImages.trixie : upstreamImages.bookworm}
bootstrap_stage=rust-install
timeout 900 bash -o pipefail -c 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal'
export PATH=/root/.cargo/bin:$PATH
bootstrap_stage=tool-versions
{ docker --version; node --version; npm --version; rustc --version; cargo --version; } >> /bench/host.txt
bootstrap_stage=firmware-verification
for unit in fwupd.service fwupd-refresh.service fwupd-refresh.timer; do
  load_state=$(systemctl show "$unit" --property=LoadState --value)
  active_state=$(systemctl show "$unit" --property=ActiveState --value)
  main_pid=0
  case "$unit" in *.service) main_pid=$(systemctl show "$unit" --property=MainPID --value) ;; esac
  printf 'firmware unit=%s load=%s active=%s pid=%s\\n' "$unit" "$load_state" "$active_state" "$main_pid"
  test "$load_state" = masked
  test "$main_pid" = 0
  case "$active_state" in
    inactive) ;;
    failed) systemctl reset-failed "$unit" ;;
    *) false ;;
  esac
  # Masking stops activation but does not clear a stopped unit's failed state.
  # Reset only that state, then independently require the same strict boundary.
  load_state=$(systemctl show "$unit" --property=LoadState --value)
  test "$load_state" = masked
  active_state=$(systemctl show "$unit" --property=ActiveState --value)
  test "$active_state" = inactive
  case "$unit" in
    *.service)
      main_pid=$(systemctl show "$unit" --property=MainPID --value)
      test "$main_pid" = 0 ;;
  esac
done
# The entry derives all nine groups and their native settings from this measured source.
# Popular/performance views reuse the same evidence; no second workload execution.
unset BENCH_APPS BENCH_TIER BENCH_EDGE PROFILE
${s.quietBootstrap ? requireIdleUserManager("root-manager-verification") : waitForIdleUserManager}${sshIngress ? `bootstrap_stage=ssh-ingress-verification
${verifySshIngress}
` : ""}bootstrap_stage=native-entry
node bench/workloads/isolated/campaign-entry.mjs ${s.round} --commit ${s.commit} --state-dir /bench/campaign${s.group === undefined ? "" : ` --group ${s.group}`}${loadLayout ? ` --load-layout ${loadLayout}` : ""}${placement ? ` --placement ${placement}` : ""}
`;
  return { "job.sh": job, "pack.sh": pack, [s.unit]: `[Unit]
Description=Official grouped benchmark ${s.round}, pinned ${s.commit}
After=network-online.target
Wants=network-online.target
[Service]
Type=exec
ExecStart=/bin/bash /bench/job.sh
${s.fleet?.single?.offlineHandoff ? "ExecStopPost=-/usr/bin/timeout -k 5 15 /usr/sbin/nft delete table inet corten_bench_native\n" : ""}WorkingDirectory=/bench
Delegate=cpu cpuset memory pids
DelegateSubgroup=supervisor
Restart=no
RuntimeMaxSec=48h
TimeoutStopSec=120
KillMode=control-group
` };
}
