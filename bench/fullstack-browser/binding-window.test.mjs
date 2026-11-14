// Receipt-shape controls only, never a fabricated qualification capture.
import test from "node:test";
import assert from "node:assert/strict";
import { bindingFormSelector, validateBindingWindow, replayActionBinding, validateBindingClockPhase } from "./binding-window.mjs";

function fixture() {
  const native = { realm: "realm", context: 2, uniqueId: "native-context", frame: "native-frame", loader: "native-loader", observedAt: 122 };
  const target = { target: "native-target", context: "browser-context", type: "page" };
  const window = { id: "window", instance: "case-instance", case: "case", action: "submit", startedAt: 120, finishedAt: 133,
    resources: { observer: "resource-observer", realm: "realm", scope: "scope", at: 123 }, native, target,
    form: { backendNodeId: 8, observedAt: 124, selector: bindingFormSelector } };
  const observation = { id: "capture", window: "window", instance: "case-instance", case: "case", action: "submit",
    context: 2, uniqueId: "native-context", frame: "native-frame", realm: "realm", scope: "scope", form: 8,
    startedAt: 125, finishedAt: 130, nativeStartedAt: 201, nativeFinishedAt: 202 };
  const enhancement = { path: "/api/marketplace/item_2", bindingProof: { links: { observation, executionContextId: 2,
    formConstruction: { form: 8, startedAt: 126, finishedAt: 127 } } } };
  const row = { action: { id: "submit" }, at: 10, bindingWindow: window, dispatchStartedAt: 135, resourcesAtDOM: { at: 140 }, formBefore: { enhancement } };
  const evidence = { bindingInstance: "case-instance", clock: { startedAt: 100 }, steps: [row], platformLifecycle: {
    boundaries: { applicationStartedAt: 108, endedAt: 150 }, target: structuredClone(target), realms: [structuredClone(native)], events: [
      { event: "Runtime.executionContextCreated", context: 2, uniqueId: "native-context", frame: "native-frame", default: true, receivedAt: 105 },
      { event: "native-clock-sample", phase: "binding-window-before-native-clock", startedAt: 120.5, receivedAt: 121, at: 200 },
      { event: "native-clock-sample", phase: "binding-window-after-native-clock", startedAt: 131, receivedAt: 132, at: 203 },
      { event: "binding-observation", capture: "capture", window: structuredClone(window), receivedAt: 134 },
      { event: "Network.requestWillBeSent", method: "POST", path: "/api/marketplace/item_2", frame: "native-frame", loader: "native-loader", receivedAt: 136 },
    ],
  } };
  return evidence;
}

test("binding windows reject stale, transplanted and incomplete native receipts", async (t) => {
  const good = fixture();
  assert.equal(validateBindingWindow(good.steps[0].formBefore.enhancement, good, good.steps[0], "case"), true);
  assert.equal(replayActionBinding(good.steps[0].formBefore.enhancement, null, good, good.steps[0], "case"), false, "Chronology alone cannot supply emitted effects");
  const mutations = [
    ["missing window", (e, r) => { delete r.bindingWindow; }],
    ["missing observation", (e, r, o) => { delete r.formBefore.enhancement.bindingProof.links.observation; }],
    ["different instance", (e) => { e.bindingInstance = "other"; }],
    ["different case", (e, r) => { r.bindingWindow.case = "other"; }],
    ["different action", (e, r) => { r.action.id = "later-submit"; }],
    ["later action same handler", (e, r) => { r.at = 34; }],
    ["different form", (e, r) => { r.bindingWindow.form.backendNodeId++; }],
    ["different form scope", (e, r) => { r.bindingWindow.resources.scope = "other"; }],
    ["different resource realm", (e, r) => { r.bindingWindow.resources.realm = "other"; }],
    ["different unique context", (e, r) => { r.bindingWindow.native.uniqueId = "other"; }],
    ["different target", (e) => { e.platformLifecycle.target.target = "other"; }],
    ["different browser context", (e) => { e.platformLifecycle.target.context = "other"; }],
    ["different linked execution context", (e, r) => { r.formBefore.enhancement.bindingProof.links.executionContextId++; }],
    ["missing native creation", (e) => { e.platformLifecycle.events.shift(); }],
    ["duplicate native creation", (e) => { e.platformLifecycle.events.push(structuredClone(e.platformLifecycle.events[0])); }],
    ["destroyed context", (e) => { e.platformLifecycle.events.push({ event: "Runtime.executionContextDestroyed", context: 2, receivedAt: 129 }); }],
    ["cleared contexts", (e) => { e.platformLifecycle.events.push({ event: "Runtime.executionContextsCleared", receivedAt: 129 }); }],
    ["detached frame", (e) => { e.platformLifecycle.events.push({ event: "Page.frameDetached", frame: "native-frame", receivedAt: 129 }); }],
    ["no realm association", (e) => { e.platformLifecycle.realms = []; }],
    ["missing journal receipt", (e) => { e.platformLifecycle.events.splice(3, 1); }],
    ["duplicate journal receipt", (e) => { e.platformLifecycle.events.push(structuredClone(e.platformLifecycle.events[3])); }],
    ["different journal capture", (e) => { e.platformLifecycle.events[3].capture = "other"; }],
    ["duplicate row capture", (e) => { e.steps.push(structuredClone(e.steps[0])); }],
    ["missing native sample", (e) => { e.platformLifecycle.events.splice(1, 1); }],
    ["future native capture", (e, r, o) => { o.nativeFinishedAt = 3800; }],
    ["reversed native capture", (e, r, o) => { o.nativeStartedAt = 202.5; }],
    ["capture after dispatch", (e, r, o) => { o.finishedAt = 136; }],
    ["capture before form observation", (e, r, o) => { o.startedAt = 123.5; }],
    ["FormData observation outside capture", (e, r) => { r.formBefore.enhancement.bindingProof.links.formConstruction.finishedAt = 131; }],
    ["capture after lifecycle window", (e) => { e.platformLifecycle.boundaries.endedAt = 130; }],
    ["dispatch after action observation", (e, r) => { r.resourcesAtDOM.at = 132; }],
    ["missing native dispatch", (e) => { e.platformLifecycle.events.pop(); }],
    ["duplicate native dispatch", (e) => { e.platformLifecycle.events.push(structuredClone(e.platformLifecycle.events.at(-1))); }],
    ["dispatch from different frame", (e) => { e.platformLifecycle.events.at(-1).frame = "other"; }],
    ["dispatch from different loader", (e) => { e.platformLifecycle.events.at(-1).loader = "other"; }],
    ["dispatch outside action", (e) => { e.platformLifecycle.events.at(-1).receivedAt = 141; }],
    ["context dies before native dispatch", (e) => { e.platformLifecycle.events.push({ event: "Runtime.executionContextDestroyed", context: 2, receivedAt: 135.5 }); }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, () => {
    const e = structuredClone(fixture()), r = e.steps[0], enhancement = r.formBefore.enhancement;
    mutate(e, r, enhancement.bindingProof.links.observation);
    assert.equal(validateBindingWindow(enhancement, e, r, "case"), false);
  });
});

test("binding clock phases require a unique action window and native envelope", async (t) => {
  const setup = () => {
    const e = fixture(), j = e.platformLifecycle;
    j.events.unshift({ event: "native-clock-sample", phase: "initial-native-clock", startedAt: 100, receivedAt: 100.5, at: 195 });
    j.events.push({ event: "native-clock-sample", phase: "terminal-native-clock", startedAt: 145, receivedAt: 146, at: 205 });
    return e;
  };
  const check = (e) => {
    const j = e.platformLifecycle, samples = j.events.filter((r) => r.phase?.startsWith("binding-"));
    return samples.length === 2 && samples.every((r) => validateBindingClockPhase(r, e, "case", j));
  };
  assert.equal(check(setup()), true);
  for (const [name, mutate] of [
    ["unknown window", (e) => { e.steps[0].bindingWindow.id = "other"; }],
    ["wrong instance", (e) => { e.bindingInstance = "other"; }],
    ["wrong case", (e) => { e.steps[0].bindingWindow.case = "other"; }],
    ["wrong action", (e) => { e.steps[0].action.id = "other"; }],
    ["duplicate window", (e) => { e.steps.push(structuredClone(e.steps[0])); }],
    ["unknown phase", (e) => { e.platformLifecycle.events.find((r) => r.phase?.startsWith("binding-")).phase = "binding-window-middle-native-clock"; }],
    ["duplicate phase", (e) => { e.platformLifecycle.events.find((r) => r.phase === "binding-window-after-native-clock").phase = "binding-window-before-native-clock"; }],
    ["wrong journal capture", (e) => { e.platformLifecycle.events.find((r) => r.event === "binding-observation").capture = "other"; }],
    ["wrong context", (e) => { e.platformLifecycle.events.find((r) => r.event === "Runtime.executionContextCreated").uniqueId = "other"; }],
    ["destroyed context", (e) => { e.platformLifecycle.events.push({ event: "Runtime.executionContextDestroyed", context: 2, receivedAt: 129 }); }],
    ["future native samples", (e) => { e.platformLifecycle.events.filter((r) => r.phase?.startsWith("binding-")).forEach((r) => { r.at += 3600; }); }],
    ["missing outer native envelope", (e) => { e.platformLifecycle.events.pop(); }],
    ["sample after dispatch", (e) => { e.platformLifecycle.events.find((r) => r.phase === "binding-window-after-native-clock").receivedAt = 136; }],
  ]) await t.test(name, () => { const e = setup(); mutate(e); assert.equal(check(e), false); });
});
