import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { Evidence } from "./evidence.mjs";
import { installLayout } from "./install-layout.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "client-install-")), base = join(root, "modules"), out = join(root, "saved");
  t.after(async () => { const r = relative(tmpdir(), root); assert.ok(r && !isAbsolute(r) && !r.startsWith("..")); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(base, "pkg/bin"), { recursive: true }); await mkdir(join(base, ".bin")); await mkdir(out);
  await writeFile(join(base, "pkg/package.json"), JSON.stringify({ name: "pkg", version: "1", bin: { pkg: "bin/tool" } }));
  await writeFile(join(base, "pkg/bin/tool"), "// Exact fixture executable bytes\n");
  return { root, base, out, e: new Evidence(root, out) };
}

test("closed install reads contained hardlink peers without relaxing source readers", async (t) => {
  const f = await fixture(t); await link(join(f.base, "pkg/bin/tool"), join(f.base, "pkg/bin/peer"));
  const before = await f.e.tree(f.base, "node-dependencies", "before"), after = await f.e.tree(f.base, "node-dependencies", "after");
  assert.deepEqual(before.unavailable, []); assert.deepEqual(before.entries, after.entries); assert.deepEqual(before.layout, after.layout);
  assert.deepEqual(before.layout.hardlinks, [["pkg/bin/peer", "pkg/bin/tool"]]);
  await assert.rejects(f.e.file(f.base, "pkg/bin/tool"), /linked-or-nonregular-source/);
});

test("hardlink aliases outside the install remain unavailable", async (t) => {
  const f = await fixture(t); await link(join(f.base, "pkg/bin/tool"), join(f.root, "external"));
  const r = await f.e.tree(f.base, "node-dependencies", "before"); assert.equal(r.unavailable.length, 1);
  assert.ok(f.e.blockers.includes("node-dependencies-before-incomplete"));
});

test("declared npm bin aliases retain exact target bytes and layout", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t); await symlink("../pkg/bin/tool", join(f.base, ".bin/pkg"));
  const before = await f.e.tree(f.base, "node-dependencies", "before"), after = await f.e.tree(f.base, "node-dependencies", "after");
  assert.deepEqual(before.unavailable, []); assert.deepEqual(before.entries, after.entries); assert.deepEqual(before.layout, after.layout);
  assert.deepEqual(before.layout.bins, [{ path: ".bin/pkg", target: "../pkg/bin/tool" }]);
  const entries = new Map(before.entries.map(({ path, ...ref }) => [path, ref]));
  assert.equal(entries.get(".bin/pkg").sha256, entries.get("pkg/bin/tool").sha256);
  installLayout(before.layout, entries, (ref) => Buffer.from(JSON.stringify({ name: "pkg", bin: "bin/tool" })));
  const changed = structuredClone(before.layout); changed.bins[0].target = "../../external";
  assert.throws(() => installLayout(changed, entries, () => Buffer.alloc(0)), /escaped-or-missing/);
  await rm(join(f.base, ".bin/pkg")); await symlink("../pkg/package.json", join(f.base, ".bin/pkg"));
  const hostile = await f.e.tree(f.base, "node-dependencies", "hostile"); assert.equal(hostile.unavailable.length, 1);
  assert.ok(hostile.entries.length > 0);
});

for (const [name, path, target] of [["directory", "alias", "pkg"], ["non-bin file", "pkg/alias", "bin/tool"],
  ["escape", ".bin/pkg", "../../external"], ["cycle", ".bin/pkg", "pkg"]])
  test(`closed install rejects ${name} links`, { skip: process.platform === "win32" }, async (t) => {
    const f = await fixture(t); await writeFile(join(f.root, "external"), "private fixture\n"); await symlink(target, join(f.base, path));
    const r = await f.e.tree(f.base, "node-dependencies", "before"); assert.equal(r.unavailable.length, 1);
    assert.ok(!r.entries.some((e) => e.path === path));
    for (const e of r.entries) assert.notEqual((await readFile(join(f.out, e.blob))).toString(), "private fixture\n");
  });
