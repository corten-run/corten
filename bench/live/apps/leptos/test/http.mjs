import assert from 'node:assert/strict';
const base = process.argv[2];
assert.ok(base, 'native application URL required');
const request = (path, data) => fetch(base + '/parity/' + path, data === undefined ? {} : {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});
const row = { id: 'a', version: 0, priceCents: 12, quantity: 2 };
const e = seq => ({ seq, effectId: `e-${seq}`, key: 'a', op: 'upsert', row: { ...row, version: seq } });
assert.equal((await request('configure', { initial: [row, row], queueLimit: 2, historyLimit: 4 })).status, 400);
assert.equal((await request('configure', { initial: [row], queueLimit: 2, historyLimit: 4 })).status, 200);
const before = await (await request('snapshot')).json();
for (const input of [{ event: e(2) }, { events: [e(1)] }, { event: { ...e(1), op: 'bad' } }, { event: { ...e(1), row: { ...row, id: 'b' } } }]) {
  assert.equal((await request('publish', input)).status, 400);
  assert.deepEqual(await (await request('snapshot')).json(), before);
}
const readers = [];
try {
  for (let i = 0; i < 16; i++) {
    const abort = new AbortController(); readers.push(abort);
    const response = await fetch(base + '/parity/events?from=0', { signal: abort.signal });
    assert.equal(response.status, 200); await response.body.getReader().read();
  }
  assert.equal((await fetch(base + '/parity/events?from=0')).status, 429);
  assert.equal((await request('configure', { initial: [], queueLimit: 2, historyLimit: 4 })).status, 409);
  const resources = await (await request('resources')).json();
  assert.equal(resources.subscriptions, 16); assert.equal(resources.connections, 16); assert.equal(resources.pendingTasks, 16);
} finally { for (const reader of readers) reader.abort(); }
const deadline = performance.now() + 5000;
for (;;) {
  const r = await (await request('resources')).json();
  if (r.connections + r.pendingTasks + r.subscriptions + r.queueEvents === 0) break;
  assert.ok(performance.now() < deadline, 'cancelled HTTP readers leaked');
  await new Promise(resolve => setTimeout(resolve, 10));
}
console.log('Leptos native HTTP: invalid writes are atomic; 16 readers; saturation rejection; cancellation cleanup passed');
