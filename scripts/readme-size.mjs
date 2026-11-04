// The README's headline size of the runtime ("A(n) <size> KB (gzip) runtime"), which
// scripts/build-js.mjs writes from the runtime it builds and `--check` holds to it. Gzip at zlib's
// default level (6) in KB of 1,024 bytes, as bench/fullstack measures the item page's JavaScript
// beside it, so the two can be compared.
import { gzipSync } from "node:zlib";

const said = /\bAn? (\d+\.\d) KB \(gzip\) runtime/g;

/** "an 11.2", "an 8.4", "a 12.5", as the number is read aloud. */
export function article(/** @type {string} */ kb) {
  return /^(8|1[18](\.|$))/.test(kb) ? "An" : "A";
}

/** The runtime's gzip size in bytes. */
export function gzipped(/** @type {Uint8Array | string} */ runtime) {
  return gzipSync(runtime).length;
}

/** The phrase the README should have for a runtime of `bytes` gzipped. */
export function phrase(/** @type {number} */ bytes) {
  const kb = (bytes / 1024).toFixed(1);
  return `${article(kb)} ${kb} KB (gzip) runtime`;
}

/**
 * The README with its one runtime phrase made the one for `bytes` (unchanged when it is already),
 * or an error when it has none or more than one. `check` refuses a README whose phrase is not one
 * a runtime within 32 bytes of `bytes` would have, since another zlib may differ by a few bytes.
 * @param {string} readme
 * @param {number} bytes
 * @param {boolean} check
 * @returns {{ text?: string, error?: string }}
 */
export function keep(readme, bytes, check) {
  const found = [...readme.matchAll(said)];
  if (found.length === 0) return { error: 'no "A(n) <size> KB (gzip) runtime" to keep to the build' };
  if (found.length > 1) return { error: `${found.length} "A(n) <size> KB (gzip) runtime" phrases; keep one` };
  const [said0] = found[0];
  const allowed = new Set([-32, 0, 32].map((d) => phrase(Math.max(0, bytes + d))));
  if (allowed.has(said0)) return { text: readme };
  if (check) return { error: `says "${said0}"; the runtime is "${phrase(bytes)}": run npm run build:js` };
  return { text: readme.replace(said0, phrase(bytes)) };
}
