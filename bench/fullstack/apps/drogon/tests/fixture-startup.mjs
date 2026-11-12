import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { records as catalogRecords } from '../../../../catalog/fixtures.mjs';
import { records as marketplaceRecords } from '../../../../marketplace/fixtures.mjs';

const [image] = process.argv.slice(2);
assert.ok(image, 'usage: node tests/fixture-startup.mjs IMAGE');
const temp = mkdtempSync(join(tmpdir(), 'corten-bench-parity-drogon-fixture-'));
const folder = new URL('./results/', import.meta.url);
mkdirSync(folder, { recursive: true });
const cases = [
  ['catalog malformed', 'catalog', '{'],
  ['catalog trailing data', 'catalog', JSON.stringify(catalogRecords()) + ' garbage'],
  ['catalog missing field', 'catalog', value => { delete value.record_1.title; }],
  ['catalog id mismatch', 'catalog', value => { value.record_1.id = 'wrong'; }],
  ['catalog unknown reference', 'catalog', value => { value.record_1.related[0].id = 'missing'; }],
  ['marketplace malformed', 'marketplace', '{'],
  ['marketplace negative count', 'marketplace', value => { value.item_1.summary.count = -1; }],
  ['marketplace rating bound', 'marketplace', value => { value.item_1.listings[0].rating_hundredths = 501; }],
  ['marketplace missing nullable field', 'marketplace', value => { delete value.item_1.subtitle; }],
  ['marketplace duplicate id', 'marketplace', value => { value.item_1.listings.push(value.item_1.listings[0]); }],
  ['marketplace id mismatch', 'marketplace', value => { value.item_1.id = 'wrong'; }],
  ['marketplace unknown reference', 'marketplace', value => { value.item_1.contents[0].item_id = 'missing'; }],
];
try {
  writeFileSync(join(temp, 'items.json'), JSON.stringify({ legacy: { catalog_item_id: 'legacy', title: 'Old item' } }));
  for (const [index, [label, payload, alter]] of cases.entries()) {
    const data = { catalog: catalogRecords(), marketplace: marketplaceRecords() };
    if (typeof alter === 'function') alter(data[payload]);
    for (const [kind, value] of Object.entries(data))
      writeFileSync(join(temp, kind + '.json'), kind === payload && typeof alter === 'string' ? alter : JSON.stringify(value));
    const name = `corten-bench-parity-drogon-fixture-${process.pid}-${index}`;
    const result = spawnSync('docker', ['run', '--rm', '--name', name, '--cpus', '1',
      '--label', 'agent.owner=codex', '--label', 'agent.task=corten-bench-parity-drogon',
      '-v', `${temp}:/fixtures:ro`, '-e', 'ITEM_SOURCE=fixture', '-e', 'FIXTURE_PATH=/fixtures/items.json',
      '-e', 'CATALOG_SOURCE=fixture', '-e', 'MARKETPLACE_SOURCE=fixture', image], { encoding: 'utf8', timeout: 60_000 });
    try {
      writeFileSync(new URL(`startup-${index}.txt`, folder), JSON.stringify({ label, status: result.status, signal: result.signal }) + '\n' + result.stdout + result.stderr);
      assert.ifError(result.error);
      assert.notEqual(result.status, 0, `${label}: invalid fixture must fail before listening`);
      assert.match(result.stderr + result.stdout, /(?:invalid|JSON|mismatch|unknown|must be|strings|arrays)/i, label);
      console.log(`PASS fixture startup: ${label} rejected, measured native exit ${result.status}`);
    } finally {
      // A timeout can leave docker run's container alive; remove only this test's named resource.
      spawnSync('docker', ['rm', '-f', '-v', name], { encoding: 'utf8', timeout: 20_000 });
    }
  }
  console.log(`PASS ${cases.length} invalid fixture startup probes`);
} finally { rmSync(temp, { recursive: true, force: true }); }
