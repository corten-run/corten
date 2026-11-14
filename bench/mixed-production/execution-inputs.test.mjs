import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { finalizeExecutionInputs, packageFiles, prepareExecutionInputs, replayExecutionInputs, toolPackages } from "./execution-inputs.mjs";
import { sha256 } from "./capture.mjs";

const integrity = (body) => "sha512-" + createHash("sha512").update(body).digest("base64");
function tar(files) {
  const result = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text), h = Buffer.alloc(512); h.write(`package/${name}`); h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
    h.write(body.length.toString(8).padStart(11, "0") + "\0", 124); h.write("00000000000\0", 136); h.fill(32, 148, 156); h[156] = 48; h.write("ustar\0", 257); h.write("00", 263);
    h.write([...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    result.push(h, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...result, Buffer.alloc(1024)]));
}
async function temporary(fn) {
  const root = resolve(tmpdir()), folder = mkdtempSync(join(root, "mixed-inputs-test-"));
  try { return await fn(folder); } finally { const r = relative(root, folder); assert.ok(r && !isAbsolute(r) && !r.startsWith("..")); rmSync(folder, { recursive: true }); }
}
test("mounted dependency snapshot replays lock integrity, exact inventory and final harness bytes", () => temporary(async (folder) => {
  const source = join(folder, "source"), output = join(folder, "out"), cache = join(folder, "cache"); mkdirSync(source); mkdirSync(join(output, "execution"), { recursive: true });
  const lock = { packages: {} };
  for (const name of toolPackages) {
    const archive = tar({ "package.json": JSON.stringify({ name, version: "1.0.0" }), "index.mjs": "export const actual = 1;\n" }), value = integrity(archive);
    lock.packages[`node_modules/${name}`] = { version: "1.0.0", integrity: value };
    const key = Buffer.from(value.slice(7), "base64").toString("hex"), path = join(cache, "_cacache/content-v2/sha512", key.slice(0, 2), key.slice(2, 4), key.slice(4));
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, archive);
  }
  writeFileSync(join(source, "package-lock.json"), JSON.stringify(lock)); writeFileSync(join(source, "runner.mjs"), "export const run = true;\n");
  const tracked = Object.fromEntries(["package-lock.json", "runner.mjs"].map((name) => [name, readFileSync(join(source, name))]));
  const ref = prepareExecutionInputs({ folder: output, buildRoot: source, commit: "a".repeat(40), cacheRoots: [cache], harnessPaths: Object.keys(tracked) });
  finalizeExecutionInputs({ folder: output, repo: source });
  const receipt = JSON.parse(readFileSync(join(output, ref.path))), files = new Map();
  const scan = (path, prefix = "") => { for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) scan(join(path, entry.name), prefix + entry.name + "/"); else files.set(prefix + entry.name, true);
  } }; scan(output);
  const fs = { files, read: (path) => JSON.parse(readFileSync(join(output, path))), body: (path) => readFileSync(join(output, path)), digest: (path) => sha256(readFileSync(join(output, path))) };
  assert.equal(replayExecutionInputs({ receipt, tracked, fs, commit: "a".repeat(40) }).length, 6);
  const target = receipt.packages[0].files[1].path, original = readFileSync(join(output, target)); writeFileSync(join(output, target), "modified executable");
  assert.throws(() => replayExecutionInputs({ receipt, tracked, fs, commit: "a".repeat(40) })); writeFileSync(join(output, target), original);
  files.set("execution/dependencies/playwright/unlisted.mjs", true); assert.throws(() => replayExecutionInputs({ receipt, tracked, fs, commit: "a".repeat(40) })); files.delete("execution/dependencies/playwright/unlisted.mjs");
  const changed = structuredClone(receipt); changed.packages[0].integrity = integrity(Buffer.from("replacement")); assert.throws(() => replayExecutionInputs({ receipt: changed, tracked, fs, commit: "a".repeat(40) }));
  writeFileSync(join(source, "runner.mjs"), "export const run = false;\n");
  assert.throws(() => finalizeExecutionInputs({ folder: output, repo: source }));
}));
test("package extraction refuses escaped, ambiguous and tampered archives", () => {
  for (const path of ["../escape", "a/../../escape", "x\\y", "CON", "name.", "/absolute"]) {
    const archive = tar({ [path]: "hostile" }); assert.throws(() => packageFiles(archive, integrity(archive)));
  }
  const archive = tar({ "index.mjs": "actual" }); assert.throws(() => packageFiles(archive, integrity(Buffer.from("replacement"))));
});
