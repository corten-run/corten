// Checks summary-wait.mjs on made-up rows (no host needed): a complete matrix of samples that
// meet every condition is usable, and each way a pass can be incomplete or a sample can fail its
// case's conditions makes it unusable. Usage: node check-summary.mjs (exits 1 on a failure).
import { summarize, DECLARED } from "./summary-wait.mjs";

const R = 6, N = 5; // a small matrix, with the declared sizes
const decl = { ...DECLARED, rounds: R, reps: N };
const row = (r, b, ...f) => [r, b, ...f].join("\t");
function files(edit = () => {}) {
  const t = {};
  for (let r = 1; r <= R; r++) for (const b of ["base", "head"]) {
    const L = [];
    for (let rep = 0; rep < N; rep++) {
      for (const h of DECLARED.helds) {
        const x = (b === "head" ? 6000 : 4000) + 10 * rep + r;
        L.push(row(r, b, rep, "idle", h, "-", 4000 + rep, "-", "-", "-", "-", "-", "-", "-", "-", "-", "-", "-"));
        for (const c of ["room", "refused", "contended"]) {
          const w = c === "contended";
          const job = b === "head" ? ["1800.0", "1700.0"] : ["-", "-"];
          const writer = w ? ["-30.0", "6000.0", "3800", "-25.0", b === "head" ? "1600.0" : "-"] : ["-", "-", "-", "-", "-"];
          const out = b === "head" ? (c === "refused" ? "refused" : "admitted") : "-";
          const att = b === "head" ? ["1500.0", w ? "1" : "0"] : ["-", "-"];
          const wait = b === "head" ? [w ? "5000.0" : "3.0"] : ["-"];
          L.push(row(r, b, rep, c, h, DECLARED.kept, x, ...job, ...writer.slice(0, 3), out, ...att, ...writer.slice(3), ...wait));
        }
        L.push(row(r, b, rep, "heldown", h, "-", 5300));
      }
      L.push(row(r, b, rep, "enc", "-", DECLARED.kept, 1800, 6628));
    }
    t[b + "-" + r + ".tsv"] = L.join("\n") + "\n";
  }
  edit(t);
  return t;
}
const lineEdit = (name, match, f) => (t) => {
  const L = t[name].split("\n");
  const i = L.findIndex((l) => match.every((m, j) => m === undefined || l.split("\t")[j] === String(m)));
  if (i < 0) throw new Error("no line " + match);
  const v = f(L[i]);
  if (v === null) L.splice(i, 1); else L.splice(i, 1, ...[].concat(v));
  t[name] = L.join("\n");
};
const set = (col, val) => (l) => { const f = l.split("\t"); f[col] = val; return f.join("\t"); };
let failed = 0;
function expect(name, t, usable, pattern, declared = decl) {
  const { out } = summarize(t, R, N, declared);
  const why = out.problems.join("; ");
  const ok = out.usable === usable && (!pattern || pattern.test(why));
  if (!ok) failed++;
  console.log((ok ? "ok   " : "FAIL ") + name + ": usable " + out.usable + (why ? " (" + why.slice(0, 160) + ")" : "") + (usable ? ", rank " + out.boundRank + ", gate " + (out.met ? "met" : "NOT met") : ""));
}
const C = ["round", "build", "rep", "case", "held", "kept"];
expect("complete matrix", files(), true);
expect("the declared matrix is required", files(), false, /not the declared/, DECLARED);
expect("a missing round file", files((t) => delete t["head-3.tsv"]), false, /head-3.tsv is missing/);
expect("an extra round file", files((t) => (t["base-7.tsv"] = t["base-1.tsv"])), false, /not a declared round/);
expect("a missing sample (78,967-byte room)", files(lineEdit("head-2.tsv", [2, "head", 1, "room", "78967"], () => null)), false, /no row for repetition 1 room 78967/);
expect("a duplicate sample", files(lineEdit("base-4.tsv", [4, "base", 0, "contended", "4021"], (l) => [l, l])), false, /2 rows/);
expect("a truncated row", files(lineEdit("base-5.tsv", [5, "base", 2, "idle", "4021"], (l) => l.split("\t").slice(0, 10).join("\t"))), false, /fields/);
expect("a non-numeric time", files(lineEdit("head-1.tsv", [1, "head", 3, "refused", "4021"], set(6, "NaN"))), false, /held_us/);
expect("a skipped room job at 78,967 bytes", files(lineEdit("head-6.tsv", [6, "head", 4, "room", "78967"], set(12, "skipped"))), false, /outcome skipped/);
expect("a room job refused", files(lineEdit("head-6.tsv", [6, "head", 4, "room", "4021"], set(12, "refused"))), false, /outcome refused/);
expect("a refused job admitted", files(lineEdit("head-2.tsv", [2, "head", 0, "refused", "78967"], set(12, "admitted"))), false, /outcome admitted/);
expect("contended: lock free at the request", files(lineEdit("head-2.tsv", [2, "head", 0, "contended", "4021"], set(14, "0"))), false, /lock was free/);
expect("contended: writer inside after the request", files(lineEdit("head-3.tsv", [3, "head", 1, "contended", "78967"], set(15, "1600.0"))), false, /not before att_us/);
expect("contended: writer never saw the request", files(lineEdit("head-3.tsv", [3, "head", 1, "contended", "4021"], set(16, "-"))), false, /w_seen_us/);
expect("contended: nothing evicted", files(lineEdit("base-1.tsv", [1, "base", 0, "contended", "4021"], set(11, "0"))), false, /dropped no page/);
expect("contended: no admission", files(lineEdit("head-1.tsv", [1, "head", 0, "contended", "4021"], set(8, "-"))), false, /locked_us/);
expect("room: lock held with no writer", files(lineEdit("head-1.tsv", [1, "head", 0, "room", "4021"], set(14, "1"))), false, /held with no writer/);
expect("a base row with a job", files(lineEdit("base-1.tsv", [1, "base", 0, "room", "4021"], set(12, "admitted"))), false, /outcome is admitted/);
expect("a missing reference row", files(lineEdit("base-2.tsv", [2, "base", 3, "heldown", "4021"], () => null)), false, /heldown 4021/);
expect("a zero reference time", files(lineEdit("head-2.tsv", [2, "head", 3, "enc"], set(6, "0"))), false, /enc/);
expect("a repetition past the declared", files(lineEdit("head-2.tsv", [2, "head", 3, "enc"], set(2, "9"))), false, /repetition 9/);
expect("a row of another round", files(lineEdit("head-2.tsv", [2, "head", 3, "enc"], set(0, "3"))), false, /round 3/);
expect("an undeclared held size", files(lineEdit("head-2.tsv", [2, "head", 3, "heldown", "4021"], set(4, "4096"))), false, /heldown 4096/);
// The statistic is by round: one round's shift moves one d_r, not 1/R of the pooled pairs.
{
  const { out } = summarize(files(), R, N, decl);
  const room = out.cases["room 4021"];
  const ok = room.rounds === R && room.boundRank === 6 && Math.abs(room.change - 2.0) < 1e-9;
  if (!ok) failed++;
  console.log((ok ? "ok   " : "FAIL ") + "per-round statistic: " + room.rounds + " rounds, rank " + room.boundRank + ", median d_r " + room.change + " ms");
}
console.log(failed ? failed + " FAILED" : "all ok");
process.exit(failed ? 1 : 0);
