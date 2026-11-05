// A round's repeated load phases (run-ssr.mjs's passes): what summarize.mjs reports of several
// passes of one phase, and when two apps' numbers differ by less than the runs vary. Pure, so
// passes.test.mjs tests it.

/** The most passes a round may ask for: each one is every load phase again. */
export const maxPasses = 5;

/**
 * The passes a round asks for (BENCH_PASSES, or droplet.mjs --passes): 1, 3 or 5, 1 when unset. An
 * odd count, so each median is the middle pass, not one end of two.
 * @param {string | undefined} text
 */
export function passesOf(text) {
  if (text === undefined || text === "") return 1;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > maxPasses || n % 2 === 0) throw new Error(`passes must be 1, 3 or 5, not ${text}`);
  return n;
}

/**
 * The file a pass of a phase writes, without its extension: pass 1 is the name a round of one pass
 * writes (`corten-sat64`), so older rounds read the same; pass 2 on adds `-p<pass>`.
 * @param {string} name `<app>[-json]-<phase>`
 * @param {number} pass from 1
 */
export const passFile = (name, pass) => (pass === 1 ? name : `${name}-p${pass}`);

/**
 * The median of a phase's passes and their range, or null when none has the number. The median of
 * an even count (a pass with no files leaves one) is the lower middle one, a value a pass measured.
 * @param {(number | null | undefined)[]} values one per pass
 * @returns {{ median: number, min: number, max: number } | null}
 */
export function spread(values) {
  const ok = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!ok.length) return null;
  return { median: ok[Math.floor((ok.length - 1) / 2)], min: ok[0], max: ok[ok.length - 1] };
}

/**
 * Whether two apps' numbers differ by less than their passes vary: their ranges overlap. Only said
 * of two numbers each from two or more passes, since one run has no range; null otherwise.
 * @param {{ min: number, max: number } | null} a @param {number} aPasses
 * @param {{ min: number, max: number } | null} b @param {number} bPasses
 */
export function withinNoise(a, aPasses, b, bPasses) {
  if (!a || !b || aPasses < 2 || bPasses < 2) return null;
  return a.min <= b.max && b.min <= a.max;
}
