// Original Livewire response dispatches prove native morph results. Reverb carries event inputs.
import assert from 'node:assert/strict';

function row(value) {
  assert.ok(value && typeof value.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value.id));
  for (const field of ['version', 'priceCents', 'quantity']) assert.ok(Number.isInteger(value[field]));
}
function event(value) {
  assert.ok(value && Number.isInteger(value.seq) && value.seq > 0);
  assert.ok(typeof value.effectId === 'string' && typeof value.key === 'string');
  assert.ok(['remove', 'upsert'].includes(value.op));
  if (value.op === 'upsert') { row(value.row); assert.equal(value.row.id, value.key); }
}
function messages(network) {
  return network.filter(record => record.kind === 'native-livewire-response').flatMap(record => {
    assert.equal(record.status, 200);
    assert.ok(Array.isArray(record.body.components), 'native Livewire components required');
    return record.body.components.flatMap(component => (component.effects?.dispatches || [])
      .filter(dispatch => dispatch.name === 'parity').map(dispatch => {
        const message = dispatch.params.packet;
        if (message.kind === 'event') {
          event(message.event);
          assert.ok(['applied', 'duplicate', 'gap'].includes(message.disposition));
        } else if (message.kind === 'snapshot') {
          assert.ok(Number.isInteger(message.snapshot.through) && message.snapshot.through >= 0);
          assert.ok(Array.isArray(message.snapshot.rows));
          message.snapshot.rows.forEach(row);
          assert.equal(new Set(message.snapshot.rows.map(row => row.id)).size, message.snapshot.rows.length);
          assert.deepEqual(message.snapshot.work, { reads: 1, rows: message.snapshot.rows.length });
        }
        return message;
      }));
  });
}
export const wireEvents = network => messages(network).filter(message => message.kind === 'event').map(message => message.event);
export const wireSnapshots = network => messages(network).filter(message => message.kind === 'snapshot').map(message => message.snapshot);
export const wireResources = network => network.flatMap(record => record.kind === 'native-livewire-response'
  ? messages([record]).filter(message => message.resources).map(message => message.resources)
  : reverbPackets([record]).filter(message => message.kind === 'overflow').map(message => message.resources));
export const wireResumes = network => messages(network).filter(message => message.kind === 'ready').map(({ from, status }) => ({ from, status }));
function reverbPackets(network) {
  return network.filter(record => record.kind === 'native-websocket-received' && record.response?.opcode === 1)
    .flatMap(record => {
      const frame = JSON.parse(record.response.payloadData);
      if (frame.event !== 'delivery' || !/^live\.[a-f0-9]{64}$/.test(frame.channel)) return [];
      const value = typeof frame.data === 'string' ? JSON.parse(frame.data) : frame.data;
      if (!value.packet) return [];
      if (value.packet.kind === 'event') event(value.packet.event);
      return [value.packet];
    });
}
export const reverbEvents = network => reverbPackets(network).filter(packet => packet.kind === 'event').map(packet => packet.event);

export function verifyCapture(network, records) {
  const initial = network.find(record => record.kind === 'request' && record.method === 'GET' && new URL(record.url).pathname === '/');
  assert.ok(initial, 'native document request required');
  const origin = new URL(initial.url).origin;
  assert.ok(network.some(record => record.kind === 'response' && record.url === initial.url && record.status === 200), 'native document response required');
  for (const record of network.filter(record => ['request', 'response', 'native-livewire-response'].includes(record.kind))) {
    assert.equal(new URL(record.url).origin, origin, 'native HTTP origin differs from document');
  }
  const sockets = new Map(network.filter(record => record.kind === 'native-websocket-created').map(record => [record.requestId, record]));
  for (const record of network.filter(record => record.kind === 'native-websocket-received')) {
    const socket = sockets.get(record.requestId);
    assert.ok(socket, 'Reverb frame has no original socket');
    const url = new URL(socket.url);
    assert.equal(url.protocol, new URL(origin).protocol === 'https:' ? 'wss:' : 'ws:');
    assert.equal(url.host, new URL(origin).host, 'Reverb socket origin differs from document');
    assert.match(url.pathname, /^\/app\//);
  }
  const requests = network.filter(record => record.kind === 'request');
  const ready = messages(network).filter(message => message.kind === 'ready');
  assert.equal(ready.length, records.filter(record => record.kind === 'attach').length, 'native attach acknowledgement missing');
  for (const message of ready) {
    assert.match(message.consumer, /^[a-f0-9]{64}$/);
    assert.match(message.readerId, /^[a-f0-9]{32}$/);
    assert.equal(message.resources.inventory.consumers[message.consumer].subscriptions, 1);
  }
  for (const record of network.filter(record => record.kind === 'native-websocket-received' && record.response?.opcode === 1)) {
    const frame = JSON.parse(record.response.payloadData);
    if (frame.event !== 'delivery') continue;
    assert.ok(ready.some(message => frame.channel === 'live.' + message.consumer), 'Reverb delivery belongs to a different consumer');
    const data = typeof frame.data === 'string' ? JSON.parse(frame.data) : frame.data;
    assert.ok(ready.some(message => message.readerId === data.packet.readerId), 'Reverb delivery belongs to an unobserved reader');
  }
  const inputs = [];
  for (const record of network.filter(record => record.kind === 'native-livewire-response')) {
    assert.equal(record.bodyError, undefined, 'native Livewire body capture failed');
    const request = requests.find(request => request.requestId === record.requestId);
    assert.ok(request && request.method === 'POST' && request.url === record.url, 'native Livewire request/response identity differs');
    assert.match(new URL(record.url).pathname, /^\/livewire(?:\/|-).*update$/);
    assert.ok(network.some(response => response.kind === 'response' && response.requestId === record.requestId && response.url === record.url && response.status === record.status), 'original HTTP response missing');
    for (const value of [request, record]) {
      assert.match(value.bodySha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(value.bodyBytes) && value.bodyBytes > 0);
    }
    for (const component of JSON.parse(request.body).components) {
      assert.match(component.snapshotSha256, /^[a-f0-9]{64}$/);
      inputs.push(...component.calls.filter(call => call.method === 'receive').map(call => call.params[0].packet));
    }
  }
  const packets = reverbPackets(network).filter(packet => packet.kind === 'event');
  assert.deepEqual(inputs, packets, 'Livewire receive input differs from original Reverb packet');
  const events = messages(network).filter(message => message.kind === 'event');
  assert.deepEqual(events.map(({ disposition, nativeThrough, nativeCount, nativeRows, ...packet }) => packet), packets,
    'Livewire result differs from original Reverb packet');
  const observations = records.filter(record => record.kind === 'event');
  assert.equal(events.length, observations.length);
  let cursor = 0, eventIndex = 0;
  for (const record of records) {
    if (record.kind === 'snapshot') cursor = record.through;
    if (record.kind !== 'event') continue;
    if (record.disposition === 'applied') cursor = record.event.seq;
    assert.equal(events[eventIndex++].nativeThrough, cursor, 'native cursor differs from observed application progression');
  }
  for (const [i, message] of events.entries()) {
    const actual = observations[i];
    assert.equal(actual.disposition, message.disposition);
    assert.equal(actual.effectCount, message.nativeCount, 'native effect count differs from DOM');
    assert.equal(actual.state.length, message.nativeRows, 'native row count differs from DOM');
  }
}
