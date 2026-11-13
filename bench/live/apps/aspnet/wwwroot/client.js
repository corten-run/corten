// ASP.NET application: keyed list rendering and native EventSource, independent of Express.
(() => {
  const records = [], effects = [], list = document.getElementById("listings");
  const count = document.getElementById("effect-count");
  let version = 0, stream, work = Promise.resolve(), ack = Promise.resolve(), options, stopped = false;
  const log = (kind, fields = {}) => records.push(structuredClone({ kind, at: performance.now(), ...fields }));
  const visible = () => Array.from(list.children, (li) => ({ id: li.dataset.key, version: +li.querySelector(".version").textContent,
    priceCents: +li.querySelector(".price").textContent, quantity: +li.querySelector(".quantity").textContent }));
  const state = () => ({ state: visible(), effects: effects.slice(), effectCount: Number(count.value) });
  async function api(path, value) {
    const r = await fetch(`/parity/${path}`, value === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
    if (!r.ok) throw new Error(`${path} failed: ${r.status}`);
    return r.json();
  }
  function draw(row) {
    let li = Array.from(list.children).find((n) => n.dataset.key === row.id);
    if (!li) {
      li = document.createElement("li"); li.dataset.key = row.id;
      for (const name of ["version", "price", "quantity"]) { const span = document.createElement("span"); span.className = name; li.append(span, " "); }
      list.append(li);
    }
    li.querySelector(".version").textContent = row.version;
    li.querySelector(".price").textContent = row.priceCents;
    li.querySelector(".quantity").textContent = row.quantity;
  }
  async function resources() { const r = await api("resources"); log("resources", r); return r; }
  async function read() {
    log("snapshot-request"); const s = await api("snapshot");
    list.replaceChildren(); for (const row of s.rows) draw(row); version = s.through;
    log("snapshot", { ...s, ...state() });
  }
  async function open(resuming) {
    log("attach");
    await new Promise((resolve, reject) => {
      stream = new EventSource(`/parity/events?from=${version}`);
      stream.onerror = () => { if (!stopped) { stream.close(); log("transport-error"); reject(new Error("SSE disconnected")); } };
      stream.addEventListener("ready", (m) => {
        work = work.then(async () => {
          const ready = JSON.parse(m.data); log("resources", ready.resources);
          if (resuming) log("resume", { from: ready.from, status: ready.status });
          if (!resuming || ready.status === "expired") await read();
          resolve();
        });
      });
      stream.addEventListener("update", (m) => {
        const receivedAt = performance.now(), barrier = ack, e = JSON.parse(m.data);
        work = work.then(async () => {
          await barrier;
          if (stopped) { log("late-delivery", { event: e }); return; }
          const disposition = e.seq <= version ? "duplicate" : e.seq > version + 1 ? "gap" : "applied";
          if (disposition === "applied") {
            if (e.op === "upsert") draw(e.row);
            else Array.from(list.children).find((n) => n.dataset.key === e.key)?.remove();
            version = e.seq; effects.push(e.effectId); count.value = String(Number(count.value) + 1);
          }
          log("event", { event: e, disposition, receivedAt, ...state() });
          if (disposition === "gap") await read();
        });
      });
      stream.addEventListener("overflow", (m) => {
        const receivedAt = performance.now(), barrier = ack;
        work = work.then(async () => {
          await barrier; const outcome = JSON.parse(m.data);
          log("resources", outcome.resources); log("overflow", { outcome: outcome.outcome, receivedAt }); await read();
        });
      });
    });
  }
  window.liveApp = {
    records,
    async setup(s) { options = s; await resources(); await open(false); },
    async publish(event, probe = false) {
      let release; ack = new Promise((resolve) => { release = resolve; });
      const scheduledAt = performance.now(), startedAt = performance.now();
      try {
        const result = await api("publish", { event });
        if (result.seq !== event.seq) throw new Error("publication not acknowledged");
        log(probe ? "cleanup-probe" : "publish", probe ? { event } : { seq: result.seq, scheduledAt, startedAt });
        log("resources", result.resources);
      } finally { release(); }
    },
    async publishBatch(events) {
      let release; ack = new Promise((resolve) => { release = resolve; });
      const startedAt = performance.now();
      try {
        const result = await api("publish", { events });
        if (result.acks?.length !== events.length) throw new Error("batch not fully acknowledged");
        result.acks.forEach((item, i) => {
          if (item.seq !== events[i].seq) throw new Error("batch sequence mismatch");
          log("publish", { seq: item.seq, scheduledAt: startedAt, startedAt }); log("resources", item.resources);
        });
      } finally { release(); }
    },
    async released() {
      const deadline = performance.now() + options.maxCleanupMs;
      for (;;) {
        const r = await resources();
        if (r.connections + r.subscriptions + r.pendingTasks + r.queueEvents === 0) return;
        if (performance.now() > deadline) throw new Error("reader task not released");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async disconnect() { log("disconnect", { reason: "forced" }); stream.close(); await this.released(); },
    reconnect() { return open(true); },
    async drop(seq) { await api("control", { action: "drop", seq }); },
    async hold() { log("slow"); await api("control", { action: "hold" }); },
    async duplicate() { await api("control", { action: "duplicate" }); },
    async settle() { await work; },
    state() { const s = state(); log("state", { through: version, rows: s.state, effects: s.effects, effectCount: s.effectCount }); },
    async detach() { log("detach"); stopped = true; stream.close(); await work; await this.released(); },
    get through() { return version; },
  };
})();
