import assert from 'node:assert/strict';
import test from 'node:test';
import { wireEvents, wireSnapshots } from '../wire.mjs';

test('extracts only native update deliveries, preserving duplicates and rejecting key drift', () => {
  const event = { seq: 1, effectId: 'one', key: 'a', op: 'upsert', row: { id: 'a', version: 1, priceCents: 2, quantity: 3 } };
  const frame = { kind: 'native-sse', eventName: 'update', data: JSON.stringify(event) };
  assert.deepEqual(wireEvents([{ kind: 'event', event }, { ...frame, eventName: 'other' }, frame, frame]), [event, event]);
  assert.throws(() => wireEvents([{ ...frame, data: JSON.stringify({ ...event, key: 'b' }) }]));
});
test('extracts authoritative HTTP snapshots with real materialization work', () => {
  const snapshot = { through: 0, rows: [], work: { reads: 1, rows: 0 } };
  const frame = { kind: 'response', url: 'http://localhost/parity/snapshot', status: 200, body: JSON.stringify(snapshot) };
  assert.deepEqual(wireSnapshots([frame]), [snapshot]);
  assert.throws(() => wireSnapshots([{ ...frame, status: 500 }]));
  assert.throws(() => wireSnapshots([{ ...frame, body: JSON.stringify({ ...snapshot, work: { reads: 0, rows: 0 } }) }]));
});
