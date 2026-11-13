import { subscribe } from "corten";
import { rows, ParityRow } from "corten/views";
/** @import { FeedUrl } from "corten" */
/** @import { Holds } from "corten/views" */
/** @typedef {import("../types/app").Listing} Listing */

/**
 * The probe observes the native EventSource without replacing its connection,
 * cursor, retry, duplicate/gap checks or recovery. Those belong to subscribe().
 * @param {Holds<ParityRow, HTMLTableSectionElement>} body
 * @param {HTMLTemplateElement} template @param {HTMLOutputElement} count
 * @param {FeedUrl<Listing>} feed @param {AbortSignal} signal
 */
export function start(body, template, count, feed, signal) {
  const list = rows(body, ParityRow, template), records = [], effects = [];
  let through = 0, seen = 0, settings, work = Promise.resolve(), ack = Promise.resolve();
  let resume = false, received;
  const lifetime = new AbortController();
  const log = (kind, fields = {}) => records.push(structuredClone({ kind, at: performance.now(), ...fields }));
  const visible = () => Array.from(body.children, (el) => {
    const cells = el.children;
    return { id: cells[0].textContent, version: +cells[1].textContent,
      priceCents: +cells[2].textContent, quantity: +cells[3].textContent };
  });
  const state = () => ({ state: visible(), effects: effects.slice(), effectCount: Number(count.value) });
  const enqueue = (fn) => { work = work.then(fn); };
  async function api(name, data) {
    const r = await fetch(`/parity/${name}`, data === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    if (!r.ok) throw new Error(`${name}: ${r.status}`); return r.json();
  }
  async function resources() { const r = await api("resources"); log("resources", r); return r; }
  const data = (r) => ({ id: r.id, version: r.version, price_cents: r.priceCents, quantity: r.quantity });
  const native = window.EventSource;
  // An observational constructor decorator. Always returns the original native instance.
  window.EventSource = new Proxy(native, { construct(Target, args) {
    const source = Reflect.construct(Target, args);
    source.addEventListener("parity-ready", (message) => {
      const ready = JSON.parse(message.data);
      enqueue(async () => {
        if (resume) log("attach");
        log("resources", ready.resources);
        if (resume) { log("resume", { from: ready.from, status: ready.status }); resume = false; }
      });
    });
    source.addEventListener("patch", (message) => {
      const patch = JSON.parse(message.data), event = patch.event;
      const disposition = patch.seq <= seen ? "duplicate" : patch.seq !== seen + 1 ? "gap" : "applied";
      received = { event, disposition, receivedAt: performance.now(), barrier: ack };
      if (disposition !== "applied") {
        const delivery = received;
        enqueue(async () => { await delivery.barrier; log("event", { event, disposition, receivedAt: delivery.receivedAt, ...state() }); });
      }
    });
    source.addEventListener("sync", (message) => {
      const reason = JSON.parse(message.data).reason, barrier = ack;
      enqueue(async () => {
        await barrier;
        if (reason === "replay-backpressure") log("overflow", { outcome: "resnapshot" });
      });
    });
    return source;
  } });
  function follow() {
    subscribe(feed, {
      snapshot(items, seq) {
        seen = seq;
        enqueue(async () => {
          await ack;
          list.replace(items.map(data)); through = seq;
          log("snapshot", { through: seq, rows: items, work: { reads: 1, rows: items.length }, ...state() });
        });
      },
      patch(changes, seq) {
        seen = seq; const delivery = received;
        enqueue(async () => {
          await delivery.barrier;
          for (const change of changes) {
            const row = list.get(change.id);
            if (change.op === "remove") { if (row) list.remove(row); }
            else if (row) { row.version = change.value.version; row.price_cents = change.value.priceCents; row.quantity = change.value.quantity; }
            else list.push([data(change.value)]);
          }
          through = seq; effects.push(delivery.event.effectId); count.value = String(Number(count.value) + 1);
          log("event", { event: delivery.event, disposition: delivery.disposition, receivedAt: delivery.receivedAt, ...state() });
        });
      },
      status(status) {
        if (status === "syncing") enqueue(() => {
          // A reconnect that the feed refuses is followed by an actual native snapshot.
          log("snapshot-request");
        });
      },
    }, { signal: AbortSignal.any([signal, lifetime.signal]) });
  }
  window.liveApp = {
    records,
    async setup(s) { settings = s; await resources(); log("attach"); follow();
      await this.until(() => records.some((r) => r.kind === "snapshot") && records.some((r) => r.kind === "resources" && r.connections === 1)); },
    async until(predicate) {
      const deadline = performance.now() + 10000;
      while (!predicate()) { await work; if (performance.now() > deadline) throw new Error("native feed wait timed out"); await new Promise((r) => setTimeout(r, 5)); }
      await work;
    },
    async publish(event, probe = false) {
      let release; ack = new Promise((r) => { release = r; });
      const scheduledAt = performance.now(), startedAt = performance.now();
      try {
        const result = await api("publish", { event });
        if (result.seq !== event.seq) throw new Error("wrong native acknowledgement");
        log(probe ? "cleanup-probe" : "publish", probe ? { event } : { seq: result.seq, scheduledAt, startedAt });
        log("resources", result.resources);
      } finally { release(); }
    },
    async publishBatch(events) {
      let release; ack = new Promise((r) => { release = r; });
      const startedAt = performance.now();
      try {
        const result = await api("publish", { events });
        if (result.acks?.length !== events.length) throw new Error("wrong native batch acknowledgement count");
        result.acks.forEach((a, i) => {
          if (a.seq !== events[i].seq) throw new Error("wrong native batch sequence");
          log("publish", { seq: a.seq, scheduledAt: startedAt, startedAt }); log("resources", a.resources);
        });
      } finally { release(); }
    },
    async released() {
      const deadline = performance.now() + settings.maxCleanupMs;
      for (;;) { const r = await resources(); if (r.subscriptions + r.connections + r.pendingTasks + r.queueEvents === 0) return;
        if (performance.now() > deadline) throw new Error("native feed reader leaked"); await new Promise((r) => setTimeout(r, 10)); }
    },
    async disconnect() { log("disconnect", { reason: "forced" }); resume = true; await api("control", { action: "disconnect" }); await this.released(); },
    async reconnect() { await api("control", { action: "reconnect" }); },
    async drop(seq) { await api("control", { action: "drop", seq }); },
    async hold() { log("slow"); await api("control", { action: "hold" }); },
    async duplicate() { await api("control", { action: "duplicate" }); },
    async settle() { await work; },
    state() { log("state", { through, rows: visible(), effects: effects.slice(), effectCount: Number(count.value) }); },
    async detach() { log("detach"); lifetime.abort(); window.EventSource = native; await work; await this.released(); },
    get through() { return through; },
  };
  signal.addEventListener("abort", () => { lifetime.abort(); window.EventSource = native; }, { once: true });
}
