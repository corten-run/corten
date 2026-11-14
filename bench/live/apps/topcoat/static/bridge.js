// Topcoat owns connections, rendering, keyed components and their cancellation.
// This bridge invokes native signal handlers and observes the DOM and original WebSockets.
const records = [], effects = [], sockets = new Set(), arrivals = new Map();
const OriginalWebSocket = window.WebSocket;
let nativeConnection;
window.WebSocket = class extends OriginalWebSocket {
  constructor(...args) {
    super(...args); sockets.add(this); nativeConnection = this;
    this.addEventListener('close', () => sockets.delete(this));
    this.addEventListener('message', event => {
      if (typeof event.data !== 'string') return;
      const frame = JSON.parse(event.data)?.frame;
      if (!['snapshot', 'swap'].includes(frame?.t)) return;
      const encoded = /<output id="native-message" data-message="([A-Za-z0-9+/=]+)"/.exec(frame.html)?.[1];
      if (encoded) {
        const message = decode(encoded);
        if (message.serial) arrivals.set(message.serial, { at: performance.now(), connection: this });
      }
    });
  }
};
const client = document.querySelector('#parity-app').dataset.client;
let through = 0, work = Promise.resolve(), ack = Promise.resolve(), settings, stopped = false, opening, lastSerial = 0, observedSerial = 0;
const generation = () => ({ controller: new AbortController(), pending: new Set(), error: undefined });
let current = generation();
const log = (kind, fields = {}) => records.push(structuredClone({ kind, at: performance.now(), ...fields }));
function until(promise, signal) {
  return new Promise((resolve, reject) => {
    const finish = (settle, value) => { signal.removeEventListener('abort', abort); settle(value); };
    const abort = () => finish(reject, signal.reason);
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}
function publication() {
  const prior = ack;
  let release;
  const current = new Promise(resolve => { release = resolve; });
  ack = prior.then(() => current);
  return { prior, release };
}
function decode(encoded) { return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)))); }
function state() {
  return { state: Array.from(document.querySelectorAll('#listings > li'), li => ({ id: li.dataset.key,
    version: +li.querySelector('.version').textContent, priceCents: +li.querySelector('.price').textContent,
    quantity: +li.querySelector('.quantity').textContent })), effects: effects.slice(),
  effectCount: Number(document.querySelector('#effect-count').textContent) };
}
async function api(path, value, signal) {
  const response = await fetch(`/parity/${path}`, value === undefined ? { signal } : {
    signal,
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
async function resources(signal) { const r = await api('resources', undefined, signal); log('resources', r); return r; }
async function read(signal) {
  log('snapshot-request');
  await api(`snapshot?client=${encodeURIComponent(client)}`, undefined, signal);
  // Only Topcoat's subsequent native emission changes the screen and records the snapshot.
}
function complete(message, owner, handshake, arrival) {
  const signal = owner.controller.signal;
  const pending = (async () => {
    await api('acknowledge', { client, serial: message.serial }, signal);
    if (signal.aborted || owner !== current) return;
    if (message.kind === 'ready') {
      if (handshake?.resuming === false || message.status === 'expired') await read(signal);
      else { handshake?.resolve(); if (opening === handshake) opening = undefined; }
    } else if (message.kind === 'snapshot') {
      handshake?.resolve(); if (opening === handshake) opening = undefined;
    } else if (message.kind === 'overflow' || message.disposition === 'gap') await read(signal);
  })().catch(error => {
    if (signal.aborted || owner !== current) return;
    owner.error ??= error;
    if (arrival.connection === nativeConnection && nativeConnection.readyState === OriginalWebSocket.OPEN) handshake?.reject(error);
  }).finally(() => owner.pending.delete(pending));
  owner.pending.add(pending);
}
async function settled() {
  for (;;) {
    const owner = current, observed = work;
    await observed;
    await Promise.all(owner.pending);
    if (owner !== current || observed !== work || owner.pending.size) continue;
    if (owner.error) throw owner.error;
    return;
  }
}
async function socketsClosed(signal) {
  const waiting = Array.from(sockets);
  let closed;
  try {
    await until(new Promise(resolve => {
      closed = () => { if (sockets.size === 0) resolve(); };
      for (const socket of waiting) socket.addEventListener('close', closed);
      closed();
    }), signal);
  } finally {
    for (const socket of waiting) socket.removeEventListener('close', closed);
  }
}
function observe() {
  const node = document.querySelector('#native-message');
  if (!node) return;
  const message = decode(node.dataset.message);
  if (!message.serial || message.serial <= lastSerial) return;
  lastSerial = message.serial;
  // Keep completion and rejection callbacks with this connection's handshake.
  const arrival = arrivals.get(message.serial), receivedAt = arrival?.at, barrier = ack, handshake = opening;
  if (!Number.isFinite(receivedAt)) throw new Error('native Topcoat arrival timestamp missing');
  arrivals.delete(message.serial);
  // Recording a native observation never waits on an earlier ACK response.
  // A ready owns a fresh ACK generation; old requests cannot hold it pending.
  if (message.kind === 'ready') {
    current.controller.abort(); current = generation();
  }
  const owner = current, screen = state(), visibleThrough = Number(document.querySelector('#native-screen').dataset.through);
  work = work.then(async () => {
    await barrier;
    if (stopped) return;
    if (owner === current) through = visibleThrough;
    observedSerial = Math.max(observedSerial, message.serial);
    if (message.kind === 'ready') {
      log('resources', message.resources);
      const resuming = handshake?.resuming ?? true;
      if (resuming) log('resume', { from: message.from, status: message.status });
    } else if (message.kind === 'snapshot') {
      log('snapshot', { ...message.snapshot, ...screen, effects: effects.slice() });
    } else if (message.kind === 'event') {
      if (message.disposition === 'applied') effects.push(message.event.effectId);
      log('event', { event: message.event, disposition: message.disposition, receivedAt, ...screen, effects: effects.slice() });
    } else if (message.kind === 'overflow') {
      log('resources', message.resources); log('overflow', { outcome: message.outcome, receivedAt });
    } else throw new Error('unknown native Topcoat message');
    if (owner === current) complete(message, owner, handshake, arrival);
  }).catch(error => {
    owner.error ??= error;
    if (owner === current) handshake?.reject(error);
  });
}
const observer = new MutationObserver(observe);
observer.observe(document.querySelector('#parity-app'), { subtree: true, childList: true, attributes: true });
observe();
async function open(resuming) {
  log('attach');
  // Reconcile the actual DOM observation, including an ACK whose response was lost.
  // Serial zero registers only on first live attach, not on an ordinary page GET.
  await api('acknowledge', { client, serial: observedSerial });
  current.controller.abort(); current = generation();
  await new Promise((resolve, reject) => {
    opening = { resolve, reject, resuming };
    document.querySelector('#native-connect').click();
  });
}
window.liveApp = {
  records,
  async setup(options) { settings = options; await resources(); await open(false); },
  async publish(event, probe = false) {
    const { prior, release } = publication();
    const startedAt = performance.now();
    try {
      const result = await api('publish', { event });
      if (result.seq !== event.seq) throw new Error('native write not acknowledged');
      await prior;
      log(probe ? 'cleanup-probe' : 'publish', probe ? { event } : { seq: result.seq, scheduledAt: startedAt, startedAt });
      log('resources', result.resources);
      await api('publisher-ack', { through: result.seq });
    } finally { release(); }
  },
  async publishBatch(events) {
    const { prior, release } = publication();
    const startedAt = performance.now();
    try {
      const result = await api('publish', { events });
      if (result.acks?.length !== events.length) throw new Error('incomplete native batch acknowledgement');
      await prior;
      for (const [i, item] of result.acks.entries()) {
        if (item.seq !== events[i].seq) throw new Error('batch acknowledgement sequence mismatch');
        log('publish', { seq: item.seq, scheduledAt: startedAt, startedAt }); log('resources', item.resources);
      }
      await api('publisher-ack', { through: events.at(-1).seq });
    } finally { release(); }
  },
  async released(deadline = performance.now() + settings.maxCleanupMs, finish = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('native Topcoat render/socket not released')),
      Math.max(0, deadline - performance.now()));
    try {
      await until(settled(), controller.signal);
      for (;;) {
        controller.signal.throwIfAborted();
        const reader = await api(`reader?client=${encodeURIComponent(client)}`, undefined, controller.signal);
        const observed = await resources(controller.signal);
        controller.signal.throwIfAborted();
        if (!reader.active) {
          await socketsClosed(controller.signal);
          await until(settled(), controller.signal);
          if (finish) await until(api('finish', { client }, controller.signal), controller.signal);
          controller.signal.throwIfAborted();
          return observed;
        }
        let poll;
        try { await until(new Promise(resolve => { poll = setTimeout(resolve, 10); }), controller.signal); }
        finally { clearTimeout(poll); }
      }
    } finally { clearTimeout(timer); }
  },
  async disconnect() {
    const deadline = performance.now() + settings.maxCleanupMs;
    log('disconnect', { reason: 'forced' }); document.querySelector('#native-disconnect').click(); await this.released(deadline);
  },
  reconnect() { return open(true); },
  async hold() { log('slow'); await api('control', { action: 'hold' }); },
  async drop(seq) { await api('control', { action: 'drop', seq }); },
  async duplicate() { await api('control', { action: 'duplicate' }); },
  async settle() { await settled(); },
  state() { const s = state(); log('state', { through, rows: s.state, effects: s.effects, effectCount: s.effectCount }); },
  async detach() {
    const deadline = performance.now() + settings.maxCleanupMs;
    log('detach'); document.querySelector('#native-disconnect').click();
    try { await this.released(deadline, true); }
    finally { stopped = true; current.controller.abort(); observer.disconnect(); arrivals.clear(); window.WebSocket = OriginalWebSocket; }
  },
  get through() { return through; },
};
