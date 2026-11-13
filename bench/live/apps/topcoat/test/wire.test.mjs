import assert from 'node:assert/strict';
import test from 'node:test';
import { wireEvents, wireSnapshots } from '../wire.mjs';
const event = { seq: 1, effectId: 'e-1', key: 'a', op: 'upsert', row: { id: 'a', version: 1, priceCents: 12, quantity: 2 } };
const snapshot = { through: 0, rows: [], work: { reads: 1, rows: 0 } };
function native(message, t = 'swap') {
  const region = '0123456789abcdef0123456789abcdef';
  let html = `<section id="native-screen" data-through="${message.snapshot?.through ?? 1}" data-serial="${message.serial ?? 0}"><output id="native-message" data-message="${Buffer.from(JSON.stringify(message)).toString('base64')}" hidden=""></output></section>`;
  if (t === 'snapshot') html = `<!--::topcoat::region::start(${region})-->${html}<!--::topcoat::region::end(${region})-->`;
  return { kind: 'native-websocket-received', response: { opcode: 1, payloadData: JSON.stringify({ run: 1,
    frame: { t, ...(t === 'swap' ? { region } : {}), html } }) } };
}
test('extracts only canonical native run/component frames, including duplicates', () => {
  const message = { kind: 'event', serial: 1, disposition: 'applied', event };
  const records = [native({ kind: 'snapshot', serial: 1, snapshot }, 'snapshot'), native(message), native({ ...message, serial: 2, disposition: 'duplicate' })];
  assert.deepEqual(wireEvents(records), [event, event]);
  assert.deepEqual(wireSnapshots(records), [snapshot]);
  assert.deepEqual(wireEvents([{ kind: 'request', body: JSON.stringify(message) }]), []);
  // Cancelling the native live body emits an ordinary shard snapshot with no live region.
  const idle = native({ kind: 'idle' }); const envelope = JSON.parse(idle.response.payloadData);
  envelope.frame.t = 'snapshot'; delete envelope.frame.region; idle.response.payloadData = JSON.stringify(envelope);
  assert.deepEqual(wireEvents([idle]), []);
});
test('rejects malformed envelope, key drift and ambiguous component evidence', () => {
  assert.throws(() => wireEvents([{ kind: 'native-websocket-received', response: { opcode: 1, payloadData: '{}' } }]));
  assert.throws(() => wireEvents([native({ kind: 'snapshot', serial: 1, snapshot }, 'snapshot'),
    native({ kind: 'event', serial: 2, disposition: 'applied', event: { ...event, key: 'b' } })]), /a.*b/s);
  const record = native({ kind: 'snapshot', serial: 1, snapshot });
  const envelope = JSON.parse(record.response.payloadData); envelope.frame.html += envelope.frame.html;
  record.response.payloadData = JSON.stringify(envelope);
  assert.throws(() => wireSnapshots([record]));
  const wrong = native({ kind: 'event', serial: 2, disposition: 'applied', event });
  const swap = JSON.parse(wrong.response.payloadData); swap.frame.region = 'f'.repeat(32); wrong.response.payloadData = JSON.stringify(swap);
  assert.throws(() => wireEvents([native({ kind: 'snapshot', serial: 1, snapshot }, 'snapshot'), wrong]));
});
test('requires the native screen to name the same observed emission', () => {
  const ready = native({ kind: 'ready', serial: 1 }, 'snapshot');
  for (const replacement of ['', ' data-serial="2"']) {
    const invalid = structuredClone(ready), envelope = JSON.parse(invalid.response.payloadData);
    envelope.frame.html = envelope.frame.html.replace(' data-serial="1"', replacement);
    invalid.response.payloadData = JSON.stringify(envelope);
    assert.throws(() => wireEvents([invalid]), /native component screen required|native screen\/emission serial drift/);
  }
});
