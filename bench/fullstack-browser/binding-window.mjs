import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { replayBindingProof } from "./bindings.mjs";

export const bindingFormSelector = ".marketplace__alert form";

// Harness observations only. No application callback or constructor is invoked.
export async function beginBindingWindow(cdp, lifecycle, resources, identity) {
  const window = { id: randomUUID(), ...identity, startedAt: performance.now() };
  await lifecycle.sampleNativeClock(`binding-${window.id}-before`);
  const { observer, realm, scope, at } = await resources.checkpoint();
  window.resources = { observer, realm, scope, at };
  window.native = structuredClone(lifecycle.realms.get(window.resources.realm));
  assert.ok(window.native?.uniqueId && window.resources.scope, "Pre-dispatch native realm/scope association unavailable");
  window.target = structuredClone(lifecycle.target);
  const document = await cdp.send("DOM.getDocument", { depth: 0 });
  const found = await cdp.send("DOM.querySelector", { nodeId: document.root.nodeId, selector: bindingFormSelector });
  const { node } = await cdp.send("DOM.describeNode", { nodeId: found.nodeId, depth: 0 });
  assert.equal(node.localName, "form", "Pre-dispatch mounted form unavailable");
  window.form = { backendNodeId: node.backendNodeId, observedAt: performance.now(), selector: bindingFormSelector };
  return window;
}

export async function finishBindingWindow(lifecycle, window, enhancement) {
  await lifecycle.sampleNativeClock(`binding-${window.id}-after`);
  window.finishedAt = performance.now();
  lifecycle.events.push({ event: "binding-observation", receivedAt: performance.now(),
    capture: enhancement?.bindingProof?.links?.observation?.id ?? null, window: structuredClone(window) });
}

// Structural effects replay is necessary but never sufficient for an action.
// Expectations come from the case row and independent native lifecycle journal,
// not from fields copied out of the candidate proof.
export function validateBindingWindow(enhancement, evidence, row, caseKey) {
  try {
    const w = row.bindingWindow, o = enhancement.bindingProof.links.observation, j = evidence.platformLifecycle;
    const text = (v) => typeof v === "string" && v.length > 0;
    const times = (...vs) => vs.every((v) => Number.isFinite(v) && v >= 0) && vs.every((v, i) => i === 0 || vs[i - 1] <= v);
    assert.ok(text(evidence.bindingInstance) && text(w.id) && text(o.id));
    assert.equal(w.instance, evidence.bindingInstance); assert.equal(w.case, caseKey); assert.equal(w.action, row.action.id);
    for (const [key, expected] of Object.entries({ window: w.id, instance: w.instance, case: caseKey, action: row.action.id,
      context: w.native.context, uniqueId: w.native.uniqueId, frame: w.native.frame,
      realm: w.resources.realm, scope: w.resources.scope, form: w.form.backendNodeId })) assert.equal(o[key], expected);
    assert.ok(text(w.native.uniqueId) && text(w.native.frame) && text(w.resources.realm) && text(w.resources.scope) && text(w.resources.observer));
    assert.ok(Number.isInteger(w.form.backendNodeId) && w.form.backendNodeId > 0);
    assert.equal(w.form.selector, bindingFormSelector);
    assert.equal(enhancement.bindingProof.links.executionContextId, w.native.context);
    assert.equal(enhancement.bindingProof.links.formConstruction.form, w.form.backendNodeId);
    assert.ok(times(evidence.clock.startedAt + row.at, w.startedAt, w.resources.at, w.form.observedAt,
      o.startedAt, o.finishedAt, w.finishedAt, row.dispatchStartedAt));
    const construction = enhancement.bindingProof.links.formConstruction;
    assert.ok(times(o.startedAt, construction.startedAt, construction.finishedAt, o.finishedAt));
    assert.ok(times(j.boundaries.applicationStartedAt, w.startedAt, row.dispatchStartedAt, row.resourcesAtDOM.at, j.boundaries.endedAt));
    assert.deepEqual(w.target, j.target);
    assert.ok(text(w.target.target) && text(w.target.context));
    assert.equal(j.realms.filter((r) => isDeepStrictEqual(r, w.native)).length, 1);
    assert.equal(w.native.realm, w.resources.realm);
    assert.ok(times(w.native.observedAt, w.resources.at));
    const created = j.events.filter((e) => e.event === "Runtime.executionContextCreated" && e.uniqueId === w.native.uniqueId);
    assert.equal(created.length, 1);
    assert.equal(created[0].context, w.native.context); assert.equal(created[0].frame, w.native.frame); assert.equal(created[0].default, true);
    assert.ok(times(created[0].receivedAt, w.startedAt));
    const dispatches = j.events.filter((e) => e.event === "Network.requestWillBeSent" && e.method === "POST" && e.path === enhancement.path
      && e.frame === w.native.frame && e.loader === w.native.loader && e.receivedAt >= row.dispatchStartedAt && e.receivedAt <= row.resourcesAtDOM.at);
    assert.equal(dispatches.length, 1);
    assert.ok(!j.events.some((e) => e.receivedAt >= created[0].receivedAt && e.receivedAt <= dispatches[0].receivedAt
      && (e.event === "Runtime.executionContextDestroyed" && (e.context === w.native.context || e.uniqueId === w.native.uniqueId)
        || e.event === "Runtime.executionContextsCleared" || e.event === "Page.frameDetached" && e.frame === w.native.frame)));
    const receipts = j.events.filter((e) => e.event === "binding-observation" && (e.capture === o.id || e.window?.id === w.id));
    assert.equal(receipts.length, 1); assert.equal(receipts[0].capture, o.id); assert.deepEqual(receipts[0].window, w);
    assert.ok(times(w.finishedAt, receipts[0].receivedAt, row.dispatchStartedAt));
    for (const [phase, native, host, before] of [["before", o.nativeStartedAt, o.startedAt, true], ["after", o.nativeFinishedAt, o.finishedAt, false]]) {
      const samples = j.events.filter((e) => e.event === "native-clock-sample" && e.phase === `binding-${w.id}-${phase}-native-clock`);
      assert.equal(samples.length, 1); const s = samples[0];
      assert.ok(times(w.startedAt, s.startedAt, s.receivedAt, w.finishedAt));
      assert.ok(before ? times(s.receivedAt, host) && times(s.at, native) : times(host, s.startedAt) && times(native, s.at));
    }
    assert.ok(times(o.nativeStartedAt, o.nativeFinishedAt));
    assert.equal(evidence.steps.filter((r) => r.bindingWindow?.id === w.id).length, 1);
    assert.equal(evidence.steps.filter((r) => r.formBefore?.enhancement?.bindingProof?.links?.observation?.id === o.id).length, 1);
    return true;
  } catch { return false; }
}

export function replayActionBinding(enhancement, artifact, evidence, row, caseKey) {
  return validateBindingWindow(enhancement, evidence, row, caseKey) && replayBindingProof(enhancement, artifact);
}
