import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { checkApp } from "./check.mjs";
import { records } from "./fixtures.mjs";
import { verifyRecordAttempt, verifyCheckerExit } from "./record-attempt.mjs";

test("native catalog checker retains a replayable observed target violation, not assertion text", async (t) => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ requests: {} }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let failure;
  try { await checkApp({ base, upstream: base, source: "fixture", catalog: records() }); } catch (error) { failure = error; }
  assert.ok(failure);
  assert.equal(verifyRecordAttempt(failure.recordAttempt, records(), "/api/catalog").outcome, "failed");
  for (const mutate of [
    (p) => { delete p.requests[0].response; },
    (p) => { p.requests[0].id = "record_499"; },
    (p) => { p.requests[0].path = "/unrelated"; },
    (p) => { p.requests[0].finishedAt = null; },
    (p) => { for (const row of p.requests) row.response.body = JSON.stringify(records()[row.id]); },
  ]) { const p = structuredClone(failure.recordAttempt); mutate(p); assert.throws(() => verifyRecordAttempt(p, records(), "/api/catalog")); }
});

test("only a normal failed checker exit can support negative replay", () => {
  const exit = { code: 1, signal: null, expired: false, interrupted: false };
  verifyCheckerExit(exit);
  for (const change of [{ code: 0 }, { code: 137 }, { signal: "SIGTERM" }, { expired: true }, { interrupted: true }])
    assert.throws(() => verifyCheckerExit({ ...exit, ...change }));
});
