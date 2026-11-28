// node --test bench/request-cost/build.test.mjs
// build.sh with a stand-in for cargo on PATH: what it refuses before it makes anything, and what
// it leaves when a build fails or resolves a version the commit's lock file does not have. Needs
// sh, git and a checkout, and is skipped without them; no test here compiles the probe.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const kit = dirname(fileURLToPath(import.meta.url));
const git = (/** @type {string[]} */ ...args) => spawnSync("git", args, { cwd: kit, encoding: "utf8" });
const checkout = spawnSync("sh", ["-c", "git rev-parse --show-toplevel"], { cwd: kit }).status === 0;
const skip = !checkout && "needs sh, git and a checkout";
// The stand-in cargo is a shell script on PATH, and build.sh's own tools are a Linux host's.
const builds = checkout && process.platform === "linux";
const skipBuilds = !builds && "needs Linux, sh, git and a checkout";

/**
 * A directory outside the checkout, and `build(directory, asked)`: build.sh for HEAD with a
 * cargo that builds nothing. In the probe's copy it writes a file where the binary would be and
 * adds to the lock file, as cargo does, the probe's own package and those `STAND_IN_ADDS` names
 * ("name version name version"); with `STAND_IN_FAILS` it fails as a build that does not compile.
 */
function standIn() {
  const outside = mkdtempSync(join(tmpdir(), "request-cost-build-"));
  mkdirSync(join(outside, "bin"));
  const cargo = [
    "#!/bin/sh",
    '[ "$1 $2" = "build --release" ] && [ -f Cargo.toml ] && [ -f Cargo.lock ] && [ -d ../work/crates/corten ] || exit 64',
    '[ -z "${STAND_IN_FAILS:-}" ] || exit 101',
    'mkdir -p "$CARGO_TARGET_DIR/release"',
    'echo "a probe built in $(pwd)" > "$CARGO_TARGET_DIR/release/probe"',
    "printf '\\n[[package]]\\nname = \"%s\"\\nversion = \"%s\"\\n' request-cost-probe 0.0.0 ${STAND_IN_ADDS:-} >> Cargo.lock",
    "",
  ].join("\n");
  writeFileSync(join(outside, "bin", "cargo"), cargo);
  chmodSync(join(outside, "bin", "cargo"), 0o755);
  const env = { ...process.env, PATH: `${join(outside, "bin")}${delimiter}${process.env.PATH}` };
  const build = (/** @type {string} */ directory, /** @type {Record<string, string>} */ asked = {}) =>
    spawnSync("sh", [join(kit, "build.sh"), "HEAD", directory], { cwd: kit, env: { ...env, ...asked }, encoding: "utf8" });
  return { outside, build, remove: () => rmSync(outside, { recursive: true, force: true }) };
}

test("build.sh refuses a directory inside the checkout before it makes or removes anything", { skip }, () => {
  for (const inside of ["not-made", "probe/not-made/deeper"]) {
    const built = spawnSync("sh", ["build.sh", "HEAD", inside], { cwd: kit, encoding: "utf8" });
    assert.equal(built.status, 2, built.stderr);
    assert.match(built.stderr, /is inside the checkout/);
    assert.ok(!existsSync(join(kit, inside.split("/")[0] === "probe" ? "probe/not-made" : "not-made")), `${inside} was made`);
  }
  assert.ok(existsSync(join(kit, "probe", "Cargo.toml")));
});

test("build.sh refuses a directory inside any git repository, whose probe/ it would replace", { skip: skipBuilds }, () => {
  const stand = standIn();
  try {
    const other = join(stand.outside, "other");
    mkdirSync(join(other, "probe"), { recursive: true });
    writeFileSync(join(other, "probe", "kept"), "another checkout's own");
    assert.equal(spawnSync("git", ["init", "-q", other]).status, 0);
    for (const inside of [other, join(other, "not-made", "deeper")]) {
      const built = stand.build(inside);
      assert.equal(built.status, 2, built.stderr);
      assert.match(built.stderr, /is inside a git repository/);
    }
    assert.ok(existsSync(join(other, "probe", "kept")));
    assert.ok(!existsSync(join(other, "not-made")) && !existsSync(join(other, "work")));
  } finally {
    stand.remove();
  }
});

test("build.sh refuses a directory under a .git entry that git itself does not read as a repository", { skip: skipBuilds }, () => {
  const stand = standIn();
  try {
    // As a repository owned by another user is to git: `rev-parse --git-dir` fails in both.
    for (const [name, entry] of /** @type {const} */ ([["emptied", "directory"], ["linked", "file"]])) {
      const other = join(stand.outside, name);
      mkdirSync(join(other, "probe"), { recursive: true });
      writeFileSync(join(other, "probe", "kept"), "another checkout's own");
      if (entry === "directory") mkdirSync(join(other, ".git"));
      else writeFileSync(join(other, ".git"), "gitdir: /nowhere\n");
      assert.notEqual(spawnSync("git", ["-C", other, "rev-parse", "--git-dir"]).status, 0, "git reads it as a repository");
      for (const inside of [other, join(other, "not-made", "deeper")]) {
        const built = stand.build(inside);
        assert.equal(built.status, 2, built.stderr);
        assert.match(built.stderr, /is inside a git repository/);
      }
      assert.ok(existsSync(join(other, "probe", "kept")));
      assert.ok(!existsSync(join(other, "not-made")) && !existsSync(join(other, "work")));
    }
  } finally {
    stand.remove();
  }
});

test("build.sh leaves the probe built against the commit's tree at bin/<commit>, and none when a later build of it fails", { skip: skipBuilds }, () => {
  const stand = standIn();
  try {
    const directory = join(stand.outside, "built");
    const commit = git("rev-parse", "HEAD").stdout.trim();
    const built = stand.build(directory);
    assert.equal(built.status, 0, built.stderr);
    assert.equal(built.stdout, `built ${directory}/bin/${commit}\n`);
    assert.match(readFileSync(join(directory, "bin", commit), "utf8"), /^a probe built in .*\/built\/probe$/m);
    // The commit's tree beside the probe's copy, which has the commit's lock file.
    assert.ok(existsSync(join(directory, "work", "crates", "corten", "Cargo.toml")));
    assert.ok(readFileSync(join(directory, "probe", "Cargo.lock"), "utf8").startsWith(git("show", "HEAD:Cargo.lock").stdout));
    const failed = stand.build(directory, { STAND_IN_FAILS: "1" });
    assert.equal(failed.status, 101, failed.stderr);
    assert.ok(!existsSync(join(directory, "bin", commit)), "the earlier build's binary was left");
  } finally {
    stand.remove();
  }
});

test("build.sh fails, and leaves no binary, when the build's lock file has a version the commit's has not", { skip: skipBuilds }, () => {
  const stand = standIn();
  try {
    const directory = join(stand.outside, "built");
    const commit = git("rev-parse", "HEAD").stdout.trim();
    const [, name, version] = /** @type {RegExpExecArray} */ (/^name = "(.+)"\nversion = "(.+)"$/m.exec(git("show", "HEAD:Cargo.lock").stdout));
    // A crate the commit's lock file has, at its version, is none.
    const same = stand.build(directory, { STAND_IN_ADDS: `${name} ${version}` });
    assert.equal(same.status, 0, same.stderr);
    // Another crate, another version of one it has, and a crate named as the probe's own begins.
    for (const adds of ["not-in-the-lock 1.2.3", `${name} 999.0.0`, "request-cost-probe-too 0.0.0"]) {
      const built = stand.build(directory, { STAND_IN_ADDS: adds });
      assert.equal(built.status, 1, `${adds}: ${built.stderr}`);
      assert.ok(built.stderr.includes(`built with versions the commit's Cargo.lock does not have:\n${adds}\n`), built.stderr);
      assert.ok(!existsSync(join(directory, "bin", commit)), `${adds}: a binary was left`);
    }
  } finally {
    stand.remove();
  }
});
