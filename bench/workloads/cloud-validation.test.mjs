import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { commit, harness } from "./cloud-fixtures.mjs";
import { inspectCampaign, validationLimit } from "./cloud-validation.mjs";

async function fakeNative(t, source) {
  const h = harness(t), root = join(h.temp, "validator"); mkdirSync(root); mkdirSync(join(root, "isolated"));
  for (const name of ["cloud-validation.mjs", "cloud-validation-worker.mjs"])
    copyFileSync(new URL(name, import.meta.url), join(root, name));
  // Temporary synthetic local modules only. The real pinned native path stays absent.
  writeFileSync(join(root, "isolated/campaign-verify.mjs"), source);
  const native = await import(pathToFileURL(join(root, "cloud-validation.mjs")));
  return { ...h, inspect: native.inspectCampaign, input: { folder: root, round: "r21", commit }, started: join(root, "started") };
}

test("native worker returns only after stopping validator-owned lasting work", { timeout: 5000 }, async (t) => {
  const h = await fakeNative(t, "export function validateCampaign(input) { setInterval(() => {}, 1000); return input; }");
  let retained = false;
  assert.deepEqual(await h.inspect(h.input, { preserveLock: () => { retained = true; } }), h.input);
  assert.equal(retained, false);
});

test("native worker awaits the fixed asynchronous read-only API without adding authority context", { timeout: 5000 }, async (t) => {
  const h = await fakeNative(t, 'export async function validateCampaign(input) { await new Promise((r) => setTimeout(r, 25)); return { keys: Object.keys(input).sort(), input, frozen: Object.isFrozen(input) }; }');
  assert.deepEqual(await h.inspect(h.input), { keys: ["commit", "folder", "round"], input: h.input, frozen: true });
});

test("asynchronous native rejection is sanitized, settled and cannot become a report", { timeout: 5000 }, async (t) => {
  const h = await fakeNative(t, 'export async function validateCampaign() { await new Promise((r) => setTimeout(r, 25)); throw new Error("synthetic-private-value"); }');
  let retained = false;
  await assert.rejects(h.inspect(h.input, { preserveLock: () => { retained = true; } }), (error) =>
    /validation unavailable/.test(error.message) && !error.message.includes("synthetic-private-value"));
  assert.equal(retained, false);
});

test("native worker cancellation terminates synchronous validator work before lock release", { timeout: 5000 }, async (t) => {
  const h = await fakeNative(t, 'import {writeFileSync} from "node:fs"; export function validateCampaign({folder}) { writeFileSync(folder + "/started", "fake"); while (true) {} }');
  let cancelled = false, retained = false;
  const pending = h.inspect(h.input, { interrupted: () => cancelled, preserveLock: () => { retained = true; } });
  const observed = assert.rejects(pending, /validation unavailable/);
  while (!existsSync(h.started)) await new Promise((r) => setImmediate(r));
  cancelled = true; await observed; assert.equal(retained, false);
});

test("native worker fixed deadline terminates synchronous validator work", { timeout: 5000 }, async (t) => {
  const h = await fakeNative(t, 'import {writeFileSync} from "node:fs"; export function validateCampaign({folder}) { writeFileSync(folder + "/started", "fake"); while (true) {} }');
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let retained = false;
  const pending = h.inspect(h.input, { preserveLock: () => { retained = true; } });
  const observed = assert.rejects(pending, /validation unavailable/);
  while (!existsSync(h.started)) await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(validationLimit); await observed; assert.equal(retained, false);
});

test("worker missing/throwing native validator errors are sanitized and settled", { timeout: 5000 }, async (t) => {
  const input = { folder: "/not-used", round: "r21", commit }; let retained = false;
  const missing = await fakeNative(t, 'export const syntheticMissingApi = true;');
  await assert.rejects(missing.inspect(input, { preserveLock: () => { retained = true; } }), /validation unavailable/);
  const h = await fakeNative(t, 'export function validateCampaign() { console.error("synthetic-private-value"); throw new Error("synthetic-private-value"); }');
  await assert.rejects(h.inspect(h.input), (error) => !error.message.includes("synthetic-private-value"));
  assert.equal(retained, false);
});
