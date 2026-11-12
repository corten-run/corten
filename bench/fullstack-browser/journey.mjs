import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { settings, alertsFromReadback, nativeFailures } from "./contract.mjs";
import { architecture, classifyDisabledPreloads, nativeDOM, observeNetwork, responseDocument, visibleDOM } from "./observe.mjs";
import { upstreamDelta } from "./upstream.mjs";
import { comparePage } from "../marketplace/check.mjs";
import { labels } from "../marketplace/records.mjs";

// A semantic DOM observation, not an application-provided "hydrated" mark.
function signature() {
  return JSON.stringify([document.querySelector("article.marketplace h1")?.textContent,
    [...document.querySelectorAll("[data-listing-id]")].map((v) => v.getAttribute("data-listing-id")),
    [...document.querySelectorAll("[data-offer-id]")].map((v) => v.getAttribute("data-offer-id")),
    document.querySelector(".marketplace__message")?.textContent,
    document.querySelector("article.marketplace") === null ? document.body?.textContent : null]);
}
function message(step, locale, record) {
  if (step.kind === "invalid-email") return labels[locale].invalid_email;
  if (step.kind === "invalid-price") return labels[locale].invalid_price;
  if (step.kind !== "accepted-write") return "";
  const values = { email: step.input.email, title: record.title,
    price: new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(1.25) };
  return labels[locale].alert_set.replace(/\{(email|title|price)\}/g, (_, key) => values[key]);
}
export async function readStore(base, specification, request) {
  if (!specification) return { outcome: "unsupported", reason: "No independent native alert-store readback configured", alerts: null };
  assert.ok(request?.get, "readback requires the browser context's API cookie jar");
  const observed = { observer: randomUUID(), outcome: "failed", via: "independent-read", path: specification.path, status: null, alerts: null };
  try {
    const response = await request.get(base + specification.path, { maxRedirects: 0, headers: { accept: "application/json", "cache-control": "no-cache" }, timeout: 5000 });
    observed.status = response.status();
    assert.equal(observed.status, 200, "independent native store readback failed");
    assert.match(response.headers()["content-type"] ?? "", /^application\/json\b/);
    observed.alerts = alertsFromReadback(await response.json());
    return { ...observed, outcome: "read" };
  } catch (e) { e.readback = { ...observed, reason: e.message }; throw e; }
}
export async function dispatch(page, step) {
  if (["initial", "reset", "missing", "return"].includes(step.kind)) return page.goto(new URL(step.path, page.url()).href, { waitUntil: "load" });
  if (step.kind === "navigate") return page.locator(`.marketplace__contents a[href="${step.path}"]`).first().click();
  if (step.kind === "show-all") return page.locator(".marketplace__more").click();
  if (["filter", "sort"].includes(step.kind)) {
    const form = page.locator(".marketplace__listings form");
    await form.locator('[name="seller"]').fill(step.query.seller);
    await form.locator('[name="sort"]').selectOption(step.query.sort ?? "asc");
    return form.locator('[type="submit"]').click();
  }
  const form = page.locator(".marketplace__alert form");
  await form.locator('[name="email"]').fill(step.input.email);
  await form.locator('[name="target_price"]').fill(step.input.target_price);
  // Only bypass HTML validation for the server-invalid test. Native submit,
  // CSRF/session controls and framework enhancement are otherwise untouched.
  if (step.kind === "invalid-email") await form.evaluate((f) => { f.noValidate = true; });
  return form.locator('[type="submit"]').click();
}

export async function runJourney({ browser, app, base, profile, records, readback, counters }) {
  const environment = structuredClone(settings.profiles[profile.device]);
  const result = { case: profile.key, outcome: "failed", qualificationPassed: false, evidence: {
    environment: { ...environment, js: profile.js }, architecture: null, steps: [], failures: [], gaps: [], cleanup: null,
    readiness: { definition: "Native controls visible and enabled after load; no synthetic hydration mark. Actions themselves test usability.", actionableObservedMs: null },
    timingScope: "Host-observed elapsed time including Playwright dispatch/polling. Visible-change is an upper bound, not a hydration or comparative speed claim.",
  } };
  const evidence = result.evidence;
  const context = await browser.newContext({ javaScriptEnabled: profile.js, viewport: environment.viewport, serviceWorkers: "block", reducedMotion: "reduce" });
  context.setDefaultTimeout(settings.actionTimeoutMs); context.setDefaultNavigationTimeout(settings.actionTimeoutMs);
  let network;
  const runtimeErrors = [];
  const started = performance.now();
  try {
    await context.route("**/*", (route) => new URL(route.request().url()).origin === base ? route.continue() : route.abort("blockedbyclient"));
    const page = await context.newPage();
    page.on("pageerror", (e) => runtimeErrors.push(e.message));
    network = observeNetwork(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable"); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    if (environment.network) await cdp.send("Network.emulateNetworkConditions", environment.network);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: environment.cpu });
    // No native 404/error page is used as a start document: its late subresource
    // events would contaminate the next action's ledger. This is a diagnostic
    // about:blank arrival, not the historical cross-site timing profile.
    await page.goto("about:blank");
    await network.drain(); network.rows.length = 0; network.failures.length = 0; runtimeErrors.length = 0;
    try {
      evidence.storeBefore = await readStore(base, readback, context.request);
      if (evidence.storeBefore.outcome === "read") assert.deepEqual(evidence.storeBefore.alerts, [], "fresh case must start with an empty independent alert store");
      else evidence.gaps.push(evidence.storeBefore.reason);
    } catch (e) {
      evidence.storeBefore = e.readback ?? { outcome: "failed", alerts: null, reason: e.message };
      evidence.failures.push(`initial independent store read: ${e.message}`);
    }
    for (const step of profile.steps) {
      const row = { action: step, at: performance.now() - started, requests: [], dom: null, document: null, readback: null, upstream: null, formBefore: null, componentsBefore: [], domPassed: false,
        timing: { dispatchMs: null, visibleChangeObservedMs: null, settledObservedMs: null }, errors: [], failures: [] };
      evidence.steps.push(row);
      const beforeCounters = await counters();
      const offset = network.rows.length, errorsAt = runtimeErrors.length, networkErrorsAt = network.failures.length;
      const before = await page.evaluate(signature);
      const nativeBefore = await page.evaluate(nativeDOM);
      row.formBefore = nativeBefore.form; row.componentsBefore = nativeBefore.components;
      const at = performance.now();
      try {
        const response = step.kind === "initial" ? await page.goto(base + step.path, { waitUntil: "load" }) : await dispatch(page, step);
        row.timing.dispatchMs = performance.now() - at;
        if (step.kind !== "initial") await page.waitForFunction(`(${signature.toString()})() !== ${JSON.stringify(before)}`, null, { timeout: settings.actionTimeoutMs });
        row.timing.visibleChangeObservedMs = performance.now() - at;
        await page.waitForLoadState("load");
        await page.evaluate(() => globalThis.navigation?.transition?.finished);
        await page.waitForLoadState("networkidle");
        row.timing.settledObservedMs = performance.now() - at;
        row.dom = await visibleDOM(page);
        assert.equal(row.dom.url.path, step.path, "visible logical route differs from action");
        if (step.kind === "initial") {
          assert.ok(response, "initial document response missing");
          evidence.architecture = architecture(app, row.dom.native);
          const button = page.locator('.marketplace__alert [type="submit"]');
          assert.ok(await button.isVisible() && await button.isEnabled(), "native action not usable");
          evidence.readiness.actionableObservedMs = performance.now() - at;
          row.document = await responseDocument(browser, response, base + step.path);
          evidence.navigationTiming = await page.evaluate(() => performance.getEntriesByType("navigation")[0]?.toJSON() ?? null);
        }
        // Offline comparisons consume captured DOM. They never supply render data.
        if (step.kind === "missing") {
          assert.equal(row.dom.page, null, "missing item rendered a marketplace record"); assert.ok(row.dom.error, "missing visible error");
        } else {
          const options = { ...step.query, message: message(step, profile.locale, records[step.itemId]) };
          comparePage(row.dom.page, records[step.itemId], profile.locale, options);
          if (row.document) comparePage(row.document.page, records[step.itemId], profile.locale, options);
        }
        row.domPassed = true;
      } catch (e) {
        row.failures.push(e.message);
        // A timeout must retain the page that actually failed, not only the
        // planned action. Extraction may itself fail; retain that reason too.
        if (!row.dom) try { row.dom = await visibleDOM(page); } catch (error) { row.failures.push(`failure DOM extraction: ${error.message}`); }
        if (!row.dom) try {
          row.failurePage = { native: await page.evaluate(nativeDOM), text: (await page.locator("body").innerText()).slice(0, 4096) };
        } catch (error) { row.failurePage = { error: error.message }; }
      }
      const afterCounters = await counters(); row.upstream = upstreamDelta(beforeCounters, afterCounters);
      if (step.input) {
        try {
          row.readback = await readStore(base, readback, context.request);
          if (row.readback.outcome === "read") assert.deepEqual(row.readback.alerts, [{ item_id: step.itemId, email: profile.steps.find((s) => s.kind === "accepted-write").input.email, target_minor: 125 }], "write/rejected-write state differs, duplicate or false success");
          else row.failures.push(row.readback.reason);
        } catch (e) { row.readback = e.readback ?? { outcome: "failed", reason: e.message, alerts: null }; row.failures.push(e.message); }
      }
      await network.drain();
      row.requests = structuredClone(network.rows.slice(offset));
      classifyDisabledPreloads(row.requests, row.dom, profile.js);
      row.errors = [...runtimeErrors.slice(errorsAt), ...network.failures.slice(networkErrorsAt)];
      if (row.errors.length) row.failures.push("Browser/runtime/network-observer errors recorded");
      const posts = row.requests.filter((r) => r.method === "POST");
      if (step.input) {
        if (posts.length !== 1 || JSON.stringify(posts[0]?.input) !== JSON.stringify(step.input)) row.failures.push("Native write missing, duplicate, or input not independently observable");
        const endpoint = profile.js && posts[0]?.transport === "livewire" ? row.formBefore?.updatePath : row.formBefore?.action;
        if (!endpoint || posts[0]?.path !== endpoint) row.failures.push("Write did not use the independently discovered native form/update endpoint");
        const allowed = step.kind === "accepted-write" ? [200, 201, 202, 204, 302, 303] : [200, 302, 303, 400, 422];
        if (!allowed.includes(posts[0]?.status)) row.failures.push("Native write returned unexpected status");
      } else if (posts.length) row.failures.push("Unexpected write");
      if (row.requests.some((r) => (r.failure || r.status === null) && !r.intentionallyDisabledPreload)) row.failures.push("Failed or unfinished browser requests recorded");
      if (["initial", "missing", "reset", "return"].includes(step.kind) && !row.requests.some((r) => r.path === step.path && r.method === "GET" && r.status === (step.kind === "missing" ? 404 : 200))) row.failures.push("Missing native document/error request");
      if (!step.input && (step.kind === "navigate" || !profile.js) && !row.requests.some((r) => r.method === "GET" && r.status === (step.kind === "missing" ? 404 : 200)
        && (r.path === step.path || profile.js && evidence.architecture === "next-pages" && r.transport === "router"
          && /^\/_next\/data\/[^/.][^/]*\/marketplace\/[^/]+\/[^/]+\.json$/.test(r.path)
          && r.path.replace(/^\/_next\/data\/[^/]+/, "").replace(/\.json$/, "") === step.path))) row.failures.push("Missing native navigation request to the logical destination");
      if (profile.source === "fixture" && row.upstream.started !== 0) row.failures.push("Fixture source unexpectedly fetched upstream");
      if (row.upstream.pending || row.upstream.completed + row.upstream.cancelled !== row.upstream.started) row.failures.push("Upstream work still pending/unaccounted");
      if (profile.source === "api" && step.kind !== "missing" && row.requests.some((r) => ["document", "fetch", "router", "turbo", "livewire"].includes(r.transport) && (r.path.includes("marketplace") || r.method === "POST")) && !row.upstream.completed) row.failures.push("Request-time upstream read missing");
    }
    evidence.failures.push(...nativeFailures(app, profile, evidence.steps));
    evidence.failures.push(...evidence.steps.flatMap((s) => s.failures.map((f) => `${s.action.kind}: ${f}`)));
  } catch (e) { evidence.failures.push(e.message); }
  finally {
    const beforeClose = performance.now();
    try {
      await context.close();
      evidence.cleanup = { contextClosed: !browser.contexts().includes(context), closeMs: performance.now() - beforeClose,
        nativePageScope: null, reason: "Context closure is observed; native retired-page subscriptions/listeners/timers and retired-event probe are not instrumented by these adapters" };
      evidence.gaps.push(evidence.cleanup.reason);
    } catch (e) { evidence.cleanup = { contextClosed: false, error: e.message, nativePageScope: null }; evidence.failures.push("Browser context cleanup failed"); }
  }
  result.outcome = evidence.failures.length ? "failed" : "unsupported";
  evidence.domChecksPassed = evidence.steps.length === profile.steps.length && evidence.steps.every((s) => s.domPassed);
  result.reason = evidence.failures[0] ?? evidence.gaps[0];
  return result;
}
