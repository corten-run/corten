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
