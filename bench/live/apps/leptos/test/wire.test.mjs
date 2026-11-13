import assert from 'node:assert/strict';
import test from 'node:test';
import { wireEvents, wireSnapshots, wireResources, wireResumes } from '../wire.mjs';

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

test('extracts only actual native ready and overflow resource and cursor envelopes', () => {
  const resources = { subscriptions: 1, queueEvents: 2, queuePeak: 2 };
  const ready = { kind: 'native-sse', eventName: 'ready', data: JSON.stringify({ from: 3, status: 'accepted', resources }) };
  const overflow = { kind: 'native-sse', eventName: 'overflow', data: JSON.stringify({ outcome: 'resnapshot', resources }) };
  const expired = { ...ready, data: JSON.stringify({ from: 0, status: 'expired', resources }) };
  const application = { ...ready, kind: 'resources' };
  assert.deepEqual(wireResources([application, ready, overflow, expired]), [resources, resources, resources]);
  assert.deepEqual(wireResumes([application, ready, overflow, expired]), [{ from: 3, status: 'accepted' }, { from: 0, status: 'expired' }]);
  for (const data of [{ from: -1, status: 'accepted' }, { from: 0, status: 'unknown' }, { status: 'accepted' }]) {
    assert.throws(() => wireResumes([{ ...ready, data: JSON.stringify(data) }]));
  }
  for (const resources of [null, [], 'self-reported']) assert.throws(() => wireResources([{ ...ready, data: JSON.stringify({ resources }) }]));
  assert.throws(() => wireResources([{ ...overflow, data: JSON.stringify({ outcome: 'unknown', resources }) }]));
});
