import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import ts from "typescript";

export const bindingArtifactSchema = "native-binding-code/v1";
export const bindingHash = (value) => createHash("sha256").update(value).digest("hex");
const payload = ({ schema, imageId, sourceCommit, scripts }) => ({ schema, imageId, sourceCommit, scripts });

// The caller supplies bytes extracted from an immutable image, not page-provided
// purity annotations. The same format is used by explicitly non-qualifying tests.
export function createBindingArtifact({ imageId, sourceCommit, scripts }) {
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  let bytes = 0;
  const rows = scripts.map(({ path, source }) => {
    assert.ok(typeof path === "string" && /^\/(?!\/)/.test(path) && !/[?#\\\s]/.test(path)
      && !path.split("/").includes(".."));
    assert.equal(typeof source, "string");
    assert.ok(Buffer.byteLength(source) <= 8 * 1024 * 1024, "Binding script exceeds supported bound");
    bytes += Buffer.byteLength(source); assert.ok(bytes <= 32 * 1024 * 1024, "Binding artifact exceeds supported byte bound");
    return { path, sha256: bindingHash(source), source };
  }).sort((a, b) => a.path.localeCompare(b.path));
  assert.ok(rows.length <= 256 && new Set(rows.map((r) => r.path)).size === rows.length, "Duplicate/excess binding scripts");
  const value = { schema: bindingArtifactSchema, imageId, sourceCommit, scripts: rows };
  return { ...value, sha256: bindingHash(JSON.stringify(value)) };
}

export function validateBindingArtifact(value) {
  assert.equal(value?.schema, bindingArtifactSchema);
  assert.deepEqual(Object.keys(value).sort(), ["imageId", "schema", "scripts", "sha256", "sourceCommit"]);
  const rebuilt = createBindingArtifact(value);
  assert.deepEqual(value, rebuilt, "Binding artifact bytes/hash differ");
  assert.equal(value.sha256, bindingHash(JSON.stringify(payload(value))));
  return value;
}

export function indexBindingArtifact(artifact) {
  validateBindingArtifact(artifact);
  const scripts = new Map(), functions = new Map();
  for (const script of artifact.scripts) {
    const file = ts.createSourceFile(script.path, script.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.equal(file.parseDiagnostics.length, 0, `Unsupported emitted JavaScript: ${script.path}`);
    const row = { ...script, file, functions: [] };
    const visit = (node) => {
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
        const start = node.getStart(file), end = node.end;
        const id = `${script.sha256}:${start}:${end}`;
        const entry = { id, script: row, node, start, end };
        row.functions.push(entry); functions.set(id, entry);
      }
      ts.forEachChild(node, visit);
    };
    visit(file); scripts.set(script.path, row);
  }
  return { artifact, scripts, functions, locate(path, line, column) {
    const script = scripts.get(path);
    assert.ok(script && Number.isInteger(line) && Number.isInteger(column), "Unbound native function location");
    const offset = script.file.getPositionOfLineAndCharacter(line, column);
    const matches = script.functions.filter((f) => f.start <= offset && offset < f.end).sort((a, b) => (a.end - a.start) - (b.end - b.start));
    assert.ok(matches.length, "Function location is outside emitted artifact functions");
    return matches[0];
  } };
}

export function bindingFunctionText(entry) {
  return entry.node.getText(entry.script.file).replace(/^export\s+(?:default\s+)?/, "");
}
