// synth.mjs: writes the map a placement would have, from its side's unpadded link's map, by
// LLD's rule: the pad's section first in .text, then each input section at the first multiple
// of its own alignment at or after the end of the one before it, and a second pad last when one
// is asked for:
//   node synth.mjs <map of the unpadded link> <output map> <pad bytes> [--last-pad <bytes>] [--last-pad-before-end] [--compare <map of the real placement>]
// It models .text. The output sections after it are written moved by .text's growth rounded up
// to 16 bytes, which is an assumption and not LLD's rule for them: where they land in a real
// link is what last-pad.sh reads. --last-pad-before-end writes the second pad before the last
// section of the link, a layout the check must refuse. --compare reads a real placement's map
// and fails unless every input section and symbol of its .text is at the address written here.
import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const opt = (name) => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const lastArg = opt("--last-pad"), compare = opt("--compare"), beforeEnd = flag("--last-pad-before-end");
const [mapA, out, padArg] = argv;
const pad = Number(padArg), lastPad = lastArg === undefined ? null : Number(lastArg);
if (!mapA || !out || !Number.isInteger(pad)) throw new Error("usage: node synth.mjs <map A> <output map> <pad bytes> [--last-pad <bytes>] [--last-pad-before-end] [--compare <real map>]");

const RE = /^\s*([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(\d+) (.*)$/;
const line = (at, size, align, rest) => `${at.toString(16).padStart(16)} ${at.toString(16).padStart(16)} ${size.toString(16).padStart(8)} ${String(align).padStart(5)} ${rest}`;
const up = (x, a) => Math.ceil(x / a) * a;
const ls = readFileSync(mapA, "utf8").split("\n");
const rows = ls.map((l) => { const m = RE.exec(l); return m ? { at: parseInt(m[1], 16), size: parseInt(m[3], 16), align: Number(m[4]), rest: m[5] } : null; });
const kind = (r) => (r === null ? "other" : !r.rest.startsWith(" ") ? "output" : /^ {8}\S/.test(r.rest) ? "input" : "symbol");
const iText = rows.findIndex((r) => r && r.rest === ".text");
let end = iText + 1;
while (end < rows.length && kind(rows[end]) !== "output") end++;

const text = rows[iText], written = [];
const padLine = (name, symbol, at, size) => [line(at, size, 16, `        /m/1971/pads/${name}.o:(.text.${symbol})`), line(at, size, 1, `                ${symbol}`)];
let dot = up(text.at, 16);
written.push(...padLine(`pad-${pad}`, "corten_layout_pad", dot, pad));
dot += pad;
const inputs = [];
for (let i = iText + 1; i < end; i++) if (kind(rows[i]) === "input") inputs.push(i);
let shift = 0;
for (let i = iText + 1; i < end; i++) {
  const r = rows[i];
  if (kind(r) === "input") {
    if (lastPad !== null && beforeEnd && i === inputs[inputs.length - 1]) { dot = up(dot, 16); written.push(...padLine(`pad2-${lastPad}`, "corten_layout_pad2", dot, lastPad)); dot += lastPad; }
    dot = up(dot, r.align);
    shift = dot - r.at;
    written.push(line(dot, r.size, r.align, r.rest));
    dot += r.size;
  } else if (kind(r) === "symbol") written.push(line(r.at + shift, r.size, r.align, r.rest));
  else written.push(ls[i]);
}
if (lastPad !== null && !beforeEnd) { dot = up(dot, 16); written.push(...padLine(`pad2-${lastPad}`, "corten_layout_pad2", dot, lastPad)); dot += lastPad; }
const grew = dot - (text.at + text.size), after = up(grew, 16);
const result = [...ls.slice(0, iText), line(text.at, dot - text.at, text.align, text.rest), ...written,
  ...ls.slice(end).map((l, k) => { const r = rows[end + k]; return r && r.at ? line(r.at + after, r.size, r.align, r.rest) : l; })];
writeFileSync(out, result.join("\n"));
console.log(`synth.mjs: ${inputs.length} input sections of .text written after a pad of ${pad} bytes${lastPad === null ? "" : ` and before a second pad of ${lastPad}`}; .text grew by ${grew}`);

if (compare) {
  const real = readFileSync(compare, "utf8").split("\n").map((l) => RE.exec(l)).filter(Boolean).map((m) => ({ at: parseInt(m[1], 16), size: parseInt(m[3], 16), rest: m[5] }));
  const a = real.findIndex((r) => r.rest === ".text");
  let b = a + 1;
  while (b < real.length && real[b].rest.startsWith(" ")) b++;
  const mine = result.slice(iText, iText + 1 + written.length).map((l) => RE.exec(l)).filter(Boolean).map((m) => ({ at: parseInt(m[1], 16), size: parseInt(m[3], 16), rest: m[5] }));
  const theirs = real.slice(a, b);
  let off = mine.length === theirs.length ? 0 : Math.abs(mine.length - theirs.length);
  for (let i = 0; i < Math.min(mine.length, theirs.length); i++) if (mine[i].at !== theirs[i].at || mine[i].size !== theirs[i].size || mine[i].rest.trim().replace(/^.*\//, "") !== theirs[i].rest.trim().replace(/^.*\//, "")) off++;
  console.log(`synth.mjs: against the real placement's map, ${mine.length} lines of .text written and ${theirs.length} read, ${off} that differ`);
  process.exit(off ? 1 : 0);
}
