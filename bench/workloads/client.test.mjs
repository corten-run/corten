import assert from "node:assert/strict";
import test from "node:test";
import { selectedApps } from "./registry.mjs";
import { clientCaptureSchema, clientSnapshot, createClientWorkload, validateClientCapture } from "./client.mjs";

const options = () => ({ seed: 7, rowCount: 14, largeRowCount: 110, appendCount: 7, dashboardCount: 24 });
const zero = () => ({ subscriptions: 0, connections: 0, listeners: 0, timers: 0, pendingTasks: 0 });
const settings = () => ({ maxCleanupMs: 10, cleanupObservationMs: 5 });

// Synthetic unit-test observations, never framework evidence. The state is independently
// mutated below; the validator's clientSnapshot is not used to construct a passing trace.
function fixture(app = "corten") {
  const workload = createClientWorkload(options()), records = [];
  let rows = structuredClone(workload.initial.rows), cards = structuredClone(workload.initial.cards);
  let nextId = rows.length + 1, tick = 0, selected = null, filter = "", direction = null, at = 0, observation = 0, nodeId = 0;
  let priorNodes = new Map();
  const add = (kind, fields = {}) => records.push({ kind, at: ++at, ...structuredClone(fields) });
  const observe = () => {
    let visible = rows.filter((r) => r.label.includes(filter));
    if (direction) visible = [...visible].sort((a, b) => direction === "asc" ? +a.id.slice(4) - +b.id.slice(4) : +b.id.slice(4) - +a.id.slice(4));
    const current = new Map();
    const nodes = (list) => list.map((r) => { const node = priorNodes.get(r.id) ?? `node-${++nodeId}`; current.set(r.id, node); return { ...r, node }; });
    const dom = { id: `dom-${++observation}`, rows: nodes(visible), selected: visible.some((r) => r.id === selected) ? selected : null,
      cards: nodes(cards), totalMinor: cards.reduce((sum, r) => sum + r.priceMinor, 0) };
    priorNodes = current; return dom;
  };
  const make = (count) => Array.from({ length: count }, () => { const id = nextId++; return { id: `row-${id}`, label: `group-${(7 + id) % 7} row-${id}` }; });
  add("resources", { owned: zero() });
  add("initial", { data: workload.initial, dom: observe(), errors: [] });
  add("resources", { owned: { ...zero(), listeners: 2, subscriptions: 1 } });
  for (const op of workload.operations) {
    if (op.kind === "update-tenth") for (let i = 0; i < rows.length; i += 10) rows[i].label += " !!!";
    if (op.kind === "select") selected = op.key;
    if (op.kind === "swap") { const other = rows.length - 2, temp = rows[1]; rows[1] = rows[other]; rows[other] = temp; }
    if (op.kind === "filter") filter = op.text;
    if (op.kind === "sort") direction = op.direction;
    if (op.kind === "remove") { rows.splice(rows.findIndex((r) => r.id === op.key), 1); if (selected === op.key) selected = null; }
    if (op.kind === "patch-one") rows[rows.length >> 1].label += " *";
    if (op.kind === "patch-many") for (let i = 0; i < rows.length && i < 100; i++) rows[(i * (rows.length % 97 === 0 ? 1 : 97)) % rows.length].label += " *";
    if (op.kind === "append") rows.push(...make(workload.appendCount));
    if (["clear", "create-small", "replace-small", "create-large"].includes(op.kind)) {
      rows = op.kind === "clear" ? [] : make(op.kind === "create-large" ? workload.largeRowCount : workload.rowCount);
      selected = null; filter = ""; direction = null;
    }
    if (op.kind === "tick") {
      tick++;
      const indices = Array.from({ length: op.count }, (_, k) => (k + tick) % cards.length);
      cards = cards.map((r, i) => indices.includes(i) ? { ...r, priceMinor: 10000 + (i % 17) * 100 + tick * 13 + i } : r);
    }
    add("operation", { operation: op, dom: observe(), network: [], errors: [] });
  }
  add("detach"); add("resources", { owned: zero() });
  add("cleanup-probe", { input: workload.cleanupProbe, network: [] }); add("resources", { owned: zero() });
  at += settings().cleanupObservationMs;
  add("state", { dom: observe(), owned: zero(), network: [], errors: [] });
  return { workload, capture: { schema: clientCaptureSchema, app, effectiveWorkload: workload, outcome: "captured", reason: null, records }, settings: settings() };
}
const validate = (f, normalize) => validateClientCapture(f.workload, f.capture, f.settings, normalize);
const operation = (f, kind) => f.capture.records.find((r) => r.kind === "operation" && r.operation.kind === kind);

test("deterministic fixture retains loaded rows, all row/dashboard operations and explicit legacy sizes", () => {
  const w = createClientWorkload(options());
  assert.deepEqual(w, createClientWorkload(options()));
  assert.notEqual(w.sha256, createClientWorkload({ ...options(), seed: 8 }).sha256);
  assert.equal(w.operations.length, 19);
  for (const kind of ["update-tenth", "select", "swap", "remove", "create-small", "replace-small", "create-large", "append", "clear", "patch-one", "patch-many", "filter", "sort", "tick"]) {
    assert.ok(w.operations.some((op) => op.kind === kind));
  }
  const large = createClientWorkload({ seed: 7, rowCount: 1000, largeRowCount: 10000, appendCount: 1000, dashboardCount: 200 });
  assert.equal(large.initial.rows.length, 1000); assert.equal(large.initial.cards.length, 200);
  assert.equal(clientSnapshot(large, 14).rows.length, 10000);
  assert.equal(clientSnapshot(large).rows.length, 0);
  const prime = createClientWorkload({ ...options(), largeRowCount: 97 });
  const before = clientSnapshot(prime, 15).rows, after = clientSnapshot(prime, 16).rows;
  assert.equal(after.filter((r, i) => r.label !== before[i].label).length, 97, "many-row patch must touch distinct keys");
  assert.deepEqual(createClientWorkload(Object.fromEntries(Object.entries(options()).reverse())), w);
});

test("all selected client frameworks can supply the same actual state without claiming qualification", () => {
  for (const app of selectedApps("client-heavy")) {
    const result = validate(fixture(app));
    assert.equal(result.functionalPassed, true); assert.equal(result.readyForLoad, false); assert.equal(result.observedOperations, 19);
    assert.equal(Object.hasOwn(result, "timingMs"), false);
  }
});

test("unsupported/not-run/failed stay explicit without fabricated zero operations", () => {
  for (const outcome of ["unsupported", "not-run", "failed"]) {
    const f = fixture(); Object.assign(f.capture, { outcome, reason: "No native capture supplied", records: null });
    const result = validate(f);
    assert.equal(result.outcome, outcome); assert.equal(result.observedOperations, null); assert.equal(result.readyForLoad, false);
    assert.equal(result.functionalPassed, outcome === "failed" ? false : null);
    f.capture.records = []; assert.throws(() => validate(f), /client contract:/);
  }
});

test("early zero resource counters cannot replace a fresh terminal resource observation", () => {
  const f = fixture(), probe = f.capture.records.find((r) => r.kind === "cleanup-probe");
  f.capture.records.at(-2).at = probe.at + 0.001;
  f.capture.records.at(-1).at = probe.at + 100000;
  delete f.capture.records.at(-1).owned;
  assert.throws(() => validate(f), /client contract:/);
});

test("fresh terminal resource counts and DOM can establish quiescence after a long observation interval", () => {
  const f = fixture(), probe = f.capture.records.find((r) => r.kind === "cleanup-probe");
  f.capture.records.at(-2).at = probe.at + 0.001;
  f.capture.records.at(-1).at = probe.at + 100000;
  const result = validate(f);
  assert.equal(result.functionalPassed, true); assert.equal(result.readyForLoad, false);
});

const mutations = {
  "wrong loaded data": (f) => { f.capture.records.find((r) => r.kind === "initial").data.rows[0].label = "unequal"; },
  "static shell": (f) => { f.capture.records.find((r) => r.kind === "initial").dom.rows = []; },
  "manufactured ready flag": (f) => { f.capture.records.find((r) => r.kind === "initial").dom = { ready: true }; },
  "wrong update": (f) => { operation(f, "update-tenth").dom.rows[0].label += " wrong"; },
  "duplicate row": (f) => { operation(f, "append").dom.rows.push(structuredClone(operation(f, "append").dom.rows[0])); },
  "missing row": (f) => { operation(f, "append").dom.rows.pop(); },
  "wrong selection": (f) => { operation(f, "select").dom.selected = null; },
  "wrong sort order": (f) => { operation(f, "sort").dom.rows.reverse(); },
  "wrong filter": (f) => { operation(f, "filter").dom.rows = []; },
  "wrong keyed identity": (f) => { operation(f, "swap").dom.rows[0].node = "recreated-node"; },
  "duplicate observer node": (f) => { operation(f, "swap").dom.rows[0].node = operation(f, "swap").dom.rows[1].node; },
  "node moved to different key": (f) => { const rows = operation(f, "swap").dom.rows; [rows[0].node, rows[1].node] = [rows[1].node, rows[0].node]; },
  "wrong dashboard value": (f) => { operation(f, "tick").dom.cards[0].priceMinor++; },
  "manufactured dashboard total": (f) => { operation(f, "tick").dom.totalMinor++; },
  "operation HTTP": (f) => { operation(f, "select").network.push({ method: "GET", path: "/rows" }); },
  "failed HTTP also counts": (f) => { operation(f, "select").network.push({ transport: "websocket", error: "refused" }); },
  "browser error": (f) => { operation(f, "select").errors.push("pageerror"); },
  "missing operation": (f) => { f.capture.records.splice(4, 1); },
  "duplicate operation": (f) => { f.capture.records[5].operation = structuredClone(f.capture.records[4].operation); },
  "out-of-order operation": (f) => { f.capture.records[4].operation = structuredClone(f.capture.records[5].operation); },
  "backwards observation clock": (f) => { f.capture.records[4].at = 0; },
  "missing baseline": (f) => { f.capture.records.shift(); },
  "missing cleanup": (f) => { f.capture.records = f.capture.records.filter((r) => r.kind !== "detach"); },
  "cleanup flag not evidence": (f) => { f.capture.records.find((r) => r.kind === "cleanup-probe").cleanup = true; },
  "wrong cleanup probe": (f) => { f.capture.records.find((r) => r.kind === "cleanup-probe").input.count--; },
  "cleanup HTTP": (f) => { f.capture.records.find((r) => r.kind === "cleanup-probe").network.push({ method: "POST" }); },
  "post-detach mutation": (f) => { f.capture.records.at(-1).dom.cards[0].priceMinor++; },
  "insufficient observation window": (f) => { f.capture.records.at(-1).at -= 5; },
  "leaked subscription": (f) => { for (const r of f.capture.records.filter((r) => r.kind === "resources").slice(-2)) r.owned.subscriptions = 1; },
  "resurrected timer": (f) => { f.capture.records.filter((r) => r.kind === "resources").at(-1).owned.timers = 1; },
  "missing post-probe counters": (f) => { f.capture.records.splice(-2, 1); },
  "missing terminal resource sample": (f) => { delete f.capture.records.at(-1).owned; },
  "terminal resource leak hidden by early zero counters": (f) => { f.capture.records.at(-1).owned.timers = 1; },
  "observations after terminal state": (f) => { f.capture.records.push({ kind: "resources", at: f.capture.records.at(-1).at + 1, owned: zero() }); },
  "unknown app": (f) => { f.capture.app = "vanilla"; },
  "corrupt workload": (f) => { f.workload.operations.pop(); },
  "extra metrics": (f) => { f.capture.timingMs = 0; },
};
for (const [name, mutate] of Object.entries(mutations)) test(`rejects ${name}`, () => {
  const f = fixture(); mutate(f); assert.throws(() => validate(f), /client contract:/);
});

test("normalizer gets copies and cannot skip observations", () => {
  const f = fixture(), saved = structuredClone(f.capture);
  validate(f, (r) => { r.unused = 1; delete r.unused; return r; }); assert.deepEqual(f.capture, saved);
  assert.throws(() => validate(f, () => null), /client contract:/);
});

test("bad fixture/cleanup inputs are not silently defaulted", () => {
  for (const changes of [{ seed: -1 }, { rowCount: 3 }, { largeRowCount: 1 }, { appendCount: 0 }, { dashboardCount: 0 }, { rate: 150 }]) {
    assert.throws(() => createClientWorkload({ ...options(), ...changes }), /client contract:/);
  }
  const f = fixture(); f.settings.maxCleanupMs = 0; assert.throws(() => validate(f), /client contract:/);
});
