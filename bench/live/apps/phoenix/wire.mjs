// Lossless extraction from native Phoenix v2 LiveView diff/reply push-event envelopes.
import assert from 'node:assert/strict';

function messages(network) {
  return network.filter(record => record.kind === 'native-websocket-received').flatMap(record => {
    if (record.response?.opcode !== 1) return [];
    const frame = JSON.parse(record.response.payloadData);
    assert.ok(Array.isArray(frame) && frame.length === 5, 'Phoenix v2 frame required');
    const [, , topic, event, payload] = frame;
    if (!topic.startsWith('lv:')) return [];
    const diff = event === 'diff' ? payload : event === 'phx_reply' ? payload.response?.diff || payload.response?.rendered : null;
    return (diff?.e || []).filter(([name]) => name === 'parity').map(([, message]) => {
      if (message.kind === 'event') {
        const value = message.event;
        assert.ok(Number.isInteger(value.seq) && value.seq > 0 && typeof value.effectId === 'string');
        assert.ok(typeof value.key === 'string' && ['upsert', 'remove'].includes(value.op));
        if (value.op === 'upsert') assert.equal(value.row.id, value.key);
        assert.ok(['applied', 'duplicate', 'gap'].includes(message.disposition));
      } else if (message.kind === 'snapshot') {
        const value = message.snapshot;
        assert.ok(Number.isInteger(value.through) && value.through >= 0 && Array.isArray(value.rows));
        assert.deepEqual(value.work, { reads: 1, rows: value.rows.length });
        assert.ok(value.rows.every(row => typeof row.id === 'string'));
      }
      return message;
    });
  });
}
export const wireEvents = network => messages(network).filter(message => message.kind === 'event').map(message => message.event);
export const wireSnapshots = network => messages(network).filter(message => message.kind === 'snapshot').map(message => message.snapshot);
