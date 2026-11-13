import assert from "node:assert/strict";
import test from "node:test";
import { deadlineContract } from "./deadline-contract.mjs";

const response = (media, text, status = 504) => ({ status, headers: { "content-type": media }, text });
test("API deadlines require real JSON error media and payload", () => {
  for (const media of [undefined, "text/html", "text/plain"]) {
    assert.throws(() => deadlineContract(response(media, '{"error":"timeout"}'), true));
  }
  for (const text of ["", "not JSON", "<html>timeout</html>", "null", "[]", "{}", '"timeout"', '{"error":""}', '{"status":504}']) {
    assert.throws(() => deadlineContract(response("application/json", text), true), text);
  }
  assert.throws(() => deadlineContract(response("application/problem+json", '{"status":503,"title":"Timeout"}'), true));
  assert.throws(() => deadlineContract(response("application/problem+json", '{"status":504,"title":""}'), true));
  assert.throws(() => deadlineContract(response("application/json", '{"error":"timeout"}', 500), true));
  assert.deepEqual(deadlineContract(response("application/json; charset=utf-8", '{"error":"timeout"}'), true), { error: "timeout" });
  assert.deepEqual(deadlineContract(response("application/problem+json", '{"status":504,"title":"Timeout"}'), true), { status: 504, title: "Timeout" });
});
