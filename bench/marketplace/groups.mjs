import assert from "node:assert/strict";
import { apps } from "./contract.mjs";
import { selectedApps } from "../workloads/registry.mjs";

// Candidate pools, not winners or a claim about current marketplace performance.
// Popularity follows the survey cohort proposed in issue 817, updated for the two
// adapters added by issue 818. Performance candidates start with that proposal's
// ASP.NET/Topcoat/Leptos shortlist; no legacy number becomes a v2 speed claim.
export const cohorts = {
  popular: ["nextjs", "aspnet", "fastapi", "express"],
  performant: ["aspnet", "topcoat", "leptos"],
};
export const groupNames = ["production", "production-popular", "production-performant", "production-qualify", "localized-marketplace"];
export function groupApps(group) {
  // Pre-group evidence/reservations retain their exact original inventory.
  if (group === undefined) return [...apps];
  assert.ok(groupNames.includes(group), `unknown marketplace group: ${group}`);
  if (group === "localized-marketplace") return selectedApps(group);
  const candidates = group === "production-qualify" ? apps
    : group === "production-popular" ? cohorts.popular
      : group === "production-performant" ? cohorts.performant : Object.values(cohorts).flat();
  const selected = [...new Set(["corten", ...candidates])];
  assert.ok(selected.every((a) => apps.includes(a)), "group candidate missing from the official inventory");
  return selected;
}
// One deduplicated run serves both cohorts. No automatic axum anchor and no
// runtime-family rotation: every admitted peer must pass the production contract.
export function scheduledGroup(round) {
  assert.match(round ?? "", /^r[1-9]\d*$/);
  const n = Number(round.slice(1));
  assert.ok(Number.isSafeInteger(n) && n >= 17);
  // The new registry is explicit opt-in until native parity work is qualified.
  // Do not silently change the existing automation while its previous round is pending.
  return "production";
}
