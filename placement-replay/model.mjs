// Tests three statements against the recorded tail layouts of #1971's head:
//   node model.mjs <dir with tail-head-p*.txt and layout-head-p*.txt>
// The alignments below are those of the head's link map (results/head.map.gz): 13 sections of the
// linked code at 64 bytes and 5 at 32.
// (1) the suggested sentence: shift == pad rounded up to the function's own alignment;
// (2) the linker's rule replayed: a function aligned to 16 or less moves as the function before
//     it; one aligned to a = 32 or 64 moves by the previous shift rounded down to a when the
//     previous shift mod a is at most the function's slack in the unpadded binary, else up,
//     one slack per function across all placements;
// (3) the bound: floor(pad, A) <= shift <= ceil(pad, A), A the largest alignment so far.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const a64 = new Set(["deflate_compress_fastest", "deflate_compress_greedy", "deflate_compress_lazy", "deflate_compress_lazy2", "deflate_compress_near_optimal", "deflate_find_min_cost_path", "deflate_optimize_and_flush_block", "deflate_precompute_huffman_header", "deflate_set_costs_from_codes", "sort_symbols.constprop.0", "sort_symbols.constprop.1", "sort_symbols.constprop.2", "crc32_x86_vpclmulqdq_avx512_vl512", "build_decode_table", "deflate_decompress_bmi2", "deflate_decompress_default"]);
const a32 = new Set(["calculate_min_match_len", "compute_length_counts", "crc32_slice8", "deflate_flush_block", "deflate_make_huffman_codes"]);
const align = (n) => (a64.has(n) ? 64 : a32.has(n) ? 32 : 16);
const up = (x, a) => Math.ceil(x / a) * a, down = (x, a) => Math.floor(x / a) * a;

const runs = [];
for (const f of readdirSync(dir).filter((x) => /^tail-head-p\d+\.txt$/.test(x))) {
  const pad = Number(/p(\d+)/.exec(f)[1]);
  const lines = readFileSync(join(dir, f), "utf8").split("\n");
  const list = lines.find((l) => l.startsWith("  ")).trim().split(", ").map((s) => { const m = /^(\S+) ([+-]\d+)$/.exec(s); return { name: m[1], d: Number(m[2]) }; });
  const lay = JSON.parse(readFileSync(join(dir, `layout-head-p${pad}.txt`), "utf8").split("\n").find((l) => l.startsWith("JSON ")).slice(5));
  runs.push({ pad, list, sections: lay.otherSectionsMoved, textGrew: lay.textB - lay.textA });
}
runs.sort((x, y) => x.pad - y.pad);
const names = runs[0].list.map((x) => x.name);
for (const r of runs) if (r.list.map((x) => x.name).join() !== names.join()) throw new Error("order differs at pad " + r.pad);
console.log(`${runs.length} placements, ${names.length} functions from the C code on, the same names in the same order in every one`);
console.log(`alignments taken from the archive's record: ${names.filter((n) => align(n) === 64).length} at 64, ${names.filter((n) => align(n) === 32).length} at 32, ${names.filter((n) => align(n) === 16).length} at 16 or less`);

// (1)
let s1ok = 0, s1bad = 0; const s1badBy = { 16: 0, 32: 0, 64: 0 }; const s1okBy = { 16: 0, 32: 0, 64: 0 };
for (const r of runs) for (const f of r.list) { const a = align(f.name); if (r.pad + f.d === up(r.pad, a)) { s1ok++; s1okBy[a]++; } else { s1bad++; s1badBy[a]++; } }
console.log(`(1) shift == pad rounded up to own alignment: holds ${s1ok}, fails ${s1bad} of ${s1ok + s1bad}; holds by alignment ${JSON.stringify(s1okBy)}, fails by alignment ${JSON.stringify(s1badBy)}`);
const s1ByPhase = {};
for (const r of runs) { const ph = r.pad % 64; s1ByPhase[ph] ??= { placements: 0, ok: 0, bad: 0 }; s1ByPhase[ph].placements++; for (const f of r.list) (r.pad + f.d === up(r.pad, align(f.name)) ? s1ByPhase[ph].ok++ : s1ByPhase[ph].bad++); }
console.log(`    by pad mod 64: ${JSON.stringify(s1ByPhase)}`);

// (2)
let follow = 0, followBad = 0; const slack = new Map(); let alignedObs = 0, notMultiple = 0, far = 0;
for (const r of runs) {
  let prev = r.pad;
  for (const f of r.list) {
    const a = align(f.name), s = r.pad + f.d;
    if (a <= 16) { if (s === prev) follow++; else { followBad++; console.log(`    ${f.name} at pad ${r.pad}: ${s} where the function before moved ${prev}`); } }
    else {
      alignedObs++;
      if (s % a) notMultiple++;
      const lo = down(prev, a), hi = lo + a, m = prev % a;
      if (s !== lo && !(s === hi && m !== 0)) far++;
      if (m !== 0) { const e = slack.get(f.name) ?? { a, downAt: [], upAt: [] }; (s === lo ? e.downAt : e.upAt).push(m); slack.set(f.name, e); }
    }
    prev = s;
  }
}
console.log(`(2) functions aligned to 16 or less that moved as the function before them: ${follow}, otherwise ${followBad}`);
console.log(`    functions aligned to 32 or 64: ${alignedObs} shifts, ${notMultiple} not a multiple of the alignment, ${far} neither the previous shift rounded down nor up`);
let consistent = 0, inconsistent = 0, decided = 0;
for (const [n, e] of slack) {
  const maxDown = Math.max(-1, ...e.downAt), minUp = Math.min(Infinity, ...e.upAt);
  const ok = maxDown < minUp; ok ? consistent++ : inconsistent++;
  decided += e.downAt.length + e.upAt.length;
  console.log(`    ${n} (${e.a}): rounded down when the previous shift mod ${e.a} was ${[...new Set(e.downAt)].sort((x, y) => x - y).join("/") || "-"} (${e.downAt.length} times), up when ${[...new Set(e.upAt)].sort((x, y) => x - y).join("/") || "-"} (${e.upAt.length} times): slack in [${maxDown < 0 ? 0 : maxDown}, ${minUp === Infinity ? e.a - 1 : minUp - 1}] ${ok ? "consistent" : "INCONSISTENT"}`);
}
console.log(`    one slack per function explains every rounding: ${consistent} functions consistent, ${inconsistent} not, over ${decided} shifts where the previous shift was not a multiple of the alignment`);

// (3)
let in3 = 0, out3 = 0, within16 = 0;
for (const r of runs) { let A = 16; for (const f of r.list) { A = Math.max(A, align(f.name)); const s = r.pad + f.d; (s >= down(r.pad, A) && s <= up(r.pad, A)) ? in3++ : out3++; } }
console.log(`(3) floor(pad, A) <= shift <= ceil(pad, A): holds ${in3}, fails ${out3}`);

// What the pads sample, per function: distinct offsets in a 64-byte line and page offsets.
const dist = {};
for (const r of runs) for (const f of r.list) dist[f.d] = (dist[f.d] ?? 0) + 1;
console.log(`shift minus pad over all ${runs.length * names.length}: ${JSON.stringify(dist)}`);
const perFn = names.map((n, i) => ({ n, a: align(n), line: new Set(runs.map((r) => (r.pad + r.list[i].d) % 64)).size, page: new Set(runs.map((r) => (r.pad + r.list[i].d) % 4096)).size, q: [0, 1, 2, 3].map((q) => runs.filter((r) => Math.floor(((r.pad + r.list[i].d) % 4096) / 1024) === q).length) }));
for (const p of perFn) console.log(`    ${p.n} (${p.a}): ${p.line} of 4 places in a line, ${p.page} distinct page offsets of ${runs.length}, by quarter of a page ${p.q.join("/")}`);
console.log(`pads: by quarter of a page ${[0, 1, 2, 3].map((q) => runs.filter((r) => Math.floor((r.pad % 4096) / 1024) === q).length).join("/")}; by place in a line ${[0, 16, 32, 48].map((p) => runs.filter((r) => r.pad % 64 === p).length).join("/")}`);
// Sections after .text.
const sec = {}; let secOne = 0;
for (const r of runs) { const ds = new Set(r.sections.map((s) => Number(s.split(" ")[1]) - r.pad)); if (ds.size === 1) secOne++; const d = [...ds].join(","); sec[d] = (sec[d] ?? 0) + 1; const last = r.list.at(-1).d; if (!ds.has(last)) console.log(`    pad ${r.pad}: sections moved ${d}, the last function ${last}`); if (r.textGrew - r.pad !== [...ds][0]) console.log(`    pad ${r.pad}: .text grew by pad ${r.textGrew - r.pad}`); }
console.log(`sections after .text: one shift for all of them in ${secOne} of ${runs.length} placements; shift minus pad ${JSON.stringify(sec)}; a multiple of 64 in ${runs.filter((r) => r.sections.every((s) => Number(s.split(" ")[1]) % 64 === 0)).length}`);
