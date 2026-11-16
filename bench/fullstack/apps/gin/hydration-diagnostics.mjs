import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const diagnosticLimits = Object.freeze({ events: 32, eventBytes: 12 * 1024,
  textBytes: 512, resources: 12, artifactBytes: 24 * 1024, snapshotMs: 1000, writeMs: 1000 });

export function hydrationArtifactPath(app, source, profile) {
  if (!['gin', 'drogon', 'topcoat', 'leptos'].includes(app)
    || !['fixture', 'api'].includes(source) || !['defaults', 'matched'].includes(profile)) throw new Error('Invalid diagnostic subject');
  // catalog.yml already uploads this directory on failure, including native alerts.
  return fileURLToPath(new URL(`../../../catalog/results/c1/compiled-alerts-${app}-${source}-${profile}-${process.pid}-hydration.json`, import.meta.url));
}

function clipped(text, bytes = diagnosticLimits.textBytes) {
  return Buffer.from(text).subarray(0, bytes).toString('utf8').replace(/\ufffd$/, '');
}

function safeText(value) {
  // Event text is untrusted. Keep panic locations/reasons, not embedded values,
  // origins, query strings, quoted payloads or likely credential material.
  const input = String(value ?? '').slice(0, 4096)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  if (/(?:\b[\w-]*(?:cookie|authorization|password|passwd|credential|secret|token|session|(?:api|access|private)[_-]?key|headers|origin)[\w-]*["']?\s*[:=]|process\.env|\b(?:Bearer|Basic)\s+\S+)/i.test(input)) return '[sensitive detail redacted]';
  const text = input
    .replace(/\b(?:[a-z][a-z\d+.-]*:\/\/|data:|blob:)[^\s<>"'`)]*/gi, '[url]')
    .replace(/\/\/[^\s<>"'`)]+/g, '[url]')
    .replace(/[?#&][^\s<>"'`)]*/g, '[query]')
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[credential]')
    .replace(/\b[A-Z\d._%+-]+@[A-Z\d.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g, '[quoted]')
    .replace(/[A-Za-z\d+/_=-]{24,}/g, '[opaque]');
  return clipped(text);
}

function safePath(value) {
  try {
    const url = new URL(String(value).slice(0, 2048));
    const path = url.pathname;
    if (!['http:', 'https:'].includes(url.protocol) || !/^\/[A-Za-z\d/_.-]*$/.test(path)
      || path.split('/').some(part => part.length > 80 || /(?:token|secret|password|session|cookie)/i.test(part))) return '[redacted-path]';
    return clipped(path.replace(/[A-Za-z\d_-]{24,}/g, '[opaque]'), 256);
  } catch { return '[redacted-path]'; }
}

function staticAsset(value) {
  try { return /\.(?:[cm]?js|wasm)$/i.test(new URL(String(value).slice(0, 2048)).pathname); } catch { return false; }
}
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12 ? value : null;
const status = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;

function safeState(raw) {
  if (!raw || typeof raw !== 'object') return { unavailable: true };
  return {
    readyState: ['loading', 'interactive', 'complete'].includes(raw.readyState) ? raw.readyState : 'unknown',
    hydratedType: ['undefined', 'number', 'string', 'object', 'boolean', 'function', 'symbol', 'bigint'].includes(raw.hydratedType) ? raw.hydratedType : 'unknown',
    hydratedAt: number(raw.hydratedAt), marketplace: raw.marketplace === true,
    scripts: (Array.isArray(raw.scripts) ? raw.scripts : []).slice(0, diagnosticLimits.resources).map(script => ({
      path: script.src ? safePath(script.src) : '[inline]', type: ['module', '', 'text/javascript', 'application/javascript'].includes(script.type) ? script.type : 'other',
    })),
    resources: (Array.isArray(raw.resources) ? raw.resources : []).slice(0, diagnosticLimits.resources).map(resource => ({
      path: safePath(resource.name), initiatorType: ['script', 'fetch', 'link', 'xmlhttprequest', 'other'].includes(resource.initiatorType) ? resource.initiatorType : 'other',
      duration: number(resource.duration), transferSize: number(resource.transferSize),
    })),
  };
}

async function bounded(operation, milliseconds, controller = new AbortController()) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Diagnostic budget expired')); }, milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function save(path, text, signal) {
  await mkdir(dirname(path), { recursive: true });
  signal.throwIfAborted();
  await writeFile(path, text, { encoding: 'utf8', flag: 'wx', mode: 0o600, signal });
}

// Attach before goto. The observer never requests a URL or reads response bodies,
// HTML, form values, headers, cookies or console argument objects.
export function observeHydration(page, { artifactPath, app, source, profile, container, write = save, log = summary => console.error(JSON.stringify(summary)) }) {
  let events = [], eventBytes = 2, dropped = 0, navigation = null, navigationIndex = 1;
  const listeners = [];
  const add = event => {
    const bytes = Buffer.byteLength(JSON.stringify(event)) + 1;
    if (events.length >= diagnosticLimits.events || eventBytes + bytes > diagnosticLimits.eventBytes) {
      dropped = Math.min(dropped + 1, 1e9); return;
    }
    events.push(event); eventBytes += bytes;
  };
  const listen = (name, callback) => {
    const handler = value => {
      if (name !== 'response' && events.length >= diagnosticLimits.events) { dropped = Math.min(dropped + 1, 1e9); return; }
      try { callback(value); } catch { dropped = Math.min(dropped + 1, 1e9); }
    };
    listeners.push([name, handler]); page.on(name, handler);
  };
  const dispose = () => { for (const [name, handler] of listeners) page.off(name, handler); page.off('close', dispose); };
  listen('console', message => add({ kind: 'console', level: ['error', 'warning', 'info', 'log', 'debug'].includes(message.type()) ? message.type() : 'other', text: safeText(message.text()) }));
  listen('pageerror', error => add({ kind: 'pageerror', text: safeText(error.stack ?? error.message) }));
  listen('requestfailed', request => add({ kind: 'requestfailed', path: safePath(request.url()), text: safeText(request.failure()?.errorText) }));
  listen('response', response => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
      navigation = { status: status(response.status()), path: safePath(response.url()) };
    }
    if (staticAsset(response.url())) add({ kind: 'response', path: safePath(response.url()), status: status(response.status()) });
  });
  page.once('close', dispose);

  async function capture(error) {
    let state;
    try {
      state = safeState(await bounded(() => page.evaluate(() => ({
        readyState: document.readyState, hydratedType: typeof window.__hydratedAt,
        hydratedAt: typeof window.__hydratedAt === 'number' ? window.__hydratedAt : null,
        marketplace: !!document.querySelector('.marketplace__alert form'),
        scripts: Array.from({ length: Math.min(document.scripts.length, 12) }, (_, i) => ({ src: document.scripts[i].src.slice(0, 2048), type: document.scripts[i].type.slice(0, 64) })),
        resources: performance.getEntriesByType('resource').slice(-32).filter(resource => /\.(?:[cm]?js|wasm)(?:[?#]|$)/i.test(resource.name))
          .slice(-12).map(resource => ({ name: resource.name.slice(0, 2048), initiatorType: resource.initiatorType, duration: resource.duration, transferSize: resource.transferSize })),
      })), diagnosticLimits.snapshotMs));
    } catch { state = { unavailable: true }; }
    const detail = { schema: 'compiled-alerts-hydration/v1',
      app: ['gin', 'drogon', 'topcoat', 'leptos'].includes(app) ? app : 'unknown',
      source: ['fixture', 'api'].includes(source) ? source : 'unknown',
      profile: ['defaults', 'matched'].includes(profile) ? profile : 'unknown',
      container: typeof container === 'string' && container.length <= 96
        && /^compiled-alerts-(?:gin|drogon|topcoat|leptos)-(?:fixture|api)-\d+$/.test(container) ? container : 'unknown',
      navigationIndex, navigation, error: safeText(error?.stack ?? error?.message ?? error), state, events, dropped };
    let text = JSON.stringify(detail, null, 2) + '\n';
    // Also cap the complete encoding, including JSON escaping and pretty printing.
    while (Buffer.byteLength(text) > diagnosticLimits.artifactBytes && events.length) {
      events.pop(); detail.dropped++; text = JSON.stringify(detail, null, 2) + '\n';
    }
    if (Buffer.byteLength(text) > diagnosticLimits.artifactBytes) { detail.state = { unavailable: true }; text = JSON.stringify(detail) + '\n'; }
    let saved = false;
    try { await bounded(signal => write(artifactPath, text, signal), diagnosticLimits.writeMs); saved = true; } catch { /* Original readiness error wins. */ }
    log({ diagnostic: 'compiled-alerts-hydration/v1', app: detail.app, source: detail.source, profile: detail.profile,
      navigationIndex, saved, events: events.length, dropped: detail.dropped, bytes: Buffer.byteLength(text) });
  }

  return {
    dispose,
    reset() { events = []; eventBytes = 2; dropped = 0; navigation = null; navigationIndex++; },
    async wait() {
      try {
        await page.waitForFunction(() => typeof window.__hydratedAt === 'number');
      } catch (error) {
        try { dispose(); } catch { /* Original readiness error wins even if the page is broken. */ }
        try { await capture(error); } catch { /* Diagnostics must never replace the gate's exception. */ }
        throw error;
      }
    },
  };
}
