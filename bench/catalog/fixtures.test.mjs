import assert from 'node:assert/strict';
import test from 'node:test';
import { records, count, workload } from './fixtures.mjs';

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
