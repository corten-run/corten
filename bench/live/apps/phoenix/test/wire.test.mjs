import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wireEvents, wireSnapshots } from '../wire.mjs';

const frame = (event, payload, topic = 'lv:native-root') => ({ kind: 'native-websocket-received',
  response: { opcode: 1, payloadData: JSON.stringify(['1', null, topic, event, payload]) } });
const event = { seq: 1, effectId: 'effect-1', key: 'a', op: 'upsert',
  row: { id: 'a', version: 1, priceCents: 100, quantity: 2 } };

test('native LiveView diff metadata is returned losslessly, never reconstructed', () => {
  assert.deepEqual(wireEvents([frame('diff', { e: [['parity', { kind: 'event', event, disposition: 'applied' }]] })]), [event]);
});
test('another topic cannot manufacture LiveView event evidence', () => {
  assert.deepEqual(wireEvents([frame('diff', { e: [['parity', { kind: 'event', event, disposition: 'applied' }]] }, 'other')]), []);
});
test('malformed native envelopes and mismatched native row identity are rejected', () => {
  assert.throws(() => wireEvents([{ kind: 'native-websocket-received', response: { opcode: 1, payloadData: '{}' } }]));
  const bad = { ...event, row: { ...event.row, id: 'different' } };
  assert.throws(() => wireEvents([frame('diff', { e: [['parity', { kind: 'event', event: bad, disposition: 'applied' }]] })]));
});
test('snapshot read work must match its original rows', () => {
  const snapshot = { through: 0, rows: [event.row], work: { reads: 1, rows: 1 } };
  assert.deepEqual(wireSnapshots([frame('diff', { e: [['parity', { kind: 'snapshot', snapshot }]] })]), [snapshot]);
  assert.deepEqual(wireSnapshots([frame('phx_reply', { status: 'ok', response: { diff: { e: [['parity', { kind: 'snapshot', snapshot }]] } } })]), [snapshot]);
  assert.throws(() => wireSnapshots([frame('diff', { e: [['parity', { kind: 'snapshot', snapshot: { ...snapshot, work: { reads: 0, rows: 1 } } }]] })]));
});
