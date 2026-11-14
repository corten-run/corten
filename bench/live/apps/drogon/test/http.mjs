// Destructive synthetic controls: run only against this isolated app instance.
import assert from 'node:assert/strict';
const base = process.argv[2]; assert.ok(base, 'isolated native app URL required');
const request = async (path, data, status = 200) => {
  const result = await fetch(base + '/parity/' + path, { signal: AbortSignal.timeout(10000), ...(data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }) });
  assert.equal(result.status, status, `${path}: ${await result.clone().text()}`); return result.json();
};
const initial = [{ id: 'a<&"', version: 0, priceCents: 10, quantity: 2 }];
const configuration = (large = false) => ({ initial, queueLimit: large ? 1024 : 2, historyLimit: large ? 1025 : 4 });
const event = seq => ({ seq, key: initial[0].id, effectId: `e-${seq}`, ...(seq % 3 === 2 ? { op: 'remove' }
  : { op: 'upsert', row: { ...initial[0], version: seq } }) });
async function zero() {
  const deadline = performance.now() + 5000;
  while (true) {
    const value = await request('resources');
    if (['subscriptions', 'connections', 'pendingTasks', 'queueEvents'].every(key => value[key] === 0)) return;
    assert.ok(performance.now() < deadline, 'native resources did not release'); await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const sockets = [];
async function connect(from = 0) {
  const url = new URL('/parity/socket?from=' + from, base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url); sockets.push(socket);
  const frames = [];
  socket.addEventListener('message', value => frames.push(JSON.parse(value.data)));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('native socket ready timeout')), 5000);
    socket.addEventListener('message', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', error => { clearTimeout(timer); reject(error); }, { once: true });
  });
  assert.equal(frames[0].kind, 'ready'); return { socket, frames };
}
try {
  assert.equal((await request('configure', configuration())).framework, 'drogon');
  const html = await (await fetch(base)).text(); assert.ok(html.includes('a&lt;&amp;&quot;') && !html.includes('data-key="a<&"'));
  for (const invalid of [null, {}, { event: event(2) }, { event: event(1), events: [event(1)] }, { events: [] },
    { event: { ...event(1), row: { ...initial[0], quantity: -1 } } },
    { event: { ...event(1), row: { ...initial[0], id: 'wrong' } } }, { events: [event(1)] }]) await request('publish', invalid, 400);
  await request('configure', { ...configuration(), initial: [initial[0], initial[0]] }, 400);
  assert.equal((await request('snapshot')).through, 0);
  for (const id of ['0', '-1', 'no-reader', '1junk', '18446744073709551616']) await request('resources?reader=' + id, undefined, 400);
  for (const body of ['{"event":', '{"event":{},"event":{}}', '{} trailing']) {
    assert.equal((await fetch(base + '/parity/publish', { method: 'POST', body, signal: AbortSignal.timeout(10000) })).status, 400);
  }
  const reader = await connect(); reader.socket.send(JSON.stringify({ kind: 'start', through: 0 }));
  await request('configure', configuration(), 409);
  await request('publish', { event: event(1) });
  const deadline = performance.now() + 5000;
  while (reader.frames.length < 2) { assert.ok(performance.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  await request('publish', { event: event(2) }); await request('publish', { event: event(3) });
  const gated = await request('resources'); assert.equal(gated.queueEvents, 2); assert.equal(gated.inventory.inFlight, 1);
  const id = reader.frames[0].readerId; assert.match(id, /^[1-9][0-9]*$/);
  const scoped = await request('resources?reader=' + id);
  assert.equal(scoped.connections, 1); assert.equal(scoped.reader.id, id);
  assert.equal(scoped.reader.queueEvents, 2); assert.equal(scoped.reader.inFlight, 1);
  assert.equal(reader.frames.length, 2, 'unacknowledged native frames accumulated');
  reader.socket.close(); await zero();
  const released = await request('resources?reader=' + id);
  for (const field of ['subscriptions', 'connections', 'pendingTasks', 'queueEvents', 'replayEvents', 'inFlight']) assert.equal(released.reader[field], 0);
  await request('configure', configuration(true));
  const events = Array.from({ length: 1044 }, (_, index) => event(index + 1));
  for (const bad of [{ events: [] }, { event: events[0], events }, { events: [events[0], events[2]] }, { events: [...events, event(1045)] }]) await request('publish', bad, 400);
  assert.equal((await request('snapshot')).through, 0);
  const batch = await request('publish', { events }); assert.equal(batch.acks.length, 1044);
  assert.deepEqual(batch.acks.map(ack => ack.seq), events.map(value => value.seq));
  assert.equal(batch.acks.at(-1).resources.historyPeak, 1025);
  const snapshot = await request('snapshot'); assert.equal(snapshot.through, 1044); assert.equal(snapshot.rows[0].version, 1044);
  // HTTP concurrency is serialized: exactly one identical publication can commit.
  const concurrent = await Promise.all([1, 2].map(() => fetch(base + '/parity/publish', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: event(1045) }), signal: AbortSignal.timeout(10000),
  })));
  assert.deepEqual(concurrent.map(value => value.status).sort(), [200, 400]);
  assert.equal((await request('snapshot')).through, 1045);
  await zero();
  for (let n = 0; n < 16; n++) await connect(1045);
  const full = await request('resources'); assert.equal(full.connections, 16); assert.equal(full.subscriptions, 16);
  const url = new URL('/parity/socket?from=1045', base); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const rejected = new WebSocket(url); sockets.push(rejected);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('17th reader not refused')), 5000);
    rejected.addEventListener('close', value => {
      clearTimeout(timer); try { assert.equal(value.code, 1008); resolve(); } catch (error) { reject(error); }
    }, { once: true });
    rejected.addEventListener('message', () => { clearTimeout(timer); reject(new Error('17th reader admitted')); }, { once: true });
  });
  assert.equal((await request('resources')).connections, 16);
  for (const socket of sockets) if (socket.readyState < WebSocket.CLOSING) socket.close();
  await zero();
  console.log('Drogon production HTTP/native WS: SSR escaping, strict validation, no partial batch writes, 1044 actual acknowledgements, native ack gating, concurrent writers, 16 real readers/17th refusal and disconnect cleanup passed');
} finally {
  for (const socket of sockets) if (socket.readyState < WebSocket.CLOSING) socket.close();
  await zero();
}
