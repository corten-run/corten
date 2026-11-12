// Offline application-state oracle. No browser runner, qualification or timing result.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { contractSha256, selectedApps } from "./registry.mjs";

export const clientWorkloadSchema = "client-workload/v1";
export const clientCaptureSchema = "client-capture/v1";
const need = (ok, message) => { if (!ok) throw new Error(`client contract: ${message}`); };
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = isDeepStrictEqual;
const exact = (v, keys) => need(object(v) && same(Object.keys(v).sort(), [...keys].sort()), "missing or unexpected fields");
const integer = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const resourceKeys = ["subscriptions", "connections", "listeners", "timers", "pendingTasks"];
const resources = (v) => { exact(v, resourceKeys); need(resourceKeys.every((k) => integer(v[k])), "invalid owned resource counts"); };
const zero = (v) => resourceKeys.every((k) => v[k] === 0);
const row = (seed, id) => ({ id: `row-${id}`, label: `group-${(seed + id) % 7} row-${id}` });
const card = (i) => ({ id: `card-${i}`, priceMinor: 10000 + i % 17 * 100 });

/** A new functional fixture, not a replacement for historical js-framework-benchmark numbers.
 * All counts are explicit runner inputs; 1k/10k/append-1k/200 reproduce the old case sizes.
 * Native apps must load these same records and implement the operations themselves.
 */
export function createClientWorkload(options) {
  exact(options, ["seed", "rowCount", "largeRowCount", "appendCount", "dashboardCount"]);
  const { seed, rowCount, largeRowCount, appendCount, dashboardCount } = options;
  need(integer(seed, 0, 0xffffffff), "uint32 seed required");
  need(integer(rowCount, 8, 10000) && integer(largeRowCount, rowCount, 20000)
    && integer(appendCount, 1, 10000) && integer(dashboardCount, 2, 1000), "explicit bounded fixture sizes required");
  const initial = { rows: Array.from({ length: rowCount }, (_, i) => row(seed, i + 1)), cards: Array.from({ length: dashboardCount }, (_, i) => card(i)) };
  const operations = [
    { kind: "update-tenth" }, { kind: "select", key: "row-2" }, { kind: "swap" },
    { kind: "filter", text: initial.rows[0].label.split(" ")[0] }, { kind: "sort", direction: "desc" },
    { kind: "filter", text: "" }, { kind: "sort", direction: "asc" }, { kind: "remove", key: "row-4" },
    { kind: "patch-many" }, { kind: "append" }, { kind: "clear" }, { kind: "create-small" },
    { kind: "replace-small" }, { kind: "create-large" }, { kind: "patch-one" }, { kind: "patch-many" },
    { kind: "tick", count: Math.min(20, dashboardCount) }, { kind: "tick", count: dashboardCount }, { kind: "clear" },
  ].map((operation, index) => ({ id: `operation-${index}`, ...operation }));
  const spec = { schema: clientWorkloadSchema, group: "client-heavy", contractSha256: contractSha256("client-heavy"), seed, rowCount, largeRowCount, appendCount, dashboardCount,
    initial, operations, cleanupProbe: { kind: "tick", count: dashboardCount } };
  return { ...spec, sha256: hash(spec) };
}

function checkedWorkload(workload) {
  need(object(workload), "effective workload required");
  const { seed, rowCount, largeRowCount, appendCount, dashboardCount } = workload;
  const expected = createClientWorkload({ seed, rowCount, largeRowCount, appendCount, dashboardCount });
  need(same(workload, expected), "corrupt or incompatible effective workload");
  return expected;
}

/** Reference reduction only. Never use this helper to manufacture native DOM observations. */
export function clientSnapshot(workload, through = workload.operations.length) {
  checkedWorkload(workload);
  need(integer(through, 0, workload.operations.length), "invalid operation boundary");
  let rows = structuredClone(workload.initial.rows), selected = null, filter = "", order = null;
  let nextId = rows.length + 1, ticks = 0;
  const cards = structuredClone(workload.initial.cards);
  const make = (count) => Array.from({ length: count }, () => row(workload.seed, nextId++));
  for (const op of workload.operations.slice(0, through)) {
    switch (op.kind) {
      case "update-tenth": rows.forEach((r, i) => { if (i % 10 === 0) r.label += " !!!"; }); break;
      case "select": selected = op.key; break;
      case "swap": [rows[1], rows[rows.length - 2]] = [rows[rows.length - 2], rows[1]]; break;
      case "filter": filter = op.text; break;
      case "sort": order = op.direction; break;
      case "remove": rows = rows.filter((r) => r.id !== op.key); if (selected === op.key) selected = null; break;
      case "patch-one": rows[Math.floor(rows.length / 2)].label += " *"; break;
      case "patch-many": for (let i = 0; i < Math.min(100, rows.length); i++) rows[i * (rows.length % 97 ? 97 : 1) % rows.length].label += " *"; break;
      case "append": rows.push(...make(workload.appendCount)); break;
      case "clear": rows = []; selected = null; filter = ""; order = null; break;
      case "create-small": case "replace-small": case "create-large":
        rows = make(op.kind === "create-large" ? workload.largeRowCount : workload.rowCount); selected = null; filter = ""; order = null; break;
      case "tick":
        ticks++;
        for (let k = 0; k < op.count; k++) { const i = (k + ticks) % cards.length; cards[i].priceMinor = card(i).priceMinor + ticks * 13 + i; }
        break;
    }
  }
  let visible = rows.filter((r) => r.label.includes(filter));
  if (order) visible = [...visible].sort((a, b) => (order === "asc" ? 1 : -1) * (Number(a.id.slice(4)) - Number(b.id.slice(4))));
  return { rows: visible, selected: visible.some((r) => r.id === selected) ? selected : null, cards,
    totalMinor: cards.reduce((total, r) => total + r.priceMinor, 0) };
}

/**
 * Each record is a saved harness observation, not an app's ready/cleanup flag. `initial`
 * carries the independently captured loaded data and a DOM extraction; `operation` carries
 * the dispatched input and the subsequent DOM. DOM row/card `node` tokens come from the
 * observer's WeakMap, not data attributes. Surviving visible keys retain their node across
 * updates/reorder. Filtering may unmount hidden keys normally. `network` is the complete
 * observer ledger for that interval (including failed HTTP, fetch, WS, beacon and navigation).
 * It must stay empty during local operations AND the cleanup probe.
 *
 * Baseline/active/after-detach resources are journey-owned counts, not global heap guesses.
 * Detach, an independently dispatched store tick, zero resources and unchanged DOM after
 * the reviewed observation interval prove bounded quiescence. The adapter must actually
 * instrument all resource classes; the oracle cannot authenticate a fabricated trace.
 * The terminal state carries fresh `owned` counts captured alongside its DOM, not an
 * earlier resource sample reused after the observation interval.
 * No raw cookies, CSRF, request bodies or arbitrary error text belong in the capture.
 */
export function validateClientCapture(workload, capture, settings, normalize = (record) => record) {
  checkedWorkload(workload);
  exact(settings, ["maxCleanupMs", "cleanupObservationMs"]);
  need(Object.values(settings).every((v) => Number.isFinite(v) && v > 0), "positive cleanup bounds required");
  exact(capture, ["schema", "app", "effectiveWorkload", "outcome", "reason", "records"]);
  need(capture.schema === clientCaptureSchema && same(capture.effectiveWorkload, workload), "wrong capture/workload identity");
  need(selectedApps("client-heavy").includes(capture.app), "unselected client adapter");
  need(["captured", "unsupported", "not-run", "failed"].includes(capture.outcome), "unknown capture outcome");
  const result = { schema: clientCaptureSchema, app: capture.app, workloadSha256: workload.sha256, outcome: capture.outcome,
    functionalPassed: null, observedOperations: null, readyForLoad: false,
    scope: "Offline correctness evidence only; no native qualification, browser timing or load readiness is certified." };
  if (capture.outcome !== "captured") {
    need(capture.records === null && typeof capture.reason === "string" && capture.reason.trim(), "unavailable/failed capture needs reason and no invented observations");
    return { ...result, functionalPassed: capture.outcome === "failed" ? false : null, reason: capture.reason };
  }
  need(capture.reason === null && Array.isArray(capture.records) && typeof normalize === "function", "capture records required");
  let lastAt = -1, initialized = false, step = 0, detached = false, detachedAt = null, probeAt = null, quiescent = false;
  let owned = null, resourceAt = -1, released = false, previous = null;
  const nodes = new Map(), ids = new Set();
  const dom = (observed, expected) => {
    exact(observed, ["id", "rows", "selected", "cards", "totalMinor"]);
    need(typeof observed.id === "string" && observed.id && !ids.has(observed.id), "duplicate/missing DOM observation"); ids.add(observed.id);
    const tokens = new Set();
    const strip = (list, kind) => {
      need(Array.isArray(list), "DOM rows required");
      const prior = new Map((previous?.[kind === "row" ? "rows" : "cards"] ?? []).map((r) => [r.id, r]));
      return list.map((r) => {
        exact(r, kind === "row" ? ["id", "label", "node"] : ["id", "priceMinor", "node"]);
        need(typeof r.node === "string" && r.node && !tokens.has(r.node), "duplicate/missing observer node identity"); tokens.add(r.node);
        const owner = `${kind}:${r.id}`;
        need(!nodes.has(r.node) || nodes.get(r.node) === owner, "DOM node reassigned to another key"); nodes.set(r.node, owner);
        const old = prior.get(r.id);
        need(!old || old.node === r.node, "surviving keyed node replaced");
        const { node, ...value } = r; return value;
      });
    };
    need(same({ rows: strip(observed.rows, "row"), selected: observed.selected, cards: strip(observed.cards, "card"), totalMinor: observed.totalMinor }, expected), "wrong independent DOM/final state");
    previous = structuredClone(observed);
  };
  for (const [index, raw] of capture.records.entries()) {
    const r = normalize(structuredClone(raw), index);
    need(object(r) && Number.isFinite(r.at) && r.at >= 0 && r.at > lastAt, "invalid or out-of-order capture clock"); lastAt = r.at;
    if (detached && !released) need(r.at - detachedAt <= settings.maxCleanupMs, "cleanup exceeded bound");
    if (index === 0) need(r.kind === "resources", "baseline owned resources required");
    switch (r.kind) {
      case "resources":
        exact(r, ["kind", "at", "owned"]); resources(r.owned); owned = r.owned; resourceAt = r.at;
        if (index === 0 || released) need(zero(owned), "nonzero baseline or resurrected resources");
        if (detached && zero(owned)) released = true;
        break;
      case "initial":
        exact(r, ["kind", "at", "data", "dom", "errors"]);
        need(!initialized && !detached && owned !== null && same(r.data, workload.initial), "missing/unequal loaded data");
        need(same(r.errors, []), "browser/hydration error"); dom(r.dom, clientSnapshot(workload, 0)); initialized = true; break;
      case "operation":
        exact(r, ["kind", "at", "operation", "dom", "network", "errors"]);
        need(initialized && !detached && step < workload.operations.length && same(r.operation, workload.operations[step]), "missing/duplicate/wrong operation order");
        need(same(r.network, []) && same(r.errors, []), "operation HTTP or browser error");
        dom(r.dom, clientSnapshot(workload, ++step)); break;
      case "detach":
        exact(r, ["kind", "at"]);
        need(initialized && step === workload.operations.length && !detached, "detach before final operation"); detached = true; detachedAt = r.at; break;
      case "cleanup-probe":
        exact(r, ["kind", "at", "input", "network"]);
        need(detached && probeAt === null && same(r.input, workload.cleanupProbe) && same(r.network, []), "missing/wrong cleanup probe or hidden HTTP"); probeAt = r.at; break;
      case "state":
        exact(r, ["kind", "at", "dom", "owned", "network", "errors"]); resources(r.owned);
        need(detached && released && probeAt !== null && r.at - probeAt >= settings.cleanupObservationMs && resourceAt >= probeAt
          && zero(owned) && zero(r.owned) && !quiescent && index === capture.records.length - 1, "missing post-probe quiescence/resources");
        need(same(r.network, []) && same(r.errors, []), "post-detach HTTP or browser error");
        dom(r.dom, clientSnapshot(workload)); quiescent = true; break;
      default: need(false, "unknown observation kind");
    }
  }
  need(initialized && detached && released && quiescent && step === workload.operations.length && zero(owned), "incomplete client journey");
  return { ...result, functionalPassed: true, observedOperations: step };
}
