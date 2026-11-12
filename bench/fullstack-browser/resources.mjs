import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

// Installed before native scripts. It observes browser primitives, never removes
// a native listener, clears a native timer, or supplies framework cleanup.
export function installResourceObserver() {
  if (globalThis.__fullstackBrowserAudit) return;
  const entries = [], roots = new Map(), rootIds = new WeakMap(), callbacks = new WeakMap();
  const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  let activeScope = null, sequence = 0;
  const capture = (options) => typeof options === "boolean" ? options : Boolean(options?.capture);
  const scopeOf = (target) => {
    if (target instanceof Node) {
      const root = target instanceof Element ? target.closest("article.marketplace") : target.parentElement?.closest("article.marketplace");
      if (root) return register(root);
      for (const [id, ref] of roots) if (ref.deref()?.contains(target)) return id;
    }
    return activeScope;
  };
  const register = (root) => {
    if (!rootIds.has(root)) { const id = `${realm}:${++sequence}`; rootIds.set(root, id); roots.set(id, new WeakRef(root)); }
    return rootIds.get(root);
  };
  const realm = [...crypto.getRandomValues(new Uint32Array(4))].map((v) => v.toString(16).padStart(8, "0")).join("");
  const entry = (kind, target = null) => {
    const source = new Error().stack.split("\n").slice(2, 6).map((line) => line.replace(/https?:\/\/[^\s)]+/g, (value) => {
      try { const u = new URL(value); return u.pathname; } catch { return "[URL]"; }
    }));
    const tooling = source.some((line) => /InjectedScript\._setup(?:GlobalListenersRemovalDetection|HitTargetInterceptors)/.test(line));
    const value = { kind, target: target ? new WeakRef(target) : null, scope: scopeOf(target), active: true, source, tooling };
    entries.push(value); return value;
  };
  const invoke = (owned, callback, receiver, args) => {
    const previous = activeScope; activeScope = owned.scope ?? scopeOf(owned.target?.deref());
    try { return Reflect.apply(callback, receiver, args); } finally { activeScope = previous; }
  };
  EventTarget.prototype.addEventListener = function(type, callback, options) {
    if (!callback || options?.signal?.aborted) return Reflect.apply(add, this, [type, callback, options]);
    let targets = callbacks.get(callback); if (!targets) callbacks.set(callback, targets = new WeakMap());
    let bindings = targets.get(this); if (!bindings) targets.set(this, bindings = new Map());
    const key = JSON.stringify([String(type), capture(options)]);
    if (bindings.has(key)) return Reflect.apply(add, this, [type, bindings.get(key).wrapped, options]);
    const owned = entry("listeners", this); owned.type = String(type);
    const wrapped = function(...args) {
      if (options?.once) { owned.active = false; bindings.delete(key); }
      return typeof callback === "function" ? invoke(owned, callback, this, args) : invoke(owned, callback.handleEvent, callback, args);
    };
    bindings.set(key, { owned, wrapped });
    if (options?.signal) Reflect.apply(add, options.signal, ["abort", () => { owned.active = false; bindings.delete(key); }, { once: true }]);
    try { return Reflect.apply(add, this, [type, wrapped, options]); }
    catch (e) { owned.active = false; bindings.delete(key); throw e; }
  };
  EventTarget.prototype.removeEventListener = function(type, callback, options) {
    const bindings = callback && callbacks.get(callback)?.get(this), key = JSON.stringify([String(type), capture(options)]);
    const binding = bindings?.get(key);
    if (binding) { binding.owned.active = false; bindings.delete(key); }
    return Reflect.apply(remove, this, [type, binding?.wrapped ?? callback, options]);
  };
  const timerFamilies = { clock: new Map(), animation: new Map(), idle: new Map() };
  for (const [start, stop, repeat] of [["setTimeout", "clearTimeout", false], ["setInterval", "clearInterval", true],
    ["requestAnimationFrame", "cancelAnimationFrame", false], ["requestIdleCallback", "cancelIdleCallback", false]]) {
    const original = globalThis[start], cancel = globalThis[stop];
    if (!original) continue;
    const timers = timerFamilies[start.includes("Animation") ? "animation" : start.includes("Idle") ? "idle" : "clock"];
    globalThis[start] = function(callback, ...args) {
      const owned = entry("timers"); let id;
      const wrapped = typeof callback === "function" ? function(...values) {
        if (!repeat) { owned.active = false; timers.delete(id); }
        return invoke(owned, callback, this, values);
      } : callback;
      if (typeof callback !== "function") owned.unobservable = "string timer callback cannot propagate ownership";
      try { id = Reflect.apply(original, this, [wrapped, ...args]); timers.set(id, owned); return id; }
      catch (e) { owned.active = false; throw e; }
    };
    globalThis[stop] = function(id) { const owned = timers.get(id); if (owned) owned.active = false; timers.delete(id); return Reflect.apply(cancel, this, [id]); };
  }
  const fetch = globalThis.fetch;
  globalThis.fetch = function(...args) {
    const owned = entry("pendingTasks");
    try { return Reflect.apply(fetch, this, args).then((value) => { owned.active = false; return value; }, (e) => { owned.active = false; throw e; }); }
    catch (e) { owned.active = false; throw e; }
  };
  const queue = globalThis.queueMicrotask;
  globalThis.queueMicrotask = function(callback) {
    const owned = entry("pendingTasks");
    return queue(() => { owned.active = false; return invoke(owned, callback, undefined, []); });
  };
  for (const name of ["MutationObserver", "ResizeObserver", "IntersectionObserver"]) {
    const Original = globalThis[name]; if (!Original) continue;
    const owners = new WeakMap(), observe = Original.prototype.observe, disconnect = Original.prototype.disconnect;
    globalThis[name] = new Proxy(Original, { construct(Target, args, newTarget) {
      const owned = entry("subscriptions"); owned.active = false;
      const callback = args[0];
      const observer = Reflect.construct(Target, [function(...values) { return invoke(owned, callback, this, values); }, ...args.slice(1)], newTarget);
      owners.set(observer, owned); return observer;
    } });
    Original.prototype.observe = function(target, ...args) {
      const owned = owners.get(this);
      const value = Reflect.apply(observe, this, [target, ...args]);
      if (owned) { owned.active = true; owned.scope ??= scopeOf(target); owned.target = new WeakRef(target); }
      return value;
    };
    Original.prototype.disconnect = function() { const value = Reflect.apply(disconnect, this, []); const owned = owners.get(this); if (owned) owned.active = false; return value; };
  }
  for (const name of ["EventSource", "WebSocket", "Worker", "SharedWorker"]) {
    const Original = globalThis[name]; if (!Original) continue;
    const owners = new WeakMap();
    globalThis[name] = new Proxy(Original, { construct(Target, args, newTarget) {
      const value = Reflect.construct(Target, args, newTarget), owned = entry("connections"); owners.set(value, owned);
      Reflect.apply(add, value.port ?? value, ["close", () => { owned.active = false; }, { once: true }]);
      return value;
    } });
    const method = name.includes("Worker") ? "terminate" : "close", original = Original.prototype[method];
    if (original && name !== "WebSocket") Original.prototype[method] = function(...args) { const result = Reflect.apply(original, this, args); const owned = owners.get(this); if (owned) owned.active = false; return result; };
  }
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    const owned = entry("pendingTasks");
    Reflect.apply(add, this, ["loadend", () => { owned.active = false; }, { once: true }]);
    try { return Reflect.apply(send, this, args); } catch (e) { owned.active = false; throw e; }
  };
  const counts = (scope, tooling = false) => {
    const result = { subscriptions: 0, connections: 0, listeners: 0, timers: 0, pendingTasks: 0 };
    for (const owned of entries) {
      if (!owned.active) continue;
      if (owned.tooling !== tooling) continue;
      const target = owned.target?.deref();
      if (owned.target && !target) continue;
      owned.scope ??= scopeOf(target);
      if (tooling || owned.scope === scope) result[owned.kind]++;
    }
    return result;
  };
  Object.defineProperty(globalThis, "__fullstackBrowserAudit", { value: {
    checkpoint() {
      const root = document.querySelector("article.marketplace") ?? document.body; const scope = root ? register(root) : null;
      return { realm, scope, scopes: [...roots].map(([id, ref]) => ({ scope: id, connected: ref.deref()?.isConnected ?? false, owned: counts(id) })),
        tooling: { basis: "Observed Playwright InjectedScript setup call stacks", owned: counts(null, true) },
        unattributed: counts(null), unattributedDetails: entries.filter((e) => e.active && !e.scope && !e.tooling).map((e) => ({ kind: e.kind, source: e.source })),
        unsupported: entries.filter((e) => e.active && e.unobservable).map((e) => e.unobservable) };
    },
    probe(scope) {
      const root = roots.get(scope)?.deref(); if (!root) throw new Error("Retired DOM is unavailable for an event probe");
      if (root.isConnected) throw new Error("Native navigation did not retire the original marketplace root");
      const before = root.outerHTML, dispatched = [];
      for (const owned of entries.filter((e) => e.active && e.kind === "listeners" && e.scope === scope)) {
        const target = owned.target?.deref(); if (!target) continue;
        const event = new Event(owned.type, { cancelable: true }); event.preventDefault(); target.dispatchEvent(event); dispatched.push(owned.type);
      }
      root.dispatchEvent(new CustomEvent("retired-page-event"));
      return { before, after: root.outerHTML, dispatched, owned: counts(scope) };
    },
    root(scope) { return roots.get(scope)?.deref() ?? null; },
  }, configurable: false, writable: false });
}

export class ResourceAudit {
  constructor(page, cdp, javaScriptEnabled) {
    this.page = page; this.cdp = cdp; this.javaScriptEnabled = javaScriptEnabled; this.events = [];
    cdp.on("Runtime.executionContextDestroyed", (event) => this.events.push({ kind: "execution-context-destroyed", id: event.executionContextId }));
    cdp.on("Runtime.executionContextsCleared", () => this.events.push({ kind: "execution-contexts-cleared" }));
  }
  async checkpoint() {
    let observed = await this.page.evaluate(() => globalThis.__fullstackBrowserAudit?.checkpoint() ?? null);
    if (!observed && !this.javaScriptEnabled) {
      await this.page.evaluate(installResourceObserver);
      observed = await this.page.evaluate(() => globalThis.__fullstackBrowserAudit.checkpoint());
    }
    if (!observed) throw new Error("Document-start resource instrumentation absent");
    return { observer: randomUUID(), at: performance.now(), scriptExecutionEnabled: this.javaScriptEnabled, nativeContextEvents: [...this.events], ...observed };
  }
  async retain(observation) {
    if (!observation.scope) return null;
    return this.page.evaluateHandle((scope) => globalThis.__fullstackBrowserAudit.root(scope), observation.scope);
  }
  retired(before, after) {
    if (!before?.scope || before.scope === after.scope) return null;
    if (before.realm !== after.realm) return { scope: before.scope, owned: null, basis: "Native document realm replaced", probeAvailable: false,
      reason: "A destroyed realm cannot supply a fresh retired-DOM observation; no zero counts or successful event probe are invented" };
    const found = after.scopes.find((s) => s.scope === before.scope);
    return { scope: before.scope, owned: found?.owned ?? null, connected: found?.connected ?? null, basis: "Document-start native primitive ledger", probeAvailable: Boolean(found) };
  }
  async cleanup({ timeoutMs, observationMs, network, runtimeErrors }) {
    const evidence = { outcome: "failed", before: null, navigation: null, retired: null, probe: null, after: null, failures: [] };
    let handle;
    const hash = (value) => createHash("sha256").update(value).digest("hex");
    try {
      evidence.before = await this.checkpoint(); handle = await this.retain(evidence.before);
      if (!handle) throw new Error("No native marketplace scope remains to retire");
      const anchor = this.page.locator('header a[href="/"]').first();
      if (!await anchor.count()) throw new Error("No native navigation-away link is available for cleanup");
      evidence.navigation = { via: "native-header-link", path: "/", at: performance.now() };
      await anchor.click();
      const deadline = performance.now() + timeoutMs;
      let after;
      while (performance.now() < deadline) {
        try {
          after = await this.checkpoint();
          if (after.realm !== evidence.before.realm || !await handle.evaluate((root) => root.isConnected)) break;
        } catch (e) { if (!e.message.includes("Execution context was destroyed")) throw e; }
        await new Promise((r) => setTimeout(r, 25));
      }
      evidence.after = after;
      evidence.retired = this.retired(evidence.before, after);
      if (!evidence.retired?.probeAvailable) {
        evidence.outcome = "unsupported";
        throw new Error(evidence.retired?.reason ?? "Native navigation did not retire the marketplace scope");
      }
      await this.page.waitForLoadState("networkidle"); await network.drain();
      evidence.released = await this.checkpoint();
      evidence.retired = this.retired(evidence.before, evidence.released);
      const offset = network.rows.length, errorsAt = runtimeErrors.length;
      const probe = await this.page.evaluate((scope) => globalThis.__fullstackBrowserAudit.probe(scope), evidence.before.scope);
      evidence.probe = { observer: randomUUID(), scope: evidence.before.scope, kind: "retired-page-event", at: performance.now(),
        beforeSha256: hash(probe.before), immediateSha256: hash(probe.after), dispatched: probe.dispatched, owned: probe.owned };
      await new Promise((r) => setTimeout(r, observationMs)); await network.drain();
      const html = await handle.evaluate((root) => root.outerHTML);
      evidence.probe.afterSha256 = hash(html); evidence.probe.afterAt = performance.now();
      evidence.probe.afterResources = (await this.checkpoint()).scopes.find((s) => s.scope === evidence.before.scope)?.owned ?? null;
      evidence.probe.requests = structuredClone(network.rows.slice(offset)); evidence.probe.errors = runtimeErrors.slice(errorsAt);
      if (!evidence.retired.owned || Object.values(evidence.retired.owned).some(Boolean) || Object.values(probe.owned).some(Boolean) || !evidence.probe.afterResources || Object.values(evidence.probe.afterResources).some(Boolean)) throw new Error("Retired native scope still owns browser resources");
      if (evidence.probe.beforeSha256 !== evidence.probe.immediateSha256 || evidence.probe.beforeSha256 !== evidence.probe.afterSha256) throw new Error("Retired native DOM changed after event probe");
      if (evidence.probe.requests.length || evidence.probe.errors.length) throw new Error("Retired native event probe produced network work/errors");
      if (Object.values(evidence.after.unattributed).some(Boolean) || evidence.after.unsupported.length) throw new Error("Unattributed native resources prevent page-ownership qualification");
      evidence.outcome = "observed";
    } catch (e) { evidence.failures.push(e.message); }
    finally { if (handle) await handle.dispose().catch(() => {}); }
    return evidence;
  }
}
