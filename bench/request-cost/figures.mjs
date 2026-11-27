// The arithmetic of a count and of an idle reading, apart from what runs the probe.

/** Requests a connection answers before its counted ones, so the first requests' one-time work is not counted. */
export const WARM = 240;
/** Requests counted. */
export const COUNTED = 1000;

/**
 * How many of `count` requests are written `depth` at a time: whole batches only, so 992 of
 * 1,000 at 16. @param {number} count @param {number} depth
 */
export const sent = (count, depth) => Math.floor(count / depth) * depth;

/**
 * What one request cost, when the counted requests written `depth` at a time cost `total`.
 * @param {number} total @param {number} depth
 */
export const each = (total, depth) => total / sent(COUNTED, depth);

/**
 * What the probe's other thread, the clock Corten closes idle connections by, may run each time
 * it wakes, which is once a second. It ran 243 instructions a tick with one connection open (on
 * `c9666dc96`); this leaves room for a commit that changes the clock a little.
 */
export const TICK = 300;

/**
 * The most that threads other than the serving one can have run in a window of `seconds` when
 * the clock is all that ran on them: a tick for each whole second, one more for the part of a
 * second, and one more because the seconds are read from outside the window.
 * @param {number} seconds
 */
export const ticks = (seconds) => (Math.floor(seconds) + 2) * TICK;

/**
 * Refuses a window that is not a count of its requests. A count reads the probe's first thread
 * alone, so that thread must have served (at least an instruction a request), and the other
 * threads together must have run no more than the clock's ticks explain: work a commit moves to
 * another thread is otherwise a saving that is none.
 * @param {{ serving: number, others: number, threads: number, seconds: number }} window what the
 *   first thread ran, what the `threads` other ones ran together, and how long the window lasted
 * @param {number} depth
 */
export function alone({ serving, others, threads, seconds }, depth) {
  const requests = sent(COUNTED, depth);
  if (serving < requests) {
    throw new Error(`not a count: the probe's first thread ran ${serving} instructions for ${requests} requests, so it did not serve them (${threads} other threads ran ${others})`);
  }
  if (others > ticks(seconds)) {
    throw new Error(
      `not a count: ${threads} other threads ran ${others} instructions in a window of ${seconds.toFixed(1)} s, where the clock's ticks explain ${ticks(seconds)} at most; ` +
        `the first thread ran ${serving}, and a count reads it alone`,
    );
  }
}

/** The middle of an odd number of counts, the upper of the two middle ones of an even number. @param {number[]} counts */
export function median(counts) {
  const ordered = [...counts].sort((a, b) => a - b);
  return /** @type {number} */ (ordered[Math.floor(ordered.length / 2)]);
}

/** A process's resident memory in bytes, from its `/proc/<pid>/status`, which gives it in kB. @param {string} status */
export function resident(status) {
  const found = /^VmRSS:\s+(\d+) kB$/m.exec(status);
  if (!found) throw new Error("no VmRSS in the probe's status");
  return Number(found[1]) * 1024;
}

/**
 * Bytes a connection holds: the growth of resident memory over the connections opened. Refuses a
 * run that did not hold them all: one the probe closed holds nothing, and one the probe has not
 * accepted (it waits in the listen queue when the probe may open no more files) is no file of its.
 * @param {{ connections: number, before: number, after: number, closed: number, accepted: number }} run
 *   `before` and `after` in bytes; `accepted` is the growth in the probe's open files
 */
export function held({ connections, before, after, closed, accepted }) {
  if (closed > 0) throw new Error(`not a measurement: the probe had closed ${closed} of the ${connections} connections`);
  if (accepted !== connections) throw new Error(`not a measurement: the probe held ${accepted} more open files for ${connections} connections`);
  return Math.round((after - before) / connections);
}

/**
 * The pages a rise of idle memory is allowed whatever base's runs span: the floor of the rule,
 * in pages of the size the runs were read in. It was one page, the least a reading can show,
 * until the maintainer raised it to four on 2026-11-27 (docs/design.md#choice-counted-or-measured).
 */
const FLOOR_PAGES = 4;

/**
 * Whether head's idle memory rose past base's, read from each run's growth of resident memory in
 * bytes (its after less its before, which `idle.mjs` prints), never from the figures a connection,
 * which are rounded. Head rises when the median of its three growths is above base's by more than
 * the larger of base's three span and four pages (`FLOOR_PAGES`): resident memory moves a page at
 * a time, and the span is what base's own readings moved by. Four pages are the least allowed,
 * not the most, and they are allowed only over at least as many connections as a page has bytes,
 * so they are at most four bytes a connection (16,384 bytes over 5,000 connections in 4,096-byte
 * pages is under 3.3): over fewer, four pages are a coarser step than the gate lets pass, and the
 * readings decide nothing.
 * @param {{ base: number[], head: number[], page: number, connections: number }} readings three
 *   growths in bytes each, the page size in bytes (`getconf PAGESIZE`) and the connections all six
 *   runs opened
 */
export function idleRise({ base, head, page, connections }) {
  if (!Number.isSafeInteger(page) || page <= 0) throw new Error(`a page of ${page} bytes is not one`);
  if (!Number.isSafeInteger(connections) || connections <= 0) throw new Error(`${connections} connections are not a count of them`);
  if (connections < page) throw new Error(`not a gate reading: four ${page}-byte pages over ${connections} connections are more than four bytes a connection; open at least ${page}`);
  for (const [side, growths] of /** @type {const} */ ([["base", base], ["head", head]])) {
    if (growths.length !== 3) throw new Error(`${side} has ${growths.length} idle readings, not three`);
    for (const growth of growths) {
      if (!Number.isSafeInteger(growth)) throw new Error(`${side}'s growth of ${growth} bytes is not a whole number`);
      // Resident memory moves a page at a time, so a growth that is not whole pages is not one
      // `idle.mjs` printed: a figure a connection, which is rounded, given in its place.
      if (growth % page !== 0) throw new Error(`${side}'s growth of ${growth} bytes is not whole ${page}-byte pages: give each run's growth, not its figure a connection`);
    }
  }
  const rise = median(head) - median(base);
  const allowed = Math.max(Math.max(...base) - Math.min(...base), FLOOR_PAGES * page);
  return { rise, allowed, rose: rise > allowed };
}
