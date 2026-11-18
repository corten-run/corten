import assert from "node:assert/strict";
import test from "node:test";
import { productionChild } from "./fleet.mjs";

test("the production fleet worker loads the controller before rejecting an empty command", async () => {
  // No round, approved action or cloud configuration: only worker startup can run.
  await assert.rejects(productionChild([], { cancellation: new SharedArrayBuffer(4) }),
    { message: "group-operation-failed" });
});
