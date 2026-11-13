import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wireEvents, wireSnapshots, wireResources, wireResumes } from '../wire.mjs';

const frame = (event, payload, topic = 'lv:native-root') => ({ kind: 'native-websocket-received',
  response: { opcode: 1, payloadData: JSON.stringify(['1', null, topic, event, payload]) } });
const event = { seq: 1, effectId: 'effect-1', key: 'a', op: 'upsert',
  row: { id: 'a', version: 1, priceCents: 100, quantity: 2 } };

test('every native resource object is retained in order and HTTP records are excluded', () => {
  const ready = { queueEvents: 0, historyEvents: 1, inventory: { retainedClients: 1 } };
  const overflow = { queueEvents: 2, historyEvents: 4, inventory: { stagedClientRows: 5 } };
  const native = frame('diff', { e: [['parity', { kind: 'ready', resources: ready }], ['parity', { kind: 'overflow', resources: overflow }]] });
  assert.deepEqual(wireResources([{ kind: 'write-response', resources: { forged: true } }, native]), [ready, overflow]);
});

test('native LiveView diff metadata is returned losslessly, never reconstructed', () => {
  assert.deepEqual(wireEvents([frame('diff', { e: [['parity', { kind: 'event', event, disposition: 'applied' }]] })]), [event]);
});

test('native cursors retain initial ready and reconnect order without inferring snapshot status', () => {
  const native = frame('diff', { e: [['parity', { kind: 'ready', from: 0, status: 'accepted' }],
    ['parity', { kind: 'ready', from: 1, status: 'expired' }]] });
  assert.deepEqual(wireResumes([{ kind: 'resume', from: 999, status: 'accepted' }, native]), [
    { from: 0, status: 'accepted' }, { from: 1, status: 'expired' }]);
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
