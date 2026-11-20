// Check pending entries without changing the tree, or cut them into CHANGELOG.md for a release.
import { lstatSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pendingPointer = "Pending entries are in [changelog.d/](changelog.d/).";
const archiveHeading = "Release archive";
const versionNumber = /(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}/;
const maxVisibleLength = 400;
const lastUncappedPr = 1736;

// A fragment is one paragraph, not arbitrary Markdown. Mask supported inline forms before
// checking for anything that could introduce a different kind of link or a block.
const codeSpan = /(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/g;
const inlineLink = /\[([^[\]<>\\\0]+)\]\((https:\/\/[^\s<>()\\[\]\0"']+)\)/g;
const bareLink = /(?:https?:\/\/|ftp:\/\/|www\.|[a-z\d_.+-]@[a-z\d_.-]+\.[a-z\d_-]*[a-z\d])/i;
const entity = /&(?:#(?:x[\da-f]+|\d+)|[a-z][a-z\d]*);/i;

export function visibleLength(lines, label) {
  let length = lines.length - 1; // A space between wrapped lines.
  for (const line of lines) {
    const prose = line.replace(/^[ \t]+| +$/g, "").replace(codeSpan, (span, ticks) => {
      const code = span.slice(ticks.length, -ticks.length);
      const unpadded = /^ .* $/.test(code) && /[^ ]/.test(code) ? code.slice(1, -1) : code;
      length += [...unpadded].length;
      return "\0";
    }).replace(inlineLink, (link, text, url, offset, source) => {
      if (source[offset - 1] === "!" || !text.trim() || bareLink.test(text) || entity.test(text) ||
        /^https:\/\/[/?#]/.test(url) || entity.test(url) || !URL.canParse(url)) return link;
      length += [...text].length;
      return "\0";
    });
    if (/[<>[\]\\`]/.test(prose) || bareLink.test(prose) || entity.test(prose)) {
      throw new Error(`${label}: use only single-line [label](https://host/path) links; put literal Markdown syntax in code spans`);
    }
    if (/^(?:#{1,6}(?: |$)|[-+*](?: |$)|\d{1,9}[.)](?: |$)|~{3,})/.test(prose) ||
      /^(?:=+|(?:[-*_] *){3,}|\|? *:?-+:? *(?:\| *:?-+:? *)*\|?)$/.test(prose)) {
      throw new Error(`${label}: expected one paragraph of note text, not nested Markdown blocks`);
    }
    length += [...prose.replaceAll("\0", "")].length;
  }
  return length;
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
    const name = /^(?:pr-([1-9]\d*)|branch-[a-z0-9]+(?:-[a-z0-9]+)*)-[1-9]\d*\.md$/.exec(file.name);
    if (!file.isFile() || !name) {
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
    const bullet = /^-( {1,4})([^ \t].*)$/.exec(first);
    const indent = " ".repeat(bullet ? 1 + bullet[1].length : 0);
    if (!bullet || /^-(?: *-){2,} *$/.test(first) ||
      [first, ...rest].some((line) => /[\x00-\x1f\x7f]/.test(line)) ||
      rest.some((line) => !line.startsWith(indent) || !/[^ \t]/.test(line))) {
      throw new Error(`${label}: expected one '- ' bullet with visible text and space-indented continuation lines, with no blank lines`);
    }
    const length = visibleLength([bullet[2], ...rest], label);
    if ((!name[1] || Number(name[1]) > lastUncappedPr) && length > maxVisibleLength) {
      throw new Error(`${label}: ${length} visible characters exceeds the ${maxVisibleLength}-character limit; keep the change and link, move details to the guide, PR or Choice`);
    }
    return { label, path, lines: [first, ...rest], breaking: bullet[2].startsWith("**Breaking:** ") };
  });
}

function unreleasedSection(changelog) {
  const headings = [...changelog.matchAll(/^## ([^\r\n]+)(\r?\n|$)/gm)];
  const [unreleased, next] = headings;
  const older = headings.slice(1);
  if (unreleased?.[1] !== "Unreleased" || older.some((h) => h[1] === "Unreleased")) {
    throw new Error("CHANGELOG.md must start its release sections with one '## Unreleased' heading");
  }
  const archive = older.at(-1)?.[1] === archiveHeading ? older.pop() : undefined;
  const body = changelog.slice(unreleased.index + unreleased[0].length, next?.index);
  const pointers = [...body.matchAll(/^([^\r\n]+)(?:\r?\n|$)/gm)].filter((line) => line[1] === pendingPointer);
  if (pointers.length > 1) throw new Error("CHANGELOG.md has more than one pending-notes link under Unreleased");
  const [pointer] = pointers;
  // A merge can put an old-style note above the pointer. Keep the pointer under Unreleased
  // instead of treating it as a legacy note just because it is no longer first.
  const legacy = pointer
    ? body.slice(0, pointer.index) + body.slice(pointer.index + pointer[0].length).replace(/^\r?\n/, "")
    : body;
  return { unreleased, archive, older, legacy, hasPointer: Boolean(pointer) };
}

function render(changelog, fragments, version, date) {
  const { unreleased, archive, older, legacy, hasPointer } = unreleasedSection(changelog);
  const eol = unreleased[2] || "\n";
  const gap = eol.repeat(2);
  const pointer = eol + pendingPointer + gap;
  const versions = new Set([version]);
  const archives = older.map((heading, i) => {
    const number = new RegExp(`^(${versionNumber.source})(?: |$)`).exec(heading[1])?.[1];
    if (!number) throw new Error(`CHANGELOG.md has an unexpected release heading: ${heading[1]}`);
    if (versions.has(number)) throw new Error(`CHANGELOG.md already has a section for ${number}`);
    versions.add(number);
    return {
      version: number,
      name: archiveName(number),
      content: changelog.slice(heading.index, (older[i + 1] ?? archive)?.index),
    };
  });
  if (!fragments.length && !legacy.trim()) throw new Error("no unreleased changelog entries");

  const ordered = [...fragments.filter(({ breaking }) => breaking), ...fragments.filter(({ breaking }) => !breaking)];
  const added = ordered.map(({ lines }) => lines.join(eol)).join(gap);
  // Prepend new bullets, leaving legacy entries in their original order.
  const notes = added ? eol + added + gap + (legacy.trim() ? legacy.replace(/^\r?\n/, "") : "") : legacy;
  const links = archives.map(({ version, name }) => `- [${version}](${name})${eol}`).join("");
  const oldLinks = archive ? changelog.slice(archive.index + archive[0].length).replace(/^\r?\n/, "") : "";
  const section = links || oldLinks ? `## ${archiveHeading}${gap}${links}${oldLinks}` : "";
  return { archives, updated:
    changelog.slice(0, unreleased.index) +
    `## Unreleased${eol}${hasPointer ? pointer : eol}## ${version} (${date})${eol}` +
    notes +
    (section && !notes.endsWith(gap) ? notes.endsWith(eol) ? eol : gap : "") + section,
  };
}

function archiveName(version) {
  // The release workflow uses CHANGELOG-*.md for attachments of oversized new notes.
  return `CHANGELOG.${version}.md`;
}

function main() {
  const [command, version, date, ...extra] = process.argv.slice(2);
  const check = command === "--check" && version === undefined;
  const checkRelease = command === "--check-release" && version === undefined;
  const day = new Date(`${date}T00:00:00Z`);
  if (!check && !checkRelease && (
    command !== "release" || !new RegExp(`^${versionNumber.source}$`).test(version) ||
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
    // Reject invalid UTF-8 rather than silently changing bytes when moving a published section.
    const changelog = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
    const { archives, updated } = render(changelog, fragments, version, date);
    const newArchive = archiveName(version);
    if (lstatSync(join(root, newArchive), { throwIfNoEntry: false })) {
      throw new Error(`${newArchive} already exists; refusing to reuse an archived release version`);
    }
    // A failed index write can leave a complete archive. Reuse its bytes without rewriting it.
    const missing = archives.filter(({ name, content }) => {
      const archivePath = join(root, name);
      const existing = lstatSync(archivePath, { throwIfNoEntry: false });
      if (!existing) return true;
      if (!existing.isFile() || !readFileSync(archivePath).equals(Buffer.from(content))) {
        throw new Error(`${name} already exists and differs from the archive to write; refusing to overwrite it`);
      }
      return false;
    });
    for (const { name, content } of missing) writeFileSync(join(root, name), content, { flag: "wx" });
    writeFileSync(path, updated);
    for (const fragment of fragments) unlinkSync(fragment.path);
    console.log(`changelog: ${fragments.length} fragment(s) released in ${version}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`changelog: ${error.message}`);
    process.exitCode = 1;
  }
}
