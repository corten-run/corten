// Extract original payloads from captured Drogon frames/HTTP responses, never DOM effects.
import assert from 'node:assert/strict';

const integer = value => Number.isSafeInteger(value) && value >= 0;
function row(value) {
  assert.ok(value && typeof value.id === 'string' && value.id.length > 0);
  for (const name of ['version', 'priceCents', 'quantity']) assert.ok(integer(value[name]));
}
function messages(network) {
  const sockets = new Map();
  const messages = [];
  for (const record of network) {
    if (record.kind === 'native-websocket-created' && new URL(record.url).pathname === '/parity/socket') {
      sockets.set(record.requestId, { delivery: 0, ready: false });
    }
    if (record.kind !== 'native-websocket-received' || !sockets.has(record.requestId) || record.response?.opcode !== 1) continue;
    const socket = sockets.get(record.requestId), message = JSON.parse(record.response.payloadData);
    assert.equal(message.protocol, 'drogon-live/v1');
    if (message.kind === 'ready') {
      assert.equal(socket.ready, false); socket.ready = true;
      assert.ok(integer(message.from) && ['accepted', 'expired'].includes(message.status));
      assert.ok(message.resources && integer(message.resources.subscriptions));
    } else {
      assert.equal(socket.ready, true, 'native delivery before ready');
      assert.equal(message.delivery, ++socket.delivery, 'native delivery identity skipped/repeated');
      if (message.kind === 'event') {
        const event = message.event;
        assert.ok(integer(event.seq) && event.seq > 0 && typeof event.effectId === 'string' && event.effectId.length > 0);
        assert.ok(typeof event.key === 'string' && event.key.length > 0);
        assert.ok(['upsert', 'remove'].includes(event.op));
        if (event.op === 'upsert') { row(event.row); assert.equal(event.row.id, event.key); }
      } else {
        assert.equal(message.kind, 'overflow'); assert.equal(message.outcome, 'resnapshot');
        assert.ok(integer(message.resources.queueEvents) && message.resources.queueEvents > 0);
      }
    }
    messages.push(message);
  }
  return messages;
}
export const wireEvents = network => messages(network).filter(message => message.kind === 'event').map(message => message.event);
export function wireSnapshots(network) {
  return network.filter(record => record.kind === 'response' && new URL(record.url).pathname === '/parity/snapshot').map(record => {
    assert.equal(record.status, 200); const value = JSON.parse(record.body);
    assert.ok(integer(value.through) && Array.isArray(value.rows)); value.rows.forEach(row);
    assert.equal(new Set(value.rows.map(row => row.id)).size, value.rows.length);
    assert.deepEqual(value.work, { reads: 1, rows: value.rows.length }); return value;
  });
}
