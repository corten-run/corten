// Synthetic test support only; never native execution evidence.
import { createClientWorkload, validateClientCapture } from "../workloads/client.mjs";
export const workload = createClientWorkload({ seed: 7, rowCount: 8, largeRowCount: 10, appendCount: 1, dashboardCount: 2 });
export const settings = { maxCleanupMs: 10, cleanupObservationMs: 5 };
const zero = () => ({ subscriptions: 0, connections: 0, listeners: 0, timers: 0, pendingTasks: 0 });
// Independent synthetic reducer for adversarial unit coverage, NOT native evidence.
export function fixturePass(app = "react", measured = true) {
  const records = [];
  let rows = structuredClone(workload.initial.rows), cards = structuredClone(workload.initial.cards);
  let next = rows.length + 1, selected = null, filter = "", direction = null, tick = 0, at = 0, id = 0;
  const add = (kind, fields = {}) => records.push({ kind, at: ++at, ...structuredClone(fields) });
  const make = (n) => Array.from({ length: n }, () => { const i = next++; return { id: `row-${i}`, label: `group-${(7 + i) % 7} row-${i}` }; });
  const dom = () => {
    let visible = rows.filter((r) => r.label.includes(filter));
    if (direction) visible = [...visible].sort((a, b) => (direction === "asc" ? 1 : -1) * (+a.id.slice(4) - +b.id.slice(4)));
    return { id: `dom-${++id}`, rows: visible.map((r) => ({ ...r, node: `node-${r.id}` })),
      selected: visible.some((r) => r.id === selected) ? selected : null,
      cards: cards.map((r) => ({ ...r, node: `node-${r.id}` })), totalMinor: cards.reduce((s, c) => s + c.priceMinor, 0) };
  };
  add("resources", { owned: zero() }); add("initial", { data: workload.initial, dom: dom(), errors: [] });
  add("resources", { owned: { ...zero(), subscriptions: 1, listeners: 1 } });
  for (const op of workload.operations) {
    if (op.kind === "update-tenth") rows.forEach((r, i) => { if (!(i % 10)) r.label += " !!!"; });
    if (op.kind === "select") selected = op.key;
    if (op.kind === "swap") [rows[1], rows[rows.length - 2]] = [rows[rows.length - 2], rows[1]];
    if (op.kind === "filter") filter = op.text;
    if (op.kind === "sort") direction = op.direction;
    if (op.kind === "remove") rows = rows.filter((r) => r.id !== op.key);
    if (op.kind === "patch-one") rows[Math.floor(rows.length / 2)].label += " *";
    if (op.kind === "patch-many") for (let i = 0; i < Math.min(100, rows.length); i++) rows[i * (rows.length % 97 ? 97 : 1) % rows.length].label += " *";
    if (op.kind === "append") rows.push(...make(workload.appendCount));
    if (["clear", "create-small", "replace-small", "create-large"].includes(op.kind)) {
      rows = op.kind === "clear" ? [] : make(op.kind === "create-large" ? workload.largeRowCount : workload.rowCount);
      selected = null; filter = ""; direction = null;
    }
    if (op.kind === "tick") { tick++; for (let k = 0; k < op.count; k++) { const i = (k + tick) % cards.length; cards[i].priceMinor = 10000 + (i % 17) * 100 + tick * 13 + i; } }
    add("operation", { operation: op, dom: dom(), network: [], errors: [] });
  }
  add("detach"); add("resources", { owned: zero() }); add("cleanup-probe", { input: workload.cleanupProbe, network: [] }); add("resources", { owned: zero() });
  at += settings.cleanupObservationMs; add("state", { dom: dom(), owned: zero(), network: [], errors: [] });
  const capture = { schema: "client-capture/v1", app, effectiveWorkload: workload, outcome: "captured", reason: null, records };
  return { capture, oracle: validateClientCapture(workload, capture, settings), readyMs: 1,
    actions: measured ? workload.operations.map((op) => ({ operation: op.id, kind: op.kind, elapsedMs: 0.25 })) : null,
    resourceDetails: [], failure: null, requests: [],
    timing: { schema: "client-heavy-timing/v1", clock: "browser-performance", timeOrigin: 1000,
      mount: { startedAt: 1, endedAt: 2, recordAt: 2, recordIndex: 1 },
      operations: workload.operations.map((op, i) => ({ operation: op.id, startedAt: 3 + i, endedAt: 3.25 + i, timeOrigin: 1000, recordAt: 4 + i, recordIndex: 3 + i })) },
    lifecycle: { clock: "node-performance", timeOrigin: 1000, contextCreatedAt: 0,
      close: { resource: "context", startedAt: 101, endedAt: 102, returned: true, observed: true, failure: null },
      deadline: { timeoutMs: 30000, scheduledAt: 1, firedAt: null, aborted: false, cancelledAt: 100 } } };
}
