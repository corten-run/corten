// The fifth point's reading of LLD's maps (CONTRIBUTING.md, Pull requests, item 2) against the
// maps kept under the tag evidence/placement-aligned-code-6 (a base with no section of .text
// aligned beyond 16 bytes and a head with eighteen), against that tag's written cases for the
// Rust-name pattern, and against small maps made here; and the first point's check of a
// placement's functions.
import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, symbols, textStart } from "./layout.mjs";
import { check, data, mapText, origin, PAD, readMap, record, refusals, RUST_NAME, SECOND_PAD, SIZES } from "./map.mjs";
import { blob } from "./tags.mjs";

const TAG = "evidence/placement-aligned-code-6", kept = (name) => mapText(blob(TAG, `placement-replay/results/${name}`));
const texts = {};
const text = (name) => (texts[name] ??= kept(`${name}.map.gz`));
const maps = {};
const map = (name) => (maps[name] ??= readMap(text(name)));
const has = (why, word) => assert.ok(why.some((w) => w.includes(word)), `no "${word}" in: ${why.join(" | ") || "nothing"}`);

test("CONTRIBUTING.md prints the pattern the kit refuses by", async () => {
  const { readFileSync } = await import("node:fs");
  const doc = readFileSync(new URL("../../CONTRIBUTING.md", import.meta.url), "utf8");
  assert.ok(doc.includes(`\`${RUST_NAME.source}\``), "the pattern in map.mjs is not the one item 2 prints");
  assert.deepEqual(SIZES, [16, 32, 48, 64]);
});

test("the kept base's record: no section aligned beyond 16 bytes, an empty list", () => {
  const r = record(map("base"));
  assert.deepEqual(r, { inputs: 3442, alignments: { 1: 162, 4: 42, 8: 23, 16: 3215 }, aligned: [], sectionsBefore: 3442, list: [] });
  assert.deepEqual(refusals(map("base")), []);
});

test("the kept head's record is the one that tag states: eighteen sections and the list from the first", () => {
  const r = record(map("head")), stated = JSON.parse(blob(TAG, "placement-replay/results/stated-head.json").toString("utf8"));
  assert.equal(r.inputs, 3483);
  assert.deepEqual(r.alignments, { 1: 162, 4: 42, 8: 23, 16: 3238, 32: 5, 64: 13 });
  assert.equal(r.sectionsBefore, 3443);
  // The tag states an archive and its member less the hashes cargo and the cc crate give them;
  // the record keeps them as the map names them.
  const bare = (x) => x.replace(/^[0-9a-f]{16}-/, "").replace(/[-.][0-9a-f]{16}(?=[-.])/g, "");
  const file = (s) => (s.archive ? `${bare(s.archive)}(${bare(s.member)})` : s.object);
  assert.deepEqual(r.aligned.map((s) => ({ section: `${file(s)}:(${s.section})`, align: s.align })), stated.beyond);
  assert.equal(r.aligned[0].archive, "liblibdeflate_sys-5c8cf0e00bd3ad12.rlib");
  assert.equal(r.aligned[0].member, "409ab19b05e0b730-deflate_compress.o");
  assert.equal(`${file(r.aligned[0])}:(${r.aligned[0].section})`, stated.first);
  const from = {};
  for (const s of r.list) (from[file(s)] ??= []).push(s.symbol);
  assert.deepEqual(from, stated.from);
  assert.ok(r.list.some((s) => s.symbol === "__udivti3") && r.list.some((s) => s.symbol === "round"), "the compiler's built-ins are on the list");
  assert.deepEqual(refusals(map("head")), []);
});

test("the kept placements pass the map check, each with the second pad its name gives", () => {
  for (const [side, pad, second] of [["base", 15120, 48], ["base", 25824, 48], ["head", 15120, 64], ["head", 25824, 16], ["head", 320, 48]]) {
    const r = check(map(side), map(`${side}-p${pad}-l${second}`), pad, second), name = `${side}-p${pad}-l${second}`;
    assert.deepEqual(r.why, [], name);
    assert.equal(r.ok, true);
    assert.equal(r.inputs, side === "base" ? 3442 : 3483, name);
    // Before the first section aligned beyond 16 bytes everything moved by exactly the pad.
    assert.equal(r.sectionsBeforeAlignedMovedByPad, r.sectionsBeforeAligned, name);
    assert.equal(r.sectionsBeforeAligned, side === "base" ? 3442 : 3443, name);
    const d = data(map(side), map(name), pad);
    assert.deepEqual([d.fits, d.offset], [true, d.want], name);
    assert.equal(d.want, (map(side).find((o) => o.name === ".data").at + pad) % 64, name);
  }
});

test("the kept negative case, a second pad of 8 bytes, is refused twice over", () => {
  const r = check(map("head"), map("head-p320-l8"), 320, 8);
  assert.equal(r.ok, false);
  has(r.why, "a second pad of 8 bytes is not one of 16, 32, 48, 64");
  has(r.why, ".data begins 48 bytes into a 64-byte line, not 32");
  assert.equal(data(map("head"), map("head-p320-l8"), 320).fits, false);
});

test("a kept placement checked as another is refused", () => {
  // Another first pad.
  has(check(map("head"), map("head-p320-l48"), 336, 48).why, "not the first pad of 336 bytes");
  // Another second pad, of the four.
  has(check(map("head"), map("head-p320-l48"), 320, 32).why, "not the second pad of 32 bytes");
  // The other side's unpadded link.
  has(check(map("base"), map("head-p15120-l64"), 15120, 64).why, ".text has 3442 input sections unpadded and 3483 between the pads");
  // No pad at all: an unpadded link as a placement.
  const none = check(map("base"), map("base"), 15120, 48).why;
  has(none, "not the first pad");
  has(none, "not the second pad");
});

// The tag's written cases (rust-names-cases.mjs, results/rust-names.txt): the head's unpadded map
// with one input section's name rewritten. A rewritten name moves no section.
test("the Rust-name refusal on the tag's five written cases", () => {
  const renamed = (from, to, count = 1) => {
    const needle = `:(${from})`, lines = text("head").split("\n");
    const hits = lines.flatMap((l, i) => (l.replace(/\r$/, "").endsWith(needle) ? [i] : []));
    assert.equal(hits.length, count, `${from}: input sections of that name`);
    lines[hits[0]] = lines[hits[0]].replace(needle, `:(${to})`);
    return refusals(readMap(lines.join("\n")));
  };
  const v0 = renamed(".text.round", ".text._RNvNtCs9ltgdHTiPiY_17compiler_builtins4math5round");
  assert.equal(v0.length, 1);
  has(v0, "lies at or after the first section aligned beyond 16 bytes");
  const legacy = renamed(".text.__udivti3", ".text._ZN17compiler_builtins3int4udiv8__udivti317h0123456789abcdefE");
  assert.equal(legacy.length, 1);
  has(legacy, ".text._ZN17compiler_builtins3int4udiv8__udivti317h0123456789abcdefE");
  const cold = renamed(".text.round", ".text.unlikely._RNvNtCs9ltgdHTiPiY_17compiler_builtins4math5round");
  assert.equal(cold.length, 1);
  has(cold, "lies at or after the first section aligned beyond 16 bytes");
  const init = renamed(".init", ".text._RNvCs9ltgdHTiPiY_4init4init", 2);
  assert.equal(init.length, 1);
  has(init, "lies in .init");
  // A name that only begins like one (no hash under the legacy scheme) is not refused.
  assert.deepEqual(renamed(".text.round", ".text._ZN5round5roundE"), []);
});

test("the pattern: what ends in a Rust-mangled symbol and what does not", () => {
  for (const name of [".text._RNvCs1234_3app4main", ".text.unlikely._RNvCs1234_3app4cold", ".text._ZN3app4main17h0123456789abcdefE", ".text._ZN3app4main17h0123456789abcdefE.llvm.1234567890", ".text._ZN4core3fmt9Formatter3pad17hfedcba9876543210E", ".text._RNvCs1234_3app4main.cold"]) assert.ok(RUST_NAME.test(name), name);
  for (const name of [".text.main", ".text.round", ".text.__udivti3", ".text.deflate_flush_block", ".text._ZN5round5roundE", ".text._ZN3app4main17h0123456789abcdeE", ".text._ZN3app4main17h0123456789ABCDEFE", ".text._R", ".text.sort_symbols.constprop.0", ".text"]) assert.ok(!RUST_NAME.test(name), name);
});

test("a section aligned beyond 64 bytes refuses the side", () => {
  const lines = text("head").split("\n"), at = lines.findIndex((l) => l.replace(/\r$/, "").endsWith(":(.text.deflate_flush_block)"));
  lines[at] = lines[at].replace(/^(\s*[0-9a-f]+\s+[0-9a-f]+\s+[0-9a-f]+\s+)32 /, "$1128 ");
  const why = refusals(readMap(lines.join("\n")));
  assert.equal(why.length, 1);
  has(why, "1 input sections of .text are aligned beyond 64 bytes: .text.deflate_flush_block (128)");
});

// Small maps made here, laid out by LLD's rule: each input section at the first multiple of its
// alignment at or after the end of the one before it, .data a fixed way past the end of .text.
const S = (file, section, size, align, syms = [[section.replace(/^\.text\.?/, "") || "start", 0]]) => ({ file, section, size, align, syms });
const UNPADDED = [
  S("/usr/lib/x86_64-linux-gnu/Scrt1.o", ".text", 34, 16),
  S("/t/release/deps/probe.probe.0.rcgu.o", ".text._ZN5probe4main17h0123456789abcdefE", 700, 16, [["_ZN5probe4main17h0123456789abcdefE", 0]]),
  S("/t/release/deps/probe.probe.0.rcgu.o", ".text._ZN5probe4page17hfedcba9876543210E", 1234, 16, [["_ZN5probe4page17hfedcba9876543210E", 0]]),
  S("/t/release/build/c/out/libc.a(compress.o)", ".text.fill", 217, 32),
  S("/t/release/build/c/out/libc.a(compress.o)", ".text.flush", 1377, 64, [["flush", 0], ["flush_tail", 512]]),
  S("/t/release/build/c/out/libc.a(crc.o)", ".text.crc", 99, 16),
];
const lay = (sections, { textAt = 0x201000, nudge = () => 0 } = {}) => {
  let dot = textAt;
  const placed = sections.map((s, i) => { dot = Math.ceil(dot / s.align) * s.align + nudge(i); const at = dot; dot += s.size; return { ...s, at }; });
  const row = (at, size, align, rest) => `${at.toString(16).padStart(8)} ${at.toString(16).padStart(8)} ${size.toString(16).padStart(8)} ${String(align).padStart(5)} ${rest}`;
  const out = ["     VMA      LMA     Size Align Out     In      Symbol", row(textAt, dot - textAt, 64, ".text")];
  for (const s of placed) { out.push(row(s.at, s.size, s.align, `        ${s.file}:(${s.section})`)); for (const [n, off] of s.syms) out.push(row(s.at + off, 0, 1, `                ${n}`)); }
  const dataAt = Math.ceil(dot / 16) * 16 + 0x2000;
  out.push(row(dataAt, 64, 8, ".data"), row(dataAt, 64, 8, "        /t/release/deps/probe.probe.0.rcgu.o:(.data)"));
  return readMap(out.join("\n") + "\n");
};
const pad = (n) => S("/w/pads/pad.o", PAD, n, 16, [["corten_layout_pad", 0]]), pad2 = (n) => S("/w/pads/pad2.o", SECOND_PAD, n, 16, [["corten_layout_pad2", 0]]);
const placed = (p, second, sections = UNPADDED, o) => lay([pad(p), ...sections, ...(second ? [pad2(second)] : [])], o);

test("a made-up side: its record, origins less directories, and nothing refused", () => {
  const r = record(lay(UNPADDED));
  assert.deepEqual(r.aligned, [{ section: ".text.fill", archive: "libc.a", member: "compress.o", align: 32 }, { section: ".text.flush", archive: "libc.a", member: "compress.o", align: 64 }]);
  assert.equal(r.sectionsBefore, 3);
  assert.deepEqual(r.list, [{ symbol: "fill", archive: "libc.a", member: "compress.o" }, { symbol: "flush", archive: "libc.a", member: "compress.o" }, { symbol: "flush_tail", archive: "libc.a", member: "compress.o" }, { symbol: "crc", archive: "libc.a", member: "crc.o" }]);
  assert.deepEqual(origin("/usr/lib/x86_64-linux-gnu/Scrt1.o"), { object: "Scrt1.o" });
  assert.deepEqual(origin("/a/b/libx.rlib(x.x.0.rcgu.o)"), { archive: "libx.rlib", member: "x.x.0.rcgu.o" });
  assert.deepEqual(refusals(lay(UNPADDED)), []);
  // Rust code after the first aligned section, and in another output section.
  has(refusals(lay([...UNPADDED, S("/t/release/deps/probe.probe.0.rcgu.o", ".text._ZN5probe4late17h0123456789abcdefE", 10, 16)])), "at or after the first section aligned beyond 16 bytes");
  // "At or after": a Rust-named section that is itself the first one aligned beyond 16 bytes,
  // with Rust code before it, which is not refused, and none after.
  const itself = refusals(lay([...UNPADDED.slice(0, 3), S("/t/release/deps/probe.probe.0.rcgu.o", ".text._ZN5probe4fast17h0123456789abcdefE", 64, 32), UNPADDED[5]]));
  assert.deepEqual(itself, [".text._ZN5probe4fast17h0123456789abcdefE [probe.probe.0.rcgu.o] is named for a Rust-mangled symbol and lies at or after the first section aligned beyond 16 bytes"]);
  assert.throws(() => record(readMap("no map\n")), /no \.text/);
});

test("for each first pad one of the four sizes fits, the map check passes with it and refuses the others", () => {
  const A = lay(UNPADDED);
  for (const p of [320, 15120, 25824, 40624, 10304, 21008, 35808, 5552]) {
    const fits = SIZES.filter((n) => data(A, placed(p, n), p).fits);
    assert.ok(fits.length >= 1, `pad ${p}: no size fits`);
    for (const n of SIZES) {
      const r = check(A, placed(p, n), p, n);
      if (fits.includes(n)) assert.deepEqual(r.why, [], `pad ${p}, second ${n}`);
      else { assert.equal(r.why.length, 1, `pad ${p}, second ${n}`); has(r.why, ".data begins"); }
    }
    // The first three sections lie before the first aligned beyond 16 and move by exactly the pad.
    const ok = check(A, placed(p, fits[0]), p, fits[0]);
    assert.deepEqual([ok.sectionsBeforeAligned, ok.sectionsBeforeAlignedMovedByPad, ok.symbolsBeforeAlignedMovedByPad], [3, 3, 3]);
  }
});

test("the map check refuses each way a placement can differ from its unpadded link", () => {
  const A = lay(UNPADDED), p = 320, n = SIZES.find((x) => data(A, placed(p, x), p).fits);
  const why = (B, second = n) => check(A, B, p, second).why;
  assert.deepEqual(why(placed(p, n)), []);
  // No second pad; a second pad the ordering file named, so it is not last.
  has(why(placed(p, 0)), "the last input section of .text is");
  has(why(lay([pad(p), pad2(n), ...UNPADDED])), "not the second pad");
  // The pad not first.
  has(why(lay([UNPADDED[0], pad(p), ...UNPADDED.slice(1), pad2(n)])), "not the first pad");
  // Two sections in the other order; one of another size; one of another alignment.
  const swapped = [UNPADDED[0], UNPADDED[2], UNPADDED[1], ...UNPADDED.slice(3)];
  has(why(placed(p, n, swapped)), "input section 1 differs");
  has(why(placed(p, n, UNPADDED.map((s, i) => (i === 2 ? { ...s, size: s.size + 16 } : s)))), "input section 2 differs");
  has(why(placed(p, n, UNPADDED.map((s, i) => (i === 3 ? { ...s, align: 64 } : s)))), "input section 3 differs");
  // A section missing.
  has(why(placed(p, n, UNPADDED.slice(0, -1))), ".text has 6 input sections unpadded and 5 between the pads");
  // A symbol elsewhere in its section.
  has(why(placed(p, n, UNPADDED.map((s, i) => (i === 4 ? { ...s, syms: [["flush", 0], ["flush_tail", 528]] } : s)))), "1 symbols of .text are not in the input section");
  // A section 16 bytes past the first multiple of its alignment.
  has(why(placed(p, n, UNPADDED, { nudge: (i) => (i === 3 ? 16 : 0) })), "1 input sections of the placement's .text do not begin at the first multiple");
  // .text beginning elsewhere.
  has(why(placed(p, n, UNPADDED, { textAt: 0x202000 })), ".text begins at 0x202000, not 0x201000");
  // A size that is none of the four, though it puts .data where the rule says.
  has(why(placed(p, n + 64), n + 64), `a second pad of ${n + 64} bytes is not one of`);
  // A section of the same name, size and alignment from another file.
  has(why(placed(p, n, UNPADDED.map((s, i) => (i === 5 ? { ...s, file: "/t/release/build/z/out/libz.a(crc.o)" } : s)))), "input section 5 differs: /t/release/build/c/out/libc.a(crc.o):(.text.crc)");
  // The first pad first in .text, of its size, and 16 bytes past .text's start.
  has(why(placed(p, n, UNPADDED, { nudge: (i) => (i === 0 ? 16 : 0) })), `not the first pad of ${p} bytes at its start`);
  // The second pad last, of its size, and aligned beyond 16 bytes.
  has(why(lay([pad(p), ...UNPADDED, { ...pad2(n), align: 32 }])), `not the second pad of ${n} bytes aligned to 16`);
  // An unpadded link that LLD's rule does not give: the check stands on both maps.
  has(check(lay(UNPADDED, { nudge: (i) => (i === 2 ? 16 : 0) }), placed(p, n), p, n).why, "1 input sections of the unpadded .text do not begin at the first multiple");
});

// The first point's check, from nm's symbols.
const nm = (fns) => fns.map(([name, at, kind = "t"]) => `${at.toString(16).padStart(16, "0")} ${kind} ${name}`).join("\n") + "\n0000000000300000 D some_data\n";
const FNS = [["_start", 0x201000, "T"], ["_ZN5probe4main17h0123456789abcdefE.llvm.123", 0x201030], ["_ZN5probe4page17hfedcba9876543210E", 0x2012f0], ["crc", 0x2017d0, "T"]];
const moved = (by, fns = FNS) => fns.map(([n, at, k]) => [n.replace(".llvm.123", ".llvm.987"), at + by, k]);

test("a placement's functions: its side's and the pad, the pad first, each moved by the pad, neighbours kept", () => {
  const a = symbols(nm(FNS)), at = 0x201000;
  assert.equal(a.size, 4);
  assert.equal(a.get("_ZN5probe4main17h0123456789abcdefE"), 0x201030);
  assert.equal(textStart("  [14] .text             PROGBITS        0000000000201000 001000 0d6f22 00  AX  0   0 64\n"), at);
  const ok = compare(a, symbols(nm([["corten_layout_pad", at], ...moved(320)])), at, 320);
  assert.deepEqual([ok.ok, ok.functions, ok.exact, ok.neighbours, ok.neighboursKept], [true, 4, 4, 3, 3]);
  const why = (b, pad = 320, second = false) => compare(a, symbols(nm(b)), at, pad, second).why;
  has(why([["corten_layout_pad", at], ...moved(336)]), "4 of 4 functions moved by other than the pad's 320 bytes");
  has(why([["corten_layout_pad", at], ...moved(320).map((f, i) => (i === 3 ? [f[0], f[1] + 16, f[2]] : f))]), "1 of 4 functions moved by other");
  has(why(moved(320)), "only in the placement: nothing");
  has(why([["corten_layout_pad", at + 16], ...moved(320)]), "the pad is not at the start of .text");
  has(why([["corten_layout_pad", at], ...moved(320).slice(0, 3)]), "1 functions only in the unpadded binary: crc");
  has(why([["corten_layout_pad", at], ...moved(320), ["extra", 0x209000]]), "only in the placement");
  // Two functions in the other order.
  const turned = moved(320).map((f, i) => (i === 1 ? [f[0], 0x2012f0 + 320, f[2]] : i === 2 ? [f[0], 0x201030 + 320, f[2]] : f));
  has(why([["corten_layout_pad", at], ...turned]), "neighbours still next to each other in order: 0 of 3");
  // With code aligned beyond 16 bytes: both pads, and the shift is the map check's to ask.
  const two = [["corten_layout_pad", at], ...moved(320).map((f, i) => (i === 3 ? [f[0], f[1] + 16, f[2]] : f)), ["corten_layout_pad2", 0x202000]];
  assert.deepEqual(why(two, 320, true), []);
  has(why(two), "only in the placement");
  has(why([["corten_layout_pad", at], ...moved(320)], 320, true), "not corten_layout_pad and corten_layout_pad2");
  // A name defined more than once has no one address: it is counted and left out of the shift.
  const named = [...FNS, ["helper", 0x201900], ["helper", 0x201a00]];
  const twice = compare(symbols(nm(named)), symbols(nm([["corten_layout_pad", at], ...moved(320, named.slice(0, 5)), ["helper", 0x209000]])), at, 320);
  assert.deepEqual([twice.ok, twice.functions, twice.repeated], [true, 4, 1]);
});
