import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const prefix = "# Changelog\n\n## Unreleased\n\n";
const pointer = "Pending entries are in [changelog.d/](changelog.d/).\n\n";
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
    copyReadme: () => {
      mkdirSync(dir, { recursive: true });
      copyFileSync(new URL("../changelog.d/README.md", import.meta.url), join(dir, "README.md"));
    },
    run: (...args) => {
      const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
      if (result.error) throw result.error;
      return result;
    },
    read: () => readFileSync(file, "utf8"),
    writeChangelog: (text) => writeFileSync(file, text),
  };
}

test("check accepts absent and valid fragments without editing files", (t) => {
  const tree = checkout(t);
  const empty = tree.run("--check");
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /0 fragment\(s\) valid/);
  assert.equal(tree.run("--check-release").status, 0, "older patch tags may have no fragment directory");

  const note = "-    A wrapped entry.\r\n     More detail.\r\n";
  tree.write("pr-1612-1.md", note);
  const valid = tree.run("--check");
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /1 fragment\(s\) valid/);
  assert.equal(readFileSync(join(tree.dir, "pr-1612-1.md"), "utf8"), note);
  assert.equal(tree.read(), prefix + previous);
});

test("separate PRs for one issue and entries within one PR have distinct paths", (t) => {
  const tree = checkout(t);
  tree.write("pr-1612-1.md", "- One change for issue 1611.\n");
  tree.write("pr-1613-1.md", "- Another change for issue 1611.\n");
  tree.write("pr-1613-2.md", "- A second note in the same PR.\n");
  tree.write("branch-my-release-notes-1.md", "- A change whose PR is not open yet.\n");
  tree.write("branch-their-release-notes-1.md", "- Another PR that is not open yet.\n");
  const check = tree.run("--check");
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /5 fragment\(s\) valid/);
});

test("release renders Breaking first in filename order within each group, then unchanged legacy notes", (t) => {
  const actual = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  assert.ok(actual.includes("## Unreleased\n\n" + pointer));
  const legacy = "- An inline note.\n\n- **Breaking:** A legacy change.\n\n### Added\n\n- A categorized note.\n  More detail.\n\n";
  const tree = checkout(t, prefix + pointer + legacy + previous);
  tree.copyReadme();
  tree.write("pr-9-1.md", "- A documentation note.\n");
  tree.write("pr-9-2.md", "- **Breaking:** Remove the old API.\n");
  tree.write("pr-10-1.md", "- A fix with no trailing newline.");
  tree.write("pr-10-2.md", "-  **Breaking:** Change the API.\r\n   Explain how to upgrade.\r\n");
  tree.write("pr-10-3.md", "- Show the literal `**Breaking:**` marker.\n");
  tree.write("pr-10-4.md", "- Document migration.\n  **Breaking:** is the label.\n");

  const released = tree.run("release", "0.3.0", "2026-11-19");
  assert.equal(released.status, 0, released.stderr);
  assert.match(released.stdout, /6 fragment\(s\) released in 0\.3\.0/);
  assert.equal(tree.read(), prefix + pointer + "## 0.3.0 (2026-11-19)\n\n" +
    "-  **Breaking:** Change the API.\n   Explain how to upgrade.\n\n" +
    "- **Breaking:** Remove the old API.\n\n" +
    "- A fix with no trailing newline.\n\n" +
    "- Show the literal `**Breaking:**` marker.\n\n" +
    "- Document migration.\n  **Breaking:** is the label.\n\n" +
    "- A documentation note.\n\n" +
    legacy + previous);
  assert.deepEqual(readdirSync(tree.dir), ["README.md"]);
  const check = tree.run("--check");
  assert.equal(check.status, 0, check.stderr);
});

test("release supports fragment-only and legacy-only notes", (t) => {
  const tree = checkout(t);
  tree.write("pr-12-1.md", "-  A fragment.\n");
  const release = tree.run("release", "0.3.0", "2026-11-19");
  assert.equal(release.status, 0, release.stderr);
  assert.equal(tree.read(), prefix + "## 0.3.0 (2026-11-19)\n\n-  A fragment.\n\n" + previous);
  assert.deepEqual(readdirSync(tree.dir), []);

  const crlf = (text) => text.replaceAll("\n", "\r\n");
  const legacy = "- A fix recorded in an open pull request.\n\n";
  const legacyTree = checkout(t, crlf(prefix + pointer + legacy + previous));
  const legacyRelease = legacyTree.run("release", "0.2.1", "2026-11-19");
  assert.equal(legacyRelease.status, 0, legacyRelease.stderr);
  assert.equal(legacyTree.read(), crlf(prefix + pointer + "## 0.2.1 (2026-11-19)\n\n" + legacy + previous));
});

test("a release candidate fails if a fragment arrives after preparation", (t) => {
  const tree = checkout(t, prefix + pointer + previous);
  tree.copyReadme();
  tree.write("pr-12-1.md", "- A prepared fragment.\n");
  assert.equal(tree.run("release", "0.3.0", "2026-11-19").status, 0);
  const clean = tree.run("--check-release");
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /no pending fragments/);

  const prepared = tree.read();
  tree.write("pr-13-1.md", "- A late fragment.\n");
  assert.equal(tree.run("--check").status, 0, "pending notes are valid in normal CI");
  const blocked = tree.run("--check-release");
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /pending fragments.*pr-13-1\.md/);
  assert.equal(tree.read(), prepared);
  assert.deepEqual(readdirSync(tree.dir).sort(), ["README.md", "pr-13-1.md"]);
});

test("a late inline note blocks the tag gate and a new cut keeps the pointer out of the release", (t) => {
  const tree = checkout(t, prefix + pointer + previous);
  tree.copyReadme();
  const note = "- A prepared fragment.\n";
  tree.write("pr-12-1.md", note);
  assert.equal(tree.run("release", "0.3.0", "2026-11-19").status, 0);
  const prepared = tree.read();
  const late = "- A late inline note from an older pull request.\n\n";
  for (const candidate of [
    prepared.replace(prefix, prefix + late),
    prepared.replace(pointer, pointer + late),
    prepared.replace(pointer, late),
  ]) {
    tree.writeChangelog(candidate);
    assert.equal(tree.run("--check").status, 0, "legacy notes can still land in normal CI");
    const blocked = tree.run("--check-release");
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /inline Unreleased entries.*updated base/);
    assert.equal(tree.read(), candidate, "the tag gate does not consume notes or the pointer");
  }

  tree.writeChangelog(prefix + late + pointer + previous);
  tree.write("pr-12-1.md", note);
  const recut = tree.run("release", "0.3.0", "2026-11-19");
  assert.equal(recut.status, 0, recut.stderr);
  assert.equal(tree.read(), prefix + pointer + "## 0.3.0 (2026-11-19)\n\n" + note + "\n" + late + previous);
  assert.equal(tree.run("--check-release").status, 0);
  assert.deepEqual(readdirSync(tree.dir), ["README.md"]);
});

test("single-line absolute HTTPS links survive release unchanged", (t) => {
  const tree = checkout(t);
  const links = "- See the [kit guide](https://github.com/corten-run/corten/blob/main/docs/guide/kit.md).\n" +
    "  Read [more](https://corten.run/) or type ``[an example](./kit.md) and `x` ``.\n";
  tree.write("pr-12-1.md", links);
  const check = tree.run("--check");
  assert.equal(check.status, 0, check.stderr);
  const released = tree.run("release", "0.3.0", "2026-11-19");
  assert.equal(released.status, 0, released.stderr);
  assert.equal(tree.read(), prefix + "## 0.3.0 (2026-11-19)\n\n" + links + "\n" + previous);
});

test("check rejects unsupported link forms, including links split across lines", (t) => {
  const tree = checkout(t);
  for (const text of [
    "- See [the guide](docs/guide/kit.md).",
    "- See [the guide](../docs/guide/kit.md).",
    "- See [the guide](/docs/guide/kit.md).",
    "- See [this section](#kit).",
    "- See [the guide](http://example.com).",
    "- See [the guide](//example.com).",
    "- See [the guide](https:///example.com).",
    "- See [the guide](https://).",
    "- See [the guide](https://example.com \"title\").",
    "- See [the guide](<https://example.com>).",
    "- See [the guide](https://example.com/foo(bar)).",
    "- See [the guide]().",
    "- See [the guide](\n  ../docs/guide/kit.md).",
    "- See [the guide](\n  https://example.com).",
    "- See [the\n  guide](https://example.com).",
    "- See [the guide]\n  (https://example.com).",
    "- See [the guide][ref].\n  [ref]: https://example.com",
    "- See <https://example.com>.",
    "- See https://example.com or www.example.com.",
    "- Email me@example.com.",
    "- Contact xmpp:me@server_name.example.",
    "- See <a href=\"../docs/guide/kit.md\">the guide</a>.",
    "- See ![the guide](https://example.com).",
  ]) {
    tree.write("pr-12-1.md", text);
    const rejected = tree.run("--check");
    assert.equal(rejected.status, 1, text);
    assert.match(rejected.stderr, /changelog\.d\/pr-12-1\.md:.*\[label\]\(https:\/\//);
  }
});

test("check and release reject malformed fragments without changing either file", (t) => {
  const tree = checkout(t);
  tree.write("pr-12-1.md", "- Preserve this entry.\n");
  for (const text of [
    "",
    "- \n",
    "- ---\n",
    "- <!-- No visible note. -->\n",
    "- <!-- No visible\n  note. -->\n",
    "- [guide]: https://corten.run/\n",
    "- [&#32;](https://corten.run/)\n",
    "- ` `\n",
    "- A paragraph.\n  - A nested bullet.\n",
    "- # A heading instead of prose.\n",
    "-     This is an indented code block, not note text.\n",
    "-  One.\n  ## Outside the bullet.\n",
    "### Fixed\n- A fix.\n",
    "- One.\n- Two.\n",
    "- One.\n ## A heading outside the list.\n",
    "- One.\n\n  Broken continuation.\n",
    "- One.\n  \n  Broken continuation.\n",
    "- One.\r- Two.\n",
    Buffer.from([45, 32, 255]),
  ]) {
    tree.write("pr-13-1.md", text);
    for (const args of [["--check"], ["release", "0.3.0", "2026-11-19"]]) {
      const rejected = tree.run(...args);
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.match(rejected.stderr, /changelog\.d\/pr-13-1\.md:/);
    }
    assert.equal(tree.read(), prefix + previous);
    assert.equal(readFileSync(join(tree.dir, "pr-12-1.md"), "utf8"), "- Preserve this entry.\n");
    assert.deepEqual(readFileSync(join(tree.dir, "pr-13-1.md")), Buffer.from(text));
  }
});

test("check rejects stray filenames and directories", (t) => {
  const stray = checkout(t);
  stray.write("Not-a-fragment.txt", "- A note.\n");
  const wrongName = stray.run("--check");
  assert.equal(wrongName.status, 1, wrongName.stderr);
  assert.match(wrongName.stderr, /changelog\.d\/Not-a-fragment\.txt:/);

  const issueNumber = checkout(t);
  issueNumber.write("1611.md", "- Two PRs for one issue would share this name.\n");
  const shared = issueNumber.run("--check");
  assert.equal(shared.status, 1);
  assert.match(shared.stderr, /changelog\.d\/1611\.md:/);

  const subdir = checkout(t);
  mkdirSync(join(subdir.dir, "pr-12-1.md"), { recursive: true });
  const wrongType = subdir.run("--check");
  assert.equal(wrongType.status, 1, wrongType.stderr);
  assert.match(wrongType.stderr, /changelog\.d\/pr-12-1\.md:/);
});

test("release refuses an empty, duplicate, malformed or misdated release", (t) => {
  const empty = checkout(t, prefix + pointer + previous);
  const noNotes = empty.run("release", "0.3.0", "2026-11-19");
  assert.equal(noNotes.status, 1, noNotes.stderr);
  assert.match(noNotes.stderr, /no unreleased changelog entries/);
  assert.equal(empty.read(), prefix + pointer + previous);

  const tree = checkout(t);
  tree.write("pr-12-1.md", "- A fix.\n");
  for (const [version, date, error] of [
    ["0.2.0", "2026-11-19", /already has a section/],
    ["v0.3.0", "2026-11-19", /usage:/],
    ["0.3.0", "2026-02-30", /usage:/],
  ]) {
    const rejected = tree.run("release", version, date);
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, error);
    assert.equal(tree.read(), prefix + previous);
    assert.deepEqual(readdirSync(tree.dir), ["pr-12-1.md"]);
  }

  const invalid = checkout(t, previous + "\n## Unreleased\n");
  invalid.write("pr-12-1.md", "- A fix.\n");
  const badHeading = invalid.run("release", "0.3.0", "2026-11-19");
  assert.equal(badHeading.status, 1, badHeading.stderr);
  assert.match(badHeading.stderr, /Unreleased.*heading/);
  assert.equal(invalid.read(), previous + "\n## Unreleased\n");
  assert.deepEqual(readdirSync(invalid.dir), ["pr-12-1.md"]);
});
