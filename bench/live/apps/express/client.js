// Express application's native EventSource consumer and DOM renderer. No benchmark oracle.
(() => {
  const records = [], effects = [];
  const body = document.querySelector("#rows"), counter = document.querySelector("#effects");
  let through = 0, source = null, chain = Promise.resolve(), publication = Promise.resolve();
  let settings, detached = false;
  const record = (kind, fields = {}) => records.push(structuredClone({ kind, at: performance.now(), ...fields }));
  const rows = () => [...body.children].map((tr) => ({ id: tr.id, version: +tr.cells[0].textContent,
    priceCents: +tr.cells[1].textContent, quantity: +tr.cells[2].textContent }));
  const application = () => ({ state: rows(), effects: [...effects], effectCount: +counter.value });
  async function request(path, data) {
    const response = await fetch(path, data === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.json();
  }
  function upsert(row) {
    let tr = document.getElementById(row.id);
    if (!tr) { tr = body.insertRow(); tr.id = row.id; for (let i = 0; i < 3; i++) tr.insertCell(); }
    [row.version, row.priceCents, row.quantity].forEach((value, i) => { tr.cells[i].textContent = String(value); });
  }
  async function resources() { const r = await request("/parity/resources"); record("resources", r); return r; }
  async function snapshot() {
    record("snapshot-request");
    const s = await request("/parity/snapshot");
    body.replaceChildren(); s.rows.forEach(upsert); through = s.through;
    record("snapshot", { ...s, ...application() });
  }
  async function connect(resume) {
    record("attach");
    let resolve, reject;
    const ready = new Promise((yes, no) => { resolve = yes; reject = no; });
    source = new EventSource(`/parity/events?from=${through}`);
    source.onerror = () => { if (!detached) { source.close(); reject(new Error("unexpected native stream failure")); record("transport-error"); } };
    source.addEventListener("ready", (message) => {
      chain = chain.then(async () => {
        const r = JSON.parse(message.data); record("resources", r.resources);
        if (resume) record("resume", { from: r.from, status: r.status });
        if (!resume || r.status === "expired") await snapshot();
        resolve();
      });
    });
    source.addEventListener("update", (message) => {
      const receivedAt = performance.now(), event = JSON.parse(message.data), barrier = publication;
      chain = chain.then(async () => {
        await barrier;
        if (detached) { record("late-delivery", { event }); return; }
        let disposition;
        if (event.seq <= through) disposition = "duplicate";
        else if (event.seq !== through + 1) disposition = "gap";
        else {
          disposition = "applied"; through = event.seq;
          if (event.op === "remove") document.getElementById(event.key)?.remove(); else upsert(event.row);
          effects.push(event.effectId); counter.value = String(+counter.value + 1);
        }
        record("event", { event, disposition, receivedAt, ...application() });
        if (disposition === "gap") await snapshot();
      });
    });
    source.addEventListener("overflow", (message) => {
      const receivedAt = performance.now(), barrier = publication;
      chain = chain.then(async () => {
        await barrier;
        const r = JSON.parse(message.data);
        record("resources", r.resources); record("overflow", { outcome: r.outcome, receivedAt }); await snapshot();
      });
    });
    await ready;
  }
  window.liveApp = {
    records,
    async setup(s) { settings = s; await resources(); await connect(false); },
    async publish(event, probe = false) {
      let release; publication = new Promise((r) => { release = r; });
      const scheduledAt = performance.now(), startedAt = performance.now();
      try {
        const ack = await request("/parity/publish", { event });
        if (ack.seq !== event.seq) throw new Error("wrong publication acknowledgement");
        record(probe ? "cleanup-probe" : "publish", probe ? { event } : { seq: ack.seq, scheduledAt, startedAt });
        record("resources", ack.resources);
      } finally { release(); }
    },
    async disconnect() { record("disconnect", { reason: "forced" }); source.close(); source = null; await this.released(); },
    async released() {
      const until = performance.now() + settings.maxCleanupMs;
      while (true) {
        const r = await resources();
        if (!r.subscriptions && !r.connections && !r.pendingTasks && !r.queueEvents) return;
        if (performance.now() >= until) throw new Error("native resource cleanup timed out");
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    async reconnect() { await connect(true); },
    async hold() { record("slow"); await request("/parity/control", { action: "hold" }); },
    async drop(seq) { await request("/parity/control", { action: "drop", seq }); },
    async duplicate() { await request("/parity/control", { action: "duplicate" }); },
    async settle() { await chain; },
    state() { const a = application(); record("state", { through, rows: a.state, effects: a.effects, effectCount: a.effectCount }); },
    async detach() { record("detach"); detached = true; source.close(); source = null; await chain; await this.released(); },
    get through() { return through; },
  };
})();
