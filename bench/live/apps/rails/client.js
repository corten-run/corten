// Action Cable owns connection/subscription lifecycle; Turbo owns every keyed DOM mutation.
import { createConsumer } from '/native/cable.js';
import '/native/turbo.js';
const { renderStreamMessage } = window.Turbo;

const records = [], effects = [];
let consumer, subscription, settings, detached = false, through = 0, initialized = false;
let consumerId, publications = Promise.resolve();
function enqueuePublication(work) { return publications = publications.then(work); }
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
async function render(html) {
  if (!html) return;
  const streams = (html.match(/<turbo-stream\b/g) || []).length;
  let completed = 0;
  const applied = new Promise(resolve => {
    const before = event => {
      const nativeRender = event.detail.render;
      event.detail.render = async element => {
        await nativeRender(element);
        if (++completed === streams) { document.removeEventListener('turbo:before-stream-render', before); resolve(); }
      };
    };
    document.addEventListener('turbo:before-stream-render', before);
  });
  renderStreamMessage(html);
  await applied;
}
const observed = () => ({ through: +document.querySelector('#effects').dataset.through,
  effectCount: +document.querySelector('#effects').value, rowCount: rows().length });
function acknowledge() { subscription.perform('acknowledge', observed()); }
function snapshot() { record('snapshot-request'); subscription.perform('snapshot', observed()); }
async function connect(resume) {
  record('attach');
  if (!resume) record('snapshot-request');
  const ready = new Promise(resolve => { resolveReady = resolve; });
  consumer = createConsumer('/cable');
  subscription = consumer.subscriptions.create({ channel: 'NativeChannel', consumer: document.querySelector('meta[name="native-consumer"]').content }, {
    connected() { this.perform('start', { from: through, initial: !initialized, observed: observed() }); },
    received(message) {
      const receivedAt = performance.now(), barrier = publication;
      chain = chain.then(async () => {
        await barrier;
        if (message.kind === 'finished') { resolveFinished(); return; }
        if (detached) return;
        if (message.kind === 'error') throw new Error(message.message);
        if (message.kind === 'ready') {
          consumerId = message.consumer;
          record('resources', message.resources);
          if (initialized) {
            record('resume', { from: message.from, status: message.status });
            if (message.status === 'expired') snapshot();
          }
        } else if (message.kind === 'restore') {
          await render(message.html);
          if (+document.querySelector('#effects').dataset.through === through) resolveReady();
        } else if (message.kind === 'snapshot') {
          await render(message.html);
          through = +document.querySelector('#effects').dataset.through;
          record('snapshot', { ...message.snapshot, ...application() });
          initialized = true; acknowledge(); resolveReady();
        } else if (message.kind === 'event') {
          await render(message.html);
          through = +document.querySelector('#effects').dataset.through;
          if (message.disposition === 'applied') effects.push(message.event.effectId);
          record('event', { event: message.event, disposition: message.disposition, receivedAt, ...application() });
          if (message.disposition === 'gap') snapshot(); else acknowledge();
        } else if (message.kind === 'overflow') {
          record('resources', message.resources);
          record('overflow', { outcome: message.outcome, receivedAt }); snapshot();
        }
      });
    },
  });
  await ready;
}
window.liveApp = {
  records,
  async setup(value) { settings = value; await resources(); await connect(false); },
  publish(event, probe = false) {
    const scheduledAt = performance.now();
    return enqueuePublication(async () => {
      let release; publication = new Promise(resolve => { release = resolve; });
      const startedAt = performance.now();
      try {
        const ack = await request('/parity/publish', { event });
        if (ack.seq !== event.seq) throw new Error('publication acknowledgement mismatch');
        record(probe ? 'cleanup-probe' : 'publish', probe ? { event } : { seq: ack.seq, scheduledAt, startedAt });
        record('resources', ack.resources);
      } finally { release(); }
    });
  },
  publishBatch(events) {
    const scheduledAt = performance.now();
    return enqueuePublication(async () => {
      let release; publication = new Promise(resolve => { release = resolve; });
      const startedAt = performance.now();
      try {
        const response = await request('/parity/publish', { events });
        if (response.acks?.length !== events.length || response.acks.some((ack, index) => ack.seq !== events[index].seq)) {
          throw new Error('bulk publication acknowledgement mismatch');
        }
        for (const ack of response.acks) {
          record('publish', { seq: ack.seq, scheduledAt, startedAt });
          record('resources', ack.resources);
        }
      } finally { release(); }
    });
  },
  async released() {
    const end = performance.now() + settings.maxCleanupMs;
    for (;;) {
      const value = await resources();
      if (!consumerId || !value.inventory?.consumers) throw new Error('missing native consumer inventory');
      const own = value.inventory.consumers[consumerId];
      if (own === undefined || (own !== null &&
          ['subscriptions', 'connections', 'pendingTasks', 'queueEvents'].every(key => own[key] === 0))) return;
      if (performance.now() >= end) throw new Error('native cleanup timeout');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  },
  async disconnect() { await chain; record('disconnect', { reason: 'forced' }); consumer.disconnect(); consumer = subscription = null; await this.released(); },
  async reconnect() { await connect(true); },
  async hold() { record('slow'); await request('/parity/control', { action: 'hold' }); },
  async drop(seq) { await request('/parity/control', { action: 'drop', seq }); },
  async duplicate() { await request('/parity/control', { action: 'duplicate' }); },
  async settle() { await chain; },
  state() { const value = application(); record('state', { through, rows: value.state, effects: value.effects, effectCount: value.effectCount }); },
  async detach() {
    await chain; record('detach'); detached = true;
    const finished = new Promise(resolve => { resolveFinished = resolve; });
    subscription.perform('finish', {}); await finished;
    consumer.disconnect(); consumer = subscription = null; await this.released();
  },
  get through() { return through; },
  get consumerId() { return consumerId; },
};
