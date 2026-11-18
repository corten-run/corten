// Check pending entries without changing the tree, or cut them into CHANGELOG.md for a release.
import { lstatSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pendingPointer = "Pending entries are in [changelog.d/](changelog.d/).";

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
    if (!bullet || bullet[2].startsWith("<!--") || /^-(?:[ \t]*-){2,}[ \t]*$/.test(first) ||
      [first, ...rest].some((line) => /[\0\r]/.test(line)) ||
      rest.some((line) => !line.startsWith(indent) || !line.trim())) {
      throw new Error(`${label}: expected one '- ' bullet starting with visible text and indented continuation lines, with no blank lines`);
    }
    return { label, path, lines: [first, ...rest] };
  });
}

function render(changelog, fragments, version, date) {
  const headings = [...changelog.matchAll(/^## ([^\r\n]+)(\r?\n|$)/gm)];
  const [unreleased, previous] = headings;
  const older = headings.slice(1);
  if (unreleased?.[1] !== "Unreleased" || older.some((h) => h[1] === "Unreleased")) {
    throw new Error("CHANGELOG.md must start its release sections with one '## Unreleased' heading");
  }
  if (older.some((h) => h[1] === version || h[1].startsWith(`${version} `))) {
    throw new Error(`CHANGELOG.md already has a section for ${version}`);
  }

  const eol = unreleased[2] || "\n";
  const gap = eol.repeat(2);
  const body = changelog.slice(unreleased.index + unreleased[0].length, previous?.index);
  const pointer = eol + pendingPointer + gap;
  const hasPointer = body.startsWith(pointer);
  const legacy = hasPointer ? eol + body.slice(pointer.length) : body;
  if (!fragments.length && !legacy.trim()) throw new Error("no unreleased changelog entries");

  const breaking = ({ lines }) => lines.some((line) => line.includes("**Breaking:**"));
  const ordered = [...fragments.filter(breaking), ...fragments.filter((fragment) => !breaking(fragment))];
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
  if (checkRelease) {
    if (fragments.length) {
      throw new Error(`pending fragments: ${fragments.map(({ label }) => label).join(", ")}; rerun release preparation from the updated base`);
    }
    console.log("changelog: no pending fragments");
  } else if (check) {
    console.log(`changelog: ${fragments.length} fragment(s) valid`);
  } else {
    const path = join(root, "CHANGELOG.md");
    writeFileSync(path, render(readFileSync(path, "utf8"), fragments, version, date));
    for (const fragment of fragments) unlinkSync(fragment.path);
    console.log(`changelog: ${fragments.length} fragment(s) released in ${version}`);
  }
} catch (error) {
  console.error(`changelog: ${error.message}`);
  process.exitCode = 1;
}
