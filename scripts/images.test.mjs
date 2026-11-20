// @ts-check
// Every image Corten writes or ships runs its server as an unprivileged user given by number, so a
// cluster that requires non-root containers starts it and a flaw in the app does not run as root:
// the template `corten new` writes and each example's (#1136). Nothing builds the template's
// image (its app depends on the published crate), so card-market's, which CI builds and smokes,
// stands in for it: their run stages must be the same instructions.
// Each also keeps its build caches from waiting on, or racing, other apps' on the machine (#1345).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dockerfileOf, recipes } from "../bench/fullstack/builds.mjs";

const root = new URL("../", import.meta.url);
const TEMPLATE = "crates/corten-cli/template/Dockerfile";
const STAND_IN = "examples/card-market/Dockerfile";
const examples = readdirSync(new URL("examples/", root), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(new URL(`examples/${entry.name}/Cargo.toml`, root)))
  .map((entry) => entry.name);
const files = [TEMPLATE, ...examples.map((name) => `examples/${name}/Dockerfile`)];
const source = (/** @type {string} */ file) => readFileSync(new URL(file, root), "utf8");

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

/** The cache mounts of a Dockerfile's `RUN`s, each as its options and the index of its `RUN`. */
function caches(/** @type {string} */ text) {
  const runs = instructions(text).filter((line) => /^RUN\s/i.test(line));
  const mounts = runs.flatMap((line, run) =>
    [...line.matchAll(/--mount=(\S+)/g)].map((found) => ({ ...Object.fromEntries(found[1].split(",").map((pair) => pair.split("="))), run })),
  );
  return mounts.filter((mount) => mount.type === "cache");
}

/** The cargo home each `cargo build` in a Dockerfile runs with: a `CARGO_HOME=` before the command,
 * else its stage's `ENV CARGO_HOME`, else none (`undefined`, the image's own). */
function cargoHomes(/** @type {string} */ text) {
  /** @type {(string | undefined)[]} */
  const homes = [];
  /** @type {string | undefined} */
  let home;
  for (const line of instructions(text)) {
    if (/^FROM\s/i.test(line)) home = undefined;
    const env = /^ENV\s+(.*)$/i.exec(line)?.[1];
    if (env !== undefined) {
      const pairs = /^\w+=/.test(env) ? [...env.matchAll(/(\w+)=(\S+)/g)].map((pair) => [pair[1], pair[2]]) : [env.split(/\s+/)];
      for (const [key, value] of pairs) if (key === "CARGO_HOME") home = value;
    }
    if (/^RUN\s/i.test(line)) for (const build of line.matchAll(/(?:CARGO_HOME=(\S+)\s+)?cargo build/g)) homes.push(build[1] ?? home);
  }
  return homes;
}

test("every example has an image, and each is checked", () => {
  assert.ok(examples.length > 0);
  for (const file of files) assert.ok(existsSync(new URL(file, root)), `${file} is missing`);
});

/** The commands a `RUN` line runs, each as its words with quotes taken off: the exec form's array,
 * or the shell form split at `&&`, `||`, `;` and `|`, without the instruction's own `--` options,
 * redirections, and the `NAME=value` assignments before a command. A word that still holds a `$`
 * is an expansion this reading cannot follow. */
function commands(/** @type {string} */ line) {
  let rest = line.replace(/^RUN\s+/i, "");
  while (/^--\S+\s/.test(rest)) rest = rest.replace(/^--\S+\s+/, "");
  if (rest.startsWith("[")) return [JSON.parse(rest)];
  /** @type {string[][]} */
  const found = [[]];
  let word = "";
  let quoted = false;
  let redirect = false;
  const end = () => {
    if (word || quoted) {
      if (redirect) redirect = false;
      else found[found.length - 1].push(word);
    }
    word = "";
    quoted = false;
  };
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === "'" || c === '"') {
      const close = rest.indexOf(c, i + 1);
      assert.ok(close > i, `unclosed quote in ${line}`);
      word += rest.slice(i + 1, close);
      quoted = true;
      i = close;
    } else if (c === "\\") word += rest[++i] ?? "";
    else if (/\s/.test(c)) end();
    else if ("&|;".includes(c)) {
      end();
      if (rest[i + 1] === c) i++;
      found.push([]);
    } else if ("<>".includes(c)) {
      end();
      if (rest[i + 1] === c || rest[i + 1] === "&") i++;
      redirect = true;
    } else word += c;
  }
  end();
  return found.map((words) => words.slice(words.findIndex((w) => !/^\w+=/.test(w)))).filter((words) => words.length > 0 && !/^\w+=/.test(words[0]));
}

/** Why a Dockerfile's `cargo` commands are not all locked builds, or nothing when they are: each
 * `cargo` names its subcommand in plain words, and each `cargo build` has `--locked`. */
function unlocked(/** @type {string} */ text) {
  const cargo = instructions(text)
    .filter((line) => /^RUN\s/i.test(line))
    .flatMap(commands)
    .filter((words) => words[0] === "cargo" || words[0].endsWith("/cargo"));
  if (!cargo.some((words) => words[1] === "build")) return "runs no cargo build";
  for (const words of cargo) {
    if (words.length < 2 || words[1].includes("$")) return `names cargo's subcommand by an expansion: ${words.join(" ")}`;
    if (words[1] === "build" && !words.includes("--locked")) return `builds without --locked: ${words.join(" ")}`;
  }
  return undefined;
}

test("the locked-build reading follows the shell's words, not text that looks like them", () => {
  const run = (/** @type {string} */ line) => unlocked(`FROM rust\nRUN ${line}\n`);
  for (const ok of [
    "cargo build --release --locked -p app",
    "--mount=type=cache,target=/t find . -exec touch {} + && CARGO_HOME=/c cargo build --release '--locked' && cp a b",
    "cargo fetch && cargo build --locked > build.log 2>&1",
    '["cargo", "build", "--release", "--locked"]',
    "cargo \\\n build --locked",
  ])
    assert.equal(run(ok), undefined, ok);
  for (const bad of [
    "cargo build --release",
    "cargo build --locked && cargo build --release -p other",
    "cargo build --locked; action=build; cargo \"$action\" --release",
    'cargo build --release > "build --locked output.log"',
    '["cargo", "build", "--release"]',
    "echo cargo build --locked",
  ])
    assert.notEqual(run(bad), undefined, bad);
});

// An image builds the versions the lock names, which `corten check` ran, and fails when the lock is
// missing or stale instead of repairing it inside the build (#1579, #1584).
test("every image's cargo build is --locked", () => {
  for (const file of files) assert.equal(unlocked(source(file)), undefined, file);
});

// The timed build benchmark runs an image's commands from its recipe, its download first (`deps`).
// A recipe whose build is locked downloads locked too, or the download could repair the lock
// before the build would refuse it (#1584).
test("a bench recipe that builds locked fetches locked", () => {
  const locked = Object.entries(recipes).filter(([, recipe]) => /\bcargo build\b.*--locked\b/.test(recipe.build ?? ""));
  assert.ok(locked.some(([name]) => dockerfileOf(name) === STAND_IN), "card-market's recipe builds locked");
  for (const [name, recipe] of locked) {
    if (/\bcargo fetch\b/.test(recipe.deps ?? "")) assert.match(recipe.deps ?? "", /\s--locked(\s|$)/, name);
  }
});

test("card-market's run stage is the template's, so its smoke checks the template's image", () => {
  const copy = (/** @type {string} */ line) => line.replace(/^COPY --from=build \S+/i, "COPY --from=build <server>");
  const read = (/** @type {string} */ file) => lastStage(readFileSync(new URL(file, root), "utf8")).map(copy);
  assert.deepEqual(read(STAND_IN), read(TEMPLATE));
});

// BuildKit names a cache mount by its `id`, the mount's path when there is none, so every image on a
// builder that mounts /src/target without one shares a single target cache, and with `locked` each
// build waits for every other one. The template's is the app's own, by its name. The examples build
// one workspace, so theirs is one id for them all, which they take turns on, and one no app `corten
// new` writes can have: an app's name is lowercase letters, digits, `-` and `_`.
test("each target cache is one app's, or the examples' workspace's, by its id", () => {
  const ids = new Map();
  for (const file of files) {
    const target = caches(source(file)).filter((mount) => mount.target === "/src/target");
    assert.equal(target.length, 1, `${file}: one target cache`);
    assert.ok(target[0].id, `${file}: the target cache has no id, so it is every app's /src/target`);
    assert.equal(target[0].sharing, "locked", `${file}: builds of one app take turns on its target`);
    ids.set(file, target[0].id);
  }
  assert.equal(ids.get(TEMPLATE), "{{name}}-target", "the template's target cache is named for the app");
  const shared = new Set(files.filter((file) => file !== TEMPLATE).map((file) => ids.get(file)));
  assert.equal(shared.size, 1, `the examples share one target cache: ${[...shared].join(", ")}`);
  const [id] = shared;
  assert.doesNotMatch(id, /^[a-z][a-z0-9_-]*-target$/, `${id}: an app corten new writes could be named to share the examples' target`);
});

// Builds of different apps run at once, and cargo's lock on downloaded crates is in its home
// (`.package-cache`), not beside them under `registry`: two `cargo fetch`es sharing only `registry`
// failed to unpack a crate in two runs of three ("File exists"), and sharing the whole home they
// waited for each other's lock in three of three. So the template caches cargo's whole home and
// builds with it, set before the command or by `ENV`.
test("the template caches cargo's whole home, with its lock, and builds with it", () => {
  const text = source(TEMPLATE);
  const mounts = caches(text);
  const home = mounts.filter((mount) => mount.target === "/var/cache/cargo");
  assert.equal(home.length, 1, "cargo's home is a cache");
  assert.equal(home[0].sharing ?? "shared", "shared", "every app's builds share the downloaded crates");
  assert.equal(home[0].id, undefined, "one cache of crates for every app on the machine");
  const cargo = mounts.filter((mount) => mount.target.startsWith("/usr/local/cargo"));
  assert.deepEqual(cargo, [], "a cache under the image's cargo home leaves cargo's lock out of it");
  const homes = cargoHomes(text);
  assert.ok(homes.length > 0, "the template builds with cargo");
  for (const used of homes) assert.equal(used, "/var/cache/cargo", "cargo builds with the cached home");
});

test("a cargo home is read from before the command or from the stage's ENV", () => {
  const build = "RUN cargo build --release";
  assert.deepEqual(cargoHomes(`FROM a\n${build}`), [undefined]);
  assert.deepEqual(cargoHomes(`FROM a\nRUN CARGO_HOME=/h cargo build`), ["/h"]);
  assert.deepEqual(cargoHomes(`FROM a\nENV A=1 CARGO_HOME=/h\n${build}`), ["/h"]);
  assert.deepEqual(cargoHomes(`FROM a\nENV CARGO_HOME /h\n${build}`), ["/h"]);
  assert.deepEqual(cargoHomes(`FROM a\nENV CARGO_HOME=/h\nFROM b\n${build}`), [undefined], "a stage from another image starts without it");
});

// The examples keep the image's cargo home, as bench/fullstack's recipe for card-market builds it,
// so their downloaded crates are a `registry` cache of their own. Without an id it is every image's
// /usr/local/cargo/registry, which builds of other apps write at the same time with no lock they all
// see. The examples write theirs one at a time: it is mounted in the RUN that holds their locked
// target.
test("the examples' downloaded crates are a cache of theirs, written one build at a time", () => {
  const ids = new Set();
  for (const file of files.filter((file) => file !== TEMPLATE)) {
    const mounts = caches(source(file));
    const crates = mounts.filter((mount) => mount.target.startsWith("/usr/local/cargo"));
    assert.equal(crates.length, 1, `${file}: one cache of downloaded crates`);
    assert.ok(crates[0].id, `${file}: the crate cache has no id, so other apps' builds write it too`);
    const target = mounts.find((mount) => mount.target === "/src/target");
    assert.equal(crates[0].run, target?.run, `${file}: the crate cache is mounted beside the locked target`);
    ids.add(crates[0].id);
  }
  assert.equal(ids.size, 1, `the examples share one crate cache: ${[...ids].join(", ")}`);
});

for (const file of files) {
  test(`${file} runs its server as a numeric non-root user`, () => {
    const stage = lastStage(source(file));
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
