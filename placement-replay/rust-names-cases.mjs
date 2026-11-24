// Written cases for rust-names.mjs: an unpadded link's map as recorded, and the same map with
// one input section's name rewritten, each run through the script and its exit status checked.
//
//   node rust-names-cases.mjs <the head's unpadded map, gzipped> [<the base's>]
//
// Nothing is linked: a rewritten name moves no section. Exits 1 if a case does not go as written.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const [head, base] = process.argv.slice(2);
if (!head) {
  console.error('usage: node rust-names-cases.mjs <head.map.gz> [<base.map.gz>]');
  process.exit(2);
}
const script = join(dirname(fileURLToPath(import.meta.url)), 'rust-names.mjs');
const map = gunzipSync(readFileSync(head)).toString('utf8');
const dir = mkdtempSync(join(tmpdir(), 'rust-names-'));
let wrong = 0;

const run = (title, file, expected) => {
  const r = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  const ok = r.status === expected;
  if (!ok) wrong += 1;
  console.log(`== ${title}`);
  for (const l of r.stdout.trimEnd().split('\n')) console.log(`   ${l}`);
  for (const l of r.stderr.trimEnd().split('\n').filter(Boolean)) console.log(`   ! ${l}`);
  console.log(`   exit ${r.status}, ${ok ? 'as expected' : `NOT as expected (${expected})`}`);
};
// One input section's name rewritten, where `:(<from>)` ends a line: the only such line, or the
// first of `count` of them.
const renamed = (from, to, count = 1) => {
  const needle = `:(${from})`;
  const lines = map.split('\n');
  const hits = lines.flatMap((l, i) => (l.replace(/\r$/, '').endsWith(needle) ? [i] : []));
  if (hits.length !== count) throw new Error(`${from}: ${hits.length} input sections of that name`);
  lines[hits[0]] = lines[hits[0]].replace(needle, `:(${to})`);
  return lines.join('\n');
};
const written = (title, name, text, expected) => {
  const file = join(dir, name);
  writeFileSync(file, text);
  run(title, file, expected);
};

try {
  run('the head as recorded', head, 0);
  if (base) run('the base as recorded', base, 0);
  written("a built-in behind the library named as rustc's v0 scheme names a function",
    'v0.map', renamed('.text.round', '.text._RNvNtCs9ltgdHTiPiY_17compiler_builtins4math5round'), 1);
  written('the other named as the legacy scheme does',
    'legacy.map', renamed('.text.__udivti3',
      '.text._ZN17compiler_builtins3int4udiv8__udivti317h0123456789abcdefE'), 1);
  written('a cold section there, under .text.unlikely.',
    'unlikely.map', renamed('.text.round', '.text.unlikely._RNvNtCs9ltgdHTiPiY_17compiler_builtins4math5round'), 1);
  written('a section so named in another output section',
    'init.map', renamed('.init', '.text._RNvCs9ltgdHTiPiY_4init4init', 2), 1);
  written('a name that only begins like one (no hash under the legacy scheme) is not refused',
    'plain.map', renamed('.text.round', '.text._ZN5round5roundE'), 0);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(wrong ? `${wrong} cases not as expected` : 'every case as expected');
process.exit(wrong ? 1 : 0);
