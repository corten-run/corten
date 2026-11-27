// mask.mjs: the header values a plan masks when two answers are compared (the placement plan's
// first point, CONTRIBUTING.md#pull-requests): "only the header values the plan names masked,
// each one that differs between two starts of one binary (a keyed `ETag`). A header value the
// workload's cost depends on, as `kept`'s depends on `Age`, is masked for that comparison only if
// it can differ between starts, and is then checked separately against the value or range the
// plan states, not accepted as any number." So every masked header, with a stated range or
// without, must be shown to differ between two starts of one binary, and one with a range is then
// also held to it in every answer. Nothing of a body is masked. A mask is the workload's `mask`
// in the plan, a list of { "header": name } with an optional "range": [low, high] (numbers, low
// under high). The kit takes a range and no single value: a header that two starts must send
// differently cannot also be one stated value in every answer. Both checks read the final
// response's header lines alone: an interim 1xx response's (early hints, say) are no evidence
// for the answer's own, so a masked header an interim block sends and the final one does not is
// sent 0 times. The interim block stays in the headers compared (answers.mjs).
//   node mask.mjs sed <mask.json>                       the sed script that masks those values
//   node mask.mjs starts <mask.json> <headers> <headers>  two starts of one binary: exit 1 unless
//                                                       each masked header was sent once by both
//                                                       and differs
//   node mask.mjs stated <mask.json> <headers>...       exit 1 unless every answer's masked header
//                                                       with a stated range is within it
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
    if (Object.keys(m).some((k) => k !== "header" && k !== "range")) why.push(`mask: ${name} has a field other than header and range`);
    if (m.range !== undefined && (!Array.isArray(m.range) || m.range.length !== 2 || !m.range.every(Number.isFinite) || m.range[0] >= m.range[1])) why.push(`mask: ${name}'s range is not [low, high] with low under high: a header that differs between two starts takes more than one value`);
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

/**
 * The final response's header lines of headers as curl -D saves them: from the last status line
 * on, so an interim 1xx response's block before it is left out (all of headers when no line is one).
 */
export function final(headers) {
  const at = headers.lastIndexOf("\nHTTP/");
  return at < 0 ? headers : headers.slice(at + 1);
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

/**
 * Two starts of one binary: each masked header, with a stated range or without, differs between
 * them. "Can differ between starts" is read here as "did differ between the two starts the kit
 * made", so a header with a range that can differ and did not in these two is refused as well;
 * whether a range may instead be taken on the plan's word is the rule's to say, not this kit's.
 */
export function starts(mask, one, two) {
  const why = [];
  for (const m of mask) {
    const a = values(final(one), m.header), b = values(final(two), m.header);
    if (a.length !== 1 || b.length !== 1) why.push(`${m.header}: two starts sent it ${a.length} and ${b.length} times; a masked value is one each start sends once`);
    else if (a[0] === b[0]) why.push(`${m.header}: two starts of one binary both sent "${a[0]}"; only a value that differs between starts is masked${m.range === undefined ? "" : ". The kit shows that by the two starts it makes and does not take it on the plan's word, so a header with a range that can differ between starts and did not in these two stops the run here. The plan's author can leave it out of the mask, when this workload always sends that value (a placement whose answers then differ in it fails), or ask on the pull request whether the rule lets a range stand on the plan's word, which this kit does not do"}`);
  }
  return why;
}

/** An answer's masked headers that have a stated range: each sent once in its final response, within it. */
export function stated(mask, headers) {
  const why = [];
  for (const m of mask) {
    if (m.range === undefined) continue;
    const v = values(final(headers), m.header);
    if (v.length !== 1) { why.push(`${m.header}: sent ${v.length} times, not once`); continue; }
    if (!(/^-?\d+(\.\d+)?$/.test(v[0]) && Number(v[0]) >= m.range[0] && Number(v[0]) <= m.range[1])) why.push(`${m.header}: "${v[0]}", not a number from ${m.range[0]} to ${m.range[1]}`);
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
