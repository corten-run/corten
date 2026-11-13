// App-local native WebSocket consumer; the DOM, not a fixture/parallel model, is observed.
(() => {
  const body = document.querySelector('#rows'), template = document.querySelector('#listing');
  const counter = document.querySelector('#effects'), status = document.querySelector('#status');
  const keyed = new Map([...body.children].map(node => [node.dataset.key, node]));
  const records = [], effects = [], transportRecords = [];
  let through = 0, connection, settings, detached = false, needsSnapshot = false, failure;
  let sequence = Promise.resolve(), publication = Promise.resolve(), publishQueue = Promise.resolve();
  const log = (kind, data = {}) => records.push(structuredClone({ kind, at: performance.now(), ...data }));
  const logTransport = (kind, data) => transportRecords.push(structuredClone({ kind, at: performance.now(), ...data }));
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
  async function resources(reader) {
    const value = await http('resources' + (reader ? '?reader=' + encodeURIComponent(reader) : ''));
    log('resources', value); return value;
  }
  async function snapshot() {
    log('snapshot-request'); const value = await http('snapshot');
    body.replaceChildren(); keyed.clear(); value.rows.forEach(render); through = value.through;
    log('snapshot', { ...value, ...observed() });
  }
  function failed(owner, error) {
    if (owner.failed) return;
    owner.failed = true; owner.expectedClose = true; needsSnapshot = true; failure = error;
    status.textContent = error.message; log('failure', { message: error.message });
    owner.reject(error); owner.socket.close(4000, 'delivery failed');
    queueMicrotask(() => { throw error; });
  }
  function enqueue(owner, work) {
    // Drain the scheduling tail after a failure, but retain/report the actual failed operation.
    sequence = sequence.then(() => { if (owner === connection && !owner.failed) return work(); })
      .catch(error => failed(owner, error));
  }
  async function attach(resuming) {
    if (connection) await close(connection);
    if (detached) throw new Error('Drogon application detached');
    failure = undefined; log('attach');
    await new Promise((resolve, reject) => {
      const url = new URL('/parity/socket', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('from', through);
      const owner = connection = { socket: new WebSocket(url), reject, readerId: null, terminal: null, expectedClose: false, failed: false };
      owner.socket.onerror = () => failed(owner, new Error('Drogon WebSocket failed'));
      owner.socket.onclose = event => {
        owner.terminal = { url: owner.socket.url, readerId: owner.readerId, code: event.code, reason: event.reason, wasClean: event.wasClean };
        logTransport('socket-close', owner.terminal);
        if (owner === connection && !owner.failed) status.textContent = detached ? 'Detached' : 'Disconnected';
        if (!owner.expectedClose) failed(owner, new Error('Drogon WebSocket closed unexpectedly'));
      };
      owner.socket.onmessage = message => {
        const receivedAt = performance.now(), barrier = publication;
        let value;
        try {
          value = JSON.parse(message.data);
          if (value.protocol !== 'drogon-live/v1') throw new Error('Unknown Drogon wire protocol');
          if (value.kind === 'ready') owner.readerId = value.readerId;
        } catch (error) { failed(owner, error); return; }
        enqueue(owner, async () => {
          await barrier;
          if (detached) throw new Error('Drogon delivery after detach');
          if (value.kind === 'ready') {
            log('resources', value.resources);
            if (resuming) log('resume', { from: value.from, status: value.status });
            const replace = needsSnapshot || !resuming || value.status === 'expired';
            if (replace) { await snapshot(); needsSnapshot = false; }
            owner.socket.send(JSON.stringify({ kind: 'start', through, snapshot: replace }));
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
          owner.socket.send(JSON.stringify({ kind: 'ack', delivery: value.delivery, through, snapshot: replace }));
        });
      };
    });
    await sequence;
  }
  async function write(events, probe, batch, scheduledAt) {
    let release; publication = new Promise(resolve => { release = resolve; });
    const startedAt = performance.now();
    try {
      const value = await http('publish', batch ? { events } : { event: events[0] });
      const acks = batch ? value.acks : [value];
      if (acks?.length !== events.length) throw new Error('Drogon acknowledgement count mismatch');
      for (const [n, ack] of acks.entries()) {
        if (ack.seq !== events[n].seq) throw new Error('Drogon acknowledgement sequence mismatch');
        log(probe ? 'cleanup-probe' : 'publish', probe ? { event: events[n] } : { seq: ack.seq, scheduledAt, startedAt });
        log('resources', ack.resources);
      }
    } finally { release(); }
  }
  function publish(events, probe, batch) {
    const scheduledAt = performance.now();
    const task = publishQueue.then(() => write(events, probe, batch, scheduledAt));
    publishQueue = task.catch(() => {}); return task;
  }
  async function released(owner = connection) {
    const reader = owner?.readerId;
    if (!reader) {
      if (!owner?.terminal || owner.socket.readyState !== WebSocket.CLOSED) throw new Error('Drogon reader identity unavailable for cleanup');
      // No ready frame means no known reader inventory. Prove only actual local transport closure.
      logTransport('transport-released', { scope: 'browser-socket', ...owner.terminal }); return;
    }
    const deadline = performance.now() + settings.maxCleanupMs;
    while (true) {
      const value = await resources(reader), owned = value.reader;
      if (owned?.id !== reader) throw new Error('Drogon cleanup identity mismatch');
      if (owned.subscriptions + owned.connections + owned.pendingTasks + owned.queueEvents + owned.replayEvents + owned.inFlight === 0) return;
      if (performance.now() > deadline) throw new Error('Drogon reader/connection leaked');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  async function close(owner = connection) {
    owner.expectedClose = true;
    if (owner.socket.readyState !== WebSocket.CLOSED) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Drogon socket close exceeded cleanup bound')), settings.maxCleanupMs);
        owner.socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true }); owner.socket.close(1000);
      });
    }
    await sequence; await released(owner);
  }
  window.addEventListener('pagehide', () => { if (connection) { connection.expectedClose = true; connection.socket.close(1000); } });
  window.liveApp = {
    records, transportRecords, get through() { return through; },
    async setup(value) { settings = value; await resources(); await attach(false); },
    publish(event, probe = false) { return publish([event], probe, false); },
    publishBatch(events) { return publish(events, false, true); },
    async disconnect() { log('disconnect', { reason: 'forced' }); await close(); },
    reconnect() { return attach(true); },
    async hold() { log('slow'); await http('control', { action: 'hold' }); },
    async drop(seq) { await http('control', { action: 'drop', seq }); },
    async duplicate() { await http('control', { action: 'duplicate' }); },
    async settle() { await sequence; if (failure) throw failure; },
    state() { const value = observed(); log('state', { through, rows: value.state, effects: value.effects, effectCount: value.effectCount }); },
    async detach() { await sequence; log('detach'); detached = true; await close(); },
    released,
  };
})();
