import tls from 'node:tls';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

function frame(type, flags, stream, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(9);
  header.writeUIntBE(payload.length, 0, 3);
  header[3] = type; header[4] = flags; header.writeUInt32BE(stream, 5);
  return Buffer.concat([header, payload]);
}
function headers(path) {
  const authority = Buffer.from('localhost:18590');
  const bytes = Buffer.from(path);
  return Buffer.concat([Buffer.from([0x82, 0x87, 0x01, authority.length]), authority, Buffer.from([0x04, bytes.length]), bytes]);
}
async function connect(window = 65535) {
  const socket = tls.connect({ host: 'localhost', port: 18590, rejectUnauthorized: false, ALPNProtocols: ['h2'] });
  await once(socket, 'secureConnect');
  assert.equal(socket.alpnProtocol, 'h2');
  const frames = [];
  let pending = Buffer.alloc(0);
  socket.on('error', () => {});
  socket.on('data', bytes => {
    pending = Buffer.concat([pending, bytes]);
    while (pending.length >= 9 && pending.length >= 9 + pending.readUIntBE(0, 3)) {
      const length = pending.readUIntBE(0, 3);
      const one = { type: pending[3], flags: pending[4], stream: pending.readUInt32BE(5), payload: pending.subarray(9, 9 + length) };
      frames.push(one);
      if (one.type === 4 && !(one.flags & 1)) socket.write(frame(4, 1, 0));
      if (one.type === 6 && !(one.flags & 1)) socket.write(frame(6, 1, 0, one.payload));
      pending = pending.subarray(9 + length);
    }
  });
  const settings = Buffer.alloc(6);
  settings.writeUInt16BE(4, 0); settings.writeUInt32BE(window, 2);
  socket.write(Buffer.concat([Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'), frame(4, 0, 0, settings)]));
  return { socket, frames };
}
const results = [];
{
  const { socket, frames } = await connect(0);
  try {
    socket.write(frame(1, 5, 1, headers('/events?n=1')));
    await delay(500);
    assert(frames.some(f => f.type === 1 && f.stream === 1), 'response started');
    assert(!frames.some(f => [0, 3, 7].includes(f.type)), 'no data, reset or GOAWAY during the blocked window');
    assert(!socket.destroyed, 'socket remains open past the 100ms send timeout');
    const credit = Buffer.alloc(4); credit.writeUInt32BE(65535);
    socket.write(frame(8, 0, 1, credit));
    await delay(100);
    assert(frames.some(f => f.type === 0 && f.stream === 1), 'old response resumes after credit');
    results.push({ check: 'zero stream window', configuredTimeoutMs: 100, waitedMs: 500, timedOut: false, resumesAfterWindowUpdate: true });
  } finally { socket.destroy(); }
}
{
  const { socket, frames } = await connect();
  try {
    socket.write(frame(1, 5, 1, headers('/quiet')));
    await delay(30);
    assert(frames.some(f => f.type === 1 && f.stream === 1), 'quiet stream opened');
    const block = headers('/');
    socket.write(frame(1, 1, 3, block.subarray(0, 1)));
    await delay(500);
    assert(!socket.destroyed && !frames.some(f => f.type === 7), 'partial head survives while sibling stays open');
    socket.write(frame(9, 4, 3, block.subarray(1)));
    await delay(100);
    assert(frames.some(f => f.type === 1 && f.stream === 3), 'late continuation accepted');
    results.push({ check: 'partial head beside live stream', configuredTimeoutMs: 100, waitedMs: 500, timedOut: false, lateHeadAccepted: true });
  } finally { socket.destroy(); }
}
console.log(JSON.stringify(results));
