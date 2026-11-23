// tail.mjs: how far each function of a placement moved, where a build links C code whose
// compiler aligned its function sections beyond rustc's 16 bytes (libdeflate's, since #1971):
//   node tail.mjs <unpadded binary A> <padded binary B> <pad bytes> [<C archive>...]
// A section aligned to 32 or 64 bytes cannot move by a pad that is not a multiple of its
// alignment, so the linker moves it, and whatever it lays after it, by the pad rounded to that
// alignment. The check: with T the lowest address in A of a function any of the archives
// defines (none given, or none linked: the end of the code), every function below T moved by
// exactly the pad, and every function at or above T moved by exactly the pad or by a multiple of
// 32 bytes less than 64 bytes from it. Prints the count and shifts of each part and, as its last line, JSON for
// build.sh; exits 1 when the check fails. Names are read as layout.mjs reads them (function
// symbols named once in each binary, ThinLTO suffixes stripped).
import { execFileSync } from "node:child_process";

const [, , a, b, padArg, ...archives] = process.argv;
const pad = Number(padArg);
if (!a || !b || !Number.isInteger(pad)) throw new Error("usage: node tail.mjs <binary A> <binary B> <pad bytes> [<C archive>...]");
const nm = (file) => execFileSync("nm", ["--defined-only", file], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\n");
const symbols = (bin) => {
  const seen = new Map();
  for (const l of nm(bin)) {
    const m = /^([0-9a-f]+) [tTwW] (.+)$/.exec(l);
    if (!m) continue;
    const name = m[2].replace(/\.llvm\.\d+$/, "");
    seen.set(name, seen.has(name) ? null : parseInt(m[1], 16));
  }
  return seen;
};
const fromC = new Set();
for (const archive of archives) for (const l of nm(archive)) { const m = /^[0-9a-f]+ [tT] (.+)$/.exec(l); if (m) fromC.add(m[1]); }
const fa = symbols(a), fb = symbols(b);
const both = [];
for (const [name, at] of fa) { const bt = fb.get(name); if (at != null && bt != null) both.push({ name, at, shift: bt - at }); }
both.sort((x, y) => x.at - y.at);
const linked = both.filter((f) => fromC.has(f.name));
const T = linked.length ? linked[0].at : Infinity;
const head = both.filter((f) => f.at < T), tail = both.filter((f) => f.at >= T);
const count = (fs) => { const m = new Map(); for (const f of fs) m.set(f.shift, (m.get(f.shift) ?? 0) + 1); return Object.fromEntries([...m].sort((x, y) => y[1] - x[1])); };
const inexact = head.filter((f) => f.shift !== pad);
const loose = tail.filter((f) => f.shift !== pad && (f.shift % 32 !== 0 || Math.abs(f.shift - pad) >= 64));
console.log(`functions before the C code: ${head.length}, moved by exactly the pad ${head.length - inexact.length}`);
console.log(`functions from the C code on (${linked.length} of them the archives' own, the first ${linked[0]?.name ?? "none"} at 0x${Number.isFinite(T) ? T.toString(16) : "-"}): ${tail.length}; shifts ${JSON.stringify(count(tail))}`);
if (tail.length) console.log(`  ${tail.map((f) => `${f.name} ${f.shift >= pad ? "+" : ""}${f.shift - pad}`).join(", ")}`);
const ok = inexact.length === 0 && loose.length === 0;
if (!ok) console.error(`tail.mjs: ${inexact.length} functions before the C code did not move by exactly the pad (${inexact.slice(0, 5).map((f) => f.name).join(", ")}); ${loose.length} from it on moved by neither the pad nor a multiple of 32 within 64 of it (${loose.slice(0, 5).map((f) => `${f.name} ${f.shift}`).join(", ")})`);
console.log(`JSON ${JSON.stringify({ pad, before: head.length, beforeExact: head.length - inexact.length, tail: tail.length, tailOwn: linked.length, tailShifts: count(tail), ok })}`);
process.exit(ok ? 0 : 1);
