import { test } from "node:test";
import assert from "node:assert/strict";
import { patchOf, snapshotOf } from "../crates/corten/js/feed.js";

test("a snapshot is its envelope as corten-protocol writes it", () => {
  const snap = { epoch: "e", seq: 3, rows: [{ id: "a" }] };
  assert.equal(snapshotOf(snap), snap);
  assert.deepEqual(snapshotOf({ epoch: "e", seq: 0, rows: [] }), { epoch: "e", seq: 0, rows: [] });
  // Rows are the server's: not looked into.
  assert.ok(snapshotOf({ epoch: "e", seq: 1, rows: [null, 5, "x"] }));
});

test("anything else is no snapshot", () => {
  for (const bad of [null, undefined, "x", 5, [], {}, { seq: 1, rows: [] }, { epoch: 1, seq: 1, rows: [] }, { epoch: "e", rows: [] }, { epoch: "e", seq: -1, rows: [] }, { epoch: "e", seq: 1.5, rows: [] }, { epoch: "e", seq: "1", rows: [] }, { epoch: "e", seq: 2 ** 53, rows: [] }, { epoch: "e", seq: 1 }, { epoch: "e", seq: 1, rows: {} }, { epoch: "e", seq: 1, rows: null }])
    assert.equal(snapshotOf(bad), null, JSON.stringify(bad));
});

test("a patch is its envelope and each change's op and id, and an upsert's value", () => {
  const data = '{"seq":2,"changes":[{"op":"upsert","id":"a","value":{"n":1}},{"op":"remove","id":"b"},{"op":"upsert","id":"c","value":null}]}';
  assert.deepEqual(patchOf(data), JSON.parse(data));
  assert.deepEqual(patchOf('{"seq":0,"changes":[]}'), { seq: 0, changes: [] });
});

test("anything else is no patch, and nothing throws", () => {
  const bad = [
    "", "<html>", "null", "5", '"x"', "[]", "{}",
    '{"changes":[]}', '{"seq":-1,"changes":[]}', '{"seq":1.5,"changes":[]}', '{"seq":"1","changes":[]}', '{"seq":1}', '{"seq":1,"changes":{}}',
    '{"seq":1,"changes":[null]}', '{"seq":1,"changes":[5]}', '{"seq":1,"changes":[{"op":"remove"}]}', '{"seq":1,"changes":[{"op":"remove","id":7}]}',
    '{"seq":1,"changes":[{"op":"upsert","id":"a"}]}', '{"seq":1,"changes":[{"op":"move","id":"a"}]}', '{"seq":1,"changes":[{"id":"a","value":1}]}',
    '{"seq":1,"changes":[{"op":"remove","id":"a"},{"op":"upsert","id":"b"}]}',
  ];
  for (const data of bad) assert.equal(patchOf(data), null, data);
});
