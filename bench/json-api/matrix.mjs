import assert from "node:assert/strict";
import { descriptor, timingPlan } from "./contract.mjs";

// All members stay selected even when a native build/endpoint/audit is missing.
// Never time a successful subset of an unqualified group.
export async function executeMatrix(options, io, plan = timingPlan(options)) {
  assert.deepEqual(plan, timingPlan(options), "effective timing plan differs from deterministic registry plan");
  let qualified = true;
  for (const app of options.apps) for (const payload of descriptor().payloads) {
    try { await io.prepare(app, payload); } catch (error) { qualified = false; await io.failure(app, payload, "build/image", error); }
  }
  for (const profile of descriptor().cases) for (const app of options.apps) {
    try { qualified = (await io.check(app, profile)) && qualified; }
    catch (error) { qualified = false; await io.failure(app, profile.key, "JSON qualification", error); }
  }
  await io.gate(qualified);
  if (!options.checkOnly && qualified) for (const item of plan) {
    try { await io.measure(item); } catch (error) { await io.failure(item.app, item.profile.key, `timing pass ${item.pass}`, error); }
  }
  return qualified;
}
