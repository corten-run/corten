// The README's headline size of the runtime ("A(n) <size> KB (gzip) runtime"), which
// scripts/build-js.mjs writes from dist/corten.js and `--check` holds to it. Gzip at level 9 in KB
// of 1,024 bytes, as the README's other JavaScript sizes (bench/fullstack, bench/browser) are, so the
// number beside it can be compared with it.
import { gzipSync } from "node:zlib";

const said = /\bAn? (\d+\.\d) KB \(gzip\) runtime/;

/** "an 11.2", "an 8.4", "a 12.5", as the number is read aloud. */
export function article(/** @type {string} */ kb) {
  return /^(8|1[18](\.|$))/.test(kb) ? "An" : "A";
}

/** The phrase the README should have for a runtime of these bytes. */
export function phrase(/** @type {Uint8Array} */ runtime) {
  const kb = (gzipSync(runtime, { level: 9 }).length / 1024).toFixed(1);
  return `${article(kb)} ${kb} KB (gzip) runtime`;
}

/**
 * The README with its runtime phrase made `want`, or an error when it has none. `check` refuses a
 * README whose phrase is not `want` instead, allowing 0.1 KB, since another zlib may differ by a
 * few bytes.
 * @param {string} readme
 * @param {string} want
 * @param {boolean} check
 * @returns {{ text?: string, error?: string }}
 */
export function keep(readme, want, check) {
  const found = said.exec(readme);
  if (!found) return { error: 'no "A(n) <size> KB (gzip) runtime" to keep to the build' };
  if (!check) return { text: readme.replace(said, want) };
  const [, wantKb] = /** @type {RegExpExecArray} */ (said.exec(want));
  const close = Math.abs(Number(found[1]) - Number(wantKb)) <= 0.1 + 1e-9;
  if (!close || found[0].split(" ")[0] !== article(found[1])) {
    return { error: `says "${found[0]}"; dist/corten.js is "${want}": run npm run build:js` };
  }
  return { text: readme };
}
