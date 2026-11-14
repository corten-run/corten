import assert from "node:assert/strict";
import { bindExecution } from "./contract.mjs";
import { groupNames } from "../registry.mjs";
import { deploymentSha256 } from "../deployments.mjs";
import { parseArgs } from "../../json-api/contract.mjs";
import { parseArgs as mixedOptions } from "../../mixed-production/run.mjs";

export const campaignSchema = "benchmark-isolated-campaign/v1";
export const groupCampaignSchema = "benchmark-isolated-group-campaign/v1";
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
export function campaignRounds(round) {
  assert.equal(typeof round, "string"); assert.match(round, /^r[1-9]\d*$/);
  const n = Number(round.slice(1));
  assert.ok(Number.isSafeInteger(n) && n >= 17 && n <= 1000000000, "official campaign round must be r17..r1000000000");
  return Object.fromEntries(groupNames.map((group) => [group, group === "catalog-page" ? `c${n}`
    : group === "json-api" ? `j${2 * n + 1}` : group === "localized-marketplace" ? round
      : ["live-delivery", "recoverable-live"].includes(group) ? round : `w${n}`]));
}
export function bindCampaign(input) {
  exact(input, ["round", "commit"]);
  return bindNativeCampaign(input, groupNames, campaignSchema);
}
export function bindGroupCampaign(input) {
  exact(input, ["round", "commit", "group"]);
  const { group, ...request } = input;
  assert.ok(groupNames.includes(group), "unknown registry group");
  return bindNativeCampaign(request, [group], groupCampaignSchema);
}
function bindNativeCampaign(input, order, schema) {
  const rounds = campaignRounds(input.round);
  const bindings = order.map((group) => bindExecution({ group, round: rounds[group], commit: input.commit,
    recipe: productionRecipes[group], review: null }));
  const first = bindings[0];
  assert.ok(bindings.every((b) => b.sources.sha256 === first.sources.sha256), "source changed while binding campaign");
  const procedures = ["bench/catalog/README.md", "bench/json-api/README.md", "bench/marketplace/nightly.md",
    "bench/mixed-production/README.md", "bench/fullstack-browser/README.md", "bench/client-heavy/README.md",
    "bench/live/README.md", "bench/recoverable-live/README.md", "bench/hardening/README.md"]
    .map((path) => { const entry = first.sources.files.find((e) => e.path === path); assert.ok(entry, `missing procedure ${path}`); return entry; });
  const body = { schema, ...input, bindings, procedures, recipes: productionRecipes,
    sourceSha256: first.sources.sha256, order: [...order], ready: false, executionAuthorized: false };
  return freeze({ ...body, campaignSha256: deploymentSha256(body) });
}
export function validateCampaign(plan) {
  const request = { round: plan?.round, commit: plan?.commit };
  const expected = plan?.schema === groupCampaignSchema ? bindGroupCampaign({ ...request, group: plan.order?.[0] }) : bindCampaign(request);
  assert.deepEqual(plan, expected, "campaign differs from fixed native bindings");
}

// These are operational phases, not arbitrary overrides or a replacement native parser.
export function jsonPhase(plan, phase, receiptPath) {
  const binding = plan.bindings.find((b) => b.request.group === "json-api");
  assert.ok(binding); assert.ok(["prepare", "timing"].includes(phase));
  const round = phase === "prepare" ? `j${2 * Number(plan.round.slice(1))}` : binding.request.round;
  const argv = ["bench/json-api/run.mjs", round, "--group", "json-api"];
  if (phase === "prepare") argv.push("--build", "--check-only");
  else { assert.equal(typeof receiptPath, "string"); argv.push("--receipts", receiptPath); }
  return freeze({ ...binding, request: { ...binding.request, round },
    execution: { ...binding.execution, invocation: { executable: "node", argv }, effectiveOptions: parseArgs(argv.slice(1)) },
    validation: { ...binding.validation, artifactRoot: `bench/json-api/results/${round}` } });
}

export function mixedPhase(plan, id) {
  assert.match(id, new RegExp(`^${plan.round}-[a-f0-9]{16}$`));
  const binding = plan.bindings.find((b) => b.request.group === "mixed-production"); assert.ok(binding);
  assert.equal(binding.execution.effectiveOptions.nativeAudits, null);
  const argv = [...binding.execution.invocation.argv, "--native-audits", `/bench/campaign/${id}/mixed-native-audits.json`];
  const options = mixedOptions(argv.slice(1)); options.apps = [...binding.selection.apps];
  return freeze({ ...binding, execution: { ...binding.execution, invocation: { ...binding.execution.invocation, argv }, effectiveOptions: options } });
}
