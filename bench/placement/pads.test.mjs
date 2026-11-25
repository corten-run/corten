// The pad lists and the fourth point's phase rules (CONTRIBUTING.md, Pull requests, item 2), and
// the seeded order a part's placements run in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { coverage, pads, problems } from "./pads.mjs";
import { comparisons, lines, schedule, sides } from "./schedule.mjs";

// The first runs' lists (tags evidence/ee7b0b41 and evidence/request-gzip-1971-placed, plan.env).
const FIRST_P = "320 15120 25824 40624 10304 21008 35808 5552 20288 30992 736 15536 26176 36880 10720 21424 36160 5904 16608 31408 1088 15888 26592 37296 11072 21776 36576 6320 16960 31760".split(" ").map(Number);
const FIRST_Q = "22848 12160 38336 27648 12880 2192 32464 17680 7008 33184 22496 11808 38000 27312 12528 1840 32064 17280 6592 32768 22096 11408 37584 26896 16224 1440 31712 16928 6256 36528".split(" ").map(Number);

test("the generator's first 30 pairs are the first runs' lists, at any K", () => {
  assert.deepEqual(pads(30), { P: FIRST_P, Q: FIRST_Q });
  for (const K of [5, 16, 100, 254]) {
    const { P, Q } = pads(K), n = Math.min(K, 30);
    assert.deepEqual(P.slice(0, n), FIRST_P.slice(0, n));
    assert.deepEqual(Q.slice(0, n), FIRST_Q.slice(0, n));
  }
});

test("every K from 5 to 254 gives lists that meet the rule", () => {
  for (let K = 5; K <= 254; K++) {
    const { P, Q } = pads(K), all = [...P, ...Q], c = coverage(P, Q);
    assert.deepEqual(problems(P, Q), [], `K = ${K}`);
    // The rule itself, worked out here and not by problems().
    assert.equal(new Set(all).size, 2 * K, `K = ${K}: a size in both lists or twice in one`);
    assert.ok(all.every((x) => x % 16 === 0 && x >= 16 && x <= 40960), `K = ${K}: sizes`);
    assert.equal(new Set(P.map((p, i) => `${p % 64} ${Q[i] % 64}`)).size, Math.min(16, K), `K = ${K}: line phases`);
    const diffs = P.map((p, i) => (((Q[i] - p) % 4096) + 4096) % 4096);
    assert.equal(new Set(diffs).size, K, `K = ${K}: differences`);
    for (let q = 0; q < 4; q++) assert.ok(diffs.filter((d) => Math.floor(d / 1024) === q).length >= Math.floor(K / 8), `K = ${K}: quarter ${q}`);
    assert.deepEqual(c.diffs, diffs);
  }
});

test("the first list covers the phases of a line and of a page evenly", () => {
  const c = coverage(...Object.values(pads(100)));
  assert.deepEqual(c.P.line, [25, 25, 25, 25]);
  assert.deepEqual(c.P.pageQuarters, [25, 25, 25, 25]);
  assert.deepEqual(c.diffQuarters, [25, 25, 25, 25]);
  assert.ok(c.P.max <= 40960 && c.Q.max <= 40960 && c.P.min >= 16);
});

test("lists that break the rule are named for what they break", () => {
  const { P, Q } = pads(32);
  const broken = (change, word) => {
    const p = [...P], q = [...Q];
    change(p, q);
    const why = problems(p, q);
    assert.ok(why.some((w) => w.includes(word)), `${word}: ${why.join("; ") || "passed"}`);
  };
  broken((p, q) => { q[3] = p[7]; }, "a size repeats");
  broken((p) => { p[0] += 8; }, "not a multiple of 16");
  broken((p) => { p[0] = 40960 + 4096; }, "not a multiple of 16 from 16 to 40,960");
  broken((p, q) => { q.pop(); }, "differ in length");
  // q - p the same for two pairs: one difference fewer.
  broken((p, q) => { q[1] = q[0] - p[0] + p[1] + 4096 * 3; }, "q - p mod 4096 takes 31 values");
  // Every pair in one line phase: one combination.
  const flat = Array.from({ length: 16 }, (_, i) => 64 * (i + 1)), other = flat.map((x, i) => x + 64 * 17 * (i + 1));
  assert.ok(problems(flat, other).some((w) => w.includes("ordered combinations")));
  // Sixteen pairs, every line-phase combination, their differences all in the first 1,072 bytes
  // of a page: two quarters of a page have none.
  const p16 = Array.from({ length: 16 }, (_, i) => 4096 + 16 * (i % 4) + 64 * i), q16 = p16.map((p, i) => p + 16 * Math.floor(i / 4) + 64 * (i + 1));
  assert.ok(problems(p16, q16).some((w) => w.includes("fewer than 2 in one")), problems(p16, q16).join("; "));
  // The floor is an eighth of K: of 32 pairs, three differences in a quarter of a page are too
  // few, though a sixteenth of K is two. Five of the first quarter's eight move to the second.
  const q = [...Q];
  let moved = 0;
  for (let i = 0; i < 32 && moved < 5; i++) if ((((q[i] - P[i]) % 4096) + 4096) % 4096 < 1024) { q[i] += 1024; moved++; }
  assert.deepEqual(coverage(P, q).diffQuarters, [3, 13, 8, 8]);
  assert.ok(problems(P, q).some((w) => w.includes("q - p mod 4096 by quarter of a page is 3, 13, 8, 8: fewer than 4 in one")), problems(P, q).join("; "));
});

test("a schedule is a seeded order: the same every time, another with another seed", () => {
  const a = schedule("pilot", "plain", 100, 2026112401);
  assert.deepEqual(schedule("pilot", "plain", 100, 2026112401), a);
  assert.deepEqual(a.map((x) => x.i).sort((x, y) => x - y), Array.from({ length: 100 }, (_, i) => i + 1));
  assert.deepEqual(a.map((x) => x.seq), Array.from({ length: 100 }, (_, i) => i + 1));
  assert.notDeepEqual(schedule("pilot", "plain", 100, 2026112402).map((x) => x.i), a.map((x) => x.i));
  // The order a run recorded for this K and seed (tag evidence/deadline-timer-2,
  // pilot/close/results/schedule.txt): a change to the generator or the shuffle shows here.
  const recorded = "85 36 93 63 71 75 31 17 1 38 9 11 40 21 22 10 42 18 83 55 56 76 52 73 67 91 70 30 44 24 89 23 12 61 99 98 7 87 90 13 20 8 97 65 60 95 72 2 96 35 49 54 33 77 43 27 19 5 94 26 78 15 69 86 80 66 47 34 14 51 79 74 45 25 81 58 16 32 59 84 64 88 4 28 92 41 53 57 46 48 50 37 62 82 39 100 6 68 3 29";
  assert.equal(lines(schedule("pilot", "close", 100, 7303)), recorded.split(" ").map((i, k) => `${k + 1} pilot-close ${i}\n`).join(""));
});

test("a gated part turns the A/A and the change back to back at each index, first by turns", () => {
  const s = schedule("gated", "kept", 30, 5), pilot = schedule("pilot", "kept", 30, 5);
  assert.equal(s.length, 60);
  for (let k = 0; k < 30; k++) {
    const [one, two] = s.slice(2 * k, 2 * k + 2);
    assert.equal(one.i, pilot[k].i);
    assert.equal(two.i, pilot[k].i);
    assert.deepEqual([one.comparison, two.comparison], k % 2 ? ["change-kept", "aa-kept"] : ["aa-kept", "change-kept"]);
  }
  assert.deepEqual(comparisons("gated", "kept"), ["aa-kept", "change-kept"]);
  assert.throws(() => schedule("gated", "Kept", 30, 5));
  assert.throws(() => schedule("other", "kept", 30, 5));
  assert.throws(() => schedule("gated", "kept", 30, -1));
});

test("a placement's binaries: the change at one pad, the A/A at one of each list", () => {
  const { P, Q } = pads(30);
  assert.deepEqual(sides("change-plain", 1, P, Q), ["base-p320", "head-p320"]);
  assert.deepEqual(sides("aa-plain", 1, P, Q), ["base-p320", "base-p22848"]);
  assert.deepEqual(sides("pilot-plain", 30, P, Q), ["base-p31760", "base-p36528"]);
  assert.throws(() => sides("other-plain", 1, P, Q));
});
