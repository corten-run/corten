import assert from "node:assert/strict";
import test from "node:test";
import { npmClosure, compilerGraph } from "./build-replay.mjs";
const blob = (ref) => Buffer.from(JSON.stringify(ref));
test("installed package manifests must cover the locked package graph", () => {
  const lock = { lockfileVersion: 3, packages: { "": {}, "node_modules/a": { version: "1" }, "node_modules/b": { version: "2", optional: true } } };
  npmClosure(new Map([["a/package.json", { version: "1" }]]), lock, blob);
  assert.throws(() => npmClosure(new Map(), lock, blob), /invalid-npm-lock/);
  assert.throws(() => npmClosure(new Map([["other/file.js", {}]]), lock, blob), /missing-locked-package/);
  assert.throws(() => npmClosure(new Map([["a/package.json", { version: "9" }]]), lock, blob), /differs-from-lock/);
  assert.throws(() => npmClosure(new Map([["a/package.json", { version: "1" }], ["extra/package.json", { version: "1" }]]), lock, blob), /outside-lock/);
  npmClosure(new Map(), lock, blob, false);
  assert.throws(() => npmClosure(new Map([["a/package.json", { version: "9" }]]), lock, blob, false), /differs-from-lock/);
});
test("compiler graph binds every observed artifact target and rustc identity", () => {
  const packages = ["gen", "corten"].map((id) => ({ id, name: id === "gen" ? "corten-bench-gen" : "corten-run", version: "1",
    manifest_path: `/src/${id}/Cargo.toml`, targets: [{ name: id === "gen" ? "client" : "corten", src_path: `/src/${id}/lib.rs` }] }));
  const metadata = { version: 1, packages, resolve: { root: "gen", nodes: [{ id: "gen", dependencies: ["corten"] }, { id: "corten", dependencies: [] }] } };
  const c = { compilerRoot: "/src", artifacts: packages.map((p) => ({ package_id: p.id, target: p.targets[0], filenames: ["unit"], fresh: false })),
    inputs: packages.map((p) => ({ sourcePath: `${p.id}/lib.rs`, sha256: "unit" })), depfiles: [{ inputs: ["lib.rs", "/src/corten/lib.rs"] }],
    toolchain: { rustc_fingerprint: 1, outputs: { unit: { success: true, stdout: "rustc 1.0.0\nhost: unit\nrelease: unit\n" } } } };
  const invoke = (x = c, m = metadata) => compilerGraph(x, m, [{ reason: "build-finished", success: true }], blob, () => ({ sha256: "unit" }), new Map(), "out");
  invoke();
  assert.throws(() => invoke(c, {}), /invalid-cargo-metadata/);
  for (const mutate of [(x) => { x.inputs.pop(); }, (x) => { x.artifacts[0].target = { name: "fake" }; }, (x) => { x.toolchain = {}; }]) {
    const copy = structuredClone(c); mutate(copy); assert.throws(() => invoke(copy));
  }
});
