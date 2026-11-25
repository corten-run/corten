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
