import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const diagnosticLimits = Object.freeze({ events: 32, eventBytes: 12 * 1024,
  resources: 12, artifactBytes: 24 * 1024, snapshotMs: 1000, writeMs: 1000 });

export function hydrationArtifactPath(app, source, profile) {
  if (!['gin', 'drogon', 'topcoat', 'leptos'].includes(app)
    || !['fixture', 'api'].includes(source) || !['defaults', 'matched'].includes(profile)) throw new Error('Invalid diagnostic subject');
  // catalog.yml already uploads this directory on failure, including native alerts.
  return fileURLToPath(new URL(`../../../catalog/results/c1/compiled-alerts-${app}-${source}-${profile}-${process.pid}-hydration.json`, import.meta.url));
}

function resourceKind(value) {
  if (typeof value !== 'string' || value.length > 2048) return 'other';
  try {
    const path = new URL(value).pathname;
    return /\.wasm$/i.test(path) ? 'wasm' : /\.[cm]?js$/i.test(path) ? 'js' : 'other';
  } catch { return 'other'; }
}
const kind = value => ['js', 'wasm'].includes(value) ? value : 'other';
const category = (value, choices, fallback = 'other') => choices.find(choice => choice === value) ?? fallback;
const errorClass = error => category(error?.name, ['Error', 'TimeoutError', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError',
  'URIError', 'EvalError', 'AggregateError', 'CompileError', 'LinkError', 'RuntimeError'], 'unknown');
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12 ? value : null;
const count = value => Number.isInteger(value) && value >= 0 && value <= 1e6 ? value : null;
const status = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;

function safeState(raw) {
  if (!raw || typeof raw !== 'object') return { unavailable: true };
  return {
    readyState: category(raw.readyState, ['loading', 'interactive', 'complete'], 'unknown'),
    hydratedType: category(raw.hydratedType, ['undefined', 'number', 'string', 'object', 'boolean', 'function', 'symbol', 'bigint'], 'unknown'),
    hydratedAt: number(raw.hydratedAt), marketplace: raw.marketplace === true,
    scriptCount: count(raw.scriptCount), resourceCount: count(raw.resourceCount),
    scripts: (Array.isArray(raw.scripts) ? raw.scripts : []).slice(0, diagnosticLimits.resources).map(script => ({
      resourceKind: kind(script.resourceKind), type: category(script.type, ['module', 'classic']), external: script.external === true,
    })),
    resources: (Array.isArray(raw.resources) ? raw.resources : []).slice(0, diagnosticLimits.resources).map(resource => ({
      resourceKind: kind(resource.resourceKind), initiatorType: category(resource.initiatorType, ['script', 'fetch', 'link', 'xmlhttprequest']),
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

// Attach before goto. Retain closed structural fields only, never program text,
// URL paths, HTML, form values, headers, cookies, environment or response bodies.
export function observeHydration(page, { artifactPath, app, source, profile, container, write = save, log = summary => console.error(JSON.stringify(summary)) }) {
  let events = [], eventBytes = 2, dropped = 0, sequence = 0, navigation = null, navigationIndex = 1;
  const listeners = [];
  const add = event => {
    const record = { sequence: sequence = Math.min(sequence + 1, 1e9), ...event };
    const bytes = Buffer.byteLength(JSON.stringify(record)) + 1;
    if (events.length >= diagnosticLimits.events || eventBytes + bytes > diagnosticLimits.eventBytes) {
      dropped = Math.min(dropped + 1, 1e9); return;
    }
    events.push(record); eventBytes += bytes;
  };
  const listen = (name, callback) => {
    const handler = value => {
      if (name !== 'response' && events.length >= diagnosticLimits.events) {
        sequence = Math.min(sequence + 1, 1e9); dropped = Math.min(dropped + 1, 1e9); return;
      }
      try { callback(value); } catch { dropped = Math.min(dropped + 1, 1e9); }
    };
    listeners.push([name, handler]); page.on(name, handler);
  };
  const dispose = () => { for (const [name, handler] of listeners) page.off(name, handler); page.off('close', dispose); };
  listen('console', message => {
    const level = message.type();
    add({ kind: 'console', level: ['error', 'warning', 'info', 'log', 'debug'].includes(level) ? level : 'other' });
  });
  listen('pageerror', error => add({ kind: 'pageerror', errorClass: errorClass(error) }));
  listen('requestfailed', request => add({ kind: 'requestfailed', resourceKind: resourceKind(request.url()) }));
  listen('response', response => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
      navigation = { status: status(response.status()) };
    }
    const resource = resourceKind(response.url());
    if (resource !== 'other') add({ kind: 'response', resourceKind: resource, status: status(response.status()) });
  });
  page.once('close', dispose);

  async function capture(error) {
    let state;
    try {
      state = safeState(await bounded(() => page.evaluate(() => {
        const resourceKind = value => {
          if (typeof value !== 'string' || value.length > 2048) return 'other';
          try {
            const path = new URL(value).pathname;
            return /\.wasm$/i.test(path) ? 'wasm' : /\.[cm]?js$/i.test(path) ? 'js' : 'other';
          } catch { return 'other'; }
        };
        const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12 ? value : null;
        const count = value => Number.isInteger(value) && value >= 0 && value <= 1e6 ? value : null;
        const resources = performance.getEntriesByType('resource');
        const readyState = document.readyState;
        const mark = window.__hydratedAt;
        return {
          readyState: ['loading', 'interactive', 'complete'].includes(readyState) ? readyState : 'unknown', hydratedType: typeof mark,
          hydratedAt: number(mark), marketplace: !!document.querySelector('.marketplace__alert form'),
          scriptCount: count(document.scripts.length), resourceCount: count(resources.length),
          scripts: Array.from({ length: Math.min(document.scripts.length, 12) }, (_, i) => {
            const script = document.scripts[i];
            return { resourceKind: resourceKind(script.src), external: !!script.src,
              type: script.type === 'module' ? 'module' : ['', 'text/javascript', 'application/javascript'].includes(script.type) ? 'classic' : 'other' };
          }),
          resources: resources.slice(-12).map(resource => {
            const initiatorType = resource.initiatorType;
            return { resourceKind: resourceKind(resource.name),
              initiatorType: ['script', 'fetch', 'link', 'xmlhttprequest'].includes(initiatorType) ? initiatorType : 'other',
              duration: number(resource.duration), transferSize: number(resource.transferSize) };
          }),
        };
      }), diagnosticLimits.snapshotMs));
    } catch { state = { unavailable: true }; }
    const detail = { schema: 'compiled-alerts-hydration/v2',
      app: ['gin', 'drogon', 'topcoat', 'leptos'].includes(app) ? app : 'unknown',
      source: ['fixture', 'api'].includes(source) ? source : 'unknown',
      profile: ['defaults', 'matched'].includes(profile) ? profile : 'unknown',
      container: typeof container === 'string' && container.length <= 96
        && /^compiled-alerts-(?:gin|drogon|topcoat|leptos)-(?:fixture|api)-\d+$/.test(container) ? container : 'unknown',
      navigationIndex, navigation, errorClass: errorClass(error), state, events, dropped };
    let text = JSON.stringify(detail, null, 2) + '\n';
    // Also cap the complete encoding, including JSON escaping and pretty printing.
    while (Buffer.byteLength(text) > diagnosticLimits.artifactBytes && events.length) {
      events.pop(); detail.dropped++; text = JSON.stringify(detail, null, 2) + '\n';
    }
    if (Buffer.byteLength(text) > diagnosticLimits.artifactBytes) { detail.state = { unavailable: true }; text = JSON.stringify(detail) + '\n'; }
    let saved = false;
    try { await bounded(signal => write(artifactPath, text, signal), diagnosticLimits.writeMs); saved = true; } catch { /* Original readiness error wins. */ }
    log({ diagnostic: 'compiled-alerts-hydration/v2', app: detail.app, source: detail.source, profile: detail.profile,
      navigationIndex, saved, events: events.length, dropped: detail.dropped, bytes: Buffer.byteLength(text) });
  }

  return {
    dispose,
    reset() { events = []; eventBytes = 2; dropped = 0; sequence = 0; navigation = null; navigationIndex++; },
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
