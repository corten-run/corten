// Run against a started app with tests/catalog.json mounted as its catalog fixture.
// The same contract applies to the Leptos and Topcoat benchmark apps.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const base = process.argv[2];
assert.ok(base, 'usage: node tests/catalog-smoke.mjs http://localhost:8080');
const fixture = JSON.parse(await readFile(new URL('catalog.json', import.meta.url), 'utf8'));
const sharedCss = await readFile(new URL('../../../../catalog/catalog.css', import.meta.url));

async function page(id, prefix = '') {
  const response = await fetch(`${base}/catalog/${id}?field=${encodeURIComponent(prefix)}`);
  assert.equal(response.status, 200);
  // Leptos writes <!> as an empty hydration comment; neither comment form is content.
  return (await response.text()).replace(/<!--[\s\S]*?-->|<!>/g, '');
}

const html = await page('record_1');
assert.ok(html.includes('<article aria-label="Catalog record">'));
assert.ok(html.includes('Ridge &lt;trail&gt; &amp;'));
assert.ok(!html.includes('<script>alert(1)</script>'));
assert.ok(html.includes('<caption>Record fields</caption>'));
assert.ok(html.includes('scope="row"'));
assert.ok(html.includes('aria-label="Related records"'));
assert.ok(html.includes('href="/catalog/record_2"'));
assert.ok(html.includes('name="field"'));
assert.ok(html.includes('action="/catalog/record_1"'));
assert.ok(html.includes('method="get"'));
for (const [prefix, expected] of [['', 4], ['Ac', 2], ['ac', 1], [' ', 1], ['missing', 0]]) {
  const filtered = await page('record_1', prefix);
  assert.equal((filtered.match(/scope="row"/g) ?? []).length, expected, `prefix ${JSON.stringify(prefix)}`);
  assert.ok(filtered.includes(`value="${prefix}"`), 'retained input');
}
const empty = await page('record_2');
assert.ok(empty.includes('<ul aria-label="Tags"></ul>'));
assert.ok(empty.includes('<tbody></tbody>'));
assert.ok(empty.includes('<nav aria-label="Related records"><ul></ul></nav>'));
for (const [id, expected] of Object.entries(fixture)) {
  const response = await fetch(`${base}/api/catalog/${id}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await response.json(), expected);
}
for (const path of ['/catalog/unknown', '/api/catalog/unknown']) {
  assert.equal((await fetch(base + path)).status, 404, path);
}
const links = [...html.matchAll(/<link\b[^>]*href="([^"]+)"[^>]*>/g)].map(match => match[1]);
let shared = false;
for (const href of links) {
  const response = await fetch(new URL(href, base));
  if (response.status === 200 && Buffer.from(await response.arrayBuffer()).equals(sharedCss)) shared = true;
}
assert.ok(shared, 'linked stylesheet is the shared catalog.css byte for byte');
console.log('PASS catalog: fixture JSON, escaped HTML, prefixes, retained input, empty containers, links, form, 404 and CSS');
