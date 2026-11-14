import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLiveWorkload, validateLiveCapture } from '../../../../workloads/live.mjs';
import { wireEvents, wireSnapshots, reverbEvents } from '../wire.mjs';

const records = (await readFile(new URL('./receipts/browser-raw.jsonl', import.meta.url), 'utf8')).trim().split('\n').map(JSON.parse);
const cases = records.filter(record => record.kind === 'case');
assert.equal(cases.length, 6);
function safe(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['checksum', 'csrf', 'csrftoken', 'snapshotencoded', '_token', 'cookie', 'set-cookie'].includes(key.toLowerCase()), key);
    safe(child);
  }
}
safe(records);
for (const header of cases) {
  const own = records.filter(record => record.scenario === header.scenario);
  const capture = { schema: header.schema, contract: header.contract,
    records: own.filter(record => record.kind === 'application-record').map(record => record.record) };
  const network = own.filter(record => record.kind === 'native-network-record').map(({ record }) => record.kind === 'native-livewire-response'
    ? { ...record, body: { components: [{ effects: { dispatches: record.dispatches } }] } } : record);
  validateLiveCapture(createLiveWorkload({ seed: 17, rowCount: 5, eventCount: 24 }), capture, header.settings);
  assert.deepEqual(wireEvents(network), reverbEvents(network));
  assert.deepEqual(wireEvents(network), capture.records.filter(record => record.kind === 'event').map(record => record.event));
  assert.deepEqual(wireSnapshots(network), capture.records.filter(record => record.kind === 'snapshot').map(({ through, rows, work }) => ({ through, rows, work })));
}
console.log(`${cases.length} saved browser cases / ${records.length} raw records revalidated without signed snapshot/token fields`);
