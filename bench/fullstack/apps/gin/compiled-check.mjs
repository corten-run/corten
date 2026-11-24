import assert from 'node:assert/strict';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

// Errors cleanUp threw after an otherwise passing check, with the step that threw them.
const cleanupFailures = new WeakMap();

// Runs every cleanup step ([name, step] pairs) even when an earlier one fails. After a failed
// check (outcome.failed) the check's own error stays the one thrown, so each cleanup failure is
// only reported; after a passing check a cleanup failure fails it.
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
  const [name, error] = errors.length === 1 ? errors[0] : ['cleanup', new AggregateError(errors.map(([, error]) => error), 'Cleanup failed')];
  if (error !== null && (typeof error === 'object' || typeof error === 'function')) cleanupFailures.set(error, name);
  throw error;
}

// Regressions a check records and asserts only at its end (such as the money confirmations)
// outrank a cleanup failure that would otherwise end the check before that assertion: the
// recorded failure is thrown and the cleanup failure is reported. Any other error is returned
// unchanged, so a gate's own error object still surfaces as it was thrown.
export function recordedFirst(error, recorded, message, report = reportCleanupFailure) {
  if (!recorded.length || !cleanupFailures.has(error)) return error;
  try { report(error, cleanupFailures.get(error)); } catch { /* The recorded failure still wins. */ }
  try { assert.deepEqual(recorded, [], message); } catch (failure) { return failure; }
  return error;
}

// Closes a server and rejects when close reports an error (for example ERR_SERVER_NOT_RUNNING).
export function closeServer(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

const errorNames = ['Error', 'AssertionError', 'AggregateError', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'TimeoutError', 'AbortError', 'SystemError'];

// One line with a fixed step name, an allowlisted error class and a code shaped like
// `ERR_*` or an errno; never error message text, which can carry Docker's stderr.
export function reportCleanupFailure(error, step) {
  let name = 'unknown', code = 'none';
  try { if (errorNames.includes(error?.name)) name = error.name; } catch { /* Keep 'unknown'. */ }
  try { if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(error.code)) code = error.code; } catch { /* Keep 'none'. */ }
  const label = typeof step === 'string' && /^[a-z][a-z0-9.-]{0,40}$/.test(step) ? step : 'unknown';
  console.error(`cleanup also failed after the check failed: step=${label} class=${name} code=${code}`);
}
