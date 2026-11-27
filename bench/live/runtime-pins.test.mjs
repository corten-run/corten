import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('native Corten and Leptos live images retain the reviewed production Rust toolchain', () => {
  const rust = 'rust:1.100.0-trixie@sha256:e19840879045c951c905d0eaa9887f3439c62000e429963371b376bac8d38c31';
  const runtime = 'debian:trixie-20261123-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0';
  for (const path of ['apps/corten/Dockerfile.parity', 'apps/leptos/Dockerfile']) {
    const dockerfile = readFileSync(new URL(path, import.meta.url), 'utf8');
    const inputs = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map(match => match[1]);
    assert.equal(inputs[0], rust, path);
    assert.equal(inputs.at(-1), runtime, path);
    assert.ok(dockerfile.includes('--locked'), path);
  }
  const leptos = readFileSync(new URL('apps/leptos/Dockerfile', import.meta.url), 'utf8');
  assert.match(leptos, /cargo install cargo-leptos --version =0\.3\.12 --locked/);
  assert.ok(!leptos.includes('cargo-leptos-installer.sh'));
});
