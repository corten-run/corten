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

test("head's idle memory rises past base's by its growths in bytes, beyond base's span and one page", () => {
  const page = 4096, connections = 5000;
  const grew = (/** @type {number} */ pages) => pages * page;
  // Base's three readings agree: one page more passes, two do not.
  assert.deepEqual(idleRise({ base: [grew(15335), grew(15335), grew(15335)], head: [grew(15336), grew(15336), grew(15335)], page, connections }), { rise: page, allowed: page, rose: false });
  assert.deepEqual(idleRise({ base: [grew(15335), grew(15335), grew(15335)], head: [grew(15337), grew(15337), grew(15337)], page, connections }), { rise: 2 * page, allowed: page, rose: true });
  // The case #2136's review found: 5,000 connections and two pages more, whose figures a connection,
  // rounded, are only one byte apart (12,562 and 12,563), and still a rise.
  const base = grew(15334), head = grew(15336);
  const run = { connections: 5000, before: 0, closed: 0, accepted: 5000 };
  assert.deepEqual([held({ ...run, after: base }), held({ ...run, after: head })], [12562, 12563]);
  assert.equal(idleRise({ base: [base, base, base], head: [head, head, head], page, connections }).rose, true);
  // The median decides, not the first or the largest reading, in any order.
  assert.deepEqual(idleRise({ base: [grew(10), grew(10), grew(10)], head: [grew(11), grew(16), grew(12)], page, connections }), { rise: 2 * page, allowed: page, rose: true });
  assert.deepEqual(idleRise({ base: [grew(12), grew(10), grew(11)], head: [grew(9), grew(12), grew(14)], page, connections }), { rise: page, allowed: 2 * page, rose: false });
  // The page is the one given: one 64 KiB page more passes, which 4 KiB would refuse.
  const large = 65536;
  assert.deepEqual(idleRise({ base: [large * 9, large * 9, large * 9], head: [large * 10, large * 10, large * 10], page: large, connections: large }), { rise: large, allowed: large, rose: false });
  // A wider span allows more than a page; a fall is no rise.
  assert.deepEqual(idleRise({ base: [grew(10), grew(13), grew(11)], head: [grew(14), grew(14), grew(14)], page, connections }), { rise: 3 * page, allowed: 3 * page, rose: false });
  assert.equal(idleRise({ base: [grew(10), grew(10), grew(10)], head: [grew(4), grew(4), grew(4)], page, connections }).rose, false);
  assert.throws(() => idleRise({ base: [1, 1, 1], head: [1, 1, 1], page: 0, connections }), /not one/);
  assert.throws(() => idleRise({ base: [1, 1, 1], head: [1, 1, 1], page: 4096.5, connections }), /not one/);
  assert.throws(() => idleRise({ base: [1, 1, 1], head: [1, 1, 1], page: 9007199254740992, connections }), /not one/);
  assert.throws(() => idleRise({ base: [1, 1], head: [1, 1, 1], page, connections }), /base has 2 idle readings, not three/);
  assert.throws(() => idleRise({ base: [1, 1, 1], head: [1, 1, 1, 1], page, connections }), /head has 4 idle readings, not three/);
  assert.throws(() => idleRise({ base: [1, 1, 1], head: [1, 1, 1.5], page, connections }), /head's growth of 1.5 bytes is not a whole number/);
  assert.throws(() => idleRise({ base: [1.5, 1, 1], head: [1, 1, 1], page, connections }), /base's growth of 1.5 bytes is not a whole number/);
  // A page is allowed only where it is at most a byte a connection: a run over fewer connections than
  // a page has bytes decides nothing (#2149's review: one page over 40 is 102 bytes a connection).
  const one = { base: [grew(10), grew(10), grew(10)], head: [grew(11), grew(11), grew(11)], page };
  assert.deepEqual(idleRise({ ...one, connections: page }), { rise: page, allowed: page, rose: false });
  assert.throws(() => idleRise({ ...one, connections: 40 }), /not a gate reading: one 4096-byte page over 40 connections is more than a byte a connection; open at least 4096/);
  assert.throws(() => idleRise({ ...one, connections: page - 1 }), /not a gate reading/);
  assert.throws(() => idleRise({ base: [large * 9, large * 9, large * 9], head: [large * 10, large * 10, large * 10], page: large, connections }), /open at least 65536/);
  for (const count of [0, -1, 1.5, Number.NaN]) assert.throws(() => idleRise({ ...one, connections: count }), /are not a count of them/);});
