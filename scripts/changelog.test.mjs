import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const prefix = "# Changelog\n\n## Unreleased\n\n";
const previous = "## 0.2.0 (2026-11-11)\n\n- A published entry.\n";

function checkout(t, changelog = prefix + previous) {
  const root = mkdtempSync(join(tmpdir(), "corten-changelog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, "scripts", "changelog.mjs");
  mkdirSync(join(root, "scripts"));
  copyFileSync(new URL("./changelog.mjs", import.meta.url), script);
  const file = join(root, "CHANGELOG.md");
  const dir = join(root, "changelog.d");
  writeFileSync(file, changelog);
  return {
    dir,
    write: (name, text) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), text);
    },
    run: (...args) => {
      const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
      if (result.error) throw result.error;
      return result;
    },
    read: () => readFileSync(file, "utf8"),
  };
}

test("check accepts absent and valid fragments without editing files", (t) => {
  const tree = checkout(t);
  const empty = tree.run("--check");
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /0 fragment\(s\) valid/);

  const note = "- A wrapped entry.\r\n  More detail.\r\n";
  tree.write("1611.md", note);
  const valid = tree.run("--check");
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /1 fragment\(s\) valid/);
  assert.equal(readFileSync(join(tree.dir, "1611.md"), "utf8"), note);
  assert.equal(tree.read(), prefix + previous);
});

test("release renders a single list in filename order ahead of unchanged legacy notes", (t) => {
  const legacy = "- An inline note.\n\n### Added\n\n- A categorized note.\n  More detail.\n\n";
  const tree = checkout(t, prefix + legacy + previous);
  tree.write("z-docs.md", "- A documentation note.\n");
  tree.write("9-fix.md", "- A fix with no trailing newline.");
  tree.write("10.md", "- **Breaking:** Change the API.\r\n  Explain how to upgrade.\r\n");

  const released = tree.run("release", "0.3.0", "2026-11-19");
  assert.equal(released.status, 0, released.stderr);
  assert.match(released.stdout, /3 fragment\(s\) released in 0\.3\.0/);
  assert.equal(tree.read(), prefix + "## 0.3.0 (2026-11-19)\n\n" +
    "- **Breaking:** Change the API.\n  Explain how to upgrade.\n\n" +
    "- A fix with no trailing newline.\n\n- A documentation note.\n\n" +
    legacy + previous);
  assert.deepEqual(readdirSync(tree.dir), []);
  const check = tree.run("--check");
  assert.equal(check.status, 0, check.stderr);
});

test("release supports fragment-only and legacy-only notes", (t) => {
  const tree = checkout(t);
  tree.write("a.md", "- A fragment.\n");
  const release = tree.run("release", "0.3.0", "2026-11-19");
  assert.equal(release.status, 0, release.stderr);
  assert.equal(tree.read(), prefix + "## 0.3.0 (2026-11-19)\n\n- A fragment.\n\n" + previous);
  assert.deepEqual(readdirSync(tree.dir), []);

  const crlf = (text) => text.replaceAll("\n", "\r\n");
  const legacy = "- A fix recorded in an open pull request.\n\n";
  const legacyTree = checkout(t, crlf(prefix + legacy + previous));
  const legacyRelease = legacyTree.run("release", "0.2.1", "2026-11-19");
  assert.equal(legacyRelease.status, 0, legacyRelease.stderr);
  assert.equal(legacyTree.read(), crlf(prefix + "## 0.2.1 (2026-11-19)\n\n" + legacy + previous));
});

test("check and release reject malformed fragments without changing either file", (t) => {
  const tree = checkout(t);
  tree.write("a-valid.md", "- Preserve this entry.\n");
  for (const text of [
    "",
    "- \n",
    "- ---\n",
    "### Fixed\n- A fix.\n",
    "- One.\n- Two.\n",
    "- One.\n ## A heading outside the list.\n",
    "- One.\n\n  Broken continuation.\n",
    "- One.\r- Two.\n",
    Buffer.from([45, 32, 255]),
  ]) {
    tree.write("bad.md", text);
    for (const args of [["--check"], ["release", "0.3.0", "2026-11-19"]]) {
      const rejected = tree.run(...args);
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.match(rejected.stderr, /changelog\.d\/bad\.md:/);
    }
    assert.equal(tree.read(), prefix + previous);
    assert.equal(readFileSync(join(tree.dir, "a-valid.md"), "utf8"), "- Preserve this entry.\n");
    assert.deepEqual(readFileSync(join(tree.dir, "bad.md")), Buffer.from(text));
  }
});

test("check rejects stray filenames and directories", (t) => {
  const stray = checkout(t);
  stray.write("Not-a-fragment.txt", "- A note.\n");
  const wrongName = stray.run("--check");
  assert.equal(wrongName.status, 1, wrongName.stderr);
  assert.match(wrongName.stderr, /changelog\.d\/Not-a-fragment\.txt:/);

  const subdir = checkout(t);
  mkdirSync(join(subdir.dir, "subdir.md"), { recursive: true });
  const wrongType = subdir.run("--check");
  assert.equal(wrongType.status, 1, wrongType.stderr);
  assert.match(wrongType.stderr, /changelog\.d\/subdir\.md:/);
});

test("release refuses an empty, duplicate, malformed or misdated release", (t) => {
  const empty = checkout(t);
  const noNotes = empty.run("release", "0.3.0", "2026-11-19");
  assert.equal(noNotes.status, 1, noNotes.stderr);
  assert.match(noNotes.stderr, /no unreleased changelog entries/);
  assert.equal(empty.read(), prefix + previous);

  const tree = checkout(t);
  tree.write("a.md", "- A fix.\n");
  for (const [version, date, error] of [
    ["0.2.0", "2026-11-19", /already has a section/],
    ["v0.3.0", "2026-11-19", /usage:/],
    ["0.3.0", "2026-02-30", /usage:/],
  ]) {
    const rejected = tree.run("release", version, date);
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, error);
    assert.equal(tree.read(), prefix + previous);
    assert.deepEqual(readdirSync(tree.dir), ["a.md"]);
  }

  const invalid = checkout(t, previous + "\n## Unreleased\n");
  invalid.write("a.md", "- A fix.\n");
  const badHeading = invalid.run("release", "0.3.0", "2026-11-19");
  assert.equal(badHeading.status, 1, badHeading.stderr);
  assert.match(badHeading.stderr, /Unreleased.*heading/);
  assert.equal(invalid.read(), previous + "\n## Unreleased\n");
  assert.deepEqual(readdirSync(invalid.dir), ["a.md"]);
});
