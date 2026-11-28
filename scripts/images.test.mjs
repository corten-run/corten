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

/** The cargo home each build in a Dockerfile runs with (`cargo build`, `cargo install`, and
 * `corten build`, which runs Cargo): a `CARGO_HOME=` before the command, else its stage's
 * `ENV CARGO_HOME`, else none (`undefined`, the image's own). */
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
    if (/^RUN\s/i.test(line)) {
      for (const build of line.matchAll(/(?:CARGO_HOME=(\S+)\s+)?(?:cargo (?:build|install)|corten build)/g)) homes.push(build[1] ?? home);
    }
  }
  return homes;
}

test("every example has an image, and each is checked", () => {
  assert.ok(examples.length > 0);
  for (const file of files) assert.ok(existsSync(new URL(file, root)), `${file} is missing`);
});

/** The one `RUN` of an example's build stages, without its leading `--mount` options: touch the
 * sources, build the release locked (one package in the examples' workspace), and copy the binary
 * out. Any other `RUN` before the run stage, or another shape, is refused, so a second build, a
 * build behind a variable or a flag in a comment cannot slip past. */
const BUILD =
  /^find \. -name target -prune -o -type f -exec touch \{\} \+ && cargo build --release --locked(?: -p [\w-]+)? && (?:mkdir -p \/out && )?cp target\/release\/[\w-]+ \/[\w/]+$/;

/** The two `RUN`s of the template's build stage, which builds with a profile when `PROFILE_FROM`
 * names the app's script (docs/design.md#choice-profile-image), each in its one shape. The first
 * installs the `corten` command, locked, only when the argument is given, and refuses one without
 * the option. The second is {@link BUILD} with the build as a choice of two: `cargo build` without
 * the argument, `corten build --profile-from` with it, both locked, and neither behind any other
 * variable. */
const INSTALL =
  /^if \[ -n "\$PROFILE_FROM" \]; then rustup component add llvm-tools && CARGO_HOME=[\w/.-]+ cargo install corten-cli --version \{\{version\}\} --locked --root \/usr\/local && if ! corten help build \| grep -q -e --profile-from; then echo "[^"$`\\]*" >&2; exit 1; fi; fi$/;
const BUILD_EITHER =
  /^find \. -name target -prune -o -type f -exec touch \{\} \+ && if \[ -z "\$PROFILE_FROM" \]; then CARGO_HOME=[\w/.-]+ cargo build --release --locked; elif \[ -f "\$PROFILE_FROM" \]; then CARGO_HOME=[\w/.-]+ corten build --locked --profile-from sh -- "\$PROFILE_FROM"; else echo "PROFILE_FROM=\$PROFILE_FROM: [^"$`\\]*" >&2; exit 1; fi && cp target\/release\/\{\{name\}\} \/server$/;

/** Why a Dockerfile does not build the way it has to, or nothing when it does: an example's one
 * `RUN` as {@link BUILD} reads, or, for the template (`profiled`), {@link INSTALL} and
 * {@link BUILD_EITHER} in that order. Each file has the one shape that is its own, so an example
 * cannot take the template's. */
function unlocked(/** @type {string} */ text, profiled = false) {
  const lines = instructions(text);
  const runs = lines
    .slice(0, lines.findLastIndex((line) => /^FROM\s/i.test(line)))
    .filter((line) => /^RUN\s/i.test(line))
    .map((line) => line.replace(/^RUN\s+((--mount=\S+)\s+)*/i, "").replace(/\s+/g, " ").trim());
  if (profiled) {
    if (runs.length !== 2) return `has ${runs.length} RUN instructions before its run stage, not the 2 of a build that may take a profile`;
    if (!INSTALL.test(runs[0])) return `installs otherwise than the one locked install of a profiled build: ${runs[0]}`;
    return BUILD_EITHER.test(runs[1]) ? undefined : `builds otherwise than locked, with a profile or without: ${runs[1]}`;
  }
  if (runs.length !== 1) return `has ${runs.length} RUN instructions before its run stage, not 1`;
  return BUILD.test(runs[0]) ? undefined : `builds otherwise than its one locked release build: ${runs[0]}`;
}

test("an example's build is read in its one shape, and the template's two RUNs each in theirs", () => {
  const dockerfile = (/** @type {string[]} */ runs) => ["FROM rust AS build", ...runs.map((run) => `RUN ${run}`), "FROM debian", "RUN echo cargo"].join("\n");
  const image = (/** @type {string} */ ...runs) => unlocked(dockerfile(runs));
  const template = (/** @type {string} */ ...runs) => unlocked(dockerfile(runs), true);
  const touch = "find . -name target -prune -o -type f -exec touch {} +";
  const copy = "mkdir -p /out && cp target/release/app /out/server";
  assert.equal(image(`--mount=type=cache,target=/t ${touch} \\\n    && cargo build --release --locked -p app && ${copy}`), undefined);
  for (const bad of [
    [`${touch} && cargo build --release -p app && ${copy}`],
    [`${touch} && cargo build --release -p app && ${copy} # --locked`],
    [`${touch} && cargo build --release --mount=type=cache,target=/t --locked -p app && ${copy}`],
    [`${touch} && env CARGO_HOME=/c cargo build --release --locked -p app && ${copy}`],
    ['sh -c "$BUILD"', `${touch} && cargo build --release --locked -p app && ${copy}`],
    [`${touch} && cargo build --release --locked -p app && ${copy}`, `${touch} && cargo build --release --locked -p app && ${copy}`],
    [`${touch} && cargo build --release --locked -p app && cargo build --release -p other && ${copy}`],
    [`${touch} && env CARGO_HOME=/c cargo build --release -p app && ${copy}`],
    [`${touch} && cargo build --release --locked -p app && ${copy}`, "cargo build --release"],
    ["echo build"],
  ])
    assert.notEqual(image(...bad), undefined, bad.join(" / "));
  // The template's two, read from the template so that these are its lines with one thing changed.
  const [install, build] = instructions(source(TEMPLATE)).filter((line) => /^RUN\s/i.test(line)).map((line) => line.replace(/^RUN\s+/i, ""));
  assert.equal(template(install, build), undefined);
  assert.notEqual(image(install, build), undefined, "an example does not take the template's two RUNs");
  assert.notEqual(template(`${touch} && cargo build --release --locked -p app && ${copy}`), undefined, "nor the template an example's one");
  // One thing changed, which has to be there to change.
  const swapped = (/** @type {string} */ run, /** @type {string} */ from, /** @type {string} */ to) => {
    assert.ok(run.includes(from), `the template has no ${from}`);
    return run.replace(from, to);
  };
  for (const bad of [
    [swapped(install, " --locked", ""), build],
    [install, swapped(build, "cargo build --release --locked", "cargo build --release")],
    [install, swapped(build, "corten build --locked", "corten build")],
    [swapped(install, "exit 1; ", ""), build],
    [install, swapped(build, "exit 1; ", "")],
    [swapped(install, "if ! corten", "if corten"), build],
    [install, swapped(build, 'sh -- "$PROFILE_FROM"', "sh $PROFILE_FROM")],
    [install, swapped(build, '[ -f "$PROFILE_FROM" ]', "true")],
    [install, swapped(build, "cp target/release/{{name}} /server", "cp target/release/server /server")],
    [install, swapped(build, "cp target/release/{{name}} /server", "cp target/release/{{name}} /srv")],
    [build, install],
    [install, build, build],
    [install, `${touch} && cargo build --release --locked -p app && ${copy}`],
    [install],
  ])
    assert.notEqual(template(...bad), undefined, bad.join(" / "));
});

// An image builds the versions the lock names, which `corten check` ran, and fails when the lock is
// missing or stale instead of repairing it inside the build (#1579, #1584).
test("every image's cargo build is --locked", () => {
  for (const file of files) assert.equal(unlocked(source(file), file === TEMPLATE), undefined, file);
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
  // One mount in each RUN that runs Cargo: the one that installs the `corten` command for a
  // profiled build, and the build.
  assert.deepEqual(home.map((mount) => mount.run), [0, 1], "cargo's home is a cache in each RUN that runs cargo");
  for (const mount of home) {
    assert.equal(mount.sharing ?? "shared", "shared", "every app's builds share the downloaded crates");
    assert.equal(mount.id, undefined, "one cache of crates for every app on the machine");
  }
  const cargo = mounts.filter((mount) => mount.target.startsWith("/usr/local/cargo"));
  assert.deepEqual(cargo, [], "a cache under the image's cargo home leaves cargo's lock out of it");
  const homes = cargoHomes(text);
  assert.equal(homes.length, 3, "the template installs the command, and builds with cargo or with it");
  for (const used of homes) assert.equal(used, "/var/cache/cargo", "cargo builds with the cached home");
});

// A profile is asked for (docs/design.md#choice-profile-image): with no PROFILE_FROM the image's
// build is the ordinary one, and neither the command nor llvm-tools is fetched. The command goes
// into the layer, under /usr/local: cargo's home here is a cache mount, which is no part of a
// layer, so a build that reused the layer on a builder without the cache would have no command.
// A command without the option (0.2.0's `corten build` took no arguments and built without a
// profile) is refused before the app is built. Both builds hold the lock.
test("the template's build takes a profile only when PROFILE_FROM names the app's script", () => {
  const lines = instructions(source(TEMPLATE));
  const run = (/** @type {string} */ line) => /^RUN\s/i.test(line);
  // Declared in the build stage and before both of its RUNs: a RUN it is declared after reads it
  // as empty, so after the first the build looks for a command that was not installed, and
  // after both the build is the ordinary one without a word.
  const argument = lines.indexOf("ARG PROFILE_FROM=");
  assert.ok(argument >= 0, "PROFILE_FROM is empty unless the build is given it");
  assert.equal(lines.findIndex((line) => /^FROM\s/i.test(line)), 0);
  assert.ok(argument < lines.findIndex(run), "PROFILE_FROM is declared before the RUNs that read it");
  assert.ok(lines.findIndex(run) < lines.indexOf("COPY . ."), "the command is installed before the sources, so a changed source does not install it again");
  // And nothing between takes it away again: an argument lasts to the end of its stage, so a
  // `FROM` before the build would start a stage without it, and an `ENV` of the name is read
  // in the argument's place. Either builds the ordinary image whatever the build was given.
  assert.equal(lines.filter((line) => /^FROM\s/i.test(line)).length, 2, "one build stage and the run stage");
  assert.deepEqual(lines.filter((line) => /PROFILE_FROM/.test(line) && !/^RUN\s/i.test(line)), ["ARG PROFILE_FROM="], "nothing else sets the name");
  // What the two RUNs run is read whole by "every image's cargo build is --locked".
  assert.equal(lines.filter(run).length, 3, "two RUNs build, and the run stage's installs jemalloc");
});

test("a cargo home is read from before the command or from the stage's ENV", () => {
  const build = "RUN cargo build --release";
  assert.deepEqual(cargoHomes(`FROM a\n${build}`), [undefined]);
  assert.deepEqual(cargoHomes(`FROM a\nRUN CARGO_HOME=/h cargo build`), ["/h"]);
  assert.deepEqual(cargoHomes(`FROM a\nRUN CARGO_HOME=/h cargo install x && corten build`), ["/h", undefined]);
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
