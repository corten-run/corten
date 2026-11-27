// node --test bench/request-cost/figures.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { COUNTED, TICK, WARM, alone, each, held, idleRise, median, resident, sent, ticks } from "./figures.mjs";

test("a connection answers 240 requests before the 1,000 that are counted", () => {
  assert.deepEqual([WARM, COUNTED], [240, 1000]);
});

test("requests are sent in whole batches of the depth", () => {
  assert.equal(sent(1000, 1), 1000);
  assert.equal(sent(1000, 16), 992);
  assert.equal(sent(240, 16), 240);
  assert.equal(sent(240, 7), 238);
  assert.equal(sent(240, 241), 0);
});

test("one request's cost is the total over the counted requests that were sent", () => {
  assert.equal(each(18_971_934, 1), 18_971.934);
  assert.equal(each(16_000, 1), 16);
  // 16 at a time, 992 are counted, not 1,000.
  assert.equal(each(992_000, 16), 1000);
  assert.equal(each(10_912, 16), 11);
});

test("the clock's ticks explain a tick for each whole second of a window, and two more", () => {
  assert.equal(TICK, 300);
  assert.deepEqual([ticks(0.3), ticks(0.99), ticks(1), ticks(16.8)], [600, 600, 900, 5400]);
});

test("a window is a count only when the first thread served and the others ran no more than the clock", () => {
  const window = { serving: 18_987_000, others: 243, threads: 1, seconds: 0.4 };
  assert.equal(alone(window, 1), undefined);
  // The clock alone over a long window, and no other thread at all.
  assert.equal(alone({ ...window, others: 17 * 243, seconds: 16.8 }, 1), undefined);
  assert.equal(alone({ ...window, others: 0, threads: 0 }, 1), undefined);
  assert.equal(alone({ ...window, others: 600 }, 1), undefined);
  assert.throws(() => alone({ ...window, others: 601 }, 1), /not a count: 1 other threads ran 601 instructions in a window of 0\.4 s, where the clock's ticks explain 600 at most; the first thread ran 18987000/);
  // A probe that serves on another thread: the first ran nothing, or less than an instruction a request.
  assert.throws(() => alone({ serving: 0, others: 19_584_187, threads: 2, seconds: 0.4 }, 1), /not a count: the probe's first thread ran 0 instructions for 1000 requests, so it did not serve them \(2 other threads ran 19584187\)/);
  assert.throws(() => alone({ ...window, serving: 999 }, 1), /first thread ran 999 instructions for 1000 requests/);
  assert.equal(alone({ ...window, serving: 1000 }, 1), undefined);
  // At a depth of 16, 992 requests are counted.
  assert.equal(alone({ ...window, serving: 992 }, 16), undefined);
  assert.throws(() => alone({ ...window, serving: 991 }, 16), /for 992 requests/);
});

test("the median is the middle count by size, the upper middle of an even number", () => {
  assert.equal(median([19175, 19169, 19171]), 19171);
  assert.equal(median([5]), 5);
  // By size, not as text, where 100 comes before 5.
  assert.equal(median([100, 5, 10]), 10);
  assert.equal(median([4, 1, 3, 2]), 3);
});

test("resident memory is the status file's VmRSS, which is in kB", () => {
  const status = "Name:\tprobe\nVmHWM:\t   60000 kB\nVmRSS:\t   48528 kB\nRssAnon:\t   40000 kB\n";
  assert.equal(resident(status), 49_692_672);
  assert.throws(() => resident("Name:\tprobe\nVmHWM:\t   60000 kB\n"), /no VmRSS/);
});

test("an idle reading is the growth over the connections, and only of a run that held them all", () => {
  const run = { connections: 5000, before: 7_577_600, after: 49_692_672, closed: 0, accepted: 5000 };
  assert.equal(held(run), 8423);
  assert.throws(() => held({ ...run, closed: 1 }), /had closed 1 of the 5000 connections/);
  assert.throws(() => held({ ...run, accepted: 1014 }), /held 1014 more open files for 5000 connections/);
  assert.throws(() => held({ ...run, accepted: 5001 }), /held 5001 more open files/);
});

test("head's idle memory rises past base's by its growths in bytes, beyond base's span and four pages", () => {
  const page = 4096, connections = 5000;
  const grew = (/** @type {number} */ pages) => pages * page;
  const agree = [grew(15335), grew(15335), grew(15335)];
  // Base's three readings agree: four pages more pass (16,384 bytes), five do not (20,480).
  assert.deepEqual(idleRise({ base: agree, head: [grew(15339), grew(15339), grew(15335)], page, connections }), { rise: 16_384, allowed: 16_384, rose: false });
  assert.deepEqual(idleRise({ base: agree, head: [grew(15340), grew(15340), grew(15340)], page, connections }), { rise: 20_480, allowed: 16_384, rose: true });
  // The rises the floor was raised for, one, two and three pages over base's agreeing three
  // (4,096, 8,192 and 12,288 bytes), are under it, where one page allowed passed only the first.
  for (const pages of [1, 2, 3]) {
    const head = [grew(15335 + pages), grew(15335 + pages), grew(15335 + pages)];
    assert.deepEqual(idleRise({ base: agree, head, page, connections }), { rise: pages * page, allowed: 4 * page, rose: false }, String(pages));
  }
  // What it still sees: one 8-byte field a connection, 40,000 bytes over 5,000, read as nine or
  // ten pages, and over the fewest connections a 4,096-byte page allows, 32,768 bytes, eight pages.
  for (const pages of [9, 10]) assert.equal(idleRise({ base: agree, head: [grew(15335 + pages), grew(15335 + pages), grew(15335 + pages)], page, connections }).rose, true, String(pages));
  assert.equal(idleRise({ base: agree, head: [grew(15343), grew(15343), grew(15343)], page, connections: page }).rose, true);
  // The figures a connection, rounded, do not tell the two sides of the floor apart (#2136's
  // review found it at one page): over 5,000 connections four pages more and five pages more can
  // both read 12,562 and 12,566, and only the five are a rise.
  const run = { connections: 5000, before: 0, closed: 0, accepted: 5000 };
  const head = grew(15339);
  for (const [base, rose] of /** @type {const} */ ([[grew(15335), false], [grew(15334), true]])) {
    assert.deepEqual([held({ ...run, after: base }), held({ ...run, after: head })], [12562, 12566]);
    assert.equal(idleRise({ base: [base, base, base], head: [head, head, head], page, connections }).rose, rose);
  }
  // The median decides, not the first or the largest reading, in any order.
  assert.deepEqual(idleRise({ base: [grew(10), grew(10), grew(10)], head: [grew(11), grew(30), grew(15)], page, connections }), { rise: 5 * page, allowed: 4 * page, rose: true });
  assert.deepEqual(idleRise({ base: [grew(12), grew(10), grew(11)], head: [grew(9), grew(15), grew(30)], page, connections }), { rise: 4 * page, allowed: 4 * page, rose: false });
  // The page is the one given: four 64 KiB pages more pass, which 4 KiB pages would refuse, and five do not.
  const large = 65536;
  assert.deepEqual(idleRise({ base: [large * 9, large * 9, large * 9], head: [large * 13, large * 13, large * 13], page: large, connections: large }), { rise: 4 * large, allowed: 4 * large, rose: false });
  assert.deepEqual(idleRise({ base: [large * 9, large * 9, large * 9], head: [large * 14, large * 14, large * 14], page: large, connections: large }), { rise: 5 * large, allowed: 4 * large, rose: true });
  // A span of base's wider than four pages still governs, and allows no more than itself; a
  // span under four pages allows the four; a fall is no rise.
  assert.deepEqual(idleRise({ base: [grew(10), grew(16), grew(11)], head: [grew(17), grew(17), grew(17)], page, connections }), { rise: 6 * page, allowed: 6 * page, rose: false });
  assert.deepEqual(idleRise({ base: [grew(10), grew(16), grew(11)], head: [grew(18), grew(18), grew(18)], page, connections }), { rise: 7 * page, allowed: 6 * page, rose: true });
  assert.deepEqual(idleRise({ base: [grew(10), grew(13), grew(11)], head: [grew(15), grew(15), grew(15)], page, connections }), { rise: 4 * page, allowed: 4 * page, rose: false });
  assert.deepEqual(idleRise({ base: [grew(10), grew(13), grew(11)], head: [grew(16), grew(16), grew(16)], page, connections }), { rise: 5 * page, allowed: 4 * page, rose: true });
  assert.equal(idleRise({ base: [grew(10), grew(10), grew(10)], head: [grew(4), grew(4), grew(4)], page, connections }).rose, false);
  assert.throws(() => idleRise({ base: [1, 1, 1], head: [1, 1, 1], page: 0, connections }), /not one/);
  assert.throws(() => idleRise({ base: [1, 1, 1], head: [1, 1, 1], page: 4096.5, connections }), /not one/);
  assert.throws(() => idleRise({ base: [1, 1, 1], head: [1, 1, 1], page: 9007199254740992, connections }), /not one/);
  assert.throws(() => idleRise({ base: [page, page], head: [page, page, page], page, connections }), /base has 2 idle readings, not three/);
  assert.throws(() => idleRise({ base: [page, page, page], head: [page, page, page, page], page, connections }), /head has 4 idle readings, not three/);
  assert.throws(() => idleRise({ base: [page, page, page], head: [page, page, 1.5], page, connections }), /head's growth of 1.5 bytes is not a whole number/);
  assert.throws(() => idleRise({ base: [1.5, page, page], head: [page, page, page], page, connections }), /base's growth of 1.5 bytes is not a whole number/);
  assert.throws(() => idleRise({ base: [2 ** 53, page, page], head: [page, page, page], page, connections }), /not a whole number/);
  // The figures a connection, rounded, are not growths: a rise given as its figures (12,562 and
  // 12,563, #2136's) is refused, not read as a rise of one byte.
  assert.throws(() => idleRise({ base: [12562, 12562, 12562], head: [12563, 12563, 12563], page, connections }), /base's growth of 12562 bytes is not whole 4096-byte pages: give each run's growth, not its figure a connection/);
  assert.throws(() => idleRise({ base: [page, page, page], head: [page, page, page + 1], page, connections }), /head's growth of 4097 bytes is not whole 4096-byte pages/);
  // A shrink is whole pages too.
  assert.equal(idleRise({ base: [page, page, page], head: [-page, -page, -page], page, connections }).rose, false);
  // The four pages are allowed only where they are at most four bytes a connection: a run over
  // fewer connections than a page has bytes decides nothing (#2149's review, of one page: over 40
  // connections one page is 102 bytes a connection, and four are 410).
  const one = { base: [grew(10), grew(10), grew(10)], head: [grew(14), grew(14), grew(14)], page };
  assert.deepEqual(idleRise({ ...one, connections: page }), { rise: 4 * page, allowed: 4 * page, rose: false });
  assert.throws(() => idleRise({ ...one, connections: 40 }), /not a gate reading: four 4096-byte pages over 40 connections are more than four bytes a connection; open at least 4096/);
  assert.throws(() => idleRise({ ...one, connections: page - 1 }), /not a gate reading/);
  assert.throws(() => idleRise({ base: [large * 9, large * 9, large * 9], head: [large * 10, large * 10, large * 10], page: large, connections }), /open at least 65536/);
  for (const count of [0, -1, 1.5, Number.NaN]) assert.throws(() => idleRise({ ...one, connections: count }), /are not a count of them/);});
