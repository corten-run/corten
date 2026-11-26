import { createHash } from "node:crypto";
import { groupNames, selectedApps } from "./registry.mjs";
import { candidateDependencies } from "../client-heavy/contract.mjs";
import { solidCompilerArchives, solidCompilerVersion } from "../client-heavy/compiler.mjs";
import { posix } from "node:path";
// Resolve only the declared root tooling package, never an ancestor/global or
// the benchmark's unrelated transitive parser. Immutable replay must capture it too.
import semver from "../../node_modules/semver/index.js";

export const latestStableSchema = "benchmark-latest-stable-evaluation/v1";
export const candidateLatestStableSchema = "benchmark-latest-stable-evaluation/v2";
export const latestStableSources = Object.freeze({
  policy: "bench/workloads/latest-stable.json",
  manifest: "bench/browser/package.json",
  lockfile: "bench/browser/package-lock.json",
  toolingManifest: "package.json",
  toolingLockfile: "package-lock.json",
});
export const policyParser = Object.freeze({ package: "semver", version: "7.8.6",
  integrity: "sha512-9lpSSU4Mly3mrtruwLs1eLK6+gzbzqeBFwRNjIjE+9LuDpWdYctrQlQ3ej1Ilgi7gknpsTRnPoLP8DpCHqHIJw==" });

// A policy edit, including removal of a blocker, needs a reviewed evaluator update.
// This is an integrity check on the fixed record, not a signature or a latest resolver.
const reviewedPolicySha256 = "091ec3f9d888cd2474debff2f08dbb41596d641f6c547d5d91eb7966cfff5580";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => value && typeof value === "object"
  ? Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value);
const dependencyKinds = ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"];

/**
 * Offline, read-only policy evaluation of UTF-8 source strings or byte arrays.
 * The caller must bind these exact bytes AND this module/registry to its trusted
 * source closure, then recompute on offline admission, not trust a saved verdict.
 * Lock metadata is not proof of installed compiler bytes; retain npm closure checks.
 * A valid result describes pinned inputs, never that a group or journey is eligible.
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

// Reviewed primary-registry observation supplied on 2026-11-22. These facts
// cannot be advanced by editing a policy date, a lock or an authored verdict.
// New observations require source review; this is not a network latest resolver.
const currentObservedAt = "2026-11-22T19:13:18.740Z";
const previousObservedAt = "2026-11-17T14:50:31.991Z";
const reviewedSolid2 = Object.freeze({
  metadata: "56dd082ed737d4a1a0dd710ac2a39f1d9e691bf1079271a33884970ca131d8f0",
  observedAt: "2026-11-23T23:28:47.230Z",
});
const solid2Roots = Object.freeze(["@solidjs/compiler", "@solidjs/web", "esbuild", "solid-js"]);
// Transitive executable runtime of the Solid 2 adapter, not a new latest target.
const solidSignals = {
  version: "2.0.3",
  resolved: "https://registry.npmjs.org/@solidjs/signals/-/signals-2.0.3.tgz",
  integrity: "sha512-M6+kiJflqSvJRHRcmdsdIXpPLPkQrY817zWKKfxZ3z3ZRE5eEtddtWPrDXY4IM1Wz3zAqG+3Fx/HQIkAtpRwnA==",
};
// Exact primary response identities, not eligible verdicts. Below we also parse
// their bytes and recompute targets, dependency paths and native-consumer scope.
const reviewedRegistry = Object.freeze({
  "@babel/core": ["8.1.3", "752efc828684eb735e3e212bb5f7cc3a00cc715758aebbef2b353c3a1ebf223f"],
  "babel-preset-solid": ["1.9.19", "5607d3867fc265be88881506bd28b15e8ab14a961b5c9dabfcce3556684f8068"],
  esbuild: ["0.28.2", "7a6838097b106ef5d8877fd543a1e25c46e5eb1730945fb7e57bc467c12c7c8c"],
  react: ["19.3.1", "ecf8c02b9096a7813842d87fae50a707a8809c5c3d0ec6b359ac51d40188ff6f"],
  "react-dom": ["19.3.1", "2d72d7d33a8b0fea5614e1b415d06470877efa8eebbdf638cee04e5b83c2c7a5"],
  remix: ["3.3.0", "a9a2909f0f864315f895a393aa861a92220ad8645e3db46d0bc1e0e4a14b72cc"],
  "solid-js": ["2.0.3", "361565891c754741113cc4ec3700b1b60ab9f0dfb9fb1bc291775343c2f7123b"],
  svelte: ["5.59.1", "aabd653e7472de78a912e93f7af0cde8a75d6ccea77f9f29342e90a8894512ae"],
  vue: ["3.5.46", "63e306e9ab6f1c75ed60d24303cfd0cd310a8ed17944e072f5615043c1cab563"],
  "@vue/compiler-sfc": ["3.5.46", "05cd0961875d2b1cc6685aa4e1f3fe0c13798f3213926e5aa8b87828e8fce403"],
  "@babel/parser": ["8.1.3", "3946934b5df97aee0244c0d18e7ac3750cb07ebb8186b66202c9ab6150eb937f"],
  "babel-plugin-jsx-dom-expressions": ["0.40.14", "5b401b6520332ddd9fac5dc2d285e31d8bffa6d14b2c6e02dbf81e5174ce3ed5"],
  "@solidjs/web": ["2.0.3", "de2af989c395747685ffaf815dcefa699cb45d76c4a64848dd885463a85973ef"],
  "@remix-run/test": ["1.2.0", "ead3050b1573b90332c09ec7f2e8e3f5ee611e352d87a6c4da7aab7e33d0104e"],
});
// Retained v2 observation: do not replay its forced Remix resolution with the
// private-tool rule, or reinterpret the previous blocked row as current.
const previousRegistry = Object.freeze({
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
// Reviewed version response at https://registry.npmjs.org/esbuild/0.27.2.
// Bind both the archive and its published dependency maps (including binaries).
const privateEsbuild = Object.freeze({
  version: "0.27.2", resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.27.2.tgz",
  integrity: "sha512-HyNQImnsOC7X9PMNaCIeAm4ISCQXs5a5YasTXVliKv4uuBo1dKrG0A+uQS8M5eXjVMnLg3WgXaKvprHlFJQffw==",
  dependencySha256: "6ddacbd6815df6ddbaff1acb08c11e0533693e7aa81735a18b1f40a679cce1af",
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
    const solid2 = Object.hasOwn(record, "solid2");
    need(canonical(Object.keys(record).sort()) === canonical(["schema", "checkedOn", "observedAt", "observations", "candidates", "unsupported", "legacy",
      ...(solid2 ? ["solid2"] : [])].sort()), "policy:unexpected-fields");
    const previous = record.observedAt === previousObservedAt;
    const observedAt = previous ? previousObservedAt : currentObservedAt;
    const expectedRegistry = previous ? previousRegistry : reviewedRegistry;
    need(record.checkedOn === observedAt.slice(0, 10) && record.observedAt === observedAt, "policy:unreviewed-observation-date");
    const registry = record.observations;
    need(registry?.schema === registryObservationSchema && registry.observedAt === observedAt
      && canonical(Object.keys(registry).sort()) === canonical(["schema", "observedAt", "packages"].sort())
      && canonical(Object.keys(registry.packages).sort()) === canonical(Object.keys(expectedRegistry).sort()), "policy:unreviewed-observations");
    const observations = {};
    for (const [name, [version, identity]] of Object.entries(expectedRegistry)) {
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
    const roots = solid2 ? { ...candidateDependencies, solid: solid2Roots } : candidateDependencies;
    need(canonical(record.candidates) === canonical(roots), "policy:candidate-membership-mismatch");
    need(canonical(record.unsupported) === canonical(solid2 ? null : { app: "solid", reason: unsupportedSolidReason }), "policy:unreviewed-unsupported-disposition");
    if (solid2) {
      const compiler = "@solidjs/compiler", response = record.solid2;
      const bytes = Buffer.from(response?.raw ?? "");
      need(!previous && response && canonical(Object.keys(response).sort()) === canonical(["url", "observedAt", "status", "bytes", "sha256", "raw"].sort())
        && response.observedAt === reviewedSolid2.observedAt
        && response.url === "https://registry.npmjs.org/%40solidjs%2Fcompiler/latest" && response.status === 200
        && response.bytes === bytes.length && response.sha256 === reviewedSolid2.metadata && sha256(bytes) === reviewedSolid2.metadata,
      "policy:unreviewed-solid-compiler");
      const metadata = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      need(metadata.name === compiler && metadata.version === solidCompilerVersion, "policy:unreviewed-solid-compiler");
      if (input.group === "client-heavy") observations[compiler] = metadata;
    }
    need(sha256(canonical(record.legacy)) === reviewedPolicySha256, "policy:changed-legacy-record");
    need(groupNames.includes(input.group), "group:unknown");
    result.checkedOn = record.checkedOn;
    result.observation = { observedAt, packages: Object.fromEntries(Object.entries(observations).map(([name, value]) =>
      [name, { version: value.version, peers: value.peerDependencies ?? {},
        source: (registry.packages[name] ?? record.solid2).url, sha256: (registry.packages[name] ?? record.solid2).sha256 }])) };
    if (input.group !== "client-heavy") return { ...result, schema: latestStableSchema, valid: true, status: "not-applicable", groupComparisonEligible: null };
    const manifest = read("manifest"), lock = read("lockfile"), tooling = read("toolingManifest"), toolingLock = read("toolingLockfile");
    need(tooling?.devDependencies?.semver === policyParser.version && !Object.hasOwn(tooling.dependencies ?? {}, "semver")
      && !Object.hasOwn(tooling.optionalDependencies ?? {}, "semver") && !Object.hasOwn(tooling.overrides ?? {}, "semver")
      && toolingLock?.lockfileVersion === 3 && toolingLock.packages?.[""]?.devDependencies?.semver === policyParser.version,
    "tooling:parser-declaration-mismatch");
    const parser = toolingLock.packages["node_modules/semver"];
    need(parser?.version === policyParser.version && parser.integrity === policyParser.integrity
      && parser.resolved === "https://registry.npmjs.org/semver/-/semver-7.8.6.tgz" && !parser.link
      && Object.keys(toolingLock.packages).filter((path) => path === "node_modules/semver" || path.endsWith("/node_modules/semver")).length === 1,
    "tooling:parser-lock-mismatch");
    need(lock?.lockfileVersion === 3 && lock.packages?.[""], "lockfile:invalid-shape");
    need(manifest && typeof manifest === "object" && !Array.isArray(manifest), "manifest:invalid-shape");
    const remixTestVersion = reviewedRegistry["@remix-run/test"][0];
    // Keep the private test tool in its published range and outside
    // GHSA-g7r4-m6w7-qqqr, without changing the actual benchmark bundler.
    const overrides = previous ? { "@remix-run/test": { esbuild: "$esbuild" } }
      : { [`@remix-run/test@${remixTestVersion}`]: { esbuild: privateEsbuild.version } };
    need(canonical(manifest.overrides) === canonical(overrides), "manifest:unreviewed-overrides");
    for (const kind of ["dependencies", "devDependencies", "optionalDependencies"]) need(canonical(manifest[kind] ?? {}) === canonical(lock.packages[""][kind] ?? {}), `lockfile:root-${kind}-mismatch`);
    if (solid2) for (const [name, archive] of Object.entries(solidCompilerArchives)) {
      const path = `node_modules/${name}`, pkg = lock.packages[path];
      need(pkg?.version === solidCompilerVersion && pkg.optional === true && !pkg.link
        && pkg.resolved === `https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-${solidCompilerVersion}.tgz`
        && pkg.integrity === archive.integrity && !dependencyKinds.some((kind) => Object.keys(pkg[kind] ?? {}).length)
        && ["os", "cpu", "libc"].every((key) => Object.hasOwn(pkg, key) === Object.hasOwn(archive, key)
          && canonical(pkg[key]) === canonical(archive[key]))
        && Object.keys(lock.packages).filter((key) => key === path || key.endsWith("/" + path)).length === 1,
      `lockfile:${name}:unreviewed-solid-compiler-binding`);
    }
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
    const remixTest = "node_modules/@remix-run/test";
    const remixTestEsbuild = previous ? null : `${remixTest}/node_modules/esbuild`;
    if (remixTestEsbuild && Object.hasOwn(lock.packages, remixTestEsbuild)) {
      const pkg = lock.packages[remixTestEsbuild];
      need(pkg?.version === privateEsbuild.version && !pkg.link && pkg.resolved === privateEsbuild.resolved
        && pkg.integrity === privateEsbuild.integrity, "lockfile:unreviewed-remix-test-esbuild-archive");
      const edges = Object.fromEntries(dependencyKinds.map((kind) => [kind, pkg[kind] ?? {}]));
      need(sha256(canonical(edges)) === privateEsbuild.dependencySha256, "lockfile:unreviewed-remix-test-esbuild-dependencies");
    }
    for (const app of selectedApps("client-heavy")) {
      const usesSolid2 = app === "solid" && solid2;
      const closure = new Map(), pending = [], incompatible = [];
      for (const name of roots[app]) {
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
        need(pkg && !pkg.link && typeof pkg.version === "string" && semver.valid(pkg.version) !== null, `lockfile:${name}:invalid-or-linked-package`);
        // Reject even unused shadows, except the private build tool npm resolves
        // for @remix-run/test's independently observed esbuild dependency.
        if (roots[app].includes(name) || Object.hasOwn(observations, name) || usesSolid2 && name === "@solidjs/signals") {
          need(Object.keys(lock.packages).filter((key) => key !== remixTestEsbuild
            && (key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))).length === 1,
            `lockfile:${name}:ambiguous-resolution`);
        }
        // A latest root/compiler retains the dependency declarations actually
        // published for that version. Internal dependencies are supported pins,
        // not new independent latest targets (e.g. Vue's Babel parser 7).
        if (observations[name]?.version === pkg.version) for (const kind of dependencyKinds) {
          need(canonical(pkg[kind] ?? {}) === canonical(observations[name][kind] ?? {}), `lockfile:${name}:${kind}-differs-from-registry`);
        }
        if (usesSolid2 && roots.solid.includes(name) && (name !== "esbuild" || pkg.version === observations.esbuild.version)) {
          const observed = observations[name];
          need(observed?.version === pkg.version && pkg.resolved === observed.dist.tarball
            && pkg.integrity === observed.dist.integrity, `lockfile:${name}:unreviewed-solid-2-archive`);
        }
        if (usesSolid2 && name === "@solidjs/signals") {
          need(path === "node_modules/@solidjs/signals"
            && Object.entries(solidSignals).every(([key, value]) => pkg[key] === value)
            && !dependencyKinds.some((kind) => Object.keys(pkg[kind] ?? {}).length),
          "lockfile:@solidjs/signals:unreviewed-solid-2-archive");
        }
        closure.set(path, { path, package: name, version: pkg.version });
        for (const [kind, edges] of [["dependency", pkg.dependencies], ["optional", pkg.optionalDependencies], ["peer", pkg.peerDependencies]]) {
          for (const dependency of Object.keys(edges ?? {})) {
            if (kind === "dependency" && Object.hasOwn(pkg.optionalDependencies ?? {}, dependency)) continue;
            const resolved = resolvePackage(path, dependency);
            const optional = kind === "optional" || kind === "peer" && pkg.peerDependenciesMeta?.[dependency]?.optional === true;
            need(resolved || optional, `lockfile:${dependency}:missing-${kind}`);
            const range = edges[dependency];
            need(typeof range === "string" && semver.validRange(range) !== null, `lockfile:${dependency}:invalid-${kind}-range`);
            if (resolved) {
              const version = lock.packages[resolved]?.version;
              if (resolved === remixTestEsbuild) {
                need(path === remixTest && kind === "dependency" && pkg.version === remixTestVersion,
                  "lockfile:unreviewed-remix-test-esbuild-consumer");
                const { dist } = observations["@remix-run/test"];
                need(pkg.resolved === dist.tarball && pkg.integrity === dist.integrity, "lockfile:unreviewed-remix-test-archive");
              }
              if (typeof version !== "string" || !semver.satisfies(version, range)) incompatible.push({ from: path, kind, package: dependency, range, resolved, version });
              pending.push(resolved);
            }
          }
        }
      }
      const dependencies = [...closure.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
      const targets = [...roots[app], ...(app === "vue" ? ["@vue/compiler-sfc"] : [])];
      // Retain the existing explicit Babel-core target for EVERY actual graph
      // consumer. Do not invent a latest-all-transitives policy from metadata.
      if (dependencies.some((d) => d.package === "@babel/core") && !targets.includes("@babel/core")) targets.push("@babel/core");
      incompatible.sort((a, b) => canonical(a).localeCompare(canonical(b), "en"));
      const blockers = [...targets.flatMap((name) => !observations[name] ? [`latest-not-observed:${name}`]
        : dependencies.some((d) => d.package === name && d.path !== remixTestEsbuild
          && d.version !== observations[name].version) ? [`not-latest-stable:${name}`] : []),
      ...incompatible.map((edge) => `incompatible-${edge.kind}:${edge.from}:${edge.package}`)];
      const row = { app, roots: [...roots[app]], dependencies, status: blockers.length ? "blocked" : "satisfied",
        targets, incompatible,
        reason: blockers.length ? "latest-stable-closure-not-qualified" : null,
        latestStableEligible: blockers.length === 0, measurements: null, blockers };
      if (app === "solid" && !solid2) {
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
