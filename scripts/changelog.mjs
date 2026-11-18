// Check pending entries without changing the tree, or cut them into CHANGELOG.md for a release.
import { lstatSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pendingPointer = "Pending entries are in [changelog.d/](changelog.d/).";

// A fragment is one paragraph, not arbitrary Markdown. Mask supported inline forms before
// checking for anything that could introduce a different kind of link or a block.
const codeSpan = /(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/g;
const inlineLink = /\[([^[\]<>\\\0]+)\]\((https:\/\/[^\s<>()\\[\]\0"']+)\)/g;
const bareLink = /(?:https?:\/\/|ftp:\/\/|www\.|[a-z\d_.+-]@[a-z\d_.-]+\.[a-z\d_-]*[a-z\d])/i;
const entity = /&(?:#(?:x[\da-f]+|\d+)|[a-z][a-z\d]*);/i;

function checkProse(lines, label) {
  for (const line of lines) {
    const prose = line.replace(codeSpan, (span, ticks) => span.slice(ticks.length, -ticks.length).trim() ? "\0" : span)
      .replace(inlineLink, (link, text, url, offset, source) =>
        source[offset - 1] !== "!" && text.trim() && !bareLink.test(text) && !entity.test(text) &&
        !/^https:\/\/[/?#]/.test(url) && !entity.test(url) && URL.canParse(url) ? "\0" : link);
    if (/[<>[\]\\`]/.test(prose) || bareLink.test(prose) || entity.test(prose)) {
      throw new Error(`${label}: use only single-line [label](https://host/path) links; put literal Markdown syntax in code spans`);
    }
    if (/^(?:#{1,6}(?: |$)|[-+*](?: |$)|\d{1,9}[.)](?: |$)|~{3,})/.test(prose) ||
      /^(?:=+|(?:[-*_] *){3,}|\|? *:?-+:? *(?:\| *:?-+:? *)*\|?)$/.test(prose.trimEnd())) {
      throw new Error(`${label}: expected one paragraph of note text, not nested Markdown blocks`);
    }
  }
}

function readFragments(dir) {
  const directory = lstatSync(dir, { throwIfNoEntry: false });
  if (!directory) return [];
  if (!directory.isDirectory()) throw new Error("changelog.d must be a directory");

  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((file) => file.name !== "README.md" || !file.isFile())
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return files.map((file) => {
    const label = `changelog.d/${file.name}`;
    if (!file.isFile() || !/^(?:pr-[1-9]\d*|branch-[a-z0-9]+(?:-[a-z0-9]+)*)-[1-9]\d*\.md$/.test(file.name)) {
      throw new Error(`${label}: expected a file named pr-<number>-<entry>.md or branch-<unique-slug>-<entry>.md`);
    }
    const path = join(dir, file.name);
    let text;
    try {
      text = decoder.decode(readFileSync(path)).replace(/\r?\n$/, "");
    } catch (error) {
      throw new Error(`${label}: ${error.message}`);
    }
    const [first, ...rest] = text.split(/\r?\n/);
    const bullet = /^-( {1,4})(\S.*)$/.exec(first);
    const indent = " ".repeat(bullet ? 1 + bullet[1].length : 0);
    if (!bullet || /^-(?: *-){2,} *$/.test(first) ||
      [first, ...rest].some((line) => /[\x00-\x1f\x7f]/.test(line)) ||
      rest.some((line) => !line.startsWith(indent) || !line.trim())) {
      throw new Error(`${label}: expected one '- ' bullet with visible text and space-indented continuation lines, with no blank lines`);
    }
    checkProse([bullet[2], ...rest.map((line) => line.trimStart())], label);
    return { label, path, lines: [first, ...rest], breaking: bullet[2].startsWith("**Breaking:** ") };
  });
}

function unreleasedSection(changelog) {
  const headings = [...changelog.matchAll(/^## ([^\r\n]+)(\r?\n|$)/gm)];
  const [unreleased, previous] = headings;
  const older = headings.slice(1);
  if (unreleased?.[1] !== "Unreleased" || older.some((h) => h[1] === "Unreleased")) {
    throw new Error("CHANGELOG.md must start its release sections with one '## Unreleased' heading");
  }
  const body = changelog.slice(unreleased.index + unreleased[0].length, previous?.index);
  const pointers = [...body.matchAll(/^([^\r\n]+)(?:\r?\n|$)/gm)].filter((line) => line[1] === pendingPointer);
  if (pointers.length > 1) throw new Error("CHANGELOG.md has more than one pending-notes link under Unreleased");
  const [pointer] = pointers;
  // A merge can put an old-style note above the pointer. Keep the pointer under Unreleased
  // instead of treating it as a legacy note just because it is no longer first.
  const legacy = pointer
    ? body.slice(0, pointer.index) + body.slice(pointer.index + pointer[0].length).replace(/^\r?\n/, "")
    : body;
  return { unreleased, previous, older, legacy, hasPointer: Boolean(pointer) };
}

function render(changelog, fragments, version, date) {
  const { unreleased, previous, older, legacy, hasPointer } = unreleasedSection(changelog);
  if (older.some((h) => h[1] === version || h[1].startsWith(`${version} `))) {
    throw new Error(`CHANGELOG.md already has a section for ${version}`);
  }

  const eol = unreleased[2] || "\n";
  const gap = eol.repeat(2);
  const pointer = eol + pendingPointer + gap;
  if (!fragments.length && !legacy.trim()) throw new Error("no unreleased changelog entries");

  const ordered = [...fragments.filter(({ breaking }) => breaking), ...fragments.filter(({ breaking }) => !breaking)];
  const added = ordered.map(({ lines }) => lines.join(eol)).join(gap);
  // Prepend new bullets, leaving legacy entries and published sections in their original order.
  const notes = added ? eol + added + gap + (legacy.trim() ? legacy.replace(/^\r?\n/, "") : "") : legacy;
  return (
    changelog.slice(0, unreleased.index) +
    `## Unreleased${eol}${hasPointer ? pointer : eol}## ${version} (${date})${eol}` +
    notes +
    (previous ? changelog.slice(previous.index) : "")
  );
}

try {
  const [command, version, date, ...extra] = process.argv.slice(2);
  const check = command === "--check" && version === undefined;
  const checkRelease = command === "--check-release" && version === undefined;
  const day = new Date(`${date}T00:00:00Z`);
  if (!check && !checkRelease && (
    command !== "release" || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){2}$/.test(version) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(day.getTime()) ||
    day.toISOString().slice(0, 10) !== date || extra.length
  )) {
    throw new Error("usage: node scripts/changelog.mjs --check | --check-release | release X.Y.Z YYYY-MM-DD");
  }
  const root = fileURLToPath(new URL("..", import.meta.url));
  const fragments = readFragments(join(root, "changelog.d"));
  const path = join(root, "CHANGELOG.md");
  if (checkRelease) {
    if (fragments.length) {
      throw new Error(`pending fragments: ${fragments.map(({ label }) => label).join(", ")}; rerun release preparation from the updated base`);
    }
    if (unreleasedSection(readFileSync(path, "utf8")).legacy.trim()) {
      throw new Error("inline Unreleased entries remain in CHANGELOG.md; rerun release preparation from the updated base");
    }
    console.log("changelog: no pending fragments or inline Unreleased entries");
  } else if (check) {
    console.log(`changelog: ${fragments.length} fragment(s) valid`);
  } else {
    writeFileSync(path, render(readFileSync(path, "utf8"), fragments, version, date));
    for (const fragment of fragments) unlinkSync(fragment.path);
    console.log(`changelog: ${fragments.length} fragment(s) released in ${version}`);
  }
} catch (error) {
  console.error(`changelog: ${error.message}`);
  process.exitCode = 1;
}
