// Pinned Topcoat 0.12.1 run envelopes and this component's canonical diagnostic slot.
// Never synthesize an event from the workload, another frame field or a DOM observation.
import assert from 'node:assert/strict';

function messages(network) {
  const regions = new Map();
  return network.filter(r => r.kind === 'native-websocket-received').flatMap(record => {
    if (record.response?.opcode !== 1) return [];
    const envelope = JSON.parse(record.response.payloadData), frame = envelope.frame;
    assert.ok(frame && typeof frame.t === 'string', 'native Topcoat frame required');
    if (!['snapshot', 'swap'].includes(frame.t)) return [];
    assert.ok(Number.isSafeInteger(envelope.run) && envelope.run >= 0, 'native run required');
    assert.equal(typeof frame.html, 'string');
    // This is an exact app-local serialized element grammar, not arbitrary JSON search.
    const slots = [...frame.html.matchAll(/<output id="native-message" data-message="([A-Za-z0-9+/]+={0,2})" hidden=""><\/output>/g)];
    if (!slots.length) { assert.ok(!frame.html.includes('id="native-message"'), 'malformed native diagnostic slot'); return []; }
    assert.equal(slots.length, 1, 'ambiguous native diagnostic slot');
    const bytes = Buffer.from(slots[0][1], 'base64');
    assert.equal(bytes.toString('base64'), slots[0][1], 'noncanonical diagnostic encoding');
    const message = JSON.parse(bytes.toString('utf8'));
    if (['idle', 'waiting'].includes(message.kind)) return [];
    const screen = /<section id="native-screen" data-through="(\d+)" data-serial="(\d+)">/.exec(frame.html);
    assert.ok(screen, 'native component screen required');
    const through = Number(screen[1]); assert.ok(Number.isSafeInteger(through));
    const run = `${record.requestId}/${envelope.run}`;
    if (frame.t === 'snapshot') {
      const start = /<!--::topcoat::region::start\(([0-9a-f]{32})\)-->/g;
      const boundaries = [...frame.html.matchAll(start)];
      assert.equal(boundaries.length, 1, 'native live region boundary required');
      assert.ok(frame.html.endsWith(`<!--::topcoat::region::end(${boundaries[0][1]})-->`));
      regions.set(run, boundaries[0][1]);
    } else {
      assert.match(frame.region, /^[0-9a-f]{32}$/);
      assert.equal(frame.region, regions.get(run), 'swap does not belong to the native live region');
    }
    assert.ok(Number.isSafeInteger(message.serial) && message.serial > 0);
    assert.equal(Number(screen[2]), message.serial, 'native screen/emission serial drift');
    if (message.kind === 'event') {
      const e = message.event;
      assert.ok(Number.isSafeInteger(e.seq) && e.seq > 0 && typeof e.effectId === 'string' && e.effectId.length > 0);
      assert.ok(typeof e.key === 'string' && e.key.length > 0 && ['upsert', 'remove'].includes(e.op));
      if (e.op === 'upsert') assert.equal(e.row.id, e.key);
      else assert.equal(e.row, undefined);
      assert.ok(['applied', 'duplicate', 'gap'].includes(message.disposition));
      if (message.disposition === 'applied') assert.equal(e.seq, through);
      else assert.ok(message.disposition === 'duplicate' ? e.seq <= through : e.seq > through + 1, 'native sequence disposition drift');
    } else if (message.kind === 'snapshot') {
      const s = message.snapshot;
      assert.ok(Number.isSafeInteger(s.through) && s.through >= 0 && Array.isArray(s.rows));
      assert.equal(new Set(s.rows.map(row => row.id)).size, s.rows.length);
      assert.deepEqual(s.work, { reads: 1, rows: s.rows.length });
      assert.equal(s.through, through);
    } else assert.ok(['ready', 'overflow'].includes(message.kind), 'unknown native diagnostic kind');
    return [message];
  });
}
export const wireEvents = network => messages(network).filter(m => m.kind === 'event').map(m => m.event);
export const wireSnapshots = network => messages(network).filter(m => m.kind === 'snapshot').map(m => m.snapshot);
