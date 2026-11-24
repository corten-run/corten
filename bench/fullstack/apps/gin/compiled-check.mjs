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

// Runs every cleanup step even when an earlier one fails. After a failed check (outcome.failed)
// the check's own error stays the one thrown, so each cleanup failure is only reported; after
// a passing check a cleanup failure fails it.
export async function cleanUp(outcome, steps, report = reportCleanupFailure) {
  const errors = [];
  for (const step of steps) {
    try { await step(); } catch (error) { errors.push(error); }
  }
  if (!errors.length) return;
  if (outcome.failed) {
    for (const error of errors) { try { report(error); } catch { /* The check's error still wins. */ } }
    return;
  }
  throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Cleanup failed');
}

export function reportCleanupFailure(error) {
  let line = 'unknown';
  try { line = `${String(error?.name ?? 'Error').slice(0, 40)}: ${String(error?.message ?? error).split('\n', 1)[0].slice(0, 200)}`; } catch { /* Keep 'unknown'. */ }
  console.error(`cleanup also failed after the check failed: ${line}`);
}
