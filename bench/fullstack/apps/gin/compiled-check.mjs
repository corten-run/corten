import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

export async function writeFixtures(folder, fixtures) {
  // These synthetic inputs are mounted read-only by images with different users.
  for (const [name, value] of Object.entries(fixtures)) {
    const path = join(folder, name);
    await writeFile(path, JSON.stringify(value));
    await chmod(path, 0o644);
  }
  await chmod(folder, 0o755);
}

export function startupFailure(docker, name, cause) {
  const container = JSON.parse(docker('inspect', name))[0];
  return new Error(`native startup failed: ${name}; state=${JSON.stringify(container.State)}\n${docker('logs', name)}`, { cause });
}

export function containerBase(docker, name) {
  const container = JSON.parse(docker('inspect', name))[0];
  const binding = container.NetworkSettings?.Ports?.['8080/tcp']?.[0];
  if (!container.State.Running || !binding?.HostPort) throw startupFailure(docker, name);
  return `http://127.0.0.1:${binding.HostPort}`;
}

// A failed Docker command. Its message names only the subcommand and the exit status or
// failure kind; Docker's stderr is never kept, so a thrown or printed error cannot carry it.
// `sent: false` means the client never started, so the daemon was never asked.
export class DockerCommandError extends Error {
  constructor(op, code, status = null) {
    super(`docker ${op}: ${code === 'ERR_DOCKER_EXIT' ? `exit ${status}` : code === 'ERR_DOCKER_TIMEOUT' ? 'timed out'
      : code === 'ERR_DOCKER_OUTPUT' ? 'unexpected output' : code === 'ENOENT' ? 'not found' : 'could not start'}`);
    this.name = 'DockerCommandError';
    this.code = code;
    this.status = status;
    this.sent = !['ENOENT', 'ERR_DOCKER_START'].includes(code);
  }
}
const dockerOps = ['run', 'rm', 'ps', 'container', 'inspect', 'logs'];

// One bounded, synchronous Docker command. `combined` returns stderr after stdout, for a
// container log, which Docker splits across both; a failure keeps neither.
export function dockerCommand(args, { timeout = 60_000, combined = false, command = 'docker', prefix = [] } = {}) {
  const op = dockerOps.includes(args[0]) ? args[0] : 'command';
  const result = spawnSync(command, [...prefix, ...args], { encoding: 'utf8', timeout, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 64 * 2 ** 20 });
  if (result.error) {
    const code = result.error.code === 'ETIMEDOUT' ? 'ERR_DOCKER_TIMEOUT' : result.error.code === 'ENOBUFS' ? 'ERR_DOCKER_OUTPUT'
      : result.error.code === 'ENOENT' ? 'ENOENT' : 'ERR_DOCKER_START';
    throw new DockerCommandError(op, code);
  }
  if (result.status !== 0) throw new DockerCommandError(op, 'ERR_DOCKER_EXIT', result.status);
  return (combined ? result.stdout + result.stderr : result.stdout).trim();
}

// The owned-container pattern of bench/marketplace/alert-probe-run.mjs and
// bench/fullstack/idle-close.mjs. Every container carries this run's owner label and its
// create's own attempt label. It is registered only by the 64-hex ID a successful
// `docker run -d` returned, and every inspect, log read and removal goes through that ID after
// confirming the owner label; a name is never proof of ownership and is never inspected or
// removed. A create that returned no ID was not acknowledged, whatever its error (a daemon
// error can follow a create it made): teardown looks for it by its attempt label for a bounded
// window, removes what it finds by confirmed ID, and otherwise reports its cleanup unconfirmed.
export const ownerKey = 'run.corten.fullstack.compiled-alerts';
export const attemptKey = `${ownerKey}.create`;
export const reconcileWindow = 10_000;
const canonical = /^[0-9a-f]{64}$/;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Caller labels go on every container. Docker keeps a key's last value, so a caller label with
// the owner key or a key in its dot-delimited namespace would take a container out of this
// run's ownership checks; it is refused before any Docker command.
// Returns a fresh copy, each element read once, so nothing the caller's array does later (its
// own methods, getters or later edits) reaches the argv.
export function checkLabels(labels) {
  const copy = snapshot(labels, 'labels are key=value strings');
  for (const label of copy) {
    const key = typeof label === 'string' ? /^([\w.-]+)=[\w.:/-]*$/.exec(label)?.[1] : undefined;
    assert.ok(key, 'labels are key=value strings');
    assert.ok(key !== ownerKey && !key.startsWith(`${ownerKey}.`), `label ${key} is reserved for the check's ownership labels`);
  }
  return copy;
}

// A new plain array of `value`'s elements, each read once by index up to a length read once; the
// caller's array methods and iterator are never called.
function snapshot(value, message) {
  assert.ok(Array.isArray(value), message);
  const length = value.length;
  assert.ok(Number.isSafeInteger(length) && length >= 0 && length <= 64, message);
  const copy = [];
  for (let index = 0; index < length; index++) copy.push(value[index]);
  // A list that changed size while it was read is refused rather than cut short or extended.
  assert.equal(value.length, length, message);
  return copy;
}

// The `docker run` options a check may set, as a structured object; the helper writes the argv
// itself, so a caller cannot pass a label, a positional argument or `--` that would change the
// image Docker runs. Each value is passed as its flag's separate argument.
const text = value => typeof value === 'string' && value.length > 0 && !/[\0\r\n]/.test(value);
const strings = (value, flag) => {
  const copy = snapshot(value, `${flag} values are non-empty strings`);
  assert.ok(copy.every(text), `${flag} values are non-empty strings`);
  return copy.flatMap(item => [flag, item]);
};
const runOptions = {
  cpus(value) { assert.ok(typeof value === 'string' && /^\d+(\.\d+)?$/.test(value), 'cpus is a decimal string'); return ['--cpus', value]; },
  memory(value) { assert.ok(typeof value === 'string' && /^\d+[bkmg]?$/.test(value), 'memory is a size such as 512m'); return ['--memory', value]; },
  addHosts: value => strings(value, '--add-host'),
  publish: value => strings(value, '--publish'),
  volumes: value => strings(value, '--volume'),
  env(value) {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, 'env is a plain object');
    return Object.entries(value).flatMap(([key, item]) => {
      assert.ok(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof item === 'string' && !/[\0\r\n]/.test(item), 'env maps variable names to strings');
      return ['--env', `${key}=${item}`];
    });
  },
};
// The argv for `options`, in the order of runOptions; throws before any Docker command on an
// unknown key or a value of the wrong type or shape.
export function runArguments(options) {
  assert.ok(options && typeof options === 'object' && !Array.isArray(options) && Object.getPrototypeOf(options) === Object.prototype, 'options are a plain object');
  for (const key of Object.keys(options)) assert.ok(Object.hasOwn(runOptions, key), `unknown docker run option ${key}`);
  const args = [];
  for (const [key, build] of Object.entries(runOptions)) {
    const value = options[key];
    if (value !== undefined) args.push(...build(value));
  }
  return args;
}

export function ownedContainers({ docker, runId, labels = [], window = reconcileWindow, wait = sleep, now = () => performance.now() }) {
  const ownLabels = checkLabels(labels);
  assert.match(runId, /^[\w.-]{1,64}$/, 'runId is a short label value');
  const owner = `${ownerKey}=${runId}`;
  const record = { runId, ownerLabel: owner, created: [], unacknowledged: [], removed: [], recovered: [], failures: [], complete: false };
  const pending = new Set();
  let attempts = 0;
  const fail = (resource, error) => record.failures.push({ resource, ...classify(error) });
  // Only full container IDs are kept from a lookup; any other line is a failure and is never
  // inspected or removed.
  const list = (filter, timeout) => {
    const lines = docker(['ps', '-a', '--no-trunc', '--filter', filter, '--format', '{{.ID}}'], timeout === undefined ? {} : { timeout })
      .split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.some(line => !canonical.test(line))) fail(`containers matching ${filter}`, new DockerCommandError('ps', 'ERR_DOCKER_OUTPUT'));
    return lines.filter(line => canonical.test(line));
  };
  // Whether `id` still exists, from a lookup by its own ID; any output but nothing or exactly
  // that ID leaves its removal unconfirmed.
  const present = id => {
    const lines = docker(['ps', '-a', '--no-trunc', '--filter', `id=${id}`, '--format', '{{.ID}}']).split('\n').map(line => line.trim()).filter(Boolean);
    if (!lines.length) return false;
    assert.ok(lines.length === 1 && lines[0] === id, `docker ps --filter id=${id} did not return exactly that ID`);
    return true;
  };
  const confirm = id => {
    assert.match(id, canonical, 'only a full container ID is inspected');
    const [info] = JSON.parse(docker(['container', 'inspect', id]));
    assert.equal(info?.Id, id, `container ${id}: inspect returned a different object`);
    assert.equal(info.Config?.Labels?.[ownerKey], runId, `refusing unowned container ${id}`);
    return info;
  };
  const removeConfirmed = id => {
    if (present(id)) {
      confirm(id);
      assert.equal(docker(['rm', '-f', '-v', id]), id, `docker rm did not confirm ${id}`);
    }
    pending.delete(id);
    (record.created.some(entry => entry.id === id) ? record.removed : record.recovered).push(id);
  };
  return {
    record,
    // `docker run -d` with the ownership labels, the argv runArguments builds from `options`,
    // then `--` and `image`, so the image Docker runs is always this one. The image is only
    // checked not to look like an option; its reference syntax is Docker's. Returns the ID.
    run(options, image, name) {
      const args = runArguments(options);
      assert.ok(typeof image === 'string' && image.length > 0 && !image.startsWith('-'), 'the image is a non-empty argument that is not an option');
      const label = `${attemptKey}=${runId}-${++attempts}`;
      let id;
      try { id = docker(['run', '-d', '--name', name, ...ownLabels.flatMap(value => ['--label', value]), '--label', owner, '--label', label, ...args, '--', image]); } catch (error) {
        if (error?.sent !== false) record.unacknowledged.push({ name, label });
        throw error;
      }
      if (!canonical.test(id)) {
        record.unacknowledged.push({ name, label });
        throw new DockerCommandError('run', 'ERR_DOCKER_OUTPUT');
      }
      pending.add(id); record.created.push({ id, name, label });
      return id;
    },
    inspect: id => confirm(id),
    logs(id) { confirm(id); return docker(['logs', id], { combined: true }); },
    // Removes a created container by confirmed ID; on failure it stays pending for teardown.
    remove(id) { assert.ok(pending.has(id), `container ${id} is not this run's`); removeConfirmed(id); },
    // Never throws; `complete` is false when anything this run may own is not confirmed gone.
    async teardown() {
      const targets = new Set(pending);
      const missing = () => record.unacknowledged.filter(attempt => !attempt.ids);
      if (missing().length) {
        // A create may still be under way in the daemon: look for each by its own label until it
        // appears or the window ends. Each lookup gets only the time left, and none starts once it
        // is spent. A failed lookup ends the search and is kept; the owner sweep below still runs.
        const end = now() + window;
        try {
          search: for (;;) {
            for (const attempt of missing()) {
              const left = Math.floor(end - now());
              if (left < 1) break search;
              const found = list(`label=${attempt.label}`, left);
              if (found.length) { attempt.ids = found; for (const id of found) targets.add(id); }
            }
            const pause = Math.min(250, end - now());
            if (!missing().length || pause <= 0) break;
            await wait(pause);
          }
        } catch (error) { fail(`containers labelled ${attemptKey}`, error); }
      }
      try { for (const id of list(`label=${owner}`)) targets.add(id); } catch (error) { fail(`containers labelled ${owner}`, error); }
      for (const id of targets) {
        try { removeConfirmed(id); } catch (error) { fail(`container ${id}`, error); }
      }
      const gone = new Set([...record.removed, ...record.recovered]);
      for (const attempt of record.unacknowledged) {
        attempt.outcome = !attempt.ids ? 'unconfirmed' : attempt.ids.every(id => gone.has(id)) ? 'removed' : 'not removed';
        if (!attempt.ids) fail(`container ${attempt.name} (${attempt.label})`, Object.assign(new Error('unconfirmed'), { code: 'ERR_CLEANUP_UNCONFIRMED' }));
      }
      record.complete = record.failures.length === 0;
      return record;
    },
  };
}

// The error thrown when cleanup fails after an otherwise passing check. Its message names each
// failed step with only an allowlisted class and code; it keeps no cause, nested error or error
// text, so Node's uncaught-error output cannot print Docker's stderr.
export class CleanupError extends Error {
  constructor(failures) {
    super(`cleanup failed: ${failures.map(line).join('; ')}`);
    this.name = 'CleanupError';
    this.code = 'ERR_CLEANUP';
    this.failures = failures;
  }
}
const line = ({ step, errorClass, code }) => `step=${step} class=${errorClass} code=${code}`;

// Runs every cleanup step ([name, step] pairs) even when an earlier one fails. After a failed
// check (outcome.failed) the check's own error stays the one thrown, so each cleanup failure is
// only reported; after a passing check a cleanup failure fails it with a CleanupError.
export async function cleanUp(outcome, steps, report = reportCleanupFailure) {
  const errors = [];
  for (const [name, step] of steps) {
    try { await step(); } catch (error) { errors.push([name, error]); }
  }
  if (!errors.length) return;
  if (outcome.failed) {
    for (const [name, error] of errors) { try { report(error, name); } catch { /* The check's error still wins. */ } }
    return;
  }
  throw new CleanupError(errors.map(([name, error]) => ({ step: stepName(name), ...classify(error) })));
}

// Regressions a check records and asserts only at its end (such as the money confirmations)
// outrank a cleanup failure that would otherwise end the check before that assertion: the
// recorded failure is thrown and the cleanup failure is reported. Any other error is returned
// unchanged, so a gate's own error object still surfaces as it was thrown.
export function recordedFirst(error, recorded, message, report = reportCleanupFailure) {
  if (!recorded.length || !(error instanceof CleanupError)) return error;
  try { report(error, 'cleanup'); } catch { /* The recorded failure still wins. */ }
  try { assert.deepEqual(recorded, [], message); } catch (failure) { return failure; }
  return error;
}

// Closes a server and rejects when close reports an error (for example ERR_SERVER_NOT_RUNNING).
export function closeServer(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

const errorNames = ['Error', 'AssertionError', 'AggregateError', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'TimeoutError', 'AbortError', 'SystemError', 'DockerCommandError', 'CleanupError'];
// The codes a cleanup step here can fail with, printed literally; any other code is `other`.
export const cleanupCodes = Object.freeze([
  'ERR_SERVER_NOT_RUNNING', // closeServer on a server that is not listening
  'ERR_ASSERTION', // an ownership or removal confirmation (refusing an unowned container, rm not confirmed)
  'ABORT_ERR', // an aborted operation
  'ENOENT', 'EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', // the docker client is missing; removing the fixture folder
  'ETIMEDOUT', 'EPIPE', 'ECONNRESET', // a timed-out call or a broken connection to the browser
  'ERR_DOCKER_EXIT', 'ERR_DOCKER_TIMEOUT', 'ERR_DOCKER_OUTPUT', 'ERR_DOCKER_START', // dockerCommand's own codes
  'ERR_CLEANUP_UNCONFIRMED', // the container teardown could not confirm everything this run may own is gone
  'ERR_CLEANUP', // a CleanupError
]);

function stepName(step) {
  return typeof step === 'string' && /^[a-z][a-z0-9.-]{0,40}$/.test(step) ? step : 'unknown';
}

// An error's allowlisted class and code; never its message, which can carry Docker's stderr.
export function classify(error) {
  let errorClass = 'unknown', code = 'none';
  // Read once: a getter could return an allowlisted name to the check and other text after it.
  try { const name = error?.name; if (errorNames.includes(name)) errorClass = name; } catch { /* Keep 'unknown'. */ }
  try {
    const value = error?.code;
    if (value !== undefined && value !== null) code = cleanupCodes.includes(value) ? value : 'other';
  } catch { code = 'other'; }
  return { errorClass, code };
}

// One line per failure with a fixed step name, an allowlisted error class and code; never
// error message text. A CleanupError prints each failure it holds.
export function reportCleanupFailure(error, step) {
  const failures = error instanceof CleanupError ? error.failures : [{ step: stepName(step), ...classify(error) }];
  for (const failure of failures) console.error(`cleanup also failed after the check failed: ${line(failure)}`);
}
