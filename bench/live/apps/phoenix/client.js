// Native LiveView owns its WebSocket, lifecycle, keyed streams and every DOM mutation.
import { Socket } from 'phoenix';
import { LiveSocket } from 'phoenix_live_view';

const records = [], effects = [];
let settings, hook, detached = false, through = 0, resume = false;
let chain = Promise.resolve(), publication = Promise.resolve(), resolveReady, resolveFinished;
const record = (kind, fields = {}) => records.push(structuredClone({ kind, at: performance.now(), ...fields }));
const rows = () => [...document.querySelector('#rows').children].map(tr => ({ id: tr.id,
  version: +tr.cells[0].textContent, priceCents: +tr.cells[1].textContent, quantity: +tr.cells[2].textContent }));
const application = () => ({ state: rows(), effects: [...effects], effectCount: +document.querySelector('#effects').value });
async function request(path, data) {
  const response = await fetch(path, data === undefined ? {} : { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}
async function resources() {
  const value = await request('/parity/resources'); record('resources', value); return value;
}
function acknowledge() { hook.pushEvent('acknowledge', {}); }
function snapshot() { record('snapshot-request'); hook.pushEvent('snapshot', {}); }
function received(message) {
  const receivedAt = performance.now(), barrier = publication;
  chain = chain.then(async () => {
    await barrier;
    if (message.kind === 'finished') { resolveFinished(); return; }
    if (detached) return;
    if (message.kind === 'ready') {
      record('resources', message.resources);
      if (resume) {
        record('resume', { from: message.from, status: message.status });
        if (message.status === 'expired') snapshot();
      }
    } else if (message.kind === 'restore') {
      if (+document.querySelector('#effects').dataset.through === through) resolveReady();
      acknowledge();
    } else if (message.kind === 'snapshot') {
      through = +document.querySelector('#effects').dataset.through;
      record('snapshot', { ...message.snapshot, ...application(), through });
      acknowledge(); resolveReady();
    } else if (message.kind === 'event') {
      through = +document.querySelector('#effects').dataset.through;
      if (message.disposition === 'applied') effects.push(message.event.effectId);
      record('event', { event: message.event, disposition: message.disposition, receivedAt, ...application() });
      if (message.disposition === 'gap') snapshot(); else acknowledge();
    } else if (message.kind === 'overflow') {
      record('resources', message.resources);
      record('overflow', { outcome: message.outcome, receivedAt }); snapshot();
    }
  });
}
const liveSocket = new LiveSocket('/live', Socket, {
  params: { _csrf_token: document.querySelector('meta[name="csrf-token"]').content },
  hooks: { Parity: {
    mounted() {
      hook = this;
      this.handleEvent('parity', received);
      this.pushEvent('start', { from: through, initial: !resume });
    },
    reconnected() {
      hook = this;
      this.pushEvent('start', { from: through, initial: !resume });
    },
  } },
});
async function connect(value) {
  resume = value; record('attach');
  if (!resume) record('snapshot-request');
  const ready = new Promise(resolve => { resolveReady = resolve; });
  liveSocket.connect(); await ready;
}
window.liveApp = {
  records,
  async setup(value) { settings = value; await resources(); await connect(false); },
  async publish(event, probe = false) {
    let release; publication = new Promise(resolve => { release = resolve; });
    const scheduledAt = performance.now(), startedAt = performance.now();
    try {
      const ack = await request('/parity/publish', { event });
      if (ack.seq !== event.seq) throw new Error('publication acknowledgement mismatch');
      record(probe ? 'cleanup-probe' : 'publish', probe ? { event } : { seq: ack.seq, scheduledAt, startedAt });
      record('resources', ack.resources);
    } finally { release(); }
  },
  async publishBatch(events) {
    let release; publication = new Promise(resolve => { release = resolve; });
    const scheduledAt = performance.now(), startedAt = performance.now();
    try {
      const response = await request('/parity/publish', { events });
      if (response.acks?.length !== events.length || response.acks.some((ack, index) => ack.seq !== events[index].seq)) {
        throw new Error('bulk publication acknowledgement mismatch');
      }
      for (const ack of response.acks) {
        record('publish', { seq: ack.seq, scheduledAt, startedAt }); record('resources', ack.resources);
      }
    } finally { release(); }
  },
  async released() {
    const end = performance.now() + settings.maxCleanupMs;
    for (;;) {
      const value = await resources();
      if (!value.subscriptions && !value.connections && !value.pendingTasks && !value.queueEvents) return;
      if (performance.now() >= end) throw new Error('native cleanup timeout');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  },
  async disconnect() { await chain; record('disconnect', { reason: 'forced' }); liveSocket.disconnect(); await this.released(); },
  async reconnect() { await connect(true); },
  async hold() { record('slow'); await request('/parity/control', { action: 'hold' }); },
  async drop(seq) { await request('/parity/control', { action: 'drop', seq }); },
  async duplicate() { await request('/parity/control', { action: 'duplicate' }); },
  async settle() { await chain; },
  state() { const value = application(); record('state', { through, rows: value.state, effects: value.effects, effectCount: value.effectCount }); },
  async detach() {
    await chain; record('detach'); detached = true;
    const finished = new Promise(resolve => { resolveFinished = resolve; });
    hook.pushEvent('finish', {}); await finished;
    liveSocket.disconnect(); await this.released();
  },
  get through() { return through; },
};
