import { createHash } from "node:crypto";
import { groupNames, selectedApps } from "./registry.mjs";
import { candidateDependencies } from "../client-heavy/contract.mjs";
import { posix } from "node:path";

export const latestStableSchema = "benchmark-latest-stable-evaluation/v1";
export const candidateLatestStableSchema = "benchmark-latest-stable-evaluation/v2";
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
 * Not-applicable means only that this fixed client policy does not cover the group.
 */
export function evaluateLatestStable(input = {}) {
  // Historical v1 records retain their original, group-wide blocked semantics.
  try {
    const policy = JSON.parse(Buffer.from(input?.policy ?? "").toString("utf8"));
    if (policy.schema === "benchmark-latest-stable-policy/v2") return evaluateCandidates(input);
  } catch { /* The v1 reader supplies the normal malformed-source diagnostic. */ }
  return evaluateLegacy(input);
}

function evaluateLegacy(input = {}) {
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

// Reviewed primary-registry observation supplied on 2026-11-17. These facts
// cannot be advanced by editing a policy date, a lock or an authored verdict.
// New observations require source review; this is not a network latest resolver.
const observedAt = "2026-11-17T14:50:31.991Z";
// Exact primary response identities, not eligible verdicts. Below we also parse
// their bytes and recompute targets, dependency paths and native-consumer scope.
const reviewedRegistry = Object.freeze({
  "@babel/core": ["8.1.2", "ea4b870f29d90df7b3ada07d3f20dcb05ad15f0230608ef149c32c10f157f1ad"],
  "babel-preset-solid": ["1.9.19", "5607d3867fc265be88881506bd28b15e8ab14a961b5c9dabfcce3556684f8068"],
  esbuild: ["0.28.2", "7a6838097b106ef5d8877fd543a1e25c46e5eb1730945fb7e57bc467c12c7c8c"],
  react: ["19.3.1", "ecf8c02b9096a7813842d87fae50a707a8809c5c3d0ec6b359ac51d40188ff6f"],
  "react-dom": ["19.3.1", "2d72d7d33a8b0fea5614e1b415d06470877efa8eebbdf638cee04e5b83c2c7a5"],
  remix: ["3.2.0", "95e8629a1d6f270cd0fe6066ee4fe4c76ebaacae285451a9b551162661018b8d"],
  "solid-js": ["2.0.0", "5c1b6535469aaf1b97917b14541b82832b2ac1566eaf7771f2ff89ab1c34a31c"],
  svelte: ["5.57.3", "634f95528477681a4038169e260043050af2538ef1b29703dcb345df298f4c51"],
  vue: ["3.5.45", "1ee58b6cbee8116c5f29a4c60ab4c46d8253f5151c2e5c66ac91185b6993d603"],
  "@vue/compiler-sfc": ["3.5.45", "b590cd088c7527f22e55087dac8ae5a8d189ec7872e121940290afeadaafe942"],
  "@babel/parser": ["8.1.2", "23bea21411dae23f43b3b3ab8fa846391329cf6d1eea2dac894f258e96ba6de1"],
  "babel-plugin-jsx-dom-expressions": ["0.40.14", "5b401b6520332ddd9fac5dc2d285e31d8bffa6d14b2c6e02dbf81e5174ce3ed5"],
  "@solidjs/web": ["2.0.0", "463c70691ccf608a7fb49f7d40a02b05044c563ea08637bd826668703c43a8d2"],
});
export const registryObservationSchema = "benchmark-npm-registry-observation/v1";
export const unsupportedSolidReason = "latest-stable-solid-2-needs-compatible-stable-compiler";

function evaluateCandidates(input) {
  const result = { schema: candidateLatestStableSchema, group: typeof input.group === "string" ? input.group : null,
    valid: false, status: "invalid", groupComparisonEligible: false, checkedOn: null,
    errors: [], targets: [], sources: {}, candidates: [] };
  const read = (name) => {
    const source = input[name];
    if (typeof source !== "string" && !(source instanceof Uint8Array)) throw new Error(`${name}:missing-source`);
    const bytes = Buffer.from(source);
    result.sources[name] = { path: latestStableSources[name], bytes: bytes.length, sha256: sha256(bytes) };
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error(`${name}:invalid-json`); }
  };
  const need = (condition, reason) => { if (!condition) throw new Error(reason); };
  try {
    const record = read("policy");
    need(canonical(Object.keys(record).sort()) === canonical(["schema", "checkedOn", "observedAt", "observations", "candidates", "unsupported", "legacy"].sort()), "policy:unexpected-fields");
    need(record.checkedOn === "2026-11-17" && record.observedAt === observedAt, "policy:unreviewed-observation-date");
    const registry = record.observations;
    need(registry?.schema === registryObservationSchema && registry.observedAt === observedAt
      && canonical(Object.keys(registry).sort()) === canonical(["schema", "observedAt", "packages"].sort())
      && canonical(Object.keys(registry.packages).sort()) === canonical(Object.keys(reviewedRegistry).sort()), "policy:unreviewed-observations");
    const observations = {};
    for (const [name, [version, identity]] of Object.entries(reviewedRegistry)) {
      const response = registry.packages[name];
      need(response && canonical(Object.keys(response).sort()) === canonical(["url", "observedAt", "status", "bytes", "sha256", "raw"].sort()), "policy:invalid-registry-response");
      const bytes = Buffer.from(response.raw ?? "");
      need(response.status === 200 && response.url === `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`
        && Number.isFinite(Date.parse(response.observedAt)) && Date.parse(response.observedAt) <= Date.parse(observedAt)
        && Date.parse(response.observedAt) >= Date.parse(observedAt) - 2000
        && response.bytes === bytes.length && response.sha256 === identity && sha256(bytes) === identity, "policy:registry-response-identity-mismatch");
      const metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      need(metadata.name === name && metadata.version === version && /^\d+\.\d+\.\d+$/.test(metadata.version), "policy:registry-version-mismatch");
      observations[name] = metadata;
    }
    need(canonical(record.candidates) === canonical(candidateDependencies), "policy:candidate-membership-mismatch");
    need(canonical(record.unsupported) === canonical({ app: "solid", reason: unsupportedSolidReason }), "policy:unreviewed-unsupported-disposition");
    need(sha256(canonical(record.legacy)) === reviewedPolicySha256, "policy:changed-legacy-record");
    need(groupNames.includes(input.group), "group:unknown");
    result.checkedOn = record.checkedOn;
    result.observation = { observedAt, packages: Object.fromEntries(Object.entries(observations).map(([name, value]) =>
      [name, { version: value.version, peers: value.peerDependencies ?? {}, source: registry.packages[name].url, sha256: registry.packages[name].sha256 }])) };
    if (input.group !== "client-heavy") return { ...result, schema: latestStableSchema, valid: true, status: "not-applicable", groupComparisonEligible: null };
    const manifest = read("manifest"), lock = read("lockfile");
    need(lock?.lockfileVersion === 3 && lock.packages?.[""], "lockfile:invalid-shape");
    need(manifest && typeof manifest === "object" && !Array.isArray(manifest), "manifest:invalid-shape");
    need(canonical(manifest.overrides) === canonical({ "@remix-run/test": { esbuild: "$esbuild" } }), "manifest:unreviewed-overrides");
    for (const kind of ["dependencies", "devDependencies", "optionalDependencies"]) need(canonical(manifest[kind] ?? {}) === canonical(lock.packages[""][kind] ?? {}), `lockfile:root-${kind}-mismatch`);
    const resolvePackage = (from, name) => {
      need(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)
        && name.split("/").every((part) => ![".", "..", "node_modules"].includes(part)), "lockfile:invalid-package-name");
      let base = from;
      while (true) {
        const key = `${base ? base + "/" : ""}node_modules/${name}`;
        // Node skips a node_modules directory itself when walking ancestors.
        if (posix.basename(base) !== "node_modules" && Object.hasOwn(lock.packages, key)) return key;
        if (!base) return null;
        base = posix.dirname(base);
        if (base === ".") base = "";
      }
    };
    for (const app of selectedApps("client-heavy")) {
      const closure = new Map(), pending = [];
      for (const name of candidateDependencies[app]) {
        const version = manifest.devDependencies?.[name];
        need(typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version)
          && !Object.hasOwn(manifest.dependencies ?? {}, name) && !Object.hasOwn(manifest.optionalDependencies ?? {}, name), `manifest:${name}:non-exact-or-shadowed-root`);
        need(lock.packages[`node_modules/${name}`]?.version === version, `lockfile:${name}:root-version-mismatch`);
        pending.push(`node_modules/${name}`);
      }
      while (pending.length) {
        const path = pending.pop();
        if (closure.has(path)) continue;
        const pkg = lock.packages[path], name = path.slice(path.lastIndexOf("node_modules/") + 13);
        need(pkg && !pkg.link && typeof pkg.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version), `lockfile:${name}:invalid-or-linked-package`);
        // Even an unused nested copy of a consumed package can shadow a future
        // import. Do not certify a single-root closure while it is installed.
        if (candidateDependencies[app].includes(name) || Object.hasOwn(observations, name)) {
          need(Object.keys(lock.packages).filter((key) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`)).length === 1,
            `lockfile:${name}:ambiguous-resolution`);
        }
        // A latest root/compiler retains the dependency declarations actually
        // published for that version. Internal dependencies are supported pins,
        // not new independent latest targets (e.g. Vue's Babel parser 7).
        if (observations[name]?.version === pkg.version) for (const kind of ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"]) {
          need(canonical(pkg[kind] ?? {}) === canonical(observations[name][kind] ?? {}), `lockfile:${name}:${kind}-differs-from-registry`);
        }
        closure.set(path, { path, package: name, version: pkg.version });
        for (const [kind, edges] of [["dependency", pkg.dependencies], ["optional", pkg.optionalDependencies], ["peer", pkg.peerDependencies]]) {
          for (const dependency of Object.keys(edges ?? {})) {
            if (kind === "dependency" && Object.hasOwn(pkg.optionalDependencies ?? {}, dependency)) continue;
            const resolved = resolvePackage(path, dependency);
            const optional = kind === "optional" || kind === "peer" && pkg.peerDependenciesMeta?.[dependency]?.optional === true;
            need(resolved || optional, `lockfile:${dependency}:missing-${kind}`);
            if (resolved) pending.push(resolved);
          }
        }
      }
      const dependencies = [...closure.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
      const targets = [...candidateDependencies[app], ...(app === "vue" ? ["@vue/compiler-sfc"] : [])];
      // Retain the existing explicit Babel-core target for EVERY actual graph
      // consumer. Do not invent a latest-all-transitives policy from metadata.
      if (dependencies.some((d) => d.package === "@babel/core") && !targets.includes("@babel/core")) targets.push("@babel/core");
      const blockers = targets.flatMap((name) => !observations[name] ? [`latest-not-observed:${name}`]
        : dependencies.filter((d) => d.package === name).some((d) => d.version !== observations[name].version) ? [`not-latest-stable:${name}`] : []);
      const row = { app, roots: [...candidateDependencies[app]], dependencies, status: blockers.length ? "blocked" : "satisfied",
        targets,
        reason: blockers.length ? "latest-stable-closure-not-qualified" : null,
        latestStableEligible: blockers.length === 0, measurements: null, blockers };
      if (app === "solid") {
        const preset = lock.packages["node_modules/babel-preset-solid"];
        need(preset?.version === observations["babel-preset-solid"].version
          && canonical(preset.peerDependencies) === canonical({ "solid-js": "^1.9.16", "@babel/core": "^7.0.0" }), "lockfile:solid-compiler-peer-mismatch");
        row.status = "unsupported"; row.reason = unsupportedSolidReason; row.latestStableEligible = false;
      }
      result.candidates.push(row);
    }
    result.valid = true;
    result.status = "blocked";
  } catch (error) { result.errors.push(error.message); result.candidates = []; }
  return result;
}
