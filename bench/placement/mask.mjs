// mask.mjs: the header values a plan masks when two answers are compared (the placement plan's
// first point, CONTRIBUTING.md, Pull requests, item 2): only the values the plan names, each one
// that differs between two starts of one binary, and one the workload's cost depends on checked
// against the value or range the plan states. Nothing of a body is masked. A mask is the
// workload's `mask` in the plan, a list of { "header": name } with an optional "range": [low,
// high] (numbers) or "value": text.
//   node mask.mjs sed <mask.json>                       the sed script that masks those values
//   node mask.mjs starts <mask.json> <headers> <headers>  two starts of one binary: exit 1 unless
//                                                       each masked header without a stated value
//                                                       or range was sent by both and differs
//   node mask.mjs stated <mask.json> <headers>...       exit 1 unless every answer's masked header
//                                                       with a stated value or range has it
// <headers> is a response's header lines as curl -D saves them.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Why a mask is not usable, or [] when it is. */
export function problems(mask) {
  if (!Array.isArray(mask)) return ["mask is not a list"];
  const why = [], seen = new Set();
  for (const m of mask) {
    const name = typeof m?.header === "string" ? m.header.toLowerCase() : "";
    if (!/^[a-z0-9-]+$/.test(name)) { why.push(`mask: ${JSON.stringify(m?.header)} is not a header name`); continue; }
    if (name === "date") why.push("mask: Date is left out of every comparison and is not masked");
    if (seen.has(name)) why.push(`mask: ${name} is named twice`);
    seen.add(name);
    if (m.range !== undefined && (m.value !== undefined || !Array.isArray(m.range) || m.range.length !== 2 || !m.range.every(Number.isFinite) || m.range[0] > m.range[1])) why.push(`mask: ${name}'s range is not [low, high], or it has a value as well`);
    if (m.value !== undefined && typeof m.value !== "string") why.push(`mask: ${name}'s value is not text`);
  }
  return why;
}

/** A sed script (POSIX) that turns each masked header's line into its name and "<masked>". */
export function sed(mask) {
  return mask.map((m) => {
    const name = m.header.toLowerCase();
    const any = [...name].map((c) => (/[a-z]/.test(c) ? `[${c.toUpperCase()}${c}]` : c)).join("");
    return `s/^${any}:.*$/${name}: <masked>/\n`;
  }).join("");
}

/** The values a response's header lines give a header, in order. */
export function values(headers, name) {
  const out = [];
  for (const l of headers.split("\n")) {
    const m = /^([^:\s]+):[ \t]*(.*?)[ \t]*\r?$/.exec(l);
    if (m && m[1].toLowerCase() === name.toLowerCase()) out.push(m[2]);
  }
  return out;
}

/** Two starts of one binary: each masked header with no stated value or range differs between them. */
export function starts(mask, one, two) {
  const why = [];
  for (const m of mask) {
    if (m.range !== undefined || m.value !== undefined) continue;
    const a = values(one, m.header), b = values(two, m.header);
    if (a.length !== 1 || b.length !== 1) why.push(`${m.header}: two starts sent it ${a.length} and ${b.length} times; a masked value is one each start sends once`);
    else if (a[0] === b[0]) why.push(`${m.header}: two starts of one binary both sent "${a[0]}"; only a value that differs between starts is masked`);
  }
  return why;
}

/** An answer's masked headers that have a stated value or range: each sent once, with it. */
export function stated(mask, headers) {
  const why = [];
  for (const m of mask) {
    if (m.range === undefined && m.value === undefined) continue;
    const v = values(headers, m.header);
    if (v.length !== 1) { why.push(`${m.header}: sent ${v.length} times, not once`); continue; }
    if (m.value !== undefined && v[0] !== m.value) why.push(`${m.header}: "${v[0]}", not "${m.value}"`);
    if (m.range !== undefined && !(/^-?\d+(\.\d+)?$/.test(v[0]) && Number(v[0]) >= m.range[0] && Number(v[0]) <= m.range[1])) why.push(`${m.header}: "${v[0]}", not a number from ${m.range[0]} to ${m.range[1]}`);
  }
  return why;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [mode, file, ...rest] = process.argv.slice(2);
  const text = (f) => readFileSync(f, "utf8");
  const end = (why) => { for (const w of why) console.error(`mask.mjs: ${w}`); process.exit(why.length ? 1 : 0); };
  if (!["sed", "starts", "stated"].includes(mode) || !file || (mode === "starts" && rest.length !== 2)) { console.error("usage: node mask.mjs sed <mask.json> | starts <mask.json> <headers> <headers> | stated <mask.json> <headers>..."); process.exit(2); }
  const mask = JSON.parse(text(file));
  const bad = problems(mask);
  if (bad.length) end(bad);
  if (mode === "sed") process.stdout.write(sed(mask));
  else if (mode === "starts") end(starts(mask, text(rest[0]), text(rest[1])));
  else end(rest.flatMap((f) => stated(mask, text(f)).map((w) => `${f}: ${w}`)));
}
