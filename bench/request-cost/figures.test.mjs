// node --test bench/request-cost/figures.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { COUNTED, WARM, each, held, median, resident, sent } from "./figures.mjs";

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
