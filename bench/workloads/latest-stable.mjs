import { createHash } from "node:crypto";
import { groupNames } from "./registry.mjs";

export const latestStableSchema = "benchmark-latest-stable-evaluation/v1";
export const latestStableSources = Object.freeze({
  policy: "bench/workloads/latest-stable.json",
  manifest: "bench/browser/package.json",
  lockfile: "bench/browser/package-lock.json",
});

// A policy edit, including removal of a blocker, needs a reviewed evaluator update.
// This is an integrity check on the fixed record, not a signature or a latest resolver.
const reviewedPolicySha256 = "091ec3f9d888cd2474debff2f08dbb41596d641f6c547d5d91eb7966cfff5580";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => value && typeof value === "object"
  ? Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value);

/**
 * Offline, read-only policy evaluation of UTF-8 source strings or byte arrays.
 * The caller must bind these exact bytes AND this module/registry to its trusted
 * source closure, then recompute on offline admission, not trust a saved verdict.
 * Lock metadata is not proof of installed compiler bytes; retain npm closure checks.
 * A valid result means the blocked record matches, never that a group is eligible.
 * Keep every campaign/group/contender and its native outcomes visible. This module
 * does not launch, filter or mutate them, nor decide global campaign admission.
 * Not-applicable means only that this fixed Babel target does not cover the group.
 */
export function evaluateLatestStable(input = {}) {
  const { group, policy, manifest, lockfile } = input && typeof input === "object" ? input : {};
  const result = {
    schema: latestStableSchema, group: typeof group === "string" ? group : null,
    valid: false, status: "invalid", groupComparisonEligible: false, checkedOn: null,
    errors: [], targets: [], sources: {},
  };
  const read = (name, input) => {
    if (typeof input !== "string" && !(input instanceof Uint8Array)) {
      result.errors.push(`${name}:missing-source`); return null;
    }
    const bytes = Buffer.from(input);
    result.sources[name] = { path: latestStableSources[name], bytes: bytes.length, sha256: sha256(bytes) };
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      result.errors.push(`${name}:invalid-json`); return null;
    }
  };
  const record = read("policy", policy);
  if (!record || sha256(canonical(record)) !== reviewedPolicySha256) {
    result.errors.push("policy:unreviewed-record"); return result;
  }
  result.checkedOn = record.checkedOn;
  if (!groupNames.includes(group)) {
    result.errors.push("group:unknown"); return result;
  }
  const targets = record.targets.filter((target) => target.groups.includes(group));
  if (targets.length === 0) {
    return { ...result, valid: true, status: "not-applicable", groupComparisonEligible: null };
  }
  result.targets = targets;
  const pkg = read("manifest", manifest), lock = read("lockfile", lockfile);
  const requireMatch = (condition, error) => { if (!condition) result.errors.push(error); };
  requireMatch(pkg && typeof pkg === "object" && !Array.isArray(pkg), "manifest:invalid-shape");
  requireMatch(lock?.lockfileVersion === 3 && lock.packages?.[""], "lockfile:invalid-shape");
  if (result.errors.length) return result;
  for (const kind of ["dependencies", "devDependencies", "optionalDependencies"]) {
    requireMatch(canonical(pkg[kind] ?? {}) === canonical(lock.packages[""][kind] ?? {}), `lockfile:root-${kind}-mismatch`);
  }
  for (const target of targets) {
    requireMatch(pkg.devDependencies?.[target.package] === target.resolved
      && !Object.hasOwn(pkg.dependencies ?? {}, target.package)
      && !Object.hasOwn(pkg.optionalDependencies ?? {}, target.package), "manifest:target-version-mismatch");
    requireMatch(pkg.devDependencies?.[target.blockers[0].package] === target.blockers[0].version,
      "manifest:compiler-version-mismatch");
    const expected = [{ package: target.package, version: target.resolved }, ...target.blockers];
    for (const dependency of expected) {
      const path = `node_modules/${dependency.package}`, installed = lock.packages[path];
      requireMatch(installed?.version === dependency.version, `lockfile:${dependency.package}:version-mismatch`);
      requireMatch(Object.keys(lock.packages).filter((key) => key === path || key.endsWith(`/${path}`)).length === 1,
        `lockfile:${dependency.package}:ambiguous-resolution`);
      if (dependency.peerPackage) requireMatch(installed?.peerDependencies?.[dependency.peerPackage] === dependency.peerRange,
        `lockfile:${dependency.package}:peer-mismatch`);
    }
    const edge = target.compilerDependency;
    requireMatch(lock.packages[`node_modules/${edge.from}`]?.dependencies?.[edge.package] === edge.range,
      "lockfile:compiler-dependency-mismatch");
  }
  result.valid = result.errors.length === 0;
  result.status = result.valid ? "blocked" : "invalid";
  return result;
}
