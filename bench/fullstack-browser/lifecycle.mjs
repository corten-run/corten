import { performance } from "node:perf_hooks";

function address(value) {
  try { const url = new URL(value); return { scheme: url.protocol, path: ["http:", "https:", "ws:", "wss:"].includes(url.protocol) ? url.pathname : null }; }
  catch { return { scheme: null, path: null }; }
}

// Read-only receipts, not a cleanup decision or a resource-count substitute.
export class PlatformLifecycle {
  constructor(cdp, targets = null) {
    this.cdp = cdp; this.targets = targets; this.events = []; this.contexts = new Map(); this.frames = new Map(); this.realms = new Map();
    this.discovery = false; this.target = null;
    const record = (event, fields) => { const row = { event, receivedAt: performance.now(), ...fields }; this.events.push(row); return row; };
    cdp.on("Runtime.executionContextCreated", ({ context: c }) => {
      const row = record("Runtime.executionContextCreated", { context: c.id, uniqueId: c.uniqueId, frame: c.auxData?.frameId ?? null, default: c.auxData?.isDefault === true });
      this.contexts.set(c.id, { ...row, live: true });
    });
    cdp.on("Runtime.executionContextDestroyed", (e) => {
      record("Runtime.executionContextDestroyed", { context: e.executionContextId, uniqueId: e.executionContextUniqueId ?? null });
      const context = this.contexts.get(e.executionContextId); if (context) context.live = false;
    });
    cdp.on("Runtime.executionContextsCleared", () => {
      record("Runtime.executionContextsCleared", { contexts: [...this.contexts.values()].filter((c) => c.live).map((c) => ({ context: c.context, uniqueId: c.uniqueId })) });
      for (const context of this.contexts.values()) context.live = false;
    });
    cdp.on("Page.frameNavigated", ({ frame: f, type }) => {
      const row = record("Page.frameNavigated", { frame: f.id, parent: f.parentId ?? null, loader: f.loaderId, navigationType: type ?? null, ...address(f.url) }); this.frames.set(f.id, row);
    });
    cdp.on("Page.frameDetached", (e) => record("Page.frameDetached", { frame: e.frameId, reason: e.reason }));
    cdp.on("Network.webSocketCreated", (e) => record("Network.webSocketCreated", { request: e.requestId, ...address(e.url) }));
    cdp.on("Network.webSocketHandshakeResponseReceived", (e) => record("Network.webSocketHandshakeResponseReceived", { request: e.requestId, at: e.timestamp, status: e.response.status }));
    cdp.on("Network.webSocketClosed", (e) => record("Network.webSocketClosed", { request: e.requestId, at: e.timestamp }));
    cdp.on("Network.requestWillBeSent", (e) => {
      record("Network.requestWillBeSent", { request: e.requestId, frame: e.frameId ?? null, loader: e.loaderId, type: e.type, method: e.request.method, at: e.timestamp, ...address(e.request.url) });
    });
    cdp.on("Network.responseReceived", (e) => record("Network.responseReceived", { request: e.requestId, frame: e.frameId ?? null, loader: e.loaderId, type: e.type, status: e.response.status, at: e.timestamp }));
    cdp.on("Network.loadingFinished", (e) => record("Network.loadingFinished", { request: e.requestId, at: e.timestamp }));
    cdp.on("Network.loadingFailed", (e) => record("Network.loadingFailed", { request: e.requestId, at: e.timestamp, canceled: e.canceled === true, errorText: e.errorText }));
    for (const event of ["Target.targetCreated", "Target.targetInfoChanged"]) targets?.on(event, ({ targetInfo: t }) => record(event, {
      target: t.targetId, context: t.browserContextId ?? null, type: t.type, opener: t.openerId ?? null, openerFrame: t.openerFrameId ?? null, ...address(t.url),
    }));
    targets?.on("Target.targetDestroyed", (e) => record("Target.targetDestroyed", { target: e.targetId }));
  }
  async enable() {
    const { targetInfo: t } = await this.cdp.send("Target.getTargetInfo");
    this.target = { target: t.targetId, context: t.browserContextId ?? null, type: t.type };
    if (this.targets) { await this.targets.send("Target.setDiscoverTargets", { discover: true }); this.discovery = true; }
  }
  async bindRealm(realm) {
    if (this.realms.has(realm)) return;
    for (const context of this.contexts.values()) {
      if (!context.live || !context.default) continue;
      try {
        const result = await this.cdp.send("Runtime.evaluate", { expression: "globalThis.__fullstackBrowserAudit?.checkpoint()?.realm ?? null", contextId: context.context, returnByValue: true, silent: true });
        if (result.result?.value === realm) {
          this.realms.set(realm, { realm, context: context.context, uniqueId: context.uniqueId, frame: context.frame,
            loader: this.frames.get(context.frame)?.loader ?? null, observedAt: performance.now() }); return;
        }
      } catch (error) {
        // A real navigation can destroy the context during the read. Preserve
        // that failed association; never assign a replacement context by guess.
        this.events.push({ event: "realm-association-failed", receivedAt: performance.now(), context: context.context, error: error.message });
      }
    }
  }
  snapshot() {
    return structuredClone({ schema: "native-browser-platform-lifetimes/v1", target: this.target,
      coverage: { runtime: true, pageFrames: true, pageNetwork: true, browserTargetDiscovery: this.discovery,
        workerNetwork: false, serverSocketPeerClosure: false, sharedWorkerOwnership: false },
      realms: [...this.realms.values()], events: this.events,
      limits: ["Target destruction is not server-side socket closure", "Missing close/destroy receipts remain unknown, not zero",
        "Shared/service worker lifetime is not owned by a document without additional proof", "No retired DOM or successful event probe follows from realm destruction"] });
  }
  async probeRealm(realm, timeoutMs = 1000) {
    const observed = this.realms.get(realm);
    if (!observed?.uniqueId) return { realm, outcome: "unavailable", reason: "Old realm has no observed unique context identity" };
    const receipt = { event: "unique-context-read-probe", receivedAt: performance.now(), realm, uniqueId: observed.uniqueId, outcome: null, error: null, timeoutMs };
    let timer;
    try {
      await Promise.race([this.cdp.send("Runtime.evaluate", { expression: "1", uniqueContextId: observed.uniqueId, returnByValue: true, silent: true }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Unique-context observer probe deadline exceeded"), { code: "observer-probe-timeout" })), timeoutMs); })]);
      receipt.outcome = "still-executable";
    } catch (error) {
      receipt.error = error.message;
      receipt.outcome = error.code === "observer-probe-timeout" ? "probe-timeout"
        : /Protocol error \(Runtime\.evaluate\): (?:uniqueContextId not found|Cannot find context with specified (?:unique )?id)$/.test(error.message) ? "context-not-found" : "probe-failed";
    } finally { clearTimeout(timer); }
    this.events.push(receipt); return structuredClone(receipt);
  }
  async close() { if (this.targets) await this.targets.detach(); }
}
