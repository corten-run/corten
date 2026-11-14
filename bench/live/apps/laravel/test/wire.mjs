import assert from 'node:assert/strict';
import test from 'node:test';
import { wireEvents, wireSnapshots, wireResources, wireResumes, reverbEvents } from '../wire.mjs';

const row = { id: 'a', version: 1, priceCents: 100, quantity: 2 };
const event = { seq: 1, effectId: 'effect-1', key: 'a', op: 'upsert', row };
const native = (...packets) => ({ kind: 'native-livewire-response', status: 200,
  body: { components: [{ effects: { dispatches: packets.map(packet => ({ name: 'parity', params: { packet } })) } }] } });
const packet = (disposition = 'applied', value = event) => ({ kind: 'event', disposition, event: value });
const frame = (value, channel = 'live.' + 'a'.repeat(64)) => ({ kind: 'native-websocket-received',
  response: { opcode: 1, payloadData: JSON.stringify({ event: 'delivery', channel, data: JSON.stringify({ packet: value }) }) } });

test('original native events retain arrival order and duplicate/gap dispositions', () => {
  const second = { ...event, seq: 2, effectId: 'effect-2' };
  const result = wireEvents([native(packet('applied', second), packet('duplicate'), packet('gap', second))]);
  assert.deepEqual(result, [second, event, second]);
  assert.equal(result[0], second); assert.equal(result[1], event);
});
test('original snapshots retain rows, cursor and measured work', () => {
  const snapshot = { through: 4, rows: [row], work: { reads: 1, rows: 1 } };
  assert.equal(wireSnapshots([native({ kind: 'snapshot', snapshot })])[0], snapshot);
});
test('native resources retain null unknowns and per-consumer inventory', () => {
  const resources = { connections: 1, inventory: { nativeSocketBufferBytes: null, consumers: { a: { queueEvents: 2 } } } };
  assert.equal(wireResources([native({ kind: 'ready', resources })])[0], resources);
});
test('native ready cursor/status are not synthesized', () => {
  assert.deepEqual(wireResumes([native({ kind: 'ready', from: 1, status: 'expired' })]), [{ from: 1, status: 'expired' }]);
});
test('publisher responses and bridge records are not native delivery proof', () => {
  assert.deepEqual(wireEvents([{ kind: 'write-response', status: 200, body: event },
    { kind: 'event', event }, { kind: 'native-websocket-received', response: { opcode: 1 } }]), []);
});
test('malformed native response or event evidence is rejected', () => {
  for (const value of [{ ...native(), status: 500 }, { ...native(), body: {} },
    native(packet('invented')), native(packet('applied', { ...event, seq: 0 })),
    native(packet('applied', { ...event, row: { ...row, id: 'b' } })),
    native(packet('applied', { ...event, op: 'invented' }))]) assert.throws(() => wireEvents([value]));
});
test('malformed snapshot work, rows, identities and cursors are rejected', () => {
  const snapshot = { through: 0, rows: [row], work: { reads: 1, rows: 1 } };
  for (const value of [{ ...snapshot, through: -1 }, { ...snapshot, rows: [row, row], work: { reads: 1, rows: 2 } },
    { ...snapshot, work: { reads: 0, rows: 1 } }, { ...snapshot, rows: [{ ...row, quantity: '2' }] }]) {
    assert.throws(() => wireSnapshots([native({ kind: 'snapshot', snapshot: value })]));
  }
});
test('real Reverb delivery envelopes preserve order and reject invalid events', () => {
  assert.deepEqual(reverbEvents([frame(packet()), frame({ kind: 'overflow' }), frame(packet(), 'other'), frame(packet('duplicate'))]), [event, event]);
  assert.throws(() => reverbEvents([frame(packet('applied', { ...event, row: {} }))]));
});
