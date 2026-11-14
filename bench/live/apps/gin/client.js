// Gin application: native SSE with keyed article updates, not a shared browser renderer.
(() => {
  const records = [], effects = [], cards = document.querySelector("#cards"), count = document.querySelector("#effects");
  let through = 0, connection, sequence = Promise.resolve(), publication = Promise.resolve(), settings, removed = false;
  const log = (kind, data = {}) => records.push(structuredClone({ kind, at: performance.now(), ...data }));
  const rows = () => [...cards.children].map((card) => ({ id: card.id, version: +card.querySelector("b").textContent,
    priceCents: +card.querySelector("data").value, quantity: +card.querySelector("small").textContent }));
  const state = () => ({ state: rows(), effects: [...effects], effectCount: +count.value });
  async function http(path, data) {
    const response = await fetch("/parity/" + path, data === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    if (!response.ok) throw new Error(`Gin ${path}: ${response.status}`); return response.json();
  }
  function render(row) {
    let card = document.getElementById(row.id);
    if (!card) { card = document.createElement("article"); card.id = row.id; card.append(document.createElement("b"), document.createElement("data"), document.createElement("small")); cards.append(card); }
    card.querySelector("b").textContent = row.version;
    card.querySelector("data").value = String(row.priceCents); card.querySelector("data").textContent = row.priceCents;
    card.querySelector("small").textContent = row.quantity;
  }
  async function resources() { const r = await http("resources"); log("resources", r); return r; }
  async function snapshot() {
    log("snapshot-request"); const s = await http("snapshot"); cards.replaceChildren(); s.rows.forEach(render); through = s.through;
    log("snapshot", { ...s, ...state() });
  }
  async function attach(resuming) {
    log("attach");
    await new Promise((resolve, reject) => {
      connection = new EventSource(`/parity/events?from=${through}`);
      connection.onerror = () => { if (!removed) { connection.close(); log("transport-error"); reject(new Error("Gin stream ended")); } };
      connection.addEventListener("ready", (m) => {
        sequence = sequence.then(async () => {
          const ready = JSON.parse(m.data); log("resources", ready.resources);
          if (resuming) log("resume", { from: ready.from, status: ready.status });
          if (!resuming || ready.status === "expired") await snapshot(); resolve();
        });
      });
      connection.addEventListener("update", (m) => {
        const receivedAt = performance.now(), barrier = publication, event = JSON.parse(m.data);
        sequence = sequence.then(async () => {
          await barrier;
          if (removed) { log("late-delivery", { event }); return; }
          let disposition = "duplicate";
          if (event.seq > through + 1) disposition = "gap";
          else if (event.seq === through + 1) {
            disposition = "applied";
            if (event.op === "remove") document.getElementById(event.key)?.remove(); else render(event.row);
            through = event.seq; effects.push(event.effectId); count.value = String(+count.value + 1);
          }
          log("event", { event, disposition, receivedAt, ...state() });
          if (disposition === "gap") await snapshot();
        });
      });
      connection.addEventListener("overflow", (m) => {
        const receivedAt = performance.now(), barrier = publication;
        sequence = sequence.then(async () => { await barrier; const outcome = JSON.parse(m.data);
          log("resources", outcome.resources); log("overflow", { outcome: outcome.outcome, receivedAt }); await snapshot(); });
      });
    });
  }
  window.liveApp = {
    records,
    async setup(s) { settings = s; await resources(); await attach(false); },
    async publish(event, probe = false) {
      let release; publication = new Promise((resolve) => { release = resolve; });
      const scheduledAt = performance.now(), startedAt = performance.now();
      try {
        const response = await http("publish", { event }); if (response.seq !== event.seq) throw new Error("Gin publish ack mismatch");
        log(probe ? "cleanup-probe" : "publish", probe ? { event } : { seq: response.seq, scheduledAt, startedAt }); log("resources", response.resources);
      } finally { release(); }
    },
    async publishBatch(events) {
      let release; publication = new Promise((resolve) => { release = resolve; });
      const startedAt = performance.now();
      try {
        const response = await http("publish", { events });
        if (response.acks?.length !== events.length) throw new Error("Gin batch size mismatch");
        response.acks.forEach((item, i) => {
          if (item.seq !== events[i].seq) throw new Error("Gin batch acknowledgement mismatch");
          log("publish", { seq: item.seq, scheduledAt: startedAt, startedAt }); log("resources", item.resources);
        });
      } finally { release(); }
    },
    async released() {
      const deadline = performance.now() + settings.maxCleanupMs;
      while (true) { const r = await resources(); if (r.subscriptions + r.connections + r.pendingTasks + r.queueEvents === 0) return;
        if (performance.now() > deadline) throw new Error("Gin stream goroutine leaked"); await new Promise((resolve) => setTimeout(resolve, 10)); }
    },
    async disconnect() { log("disconnect", { reason: "forced" }); connection.close(); await this.released(); },
    reconnect() { return attach(true); },
    async hold() { log("slow"); await http("control", { action: "hold" }); },
    async drop(seq) { await http("control", { action: "drop", seq }); },
    async duplicate() { await http("control", { action: "duplicate" }); },
    async settle() { await sequence; },
    state() { const s = state(); log("state", { through, rows: s.state, effects: s.effects, effectCount: s.effectCount }); },
    async detach() { log("detach"); removed = true; connection.close(); await sequence; await this.released(); },
    get through() { return through; },
  };
})();
