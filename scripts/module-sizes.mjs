// The size the guides state for each of Corten's own script modules, which scripts/build-js.mjs
// writes from the module it builds and `--check` holds to it, as scripts/readme-size.mjs does for
// the runtime. A size is written right after the module's name, as "`corten/read` is a module of
// its own (749 bytes, 486 gzipped)": the bytes as built, then gzip at zlib's default level (6), as
// the runtime's size is measured. The bytes are exact; the gzip number passes within 32 bytes,
// since another zlib may differ (see readme-size.mjs), and a build leaves such a number as it is.
import { gzipped } from "./readme-size.mjs";

/** Each module a guide may give a size for, by the name a script imports or the page loads. */
export const MODULES = {
  "corten-format": "format.js",
  "corten-part": "part.js",
  "corten-upload": "upload.js",
  "corten/keys": "keys.js",
  "corten/read": "read.js",
};

// A module's name in backticks, then up to 80 characters of the same line with no other code
// span, then a parenthesis that starts with a size.
const stated = /`(corten[-/][a-z]+)`([^`\n]{0,80}?)\(((?:about |under |~)?[\d.,]+ ?(?:B|kB|KB|bytes)\b[^)\n]*)\)/g;
const canonical = /^([\d,]+) bytes, ([\d,]+) gzipped$/;

/** "3,005": a byte count as the guides write it. */
export function count(/** @type {number} */ n) {
  return n.toLocaleString("en-US");
}

/** The parenthesis a guide should have for a module of `bytes` bytes and `gzip` gzipped. */
export function phrase(/** @type {number} */ bytes, /** @type {number} */ gzip) {
  return `${count(bytes)} bytes, ${count(gzip)} gzipped`;
}

/**
 * The guide with every module size made the built module's (unchanged where it already is), and
 * the errors: a size in another form, or for a module that is not one of `MODULES`, or, when
 * checking, a size the build does not have.
 * @param {string} guide
 * @param {Record<string, Uint8Array | string>} built  each `MODULES` file name's built text
 * @param {boolean} check
 * @returns {{ text: string, errors: string[] }}
 */
export function keepSizes(guide, built, check) {
  /** @type {string[]} */
  const errors = [];
  const text = guide.replace(stated, (all, name, between, size) => {
    const file = MODULES[/** @type {keyof typeof MODULES} */ (name)];
    if (!file || built[file] === undefined) {
      errors.push(`gives a size for \`${name}\`, which is not one of Corten's modules a build measures`);
      return all;
    }
    const module = built[file];
    const bytes = typeof module === "string" ? Buffer.byteLength(module) : module.length;
    const gzip = gzipped(module);
    const want = phrase(bytes, gzip);
    const found = canonical.exec(size);
    if (!found) {
      errors.push(`gives \`${name}\` as "(${size})"; write "(${want})", which a build keeps`);
      return all;
    }
    const [saidBytes, saidGzip] = [found[1], found[2]].map((n) => Number(n.replaceAll(",", "")));
    if (size === phrase(saidBytes, saidGzip) && saidBytes === bytes && Math.abs(saidGzip - gzip) <= 32) return all;
    if (check) {
      errors.push(`says \`${name}\` is "${size}"; the built ${file} is "${want}": run npm run build:js`);
      return all;
    }
    return `\`${name}\`${between}(${want})`;
  });
  return { text, errors };
}