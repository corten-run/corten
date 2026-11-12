// Installed before application scripts. This observer never imports a workload reducer.
export function installObserver() {
  const original = { add: EventTarget.prototype.addEventListener, remove: EventTarget.prototype.removeEventListener,
    timeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window), interval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
    raf: window.requestAnimationFrame.bind(window), cancelRaf: window.cancelAnimationFrame.bind(window), microtask: window.queueMicrotask.bind(window), fetch: window.fetch.bind(window) };
  const listeners = new Set(), timers = new Set(), tasks = new Set(), connections = new Set(), network = [];
  const byTarget = new WeakMap();
  const pageDelegates = new Set();
  let recording = false, screen, nodeId = 0, domId = 0, lastAt = -1;
  const nodes = new WeakMap();
  const now = () => { lastAt = Math.max(performance.now(), lastAt + 0.001); return lastAt; };
  const token = (node) => { if (!nodes.has(node)) nodes.set(node, `node-${++nodeId}`); return nodes.get(node); };
  const capture = (options) => typeof options === "boolean" ? options : !!options?.capture;
  const index = (target, type, options) => {
    let types = byTarget.get(target);
    if (!types) byTarget.set(target, types = new Map());
    const key = `${type}:${capture(options)}`;
    if (!types.has(key)) types.set(key, new Map());
    return types.get(key);
  };
  const releaseListener = (record) => {
    listeners.delete(record);
    index(record.target, record.type, record.capture).delete(record.callback);
  };
  EventTarget.prototype.addEventListener = function(type, callback, options) {
    if (!callback || options?.signal?.aborted) return original.add.call(this, type, callback, options);
    const registrations = index(this, type, options), old = registrations.get(callback);
    if (old) return;
    // Corten lazily installs one bubbling/capture delegate per input event for the
    // lifetime of the document (corten.js: listen). Count only those exact native
    // call sites as page infrastructure, not arbitrary app document listeners.
    const caller = new Error().stack?.split("\n")[2] ?? "";
    const delegate = `${type}:${capture(options)}`;
    const pageOwned = recording && this === document && ["click", "input"].includes(type)
      && /\/corten\/runtime\.js:\d+:\d+\)?$/.test(caller) && !pageDelegates.has(delegate);
    if (pageOwned) pageDelegates.add(delegate);
    const record = { target: this, type, callback, capture: capture(options), owned: recording && !pageOwned, pageOwned };
    record.wrapped = function(e) {
      if (options?.once) releaseListener(record);
      if (typeof callback === "function") return callback.call(this, e);
      return callback.handleEvent(e);
    };
    listeners.add(record); registrations.set(callback, record);
    if (options?.signal) original.add.call(options.signal, "abort", () => releaseListener(record), { once: true });
    return original.add.call(this, type, record.wrapped, options);
  };
  EventTarget.prototype.removeEventListener = function(type, callback, options) {
    const record = index(this, type, options).get(callback);
    if (record) { releaseListener(record); return original.remove.call(this, type, record.wrapped, options); }
    return original.remove.call(this, type, callback, options);
  };
  for (const [name, clear, repeat] of [["setTimeout", "clearTimeout", false], ["setInterval", "clearInterval", true]]) {
    const set = repeat ? original.interval : original.timeout, cancel = repeat ? original.clearInterval : original.clearTimeout;
    window[name] = (fn, delay, ...args) => {
      let id;
      id = set(() => { if (!repeat) timers.delete(id); typeof fn === "function" ? fn(...args) : (0, eval)(fn); }, delay);
      if (recording) timers.add(id);
      return id;
    };
    window[clear] = (id) => { timers.delete(id); cancel(id); };
  }
  window.requestAnimationFrame = (fn) => { const id = original.raf((at) => { tasks.delete(id); fn(at); }); if (recording) tasks.add(id); return id; };
  window.cancelAnimationFrame = (id) => { tasks.delete(id); original.cancelRaf(id); };
  window.queueMicrotask = (fn) => { const id = {}; if (recording) tasks.add(id); original.microtask(() => { tasks.delete(id); fn(); }); };
  if (window.requestIdleCallback) {
    const request = window.requestIdleCallback.bind(window), cancel = window.cancelIdleCallback.bind(window), pending = new Map();
    window.requestIdleCallback = (fn, options) => {
      const token = {}, id = request((deadline) => { pending.delete(id); tasks.delete(token); fn(deadline); }, options);
      pending.set(id, token); if (recording) tasks.add(token); return id;
    };
    window.cancelIdleCallback = (id) => { tasks.delete(pending.get(id)); pending.delete(id); cancel(id); };
  }
  if (window.scheduler?.postTask) {
    const post = window.scheduler.postTask.bind(window.scheduler);
    window.scheduler.postTask = (fn, options) => {
      const id = {}; if (recording) tasks.add(id);
      return post(fn, options).finally(() => tasks.delete(id));
    };
  }
  const NativeChannel = window.MessageChannel;
  window.MessageChannel = class extends NativeChannel {
    constructor() {
      super();
      for (const [from, to] of [[this.port1, this.port2], [this.port2, this.port1]]) {
        const pending = [], post = from.postMessage.bind(from), close = to.close.bind(to);
        from.postMessage = (...args) => {
          const id = {}; pending.push(id); if (recording) tasks.add(id);
          try { return post(...args); } catch (error) { pending.pop(); tasks.delete(id); throw error; }
        };
        original.add.call(to, "message", () => tasks.delete(pending.shift()));
        original.add.call(to, "messageerror", () => tasks.delete(pending.shift()));
        to.close = () => { for (const id of pending.splice(0)) tasks.delete(id); return close(); };
      }
    }
  };
  window.fetch = (...args) => {
    const id = {}; if (recording) { tasks.add(id); network.push({ transport: "fetch" }); }
    return original.fetch(...args).finally(() => tasks.delete(id));
  };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    if (recording) { tasks.add(this); network.push({ transport: "xhr" }); original.add.call(this, "loadend", () => tasks.delete(this), { once: true }); }
    try { return send.apply(this, args); } catch (error) { tasks.delete(this); throw error; }
  };
  const beacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = (...args) => { if (recording) network.push({ transport: "beacon" }); return beacon(...args); };
  for (const name of ["WebSocket", "EventSource"]) {
    const Native = window[name];
    window[name] = class extends Native {
      constructor(...args) {
        super(...args);
        if (recording) { connections.add(this); network.push({ transport: name }); }
        original.add.call(this, "close", () => connections.delete(this));
        if (name === "EventSource") original.add.call(this, "error", () => { if (this.readyState === 2) connections.delete(this); });
      }
      close(...args) { const result = super.close(...args); if (name === "EventSource") connections.delete(this); return result; }
    };
  }
  // These apps do not use workers. Fail closed rather than omit their resource/network activity.
  for (const name of ["Worker", "SharedWorker"]) if (window[name]) window[name] = class { constructor() { throw new Error("unobserved-worker-not-supported"); } };
  const owned = () => {
    const live = [...listeners].filter((r) => r.owned && !(r.target instanceof AbortSignal));
    // Detached element-bound UI handlers cannot receive browser input. Global listeners
    // installed before begin() belong to the page bootstrap, not this mount.
    const lasting = live.filter((r) => !(r.target instanceof Node) ||
      r.target.isConnected);
    return { subscriptions: live.filter((r) => r.target === window.clientSource).length, connections: connections.size,
      listeners: lasting.length, timers: timers.size, pendingTasks: tasks.size };
  };
  const dom = () => {
    screen ??= document.getElementById("screen");
    if (!screen) throw new Error("screen-missing");
    const visible = [...screen.querySelectorAll("tr[data-row]")].filter((e) => !e.hidden && (!screen.isConnected || e.checkVisibility()));
    const selected = visible.filter((e) => e.getAttribute("aria-selected") === "true" || e.hasAttribute("data-selected"));
    if (selected.length > 1) throw new Error("multiple-selected-rows");
    return { id: `dom-${++domId}`, rows: visible.map((e) => ({ id: e.cells[0].textContent, label: e.cells[1].textContent, node: token(e) })),
      selected: selected[0]?.cells[0].textContent ?? null,
      cards: [...screen.querySelectorAll("[data-card]")].filter((e) => !screen.isConnected || e.checkVisibility()).map((e) => ({ id: e.querySelector("b").textContent, priceMinor: Number(e.querySelector("span").textContent), node: token(e) })),
      totalMinor: Number(screen.querySelector("#total").textContent) };
  };
  window.clientObserver = { now, dom, owned, network,
    listenerDetails() { return [...listeners].filter((r) => r.owned || r.pageOwned).map((r) => ({ type: r.type, target: r.target.constructor.name, connected: r.target instanceof Node ? r.target.isConnected : null, pageOwned: r.pageOwned })); },
    begin() { recording = true; return { kind: "resources", at: now(), owned: owned() }; },
    loaded() { return JSON.parse(document.getElementById("fixture").textContent).initial; },
    detached() { return screen && !screen.isConnected; },
    settle() { return new Promise((resolve) => original.raf(() => original.raf(resolve))); },
    wait(ms) { return new Promise((resolve) => original.timeout(resolve, ms)); },
  };
}
