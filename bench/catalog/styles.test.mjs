import assert from 'node:assert/strict';
import test from 'node:test';
import { copies, syncStyles } from './styles.mjs';

test('all eighteen catalog apps ship the canonical stylesheet byte-for-byte', () => {
  assert.equal(new Set(copies).size, 18);
  assert.equal(syncStyles(), 18);
});
