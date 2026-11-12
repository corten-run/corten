// Offline native-journey correctness oracle, not a browser/load runner.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { expectedPage, labels, normalize, validateRecord } from "../marketplace/records.mjs";
import { contractSha256, definition, selectedApps } from "./registry.mjs";

export const browserPlanSchema = "browser-journey-plan/v1";
export const browserCaptureSchema = "browser-journey-capture/v1";
const need = (ok, message) => { if (!ok) throw new Error(`browser contract: ${message}`); };
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : object(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const same = (a, b) => isDeepStrictEqual(canonical(a), canonical(b));
const hash = (v) => createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
const exact = (v, keys) => need(object(v) && same(Object.keys(v).sort(), [...keys].sort()), "missing or unexpected fields");
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const publicPath = (v) => typeof v === "string" && /^\/(?!\/)/.test(v) && !/[\\?#\s\x00-\x1f\x7f]/.test(v);
const text = (v) => typeof v === "string" && v.length > 0;
const normalized = (v) => typeof v === "string" ? normalize(v) : Array.isArray(v) ? v.map(normalized)
  : object(v) ? Object.fromEntries(Object.entries(v).map(([k, value]) => [k, normalized(value)])) : v;
const resourceKeys = ["subscriptions", "connections", "listeners", "timers", "pendingTasks"];
const resources = (v) => { exact(v, resourceKeys); need(resourceKeys.every((k) => integer(v[k])), "owned resource observations required"); };
const zero = (v) => resourceKeys.every((k) => v[k] === 0);
// Architecture is disclosed, not inferred from equal SSR. LiveView is deliberately not an
// alias for Phoenix controllers (Phoenix is not selected for this registry group).
const models = {
  corten: ["corten"], nextjs: ["next-pages", "next-app"], nuxt: ["nuxt"], "react-router": ["react-router"],
  rails: ["hotwire"], laravel: ["livewire"], sveltekit: ["sveltekit"], astro: ["astro"], "tanstack-start": ["tanstack-start"], leptos: ["leptos"],
};

function observableSellerPrefix(listings) {
  for (const { seller } of listings) {
    for (let length = seller.length; length > 0; length--) {
      const prefix = seller.slice(0, length).trimEnd();
      if (!prefix) continue;
      const filtered = listings.filter((row) => row.seller.startsWith(prefix));
      if (filtered.length < listings.length
        && new Set(filtered.filter((row) => row.price_minor !== null).map((row) => row.price_minor)).size >= 2) return prefix;
    }
  }
  return null;
}

function navigationMatches(request, step, profile, architecture) {
  if (profile.js && architecture === "hotwire" && step.kind === "navigate" && request.transport !== "turbo") return false;
  if (request.path === step.path) return true;
  if (!profile.js || step.kind === "initial" || architecture !== "next-pages" || request.transport !== "router") return false;
  const data = /^\/_next\/data\/([^/]+)(\/marketplace\/[^/]+\/[^/]+)\.json$/.exec(request.path);
  return data !== null && ![".", ".."].includes(data[1]) && data[2] === step.path;
}

/** Both sources/all locales/devices/JS modes come from the registry, never passing adapters.
 * The linked pair and populated offers make navigation/filter/sort/show-all observable.
 * No expected DOM, output cache, timing profile or native renderer is embedded in this plan.
 */
export function createBrowserPlan(options) {
  exact(options, ["records"]);
  const records = options.records;
  need(object(records) && Object.keys(records).length >= 2, "numeric linked marketplace records required");
  try {
    for (const [id, record] of Object.entries(records)) {
      need(/^item_[1-9]\d*$/.test(id), "invalid item id"); validateRecord(record, id);
      for (const line of [...record.contents, ...record.included_in]) need(Object.hasOwn(records, line.item_id), "missing linked record");
    }
  } catch { throw new Error("browser contract: invalid marketplace records"); }
  const ids = Object.keys(records).sort();
  let pair;
  for (const first of ids) {
    for (const { item_id: second } of records[first].contents) {
      if (second === first || records[second].offers.length <= 5) continue;
      const seller = observableSellerPrefix(records[second].listings);
      if (seller !== null) { pair = { first, second, seller }; break; }
    }
    if (pair) break;
  }
  need(pair, "linked navigation with observable filter/sort and populated offers required");
  const { first, second, seller } = pair;
  const cases = definition("fullstack-browser").cases.map((profile) => {
    const path = (id) => `/marketplace/${profile.locale}/${id}`;
    const steps = [
      { kind: "initial", itemId: first, path: path(first), query: {} },
      { kind: "navigate", itemId: second, path: path(second), query: {} },
      { kind: "filter", itemId: second, path: path(second), query: { seller } },
      { kind: "sort", itemId: second, path: path(second), query: { seller, sort: "desc" } },
      { kind: "show-all", itemId: second, path: path(second), query: { seller, sort: "desc", all: true } },
      { kind: "reset", itemId: second, path: path(second), query: {} },
      ...["accepted-write", "invalid-email", "invalid-price"].map((kind) => ({ kind, itemId: second, path: path(second), query: {},
        input: { email: kind === "invalid-email" ? "invalid-email" : `browser-${profile.key}@example.test`, target_price: kind === "invalid-price" ? "0" : profile.locale === "en-US" ? "1.25" : "1,25" } })),
      { kind: "missing", itemId: "item_missing", path: path("item_missing"), query: {} },
      { kind: "return", itemId: first, path: path(first), query: {} },
    ].map((step, index) => ({ id: `${profile.key}-${index}`, ...step }));
    return { ...profile, steps };
  });
  const plan = { schema: browserPlanSchema, group: "fullstack-browser", contractSha256: contractSha256("fullstack-browser"),
    recordsSha256: hash(records), cases, policy: { nativeForm: "discovered", readback: "independent-read", timing: "not-specified", outputCache: "forbidden" } };
  return { ...plan, sha256: hash(plan) };
}

function expectedMessage(step, locale, record) {
  if (step.kind === "invalid-email") return labels[locale].invalid_email;
  if (step.kind === "invalid-price") return labels[locale].invalid_price;
  if (step.kind !== "accepted-write") return "";
  const price = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1.25);
  const values = { email: step.input.email, title: record.title, price };
  return labels[locale].alert_set.replace(/\{(email|title|price)\}/g, (_, key) => values[key]);
}

/**
 * The future native runner supplies independent response-document parsing, visible DOM
 * extraction, complete request/error ledgers, fresh form metadata, independent alert-store
 * readback and instrumented page-scope resources. These are captured values, NOT expectedPage
 * results or app-reported ready/cleanup booleans. A normalizer may map native shapes but may
 * not skip records or derive them from this oracle. No transport tokens/bodies are persisted.
 *
 * Each captured step has a strictly ordered `at`, its exact dispatched `action`, requests
 * (public pathname, observed method/status/transport/input and Livewire component IDs), a
 * fresh DOM extraction, an initial response-document extraction (SSR), independent write
 * readback and retired page-scope resource counts. Document and DOM observations have
 * different observer IDs. Native redirects/revalidation and client-local filter/sort work
 * remain native; there is no common wire protocol or artificial hydration requirement.
 * Next Pages JS transitions may fetch /_next/data/<buildId>/<logical-path>.json via the
 * native router. The raw request pathname is retained and its destination is checked
 * against the action/visible route; initial HTML and no-JS navigation still use that route.
 * A form's `enhancement` is its captured native binding (public endpoint and transport),
 * or null. Livewire may POST its update endpoint while no-JS posts the HTML form action;
 * only the dispatched component IDs need appear in that update, not every page component.
 * Livewire JS writes and Hotwire navigation/forms additionally need actual native request
 * and component evidence, not an architecture label on an SSR-only implementation.
 *
 * Settings are caller-reviewed viewport/network/cache/service-worker configurations and
 * cleanup bounds, not performance claims. Cleanup dispatches a probe to the retired scope;
 * after the observation interval its DOM is unchanged and all owned resources remain zero.
 * Provenance/authentication, continuous instrumentation, measured bytes/readiness/actions,
 * native parse/render work and real browser execution are still runner responsibilities.
 */
export function validateBrowserCapture(plan, capture, records, settings, normalizeCapture = (record) => record) {
  need(same(plan, createBrowserPlan({ records })), "corrupt or incompatible effective plan");
  exact(settings, ["profiles", "maxCleanupMs", "cleanupObservationMs"]);
  exact(settings.profiles, ["desktop", "mobile"]);
  for (const p of Object.values(settings.profiles)) {
    exact(p, ["viewport", "network", "cache", "serviceWorker"]); exact(p.viewport, ["width", "height"]);
    need(integer(p.viewport.width) && p.viewport.width > 0 && integer(p.viewport.height) && p.viewport.height > 0, "reviewed viewport required");
    need(text(p.network) && ["cold", "warm"].includes(p.cache) && ["blocked", "enabled"].includes(p.serviceWorker), "reviewed browser environment required");
  }
  need([settings.maxCleanupMs, settings.cleanupObservationMs].every((n) => Number.isFinite(n) && n > 0), "positive cleanup bounds required");
  exact(capture, ["schema", "app", "effectivePlan", "cases"]);
  need(capture.schema === browserCaptureSchema && same(capture.effectivePlan, plan) && selectedApps(plan.group).includes(capture.app), "wrong group/app/plan");
  need(Array.isArray(capture.cases) && capture.cases.length === plan.cases.length && typeof normalizeCapture === "function", "complete profile matrix required");
  const results = [], seen = new Set(), observations = new Set(), requestIds = new Set();
  const unique = (id, set) => { need(text(id) && !set.has(id), "duplicate/missing observer identity"); set.add(id); };
  const checkDOM = (dom, step, locale) => {
    exact(dom, ["id", "scope", "path", "page", "error", "form", "components"]); unique(dom.id, observations);
    need(text(dom.scope) && dom.path === step.path && Array.isArray(dom.components), "wrong visible scope/route");
    need(dom.components.every(text) && new Set(dom.components).size === dom.components.length, "duplicate/invalid native component identity");
    if (step.kind === "missing") {
      exact(dom.error, ["status", "text"]);
      need(dom.page === null && dom.form === null && dom.error.status === 404 && text(dom.error.text), "missing visible error state");
    } else {
      need(dom.error === null && same(normalized(dom.page), normalized(expectedPage(records[step.itemId], locale,
        { ...step.query, message: expectedMessage(step, locale, records[step.itemId]) }))), "wrong independent localized DOM");
      exact(dom.form, ["method", "action", "fields", "enhancement"]);
      need(dom.form.method === "POST" && publicPath(dom.form.action) && Array.isArray(dom.form.fields)
        && ["email", "target_price"].every((f) => dom.form.fields.includes(f)), "native form not captured");
      if (dom.form.enhancement !== null) {
        exact(dom.form.enhancement, ["path", "transport"]);
        need(publicPath(dom.form.enhancement.path) && ["fetch", "router", "turbo", "livewire"].includes(dom.form.enhancement.transport), "invalid native enhancement binding");
      }
    }
  };
  for (const raw of capture.cases) {
    const c = normalizeCapture(structuredClone(raw));
    exact(c, ["case", "outcome", "reason", "architecture", "environment", "baseline", "steps", "cleanup"]);
    const profile = plan.cases.find((p) => p.key === c.case);
    need(profile && !seen.has(c.case), "unknown/duplicate profile"); seen.add(c.case);
    need(["captured", "not-run", "unsupported", "failed"].includes(c.outcome), "unknown profile outcome");
    if (c.outcome !== "captured") {
      need(text(c.reason) && [c.architecture, c.environment, c.baseline, c.steps, c.cleanup].every((v) => v === null), "unavailable profile has manufactured evidence");
      results.push({ case: c.case, outcome: c.outcome, functionalPassed: c.outcome === "failed" ? false : null, reason: c.reason, observedSteps: null }); continue;
    }
    need(c.reason === null && models[capture.app]?.includes(c.architecture), "wrong or SSR-only native architecture");
    need(same(c.environment, { ...settings.profiles[profile.device], js: profile.js, device: profile.device }), "wrong JS/device/environment profile");
    resources(c.baseline); need(zero(c.baseline), "owned baseline not empty");
    need(Array.isArray(c.steps) && c.steps.length === profile.steps.length, "every journey step required");
    let lastAt = -1, previous = null, alerts = [];
    const retired = new Set();
    for (const [index, row] of c.steps.entries()) {
      exact(row, ["at", "action", "requests", "dom", "document", "readback", "retired", "upstream", "errors"]);
      const step = profile.steps[index], write = Object.hasOwn(step, "input");
      need(Number.isFinite(row.at) && row.at >= 0 && row.at > lastAt && same(row.action, step), "wrong/missing/out-of-order action"); lastAt = row.at;
      need(same(row.errors, []) && Array.isArray(row.requests), "browser errors or missing request ledger");
      for (const request of row.requests) {
        exact(request, ["id", "method", "path", "status", "transport", "input", "components"]); unique(request.id, requestIds);
        need(["GET", "POST"].includes(request.method) && publicPath(request.path) && integer(request.status) && request.status >= 200 && request.status <= 599,
          "invalid native request observation");
        need(["document", "fetch", "router", "turbo", "livewire"].includes(request.transport) && Array.isArray(request.components)
          && request.components.every(text) && new Set(request.components).size === request.components.length, "native request transport required");
        if (!profile.js) need(request.transport === "document", "JS work in no-JS profile");
        if (request.method === "GET") need(request.input === null, "GET cannot substitute a form write");
      }
      const posts = row.requests.filter((r) => r.method === "POST");
      if (write) {
        const enhancement = profile.js ? previous?.form?.enhancement : null;
        need(posts.length === 1 && previous?.form && posts[0].path === (enhancement?.path ?? previous.form.action)
          && (!enhancement || posts[0].transport === enhancement.transport) && same(posts[0].input, step.input), "missing/duplicate/substituted native form submission");
        need((step.kind === "accepted-write" ? [200, 201, 202, 204, 302, 303] : [200, 302, 303, 400, 422]).includes(posts[0].status), "write status differs");
        if (profile.js && capture.app === "laravel") need(enhancement?.transport === "livewire" && posts[0].transport === "livewire" && previous.components.length > 0
          && posts[0].components.length > 0 && posts[0].components.every((id) => previous.components.includes(id))
          && row.dom?.components?.length > 0, "Livewire interaction replaced by SSR/label");
        if (profile.js && capture.app === "rails") need(posts[0].transport === "turbo", "Hotwire form replaced by SSR");
        exact(row.readback, ["id", "via", "alerts"]); unique(row.readback.id, observations);
        need(row.readback.via === "independent-read", "independent store readback required");
        if (step.kind === "accepted-write") alerts = [...alerts, { item_id: step.itemId, email: step.input.email, target_minor: 125 }];
        need(same(row.readback.alerts, alerts), "false success, rejected mutation or duplicate write/readback");
      } else {
        need(posts.length === 0 && row.readback === null, "unexpected write/readback");
        if (["initial", "navigate", "reset", "missing", "return"].includes(step.kind) || !profile.js) {
          need(row.requests.some((r) => r.method === "GET" && navigationMatches(r, step, profile, c.architecture)
            && r.status === (step.kind === "missing" ? 404 : 200)), "missing native navigation/error request");
        }
      }
      checkDOM(row.dom, step, profile.locale);
      need(!retired.has(row.dom.scope), "retired page scope resurrected");
      if (step.kind === "initial") {
        need(row.requests.some((r) => r.transport === "document"), "initial document request required");
        checkDOM(row.document, step, profile.locale);
      } else need(row.document === null, "unexpected initial SSR observation");
      need(Array.isArray(row.retired), "retired page-scope resource observations required");
      const currentRetired = new Set();
      for (const entry of row.retired) {
        exact(entry, ["scope", "owned"]); resources(entry.owned);
        need(text(entry.scope) && !retired.has(entry.scope) && !currentRetired.has(entry.scope) && entry.scope !== row.dom.scope && zero(entry.owned), "retired page resource leak");
        currentRetired.add(entry.scope); retired.add(entry.scope);
      }
      if (previous && previous.scope !== row.dom.scope) need(currentRetired.has(previous.scope), "old page subscription cleanup missing");
      exact(row.upstream, ["started", "completed", "cancelled", "pending"]);
      need(Object.values(row.upstream).every(integer) && row.upstream.pending === 0
        && row.upstream.completed + row.upstream.cancelled === row.upstream.started, "upstream work leaked/unaccounted");
      if (profile.source === "fixture") need(row.upstream.started === 0, "fixture route fetched upstream");
      else if (step.kind !== "missing" && row.requests.length) need(row.upstream.completed > 0, "request-time upstream work missing");
      previous = row.dom;
    }
    const cleanup = c.cleanup;
    exact(cleanup, ["detachedAt", "releasedAt", "probeAt", "afterAt", "detached", "afterProbe", "probe", "dom", "network", "errors"]);
    need([cleanup.detachedAt, cleanup.releasedAt, cleanup.probeAt, cleanup.afterAt].every(Number.isFinite)
      && cleanup.detachedAt > lastAt && cleanup.releasedAt >= cleanup.detachedAt && cleanup.releasedAt - cleanup.detachedAt <= settings.maxCleanupMs
      && cleanup.probeAt >= cleanup.releasedAt
      && cleanup.afterAt - cleanup.probeAt >= settings.cleanupObservationMs, "missing/bounded cleanup observation required");
    resources(cleanup.detached); resources(cleanup.afterProbe);
    need(zero(cleanup.detached) && zero(cleanup.afterProbe), "owned resources leaked after detach/probe");
    need(same(cleanup.probe, { scope: previous.scope, kind: "retired-page-event" }) && same(cleanup.network, []) && same(cleanup.errors, []), "cleanup probe or quiescence missing");
    unique(cleanup.dom?.id, observations);
    need(same({ ...cleanup.dom, id: previous.id }, previous), "detached DOM changed after probe");
    results.push({ case: c.case, outcome: "captured", functionalPassed: true, observedSteps: c.steps.length });
  }
  return { schema: browserCaptureSchema, app: capture.app, planSha256: plan.sha256, cases: results,
    functionalPassed: results.every((r) => r.functionalPassed === true), readyForLoad: false,
    scope: "Offline native-journey observations only; no native qualification, timing, byte or load-readiness claim." };
}
