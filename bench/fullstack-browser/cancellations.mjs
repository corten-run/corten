import { publicURL, sha256 } from './contract.mjs';
import { performance } from 'node:perf_hooks';

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
  constructor(cdp, identity, retainBody = () => {}) {
    this.identity = identity; this.requests = []; this.latest = new Map(); this.frames = [];
    this.pending = new Set();
    cdp.on('Network.requestWillBeSent', (e) => {
      const row = { id: e.requestId, frame: e.frameId ?? null, loader: e.loaderId ?? null, at: e.timestamp,
        wall: e.wallTime * 1000, url: e.request.url, ...publicURL(e.request.url), method: e.request.method, kind: e.type,
        status: null, failed: null };
      this.requests.push(row); this.latest.set(e.requestId, row);
    });
    cdp.on('Network.responseReceived', (e) => { const row = this.latest.get(e.requestId); if (row) {
      row.status = e.response.status; row.dateSha256 = responseDateHash(e.response.headers);
    } });
    cdp.on('Network.loadingFinished', (e) => {
      const row = this.latest.get(e.requestId);
      if (!row || row.kind !== 'Document' || row.failed || row.status >= 300 && row.status < 400) return;
      const startedAt = performance.now(); let timer;
      const pending = Promise.race([cdp.send('Network.getResponseBody', { requestId: row.id }), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native document body observation unavailable')), 1000);
      })]).then((result) => {
        if (typeof result.body !== 'string' || result.body.length > 16 * 1024 ** 2 || typeof result.base64Encoded !== 'boolean') return;
        const bytes = Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8');
        row.body = { event: 'native-document-body', request: row.id, dispatchAt: row.at, frame: row.frame, loader: row.loader,
          urlSha256: sha256(row.url), method: row.method, status: row.status, dateSha256: row.dateSha256,
          bodySha256: sha256(bytes), bytes: bytes.length, startedAt, receivedAt: performance.now() };
        retainBody({ ...row.body });
      }).catch(() => { row.body = null; }).finally(() => { clearTimeout(timer); this.pending.delete(pending); });
      this.pending.add(pending);
    });
    cdp.on('Network.loadingFailed', (e) => { const row = this.latest.get(e.requestId); if (row) row.failed = {
      at: e.timestamp, canceled: e.canceled === true, errorText: e.errorText, blockedReason: e.blockedReason ?? null }; });
    cdp.on('Page.frameNavigated', (e) => this.frames.push({ frame: e.frame.id, loader: e.frame.loaderId, ...publicURL(e.frame.url) }));
  }
  async drain() { while (this.pending.size) await Promise.allSettled([...this.pending]); }
  annotate(rows) {
    const documents = this.requests.filter((r) => r.kind === 'Document');
    for (const row of rows) {
      if (row.resource === 'document') {
        const identity = this.identity(row.id);
        if (identity) {
          row.documentIdentity = { urlSha256: sha256(identity.url), startedAt: identity.startTime, dateSha256: row.dateSha256 ?? null };
          const sameResponse = (native, browser) => native.url === this.identity(browser.id)?.url && native.method === browser.method
            && native.status === browser.status && native.body?.bodySha256 === browser.bodySha256 && native.body?.bytes === browser.bytes?.decodedBody
            && typeof native.dateSha256 === 'string' && native.dateSha256 === browser.dateSha256;
          const matches = documents.filter((r) => sameResponse(r, row));
          const browserMatches = matches.length === 1 ? rows.filter((other) => other.resource === 'document' && sameResponse(matches[0], other)) : [];
          row.nativeDocument = matches.length === 1 && browserMatches.length === 1 ? { request: matches[0].id, frame: matches[0].frame, loader: matches[0].loader,
            at: matches[0].at, wall: matches[0].wall, urlSha256: sha256(matches[0].url) } : null;
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
