import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

export const diagnosticLimits = Object.freeze({ events: 32, eventBytes: 12 * 1024,
  resources: 12, artifactBytes: 24 * 1024, snapshotMs: 1000, writeMs: 1000,
  containers: 16, dockerEvents: 32, dockerEventsMs: 2000, dockerEventsBytes: 256 * 1024, dockerWindowMs: 60_000 });

// Chromium network error names a navigation or subresource can end with. A request's
// errorText or a goto error is reduced to one of these, or 'other'; the text itself is
// never kept, since a goto message carries the URL.
export const failureCodes = Object.freeze(['ERR_ABORTED', 'ERR_FAILED', 'ERR_NETWORK_CHANGED', 'ERR_NETWORK_IO_SUSPENDED',
  'ERR_INTERNET_DISCONNECTED', 'ERR_ADDRESS_UNREACHABLE', 'ERR_ADDRESS_INVALID', 'ERR_NAME_NOT_RESOLVED', 'ERR_UNSAFE_PORT',
  'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_ABORTED', 'ERR_CONNECTION_FAILED',
  'ERR_CONNECTION_TIMED_OUT', 'ERR_TIMED_OUT', 'ERR_SOCKET_NOT_CONNECTED', 'ERR_EMPTY_RESPONSE', 'ERR_INVALID_RESPONSE',
  'ERR_INVALID_HTTP_RESPONSE', 'ERR_RESPONSE_HEADERS_TRUNCATED', 'ERR_CONTENT_LENGTH_MISMATCH', 'ERR_INCOMPLETE_CHUNKED_ENCODING',
  'ERR_INVALID_CHUNKED_ENCODING', 'ERR_CONTENT_DECODING_FAILED', 'ERR_INSUFFICIENT_RESOURCES', 'ERR_OUT_OF_MEMORY',
  'ERR_BLOCKED_BY_CLIENT', 'ERR_BLOCKED_BY_RESPONSE', 'ERR_BLOCKED_BY_CSP', 'ERR_BLOCKED_BY_ORB', 'ERR_ACCESS_DENIED',
  'ERR_NETWORK_ACCESS_DENIED', 'ERR_CACHE_MISS', 'ERR_INVALID_URL']);
const resourceTypes = ['document', 'stylesheet', 'image', 'media', 'font', 'script', 'texttrack', 'xhr', 'fetch',
  'eventsource', 'websocket', 'manifest'];
const containerActions = ['create', 'start', 'restart', 'die', 'kill', 'stop', 'destroy', 'oom', 'pause', 'unpause'];
const networkActions = ['create', 'connect', 'disconnect', 'destroy', 'remove'];

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
const offset = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(-1e7, Math.min(1e7, Math.round(value))) : null;

// A request's errorText is the whole token `net::ERR_*`; anything else is 'other'.
export function requestFailureCode(text) {
  if (typeof text !== 'string' || text.length > 128) return 'other';
  return category(/^net::(ERR_[A-Z0-9_]{1,64})$/.exec(text.trim())?.[1], failureCodes);
}

// A goto error's code is read from its leading header line only (`page.goto: net::ERR_X at URL`);
// a code that appears only in a URL or in the call log below it is 'other'.
export function gotoFailureCode(text) {
  if (typeof text !== 'string') return 'other';
  const header = text.slice(0, 512).split('\n', 1)[0];
  return category(/^(?:page\.goto: )?net::(ERR_[A-Z0-9_]{1,64})(?=[\s;,]|$)/.exec(header)?.[1], failureCodes);
}

// Records the check's own container starts and removals on the observer's clock, so an
// artifact can place them against the failing navigation. Other Docker commands pass through.
export function containerTimeline(now = () => performance.now()) {
  const entries = [];
  return {
    entries,
    record(args, run) {
      const op = args[0];
      if (op !== 'run' && op !== 'rm') return run();
      const start = now();
      let ok = false, id;
      try {
        const output = run();
        ok = true;
        if (op === 'run' && typeof output === 'string' && /^[0-9a-f]{64}$/.test(output)) id = output;
        return output;
      } finally {
        entries.push({ op, start, end: now(), ok, ...(id ? { id } : {}) });
        if (entries.length > diagnosticLimits.containers) entries.shift();
      }
    },
  };
}

// Replays the host's container and network lifecycle events for a closed window; read-only
// and returns at --until. Each line is a JSON array of type, action, the container the event
// is about (a container event's actor, a network event's attached container; never the
// network's own ID) and the time. That container ID passes through this reader's private
// stdout only to be compared with the check's own; projectDockerEvents keeps only type,
// allowlisted action, time and whether the container is the check's own.
// The reader owns its subprocess: at the deadline, on abort or past the byte cap it kills the
// child with SIGKILL, destroys its stdout and settles without waiting for the pipe to close.
// A child or stdout stream error takes the same path, so it becomes this promise's rejection
// (which the observer records as an unavailable query) rather than an unhandled 'error'.
export function readDockerEvents({ since, until, signal, command = 'docker', prefix = [],
  timeoutMs = diagnosticLimits.dockerEventsMs, maxBytes = diagnosticLimits.dockerEventsBytes, start = spawn }) {
  const actions = [...new Set([...containerActions, ...networkActions])].flatMap(action => ['--filter', `event=${action}`]);
  return new Promise((resolve, reject) => {
    let child, timer, text = '', bytes = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error && child) {
        try { child.kill('SIGKILL'); } catch { /* Already gone. */ }
        child.stdout?.destroy();
        child.unref();
      }
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new Error('docker events aborted'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(new Error('docker events deadline')), timeoutMs);
    try {
      child = start(command, [...prefix, 'events', '--since', since.toFixed(3), '--until', until.toFixed(3),
        '--filter', 'type=container', '--filter', 'type=network', ...actions, '--format',
        '[{{json .Type}},{{json .Action}},{{if eq .Type "network"}}{{json (index .Actor.Attributes "container")}}'
          + '{{else}}{{json .Actor.ID}}{{end}},{{json .TimeNano}}]'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
      // Listeners stay attached after settling, so a later error (a failed kill, a second
      // stream error) is absorbed by finish's settled guard instead of being unhandled.
      child.on('error', error => finish(error));
      child.stdout.on('error', error => finish(error));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) finish(new Error('docker events output exceeded its cap')); else text += chunk;
      });
      child.once('close', code => finish(code === 0 ? null : new Error('docker events failed'), text));
    } catch (error) { finish(error); }
  });
}

// Whether the host-wide Docker event replay runs. It reads every container's and network's
// lifecycle events on the daemon (keeping only type, action, time and the own bit), so it is
// on only where the daemon belongs to this job: a GitHub-hosted runner, which is a fresh VM
// per job (GitHub sets RUNNER_ENVIRONMENT=github-hosted), or when COMPILED_ALERTS_HOST_EVENTS=1.
// COMPILED_ALERTS_HOST_EVENTS=0 turns it off; on a shared or self-hosted daemon it is off.
export function hostEventsEnabled(env = process.env) {
  if (env.COMPILED_ALERTS_HOST_EVENTS === '1') return true;
  if (env.COMPILED_ALERTS_HOST_EVENTS === '0') return false;
  return env.RUNNER_ENVIRONMENT === 'github-hosted';
}

// Events after the cutoff (the failure) are excluded even if Docker returned them. Docker keeps
// only its most recent events (256 in current releases) before applying a query's filters, so
// a replay is best effort even when nothing was dropped here: an empty or short list is not
// evidence that nothing happened in the window, and `history: 'best-effort'` says so.
export function projectDockerEvents(text, originWall, ownIds, untilWall = Infinity) {
  if (typeof text !== 'string') return { unavailable: true };
  const events = [];
  let dropped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let raw;
    try { raw = JSON.parse(line); } catch { dropped = Math.min(dropped + 1, 1e9); continue; }
    if (!Array.isArray(raw)) { dropped = Math.min(dropped + 1, 1e9); continue; }
    const [rawType, action, container, timeNano] = raw;
    const wallMs = Number(timeNano) / 1e6;
    if (wallMs > untilWall) continue;
    const type = category(rawType, ['container', 'network']);
    events.push({ type, action: category(action, type === 'network' ? networkActions : type === 'container' ? containerActions : []),
      ms: offset(wallMs - originWall), own: typeof container === 'string' && ownIds.has(container) });
    if (events.length > diagnosticLimits.dockerEvents) { events.shift(); dropped = Math.min(dropped + 1, 1e9); }
  }
  return { history: 'best-effort', events, dropped };
}

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
// A failing goto (hydration.goto) or readiness wait (hydration.wait) writes the artifact and
// rethrows the original error. Request failures keep a reduced net error code, the resource
// type, the stage and the time from the navigation's start; the artifact also places the
// check's own container starts and removals (timeline) and the host's Docker container and
// network events (dockerEvents) on that clock, since Chromium aborts requests in flight with
// ERR_NETWORK_CHANGED when the host's interfaces change. The Docker window ends at the failure
// (failureMs), read when the gate rejects and before any diagnostic await. Without dockerEvents
// (the default off a GitHub-hosted runner, see hostEventsEnabled) the artifact's docker field is
// { disabled: true }.
export function observeHydration(page, { artifactPath, app, source, profile, write = save,
  log = summary => console.error(JSON.stringify(summary)), timeline, dockerEvents, now = () => performance.now(), wall = Date.now }) {
  let events = [], eventBytes = 2, dropped = 0, sequence = 0, navigation = null, navigationIndex = 1, stage = 'idle';
  let origin = { mono: now(), wall: wall() };
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
  listen('requestfailed', request => {
    let failure = 'other', resourceType = 'other';
    try { failure = requestFailureCode(request.failure()?.errorText); } catch { /* A broken accessor is 'other'. */ }
    try { resourceType = category(request.resourceType(), resourceTypes); } catch { /* Likewise. */ }
    add({ kind: 'requestfailed', resourceKind: resourceKind(request.url()), resourceType, failure, stage, ms: offset(now() - origin.mono) });
  });
  listen('response', response => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
      navigation = { status: status(response.status()) };
    }
    const resource = resourceKind(response.url());
    if (resource !== 'other') add({ kind: 'response', resourceKind: resource, status: status(response.status()) });
  });
  page.once('close', dispose);

  // `failed` is the clock reading taken when the gate rejected, before any diagnostic await.
  async function capture(error, failedStage, failed) {
    let containers = [];
    const ownIds = new Set();
    try {
      for (const entry of (Array.isArray(timeline?.entries) ? timeline.entries : []).slice(-diagnosticLimits.containers)) {
        if (typeof entry?.id === 'string') ownIds.add(entry.id);
        containers.push({ op: category(entry?.op, ['run', 'rm']), startMs: offset(entry?.start - origin.mono),
          endMs: offset(entry?.end - origin.mono), ok: entry?.ok === true });
      }
    } catch { containers = []; }
    // The replay's window is already closed at the failure, so it starts now and runs beside the
    // snapshot under its own budget, rather than after it, while Docker still holds the events.
    let replay = Promise.resolve({ disabled: true });
    if (typeof dockerEvents === 'function') {
      replay = Number.isFinite(failed.wall) ? bounded(signal => dockerEvents({ since: (origin.wall - diagnosticLimits.dockerWindowMs) / 1000,
        until: failed.wall / 1000, signal }), diagnosticLimits.dockerEventsMs)
        .then(text => projectDockerEvents(text, origin.wall, ownIds, failed.wall)).catch(() => ({ unavailable: true }))
        : Promise.resolve({ unavailable: true });
    }
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
    // Only a goto's own error is read, and only for its net error code.
    let failure = null;
    if (failedStage === 'goto') { try { failure = gotoFailureCode(error?.message); } catch { failure = 'other'; } }
    let docker;
    try { docker = await replay; } catch { docker = { unavailable: true }; }
    const detail = { schema: 'compiled-alerts-hydration/v3',
      app: ['gin', 'drogon', 'topcoat', 'leptos'].includes(app) ? app : 'unknown',
      source: ['fixture', 'api'].includes(source) ? source : 'unknown',
      profile: ['defaults', 'matched'].includes(profile) ? profile : 'unknown',
      navigationIndex, stage: failedStage, failureMs: offset(failed.mono - origin.mono), failure, navigation,
      errorClass: errorClass(error), state, events, dropped, containers, docker };
    let text = JSON.stringify(detail, null, 2) + '\n';
    // Also cap the complete encoding, including JSON escaping and pretty printing.
    while (Buffer.byteLength(text) > diagnosticLimits.artifactBytes && (events.length || docker.events?.length)) {
      if (events.length) { events.pop(); detail.dropped++; } else { docker.events.shift(); docker.dropped++; }
      text = JSON.stringify(detail, null, 2) + '\n';
    }
    if (Buffer.byteLength(text) > diagnosticLimits.artifactBytes) { detail.state = { unavailable: true }; text = JSON.stringify(detail) + '\n'; }
    let saved = false;
    try { await bounded(signal => write(artifactPath, text, signal), diagnosticLimits.writeMs); saved = true; } catch { /* Original readiness error wins. */ }
    log({ diagnostic: 'compiled-alerts-hydration/v3', app: detail.app, source: detail.source, profile: detail.profile,
      navigationIndex, stage: detail.stage, failure, saved, events: events.length, dropped: detail.dropped, bytes: Buffer.byteLength(text) });
  }

  async function fail(error, failedStage) {
    let failed;
    try { failed = { mono: now(), wall: wall() }; } catch { failed = { mono: NaN, wall: NaN }; }
    stage = 'idle';
    try { dispose(); } catch { /* Original error wins even if the page is broken. */ }
    try { await capture(error, failedStage, failed); } catch { /* Diagnostics must never replace the gate's exception. */ }
    throw error;
  }

  return {
    dispose,
    reset() {
      events = []; eventBytes = 2; dropped = 0; sequence = 0; navigation = null; navigationIndex++; stage = 'idle';
      origin = { mono: now(), wall: wall() };
    },
    // Runs the caller's own navigation unchanged and returns its result.
    async goto(navigate) {
      origin = { mono: now(), wall: wall() }; stage = 'goto';
      let response;
      try { response = await navigate(); } catch (error) { return fail(error, 'goto'); }
      stage = 'idle';
      return response;
    },
    async wait() {
      stage = 'readiness';
      try {
        await page.waitForFunction(() => typeof window.__hydratedAt === 'number');
      } catch (error) { return fail(error, 'readiness'); }
      stage = 'idle';
    },
  };
}
