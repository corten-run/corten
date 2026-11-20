import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const prefix = "# Changelog\n\n## Unreleased\n\n";
const pointer = "Pending entries are in [changelog.d/](changelog.d/).\n\n";
const previous = "## 0.2.0 (2026-11-11)\n\n- A published entry.\n";
const archiveIndex = (...versions) => "## Release archive\n\n" +
  versions.map((v) => `- [${v}](CHANGELOG.${v}.md)\n`).join("");

function checkout(t, changelog = prefix + previous) {
  const root = mkdtempSync(join(tmpdir(), "corten-changelog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, "scripts", "changelog.mjs");
  mkdirSync(join(root, "scripts"));
  copyFileSync(new URL("./changelog.mjs", import.meta.url), script);
  const file = join(root, "CHANGELOG.md");
  const dir = join(root, "changelog.d");
  writeFileSync(file, changelog);
  const run = (args, nodeArgs = []) => {
    const result = spawnSync(process.execPath, [...nodeArgs, script, ...args], { cwd: root, encoding: "utf8" });
    if (result.error) throw result.error;
    return result;
  };
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
    run: (...args) => run(args),
    runWithImport: (source, ...args) => run(args, ["--import", "data:text/javascript," + encodeURIComponent(source)]),
    read: () => readFileSync(file, "utf8"),
    readArchive: (version) => readFileSync(join(root, `CHANGELOG.${version}.md`)),
    writeArchive: (version, bytes) => writeFileSync(join(root, `CHANGELOG.${version}.md`), bytes),
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
    legacy + archiveIndex("0.2.0"));
  assert.deepEqual(tree.readArchive("0.2.0"), Buffer.from(previous));
  assert.deepEqual(readdirSync(tree.dir), ["README.md"]);
  const check = tree.run("--check");
  assert.equal(check.status, 0, check.stderr);
});

test("release supports fragment-only and legacy-only notes", (t) => {
  const tree = checkout(t);
  tree.write("pr-12-1.md", "-  A fragment.\n");
  const release = tree.run("release", "0.3.0", "2026-11-19");
  assert.equal(release.status, 0, release.stderr);
  assert.equal(tree.read(), prefix + "## 0.3.0 (2026-11-19)\n\n-  A fragment.\n\n" + archiveIndex("0.2.0"));
  assert.deepEqual(readdirSync(tree.dir), []);

  const crlf = (text) => text.replaceAll("\n", "\r\n");
  const legacy = "- A fix recorded in an open pull request.\n\n";
  const legacyTree = checkout(t, crlf(prefix + pointer + legacy + previous));
  const legacyRelease = legacyTree.run("release", "0.2.1", "2026-11-19");
  assert.equal(legacyRelease.status, 0, legacyRelease.stderr);
  assert.equal(legacyTree.read(), crlf(prefix + pointer + "## 0.2.1 (2026-11-19)\n\n" + legacy + archiveIndex("0.2.0")));
  assert.deepEqual(legacyTree.readArchive("0.2.0"), Buffer.from(crlf(previous)));
});

test("release moves existing sections byte-for-byte and keeps earlier archive links", (t) => {
  const newest = "## 0.2.0 (2026-11-11)\n\n### Added\n\n- Café: [guide](docs/guide/kit.md).  \n\n";
  const older = "## 0.1.0 (not tagged)\r\n\r\n- No final newline.";
  const tree = checkout(t, prefix + pointer + newest + older);
  tree.write("pr-12-1.md", "- A new release.\n");
  const first = tree.run("release", "0.3.0", "2026-11-19");
  assert.equal(first.status, 0, first.stderr);
  const movedNewest = tree.readArchive("0.2.0");
  const movedOlder = tree.readArchive("0.1.0");
  assert.deepEqual(Buffer.concat([movedNewest, movedOlder]), Buffer.from(newest + older));
  const issued = "## 0.3.0 (2026-11-19)\n\n- A new release.\n\n";
  assert.equal(tree.read(), prefix + pointer + issued + archiveIndex("0.2.0", "0.1.0"));

  tree.write("pr-13-1.md", "- A patch release.\n");
  const second = tree.run("release", "0.3.1", "2026-11-20");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(tree.read(), prefix + pointer + "## 0.3.1 (2026-11-20)\n\n- A patch release.\n\n" +
    archiveIndex("0.3.0", "0.2.0", "0.1.0"));
  assert.deepEqual(tree.readArchive("0.3.0"), Buffer.from(issued));
  assert.deepEqual(tree.readArchive("0.2.0"), movedNewest);
  assert.deepEqual(tree.readArchive("0.1.0"), movedOlder);
  assert.equal(tree.run("--check-release").status, 0);
});

test("release retries after writing an archive but failing to write the index", (t) => {
  const tree = checkout(t);
  const note = "- Keep this pending entry.\n";
  tree.write("pr-12-1.md", note);
  const args = ["release", "0.3.0", "2026-11-19"];
  const withBlockedWrite = (name) => tree.runWithImport(`
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { basename } from "node:path";
    const write = fs.writeFileSync;
    fs.writeFileSync = (path, ...args) => {
      if (basename(path) === ${JSON.stringify(name)}) throw new Error("injected write failure: " + basename(path));
      return write(path, ...args);
    };
    syncBuiltinESMExports();
  `, ...args);
  const failed = withBlockedWrite("CHANGELOG.md");
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /injected write failure: CHANGELOG\.md/);
  assert.deepEqual(tree.readArchive("0.2.0"), Buffer.from(previous));
  assert.equal(tree.read(), prefix + previous);
  assert.equal(readFileSync(join(tree.dir, "pr-12-1.md"), "utf8"), note);

  const retried = withBlockedWrite("CHANGELOG.0.2.0.md");
  assert.equal(retried.status, 0, retried.stderr);
  assert.deepEqual(tree.readArchive("0.2.0"), Buffer.from(previous));
  assert.equal(tree.read(), prefix + "## 0.3.0 (2026-11-19)\n\n" + note + "\n" + archiveIndex("0.2.0"));
  assert.deepEqual(readdirSync(tree.dir), []);
  assert.equal(tree.run("--check-release").status, 0);
});

test("release does not overwrite an archive or reuse its version", (t) => {
  const note = "- Keep this pending entry.\n";
  for (const [version, error] of [
    ["0.2.0", /CHANGELOG\.0\.2\.0\.md already exists and differs/],
    ["0.3.0", /CHANGELOG\.0\.3\.0\.md already exists; refusing to reuse/],
  ]) {
    const tree = checkout(t);
    tree.write("pr-12-1.md", note);
    const bytes = Buffer.from(previous.replace("\n", "\r\n"));
    tree.writeArchive(version, bytes);
    const result = tree.run("release", "0.3.0", "2026-11-19");
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
    assert.deepEqual(tree.readArchive(version), bytes);
    assert.equal(tree.read(), prefix + previous);
    assert.equal(readFileSync(join(tree.dir, "pr-12-1.md"), "utf8"), note);
  }
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

  tree.writeChangelog(prefix + late + pointer + archiveIndex("0.2.0"));
  tree.write("pr-12-1.md", note);
  const recut = tree.run("release", "0.3.0", "2026-11-19");
  assert.equal(recut.status, 0, recut.stderr);
  assert.equal(tree.read(), prefix + pointer + "## 0.3.0 (2026-11-19)\n\n" + note + "\n" + late + archiveIndex("0.2.0"));
  assert.deepEqual(tree.readArchive("0.2.0"), Buffer.from(previous));
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
  assert.equal(tree.read(), prefix + "## 0.3.0 (2026-11-19)\n\n" + links + "\n" + archiveIndex("0.2.0"));
});

test("the visible length cap applies only to branch fragments and PRs after the cutoff", (t) => {
  const tree = checkout(t);
  const note = (length) => "- " + "x".repeat(length) + "\n";
  tree.write("pr-1730-1.md", note(401));
  tree.write("pr-1736-2.md", note(401));
  tree.write("pr-1737-1.md", note(400));
  const accepted = tree.run("--check");
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /3 fragment\(s\) valid/);

  for (const name of ["pr-1737-1.md", "branch-next-1.md"]) {
    tree.write(name, note(401));
    const rejected = tree.run("--check");
    assert.equal(rejected.status, 1);
    assert.ok(rejected.stderr.includes(name + ": 401 visible characters"), rejected.stderr);
    tree.write(name, note(400));
  }

  const released = tree.run("release", "0.3.0", "2026-11-19");
  assert.equal(released.status, 0, released.stderr);
  assert.match(released.stdout, /4 fragment\(s\) released/);
});

test("check caps visible text at 400 Unicode code points, not Markdown link destinations", (t) => {
  const tree = checkout(t);
  const name = "pr-1737-1.md";
  const path = "https://example.com/" + "x".repeat(500);
  const note = "-    " + "\u{1F600}".repeat(389) + "  \r\n     [link](" + path + ") and ` x `";
  tree.write(name, note + "\r\n");
  assert.equal(tree.run("--check").status, 0); // 389 + wrap + 'link and x'.
  tree.write(name, note + ".");
  for (const args of [["--check"], ["release", "0.3.0", "2026-11-19"]]) {
    const result = tree.run(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pr-1737-1\.md: 401 visible characters.*400-character limit/);
  }
  assert.equal(tree.read(), prefix + previous);

  tree.write(name, "- `[link](" + path + ")`");
  const literal = tree.run("--check");
  assert.equal(literal.status, 1, "a URL printed inside a code span is visible");
  assert.match(literal.stderr, /visible characters.*400-character limit/);
});

test("check counts a nonbreaking space after Markdown indentation", (t) => {
  const tree = checkout(t);
  const name = "pr-1737-1.md";
  const note = (n) => "- " + "x".repeat(n) + "\n  \u00A0y\n";
  tree.write(name, note(397));
  assert.equal(tree.run("--check").status, 0);
  tree.write(name, note(398));
  const rejected = tree.run("--check");
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /pr-1737-1\.md: 401 visible characters.*400-character limit/);
});

test("check counts every space in an all-space code span", (t) => {
  const tree = checkout(t);
  const name = "pr-1737-1.md";
  const note = (n) => "- " + "x".repeat(n) + " `   `\n";
  tree.write(name, note(396));
  const accepted = tree.run("--check");
  assert.equal(accepted.status, 0, accepted.stderr);
  tree.write(name, note(397));
  const rejected = tree.run("--check");
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /pr-1737-1\.md: 401 visible characters.*400-character limit/);
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
    "- A paragraph.\n  - A nested bullet.\n",
    "- # A heading instead of prose.\n",
    "- | Guide |\n  | --- |\n  | `[kit](../docs/guide/kit.md) | ` |\n",
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
