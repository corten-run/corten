import assert from 'node:assert/strict';

export function wireEvents(network) {
  return network.filter(r => r.kind === 'native-sse' && r.eventName === 'update').map(r => {
    const e = JSON.parse(r.data);
    assert.ok(Number.isSafeInteger(e.seq) && e.seq > 0 && typeof e.effectId === 'string' && typeof e.key === 'string');
    assert.ok(['upsert', 'remove'].includes(e.op));
    if (e.op === 'upsert') assert.equal(e.row.id, e.key);
    else assert.equal(e.row, undefined);
    return e;
  });
}
export function wireSnapshots(network) {
  return network.filter(r => r.kind === 'response' && new URL(r.url).pathname === '/parity/snapshot').map(r => {
    assert.equal(r.status, 200); const s = JSON.parse(r.body);
    assert.ok(Number.isSafeInteger(s.through) && s.through >= 0 && Array.isArray(s.rows));
    assert.deepEqual(s.work, { reads: 1, rows: s.rows.length });
    assert.equal(new Set(s.rows.map(r => r.id)).size, s.rows.length);
    return s;
  });
}
