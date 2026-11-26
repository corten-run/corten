// node --test bench/request-cost/figures.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { COUNTED, TICK, WARM, alone, each, held, median, resident, resolution, sent, ticks } from "./figures.mjs";

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

test("an idle reading is read to one page over its connections, rounded up to a whole byte", () => {
  assert.equal(resolution({ connections: 5000, page: 4096 }), 1);
  assert.equal(resolution({ connections: 4096, page: 4096 }), 1);
  assert.equal(resolution({ connections: 4095, page: 4096 }), 2);
  assert.equal(resolution({ connections: 40, page: 4096 }), 103);
  assert.equal(resolution({ connections: 5000, page: 65536 }), 14);
  assert.throws(() => resolution({ connections: 5000, page: 0 }), /not one/);
  assert.throws(() => resolution({ connections: 5000, page: NaN }), /not one/);
});
