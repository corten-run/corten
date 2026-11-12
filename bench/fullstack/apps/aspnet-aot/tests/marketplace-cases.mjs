import assert from 'node:assert/strict';
import { validateRecord } from '../../../../marketplace/records.mjs';

// Exercise the complete canonical record contract independently of the native implementation.
export function invalidMarketplaceCases(record) {
  const cases = [];
  const at = (root, path) => path.reduce((value, key) => value[key], root);
  const add = (name, mutate) => {
    const value = structuredClone(record);
    mutate(value);
    assert.throws(() => validateRecord(value, record.id), `oracle accepts invalid case: ${name}`);
    cases.push({ name, record: value });
  };
  const nullable = new Set(['subtitle', 'summary', 'summary.lowest_minor', 'listings.0.rating_hundredths', 'listings.0.price_minor', 'offers.0.price_minor']);
  function shape(value, path = []) {
    for (const [key, field] of Object.entries(value)) {
      const next = [...path, key], name = next.join('.');
      add(`${name} missing`, r => { delete at(r, path)[key]; });
      if (!nullable.has(name)) add(`${name} null`, r => { at(r, path)[key] = null; });
      add(`${name} wrong type`, r => { at(r, path)[key] = true; });
      if (Array.isArray(field) && field.length) {
        add(`${name} null entry`, r => { at(r, next)[0] = null; });
        add(`${name} wrong entry type`, r => { at(r, next)[0] = false; });
        if (typeof field[0] === 'object') shape(field[0], [...next, 0]);
      } else if (field && typeof field === 'object') shape(field, next);
    }
  }
  shape(record);
  const numbers = [
    ['summary', 'lowest_minor'], ['summary', 'count'], ['summary', 'quantity'],
    ['listings', 0, 'rating_hundredths'], ['listings', 0, 'reviews'], ['listings', 0, 'quantity'], ['listings', 0, 'price_minor'],
    ['offers', 0, 'quantity'], ['offers', 0, 'price_minor'], ['contents', 0, 'quantity'], ['included_in', 0, 'quantity'],
  ];
  for (const path of numbers) {
    const key = path.at(-1), parent = path.slice(0, -1), name = path.join('.');
    const min = key.endsWith('minor') ? -1e9 : 0;
    const max = key === 'rating_hundredths' ? 500 : 1e9;
    for (const bad of [min - 1, max + 1, 0.5, '1'])
      add(`${name} invalid numeric ${bad}`, r => { at(r, parent)[key] = bad; });
  }
  for (const key of ['listings', 'offers', 'contents', 'included_in'])
    add(`${key} duplicate id`, r => { r[key].push(structuredClone(r[key][0])); });
  add('record id mismatch', r => { r.id = 'different'; });
  return cases;
}
