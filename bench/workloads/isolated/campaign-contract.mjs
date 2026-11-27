import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { alternateCampaignPlacements, bindExecution, clientComparisonRecipe } from "./contract.mjs";
import { campaignRounds, groupNames, jsonPreparationInvocation, jsonPreparationRound, jsonTimingInvocation, nativeArtifactRoot } from "../registry.mjs";
import { catalogFleetPlacement, jsonFleetPlacementFor } from "../cloud-contract.mjs";
import { deploymentSha256 } from "../deployments.mjs";
import { parseArgs } from "../../json-api/contract.mjs";
import { parseArgs as mixedOptions } from "../../mixed-production/run.mjs";
import { springWebflux } from "../../mixed-production/source-audit.mjs";
import { nativeControlPartition } from "./native-roles.mjs";

export const campaignSchema = "benchmark-isolated-campaign/v1";
export const groupCampaignSchema = "benchmark-isolated-group-campaign/v1";
export const auditWaitMs = 24 * 60 * 60 * 1000;
export const productionRecipes = Object.freeze(Object.fromEntries(groupNames.map((group) => [group,
  group === "localized-marketplace" ? "marketplace-short-window"
    : group === "mixed-production" ? "mixed-production-measure"
      : ["live-delivery", "recoverable-live"].includes(group) ? "native-feed-measure" : "native-defaults"])));
export function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function exact(value, fields) {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype, "plain object required");
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort(), "unexpected or missing fields");
}
export function verifyOfflineAuditClock(sample, bootId) {
  exact(sample, ["bootId", "monoNs"]);
  assert.match(sample.bootId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.equal(sample.bootId, bootId, "offline audit clock boot differs");
  assert.match(sample.monoNs, /^(0|[1-9]\d{0,19})$/);
  return BigInt(sample.monoNs);
}
export function offlineAuditRemainingMs(waiting, now, bootId) {
  const elapsed = verifyOfflineAuditClock(now, bootId) - verifyOfflineAuditClock(waiting, bootId);
  assert.ok(elapsed >= 0n, "offline audit clock regressed");
  const remainingNs = BigInt(auditWaitMs) * 1000000n - elapsed;
  return remainingNs > 0n ? Number((remainingNs + 999999n) / 1000000n) : 0;
}
export function verifyOfflineAuditStart(sample, bootstrap, preparation) {
  const bootId = bootstrap.host.bootId;
  const start = verifyOfflineAuditClock(sample, bootId);
  const closed = verifyOfflineAuditClock({ bootId, monoNs: bootstrap.closedMonoNs }, bootId);
  assert.ok(start >= closed, "offline audit wait predates bootstrap closure");
  if (preparation) {
    // These are the same host boundaries used to prove cleanup, not the
    // review or journal's wall time. A settled census supersedes the first.
    const { before, after, settled, terminalClock } = preparation;
    const observed = (host) => verifyOfflineAuditClock({ bootId: host.bootId, monoNs: host.offlineMonoNs }, bootId);
    const first = observed(before), last = observed(after);
    assert.ok(closed <= first && first <= last, "offline audit preparation clock is out of order");
    assert.deepEqual(after.terminalClock, terminalClock, "offline audit terminal clock differs from sealed lifetime");
    if (terminalClock) {
      const terminal = verifyOfflineAuditClock({ bootId: terminalClock.bootId, monoNs: terminalClock.monoNs }, bootId);
      assert.ok(first <= terminal && terminal <= last, "offline audit terminal clock is outside preparation");
    }
    const end = settled ? observed(settled) : last;
    assert.ok(last <= end, "offline audit settled clock predates the first cleanup census");
    assert.ok(end <= start, "offline audit wait predates preparation completion");
  }
}
export { campaignRounds };
export function bindCampaign(input) {
  exact(input, ["round", "commit"]);
  return bindNativeCampaign(input, groupNames, campaignSchema, "legacy");
}
export function bindGroupCampaign(input, mode = "dedicated") {
  exact(input, ["round", "commit", "group"]);
  const { group, ...request } = input;
  assert.ok(groupNames.includes(group), "unknown registry group");
  assert.ok(mode === "dedicated" || alternateCampaignPlacements.includes(mode) && group !== "catalog-page"
    || mode === catalogFleetPlacement.loadLayout && group === "catalog-page"
    || jsonFleetPlacementFor(group, mode), "unknown group placement");
  return bindNativeCampaign(request, [group], groupCampaignSchema, mode);
}
function bindNativeCampaign(input, order, schema, mode) {
  const rounds = campaignRounds(input.round);
  const dedicatedRecipe = schema === groupCampaignSchema && (order[0] === "mixed-production" ? springWebflux.recipe
    : order[0] === "client-heavy" ? clientComparisonRecipe : null);
  const recipes = dedicatedRecipe ? { ...productionRecipes, [order[0]]: dedicatedRecipe } : productionRecipes;
  const bindings = order.map((group) => bindExecution({ group, round: rounds[group], commit: input.commit,
    recipe: recipes[group], review: null }, mode));
  const first = bindings[0];
  assert.ok(bindings.every((b) => b.sources.sha256 === first.sources.sha256), "source changed while binding campaign");
  const procedures = ["bench/catalog/README.md", "bench/json-api/README.md", "bench/marketplace/nightly.md",
    "bench/mixed-production/README.md", "bench/fullstack-browser/README.md", "bench/client-heavy/README.md",
    "bench/live/README.md", "bench/recoverable-live/README.md", "bench/hardening/README.md"]
    .map((path) => { const entry = first.sources.files.find((e) => e.path === path); assert.ok(entry, `missing procedure ${path}`); return entry; });
  const body = { schema, ...input, bindings, procedures, recipes,
    sourceSha256: first.sources.sha256, order: [...order], ready: false, executionAuthorized: false };
  return freeze({ ...body, campaignSha256: deploymentSha256(body) });
}
export function validateCampaign(plan) {
  assert.ok([campaignSchema, groupCampaignSchema].includes(plan?.schema), "campaign differs from fixed native bindings");
  const request = { round: plan?.round, commit: plan?.commit };
  const expected = plan?.schema === groupCampaignSchema
    ? bindGroupCampaign({ ...request, group: plan.order?.[0] }, plan.bindings?.[0]?.campaignMode) : bindCampaign(request);
  // A full plan includes every group's source manifest. Keep exact comparison
  // without constructing a potentially enormous assertion diff on rejection.
  assert.ok(isDeepStrictEqual(plan, expected), "campaign differs from fixed native bindings");
}

// The input is the generated plan, not a controller-side substitute for it.
export function campaignRoleBlockers(plan) {
  return plan.bindings.flatMap((binding) => {
    try { nativeControlPartition(binding); return []; }
    catch {
      const group = binding.request.group;
      return [group + ": native actor-role compatibility unavailable"];
    }
  });
}

// These are operational phases, not arbitrary overrides or a replacement native parser.
export function jsonPhase(plan, phase, receiptPath) {
  const binding = plan.bindings.find((b) => b.request.group === "json-api");
  assert.ok(binding); assert.ok(["prepare", "timing"].includes(phase));
  const round = phase === "prepare" ? jsonPreparationRound(plan.round) : binding.request.round;
  if (phase === "timing") assert.equal(typeof receiptPath, "string");
  const invocation = phase === "prepare" ? jsonPreparationInvocation(plan.round)
    : jsonTimingInvocation(round, receiptPath);
  return freeze({ ...binding, request: { ...binding.request, round },
    execution: { ...binding.execution, invocation, effectiveOptions: parseArgs(invocation.argv.slice(1)) },
    validation: { ...binding.validation, artifactRoot: nativeArtifactRoot("json-api", round) } });
}

export function mixedPhase(plan, id) {
  assert.match(id, new RegExp(`^${plan.round}-[a-f0-9]{16}$`));
  const binding = plan.bindings.find((b) => b.request.group === "mixed-production"); assert.ok(binding);
  assert.equal(binding.execution.effectiveOptions.nativeAudits, null);
  const argv = [...binding.execution.invocation.argv, "--native-audits", `/bench/campaign/${id}/mixed-native-audits.json`];
  const options = mixedOptions(argv.slice(1)); options.apps = [...binding.selection.apps];
  return freeze({ ...binding, execution: { ...binding.execution, invocation: { ...binding.execution.invocation, argv }, effectiveOptions: options } });
}
