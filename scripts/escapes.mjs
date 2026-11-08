// Checks that the scripts Corten ships (the runtime, the kit, the template, the examples) have no
// `any` and no comment that turns the checker off: a value of unknown shape is `unknown` and is
// narrowed, or cast once where it enters with a comment saying what vouches for it
// (docs/design.md#choice-script-boundaries). `@ts-expect-error` belongs to the typing fixtures,
// which are not among these files. A JSDoc type is read from one line: one that spans lines is not
// checked. Run by npm run check.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The types a line names: in JSDoc tags of a script, or the code of a declaration file. @param {string} file @param {string} line */
const typesIn = (file, line) =>
  file.endsWith(".d.ts")
    ? [line.replace(/\/\*.*?(\*\/|$)|\/\/.*|^\s*\*.*/g, "")]
    : [...line.matchAll(/@(?:type|param|returns?|typedef|property|prop|template|satisfies)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g)].map((m) => m[1] ?? "");

/** What `text`, the file `file`, has that this check forbids, by line. @param {string} file @param {string} text @returns {string[]} */
export function problems(file, text) {
  /** @type {string[]} */
  const found = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const at = `${file}:${i + 1}`;
    const off = /@ts-(ignore|nocheck|expect-error)\b/.exec(line);
    if (off) found.push(`${at}: @ts-${off[1]} turns the type check off here; fix the type, or narrow the value`);
    if (typesIn(file, line).some((type) => /(^|[^\w$])any\b(?![\w$])/.test(type))) found.push(`${at}: \`any\` is unchecked; use \`unknown\` and narrow it, or the type it is`);
  });
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = execFileSync("git", ["ls-files", "-z", "--", "crates/corten/js", "crates/corten/src", "crates/corten-ui/src", "crates/corten-cli/template", "examples"], { cwd: root, encoding: "utf8" })
    .split("\0")
    // The scripts the type check covers: not the minified builds, nor the smokes' Node scripts.
    .filter((file) => /\.(js|d\.ts)$/.test(file) && !file.includes("/dist/") && !file.includes("node_modules/"));
  const found = files.filter((file) => existsSync(join(root, file))).flatMap((file) => problems(file, readFileSync(join(root, file), "utf8")));
  if (found.length) {
    console.error(found.join("\n"));
    process.exit(1);
  }
}
