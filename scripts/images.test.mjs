// @ts-check
// Every image Corten writes or ships runs its server as an unprivileged user given by number, so a
// cluster that requires non-root containers starts it and a flaw in the app does not run as root:
// the template `corten new` writes and each example's (#1136). Nothing builds the template's
// image (its app depends on the published crate), so card-market's, which CI builds and smokes,
// stands in for it: their run stages must be the same instructions.
// Each also keeps its target cache apart from other apps' on the machine (#1345).
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

/** A Dockerfile's instructions, one per line. A comment line is dropped before continuations are
 * joined, as Docker reads it: a `\` ending a comment does not continue it. */
function instructions(/** @type {string} */ text) {
  const kept = text.split(/\r?\n/).filter((line) => !line.trim().startsWith("#"));
  return kept.join("\n").replace(/\\\n/g, " ").split("\n").map((line) => line.trim()).filter(Boolean);
}

/** The instructions of a Dockerfile's last stage. */
function lastStage(/** @type {string} */ text) {
  const lines = instructions(text);
  const from = lines.findLastIndex((line) => /^FROM\s/i.test(line));
  return lines.slice(from);
}

/** The cache mounts of a Dockerfile's `RUN`s, each as its options, and the commands they run. */
function caches(/** @type {string} */ text) {
  const runs = instructions(text).filter((line) => /^RUN\s/i.test(line));
  const mounts = runs.flatMap((line) => [...line.matchAll(/--mount=(\S+)/g)].map((found) => found[1]));
  const options = mounts.map((mount) => Object.fromEntries(mount.split(",").map((pair) => pair.split("="))));
  return { mounts: options.filter((mount) => mount.type === "cache"), commands: runs.join("\n") };
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

// BuildKit names a cache mount by its `id`, the mount's path when there is none, so every image on a
// builder that mounts /src/target without one shares a single target cache, and with `locked` each
// build waits for every other one. The template's is the app's own, by its name; the examples build
// one workspace, so theirs is one id for them all, and they still take turns.
test("each image's target cache has an id of its own", () => {
  const ids = new Map();
  for (const file of files) {
    const { mounts } = caches(readFileSync(new URL(file, root), "utf8"));
    const target = mounts.filter((mount) => mount.target === "/src/target");
    assert.equal(target.length, 1, `${file}: one target cache`);
    assert.ok(target[0].id, `${file}: the target cache has no id, so it is every app's /src/target`);
    assert.equal(target[0].sharing, "locked", `${file}: builds of one app take turns on its target`);
    ids.set(file, target[0].id);
  }
  assert.equal(ids.get(TEMPLATE), "{{name}}-target", "the template's target cache is named for the app");
  const examples = new Set(files.filter((file) => file !== TEMPLATE).map((file) => ids.get(file)));
  assert.equal(examples.size, 1, `the examples share one target cache: ${[...examples].join(", ")}`);
  assert.ok(!examples.has(ids.get(TEMPLATE)));
});

// Builds of different apps now run at once, and cargo's lock on downloaded crates is in its home
// (`.package-cache`), not beside them under `registry`: two builds sharing only `registry` unpacked
// the same crate at once, and one failed (#1345). So the template caches cargo's whole home, where
// each build sees the other's lock, and builds with it.
test("the template caches cargo's whole home, with its lock, and builds with it", () => {
  const { mounts, commands } = caches(readFileSync(new URL(TEMPLATE, root), "utf8"));
  const home = mounts.filter((mount) => mount.target === "/var/cache/cargo");
  assert.equal(home.length, 1, "cargo's home is a cache");
  assert.equal(home[0].sharing ?? "shared", "shared", "every app's builds share the downloaded crates");
  assert.equal(home[0].id, undefined, "one cache of crates for every app on the machine");
  const cargo = mounts.filter((mount) => mount.target.startsWith("/usr/local/cargo"));
  assert.deepEqual(cargo, [], "a cache under the image's cargo home leaves cargo's lock out of it");
  const builds = [...commands.matchAll(/(\S+\s+)?cargo build/g)];
  assert.ok(builds.length > 0, "the template builds with cargo");
  for (const build of builds) assert.equal(build[1]?.trim(), "CARGO_HOME=/var/cache/cargo", "cargo builds with the cached home");
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
