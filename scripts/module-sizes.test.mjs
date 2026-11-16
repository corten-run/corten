import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { keepSizes, phrase } from "./module-sizes.mjs";

// 749 bytes that gzip to a few hundred, as a module does.
const read = Array.from({ length: 749 }, (_, i) => String.fromCharCode(33 + ((i * 7919) % 89))).join("");
const gz = gzipSync(read).length;
const built = { "read.js": read };

test("a build writes the built size after a module's name, and a check holds the guide to it", () => {
  const guide = "`corten/read` is a module of its own (700 bytes, 400 gzipped), served";
  const written = keepSizes(guide, built, false);
  assert.deepEqual(written.errors, []);
  assert.equal(written.text, `\`corten/read\` is a module of its own (${phrase(749, gz)}), served`);
  assert.deepEqual(keepSizes(written.text, built, true).errors, []);
  assert.match(keepSizes(guide, built, true).errors[0], /says `corten\/read` is "700 bytes, 400 gzipped"/);
});

test("the bytes are exact and the gzip number passes within 32 bytes, where a build leaves it", () => {
  for (const [said, ok] of [[phrase(749, gz + 32), true], [phrase(749, gz - 32), true], [phrase(749, gz + 33), false], [phrase(750, gz), false], ["749 bytes, 0 gzipped", false]]) {
    const guide = `\`corten/read\` (${said})`;
    assert.equal(keepSizes(guide, built, true).errors.length === 0, ok, said);
    if (ok) assert.equal(keepSizes(guide, built, false).text, guide, `a build keeps ${said}`);
  }
});

test("a size in another form, or for a module no build measures, is refused", () => {
  for (const guide of ["`corten/read` is a module of its own (about 1 KB gzip)", "loads `corten/read` (0.7 kB, 0.5 kB gzipped)", "`corten/read` (749 B gzip)", "`corten/read` (749 bytes,486 gzipped)"]) {
    assert.equal(keepSizes(guide, built, true).errors.length, 1, guide);
    assert.equal(keepSizes(guide, built, false).errors.length, 1, guide);
    assert.equal(keepSizes(guide, built, false).text, guide, `a build leaves ${guide}`);
  }
  assert.match(keepSizes("`corten/nope` (749 bytes, 486 gzipped)", built, true).errors[0], /`corten\/nope`/);
  assert.match(keepSizes("`corten-format` (749 bytes, 486 gzipped)", built, true).errors[0], /`corten-format`/, "a module whose build is missing");
});

test("a size that is not right after a module's name is not read as the module's", () => {
  for (const guide of ["`corten/read`\n(60 bytes, under 10 compressed)", "`corten/read` and `corten/keys` both (12 bytes, 5 gzipped)", "`App::script` (1,000 bytes, 400 gzipped)"]) {
    const kept = keepSizes(guide, built, true);
    assert.ok(kept.errors.every((e) => !e.includes("corten/read")), guide);
  }
});

test("byte counts are written with thousands separators", () => {
  assert.equal(phrase(3005, 1492), "3,005 bytes, 1,492 gzipped");
});