import { apply_change, replace_snapshot, detach_component } from '/pkg/live_parity.js';

// Observation/control only. The WASM component owns all rendered nodes and its counter.
const records = [], effects = [];
let through = 0, stream, work = Promise.resolve(), ack = Promise.resolve(), settings, stopped = false;
const log = (kind, fields = {}) => records.push(structuredClone({ kind, at: performance.now(), ...fields }));
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function publication() {
  const prior = ack;
  let release;
  const current = new Promise(resolve => { release = resolve; });
  ack = prior.then(() => current);
  return { prior, release };
}
const state = () => ({
  state: Array.from(document.querySelectorAll('#listings > li'), li => ({ id: li.dataset.key,
    version: +li.querySelector('.version').textContent, priceCents: +li.querySelector('.price').textContent,
    quantity: +li.querySelector('.quantity').textContent })),
  effects: effects.slice(), effectCount: Number(document.querySelector('#effect-count').textContent),
});
async function api(path, value) {
  const response = await fetch(`/parity/${path}`, value === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
async function resources() { const r = await api('resources'); log('resources', r); return r; }
async function read() {
  log('snapshot-request'); const snapshot = await api('snapshot');
  if (stopped) return;
  replace_snapshot(JSON.stringify(snapshot)); await flush(); through = snapshot.through;
  log('snapshot', { ...snapshot, ...state() });
}
async function open(resuming) {
  log('attach');
  await new Promise((resolve, reject) => {
    const source = new EventSource(`/parity/events?from=${through}`); stream = source;
    source.onerror = () => { source.close(); if (!stopped) reject(new Error('native SSE disconnected')); };
    source.addEventListener('ready', message => {
      work = work.then(async () => {
        if (stopped) return;
        const ready = JSON.parse(message.data); log('resources', ready.resources);
        if (resuming) log('resume', { from: ready.from, status: ready.status });
        if (!resuming || ready.status === 'expired') await read();
        resolve();
      });
      work.catch(reject);
    });
    source.addEventListener('update', message => {
      const receivedAt = performance.now(), barrier = ack, event = JSON.parse(message.data);
      work = work.then(async () => {
        await barrier;
        if (stopped) return;
        const disposition = event.seq <= through ? 'duplicate' : event.seq > through + 1 ? 'gap' : 'applied';
        if (disposition === 'applied') {
          apply_change(JSON.stringify(event)); await flush(); through = event.seq; effects.push(event.effectId);
        }
        log('event', { event, disposition, receivedAt, ...state() });
        if (disposition === 'gap') await read();
      });
    });
    source.addEventListener('overflow', message => {
      const receivedAt = performance.now(), barrier = ack;
      work = work.then(async () => {
        await barrier; if (stopped) return;
        const overflow = JSON.parse(message.data);
        log('resources', overflow.resources); log('overflow', { outcome: overflow.outcome, receivedAt }); await read();
      });
    });
  });
}
window.nativeLeptosCleanup = () => { stopped = true; stream?.close(); };
window.liveApp = {
  records,
  async setup(options) {
    settings = options;
    const deadline = performance.now() + 10000;
    while (!window.nativeLeptosReady) { if (performance.now() > deadline) throw new Error('Leptos did not hydrate'); await flush(); }
    await resources(); await open(false);
  },
  async publish(event, probe = false) {
    const { prior, release } = publication();
    const startedAt = performance.now();
    try {
      const result = await api('publish', { event });
      if (result.seq !== event.seq) throw new Error('native write not acknowledged');
      await prior;
      log(probe ? 'cleanup-probe' : 'publish', probe ? { event } : { seq: result.seq, scheduledAt: startedAt, startedAt });
      log('resources', result.resources);
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
        if (item.seq !== events[i].seq) throw new Error('native batch sequence mismatch');
        log('publish', { seq: item.seq, scheduledAt: startedAt, startedAt }); log('resources', item.resources);
      }
    } finally { release(); }
  },
  async released() {
    await work;
    const deadline = performance.now() + settings.maxCleanupMs;
    for (;;) {
      const r = await resources();
      // Counters remain aggregate and unchanged: another reader may be healthy.
      // This client's native EventSource closure and drained work identify release.
      if (!stream || stream.readyState === EventSource.CLOSED) return r;
      if (performance.now() > deadline) throw new Error('native reader not released');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  },
  async disconnect() { log('disconnect', { reason: 'forced' }); stream.close(); await this.released(); },
  reconnect() { return open(true); },
  async hold() { log('slow'); await api('control', { action: 'hold' }); },
  async drop(seq) { await api('control', { action: 'drop', seq }); },
  async duplicate() { await api('control', { action: 'duplicate' }); },
  async settle() { await work; },
  state() { const s = state(); log('state', { through, rows: s.state, effects: s.effects, effectCount: s.effectCount }); },
  async detach() { log('detach'); detach_component(); await work; await this.released(); },
  get through() { return through; },
};
