// lock-check.mjs: checks the probes' resolved Cargo.lock files against their trees' (lock.sh).
// 1. Every package from a registry in probe-<side>/Cargo.lock is in src-<side>/Cargo.lock with the
//    same version, source and checksum: the probe selects nothing the workspace does not.
// 2. The probe's packages from a path are the tree's crates and the probe itself, each depending
//    on no package the tree's lock does not give it.
// 3. probe-base and probe-head select the same packages, apart from the probe's own name
//    (p1865-base, p1865-head), the one intended difference in the build's inputs; the trees' own
//    crates are compared by name and version (their source is the tree each probe builds).
// Prints the counts and exits 1 on any difference. Usage: node lock-check.mjs <kit>/1865
import { readFileSync } from "node:fs";

const dir = process.argv[2];
const parse = (file) => {
  const text = readFileSync(file, "utf8");
  const packages = [];
  for (const block of text.split(/^\[\[package\]\]$/m).slice(1)) {
    const field = (name) => (block.match(new RegExp("^" + name + ' = "([^"]*)"$', "m")) ?? [])[1];
    const deps = (block.match(/^dependencies = \[([\s\S]*?)^\]$/m) ?? [, ""])[1].match(/"[^"]*"/g) ?? [];
    packages.push({ name: field("name"), version: field("version"), source: field("source"), checksum: field("checksum"), deps: deps.map((d) => d.slice(1, -1)).sort() });
  }
  // A dependency names its package alone, or with its version where the lock has two of that name:
  // each resolved to "name version".
  for (const p of packages) {
    p.deps = p.deps.map((d) => {
      const [name, v] = d.split(" ");
      const found = packages.filter((q) => q.name === name && (!v || q.version === v));
      return found.length === 1 ? name + " " + found[0].version : d + " (unresolved)";
    }).sort();
  }
  const version = (text.match(/^version = (\d+)$/m) ?? [])[1];
  return { packages, version };
};
const key = (p) => p.name + " " + p.version + " " + (p.source ?? "path");
let failed = false;
const fail = (why) => { failed = true; console.log("FAIL " + why); };
const probes = {};
for (const side of ["base", "head"]) {
  const tree = parse(dir + "/src-" + side + "/Cargo.lock");
  const probe = parse(dir + "/probe-" + side + "/Cargo.lock");
  if (probe.version !== tree.version) fail(side + ": lock format " + probe.version + ", the tree's " + tree.version);
  const inTree = new Map(tree.packages.map((p) => [key(p), p]));
  let registry = 0, path = 0;
  for (const p of probe.packages) {
    if (p.source) {
      registry++;
      const t = inTree.get(key(p));
      if (!t) fail(side + ": " + key(p) + " is not in the tree's lock");
      else if (t.checksum !== p.checksum) fail(side + ": " + key(p) + " checksum " + p.checksum + ", the tree's " + t.checksum);
    } else {
      path++;
      if (p.name === "p1865-" + side) continue;
      const t = inTree.get(key(p));
      if (!t) fail(side + ": path package " + key(p) + " is not one of the tree's crates");
      // The probe asks for fewer features than the workspace's apps, so a crate's optional
      // dependencies may be fewer; none may be other than the tree's.
      else if (!p.deps.every((d) => t.deps.includes(d))) fail(side + ": " + key(p) + " depends on a package the tree's lock does not give it");
    }
  }
  if (!probe.packages.some((p) => p.name === "p1865-" + side && !p.source)) fail(side + ": the lock lacks the probe's own package p1865-" + side);
  console.log(side + ": " + probe.packages.length + " packages (" + registry + " from a registry, every one the tree's version and checksum; " + path + " by path), lock version " + probe.version + "; the tree's lock has " + tree.packages.length);
  probes[side] = probe;
}
const strip = (lock, side) => lock.packages.map((p) => {
  const q = { ...p, deps: p.deps.map((d) => (d === "p1865-" + side ? "p1865" : d)) };
  if (q.name === "p1865-" + side) q.name = "p1865";
  return JSON.stringify(q);
}).sort();
const [b, h] = [strip(probes.base, "base"), strip(probes.head, "head")];
const onlyBase = b.filter((x) => !h.includes(x)), onlyHead = h.filter((x) => !b.includes(x));
if (onlyBase.length || onlyHead.length) {
  for (const x of onlyBase) fail("only in probe-base: " + x);
  for (const x of onlyHead) fail("only in probe-head: " + x);
} else console.log("probe-base and probe-head select the same " + b.length + " packages, apart from the probe's own name");
process.exit(failed ? 1 : 0);
