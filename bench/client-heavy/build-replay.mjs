// Pure checks on retained compiler/package observations. No compiler is loaded.
import { isDeepStrictEqual as same } from "node:util";
import { need } from "./replay-v2.mjs";
import { compilerSourcePath, compilerWorkingDirectory } from "./compiler.mjs";

export const vendorConfiguration = '[source.crates-io]\nreplace-with = "client-heavy-vendor"\n[source.client-heavy-vendor]\ndirectory = "evidence/cargo-vendor"\n';

export function npmClosure(dependencies, lock, blob, complete = true) {
  need(lock.lockfileVersion === 3 && lock.packages && (!complete || dependencies.size > 0), "invalid-npm-lock");
  for (const [path, expected] of Object.entries(lock.packages)) {
    if (!path) continue;
    need(path.startsWith("node_modules/"), "unexpected-npm-lock-path");
    const ref = dependencies.get(`${path.slice(13)}/package.json`);
    if (!ref && (expected.optional || !complete)) continue;
    need(ref, "missing-locked-package-manifest");
    const manifest = JSON.parse(blob(ref));
    need(manifest.version === expected.version, "installed-package-differs-from-lock");
  }
  for (const path of dependencies.keys()) if (path.endsWith("/package.json")) {
    // Packages may ship fixture/package.json files; only installed package roots
    // (including nested node_modules) are lock entries.
    const root = path.slice(0, -"/package.json".length);
    if (lock.packages[`node_modules/${root}`]) continue;
    const parts = root.split("/"), marker = parts.lastIndexOf("node_modules"), tail = parts.slice(marker + 1);
    const packageDepth = tail[0]?.startsWith("@") ? 2 : 1;
    need(tail.length !== packageDepth, "installed-package-outside-lock");
  }
}

export function compilerGraph(c, metadata, messages, blob, sourceRef, cargoDependencies, relativeOutput) {
  need(metadata.version === 1 && Array.isArray(metadata.packages) && metadata.packages.length > 0
    && Array.isArray(metadata.resolve?.nodes) && typeof metadata.resolve.root === "string", "invalid-cargo-metadata-graph");
  const packages = new Map(metadata.packages.map((p) => [p.id, p]));
  need(packages.size === metadata.packages.length && packages.has(metadata.resolve.root), "invalid-cargo-package-identities");
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  need(nodes.size === metadata.resolve.nodes.length && nodes.has(metadata.resolve.root), "invalid-cargo-resolve-graph");
  for (const node of nodes.values()) {
    need(packages.has(node.id) && Array.isArray(node.dependencies) && node.dependencies.every((id) => nodes.has(id)), "incomplete-cargo-resolve-graph");
  }
  const inputs = new Map(c.inputs.map((i) => [i.sourcePath, i]));
  const available = (path) => sourceRef(path) ?? (path.startsWith(`${relativeOutput}/evidence/cargo-vendor/`)
    ? cargoDependencies.get(path.slice(`${relativeOutput}/evidence/cargo-vendor/`.length)) : null);
  const targetPath = (path) => compilerSourcePath(c.compilerRoot, path.replaceAll("\\", "/"), compilerWorkingDirectory(metadata));
  for (const p of packages.values()) {
    need(typeof p.id === "string" && typeof p.name === "string" && typeof p.version === "string" && Array.isArray(p.targets), "invalid-cargo-package");
    const manifest = targetPath(p.manifest_path), ref = available(manifest);
    need(ref && blob(ref).length > 0, "missing-cargo-package-manifest");
  }
  const root = packages.get(metadata.resolve.root);
  need(root.name === "corten-bench-gen" && c.artifacts.some((a) => a.package_id === root.id && a.target?.name === "client")
    && c.artifacts.some((a) => packages.get(a.package_id)?.name === "corten-run"), "missing-generator-or-framework-artifact");
  need(messages.some((m) => m.reason === "build-finished" && m.success === true), "missing-successful-cargo-build-finished");
  for (const a of c.artifacts) {
    const p = packages.get(a.package_id);
    need(p && nodes.has(a.package_id) && p.targets.some((t) => same(t, a.target))
      && Array.isArray(a.filenames) && a.filenames.length > 0 && a.fresh === false, "artifact-outside-cargo-graph");
    const path = targetPath(a.target.src_path);
    need(inputs.has(path) && available(path)?.sha256 === inputs.get(path).sha256, "compiler-target-missing-from-dep-info");
    need(c.depfiles.some((d) => d.inputs.some((i) => targetPath(i) === path)), "compiler-target-without-dep-info");
  }
  const rustc = JSON.parse(blob(c.toolchain));
  need(Number.isInteger(rustc.rustc_fingerprint) && rustc.rustc_fingerprint >= 0 && rustc.outputs && Object.values(rustc.outputs)
    .some((v) => v.success === true && typeof v.stdout === "string" && /^rustc \d+\.\d+/m.test(v.stdout)
      && /\nhost: \S+/.test(v.stdout) && /\nrelease: \S+/.test(v.stdout)), "invalid-rust-toolchain-identity");
}
