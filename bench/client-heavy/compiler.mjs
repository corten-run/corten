import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep, isAbsolute, posix, win32 } from "node:path";

export function compilerSourcePath(root, input, workingDirectory = root) {
  const api = /^[A-Za-z]:\//.test(root) ? win32 : posix;
  const rel = api.relative(root, api.resolve(workingDirectory, input)).replaceAll("\\", "/");
  assert.ok(rel && rel !== ".." && !rel.startsWith("../") && !api.isAbsolute(rel), "escaped-rust-compiler-input");
  return rel;
}

export function compilerWorkingDirectory(metadata) {
  const manifest = metadata.packages.find((p) => p.id === metadata.resolve?.root)?.manifest_path?.replaceAll("\\", "/");
  assert.ok(manifest?.endsWith("/Cargo.toml"), "missing-rust-generator-package");
  return manifest.slice(0, -"/Cargo.toml".length);
}

export function cargoMetadata(stdout) {
  // Cargo writes one JSON object. A Cargo-compatible launcher may surround it
  // with non-JSON queue/status lines; keep all raw bytes in the tool receipt.
  const objects = stdout.toString().split(/\r?\n/).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  assert.ok(objects.length === 1 && objects[0].version === 1 && Array.isArray(objects[0].packages), "invalid-cargo-metadata-output");
  return objects[0];
}

// Rust's textual dep-info uses Make escaping, including continuations and spaces.
// Retain the original bytes too; env-dep comments are observations, not commands.
export function depInputs(text) {
  const inputs = new Set();
  for (const line of text.replace(/\\\r?\n/g, "").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const colon = line.search(/:\s/);
    assert.ok(colon >= 0 || line.endsWith(":"), "invalid-rust-dep-info");
    if (colon < 0) continue;
    const rhs = line.slice(colon + 1), words = [];
    let word = "", escaped = false;
    for (const char of rhs) {
      if (escaped) { word += char; escaped = false; }
      else if (char === "\\") escaped = true;
      else if (/\s/.test(char)) { if (word) words.push(word); word = ""; }
      else word += char;
    }
    assert.ok(!escaped, "invalid-rust-dep-info");
    if (word) words.push(word);
    words.forEach((word) => inputs.add(word.replaceAll("$$", "$")));
  }
  return [...inputs].sort();
}

export async function collectCompiler(evidence, target, metadata, stdout) {
  const value = { schema: "client-heavy-compiler-inputs/v1", metadata, toolchain: null, artifacts: [], depfiles: [], inputs: [], unavailable: [] };
  try {
    value.toolchain = await evidence.blob(await readFile(join(target, ".rustc_info.json")));
    const meta = cargoMetadata(metadata.stdout), messages = stdout.toString().split(/\r?\n/).filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    value.artifacts = messages.filter((m) => m.reason === "compiler-artifact");
    assert.ok(value.artifacts.length > 0, "missing-rust-compiler-artifacts");
    const manifest = meta.packages.find((p) => p.name === "corten-run")?.manifest_path.replaceAll("\\", "/");
    assert.ok(manifest?.endsWith("/crates/corten/Cargo.toml"), "missing-rust-source-root");
    const compilerRoot = manifest.slice(0, -"/crates/corten/Cargo.toml".length);
    value.compilerRoot = compilerRoot;
    const paths = new Set();
    let count = 0;
    const walk = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        assert.ok(++count <= 40000 && !entry.isSymbolicLink(), "compiler-tree-limit-or-link");
        const file = join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.name.endsWith(".d")) {
          const bytes = await readFile(file), inputs = depInputs(bytes.toString());
          value.depfiles.push({ path: relative(target, file).replaceAll("\\", "/"), ...await evidence.blob(bytes), inputs });
          inputs.forEach((path) => paths.add(path));
        }
      }
    };
    await walk(target);
    assert.ok(value.depfiles.length > 0, "missing-rust-dep-info");
    for (const path of [...paths].sort()) {
      const normalized = path.replaceAll("\\", "/");
      const sourcePath = compilerSourcePath(compilerRoot, normalized, compilerWorkingDirectory(meta));
      const local = resolve(evidence.root, sourcePath), rel = relative(evidence.root, local);
      assert.ok(!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`), "escaped-rust-compiler-input");
      value.inputs.push({ path, sourcePath, ...await evidence.file(evidence.root, rel) });
    }
  } catch (error) { value.unavailable.push({ name: error.name }); evidence.blockers.push("compiler-input-closure-incomplete"); }
  // stdout is retained in cargo-run.json, metadata's actual bytes in cargo-metadata.json.
  value.metadata = "evidence/cargo-metadata.json";
  await evidence.save("evidence/compiler-inputs.json", value);
  return value;
}
