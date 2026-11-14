import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wireResources, wireResumes } from '../wire.mjs';

const frame = message => ({ kind: 'native-websocket-received', response: {
  opcode: 1, payloadData: JSON.stringify({ identifier: 'native', message }) } });

test('all native resource objects retain frame order, excluding HTTP records', () => {
  const ready = { queueEvents: 0, inventory: { retainedClients: 1 } };
  const overflow = { queueEvents: 2, inventory: { stagedClientRows: 5 } };
  assert.deepEqual(wireResources([{ kind: 'write-response', resources: { forged: true } },
    frame({ kind: 'ready', resources: ready }), frame({ kind: 'overflow', resources: overflow })]), [ready, overflow]);
});

test('native cursor binding includes the initial acknowledgement and every reconnect', () => {
  assert.deepEqual(wireResumes([frame({ kind: 'ready', from: 0, status: 'accepted' }),
    frame({ kind: 'snapshot', snapshot: { through: 10 } }),
    { kind: 'resume', from: 999, status: 'accepted' },
    frame({ kind: 'ready', from: 1, status: 'expired' })]), [
    { from: 0, status: 'accepted' }, { from: 1, status: 'expired' }]);
});
