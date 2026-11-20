import tls from 'node:tls';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const port = Number(process.env.HTTP2_PORT ?? 18590);
const timeoutMs = 100;
const observeMs = 500;
const DATA = 0, HEADERS = 1, RESET = 3, SETTINGS = 4, PING = 6, GOAWAY = 7, WINDOW = 8, CONTINUATION = 9;
const END = 1, END_HEADERS = 4;
const fragment = '<p id="event">a fixed fragment for the transport comparison</p>';

function frame(type, flags, stream, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(9);
  header.writeUIntBE(payload.length, 0, 3);
  header[3] = type; header[4] = flags; header.writeUInt32BE(stream, 5);
  return Buffer.concat([header, payload]);
}
function headers(path) {
  const authority = Buffer.from(`localhost:${port}`);
  const bytes = Buffer.from(path);
  return Buffer.concat([Buffer.from([0x82, 0x87, 0x01, authority.length]), authority, Buffer.from([0x04, bytes.length]), bytes]);
}
function word(value) {
  const payload = Buffer.alloc(4);
  payload.writeUInt32BE(value);
  return payload;
}
function round(ms) {
  return Math.round(ms * 10) / 10;
}
async function waitUntil(predicate, by, stopped = () => false) {
  while (performance.now() < by && !predicate() && !stopped()) await delay(2);
  return predicate();
}
async function connect(window, openAt) {
  const socket = tls.connect({
    host: '127.0.0.1', port, rejectUnauthorized: false, ALPNProtocols: ['h2'],
  });
  const frames = [];
  let pending = Buffer.alloc(0);
  let closedAt;
  socket.on('error', () => {});
  socket.on('close', () => { closedAt = performance.now(); });
  const write = (...args) => {
    if (!socket.destroyed && socket.writable) { socket.write(frame(...args)); return true; }
    return false;
  };
  socket.on('data', bytes => {
    pending = Buffer.concat([pending, bytes]);
    while (pending.length >= 9 && pending.length >= 9 + pending.readUIntBE(0, 3)) {
      const length = pending.readUIntBE(0, 3);
      const one = {
        type: pending[3], flags: pending[4], stream: pending.readUInt32BE(5),
        payload: pending.subarray(9, 9 + length), at: performance.now(),
      };
      frames.push(one);
      if (one.type === SETTINGS && !(one.flags & END)) write(SETTINGS, END, 0);
      if (one.type === PING && !(one.flags & END)) write(PING, END, 0, one.payload);
      pending = pending.subarray(9 + length);
    }
  });
  try {
    await once(socket, 'secureConnect', { signal: AbortSignal.timeout(2000) });
    assert.equal(socket.alpnProtocol, 'h2');
    socket.setNoDelay(true);
    const settings = Buffer.alloc(6);
    settings.writeUInt16BE(4, 0); settings.writeUInt32BE(window, 2);
    socket.write(Buffer.concat([Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'), frame(SETTINGS, 0, 0, settings)]));
    const find = (type, stream, flags = 0) => frames.find(f => f.type === type && f.stream === stream && (f.flags & flags) === flags);
    const stop = () => closedAt !== undefined;
    const ready = async (predicate, label, maxMs = observeMs) => {
      assert(await waitUntil(predicate, performance.now() + maxMs, stop), label);
    };
    await ready(() => find(SETTINGS, 0, END), 'server acknowledged initial stream credit');
    return {
      socket, frames, find, ready, write, openAt, get closedAt() { return closedAt; },
      request: (id, path, flags = END | END_HEADERS) => write(HEADERS, flags, id, headers(path)),
      reset: id => write(RESET, 0, id, word(8)), // CANCEL
      credit: (id, n = 65535) => write(WINDOW, 0, id, word(n)),
      data: id => Buffer.concat(frames.filter(f => f.type === DATA && f.stream === id).map(f => f.payload)),
      end: id => frames.find(f => [DATA, HEADERS].includes(f.type) && f.stream === id && f.flags & END),
      alive: () => !stop() && !find(GOAWAY, 0),
    };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function partial(c, id, path = '/') {
  const block = headers(path);
  assert(c.write(HEADERS, END, id, block.subarray(0, 1)), 'partial HEADERS written');
  return () => c.write(CONTINUATION, END_HEADERS, id, block.subarray(1));
}
async function ended(c, id) {
  await c.ready(() => c.end(id), `stream ${id} ended`);
  return c.end(id).at;
}
async function page(c, id) {
  const finished = await ended(c, id);
  assert.equal(c.data(id).toString(), 'Same page');
  return finished;
}
async function open(c, id, path) {
  assert(c.request(id, path), `sent ${path}`);
  await c.ready(() => c.find(HEADERS, id), `stream ${id} started`);
}
async function requireClosure(c, timing, start, late, hasOld) {
  const by = start + observeMs;
  await delay(Math.max(0, Math.ceil(by - performance.now())));
  // On success the socket already refused the late frame. On failure actually
  // send it and look for the old response instead of merely noting an open socket.
  timing.closedMs = c.closedAt === undefined ? null : round(c.closedAt - start);
  timing.lateWritten = late();
  if (timing.lateWritten) {
    timing.lateResponse = await waitUntil(hasOld, performance.now() + 150, () => c.closedAt !== undefined);
    if (timing.lateResponse) timing.lateResponseMs = round(performance.now() - start);
  } else {
    timing.lateResponse = Boolean(hasOld());
  }
  assert(c.closedAt !== undefined && c.closedAt <= by, 'connection did not close by 500 ms');
  assert(!timing.lateResponse, 'old response delivered');
}
async function idlePartial(c, timing, id, start = performance.now()) {
  const late = partial(c, id);
  await requireClosure(c, timing, start, late, () => c.find(HEADERS, id));
}

async function idleAfterPage(c, t, at, next) {
  await requireClosure(c, t, at, () => c.request(next, '/'), () => c.find(HEADERS, next));
  assert(t.closedMs >= timeoutMs - 10 && t.closedMs <= timeoutMs + 50, 'normal completion got a new idle period');
}

const idle = [
  ['no first request', 65535, async (c, t) => {
    await requireClosure(c, t, c.openAt, () => c.request(1, '/'), () => c.find(HEADERS, 1));
  }],
  ['incomplete first request', 65535, (c, t) => idlePartial(c, t, 1, c.openAt)],
  ['idle partial head after END_STREAM', 65535, async (c, t) => {
    assert(c.request(1, '/'));
    await idlePartial(c, t, 3, await page(c, 1));
  }],
  ['idle after last overlapping answer', 65535, async (c, t) => {
    assert(c.request(1, '/hold?ms=160'));
    assert(c.request(3, '/hold?ms=380'));
    await c.ready(() => c.find(HEADERS, 1) && c.find(HEADERS, 3), 'both answers opened');
    const first = await ended(c, 1);
    const last = await ended(c, 3);
    t.betweenEndsMs = round(last - first);
    assert(last - first > timeoutMs, 'sibling remained open beyond the idle bound');
    assert(c.data(3).includes(fragment), 'last answer delivered');
    await idlePartial(c, t, 5, last);
  }],
  ['reset with open sibling, then idle', 65535, async (c, t) => {
    await open(c, 1, '/quiet');
    await open(c, 3, '/quiet');
    assert(c.reset(1));
    await delay(observeMs);
    t.siblingOpenMs = observeMs;
    assert(c.alive() && !c.end(3) && !c.find(RESET, 3), 'reset must not idle an open sibling');
    const last = performance.now();
    assert(c.reset(3));
    await idlePartial(c, t, 5, last);
  }],
  ['cancel pending handler, then idle', 65535, async (c, t) => {
    assert(c.request(1, '/wait'));
    await delay(2 * timeoutMs);
    assert(c.alive() && !c.find(HEADERS, 1), 'pending handler kept the connection busy');
    const last = performance.now();
    assert(c.reset(1));
    await idlePartial(c, t, 3, last);
  }],
  ['partial head beside open sibling', 65535, async (c, t) => {
    await open(c, 1, '/quiet');
    const at = performance.now();
    const late = partial(c, 3);
    await delay(observeMs);
    t.siblingOpenMs = round(performance.now() - at);
    assert(c.alive() && !c.end(1) && !c.find(RESET, 1), 'open sibling must keep connection busy');
    assert(late());
    t.latePageMs = round(await page(c, 3) - at);
  }],
  ['queued final answer keeps connection busy', 1, async (c, t) => {
    await open(c, 1, '/final');
    await c.ready(() => c.data(1).length === 1, 'one byte sent and a tail withheld');
    const at = performance.now();
    await delay(observeMs);
    t.closedMs = c.closedAt === undefined ? null : round(c.closedAt - at);
    assert(c.alive() && !c.end(1), 'queued tail must keep the idle-only connection busy');
    assert(c.credit(1));
    const last = await ended(c, 1);
    t.completedMs = round(last - at);
    assert.equal(c.data(1).length, 4096);
    await idlePartial(c, t, 3, last);
    t.idleAfterDrainMs = t.closedMs;
    delete t.closedMs;
  }],
];

const send = [
  ['zero stream window', 0, async (c, t) => {
    const at = performance.now();
    await open(c, 1, '/events?n=1');
    await requireClosure(c, t, at, () => {
      assert(!c.find(DATA, 1) && !c.find(RESET, 1), 'no delivery or reset before credit');
      return c.credit(1);
    }, () => c.data(1).includes(fragment));
  }],
  ['final chunk with buffered tail', 1, async (c, t) => {
    const at = performance.now();
    await open(c, 1, '/final');
    await c.ready(() => c.data(1).length === 1, 'final chunk started then blocked');
    await requireClosure(c, t, at, () => {
      assert.equal(c.data(1).length, 1, 'tail withheld');
      return c.credit(1);
    }, () => c.data(1).length > 1);
  }],
  ['stalled tail beside progressing sibling', 1, async (c, t) => {
    const at = performance.now();
    assert(c.request(1, '/final') && c.request(3, '/ticker'));
    assert(c.credit(3));
    await c.ready(() => c.data(1).length === 1, 'target consumed its credit');
    try {
      await requireClosure(c, t, at, () => c.credit(1), () => c.data(1).length > 1);
    } finally {
      const progress = c.frames.filter(f => f.type === DATA && f.stream === 3 && f.at <= (c.closedAt ?? at + observeMs));
      t.siblingWrites = progress.length;
      t.lastSiblingMs = progress.length ? round(progress.at(-1).at - at) : null;
      assert(progress.length >= 2, 'sibling really made repeated progress');
    }
  }],
  ['quiet producer', 0, async (c, t) => {
    await open(c, 1, '/quiet');
    const at = performance.now();
    await delay(observeMs);
    t.survivedMs = round(performance.now() - at);
    assert(c.alive() && !c.find(DATA, 1) && !c.find(RESET, 1), 'no chunk is not a send stall');
    assert(c.request(3, '/') && c.credit(3));
    t.siblingPageMs = round(await page(c, 3) - at);
  }],
  ['normal response', 65535, async (c, t) => {
    assert(c.request(1, '/'));
    const at = await page(c, 1);
    await delay(observeMs);
    assert(c.alive() && c.request(3, '/'), 'normal completion left no send timer armed');
    t.reusedMs = round(await page(c, 3) - at);
  }],
  ['credit recovers before the bound', 0, async (c, t, combined) => {
    if (combined) await open(c, 1, '/quiet');
    const id = combined ? 3 : 1;
    const at = performance.now();
    await open(c, id, '/events?n=1');
    await delay(35);
    t.creditMs = round(performance.now() - at);
    assert(t.creditMs < timeoutMs && c.credit(id), 'early credit sent');
    t.completedMs = round(await ended(c, id) - at);
    assert(c.data(id).includes(fragment), 'event arrived');
    await delay(2 * timeoutMs);
    assert(c.alive() && c.request(id + 2, '/') && c.credit(id + 2), 'no stale timer after recovery');
    const reused = await page(c, id + 2);
    if (combined) t.reusedMs = round(reused - at);
  }],
  ['incremental credit for one final chunk', 1, async (c, t) => {
    await open(c, 1, '/final');
    await c.ready(() => c.data(1).length === 1, 'first byte drained');
    const at = performance.now();
    for (let n = 1; n <= 6; n++) {
      await delay(30);
      assert(c.credit(1, 700), 'more credit sent');
      await c.ready(() => c.data(1).length === Math.min(4096, 1 + n * 700), 'chunk made progress');
    }
    t.completedMs = round(await ended(c, 1) - at);
    assert(t.completedMs > timeoutMs && c.alive(), 'a draining chunk can take longer than the bound in total');
  }],
  ['reset discards a queued tail', 1, async (c, t, combined) => {
    if (combined) await open(c, 1, '/quiet');
    const id = combined ? 3 : 1;
    await open(c, id, '/final');
    await c.ready(() => c.data(id).length === 1, 'tail queued before reset');
    const at = performance.now();
    assert(c.reset(id));
    await delay(observeMs);
    assert(c.alive() && c.request(id + 2, '/') && c.credit(id + 2), 'no stale timer after reset');
    t.reusedMs = round(await page(c, id + 2) - at);
    assert.equal(c.data(id).length, 1);
  }],
];

const combined = [
  ...idle.slice(0, -1),
  ['queued final answer exceeds send bound while busy', 1, async (c, t) => {
    await open(c, 1, '/final');
    await c.ready(() => c.data(1).length === 1, 'one byte sent and a tail withheld');
    await requireClosure(c, t, c.find(DATA, 1).at, () => c.credit(1), () => c.data(1).length > 1);
  }],
  ...send.map(test => test[0] !== 'normal response' ? test :
    ['normal response returns to idle', 65535, async (c, t) => {
      assert(c.request(1, '/'));
      await idleAfterPage(c, t, await page(c, 1), 3);
    }]),
  ['paused TCP reader stalls after h2 consumes DATA', 16 * 1024 * 1024, async (c, t) => {
    await open(c, 1, '/quiet'); // Idle must not be able to close this connection.
    assert(c.credit(0, 16 * 1024 * 1024), 'connection has credit for the entire socket fixture');
    c.socket.pause();
    const at = performance.now();
    assert(c.request(3, '/socket-stall'));
    await delay(observeMs);
    t.pausedMs = round(performance.now() - at);

    // Read the deadline report before resuming the blocked reader. Its own
    // close event cannot tell when the server first gave up on its write.
    const report = await connect(65535, performance.now());
    let resumed;
    try {
      assert(report.request(1, '/socket-report'));
      await ended(report, 1);
      const [op, pending, waited, sinceRequest] = report.data(1).toString().split(' ');
      t.socketOperation = op || null;
      t.pendingBuffers = pending === undefined ? null : Number(pending);
      t.socketWaitMs = waited === undefined ? null : Number(waited);
      t.socketExpiredMs = sinceRequest === undefined ? null : Number(sinceRequest);
    } finally {
      report.socket.destroy();
      resumed = performance.now();
      c.socket.resume();
    }
    const closed = await waitUntil(() => c.closedAt !== undefined, performance.now() + observeMs);
    t.closedAfterResumeMs = closed ? round(c.closedAt - resumed) : null;
    t.receivedBytes = c.data(3).length;
    assert(closed, 'peer closed after reads resumed');
    assert(['write', 'write_vectored', 'flush'].includes(t.socketOperation), 'socket write watch expired before reads resumed');
    assert.equal(t.pendingBuffers, 0, 'h2 had consumed all outstanding DATA buffers');
    assert(t.socketWaitMs >= timeoutMs && t.socketExpiredMs <= observeMs, 'socket wait expired within the send bound');
    assert(t.receivedBytes > 0 && !c.end(3) && !c.find(RESET, 3), 'only a prefix of the response reached the TCP reader');
  }],
];

const suite = process.argv[2] ?? 'all';
assert(['idle', 'send', 'all', 'combined'].includes(suite), 'usage: node limits.mjs [idle|send|all|combined]');
const cases = suite === 'idle' ? idle : suite === 'send' ? send : suite === 'combined' ? combined : [...idle, ...send];
for (const [check, window, run] of cases) {
  const at = performance.now();
  const result = { check, configuredTimeoutMs: timeoutMs };
  let c;
  try {
    c = await connect(window, at);
    await run(c, result, suite === 'combined');
    result.pass = true;
  } catch (error) {
    result.pass = false;
    result.error = error.message;
    result.caseClosedMs = c?.closedAt === undefined ? null : round(c.closedAt - at);
    process.exitCode = 1;
  } finally {
    c?.socket.destroy();
    result.elapsedMs = round(performance.now() - at);
    console.log(JSON.stringify(result));
  }
}
