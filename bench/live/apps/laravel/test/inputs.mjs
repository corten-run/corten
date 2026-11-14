import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const lock = JSON.parse(await readFile(new URL('../composer.lock', import.meta.url), 'utf8'));
const npm = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
async function metadata(url) {
  const response = await fetch(url); assert.equal(response.status, 200);
  const body = await response.text();
  return { url, checkedAt: new Date().toISOString(), sha256: createHash('sha256').update(body).digest('hex'), value: JSON.parse(body) };
}
for (const name of ['laravel/framework', 'livewire/livewire', 'laravel/reverb', 'laravel/octane', 'laravel/tinker']) {
  const { value, ...receipt } = await metadata('https://repo.packagist.org/p2/' + name + '.json');
  const latest = value.packages[name].find(item => /^v?\d+\.\d+\.\d+$/.test(item.version));
  const installed = lock.packages.find(item => item.name === name);
  assert.equal(installed.version, latest.version); assert.equal(installed.source.reference, latest.source.reference);
  console.log(JSON.stringify({ ...receipt, name, version: latest.version, source: latest.source.reference, releasedAt: latest.time }));
}
for (const name of ['laravel-echo', 'pusher-js', 'esbuild']) {
  const { value, ...receipt } = await metadata('https://registry.npmjs.org/' + name + '/latest');
  assert.equal(npm.packages['node_modules/' + name].version, value.version);
  console.log(JSON.stringify({ ...receipt, name, version: value.version, integrity: value.dist.integrity }));
}
for (const [url, extract, expected] of [
  ['https://www.php.net/releases/?json&version=8.5', value => value.version, '8.5.12'],
  ['https://api.github.com/repos/php/frankenphp/releases/latest', value => value.tag_name, 'v1.13.5'],
  ['https://nodejs.org/dist/index.json', value => value.find(item => /^v\d+\.\d+\.\d+$/.test(item.version)).version, 'v26.13.1'],
  ['https://api.github.com/repos/composer/composer/releases/latest', value => value.tag_name, '2.11.2'],
]) {
  const { value, ...receipt } = await metadata(url), version = extract(value);
  assert.equal(version, expected); console.log(JSON.stringify({ ...receipt, version }));
}
