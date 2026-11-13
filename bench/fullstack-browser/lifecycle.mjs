import { performance } from "node:perf_hooks";
import { intentionalDisabledPreload, isScriptPreload } from "../catalog/check.mjs";

function address(value) {
  try { const url = new URL(value); return { scheme: url.protocol, path: ["http:", "https:", "ws:", "wss:"].includes(url.protocol) ? url.pathname : null }; }
  catch { return { scheme: null, path: null }; }
}
const targetInfo = (t) => ({ target: t.targetId, context: t.browserContextId ?? null, type: t.type,
  opener: t.openerId ?? null, openerFrame: t.openerFrameId ?? null, ...address(t.url) });
const notFound = (message) => /Protocol error \(Runtime\.evaluate\): (?:uniqueContextId not found|Cannot find context with specified (?:unique )?id)$/.test(message ?? "");
const sameOrigin = (a, b) => { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } };
async function boundedSend(session, method, params, timeoutMs = 1000) {
  let timer;
  try { return await Promise.race([session.send(method, params), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${method} observation deadline exceeded`)), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}

// Read-only receipts, not a cleanup decision or a resource-count substitute.
export class PlatformLifecycle {
  constructor(cdp, targets = null, contextConfiguration = {}) {
    this.cdp = cdp; this.targets = targets; this.events = []; this.contexts = new Map(); this.frames = new Map(); this.realms = new Map();
    this.discovery = false; this.target = null; this.boundaries = {}; this.observationFailures = [];
    this.domains = new Set();
    this.contextConfiguration = structuredClone(contextConfiguration); this.documents = [];
    for (const [name, session] of [["page", cdp], ["targets", targets]]) session?.on("close", () => this.observationFailures.push({ phase: `${name}-session-closed`, at: performance.now() }));
    cdp.on("Inspector.detached", (e) => this.observationFailures.push({ phase: "inspector-detached", at: performance.now(), error: e.reason }));
    targets?.on("Target.targetCrashed", (e) => this.observationFailures.push({ phase: "target-crashed", at: performance.now(), target: e.targetId }));
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
      record("Network.requestWillBeSent", { request: e.requestId, frame: e.frameId ?? null, loader: e.loaderId, type: e.type, method: e.request.method, at: e.timestamp, ...address(e.request.url),
        document: address(e.documentURL), sameDocumentOrigin: sameOrigin(e.request.url, e.documentURL), initiator: { type: e.initiator?.type ?? null, ...address(e.initiator?.url), sameDocumentOrigin: sameOrigin(e.initiator?.url, e.documentURL), line: e.initiator?.lineNumber ?? null,
          request: e.initiator?.requestId ?? null }, redirectStatus: e.redirectResponse?.status ?? null });
    });
    cdp.on("Network.responseReceived", (e) => record("Network.responseReceived", { request: e.requestId, frame: e.frameId ?? null, loader: e.loaderId, type: e.type, status: e.response.status, at: e.timestamp,
      mime: e.response.mimeType ?? null, hasCsp: Object.keys(e.response.headers ?? {}).some((key) => key.toLowerCase() === "content-security-policy") }));
    cdp.on("Network.loadingFinished", (e) => record("Network.loadingFinished", { request: e.requestId, at: e.timestamp }));
    cdp.on("Network.loadingFailed", (e) => record("Network.loadingFailed", { request: e.requestId, at: e.timestamp, canceled: e.canceled === true, errorText: e.errorText, blockedReason: e.blockedReason ?? null }));
    for (const event of ["Target.targetCreated", "Target.targetInfoChanged"]) targets?.on(event, ({ targetInfo: t }) => record(event, targetInfo(t)));
    targets?.on("Target.targetDestroyed", (e) => record("Target.targetDestroyed", { target: e.targetId }));
  }
  async enable() {
    const { targetInfo: t } = await this.cdp.send("Target.getTargetInfo");
    this.target = { target: t.targetId, context: t.browserContextId ?? null, type: t.type };
    if (this.targets) { await this.targets.send("Target.setDiscoverTargets", { discover: true }); this.discovery = true; }
  }
  async inventory(phase) {
    const startedAt = performance.now();
    try {
      if (!this.discovery) throw new Error("Browser target discovery unavailable");
      const { targetInfos } = await boundedSend(this.targets, "Target.getTargets");
      this.events.push({ event: "Target.getTargets", phase, startedAt, receivedAt: performance.now(), targets: targetInfos.map(targetInfo),
        observedContexts: [...this.contexts.values()].filter((c) => c.live).map(({ context, uniqueId, frame, default: isDefault }) => ({ context, uniqueId, frame, default: isDefault })),
        contextInventoryBasis: "Runtime.enable enumeration and continuous created/destroyed/cleared events" });
    } catch (error) { this.observationFailures.push({ phase, at: performance.now(), error: error.message }); }
  }
  async enableDomains() {
    for (const domain of ["Runtime", "Page", "Network"]) {
      await boundedSend(this.cdp, `${domain}.enable`); this.domains.add(domain);
      this.events.push({ event: "domain-enabled", domain, receivedAt: performance.now() });
    }
  }
  async startObservation() {
    await this.inventory("initial"); this.boundaries.startedAt = performance.now();
  }
  markApplicationStart() { this.boundaries.applicationStartedAt = performance.now(); }
  recordDocument(dom, resources) {
    const binding = this.realms.get(resources?.realm);
    if (!binding || !dom?.observer || dom.scope !== resources.scope) return;
    this.documents.push({ observedAt: performance.now(), observer: dom.observer, realm: resources.realm, scope: resources.scope,
      frame: binding.frame, loader: binding.loader, path: dom.url.path, hasMetaCsp: dom.native?.hasMetaCsp ?? null,
      preloads: structuredClone(dom.native?.preloads ?? []), assets: structuredClone(dom.native?.assets ?? []) });
  }
  async finishObservation({ observationMs = 250, realms = [] } = {}) {
    this.boundaries.terminalStartedAt = performance.now();
    await new Promise((resolve) => setTimeout(resolve, observationMs));
    for (const realm of new Set(realms)) await this.probeRealm(realm);
    await this.inventory("terminal"); this.boundaries.endedAt = performance.now();
  }
  async bindRealm(realm) {
    if (this.realms.has(realm)) return;
    for (const context of this.contexts.values()) {
      if (!context.live || !context.default) continue;
      try {
        if (!context.uniqueId) throw new Error("Default context lacks native unique identity");
        const result = await this.cdp.send("Runtime.evaluate", { expression: "globalThis.__fullstackBrowserAudit?.checkpoint()?.realm ?? null", uniqueContextId: context.uniqueId, returnByValue: true, silent: true });
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
    return structuredClone({ schema: "native-browser-platform-lifetimes/v2", target: this.target, boundaries: this.boundaries, observationFailures: this.observationFailures,
      contextConfiguration: this.contextConfiguration, documents: this.documents,
      coverage: { runtime: this.domains.has("Runtime"), pageFrames: this.domains.has("Page"), pageNetwork: this.domains.has("Network"), browserTargetDiscovery: this.discovery,
        workerNetwork: false, serverSocketPeerClosure: false, sharedWorkerOwnership: false },
      realms: [...this.realms.values()], events: this.events,
      limits: ["Target destruction is not server-side socket closure", "Missing close/destroy receipts remain unknown, not zero",
        "Shared/service worker lifetime is not owned by a document without additional proof", "No retired DOM or successful event probe follows from realm destruction"] });
  }
  async probeRealm(realm, timeoutMs = 1000) {
    const observed = this.realms.get(realm);
    if (!observed?.uniqueId) return { realm, outcome: "unavailable", reason: "Old realm has no observed unique context identity" };
    const receipt = { event: "unique-context-read-probe", receivedAt: performance.now(), realm, uniqueId: observed.uniqueId, outcome: null, error: null, timeoutMs };
    this.events.push(receipt);
    let timer;
    try {
      await Promise.race([this.cdp.send("Runtime.evaluate", { expression: "1", uniqueContextId: observed.uniqueId, returnByValue: true, silent: true }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Unique-context observer probe deadline exceeded"), { code: "observer-probe-timeout" })), timeoutMs); })]);
      receipt.outcome = "still-executable";
    } catch (error) {
      receipt.error = error.message;
      receipt.outcome = error.code === "observer-probe-timeout" ? "probe-timeout" : notFound(error.message) ? "context-not-found" : "probe-failed";
    } finally { clearTimeout(timer); receipt.finishedAt = performance.now(); }
    return structuredClone(receipt);
  }
  async close() { if (this.targets) await this.targets.detach(); }
}

// This proof is deliberately separate from the shared DOM/event-probe oracle.
// Native loading failures are terminal receipts, NOT successful functional work.
export function validatePlatformRetirement(journal, { realm, retiredAt, observationMs = 250, maxProbeMs = 1000 } = {}) {
  const result = { schema: "native-platform-retirement-proof/v1", outcome: "unknown", reasons: [], binding: null,
    destruction: null, replacement: null, terminalProbe: null, requests: [], sockets: [], nativeFailures: [],
    scope: "One observed default document realm; no retired DOM/count/event probe, worker-network or server-peer cleanup proof" };
  const unknown = (message) => result.reasons.push(message);
  let failed = false;
  const finish = () => { result.outcome = failed ? "failed" : result.reasons.length ? "unknown" : "proved"; return structuredClone(result); };
  const finite = (value) => Number.isFinite(value) && value >= 0;
  if (journal?.schema !== "native-browser-platform-lifetimes/v2" || !Array.isArray(journal.events) || !Array.isArray(journal.realms)) {
    unknown("Complete v2 platform journal unavailable"); return finish();
  }
  if (journal.events.some((e) => !e || typeof e.event !== "string" || e.event === "Runtime.executionContextsCleared" && (!Array.isArray(e.contexts) || e.contexts.some((c) => !c)))
    || journal.realms.some((r) => !r || typeof r.realm !== "string")) {
    unknown("Malformed native event/realm records"); return finish();
  }
  const events = journal.events, b = journal.boundaries ?? {}, target = journal.target, coverage = journal.coverage;
  if (!realm || !finite(retiredAt) || !finite(observationMs) || observationMs <= 0 || !finite(maxProbeMs) || maxProbeMs <= 0) {
    unknown("Invalid consumer identity or observation/probe bounds"); return finish();
  }
  if (!target?.context || target.type !== "page" || !target.target || coverage?.runtime !== true || coverage.pageFrames !== true
    || coverage.pageNetwork !== true || coverage.browserTargetDiscovery !== true
    || !Array.isArray(journal.observationFailures) || journal.observationFailures.length) unknown("Incomplete native domain/discovery coverage");
  if (![b.startedAt, b.applicationStartedAt, b.terminalStartedAt, b.endedAt].every(finite)
    || !(b.startedAt <= b.applicationStartedAt && b.applicationStartedAt <= retiredAt && retiredAt <= b.terminalStartedAt
      && b.endedAt - b.terminalStartedAt >= observationMs)) unknown("Observation does not span application start through bounded terminal interval");
  if (events.some((e, index) => !finite(e.receivedAt) || index && e.receivedAt < events[index - 1].receivedAt)) unknown("Journal event order/timestamps unavailable");
  const inventories = events.filter((e) => e.event === "Target.getTargets"), initial = inventories.filter((e) => e.phase === "initial"), terminal = inventories.filter((e) => e.phase === "terminal");
  if (initial.length !== 1 || terminal.length !== 1 || !Array.isArray(initial[0]?.targets) || !Array.isArray(terminal[0]?.targets)
    || !Array.isArray(initial[0].observedContexts) || !Array.isArray(terminal[0].observedContexts)
    || [...initial[0].observedContexts, ...terminal[0].observedContexts].some((c) => !c || !Number.isInteger(c.context) || typeof c.uniqueId !== "string" || !c.uniqueId || !c.frame)
    || [...initial[0].targets, ...terminal[0].targets].some((t) => !t || typeof t.target !== "string" || typeof t.type !== "string")
    || !finite(initial[0].startedAt) || !finite(terminal[0].startedAt) || initial[0].startedAt > initial[0].receivedAt
    || terminal[0].startedAt > terminal[0].receivedAt || initial[0].receivedAt > b.startedAt
    || terminal[0].startedAt < b.terminalStartedAt || terminal[0].receivedAt > b.endedAt) {
    unknown("Complete initial/terminal target inventories unavailable"); return finish();
  }
  for (const domain of ["Runtime", "Page", "Network"]) if (!events.some((e) => e.event === "domain-enabled" && e.domain === domain && e.receivedAt <= initial[0].startedAt)) unknown(`Initial ${domain} enable receipt absent`);
  const contextKey = (c) => JSON.stringify([c.context, c.uniqueId, c.frame, c.default]);
  const contexts = new Map();
  for (const c of initial[0].observedContexts) {
    if (!c?.uniqueId || !Number.isInteger(c.context) || !c.frame) unknown("Initial execution-context identity incomplete");
    else { if (contexts.has(c.context)) unknown("Duplicate initial execution context"); contexts.set(c.context, c); }
  }
  for (const e of events.filter((e) => e.receivedAt > initial[0].receivedAt && e.receivedAt <= terminal[0].receivedAt)) {
    if (e.event === "Runtime.executionContextCreated") {
      if (!e.uniqueId || contexts.has(e.context)) unknown("Unmatched/reused live execution-context identity");
      contexts.set(e.context, e);
      if (e.frame !== target?.target) unknown("Child/unknown-frame execution context requires additional ownership coverage");
    }
    if (e.event === "Runtime.executionContextDestroyed") {
      const old = contexts.get(e.context);
      if (!old || e.uniqueId && e.uniqueId !== old.uniqueId) unknown("Unmatched execution-context destruction");
      contexts.delete(e.context);
    }
    if (e.event === "Runtime.executionContextsCleared") {
      const cleared = e.contexts?.map((c) => c.uniqueId).sort(), liveIds = [...contexts.values()].map((c) => c.uniqueId).sort();
      if (JSON.stringify(cleared) !== JSON.stringify(liveIds)) unknown("Context-clear receipt does not match previously live identities");
      contexts.clear();
    }
  }
  if (JSON.stringify([...contexts.values()].map(contextKey).sort()) !== JSON.stringify(terminal[0].observedContexts.map(contextKey).sort())) unknown("Continuous execution-context ledger differs from terminal inventory");
  const live = new Map(initial[0].targets.map((t) => [t.target, t]));
  if (live.size !== initial[0].targets.length || new Set(terminal[0].targets.map((t) => t.target)).size !== terminal[0].targets.length) unknown("Duplicate inventory target identities");
  const inspectTarget = (t) => {
    if (!t.context && t.type !== "browser") unknown(`Target ${t.target} has unknown browser-context ownership`);
    if (t.context === target?.context && (t.target !== target.target || t.type !== "page")) unknown(`Application-context target ${t.target} (${t.type}) lacks complete owned page coverage`);
    if (t.target === target?.target && t.context !== target.context) unknown("Owned target changed browser-context identity");
  };
  initial[0].targets.forEach(inspectTarget); terminal[0].targets.forEach(inspectTarget);
  if (!initial[0].targets.some((t) => t.target === target?.target && t.context === target.context)
    || !terminal[0].targets.some((t) => t.target === target?.target && t.context === target.context)) unknown("Owned page target absent from boundary inventory");
  for (const e of events.filter((e) => e.receivedAt > initial[0].receivedAt && e.receivedAt <= terminal[0].receivedAt)) {
    if (["Target.targetCreated", "Target.targetInfoChanged"].includes(e.event)) { inspectTarget(e); live.set(e.target, e); }
    if (e.event === "Target.targetDestroyed") { if (!live.has(e.target)) unknown("Unmatched target destruction"); live.delete(e.target); }
  }
  const expected = terminal[0].targets.filter((t) => t.context === target?.context).map((t) => t.target).sort();
  const actual = [...live.values()].filter((t) => t.context === target?.context).map((t) => t.target).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) unknown("Discovery events do not reconcile with terminal app-context inventory");
  const bindings = journal.realms.filter((r) => r.realm === realm);
  if (bindings.length !== 1) { unknown("Retired realm has no unique observed native binding"); return finish(); }
  const old = bindings[0]; result.binding = old;
  const created = events.filter((e) => e.event === "Runtime.executionContextCreated" && e.uniqueId === old.uniqueId && e.context === old.context && e.frame === old.frame && e.default === true);
  if (!old.uniqueId || !old.loader || old.frame !== target?.target || created.length !== 1 || created[0]?.receivedAt > old.observedAt || !finite(old.observedAt)
    || old.observedAt < b.applicationStartedAt || old.observedAt > retiredAt
    || !events.some((e) => e.event === "Page.frameNavigated" && e.frame === old.frame && e.loader === old.loader && e.receivedAt <= old.observedAt)) unknown("Default-context/frame/loader/realm association incomplete");
  const destruction = events.find((e) => e.receivedAt >= retiredAt && (e.event === "Runtime.executionContextDestroyed" && e.context === old.context && e.uniqueId === old.uniqueId
    || e.event === "Runtime.executionContextsCleared" && e.contexts?.some((c) => c.context === old.context && c.uniqueId === old.uniqueId)));
  if (!destruction) unknown("Matched old unique-context destruction/clear receipt absent");
  else {
    result.destruction = destruction;
    const commit = events.find((e) => e.event === "Page.frameNavigated" && e.frame === old.frame && e.loader !== old.loader && e.receivedAt >= destruction.receivedAt && e.receivedAt <= b.terminalStartedAt);
    const next = journal.realms.find((r) => r.realm !== realm && r.frame === old.frame && r.loader === commit?.loader && r.uniqueId !== old.uniqueId && r.observedAt >= commit?.receivedAt && r.observedAt <= b.terminalStartedAt);
    if (!commit || commit.navigationType !== "Navigation" || !next || !events.some((e) => e.event === "Runtime.executionContextCreated"
      && e.uniqueId === next.uniqueId && e.context === next.context && e.frame === next.frame && e.default === true)) unknown("Committed replacement default context with a distinct loader/realm absent");
    else result.replacement = { commit, binding: next };
    if (events.some((e) => e.event === "Page.frameDetached" && e.frame === old.frame && e.receivedAt >= retiredAt && e.receivedAt <= b.endedAt)) unknown("Frame detach/swap requires additional coverage");
  }
  const probes = events.filter((e) => e.event === "unique-context-read-probe" && e.realm === realm && e.uniqueId === old.uniqueId && e.receivedAt >= b.terminalStartedAt && e.finishedAt <= b.endedAt);
  const probe = probes.at(-1); result.terminalProbe = probe ?? null;
  if (!probe || probe.outcome !== "context-not-found" || !notFound(probe.error) || !finite(probe.timeoutMs) || probe.timeoutMs > maxProbeMs
    || !finite(probe.finishedAt) || probe.finishedAt < probe.receivedAt || probe.finishedAt - probe.receivedAt > probe.timeoutMs) unknown("Bounded terminal unique-context-not-found receipt absent");
  if (probe?.outcome === "still-executable") { failed = true; unknown("Retired realm still executes at terminal probe"); }
  const requests = new Map(), sockets = new Map();
  for (const e of events.filter((e) => e.receivedAt >= b.startedAt && e.receivedAt <= b.endedAt)) {
    if (e.event === "Network.requestWillBeSent") {
      if (!e.frame || !e.loader) unknown(`Request ${e.request} has unknown document ownership`);
      const prior = requests.get(e.request);
      if (prior && (!e.redirectStatus || prior.terminal)) unknown("Reused request ID lacks native redirect binding");
      const row = { dispatch: e, response: null, terminal: null }; requests.set(e.request, row); result.requests.push(row);
      if (prior && e.redirectStatus) prior.terminal = { event: "native-redirect", status: e.redirectStatus, receivedAt: e.receivedAt };
      if (destruction && e.frame === old.frame && e.loader === old.loader && e.receivedAt > destruction.receivedAt) { failed = true; unknown("Old-loader request dispatched after realm destruction"); }
    }
    if (["Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"].includes(e.event)) {
      const row = requests.get(e.request);
      if (!row) unknown(`Unmatched page network receipt ${e.request}`);
      else if (e.event === "Network.responseReceived") {
        row.response = e;
        if (e.frame !== row.dispatch.frame || e.loader !== row.dispatch.loader || !Number.isInteger(e.status)) unknown("Response document identity/status differs from native dispatch");
      }
      else { if (row.terminal) unknown("Duplicate native request terminal receipt"); row.terminal = e; if (e.event === "Network.loadingFailed") result.nativeFailures.push(e); }
    }
    if (e.event === "Network.webSocketCreated") { const row = { created: e, handshake: null, closed: null }; sockets.set(e.request, row); result.sockets.push(row); }
    if (["Network.webSocketHandshakeResponseReceived", "Network.webSocketClosed"].includes(e.event)) {
      const row = sockets.get(e.request); if (!row) unknown("Unmatched WebSocket receipt");
      else if (e.event === "Network.webSocketClosed") row.closed = e; else row.handshake = e;
    }
  }
  for (const row of result.requests) if (!row.terminal || row.terminal.event === "Network.loadingFinished" && !row.response) unknown(`Request ${row.dispatch.request} lacks terminal/response evidence`);
  // CDP socket creation lacks a reliable initiator execution-context ID. An open
  // socket on this page is unknown ownership, not an exemption or a forced close.
  for (const row of result.sockets) if (!row.closed) unknown(`Page socket ${row.created.request} has no native close receipt`);
  return finish();
}

// Classification receipts only. Nothing is removed, including intentionally
// disabled preloads; this function cannot authorize a shared-oracle exception.
export function classifyNoJSRequests(journal) {
  const result = { schema: "native-no-js-request-proof/v1", outcome: "unknown", reasons: [], requests: [],
    scope: "Parser provenance classification, not functional qualification or a failed-request waiver" };
  if (journal?.schema !== "native-browser-platform-lifetimes/v2" || journal.contextConfiguration?.javaScriptEnabled !== false
    || journal.coverage?.pageNetwork !== true || !Array.isArray(journal.events) || !journal.events.length || !Array.isArray(journal.documents)
    || journal.events.some((e) => !e || typeof e.event !== "string") || journal.documents.some((d) => !d || !Array.isArray(d.assets) || !Array.isArray(d.preloads))) {
    result.reasons.push("Script-disabled context configuration and native page/parser journal required"); return result;
  }
  if (!Array.isArray(journal.observationFailures) || journal.observationFailures.length) result.reasons.push("Native observer coverage interrupted");
  const latest = new Map();
  for (const event of journal.events) {
    if (event.event === "Network.requestWillBeSent") {
      if (typeof event.type !== "string") { result.reasons.push("Request resource type unavailable"); continue; }
      const previous = latest.get(event.request);
      if (previous && event.redirectStatus) previous.terminal = { event: "native-redirect", status: event.redirectStatus };
      const row = { dispatch: event, response: null, terminal: null, classification: "unknown", proof: null };
      result.requests.push(row); latest.set(event.request, row);
    }
    if (["Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"].includes(event.event)) {
      const row = latest.get(event.request);
      if (!row) result.reasons.push(`Unmatched network receipt ${event.request}`);
      else if (event.event === "Network.responseReceived") row.response = event; else row.terminal = event;
    }
  }
  for (const row of result.requests) {
    const r = row.dispatch;
    if (!row.terminal) { result.reasons.push(`Unfinished request ${r.request}`); continue; }
    if (r.type === "Document") {
      if (!r.frame || !r.loader) result.reasons.push(`Document ${r.request} lacks native frame/loader ownership`);
      else if (row.terminal.event === "Network.loadingFailed") row.classification = "failed-document";
      else if (row.terminal.event === "native-redirect" && row.terminal.status >= 300 && row.terminal.status < 400
        || row.response?.frame === r.frame && row.response?.loader === r.loader && Number.isInteger(row.response?.status)
          && row.response.status >= 100 && row.response.status <= 599) row.classification = "document";
      else result.reasons.push(`Document ${r.request} lacks a matched native response/status receipt`);
      continue;
    }
    const documentRequest = result.requests.find((d) => d.dispatch.type === "Document" && d.dispatch.frame === r.frame && d.dispatch.loader === r.loader);
    const observed = journal.documents.find((d) => d.observer && d.scope && d.frame === r.frame && d.loader === r.loader
      && d.path === r.document?.path && d.observedAt >= r.receivedAt);
    if (documentRequest?.classification !== "document" || !documentRequest.response || !observed || r.sameDocumentOrigin !== true || !r.frame || !r.loader) {
      result.reasons.push(`Request ${r.request} lacks matching native document/parser ownership`); continue;
    }
    const directParser = r.initiator?.type === "parser" && r.initiator.sameDocumentOrigin === true && r.initiator.path === observed.path;
    const declaration = observed.assets.find((a) => a.type === r.type && a.path === r.path && a.sameOrigin === true);
    const preload = observed.preloads.find((p) => p.path === r.path && p.sameOrigin === true && isScriptPreload(p));
    const disabled = intentionalDisabledPreload({ javaScriptEnabled: false, resourceType: r.type.toLowerCase(),
      errorText: row.terminal.event === "Network.loadingFailed" && row.terminal.blockedReason === "csp" ? "csp" : row.terminal.errorText,
      scriptPreload: Boolean(preload), hasCsp: documentRequest.response.hasCsp !== false || observed.hasMetaCsp !== false });
    row.proof = { documentRequest: documentRequest.dispatch.request, observer: observed.observer, scope: observed.scope,
      frame: r.frame, loader: r.loader, initiator: r.initiator, declaration: declaration ?? null, preload: preload ?? null,
      hasHeaderCsp: documentRequest.response.hasCsp, hasMetaCsp: observed.hasMetaCsp };
    // Chromium can report a script/about:blank initiator for a disabled parser
    // preload. Preserve that native fact; the existing strict exception instead
    // requires the disabled context, exact DOM declaration and absent real CSP.
    if (disabled) { row.classification = "intentionally-disabled-preload"; continue; }
    if (row.terminal.event === "Network.loadingFailed") { row.classification = "failed-request"; continue; }
    if (["Fetch", "XHR", "Script", "EventSource", "WebSocket"].includes(r.type)) { row.classification = "application-transport"; continue; }
    const stylesheet = result.requests.find((s) => s.dispatch.type === "Stylesheet" && s.dispatch.frame === r.frame && s.dispatch.loader === r.loader
      && s.dispatch.path === r.initiator?.path && s.response?.mime === "text/css" && s.terminal?.event === "Network.loadingFinished"
      && observed.assets.some((a) => a.type === "Stylesheet" && a.path === s.dispatch.path && a.sameOrigin === true));
    if (r.method === "GET" && (directParser && declaration || r.initiator?.type === "parser" && r.initiator.sameDocumentOrigin === true && stylesheet && ["Image", "Font", "Stylesheet"].includes(r.type))) {
      row.classification = "parser-asset"; row.proof.stylesheetRequest = stylesheet?.dispatch.request ?? null;
    } else result.reasons.push(`Request ${r.request} has no independently observed parser asset provenance`);
  }
  result.outcome = result.reasons.length || result.requests.some((r) => ["unknown", "failed-document", "failed-request", "application-transport"].includes(r.classification)) ? "unknown" : "classified";
  return structuredClone(result);
}
