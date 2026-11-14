import { publicURL, sha256 } from './contract.mjs';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

export function nativeOriginId(namespace, dispatch, hop) {
  return `cdp:${sha256(JSON.stringify([namespace.observerSession, namespace.targetId, dispatch.request, hop, dispatch.at, dispatch.frame, dispatch.loader]))}`;
}

export function responseDateHash(headers) {
  const values = Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() === 'date');
  return values.length === 1 && typeof values[0][1] === 'string' ? sha256(values[0][1]) : null;
}

export function classifyCancellation(request, documents, frames) {
  const failure = request.failed;
  if (!failure) return null;
  const receipt = { source: 'CDP Network.loadingFailed', canceled: failure.canceled, errorText: failure.errorText,
    at: failure.at, frame: request.frame, loader: request.loader, classification: 'network-failure', replacement: null };
  if (!failure.canceled) return receipt;
  receipt.classification = request.method === 'GET' && request.kind !== 'Document' ? 'native-request-cancellation' : 'critical-request-cancellation';
  if (request.method !== 'GET' || request.kind === 'Document' || !request.frame || !request.loader) return receipt;
  const replacements = documents.filter((next) => next.frame === request.frame && next.loader && next.loader !== request.loader
    && next.at >= request.at && next.at <= failure.at && next.status >= 200 && next.status <= 599
    && frames.some((frame) => frame.frame === next.frame && frame.loader === next.loader));
  if (replacements.length !== 1) return receipt;
  const next = replacements[0];
  receipt.classification = 'native-document-replacement-cancellation';
  receipt.replacement = { frame: next.frame, loader: next.loader, path: next.path, status: next.status, at: next.at };
  return receipt;
}

export class NativeNetworkAudit {
  constructor(cdp, identity, retainBody = () => {}, namespace = { observerSession: randomUUID(), targetId: null }) {
    this.identity = identity; this.requests = []; this.latest = new Map(); this.frames = [];
    this.cdp = cdp; this.retainBody = retainBody; this.namespace = { ...namespace };
    this.pending = new Set(); this.observations = new Set(); this.queue = []; this.parserBody = null; this.closed = false;
    retainBody({ event: 'native-network-observer', namespaceKind: 'observer-assigned', ...this.namespace, receivedAt: performance.now() });
    cdp.once('close', () => {
      this.closed = true;
      for (const entry of [...this.pending, ...this.queue]) this.finish(entry);
      this.pending.clear(); this.parserBody = null;
    });
    cdp.on('Network.requestWillBeSent', (e) => {
      const row = { id: e.requestId, frame: e.frameId ?? null, loader: e.loaderId ?? null, at: e.timestamp,
        hop: (this.latest.get(e.requestId)?.hop ?? -1) + 1,
        wall: e.wallTime * 1000, url: e.request.url, ...publicURL(e.request.url), method: e.request.method, kind: e.type,
        status: null, failed: null };
      this.requests.push(row); this.latest.set(e.requestId, row);
    });
    cdp.on('Network.responseReceived', (e) => { const row = this.latest.get(e.requestId); if (row) {
      row.status = e.response.status; row.dateSha256 = responseDateHash(e.response.headers);
    } });
    cdp.on('Network.loadingFinished', (e) => {
      const row = this.latest.get(e.requestId);
      if (this.closed || !row || row.failed || !/^https?:/.test(row.url) || row.status >= 300 && row.status < 400 || this.queue.length >= 1024) return;
      const entry = { row, queuedAt: performance.now(), done: false };
      row.body = null;
      entry.observed = new Promise((resolve) => { entry.resolve = resolve; });
      this.observations.add(entry.observed);
      entry.timer = setTimeout(() => this.finish(entry), 1000);
      this.queue.push(entry); this.pump();
    });
    cdp.on('Network.loadingFailed', (e) => { const row = this.latest.get(e.requestId); if (row) row.failed = {
      at: e.timestamp, canceled: e.canceled === true, errorText: e.errorText, blockedReason: e.blockedReason ?? null }; });
    cdp.on('Page.frameNavigated', (e) => this.frames.push({ frame: e.frame.id, loader: e.frame.loaderId, ...publicURL(e.frame.url) }));
  }
  finish(entry) {
    if (entry.done) return;
    entry.done = true; clearTimeout(entry.timer);
    const index = this.queue.indexOf(entry);
    if (index !== -1) this.queue.splice(index, 1);
    this.observations.delete(entry.observed); entry.resolve();
  }
  pump() {
    while (!this.closed && this.pending.size < 4 && this.queue.length) {
      const entry = this.queue.shift(), { row, queuedAt } = entry, startedAt = performance.now();
      if (startedAt - queuedAt >= 1000) { this.finish(entry); continue; }
      // Observation expiry is not protocol cancellation. Keep the actual send
      // counted until it settles (including rejection when its session closes).
      this.pending.add(entry);
      let sent;
      try { sent = this.cdp.send('Network.getResponseBody', { requestId: row.id }); }
      catch { this.pending.delete(entry); this.finish(entry); continue; }
      Promise.resolve(sent).then((result) => {
        if (entry.done || performance.now() - queuedAt >= 1000) return;
        if (typeof result.body !== 'string' || result.body.length > 16 * 1024 ** 2 || typeof result.base64Encoded !== 'boolean') return;
        const bytes = Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8');
        if (bytes.length > 16 * 1024 ** 2 || performance.now() - queuedAt >= 1000) return;
        const originId = nativeOriginId(this.namespace, { request: row.id, ...row }, row.hop);
        row.body = { event: row.kind === 'Document' ? 'native-document-body' : 'native-response-body', ...this.namespace, originId, hop: row.hop,
          request: row.id, dispatchAt: row.at, frame: row.frame, loader: row.loader, urlSha256: sha256(row.url), method: row.method,
          status: row.status, dateSha256: row.dateSha256 ?? null, bodySha256: sha256(bytes), bytes: bytes.length, queuedAt, startedAt, receivedAt: performance.now() };
        if (row.kind === 'Document') this.parserBody = { originId, bytes };
        this.retainBody({ ...row.body });
      }).catch(() => { row.body = null; }).finally(() => { this.finish(entry); this.pending.delete(entry); this.pump(); });
    }
  }
  async drain() { while (this.observations.size) { this.pump(); await Promise.allSettled([...this.observations]); } }
  originatingDocument(binding) {
    const matches = this.requests.filter((r) => binding && r.kind === 'Document' && r.frame === binding.frame && r.loader === binding.loader
      && r.body && !r.failed && !(r.status >= 300 && r.status < 400));
    return matches.length === 1 ? { requestId: matches[0].body.originId, sha256: matches[0].body.bodySha256 } : null;
  }
  takeDocumentResponse(origin) {
    const rows = this.requests.filter((r) => r.kind === 'Document' && r.body?.originId === origin?.requestId && r.body.bodySha256 === origin.sha256);
    const saved = this.parserBody;
    if (rows.length !== 1 || saved?.originId !== origin.requestId) return null;
    this.parserBody = null;
    return { ...origin, body: saved.bytes, status: rows[0].status, url: rows[0].url };
  }
  annotate(rows) {
    const documents = this.requests.filter((r) => r.kind === 'Document');
    for (const row of rows) {
      if (row.resource === 'document') {
        const identity = this.identity(row.id);
        if (identity) {
          row.documentIdentity = { urlSha256: sha256(identity.url), startedAt: identity.startTime, dateSha256: row.dateSha256 ?? null };
        }
      }
      if (!row.failure) continue;
      const identity = this.identity(row.id); if (!identity) continue;
      const sameURL = this.requests.filter((r) => r.url === identity.url && r.method === row.method);
      const browserMatches = rows.filter((other) => other.method === row.method && this.identity(other.id)?.url === identity.url);
      // Interception can shift Playwright's network start from CDP's dispatch.
      // Mutual uniqueness is exact identity evidence; repeated URLs still need
      // an unambiguous timestamp match. Neither path excuses a failed request.
      const matches = sameURL.length === 1 && browserMatches.length === 1 ? sameURL
        : sameURL.filter((r) => Math.abs(r.wall - identity.startTime) <= 1);
      if (matches.length !== 1) { row.cancellation = { classification: 'unmatched-native-failure', matches: matches.length,
        candidates: this.requests.filter((r) => r.path === row.path && r.method === row.method).slice(-4).map((r) => ({
          startDeltaMs: r.wall - identity.startTime, frame: r.frame, loader: r.loader, kind: r.kind, canceled: r.failed?.canceled ?? null })) }; continue; }
      row.cancellation = classifyCancellation(matches[0], documents, this.frames);
    }
  }
}
