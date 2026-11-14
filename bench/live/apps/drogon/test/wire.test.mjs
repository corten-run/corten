import assert from 'node:assert/strict';
import test from 'node:test';
import { wireEvents, wireResources, wireResumes, wireSnapshots } from '../wire.mjs';
import { inventory, nativePorts, portFor, recordedInventory } from '../../../native.mjs';
const row = { id: 'a', version: 1, priceCents: 12, quantity: 3 };
const event = { seq: 1, key: 'a', effectId: 'effect-1', op: 'upsert', row };
const created = { kind: 'native-websocket-created', requestId: '1', url: 'ws://localhost/parity/socket?from=0' };
const frame = value => ({ kind: 'native-websocket-received', requestId: '1', response: { opcode: 1, payloadData: JSON.stringify({ protocol: 'drogon-live/v1', ...value }) } });
const ready = frame({ kind: 'ready', readerId: '1', from: 0, status: 'accepted', resources: { subscriptions: 1 } });
const update = frame({ kind: 'event', delivery: 1, event });
test('extracts only original events on identified native sockets', () => {
  assert.deepEqual(wireEvents([created, ready, update]), [event]);
  assert.deepEqual(wireEvents([{ ...created, url: 'ws://localhost/unrelated' }, ready, update]), []);
  assert.throws(() => wireEvents([created, update]));
  assert.throws(() => wireEvents([created, frame({ kind: 'ready', from: 0, status: 'accepted', resources: { subscriptions: 1 } }), update]));
  assert.throws(() => wireEvents([created, ready, update, update]));
  assert.throws(() => wireEvents([created, ready, frame({ kind: 'event', delivery: 1, event: { ...event, row: { ...row, id: 'wrong' } } })]));
  assert.throws(() => wireEvents([created, ready, frame({ kind: 'event', delivery: 1, event: { ...event, seq: 1.5 } })]));
});
test('snapshots are actual authoritative HTTP reads with exact work', () => {
  const value = { through: 1, rows: [row], work: { reads: 1, rows: 1 } };
  const response = { kind: 'response', url: 'http://localhost/parity/snapshot', status: 200, body: JSON.stringify(value) };
  assert.deepEqual(wireSnapshots([response]), [value]);
  assert.throws(() => wireSnapshots([{ ...response, status: 500 }]));
  assert.throws(() => wireSnapshots([{ ...response, body: JSON.stringify({ ...value, work: { reads: 0, rows: 1 } }) }]));
  assert.throws(() => wireSnapshots([{ ...response, body: JSON.stringify({ ...value, rows: [row, row] }) }]));
});

test('shared registration extracts actual resume and resource envelopes without upgrading old captures', () => {
  assert.equal(portFor('drogon', 'bounded'), nativePorts.drogon);
  assert.equal(portFor('drogon', 'native-feed'), nativePorts.drogon);
  const overflow = frame({ kind: 'overflow', delivery: 2, outcome: 'resnapshot', resources: { queueEvents: 2, queuePeak: 2 } });
  const network = [created, ready, update, overflow];
  assert.deepEqual(wireResumes(network), [{ from: 0, status: 'accepted' }]);
  assert.deepEqual(wireResources(network), [{ subscriptions: 1 }, { queueEvents: 2, queuePeak: 2 }]);
  assert.throws(() => wireResources([created, update]));
  assert.throws(() => wireResumes([created, ready, update, update]));
  const old = inventory('live-delivery').map(entry => entry.app !== 'drogon' ? entry : { app: 'drogon', implementation: 'not-implemented',
    reason: 'Missing drogon native keyed browser application, bounded queue/history instrumentation and recovery port under bench/live/apps; historical transport-only code is not parity' });
  assert.equal(recordedInventory('live-delivery', old, 'bounded', 2).find(entry => entry.app === 'drogon').implementation, 'not-implemented');
});
