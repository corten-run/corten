import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { records, count, workload } from './fixtures.mjs';

test('generated public fixtures remain readable under a private umask without opening other state', () => {
  const folder = mkdtempSync(join(tmpdir(), 'catalog-permissions-'));
  const output = join(folder, 'fixtures', 'catalog.json');
  try {
    copyFileSync(new URL('./fixtures.mjs', import.meta.url), join(folder, 'fixtures.mjs'));
    const privateState = join(folder, 'private.json');
    writeFileSync(privateState, '{}', { mode: 0o600 });
    // Exercise fresh creation and repair of a fixture from an earlier private run.
    for (const existing of [false, true]) {
      if (existing) { chmodSync(join(folder, 'fixtures'), 0o700); chmodSync(output, 0o600); }
      const cli = spawnSync(process.execPath, ['--input-type=module', '-e', "process.umask(0o077); process.argv[1] = './fixtures.mjs'; await import('./fixtures.mjs')"], { cwd: folder, encoding: 'utf8', windowsHide: true });
      assert.equal(cli.status, 0, cli.stderr);
      assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), records());
      if (process.platform !== 'win32') {
        assert.equal(statSync(join(folder, 'fixtures')).mode & 0o777, 0o755);
        assert.equal(statSync(output).mode & 0o777, 0o644);
        assert.equal(statSync(privateState).mode & 0o777, 0o600);
        assert.equal(statSync(folder).mode & 0o777, 0o700);
      }
    }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('catalog-v1 is deterministic, strings-only and has valid related records', () => {
  const data = records();
  assert.equal(workload, 'catalog-v1');
  assert.equal(Object.keys(data).length, count);
  assert.deepEqual(data, records());
  const strings = value => {
    if (Array.isArray(value)) return value.forEach(strings);
    if (value !== null && typeof value === 'object') return Object.values(value).forEach(strings);
    assert.equal(typeof value, 'string');
  };
  strings(data);
  for (let n = 1; n <= count; n++) {
    const record = data[`record_${n}`];
    assert.deepEqual(Object.keys(record), ['id', 'title', 'subtitle', 'description', 'tags', 'fields', 'related']);
    assert.equal(record.id, `record_${n}`);
    for (const related of record.related) assert.equal(data[related.id].title, related.title);
  }
});

test('the fixture exercises escaping, prefix filtering and empty collections', () => {
  const data = records();
  assert.match(data.record_1.description, /<script>.*& "quoted" <img/);
  assert.equal(data.record_1.fields.filter(field => field.name.startsWith('A')).length, 4);
  assert.equal(data.record_1.fields.filter(field => field.name === 'Access').length, 2);
  assert.equal(data.record_1.fields.filter(field => field.name.startsWith('a')).length, 0);
  assert.deepEqual(data.record_500.fields, []);
  assert.deepEqual(data.record_500.tags, []);
  assert.deepEqual(data.record_500.related, []);
});
