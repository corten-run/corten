// How a padded placement's code sits against its side's unpadded binary (kit 1923's layout.mjs,
// as kit 1965 adapted it for offset placements, unchanged): node layout.mjs <unpadded binary A> <padded binary B> <pad bytes>.
// Reads both binaries' sections (readelf) and defined function symbols (nm). Prints .text's start
// and size, where B's pad function (corten_layout_pad) is, the other sections that moved, then for
// the function symbols named once in each binary: how many moved by exactly the pad, the
// distribution of every shift, how many keep their offset in a 64-byte line and in a 4 KiB page,
// and how many of A's neighbours (two functions next to each other in A's address order) are still
// next to each other in B, for all functions, Corten's ("6corten") and the probe's ("5probe"). A
// ThinLTO suffix (".llvm.<n>") is ignored. The last line is JSON for build.sh, which refuses a
// placement unless B holds A's functions and one more (the pad, at the start of .text), every
// function moved, and every neighbour pair is kept.
import { execFileSync } from "node:child_process";

const [, , a, b, padArg] = process.argv;
const pad = Number(padArg);
if (!a || !b || !Number.isInteger(pad)) throw new Error("usage: node layout.mjs <binary A> <binary B> <pad bytes>");
const sections = (bin) => {
  const out = new Map();
  for (const l of execFileSync("readelf", ["-SW", bin], { encoding: "utf8" }).split("\n")) {
    const m = /\]\s+(\.\S+)\s+\S+\s+([0-9a-f]+)\s+[0-9a-f]+\s+([0-9a-f]+)/.exec(l);
    if (m) out.set(m[1], { address: parseInt(m[2], 16), size: parseInt(m[3], 16) });
  }
  return out;
};
const symbols = (bin) => {
  const seen = new Map();
  for (const l of execFileSync("nm", ["--defined-only", bin], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\n")) {
    const m = /^([0-9a-f]+) [tTwW] (.+)$/.exec(l);
    if (!m) continue;
    const name = m[2].replace(/\.llvm\.\d+$/, "");
    seen.set(name, seen.has(name) ? null : parseInt(m[1], 16));
  }
  return seen;
};
const sa = sections(a), sb = sections(b);
const ta = sa.get(".text"), tb = sb.get(".text");
console.log(`.text: A ${ta.size} bytes at 0x${ta.address.toString(16)}; B ${tb.size} bytes at 0x${tb.address.toString(16)} (B - A ${tb.size - ta.size} bytes; pad ${pad})`);
const moved = [...sa].filter(([n, s]) => sb.has(n) && sb.get(n).address !== s.address).map(([n, s]) => `${n} ${sb.get(n).address - s.address > 0 ? "+" : ""}${sb.get(n).address - s.address}`);
console.log(`other sections moved: ${moved.filter((x) => !x.startsWith(".text ")).join(", ") || "none"}`);
const fa = symbols(a), fb = symbols(b);
const padAt = fb.get("corten_layout_pad");
console.log(`pad function: ${padAt == null ? "absent" : `at 0x${padAt.toString(16)}${padAt === tb.address ? ", the start of .text" : ", NOT the start of .text"}`}`);
const groups = { all: () => true, corten: (n) => n.includes("6corten"), probe: (n) => n.includes("5probe") };
const json = { pad, textA: ta.size, textB: tb.size, padAtStart: padAt === tb.address, otherSectionsMoved: moved.filter((x) => !x.startsWith(".text ")) };
for (const [group, keep] of Object.entries(groups)) {
  const both = [];
  for (const [name, at] of fa) {
    const bt = fb.get(name);
    if (at == null || bt == null || !keep(name)) continue;
    both.push({ name, at, bt });
  }
  const shifts = new Map();
  for (const f of both) shifts.set(f.bt - f.at, (shifts.get(f.bt - f.at) ?? 0) + 1);
  const exact = shifts.get(pad) ?? 0;
  const unmoved = shifts.get(0) ?? 0;
  const line = both.filter((f) => f.at % 64 === f.bt % 64).length;
  const page = both.filter((f) => f.at % 4096 === f.bt % 4096).length;
  const byA = [...both].sort((x, y) => x.at - y.at);
  const rankB = new Map([...both].sort((x, y) => x.bt - y.bt).map((f, i) => [f.name, i]));
  let pairs = 0, kept = 0;
  for (let i = 1; i < byA.length; i++) {
    if (byA[i].at === byA[i - 1].at) continue;
    pairs++;
    if (rankB.get(byA[i].name) - rankB.get(byA[i - 1].name) === 1) kept++;
  }
  const top = [...shifts].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([d, n]) => `${d > 0 ? "+" : ""}${d} B: ${n}`);
  json[group] = { both: both.length, exact, moved: both.length - unmoved, shifts: Object.fromEntries([...shifts].sort((x, y) => y[1] - x[1])), sameLineOffset: line, samePageOffset: page, neighbours: pairs, neighboursKept: kept };
  console.log(`${group} functions in both: ${both.length}; moved by exactly the pad: ${exact}; not moved: ${unmoved}; shifts: ${top.join(", ")}; same offset in a 64-byte line: ${line}, in a 4 KiB page: ${page}; A's neighbours still next in B, in order: ${kept} of ${pairs}`);
}
json.onlyA = [...fa.keys()].filter((n) => !fb.has(n));
json.onlyB = [...fb.keys()].filter((n) => !fa.has(n));
console.log(`only in A: ${json.onlyA.length}; only in B: ${json.onlyB.length} (${json.onlyB.join(", ")})`);
console.log("JSON " + JSON.stringify(json));