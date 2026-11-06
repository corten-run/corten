// Holds docs/design.md's Choices to the convention its Choices section states: each ends with a
// "Stands on:" paragraph naming every premise by a kind the section lists, then a "Revisit when:"
// paragraph, and the Choices are numbered in order, since other documents cite them by number.
// The kinds are read from the section's own list, so the document is their one source.
// Run by npm run check.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The problems in a design document's Choices, one line each, and how many Choices it has. */
export function problems(/** @type {string} */ text) {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf("## Choices");
  if (start < 0) return { count: 0, problems: ["design.md: no ## Choices section"] };
  let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  if (end < 0) end = lines.length;
  /** @type {string[]} */
  const found = [];
  /** @type {string[]} */
  const kinds = [];
  /** @type {{ n: number, at: number, lines: string[] }[]} */
  const choices = [];
  for (let i = start + 1; i < end; i += 1) {
    const choice = /^(\d+)\. \*\*/.exec(lines[i]);
    if (choice) {
      choices.push({ n: Number(choice[1]), at: i + 1, lines: [lines[i]] });
    } else if (choices.length) {
      choices[choices.length - 1].lines.push(lines[i]);
    } else {
      const kind = /^\d+\. ([a-z]+): /.exec(lines[i]);
      if (kind) kinds.push(kind[1]);
    }
  }
  if (kinds.length === 0) found.push("design.md: the Choices section lists no kinds (`1. measured: ...`)");
  choices.forEach((choice, i) => {
    const at = `design.md:${choice.at}: Choice ${choice.n}`;
    if (choice.n !== i + 1) found.push(`${at} is number ${i + 1} in the list; number the Choices in order`);
    const paragraphs = [];
    let current = [];
    for (const line of choice.lines) {
      if (line.trim() === "") {
        if (current.length) paragraphs.push(current.join(" "));
        current = [];
      } else current.push(line.trim());
    }
    if (current.length) paragraphs.push(current.join(" "));
    const stands = paragraphs.length >= 3 ? paragraphs[paragraphs.length - 2] : "";
    const revisit = paragraphs.length >= 3 ? paragraphs[paragraphs.length - 1] : "";
    if (!stands.startsWith("Stands on: ") || !revisit.startsWith("Revisit when: ")) {
      found.push(`${at} does not end with a "Stands on:" paragraph and then a "Revisit when:" paragraph`);
      return;
    }
    if (revisit.length <= "Revisit when: ".length + 1) found.push(`${at} says nothing after "Revisit when:"`);
    for (const premise of premises(stands.slice("Stands on: ".length))) {
      const kind = /^[a-z]+/.exec(premise)?.[0] ?? "";
      if (!kinds.includes(kind)) {
        found.push(`${at}: a premise of kind "${kind}", not one of ${kinds.join(", ")} (${premise.slice(0, 40)}...)`);
      } else if (!premise.includes("(")) {
        found.push(`${at}: the ${kind} premise does not say what it is, in parentheses after its kind`);
      }
    }
  });
  return { count: choices.length, problems: found };
}

/** A "Stands on" list split at the semicolons outside parentheses. */
export function premises(/** @type {string} */ list) {
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === ";" && depth === 0) {
      out.push(current.trim());
      current = "";
    } else current += ch;
  }
  out.push(current.trim().replace(/\.$/, ""));
  return out.filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = readFileSync(new URL("../docs/design.md", import.meta.url), "utf8");
  const { count, problems: found } = problems(text);
  if (count < 20) found.push(`design.md: found only ${count} Choices`);
  if (found.length) {
    console.error(`choices: ${found.length} problem(s)\n${found.join("\n")}`);
    process.exit(1);
  }
  console.log(`choices: ${count} Choices, each with what it stands on and when to revisit it`);
}
