// @ts-check
// Every image Corten writes or ships runs its server as an unprivileged user given by number, so a
// cluster that requires non-root containers starts it and a flaw in the app does not run as root:
// the template `corten new` writes and each example's (#1136). Nothing builds the template's
// image (its app depends on the published crate), so card-market's, which CI builds and smokes,
// stands in for it: their run stages must be the same instructions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const root = new URL("../", import.meta.url);
const TEMPLATE = "crates/corten-cli/template/Dockerfile";
const STAND_IN = "examples/card-market/Dockerfile";
const examples = readdirSync(new URL("examples/", root), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(new URL(`examples/${entry.name}/Cargo.toml`, root)))
  .map((entry) => entry.name);
const files = [TEMPLATE, ...examples.map((name) => `examples/${name}/Dockerfile`)];

/** The instructions of a Dockerfile's last stage, one per line. A comment line is dropped before
 * continuations are joined, as Docker reads it: a `\` ending a comment does not continue it. */
function lastStage(/** @type {string} */ text) {
  const kept = text.split(/\r?\n/).filter((line) => !line.trim().startsWith("#"));
  const lines = kept.join("\n").replace(/\\\n/g, " ").split("\n").map((line) => line.trim()).filter(Boolean);
  const from = lines.findLastIndex((line) => /^FROM\s/i.test(line));
  return lines.slice(from);
}

test("every example has an image, and each is checked", () => {
  assert.ok(examples.length > 0);
  for (const file of files) assert.ok(existsSync(new URL(file, root)), `${file} is missing`);
});

test("card-market's run stage is the template's, so its smoke checks the template's image", () => {
  const copy = (/** @type {string} */ line) => line.replace(/^COPY --from=build \S+/i, "COPY --from=build <server>");
  const read = (/** @type {string} */ file) => lastStage(readFileSync(new URL(file, root), "utf8")).map(copy);
  assert.deepEqual(read(STAND_IN), read(TEMPLATE));
});

for (const file of files) {
  test(`${file} runs its server as a numeric non-root user`, () => {
    const stage = lastStage(readFileSync(new URL(file, root), "utf8"));
    const users = stage.map((line, at) => [line, at]).filter(([line]) => /^USER\s/i.test(String(line)));
    const run = stage.findIndex((line) => /^(CMD|ENTRYPOINT)\s/i.test(line));
    assert.ok(users.length > 0, "the last stage has no USER line, so the server runs as root");
    const [line, at] = users[users.length - 1];
    const id = /^USER\s+(\S+)$/i.exec(String(line))?.[1] ?? "";
    assert.match(id, /^\d+(:\d+)?$/, `USER ${id}: a name cannot be told from root by a non-root policy`);
    assert.notEqual(Number(id.split(":")[0]), 0, `USER ${id} is root`);
    assert.ok(run < 0 || Number(at) < run, "USER comes before the command it runs");
  });
}
