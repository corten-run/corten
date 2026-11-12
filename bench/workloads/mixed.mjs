// Functional groundwork only. No HTTP, load generator, adapter, or timing claims.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { sources as marketplaceSources } from "../catalog/contract.mjs";
import { cases, locales as marketplaceLocales, workload as marketplaceWorkload } from "../marketplace/contract.mjs";
import { expectedPage, labels, normalize, validateRecord } from "../marketplace/records.mjs";

export const workload = "mixed-v1";
export const planSchema = "mixed-plan/v1";
export const resultSchema = "mixed-results/v1";
export const locales = Object.freeze([...marketplaceLocales]);
export const sources = Object.freeze([...marketplaceSources]);
export const categories = Object.freeze(["page", "json", "listings", "accepted-write", "rejected-write", "slow"]);
export const outcomes = Object.freeze(["completed", "rejected", "deadline", "cancelled", "limited", "refused", "failed", "timeout", "network-error", "dropped", "unsupported", "not-run"]);
// Native response alternatives, not framework-identical wire protocols. A write's visible
// page/message and independent state still decide semantics, including after a redirect.
// Ordinary successful reads remain 200. No timing limit is inferred from these statuses.
export const responseStatuses = Object.freeze({
  completed: Object.freeze([200, 201, 202, 204, 302, 303]),
  rejected: Object.freeze([200, 302, 303, 400, 422]),
  deadline: Object.freeze([408, 503, 504]),
  limited: Object.freeze([429]),
  refused: Object.freeze([401, 403, 419]),
});

// Never include captured values in diagnostics, including AssertionError.actual/expected.
const need = (ok, message) => { if (!ok) throw new Error(`mixed contract: ${message}`); };
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : object(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const same = (a, b) => isDeepStrictEqual(canonical(a), canonical(b));
const hash = (v) => createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
const exact = (v, keys) => need(object(v) && same(Object.keys(v).sort(), [...keys].sort()), "missing or unexpected fields");
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const normalized = (v) => typeof v === "string" ? normalize(v) : Array.isArray(v) ? v.map(normalized)
  : object(v) ? Object.fromEntries(Object.entries(v).map(([k, value]) => [k, normalized(value)])) : v;

function checkedRecords(records) {
  need(object(records) && Object.keys(records).length > 0, "records required");
  try {
    for (const [id, record] of Object.entries(records)) {
      need(/^item_[1-9]\d*$/.test(id), "marketplace item ids required");
      validateRecord(record, id);
      for (const line of [...record.contents, ...record.included_in]) need(Object.hasOwn(records, line.item_id), "missing linked record");
    }
  } catch { throw new Error("mixed contract: invalid marketplace records"); }
  return records;
}

// mulberry32, with uint32 arithmetic; no wall clock, Math.random, or locale-dependent sorting.
function random(seed) {
  let state = seed;
  return () => {
    let value = state = (state + 0x6d2b79f5) >>> 0;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * Callers supply current numeric records, seed, clients and repetitions, not a cloud profile.
 * Every repetition covers both sources, all page locales and neutral JSON once per source.
 * Listings cover asc/desc/prefix; invalid writes cover email/price; API slow cases cover
 * completion, server deadline and client cancellation. Counts are derived, never percentages.
 * A future runner MUST save this complete effective plan with its result (validateResults
 * requires it), serialize requests per (source, client), and isolate state between sources.
 * Setup/form discovery and independent state reads are additional work, not replacements.
 */
export function createPlan(options) {
  exact(options, ["seed", "clients", "repetitions", "records"]);
  const { seed, clients, repetitions } = options;
  need(integer(seed, 0, 0xffffffff), "seed must be uint32");
  need(integer(clients, 1, 10000) && integer(repetitions, 1, 10000), "positive bounded clients and repetitions required");
  const records = checkedRecords(options.records), ids = Object.keys(records).sort();
  const listingIds = ids.filter((id) => records[id].listings.length > 0);
  need(listingIds.length > 0, "listing evidence requires a populated record");
  const rng = random(seed), choose = (values) => values[Math.floor(rng() * values.length)];
  const positivePrices = cases().prices.filter((v) => v.minor > 0).map((v) => v.minor);
  const requests = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    const batch = [];
    for (const source of sources) {
      batch.push({ category: "json", source, locale: null, itemId: choose(ids), variant: null });
      for (const locale of locales) {
        for (const category of ["page", "accepted-write"]) batch.push({ category, source, locale, itemId: choose(ids), variant: null });
        for (const variant of ["asc", "desc", "prefix"]) batch.push({ category: "listings", source, locale, itemId: choose(listingIds), variant });
        for (const variant of ["invalid_email", "invalid_price"]) batch.push({ category: "rejected-write", source, locale, itemId: choose(ids), variant });
        if (source === "api") for (const variant of ["complete", "deadline", "cancel"]) batch.push({ category: "slow", source, locale, itemId: choose(ids), variant });
      }
    }
    for (let i = batch.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [batch[i], batch[j]] = [batch[j], batch[i]];
    }
    for (const entry of batch) {
      const index = requests.length, client = index % clients, { itemId, locale, category, variant } = entry;
      const write = category.endsWith("-write");
      const query = category === "listings" ? { seller: variant === "prefix" ? records[itemId].listings[0].seller.slice(0, 1) : "", sort: variant === "desc" ? "desc" : "asc", all: variant === "prefix" } : null;
      const minor = choose(positivePrices);
      const target = (minor / 100).toFixed(2).replace(".", locale === "en-US" ? "." : ",");
      const input = write ? { email: variant === "invalid_email" ? "invalid-email" : `mixed-${seed}-${index}@example.test`, target_price: variant === "invalid_price" ? "0" : target } : null;
      const pagePath = `/marketplace/${locale}/${encodeURIComponent(itemId)}`;
      const path = write ? null : category === "json" ? `/api/marketplace/${encodeURIComponent(itemId)}` : pagePath + (query ? `?${new URLSearchParams({ seller: query.seller, sort: query.sort, ...(query.all ? { offers: "all" } : {}) })}` : "");
      requests.push({ id: `request_${index}`, index, repetition, client, ...entry,
        method: write ? "POST" : "GET", path, formPage: write ? pagePath : null, accept: category === "json" ? "application/json" : "text/html",
        acceptEncoding: "br, gzip", query, input, targetMinor: write && variant !== "invalid_price" ? minor : null,
        upstream: category === "slow" ? { path: `/marketplace/records/${encodeURIComponent(itemId)}`, mode: variant } : null });
    }
  }
  const counts = Object.fromEntries(categories.map((category) => [category, requests.filter((r) => r.category === category).length]));
  const plan = { schema: planSchema, workload, marketplaceWorkload, seed, clients, repetitions,
    recordsSha256: hash(records), sources: [...sources], locales: [...locales], counts,
    policy: { order: "per-source-client", initialAlerts: "empty", nativeForm: "required", readback: "independent-read",
      dynamicCaches: "forbidden", upstreamPassThrough: "forbidden", retries: "none", slowInjection: "per-request",
      timing: "not-specified", effectivePlan: "save-with-results" }, requests };
  return { ...plan, sha256: hash(plan) };
}

function checkedPlan(plan, records) {
  need(object(plan), "effective plan required");
  const rebuilt = createPlan({ seed: plan.seed, clients: plan.clients, repetitions: plan.repetitions, records });
  need(same(plan, rebuilt), "effective plan is corrupt or incompatible");
  return rebuilt;
}

const formTypes = ["application/x-www-form-urlencoded", "multipart/form-data"];
// Public action pathname only. Any native query/hidden action identifiers stay in transport,
// where the native adapter, not this contract, preserves and submits them.
const nativeAction = (action) => typeof action === "string" && action.startsWith("/") && !action.startsWith("//") && !/[\\?#\s\x00-\x1f\x7f]/.test(action);
function formEvidence(request, contentType, action) {
  return { requestId: request.id, client: request.client, source: request.source, locale: request.locale, itemId: request.itemId,
    formPage: request.formPage, method: "POST", action, contentType, fields: ["email", "target_price"], input: { ...request.input } };
}

/**
 * A native adapter discovers a fresh form in this client's session and supplies its opaque
 * transport (cookie jar, hidden fields/CSRF, native encoder, origin, etc.). This function
 * neither parses HTML nor manufactures/bypasses tokens. It resolves the discovered native
 * action against formPage; same-page actions and separate /alert routes are both valid.
 * The saved action is its public pathname, not a token-bearing query. The adapter submits binding.input
 * using binding.transport. Only binding.evidence belongs in saved results. JSON and Node
 * inspection redact the transport; do not log the transport itself. Missing forms throw.
 */
export function bindNativeForm(request, captured) {
  need(object(request) && request.category?.endsWith("-write") && request.method === "POST", "write request required");
  exact(captured, ["client", "source", "locale", "itemId", "method", "action", "contentType", "fields", "transport"]);
  for (const key of ["client", "source", "locale", "itemId"]) need(captured[key] === request[key], "form belongs to a different client or page");
  need(captured.method === "POST" && nativeAction(captured.action) && formTypes.includes(captured.contentType), "native POST form required");
  need(Array.isArray(captured.fields) && ["email", "target_price"].every((field) => captured.fields.includes(field)), "native form fields missing");
  need(object(captured.transport), "captured native session/token transport required");
  const evidence = formEvidence(request, captured.contentType, captured.action);
  const binding = { evidence, input: { ...request.input } };
  Object.defineProperties(binding, {
    transport: { value: captured.transport },
    toJSON: { value: () => evidence },
    [Symbol.for("nodejs.util.inspect.custom")]: { value: () => "[MixedNativeForm: transport redacted]" },
  });
  return binding;
}

function messageFor(request, record) {
  const l = labels[request.locale];
  if (request.category === "rejected-write") return l[request.variant];
  const amount = new Intl.NumberFormat(request.locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(request.targetMinor / 100);
  const values = { email: request.input.email, title: record.title, price: amount };
  return l.alert_set.replace(/\{(email|title|price)\}/g, (_, key) => values[key]);
}

function checkAlerts(alerts) {
  need(Array.isArray(alerts), "alert state missing");
  for (const alert of alerts) {
    exact(alert, ["item_id", "email", "target_minor"]);
    need(typeof alert.item_id === "string" && typeof alert.email === "string" && integer(alert.target_minor, 1, 1e9), "invalid alert state");
  }
}

/**
 * Captures contain no raw tokens, cookies, native bodies or timing. page is the independent
 * DOM extraction shaped like marketplace expectedPage; record is the parsed native JSON.
 * state is a normalized native alert-store view: before/after plus a separately read readback,
 * not an echo of the POST or its message. Status is the primary response; page is the visible
 * result, including native redirect/revalidation work. Upstream counters cover that logical
 * operation, excluding form preparation/state reads, and must show the injected mode/path and no
 * pending work after cleanup. A slow mode must be confirmed by the injector, not inferred
 * from a response status. Deadline values/delays remain future runner configuration.
 * Explicit load/protection outcomes remain counted; missing/corrupt evidence throws instead
 * of substituting work. A valid capture with failures/drops is not functional parity.
 */
export function validateResults(plan, capture, records) {
  const effective = checkedPlan(plan, records);
  exact(capture, ["schema", "workload", "app", "effectivePlan", "results"]);
  need(capture.schema === resultSchema && capture.workload === workload, "wrong result identity");
  need(typeof capture.app === "string" && /^[a-z][a-z0-9-]*$/.test(capture.app), "app identity required");
  need(same(capture.effectivePlan, effective), "saved effective plan missing or different");
  need(Array.isArray(capture.results) && capture.results.length === effective.requests.length, "every planned request needs a result");
  const byId = new Map();
  for (const row of capture.results) {
    exact(row, ["request", "outcome", "status", "contentType", "contentEncoding", "error", "upstream", "page", "record", "form", "state"]);
    need(object(row.request) && !byId.has(row.request.id), "duplicate or missing request identity");
    byId.set(row.request.id, row);
  }
  const counts = Object.fromEntries(categories.map((category) => [category, { planned: effective.counts[category], attempted: 0, succeeded: 0, failed: 0, usefulCompletions: 0,
    outcomes: Object.fromEntries(outcomes.map((outcome) => [outcome, 0])), statuses: {}, encodings: {}, errors: {} }]));
  const states = new Map();
  for (const request of effective.requests) {
    const row = byId.get(request.id), count = counts[request.category], write = request.method === "POST";
    need(row && same(row.request, request), "request schedule/method/path/input differs");
    need(outcomes.includes(row.outcome), "unknown outcome");
    need(integer(row.status, 200, 599) || row.status === 0, "invalid response status");
    need([null, "cancelled", "timeout", "network-error"].includes(row.error), "invalid transport error");
    need([null, "text/html", "application/json", "application/problem+json", "text/plain"].includes(row.contentType), "invalid content type");
    need([null, "identity", "gzip", "br"].includes(row.contentEncoding), "invalid content encoding");
    const unsent = ["dropped", "not-run", "unsupported"].includes(row.outcome);
    if (unsent) {
      need(row.status === 0 && row.error === null && row.upstream === null && row.page === null && row.record === null && row.form === null && row.state === null && row.contentType === null && row.contentEncoding === null, "unsent result has response evidence");
    } else {
      count.attempted++;
      const noResponse = ["cancelled", "timeout", "network-error"].includes(row.outcome);
      const writeRedirect = write && ["completed", "rejected"].includes(row.outcome) && [302, 303].includes(row.status);
      const emptyWriteResponse = writeRedirect || write && row.outcome === "completed" && row.status === 204;
      need(noResponse ? row.status === 0 && row.error === row.outcome && row.contentType === null && row.contentEncoding === null : row.status !== 0 && row.error === null && (emptyWriteResponse || row.contentType !== null && row.contentEncoding !== null), "status/error/outcome disagree");
      if (Object.hasOwn(responseStatuses, row.outcome)) need(responseStatuses[row.outcome].includes(row.status), "status/outcome disagree");
      if (row.outcome === "completed" && !write) need(row.status === 200, "successful read status must be 200");
      if (row.outcome === "failed") need(row.status >= 400 && ![...responseStatuses.refused, ...responseStatuses.limited].includes(row.status), "failure status required");
      exact(row.upstream, ["requests", "completed", "cancelled", "pending", "path", "mode"]);
      for (const key of ["requests", "completed", "cancelled", "pending"]) need(integer(row.upstream[key], 0, Number.MAX_SAFE_INTEGER), "invalid upstream counters");
      need(row.upstream.path === (request.source === "api" && row.upstream.requests > 0 ? `/marketplace/records/${encodeURIComponent(request.itemId)}` : null), "upstream path differs");
      need(row.upstream.mode === (request.category === "slow" ? request.variant : "normal"), "upstream injection schedule differs");
      need(row.upstream.pending === 0 && row.upstream.completed + row.upstream.cancelled === row.upstream.requests, "upstream work leaked or unaccounted");
      need(request.source === "fixture" ? row.upstream.requests === 0
        : !["completed", "rejected", "deadline"].includes(row.outcome) || (write ? row.upstream.requests >= 1 : row.upstream.requests === 1), "wrong primary upstream fetch count");
      // Native actions may read and then redirect/revalidate. Keep that work visible rather
      // than requiring every framework to implement one action/response wire protocol.
      if (request.category === "slow" && ["deadline", "cancelled"].includes(row.outcome)) need(row.upstream.cancelled === 1, "slow upstream cancellation missing");
      if (["completed", "rejected"].includes(row.outcome)) need(row.upstream.cancelled === 0, "completed work was cancelled");
    }
    if (write && !unsent) {
      need(object(row.form) && nativeAction(row.form.action) && formTypes.includes(row.form.contentType) && same(row.form, formEvidence(request, row.form.contentType, row.form.action)), "native form/write evidence missing or different");
      exact(row.state, ["before", "after", "readback"]);
      exact(row.state.readback, ["via", "alerts"]);
      need(row.state.readback.via === "independent-read", "independent write readback required");
      for (const alerts of [row.state.before, row.state.after, row.state.readback.alerts]) checkAlerts(alerts);
      const key = `${request.source}:${request.client}`, before = states.get(key) ?? [];
      need(same(row.state.before, before), "write state is stale, out of order, or not isolated");
      const after = request.category === "accepted-write" && row.outcome === "completed"
        ? [...before, { item_id: request.itemId, email: request.input.email, target_minor: request.targetMinor }] : before;
      need(same(row.state.after, after) && same(row.state.readback.alerts, after), "write effect/readback differs");
      states.set(key, after);
    } else need(row.form === null && row.state === null, "non-write has write evidence");
    const expectedOutcome = request.category === "rejected-write" ? "rejected" : request.category === "slow"
      ? { complete: "completed", deadline: "deadline", cancel: "cancelled" }[request.variant] : "completed";
    const passed = row.outcome === expectedOutcome;
    if (["completed", "rejected"].includes(row.outcome)) {
      const record = records[request.itemId];
      if (request.category === "json") {
        need(row.contentType === "application/json" && row.page === null && same(row.record, record), "numeric JSON differs");
      } else {
        const message = write ? messageFor(request, record) : "";
        const expected = expectedPage(record, request.locale, { ...(request.query ?? {}), message });
        need((row.contentType === "text/html" || write && [204, 302, 303].includes(row.status) && row.contentType === null) && row.record === null && same(normalized(row.page), normalized(expected)), "localized page/listings/message differs");
      }
    } else need(row.page === null && row.record === null, "failed/unsent outcome has success data");
    count.outcomes[row.outcome]++;
    count.statuses[row.status] = (count.statuses[row.status] ?? 0) + 1;
    const encoding = row.contentEncoding ?? "none", error = row.error ?? "none";
    count.encodings[encoding] = (count.encodings[encoding] ?? 0) + 1;
    count.errors[error] = (count.errors[error] ?? 0) + 1;
    count[passed ? "succeeded" : "failed"]++;
    if (passed && ["completed", "rejected"].includes(row.outcome)) count.usefulCompletions++;
  }
  return { schema: resultSchema, workload, app: capture.app, planSha256: effective.sha256, categories: counts,
    functionalPassed: Object.values(counts).every((c) => c.succeeded === c.planned), readyForLoad: false,
    scope: "Deterministic functional evidence only; native adapters, qualification, runner integration and measurement readiness are not certified." };
}

// Offline CLI: plan <options.json>, or validate <options.json> <capture.json>.
// The future runner owns persistence and execution, not this command.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, optionsPath, capturePath, ...extra] = process.argv.slice(2);
    need(extra.length === 0 && optionsPath && (command === "plan" ? !capturePath : command === "validate" && capturePath), "usage: mixed.mjs plan <options.json> | validate <options.json> <capture.json>");
    const options = JSON.parse(readFileSync(optionsPath, "utf8")), plan = createPlan(options);
    const result = command === "plan" ? plan : validateResults(plan, JSON.parse(readFileSync(capturePath, "utf8")), options.records);
    console.log(JSON.stringify(result, null, 2));
    if (command === "validate" && !result.functionalPassed) process.exitCode = 1;
  } catch { console.error("mixed contract: invalid input or parity evidence"); process.exitCode = 1; }
}
