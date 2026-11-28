import assert from 'node:assert/strict';
import test from 'node:test';
import { copies, syncStyles } from './styles.mjs';

test('all historical catalog apps and the group-only Proa peer ship the canonical stylesheet byte-for-byte', () => {
  assert.equal(new Set(copies).size, 21);
  assert.equal(syncStyles(), 21);
});
