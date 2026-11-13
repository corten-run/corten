// App-local native WebSocket consumer; the DOM, not a fixture/parallel model, is observed.
(() => {
  const body = document.querySelector('#rows'), template = document.querySelector('#listing');
  const counter = document.querySelector('#effects'), status = document.querySelector('#status');
  const keyed = new Map([...body.children].map(node => [node.dataset.key, node]));
  const records = [], effects = [];
  let through = 0, socket, settings, detached = false, expectedClose = false;
  let sequence = Promise.resolve(), publication = Promise.resolve();
  const log = (kind, data = {}) => records.push(structuredClone({ kind, at: performance.now(), ...data }));
  const rows = () => [...body.children].map(node => ({ id: node.dataset.key, version: +node.cells[1].textContent,
    priceCents: +node.cells[2].textContent, quantity: +node.cells[3].textContent }));
  const observed = () => ({ state: rows(), effects: [...effects], effectCount: +counter.value });
  function render(row) {
    let node = keyed.get(row.id);
    if (!node) { node = template.content.firstElementChild.cloneNode(true); node.dataset.key = row.id; keyed.set(row.id, node); body.append(node); }
    node.cells[0].textContent = row.id; node.cells[1].textContent = row.version;
    node.cells[2].textContent = row.priceCents; node.cells[3].textContent = row.quantity;
  }
  async function http(name, data) {
    const response = await fetch('/parity/' + name, { signal: AbortSignal.timeout(10000), ...(data === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    }) });
    if (!response.ok) throw new Error(`Drogon ${name}: HTTP ${response.status}`);
    return response.json();
  }
  async function resources() { const value = await http('resources'); log('resources', value); return value; }
  async function snapshot() {
    log('snapshot-request'); const value = await http('snapshot');
    body.replaceChildren(); keyed.clear(); value.rows.forEach(render); through = value.through;
    log('snapshot', { ...value, ...observed() });
  }
  function enqueue(work) {
    sequence = sequence.then(work);
    sequence.catch(error => { status.textContent = error.message; queueMicrotask(() => { throw error; }); });
  }
  async function attach(resuming) {
    log('attach'); expectedClose = false;
    await new Promise((resolve, reject) => {
      const url = new URL('/parity/socket', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('from', through);
      const connection = socket = new WebSocket(url);
      connection.onerror = () => reject(new Error('Drogon WebSocket failed'));
      connection.onclose = () => {
        status.textContent = detached ? 'Detached' : 'Disconnected';
        if (!expectedClose) { const error = new Error('Drogon WebSocket closed unexpectedly'); reject(error); queueMicrotask(() => { throw error; }); }
      };
      connection.onmessage = message => {
        const receivedAt = performance.now(), barrier = publication, value = JSON.parse(message.data);
        if (value.protocol !== 'drogon-live/v1') throw new Error('Unknown Drogon wire protocol');
        enqueue(async () => {
          await barrier;
          if (detached) throw new Error('Drogon delivery after detach');
          if (value.kind === 'ready') {
            log('resources', value.resources);
            if (resuming) log('resume', { from: value.from, status: value.status });
            const replace = !resuming || value.status === 'expired';
            if (replace) await snapshot();
            connection.send(JSON.stringify({ kind: 'start', through, snapshot: replace }));
            status.textContent = 'Live'; resolve(); return;
          }
          let replace = false;
          if (value.kind === 'event') {
            const event = value.event;
            const disposition = event.seq <= through ? 'duplicate' : event.seq > through + 1 ? 'gap' : 'applied';
            if (disposition === 'applied') {
              if (event.op === 'remove') { keyed.get(event.key)?.remove(); keyed.delete(event.key); } else render(event.row);
              through = event.seq; effects.push(event.effectId); counter.value = String(+counter.value + 1);
            }
            log('event', { event, disposition, receivedAt, ...observed() }); replace = disposition === 'gap';
          } else if (value.kind === 'overflow') {
            log('resources', value.resources); log('overflow', { outcome: value.outcome, receivedAt }); replace = true;
          } else throw new Error('Unknown Drogon message');
          if (replace) await snapshot();
          connection.send(JSON.stringify({ kind: 'ack', delivery: value.delivery, through, snapshot: replace }));
        });
      };
    });
    await sequence;
  }
  async function publish(events, probe, batch) {
    let release; publication = new Promise(resolve => { release = resolve; });
    const startedAt = performance.now();
    try {
      const value = await http('publish', batch ? { events } : { event: events[0] });
      const acks = batch ? value.acks : [value];
      if (acks?.length !== events.length) throw new Error('Drogon acknowledgement count mismatch');
      for (const [n, ack] of acks.entries()) {
        if (ack.seq !== events[n].seq) throw new Error('Drogon acknowledgement sequence mismatch');
        log(probe ? 'cleanup-probe' : 'publish', probe ? { event: events[n] } : { seq: ack.seq, scheduledAt: startedAt, startedAt });
        log('resources', ack.resources);
      }
    } finally { release(); }
  }
  async function released() {
    const deadline = performance.now() + settings.maxCleanupMs;
    while (true) {
      const value = await resources();
      if (value.subscriptions + value.connections + value.pendingTasks + value.queueEvents === 0) return;
      if (performance.now() > deadline) throw new Error('Drogon reader/connection leaked');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  async function close() {
    expectedClose = true;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Drogon socket close exceeded cleanup bound')), settings.maxCleanupMs);
        socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true }); socket.close(1000);
      });
    }
    await sequence; await released();
  }
  window.addEventListener('pagehide', () => { expectedClose = true; socket?.close(1000); });
  window.liveApp = {
    records, get through() { return through; },
    async setup(value) { settings = value; await resources(); await attach(false); },
    publish(event, probe = false) { return publish([event], probe, false); },
    publishBatch(events) { return publish(events, false, true); },
    async disconnect() { log('disconnect', { reason: 'forced' }); await close(); },
    reconnect() { return attach(true); },
    async hold() { log('slow'); await http('control', { action: 'hold' }); },
    async drop(seq) { await http('control', { action: 'drop', seq }); },
    async duplicate() { await http('control', { action: 'duplicate' }); },
    async settle() { await sequence; },
    state() { const value = observed(); log('state', { through, rows: value.state, effects: value.effects, effectCount: value.effectCount }); },
    async detach() { await sequence; log('detach'); detached = true; await close(); },
    released,
  };
})();
