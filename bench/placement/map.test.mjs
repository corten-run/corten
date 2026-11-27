// The fifth point's reading of LLD's maps (CONTRIBUTING.md, Pull requests, item 2) against the
// maps kept under the tag evidence/placement-aligned-code-6 (a base with no section of .text
// aligned beyond 16 bytes and a head with eighteen), against that tag's written cases for the
// Rust-name pattern, and against small maps made here; the first point's check of a
// placement's functions; and, for a workload the plan shuffles, the ordering files order.mjs
// draws and the checks of a placement linked with one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { alike, compare, elfSymbols, entries, FEWEST, inText, ordered, symbols, textFunctions, textRange, textStart } from "./layout.mjs";
import { check, data, mapText, origin, owner, PAD, readMap, record, refusals, RUST_NAME, SECOND_PAD, SIZES } from "./map.mjs";
import { key, names, namesProblem, order } from "./order.mjs";
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

// A shuffled placement's ordering file (order.mjs): the pad, then every function of its side's
// unpadded .text in the order of HMAC-SHA-256 keyed by "<seed>:<i>" over the name less a ThinLTO
// suffix.
const LISTED = ["_start", "_ZN5probe4main17h0123456789abcdefE.llvm.123", "_ZN5probe4page17hfedcba9876543210E", "crc", "flush", "flush_tail"];
const lines = (text) => text.replace(/\n$/, "").split("\n");

test("an ordering file: the pad and then the side's functions, by a key any host computes alike", () => {
  // Pinned: HMAC-SHA-256 is the same on every host (this key is also what .NET's HMACSHA256 gives).
  assert.equal(key(7, 1, "crc"), "5b3ec28337221d6e8f96f2a5417343f09927f053866d7416ab19670a8b7f2262");
  assert.equal(key(7, 1, "_ZN5probe4main17h0123456789abcdefE.llvm.123"), key(7, 1, "_ZN5probe4main17h0123456789abcdefE.llvm.987"));
  assert.equal(order(LISTED, 7, 1), "corten_layout_pad\nflush\n_ZN5probe4main17h0123456789abcdefE.llvm.123\ncrc\n_ZN5probe4page17hfedcba9876543210E\n_start\nflush_tail\n");
  // The same list, seed and index give the same bytes, whatever order the list is given in.
  assert.equal(order([...LISTED].reverse(), 7, 1), order(LISTED, 7, 1));
  // Each index draws another order, and so does another seed: K placements sample K layouts.
  const many = Array.from({ length: 30 }, (_, k) => `fn_${k}`);
  const drawn = Array.from({ length: 10 }, (_, k) => order(many, 7, k + 1));
  assert.equal(new Set(drawn).size, 10);
  assert.notEqual(order(many, 8, 1), drawn[0]);
  for (const o of drawn) assert.deepEqual([lines(o)[0], [...lines(o).slice(1)].sort()], ["corten_layout_pad", [...many].sort()]);
});

test("an ordering file: base and head at one index lay the functions they share in one order", () => {
  // Head adds a function, drops one, and its ThinLTO suffixes differ from base's.
  const base = [...Array.from({ length: 40 }, (_, k) => `shared_${k}`), "base_only", "_ZN5probe4main17h0123456789abcdefE.llvm.123"];
  const head = [...Array.from({ length: 40 }, (_, k) => `shared_${k}`), "head_only", "_ZN5probe4main17h0123456789abcdefE.llvm.987"];
  const shared = (o) => lines(o).slice(1).map((n) => n.replace(/\.llvm\.\d+$/, "")).filter((n) => n.startsWith("shared_") || n.startsWith("_ZN"));
  for (const i of [1, 2, 3]) {
    assert.deepEqual(shared(order(base, 11, i)), shared(order(head, 11, i)), `index ${i}`);
    assert.equal(shared(order(base, 11, i)).length, 41);
  }
  assert.notDeepEqual(shared(order(base, 11, 1)), shared(order(base, 11, 2)));
});

test("an ordering file is refused for a list it cannot be drawn from", () => {
  assert.equal(namesProblem([]), "it names no function");
  assert.equal(namesProblem(["a", ""]), "it has an empty line");
  assert.equal(namesProblem(["a", "a"]), "it names a function twice");
  assert.equal(namesProblem(["a", "corten_layout_pad"]), "it names a pad's function");
  assert.equal(namesProblem(["a", "corten_layout_pad2"]), "it names a pad's function");
  assert.equal(namesProblem(LISTED), null);
  assert.throws(() => order(["a", "a"], 7, 1), /names a function twice/);
  for (const [seed, i] of [[-1, 1], [7, 0], [7, 1.5], ["7", 1]]) assert.throws(() => order(LISTED, seed, i), /no usable seed or index/);
  // A functions file, as build.sh writes it and as the results keep it, gzipped.
  const file = LISTED.map((n) => `${n}\n`).join("");
  assert.deepEqual(names(Buffer.from(file)), LISTED);
  assert.deepEqual(names(gzipSync(file)), LISTED);
});

// A side's unpadded .text in input sections, laid as LLD lays them, and placements linked with an
// ordering file: each section at the place of the first of its functions the file names (the
// pad first), sections no name places after them in their own order, every section 16-aligned.
// A section is what the unpadded map gives (file, section name, address, size, symbols) with its
// functions as nm gives them; the map's symbols are its functions unless given.
const SEC = (file, section, at, size, fns, symbols = fns.map(([name, off]) => ({ name, at: at + off }))) => ({ file, section, at, size, fns, symbols });
const T = 0x201000, SECTIONS = [
  SEC("/usr/lib/x86_64-linux-gnu/Scrt1.o", ".text", 0x201000, 0x30, [["_start", 0]]),
  SEC("/t/release/deps/probe.probe.0.rcgu.o", ".text._ZN5probe4main17h0123456789abcdefE", 0x201030, 0x2c0, [["_ZN5probe4main17h0123456789abcdefE.llvm.123", 0]]),
  SEC("/t/release/deps/probe.probe.0.rcgu.o", ".text._ZN5probe4page17hfedcba9876543210E", 0x2012f0, 0x4e0, [["_ZN5probe4page17hfedcba9876543210E", 0]]),
  SEC("/t/release/build/c/out/libc.a(compress.o)", ".text.flush", 0x2017d0, 0x400, [["flush", 0], ["flush_tail", 0x200]]),
  SEC("/t/release/build/c/out/libc.a(crc.o)", ".text.crc", 0x201bd0, 0x70, [["crc", 0]]),
  SEC("/t/release/build/c/out/libc.a(a.o)", ".text.helper", 0x201c40, 0x20, [["helper", 0]]),
  SEC("/t/release/build/c/out/libc.a(b.o)", ".text.helper", 0x201c60, 0x20, [["helper", 0]]),
];
/** A section with more functions, its map symbols with them. */
const adding = (s, more) => SEC(s.file, s.section, s.at, s.size, [...s.fns, ...more]);
// A shuffled check reads functions from the ELF symbol table, each with its output section's
// index: .text's is 14 here, .init's (where _init is) 12, and 15 the next output section's.
const TEXT = { index: 14, start: T, size: 0xc80 }, INIT = ["_init", 0x200f00, 12];
/**
 * readelf -sW's two tables for functions [name, address, section index (14, .text's, unless
 * given), size, file]: .dynsym, which is not read, then .symtab, its local symbols first, as LLD
 * writes them: those given a file (a local copy compiled in that object) after that file's symbol
 * (STT_FILE), each object's together; the rest global. A file `util.c@a` is object a's, its file
 * symbol written `util.c`: objects compiled from files of one name, each with a file symbol of its own.
 */
const elf = (fns) => {
  const fn = ([name, at, shndx = 14, size = 0], bind) => `${at.toString(16).padStart(16, "0")} ${String(size).padStart(5)} FUNC    ${bind} DEFAULT ${String(shndx).padStart(4)} ${name}`;
  const file = (name) => `0000000000000000     0 FILE    LOCAL  DEFAULT  ABS ${name.replace(/@.*$/, "")}`;
  const rows = ["0000000000000000     0 NOTYPE  LOCAL  DEFAULT  UND ", file("probe.o")];
  for (const f of new Set(fns.filter((x) => x[4] != null).map((x) => x[4]))) rows.push(file(f), ...fns.filter((x) => x[4] === f).map((x) => fn(x, "LOCAL ")));
  rows.push(...fns.filter((x) => x[4] == null).map((x) => fn(x, "GLOBAL")), "0000000000300000     8 OBJECT  GLOBAL DEFAULT   20 some_data");
  return ["", "Symbol table '.dynsym' contains 2 entries:", "   Num:    Value          Size Type    Bind   Vis      Ndx Name", "     0: 0000000000000000     0 NOTYPE  LOCAL  DEFAULT  UND ", "     1: 0000000000201000    16 FUNC    GLOBAL DEFAULT   14 dynamic_only",
    "", `Symbol table '.symtab' contains ${rows.length} entries:`, "   Num:    Value          Size Type    Bind   Vis      Ndx Name", ...rows.map((r, k) => `${String(k).padStart(6)}: ${r}`)].join("\n") + "\n";
};
/** A section's functions are [name, offset, section index, file]: the file, when given, the local copy's object's file symbol. */
const unpaddedNm = (sections) => elf([INIT, ...sections.flatMap((s) => s.fns.map(([n, off, shndx, file]) => [n, s.at + off, shndx, 0, file]))]);
const UNPADDED_NM = unpaddedNm(SECTIONS);
/** A section as a map gives it: with its id. */
const ided = (sections) => sections.map((s) => ({ ...s, id: `${s.file}:(${s.section})` }));
/** One side of a shuffled change for alike(): its unpadded binary, a placement linked with file, and what ordered() takes. */
const sideOf = (sections, file, { placed = PLACED, ...o } = {}) => {
  const last = sections.reduce((x, s) => Math.max(x, s.at + s.size), T), l = link(file, { sections, ...o });
  return { ea: elfSymbols(unpaddedNm(sections)), eb: elfSymbols(l.nm), text: { index: 14, start: T, size: last - T }, placed, order: lines(file), sections: ided(sections), placedSections: l.map };
};
// A link is its symbol table (elf()) and its map's input sections of .text: the pad's, then each laid section at its
// place (LLD's: the first place the file gives any of its map's symbols) with its symbols, then
// the second pad's when extra names it. Options break the layout:
// turn swaps two laid sections, reorder lays them in another order, drop leaves out every
// definition of a name and dropOne its first (from nm, not the map), move moves a definition in
// nm alone, below links the first laid section under .text (its functions of another output
// section), and sections links another side's.
const link = (file, { pad = 320, padAt = T, turn = null, reorder = (x) => x, drop = [], dropOne = null, extra = [], move = {}, below = false, sections = SECTIONS } = {}) => {
  const pos = new Map();
  lines(file).forEach((n, k) => { if (!pos.has(n)) pos.set(n, k); });
  const laid = reorder(sections.map((s, k) => ({ s, k, p: Math.min(...s.symbols.map((y) => pos.get(y.name) ?? Infinity)) })).sort((a, b) => a.p - b.p || a.k - b.k));
  if (turn) [laid[turn[0]], laid[turn[1]]] = [laid[turn[1]], laid[turn[0]]];
  let dot = T + pad, dropped = false;
  const fns = [["corten_layout_pad", padAt], INIT], map = [{ file: `/w/pads/pad-${pad}.o`, section: PAD, id: `/w/pads/pad-${pad}.o:(${PAD})`, at: T, size: pad, align: 16, symbols: [{ name: "corten_layout_pad", at: padAt }] }];
  laid.forEach(({ s }, k) => {
    const at = below && k === 0 ? T - 0x800 : dot;
    map.push({ ...s, id: `${s.file}:(${s.section})`, at, symbols: s.symbols.map((y) => ({ name: y.name, at: y.at - s.at + at })) });
    for (const [n, off, shndx, f] of s.fns) {
      if (drop.includes(n) || (n === dropOne && !dropped && (dropped = true))) continue;
      fns.push([n, at + off + (move[n] ?? 0), below && k === 0 ? 13 : shndx, 0, f]);
    }
    if (!(below && k === 0)) dot += s.size;
  });
  for (const [n, at] of extra) if (n === "corten_layout_pad2") map.push({ file: "/w/pads/pad2-16.o", section: SECOND_PAD, id: `/w/pads/pad2-16.o:(${SECOND_PAD})`, at, size: 16, align: 16, symbols: [{ name: n, at }] });
  return { nm: elf([...fns, ...extra]), map };
};
const PLACED = { index: 14, start: T, size: 0x1000 };
const shuffledCheck = (file, b, o = {}) => ordered(elfSymbols(UNPADDED_NM), elfSymbols(b.nm), TEXT, { ...PLACED, ...o.placed }, lines(file), ided(SECTIONS), b.map, o.pad ?? 320, o.second ?? false);

test("a shuffled placement: its side's functions and the pad, the pad first, in its ordering file's order", () => {
  assert.deepEqual(textRange("  [14] .text             PROGBITS        0000000000201000 001000 000c80 00  AX  0   0 64\n"), TEXT);
  // What an ordering file lists: each function of .text once (a repeated name once), nothing outside it.
  const listed = textFunctions(elfSymbols(UNPADDED_NM), TEXT);
  assert.deepEqual(listed, ["_ZN5probe4main17h0123456789abcdefE.llvm.123", "_ZN5probe4page17hfedcba9876543210E", "_start", "crc", "flush", "flush_tail", "helper"]);
  const file = order(listed, 7, 3), ok = shuffledCheck(file, link(file));
  assert.deepEqual(ok.why, []);
  assert.deepEqual([ok.ok, ok.shuffled, ok.functions, ok.repeated, ok.sections, ok.groups, ok.tied, ok.matched, ok.placedSections, ok.together, ok.follow, ok.listed], [true, true, 8, 1, 7, 6, 2, 8, 7, 8, 7, 7]);
  // Another index's file is another order: this link is not in it.
  const other = order(listed, 7, 4);
  assert.notEqual(other, file);
  has(shuffledCheck(other, link(file)).why, "definitions where the ordering file puts them");
  // The unshuffled link, every function moved by the pad alone, is not this file's order either.
  has(shuffledCheck(file, link("corten_layout_pad\n" + SECTIONS.flatMap((s) => s.fns.map(([n]) => n)).join("\n"))).why, "definitions where the ordering file puts them");
  const why = (o, b = link(file), f = file) => shuffledCheck(f, b, o).why;
  // Two sections in the other order.
  has(why({}, link(file, { turn: [1, 2] })), "definitions where the ordering file puts them: 6 of 8, in 5 of 7 input sections");
  // A function missing from the placement, and one only in it.
  has(why({}, link(file, { drop: ["crc"] })), "1 functions only in the unpadded binary: crc");
  has(why({}, link(file, { extra: [["ghost", 0x209000]] })), "only in the placement: corten_layout_pad, ghost");
  // The pad not first in .text; the file not naming the pad first.
  has(why({}, link(file, { padAt: T + 0x40 })), "the pad is not at the start of .text");
  has(why({ placed: { start: T - 0x40 } }), "the pad is not at the start of .text");
  const rotated = [...lines(file).slice(1), "corten_layout_pad"].join("\n");
  has(why({}, link(rotated), rotated), "the ordering file's first name is");
  // A file that leaves a function out, names one twice, or names one .text does not hold.
  const less = lines(file).filter((n) => n !== "crc").join("\n");
  has(why({}, link(less), less), "1 functions of the unpadded .text not in the ordering file: crc");
  const doubled = `${file}flush\n`;
  has(why({}, link(doubled), doubled), "1 names more than once in the ordering file");
  const ghost = `${file}ghost\n`;
  has(why({}, link(ghost), ghost), "1 names in the ordering file that are no function of the unpadded .text: ghost");
  // A function moved away from the rest of its input section.
  has(why({}, link(file, { move: { flush_tail: 16 } })), "1 of 8 functions not in the placement's input section of their unpadded one");
  // With code aligned beyond 16 bytes: both pads.
  const two = link(file, { extra: [["corten_layout_pad2", T + 0xe00]] });
  assert.deepEqual(why({ second: true }, two), []);
  has(why({}, two), "only in the placement: corten_layout_pad, corten_layout_pad2, not corten_layout_pad");
  has(why({ second: true }), "not corten_layout_pad and corten_layout_pad2");
});

test("a shuffled placement: a name defined more than once is checked by its input sections, each definition in its place", () => {
  const file = order(textFunctions(elfSymbols(UNPADDED_NM), TEXT), 7, 3), why = (b) => shuffledCheck(file, b).why;
  // One of helper's two definitions gone.
  has(why(link(file, { dropOne: "helper" })), "the placement's .text holds 7 definitions of functions besides the pad, not the unpadded .text's 8");
  // A section of helper's laid against the drawn order: first when it is not first, last when it is.
  const moved = (laid) => {
    const k = laid.findIndex((u) => u.s.fns[0][0] === "helper"), [u] = laid.splice(k, 1);
    return k > 0 ? [u, ...laid] : [...laid, u];
  };
  has(why(link(file, { reorder: moved })), "definitions where the ordering file puts them");
  // Both of helper's sections in their drawn places pass, and are counted among the definitions.
  assert.deepEqual([shuffledCheck(file, link(file)).ok, shuffledCheck(file, link(file)).functions], [true, 8]);
});

test("a shuffled placement: every function inside its .text, after the whole pad, and before the second pad", () => {
  const file = order(textFunctions(elfSymbols(UNPADDED_NM), TEXT), 7, 3), why = (b, o) => shuffledCheck(file, b, o).why;
  // Linked after a 16-byte pad where the plan's is 320 bytes: the pad's symbol is first, but the functions begin inside it.
  has(why(link(file, { pad: 16 })), "the functions do not all follow the pad");
  // The first laid section linked under .text, before the pad, the rest in order.
  has(why(link(file, { below: true })), "the placement's .text holds");
  // The last section running past the end of .text, and past a second pad laid among the functions.
  has(why(link(file), { placed: { size: 0x140 + 0xc80 - 0x10 } }), "past the end of .text");
  has(why(link(file, { extra: [["corten_layout_pad2", T + 0xd00]] }), { second: true }), "past the second pad");
  assert.deepEqual(why(link(file, { extra: [["corten_layout_pad2", T + 0xdc0]] }), { second: true }), []);
});

test("a shuffled change: base's and head's placements at one index lay the functions each defines once in one order", () => {
  const names = (sections) => textFunctions(elfSymbols(unpaddedNm(sections)), { index: 14, start: T, size: sections.reduce((x, s) => Math.max(x, s.at + s.size), T) - T });
  const base = order(names(SECTIONS), 7, 3);
  // Head drops crc and adds a function of its own in a section of its own: what both have lies alike.
  const own = [...SECTIONS.filter((s) => s.fns[0][0] !== "crc"), SEC("/t/release/deps/probe.probe.0.rcgu.o", ".text.head_only", 0x201c80, 0x40, [["head_only", 0]])];
  for (const i of [1, 2, 3]) {
    const r = alike(sideOf(SECTIONS, order(names(SECTIONS), 7, i)), sideOf(own, order(names(own), 7, i)), 320);
    assert.deepEqual(r.why, [], `index ${i}`);
    // Six names both have; helper, defined twice on each side, is left out and counted.
    assert.deepEqual([r.ok, r.shuffled, r.shared, r.compared, r.leftOut, r.onlyBase, r.onlyHead], [true, true, 6, 5, 1, 1, 1]);
  }
  // A symbol head alone has, in a section base has too, can give that section another place,
  // though the two files list the names both have in one order and each placement passes its own check.
  let found = null;
  for (let k = 0; k < 200 && !found; k++) {
    const alias = `alias_${k}`, sections = SECTIONS.map((s) => (s.fns[0][0] === "crc" ? adding(s, [[alias, 0x10]]) : s)), h = order(names(sections), 7, 3);
    assert.deepEqual(lines(h).filter((n) => n !== alias), lines(base));
    const r = alike(sideOf(SECTIONS, base), sideOf(sections, h), 320);
    if (!r.ok) found = r;
  }
  assert.ok(found, "no alias moves crc's section");
  has(found.why, "names both placements define exactly once do not lie in one order");
  // A placement that fails its own check is no reading of the two.
  assert.throws(() => alike(sideOf(SECTIONS, base, { turn: [1, 2] }), sideOf(SECTIONS, base), 320), /base's placement does not pass its own shuffled check/);
});

// A name defined more than once (local functions of one name in two objects) with two other
// functions: a, b, then dup's two sections, each of its own object.
const DUPS = [
  SEC("/o/a.o", ".text.a", T, 0x40, [["a", 0]]),
  SEC("/o/b.o", ".text.b", T + 0x40, 0x40, [["b", 0]]),
  SEC("/o/x1.o", ".text.dup", T + 0x80, 0x40, [["dup", 0]]),
  SEC("/o/x2.o", ".text.dup", T + 0xc0, 0x40, [["dup", 0]]),
];

test("a shuffled change: a name defined more than once on a side is left out and counted, whatever tells its copies apart", () => {
  const file = (...n) => ["corten_layout_pad", ...n].join("\n") + "\n";
  const base = sideOf(DUPS, file("a", "b", "dup"));
  // Head's alias in x1.o's section of dup, named first: that section moves ahead of a and b, which
  // keep their order. dup is no one function on either side, so it is not compared, and the
  // change passes on a and b with dup counted as left out.
  const aliased = DUPS.map((s) => (s.file === "/o/x1.o" ? adding(s, [["alias", 0x10]]) : s));
  const ahead = alike(base, sideOf(aliased, file("alias", "a", "b", "dup")), 320);
  assert.deepEqual(ahead.why, []);
  assert.deepEqual([ahead.shared, ahead.compared, ahead.leftOut, ahead.onlyHead], [3, 2, 1, 1]);
  // Copies nothing tells apart (two archives of one name), copies trading sizes, renamed sections
  // or objects: each is a name defined more than once, left out, never matched by what it is in.
  const same = DUPS.map((s, k) => (k === 2 ? { ...s, file: "/p/libu.a(u.o)" } : k === 3 ? { ...s, file: "/q/libu.a(u.o)" } : s));
  const renamed = DUPS.map((s, k) => (k === 2 ? { ...s, file: "/o/renamed.o", section: ".text.dup_renamed" } : s));
  for (const other of [same, renamed]) {
    const r = alike(base, sideOf(other, file("a", "b", "dup")), 320);
    assert.deepEqual([r.ok, r.compared, r.leftOut], [true, 2, 1]);
  }
  // A name defined once in base and twice in head is left out too.
  const once = sideOf(DUPS.slice(0, 3), file("a", "b", "dup"));
  assert.deepEqual([alike(once, base, 320).compared, alike(once, base, 320).leftOut], [2, 1]);
  // Fewer than FEWEST names compared refuse the change: one name has no order.
  const lone = alike(sideOf(DUPS.slice(1), file("b", "dup")), sideOf(DUPS.slice(1), file("b", "dup")), 320);
  assert.deepEqual([lone.ok, lone.compared, lone.leftOut, FEWEST], [false, 1, 1, 2]);
  has(lone.why, "only 1 of the 2 names both placements have are defined exactly once on each side, fewer than the 2 an order needs");
});

test("a shuffled change: a name is one function only where the symbol table and the map agree it is defined once", () => {
  const file = (...n) => ["corten_layout_pad", ...n].join("\n") + "\n", secs = DUPS.slice(0, 2).concat([SEC("/o/c.o", ".text.c", T + 0x80, 0x40, [["c", 0]])]);
  const base = sideOf(secs, file("a", "b", "c"));
  assert.deepEqual([alike(base, base, 320).compared, alike(base, base, 320).leftOut], [3, 0]);
  // A label (NOTYPE) named c in b's section, which the map lists and the symbol table does not
  // say is a function: two definitions of c on that side, so c is left out.
  const label = secs.map((s) => (s.section === ".text.b" ? { ...s, symbols: [...s.symbols, { name: "c", at: s.at + 0x20 }] } : s));
  const r = alike(base, sideOf(label, file("a", "b", "c")), 320);
  assert.deepEqual([r.ok, r.compared, r.leftOut], [true, 2, 1]);
  // An object named a in .data, in the symbol table and the map's .data: a is left out.
  const x = sideOf(secs, file("a", "b", "c"));
  const data = { ...x, eb: [...x.eb, { raw: "a", name: "a", type: "OBJECT", local: true, at: 0x300000, size: 8, shndx: 20 }], elsewhere: [] };
  assert.deepEqual([alike(base, data, 320).compared, alike(base, data, 320).leftOut], [2, 1]);
  // The map listing a at another address than the symbol table's: the two disagree, a is left out.
  const shifted = secs.map((s) => (s.section === ".text.a" ? { ...s, symbols: [{ name: "a", at: s.at + 0x10 }] } : s));
  assert.deepEqual([alike(base, sideOf(shifted, file("a", "b", "c")), 320).compared, alike(base, sideOf(shifted, file("a", "b", "c")), 320).leftOut], [2, 1]);
});

test("a shuffled change: names a ThinLTO suffix alone sets apart are one function, and names defined once that share a place are compared each by its name", () => {
  const file = (...n) => ["corten_layout_pad", ...n].join("\n") + "\n";
  // f renumbered from f.llvm.1 to f.llvm.9 between the sides: one function of both, compared.
  const fs = (n) => [SEC("/o/a.o", ".text.a", T, 0x40, [["a", 0]]), SEC("/o/f.o", ".text.f", T + 0x40, 0x40, [[`f.llvm.${n}`, 0]]), SEC("/o/b.o", ".text.b", T + 0x80, 0x40, [["b", 0]])];
  const r = alike(sideOf(fs(1), file("a", "f.llvm.1", "b")), sideOf(fs(9), file("a", "f.llvm.9", "b")), 320);
  assert.deepEqual([r.ok, r.shared, r.compared, r.leftOut], [true, 3, 3, 0]);
  // A and B folded to one address (ICF) in base, apart in head: the place holds A and B in one and
  // A alone in the other, and the change is refused; every name at a place is compared.
  const folded = [SEC("/o/m.o", ".text.m", T, 0x40, [["m", 0]]), SEC("/o/a.o", ".text.x", T + 0x40, 0x40, [["A", 0], ["B", 0]]), SEC("/o/c.o", ".text.c", T + 0x80, 0x40, [["C", 0]])];
  const apart = [folded[0], SEC("/o/a.o", ".text.x", T + 0x40, 0x40, [["A", 0]]), SEC("/o/b.o", ".text.y", T + 0x80, 0x40, [["B", 0]]), SEC("/o/c.o", ".text.c", T + 0xc0, 0x40, [["C", 0]])];
  const f2 = file("m", "A", "B", "C"), self = alike(sideOf(folded, f2), sideOf(folded, f2), 320);
  assert.deepEqual([self.ok, self.compared, self.places], [true, 4, 3]);
  const split = alike(sideOf(folded, f2), sideOf(apart, f2), 320);
  assert.equal(split.ok, false);
  has(split.why, "place 2 holds A and B in the first and A in the second");
});

// A function symbol of no size at the end of .text.a, where .text.b begins: the map lists it under
// .text.a, though its address is also .text.b's start.
const ENDS = [SEC("/o/a.o", ".text.a", T, 0x40, [["a", 0], ["end_a", 0x40]]), SEC("/o/b.o", ".text.b", T + 0x40, 0x40, [["b", 0]])];

test("a shuffled placement: a symbol at the end of one input section and the start of the next is the section's the map lists it in", () => {
  const check = (sections, names) => {
    const file = ["corten_layout_pad", ...names].join("\n") + "\n", x = sideOf(sections, file);
    return ordered(x.ea, x.eb, x.text, x.placed, x.order, x.sections, x.placedSections, 320);
  };
  // b's section first: end_a goes with a's section, after it.
  const bFirst = check(ENDS, ["b", "a", "end_a"]);
  assert.deepEqual(bFirst.why, []);
  assert.deepEqual([bFirst.functions, bFirst.sections, bFirst.matched, bFirst.placedSections, bFirst.together], [3, 2, 3, 2, 3]);
  // a's section first: in the placement end_a and b share one address, end_a the end of a's section.
  assert.deepEqual(check(ENDS, ["a", "end_a", "b"]).why, []);
  // end_a laid elsewhere than at the end of a's section is still refused.
  const x = sideOf(ENDS, "corten_layout_pad\nb\na\nend_a\n", { move: { end_a: 16 } });
  has(ordered(x.ea, x.eb, x.text, x.placed, x.order, x.sections, x.placedSections, 320).why, "not in the placement's input section of their unpadded one, as far from its start");
  // Both sections list a symbol at that address and neither by nm's name (the map writes a mangled
  // name demangled): which section holds it is not established, and the check fails.
  const mangled = [SEC("/o/a.o", ".text.a", T, 0x40, [["a", 0], ["_ZN1a3endE", 0x40]], [{ name: "a", at: T }, { name: "a::end", at: T + 0x40 }]), ENDS[1]];
  has(check(mangled, ["b", "a", "_ZN1a3endE"]).why, "1 functions of the unpadded .text at an address its map's symbols there do not give to one input section: _ZN1a3endE");
});

// Each placed definition is of the input section the placement's own map has it in, and the order
// is that map's: what the four cases below hold (the third review of the shuffled path, each first
// seen with real LLD 19.1.7 links, which the Linux test after them makes again).
const own = (x) => ordered(x.ea, x.eb, x.text, x.placed, x.order, x.sections, x.placedSections, 320, false, x.elsewhere ?? []);
const named = (...n) => ["corten_layout_pad", ...n].join("\n") + "\n";

test("a shuffled placement: sections the file gives one key are one group, laid in any order among themselves and nowhere else", () => {
  // x.o's and y.o's local dup, each a section of its own: the file gives both dup's place (one
  // key), and LLD sorts the sections by that key alone, not stably, so either order is a link of
  // the file (a real Rust probe ties 67 sections so, and LLD lays some of them out of their
  // unpadded order).
  const dups = [SEC("/o/a.o", ".text.a", T, 0x40, [["a", 0]]), SEC("/o/x.o", ".text.dup", T + 0x40, 0x40, [["dup", 0, 14, "x.o"]]), SEC("/o/y.o", ".text.dup", T + 0x80, 0x40, [["dup", 0, 14, "y.o"]])];
  const right = sideOf(dups, named("a", "dup")), turned = sideOf(dups, named("a", "dup"), { reorder: (laid) => [laid[0], laid[2], laid[1]] });
  assert.deepEqual([own(right).why, own(turned).why], [[], []]);
  for (const x of [right, turned]) {
    const r = own(x);
    assert.deepEqual([r.functions, r.sections, r.groups, r.tied, r.matched, r.placedSections, r.together], [3, 3, 2, 2, 3, 3, 3]);
  }
  assert.deepEqual(own(turned).defs.filter((d) => d.name === "dup").map((d) => d.section.file), ["/o/y.o", "/o/x.o"]);
  // A section of the group laid away from it, before a, is refused, the definitions counted.
  has(own(sideOf(dups, named("a", "dup"), { reorder: (laid) => [laid[2], laid[0], laid[1]] })).why, "definitions where the ordering file puts them: 1 of 3, in 1 of 3 input sections (sections of one key together, in any order among themselves); the first place that differs, 1, holds /o/y.o:(.text.dup) (dup), where the file puts /o/a.o:(.text.a) (a)");
  // Base laying the group x, y and head y, x: dup is defined twice on each side and left out; a
  // and b, each defined once, lie alike.
  const tied = [...dups, SEC("/o/b.o", ".text.b", T + 0xc0, 0x40, [["b", 0]])];
  const r = alike(sideOf(tied, named("a", "dup", "b")), sideOf(tied, named("a", "dup", "b"), { reorder: (laid) => [laid[0], laid[2], laid[1], laid[3]] }), 320);
  assert.deepEqual([r.why, r.compared, r.leftOut], [[], 2, 1]);
  // A name defined once in a section of the group lies where LLD's unstable sort puts that
  // section: base and head laying the group's two sections the other way round lay hot_x and
  // hot_y the other way round, and the change is refused, though both are links of the file.
  const hot = tied.map((s) => (s.file === "/o/x.o" ? adding(s, [["hot_x", 0x10]]) : s.file === "/o/y.o" ? adding(s, [["hot_y", 0x10]]) : s));
  const file = named("a", "dup", "b", "hot_x", "hot_y");
  const swapped = alike(sideOf(hot, file), sideOf(hot, file, { reorder: (laid) => [laid[0], laid[2], laid[1], laid[3]] }), 320);
  assert.equal(swapped.ok, false);
  has(swapped.why, "the 4 names both placements define exactly once do not lie in one order: place 2 holds hot_x in the first and hot_y in the second");
});

test("a shuffled change: copies whose names differ by a ThinLTO suffix alone are one name defined more than once, left out", () => {
  // x.o's and y.o's local f, each a section of its own, written f.llvm.<n>: f is defined twice on
  // each side, so it is left out, whatever order the suffixes give the two sections (a rebuild of
  // the same code renumbers them). a and b, each defined once, are compared.
  const copies = (nx, ny) => [SEC("/o/a.o", ".text.a", T, 0x40, [["a", 0]]), SEC("/o/x.o", ".text.f", T + 0x40, 0x40, [[`f.llvm.${nx}`, 0, 14, "x.o"]]), SEC("/o/y.o", ".text.f", T + 0x80, 0x40, [[`f.llvm.${ny}`, 0, 14, "y.o"]]), SEC("/o/b.o", ".text.b", T + 0xc0, 0x40, [["b", 0]])];
  const base = sideOf(copies(1, 2), named("a", "f.llvm.1", "f.llvm.2", "b")), head = sideOf(copies(9, 3), named("a", "f.llvm.3", "f.llvm.9", "b"));
  assert.deepEqual([own(base).why, own(head).why], [[], []]);
  assert.deepEqual([base, head].map((x) => own(x).defs.filter((d) => d.name === "f").map((d) => d.section.file)), [["/o/x.o", "/o/y.o"], ["/o/y.o", "/o/x.o"]]);
  const r = alike(base, head, 320);
  assert.deepEqual([r.why, r.shared, r.compared, r.leftOut], [[], 3, 2, 1]);
});

test("a shuffled placement: a function in an input section of no size is of that section, where the next section begins too", () => {
  // zero_empty, in an empty section of its own, shares its unpadded address with a_next, the start
  // of the next section; marker follows.
  const zero = [SEC("/o/z.o", ".text.zero_empty", T, 0, [["zero_empty", 0]]), SEC("/o/n.o", ".text.a_next", T, 0x40, [["a_next", 0]]), SEC("/o/m.o", ".text.marker", T + 0x40, 0x40, [["marker", 0]])];
  const asked = named("zero_empty", "marker", "a_next"), other = named("zero_empty", "a_next", "marker");
  // LLD's link for the file: zero_empty's section, then marker's, then a_next's.
  const right = sideOf(zero, asked);
  assert.deepEqual(right.placedSections.slice(1).map((s) => s.section), [".text.zero_empty", ".text.marker", ".text.a_next"]);
  assert.deepEqual(own(right).why, []);
  assert.deepEqual([own(right).functions, own(right).sections, own(right).matched], [3, 3, 3]);
  // A link made with the other file, checked against this one, is refused.
  has(own({ ...sideOf(zero, other), order: lines(asked) }).why, "definitions where the ordering file puts them");
});

test("a shuffled change: definitions at one address are in the order of the input sections the placement's map lays", () => {
  // Base's z_end ends .text.z where a_next begins; head adds head_only's section between them,
  // in its unpadded order. Drawn at seed 7, index 1, both files give z's section the first place
  // (z_end is drawn first), head_only the second, a_next the last.
  const base = [SEC("/o/z.o", ".text.z", T, 0x40, [["z", 0], ["z_end", 0x40]]), SEC("/o/n.o", ".text.a_next", T + 0x40, 0x40, [["a_next", 0]])];
  const head = [base[0], SEC("/o/h.o", ".text.head_only", T + 0x40, 0x40, [["head_only", 0]]), { ...base[1], at: T + 0x80, symbols: [{ name: "a_next", at: T + 0x80 }] }];
  const fileOf = (sections) => order(textFunctions(elfSymbols(unpaddedNm(sections)), { index: 14, start: T, size: sections.at(-1).at + sections.at(-1).size - T }), 7, 1);
  assert.equal(fileOf(head), named("z_end", "head_only", "z", "a_next"));
  const b = sideOf(base, fileOf(base)), h = sideOf(head, fileOf(head));
  assert.deepEqual([own(b).why, own(h).why], [[], []]);
  // In base's placement z_end and a_next share one address, z's section laid first.
  assert.equal(b.eb.find((e) => e.raw === "z_end").at, b.eb.find((e) => e.raw === "a_next").at);
  const r = alike(b, h, 320);
  assert.deepEqual(r.why, []);
  // Three names, each defined once, at three places: z and z_end at its end in z's section, then
  // a_next, though z_end and a_next share an address in base's placement.
  assert.deepEqual([r.shared, r.compared, r.places, r.same], [3, 3, 3, 3]);
});

test("a shuffled placement: a function of no size at the very end of .text is of the input section the map has it in", () => {
  // Head's alias, drawn first, puts .text.b before .text.a, so z_end, the end of .text.a, is the
  // end of the placement's .text.
  const head = [SEC("/o/a.o", ".text.a", T, 0x40, [["a", 0], ["z_end", 0x40]]), SEC("/o/b.o", ".text.b", T + 0x40, 0x40, [["b", 0], ["alias", 0x10]])];
  const x = sideOf(head, named("alias", "b", "a", "z_end"), { placed: { index: 14, start: T, size: 320 + 0x80 } });
  assert.equal(x.eb.find((e) => e.raw === "z_end").at, x.placed.start + x.placed.size);
  const r = own(x);
  assert.deepEqual(r.why, []);
  assert.deepEqual([r.functions, r.together], [4, 4]);
  // A definition of .text there the map gives no input section is refused, not left out.
  const off = { ...x, placedSections: x.placedSections.map((s) => (s.section === ".text.a" ? { ...s, symbols: s.symbols.filter((y) => y.name !== "z_end") } : s)) };
  has(own(off).why, "the placement's .text holds 3 definitions of functions besides the pad, not the unpadded .text's 4");
  has(own(off).why, "1 functions of the placement's .text in no input section of its map: z_end");
});

// What the fourth review of the shuffled path found, each first seen with real LLD 19.1.7 links
// (the second Linux test below makes them again): a function is of .text by its symbol's section
// index, in the list an ordering file is drawn from and in the checks alike.

test("a shuffled placement: a function of no size at the unpadded end of .text is drawn and checked; one at that address in the next output section is neither", () => {
  // e's section is the last of .text: z_end is its end and .text's.
  const sections = [SEC("/o/m.o", ".text.middle", T, 0x40, [["middle", 0]]), SEC("/o/a.o", ".text.a", T + 0x40, 0x40, [["a", 0]]), SEC("/o/e.o", ".text.e", T + 0x80, 0x40, [["e", 0], ["z_end", 0x40]])];
  const text = { index: 14, start: T, size: 0xc0 }, ea = elfSymbols(unpaddedNm(sections));
  assert.equal(ea.find((e) => e.raw === "z_end").at, text.start + text.size);
  const listed = textFunctions(ea, text);
  assert.deepEqual(listed, ["a", "e", "middle", "z_end"]);
  const file = order(listed, 0, 1), x = sideOf(sections, file);
  assert.deepEqual(own(x).why, []);
  assert.deepEqual([own(x).functions, own(x).together], [4, 4]);
  // A file drawn without it, as an address range ending before .text's end drew it, is refused.
  has(own({ ...x, order: lines(file).filter((n) => n !== "z_end") }).why, "1 functions of the unpadded .text not in the ordering file: z_end");
  // A function at that address in the next output section (index 15) is not of .text, in the list or in either binary.
  const other = { ...x, ea: [...x.ea, ...elfSymbols(elf([["next_first", T + 0xc0, 15]]))], eb: [...x.eb, ...elfSymbols(elf([["next_first", T + 320 + 0xc0, 15]]))] };
  assert.deepEqual(textFunctions(other.ea, text), listed);
  assert.deepEqual([own(other).why, own(other).functions], [[], 4]);
  // Membership is the section index alone: without one it is not guessed from an address.
  assert.throws(() => inText({ raw: "f", at: T }, text), /no section index/);
  assert.throws(() => textFunctions(entries(nm([["f", T]])), text), /no section index/);
});

test("a shuffled placement: a local name of no size at the end of .text and the same name where the next output section begins are told apart by their sections", () => {
  // zz's section is empty and last in .text, holding a local dup; the next output section's first
  // function is another local dup at the same address. Only the first is of .text.
  const sections = [SEC("/o/m.o", ".text.middle", T, 0x40, [["middle", 0]]), SEC("/o/a.o", ".text.a", T + 0x40, 0x40, [["a", 0]]), SEC("/o/zz.o", ".text.zz", T + 0x80, 0, [["dup", 0]])];
  const x0 = sideOf(sections, named("a", "dup", "middle"));
  const x = { ...x0, ea: [...x0.ea, ...elfSymbols(elf([["dup", T + 0x80, 15, 16]]))], eb: [...x0.eb, ...elfSymbols(elf([["dup", T + 320 + 0x80, 15, 16]]))] };
  const r = own(x);
  assert.deepEqual(r.why, []);
  assert.deepEqual([r.functions, r.together, r.repeated], [3, 3, 0]);
  assert.deepEqual(r.defs.filter((d) => d.name === "dup").map((d) => d.section.id), ["/o/zz.o:(.text.zz)"]);
});

test("a shuffled placement: a Rust-mangled function of no size where two input sections meet is the section's that lists it by its own name", () => {
  // The map written with --no-demangle names it as the symbol table does; written demangled, it
  // names it otherwise, and which section holds it is not established (the case build.sh's
  // --no-demangle for a shuffled run's maps meets).
  const end = "_ZN5probe3end17h0123456789abcdefE";
  const sections = [SEC("/o/r1.o", ".text.r1", T, 0x40, [["r1", 0], [end, 0x40]]), SEC("/o/r2.o", ".text.r2", T + 0x40, 0x40, [["r2", 0]])];
  for (const file of [named("r1", end, "r2"), named("r2", "r1", end)]) assert.deepEqual(own(sideOf(sections, file)).why, [], file);
  const demangled = [{ ...sections[0], symbols: [{ name: "r1", at: T }, { name: "probe::end::h0123456789abcdef", at: T + 0x40 }] }, sections[1]];
  has(own(sideOf(demangled, named("r1", end, "r2"))).why, `at an address its map's symbols there do not give to one input section: ${end}`);
});

test("a shuffled placement: every symbol of a listed name, a label or an object as much as a function, gives its section that name's place", () => {
  // .text.late holds the function late and a local label named key (NOTYPE: no function, so not
  // on the list the file is drawn from). LLD gives late's section key's place too: with the file
  // key, mid, late it lays key's and late's sections first, in either order, then mid's.
  const secs = [SEC("/o/key.o", ".text.key", T, 0x40, [["key", 0]]), SEC("/o/late.o", ".text.late", T + 0x40, 0x40, [["late", 0]], [{ name: "late", at: T + 0x40 }, { name: "key", at: T + 0x50 }]), SEC("/o/mid.o", ".text.mid", T + 0x80, 0x40, [["mid", 0]])];
  const file = named("key", "mid", "late"), lld = sideOf(secs, file);
  assert.deepEqual(lld.placedSections.slice(1).map((s) => s.section), [".text.key", ".text.late", ".text.mid"]);
  const r = own(lld);
  assert.deepEqual([r.why, r.groups, r.tied], [[], 2, 2]);
  assert.deepEqual(own(sideOf(secs, file, { reorder: (laid) => [laid[1], laid[0], laid[2]] })).why, []);
  // The order the functions alone would give (key, mid, late) is not a link of this file.
  has(own(sideOf(secs, file, { reorder: (laid) => [laid[0], laid[2], laid[1]] })).why, "definitions where the ordering file puts them: 1 of 3, in 1 of 3 input sections");
  // A listed name the placement's map also has in another output section is refused: LLD orders that section by it too.
  has(own({ ...lld, elsewhere: [{ name: "mid", at: 0x300000, output: ".data" }] }).why, "1 names the ordering file lists are also defined outside .text, where LLD orders by them too and this check does not read: mid (.data)");
  assert.deepEqual(own({ ...lld, elsewhere: [{ name: "unlisted", at: 0x300000, output: ".data" }] }).why, []);
  // A placement listing other symbols in a section than its unpadded link does is refused.
  const extra = { ...lld, placedSections: lld.placedSections.map((s) => (s.section === ".text.mid" ? { ...s, symbols: [...s.symbols, { name: "ghost", at: s.at + 8 }] } : s)) };
  has(own(extra).why, "do not list the symbols their unpadded one lists, as far from its start: /o/mid.o:(.text.mid)");
});

test("a shuffled placement: the first pad is exactly the declared size", () => {
  const file = order(textFunctions(elfSymbols(UNPADDED_NM), TEXT), 7, 3), b = link(file);
  assert.deepEqual(shuffledCheck(file, b).why, []);
  // A 320-byte pad declared as 304, 336 or 16: the functions follow 304 bytes too, but the pad is not that size.
  for (const pad of [304, 336, 16]) has(shuffledCheck(file, b, { pad }).why, `the first input section of .text is /w/pads/pad-320.o:(.text.corten_layout_pad), 320 bytes at 0x201000, not the one first pad of ${pad} bytes at its start`);
  // A placement whose first input section is not the pad's.
  has(shuffledCheck(file, { ...b, map: [...b.map.slice(1), b.map[0]] }).why, "not the one first pad of 320 bytes at its start");
});

test("a shuffled change: base's first alias of f.llvm.2 renamed in head, which reverses the copies' sections, is refused by the names defined once in them", () => {
  // x.o's local f.llvm.1 with hot_a, y.o's local f.llvm.2 with hot_b. Base's y also holds
  // f.llvm.3, head's f.llvm.0 in its place: drawn first, f.llvm.0 lays y's section, and hot_b,
  // before x's and hot_a. f, defined three times on each side, is left out; hot_a and hot_b are
  // compared, and lie the other way round.
  const secs = (alias) => [SEC("/o/a.o", ".text.a", T, 0x40, [["a", 0]]), SEC("/o/x.o", ".text.f", T + 0x40, 0x40, [["f.llvm.1", 0, 14, "x.c"], ["hot_a", 0x10]]), SEC("/o/y.o", ".text.f", T + 0x80, 0x40, [[alias, 0, 14, "y.c"], ["f.llvm.2", 0, 14, "y.c"], ["hot_b", 0x10]])];
  const base = sideOf(secs("f.llvm.3"), named("a", "f.llvm.1", "f.llvm.2", "f.llvm.3", "hot_a", "hot_b"));
  const head = sideOf(secs("f.llvm.0"), named("a", "f.llvm.0", "f.llvm.1", "f.llvm.2", "hot_a", "hot_b"));
  assert.deepEqual([own(base).why, own(head).why], [[], []]);
  const r = alike(base, head, 320);
  assert.deepEqual([r.ok, r.shared, r.compared, r.leftOut], [false, 4, 3, 1]);
  has(r.why, "the 3 names both placements define exactly once do not lie in one order: place 2 holds hot_a in the first and hot_b in the second");
  // An alias drawn after f.llvm.2 leaves both sections their keys: alike.
  assert.deepEqual(alike(base, sideOf(secs("f.llvm.4"), named("a", "f.llvm.1", "f.llvm.2", "f.llvm.4", "hot_a", "hot_b")), 320).why, []);
});

test("a shuffled run writes every map with --no-demangle, and an unshuffled run's maps as before", () => {
  const here = (f) => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), "utf8");
  const build = here("build.sh").split("\n").filter((l) => !/^\s*#/.test(l)), relinks = build.filter((l) => l.includes('"$KIT/relink.mjs"'));
  const shuffledLinks = relinks.filter((l) => l.includes("--every-name")), plainLinks = relinks.filter((l) => l.includes('--order "$WORK/pads/order.txt"'));
  assert.equal(shuffledLinks.length, 2);
  for (const l of shuffledLinks) assert.ok(l.includes("--map") && l.includes("--no-demangle"), l);
  for (const l of plainLinks) assert.ok(!l.includes("demangle"), l);
  // The unpadded link run again with its map: --no-demangle when, and only when, the plan shuffles.
  const unpadded = relinks.filter((l) => l.includes('"$B/$side-relink"'));
  assert.deepEqual(unpadded.map((l) => / \$MANGLED$/.test(l)), [true]);
  assert.deepEqual(build.filter((l) => /MANGLED=/.test(l)).map((l) => l.trim().replace(/^.*(MANGLED=\S*);.*$/, "$1")), ["MANGLED=", "MANGLED=--no-demangle"]);
  assert.ok(/\[ "\$SHUFFLE" = 0 \] \|\| \{[^}]*MANGLED=--no-demangle; \}/.test(build.join("\n")), "MANGLED is set outside the shuffled branch");
  // relink.mjs passes it on, and only with a map.
  assert.ok(here("relink.mjs").includes('if (mangled) args.push("-Wl,--no-demangle");'));
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./relink.mjs", import.meta.url)), tmpdir(), join(tmpdir(), "out"), "--no-demangle"], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /usage: .*--map <file> \[--no-demangle\]/);
});

// The four cases above as real links: each function in a section of its own, kept through
// --gc-sections as build.sh's pad is (an object's empty .text is not), assembled by clang and
// linked by LLD, with LLD's maps, read by layout.mjs as build.sh runs it.
const LLD = { skip: process.platform === "linux" && spawnSync("sh", ["-c", "command -v clang && command -v ld.lld && command -v nm && command -v readelf"]).status === 0 ? false : "needs Linux with clang, ld.lld, nm and readelf" };

test("a shuffled placement, linked by LLD: each definition by its own map's input section, in the order that map lays them", LLD, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "placement-lld-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (cmd, args) => { const r = spawnSync(cmd, args, { cwd: dir, encoding: "utf8" }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`); return r.stdout; };
  // An object of sections, each [section, [[name, offset], ...], size, byte, local]: every name a function there.
  const obj = (file, sections) => {
    const s = sections.map(([sec, fns, size, byte = 0xcc, local = false]) => [`\t.section .text.${sec},"axR",@progbits`, "\t.p2align 4",
      ...fns.flatMap(([n, off]) => [...(local ? [] : [`\t.globl ${n}`]), `\t.type ${n},@function`, `\t.set ${n}, .Lstart_${sec} + ${off}`]),
      `.Lstart_${sec}:`, `\t.skip ${size}, ${byte}`].join("\n"));
    writeFileSync(join(dir, `${file}.s`), [`\t.file "${file}.c"`, ...s].join("\n") + "\n");
    run("clang", ["--target=x86_64-linux-gnu", "-c", `${file}.s`, "-o", `${file}.o`]);
    return `${file}.o`;
  };
  const pad = obj("pad", [["corten_layout_pad", [["corten_layout_pad", 0]], 320]]);
  const ld = (out, objs, file) => { if (file) writeFileSync(join(dir, `${out}.order`), file); run("ld.lld", ["-o", out, "-e", "0", "--gc-sections", "-Map", `${out}.map`, ...(file ? ["--symbol-ordering-file", `${out}.order`] : []), ...objs]); return out; };
  const layout = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL("./layout.mjs", import.meta.url)), ...args], { cwd: dir, encoding: "utf8" });
  const shuffled = (unpadded, placement, file) => layout(unpadded, placement, "320", "--order", `${file}.order`, "--map", `${unpadded}.map`, "--placed-map", `${placement}.map`);
  const listed = (bin) => textFunctions(elfSymbols(run("readelf", ["-sW", bin])), textRange(run("readelf", ["-SW", bin])));

  // 1. x.o's and y.o's local dup, distinct bodies of one size: the file gives both sections dup's
  // place, and a link given y.o before x.o lays y's section first. LLD promises no order between
  // sections of one key, so both links pass, and are alike: each copy is where the file puts it.
  const a = obj("a", [["a", [["a", 0]], 0x40]]), x = obj("x", [["dup", [["dup", 0]], 0x40, 0xcc, true]]), y = obj("y", [["dup", [["dup", 0]], 0x40, 0x90, true]]);
  ld("dups", [a, x, y]);
  const dupFile = named("a", "dup");
  ld("dups-p", [pad, a, x, y], dupFile); ld("dups-yx", [pad, a, y, x], dupFile);
  assert.equal(readFileSync(join(dir, "dups-yx.map"), "utf8").indexOf("y.o:(.text.dup)") < readFileSync(join(dir, "dups-yx.map"), "utf8").indexOf("x.o:(.text.dup)"), true);
  assert.equal(shuffled("dups", "dups-p", "dups-p").status, 0, shuffled("dups", "dups-p", "dups-p").stderr);
  const yx = shuffled("dups", "dups-yx", "dups-yx");
  assert.equal(yx.status, 0, yx.stderr);
  assert.match(yx.stdout, /"functions":3,"repeated":1,"sections":3,"groups":2,"tied":2,"matched":3,"placedSections":3,/);
  // dup is defined twice on each side and left out, so a alone is compared: no order, refused.
  const turned = layout("--alike", "dups", "dups-p", "dups-p.order", "dups.map", "dups-p.map", "dups", "dups-yx", "dups-yx.order", "dups.map", "dups-yx.map", "320");
  assert.equal(turned.status, 1, turned.stdout);
  assert.match(turned.stdout, /^1 shared names compared, 1 left out as ambiguous/);
  assert.match(turned.stderr, /only 1 of the 2 names both placements have are defined exactly once on each side, fewer than the 2 an order needs/);
  // Run build.sh's refusal branch against the same links, without building a Cargo probe.
  const build = readFileSync(new URL("./build.sh", import.meta.url), "utf8");
  const refusal = build.match(/^refused\(\).*$/m)?.[0];
  const alikeCheck = build.match(/^    if \[ "\$SHUFFLE" = 1 \] && \[ "\$1" = head \]; then\n[\s\S]*?^    fi$/m)?.[0];
  assert.ok(refusal && alikeCheck, "build.sh has a shuffled head refusal branch");
  for (const folder of ["bin/layout", "maps", "orders"]) mkdirSync(join(dir, folder), { recursive: true });
  for (const [name, src] of [["base", "dups"], ["head", "dups"], ["base-p320", "dups-p"], ["head-p320", "dups-yx"]]) {
    symlinkSync(join(dir, src), join(dir, "bin", name));
    if (name.endsWith("320")) {
      writeFileSync(join(dir, "maps", `${name}.map.gz`), gzipSync(readFileSync(join(dir, `${src}.map`))));
      symlinkSync(join(dir, `${src}.order`), join(dir, "orders", `${name}.txt`));
    } else symlinkSync(join(dir, `${src}.map`), join(dir, "maps", `${name}.map`));
  }
  const refused = spawnSync("sh", ["-ec", `${refusal}\nSHUFFLE=1 SECOND=0 WORK=. B=bin M=maps pl=head-p320 pl_order=orders/head-p320.txt KIT=$3\n${alikeCheck}`, "build.sh", "head", "320", fileURLToPath(new URL(".", import.meta.url))], { cwd: dir, encoding: "utf8" });
  assert.equal(refused.status, 3, refused.stderr);
  const receipt = readFileSync(join(dir, "bin", "refused.txt"), "utf8");
  assert.match(receipt, /^REFUSED: head has no reading against base across shuffled placements: .*fewer than the 2 an order needs/);
  assert.doesNotMatch(receipt, /different orders/);
  // A link of another file, dup's sections before a, read for this one is refused.
  ld("dups-y", [pad, y, a, x], named("dup", "a"));
  const away = shuffled("dups", "dups-y", "dups-p");
  assert.equal(away.status, 1);
  assert.match(away.stderr, /definitions where the ordering file puts them: /);

  // 2. zero_empty in an empty section of its own, at a_next's unpadded address: LLD's link for
  // zero_empty, marker, a_next passes; the link for zero_empty, a_next, marker does not, read for it.
  const z = obj("z", [["zero_empty", [["zero_empty", 0]], 0]]), n = obj("n", [["a_next", [["a_next", 0]], 0x40]]), m = obj("m", [["marker", [["marker", 0]], 0x40]]);
  ld("zero", [z, n, m]);
  const nmZero = entries(run("nm", ["--defined-only", "zero"]));
  assert.equal(nmZero.find((e) => e.raw === "zero_empty").at, nmZero.find((e) => e.raw === "a_next").at);
  ld("zero-p", [pad, z, n, m], named("zero_empty", "marker", "a_next"));
  ld("zero-q", [pad, z, n, m], named("zero_empty", "a_next", "marker"));
  assert.equal(shuffled("zero", "zero-p", "zero-p").status, 0, shuffled("zero", "zero-p", "zero-p").stderr);
  const wrong = shuffled("zero", "zero-q", "zero-p");
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /definitions where the ordering file puts them/);

  // 3. Base's z_end ends .text.z where a_next begins; head adds head_only between them. At seed 7,
  // index 1, both lay z's section first and a_next's last: each passes, and the two are alike.
  const zz = obj("zz", [["z", [["z", 0], ["z_end", 0x40]], 0x40]]), h = obj("h", [["head_only", [["head_only", 0]], 0x40]]);
  ld("base", [zz, n]); ld("head", [zz, h, n]);
  const bFile = order(listed("base"), 7, 1), hFile = order(listed("head"), 7, 1);
  assert.equal(hFile, named("z_end", "head_only", "z", "a_next"));
  ld("base-p", [pad, zz, n], bFile); ld("head-p", [pad, zz, h, n], hFile);
  const nmBase = entries(run("nm", ["--defined-only", "base-p"]));
  assert.equal(nmBase.find((e) => e.raw === "z_end").at, nmBase.find((e) => e.raw === "a_next").at);
  for (const s of ["base", "head"]) assert.equal(shuffled(s, `${s}-p`, `${s}-p`).status, 0, shuffled(s, `${s}-p`, `${s}-p`).stderr);
  const both = layout("--alike", "base", "base-p", "base-p.order", "base.map", "base-p.map", "head", "head-p", "head-p.order", "head.map", "head-p.map", "320");
  assert.equal(both.status, 0, both.stderr);
  assert.match(both.stdout, /"shared":3/);

  // 4. Head's alias, named first, lays .text.b before .text.a: z_end, the end of .text.a, is the
  // end of the placement's .text, and is one of its four definitions.
  const ea = obj("ea", [["a", [["a", 0], ["z_end", 0x40]], 0x40]]), eb = obj("eb", [["b", [["b", 0], ["alias", 0x10]], 0x40]]);
  ld("ends", [ea, eb]);
  ld("ends-p", [pad, ea, eb], named("alias", "b", "a", "z_end"));
  const placedText = textRange(run("readelf", ["-SW", "ends-p"])), zEnd = entries(run("nm", ["--defined-only", "ends-p"])).find((e) => e.raw === "z_end").at;
  assert.equal(zEnd, placedText.start + placedText.size);
  const ends = shuffled("ends", "ends-p", "ends-p");
  assert.equal(ends.status, 0, ends.stderr);
  assert.match(ends.stdout, /"functions":4,/);
});

// The fourth review's cases as real links, run through the CLIs build.sh runs (order.mjs functions
// and order, layout.mjs --order and --alike), every map written with --no-demangle as a shuffled
// run's are, but where a case says otherwise.
test("a shuffled placement, linked by LLD: a function of .text by its symbol's section, a repeated name left out, ICF's copies one place", LLD, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "placement-lld4-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (cmd, args) => { const r = spawnSync(cmd, args, { cwd: dir, encoding: "utf8" }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`); return r.stdout; };
  // An object of sections, each [section, [[name, offset, local], ...], size, byte, align]: every
  // name a function there; its file symbol is source (the object's name and .c unless given).
  const obj = (file, sections, source = `${file.replace(/^.*\//, "")}.c`) => {
    const label = (sec) => `.Lstart_${`${file}_${sec}`.replace(/\W/g, "_")}`;
    const s = sections.map(([sec, fns, size, byte = 0xcc, align = 4]) => [`\t.section ${sec},"axR",@progbits`, ...(align ? [`\t.p2align ${align}`] : []),
      ...fns.flatMap(([n, off, local = false]) => [...(local ? [] : [`\t.globl ${n}`]), `\t.type ${n},@function`, `\t.set ${n}, ${label(sec)} + ${off}`]),
      `${label(sec)}:`, ...(size ? [`\t.skip ${size}, ${byte}`] : [])].join("\n"));
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, `${file}.s`), [`\t.file "${source}"`, ...s].join("\n") + "\n");
    run("clang", ["--target=x86_64-linux-gnu", "-c", `${file}.s`, "-o", `${file}.o`]);
    return `${file}.o`;
  };
  const pad = obj("pad", [[".text.corten_layout_pad", [["corten_layout_pad", 0]], 320]]);
  const ld = (out, objs, file, more = ["--no-demangle"]) => { if (file) writeFileSync(join(dir, `${out}.order`), file); run("ld.lld", ["-o", out, "-e", "0", "--gc-sections", "-Map", `${out}.map`, ...more, ...(file ? ["--symbol-ordering-file", `${out}.order`] : []), ...objs]); return out; };
  const kit = (f, ...args) => spawnSync(process.execPath, [fileURLToPath(new URL(`./${f}`, import.meta.url)), ...args], { cwd: dir, encoding: "utf8" });
  const shuffled = (unpadded, placement) => kit("layout.mjs", unpadded, placement, "320", "--order", `${placement}.order`, "--map", `${unpadded}.map`, "--placed-map", `${placement}.map`);
  const alikeOf = (b, bp, h, hp) => kit("layout.mjs", "--alike", b, bp, `${bp}.order`, `${b}.map`, `${bp}.map`, h, hp, `${hp}.order`, `${h}.map`, `${hp}.map`, "320");
  const functions = (bin) => { const r = kit("order.mjs", "functions", bin); assert.equal(r.status, 0, r.stderr); writeFileSync(join(dir, `${bin}.functions`), r.stdout); return r.stdout.replace(/\n$/, "").split("\n"); };
  const drawn = (bin, seed, i) => { const r = kit("order.mjs", "order", `${bin}.functions`, String(seed), String(i)); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const syms = (bin) => run("readelf", ["-sW", bin]).split("\n").filter((l) => / FUNC /.test(l)).map((l) => l.trim().split(/\s+/)).map((f) => ({ at: f[1], ndx: f[6], name: f[7] }));
  const m = obj("m", [[".text.middle", [["middle", 0]], 0x40]]), a = obj("a", [[".text.a", [["a", 0]], 0x40]]);

  // 1. z_end, of no size, ends e's section, the last of the unpadded .text: it is drawn, at seed
  // 0 and index 1 as the review drew it, and the link of that file passes.
  const e = obj("e", [[".text.e", [["e", 0], ["z_end", 0x40]], 0x40]]);
  ld("ends", [m, a, e]);
  assert.deepEqual(functions("ends"), ["a", "e", "middle", "z_end"]);
  ld("ends-p", [pad, m, a, e], drawn("ends", 0, 1));
  const ends = shuffled("ends", "ends-p");
  assert.equal(ends.status, 0, ends.stderr);
  assert.match(ends.stdout, /"functions":4,/);

  // 2. A local dup of no size ends .text (zz's empty section), and another local dup begins the
  // next executable output section at that address: one address, two section indices; only the
  // first is of .text, and only it is drawn. LLD gives .other's section dup's place as well, an
  // order of .other this check does not read: the placement is refused, not passed.
  const zz = obj("zz", [[".text.zz", [["dup", 0, true]], 0, 0xcc, 0]]), o = obj("o", [[".other", [["dup", 0, true]], 0x10, 0x90, 0]]);
  ld("bound", [m, a, zz, o]);
  const dups = syms("bound").filter((x) => x.name === "dup");
  assert.equal(dups.length, 2);
  assert.equal(dups[0].at, dups[1].at);
  assert.notEqual(dups[0].ndx, dups[1].ndx);
  assert.deepEqual(functions("bound"), ["a", "dup", "middle"]);
  ld("bound-p", [pad, m, a, zz, o], drawn("bound", 0, 1));
  const bound = shuffled("bound", "bound-p");
  assert.equal(bound.status, 1, bound.stdout);
  assert.match(bound.stderr, /1 names the ordering file lists are also defined outside \.text, where LLD orders by them too and this check does not read: dup \(\.other\)/);
  assert.match(bound.stdout, /"functions":3,/);

  // 3. A Rust-mangled function of no size ends r1's section where r2's begins. With the maps
  // written with --no-demangle a correct link passes; written demangled (LLD's default), its
  // section is not established and the same binaries are refused.
  const end = "_ZN5probe3end17h0123456789abcdefE";
  const r1 = obj("r1", [[".text.r1", [["r1", 0], [end, 0x40]], 0x40]]), r2 = obj("r2", [[".text.r2", [["r2", 0]], 0x40]]);
  ld("rust", [r1, r2]);
  functions("rust");
  const rustFile = drawn("rust", 0, 1);
  ld("rust-p", [pad, r1, r2], rustFile);
  const mangled = shuffled("rust", "rust-p");
  assert.equal(mangled.status, 0, mangled.stderr);
  ld("rust", [r1, r2], null, []); ld("rust-p", [pad, r1, r2], rustFile, []);
  assert.match(readFileSync(join(dir, "rust.map"), "utf8"), /probe::end::h0123456789abcdef/);
  const demangled = shuffled("rust", "rust-p");
  assert.equal(demangled.status, 1);
  assert.match(demangled.stderr, new RegExp(`do not give to one input section: ${end}`));

  // 4. Local dup in x.o and y.o on both sides; head renames x.o's section (the same body) and adds
  // an alias to it. Named first, the alias lays x.o's dup before middle, which base lays first:
  // each placement passes its own check. dup, defined twice on each side, is left out; middle and
  // a, each defined once, keep their order, so the two are alike on those two, and say so.
  const x = obj("b/x", [[".text.dup", [["dup", 0, true]], 0x40, 0xcc]]), y = obj("y", [[".text.dup", [["dup", 0, true]], 0x40, 0x90]]);
  const xr = obj("h/x", [[".text.dup_renamed", [["dup", 0, true], ["alias", 0x10]], 0x40, 0xcc]]);
  ld("base", [m, a, x, y]); ld("head", [m, a, xr, y]);
  ld("base-p", [pad, m, a, x, y], named("middle", "dup", "a")); ld("head-p", [pad, m, a, xr, y], named("alias", "middle", "dup", "a"));
  for (const s of ["base", "head"]) assert.equal(shuffled(s, `${s}-p`).status, 0, shuffled(s, `${s}-p`).stderr);
  const renamed = alikeOf("base", "base-p", "head", "head-p");
  assert.equal(renamed.status, 0, renamed.stderr);
  assert.match(renamed.stdout, /^2 shared names compared, 1 left out as ambiguous/);
  // Head's alias in a's section instead, named first, lays a before middle: refused.
  const ar = obj("h/a", [[".text.a", [["a", 0], ["alias", 0x10]], 0x40]]);
  ld("head2", [m, ar, x, y]); ld("head2-p", [pad, m, ar, x, y], named("alias", "middle", "dup", "a"));
  assert.equal(shuffled("head2", "head2-p").status, 0, shuffled("head2", "head2-p").stderr);
  const moved = alikeOf("base", "base-p", "head2", "head2-p");
  assert.equal(moved.status, 1, moved.stdout);
  assert.match(moved.stderr, /the 2 names both placements define exactly once do not lie in one order: place 1 holds middle in the first and a in the second/);

  // 5. x.o's and y.o's identical local dup, which --icf=all folds to one address: dup is left
  // out, and a placement compared with itself is alike on middle and a.
  const fx = obj("fx", [[".text.dup", [["dup", 0, true]], 0x40, 0x90]]), fy = obj("fy", [[".text.dup", [["dup", 0, true]], 0x40, 0x90]]);
  ld("icf", [m, a, fx, fy], null, ["--no-demangle", "--icf=all"]);
  const folded = syms("icf").filter((s) => s.name === "dup");
  assert.deepEqual([folded.length, folded[0].at === folded[1].at], [2, true]);
  ld("icf-p", [pad, m, a, fx, fy], named("dup", "middle", "a"), ["--no-demangle", "--icf=all"]);
  const icf = shuffled("icf", "icf-p");
  assert.equal(icf.status, 0, icf.stderr);
  const self = alikeOf("icf", "icf-p", "icf", "icf-p");
  assert.equal(self.status, 0, self.stderr);
  assert.match(self.stdout, /"shared":3,"compared":2,"leftOut":1,/);
});

// Real links for the cases below, LLD's maps written with --no-demangle as a shuffled run's are.
const fifth = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "placement-lld5-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (cmd, args) => { const r = spawnSync(cmd, args, { cwd: dir, encoding: "utf8" }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`); return r.stdout; };
  // An object of one section [name, function, size, byte] holding one function, local unless
  // global, with the file symbol source, as rustc gives each codegen unit.
  const obj = (file, [sec, name, size, byte], source, global = false) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, `${file}.s`), [`\t.file "${source}"`, `\t.section ${sec},"axR",@progbits`, "\t.p2align 4", ...(global ? [`\t.globl ${name}`] : []), `\t.type ${name},@function`, `${name}:`, `\t.skip ${size}, ${byte}`].join("\n") + "\n");
    run("clang", ["--target=x86_64-linux-gnu", "-c", `${file}.s`, "-o", `${file}.o`]);
    return `${file}.o`;
  };
  const ld = (out, objs, file, more = []) => { if (file) writeFileSync(join(dir, `${out}.order`), file); run("ld.lld", ["-o", out, "-e", "0", "--gc-sections", "--no-demangle", "-Map", `${out}.map`, ...more, ...(file ? ["--symbol-ordering-file", `${out}.order`] : []), ...objs]); return out; };
  const kit = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL("./layout.mjs", import.meta.url)), ...args], { cwd: dir, encoding: "utf8" });
  return {
    dir, run, obj, ld,
    pad: obj("pad", [".text.corten_layout_pad", "corten_layout_pad", 320, 0xcc], "pad.s", true), m: obj("m", [".text.middle", "middle", 0x40, 0xcc], "m.c", true),
    shuffled: (unpadded, placement) => kit(unpadded, placement, "320", "--order", `${placement}.order`, "--map", `${unpadded}.map`, "--placed-map", `${placement}.map`),
    alikeOf: (b, bp, h, hp) => kit("--alike", b, bp, `${bp}.order`, `${b}.map`, `${bp}.map`, h, hp, `${hp}.order`, `${h}.map`, `${hp}.map`, "320"),
  };
};

// An object of one section [name, size, byte] with the file symbol source and its functions
// [name, offset, global] (local unless global).
const sixth = (t) => {
  const f = fifth(t);
  const objOf = (file, [sec, size, byte], source, fns) => {
    mkdirSync(dirname(join(f.dir, file)), { recursive: true });
    const body = [];
    let at = 0;
    for (const [name, off, global] of [...fns].sort((x, y) => x[1] - y[1])) {
      if (off > at) body.push(`\t.skip ${off - at}, ${byte}`);
      body.push(...(global ? [`\t.globl ${name}`] : []), `\t.type ${name},@function`, `${name}:`);
      at = off;
    }
    body.push(`\t.skip ${size - at}, ${byte}`);
    writeFileSync(join(f.dir, `${file}.s`), [`\t.file "${source}"`, `\t.section ${sec},"axR",@progbits`, "\t.p2align 4", ...body].join("\n") + "\n");
    f.run("clang", ["--target=x86_64-linux-gnu", "-c", `${file}.s`, "-o", `${file}.o`]);
    return `${file}.o`;
  };
  return { ...f, objOf };
};

// The seventh review's cases as real links, each a reading the rounds before it certified.
test("a shuffled change, linked by LLD: copies of one name swapped between two objects while a third object's source is renamed are left out, not matched", LLD, (t) => {
  const { obj, ld, pad, m, shuffled, alikeOf } = fifth(t), file = named("middle", "dup", "zed");
  // slot1.o and slot2.o each hold a local dup; base's are compiled from A.c and B.c, head's from
  // B.c and A.c, and a third copy's source is Old.c in base and New.c in head.
  const z = obj("z", [".text.zed", "zed", 0x40, 0xcc], "z.c", true);
  const b = [obj("b/slot1", [".text.dup", "dup", 0x40, 0x90], "A.c"), obj("b/slot2", [".text.dup", "dup", 0x40, 0x91], "B.c"), obj("b/third", [".text.dup", "dup", 0x40, 0x92], "Old.c")];
  const h = [obj("h/slot1", [".text.dup", "dup", 0x40, 0x91], "B.c"), obj("h/slot2", [".text.dup", "dup", 0x40, 0x90], "A.c"), obj("h/third", [".text.dup", "dup", 0x40, 0x92], "New.c")];
  ld("sb", [m, ...b, z]); ld("sb-p", [pad, m, ...b, z], file); ld("sh", [m, ...h, z]); ld("sh-p", [pad, m, ...h, z], file);
  for (const [u, p] of [["sb", "sb-p"], ["sh", "sh-p"]]) assert.equal(shuffled(u, p).status, 0, shuffled(u, p).stderr);
  // dup is defined three times on each side: no copy is matched to another by its object, its
  // section or its source; it is left out and counted, and middle and zed are compared.
  const r = alikeOf("sb", "sb-p", "sh", "sh-p");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^2 shared names compared, 1 left out as ambiguous/);
  assert.match(r.stdout, /"shared":3,"compared":2,"leftOut":1,/);
});

test("a shuffled change, linked by LLD: an alias of f.llvm.2 renamed from f.llvm.3 to f.llvm.0 reverses the copies' sections and is refused", LLD, (t) => {
  const { ld, pad, m, objOf, shuffled, alikeOf } = sixth(t);
  // x's local f.llvm.1 with hot_a; y's local f.llvm.2 and its alias (f.llvm.3 in base, f.llvm.0 in
  // head, the first of the two in y's symbol table) with hot_b. Head's f.llvm.0, drawn first, gives y's section the first key, so LLD lays
  // hot_b before hot_a. f is defined three times on each side and left out; hot_a and hot_b,
  // defined once, lie the other way round.
  const x = (side) => objOf(`o-${side}/x`, [".text.f", 0x40, 0x90], "x.c", [["f.llvm.1", 0], ["hot_a", 0x10, true]]);
  const y = (side, alias) => objOf(`o-${side}/y`, [".text.f", 0x40, 0x91], "y.c", [[alias, 0], ["f.llvm.2", 0], ["hot_b", 0x10, true]]);
  ld("ab", [m, x("ab"), y("ab", "f.llvm.3")]); ld("ab-p", [pad, m, x("ab"), y("ab", "f.llvm.3")], named("middle", "f.llvm.1", "f.llvm.2", "f.llvm.3", "hot_a", "hot_b"));
  ld("ah", [m, x("ah"), y("ah", "f.llvm.0")]); ld("ah-p", [pad, m, x("ah"), y("ah", "f.llvm.0")], named("middle", "f.llvm.0", "f.llvm.1", "f.llvm.2", "hot_a", "hot_b"));
  for (const [u, p] of [["ab", "ab-p"], ["ah", "ah-p"]]) assert.equal(shuffled(u, p).status, 0, shuffled(u, p).stderr);
  const r = alikeOf("ab", "ab-p", "ah", "ah-p");
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^3 shared names compared, 1 left out as ambiguous/);
  assert.match(r.stderr, /the 3 names both placements define exactly once do not lie in one order: place 2 holds hot_a in the first and hot_b in the second/);
});

// key.o's key, late.o's late with a local label named key 16 bytes in (NOTYPE: no function), and
// mid.o's mid, drawn as order.mjs draws them; LLD gives late's section key's place.
const keyLate = (t, label = true) => {
  const f = fifth(t);
  const src = (name, body) => { writeFileSync(join(f.dir, `${name}.s`), body.join("\n") + "\n"); f.run("clang", ["--target=x86_64-linux-gnu", "-c", `${name}.s`, "-o", `${name}.o`]); return `${name}.o`; };
  const fn = (name, byte) => src(name, [`\t.file "${name}.c"`, `\t.section .text.${name},"axR",@progbits`, "\t.p2align 4", `\t.globl ${name}`, `\t.type ${name},@function`, `${name}:`, `\t.skip 64, ${byte}`]);
  const objs = [fn("key", 0x90), src("late", ["\t.file \"late.c\"", "\t.section .text.late,\"axR\",@progbits", "\t.p2align 4", "\t.globl late", "\t.type late,@function", "late:", "\t.skip 16, 0x91", ...(label ? ["key:"] : []), "\t.skip 48, 0x91"]), fn("mid", 0x92)];
  const kit = (file, ...args) => spawnSync(process.execPath, [fileURLToPath(new URL(`./${file}`, import.meta.url)), ...args], { cwd: f.dir, encoding: "utf8" });
  f.ld("u", objs);
  const fns = kit("order.mjs", "functions", "u");
  assert.equal(fns.stdout, "key\nlate\nmid\n");
  writeFileSync(join(f.dir, "u.functions"), fns.stdout);
  const drawn = (seed) => { const r = kit("order.mjs", "order", "u.functions", String(seed), "1"); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const laid = (p) => readMap(readFileSync(join(f.dir, `${p}.map`), "utf8")).find((o) => o.name === ".text").inputs.slice(1).map((s) => s.section);
  const check = (p, file, pad = "320") => kit("layout.mjs", "u", p, pad, "--order", file, "--map", "u.map", "--placed-map", `${p}.map`);
  return { ...f, objs, drawn, laid, check };
};

test("a shuffled placement, linked by LLD: a local label of a listed name gives its section that name's place, for the genuine file and against another", LLD, (t) => {
  const { ld, pad, objs, drawn, laid, check } = keyLate(t);
  assert.equal(drawn(4), named("key", "mid", "late"));
  assert.equal(drawn(9), named("mid", "late", "key"));
  ld("s4", [pad, ...objs], drawn(4)); ld("s9", [pad, ...objs], drawn(9));
  // LLD lays the seed-4 file's link key, late, mid: late's section takes key's place from its label.
  assert.deepEqual(laid("s4"), [".text.key", ".text.late", ".text.mid"]);
  const genuine = check("s4", "s4.order");
  assert.equal(genuine.status, 0, genuine.stderr);
  // Seed 9's link read as seed 4's is refused, and read as its own passes.
  const wrong = check("s9", "s4.order");
  assert.equal(wrong.status, 1, wrong.stdout);
  assert.match(wrong.stderr, /definitions where the ordering file puts them: /);
  assert.equal(check("s9", "s9.order").status, 0, check("s9", "s9.order").stderr);
});

test("a shuffled placement, linked by LLD: a first pad of 320 bytes is not one of 304", LLD, (t) => {
  // The three functions without the label: the seed-4 file's link is key, mid, late.
  const { ld, pad, objs, drawn, laid, check } = keyLate(t, false);
  ld("s4", [pad, ...objs], drawn(4));
  assert.deepEqual(laid("s4"), [".text.key", ".text.mid", ".text.late"]);
  assert.equal(check("s4", "s4.order").status, 0, check("s4", "s4.order").stderr);
  const short = check("s4", "s4.order", "304");
  assert.equal(short.status, 1, short.stdout);
  assert.match(short.stderr, /the first input section of \.text is pad\.o:\(\.text\.corten_layout_pad\), 320 bytes at 0x[0-9a-f]+, not the one first pad of 304 bytes at its start/);
});

test("owner(): a definition's input section by the map, a section of no size and the end of one included", () => {
  const ins = [
    { at: 0x100, size: 0x40, symbols: [{ name: "a", at: 0x100 }, { name: "a_end", at: 0x140 }] },
    { at: 0x140, size: 0, symbols: [{ name: "empty", at: 0x140 }] },
    { at: 0x140, size: 0x40, symbols: [{ name: "b", at: 0x140 }] },
    { at: 0x180, size: 0x40, symbols: [{ name: "c", at: 0x180 }] },
  ];
  assert.deepEqual([owner(ins, 0x100, "a"), owner(ins, 0x120, "a_mid"), owner(ins, 0x140, "a_end"), owner(ins, 0x140, "empty"), owner(ins, 0x140, "b")], [0, 0, 0, 1, 2]);
  // The end of the last section, when the map lists the symbol there.
  assert.equal(owner([...ins.slice(0, 3), { ...ins[3], symbols: [...ins[3].symbols, { name: "c_end", at: 0x1c0 }] }], 0x1c0, "c_end"), 3);
  // A section's end where the map lists nothing (the next output section's first function, say) is not its.
  assert.equal(owner(ins, 0x1c0, "next"), -1);
  assert.equal(owner(ins, 0x1c1, "past"), -1);
  // At its end alone, a section holds a definition only by its name.
  assert.equal(owner([...ins.slice(0, 3), { ...ins[3], symbols: [...ins[3].symbols, { name: "c::end", at: 0x1c0 }] }], 0x1c0, "_ZN1c3endE"), -2);
  // A name the map writes otherwise (demangled), where two sections list symbols: not told apart.
  assert.equal(owner(ins, 0x140, "_ZN1b1fE"), -2);
  // Where only the next section lists a symbol, the definition starts it.
  assert.equal(owner(ins, 0x180, "_ZN1c1fE"), 3);
});

test("CONTRIBUTING.md scopes the fifth point's order and fixed line phase to unshuffled placements", async () => {
  const { readFileSync } = await import("node:fs");
  const doc = readFileSync(new URL("../../CONTRIBUTING.md", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.ok(doc.includes("then the unpadded link's input sections in its order (in a shuffled placement, in the order its ordering file gives them, any order to this check)"), "the map check's order has no shuffled exception");
  assert.ok(doc.includes("In an unshuffled placement the pads do not vary where a function on a side's list lies in a 64-byte line"), "the fixed line phase is not scoped to unshuffled placements");
});

test("the map check of a shuffled placement: the unpadded sections between the pads in any order", () => {
  const A = lay(UNPADDED), p = 320, sh = [UNPADDED[0], UNPADDED[5], UNPADDED[2], UNPADDED[1], UNPADDED[4], UNPADDED[3]];
  const n = SIZES.find((x) => data(A, placed(p, x, sh), p).fits);
  const ok = check(A, placed(p, n, sh), p, n, true);
  assert.deepEqual(ok.why, []);
  assert.equal(ok.shuffled, true);
  // Unshuffled, the same placement is refused; and an unshuffled check carries no "shuffled".
  has(check(A, placed(p, n, sh), p, n).why, "input section 1 differs");
  assert.equal("shuffled" in check(A, placed(p, SIZES.find((x) => data(A, placed(p, x), p).fits)), p, SIZES.find((x) => data(A, placed(p, x), p).fits)), false);
  const why = (B) => check(A, B, p, n, true).why;
  has(why(placed(p, n, sh.map((s, i) => (i === 2 ? { ...s, size: s.size + 16 } : s)))), "1 input sections of the unpadded .text are not between the pads with one size and alignment: /t/release/deps/probe.probe.0.rcgu.o:(.text._ZN5probe4page17hfedcba9876543210E) (1234 bytes, aligned to 16)");
  has(why(placed(p, n, sh.map((s, i) => (i === 1 ? { ...s, file: "/t/release/build/z/out/libz.a(crc.o)" } : s)))), "1 input sections of the unpadded .text are not between the pads");
  has(why(placed(p, n, sh.slice(0, -1))), ".text has 6 input sections unpadded and 5 between the pads");
  has(why(placed(p, n, sh.map((s, i) => (i === 4 ? { ...s, syms: [["flush", 0], ["flush_tail", 528]] } : s)))), "1 symbols of .text are not in the input section");
  has(why(lay([UNPADDED[0], pad(p), ...sh.slice(1), pad2(n)])), "not the first pad");
  // A kept placement, linked with the pad alone, holds its unpadded link's sections too.
  assert.deepEqual(check(map("head"), map("head-p320-l48"), 320, 48, true).why, []);
});

test("the map check of a shuffled placement: two sections one file names alike are told apart by their symbols", () => {
  // One object's two sections both printed as sameid.o:(.text.same), of one size, holding s1 and s2.
  const one = S("/t/sameid.o", ".text.same", 64, 16, [["s1", 0]]), two = S("/t/sameid.o", ".text.same", 64, 16, [["s2", 0]]);
  const A = lay([UNPADDED[0], one, two, UNPADDED[5]]), p = 320;
  const fit = (sections) => SIZES.find((x) => data(A, placed(p, x, sections), p).fits);
  // The ordering file put s2 first: LLD laid the two the other way round, and each symbol is in its own section.
  const turned = [UNPADDED[0], two, one, UNPADDED[5]], n = fit(turned), ok = check(A, placed(p, n, turned), p, n, true);
  assert.deepEqual(ok.why, []);
  assert.equal(ok.symbols, 4);
  // A symbol elsewhere in one of the two is still refused.
  const off = [UNPADDED[0], S("/t/sameid.o", ".text.same", 64, 16, [["s2", 8]]), one, UNPADDED[5]];
  has(check(A, placed(p, fit(off), off), p, fit(off), true).why, "1 symbols of .text are not in the input section the unpadded link has them in");
  // Two sections alike in their symbols too are interchangeable to this check, in either order.
  const twin = S("/t/sameid.o", ".text.same", 64, 16, [["s", 0]]), twins = [UNPADDED[0], twin, twin, UNPADDED[5]], B = lay(twins);
  const m = SIZES.find((x) => data(B, placed(p, x, twins), p).fits);
  assert.deepEqual(check(B, placed(p, m, twins), p, m, true).why, []);
});
