// The fifth point's second case, read from one LLD map: a `.text*` input section whose name
// ends in a Rust-mangled symbol (`_R...`, or `_ZN...17h<hash>E` under the legacy scheme) at or
// after the first input section of `.text` aligned beyond 16 bytes, or in another output
// section. The map prints symbols demangled, so the section's name is what is read: rustc
// names each function's section for its mangled symbol.
//
//   node rust-names.mjs <an unpadded link's map, gzipped or not>
//
// Prints the counts and each section the case refuses a side for; exits 1 where there is one.
// A C function whose own name looked like a Rust-mangled symbol would be refused too.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const file = process.argv[2];
if (!file) {
  console.error('usage: node rust-names.mjs <map or map.gz>');
  process.exit(2);
}
const bytes = readFileSync(file);
const text = (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString('utf8');

// A map line: VMA, LMA, size, alignment, then the output section at no indent, an input section
// (`file:(name)`) at 8 spaces and a symbol at 16.
const line = /^\s*([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(\d+) (.*)$/;
const outputs = [];
let output = null;
for (const l of text.split('\n')) {
  const m = line.exec(l.replace(/\r$/, ''));
  if (!m) continue;
  const rest = m[5];
  if (!rest.startsWith(' ')) {
    output = { name: rest, inputs: [] };
    outputs.push(output);
  } else if (/^ {8}\S/.test(rest) && output) {
    const id = rest.trim();
    const k = id.lastIndexOf(':(');
    if (k < 0) continue;
    output.inputs.push({ file: id.slice(0, k), name: id.slice(k + 2, -1), align: Number(m[4]) });
  }
}

const mangled = /\.(_R[A-Za-z0-9_.$]+|_ZN[A-Za-z0-9_.$]*17h[0-9a-f]{16}E(\.llvm\.\d+)?)$/;
const isText = (s) => s.name === '.text' || s.name.startsWith('.text.');
const rustNamed = (s) => isText(s) && mangled.test(s.name);
const short = (f) => f.replace(/^.*[\\/]/, '');

const dotText = outputs.find((o) => o.name === '.text');
if (!dotText) {
  console.error('no .text output section in the map');
  process.exit(2);
}
const prefixes = {};
for (const s of dotText.inputs.filter(rustNamed)) {
  const p = s.name.slice(0, mangled.exec(s.name).index + 1);
  prefixes[p] = (prefixes[p] ?? 0) + 1;
}
const named = dotText.inputs.filter(rustNamed).length;
console.log(`.text: ${dotText.inputs.length} input sections, ${named} named for a Rust-mangled symbol`
  + ` (${Object.entries(prefixes).map(([p, n]) => `${n} as ${p}<symbol>`).join(', ') || 'none'})`);
const others = dotText.inputs.filter((s) => !rustNamed(s) && /\.rcgu\.o\)?$/.test(s.file));
console.log(`.text: ${others.length} sections from rustc's objects not so named`
  + (others.length ? `: ${others.map((s) => s.name).join(' ')}` : ''));

const refused = [];
const first = dotText.inputs.findIndex((s) => s.align > 16);
if (first < 0) {
  console.log('.text: no input section aligned beyond 16 bytes');
} else {
  const from = dotText.inputs.slice(first);
  const hit = from.filter(rustNamed);
  console.log(`.text: first section aligned beyond 16 bytes is ${dotText.inputs[first].name}`
    + ` (alignment ${dotText.inputs[first].align}), after ${first} sections; from it on, ${hit.length}`
    + ` of ${from.length} sections are named for a Rust-mangled symbol`);
  refused.push(...hit.map((s) => `.text, behind the first aligned section: ${s.name} [${short(s.file)}]`));
}
let elsewhere = 0;
let dataNamed = 0;
for (const o of outputs) {
  if (o === dotText) continue;
  for (const s of o.inputs) {
    if (isText(s)) {
      elsewhere += 1;
      if (rustNamed(s)) refused.push(`${o.name}: ${s.name} [${short(s.file)}]`);
    } else if (mangled.test(s.name)) dataNamed += 1;
  }
}
console.log(`other output sections: ${elsewhere} .text* input sections;`
  + ` ${dataNamed} input sections of other names end in a Rust-mangled symbol, which the case leaves out`);
for (const r of refused) console.log(`refused: ${r}`);
console.log(refused.length ? `the side has no reading across placements (${refused.length} refused)`
  : 'the case refuses nothing on this side');
process.exit(refused.length ? 1 : 0);
