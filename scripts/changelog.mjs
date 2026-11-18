// Check pending entries without changing the tree, or cut them into CHANGELOG.md for a release.
import { lstatSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function readFragments(dir) {
  const directory = lstatSync(dir, { throwIfNoEntry: false });
  if (!directory) return [];
  if (!directory.isDirectory()) throw new Error("changelog.d must be a directory");

  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const files = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return files.map((file) => {
    const label = `changelog.d/${file.name}`;
    if (!file.isFile() || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(file.name)) {
      throw new Error(`${label}: expected a Markdown file named with lowercase letters, digits and hyphens`);
    }
    const path = join(dir, file.name);
    let text;
    try {
      text = decoder.decode(readFileSync(path)).replace(/\r?\n$/, "");
    } catch (error) {
      throw new Error(`${label}: ${error.message}`);
    }
    const [first, ...rest] = text.split(/\r?\n/);
    if (!/^- \S/.test(first) || /^-(?:[ \t]*-){2,}[ \t]*$/.test(first) ||
      [first, ...rest].some((line) => /[\0\r]/.test(line)) ||
      rest.some((line) => !/^ {2,}\S/.test(line))) {
      throw new Error(`${label}: expected one '- ' bullet with continuation lines indented by at least two spaces`);
    }
    return { path, lines: [first, ...rest] };
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
  const legacy = changelog.slice(unreleased.index + unreleased[0].length, previous?.index);
  if (!fragments.length && !legacy.trim()) throw new Error("no unreleased changelog entries");

  const gap = eol.repeat(2);
  const added = fragments.map(({ lines }) => lines.join(eol)).join(gap);
  // Prepend new bullets, leaving legacy entries and published sections in their original order.
  const notes = added ? eol + added + gap + (legacy.trim() ? legacy.replace(/^\r?\n/, "") : "") : legacy;
  return (
    changelog.slice(0, unreleased.index) +
    `## Unreleased${gap}## ${version} (${date})${eol}` +
    notes +
    (previous ? changelog.slice(previous.index) : "")
  );
}

try {
  const [command, version, date, ...extra] = process.argv.slice(2);
  const check = command === "--check" && version === undefined;
  const day = new Date(`${date}T00:00:00Z`);
  if (!check && (
    command !== "release" || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){2}$/.test(version) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(day.getTime()) ||
    day.toISOString().slice(0, 10) !== date || extra.length
  )) {
    throw new Error("usage: node scripts/changelog.mjs --check | release X.Y.Z YYYY-MM-DD");
  }
  const root = fileURLToPath(new URL("..", import.meta.url));
  const fragments = readFragments(join(root, "changelog.d"));
  if (!check) {
    const path = join(root, "CHANGELOG.md");
    writeFileSync(path, render(readFileSync(path, "utf8"), fragments, version, date));
    for (const fragment of fragments) unlinkSync(fragment.path);
  }
  console.log(`changelog: ${fragments.length} fragment(s) ${check ? "valid" : `released in ${version}`}`);
} catch (error) {
  console.error(`changelog: ${error.message}`);
  process.exitCode = 1;
}
