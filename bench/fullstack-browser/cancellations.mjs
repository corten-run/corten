import { publicURL } from './contract.mjs';

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
  constructor(cdp, identity) {
    this.identity = identity; this.requests = []; this.latest = new Map(); this.frames = [];
    cdp.on('Network.requestWillBeSent', (e) => {
      const row = { id: e.requestId, frame: e.frameId ?? null, loader: e.loaderId ?? null, at: e.timestamp,
        wall: e.wallTime * 1000, url: e.request.url, ...publicURL(e.request.url), method: e.request.method, kind: e.type,
        status: null, failed: null };
      this.requests.push(row); this.latest.set(e.requestId, row);
    });
    cdp.on('Network.responseReceived', (e) => { const row = this.latest.get(e.requestId); if (row) row.status = e.response.status; });
    cdp.on('Network.loadingFailed', (e) => { const row = this.latest.get(e.requestId); if (row) row.failed = {
      at: e.timestamp, canceled: e.canceled === true, errorText: e.errorText, blockedReason: e.blockedReason ?? null }; });
    cdp.on('Page.frameNavigated', (e) => this.frames.push({ frame: e.frame.id, loader: e.frame.loaderId, ...publicURL(e.frame.url) }));
  }
  annotate(rows) {
    const documents = this.requests.filter((r) => r.kind === 'Document');
    for (const row of rows) {
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
