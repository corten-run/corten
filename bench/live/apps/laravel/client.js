// Livewire owns rendering/morphing. Echo/Pusher own the native Reverb socket and subscription.
import { Livewire } from './vendor/livewire/livewire/dist/livewire.esm.js';
import Echo from 'laravel-echo';
import Pusher from 'pusher-js';

const records = [], effects = [], notifications = [];
let native, echo, consumerId, readerId, settings, initialized = false, detached = false, through = 0;
let chain = Promise.resolve(), publications = Promise.resolve(), publication = Promise.resolve();
const record = (kind, fields = {}) => records.push(structuredClone({ kind, at: performance.now(), ...fields }));
const rows = () => [...document.querySelector('#rows').children].map(tr => ({ id: tr.id,
  version: +tr.cells[0].textContent, priceCents: +tr.cells[1].textContent, quantity: +tr.cells[2].textContent }));
const observed = () => ({ through: +document.querySelector('#effects').dataset.through,
  effectCount: +document.querySelector('#effects').value, rowCount: rows().length });
const application = () => ({ state: rows(), effects: [...effects], effectCount: observed().effectCount });
async function request(path, data) {
  const response = await fetch(path, data === undefined ? {} : { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}
async function resources() {
  const value = await request('/parity/resources'); record('resources', value); return value;
}
async function snapshot() { record('snapshot-request'); await act('snapshot', observed()); }
async function received(message, receivedAt = performance.now()) {
  if (message.kind === 'ready') {
    consumerId = message.consumer;
    readerId = message.readerId;
    record('resources', message.resources);
    if (initialized) {
      record('resume', { from: message.from, status: message.status });
      if (message.status === 'expired') await snapshot();
    }
  } else if (message.kind === 'snapshot') {
    through = observed().through;
    record('snapshot', { ...message.snapshot, ...application(), through });
    initialized = true;
    await act('acknowledge', observed());
  } else if (message.kind === 'restore') {
    through = observed().through;
  } else if (message.kind === 'event') {
    through = observed().through;
    if (message.disposition === 'applied') effects.push(message.event.effectId);
    record('event', { event: message.event, disposition: message.disposition, receivedAt, ...application() });
    if (message.disposition === 'gap') await snapshot(); else await act('acknowledge', observed());
  } else if (message.kind === 'overflow') {
    record('resources', message.resources);
    record('overflow', { outcome: message.outcome, receivedAt }); await snapshot();
  }
}
async function act(method, ...args) {
  await native.$call(method, ...args);
  // Livewire 4 dispatches component events after its actual morph, before resolving $call.
  const messages = notifications.splice(0);
  for (const message of messages) await received(message);
}
function queue(work) { return chain = chain.then(work); }
async function connect() {
  record('attach'); if (!initialized) record('snapshot-request');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('native Reverb subscription deadline')), settings.maxCleanupMs);
    echo = new Echo({ broadcaster: 'reverb', client: new Pusher(document.querySelector('meta[name="reverb-key"]').content,
      { wsHost: location.hostname, wsPort: +(location.port || 80), wssPort: +(location.port || 443),
        cluster: 'mt1', forceTLS: false, enabledTransports: ['ws'], disableStats: true }) });
    echo.channel('live.' + consumerId).listen('.delivery', payload => {
      const receivedAt = performance.now(), barrier = publication;
      queue(async () => {
        await barrier;
        if (detached) return;
        if (payload.packet.readerId !== readerId) {
          record('superseded-delivery', { readerId: payload.packet.readerId }); return;
        }
        if (payload.packet.kind === 'overflow') await received(payload.packet, receivedAt);
        else await act('receive', payload);
      });
    }).subscribed(() => {
      queue(async () => {
        await act('start', through, !initialized, observed());
        clearTimeout(timer); resolve();
      }).catch(reject);
    }).error(error => { clearTimeout(timer); reject(error); });
  });
}
async function publish(events, bulk, probe) {
  const scheduledAt = performance.now();
  return publications = publications.then(async () => {
    let release; publication = new Promise(resolve => { release = resolve; });
    const startedAt = performance.now();
    try {
      const response = await request('/parity/publish', bulk ? { events } : { event: events[0] });
      const acks = bulk ? response.acks : [response];
      if (acks?.length !== events.length || acks.some((ack, index) => ack.seq !== events[index].seq)) {
        throw new Error('native publication acknowledgement mismatch');
      }
      for (const [index, ack] of acks.entries()) {
        record(probe ? 'cleanup-probe' : 'publish', probe ? { event: events[index] } : { seq: ack.seq, scheduledAt, startedAt });
        record('resources', ack.resources);
      }
    } finally { release(); }
  });
}
window.addEventListener('parity', event => notifications.push(event.detail.packet));
Livewire.start();
native = Livewire.find(document.querySelector('#native-screen').getAttribute('wire:id'));
consumerId = native.$get('client');
window.liveApp = {
  records,
  async setup(value) { settings = value; await resources(); await connect(); },
  publish(event, probe = false) { return publish([event], false, probe); },
  publishBatch(events) { return publish(events, true, false); },
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
  async disconnect() { await chain; record('disconnect', { reason: 'forced' }); echo.disconnect(); await this.released(); },
  async reconnect() { await connect(); },
  async hold() { record('slow'); await request('/parity/control', { action: 'hold' }); },
  async drop(seq) { await request('/parity/control', { action: 'drop', seq }); },
  async duplicate() { await request('/parity/control', { action: 'duplicate' }); },
  async settle() { await chain; },
  state() { const value = application(); record('state', { through, rows: value.state, effects: value.effects, effectCount: value.effectCount }); },
  async detach() {
    await chain; record('detach'); detached = true;
    await act('finish'); echo.disconnect(); await this.released();
  },
  get through() { return through; },
  get consumerId() { return consumerId; },
};
