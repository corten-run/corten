// Run against the fixture-backed app with and without PROFILE=catalog-lean.
import assert from 'node:assert/strict';

const [lean, legacy] = process.argv.slice(2);
assert.ok(lean && legacy, 'usage: node tests/catalog-headers.mjs LEAN_URL LEGACY_URL');
const baseline = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cache-control': 'private, no-cache',
};

for (const [base, catalogLean] of [[lean, true], [legacy, false]]) {
  for (const [path, status] of [
    ['/catalog/record_1?field=Ac', 200],
    ['/catalog/missing', 404],
    ['/api/catalog/record_1', 200],
    ['/catalog.css', 200],
    ['/', 200],
  ]) {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, status, path);
    const document = catalogLean && path === '/catalog/record_1?field=Ac';
    if (document) assert.match(response.headers.get('content-type'), /^text\/html\b/);
    for (const [name, value] of Object.entries(baseline)) {
      assert.equal(response.headers.get(name), document ? value : null, `${path}: ${name}`);
    }
    await response.arrayBuffer();
  }
}
console.log('PASS Drogon catalog document headers and profile/route isolation');
